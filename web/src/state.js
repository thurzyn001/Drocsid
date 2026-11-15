// Estado global compartilhado da SPA Drocsid

export const BASE_DOC_TITLE = "Drocsid — Chat, Voz & Go Live (Internet & P2P)";
export const APP_VERSION = typeof __DROCSID_APP_VERSION__ !== "undefined" ? __DROCSID_APP_VERSION__ : "0.4.0";
export const VOICE_RELAY_SAMPLE_RATE = 16000;
export const VOICE_RELAY_CHUNK_SAMPLES = 640; // 40ms @ 16kHz

function readStorage(storage, key) {
  try {
    return storage ? storage.getItem(key) : null;
  } catch (_) {
    return null;
  }
}

function writeStorage(storage, key, val) {
  try {
    if (storage) storage.setItem(key, val);
  } catch (_) {}
}

export function initAuth() {
  if (typeof window === "undefined" || typeof location === "undefined") {
    return { host: null, key: null, invite: "" };
  }
  const hashParams = new URLSearchParams(location.hash.slice(1));
  const queryParams = new URLSearchParams(location.search);
  const isLocalHost = location.hostname === "127.0.0.1" || location.hostname === "localhost";
  const lsKeyName = "drocsid_key_" + (location.host || "local");
  const host = hashParams.get("host")
    || readStorage(window.sessionStorage, "drocsid_host")
    || (isLocalHost ? readStorage(window.localStorage, "drocsid_host_local") : null);
  const key = hashParams.get("key")
    || queryParams.get("key")
    || readStorage(window.sessionStorage, "drocsid_key")
    || readStorage(window.localStorage, lsKeyName);
  const invite = hashParams.get("invite") || queryParams.get("invite") || "";

  if (hashParams.get("host")) {
    writeStorage(window.sessionStorage, "drocsid_host", host);
    if (isLocalHost) {
      writeStorage(window.localStorage, "drocsid_host_local", host);
    } else if (typeof history !== "undefined") {
      history.replaceState(null, "", location.pathname + location.search);
    }
  }
  if (key) {
    writeStorage(window.sessionStorage, "drocsid_key", key);
    writeStorage(window.localStorage, lsKeyName, key);
  }
  return { host, key, invite };
}

function getOrCreateClientSessionId() {
  if (typeof localStorage === "undefined") return "session_node";
  const existing = readStorage(localStorage, "drocsid_client_id");
  if (existing && existing.length >= 6) return existing;
  const fresh = "cid_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  writeStorage(localStorage, "drocsid_client_id", fresh);
  return fresh;
}

export const AUTH = initAuth();

