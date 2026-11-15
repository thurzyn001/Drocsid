// Captura de microfone 48 kHz, RNNoise WASM, AudioWorklet, VAD, VU Meter,
// Ganho/Compressor, Push-to-Talk configurável e PTT global no Windows.

import {
  state,
  sendWs,
  isEditableElementFocused,
  VOICE_RELAY_SAMPLE_RATE,
  VOICE_RELAY_CHUNK_SAMPLES,
} from "./state.js";
import { showToast } from "./ui-feedback.js";
import { createRnnoiseNode } from "./rnnoise-loader.js";
import { registerVoiceCaptureWorklet } from "./voice-worklet.js";
import {
  linearToMulaw,
  ensureVoicePlaybackContext,
  applyOutputSinkToElement,
  applyAllAudioVolumes,
  shouldTransmitVoiceRelay,
  updateVoiceRelayStatusUi,
  sendVoiceRelayPacket,
  sendCapturedVoiceFrame,
  resetOpusAudioEncoder,
} from "./audio-codec.js";

let hooks = {
  renderPeers: () => {},
  renegotiateAllPeers: async () => {},
};

let pendingPttBinding = null;

export function registerVoiceHooks(h) {
  hooks = { ...hooks, ...h };
}

export function codeToWin32Vk(code) {
  if (!code) return 0;
  if (code === "Space") return 0x20;
  if (code === "Tab") return 0x09;
  if (code === "CapsLock") return 0x14;
  if (code === "ShiftLeft" || code === "ShiftRight") return 0x10;
  if (code === "ControlLeft" || code === "ControlRight") return 0x11;
  if (code === "AltLeft" || code === "AltRight") return 0x12;
  if (code === "Backquote") return 0xc0;
  if (code === "Backslash") return 0xdc;
  if (code === "Minus") return 0xbd;
  if (code === "Equal") return 0xbb;
  if (code === "BracketLeft") return 0xdb;
  if (code === "BracketRight") return 0xdd;
  if (/^Key([A-Z])$/.test(code)) return code.charCodeAt(3);
  if (/^Digit([0-9])$/.test(code)) return code.charCodeAt(5);
  const fnMatch = /^F([1-9]|1[0-2])$/.exec(code);
  if (fnMatch) return 0x6f + Number(fnMatch[1]);
  const numMatch = /^Numpad([0-9])$/.exec(code);
  if (numMatch) return 0x60 + Number(numMatch[1]);
  return 0;
}

export function rmsToVuPercent(rms) {
  return Math.max(0, Math.min(100, Math.sqrt(Math.max(0, rms)) * 280));
}

function formatPttKeyLabel(code, key) {
  if (code === "Space") return "Espaço";
  if (code?.startsWith("Key")) return code.slice(3);
  if (code?.startsWith("Digit")) return code.slice(5);
  return key && key.length === 1 ? key.toUpperCase() : (code || "Tecla");
}

function isMatchingPttKeyEvent(e) {
  const b = state.pttBinding;
  if (!b) return e.code === "KeyV" || e.code === "Space";
  if (b.defaultCompat) return e.code === "KeyV" || e.code === "Space";
  return b.type === "key" && b.code === e.code;
}

export function updateVoiceButtonLabel() {
  const btn = document.getElementById("btnVoice");
  const mBtn = document.getElementById("mBtnVoice");
  if (!state.voiceEnabled) {
    btn.textContent = "🎙️ Entrar na Voz";
    btn.classList.remove("active-green");
    if (mBtn) {
      mBtn.textContent = "🎙️ Voz";
      mBtn.classList.remove("active-green");
    }
    return;
  }
  btn.classList.add("active-green");
  if (mBtn) {
    mBtn.textContent = "🟢 Voz";
    mBtn.classList.add("active-green");
  }
  if (state.pttEnabled) {
    const label = state.pttBinding?.defaultCompat ? "V/Espaço" : (state.pttBinding?.label || "Tecla");
    btn.textContent = state.pttKeyDown ? "🟢 Falando" : `🟡 Segure ${label}`;
  } else {
    btn.textContent = "🟢 Voz Conectada";
  }
}

