// Palco (Stage), Grid incremental com Pin 1+N, Laser, Webcam Strip, PiP (vídeo e canvas), Fullscreen, Layout & Telemetria

import { state, escapeHtml, isMobileDevice, sendWs } from "./state.js";
import { showToast } from "./ui-feedback.js";
import {
  VIDEO_CODEC_H264,
  parseServerBinaryVideoHeader,
  parseServerBinaryVideoV2Header,
} from "./protocol.js";
import {
  getEffectiveVolume,
  applyOutputSinkToElement,
  ensureVoicePlaybackContext,
  shouldTransmitVoiceRelay,
  updateVoiceRelayStatusUi,
} from "./audio-codec.js";

let hooks = {
  renderPeers: () => {},
  renegotiateAllPeers: async () => {},
};

export function registerStageHooks(h) {
  hooks = { ...hooks, ...h };
}

export function toggleMobileSidebar(force) {
  const sb = document.getElementById("sidebar");
  const bd = document.getElementById("sidebarBackdrop");
  if (!sb || !bd) return;
  const open = typeof force === "boolean" ? force : !sb.classList.contains("open");
  sb.classList.toggle("open", open);
  bd.classList.toggle("open", open);
}

export function toggleSidebarPanel(force) {
  const isMobile = typeof window !== "undefined" && window.innerWidth <= 900;
  if (isMobile) {
    toggleMobileSidebar(force);
    return;
  }
  const sb = document.getElementById("sidebar");
  if (!sb) return;
  const shouldShow = typeof force === "boolean" ? force : Boolean(state.sidebarCollapsed);
  state.sidebarCollapsed = !shouldShow;
  sb.classList.toggle("collapsed", state.sidebarCollapsed);
  document.body?.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
}

export function setLayoutViewMode(mode) {
  state.layoutViewMode = mode;
  const mainArea = document.getElementById("mainArea");
  if (!mainArea) return;
  mainArea.classList.toggle("view-stage", mode === "stage");
  mainArea.classList.toggle("view-chat", mode === "chat");
  document.getElementById("btnViewSplit")?.classList.toggle("active-view", mode === "split");
  document.getElementById("btnViewStage")?.classList.toggle("active-view", mode === "stage");
  document.getElementById("btnViewChat")?.classList.toggle("active-view", mode === "chat");
  if (mode !== "split") {
    state.theaterMode = mode === "stage";
    mainArea.classList.toggle("theater", false);
    document.getElementById("btnTheaterMode")?.classList.toggle("active-green", state.theaterMode);
  }
}

export async function unlockBrowserAudio() {
  const btn = document.getElementById("btnUnlockAudio");
  try {
    if (state.notifAudioCtx && state.notifAudioCtx.state === "suspended") await state.notifAudioCtx.resume();
    if (state.vadAudioCtx && state.vadAudioCtx.state === "suspended") await state.vadAudioCtx.resume();
    if (state.voicePlaybackCtx && state.voicePlaybackCtx.state === "suspended") await state.voicePlaybackCtx.resume();
    ensureVoicePlaybackContext();
  } catch (_) {}

  const videoEl = document.getElementById("stageVideo");
  if (videoEl && videoEl.srcObject) {
    videoEl.muted = state.selfDeaf || (state.watchedStreamerId === state.myPeerId);
    videoEl.volume = getEffectiveVolume(state.watchedStreamerId);
    try { await videoEl.play(); } catch (_) {}
  }
  for (const a of document.querySelectorAll("#remoteAudioContainer audio")) {
    a.muted = state.selfDeaf || state.forceVoiceRelay;
    try { await a.play(); } catch (_) {}
  }
  if (btn) btn.style.display = "none";
}

let fullscreenListenerBound = false;

function isOwnScreenCaptureActive() {
  return Boolean(state.myScreenShareMode && state.localCaptureSurface !== "camera");
}

export function isSelfCapturePaused() {
  return Boolean(isOwnScreenCaptureActive() && !state.selfPreviewEnabled);
}

function syncSelfPreviewControlUi() {
  const btn = document.getElementById("btnStageSelfPreview");
  const labelEl = document.getElementById("btnStageSelfPreviewLabel");
  const showControl = Boolean(
    isOwnScreenCaptureActive() &&
    (state.gridMode || state.watchedStreamerId === state.myPeerId)
  );
  if (btn) {
    btn.style.display = showControl ? "inline-flex" : "none";
    btn.classList.toggle("active-green", Boolean(state.selfPreviewEnabled));
  }
  if (labelEl) {
    labelEl.textContent = state.selfPreviewEnabled ? "Ocultar Prévia" : "Prévia";
  }
}

export function setSelfPreviewEnabled(force) {
  const next = typeof force === "boolean" ? force : !state.selfPreviewEnabled;
  if (next && typeof document !== "undefined" && document.fullscreenElement && isOwnScreenCaptureActive()) {
    state.selfPreviewEnabled = false;
    syncSelfPreviewControlUi();
    updateStageView();
    showToast(
      "Saia da Tela Cheia antes de ativar a pré-visualização da própria tela para evitar espelho infinito e tela verde.",
      "warn"
    );
    return false;
  }
  state.selfPreviewEnabled = next;
  updateStageView();
  return next;
}