export const state = {
  isHost: false,
  remoteKey: null, // chave da sala do amigo quando conectado a outro servidor
  ws: null,
  customServerOrigin: null, // null = mesmo host atual, ou "https://xxxx.trycloudflare.com"
  myPeerId: null,
  clientSessionId: getOrCreateClientSessionId(),
  currentRoom: "geral",
  knownRooms: ["geral", "jogos", "cinema-tela"],
  roomSummaries: new Map(),
  pendingJoinApprovals: [],
  peers: new Map(),
  serverVersion: null,
  sharedTurnConfig: null,
  pinnedGridPeerId: null,
  pipProxyVideoEl: null,
  pipActive: false,
  replyingTo: null,
  editingMessageId: null,
  typingPeers: new Map(),
  chatEntriesById: new Map(),
  theme: typeof localStorage !== "undefined" ? (readStorage(localStorage, "drocsid_theme") || "dark") : "dark",
  density: typeof localStorage !== "undefined" ? (readStorage(localStorage, "drocsid_density") || "cozy") : "cozy",
  qrExpanded: false,

  localAudioStream: null,
  localDisplayStream: null,
  localWebcamStream: null,
  relayIntervalId: null,
  voiceEnabled: false,
  selfMute: false,
  selfDeaf: false,
  isSpeaking: false,
  myScreenShareMode: null, // null | "web_rtc" | "universal_relay" | "native_host"
  selfPreviewEnabled: false,
  localCaptureSurface: "", // "camera" | "monitor" | "window" | "browser" | "native_host" | ""

  peerConnections: new Map(),
  remoteVideoStreams: new Map(),
  remoteWebcamStreams: new Map(),
  pendingCandidates: new Map(),
  makingOfferMap: new Map(),

  watchedStreamerId: null,
  selectedShareMode: "web_rtc",
  nativePreviews: [],
  selectedMonitorIndex: 0,

  renderedFramesCount: 0,
  lastFpsTick: typeof performance !== "undefined" ? performance.now() : 0,
  measuredFps: 0,
  pingMs: null,
  pingIntervalId: null,
  currentInviteText: "",
  masterVolume: 1.0,
  stageVolume: typeof localStorage !== "undefined" ? Math.min(1, Math.max(0, Number(readStorage(localStorage, "drocsid_stage_vol") ?? "1") || 0)) : 1.0,
  unreadCount: 0,
  peerVolumes: new Map(),
  selectedMicId: typeof localStorage !== "undefined" ? (readStorage(localStorage, "drocsid_mic_id") || "") : "",
  selectedSpeakerId: typeof localStorage !== "undefined" ? (readStorage(localStorage, "drocsid_speaker_id") || "") : "",
  rnnoiseEnabled: typeof localStorage !== "undefined" ? readStorage(localStorage, "drocsid_rnnoise") !== "false" : true,
  micGain: typeof localStorage !== "undefined" ? Math.min(2.5, Math.max(0.1, Number(readStorage(localStorage, "drocsid_mic_gain") || "1") || 1.0)) : 1.0,
  vadThreshold: typeof localStorage !== "undefined" ? Math.min(0.12, Math.max(0.003, Number(readStorage(localStorage, "drocsid_vad_threshold") || "0.015") || 0.015)) : 0.015,
  pttEnabled: typeof localStorage !== "undefined" ? readStorage(localStorage, "drocsid_ptt") === "true" : false,
  pttBinding: (() => {
    const fallback = { type: "key", code: "KeyV", label: "V (ou Espaço padrão)", vk: 0x56, defaultCompat: true };
    if (typeof localStorage === "undefined") return fallback;
    try {
      const raw = readStorage(localStorage, "drocsid_ptt_binding");
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      if (parsed && (parsed.type === "key" || parsed.type === "mouse") && parsed.label) return parsed;
    } catch {}
    return fallback;
  })(),
  globalPttEnabled: typeof localStorage !== "undefined" ? readStorage(localStorage, "drocsid_global_ptt") === "true" : false,
  capturingPttBind: false,
  pttKeyDown: false,
  micTestActive: false,
  notifAudioCtx: null,
  vadAudioCtx: null,
  vadIntervalId: null,
  gridMode: false,
  laserMode: false,
  theaterMode: false,
  lastLaserSentAt: 0,
  layoutViewMode: "split",
  webrtcWatchdogId: null,
  relayHiddenVideoEl: null,

  clientCaps: { opus_relay: false, vp8_relay: false, h264_relay: false },
  forceVoiceRelay: typeof localStorage !== "undefined" ? readStorage(localStorage, "drocsid_force_voice_relay") === "true" : false,
  prevAutoRelayActive: false,
  voiceJoinedAt: 0,
  peerJoinedAtMap: new Map(),
  pendingRenegotiatePeers: new Set(),
  voiceRelayInboundPeers: new Map(),
  voicePlaybackPeers: new Map(),
  voicePlaybackCtx: null,
  voiceCaptureCtx: null,
  voiceCaptureRawStream: null,
  voiceRnnoiseNode: null,
  voiceGainNode: null,
  voiceAnalyserNode: null,
  voiceLoopbackGainNode: null,
  voiceWorkletNode: null,
  voiceRelayProcessorNode: null,
  voiceRelayZeroGainNode: null,
  micPreviewCtx: null,
  micPreviewStream: null,
  micPreviewGainNode: null,
  micPreviewAnalyser: null,
  micPreviewLoopbackGain: null,
  micPreviewRafId: null,
  voiceRelayAccumBuf: new Float32Array(VOICE_RELAY_CHUNK_SAMPLES),
  voiceRelayAccumLen: 0,
  voiceRelayHangoverUntil: 0,
  opusAudioEncoder: null,
  opusEncoderTimestampUs: 0,
  opusDecodersByPeer: new Map(),
  videoEncoderV2: null,
  videoEncoderV2Codec: null,
  videoEncoderV2Seq: 0,
  videoDecodersByPeer: new Map(),
  forceNextVideoKeyframe: false,
  lastKeyframeReqByPeer: new Map(),
};

export function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function peerAvatarColor(peerId) {
  let hash = 0;
  const str = String(peerId || "");
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 62%, 44%)`;
}

export function isMobileDevice() {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "") || window.innerWidth <= 900;
}

export function isRemoteOrMobile() {
  if (typeof location === "undefined") return false;
  return Boolean(state.customServerOrigin)
    || (location.hostname !== "127.0.0.1" && location.hostname !== "localhost")
    || isMobileDevice();
}

export function isEditableElementFocused() {
  if (typeof document === "undefined") return false;
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return true;
  if (tag === "INPUT") {
    const type = (el.type || "text").toLowerCase();
    return type !== "range" && type !== "checkbox" && type !== "button";
  }
  return false;
}

export function hostFetch(path, opts = {}) {
  return fetch(path, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${AUTH.host || ""}` }
  });
}

export function sendWs(payload) {
  if (state.ws && state.ws.readyState === 1) { // WebSocket.OPEN === 1
    state.ws.send(JSON.stringify(payload));
  }
}
