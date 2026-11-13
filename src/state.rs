use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

use crate::{
    capture::capture_monitor_jpeg,
    protocol::{ChatEntry, PeerInfo, ScreenShareInfo, ScreenShareMode, ServerMessage},
    security::Secrets,
    tunnel::TunnelManager,
};

pub const MAX_ROOMS: usize = 32;

pub type Tx = mpsc::Sender<ServerMessage>;

pub struct ConnectedPeer {
    pub info: PeerInfo,
    pub tx: Tx,
    /// Controle de parada para a tarefa de captura nativa (`ClearDesktopSource` / `ClearGoLiveDevices`)
    pub native_capture_stop: Option<Arc<AtomicBool>>,
    /// Mapa `(streamer_id -> (último frame_seq confirmado via SignalVideoOutputSinkReady, timestamp_ms))`
    pub sink_ready_seq: HashMap<Uuid, (u64, u64)>,
    /// Timestamp da última mensagem de chat enviada (para rate limit)
    pub last_chat_ms: u64,
}

pub struct AppState {
    pub default_rooms: Vec<String>,
    pub rooms: RwLock<Vec<String>>,
    pub peers: RwLock<HashMap<Uuid, ConnectedPeer>>,
    pub chat_history: RwLock<HashMap<String, Vec<ChatEntry>>>,
    pub chat_persistence_enabled: AtomicBool,
    pub tunnel: Arc<TunnelManager>,
    pub secrets: Secrets,
}

impl AppState {
    pub fn new(port: u16, secrets: Secrets) -> Arc<Self> {
        let default_rooms = vec![
            "geral".to_string(),
            "jogos".to_string(),
            "cinema-tela".to_string(),
        ];

        let mut history = HashMap::new();
        for room in &default_rooms {
            history.insert(
                room.clone(),
                vec![ChatEntry {
                    id: Uuid::new_v4(),
                    peer_id: Uuid::nil(),
                    username: "Drocsid Bot".to_string(),
                    room: room.clone(),
                    text: format!(
                        "Bem-vindo ao canal #{room}! Para jogar com amigos em outra rede/cidade sem VPN, clique em '📡 Gerar Convite' na barra lateral!"
                    ),
                    timestamp_ms: now_ms(),
                    is_system: true,
                }],
            );
        }

        Arc::new(Self {
            rooms: RwLock::new(default_rooms.clone()),
            default_rooms,
            peers: RwLock::new(HashMap::new()),
            chat_history: RwLock::new(history),
            chat_persistence_enabled: AtomicBool::new(false),
            tunnel: TunnelManager::new(port, secrets.room_key.clone()),
            secrets,
        })
    }

    /// Envia uma mensagem para todos os participantes de uma sala (opcionalmente exceto `skip_peer`).
    pub async fn broadcast_to_room(
        &self,
        room: &str,
        msg: ServerMessage,
        skip_peer: Option<Uuid>,
    ) {
        let peers = self.peers.read().await;
        for (id, peer) in peers.iter() {
            if Some(*id) == skip_peer {
                continue;
            }
            if peer.info.room == room {
                let _ = peer.tx.try_send(msg.clone());
            }
        }
    }

    /// Envia uma mensagem para todos os participantes conectados (em qualquer sala).
    pub async fn broadcast_all(&self, msg: ServerMessage) {
        let peers = self.peers.read().await;
        for peer in peers.values() {
            let _ = peer.tx.try_send(msg.clone());
        }
    }

    /// Envia uma mensagem de sinalização WebRTC a outro participante, **somente** se os dois
    /// estiverem na mesma sala (evita que alguém mande sinalização para salas onde não está).
    pub async fn send_to_peer_in_same_room(&self, from_id: Uuid, target_id: Uuid, msg: ServerMessage) {
        let peers = self.peers.read().await;
        let (Some(from), Some(target)) = (peers.get(&from_id), peers.get(&target_id)) else {
            return;
        };
        if from.info.room == target.info.room {
            let _ = target.tx.try_send(msg);
        }
    }

    /// Registra uma mensagem de sistema no chat da sala e faz broadcast.
    pub async fn push_system_message(&self, room: &str, text: String) {
        let entry = ChatEntry {
            id: Uuid::new_v4(),
            peer_id: Uuid::nil(),
            username: "Sistema".to_string(),
            room: room.to_string(),
            text,
            timestamp_ms: now_ms(),
            is_system: true,
        };

        {
            let mut hist = self.chat_history.write().await;
            let list = hist.entry(room.to_string()).or_default();
            list.push(entry.clone());
            if list.len() > 150 {
                list.remove(0);
            }
        }

        self.broadcast_to_room(room, ServerMessage::ChatBroadcast { entry }, None)
            .await;
    }