export function initStageResizer() {
  if (!fullscreenListenerBound && typeof document !== "undefined") {
    fullscreenListenerBound = true;
    document.addEventListener("fullscreenchange", () => {
      if (
        document.fullscreenElement &&
        isOwnScreenCaptureActive() &&
        state.selfPreviewEnabled &&
        (state.watchedStreamerId === state.myPeerId || state.gridMode)
      ) {
        state.selfPreviewEnabled = false;
        updateStageView();
        showToast(
          "Pré-visualização pausada automaticamente na Tela Cheia para evitar espelho infinito e tela verde.",
          "info"
        );
      }
    });
  }

  const resizer = document.getElementById("stageResizer");
  const stage = document.getElementById("stageContainer");
  const mainArea = document.getElementById("mainArea");
  if (!resizer || !stage || !mainArea) return;

  let dragging = false;
  resizer.addEventListener("mousedown", (e) => {
    if (state.theaterMode || state.layoutViewMode !== "split") return;
    dragging = true;
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = mainArea.getBoundingClientRect();
    const topbarH = 52;
    const rawH = e.clientY - rect.top - topbarH;
    const maxH = Math.max(220, rect.height - 190);
    const clamped = Math.max(150, Math.min(maxH, rawH));
    stage.style.height = `${clamped}px`;
    stage.style.minHeight = `${clamped}px`;
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = "";
  });
}

// ==================== Recepção de Quadros + WebCodecs V2 + Backpressure ====================
function getActiveStageCanvas(streamerId) {
  if (streamerId === state.myPeerId && isSelfCapturePaused()) {
    return null;
  }
  if (state.gridMode) {
    return document.getElementById(`grid-canvas-${streamerId}`);
  }
  return state.watchedStreamerId === streamerId ? document.getElementById("stageCanvas") : null;
}

function getOwnNativePipCanvas(streamerId) {
  if (
    state.pipActive &&
    state.pipNativeMode &&
    streamerId === state.myPeerId &&
    state.pipNativeCanvasEl
  ) {
    return state.pipNativeCanvasEl;
  }
  return null;
}

function drawFrameToCanvas(canvas, source, w, h) {
  if (!canvas) return;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  canvas.getContext("2d").drawImage(source, 0, 0, w, h);
}

function requestKeyframeThrottled(streamerId) {
  const now = Date.now();
  const last = state.lastKeyframeReqByPeer.get(streamerId) || 0;
  if (now - last < 900) return;
  state.lastKeyframeReqByPeer.set(streamerId, now);
  sendWs({ type: "request_video_keyframe", streamer_id: streamerId });
}

export function cleanupPeerVideoCodecs(peerId) {
  const entry = state.videoDecodersByPeer.get(peerId);
  if (entry?.decoder) {
    try {
      if (entry.decoder.state !== "closed") entry.decoder.close();
    } catch {}
  }
  state.videoDecodersByPeer.delete(peerId);
  state.lastKeyframeReqByPeer.delete(peerId);
}

function getOrCreateVideoDecoder(streamerId, codecId) {
  if (typeof VideoDecoder !== "function" || typeof EncodedVideoChunk !== "function") return null;
  const codecStr = codecId === VIDEO_CODEC_H264 ? "avc1.42E01F" : "vp8";
  let entry = state.videoDecodersByPeer.get(streamerId);
  if (entry && entry.decoder && entry.decoder.state === "configured" && entry.codecId === codecId) {
    return entry;
  }
  cleanupPeerVideoCodecs(streamerId);

  const seqByTs = new Map();
  entry = {
    codecId,
    needsKeyframe: true,
    seqByTs,
    decoder: null,
  };
  try {
    const decoder = new VideoDecoder({
      output: (frame) => {
        const frameSeq = seqByTs.get(frame.timestamp) ?? Math.round(frame.timestamp / 33333);
        seqByTs.delete(frame.timestamp);
        try {
          const targetCanvas = getActiveStageCanvas(streamerId);
          const pipCanvas = getOwnNativePipCanvas(streamerId);
          if (!targetCanvas && !pipCanvas) {
            sendWs({
              type: "signal_video_output_sink_ready",
              streamer_id: streamerId,
              frame_seq: frameSeq,
            });
            return;
          }
          const refCanvas = targetCanvas || pipCanvas;
          const w = frame.displayWidth || frame.codedWidth || refCanvas.width || 1280;
          const h = frame.displayHeight || frame.codedHeight || refCanvas.height || 720;
          drawFrameToCanvas(targetCanvas, frame, w, h);
          if (pipCanvas && pipCanvas !== targetCanvas) {
            drawFrameToCanvas(pipCanvas, frame, w, h);
          }
          state.renderedFramesCount++;
          requestAnimationFrame(() => {
            sendWs({
              type: "signal_video_output_sink_ready",
              streamer_id: streamerId,
              frame_seq: frameSeq,
            });
          });
        } finally {
          try { frame.close(); } catch {}
        }
      },
      error: () => {
        entry.needsKeyframe = true;
        requestKeyframeThrottled(streamerId);
      },
    });
    decoder.configure({ codec: codecStr, optimizeForLatency: true });
    entry.decoder = decoder;
    state.videoDecodersByPeer.set(streamerId, entry);
    return entry;
  } catch {
    cleanupPeerVideoCodecs(streamerId);
    return null;
  }
}

