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
    /// Estado ativo de compartilhamento de tela ("Go Live")
    pub screen_share: Option<ScreenShareInfo>,
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
    },
    /// Atualiza estado de microfone/áudio (`setSelfMute`, `setSelfDeafen`, `setOnSpeakingCallback`)
    UpdateVoiceState {
        #[serde(default)]
        in_voice: bool,
        self_mute: bool,
        self_deaf: bool,
        speaking: bool,
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
    /// Expulsa um participante (somente anfitrião)
    KickPeer {
        target_id: Uuid,
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
    },
    /// Estado completo da sala ao entrar
    RoomState {
        room: String,
        peers: Vec<PeerInfo>,
        chat_history: Vec<ChatEntry>,
    },
    /// Lista atualizada de salas no servidor (P2-2)
    RoomsUpdated {
        rooms: Vec<String>,
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
    /// Quadro binário de vídeo (não serializado em JSON; enviado via `Message::Binary`)
    #[serde(skip)]
    BinaryVideoFrame(Vec<u8>),
    /// Notificação de erro
    Error {
        message: String,
    },
}

pub const CLIENT_BINARY_FRAME_MAGIC: &[u8; 4] = b"DVP\x01";
pub const SERVER_BINARY_FRAME_MAGIC: &[u8; 4] = b"DVF\x01";

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
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"welcome""#));
        assert!(json.contains(r#""is_host":false"#));
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
}