export async function captureMicStream(deviceIdOverride = null) {
  const devId = deviceIdOverride !== null ? deviceIdOverride : state.selectedMicId;
  // Quando RNNoise WASM está ativo, desabilita noiseSuppression nativa redundante para preservar timbres.
  const baseAudio = {
    echoCancellation: true,
    noiseSuppression: !state.rnnoiseEnabled,
    autoGainControl: !state.rnnoiseEnabled,
    sampleRate: { ideal: 48000 },
    channelCount: { ideal: 1 },
  };
  if (devId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...baseAudio, deviceId: { exact: devId } },
        video: false,
      });
    } catch (_) {
      if (deviceIdOverride === null) {
        state.selectedMicId = "";
        localStorage.removeItem("drocsid_mic_id");
      }
    }
  }
  return await navigator.mediaDevices.getUserMedia({ audio: baseAudio, video: false });
}

function updateVuDom(rms, threshold) {
  const fill = document.getElementById("micVuFill");
  const mark = document.getElementById("micVuThresholdMark");
  if (fill) fill.style.width = rmsToVuPercent(rms).toFixed(1) + "%";
  if (mark) mark.style.left = rmsToVuPercent(threshold).toFixed(1) + "%";
}

function stopMicPreviewPipeline() {
  if (state.micPreviewRafId) {
    cancelAnimationFrame(state.micPreviewRafId);
    state.micPreviewRafId = null;
  }
  if (state.voiceLoopbackGainNode) {
    state.voiceLoopbackGainNode.gain.value = 0;
  }
  if (state.micPreviewLoopbackGain) {
    try { state.micPreviewLoopbackGain.disconnect(); } catch {}
    state.micPreviewLoopbackGain = null;
  }
  if (state.micPreviewGainNode) {
    try { state.micPreviewGainNode.disconnect(); } catch {}
    state.micPreviewGainNode = null;
  }
  state.micPreviewAnalyser = null;
  if (state.micPreviewStream) {
    state.micPreviewStream.getTracks().forEach(t => t.stop());
    state.micPreviewStream = null;
  }
  if (state.micPreviewCtx) {
    state.micPreviewCtx.close().catch(() => {});
    state.micPreviewCtx = null;
  }
  state.micTestActive = false;
  const btn = document.getElementById("btnMicTest");
  if (btn) {
    btn.classList.remove("active-green");
    btn.textContent = "🎧 Testar Microfone";
  }
}

async function startMicPreviewAnalyser() {
  if (state.micPreviewRafId) {
    cancelAnimationFrame(state.micPreviewRafId);
    state.micPreviewRafId = null;
  }

  let analyser = state.voiceEnabled ? state.voiceAnalyserNode : state.micPreviewAnalyser;
  if (!analyser && !state.voiceEnabled) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const micId = document.getElementById("micSelect")?.value || state.selectedMicId;
      state.micPreviewStream = await captureMicStream(micId || "");
      state.micPreviewCtx = new AudioCtx({ sampleRate: 48000 });
      if (state.micPreviewCtx.state === "suspended") {
        await state.micPreviewCtx.resume().catch(() => {});
      }
      const src = state.micPreviewCtx.createMediaStreamSource(state.micPreviewStream);
      const gain = state.micPreviewCtx.createGain();
      const rangeVal = Number(document.getElementById("micGainRange")?.value || Math.round(state.micGain * 100));
      gain.gain.value = rangeVal / 100;
      const previewAnalyser = state.micPreviewCtx.createAnalyser();
      previewAnalyser.fftSize = 512;
      const loopGain = state.micPreviewCtx.createGain();
      loopGain.gain.value = state.micTestActive ? 1.0 : 0.0;

      src.connect(gain);
      gain.connect(previewAnalyser);
      gain.connect(loopGain);
      loopGain.connect(state.micPreviewCtx.destination);

      state.micPreviewGainNode = gain;
      state.micPreviewAnalyser = previewAnalyser;
      state.micPreviewLoopbackGain = loopGain;
      analyser = previewAnalyser;
    } catch {
      return;
    }
  }

  if (!analyser) return;
  const modal = document.getElementById("audioSettingsModal");
  const buf = new Float32Array(analyser.fftSize);
  const tick = () => {
    if (!modal?.classList.contains("open")) return;
    const activeAnalyser = state.voiceEnabled ? state.voiceAnalyserNode : state.micPreviewAnalyser;
    if (!activeAnalyser) return;
    activeAnalyser.getFloatTimeDomainData(buf);
    let sq = 0;
    for (let i = 0; i < buf.length; i++) sq += buf[i] * buf[i];
    const rms = Math.sqrt(sq / buf.length);
    const thr = Number(document.getElementById("vadThresholdRange")?.value || Math.round(state.vadThreshold * 1000)) / 1000;
    updateVuDom(rms, thr);
    state.micPreviewRafId = requestAnimationFrame(tick);
  };
  state.micPreviewRafId = requestAnimationFrame(tick);
}

