// Malha WebRTC (Perfect Negotiation, ICE/TURN próprio ou compartilhado pelo anfitrião, trilhas de áudio/vídeo)

import { state, sendWs } from "./state.js";
import { showToast } from "./ui-feedback.js";
import {
  getEffectiveVolume,
  applyOutputSinkToElement,
  updateVoiceRelayStatusUi,
  cleanupPeerAudioCodecs,
} from "./audio-codec.js";

let hooks = {
  fallbackWebRtcToUniversalRelay: () => {},
  renderWebcamStrip: () => {},
  renderStreamTabs: () => {},
  updateStageView: () => {},
  renderPeers: () => {},
  cleanupPeerVideoCodecs: () => {},
};

export function registerWebRtcHooks(h) {
  hooks = { ...hooks, ...h };
}

// P0-6 + Item 8: STUN público + TURN local opcional ou TURN compartilhado pelo anfitrião via WS autenticado.
export function getRtcConfig() {
  const iceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ];
  const turnUrl = (localStorage.getItem("drocsid_turn_url") || "").trim();
  const turnUser = (localStorage.getItem("drocsid_turn_user") || "").trim();
  const turnPass = localStorage.getItem("drocsid_turn_pass") || "";
  if (turnUrl) {
    const entry = { urls: turnUrl };
    if (turnUser) entry.username = turnUser;
    if (turnPass) entry.credential = turnPass;
    iceServers.push(entry);
  } else if (state.sharedTurnConfig && state.sharedTurnConfig.urls) {
    const shared = { urls: state.sharedTurnConfig.urls };
    if (state.sharedTurnConfig.username) shared.username = state.sharedTurnConfig.username;
    if (state.sharedTurnConfig.credential) shared.credential = state.sharedTurnConfig.credential;
    iceServers.push(shared);
  }
  return { iceServers };
}

export function openTurnModal() {
  document.getElementById("turnUrlInput").value =
    localStorage.getItem("drocsid_turn_url") || state.sharedTurnConfig?.urls || "";
  document.getElementById("turnUserInput").value =
    localStorage.getItem("drocsid_turn_user") || state.sharedTurnConfig?.username || "";
  document.getElementById("turnPassInput").value =
    localStorage.getItem("drocsid_turn_pass") || state.sharedTurnConfig?.credential || "";

  const shareRow = document.getElementById("shareTurnRow");
  const shareCb = document.getElementById("shareTurnCheckbox");
  const isLocalHost = state.isHost && !state.customServerOrigin;
  if (shareRow) shareRow.style.display = isLocalHost ? "flex" : "none";
  if (shareCb) shareCb.checked = isLocalHost && Boolean(state.sharedTurnConfig);

  document.getElementById("turnModal").classList.add("open");
}

export function closeTurnModal() {
  document.getElementById("turnModal").classList.remove("open");
}

export function saveTurnConfig() {
  const turnUrl = document.getElementById("turnUrlInput").value.trim();
  const turnUser = document.getElementById("turnUserInput").value.trim();
  const turnPass = document.getElementById("turnPassInput").value;
  localStorage.setItem("drocsid_turn_url", turnUrl);
  localStorage.setItem("drocsid_turn_user", turnUser);
  localStorage.setItem("drocsid_turn_pass", turnPass);

  const isLocalHost = state.isHost && !state.customServerOrigin;
  const shareChecked = Boolean(document.getElementById("shareTurnCheckbox")?.checked);
  if (isLocalHost) {
    if (shareChecked && turnUrl) {
      const turn = {
        urls: turnUrl,
        username: turnUser || null,
        credential: turnPass || null,
      };
      state.sharedTurnConfig = turn;
      sendWs({ type: "set_host_turn_config", turn });
    } else if (!shareChecked && state.sharedTurnConfig) {
      state.sharedTurnConfig = null;
      sendWs({ type: "set_host_turn_config", turn: null });
    }
  }

  closeTurnModal();
  renegotiateAllPeers();
  showToast(
    isLocalHost && shareChecked && turnUrl
      ? "TURN salvo e compartilhado com a sala!"
      : "Configuração TURN aplicada!",
    "success"
  );
}

export function clearTurnConfig() {
  localStorage.removeItem("drocsid_turn_url");
  localStorage.removeItem("drocsid_turn_user");
  localStorage.removeItem("drocsid_turn_pass");
  if (state.isHost && !state.customServerOrigin && state.sharedTurnConfig) {
    state.sharedTurnConfig = null;
    sendWs({ type: "set_host_turn_config", turn: null });
  }
  closeTurnModal();
  renegotiateAllPeers();
  showToast("Configuração TURN removida.", "info");
}