export function handleBinaryVideoFrame(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 4) return;
  const magic = new Uint8Array(buffer, 0, 4);
  if (magic[0] === 0x44 && magic[1] === 0x56 && magic[2] === 0x46 && magic[3] === 0x02) {
    const parsed = parseServerBinaryVideoV2Header(buffer);
    if (!parsed) return;
    if (!state.watchedStreamerId && !state.gridMode && (parsed.streamerId !== state.myPeerId || !isSelfCapturePaused())) {
      state.watchedStreamerId = parsed.streamerId;
      renderStreamTabs();
      updateStageView();
    }
    const targetCanvas = getActiveStageCanvas(parsed.streamerId);
    const pipCanvas = getOwnNativePipCanvas(parsed.streamerId);
    if (!targetCanvas && !pipCanvas) {
      sendWs({
        type: "signal_video_output_sink_ready",
        streamer_id: parsed.streamerId,
        frame_seq: parsed.frameSeq,
      });
      return;
    }
    const entry = getOrCreateVideoDecoder(parsed.streamerId, parsed.codecId);
    if (!entry || !entry.decoder || entry.decoder.state !== "configured") return;
    const isKey = Boolean(parsed.isKeyframe);
    if (entry.needsKeyframe && !isKey) {
      requestKeyframeThrottled(parsed.streamerId);
      sendWs({
        type: "signal_video_output_sink_ready",
        streamer_id: parsed.streamerId,
        frame_seq: parsed.frameSeq,
      });
      return;
    }
    if (isKey) entry.needsKeyframe = false;
    const ts = Number(parsed.frameSeq) * 33333;
    if (entry.seqByTs.size > 48) entry.seqByTs.clear();
    entry.seqByTs.set(ts, parsed.frameSeq);
    try {
      entry.decoder.decode(new EncodedVideoChunk({
        type: isKey ? "key" : "delta",
        timestamp: ts,
        data: parsed.payload,
      }));
    } catch {
      entry.needsKeyframe = true;
      requestKeyframeThrottled(parsed.streamerId);
    }
    return;
  }

  const parsed = parseServerBinaryVideoHeader(buffer);
  if (!parsed) return;
  if (!state.watchedStreamerId && !state.gridMode && (parsed.streamerId !== state.myPeerId || !isSelfCapturePaused())) {
    state.watchedStreamerId = parsed.streamerId;
    renderStreamTabs();
    updateStageView();
  }
  const targetCanvas = getActiveStageCanvas(parsed.streamerId);
  const pipCanvas = getOwnNativePipCanvas(parsed.streamerId);
  if (!targetCanvas && !pipCanvas) {
    sendWs({
      type: "signal_video_output_sink_ready",
      streamer_id: parsed.streamerId,
      frame_seq: parsed.frameSeq,
    });
    return;
  }

  const blob = new Blob([parsed.payload], { type: "image/jpeg" });
  if (typeof createImageBitmap === "function") {
    createImageBitmap(blob).then((bitmap) => {
      try {
        const activeCanvas = getActiveStageCanvas(parsed.streamerId);
        const activePipCanvas = getOwnNativePipCanvas(parsed.streamerId);
        if (!activeCanvas && !activePipCanvas) return;
        drawFrameToCanvas(activeCanvas, bitmap, parsed.width, parsed.height);
        if (activePipCanvas && activePipCanvas !== activeCanvas) {
          drawFrameToCanvas(activePipCanvas, bitmap, parsed.width, parsed.height);
        }
        state.renderedFramesCount++;
        requestAnimationFrame(() => {
          sendWs({
            type: "signal_video_output_sink_ready",
            streamer_id: parsed.streamerId,
            frame_seq: parsed.frameSeq,
          });
        });
      } finally {
        try { bitmap.close(); } catch {}
      }
    }).catch(() => {});
    return;
  }

  const blobUrl = URL.createObjectURL(blob);
  drawRelayFrame(parsed.streamerId, parsed.frameSeq, parsed.width, parsed.height, blobUrl, true);
}

export function handleNativeVideoFrame(msg) {
  drawRelayFrame(
    msg.streamer_id,
    msg.frame_seq,
    msg.width,
    msg.height,
    "data:image/jpeg;base64," + msg.jpeg_base64,
    false
  );
}

export function drawRelayFrame(streamerId, frameSeq, width, height, srcUrl, revokeBlob) {
  if (!state.watchedStreamerId && !state.gridMode && (streamerId !== state.myPeerId || !isSelfCapturePaused())) {
    state.watchedStreamerId = streamerId;
    renderStreamTabs();
    updateStageView();
  }

  const targetCanvas = getActiveStageCanvas(streamerId);
  const pipCanvas = getOwnNativePipCanvas(streamerId);

  if (!targetCanvas && !pipCanvas) {
    if (revokeBlob) URL.revokeObjectURL(srcUrl);
    sendWs({
      type: "signal_video_output_sink_ready",
      streamer_id: streamerId,
      frame_seq: frameSeq
    });
    return;
  }

  const img = new Image();
  img.onload = () => {
    if (revokeBlob) URL.revokeObjectURL(srcUrl);
    const activeCanvas = getActiveStageCanvas(streamerId);
    const activePipCanvas = getOwnNativePipCanvas(streamerId);
    if (!activeCanvas && !activePipCanvas) return;
    drawFrameToCanvas(activeCanvas, img, width, height);
    if (activePipCanvas && activePipCanvas !== activeCanvas) {
      drawFrameToCanvas(activePipCanvas, img, width, height);
    }
    state.renderedFramesCount++;

    requestAnimationFrame(() => {
      sendWs({
        type: "signal_video_output_sink_ready",
        streamer_id: streamerId,
        frame_seq: frameSeq
      });
    });
  };
  img.onerror = () => {
    if (revokeBlob) URL.revokeObjectURL(srcUrl);
  };
  img.src = srcUrl;
}

