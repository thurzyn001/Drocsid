//! Rotas HTTP e WebSocket do Drocsid.

use std::{collections::HashMap, sync::Arc};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Multipart, Path, Query, State,
    },
    http::{header, HeaderMap, StatusCode},
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
        ChatEntry, ChatReplyPreview, ClientMessage, PeerInfo, ScreenShareInfo, ScreenShareMode,
        ServerMessage, TurnServerConfig,
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
        .route(
            "/api/upload",
            post(upload_media_handler).layer(DefaultBodyLimit::max(5 * 1024 * 1024)),
        )
        .route("/api/media/:id", get(serve_media_handler))
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
    state.save_persisted_chat().await;
    state.tunnel.stop_tunnel().await;
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        std::process::exit(0);
    });
    StatusCode::OK.into_response()
}

fn extract_client_ip(headers: &HeaderMap) -> Option<String> {
    for name in ["cf-connecting-ip", "true-client-ip", "x-forwarded-for", "x-real-ip"] {
        if let Some(raw) = headers.get(name).and_then(|v| v.to_str().ok()) {
            let first = raw.split(',').next().unwrap_or("").trim();
            if !first.is_empty() && first.len() <= 64 {
                return Some(first.to_string());
            }
        }
    }
    None
}

fn sanitize_client_id(raw: Option<&str>) -> Option<String> {
    let cid: String = raw
        .unwrap_or("")
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(48)
        .collect();
    if cid.len() >= 6 {
        Some(cid)
    } else {
        None
    }
}

fn authorize_media_request(state: &AppState, headers: &HeaderMap, auth: &WsAuth) -> bool {
    if state.secrets.is_host_request(headers) {
        return true;
    }
    let header_key = headers
        .get("x-drocsid-key")
        .and_then(|v| v.to_str().ok())
        .map(str::trim);
    let key = auth.key.as_deref().or(header_key);
    let header_host = headers
        .get("x-drocsid-host")
        .and_then(|v| v.to_str().ok())
        .map(str::trim);
    let host = auth.host.as_deref().or(header_host);
    state.secrets.authorize(host, key).is_some()
}

fn detect_safe_image_type(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(("png", "image/png"));
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Some(("jpg", "image/jpeg"));
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(("gif", "image/gif"));
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(("webp", "image/webp"));
    }
    None
}

fn safe_media_mime_for_filename(id: &str) -> Option<&'static str> {
    if id.is_empty() || id.len() > 64 || id.contains("..") || id.contains('/') || id.contains('\\') {
        return None;
    }
    let (stem, ext) = id.split_once('.')?;
    if stem.is_empty()
        || !stem
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

async fn upload_media_handler(
    State(state): State<Arc<AppState>>,
    Query(auth): Query<WsAuth>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Response {
    const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;
    if !authorize_media_request(&state, &headers, &auth) {
        return unauthorized();
    }
    let Some(dir) = state.resolve_media_dir().await else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Diretório de mídia indisponível.",
        )
            .into_response();
    };

    let mut file_bytes: Option<Vec<u8>> = None;
    while let Ok(Some(field)) = multipart.next_field().await {
        let is_file_field = field.name() == Some("file") || file_bytes.is_none();
        if !is_file_field {
            continue;
        }
        let Ok(data) = field.bytes().await else {
            return (StatusCode::BAD_REQUEST, "Falha ao ler arquivo enviado.").into_response();
        };
        if data.len() > MAX_IMAGE_BYTES {
            return (StatusCode::PAYLOAD_TOO_LARGE, "Imagem excede o limite de 4 MB.")
                .into_response();
        }
        file_bytes = Some(data.to_vec());
        break;
    }

    let Some(bytes) = file_bytes else {
        return (StatusCode::BAD_REQUEST, "Nenhum arquivo enviado no formulário.").into_response();
    };
    let Some((ext, mime)) = detect_safe_image_type(&bytes) else {
        return (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Formato não suportado (use PNG, JPEG, GIF ou WebP).",
        )
            .into_response();
    };

    if tokio::fs::create_dir_all(&dir).await.is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Não foi possível criar diretório de mídia.",
        )
            .into_response();
    }

    let filename = format!("{}.{ext}", Uuid::new_v4().simple());
    let dest = dir.join(&filename);
    if tokio::fs::write(&dest, &bytes).await.is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Falha ao gravar arquivo de mídia.",
        )
            .into_response();
    }

    AppState::enforce_media_retention(&dir).await;

    Json(serde_json::json!({
        "id": filename,
        "url": format!("/api/media/{}", filename),
        "size": bytes.len(),
        "content_type": mime,
    }))
    .into_response()
}