export function previewMicGainChange(val) {
  const num = Math.max(20, Math.min(220, Number(val) || 100));
  const lbl = document.getElementById("micGainValue");
  if (lbl) lbl.textContent = num + "%";
  const ratio = num / 100;
  if (state.voiceGainNode) state.voiceGainNode.gain.value = ratio;
  if (state.micPreviewGainNode) state.micPreviewGainNode.gain.value = ratio;
}

export function previewVadThresholdChange(val) {
  const num = Math.max(3, Math.min(80, Number(val) || 15));
  const thr = num / 1000;
  const lbl = document.getElementById("vadThresholdValue");
  if (lbl) lbl.textContent = (num / 10).toFixed(1) + "%";
  const mark = document.getElementById("micVuThresholdMark");
  if (mark) mark.style.left = rmsToVuPercent(thr).toFixed(1) + "%";
}

export async function toggleMicLoopbackTest() {
  state.micTestActive = !state.micTestActive;
  const btn = document.getElementById("btnMicTest");
  if (btn) {
    btn.classList.toggle("active-green", state.micTestActive);
    btn.textContent = state.micTestActive ? "🔊 Parar Teste" : "🎧 Testar Microfone";
  }
  if (!state.voiceEnabled && !state.micPreviewCtx) {
    await startMicPreviewAnalyser();
  }
  if (state.voiceLoopbackGainNode) {
    state.voiceLoopbackGainNode.gain.value = state.micTestActive ? 1.0 : 0.0;
  }
  if (state.micPreviewLoopbackGain) {
    state.micPreviewLoopbackGain.gain.value = state.micTestActive ? 1.0 : 0.0;
  }
}

export function startCapturePttBind() {
  state.capturingPttBind = true;
  const btn = document.getElementById("btnBindPttKey");
  if (btn) {
    btn.classList.add("active-green");
    btn.textContent = "⌨️ Pressione tecla ou mouse lateral...";
  }
}

function finishCapturePttBind(binding) {
  state.capturingPttBind = false;
  pendingPttBinding = binding;
  const lbl = document.getElementById("pttBindingLabel");
  if (lbl) lbl.textContent = binding.label;
  const btn = document.getElementById("btnBindPttKey");
  if (btn) {
    btn.classList.remove("active-green");
    btn.textContent = "🎹 Capturar Tecla/Mouse";
  }
}

