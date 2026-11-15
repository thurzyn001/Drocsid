// Relay de áudio binário (DAP\x01/DAF\x01 μ-law e DAP\x02/DAF\x02 Opus WebCodecs),
// jitter buffer adaptativo por peer, contexto de playback e volumes.

import { state, sendWs, VOICE_RELAY_SAMPLE_RATE } from "./state.js";
import {
  MULAW_DECODE_TABLE,
  linearToMulaw,
  buildClientBinaryAudioFrame,
  parseServerBinaryAudioHeader,
  buildClientBinaryAudioV2Frame,
  parseServerBinaryAudioV2Header,
} from "./protocol.js";

export { linearToMulaw };

let hooks = {
  renderPeers: () => {},
  sendVoiceState: () => {},
};

export function registerAudioCodecHooks(h) {
  hooks = { ...hooks, ...h };
}

export function getEffectiveVolume(peerId) {
  const pVol = peerId && state.peerVolumes.has(peerId) ? state.peerVolumes.get(peerId) / 100 : 1.0;
  return Math.max(0, Math.min(1, state.masterVolume * pVol));
}

export function getStageEffectiveVolume() {
  const sv = typeof state.stageVolume === "number" ? state.stageVolume : 1.0;
  return Math.max(0, Math.min(1, sv * state.masterVolume));
}

export function applyAllAudioVolumes() {
  const videoEl = document.getElementById("stageVideo");
  if (videoEl) videoEl.volume = getStageEffectiveVolume();
  document.querySelectorAll("#remoteAudioContainer audio").forEach(a => {
    const pid = a.dataset.peerId || "";
    a.muted = state.selfDeaf || state.forceVoiceRelay;
    a.volume = getEffectiveVolume(pid);
  });
  for (const [key, st] of state.voicePlaybackPeers.entries()) {
    if (st && st.gainNode) {
      const vol = String(key).endsWith(":stage")
        ? getStageEffectiveVolume()
        : getEffectiveVolume(key);
      st.gainNode.gain.value = state.selfDeaf ? 0 : vol;
    }
  }
}

export function setStageVolume(val) {
  const norm = Math.max(0, Math.min(1, Number(val) / 100));
  state.stageVolume = norm;
  if (typeof localStorage !== "undefined") {
    try { localStorage.setItem("drocsid_stage_vol", String(norm)); } catch (_) {}
  }
  applyAllAudioVolumes();
}

export function setPeerVolume(peerId, val) {
  state.peerVolumes.set(peerId, Math.max(0, Math.min(100, Number(val))));
  applyAllAudioVolumes();
}

export async function applyOutputSinkToElement(el) {
  if (el && state.selectedSpeakerId && typeof el.setSinkId === "function") {
    try {
      await el.setSinkId(state.selectedSpeakerId);
    } catch (_) {}
  }
}

export function ensureVoicePlaybackContext() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!state.voicePlaybackCtx || state.voicePlaybackCtx.state === "closed") {
    state.voicePlaybackCtx = new AudioCtx();
    if (state.selectedSpeakerId && typeof state.voicePlaybackCtx.setSinkId === "function") {
      state.voicePlaybackCtx.setSinkId(state.selectedSpeakerId).catch(() => {});
    }
  }
  if (state.voicePlaybackCtx.state === "suspended") {
    state.voicePlaybackCtx.resume().catch(() => {});
  }
  return state.voicePlaybackCtx;
}

export function isAnyRemoteRelayRequested() {
  for (const p of state.peers.values()) {
    if (p.peer_id !== state.myPeerId && p.voice_relay) return true;
  }
  return false;
}

export function isWebRtcP2pAudioReceiving(peerId) {
  const pc = state.peerConnections.get(peerId);
  if (!pc) return false;
  const st = pc.iceConnectionState;
  if (st !== "connected" && st !== "completed") return false;
  const audios = document.querySelectorAll(`[id^="audio-${peerId}-"]`);
  for (const a of audios) {
    if (!a.paused && !a.ended && a.srcObject) return true;
  }
  return false;
}

export function shouldTransmitVoiceRelay() {
  if (!state.voiceEnabled || state.selfMute || state.selfDeaf) return false;
  if (state.pttEnabled && !state.pttKeyDown) return false;
  const remotePeers = Array.from(state.peers.values()).filter(p => p.peer_id !== state.myPeerId);
  if (remotePeers.length === 0) return false;
  if (state.forceVoiceRelay || isAnyRemoteRelayRequested()) return true;
  const now = Date.now();
  for (const p of remotePeers) {
    const pc = state.peerConnections.get(p.peer_id);
    const st = pc ? pc.iceConnectionState : "new";
    if (st === "failed" || st === "disconnected") return true;
    if (st !== "connected" && st !== "completed") {
      const joinedAt = state.peerJoinedAtMap.get(p.peer_id) || 0;
      const refTs = Math.max(state.voiceJoinedAt, joinedAt);
      if (refTs > 0 && now - refTs >= 3500) return true;
    }
  }
  return false;
}

