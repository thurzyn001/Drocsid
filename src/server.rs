//! Rotas HTTP e WebSocket do Drocsid.

use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::mpsc;
use tracing::warn;
use uuid::Uuid;

use crate::{
    capture::get_screen_previews,
    protocol::{
        ChatEntry, ClientMessage, PeerInfo, ScreenShareInfo, ScreenShareMode, ServerMessage,
    },
    security::Role,
    state::{now_ms, AppState, ConnectedPeer},
};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
const INDEX_HTML: &str = include_str!("ui.html");

pub fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(serve_index))
        .route("/api/whoami", get(whoami))
        .route("/api/screens", get(serve_screen_previews))
        .route("/api/tunnel/status", get(get_tunnel_status))
        .route("/api/tunnel/start", post(start_tunnel_handler))
        .route("/api/tunnel/stop", post(stop_tunnel_handler))
        .route("/api/room/rotate-key", post(rotate_room_key_handler))
        .route("/api/shutdown", post(shutdown_handler))
        .route("/ws", get(ws_handler))
        .with_state(state)
}

async fn serve_index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

/// Rota pública mínima: identifica o processo como Drocsid (usada para instância única).
async fn whoami() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "app": "drocsid", "version": VERSION }))
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        "Acesso restrito ao anfitrião desta sala.",
    )
        .into_response()
}

/// Equivalente ao `GetScreenPreviews` (ordinal 121 em `discord_voice.node`). **Somente o anfitrião**:
/// expõe miniaturas da tela do PC que hospeda o servidor (P0-1).
async fn serve_screen_previews(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if !state.secrets.is_host_request(&headers) {
        return unauthorized();
    }
    let previews = tokio::task::spawn_blocking(|| get_screen_previews(360))
        .await
        .unwrap_or_default();
    Json(previews).into_response()
}

async fn get_tunnel_status(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if !state.secrets.is_host_request(&headers) {
        return unauthorized();
    }
    Json(state.tunnel.get_status().await).into_response()
}

async fn start_tunnel_handler(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if !state.secrets.is_host_request(&headers) {
        return unauthorized();
    }
    Json(state.tunnel.clone().start_tunnel().await).into_response()
}

async fn stop_tunnel_handler(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if !state.secrets.is_host_request(&headers) {
        return unauthorized();
    }
    Json(state.tunnel.stop_tunnel().await).into_response()
}

/// Regenera a chave secreta da sala (revogando links/códigos antigos) — U-4.
async fn rotate_room_key_handler(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if !state.secrets.is_host_request(&headers) {
        return unauthorized();
    }
    let new_key = state.secrets.rotate_room_key();
    let status = state.tunnel.update_room_key(new_key).await;
    Json(status).into_response()
}

async fn shutdown_handler(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if !state.secrets.is_host_request(&headers) {
        return unauthorized();
    }
    state.tunnel.stop_tunnel().await;
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        std::process::exit(0);
    });
    StatusCode::OK.into_response()
}

#[derive(Debug, Deserialize)]
pub struct WsAuth {
    pub host: Option<String>,
    pub key: Option<String>,
}