export function renderStreamTabs() {
  const tabsEl = document.getElementById("streamTabs");
  const livePeers = Array.from(state.peers.values()).filter(p => p.screen_share);

  if (livePeers.length === 0) {
    tabsEl.innerHTML = `<span style="color: var(--text-muted);">Nenhuma transmissão ativa</span>`;
    return;
  }

  tabsEl.innerHTML = "";
  for (const p of livePeers) {
    const s = p.screen_share;
    const btn = document.createElement("button");
    btn.className = "stream-tab" + (state.watchedStreamerId === p.peer_id ? " active" : "");
    const modeTag = s.mode === "native_host"
      ? "🖥️ Captura do PC"
      : (s.mode === "universal_relay" ? "🌐 Túnel" : "⚡ Direto");
    btn.innerHTML = `<span>🔴</span> <strong>${escapeHtml(p.username)}</strong> <span>(${s.width}x${s.height} @ ${s.fps}fps • ${modeTag})</span>`;
    btn.onclick = () => selectWatchedStreamer(p.peer_id);
    tabsEl.appendChild(btn);
  }
}

export function selectWatchedStreamer(peerId) {
  if (state.watchedStreamerId !== peerId) {
    const c = document.getElementById("stageCanvas");
    if (c) c.getContext("2d").clearRect(0, 0, c.width, c.height);
  }
  state.watchedStreamerId = peerId;
  renderStreamTabs();
  updateStageView();
}

export function playVideoSafely(videoEl, wantMuted) {
  videoEl.playsInline = true;
  videoEl.setAttribute("playsinline", "");
  videoEl.setAttribute("webkit-playsinline", "");
  videoEl.muted = wantMuted;
  const p = videoEl.play();
  if (p && typeof p.catch === "function") {
    p.catch(() => {
      if (!videoEl.muted) {
        videoEl.muted = true;
        videoEl.play().catch(() => {});
        const unlockBtn = document.getElementById("btnUnlockAudio");
        if (unlockBtn) unlockBtn.style.display = "block";
      }
    });
  }
}

export function togglePinGridPeer(peerId) {
  state.pinnedGridPeerId = state.pinnedGridPeerId === peerId ? null : peerId;
  updateStageView();
}

function buildGridTile(p) {
  const tile = document.createElement("div");
  tile.className = "grid-tile";
  tile.dataset.peerId = p.peer_id;
  tile.onclick = () => {
    state.gridMode = false;
    document.getElementById("btnGridMode")?.classList.remove("active-green");
    selectWatchedStreamer(p.peer_id);
  };

  const pinBtn = document.createElement("button");
  pinBtn.type = "button";
  pinBtn.className = "grid-tile-pin-btn";
  pinBtn.title = "Fixar esta transmissão em destaque (1+N)";
  pinBtn.textContent = "📌";
  pinBtn.onclick = (e) => {
    e.stopPropagation();
    togglePinGridPeer(p.peer_id);
  };
  tile.appendChild(pinBtn);

  const label = document.createElement("div");
  label.className = "grid-tile-label";
  label.textContent = `${p.username} (${p.screen_share.width}x${p.screen_share.height})`;
  tile.appendChild(label);

  return tile;
}

function reconcileGridTileMedia(tile, p) {
  const existingVideo = tile.querySelector("video");
  const existingCanvas = tile.querySelector("canvas");
  const existingPaused = tile.querySelector(".grid-tile-paused");

  if (p.peer_id === state.myPeerId && isSelfCapturePaused()) {
    if (existingVideo) {
      try { existingVideo.srcObject = null; } catch (_) {}
      existingVideo.remove();
    }
    if (existingCanvas) existingCanvas.remove();
    if (!existingPaused) {
      const pausedBox = document.createElement("div");
      pausedBox.className = "grid-tile-paused";
      pausedBox.textContent = "Transmitindo ao vivo — prévia pausada para evitar espelho e tela verde";
      tile.insertBefore(pausedBox, tile.firstChild);
    }
    return;
  }

  if (existingPaused) existingPaused.remove();

  const isSelfRelay = p.peer_id === state.myPeerId && p.screen_share.mode === "universal_relay" && state.localDisplayStream;
  const webrtcStream = p.screen_share.mode === "web_rtc" ? state.remoteVideoStreams.get(p.peer_id) : null;
  const targetStream = isSelfRelay ? state.localDisplayStream : webrtcStream;

  if (targetStream) {
    if (existingCanvas) existingCanvas.remove();
    let v = existingVideo;
    if (!v) {
      v = document.createElement("video");
      v.autoplay = true;
      v.playsInline = true;
      tile.insertBefore(v, tile.firstChild);
    }
    if (v.srcObject !== targetStream) {
      v.srcObject = targetStream;
      v.volume = getEffectiveVolume(p.peer_id);
      applyOutputSinkToElement(v);
      playVideoSafely(v, state.selfDeaf || p.peer_id === state.myPeerId);
    } else {
      v.muted = state.selfDeaf || p.peer_id === state.myPeerId;
      v.volume = getEffectiveVolume(p.peer_id);
    }
  } else {
    if (existingVideo) {
      try { existingVideo.srcObject = null; } catch (_) {}
      existingVideo.remove();
    }
    if (!existingCanvas) {
      const c = document.createElement("canvas");
      c.id = `grid-canvas-${p.peer_id}`;
      tile.insertBefore(c, tile.firstChild);
    }
  }
}

