use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Modos de compartilhamento de tela suportados pelo Drocsid:
/// 1. `WebRtc`: usa o motor WebRTC P2P (`getDisplayMedia` + áudio de loopback) com STUN/TURN.
/// 2. `UniversalRelay`: captura qualquer janela/tela no cliente e retransmite pelo servidor Rust
///    com backpressure `SignalVideoOutputSinkReady` — atravessa 100% dos roteadores CGNAT na Internet!
/// 3. `NativeHost`: usa o capturador nativo em Rust no servidor/host (espelhando o `discord_voice.node`:
///    `SetDesktopSource` + `SetVideoOutputSink` + controle de backpressure via `SignalVideoOutputSinkReady`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScreenShareMode {
    WebRtc,
    UniversalRelay,
    NativeHost,
}

/// Metadados de um compartilhamento de tela ("Go Live") ativo na sala.
/// Equivale ao estado gerenciado por `SetDesktopSource` (ordinal 165) e `SetGoLiveDevices` (ordinal 175)
/// no `discord_voice.node`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenShareInfo {
    pub mode: ScreenShareMode,
    pub source_id: String,
    pub source_name: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub has_audio: bool,
}

/// Capacidades opcionais de codecs binários no cliente (negociação Opus / WebCodecs)
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PeerCapabilities {
    #[serde(default)]
    pub opus_relay: bool,
    #[serde(default)]
    pub vp8_relay: bool,
    #[serde(default)]
    pub h264_relay: bool,
}

/// Estado de um participante conectado em uma sala (voz, vídeo e Go Live).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerInfo {
    pub peer_id: Uuid,
    pub username: String,
    pub room: String,
    /// Anfitrião (dono do servidor)
    pub is_host: bool,
    /// Participante conectou o microfone na voz
    #[serde(default)]
    pub in_voice: bool,
    /// Equivale a `setSelfMute` no `discord_voice/index.js`
    pub self_mute: bool,
    /// Equivale a `setSelfDeafen` no `discord_voice/index.js`
    pub self_deaf: bool,
    /// Equivale a `setOnSpeakingCallback` no `discord_voice/index.js`
    pub speaking: bool,
    /// Participante solicitou/ativou Relay de Voz pelo WebSocket (anti-CGNAT)
    #[serde(default)]
    pub voice_relay: bool,
    /// Participante silenciado no servidor pelo anfitrião (Item 7)
    #[serde(default)]
    pub server_muted: bool,
    /// Estado ativo de compartilhamento de tela ("Go Live")
    pub screen_share: Option<ScreenShareInfo>,
    /// Capacidades de codecs WebCodecs anunciadas pelo navegador do participante
    #[serde(default)]
    pub caps: PeerCapabilities,
}

/// Prévia da mensagem citada em uma resposta de chat.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatReplyPreview {
    pub id: Uuid,
    pub username: String,
    pub snippet: String,
}

/// Mensagem de texto persistida no histórico recente da sala.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatEntry {
    pub id: Uuid,
    pub peer_id: Uuid,
    pub username: String,
    pub room: String,
    pub text: String,
    pub timestamp_ms: u64,
    pub is_system: bool,
    #[serde(default)]
    pub edited_at_ms: Option<u64>,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub reply_to: Option<ChatReplyPreview>,
    #[serde(default)]
    pub reactions: HashMap<String, Vec<Uuid>>,
}

/// Configuração opcional de servidor TURN compartilhada pelo anfitrião aos convidados autenticados.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TurnServerConfig {
    pub urls: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub credential: String,
}

/// Resumo em tempo real de uma sala para prévia na barra lateral.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomSummary {
    pub name: String,
    pub peer_count: usize,
    pub voice_count: usize,
    pub live_count: usize,
    #[serde(default)]
    pub locked: bool,
}

