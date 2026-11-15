// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("../src/rnnoise-loader.js", () => ({
  createRnnoiseNode: vi.fn(async () => null),
}));
vi.mock("../src/voice-worklet.js", () => ({
  VOICE_CAPTURE_WORKLET_CODE: "",
  registerVoiceCaptureWorklet: vi.fn(async () => false),
}));

import { state, AUTH } from "../src/state.js";
import { buildMediaAuthQuery, resolveMediaUrl, clearChatDom, appendChatEntry } from "../src/chat.js";
import {
  setStageVolume,
  getStageEffectiveVolume,
  getEffectiveVolume,
  handleBinaryAudioFrame,
  cleanupPeerAudioCodecs,
} from "../src/audio-codec.js";
import { applyRoleVisibility } from "../src/invite.js";
import { isSelfServerMuted, toggleMute, syncLocalAudioEnabled } from "../src/voice.js";
import { updateStageView, setSelfPreviewEnabled, toggleStageFullscreen } from "../src/stage.js";

const templatePath = path.resolve(__dirname, "..", "template.html");

function buildDaf1Packet(uuidByte, sampleRate, sampleCount) {
  const buf = new ArrayBuffer(24 + sampleCount);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  bytes[0] = 68; // 'D'
  bytes[1] = 65; // 'A'
  bytes[2] = 70; // 'F'
  bytes[3] = 1;
  bytes.fill(uuidByte, 4, 20);
  view.setUint32(20, sampleRate, false);
  bytes.fill(0xfe, 24);
  return buf;
}