async fn serve_media_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(auth): Query<WsAuth>,
    headers: HeaderMap,
) -> Response {
    if !authorize_media_request(&state, &headers, &auth) {
        return unauthorized();
    }
    let Some(mime) = safe_media_mime_for_filename(&id) else {
        return (StatusCode::BAD_REQUEST, "Nome de mídia inválido.").into_response();
    };
    let Some(dir) = state.resolve_media_dir().await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(bytes) = tokio::fs::read(dir.join(&id)).await else {
        return StatusCode::NOT_FOUND.into_response();
    };

    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, mime),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::CACHE_CONTROL, "private, max-age=86400"),
            (header::CONTENT_SECURITY_POLICY, "default-src 'none'"),
        ],
        bytes,
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
pub struct WsAuth {
    pub host: Option<String>,
    pub key: Option<String>,
    pub cid: Option<String>,
}

/// O WebSocket só abre com `?key=<room_key>` (convidado) ou `?host=<host_token>` (anfitrião) — P0-2.
/// A autorização e a lista de banidos são checadas **antes** do upgrade.
async fn ws_handler(
    State(state): State<Arc<AppState>>,
    Query(auth): Query<WsAuth>,
    headers: HeaderMap,
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
    let client_ip = extract_client_ip(&headers);
    let client_id = sanitize_client_id(auth.cid.as_deref());
    if role != Role::Host && state.is_banned(client_ip.as_deref(), client_id.as_deref()).await {
        return (
            StatusCode::FORBIDDEN,
            "Você foi banido desta sessão pelo anfitrião.",
        )
            .into_response();
    }
    let Some(ws) = ws else {
        return (StatusCode::BAD_REQUEST, "Esperado upgrade de WebSocket.").into_response();
    };
    ws.max_message_size(2 * 1024 * 1024)
        .on_upgrade(move |socket| handle_socket(socket, state, role, client_ip, client_id))
}

