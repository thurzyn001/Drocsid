// Compartilhamento de Tela ("Go Live"): modos WebRTC, Relay Universal e Nativo Rust

import { state, escapeHtml, isMobileDevice, isRemoteOrMobile, hostFetch, sendWs } from "./state.js";
import {
  VIDEO_CODEC_VP8,
  buildClientBinaryFrame,
  buildClientBinaryVideoV2Frame,
} from "./protocol.js";
import { showToast } from "./ui-feedback.js";

let encoderTargetDims = { w: 0, h: 0 };

export async function detectVideoRelayCaps() {
  if (typeof VideoEncoder !== "function" || typeof VideoDecoder !== "function" || typeof VideoFrame !== "function") {
    return { vp8: false, h264: false };
  }
  const check = async (codec) => {
    try {
      const [enc, dec] = await Promise.all([
        VideoEncoder.isConfigSupported({
          codec,
          width: 1280,
          height: 720,
          bitrate: 1_400_000,
          framerate: 24,
          latencyMode: "realtime",
        }),
        VideoDecoder.isConfigSupported({
          codec,
          codedWidth: 1280,
          codedHeight: 720,
        }),
      ]);
      return Boolean(enc?.supported && dec?.supported);
    } catch {
      return false;
    }
  };
  const [vp8, h264] = await Promise.all([check("vp8"), check("avc1.42E01F")]);
  return { vp8, h264 };
}

export function canUseVp8VideoRelay() {
  if (!state.clientCaps?.vp8_relay) return false;
  if (typeof VideoEncoder !== "function" || typeof VideoFrame !== "function") return false;
  const remotePeers = Array.from(state.peers.values()).filter(p => p.peer_id !== state.myPeerId);
  if (remotePeers.length === 0) return false;
  return remotePeers.every(p => Boolean(p.caps?.vp8_relay));
}

export function resetVideoEncoderV2() {
  if (state.videoEncoderV2) {
    try {
      if (state.videoEncoderV2.state !== "closed") state.videoEncoderV2.close();
    } catch {}
    state.videoEncoderV2 = null;
  }
  state.videoEncoderV2Codec = null;
  state.videoEncoderV2Seq = 0;
  state.forceNextVideoKeyframe = false;
  encoderTargetDims = { w: 0, h: 0 };
}

function ensureVp8VideoEncoder(w, h, fps, highLoad) {
  if (
    state.videoEncoderV2 &&
    state.videoEncoderV2.state === "configured" &&
    encoderTargetDims.w === w &&
    encoderTargetDims.h === h
  ) {
    return state.videoEncoderV2;
  }
  resetVideoEncoderV2();
  try {
    const encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        if (!state.ws || state.ws.readyState !== 1 || state.ws.bufferedAmount > 420 * 1024) return;
        const payload = new Uint8Array(chunk.byteLength);
        chunk.copyTo(payload);
        const seq = ++state.videoEncoderV2Seq;
        const cw = (metadata?.decoderConfig?.codedWidth || encoderTargetDims.w || w) & 0xffff;
        const ch = (metadata?.decoderConfig?.codedHeight || encoderTargetDims.h || h) & 0xffff;
        const flags = chunk.type === "key" ? 1 : 0;
        state.ws.send(buildClientBinaryVideoV2Frame(seq, cw, ch, VIDEO_CODEC_VP8, flags, payload));
      },
      error: () => {
        resetVideoEncoderV2();
      },
    });
    encoder.configure({
      codec: "vp8",
      width: w,
      height: h,
      bitrate: highLoad ? 750_000 : 1_500_000,
      framerate: Math.max(10, Math.min(60, fps || 24)),
      latencyMode: "realtime",
    });
    state.videoEncoderV2 = encoder;
    state.videoEncoderV2Codec = "vp8";
    encoderTargetDims = { w, h };
    state.forceNextVideoKeyframe = true;
    return encoder;
  } catch {
    resetVideoEncoderV2();
    return null;
  }
}

let hooks = {
  toggleMobileSidebar: () => {},
  updateStageView: () => {},
  renegotiateAllPeers: async () => {},
};

export function registerScreenShareHooks(h) {
  hooks = { ...hooks, ...h };
}