/// Informações de um monitor capturável pelo motor nativo em Rust.
/// Equivale ao retorno de `GetScreenPreviews` (ordinal 121 em `discord_voice.node`)
/// e `getDesktopCaptureSources` (módulo webpack `9425` em `core.asar`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopSourcePreview {
    pub id: String,
    pub monitor_index: usize,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub is_primary: bool,
    /// Miniatura em JPEG Base64 gerada nativamente em Rust
    pub thumbnail_data_url: String,
}

/// Mensagens enviadas do cliente para o servidor Rust via WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    /// Entra ou troca de sala (texto + voz + tela)
    JoinRoom {
        username: String,
        room: String,
    },
    /// Atualiza apenas o apelido sem derrubar voz ou Go Live (P0-10)
    SetUsername {
        username: String,
    },
    /// Envia mensagem de texto no chat da sala atual
    ChatMessage {
        text: String,
        #[serde(default)]
        reply_to_id: Option<Uuid>,
    },
    /// Edita mensagem própria no chat da sala
    EditChatMessage {
        message_id: Uuid,
        text: String,
    },
    /// Exclui (soft-delete) uma mensagem no chat da sala (autor ou anfitrião)
    DeleteChatMessage {
        message_id: Uuid,
    },
    /// Alterna reação emoji em uma mensagem do chat
    ReactChatMessage {
        message_id: Uuid,
        emoji: String,
    },
    /// Indica que o participante está digitando na sala atual
    Typing {
        is_typing: bool,
    },
    /// Atualiza estado de microfone/áudio (`setSelfMute`, `setSelfDeafen`, `setOnSpeakingCallback`)
    UpdateVoiceState {
        #[serde(default)]
        in_voice: bool,
        self_mute: bool,
        self_deaf: bool,
        speaking: bool,
        #[serde(default)]
        voice_relay: bool,
    },
    /// Inicia compartilhamento de tela ("Go Live" — `SetDesktopSource` / `SetVideoBroadcast`)
    StartScreenShare {
        mode: ScreenShareMode,
        source_id: String,
        source_name: String,
        width: u32,
        height: u32,
        fps: u32,
        has_audio: bool,
        /// Usado quando `mode == NativeHost`: qualidade JPEG (1..=100)
        quality: Option<u8>,
    },
    /// Encerra o compartilhamento de tela (`ClearDesktopSource` ordinal 91 / `ClearGoLiveDevices` ordinal 93)
    StopScreenShare,
    /// Quadro de vídeo enviado por qualquer participante no modo `UniversalRelay` (atravessa CGNAT/Internet)
    PushVideoFrame {
        frame_seq: u64,
        width: u32,
        height: u32,
        jpeg_base64: String,
    },
    /// Sinal de backpressure do consumidor de vídeo para o capturador/relay em Rust.
    /// Equivale diretamente a `?SignalVideoOutputSinkReady@Discord@@QEAAX...` (ordinal 237 em `discord_voice.node`):
    /// garante que o servidor não enfileire mais quadros do que o cliente consegue renderizar.
    SignalVideoOutputSinkReady {
        streamer_id: Uuid,
        frame_seq: u64,
    },
    /// Sinalização WebRTC (SDP Offer) para voz e tela P2P
    RtcOffer {
        target_id: Uuid,
        sdp: serde_json::Value,
    },
    /// Sinalização WebRTC (SDP Answer)
    RtcAnswer {
        target_id: Uuid,
        sdp: serde_json::Value,
    },
    /// Sinalização WebRTC (ICE Candidate)
    RtcIceCandidate {
        target_id: Uuid,
        candidate: serde_json::Value,
    },
    /// Medição de latência (Ping -> Pong)
    Ping {
        client_ts: u64,
    },
    /// Ponteiro laser compartilhado no palco (coordenadas normalizadas 0..1)
    LaserPointer {
        x_norm: f32,
        y_norm: f32,
    },
    /// Efeito sonoro no Soundboard da sala
    SoundEffect {
        kind: String,
    },
    /// Expulsa (e opcionalmente bane) um participante (somente anfitrião)
    KickPeer {
        target_id: Uuid,
        #[serde(default)]
        ban: bool,
    },
    /// Silencia ou dessilencia um participante no servidor (somente anfitrião)
    SetPeerServerMute {
        target_id: Uuid,
        muted: bool,
    },
    /// Tranca ou destranca uma sala para exigir aprovação do anfitrião
    ToggleRoomLock {
        room: String,
    },
    /// Anfitrião aprova ou recusa entrada de um participante em sala trancada
    ResolveJoinApproval {
        target_id: Uuid,
        room: String,
        approve: bool,
    },
    /// Exclui uma sala personalizada (exceto #geral — somente anfitrião)
    DeleteRoom {
        room: String,
    },
    /// Limpa o histórico de chat da sala especificada (somente anfitrião)
    ClearChat {
        room: String,
    },
    /// Limpa a lista de banidos da sessão (somente anfitrião)
    UnbanAll,
    /// Define ou limpa a configuração TURN compartilhada com os participantes autenticados (somente anfitrião)
    SetHostTurnConfig {
        turn: Option<TurnServerConfig>,
    },
    /// Informa capacidades de codecs WebCodecs do navegador (Opus, VP8, H.264)
    SetClientCapabilities {
        caps: PeerCapabilities,
    },
    /// Solicita ao transmissor WebCodecs V2 um keyframe imediato para sincronizar decodificador
    RequestVideoKeyframe {
        streamer_id: Uuid,
    },
    /// Configura tecla/botão virtual Windows (VK code) para Push-to-Talk global do anfitrião
    ConfigureGlobalPtt {
        enabled: bool,
        vk_code: Option<u32>,
    },
}