export function updateStageView() {
  const videoEl = document.getElementById("stageVideo");
  const canvasEl = document.getElementById("stageCanvas");
  const gridEl = document.getElementById("stageGrid");
  const emptyEl = document.getElementById("stageEmpty");
  const selfNoticeEl = document.getElementById("stageSelfPreviewNotice");
  const selfDescEl = document.getElementById("stageSelfPreviewDesc");

  const livePeers = Array.from(state.peers.values()).filter(p => p.screen_share);

  if (state.gridMode) {
    videoEl.style.display = "none";
    videoEl.srcObject = null;
    canvasEl.style.display = "none";
    if (selfNoticeEl) selfNoticeEl.style.display = "none";

    if (livePeers.length === 0) {
      state.pinnedGridPeerId = null;
      gridEl.classList.remove("active", "has-pin");
      if (gridEl.children.length > 0) gridEl.innerHTML = "";
      emptyEl.style.display = "block";
      syncSelfPreviewControlUi();
      return;
    }

    emptyEl.style.display = "none";
    gridEl.classList.add("active");

    const activePeers = livePeers.slice(0, 4);
    if (state.pinnedGridPeerId && !activePeers.some(p => p.peer_id === state.pinnedGridPeerId)) {
      state.pinnedGridPeerId = null;
    }
    gridEl.classList.toggle("has-pin", Boolean(state.pinnedGridPeerId));

    const orderedPeers = state.pinnedGridPeerId
      ? [
          ...activePeers.filter(p => p.peer_id === state.pinnedGridPeerId),
          ...activePeers.filter(p => p.peer_id !== state.pinnedGridPeerId),
        ]
      : activePeers;

    const activeIds = new Set(orderedPeers.map(p => p.peer_id));
    for (const child of Array.from(gridEl.children)) {
      if (!activeIds.has(child.dataset.peerId)) {
        const v = child.querySelector("video");
        if (v) try { v.srcObject = null; } catch (_) {}
        child.remove();
      }
    }

    orderedPeers.forEach((p, idx) => {
      let tile = Array.from(gridEl.children).find(el => el.dataset.peerId === p.peer_id);
      if (!tile) {
        tile = buildGridTile(p);
        gridEl.appendChild(tile);
      }

      const isPinned = p.peer_id === state.pinnedGridPeerId;
      tile.classList.toggle("pinned", isPinned);
      const pinBtn = tile.querySelector(".grid-tile-pin-btn");
      if (pinBtn) {
        pinBtn.classList.toggle("active-pin", isPinned);
        pinBtn.title = isPinned ? "Desafixar transmissão" : "Fixar esta transmissão em destaque (1+N)";
      }
      const label = tile.querySelector(".grid-tile-label");
      const labelText = `${p.username} (${p.screen_share.width}x${p.screen_share.height})`;
      if (label && label.textContent !== labelText) {
        label.textContent = labelText;
      }

      reconcileGridTileMedia(tile, p);

      if (gridEl.children[idx] !== tile) {
        gridEl.insertBefore(tile, gridEl.children[idx] || null);
      }
    });
    syncSelfPreviewControlUi();
    return;
  }

  gridEl.classList.remove("active", "has-pin");
  if (gridEl.children.length > 0) gridEl.innerHTML = "";

  const streamer = state.watchedStreamerId ? state.peers.get(state.watchedStreamerId) : null;
  if (!streamer || !streamer.screen_share) {
    videoEl.style.display = "none";
    videoEl.srcObject = null;
    canvasEl.style.display = "none";
    if (selfNoticeEl) selfNoticeEl.style.display = "none";
    emptyEl.style.display = "block";
    syncSelfPreviewControlUi();
    return;
  }

  emptyEl.style.display = "none";
  const watchingOwnCapture = state.watchedStreamerId === state.myPeerId && isOwnScreenCaptureActive();
  if (watchingOwnCapture && typeof document !== "undefined" && document.fullscreenElement && state.selfPreviewEnabled) {
    state.selfPreviewEnabled = false;
  }
  if (watchingOwnCapture && !state.selfPreviewEnabled) {
    videoEl.style.display = "none";
    videoEl.srcObject = null;
    canvasEl.style.display = "none";
    if (canvasEl.width > 0 && canvasEl.height > 0) {
      try { canvasEl.getContext("2d")?.clearRect(0, 0, canvasEl.width, canvasEl.height); } catch (_) {}
    }
    if (selfDescEl) {
      const s = streamer.screen_share;
      const modeLabel = s.mode === "native_host"
        ? "Captura do PC"
        : (s.mode === "universal_relay" ? "Modo Túnel" : "Conexão direta");
      selfDescEl.textContent =
        `Transmitindo ${s.width}x${s.height} @ ${s.fps}fps (${modeLabel}). ` +
        "Pré-visualização pausada para evitar espelho infinito, cursor duplicado e distorção verde de cor.";
    }
    if (selfNoticeEl) selfNoticeEl.style.display = "flex";
    syncSelfPreviewControlUi();
    return;
  }
  if (selfNoticeEl) selfNoticeEl.style.display = "none";
  const isSelfUniversalRelay =
    streamer.screen_share.mode === "universal_relay" &&
    state.watchedStreamerId === state.myPeerId &&
    state.localDisplayStream;

  if (isSelfUniversalRelay) {
    canvasEl.style.display = "none";
    videoEl.style.display = "block";
    if (videoEl.srcObject !== state.localDisplayStream) {
      videoEl.srcObject = state.localDisplayStream;
      playVideoSafely(videoEl, true);
    }
  } else if (streamer.screen_share.mode === "native_host" || streamer.screen_share.mode === "universal_relay") {
    videoEl.style.display = "none";
    videoEl.srcObject = null;
    canvasEl.style.display = "block";
  } else {
    canvasEl.style.display = "none";
    videoEl.style.display = "block";
    const stream = state.remoteVideoStreams.get(state.watchedStreamerId);
    if (stream) {
      if (videoEl.srcObject !== stream) {
        videoEl.srcObject = stream;
        videoEl.volume = getEffectiveVolume(state.watchedStreamerId);
        applyOutputSinkToElement(videoEl);
        playVideoSafely(videoEl, state.selfDeaf || (state.watchedStreamerId === state.myPeerId));
      }
    } else {
      videoEl.srcObject = null;
    }
  }
  syncSelfPreviewControlUi();
}