export function getOrCreatePeerConnection(remotePeerId) {
  if (state.peerConnections.has(remotePeerId)) {
    return state.peerConnections.get(remotePeerId);
  }

  const pc = new RTCPeerConnection(getRtcConfig());
  state.peerConnections.set(remotePeerId, pc);
  if (!state.pendingCandidates.has(remotePeerId)) {
    state.pendingCandidates.set(remotePeerId, []);
  }

  attachLocalTracksToPc(pc);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendWs({
        type: "rtc_ice_candidate",
        target_id: remotePeerId,
        candidate: e.candidate
      });
    }
  };

  // P0-6: fallback automático para o Relay quando ICE falha (ex: CGNAT simétrico sem TURN)
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
      if (state.myScreenShareMode === "web_rtc" && state.localDisplayStream) {
        hooks.fallbackWebRtcToUniversalRelay();
      } else {
        try { pc.restartIce(); } catch (_) {}
      }
    }
    updateVoiceRelayStatusUi();
    hooks.renderPeers();
  };

  pc.ontrack = (e) => {
    const stream = e.streams && e.streams[0];
    if (!stream) return;

    if (e.track.kind === "video") {
      const p = state.peers.get(remotePeerId);
      const isScreenStream = Boolean(
        p &&
        p.screen_share &&
        p.screen_share.mode === "web_rtc" &&
        p.screen_share.source_id === stream.id
      );

      if (isScreenStream) {
        if (state.remoteWebcamStreams.get(remotePeerId)?.id === stream.id) {
          state.remoteWebcamStreams.delete(remotePeerId);
          hooks.renderWebcamStrip();
        }
        state.remoteVideoStreams.set(remotePeerId, stream);
        if (!state.watchedStreamerId) {
          state.watchedStreamerId = remotePeerId;
        }
        hooks.renderStreamTabs();
        hooks.updateStageView();
      } else {
        state.remoteWebcamStreams.set(remotePeerId, stream);
        hooks.renderWebcamStrip();
      }

      e.track.onended = () => {
        if (state.remoteWebcamStreams.get(remotePeerId)?.id === stream.id) {
          state.remoteWebcamStreams.delete(remotePeerId);
          hooks.renderWebcamStrip();
        }
        if (state.remoteVideoStreams.get(remotePeerId)?.id === stream.id) {
          state.remoteVideoStreams.delete(remotePeerId);
          hooks.updateStageView();
        }
      };
    } else if (e.track.kind === "audio") {
      // P0-9: se a stream também tem vídeo, o áudio já toca no #stageVideo — evita duplicar
      if (stream.getVideoTracks().length > 0) {
        return;
      }
      let audioEl = document.getElementById(`audio-${remotePeerId}-${stream.id}`);
      if (!audioEl) {
        audioEl = document.createElement("audio");
        audioEl.id = `audio-${remotePeerId}-${stream.id}`;
        audioEl.dataset.peerId = remotePeerId;
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        audioEl.setAttribute("playsinline", "");
        audioEl.muted = state.selfDeaf || state.forceVoiceRelay;
        audioEl.volume = getEffectiveVolume(remotePeerId);
        applyOutputSinkToElement(audioEl);
        document.getElementById("remoteAudioContainer").appendChild(audioEl);
      }
      audioEl.srcObject = stream;
      audioEl.play().then(() => hooks.renderPeers()).catch(() => {
        const unlockBtn = document.getElementById("btnUnlockAudio");
        if (unlockBtn) unlockBtn.style.display = "block";
        hooks.renderPeers();
      });
    }
  };

  return pc;
}

export function attachLocalTracksToPc(pc) {
  const existingTrackIds = new Set(
    pc.getSenders().map(s => s.track && s.track.id).filter(Boolean)
  );

  if (state.localAudioStream) {
    for (const track of state.localAudioStream.getTracks()) {
      if (!existingTrackIds.has(track.id)) {
        pc.addTrack(track, state.localAudioStream);
      }
    }
  }

  if (state.localDisplayStream && state.myScreenShareMode === "web_rtc") {
    for (const track of state.localDisplayStream.getTracks()) {
      if (!existingTrackIds.has(track.id)) {
        pc.addTrack(track, state.localDisplayStream);
      }
    }
  } else if (state.localDisplayStream && state.myScreenShareMode === "universal_relay") {
    // T-2: envia o áudio do sistema via WebRTC quando o vídeo vai pelo Relay binário
    for (const track of state.localDisplayStream.getAudioTracks()) {
      if (!existingTrackIds.has(track.id)) {
        pc.addTrack(track, state.localDisplayStream);
      }
    }
  }

  if (state.localWebcamStream) {
    for (const track of state.localWebcamStream.getTracks()) {
      if (!existingTrackIds.has(track.id)) {
        pc.addTrack(track, state.localWebcamStream);
      }
    }
  }
}