/// Mensagens enviadas do servidor Rust para os clientes via WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    /// Confirmação de conexão inicial com o ID atribuído ao cliente
    Welcome {
        peer_id: Uuid,
        rooms: Vec<String>,
        /// `true` somente para a janela local do anfitrião (autenticada com `host_token`)
        is_host: bool,
        /// Versão do servidor, para avisar sobre versões diferentes entre amigos
        version: String,
        #[serde(default)]
        room_summaries: Vec<RoomSummary>,
    },
    /// Estado completo da sala ao entrar
    RoomState {
        room: String,
        peers: Vec<PeerInfo>,
        chat_history: Vec<ChatEntry>,
        #[serde(default)]
        room_summaries: Vec<RoomSummary>,
        #[serde(default)]
        shared_turn: Option<TurnServerConfig>,
    },
    /// Lista atualizada de salas no servidor (P2-2)
    RoomsUpdated {
        rooms: Vec<String>,
        #[serde(default)]
        room_summaries: Vec<RoomSummary>,
    },
    /// Novo participante entrou na sala
    PeerJoined {
        peer: PeerInfo,
    },
    /// Participante atualizou voz ou iniciou/parou compartilhamento de tela ("Go Live")
    PeerUpdated {
        peer: PeerInfo,
    },
    /// Participante saiu da sala (`SetOnDesktopSourceEnded` se estava transmitindo)
    PeerLeft {
        peer_id: Uuid,
    },
    /// Nova mensagem de chat na sala
    ChatBroadcast {
        entry: ChatEntry,
    },
    /// Atualização de mensagem existente (edição, exclusão ou reações)
    ChatMessageUpdated {
        room: String,
        entry: ChatEntry,
    },
    /// Participante começou ou parou de digitar no chat
    PeerTyping {
        peer_id: Uuid,
        username: String,
        is_typing: bool,
    },
    /// Servidor TURN compartilhado atualizado pelo anfitrião
    TurnConfigUpdated {
        turn: Option<TurnServerConfig>,
    },
    /// Solicita ao transmissor um keyframe WebCodecs imediato
    RequestVideoKeyframe {
        requester_id: Uuid,
    },
    /// Estado do atalho global Push-to-Talk do sistema operacional (Windows) para a janela do anfitrião
    GlobalPttState {
        pressed: bool,
    },
    /// Quadro de vídeo emitido pelo motor nativo em Rust ou pelo Relay Universal (`SetVideoOutputSink` ordinal 231).
    /// O cliente renderiza o quadro e responde com `SignalVideoOutputSinkReady` (ordinal 237).
    NativeVideoFrame {
        streamer_id: Uuid,
        frame_seq: u64,
        width: u32,
        height: u32,
        timestamp_ms: u64,
        jpeg_base64: String,
    },
    /// Repasse de SDP Offer WebRTC
    RtcOffer {
        from_id: Uuid,
        sdp: serde_json::Value,
    },
    /// Repasse de SDP Answer WebRTC
    RtcAnswer {
        from_id: Uuid,
        sdp: serde_json::Value,
    },
    /// Repasse de ICE Candidate WebRTC
    RtcIceCandidate {
        from_id: Uuid,
        candidate: serde_json::Value,
    },
    /// Resposta de latência
    Pong {
        client_ts: u64,
    },
    /// Ponteiro laser de um amigo sobre o palco
    LaserPointer {
        peer_id: Uuid,
        username: String,
        x_norm: f32,
        y_norm: f32,
    },
    /// Efeito sonoro disparado na sala
    SoundEffect {
        peer_id: Uuid,
        username: String,
        kind: String,
    },
    /// Aviso de remoção pelo anfitrião
    Kicked {
        reason: String,
    },
    /// Aviso ao convidado de que a sala está trancada e aguarda aprovação do anfitrião
    JoinApprovalRequired {
        room: String,
    },
    /// Solicitação enviada aos anfitriões para aprovar entrada em sala trancada
    JoinApprovalRequest {
        peer_id: Uuid,
        username: String,
        room: String,
    },
    /// Resultado da solicitação de entrada em sala trancada
    JoinApprovalResult {
        room: String,
        approved: bool,
    },
    /// Histórico da sala limpo pelo anfitrião
    ChatCleared {
        room: String,
        history: Vec<ChatEntry>,
    },
    /// Quadro binário de vídeo (não serializado em JSON; enviado via `Message::Binary`)
    #[serde(skip)]
    BinaryVideoFrame(Vec<u8>),
    /// Pacote binário de áudio/voz no modo Relay (não serializado em JSON; enviado via `Message::Binary`)
    #[serde(skip)]
    BinaryAudioFrame(Vec<u8>),
    /// Notificação de erro
    Error {
        message: String,
    },
}