describe("Etapa 4: Mídia `/api/media`, Áudio do Palco `:stage` e Moderação do Host", () => {
  const prevHost = AUTH.host;
  const prevKey = AUTH.key;
  let prevAudioCtx;

  beforeEach(() => {
    document.documentElement.innerHTML = fs.readFileSync(templatePath, "utf8");
    localStorage.clear();
    prevAudioCtx = window.AudioContext;

    AUTH.host = null;
    AUTH.key = null;
    state.customServerOrigin = "";
    state.remoteKey = "";
    state.myPeerId = "me";
    state.isHost = false;
    state.selfMute = false;
    state.selfDeaf = false;
    state.masterVolume = 1.0;
    state.stageVolume = 1.0;
    state.peers.clear();
    state.peerVolumes.clear();
    state.peerConnections.clear();
    state.voicePlaybackPeers.clear();
    state.voiceRelayInboundPeers.clear();
    state.voicePlaybackCtx = null;
    state.localAudioStream = null;
    state.myScreenShareMode = null;
    state.selfPreviewEnabled = false;
    state.localCaptureSurface = "";
    state.watchedStreamerId = null;
    state.gridMode = false;
    state.remoteVideoStreams.clear();
    state.localDisplayStream = null;
  });

  afterEach(() => {
    AUTH.host = prevHost;
    AUTH.key = prevKey;
    window.AudioContext = prevAudioCtx;
  });

  it("resolveMediaUrl anexa token host/key correto e rejeita caminhos inválidos", () => {
    AUTH.host = "host_tok_abc";
    expect(buildMediaAuthQuery()).toBe("host=host_tok_abc");
    expect(resolveMediaUrl("/api/media/foto.webp")).toBe("/api/media/foto.webp?host=host_tok_abc");

    AUTH.host = null;
    AUTH.key = "sala_key_1234567890";
    expect(resolveMediaUrl("/api/media/anim.gif")).toBe("/api/media/anim.gif?key=sala_key_1234567890");

    state.customServerOrigin = "https://demo.trycloudflare.com";
    state.remoteKey = "rem_key_99";
    expect(resolveMediaUrl("/api/media/img.png")).toBe("https://demo.trycloudflare.com/api/media/img.png?key=rem_key_99");

    expect(resolveMediaUrl("javascript:alert(1)")).toBe("");
    expect(resolveMediaUrl("/api/state")).toBe("");
  });

  it("separa Stage Volume da voz de peers e roteia DAF\\x01 24 kHz do NativeHost para `:stage`", () => {
    const streamerId = "11111111-1111-1111-1111-111111111111";
    state.masterVolume = 0.8;
    state.peerVolumes.set(streamerId, 100);
    setStageVolume(25);

    expect(getStageEffectiveVolume()).toBeCloseTo(0.2, 5);
    expect(getEffectiveVolume(streamerId)).toBeCloseTo(0.8, 5);

    window.AudioContext = class FakeAudioContext {
      constructor() {
        this.state = "running";
        this.currentTime = 1.0;
        this.destination = {};
      }
      createGain() {
        return { gain: { value: 1 }, connect() {} };
      }
      createBuffer(_channels, length, sampleRate) {
        const buf = new Float32Array(length);
        return { duration: length / sampleRate, getChannelData: () => buf };
      }
      createBufferSource() {
        return { buffer: null, connect() {}, start() {} };
      }
    };

    // Simula conexão P2P WebRTC ativa para garantir que o áudio do jogo não seja ignorado
    state.peerConnections.set(streamerId, { iceConnectionState: "connected" });
    const fakeRemoteAudio = document.createElement("audio");
    fakeRemoteAudio.id = `audio-${streamerId}-0`;
    Object.defineProperty(fakeRemoteAudio, "paused", { value: false });
    Object.defineProperty(fakeRemoteAudio, "ended", { value: false });
    Object.defineProperty(fakeRemoteAudio, "srcObject", { value: {} });
    document.body.appendChild(fakeRemoteAudio);

    state.peers.set(streamerId, {
      peer_id: streamerId,
      screen_share: { mode: "native_host", fps: 60, has_audio: true },
    });

    handleBinaryAudioFrame(buildDaf1Packet(0x11, 24000, 480));

    const stagePlayback = state.voicePlaybackPeers.get(`${streamerId}:stage`);
    expect(stagePlayback).toBeDefined();
    expect(stagePlayback.gainNode.gain.value).toBeCloseTo(0.2, 5);
    expect(state.voicePlaybackPeers.has(streamerId)).toBe(false);

    setStageVolume(50);
    expect(stagePlayback.gainNode.gain.value).toBeCloseTo(0.4, 5);

    cleanupPeerAudioCodecs(streamerId);
    expect(state.voicePlaybackPeers.has(`${streamerId}:stage`)).toBe(false);
  });

  it("aplica visibilidade de moderação por papel e limpa o DOM ao receber ClearChat", () => {
    state.isHost = false;
    applyRoleVisibility();
    expect(document.getElementById("btnHostClearChat").style.display).toBe("none");
    expect(document.getElementById("btnHostUnbanAll").style.display).toBe("none");
    expect(document.getElementById("modeNativeCard").style.display).toBe("none");

    state.isHost = true;
    applyRoleVisibility();
    expect(document.getElementById("btnHostClearChat").style.display).toBe("inline-flex");
    expect(document.getElementById("btnHostUnbanAll").style.display).toBe("inline-flex");
    expect(document.getElementById("modeNativeCard").style.display).toBe("block");

    appendChatEntry({ id: "old1", peer_id: "p1", name: "Ana", text: "mensagem antiga", ts_ms: 1000 });
    expect(document.getElementById("messagesContainer").textContent).toContain("mensagem antiga");

    clearChatDom([{ id: "sys1", peer_id: "sys", name: "Sistema", text: "Histórico limpo pelo host.", ts_ms: 2000 }]);
    const containerText = document.getElementById("messagesContainer").textContent;
    expect(containerText).not.toContain("mensagem antiga");
    expect(containerText).toContain("Histórico limpo pelo host.");
  });

  it("bloqueia toggleMute e mantém trilha de áudio desabilitada quando server_muted=true", () => {
    const track = { enabled: true };
    state.localAudioStream = { getAudioTracks: () => [track] };
    state.peers.set("me", { peer_id: "me", server_muted: true });

    expect(isSelfServerMuted()).toBe(true);
    syncLocalAudioEnabled();
    expect(track.enabled).toBe(false);

    toggleMute();
    expect(state.selfMute).toBe(false);
    expect(track.enabled).toBe(false);
  });

  it("pausa auto-prévia em captura de tela e desativa prévia ao entrar em Tela Cheia", () => {
    const fakeStream = { id: "disp-1" };
    state.myScreenShareMode = "web_rtc";
    state.localCaptureSurface = "monitor";
    state.selfPreviewEnabled = false;
    state.watchedStreamerId = "me";
    state.remoteVideoStreams.set("me", fakeStream);
    state.peers.set("me", {
      peer_id: "me",
      username: "Amigo-300",
      screen_share: { mode: "web_rtc", width: 1920, height: 1080, fps: 30 },
    });

    const videoEl = document.getElementById("stageVideo");
    const noticeEl = document.getElementById("stageSelfPreviewNotice");
    const canvasEl = document.getElementById("stageCanvas");
    const viewport = document.getElementById("stageViewport");
    canvasEl.getContext = vi.fn(() => ({ clearRect: vi.fn() }));
    viewport.requestFullscreen = vi.fn().mockResolvedValue(undefined);
    videoEl.play = vi.fn().mockResolvedValue(undefined);

    updateStageView();
    expect(noticeEl.style.display).toBe("flex");
    expect(videoEl.style.display).toBe("none");
    expect(videoEl.srcObject).toBeNull();
    expect(document.getElementById("btnStageSelfPreview").style.display).toBe("inline-flex");

    expect(setSelfPreviewEnabled(true)).toBe(true);
    expect(noticeEl.style.display).toBe("none");
    expect(videoEl.style.display).toBe("block");
    expect(videoEl.srcObject).toBe(fakeStream);

    toggleStageFullscreen();
    expect(state.selfPreviewEnabled).toBe(false);
    expect(noticeEl.style.display).toBe("flex");
    expect(videoEl.srcObject).toBeNull();
    expect(viewport.requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it("mantém pré-visualização ativa quando a fonte capturada é câmera", () => {
    const camStream = { id: "cam-1" };
    state.myScreenShareMode = "web_rtc";
    state.localCaptureSurface = "camera";
    state.selfPreviewEnabled = true;
    state.watchedStreamerId = "me";
    state.remoteVideoStreams.set("me", camStream);
    state.peers.set("me", {
      peer_id: "me",
      username: "Celular",
      screen_share: { mode: "web_rtc", width: 1280, height: 720, fps: 30 },
    });

    const videoEl = document.getElementById("stageVideo");
    const noticeEl = document.getElementById("stageSelfPreviewNotice");
    videoEl.play = vi.fn().mockResolvedValue(undefined);

    updateStageView();
    expect(noticeEl.style.display).toBe("none");
    expect(videoEl.style.display).toBe("block");
    expect(videoEl.srcObject).toBe(camStream);
    expect(document.getElementById("btnStageSelfPreview").style.display).toBe("none");
  });
});
