// Conexão WebSocket, reconexão limpa e roteamento de mensagens do servidor

import { AUTH, APP_VERSION, BASE_DOC_TITLE, state, escapeHtml, sendWs } from "./state.js";
import { applyRoleVisibility } from "./invite.js";
import {
  handleBinaryAudioFrame,
  updateVoiceRelayStatusUi,
  detectOpusRelayCapable,
  resetOpusAudioEncoder,
  cleanupPeerAudioCodecs,
} from "./audio-codec.js";
import { playNotificationBeep, playSoundboardEffect, showToast } from "./ui-feedback.js";
import { renderRooms, syncMyUsernameInput, renderPeers, switchRoom, renderJoinApprovalBanner } from "./sidebar.js";
import {
  resetChatUiState,
  appendChatEntry,
  updateChatEntryElement,
  handlePeerTyping,
  clearChatDom,
} from "./chat.js";
import {
  sendVoiceState,
  syncLocalAudioEnabled,
  updateVoiceButtonLabel,
  refreshMuteButtonUi,
} from "./voice.js";
import {
  syncWebRtcPeers,
  createAndSendOffer,
  renegotiateAllPeers,
  handleRtcOffer,
  handleRtcAnswer,
  handleRtcIceCandidate,
  closePeerConnection,
} from "./webrtc.js";
import {
  handleBinaryVideoFrame,
  handleNativeVideoFrame,
  cleanupPeerVideoCodecs,
  renderStreamTabs,
  selectWatchedStreamer,
  renderWebcamStrip,
  updateStageView,
  renderLaserDot,
} from "./stage.js";
import {
  updateGoLiveButtonState,
  detectVideoRelayCaps,
  resetVideoEncoderV2,
} from "./screenshare.js";

async function announceClientCapabilities(sock) {
  const [opusOk, videoCaps] = await Promise.all([
    detectOpusRelayCapable().catch(() => false),
    detectVideoRelayCaps().catch(() => ({ vp8: false, h264: false })),
  ]);
  state.clientCaps = {
    opus_relay: Boolean(opusOk),
    vp8_relay: Boolean(videoCaps?.vp8),
    h264_relay: Boolean(videoCaps?.h264),
  };
  if (state.ws === sock && sock.readyState === 1) {
    sendWs({
      type: "set_client_capabilities",
      caps: state.clientCaps,
    });
  }
}