pub const CLIENT_BINARY_FRAME_MAGIC: &[u8; 4] = b"DVP\x01";
pub const SERVER_BINARY_FRAME_MAGIC: &[u8; 4] = b"DVF\x01";
pub const CLIENT_BINARY_FRAME_V2_MAGIC: &[u8; 4] = b"DVP\x02";
pub const SERVER_BINARY_FRAME_V2_MAGIC: &[u8; 4] = b"DVF\x02";
pub const CLIENT_BINARY_AUDIO_MAGIC: &[u8; 4] = b"DAP\x01";
pub const SERVER_BINARY_AUDIO_MAGIC: &[u8; 4] = b"DAF\x01";
pub const CLIENT_BINARY_AUDIO_V2_MAGIC: &[u8; 4] = b"DAP\x02";
pub const SERVER_BINARY_AUDIO_V2_MAGIC: &[u8; 4] = b"DAF\x02";
pub const MAX_BINARY_AUDIO_BYTES: usize = 8192;

/// Empacota um quadro JPEG enviado pelo cliente (`DVP\x01` + `frame_seq:u64` + `w:u16` + `h:u16` + JPEG).
pub fn encode_client_binary_frame(
    frame_seq: u64,
    width: u16,
    height: u16,
    jpeg_bytes: &[u8],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + jpeg_bytes.len());
    out.extend_from_slice(CLIENT_BINARY_FRAME_MAGIC);
    out.extend_from_slice(&frame_seq.to_be_bytes());
    out.extend_from_slice(&width.to_be_bytes());
    out.extend_from_slice(&height.to_be_bytes());
    out.extend_from_slice(jpeg_bytes);
    out
}