export async function openAudioSettingsModal() {
  pendingPttBinding = null;
  state.capturingPttBind = false;

  document.getElementById("pttEnabledCheckbox").checked = state.pttEnabled;
  const rnnoiseCb = document.getElementById("rnnoiseCheckbox");
  if (rnnoiseCb) rnnoiseCb.checked = state.rnnoiseEnabled;

  const gainPct = Math.round((state.micGain || 1.0) * 100);
  const gainRange = document.getElementById("micGainRange");
  if (gainRange) gainRange.value = String(gainPct);
  previewMicGainChange(gainPct);

  const vadMilli = Math.round((state.vadThreshold || 0.015) * 1000);
  const vadRange = document.getElementById("vadThresholdRange");
  if (vadRange) vadRange.value = String(vadMilli);
  previewVadThresholdChange(vadMilli);

  const pttLbl = document.getElementById("pttBindingLabel");
  if (pttLbl) pttLbl.textContent = state.pttBinding?.label || "V (ou Espaço padrão)";

  const globalRow = document.getElementById("globalPttRow");
  const globalCb = document.getElementById("globalPttCheckbox");
  const isLocalHost = state.isHost && !state.customServerOrigin;
  if (globalRow) globalRow.style.display = isLocalHost ? "flex" : "none";
  if (globalCb) globalCb.checked = isLocalHost && state.globalPttEnabled;

  const micSelect = document.getElementById("micSelect");
  const spkSelect = document.getElementById("speakerSelect");
  micSelect.innerHTML = `<option value="">Padrão do Sistema</option>`;
  spkSelect.innerHTML = `<option value="">Padrão do Sistema</option>`;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    for (const dev of devices) {
      if (dev.kind === "audioinput") {
        const opt = document.createElement("option");
        opt.value = dev.deviceId;
        opt.textContent = dev.label || `Microfone (${dev.deviceId.slice(0, 6)})`;
        if (dev.deviceId === state.selectedMicId) opt.selected = true;
        micSelect.appendChild(opt);
      } else if (dev.kind === "audiooutput") {
        const opt = document.createElement("option");
        opt.value = dev.deviceId;
        opt.textContent = dev.label || `Saída (${dev.deviceId.slice(0, 6)})`;
        if (dev.deviceId === state.selectedSpeakerId) opt.selected = true;
        spkSelect.appendChild(opt);
      }
    }
  } catch (_) {}

  document.getElementById("audioSettingsModal").classList.add("open");
  startMicPreviewAnalyser();
}

export function closeAudioSettingsModal() {
  state.capturingPttBind = false;
  pendingPttBinding = null;
  if (state.voiceGainNode) state.voiceGainNode.gain.value = state.micGain;
  stopMicPreviewPipeline();
  document.getElementById("audioSettingsModal").classList.remove("open");
}

function sendGlobalPttConfiguration() {
  if (!state.isHost || state.customServerOrigin) return;
  const vk = Number(state.pttBinding?.vk || 0x56);
  sendWs({
    type: "configure_global_ptt",
    enabled: Boolean(state.pttEnabled && state.globalPttEnabled),
    vk_code: vk >= 1 && vk <= 254 ? vk : 0x56,
  });
}

async function replaceLiveAudioTracks(newStream) {
  const newTrack = newStream.getAudioTracks()[0];
  const oldTracks = state.localAudioStream ? state.localAudioStream.getAudioTracks() : [];
  for (const pc of state.peerConnections.values()) {
    for (const sender of pc.getSenders()) {
      if (sender.track && oldTracks.some(t => t.id === sender.track.id) && newTrack) {
        await sender.replaceTrack(newTrack);
      }
    }
  }
  oldTracks.forEach(t => t.stop());
  state.localAudioStream = newStream;
}

export async function saveAudioSettings() {
  const prevMic = state.selectedMicId;
  const prevRnnoise = state.rnnoiseEnabled;

  state.selectedMicId = document.getElementById("micSelect").value;
  state.selectedSpeakerId = document.getElementById("speakerSelect").value;
  state.pttEnabled = document.getElementById("pttEnabledCheckbox").checked;
  state.rnnoiseEnabled = Boolean(document.getElementById("rnnoiseCheckbox")?.checked);
  state.micGain = Math.max(0.2, Math.min(2.2, (Number(document.getElementById("micGainRange")?.value) || 100) / 100));
  state.vadThreshold = Math.max(0.003, Math.min(0.08, (Number(document.getElementById("vadThresholdRange")?.value) || 15) / 1000));
  if (pendingPttBinding) {
    state.pttBinding = pendingPttBinding;
    localStorage.setItem("drocsid_ptt_binding", JSON.stringify(state.pttBinding));
  }
  state.globalPttEnabled = Boolean(document.getElementById("globalPttCheckbox")?.checked);

  localStorage.setItem("drocsid_mic_id", state.selectedMicId);
  localStorage.setItem("drocsid_speaker_id", state.selectedSpeakerId);
  localStorage.setItem("drocsid_ptt", state.pttEnabled ? "true" : "false");
  localStorage.setItem("drocsid_rnnoise", state.rnnoiseEnabled ? "true" : "false");
  localStorage.setItem("drocsid_mic_gain", String(state.micGain));
  localStorage.setItem("drocsid_vad_threshold", String(state.vadThreshold));
  localStorage.setItem("drocsid_global_ptt", state.globalPttEnabled ? "true" : "false");

  state.pttKeyDown = false;
  closeAudioSettingsModal();
  sendGlobalPttConfiguration();

  if (state.voiceEnabled && (prevMic !== state.selectedMicId || prevRnnoise !== state.rnnoiseEnabled)) {
    try {
      const processedStream = await buildProcessedVoicePipeline();
      await replaceLiveAudioTracks(processedStream);
    } catch (err) {
      showToast("Erro ao reconfigurar captura de microfone: " + err.message, "error");
    }
  } else if (state.voiceGainNode) {
    state.voiceGainNode.gain.value = state.micGain;
  }

  syncLocalAudioEnabled();
  updateVoiceButtonLabel();
  await applyOutputSinkToElement(document.getElementById("stageVideo"));
  for (const a of document.querySelectorAll("#remoteAudioContainer audio")) {
    await applyOutputSinkToElement(a);
  }
  if (state.voicePlaybackCtx && state.selectedSpeakerId && typeof state.voicePlaybackCtx.setSinkId === "function") {
    state.voicePlaybackCtx.setSinkId(state.selectedSpeakerId).catch(() => {});
  }
}