export function handleGoLiveButton() {
  if (state.myScreenShareMode) {
    stopScreenShare();
  } else {
    openGoLiveModal();
  }
}

export function openGoLiveModal() {
  const hasTurn = Boolean((localStorage.getItem("drocsid_turn_url") || "").trim());
  if (isRemoteOrMobile() && !hasTurn && state.selectedShareMode === "web_rtc") {
    selectShareMode("universal_relay");
  }
  const srcSelect = document.getElementById("selectCaptureSource");
  if (srcSelect) {
    const hasGetDisplay = !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === "function");
    const displayOpt = srcSelect.querySelector('option[value="display"]');
    if (displayOpt) {
      displayOpt.textContent = hasGetDisplay
        ? "🖥️ Tela / Janela / Aba (Navegador PC)"
        : "🖥️ Captura de Tela (Indisponível neste celular — use câmera)";
    }
    if (!hasGetDisplay) {
      srcSelect.value = "camera_env";
    }
  }
  document.getElementById("goLiveModal").classList.add("open");
  if (state.selectedShareMode === "native_host") {
    loadNativeScreenPreviews();
  }
}

export function closeGoLiveModal() {
  document.getElementById("goLiveModal").classList.remove("open");
}

export function toggleEngineHelp(mode, ev) {
  if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
  const map = {
    web_rtc: "modeHelpWebRtc",
    universal_relay: "modeHelpRelay",
    native_host: "modeHelpNative",
  };
  const targetId = map[mode];
  if (!targetId) return;
  const targetEl = document.getElementById(targetId);
  if (!targetEl) return;
  const shouldOpen = !targetEl.classList.contains("open");
  Object.values(map).forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("open", id === targetId && shouldOpen);
  });
}

export function selectShareMode(mode) {
  state.selectedShareMode = mode;
  document.getElementById("modeWebRtcCard").classList.toggle("selected", mode === "web_rtc");
  document.getElementById("modeRelayCard").classList.toggle("selected", mode === "universal_relay");
  document.getElementById("modeNativeCard").classList.toggle("selected", mode === "native_host");
  document.getElementById("nativeScreensSection").style.display = mode === "native_host" ? "block" : "none";
  const srcGroup = document.getElementById("browserCaptureSourceGroup");
  if (srcGroup) srcGroup.style.display = mode === "native_host" ? "none" : "flex";
  const audioSel = document.getElementById("selectAudioOrQuality");
  if (audioSel && audioSel.options && audioSel.options.length > 0) {
    audioSel.options[0].textContent = "Compartilhar áudio do computador";
  }
  if (mode === "native_host") {
    loadNativeScreenPreviews();
  }
}

export async function loadNativeScreenPreviews() {
  const grid = document.getElementById("nativePreviewGrid");
  grid.innerHTML = `<div style="color: var(--text-muted); font-size: 12px;">Carregando pré-visualizações das telas...</div>`;
  try {
    const res = await hostFetch("/api/screens");
    if (!res.ok) {
      throw new Error("Acesso restrito ao anfitrião (HTTP " + res.status + ")");
    }
    state.nativePreviews = await res.json();
    grid.innerHTML = "";
    state.nativePreviews.forEach((scr, idx) => {
      const card = document.createElement("div");
      card.className = "preview-card" + (idx === state.selectedMonitorIndex ? " selected" : "");
      card.onclick = () => {
        state.selectedMonitorIndex = idx;
        document.querySelectorAll(".preview-card").forEach((el, i) => {
          el.classList.toggle("selected", i === idx);
        });
      };
      card.innerHTML = `
        <img src="${scr.thumbnail_data_url}" alt="${escapeHtml(scr.name)}" />
        <div class="preview-title">${escapeHtml(scr.name)}</div>
      `;
      grid.appendChild(card);
    });
  } catch (err) {
    grid.innerHTML = `<div style="color: var(--red); font-size: 12px;">Erro ao carregar monitores: ${escapeHtml(err.message)}</div>`;
  }
}