/// Faz parse do quadro binário enviado pelo cliente.
pub fn parse_client_binary_frame(buf: &[u8]) -> Option<(u64, u16, u16, &[u8])> {
    if buf.len() <= 16 || &buf[..4] != CLIENT_BINARY_FRAME_MAGIC {
        return None;
    }
    let frame_seq = u64::from_be_bytes(buf[4..12].try_into().ok()?);
    let width = u16::from_be_bytes(buf[12..14].try_into().ok()?);
    let height = u16::from_be_bytes(buf[14..16].try_into().ok()?);
    Some((frame_seq, width, height, &buf[16..]))
}

/// Empacota um quadro JPEG enviado pelo servidor (`DVF\x01` + `streamer_id:16` + `frame_seq:u64` + `w:u16` + `h:u16` + JPEG).
pub fn encode_server_binary_frame(
    streamer_id: Uuid,
    frame_seq: u64,
    width: u16,
    height: u16,
    jpeg_bytes: &[u8],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(32 + jpeg_bytes.len());
    out.extend_from_slice(SERVER_BINARY_FRAME_MAGIC);
    out.extend_from_slice(streamer_id.as_bytes());
    out.extend_from_slice(&frame_seq.to_be_bytes());
    out.extend_from_slice(&width.to_be_bytes());
    out.extend_from_slice(&height.to_be_bytes());
    out.extend_from_slice(jpeg_bytes);
    out
}

/// Faz parse do quadro binário emitido pelo servidor.
pub fn parse_server_binary_frame(buf: &[u8]) -> Option<(Uuid, u64, u16, u16, &[u8])> {
    if buf.len() <= 32 || &buf[..4] != SERVER_BINARY_FRAME_MAGIC {
        return None;
    }
    let streamer_id = Uuid::from_slice(&buf[4..20]).ok()?;
    let frame_seq = u64::from_be_bytes(buf[20..28].try_into().ok()?);
    let width = u16::from_be_bytes(buf[28..30].try_into().ok()?);
    let height = u16::from_be_bytes(buf[30..32].try_into().ok()?);
    Some((streamer_id, frame_seq, width, height, &buf[32..]))
}

