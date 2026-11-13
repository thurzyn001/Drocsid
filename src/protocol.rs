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
    /// Notificação de erro
    Error {
        message: String,
    },
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
}