export async function acquireBrowserStageStream(width, height, fps, wantAudio) {
  const sourceKind = document.getElementById("selectCaptureSource")?.value || "display";
  if (sourceKind === "camera_env" || sourceKind === "camera_user") {
    const facing = sourceKind === "camera_env" ? "environment" : "user";
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facing }, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: Math.min(fps, 30) } },
        audio: false
      });
    } catch (_) {
      return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
  }

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== "function") {
    // Fallback automático para câmera no celular se o navegador móvel não suporta getDisplayMedia
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });
  }

  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: fps, max: fps }
      },
      audio: wantAudio,
      selfBrowserSurface: "exclude"
    });
  } catch (err) {
    if (err && err.name === "NotAllowedError") {
      throw err;
    }
    return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  }
}

export function startWebRtcWatchdog() {
  if (state.webrtcWatchdogId) clearTimeout(state.webrtcWatchdogId);
  const hasTurn = Boolean((localStorage.getItem("drocsid_turn_url") || "").trim());
  if (hasTurn) return;
  state.webrtcWatchdogId = setTimeout(() => {
    if (state.myScreenShareMode !== "web_rtc" || !state.localDisplayStream) return;
    for (const pc of state.peerConnections.values()) {
      const st = pc.iceConnectionState;
      if (st !== "connected" && st !== "completed") {
        fallbackWebRtcToUniversalRelay();
        break;
      }
    }
  }, 5000);
}

export async function confirmStartScreenShare() {
  const [width, height] = document.getElementById("selectResolution").value.split("x").map(Number);
  const fps = Number(document.getElementById("selectFps").value);
  const wantAudio = document.getElementById("selectAudioOrQuality").value === "audio_on";

  closeGoLiveModal();
  hooks.toggleMobileSidebar(false);

  if (state.selectedShareMode === "web_rtc" || state.selectedShareMode === "universal_relay") {
    try {
      state.localDisplayStream = await acquireBrowserStageStream(width, height, fps, wantAudio);

      const videoTrack = state.localDisplayStream.getVideoTracks()[0];
      const settings = videoTrack.getSettings ? videoTrack.getSettings() : {};
      const sourceKind = document.getElementById("selectCaptureSource")?.value || "display";
      const isCameraCapture =
        sourceKind === "camera_env" ||
        sourceKind === "camera_user" ||
        Boolean(settings.facingMode && !settings.displaySurface);
      const sourceName = videoTrack.label || "Tela / Câmera";

      videoTrack.onended = () => {
        stopScreenShare();
      };

      state.myScreenShareMode = state.selectedShareMode;
      state.localCaptureSurface = isCameraCapture ? "camera" : (settings.displaySurface || "monitor");
      state.selfPreviewEnabled = isCameraCapture;
      updateGoLiveButtonState(true);

      state.watchedStreamerId = state.myPeerId;

      sendWs({
        type: "start_screen_share",
        mode: state.selectedShareMode,
        source_id: state.localDisplayStream.id || `${state.selectedShareMode}:display:0`,
        source_name: sourceName,
        width: settings.width || width,
        height: settings.height || height,
        fps: settings.frameRate || fps,
        has_audio: state.localDisplayStream.getAudioTracks().length > 0,
        quality: null
      });

      if (state.selectedShareMode === "web_rtc") {
        state.remoteVideoStreams.set(state.myPeerId, state.localDisplayStream);
        await hooks.renegotiateAllPeers();
        startWebRtcWatchdog();
      } else {
        if (state.localDisplayStream.getAudioTracks().length > 0) {
          await hooks.renegotiateAllPeers();
        }
        const capFps = isMobileDevice() ? Math.min(fps, 15) : Math.min(fps, 25);
        startUniversalRelayCaptureLoop(state.localDisplayStream, width, height, capFps);
      }
      hooks.updateStageView();
    } catch (err) {
      console.warn("Compartilhamento cancelado/erro:", err);
      if (err && err.name !== "NotAllowedError") {
        showToast("Não foi possível iniciar a transmissão neste navegador: " + err.message, "error");
      }
    }
  } else {
    const chosen = state.nativePreviews[state.selectedMonitorIndex] || {
      id: `screen:${state.selectedMonitorIndex}:0`,
      name: `Tela ${state.selectedMonitorIndex + 1} (Captura do PC)`
    };

    state.myScreenShareMode = "native_host";
    state.localCaptureSurface = "native_host";
    state.selfPreviewEnabled = false;
    updateGoLiveButtonState(true);
    state.watchedStreamerId = state.myPeerId;

    sendWs({
      type: "start_screen_share",
      mode: "native_host",
      source_id: chosen.id,
      source_name: chosen.name,
      width,
      height,
      fps: Math.min(fps, 60),
      has_audio: wantAudio,
      quality: 75
    });

    hooks.updateStageView();
  }
}