export function toggleGridMode() {
  state.gridMode = !state.gridMode;
  document.getElementById("btnGridMode").classList.toggle("active-green", state.gridMode);
  updateStageView();
}

export function toggleTheaterMode() {
  state.theaterMode = !state.theaterMode;
  setLayoutViewMode(state.theaterMode ? "stage" : "split");
}

export function toggleLaserMode() {
  state.laserMode = !state.laserMode;
  const btn = document.getElementById("btnLaserMode");
  btn.classList.toggle("active-green", state.laserMode);
  const viewport = document.getElementById("stageViewport");
  viewport.style.cursor = state.laserMode ? "crosshair" : "";
  if (!viewport.dataset.laserBound) {
    viewport.dataset.laserBound = "1";
    const emitLaser = (e) => {
      if (!state.laserMode || !state.ws || state.ws.readyState !== 1) return;
      const now = performance.now();
      if (now - state.lastLaserSentAt < 45) return;
      const rect = viewport.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const xNorm = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const yNorm = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      state.lastLaserSentAt = now;
      sendWs({ type: "laser_pointer", x_norm: xNorm, y_norm: yNorm });
      renderLaserDot(state.myPeerId, "Você", xNorm, yNorm);
    };
    viewport.addEventListener("pointermove", emitLaser);
    viewport.addEventListener("pointerdown", emitLaser);
  }
}

export function renderLaserDot(peerId, username, xNorm, yNorm) {
  const overlay = document.getElementById("laserOverlay");
  if (!overlay) return;
  const id = `laser-${peerId}`;
  let dot = document.getElementById(id);
  if (!dot) {
    dot = document.createElement("div");
    dot.id = id;
    dot.className = "laser-dot";
    dot.innerHTML = `<span class="laser-tag">${escapeHtml(username || "Amigo")}</span>`;
    overlay.appendChild(dot);
  }
  dot.style.left = `${(Math.max(0, Math.min(1, xNorm)) * 100).toFixed(2)}%`;
  dot.style.top = `${(Math.max(0, Math.min(1, yNorm)) * 100).toFixed(2)}%`;
  clearTimeout(dot._hideTimer);
  dot._hideTimer = setTimeout(() => dot.remove(), 1400);
}

export async function toggleWebcam() {
  const btn = document.getElementById("btnWebcam");
  const mBtn = document.getElementById("mBtnWebcam");
  if (!state.localWebcamStream) {
    try {
      state.localWebcamStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } },
        audio: false
      });
      btn.classList.add("active-green");
      btn.textContent = "📷 Parar Câmera";
      if (mBtn) {
        mBtn.classList.add("active-green");
        mBtn.textContent = "📷 Ativa";
      }
      renderWebcamStrip();
      await hooks.renegotiateAllPeers();
    } catch (err) {
      showToast("Não foi possível acessar a câmera: " + err.message, "error");
    }
  } else {
    const camIds = new Set(state.localWebcamStream.getTracks().map(t => t.id));
    for (const pc of state.peerConnections.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track && camIds.has(sender.track.id)) {
          try { pc.removeTrack(sender); } catch (_) {}
        }
      }
    }
    state.localWebcamStream.getTracks().forEach(t => t.stop());
    state.localWebcamStream = null;
    btn.classList.remove("active-green");
    btn.textContent = "📷 Câmera";
    if (mBtn) {
      mBtn.classList.remove("active-green");
      mBtn.textContent = "📷 Cam";
    }
    renderWebcamStrip();
    await hooks.renegotiateAllPeers();
  }
}

export function renderWebcamStrip() {
  const strip = document.getElementById("webcamStrip");
  if (!strip) return;
  const entries = [];
  if (state.localWebcamStream) {
    entries.push({ peerId: state.myPeerId || "self", name: "Você (Câmera)", stream: state.localWebcamStream });
  }
  for (const [peerId, stream] of state.remoteWebcamStreams.entries()) {
    if (!stream || stream.getVideoTracks().every(t => t.readyState === "ended")) continue;
    const p = state.peers.get(peerId);
    entries.push({ peerId, name: p ? p.username : "Amigo", stream });
  }

  if (entries.length === 0) {
    strip.classList.remove("active");
    strip.innerHTML = "";
    return;
  }

  strip.classList.add("active");
  strip.innerHTML = "";
  for (const item of entries) {
    const card = document.createElement("div");
    card.className = "webcam-card";
    const v = document.createElement("video");
    v.autoplay = true;
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.muted = true;
    v.srcObject = item.stream;
    v.play().catch(() => {});
    const label = document.createElement("span");
    label.textContent = item.name;
    card.appendChild(v);
    card.appendChild(label);
    strip.appendChild(card);
  }
}