export function initVoiceListeners() {
  window.addEventListener("keydown", (e) => {
    if (state.capturingPttBind) {
      e.preventDefault();
      e.stopPropagation();
      const vk = codeToWin32Vk(e.code);
      finishCapturePttBind({
        type: "key",
        code: e.code,
        label: formatPttKeyLabel(e.code, e.key),
        vk,
        defaultCompat: false,
      });
      return;
    }
    if (!state.pttEnabled || !state.voiceEnabled || state.selfMute || state.selfDeaf) return;
    if (!isMatchingPttKeyEvent(e)) return;
    if (isEditableElementFocused()) return;
    if (e.code === "Space") e.preventDefault();
    if (!state.pttKeyDown) {
      state.pttKeyDown = true;
      syncLocalAudioEnabled();
      updateVoiceButtonLabel();
    }
  }, true);

  window.addEventListener("keyup", (e) => {
    if (!isMatchingPttKeyEvent(e)) return;
    if (state.pttKeyDown) {
      state.pttKeyDown = false;
      syncLocalAudioEnabled();
      updateVoiceButtonLabel();
      if (state.isSpeaking) {
        state.isSpeaking = false;
        sendVoiceState();
      }
    }
  });

  window.addEventListener("mousedown", (e) => {
    if (state.capturingPttBind) {
      if (e.button === 0 || e.button === 2) {
        showToast("Use botão lateral (Mouse4/5), botão do meio ou tecla do teclado.", "warning");
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const vkMap = { 1: 0x04, 3: 0x05, 4: 0x06 };
      const lblMap = { 1: "Mouse Meio", 3: "Mouse 4 (Voltar)", 4: "Mouse 5 (Avançar)" };
      finishCapturePttBind({
        type: "mouse",
        button: e.button,
        label: lblMap[e.button] || `Mouse ${e.button + 1}`,
        vk: vkMap[e.button] || 0x05,
        defaultCompat: false,
      });
      return;
    }
    if (!state.pttEnabled || !state.voiceEnabled || state.selfMute || state.selfDeaf) return;
    if (state.pttBinding?.type !== "mouse" || e.button !== state.pttBinding.button) return;
    if (isEditableElementFocused()) return;
    if (!state.pttKeyDown) {
      state.pttKeyDown = true;
      syncLocalAudioEnabled();
      updateVoiceButtonLabel();
    }
  }, true);

  window.addEventListener("mouseup", (e) => {
    if (state.pttBinding?.type !== "mouse" || e.button !== state.pttBinding.button) return;
    if (state.pttKeyDown) {
      state.pttKeyDown = false;
      syncLocalAudioEnabled();
      updateVoiceButtonLabel();
      if (state.isSpeaking) {
        state.isSpeaking = false;
        sendVoiceState();
      }
    }
  });

  window.addEventListener("blur", () => {
    if (state.pttKeyDown && !state.globalPttEnabled) {
      state.pttKeyDown = false;
      syncLocalAudioEnabled();
      updateVoiceButtonLabel();
    }
  });
}

async function buildProcessedVoicePipeline() {
  stopVoiceActivityDetection();
  stopMicPreviewPipeline();

  const rawStream = await captureMicStream();
  state.voiceCaptureRawStream = rawStream;

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return rawStream;

  const ctx = new AudioCtx({ sampleRate: 48000 });
  if (ctx.state === "suspended") {
    await ctx.resume().catch(() => {});
  }
  state.voiceCaptureCtx = ctx;
  state.vadAudioCtx = ctx;

  const source = ctx.createMediaStreamSource(rawStream);
  let tailNode = source;

  if (state.rnnoiseEnabled && ctx.sampleRate === 48000) {
    try {
      const rnnoise = await createRnnoiseNode(ctx);
      if (rnnoise) {
        tailNode.connect(rnnoise);
        tailNode = rnnoise;
        state.voiceRnnoiseNode = rnnoise;
      }
    } catch (err) {
      console.warn("RNNoise indisponível, seguindo com captura padrão:", err);
    }
  }

  const gainNode = ctx.createGain();
  gainNode.gain.value = state.micGain || 1.0;
  tailNode.connect(gainNode);
  state.voiceGainNode = gainNode;

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 12;
  compressor.ratio.value = 3.5;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.15;
  gainNode.connect(compressor);

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  compressor.connect(analyser);
  state.voiceAnalyserNode = analyser;

  const loopGain = ctx.createGain();
  loopGain.gain.value = state.micTestActive ? 1.0 : 0.0;
  compressor.connect(loopGain);
  loopGain.connect(ctx.destination);
  state.voiceLoopbackGainNode = loopGain;

  const dest = typeof ctx.createMediaStreamDestination === "function" ? ctx.createMediaStreamDestination() : null;
  if (dest) compressor.connect(dest);

  const zeroGain = ctx.createGain();
  zeroGain.gain.value = 0;
  zeroGain.connect(ctx.destination);
  state.voiceRelayZeroGainNode = zeroGain;

  // Captura em AudioWorklet offline a 48 kHz (20 ms por frame = 960 amostras)
  let workletReady = false;
  try {
    workletReady = await registerVoiceCaptureWorklet(ctx);
  } catch {
    workletReady = false;
  }

  if (workletReady && typeof AudioWorkletNode === "function") {
    const workletNode = new AudioWorkletNode(ctx, "drocsid-voice-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });
    workletNode.port.onmessage = (ev) => {
      if (!shouldTransmitVoiceRelay()) return;
      const chunk = ev.data;
      if (!(chunk instanceof Float32Array) || chunk.length === 0) return;

      let sq = 0;
      for (let i = 0; i < chunk.length; i++) sq += chunk[i] * chunk[i];
      const rms = Math.sqrt(sq / chunk.length);
      const now = Date.now();
      if (rms > (state.vadThreshold || 0.015) * 0.55 || state.isSpeaking) {
        state.voiceRelayHangoverUntil = now + 600;
      }
      if (now <= state.voiceRelayHangoverUntil) {
        sendCapturedVoiceFrame(chunk, ctx.sampleRate);
      }
    };
    compressor.connect(workletNode);
    workletNode.connect(zeroGain);
    state.voiceWorkletNode = workletNode;
  } else if (typeof ctx.createScriptProcessor === "function") {
    // Fallback para navegadores antigos sem AudioWorklet
    const processor = ctx.createScriptProcessor(2048, 1, 1);
    compressor.connect(processor);
    processor.connect(zeroGain);
    state.voiceRelayProcessorNode = processor;
    state.voiceRelayAccumLen = 0;
    let resamplePos = 0;
    processor.onaudioprocess = (ev) => {
      if (!shouldTransmitVoiceRelay()) {
        state.voiceRelayAccumLen = 0;
        resamplePos = 0;
        return;
      }
      const input = ev.inputBuffer.getChannelData(0);
      const step = ctx.sampleRate / VOICE_RELAY_SAMPLE_RATE;
      while (resamplePos < input.length) {
        const i0 = Math.floor(resamplePos);
        const i1 = Math.min(input.length, Math.max(i0 + 1, Math.floor(resamplePos + step)));
        let acc = 0;
        for (let j = i0; j < i1; j++) acc += input[j];
        state.voiceRelayAccumBuf[state.voiceRelayAccumLen++] = acc / (i1 - i0);
        resamplePos += step;
        if (state.voiceRelayAccumLen >= VOICE_RELAY_CHUNK_SAMPLES) {
          let sqSum = 0;
          for (let k = 0; k < VOICE_RELAY_CHUNK_SAMPLES; k++) {
            const v = state.voiceRelayAccumBuf[k];
            sqSum += v * v;
          }
          const rms = Math.sqrt(sqSum / VOICE_RELAY_CHUNK_SAMPLES);
          const now = Date.now();
          if (rms > (state.vadThreshold || 0.015) * 0.55 || state.isSpeaking) {
            state.voiceRelayHangoverUntil = now + 600;
          }
          if (now <= state.voiceRelayHangoverUntil) {
            const mulaw = new Uint8Array(VOICE_RELAY_CHUNK_SAMPLES);
            for (let k = 0; k < VOICE_RELAY_CHUNK_SAMPLES; k++) {
              mulaw[k] = linearToMulaw(state.voiceRelayAccumBuf[k]);
            }
            sendVoiceRelayPacket(mulaw);
          }
          state.voiceRelayAccumLen = 0;
        }
      }
      resamplePos -= input.length;
    };
  }

  const timeBuf = new Float32Array(analyser.fftSize);
  state.vadIntervalId = setInterval(() => {
    if (!state.voiceEnabled || state.selfMute || state.selfDeaf || (state.pttEnabled && !state.pttKeyDown)) {
      if (state.isSpeaking) {
        state.isSpeaking = false;
        sendVoiceState();
      }
      return;
    }
    analyser.getFloatTimeDomainData(timeBuf);
    let sq = 0;
    for (let i = 0; i < timeBuf.length; i++) sq += timeBuf[i] * timeBuf[i];
    const rms = Math.sqrt(sq / timeBuf.length);
    const nowSpeaking = rms > (state.vadThreshold || 0.015);
    if (nowSpeaking !== state.isSpeaking) {
      state.isSpeaking = nowSpeaking;
      sendVoiceState();
    }
  }, 150);

  return dest ? dest.stream : rawStream;
}

export async function toggleVoiceConnection() {
  if (!state.voiceEnabled) {
    try {
      state.localAudioStream = await buildProcessedVoicePipeline();
      state.voiceEnabled = true;
      state.voiceJoinedAt = Date.now();
      state.pttKeyDown = false;
      ensureVoicePlaybackContext();
      syncLocalAudioEnabled();
      updateVoiceButtonLabel();
      updateVoiceRelayStatusUi();
      sendGlobalPttConfiguration();
      sendVoiceState();
      hooks.renderPeers();
      await hooks.renegotiateAllPeers();
    } catch (err) {
      stopVoiceActivityDetection();
      showToast("Não foi possível acessar o microfone: " + err.message, "error");
    }
  } else {
    stopVoiceActivityDetection();
    resetOpusAudioEncoder();
    if (state.localAudioStream) {
      state.localAudioStream.getTracks().forEach(t => t.stop());
      state.localAudioStream = null;
    }
    state.voiceEnabled = false;
    state.voiceJoinedAt = 0;
    state.pttKeyDown = false;
    state.isSpeaking = false;
    updateVoiceButtonLabel();
    updateVoiceRelayStatusUi();
    sendVoiceState();
    hooks.renderPeers();
    await hooks.renegotiateAllPeers();
  }
}

export function stopVoiceActivityDetection() {
  if (state.vadIntervalId) {
    clearInterval(state.vadIntervalId);
    state.vadIntervalId = null;
  }
  if (state.voiceWorkletNode) {
    try {
      state.voiceWorkletNode.port.onmessage = null;
      state.voiceWorkletNode.disconnect();
    } catch (_) {}
    state.voiceWorkletNode = null;
  }
  if (state.voiceRnnoiseNode) {
    try {
      state.voiceRnnoiseNode.destroy?.();
      state.voiceRnnoiseNode.disconnect();
    } catch (_) {}
    state.voiceRnnoiseNode = null;
  }
  if (state.voiceGainNode) {
    try { state.voiceGainNode.disconnect(); } catch (_) {}
    state.voiceGainNode = null;
  }
  if (state.voiceLoopbackGainNode) {
    try { state.voiceLoopbackGainNode.disconnect(); } catch (_) {}
    state.voiceLoopbackGainNode = null;
  }
  state.voiceAnalyserNode = null;
  if (state.voiceRelayProcessorNode) {
    try {
      state.voiceRelayProcessorNode.onaudioprocess = null;
      state.voiceRelayProcessorNode.disconnect();
    } catch (_) {}
    state.voiceRelayProcessorNode = null;
  }
  if (state.voiceRelayZeroGainNode) {
    try { state.voiceRelayZeroGainNode.disconnect(); } catch (_) {}
    state.voiceRelayZeroGainNode = null;
  }
  state.voiceRelayAccumLen = 0;
  if (state.voiceCaptureRawStream) {
    state.voiceCaptureRawStream.getTracks().forEach(t => t.stop());
    state.voiceCaptureRawStream = null;
  }
  if (state.vadAudioCtx) {
    state.vadAudioCtx.close().catch(() => {});
    state.vadAudioCtx = null;
  }
  state.voiceCaptureCtx = null;
}

export function setupVoiceActivityDetection(stream) {
  // Mantido como wrapper compatível caso algum fluxo externo chame diretamente.
  if (!stream) return;
}

export function isSelfServerMuted() {
  return Boolean(state.peers.get(state.myPeerId)?.server_muted);
}

export function refreshMuteButtonUi() {
  const mutedByHost = isSelfServerMuted();
  const effectiveMute = state.selfMute || mutedByHost;
  const btn = document.getElementById("btnMute");
  if (btn) {
    btn.classList.toggle("active-red", effectiveMute);
    btn.textContent = mutedByHost
      ? "🔇 Mutado (Anfitrião)"
      : state.selfMute
        ? "🔇 Mutado"
        : "🎤 Mutar";
  }
  const mBtn = document.getElementById("mBtnMute");
  if (mBtn) {
    mBtn.classList.toggle("active-red", effectiveMute);
    mBtn.textContent = effectiveMute ? "🔇 Mutado" : "🎤 Mutar";
  }
}

export function syncLocalAudioEnabled() {
  if (state.localAudioStream) {
    const pttAllows = !state.pttEnabled || state.pttKeyDown;
    const enabled = !(state.selfMute || state.selfDeaf || isSelfServerMuted()) && pttAllows;
    state.localAudioStream.getAudioTracks().forEach(t => { t.enabled = enabled; });
  }
}

export function toggleMute() {
  if (isSelfServerMuted()) {
    showToast("🔇 Seu microfone foi silenciado pelo anfitrião.", "warn");
    return;
  }
  state.selfMute = !state.selfMute;
  syncLocalAudioEnabled();
  refreshMuteButtonUi();
  sendVoiceState();
}

export function toggleDeaf() {
  state.selfDeaf = !state.selfDeaf;
  // P2-1: igual ao Discord, Sem Áudio também silencia o microfone local
  syncLocalAudioEnabled();
  applyAllAudioVolumes();
  const stageVideo = document.getElementById("stageVideo");
  stageVideo.muted = state.selfDeaf || (state.watchedStreamerId === state.myPeerId);

  const btn = document.getElementById("btnDeaf");
  if (btn) {
    btn.classList.toggle("active-red", state.selfDeaf);
    btn.textContent = state.selfDeaf ? "🙉 Som Desativado" : "🎧 Sem Áudio";
  }
  sendVoiceState();
}

export function sendVoiceState() {
  sendWs({
    type: "update_voice_state",
    in_voice: state.voiceEnabled,
    self_mute: state.selfMute,
    self_deaf: state.selfDeaf,
    speaking: state.isSpeaking,
    voice_relay: state.forceVoiceRelay
  });
}