async fn handle_socket(
    socket: WebSocket,
    state: Arc<AppState>,
    role: Role,
    client_ip: Option<String>,
    client_id: Option<String>,
) {
    let peer_id = Uuid::new_v4();
    let is_host = role == Role::Host;
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (tx, mut rx) = mpsc::channel::<ServerMessage>(256);

    let send_task = tokio::spawn(async move {
        while let Some(server_msg) = rx.recv().await {
            match server_msg {
                ServerMessage::BinaryVideoFrame(bytes) | ServerMessage::BinaryAudioFrame(bytes) => {
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
        voice_relay: false,
        server_muted: false,
        screen_share: None,
        caps: Default::default(),
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
                client_ip: client_ip.clone(),
                client_id: client_id.clone(),
            },
        );
    }

    let (rooms_snapshot, room_summaries) = state.build_room_summaries().await;
    let _ = tx.try_send(ServerMessage::Welcome {
        peer_id,
        rooms: rooms_snapshot,
        is_host,
        version: VERSION.to_string(),
        room_summaries,
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
                } else if let Some((frame_seq, width, height, codec_id, flags, chunk_bytes)) =
                    crate::protocol::parse_client_binary_frame_v2(&bytes)
                {
                    state
                        .relay_binary_video_v2_frame_with_backpressure(
                            peer_id, frame_seq, width, height, codec_id, flags, chunk_bytes,
                        )
                        .await;
                } else if let Some((sample_rate, audio_bytes)) =
                    crate::protocol::parse_client_binary_audio(&bytes)
                {
                    if !state.is_peer_server_muted(peer_id).await {
                        state
                            .relay_binary_audio_frame(peer_id, sample_rate, audio_bytes)
                            .await;
                    }
                } else if let Some((sample_rate, timestamp_us, opus_bytes)) =
                    crate::protocol::parse_client_binary_audio_v2(&bytes)
                {
                    if !state.is_peer_server_muted(peer_id).await {
                        state
                            .relay_binary_audio_v2_frame(
                                peer_id,
                                sample_rate,
                                timestamp_us,
                                opus_bytes,
                            )
                            .await;
                    }
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

                if !is_host {
                    let is_locked = state.locked_rooms.read().await.contains(&final_room);
                    if is_locked {
                        let is_approved = state
                            .approved_peers
                            .read()
                            .await
                            .contains(&(peer_id, final_room.clone()));
                        if !is_approved {
                            {
                                let mut pending = state.pending_approvals.write().await;
                                pending.insert((peer_id, final_room.clone()));
                            }
                            let host_targets = {
                                let peers = state.peers.read().await;
                                peers
                                    .values()
                                    .filter(|p| p.info.is_host)
                                    .map(|p| p.tx.clone())
                                    .collect::<Vec<_>>()
                            };
                            if host_targets.is_empty() {
                                let _ = tx.try_send(ServerMessage::Error {
                                    message: format!(
                                        "A sala #{final_room} está trancada e nenhum anfitrião está conectado para aprovar."
                                    ),
                                });
                            } else {
                                let _ = tx.try_send(ServerMessage::JoinApprovalRequired {
                                    room: final_room.clone(),
                                });
                                for h_tx in host_targets {
                                    let _ = h_tx.try_send(ServerMessage::JoinApprovalRequest {
                                        peer_id,
                                        username: final_name.clone(),
                                        room: final_room.clone(),
                                    });
                                }
                            }
                            continue;
                        }
                    }
                }

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

                if let Some(_rooms) = new_rooms_list {
                    state.broadcast_rooms_updated().await;
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

                let (_, room_summaries) = state.build_room_summaries().await;
                let shared_turn = state.shared_turn.read().await.clone();
                let _ = tx.try_send(ServerMessage::RoomState {
                    room: final_room.clone(),
                    peers: room_peers,
                    chat_history,
                    room_summaries,
                    shared_turn,
                });

                state
                    .broadcast_to_room(
                        &final_room,
                        ServerMessage::PeerJoined { peer: updated_info.clone() },
                        Some(peer_id),
                    )
                    .await;
                state.broadcast_rooms_updated().await;
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

            ClientMessage::ChatMessage { text, reply_to_id } => {
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

                let reply_to = if let Some(ref_id) = reply_to_id {
                    let hist = state.chat_history.read().await;
                    hist.get(&room)
                        .and_then(|list| list.iter().find(|m| m.id == ref_id))
                        .map(|m| {
                            let snippet = if m.deleted {
                                "[mensagem removida]".to_string()
                            } else if m.text.starts_with("[drocsid-img]")
                                || m.text.starts_with("[drocsid-media]")
                            {
                                "[Imagem]".to_string()
                            } else {
                                let flat: String = m.text.replace('\n', " ").chars().take(72).collect();
                                if m.text.chars().count() > 72 {
                                    format!("{flat}...")
                                } else {
                                    flat
                                }
                            };
                            ChatReplyPreview {
                                id: m.id,
                                username: m.username.clone(),
                                snippet,
                            }
                        })
                } else {
                    None
                };

                let entry = ChatEntry {
                    id: Uuid::new_v4(),
                    peer_id,
                    username,
                    room: room.clone(),
                    text: trimmed.chars().take(max_len).collect(),
                    timestamp_ms: now_ms(),
                    is_system: false,
                    edited_at_ms: None,
                    deleted: false,
                    reply_to,
                    reactions: HashMap::new(),
                };

                {
                    let mut hist = state.chat_history.write().await;
                    let list = hist.entry(room.clone()).or_default();
                    list.push(entry.clone());
                    if list.len() > 150 {
                        list.remove(0);
                    }
                }
                state.schedule_save_persisted_chat();

                state
                    .broadcast_to_room(&room, ServerMessage::ChatBroadcast { entry }, None)
                    .await;
            }

            ClientMessage::EditChatMessage { message_id, text } => {
                let trimmed = text.trim();
                if trimmed.is_empty()
                    || trimmed.starts_with("[drocsid-img]")
                    || trimmed.starts_with("[drocsid-media]")
                {
                    continue;
                }
                let room = {
                    let peers = state.peers.read().await;
                    match peers.get(&peer_id) {
                        Some(p) => p.info.room.clone(),
                        None => continue,
                    }
                };
                let updated_entry = {
                    let mut hist = state.chat_history.write().await;
                    if let Some(list) = hist.get_mut(&room) {
                        if let Some(entry) = list.iter_mut().find(|m| m.id == message_id) {
                            if entry.peer_id == peer_id
                                && !entry.is_system
                                && !entry.deleted
                                && !entry.text.starts_with("[drocsid-img]")
                                && !entry.text.starts_with("[drocsid-media]")
                            {
                                entry.text = trimmed.chars().take(2000).collect();
                                entry.edited_at_ms = Some(now_ms());
                                Some(entry.clone())
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                };
                if let Some(entry) = updated_entry {
                    state.schedule_save_persisted_chat();
                    state
                        .broadcast_to_room(&room, ServerMessage::ChatMessageUpdated { room: room.clone(), entry }, None)
                        .await;
                }
            }

            ClientMessage::DeleteChatMessage { message_id } => {
                let room = {
                    let peers = state.peers.read().await;
                    match peers.get(&peer_id) {
                        Some(p) => p.info.room.clone(),
                        None => continue,
                    }
                };
                let updated_entry = {
                    let mut hist = state.chat_history.write().await;
                    if let Some(list) = hist.get_mut(&room) {
                        if let Some(entry) = list.iter_mut().find(|m| m.id == message_id) {
                            if (entry.peer_id == peer_id || is_host) && !entry.is_system && !entry.deleted {
                                entry.deleted = true;
                                entry.text = "[mensagem removida]".to_string();
                                entry.reactions.clear();
                                entry.edited_at_ms = Some(now_ms());
                                Some(entry.clone())
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                };
                if let Some(entry) = updated_entry {
                    state.schedule_save_persisted_chat();
                    state
                        .broadcast_to_room(&room, ServerMessage::ChatMessageUpdated { room: room.clone(), entry }, None)
                        .await;
                }
            }

            ClientMessage::ReactChatMessage { message_id, emoji } => {
                let clean_emoji: String = emoji
                    .trim()
                    .chars()
                    .filter(|c| !c.is_control() && !c.is_whitespace())
                    .take(6)
                    .collect();
                if clean_emoji.is_empty() {
                    continue;
                }
                let room = {
                    let peers = state.peers.read().await;
                    match peers.get(&peer_id) {
                        Some(p) => p.info.room.clone(),
                        None => continue,
                    }
                };
                let updated_entry = {
                    let mut hist = state.chat_history.write().await;
                    if let Some(list) = hist.get_mut(&room) {
                        if let Some(entry) = list.iter_mut().find(|m| m.id == message_id) {
                            if !entry.deleted {
                                let is_existing = entry.reactions.contains_key(&clean_emoji);
                                if is_existing || entry.reactions.len() < 12 {
                                    let users = entry.reactions.entry(clean_emoji.clone()).or_default();
                                    if let Some(pos) = users.iter().position(|id| *id == peer_id) {
                                        users.remove(pos);
                                        if users.is_empty() {
                                            entry.reactions.remove(&clean_emoji);
                                        }
                                    } else {
                                        users.push(peer_id);
                                    }
                                    Some(entry.clone())
                                } else {
                                    None
                                }
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                };
                if let Some(entry) = updated_entry {
                    state.schedule_save_persisted_chat();
                    state
                        .broadcast_to_room(&room, ServerMessage::ChatMessageUpdated { room: room.clone(), entry }, None)
                        .await;
                }
            }

            ClientMessage::Typing { is_typing } => {
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
                            ServerMessage::PeerTyping {
                                peer_id,
                                username,
                                is_typing,
                            },
                            Some(peer_id),
                        )
                        .await;
                }
            }

            ClientMessage::UpdateVoiceState {
                in_voice,
                self_mute,
                self_deaf,
                speaking,
                voice_relay,
            } => {
                let (updated, voice_toggled) = {
                    let mut peers = state.peers.write().await;
                    if let Some(peer) = peers.get_mut(&peer_id) {
                        let toggled = peer.info.in_voice != in_voice;
                        peer.info.in_voice = in_voice;
                        peer.info.self_mute = self_mute || peer.info.server_muted;
                        peer.info.self_deaf = self_deaf;
                        peer.info.speaking =
                            in_voice && speaking && !self_mute && !self_deaf && !peer.info.server_muted;
                        peer.info.voice_relay = voice_relay;
                        (Some(peer.info.clone()), toggled)
                    } else {
                        (None, false)
                    }
                };

                if let Some(info) = updated {
                    state
                        .broadcast_to_room(&info.room, ServerMessage::PeerUpdated { peer: info.clone() }, None)
                        .await;
                    if voice_toggled {
                        state.broadcast_rooms_updated().await;
                    }
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
                        message: "Somente o anfitrião pode usar a Captura do PC (ela transmite a tela do servidor).".into(),
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
                        ScreenShareMode::WebRtc => "Conexão Direta",
                        ScreenShareMode::UniversalRelay => "Modo Compatível",
                        ScreenShareMode::NativeHost => "Captura do PC",
                    };

                    state
                        .broadcast_to_room(&info.room, ServerMessage::PeerUpdated { peer: info.clone() }, None)
                        .await;
                    state.broadcast_rooms_updated().await;

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
                    state.broadcast_rooms_updated().await;

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

            ClientMessage::KickPeer { target_id, ban } => {
                if !is_host || target_id == peer_id {
                    continue;
                }
                state.stop_native_capture_for_peer(target_id).await;
                let kicked_peer = {
                    let mut peers = state.peers.write().await;
                    peers.remove(&target_id)
                };
                {
                    let mut pending = state.pending_approvals.write().await;
                    pending.retain(|(id, _)| *id != target_id);
                    let mut approved = state.approved_peers.write().await;
                    approved.retain(|(id, _)| *id != target_id);
                }
                if let Some(target) = kicked_peer {
                    if ban {
                        state
                            .ban_peer(target.client_ip.as_deref(), target.client_id.as_deref())
                            .await;
                    }
                    let _ = target.tx.try_send(ServerMessage::Kicked {
                        reason: if ban {
                            "Você foi expulso e banido desta sessão pelo anfitrião.".to_string()
                        } else {
                            "Você foi removido da sala pelo anfitrião.".to_string()
                        },
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
                            if ban {
                                format!("⛔ {} foi banido da sessão pelo anfitrião.", target.info.username)
                            } else {
                                format!("🚫 {} foi removido da sala pelo anfitrião.", target.info.username)
                            },
                        )
                        .await;
                    state.broadcast_rooms_updated().await;
                }
            }

            ClientMessage::SetPeerServerMute { target_id, muted } => {
                if !is_host || target_id == peer_id {
                    continue;
                }
                let updated = {
                    let mut peers = state.peers.write().await;
                    if let Some(target) = peers.get_mut(&target_id) {
                        target.info.server_muted = muted;
                        if muted {
                            target.info.self_mute = true;
                            target.info.speaking = false;
                        }
                        Some(target.info.clone())
                    } else {
                        None
                    }
                };
                if let Some(info) = updated {
                    state
                        .broadcast_to_room(&info.room, ServerMessage::PeerUpdated { peer: info.clone() }, None)
                        .await;
                    state
                        .push_system_message(
                            &info.room,
                            if muted {
                                format!("🔇 {} foi silenciado pelo anfitrião.", info.username)
                            } else {
                                format!("🎙️ {} teve o microfone liberado pelo anfitrião.", info.username)
                            },
                        )
                        .await;
                }
            }

            ClientMessage::ToggleRoomLock { room } => {
                if !is_host {
                    continue;
                }
                let clean_room = room.trim().to_lowercase();
                if clean_room.is_empty() || clean_room == "geral" {
                    let _ = tx.try_send(ServerMessage::Error {
                        message: "A sala #geral não pode ser trancada.".into(),
                    });
                    continue;
                }
                if !state.rooms.read().await.contains(&clean_room) {
                    continue;
                }
                let now_locked = {
                    let mut locked = state.locked_rooms.write().await;
                    if locked.contains(&clean_room) {
                        locked.remove(&clean_room);
                        false
                    } else {
                        locked.insert(clean_room.clone());
                        true
                    }
                };
                if !now_locked {
                    let mut pending = state.pending_approvals.write().await;
                    pending.retain(|(_, r)| r != &clean_room);
                }
                state.broadcast_rooms_updated().await;
                state
                    .push_system_message(
                        &clean_room,
                        if now_locked {
                            format!("🔒 Sala #{clean_room} trancada: novos convidados precisam de aprovação.")
                        } else {
                            format!("🔓 Sala #{clean_room} destrancada pelo anfitrião.")
                        },
                    )
                    .await;
            }

            ClientMessage::ResolveJoinApproval {
                target_id,
                room,
                approve,
            } => {
                if !is_host {
                    continue;
                }
                let clean_room = room.trim().to_lowercase();
                let was_pending = {
                    let mut pending = state.pending_approvals.write().await;
                    pending.remove(&(target_id, clean_room.clone()))
                };
                if !was_pending {
                    continue;
                }
                if approve {
                    state
                        .approved_peers
                        .write()
                        .await
                        .insert((target_id, clean_room.clone()));
                }
                let target_tx = {
                    let peers = state.peers.read().await;
                    peers.get(&target_id).map(|p| p.tx.clone())
                };
                if let Some(t_tx) = target_tx {
                    let _ = t_tx.try_send(ServerMessage::JoinApprovalResult {
                        room: clean_room,
                        approved: approve,
                    });
                }
            }

            ClientMessage::DeleteRoom { room } => {
                if !is_host {
                    continue;
                }
                let clean_room = room.trim().to_lowercase();
                if clean_room.is_empty() || clean_room == "geral" {
                    let _ = tx.try_send(ServerMessage::Error {
                        message: "A sala #geral não pode ser excluída.".into(),
                    });
                    continue;
                }
                let removed = {
                    let mut rooms = state.rooms.write().await;
                    if let Some(pos) = rooms.iter().position(|r| r == &clean_room) {
                        rooms.remove(pos);
                        true
                    } else {
                        false
                    }
                };
                if !removed {
                    continue;
                }
                state.locked_rooms.write().await.remove(&clean_room);
                state.chat_history.write().await.remove(&clean_room);
                {
                    let mut pending = state.pending_approvals.write().await;
                    pending.retain(|(_, r)| r != &clean_room);
                    let mut approved = state.approved_peers.write().await;
                    approved.retain(|(_, r)| r != &clean_room);
                }

                let moved_peers = {
                    let mut peers = state.peers.write().await;
                    let mut moved = Vec::new();
                    for (&pid, peer) in peers.iter_mut() {
                        if peer.info.room == clean_room {
                            if let Some(stop_flag) = peer.native_capture_stop.take() {
                                stop_flag.store(true, std::sync::atomic::Ordering::SeqCst);
                            }
                            peer.info.room = "geral".to_string();
                            peer.info.screen_share = None;
                            peer.sink_ready_seq.clear();
                            moved.push((pid, peer.tx.clone(), peer.info.clone()));
                        }
                    }
                    moved
                };

                if !moved_peers.is_empty() {
                    let geral_peers = {
                        let peers = state.peers.read().await;
                        peers
                            .values()
                            .filter(|p| p.info.room == "geral")
                            .map(|p| p.info.clone())
                            .collect::<Vec<_>>()
                    };
                    let chat_history = {
                        let hist = state.chat_history.read().await;
                        hist.get("geral").cloned().unwrap_or_default()
                    };
                    let (_, room_summaries) = state.build_room_summaries().await;
                    let shared_turn = state.shared_turn.read().await.clone();

                    for (pid, ptx, info) in moved_peers {
                        let _ = ptx.try_send(ServerMessage::RoomState {
                            room: "geral".to_string(),
                            peers: geral_peers.clone(),
                            chat_history: chat_history.clone(),
                            room_summaries: room_summaries.clone(),
                            shared_turn: shared_turn.clone(),
                        });
                        state
                            .broadcast_to_room(
                                "geral",
                                ServerMessage::PeerJoined { peer: info },
                                Some(pid),
                            )
                            .await;
                    }
                }

                state.broadcast_rooms_updated().await;
                state.save_persisted_chat().await;
            }

            ClientMessage::ClearChat { room } => {
                if !is_host {
                    continue;
                }
                let clean_room = room.trim().to_lowercase();
                if clean_room.is_empty() || !state.rooms.read().await.contains(&clean_room) {
                    continue;
                }
                let notice = ChatEntry {
                    id: Uuid::new_v4(),
                    peer_id: Uuid::nil(),
                    username: "Sistema".to_string(),
                    room: clean_room.clone(),
                    text: "🧹 Histórico desta sala limpo pelo anfitrião.".to_string(),
                    timestamp_ms: now_ms(),
                    is_system: true,
                    edited_at_ms: None,
                    deleted: false,
                    reply_to: None,
                    reactions: HashMap::new(),
                };
                let history = vec![notice];
                {
                    let mut hist = state.chat_history.write().await;
                    hist.insert(clean_room.clone(), history.clone());
                }
                state.save_persisted_chat().await;
                state
                    .broadcast_to_room(
                        &clean_room,
                        ServerMessage::ChatCleared {
                            room: clean_room.clone(),
                            history,
                        },
                        None,
                    )
                    .await;
            }

            ClientMessage::UnbanAll => {
                if !is_host {
                    continue;
                }
                let cleared = state.unban_all().await;
                let host_room = {
                    let peers = state.peers.read().await;
                    peers
                        .get(&peer_id)
                        .map(|p| p.info.room.clone())
                        .unwrap_or_else(|| "geral".to_string())
                };
                state
                    .push_system_message(
                        &host_room,
                        format!("🔓 Lista de banimentos limpa pelo anfitrião ({cleared} registro(s))."),
                    )
                    .await;
            }

            ClientMessage::SetHostTurnConfig { turn } => {
                if !is_host {
                    continue;
                }
                let sanitized = turn.and_then(|t| {
                    let urls: String = t.urls.trim().chars().take(256).collect();
                    if urls.is_empty() {
                        None
                    } else {
                        Some(TurnServerConfig {
                            urls,
                            username: t.username.trim().chars().take(128).collect(),
                            credential: t.credential.chars().take(256).collect(),
                        })
                    }
                });
                {
                    let mut guard = state.shared_turn.write().await;
                    *guard = sanitized.clone();
                }
                state
                    .broadcast_all(ServerMessage::TurnConfigUpdated { turn: sanitized })
                    .await;
            }

            ClientMessage::SetClientCapabilities { caps } => {
                let updated = {
                    let mut peers = state.peers.write().await;
                    if let Some(peer) = peers.get_mut(&peer_id) {
                        peer.info.caps = caps;
                        Some((peer.info.room.clone(), peer.info.clone()))
                    } else {
                        None
                    }
                };
                if let Some((room, peer)) = updated {
                    state
                        .broadcast_to_room(&room, ServerMessage::PeerUpdated { peer }, None)
                        .await;
                }
            }

            ClientMessage::RequestVideoKeyframe { streamer_id } => {
                let target_tx = {
                    let peers = state.peers.read().await;
                    let requester_room = peers.get(&peer_id).map(|p| &p.info.room);
                    let streamer = peers.get(&streamer_id);
                    match (requester_room, streamer) {
                        (Some(r), Some(s)) if s.info.room == *r => Some(s.tx.clone()),
                        _ => None,
                    }
                };
                if let Some(s_tx) = target_tx {
                    let _ = s_tx.try_send(ServerMessage::RequestVideoKeyframe { requester_id: peer_id });
                }
            }

            ClientMessage::ConfigureGlobalPtt { enabled, vk_code } => {
                if !is_host {
                    continue;
                }
                let vk = if enabled {
                    vk_code.filter(|&k| (1..=254).contains(&k)).unwrap_or(0)
                } else {
                    0
                };
                state.configure_global_ptt(vk);
            }
        }
    }

    state.stop_native_capture_for_peer(peer_id).await;
    {
        let mut pending = state.pending_approvals.write().await;
        pending.retain(|(id, _)| *id != peer_id);
        let mut approved = state.approved_peers.write().await;
        approved.retain(|(id, _)| *id != peer_id);
    }
    let removed_peer = {
        let mut peers = state.peers.write().await;
        peers.remove(&peer_id)
    };

    if let Some(peer) = removed_peer {
        state
            .broadcast_to_room(&peer.info.room, ServerMessage::PeerLeft { peer_id }, Some(peer_id))
            .await;
        state.broadcast_rooms_updated().await;
    }

    send_task.abort();
}