    /// Distribui um quadro de vídeo para os espectadores da sala aplicando o controle de backpressure
    /// `SignalVideoOutputSinkReady` (ordinal 237 em `discord_voice.node`).
    pub async fn relay_video_frame_with_backpressure(
        &self,
        streamer_id: Uuid,
        frame_seq: u64,
        width: u32,
        height: u32,
        jpeg_base64: String,
    ) -> bool {
        let now = now_ms();
        let frame_msg = ServerMessage::NativeVideoFrame {
            streamer_id,
            frame_seq,
            width,
            height,
            timestamp_ms: now,
            jpeg_base64,
        };

        let mut peers = self.peers.write().await;
        let (room, is_universal_relay) = match peers.get(&streamer_id) {
            Some(p) => match &p.info.screen_share {
                Some(ss) => (p.info.room.clone(), ss.mode == ScreenShareMode::UniversalRelay),
                None => return false,
            },
            _ => return false,
        };

        for (viewer_id, viewer) in peers.iter_mut() {
            if viewer.info.room != room {
                continue;
            }
            if is_universal_relay && *viewer_id == streamer_id {
                continue;
            }

            let (acked_seq, last_send_ms) = viewer
                .sink_ready_seq
                .get(&streamer_id)
                .copied()
                .unwrap_or((0, 0));

            if should_send_frame(acked_seq, last_send_ms, frame_seq, now) {
                if viewer.tx.try_send(frame_msg.clone()).is_ok() {
                    viewer
                        .sink_ready_seq
                        .insert(streamer_id, (acked_seq, now));
                }
            }
        }

        true
    }

    /// Para qualquer loop ativo de captura nativa de tela de um participante (`ClearDesktopSource`).
    pub async fn stop_native_capture_for_peer(&self, peer_id: Uuid) {
        let mut peers = self.peers.write().await;
        if let Some(peer) = peers.get_mut(&peer_id) {
            if let Some(stop_flag) = peer.native_capture_stop.take() {
                stop_flag.store(true, Ordering::SeqCst);
            }
        }
    }

    /// Inicia o loop de captura nativa em Rust (`SetDesktopSource` + `SetVideoOutputSink`)
    /// respeitando o controle de backpressure `SignalVideoOutputSinkReady` de cada espectador.
    pub async fn start_native_capture_loop(
        state: Arc<Self>,
        streamer_id: Uuid,
        _room: String,
        info: ScreenShareInfo,
        quality: u8,
    ) {
        state.stop_native_capture_for_peer(streamer_id).await;

        let stop_flag = Arc::new(AtomicBool::new(false));
        {
            let mut peers = state.peers.write().await;
            if let Some(peer) = peers.get_mut(&streamer_id) {
                peer.native_capture_stop = Some(stop_flag.clone());
            } else {
                return;
            }
        }

        let monitor_index = info
            .source_id
            .split(':')
            .nth(1)
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0);

        let target_width = info.width.clamp(480, 1920);
        let fps = info.fps.clamp(5, 30);
        let frame_interval = Duration::from_millis((1000 / fps).max(33) as u64);

        tokio::spawn(async move {
            let mut frame_seq: u64 = 0;

            while !stop_flag.load(Ordering::SeqCst) {
                let loop_start = std::time::Instant::now();
                frame_seq += 1;

                let capture_res = tokio::task::spawn_blocking(move || {
                    capture_monitor_jpeg(monitor_index, target_width, quality)
                })
                .await;

                let (w, h, jpeg_base64) = match capture_res {
                    Ok(Ok(data)) => data,
                    _ => {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        continue;
                    }
                };

                {
                    let peers = state.peers.read().await;
                    let still_native = peers
                        .get(&streamer_id)
                        .and_then(|p| p.info.screen_share.as_ref())
                        .map(|s| s.mode == ScreenShareMode::NativeHost)
                        .unwrap_or(false);
                    if !still_native {
                        break;
                    }
                }

                if !state
                    .relay_video_frame_with_backpressure(streamer_id, frame_seq, w, h, jpeg_base64)
                    .await
                {
                    break;
                }

                let elapsed = loop_start.elapsed();
                if elapsed < frame_interval {
                    tokio::time::sleep(frame_interval - elapsed).await;
                }
            }
        });
    }
}

pub fn chat_history_file_path() -> Option<std::path::PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|dir| {
        std::path::PathBuf::from(dir)
            .join("Programs")
            .join("Drocsid")
            .join("chat_history.json")
    })
}