export function connectWebSocket() {
  if (state.ws) {
    try { state.ws.onclose = null; state.ws.close(); } catch (_) {}
  }

  let wsUrl;
  const cidParam = `&cid=${encodeURIComponent(state.clientSessionId || "")}`;
  if (state.customServerOrigin) {
    const wsProto = state.customServerOrigin.startsWith("https:") ? "wss:" : "ws:";
    const hostPart = state.customServerOrigin.replace(/^https?:\/\//i, "");
    wsUrl = `${wsProto}//${hostPart}/ws?key=${encodeURIComponent(state.remoteKey || "")}${cidParam}`;
  } else {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const q = AUTH.host
      ? `host=${encodeURIComponent(AUTH.host)}`
      : `key=${encodeURIComponent(AUTH.key || "")}`;
    wsUrl = `${proto}//${location.host}/ws?${q}${cidParam}`;
  }

  const sock = new WebSocket(wsUrl);
  state.ws = sock;
  sock.binaryType = "arraybuffer";

  sock.onopen = () => {
    sendWs({
      type: "join_room",
      username: document.getElementById("usernameInput").value.trim(),
      room: state.currentRoom
    });
    announceClientCapabilities(sock);
    if (state.voiceEnabled || state.selfMute || state.selfDeaf) {
      sendVoiceState();
    }
    if (state.pingIntervalId) clearInterval(state.pingIntervalId);
    sendWs({ type: "ping", client_ts: Date.now() });
    state.pingIntervalId = setInterval(() => {
      sendWs({ type: "ping", client_ts: Date.now() });
    }, 3000);
  };

  sock.onmessage = async (event) => {
    if (event.data instanceof ArrayBuffer) {
      const buf = event.data;
      if (buf.byteLength >= 4) {
        const view = new DataView(buf);
        if (view.getUint8(0) === 68 && view.getUint8(1) === 65 && view.getUint8(2) === 70) {
          handleBinaryAudioFrame(buf);
          return;
        }
      }
      handleBinaryVideoFrame(buf);
      return;
    }
    const msg = JSON.parse(event.data);
    await handleServerMessage(msg);
  };

  sock.onclose = () => {
    if (state.pingIntervalId) {
      clearInterval(state.pingIntervalId);
      state.pingIntervalId = null;
    }
    state.pingMs = null;
    // P0-11: limpa estado local zumbi e codecs antes de reconectar
    resetOpusAudioEncoder();
    resetVideoEncoderV2();
    for (const peerId of Array.from(state.peerConnections.keys())) {
      closePeerConnection(peerId);
    }
    for (const pid of Array.from(state.opusDecodersByPeer.keys())) {
      cleanupPeerAudioCodecs(pid);
    }
    for (const pid of Array.from(state.videoDecodersByPeer.keys())) {
      cleanupPeerVideoCodecs(pid);
    }
    state.lastKeyframeReqByPeer.clear();
    state.peers.clear();
    state.peerJoinedAtMap.clear();
    state.pendingRenegotiatePeers.clear();
    state.voiceRelayInboundPeers.clear();
    for (const st of state.voicePlaybackPeers.values()) {
      try { st.gainNode.disconnect(); } catch (_) {}
    }
    state.voicePlaybackPeers.clear();
    state.remoteVideoStreams.clear();
    state.remoteWebcamStreams.clear();
    state.pendingCandidates.clear();
    state.makingOfferMap.clear();
    state.watchedStreamerId = null;
    state.pinnedGridPeerId = null;
    resetChatUiState();
    if (state.myScreenShareMode) {
      if (state.relayIntervalId) {
        clearInterval(state.relayIntervalId);
        state.relayIntervalId = null;
      }
      if (state.localDisplayStream) {
        state.localDisplayStream.getTracks().forEach(t => t.stop());
        state.localDisplayStream = null;
      }
      state.myScreenShareMode = null;
      updateGoLiveButtonState(false);
    }
    renderPeers();
    renderStreamTabs();
    renderWebcamStrip();
    updateStageView();
    document.getElementById("hudStatus").textContent = "Reconectando...";
    setTimeout(connectWebSocket, 2500);
  };
}

function syncRoomSummaries(summaries) {
  if (!Array.isArray(summaries)) return;
  state.roomSummaries.clear();
  for (const s of summaries) {
    if (s && s.name) {
      state.roomSummaries.set(s.name, s);
    }
  }
}

export async function handleServerMessage(msg) {
  switch (msg.type) {
    case "welcome":
      state.myPeerId = msg.peer_id;
      state.isHost = !!msg.is_host;
      state.serverVersion = msg.version || null;
      applyRoleVisibility();
      if (Array.isArray(msg.rooms)) {
        state.knownRooms = Array.from(new Set([...state.knownRooms, ...msg.rooms]));
      }
      syncRoomSummaries(msg.room_summaries);
      renderRooms();
      {
        const badge = document.getElementById("versionMismatchBadge");
        if (msg.version && APP_VERSION && msg.version !== APP_VERSION) {
          if (badge) {
            badge.style.display = "inline-flex";
            badge.title = `Servidor v${msg.version} ≠ Interface v${APP_VERSION}`;
          }
          showToast(`Servidor v${msg.version} difere da página carregada (v${APP_VERSION}). Recarregue se notar falhas.`, "warn", 6500);
        } else if (badge) {
          badge.style.display = "none";
        }
      }
      break;

    case "room_state": {
      state.currentRoom = msg.room;
      if (!state.knownRooms.includes(state.currentRoom)) state.knownRooms.push(state.currentRoom);
      document.getElementById("currentRoomLabel").textContent = `#${state.currentRoom}`;
      syncRoomSummaries(msg.room_summaries);
      renderRooms();

      if (typeof msg.shared_turn !== "undefined") {
        state.sharedTurnConfig = msg.shared_turn || null;
      }

      state.peers.clear();
      state.peerJoinedAtMap.clear();
      const nowTs = Date.now();
      for (const p of msg.peers) {
        state.peers.set(p.peer_id, p);
        state.peerJoinedAtMap.set(p.peer_id, nowTs);
      }
      syncMyUsernameInput();
      syncLocalAudioEnabled();
      refreshMuteButtonUi();
      renderJoinApprovalBanner();
      renderPeers();
      renderStreamTabs();
      renderWebcamStrip();

      resetChatUiState();
      const container = document.getElementById("messagesContainer");
      container.innerHTML = "";
      for (const entry of msg.chat_history) {
        appendChatEntry(entry);
      }

      await syncWebRtcPeers();
      updateVoiceRelayStatusUi();
      break;
    }

    case "rooms_updated":
      if (Array.isArray(msg.rooms)) {
        state.knownRooms = Array.from(new Set(msg.rooms));
      }
      syncRoomSummaries(msg.room_summaries);
      renderRooms();
      break;

    case "peer_joined":
      state.peers.set(msg.peer.peer_id, msg.peer);
      state.peerJoinedAtMap.set(msg.peer.peer_id, Date.now());
      renderPeers();
      renderStreamTabs();
      updateVoiceRelayStatusUi();
      if (msg.peer.peer_id !== state.myPeerId) {
        if (msg.peer.in_voice) playNotificationBeep(520, 60);
        await createAndSendOffer(msg.peer.peer_id);
      }
      break;

    case "peer_updated": {
      const prev = state.peers.get(msg.peer.peer_id);
      state.peers.set(msg.peer.peer_id, msg.peer);
      if (msg.peer.peer_id === state.myPeerId) {
        syncMyUsernameInput();
        if (msg.peer.server_muted && (!prev || !prev.server_muted)) {
          state.selfMute = true;
          state.isSpeaking = false;
          showToast("🔇 Seu microfone foi silenciado pelo anfitrião.", "warn", 5000);
        } else if (!msg.peer.server_muted && prev?.server_muted) {
          showToast("🎙️ Seu microfone foi liberado pelo anfitrião.", "success", 4000);
        }
        syncLocalAudioEnabled();
        refreshMuteButtonUi();
      } else if (prev && !prev.in_voice && msg.peer.in_voice) {
        playNotificationBeep(580, 65);
      } else if (prev && prev.in_voice && !msg.peer.in_voice) {
        playNotificationBeep(340, 65);
      }
      if (!msg.peer.screen_share) {
        cleanupPeerVideoCodecs(msg.peer.peer_id);
      }
      if (!msg.peer.screen_share || msg.peer.screen_share.mode !== "web_rtc") {
        if (msg.peer.peer_id !== state.myPeerId) {
          state.remoteVideoStreams.delete(msg.peer.peer_id);
        }
      } else {
        const misclassified = state.remoteWebcamStreams.get(msg.peer.peer_id);
        if (misclassified && misclassified.id === msg.peer.screen_share.source_id) {
          state.remoteWebcamStreams.delete(msg.peer.peer_id);
          state.remoteVideoStreams.set(msg.peer.peer_id, misclassified);
          renderWebcamStrip();
        }
      }
      renderPeers();
      renderStreamTabs();
      updateVoiceRelayStatusUi();
      if (msg.peer.screen_share && !state.watchedStreamerId) {
        selectWatchedStreamer(msg.peer.peer_id);
      }
      if (!msg.peer.screen_share && state.watchedStreamerId === msg.peer.peer_id) {
        state.watchedStreamerId = null;
      }
      updateStageView();
      break;
    }

    case "peer_left":
      state.peers.delete(msg.peer_id);
      state.peerJoinedAtMap.delete(msg.peer_id);
      closePeerConnection(msg.peer_id);
      if (state.watchedStreamerId === msg.peer_id) {
        state.watchedStreamerId = null;
      }
      renderPeers();
      renderStreamTabs();
      renderWebcamStrip();
      updateStageView();
      updateVoiceRelayStatusUi();
      break;

    case "chat_broadcast":
      appendChatEntry(msg.entry);
      if (msg.entry && msg.entry.peer_id !== state.myPeerId && !msg.entry.is_system && document.hidden) {
        state.unreadCount++;
        document.title = `(${state.unreadCount}) ${BASE_DOC_TITLE}`;
        playNotificationBeep(660, 80);
      }
      break;

    case "chat_message_updated":
      if (!msg.room || msg.room === state.currentRoom) {
        updateChatEntryElement(msg.entry);
      }
      break;

    case "peer_typing":
      handlePeerTyping(msg.peer_id, msg.username, msg.is_typing);
      break;

    case "turn_config_updated":
      state.sharedTurnConfig = msg.turn || null;
      if (!(localStorage.getItem("drocsid_turn_url") || "").trim()) {
        await renegotiateAllPeers();
        showToast(
          state.sharedTurnConfig
            ? "Anfitrião compartilhou um servidor TURN para a sala!"
            : "Servidor TURN compartilhado pelo anfitrião foi removido.",
          "info"
        );
      }
      break;

    case "native_video_frame":
      handleNativeVideoFrame(msg);
      break;

    case "pong":
      if (typeof msg.client_ts === "number") {
        state.pingMs = Math.max(1, Date.now() - msg.client_ts);
      }
      break;

    case "laser_pointer":
      renderLaserDot(msg.peer_id, msg.username, msg.x_norm, msg.y_norm);
      break;

    case "sound_effect":
      playSoundboardEffect(msg.kind, msg.username);
      break;

    case "kicked":
      if (state.ws) {
        state.ws.onclose = null;
        state.ws.close();
      }
      showToast(msg.reason || "Você foi removido da sala.", "error", 7000);
      document.getElementById("stageEmpty").innerHTML =
        `<h3>Desconectado</h3><p>${escapeHtml(msg.reason || "Removido pelo anfitrião.")}</p>`;
      break;

    case "join_approval_required":
      showToast(`🔒 Sala #${msg.room} trancada. Aguardando aprovação do anfitrião...`, "info", 5500);
      break;

    case "join_approval_request":
      if (!state.pendingJoinApprovals) state.pendingJoinApprovals = [];
      if (!state.pendingJoinApprovals.some((r) => r.peer_id === msg.peer_id && r.room === msg.room)) {
        state.pendingJoinApprovals.push({
          peer_id: msg.peer_id,
          username: msg.username || "Amigo",
          room: msg.room || "geral",
        });
      }
      renderJoinApprovalBanner();
      playNotificationBeep(740, 90);
      showToast(`🔒 ${msg.username || "Convidado"} pediu para entrar em #${msg.room}`, "info", 5000);
      break;

    case "join_approval_result":
      if (msg.approved && msg.room) {
        showToast(`✅ Entrada aprovada em #${msg.room}!`, "success", 3500);
        switchRoom(msg.room, true);
      } else {
        showToast(`❌ Solicitação para #${msg.room || ""} recusada pelo anfitrião.`, "warn", 5000);
      }
      break;

    case "chat_cleared":
      if (!msg.room || msg.room === state.currentRoom) {
        clearChatDom(Array.isArray(msg.history) ? msg.history : []);
        showToast("🧹 O histórico do chat foi limpo pelo anfitrião.", "info", 4000);
      }
      break;

    case "rtc_offer":
      await handleRtcOffer(msg.from_id, msg.sdp);
      break;

    case "rtc_answer":
      await handleRtcAnswer(msg.from_id, msg.sdp);
      break;

    case "rtc_ice_candidate":
      await handleRtcIceCandidate(msg.from_id, msg.candidate);
      break;

    case "request_video_keyframe":
      state.forceNextVideoKeyframe = true;
      break;

    case "global_ptt_state":
      if (state.pttEnabled && state.globalPttEnabled && state.voiceEnabled && !state.selfMute && !state.selfDeaf) {
        const nextDown = Boolean(msg.pressed);
        if (nextDown !== state.pttKeyDown) {
          state.pttKeyDown = nextDown;
          syncLocalAudioEnabled();
          updateVoiceButtonLabel();
          if (!nextDown && state.isSpeaking) {
            state.isSpeaking = false;
            sendVoiceState();
          }
        }
      }
      break;
  }
}