export function toggleStageFullscreen() {
  const viewport = document.getElementById("stageViewport");
  if (!viewport) return;
  if (!document.fullscreenElement) {
    if (
      isOwnScreenCaptureActive() &&
      state.selfPreviewEnabled &&
      (state.watchedStreamerId === state.myPeerId || state.gridMode)
    ) {
      state.selfPreviewEnabled = false;
      updateStageView();
      showToast(
        "Pré-visualização da própria tela pausada automaticamente na Tela Cheia para evitar cursor duplicado e tela verde.",
        "info"
      );
    }
    viewport.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

function updatePipButtonUi() {
  const active = Boolean(
    state.pipActive ||
    (typeof document !== "undefined" && document.pictureInPictureElement) ||
    (typeof window !== "undefined" && window.documentPictureInPicture?.window)
  );
  state.pipActive = active;
  document.getElementById("btnPiP")?.classList.toggle("active-green", active);
}

function cleanupPipProxyMedia() {
  if (state.pipProxyVideoEl) {
    if (state.pipOwnsProxyTracks && state.pipProxyVideoEl.srcObject) {
      try {
        state.pipProxyVideoEl.srcObject.getTracks().forEach(t => t.stop());
      } catch (_) {}
    }
    try {
      state.pipProxyVideoEl.srcObject = null;
    } catch (_) {}
  }
  state.pipOwnsProxyTracks = false;
  state.pipNativeMode = false;
  state.pipStreamMode = null;
}

function ensurePipProxyVideoEl() {
  if (state.pipProxyVideoEl) return state.pipProxyVideoEl;
  const proxy = document.createElement("video");
  proxy.muted = true;
  proxy.playsInline = true;
  proxy.setAttribute("playsinline", "");
  proxy.autoplay = true;
  proxy.style.cssText = "position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;";
  proxy.addEventListener("enterpictureinpicture", () => {
    state.pipActive = true;
    updatePipButtonUi();
  });
  proxy.addEventListener("leavepictureinpicture", () => {
    state.pipActive = false;
    cleanupPipProxyMedia();
    updatePipButtonUi();
  });
  document.body.appendChild(proxy);
  state.pipProxyVideoEl = proxy;
  return proxy;
}

function ensureOwnNativePipCanvas() {
  if (!state.pipNativeCanvasEl) {
    const c = document.createElement("canvas");
    c.id = "pipNativeCanvas";
    c.style.cssText = "position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;";
    document.body.appendChild(c);
    state.pipNativeCanvasEl = c;
  }
  const peerShare = state.peers.get(state.myPeerId)?.screen_share;
  const w = peerShare?.width || 1280;
  const h = peerShare?.height || 720;
  if (state.pipNativeCanvasEl.width !== w || state.pipNativeCanvasEl.height !== h) {
    state.pipNativeCanvasEl.width = w;
    state.pipNativeCanvasEl.height = h;
    const ctx = state.pipNativeCanvasEl.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#0b0c0e";
      ctx.fillRect(0, 0, w, h);
    }
  }
  return state.pipNativeCanvasEl;
}

async function ensureVideoMetadataLoaded(videoEl) {
  if (!videoEl || videoEl.readyState >= 1) return;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      videoEl.removeEventListener("loadedmetadata", finish);
      resolve();
    };
    videoEl.addEventListener("loadedmetadata", finish, { once: true });
    setTimeout(finish, 300);
  });
}

async function openDocumentPipFromStream(stream, ownsTracks, streamMode, nativeMode, width = 480, height = 270) {
  if (!window.documentPictureInPicture?.requestWindow) return false;
  const pipWin = await window.documentPictureInPicture.requestWindow({
    width: Math.min(640, Math.max(320, width)),
    height: Math.min(360, Math.max(180, height)),
  });
  pipWin.document.body.style.cssText = "margin:0;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden;";
  const v = document.createElement("video");
  v.muted = true;
  v.autoplay = true;
  v.playsInline = true;
  v.style.cssText = "width:100%;height:100%;object-fit:contain;";
  v.srcObject = stream;
  v.play().catch(() => {});
  pipWin.document.body.appendChild(v);
  state.pipOwnsProxyTracks = ownsTracks;
  state.pipNativeMode = nativeMode;
  state.pipStreamMode = streamMode;
  state.pipActive = true;
  updatePipButtonUi();
  pipWin.addEventListener("pagehide", () => {
    state.pipActive = false;
    if (ownsTracks && v.srcObject) {
      try { v.srcObject.getTracks().forEach(t => t.stop()); } catch (_) {}
    }
    try { v.srcObject = null; } catch (_) {}
    cleanupPipProxyMedia();
    updatePipButtonUi();
  });
  return true;
}

async function openPipWithStream(stream, ownsTracks, streamMode, nativeMode, width = 480, height = 270) {
  const proxy = ensurePipProxyVideoEl();
  if (state.pipOwnsProxyTracks && proxy.srcObject && proxy.srcObject !== stream) {
    try { proxy.srcObject.getTracks().forEach(t => t.stop()); } catch (_) {}
  }
  state.pipOwnsProxyTracks = ownsTracks;
  state.pipNativeMode = nativeMode;
  state.pipStreamMode = streamMode;
  proxy.srcObject = stream;
  try { await proxy.play(); } catch (_) {}
  await ensureVideoMetadataLoaded(proxy);

  if (typeof proxy.requestPictureInPicture === "function") {
    try {
      await proxy.requestPictureInPicture();
      state.pipActive = true;
      updatePipButtonUi();
      return true;
    } catch (err) {
      if (await openDocumentPipFromStream(stream, ownsTracks, streamMode, nativeMode, width, height).catch(() => false)) {
        return true;
      }
      cleanupPipProxyMedia();
      updatePipButtonUi();
      showToast("Não foi possível ativar PiP: " + (err?.message || "indisponível"), "warn");
      return false;
    }
  }

  if (await openDocumentPipFromStream(stream, ownsTracks, streamMode, nativeMode, width, height).catch(() => false)) {
    return true;
  }
  cleanupPipProxyMedia();
  updatePipButtonUi();
  showToast("Picture-in-Picture não disponível neste navegador.", "warn");
  return false;
}

export async function closeActivePiP() {
  if (typeof document !== "undefined" && document.pictureInPictureElement) {
    try { await document.exitPictureInPicture(); } catch (_) {}
  }
  if (typeof window !== "undefined" && window.documentPictureInPicture?.window) {
    try { window.documentPictureInPicture.window.close(); } catch (_) {}
  }
  cleanupPipProxyMedia();
  state.pipActive = false;
  updatePipButtonUi();
}