export function startUniversalRelayCaptureLoop(stream, targetW, targetH, fps) {
  if (state.relayIntervalId) clearInterval(state.relayIntervalId);
  if (state.relayHiddenVideoEl) {
    try { state.relayHiddenVideoEl.srcObject = null; state.relayHiddenVideoEl.remove(); } catch (_) {}
    state.relayHiddenVideoEl = null;
  }

  const hiddenVideo = document.createElement("video");
  hiddenVideo.playsInline = true;
  hiddenVideo.setAttribute("playsinline", "");
  hiddenVideo.setAttribute("webkit-playsinline", "");
  hiddenVideo.autoplay = true;
  hiddenVideo.muted = true;
  hiddenVideo.style.cssText = "position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;";
  hiddenVideo.srcObject = stream;
  document.body.appendChild(hiddenVideo);
  state.relayHiddenVideoEl = hiddenVideo;
  hiddenVideo.play().catch(() => {});

  const offCanvas = document.createElement("canvas");
  const ctx = offCanvas.getContext("2d");
  let seq = 0;
  let vp8FrameCount = 0;
  let encodingFrame = false;

  state.relayIntervalId = setInterval(() => {
    if (!state.localDisplayStream || state.myScreenShareMode !== "universal_relay") {
      clearInterval(state.relayIntervalId);
      state.relayIntervalId = null;
      resetVideoEncoderV2();
      return;
    }
    if (encodingFrame || hiddenVideo.readyState < 2 || !state.ws || state.ws.readyState !== 1 || state.ws.bufferedAmount > 320 * 1024) {
      return;
    }
    const vw = hiddenVideo.videoWidth || targetW;
    const vh = hiddenVideo.videoHeight || targetH;
    if (vw === 0 || vh === 0) return;

    // T-4 + Etapa 3: WebCodecs VP8 (DVP\x02) quando todos os peers suportam, fallback MJPEG (DVP\x01) caso contrário
    const highLoad = state.ws.bufferedAmount > 128 * 1024;
    const mobileCap = isMobileDevice() ? 854 : 1280;
    const maxW = highLoad ? Math.min(mobileCap, 854) : mobileCap;
    const jpegQuality = highLoad ? 0.48 : 0.68;

    const rawW = Math.min(vw, maxW);
    const rawH = Math.max(2, Math.round((vh * rawW) / vw));
    const w = Math.max(2, rawW & ~1);
    const h = Math.max(2, rawH & ~1);
    offCanvas.width = w;
    offCanvas.height = h;
    ctx.drawImage(hiddenVideo, 0, 0, w, h);

    if (canUseVp8VideoRelay()) {
      const encoder = ensureVp8VideoEncoder(w, h, fps, highLoad);
      if (encoder && encoder.state === "configured" && encoder.encodeQueueSize < 4) {
        vp8FrameCount++;
        const keyFrame = vp8FrameCount === 1 || vp8FrameCount % 45 === 1 || state.forceNextVideoKeyframe;
        state.forceNextVideoKeyframe = false;
        let frame = null;
        try {
          frame = new VideoFrame(offCanvas, { timestamp: Math.round(performance.now() * 1000) });
          encoder.encode(frame, { keyFrame });
          return;
        } catch {
          resetVideoEncoderV2();
        } finally {
          if (frame) {
            try { frame.close(); } catch {}
          }
        }
      } else if (encoder && encoder.encodeQueueSize >= 4) {
        return;
      }
    } else if (state.videoEncoderV2) {
      resetVideoEncoderV2();
    }

    encodingFrame = true;
    offCanvas.toBlob(async (blob) => {
      try {
        if (!state.ws || state.ws.readyState !== 1) return;
        if (blob) {
          const buf = await blob.arrayBuffer();
          seq++;
          state.ws.send(buildClientBinaryFrame(seq, w, h, buf));
        } else {
          const dataUrl = offCanvas.toDataURL("image/jpeg", jpegQuality);
          const b64 = dataUrl.split(",")[1];
          if (b64) {
            seq++;
            sendWs({ type: "push_video_frame", frame_seq: seq, width: w, height: h, jpeg_base64: b64 });
          }
        }
      } finally {
        encodingFrame = false;
      }
    }, "image/jpeg", jpegQuality);
  }, Math.max(40, Math.round(1000 / fps)));
}