export async function drainPendingCandidates(remotePeerId, pc) {
  const queue = state.pendingCandidates.get(remotePeerId);
  if (!queue || queue.length === 0) return;
  state.pendingCandidates.set(remotePeerId, []);
  for (const candidate of queue) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (_) {}
  }
}

export async function syncWebRtcPeers() {
  for (const peerId of state.peers.keys()) {
    if (peerId !== state.myPeerId && String(state.myPeerId) < String(peerId)) {
      await createAndSendOffer(peerId);
    }
  }
}

export async function renegotiateAllPeers() {
  for (const peerId of state.peers.keys()) {
    if (peerId !== state.myPeerId) {
      await createAndSendOffer(peerId);
    }
  }
}

export async function createAndSendOffer(remotePeerId) {
  const pc = getOrCreatePeerConnection(remotePeerId);
  if (state.makingOfferMap.get(remotePeerId) || pc.signalingState !== "stable") {
    state.pendingRenegotiatePeers.add(remotePeerId);
    return;
  }
  attachLocalTracksToPc(pc);
  state.makingOfferMap.set(remotePeerId, true);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendWs({
      type: "rtc_offer",
      target_id: remotePeerId,
      sdp: pc.localDescription
    });
  } catch (err) {
    console.warn("Erro ao criar oferta WebRTC:", err);
  } finally {
    state.makingOfferMap.set(remotePeerId, false);
  }
}

// P0-7: Perfect Negotiation (evita glare quando os dois mandam offer ao mesmo tempo)
export async function handleRtcOffer(fromId, sdp) {
  const pc = getOrCreatePeerConnection(fromId);
  const polite = String(state.myPeerId) < String(fromId);
  const offerCollision = !!state.makingOfferMap.get(fromId) || pc.signalingState !== "stable";

  if (offerCollision && !polite) {
    return;
  }

  try {
    if (offerCollision && polite) {
      await pc.setLocalDescription({ type: "rollback" });
      if (state.localAudioStream || state.localDisplayStream || state.localWebcamStream) {
        state.pendingRenegotiatePeers.add(fromId);
      }
    }
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await drainPendingCandidates(fromId, pc);
    attachLocalTracksToPc(pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendWs({
      type: "rtc_answer",
      target_id: fromId,
      sdp: pc.localDescription
    });
    if (state.pendingRenegotiatePeers.has(fromId) && pc.signalingState === "stable") {
      state.pendingRenegotiatePeers.delete(fromId);
      setTimeout(() => createAndSendOffer(fromId), 25);
    }
  } catch (err) {
    console.warn("Erro ao processar oferta WebRTC:", err);
  }
}

export async function handleRtcAnswer(fromId, sdp) {
  const pc = state.peerConnections.get(fromId);
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await drainPendingCandidates(fromId, pc);
    if (state.pendingRenegotiatePeers.has(fromId) && pc.signalingState === "stable") {
      state.pendingRenegotiatePeers.delete(fromId);
      setTimeout(() => createAndSendOffer(fromId), 25);
    }
  } catch (err) {
    console.warn("Erro ao aplicar resposta WebRTC:", err);
  }
}

export async function handleRtcIceCandidate(fromId, candidate) {
  const pc = getOrCreatePeerConnection(fromId);
  if (!pc.remoteDescription || !pc.remoteDescription.type) {
    const queue = state.pendingCandidates.get(fromId) || [];
    queue.push(candidate);
    state.pendingCandidates.set(fromId, queue);
    return;
  }
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (_) {}
}

export function closePeerConnection(peerId) {
  const pc = state.peerConnections.get(peerId);
  if (pc) {
    pc.close();
    state.peerConnections.delete(peerId);
  }
  state.pendingCandidates.delete(peerId);
  state.makingOfferMap.delete(peerId);
  state.pendingRenegotiatePeers.delete(peerId);
  cleanupPeerAudioCodecs(peerId);
  hooks.cleanupPeerVideoCodecs(peerId);
  state.remoteVideoStreams.delete(peerId);
  state.remoteWebcamStreams.delete(peerId);
  document.querySelectorAll(`[id^="audio-${peerId}-"]`).forEach(el => el.remove());
}