/// Empacota áudio μ-law mono enviado pelo cliente (`DAP\x01` + `sample_rate:u32` + payload).
pub fn encode_client_binary_audio(sample_rate: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + payload.len());
    out.extend_from_slice(CLIENT_BINARY_AUDIO_MAGIC);
    out.extend_from_slice(&sample_rate.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// Faz parse do pacote de áudio binário enviado pelo cliente, validando faixa e tamanho máximo.
pub fn parse_client_binary_audio(buf: &[u8]) -> Option<(u32, &[u8])> {
    if buf.len() <= 8 || &buf[..4] != CLIENT_BINARY_AUDIO_MAGIC {
        return None;
    }
    let payload_len = buf.len() - 8;
    if payload_len > MAX_BINARY_AUDIO_BYTES {
        return None;
    }
    let sample_rate = u32::from_be_bytes(buf[4..8].try_into().ok()?);
    if !(8000..=48000).contains(&sample_rate) {
        return None;
    }
    Some((sample_rate, &buf[8..]))
}

/// Empacota áudio μ-law mono retransmitido pelo servidor (`DAF\x01` + `sender_id:16` + `sample_rate:u32` + payload).
pub fn encode_server_binary_audio(sender_id: Uuid, sample_rate: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(24 + payload.len());
    out.extend_from_slice(SERVER_BINARY_AUDIO_MAGIC);
    out.extend_from_slice(sender_id.as_bytes());
    out.extend_from_slice(&sample_rate.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// Faz parse do pacote de áudio binário emitido pelo servidor.
pub fn parse_server_binary_audio(buf: &[u8]) -> Option<(Uuid, u32, &[u8])> {
    if buf.len() <= 24 || &buf[..4] != SERVER_BINARY_AUDIO_MAGIC {
        return None;
    }
    let sender_id = Uuid::from_slice(&buf[4..20]).ok()?;
    let sample_rate = u32::from_be_bytes(buf[20..24].try_into().ok()?);
    Some((sender_id, sample_rate, &buf[24..]))
}

/// Empacota chunk de vídeo WebCodecs enviado pelo cliente (`DVP\x02`: 18 bytes de cabeçalho + payload).
pub fn encode_client_binary_frame_v2(
    frame_seq: u64,
    width: u16,
    height: u16,
    codec_id: u8,
    flags: u8,
    chunk_bytes: &[u8],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(18 + chunk_bytes.len());
    out.extend_from_slice(CLIENT_BINARY_FRAME_V2_MAGIC);
    out.extend_from_slice(&frame_seq.to_be_bytes());
    out.extend_from_slice(&width.to_be_bytes());
    out.extend_from_slice(&height.to_be_bytes());
    out.push(codec_id);
    out.push(flags);
    out.extend_from_slice(chunk_bytes);
    out
}

/// Faz parse do chunk de vídeo WebCodecs enviado pelo cliente (`DVP\x02`).
pub fn parse_client_binary_frame_v2(buf: &[u8]) -> Option<(u64, u16, u16, u8, u8, &[u8])> {
    if buf.len() <= 18 || &buf[..4] != CLIENT_BINARY_FRAME_V2_MAGIC {
        return None;
    }
    let frame_seq = u64::from_be_bytes(buf[4..12].try_into().ok()?);
    let width = u16::from_be_bytes(buf[12..14].try_into().ok()?);
    let height = u16::from_be_bytes(buf[14..16].try_into().ok()?);
    let codec_id = buf[16];
    if codec_id != 1 && codec_id != 2 {
        return None;
    }
    let flags = buf[17];
    Some((frame_seq, width, height, codec_id, flags, &buf[18..]))
}

/// Empacota chunk de vídeo WebCodecs emitido pelo servidor (`DVF\x02`: 34 bytes de cabeçalho + payload).
pub fn encode_server_binary_frame_v2(
    streamer_id: Uuid,
    frame_seq: u64,
    width: u16,
    height: u16,
    codec_id: u8,
    flags: u8,
    chunk_bytes: &[u8],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(34 + chunk_bytes.len());
    out.extend_from_slice(SERVER_BINARY_FRAME_V2_MAGIC);
    out.extend_from_slice(streamer_id.as_bytes());
    out.extend_from_slice(&frame_seq.to_be_bytes());
    out.extend_from_slice(&width.to_be_bytes());
    out.extend_from_slice(&height.to_be_bytes());
    out.push(codec_id);
    out.push(flags);
    out.extend_from_slice(chunk_bytes);
    out
}

/// Faz parse do chunk de vídeo WebCodecs emitido pelo servidor (`DVF\x02`).
pub fn parse_server_binary_frame_v2(buf: &[u8]) -> Option<(Uuid, u64, u16, u16, u8, u8, &[u8])> {
    if buf.len() <= 34 || &buf[..4] != SERVER_BINARY_FRAME_V2_MAGIC {
        return None;
    }
    let streamer_id = Uuid::from_slice(&buf[4..20]).ok()?;
    let frame_seq = u64::from_be_bytes(buf[20..28].try_into().ok()?);
    let width = u16::from_be_bytes(buf[28..30].try_into().ok()?);
    let height = u16::from_be_bytes(buf[30..32].try_into().ok()?);
    let codec_id = buf[32];
    let flags = buf[33];
    Some((streamer_id, frame_seq, width, height, codec_id, flags, &buf[34..]))
}

/// Empacota áudio Opus enviado pelo cliente (`DAP\x02`: 16 bytes de cabeçalho + payload).
pub fn encode_client_binary_audio_v2(
    sample_rate: u32,
    timestamp_us: u64,
    payload: &[u8],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + payload.len());
    out.extend_from_slice(CLIENT_BINARY_AUDIO_V2_MAGIC);
    out.extend_from_slice(&sample_rate.to_be_bytes());
    out.extend_from_slice(&timestamp_us.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// Faz parse do pacote de áudio Opus enviado pelo cliente (`DAP\x02`).
pub fn parse_client_binary_audio_v2(buf: &[u8]) -> Option<(u32, u64, &[u8])> {
    if buf.len() <= 16 || &buf[..4] != CLIENT_BINARY_AUDIO_V2_MAGIC {
        return None;
    }
    let payload_len = buf.len() - 16;
    if payload_len > MAX_BINARY_AUDIO_BYTES {
        return None;
    }
    let sample_rate = u32::from_be_bytes(buf[4..8].try_into().ok()?);
    if !(8000..=48000).contains(&sample_rate) {
        return None;
    }
    let timestamp_us = u64::from_be_bytes(buf[8..16].try_into().ok()?);
    Some((sample_rate, timestamp_us, &buf[16..]))
}

/// Empacota áudio Opus retransmitido pelo servidor (`DAF\x02`: 32 bytes de cabeçalho + payload).
pub fn encode_server_binary_audio_v2(
    sender_id: Uuid,
    sample_rate: u32,
    timestamp_us: u64,
    payload: &[u8],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(32 + payload.len());
    out.extend_from_slice(SERVER_BINARY_AUDIO_V2_MAGIC);
    out.extend_from_slice(sender_id.as_bytes());
    out.extend_from_slice(&sample_rate.to_be_bytes());
    out.extend_from_slice(&timestamp_us.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// Faz parse do pacote de áudio Opus emitido pelo servidor (`DAF\x02`).
pub fn parse_server_binary_audio_v2(buf: &[u8]) -> Option<(Uuid, u32, u64, &[u8])> {
    if buf.len() <= 32 || &buf[..4] != SERVER_BINARY_AUDIO_V2_MAGIC {
        return None;
    }
    let sender_id = Uuid::from_slice(&buf[4..20]).ok()?;
    let sample_rate = u32::from_be_bytes(buf[20..24].try_into().ok()?);
    let timestamp_us = u64::from_be_bytes(buf[24..32].try_into().ok()?);
    Some((sender_id, sample_rate, timestamp_us, &buf[32..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_message_tags_match_ui() {
        let m: ClientMessage =
            serde_json::from_str(r#"{"type":"join_room","username":"a","room":"geral"}"#).unwrap();
        assert!(matches!(m, ClientMessage::JoinRoom { .. }));

        let m: ClientMessage = serde_json::from_str(
            r#"{"type":"start_screen_share","mode":"native_host","source_id":"screen:0:0","source_name":"x","width":1280,"height":720,"fps":30,"has_audio":false,"quality":null}"#,
        )
        .unwrap();
        match m {
            ClientMessage::StartScreenShare { mode, .. } => assert_eq!(mode, ScreenShareMode::NativeHost),
            _ => panic!("tipo errado"),
        }
    }

    #[test]
    fn server_message_roundtrip() {
        let msg = ServerMessage::Welcome {
            peer_id: Uuid::nil(),
            rooms: vec!["geral".into()],
            is_host: false,
            version: "x".into(),
            room_summaries: vec![],
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"welcome""#));
        assert!(json.contains(r#""is_host":false"#));
    }

    #[test]
    fn legacy_chat_history_deserializes_with_defaults() {
        let legacy_json = r#"{"id":"00000000-0000-0000-0000-000000000001","peer_id":"00000000-0000-0000-0000-000000000000","username":"Bot","room":"geral","text":"oi","timestamp_ms":123,"is_system":true}"#;
        let entry: ChatEntry = serde_json::from_str(legacy_json).unwrap();
        assert!(!entry.deleted);
        assert!(entry.edited_at_ms.is_none());
        assert!(entry.reply_to.is_none());
        assert!(entry.reactions.is_empty());

        let legacy_msg: ClientMessage =
            serde_json::from_str(r#"{"type":"chat_message","text":"olá"}"#).unwrap();
        assert!(matches!(
            legacy_msg,
            ClientMessage::ChatMessage {
                reply_to_id: None,
                ..
            }
        ));

        let kick_legacy: ClientMessage =
            serde_json::from_str(r#"{"type":"kick_peer","target_id":"00000000-0000-0000-0000-000000000001"}"#)
                .unwrap();
        assert!(matches!(kick_legacy, ClientMessage::KickPeer { ban: false, .. }));

        let peer_legacy: PeerInfo = serde_json::from_str(
            r#"{"peer_id":"00000000-0000-0000-0000-000000000001","username":"Gui","room":"geral","is_host":false,"in_voice":false,"self_mute":false,"self_deaf":false,"speaking":false,"screen_share":null}"#,
        )
        .unwrap();
        assert!(!peer_legacy.server_muted);
    }

    #[test]
    fn binary_frame_packet_roundtrip() {
        let client_pkt = encode_client_binary_frame(42, 1280, 720, b"\xff\xd8\xff");
        let (seq, w, h, payload) = parse_client_binary_frame(&client_pkt).unwrap();
        assert_eq!((seq, w, h, payload), (42, 1280, 720, &b"\xff\xd8\xff"[..]));

        let sid = Uuid::new_v4();
        let server_pkt = encode_server_binary_frame(sid, 99, 1920, 1080, b"jpegdata");
        let (parsed_id, s_seq, s_w, s_h, s_payload) = parse_server_binary_frame(&server_pkt).unwrap();
        assert_eq!(
            (parsed_id, s_seq, s_w, s_h, s_payload),
            (sid, 99, 1920, 1080, &b"jpegdata"[..])
        );
    }

    #[test]
    fn binary_audio_packet_roundtrip() {
        let client_pkt = encode_client_binary_audio(16000, &[0x7f, 0x80, 0xff]);
        let (sr, payload) = parse_client_binary_audio(&client_pkt).unwrap();
        assert_eq!(sr, 16000);
        assert_eq!(payload, &[0x7f, 0x80, 0xff]);

        let oversized = encode_client_binary_audio(16000, &vec![0x7f; MAX_BINARY_AUDIO_BYTES + 1]);
        assert!(parse_client_binary_audio(&oversized).is_none());

        let uid = Uuid::new_v4();
        let server_pkt = encode_server_binary_audio(uid, 16000, &[1, 2, 3, 4]);
        let (p_uid, p_sr, p_data) = parse_server_binary_audio(&server_pkt).unwrap();
        assert_eq!((p_uid, p_sr, p_data), (uid, 16000, &[1, 2, 3, 4][..]));
    }

    #[test]
    fn binary_v2_packets_roundtrip() {
        let vid_pkt = encode_client_binary_frame_v2(88, 1280, 720, 1, 1, b"vp8chunk");
        let (seq, w, h, codec, flags, data) = parse_client_binary_frame_v2(&vid_pkt).unwrap();
        assert_eq!((seq, w, h, codec, flags, data), (88, 1280, 720, 1, 1, &b"vp8chunk"[..]));

        let sid = Uuid::new_v4();
        let sv_pkt = encode_server_binary_frame_v2(sid, 88, 1280, 720, 1, 1, b"vp8chunk");
        let (p_sid, p_seq, p_w, p_h, p_c, p_f, p_d) = parse_server_binary_frame_v2(&sv_pkt).unwrap();
        assert_eq!((p_sid, p_seq, p_w, p_h, p_c, p_f, p_d), (sid, 88, 1280, 720, 1, 1, &b"vp8chunk"[..]));

        let aud_pkt = encode_client_binary_audio_v2(48000, 120_000, b"opus");
        let (sr, ts, ap) = parse_client_binary_audio_v2(&aud_pkt).unwrap();
        assert_eq!((sr, ts, ap), (48000, 120_000, &b"opus"[..]));

        let sa_pkt = encode_server_binary_audio_v2(sid, 48000, 120_000, b"opus");
        let (p_uid, p_sr, p_ts, p_ap) = parse_server_binary_audio_v2(&sa_pkt).unwrap();
        assert_eq!((p_uid, p_sr, p_ts, p_ap), (sid, 48000, 120_000, &b"opus"[..]));
    }
}