export function updateVoiceRelayStatusUi() {
  const btn = document.getElementById("btnVoiceRelay");
  if (!btn) return;
  const autoActive = state.voiceEnabled && shouldTransmitVoiceRelay();
  btn.classList.toggle("active-green", state.forceVoiceRelay || autoActive);
  if (state.forceVoiceRelay) {
    btn.textContent = "🌐 Relay: ON";
  } else if (autoActive) {
    btn.textContent = "🌐 Relay: Auto (Ativo)";
  } else {
    btn.textContent = "🌐 Relay: Auto";
  }
}

export function toggleForceVoiceRelay() {
  state.forceVoiceRelay = !state.forceVoiceRelay;
  localStorage.setItem("drocsid_force_voice_relay", state.forceVoiceRelay ? "true" : "false");
  updateVoiceRelayStatusUi();
  applyAllAudioVolumes();
  hooks.sendVoiceState();
  hooks.renderPeers();
}

export async function detectOpusRelayCapable() {
  if (typeof AudioEncoder !== "function" || typeof AudioDecoder !== "function" || typeof AudioData !== "function") {
    return false;
  }
  try {
    const [enc, dec] = await Promise.all([
      AudioEncoder.isConfigSupported({
        codec: "opus",
        sampleRate: 48000,
        numberOfChannels: 1,
        bitrate: 32000,
      }),
      AudioDecoder.isConfigSupported({
        codec: "opus",
        sampleRate: 48000,
        numberOfChannels: 1,
      }),
    ]);
    return Boolean(enc?.supported && dec?.supported);
  } catch {
    return false;
  }
}

export function canUseOpusAudioRelay() {
  if (!state.clientCaps?.opus_relay) return false;
  if (typeof AudioEncoder !== "function" || typeof AudioData !== "function") return false;
  const remotePeers = Array.from(state.peers.values()).filter(p => p.peer_id !== state.myPeerId);
  if (remotePeers.length === 0) return false;
  return remotePeers.every(p => Boolean(p.caps?.opus_relay));
}

export function downsampleToMuLaw16k(float32Samples, inputSampleRate) {
  const srcRate = Math.max(8000, Number(inputSampleRate) || VOICE_RELAY_SAMPLE_RATE);
  if (srcRate === VOICE_RELAY_SAMPLE_RATE) {
    const out = new Uint8Array(float32Samples.length);
    for (let i = 0; i < float32Samples.length; i++) {
      out[i] = linearToMulaw(float32Samples[i]);
    }
    return out;
  }
  const ratio = srcRate / VOICE_RELAY_SAMPLE_RATE;
  const outLen = Math.max(1, Math.floor(float32Samples.length / ratio));
  const out = new Uint8Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(float32Samples.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let acc = 0;
    for (let j = start; j < end; j++) acc += float32Samples[j];
    out[i] = linearToMulaw(acc / (end - start));
  }
  return out;
}

export function sendVoiceRelayPacket(mulawBytes) {
  if (!state.ws || state.ws.readyState !== 1 || state.ws.bufferedAmount > 64 * 1024) return;
  state.ws.send(buildClientBinaryAudioFrame(VOICE_RELAY_SAMPLE_RATE, mulawBytes));
}

export function resetOpusAudioEncoder() {
  if (state.opusAudioEncoder) {
    try {
      if (state.opusAudioEncoder.state !== "closed") state.opusAudioEncoder.close();
    } catch {}
    state.opusAudioEncoder = null;
  }
  state.opusEncoderTimestampUs = 0;
}

function ensureOpusAudioEncoder(sampleRate) {
  if (state.opusAudioEncoder && state.opusAudioEncoder.state === "configured") {
    return state.opusAudioEncoder;
  }
  resetOpusAudioEncoder();
  try {
    const encoder = new AudioEncoder({
      output: (chunk) => {
        if (!state.ws || state.ws.readyState !== 1 || state.ws.bufferedAmount > 64 * 1024) return;
        const opusBytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(opusBytes);
        state.ws.send(buildClientBinaryAudioV2Frame(sampleRate, chunk.timestamp || 0, opusBytes));
      },
      error: () => {
        resetOpusAudioEncoder();
      },
    });
    encoder.configure({
      codec: "opus",
      sampleRate,
      numberOfChannels: 1,
      bitrate: 32000,
      opus: { application: "voip", complexity: 5, frameDuration: 20000 },
    });
    state.opusAudioEncoder = encoder;
    return encoder;
  } catch {
    resetOpusAudioEncoder();
    return null;
  }
}