impl AppState {
    /// Carrega o histórico de chat salvo em disco e ativa a persistência para o processo atual.
    pub async fn load_persisted_chat(&self) {
        self.chat_persistence_enabled.store(true, Ordering::Relaxed);
        let Some(path) = chat_history_file_path() else {
            return;
        };
        let Ok(bytes) = tokio::fs::read(&path).await else {
            return;
        };
        let Ok(loaded) = serde_json::from_slice::<HashMap<String, Vec<ChatEntry>>>(&bytes) else {
            return;
        };

        let mut loaded_rooms: Vec<String> = Vec::new();
        {
            let mut hist = self.chat_history.write().await;
            for (room, entries) in loaded {
                if !entries.is_empty() {
                    loaded_rooms.push(room.clone());
                    let trimmed = if entries.len() > 150 {
                        entries[entries.len() - 150..].to_vec()
                    } else {
                        entries
                    };
                    hist.insert(room, trimmed);
                }
            }
        }
        if !loaded_rooms.is_empty() {
            let mut rooms = self.rooms.write().await;
            for r in loaded_rooms {
                if rooms.len() >= MAX_ROOMS {
                    break;
                }
                if !rooms.contains(&r) {
                    rooms.push(r);
                }
            }
        }
    }

    /// Salva o histórico de chat em disco quando a persistência está habilitada.
    pub async fn save_persisted_chat(&self) {
        if !self.chat_persistence_enabled.load(Ordering::Relaxed) {
            return;
        }
        let Some(path) = chat_history_file_path() else {
            return;
        };
        let snapshot = {
            let hist = self.chat_history.read().await;
            hist.clone()
        };
        if let Some(parent) = path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        if let Ok(json) = serde_json::to_vec(&snapshot) {
            let _ = tokio::fs::write(&path, json).await;
        }
    }
}

/// Garante que dois participantes na mesma sala não fiquem com exatamente o mesmo apelido.
pub fn ensure_unique_username(
    desired: &str,
    peer_id: Uuid,
    peers: &HashMap<Uuid, ConnectedPeer>,
    room: &str,
) -> String {
    let duplicate = peers.iter().any(|(id, p)| {
        *id != peer_id && p.info.room == room && p.info.username.eq_ignore_ascii_case(desired)
    });
    if duplicate {
        format!("{desired}#{}", &peer_id.to_string()[..4])
    } else {
        desired.to_string()
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Quantos quadros podem estar "em voo" (enviados e ainda não confirmados) por espectador.
pub const MAX_FRAMES_IN_FLIGHT: u64 = 2;
/// Depois desse tempo sem confirmação, reenvia mesmo assim (evita travar se um ACK se perder).
pub const FRAME_ACK_TIMEOUT_MS: u64 = 600;

/// Decisão de backpressure no estilo SignalVideoOutputSinkReady (ordinal 237 do discord_voice.node).
pub fn should_send_frame(acked_seq: u64, last_send_ms: u64, frame_seq: u64, now_ms: u64) -> bool {
    acked_seq == 0
        || frame_seq.saturating_sub(acked_seq) <= MAX_FRAMES_IN_FLIGHT
        || now_ms.saturating_sub(last_send_ms) > FRAME_ACK_TIMEOUT_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backpressure_rules() {
        // Ainda sem nenhum ACK: envia
        assert!(should_send_frame(0, 0, 1, 1000));
        // Até 2 quadros em voo: envia
        assert!(should_send_frame(10, 1000, 12, 1100));
        // 3 em voo e sem timeout: segura
        assert!(!should_send_frame(10, 1000, 13, 1100));
        // 3 em voo mas passou do timeout: reenvia
        assert!(should_send_frame(10, 1000, 13, 1601));
        // Stream reiniciado (seq voltou a 1): envia
        assert!(should_send_frame(500, 1000, 1, 1001));
    }

    #[test]
    fn unique_username_disambiguates_duplicates() {
        let mut map = HashMap::new();
        let (tx, _rx) = mpsc::channel(4);
        let id1 = Uuid::parse_str("11111111-1111-1111-1111-111111111111").unwrap();
        let id2 = Uuid::parse_str("abcdef12-2222-2222-2222-222222222222").unwrap();
        map.insert(
            id1,
            ConnectedPeer {
                info: PeerInfo {
                    peer_id: id1,
                    username: "Arthur".to_string(),
                    room: "geral".to_string(),
                    is_host: true,
                    in_voice: false,
                    self_mute: false,
                    self_deaf: false,
                    speaking: false,
                    screen_share: None,
                },
                tx,
                native_capture_stop: None,
                sink_ready_seq: HashMap::new(),
                last_chat_ms: 0,
            },
        );

        assert_eq!(ensure_unique_username("arthur", id2, &map, "geral"), "arthur#abcd");
        assert_eq!(ensure_unique_username("Arthur", id1, &map, "geral"), "Arthur");
        assert_eq!(ensure_unique_username("Arthur", id2, &map, "jogos"), "Arthur");
    }
}