export async function stopScreenShare() {
  resetVideoEncoderV2();
  if (state.webrtcWatchdogId) {
    clearTimeout(state.webrtcWatchdogId);
    state.webrtcWatchdogId = null;
  }
  if (state.relayIntervalId) {
    clearInterval(state.relayIntervalId);
    state.relayIntervalId = null;
  }
  if (state.relayHiddenVideoEl) {
    try { state.relayHiddenVideoEl.srcObject = null; state.relayHiddenVideoEl.remove(); } catch (_) {}
    state.relayHiddenVideoEl = null;
  }
  // P0-8: remove explicitamente os senders da tela antes de renegociar para não congelar nos amigos
  if (state.localDisplayStream) {
    const displayTracks = new Set(state.localDisplayStream.getTracks().map(t => t.id));
    for (const pc of state.peerConnections.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track && displayTracks.has(sender.track.id)) {
          try { pc.removeTrack(sender); } catch (_) {}
        }
      }
    }
    state.localDisplayStream.getTracks().forEach(t => t.stop());
    state.localDisplayStream = null;
  }
  state.remoteVideoStreams.delete(state.myPeerId);
  state.myScreenShareMode = null;
  state.selfPreviewEnabled = false;
  state.localCaptureSurface = "";
  updateGoLiveButtonState(false);

  sendWs({ type: "stop_screen_share" });
  await hooks.renegotiateAllPeers();
  hooks.updateStageView();
}

export function updateGoLiveButtonState(active) {
  const btn = document.getElementById("btnGoLive");
  if (btn) {
    btn.classList.toggle("streaming", active);
    btn.textContent = active ? "⏹️ Parar Transmissão" : "🖥️ Transmitir Tela";
  }
  const mBtn = document.getElementById("mBtnGoLive");
  if (mBtn) {
    mBtn.classList.toggle("active-red", active);
    mBtn.textContent = active ? "⏹️ Parar" : "🖥️ Tela";
  }
}

export async function fallbackWebRtcToUniversalRelay() {
  if (state.myScreenShareMode !== "web_rtc" || !state.localDisplayStream) return;
  const track = state.localDisplayStream.getVideoTracks()[0];
  const settings = track ? track.getSettings() : {};
  const width = settings.width || 1280;
  const height = settings.height || 720;
  const fps = Math.min(settings.frameRate || 24, 24);
  const sourceName = (track && track.label) || "Tela / Janela";

  // Remove apenas as trilhas de VÍDEO da tela antes de migrar para o Relay (mantém áudio do sistema se houver!)
  const displayVideoTracks = new Set(state.localDisplayStream.getVideoTracks().map(t => t.id));
  for (const pc of state.peerConnections.values()) {
    for (const sender of pc.getSenders()) {
      if (sender.track && displayVideoTracks.has(sender.track.id)) {
        try { pc.removeTrack(sender); } catch (_) {}
      }
    }
  }
  state.remoteVideoStreams.delete(state.myPeerId);
  state.myScreenShareMode = "universal_relay";
  sendWs({
    type: "start_screen_share",
    mode: "universal_relay",
    source_id: "universal_relay:fallback:0",
    source_name: sourceName,
    width,
    height,
    fps,
    has_audio: state.localDisplayStream.getAudioTracks().length > 0,
    quality: null
  });
  await hooks.renegotiateAllPeers();
  const capFps = isMobileDevice() ? Math.min(fps, 15) : fps;
  startUniversalRelayCaptureLoop(state.localDisplayStream, width, height, capFps);
  const hudEl = document.getElementById("hudStatus");
  if (hudEl) {
    hudEl.textContent = "Conexão direta bloqueada — alternado para modo compatível";
  }
  hooks.updateStageView();
}