export function sendCapturedVoiceFrame(float32Samples, sampleRate) {
  if (!float32Samples || float32Samples.length === 0) return;
  if (!state.ws || state.ws.readyState !== 1 || state.ws.bufferedAmount > 64 * 1024) return;

  if (canUseOpusAudioRelay() && sampleRate === 48000) {
    const encoder = ensureOpusAudioEncoder(sampleRate);
    if (encoder && encoder.state === "configured" && encoder.encodeQueueSize < 8) {
      const tsUs = state.opusEncoderTimestampUs || Math.round(performance.now() * 1000);
      state.opusEncoderTimestampUs = tsUs + Math.round((float32Samples.length / sampleRate) * 1_000_000);
      const pcmCopy = new Float32Array(float32Samples);
      let audioData = null;
      try {
        audioData = new AudioData({
          format: "f32",
          sampleRate,
          numberOfFrames: pcmCopy.length,
          numberOfChannels: 1,
          timestamp: tsUs,
          data: pcmCopy,
        });
        encoder.encode(audioData);
        return;
      } catch {
        resetOpusAudioEncoder();
      } finally {
        if (audioData) {
          try { audioData.close(); } catch {}
        }
      }
    }
  }

  // Fallback compatível com todos os navegadores (μ-law 16 kHz)
  const mulaw = downsampleToMuLaw16k(float32Samples, sampleRate);
  state.voiceRelayAccumBuf.set(mulaw.subarray(0, Math.min(mulaw.length, state.voiceRelayAccumBuf.length)));
  sendVoiceRelayPacket(mulaw);
}

/**
 * Calcula e atualiza o atraso alvo do jitter buffer adaptativo (35 ms a 240 ms)
 * usando média exponencial móvel da variação entre chegadas de pacotes.
 */
export function updateJitterEstimate(jState, arrivalMs, frameDurationSec) {
  const expectedMs = Math.max(10, Math.min(100, (frameDurationSec || 0.02) * 1000));
  if (jState.lastArrivalMs > 0) {
    const deltaMs = arrivalMs - jState.lastArrivalMs;
    const transitDiff = Math.min(180, Math.abs(deltaMs - expectedMs));
    jState.jitterMs = jState.jitterMs * 0.875 + transitDiff * 0.125;
  }
  jState.lastArrivalMs = arrivalMs;
  const targetSec = 0.035 + (jState.jitterMs * 2.5) / 1000;
  jState.targetDelaySec = Math.max(0.035, Math.min(0.24, targetSec));
  return jState.targetDelaySec;
}

function scheduleDecodedAudioBuffer(senderId, audioBuf) {
  const ctx = ensureVoicePlaybackContext();
  if (!ctx || ctx.state === "suspended") return;

  let pState = state.voicePlaybackPeers.get(senderId);
  const playbackGain = String(senderId).endsWith(":stage")
    ? getStageEffectiveVolume()
    : getEffectiveVolume(senderId);
  if (!pState) {
    const gainNode = ctx.createGain();
    gainNode.gain.value = state.selfDeaf ? 0 : playbackGain;
    gainNode.connect(ctx.destination);
    pState = {
      gainNode,
      nextTime: 0,
      lastArrivalMs: 0,
      jitterMs: 12,
      targetDelaySec: 0.065,
    };
    state.voicePlaybackPeers.set(senderId, pState);
  }
  pState.gainNode.gain.value = state.selfDeaf ? 0 : playbackGain;

  const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
  const targetDelay = updateJitterEstimate(pState, nowMs, audioBuf.duration);

  const src = ctx.createBufferSource();
  src.buffer = audioBuf;
  src.connect(pState.gainNode);

  const now = ctx.currentTime;
  const leadTime = pState.nextTime - now;
  if (!pState.nextTime || leadTime < 0.008) {
    pState.nextTime = now + targetDelay;
  } else if (leadTime > Math.max(0.28, targetDelay * 2.4)) {
    pState.nextTime = now + targetDelay;
  }
  src.start(pState.nextTime);
  pState.nextTime += audioBuf.duration;
}