/// O WebSocket só abre com `?key=<room_key>` (convidado) ou `?host=<host_token>` (anfitrião) — P0-2.
/// A autorização é checada **antes** do upgrade.
async fn ws_handler(
    State(state): State<Arc<AppState>>,
    Query(auth): Query<WsAuth>,
    ws: Option<WebSocketUpgrade>,
) -> Response {
    let Some(role) = state
        .secrets
        .authorize(auth.host.as_deref(), auth.key.as_deref())
    else {
        return (
            StatusCode::UNAUTHORIZED,
            "Convite inválido ou incompleto (falta a chave da sala).",
        )
            .into_response();
    };
    let Some(ws) = ws else {
        return (StatusCode::BAD_REQUEST, "Esperado upgrade de WebSocket.").into_response();
    };
    ws.max_message_size(2 * 1024 * 1024)
        .on_upgrade(move |socket| handle_socket(socket, state, role))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>, role: Role) {
    let peer_id = Uuid::new_v4();
    let is_host = role == Role::Host;
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (tx, mut rx) = mpsc::channel::<ServerMessage>(256);

    let send_task = tokio::spawn(async move {
        while let Some(server_msg) = rx.recv().await {
            match server_msg {
                ServerMessage::BinaryVideoFrame(bytes) => {
                    if ws_sender.send(Message::Binary(bytes)).await.is_err() {
                        break;
                    }
                }
                other => {
                    if let Ok(json_text) = serde_json::to_string(&other) {
                        if ws_sender.send(Message::Text(json_text)).await.is_err() {
                            break;
                        }
                    }
                }
            }
        }
    });

    let initial_info = PeerInfo {
        peer_id,
        username: format!("Amigo-{}", &peer_id.to_string()[..4]),
        room: "geral".to_string(),
        is_host,
        in_voice: false,
        self_mute: false,
        self_deaf: false,
        speaking: false,
        screen_share: None,
    };

    {
        let mut peers = state.peers.write().await;
        peers.insert(
            peer_id,
            ConnectedPeer {
                info: initial_info,
                tx: tx.clone(),
                native_capture_stop: None,
                sink_ready_seq: HashMap::new(),
                last_chat_ms: 0,
                last_sound_ms: 0,
            },
        );
    }

    let rooms_snapshot = state.rooms.read().await.clone();
    let _ = tx.try_send(ServerMessage::Welcome {
        peer_id,
        rooms: rooms_snapshot,
        is_host,
        version: VERSION.to_string(),
    });

    while let Some(Ok(msg)) = ws_receiver.next().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Binary(bytes) => {
                if let Some((frame_seq, width, height, jpeg_bytes)) =
                    crate::protocol::parse_client_binary_frame(&bytes)
                {
                    state
                        .relay_binary_video_frame_with_backpressure(
                            peer_id, frame_seq, width, height, jpeg_bytes,
                        )
                        .await;
                }
                continue;
            }
            Message::Close(_) => break,
            _ => continue,
        };

        let client_msg: ClientMessage = match serde_json::from_str(&text) {
            Ok(parsed) => parsed,
            Err(err) => {
                warn!("Mensagem inválida de {peer_id}: {err}");
                let _ = tx.try_send(ServerMessage::Error {
                    message: format!("Formato JSON inválido: {err}"),
                });
                continue;
            }
        };

        match client_msg {
            ClientMessage::JoinRoom { username, room } => {
                let clean_name = username.trim();
                let clean_room = room.trim().to_lowercase();
                let final_name = if clean_name.is_empty() {
                    format!("Amigo-{}", &peer_id.to_string()[..4])
                } else {
                    clean_name.chars().take(28).collect()
                };
                let final_room = if clean_room.is_empty() {
                    "geral".to_string()
                } else {
                    clean_room.chars().take(32).collect()
                };

                let new_rooms_list = {
                    let mut rooms = state.rooms.write().await;
                    if !rooms.contains(&final_room) {
                        if rooms.len() >= crate::state::MAX_ROOMS {
                            let _ = tx.try_send(ServerMessage::Error {
                                message: format!("Limite máximo de {} salas atingido.", crate::state::MAX_ROOMS),
                            });
                            continue;
                        }
                        rooms.push(final_room.clone());
                        Some(rooms.clone())
                    } else {
                        None
                    }
                };

                if let Some(rooms) = new_rooms_list {
                    state
                        .broadcast_all(ServerMessage::RoomsUpdated { rooms })
                        .await;
                }

                state.stop_native_capture_for_peer(peer_id).await;

                let (old_room, updated_info) = {
                    let mut peers = state.peers.write().await;
                    let unique_name =
                        crate::state::ensure_unique_username(&final_name, peer_id, &peers, &final_room);
                    if let Some(peer) = peers.get_mut(&peer_id) {
                        let prev_room = peer.info.room.clone();
                        peer.info.username = unique_name;
                        peer.info.room = final_room.clone();
                        peer.info.screen_share = None;
                        peer.sink_ready_seq.clear();
                        (prev_room, peer.info.clone())
                    } else {
                        continue;
                    }
                };

                if old_room != final_room {
                    state
                        .broadcast_to_room(&old_room, ServerMessage::PeerLeft { peer_id }, Some(peer_id))
                        .await;
                }

                let room_peers: Vec<PeerInfo> = {
                    let peers = state.peers.read().await;
                    peers
                        .values()
                        .filter(|p| p.info.room == final_room)
                        .map(|p| p.info.clone())
                        .collect()
                };

                let chat_history: Vec<ChatEntry> = {
                    let hist = state.chat_history.read().await;
                    hist.get(&final_room).cloned().unwrap_or_default()
                };

                let _ = tx.try_send(ServerMessage::RoomState {
                    room: final_room.clone(),
                    peers: room_peers,
                    chat_history,
                });

                state
                    .broadcast_to_room(
                        &final_room,
                        ServerMessage::PeerJoined { peer: updated_info.clone() },
                        Some(peer_id),
                    )
                    .await;
            }

            ClientMessage::SetUsername { username } => {
                let clean = username.trim();
                if clean.is_empty() {
                    continue;
                }
                let final_name: String = clean.chars().take(28).collect();
                let updated = {
                    let mut peers = state.peers.write().await;
                    let room = peers
                        .get(&peer_id)
                        .map(|p| p.info.room.clone())
                        .unwrap_or_default();
                    let unique_name =
                        crate::state::ensure_unique_username(&final_name, peer_id, &peers, &room);
                    if let Some(peer) = peers.get_mut(&peer_id) {
                        peer.info.username = unique_name;
                        Some(peer.info.clone())
                    } else {
                        None
                    }
                };
                if let Some(info) = updated {
                    state
                        .broadcast_to_room(&info.room, ServerMessage::PeerUpdated { peer: info.clone() }, None)
                        .await;
                }
            }

            ClientMessage::ChatMessage { text } => {
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    continue;
                }

                let now = now_ms();
                let (username, room) = {
                    let mut peers = state.peers.write().await;
                    match peers.get_mut(&peer_id) {
                        Some(p) => {
                            if now.saturating_sub(p.last_chat_ms) < 150 {
                                let _ = tx.try_send(ServerMessage::Error {
                                    message: "Aguarde um instante antes de enviar outra mensagem.".into(),
                                });
                                continue;
                            }
                            p.last_chat_ms = now;
                            (p.info.username.clone(), p.info.room.clone())
                        }
                        None => continue,
                    }
                };

                let max_len = if trimmed.starts_with("[drocsid-img]data:image/") {
                    200_000
                } else {
                    2000
                };
                let entry = ChatEntry {
                    id: Uuid::new_v4(),
                    peer_id,
                    username,
                    room: room.clone(),
                    text: trimmed.chars().take(max_len).collect(),
                    timestamp_ms: now_ms(),
                    is_system: false,
                };

                {
                    let mut hist = state.chat_history.write().await;
                    let list = hist.entry(room.clone()).or_default();
                    list.push(entry.clone());
                    if list.len() > 150 {
                        list.remove(0);
                    }
                }
                state.save_persisted_chat().await;

                state
                    .broadcast_to_room(&room, ServerMessage::ChatBroadcast { entry }, None)
                    .await;
            }

            ClientMessage::UpdateVoiceState {
                in_voice,
                self_mute,
                self_deaf,
                speaking,
            } => {
                let updated = {
                    let mut peers = state.peers.write().await;
                    if let Some(peer) = peers.get_mut(&peer_id) {
                        peer.info.in_voice = in_voice;
                        peer.info.self_mute = self_mute;
                        peer.info.self_deaf = self_deaf;
                        peer.info.speaking = in_voice && speaking && !self_mute && !self_deaf;
                        Some(peer.info.clone())
                    } else {
                        None
                    }
                };

                if let Some(info) = updated {
                    state
                        .broadcast_to_room(&info.room, ServerMessage::PeerUpdated { peer: info.clone() }, None)
                        .await;
                }
            }

            ClientMessage::StartScreenShare {
                mode,
                source_id,
                source_name,
                width,
                height,
                fps,
                has_audio,
                quality,
            } => {
                // P0-1: captura nativa = tela do PC do servidor. Só o anfitrião pode ligar.
                if mode == ScreenShareMode::NativeHost && !is_host {
                    warn!("Convidado {peer_id} tentou iniciar captura nativa do host — negado");
                    let _ = tx.try_send(ServerMessage::Error {
                        message: "Somente o anfitrião pode usar o Motor Nativo (ele captura a tela do PC do servidor).".into(),
                    });
                    continue;
                }

                let share_info = ScreenShareInfo {
                    mode: mode.clone(),
                    source_id,
                    source_name: source_name.chars().take(80).collect(),
                    width: width.clamp(320, 3840),
                    height: height.clamp(180, 2160),
                    fps: fps.clamp(5, 60),
                    has_audio,
                };

                let updated = {
                    let mut peers = state.peers.write().await;
                    for p in peers.values_mut() {
                        p.sink_ready_seq.remove(&peer_id);
                    }
                    if let Some(peer) = peers.get_mut(&peer_id) {
                        peer.info.screen_share = Some(share_info.clone());
                        Some(peer.info.clone())
                    } else {
                        None
                    }
                };

                if let Some(info) = updated {
                    let mode_label = match mode {
                        ScreenShareMode::WebRtc => "WebRTC",
                        ScreenShareMode::UniversalRelay => "Relay pelo servidor",
                        ScreenShareMode::NativeHost => "Motor Nativo Rust",
                    };

                    state
                        .broadcast_to_room(&info.room, ServerMessage::PeerUpdated { peer: info.clone() }, None)
                        .await;

                    state
                        .push_system_message(
                            &info.room,
                            format!(
                                "🔴 {} iniciou compartilhamento de tela: {} ({}x{} @ {} FPS via {})",
                                info.username,
                                share_info.source_name,
                                share_info.width,
                                share_info.height,
                                share_info.fps,
                                mode_label
                            ),
                        )
                        .await;

                    if mode == ScreenShareMode::NativeHost {
                        AppState::start_native_capture_loop(
                            state.clone(),
                            peer_id,
                            info.room.clone(),
                            share_info,
                            quality.unwrap_or(72),
                        )
                        .await;
                    } else {
                        state.stop_native_capture_for_peer(peer_id).await;
                    }
                }
            }

            ClientMessage::StopScreenShare => {
                state.stop_native_capture_for_peer(peer_id).await;

                let updated = {
                    let mut peers = state.peers.write().await;
                    for p in peers.values_mut() {
                        p.sink_ready_seq.remove(&peer_id);
                    }
                    if let Some(peer) = peers.get_mut(&peer_id) {
                        let was_sharing = peer.info.screen_share.is_some();
                        peer.info.screen_share = None;
                        Some((peer.info.clone(), was_sharing))
                    } else {
                        None
                    }
                };

                if let Some((info, was_sharing)) = updated {
                    state
                        .broadcast_to_room(&info.room, ServerMessage::PeerUpdated { peer: info.clone() }, None)
                        .await;

                    if was_sharing {
                        state
                            .push_system_message(
                                &info.room,
                                format!("⏹️ {} encerrou o compartilhamento de tela.", info.username),
                            )
                            .await;
                    }
                }
            }

            ClientMessage::PushVideoFrame {
                frame_seq,
                width,
                height,
                jpeg_base64,
            } => {
                state
                    .relay_video_frame_with_backpressure(peer_id, frame_seq, width, height, jpeg_base64)
                    .await;
            }

            ClientMessage::SignalVideoOutputSinkReady {
                streamer_id,
                frame_seq,
            } => {
                let mut peers = state.peers.write().await;
                if let Some(peer) = peers.get_mut(&peer_id) {
                    peer.sink_ready_seq.insert(streamer_id, (frame_seq, now_ms()));
                }
            }

            ClientMessage::RtcOffer { target_id, sdp } => {
                state
                    .send_to_peer_in_same_room(peer_id, target_id, ServerMessage::RtcOffer { from_id: peer_id, sdp })
                    .await;
            }

            ClientMessage::RtcAnswer { target_id, sdp } => {
                state
                    .send_to_peer_in_same_room(peer_id, target_id, ServerMessage::RtcAnswer { from_id: peer_id, sdp })
                    .await;
            }

            ClientMessage::RtcIceCandidate { target_id, candidate } => {
                state
                    .send_to_peer_in_same_room(
                        peer_id,
                        target_id,
                        ServerMessage::RtcIceCandidate { from_id: peer_id, candidate },
                    )
                    .await;
            }

            ClientMessage::Ping { client_ts } => {
                let _ = tx.try_send(ServerMessage::Pong { client_ts });
            }

            ClientMessage::LaserPointer { x_norm, y_norm } => {
                let sender_info = {
                    let peers = state.peers.read().await;
                    peers
                        .get(&peer_id)
                        .map(|p| (p.info.room.clone(), p.info.username.clone()))
                };
                if let Some((room, username)) = sender_info {
                    state
                        .broadcast_to_room(
                            &room,
                            ServerMessage::LaserPointer {
                                peer_id,
                                username,
                                x_norm: x_norm.clamp(0.0, 1.0),
                                y_norm: y_norm.clamp(0.0, 1.0),
                            },
                            None,
                        )
                        .await;
                }
            }

            ClientMessage::SoundEffect { kind } => {
                let now = now_ms();
                let sender_info = {
                    let mut peers = state.peers.write().await;
                    match peers.get_mut(&peer_id) {
                        Some(p) if now.saturating_sub(p.last_sound_ms) >= 500 => {
                            p.last_sound_ms = now;
                            Some((p.info.room.clone(), p.info.username.clone()))
                        }
                        _ => None,
                    }
                };
                if let Some((room, username)) = sender_info {
                    let safe_kind: String = kind.trim().chars().take(24).collect();
                    if !safe_kind.is_empty() {
                        state
                            .broadcast_to_room(
                                &room,
                                ServerMessage::SoundEffect {
                                    peer_id,
                                    username,
                                    kind: safe_kind,
                                },
                                None,
                            )
                            .await;
                    }
                }
            }

            ClientMessage::KickPeer { target_id } => {
                if !is_host || target_id == peer_id {
                    continue;
                }
                state.stop_native_capture_for_peer(target_id).await;
                let kicked_peer = {
                    let mut peers = state.peers.write().await;
                    peers.remove(&target_id)
                };
                if let Some(target) = kicked_peer {
                    let _ = target.tx.try_send(ServerMessage::Kicked {
                        reason: "Você foi removido da sala pelo anfitrião.".to_string(),
                    });
                    state
                        .broadcast_to_room(
                            &target.info.room,
                            ServerMessage::PeerLeft { peer_id: target_id },
                            Some(target_id),
                        )
                        .await;
                    state
                        .push_system_message(
                            &target.info.room,
                            format!("🚫 {} foi removido da sala pelo anfitrião.", target.info.username),
                        )
                        .await;
                }
            }
        }
    }

    state.stop_native_capture_for_peer(peer_id).await;
    let removed_peer = {
        let mut peers = state.peers.write().await;
        peers.remove(&peer_id)
    };

    if let Some(peer) = removed_peer {
        state
            .broadcast_to_room(&peer.info.room, ServerMessage::PeerLeft { peer_id }, Some(peer_id))
            .await;
    }

    send_task.abort();
}