export async function togglePiP() {
  const videoEl = document.getElementById("stageVideo");
  const canvasEl = document.getElementById("stageCanvas");

  if (
    (typeof document !== "undefined" && document.pictureInPictureElement) ||
    (typeof window !== "undefined" && window.documentPictureInPicture?.window) ||
    state.pipActive
  ) {
    await closeActivePiP();
    return;
  }

  const ownCaptureActive = isOwnScreenCaptureActive();
  const targetingOwnCapture = Boolean(
    ownCaptureActive &&
    (!state.watchedStreamerId || state.watchedStreamerId === state.myPeerId || state.gridMode)
  );

  // Própria transmissão usa sempre stream/canvas auxiliar dedicado,
  // funcionando mesmo com a Prévia do palco oculta e sem acoplar ao botão de Prévia.
  if (targetingOwnCapture) {
    if (state.localDisplayStream) {
      const settings = state.localDisplayStream.getVideoTracks?.()[0]?.getSettings?.() || {};
      await openPipWithStream(
        state.localDisplayStream,
        false,
        "own_media",
        false,
        settings.width || 640,
        settings.height || 360
      );
      return;
    }
    if (state.myScreenShareMode === "native_host") {
      const nativeCanvas = ensureOwnNativePipCanvas();
      if (typeof nativeCanvas.captureStream === "function") {
        const stream = nativeCanvas.captureStream(30);
        await openPipWithStream(
          stream,
          true,
          "own_native",
          true,
          nativeCanvas.width,
          nativeCanvas.height
        );
        return;
      }
      showToast("Picture-in-Picture não disponível neste navegador.", "warn");
      return;
    }
  }

  if (videoEl && videoEl.style.display !== "none" && videoEl.srcObject) {
    if (typeof videoEl.requestPictureInPicture !== "function") {
      showToast("Picture-in-Picture não é suportado neste navegador.", "warn");
      return;
    }
    try {
      if (!videoEl.dataset.pipBound) {
        videoEl.dataset.pipBound = "1";
        videoEl.addEventListener("enterpictureinpicture", () => {
          state.pipStreamMode = "remote";
          state.pipActive = true;
          updatePipButtonUi();
        });
        videoEl.addEventListener("leavepictureinpicture", () => {
          state.pipStreamMode = null;
          state.pipActive = false;
          updatePipButtonUi();
        });
      }
      await videoEl.requestPictureInPicture();
      state.pipStreamMode = "remote";
      state.pipActive = true;
      updatePipButtonUi();
    } catch (err) {
      showToast("Não foi possível ativar PiP: " + (err?.message || "indisponível"), "warn");
    }
    return;
  }

  if (canvasEl && canvasEl.style.display !== "none" && canvasEl.width > 0 && canvasEl.height > 0) {
    if (typeof canvasEl.captureStream === "function") {
      const stream = canvasEl.captureStream(30);
      await openPipWithStream(stream, true, "remote", false, canvasEl.width, canvasEl.height);
      return;
    }
    showToast("Picture-in-Picture não disponível neste navegador.", "warn");
    return;
  }

  showToast("Abra uma transmissão em foco no palco para usar o Picture-in-Picture.", "info");
}

export function updateTelemetryHud() {
  const now = performance.now();
  const dt = (now - state.lastFpsTick) / 1000;
  if (dt > 0) {
    state.measuredFps = Math.round(state.renderedFramesCount / dt);
    state.renderedFramesCount = 0;
    state.lastFpsTick = now;
  }

  const tsNow = Date.now();
  let relayExpired = false;
  for (const [pid, lastAt] of state.voiceRelayInboundPeers.entries()) {
    if (tsNow - lastAt > 1600) {
      state.voiceRelayInboundPeers.delete(pid);
      relayExpired = true;
    }
  }
  updateVoiceRelayStatusUi();
  const autoRelayNow = state.voiceEnabled && shouldTransmitVoiceRelay();
  const relayTransitioned = autoRelayNow !== state.prevAutoRelayActive;
  state.prevAutoRelayActive = autoRelayNow;
  if (relayExpired || relayTransitioned) hooks.renderPeers();

  const streamer = state.watchedStreamerId ? state.peers.get(state.watchedStreamerId) : null;
  const hud = document.getElementById("hudStatus");
  if (!hud) return;
  const pingText = typeof state.pingMs === "number" ? ` • ${state.pingMs} ms` : "";
  const voiceTag = state.voiceEnabled
    ? (shouldTransmitVoiceRelay() ? " • Voz: Túnel" : " • Voz: Direta")
    : "";
  if (streamer && streamer.screen_share) {
    const s = streamer.screen_share;
    const engine = (s.mode === "native_host" || s.mode === "universal_relay")
      ? `${s.mode === "native_host" ? "Captura do PC" : "Modo Túnel"} (${state.measuredFps} FPS)`
      : `Conexão Direta (${s.fps} FPS)`;
    const fullInfo = `Assistindo ${streamer.username} • ${s.width}x${s.height} • ${engine}${voiceTag}${pingText}`;
    hud.title = fullInfo;
    hud.textContent = state.showTechDetails
      ? fullInfo
      : `Assistindo ${streamer.username} • ${s.width}x${s.height}${pingText}`;
  } else {
    const fullInfo = `#${state.currentRoom} • ${state.peers.size} online${voiceTag}${pingText}`;
    hud.title = fullInfo;
    hud.textContent = state.showTechDetails
      ? fullInfo
      : `${state.peers.size} online${pingText}`;
  }
}
