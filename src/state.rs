use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, RwLock};
use uuid::Uuid;

use crate::{
    capture::{NativeCaptureSession, NativeCaptureTick},
    protocol::{
        encode_server_binary_frame, encode_server_binary_frame_v2, ChatEntry, PeerInfo,
        RoomSummary, ScreenShareInfo, ScreenShareMode, ServerMessage, TurnServerConfig,
    },
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
    /// Timestamp do último efeito sonoro disparado (para rate limit)
    pub last_sound_ms: u64,
    /// Endereço IP reportado para a sessão (cabeçalhos de proxy / túnel ou peer local)
    pub client_ip: Option<String>,
    /// Identificador de sessão persistido no navegador para banimento local
    pub client_id: Option<String>,
}

pub struct AppState {
    pub default_rooms: Vec<String>,
    pub rooms: RwLock<Vec<String>>,
    pub locked_rooms: RwLock<HashSet<String>>,
    pub pending_approvals: RwLock<HashSet<(Uuid, String)>>,
    pub approved_peers: RwLock<HashSet<(Uuid, String)>>,
    pub banned_ips: RwLock<HashMap<String, u64>>,
    pub banned_client_ids: RwLock<HashMap<String, u64>>,
    pub peers: RwLock<HashMap<Uuid, ConnectedPeer>>,
    pub chat_history: RwLock<HashMap<String, Vec<ChatEntry>>>,
    pub chat_persistence_enabled: AtomicBool,
    pub chat_save_pending: AtomicBool,
    pub chat_save_task_started: AtomicBool,
    pub media_dir_override: RwLock<Option<PathBuf>>,
    pub shared_turn: RwLock<Option<TurnServerConfig>>,
    pub global_ptt_vk: AtomicU32,
    pub global_ptt_task_started: AtomicBool,
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
                    edited_at_ms: None,
                    deleted: false,
                    reply_to: None,
                    reactions: HashMap::new(),
                }],
            );
        }

        Arc::new(Self {
            rooms: RwLock::new(default_rooms.clone()),
            default_rooms,
            locked_rooms: RwLock::new(HashSet::new()),
            pending_approvals: RwLock::new(HashSet::new()),
            approved_peers: RwLock::new(HashSet::new()),
            banned_ips: RwLock::new(HashMap::new()),
            banned_client_ids: RwLock::new(HashMap::new()),
            peers: RwLock::new(HashMap::new()),
            chat_history: RwLock::new(history),
            chat_persistence_enabled: AtomicBool::new(false),
            chat_save_pending: AtomicBool::new(false),
            chat_save_task_started: AtomicBool::new(false),
            media_dir_override: RwLock::new(None),
            shared_turn: RwLock::new(None),
            global_ptt_vk: AtomicU32::new(0),
            global_ptt_task_started: AtomicBool::new(false),
            tunnel: TunnelManager::new(port, secrets.current_room_key()),
            secrets,
        })
    }

    /// Ativa/atualiza o atalho Push-to-Talk global no Windows (`vk_code == 0` desativa).
    pub fn configure_global_ptt(self: &Arc<Self>, vk_code: u32) {
        self.global_ptt_vk.store(vk_code, Ordering::Relaxed);
        if vk_code != 0 && !self.global_ptt_task_started.swap(true, Ordering::SeqCst) {
            let state = Arc::clone(self);
            tokio::spawn(async move {
                global_ptt_loop(state).await;
            });
        }
    }

    /// Monta o resumo em tempo real de todas as salas (contagem de online, voz e transmissões AO VIVO).
    pub async fn build_room_summaries(&self) -> (Vec<String>, Vec<RoomSummary>) {
        let rooms = self.rooms.read().await.clone();
        let locked = self.locked_rooms.read().await;
        let peers = self.peers.read().await;
        let summaries = rooms
            .iter()
            .map(|name| {
                let mut peer_count = 0usize;
                let mut voice_count = 0usize;
                let mut live_count = 0usize;
                for p in peers.values() {
                    if p.info.room == *name {
                        peer_count += 1;
                        if p.info.in_voice {
                            voice_count += 1;
                        }
                        if p.info.screen_share.is_some() {
                            live_count += 1;
                        }
                    }
                }
                RoomSummary {
                    name: name.clone(),
                    peer_count,
                    voice_count,
                    live_count,
                    locked: locked.contains(name),
                }
            })
            .collect();
        (rooms, summaries)
    }

    /// Notifica todos os participantes conectados sobre mudanças nas salas ou contagens AO VIVO/voz.
    pub async fn broadcast_rooms_updated(&self) {
        let (rooms, room_summaries) = self.build_room_summaries().await;
        self.broadcast_all(ServerMessage::RoomsUpdated {
            rooms,
            room_summaries,
        })
        .await;
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
            edited_at_ms: None,
            deleted: false,
            reply_to: None,
            reactions: HashMap::new(),
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

    /// Distribui um quadro de vídeo binário (`DVF\x01`) sem Base64 para os espectadores da sala,
    /// aplicando o controle de backpressure `SignalVideoOutputSinkReady`.
    pub async fn relay_binary_video_frame_with_backpressure(
        &self,
        streamer_id: Uuid,
        frame_seq: u64,
        width: u16,
        height: u16,
        jpeg_bytes: &[u8],
    ) -> bool {
        let now = now_ms();
        let packet = encode_server_binary_frame(streamer_id, frame_seq, width, height, jpeg_bytes);
        let frame_msg = ServerMessage::BinaryVideoFrame(packet);

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

    /// Distribui um quadro de vídeo binário WebCodecs (`DVF\x02`) para os espectadores da sala.
    pub async fn relay_binary_video_v2_frame_with_backpressure(
        &self,
        streamer_id: Uuid,
        frame_seq: u64,
        width: u16,
        height: u16,
        codec_id: u8,
        flags: u8,
        chunk_bytes: &[u8],
    ) -> bool {
        let now = now_ms();
        let packet = encode_server_binary_frame_v2(
            streamer_id,
            frame_seq,
            width,
            height,
            codec_id,
            flags,
            chunk_bytes,
        );
        let frame_msg = ServerMessage::BinaryVideoFrame(packet);
        let is_keyframe = (flags & 1) != 0;

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

            if is_keyframe || should_send_frame(acked_seq, last_send_ms, frame_seq, now) {
                if viewer.tx.try_send(frame_msg.clone()).is_ok() {
                    viewer
                        .sink_ready_seq
                        .insert(streamer_id, (acked_seq, now));
                }
            }
        }

        true
    }

    /// Distribui um pacote binário de voz (`DAF\x01`) pelo WebSocket quando o WebRTC P2P falha por CGNAT/NAT.
    pub async fn relay_binary_audio_frame(&self, sender_id: Uuid, sample_rate: u32, payload: &[u8]) {
        let packet = crate::protocol::encode_server_binary_audio(sender_id, sample_rate, payload);
        let msg = ServerMessage::BinaryAudioFrame(packet);
        let peers = self.peers.read().await;
        let Some(sender) = peers.get(&sender_id) else {
            return;
        };
        let room = sender.info.room.as_str();
        for (peer_id, peer) in peers.iter() {
            if *peer_id != sender_id && peer.info.room == room {
                let _ = peer.tx.try_send(msg.clone());
            }
        }
    }

    /// Distribui um pacote binário de voz Opus (`DAF\x02`) pelo WebSocket.
    pub async fn relay_binary_audio_v2_frame(
        &self,
        sender_id: Uuid,
        sample_rate: u32,
        timestamp_us: u64,
        payload: &[u8],
    ) {
        let packet = crate::protocol::encode_server_binary_audio_v2(
            sender_id,
            sample_rate,
            timestamp_us,
            payload,
        );
        let msg = ServerMessage::BinaryAudioFrame(packet);
        let peers = self.peers.read().await;
        let Some(sender) = peers.get(&sender_id) else {
            return;
        };
        let room = sender.info.room.as_str();
        for (peer_id, peer) in peers.iter() {
            if *peer_id != sender_id && peer.info.room == room {
                let _ = peer.tx.try_send(msg.clone());
            }
        }
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
    /// usando DXGI Desktop Duplication (até 60 FPS, com GDI fallback + detecção estática)
    /// e opcionalmente captura de áudio do sistema via WASAPI loopback (24 kHz `DAF\x01`),
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

        let source_id = info.source_id.clone();
        let target_width = info.width.clamp(480, 1920);
        let fps = info.fps.clamp(5, 60);
        let frame_interval = Duration::from_secs_f64(1.0 / (fps as f64));
        let capture_audio = info.has_audio;

        let (frame_tx, mut frame_rx) = mpsc::channel::<(u32, u32, Vec<u8>)>(2);
        let video_stop = stop_flag.clone();
        let _ = std::thread::Builder::new()
            .name(format!("drocsid-cap-{streamer_id}"))
            .spawn(move || {
                let mut session = NativeCaptureSession::new(source_id, target_width, quality);
                while !video_stop.load(Ordering::SeqCst) {
                    let loop_start = std::time::Instant::now();
                    match session.next_tick() {
                        Ok(NativeCaptureTick::Frame {
                            width,
                            height,
                            jpeg_bytes,
                        }) => {
                            let _ = frame_tx.try_send((width, height, jpeg_bytes));
                        }
                        Ok(NativeCaptureTick::Unchanged) => {}
                        Err(_) => {
                            std::thread::sleep(Duration::from_millis(120));
                            continue;
                        }
                    }
                    let elapsed = loop_start.elapsed();
                    if elapsed < frame_interval {
                        let rem = frame_interval - elapsed;
                        if rem >= Duration::from_millis(2) {
                            std::thread::sleep(rem);
                        }
                    }
                }
            });

        let (audio_tx, mut audio_rx) = mpsc::channel::<Vec<u8>>(32);
        #[cfg(windows)]
        let _audio_thread = if capture_audio {
            Some(crate::audio_capture::start_wasapi_loopback_thread(
                stop_flag.clone(),
                audio_tx,
            ))
        } else {
            drop(audio_tx);
            None
        };
        #[cfg(not(windows))]
        drop(audio_tx);

        tokio::spawn(async move {
            let mut frame_seq: u64 = 0;
            let mut video_open = true;
            let mut audio_open = capture_audio;

            while !stop_flag.load(Ordering::SeqCst) && video_open {
                tokio::select! {
                    maybe_audio = audio_rx.recv(), if audio_open => {
                        match maybe_audio {
                            Some(chunk) => {
                                let still_audio = {
                                    let peers = state.peers.read().await;
                                    peers
                                        .get(&streamer_id)
                                        .and_then(|p| p.info.screen_share.as_ref())
                                        .map(|s| s.mode == ScreenShareMode::NativeHost && s.has_audio)
                                        .unwrap_or(false)
                                };
                                if still_audio {
                                    state
                                        .relay_binary_audio_frame(
                                            streamer_id,
                                            crate::audio_capture::WASAPI_TARGET_SAMPLE_RATE,
                                            &chunk,
                                        )
                                        .await;
                                }
                            }
                            None => {
                                audio_open = false;
                            }
                        }
                    }
                    maybe_frame = frame_rx.recv() => {
                        let Some((w, h, jpeg_bytes)) = maybe_frame else {
                            video_open = false;
                            continue;
                        };
                        let still_native = {
                            let peers = state.peers.read().await;
                            peers
                                .get(&streamer_id)
                                .and_then(|p| p.info.screen_share.as_ref())
                                .map(|s| s.mode == ScreenShareMode::NativeHost)
                                .unwrap_or(false)
                        };
                        if !still_native {
                            stop_flag.store(true, Ordering::SeqCst);
                            break;
                        }
                        frame_seq += 1;
                        if !state
                            .relay_binary_video_frame_with_backpressure(
                                streamer_id,
                                frame_seq,
                                w as u16,
                                h as u16,
                                &jpeg_bytes,
                            )
                            .await
                        {
                            stop_flag.store(true, Ordering::SeqCst);
                            break;
                        }
                    }
                }
            }
            stop_flag.store(true, Ordering::SeqCst);
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

    /// Retorna o diretório base para armazenamento temporário de mídias enviadas no chat.
    pub async fn resolve_media_dir(&self) -> Option<PathBuf> {
        if let Some(over) = self.media_dir_override.read().await.clone() {
            return Some(over);
        }
        std::env::var_os("LOCALAPPDATA").map(|dir| {
            PathBuf::from(dir)
                .join("Programs")
                .join("Drocsid")
                .join("media")
        })
    }

    /// Mantém a pasta `media/` dentro dos limites (máx. 150 arquivos / 100 MiB), removendo os mais antigos.
    pub async fn enforce_media_retention(dir: &std::path::Path) {
        const MAX_FILES: usize = 150;
        const MAX_BYTES: u64 = 100 * 1024 * 1024;
        let Ok(mut rd) = tokio::fs::read_dir(dir).await else {
            return;
        };
        let mut entries: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
        while let Ok(Some(entry)) = rd.next_entry().await {
            let Ok(meta) = entry.metadata().await else {
                continue;
            };
            if meta.is_file() {
                let modified = meta.modified().unwrap_or(UNIX_EPOCH);
                entries.push((entry.path(), meta.len(), modified));
            }
        }
        let mut total_bytes: u64 = entries.iter().map(|e| e.1).sum();
        if entries.len() <= MAX_FILES && total_bytes <= MAX_BYTES {
            return;
        }
        entries.sort_by_key(|e| e.2);
        let mut remaining = entries.len();
        for (path, len, _) in entries {
            if remaining <= MAX_FILES && total_bytes <= MAX_BYTES {
                break;
            }
            if tokio::fs::remove_file(&path).await.is_ok() {
                remaining = remaining.saturating_sub(1);
                total_bytes = total_bytes.saturating_sub(len);
            }
        }
    }

    /// Agenda gravação assíncrona com debounce (~800 ms) para evitar I/O síncrono por mensagem.
    pub fn schedule_save_persisted_chat(self: &Arc<Self>) {
        if !self.chat_persistence_enabled.load(Ordering::Relaxed) {
            return;
        }
        self.chat_save_pending.store(true, Ordering::Release);
        if self.chat_save_task_started.swap(true, Ordering::AcqRel) {
            return;
        }
        let state = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(800)).await;
                state.chat_save_pending.store(false, Ordering::Release);
                state.save_persisted_chat().await;
                if !state.chat_save_pending.load(Ordering::Acquire) {
                    state.chat_save_task_started.store(false, Ordering::Release);
                    if state.chat_save_pending.load(Ordering::Acquire)
                        && !state.chat_save_task_started.swap(true, Ordering::AcqRel)
                    {
                        continue;
                    }
                    break;
                }
            }
        });
    }

    /// Verifica se o IP ou ID de cliente está banido nesta sessão.
    pub async fn is_banned(&self, client_ip: Option<&str>, client_id: Option<&str>) -> bool {
        if let Some(ip) = client_ip {
            if self.banned_ips.read().await.contains_key(ip) {
                return true;
            }
        }
        if let Some(cid) = client_id {
            if self.banned_client_ids.read().await.contains_key(cid) {
                return true;
            }
        }
        false
    }

    /// Adiciona IP e ID de sessão à lista de banidos da sessão atual.
    pub async fn ban_peer(&self, client_ip: Option<&str>, client_id: Option<&str>) {
        let now = now_ms();
        if let Some(ip) = client_ip {
            let trimmed = ip.trim();
            if !trimmed.is_empty() {
                self.banned_ips.write().await.insert(trimmed.to_string(), now);
            }
        }
        if let Some(cid) = client_id {
            let trimmed = cid.trim();
            if !trimmed.is_empty() {
                self.banned_client_ids
                    .write()
                    .await
                    .insert(trimmed.to_string(), now);
            }
        }
    }

    /// Limpa toda a lista de banidos da sessão e retorna quantos registros existiam.
    pub async fn unban_all(&self) -> usize {
        let mut ips = self.banned_ips.write().await;
        let mut cids = self.banned_client_ids.write().await;
        let count = ips.len() + cids.len();
        ips.clear();
        cids.clear();
        count
    }

    /// Retorna se o participante foi silenciado no servidor pelo anfitrião.
    pub async fn is_peer_server_muted(&self, peer_id: Uuid) -> bool {
        let peers = self.peers.read().await;
        peers
            .get(&peer_id)
            .map(|p| p.info.server_muted)
            .unwrap_or(false)
    }

    /// Salva o histórico de chat em disco quando a persistência está habilitada (escrita atômica).
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
            let tmp = path.with_extension("json.tmp");
            if tokio::fs::write(&tmp, &json).await.is_ok() {
                if tokio::fs::rename(&tmp, &path).await.is_err() {
                    let _ = tokio::fs::remove_file(&tmp).await;
                    let _ = tokio::fs::write(&path, &json).await;
                }
            } else {
                let _ = tokio::fs::write(&path, &json).await;
            }
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
    last_send_ms == 0
        || (acked_seq > 0 && frame_seq < acked_seq)
        || (acked_seq > 0 && frame_seq.saturating_sub(acked_seq) <= MAX_FRAMES_IN_FLIGHT)
        || now_ms.saturating_sub(last_send_ms) > FRAME_ACK_TIMEOUT_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backpressure_rules() {
        // Primeiro frame ainda não enviado: envia
        assert!(should_send_frame(0, 0, 1, 1000));
        // Já enviou o primeiro frame e ainda não voltou ACK: aguarda ACK ou timeout (evita flood em 4G/celular)
        assert!(!should_send_frame(0, 1000, 2, 1050));
        // Até 2 quadros em voo após ACK: envia
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
                    voice_relay: false,
                    server_muted: false,
                    screen_share: None,
                    caps: Default::default(),
                },
                tx,
                native_capture_stop: None,
                sink_ready_seq: HashMap::new(),
                last_chat_ms: 0,
                last_sound_ms: 0,
                client_ip: None,
                client_id: None,
            },
        );

        assert_eq!(ensure_unique_username("arthur", id2, &map, "geral"), "arthur#abcd");
        assert_eq!(ensure_unique_username("Arthur", id1, &map, "geral"), "Arthur");
        assert_eq!(ensure_unique_username("Arthur", id2, &map, "jogos"), "Arthur");
    }

    #[tokio::test]
    async fn ban_list_e_unban_funcionam() {
        let state = AppState::new(3000, Secrets::from_parts("host", "key"));
        assert!(!state.is_banned(Some("198.51.100.7"), Some("cid-1")).await);
        state.ban_peer(Some("198.51.100.7"), Some("cid-1")).await;
        assert!(state.is_banned(Some("198.51.100.7"), None).await);
        assert!(state.is_banned(None, Some("cid-1")).await);
        assert!(!state.is_banned(Some("198.51.100.8"), Some("cid-2")).await);
        let cleared = state.unban_all().await;
        assert_eq!(cleared, 2);
        assert!(!state.is_banned(Some("198.51.100.7"), Some("cid-1")).await);
    }
}

#[cfg(windows)]
extern "system" {
    fn GetAsyncKeyState(vkey: i32) -> i16;
}

async fn global_ptt_loop(state: Arc<AppState>) {
    let mut prev_pressed = false;
    loop {
        let vk = state.global_ptt_vk.load(Ordering::Relaxed);
        if vk == 0 {
            if prev_pressed {
                prev_pressed = false;
                let peers = state.peers.read().await;
                for p in peers.values() {
                    if p.info.is_host {
                        let _ = p.tx.try_send(ServerMessage::GlobalPttState { pressed: false });
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
            continue;
        }

        #[cfg(windows)]
        let pressed = (unsafe { GetAsyncKeyState(vk as i32) } as u16 & 0x8000) != 0;
        #[cfg(not(windows))]
        let pressed = false;

        if pressed != prev_pressed {
            prev_pressed = pressed;
            let peers = state.peers.read().await;
            for p in peers.values() {
                if p.info.is_host {
                    let _ = p.tx.try_send(ServerMessage::GlobalPttState { pressed });
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}