function getOrCreateOpusDecoder(senderId, sampleRate) {
  if (typeof AudioDecoder !== "function" || typeof EncodedAudioChunk !== "function") return null;
  let entry = state.opusDecodersByPeer.get(senderId);
  if (entry && entry.decoder && entry.decoder.state === "configured" && entry.sampleRate === sampleRate) {
    return entry.decoder;
  }
  if (entry?.decoder) {
    try { entry.decoder.close(); } catch {}
  }
  try {
    const decoder = new AudioDecoder({
      output: (audioData) => {
        try {
          if (state.selfDeaf) return;
          const ctx = ensureVoicePlaybackContext();
          if (!ctx || ctx.state === "suspended") return;
          const channels = Math.max(1, audioData.numberOfChannels || 1);
          const frames = audioData.numberOfFrames;
          const sr = audioData.sampleRate || sampleRate;
          if (!frames || sr < 8000 || sr > 48000) return;

          const audioBuf = ctx.createBuffer(1, frames, sr);
          const tmp = new Float32Array(frames);
          audioData.copyTo(tmp, { planeIndex: 0 });
          if (channels > 1) {
            const ch2 = new Float32Array(frames);
            try {
              audioData.copyTo(ch2, { planeIndex: 1 });
              for (let i = 0; i < frames; i++) tmp[i] = (tmp[i] + ch2[i]) * 0.5;
            } catch {}
          }
          audioBuf.copyToChannel(tmp, 0);
          scheduleDecodedAudioBuffer(senderId, audioBuf);
        } finally {
          try { audioData.close(); } catch {}
        }
      },
      error: () => {
        state.opusDecodersByPeer.delete(senderId);
      },
    });
    decoder.configure({
      codec: "opus",
      sampleRate,
      numberOfChannels: 1,
    });
    state.opusDecodersByPeer.set(senderId, { decoder, sampleRate });
    return decoder;
  } catch {
    state.opusDecodersByPeer.delete(senderId);
    return null;
  }
}

export function cleanupPeerAudioCodecs(peerId) {
  const entry = state.opusDecodersByPeer.get(peerId);
  if (entry?.decoder) {
    try {
      if (entry.decoder.state !== "closed") entry.decoder.close();
    } catch {}
  }
  state.opusDecodersByPeer.delete(peerId);
  state.voicePlaybackPeers.delete(peerId);
  state.voicePlaybackPeers.delete(`${peerId}:stage`);
  state.voiceRelayInboundPeers.delete(peerId);
}

export function handleBinaryAudioFrame(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 4) return;
  const magic = new Uint8Array(buffer, 0, 4);
  const isV2 = magic[0] === 0x44 && magic[1] === 0x41 && magic[2] === 0x46 && magic[3] === 0x02;

  const parsed = isV2 ? parseServerBinaryAudioV2Header(buffer) : parseServerBinaryAudioHeader(buffer);
  if (!parsed) return;
  const { senderId, sampleRate, payload: encoded } = parsed;
  if (senderId === state.myPeerId) return;
  if (sampleRate < 8000 || sampleRate > 48000) return;

  const senderPeer = state.peers.get(senderId);
  const isNativeStageAudio =
    !isV2 &&
    sampleRate === 24000 &&
    senderPeer?.screen_share?.mode === "native_host" &&
    Boolean(senderPeer?.screen_share?.has_audio);
  const playbackKey = isNativeStageAudio ? `${senderId}:stage` : senderId;

  if (!isNativeStageAudio) {
    const wasInbound = state.voiceRelayInboundPeers.has(senderId);
    state.voiceRelayInboundPeers.set(senderId, Date.now());
    if (!wasInbound) hooks.renderPeers();
  }

  if (state.selfDeaf) return;
  if (
    !isNativeStageAudio &&
    !state.forceVoiceRelay &&
    !state.peers.get(state.myPeerId)?.voice_relay &&
    isWebRtcP2pAudioReceiving(senderId)
  ) {
    return;
  }

  const ctx = ensureVoicePlaybackContext();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    const unlockBtn = document.getElementById("btnUnlockAudio");
    if (unlockBtn) unlockBtn.style.display = "block";
    return;
  }

  if (encoded.length === 0) return;

  if (isV2) {
    const decoder = getOrCreateOpusDecoder(senderId, sampleRate);
    if (!decoder || decoder.state !== "configured") return;
    try {
      decoder.decode(new EncodedAudioChunk({
        type: "key",
        timestamp: Number(parsed.timestampUs || 0),
        data: encoded,
      }));
    } catch {
      cleanupPeerAudioCodecs(senderId);
    }
    return;
  }

  const audioBuf = ctx.createBuffer(1, encoded.length, sampleRate);
  const ch = audioBuf.getChannelData(0);
  for (let i = 0; i < encoded.length; i++) {
    ch[i] = MULAW_DECODE_TABLE[encoded[i]];
  }
  scheduleDecodedAudioBuffer(playbackKey, audioBuf);
}
