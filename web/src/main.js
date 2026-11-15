// Ponto de entrada da SPA Drocsid: conecta módulos, inicializa listeners e expõe handlers ao HTML

import { AUTH, BASE_DOC_TITLE, state } from "./state.js";
import {
  registerInviteHooks,
  rotateRoomKey,
  shutdownHostApp,
  startInternetTunnel,
  stopInternetTunnel,
  toggleInviteQr,
  checkTunnelStatus,
  copyInviteToClipboard,
  openJoinRemoteModal,
  closeJoinRemoteModal,
  parseInviteInput,
  applyRemoteInvite,
  connectToFriendInvite,
  resetToLocalServer,
  toggleNetworkCard,
} from "./invite.js";
import {
  registerAudioCodecHooks,
  updateVoiceRelayStatusUi,
  toggleForceVoiceRelay,
  setStageVolume,
  setPeerVolume,
} from "./audio-codec.js";
import {
  toggleSoundboard,
  sendSoundEffect,
  renderLucideIcons,
  initFeedbackListeners,
  resolveDialogModal,
  closeImageLightbox,
  toggleOptionsMenu,
  closeOptionsMenu,
  openSettingsModal,
  closeSettingsModal,
  selectSettingsTab,
  toggleInfoAccordion,
} from "./ui-feedback.js";
import {
  registerSidebarHooks,
  applyAppearancePreferences,
  setTheme,
  toggleTheme,
  setDensity,
  toggleDensity,
  toggleShowTechDetails,
  toggleRoomExpand,
  renderRooms,
  promptNewRoom,
  updateProfile,
  renderPeers,
  kickPeer,
  banPeer,
  togglePeerServerMute,
  toggleRoomLock,
  deleteRoom,
  clearCurrentRoomChat,
  unbanAllPeers,
  resolveJoinApproval,
} from "./sidebar.js";
import {
  registerChatHooks,
  appendChatEntry,
  initChatPasteAndShortcuts,
  sendChatMessage,
  startReplyTo,
  cancelReplyTo,
  startEditMessage,
  reactToMessage,
  deleteChatMessage,
  scrollToMessage,
  triggerChatImagePicker,
} from "./chat.js";
import {
  registerVoiceHooks,
  openAudioSettingsModal,
  closeAudioSettingsModal,
  saveAudioSettings,
  previewMicGainChange,
  previewVadThresholdChange,
  toggleMicLoopbackTest,
  startCapturePttBind,
  toggleVoiceConnection,
  toggleMute,
  toggleDeaf,
  sendVoiceState,
  initVoiceListeners,
} from "./voice.js";
import {
  registerWebRtcHooks,
  openTurnModal,
  closeTurnModal,
  saveTurnConfig,
  clearTurnConfig,
  renegotiateAllPeers,
  closePeerConnection,
} from "./webrtc.js";
import {
  registerStageHooks,
  toggleMobileSidebar,
  toggleSidebarPanel,
  setLayoutViewMode,
  unlockBrowserAudio,
  initStageResizer,
  renderStreamTabs,
  selectWatchedStreamer,
  updateStageView,
  toggleGridMode,
  togglePinGridPeer,
  toggleTheaterMode,
  setSelfPreviewEnabled,
  toggleLaserMode,
  toggleWebcam,
  renderWebcamStrip,
  toggleStageFullscreen,
  togglePiP,
  closeActivePiP,
  updateTelemetryHud,
  cleanupPeerVideoCodecs,
} from "./stage.js";
import {
  registerScreenShareHooks,
  handleGoLiveButton,
  closeGoLiveModal,
  selectShareMode,
  toggleEngineHelp,
  loadNativeScreenPreviews,
  confirmStartScreenShare,
  stopScreenShare,
  fallbackWebRtcToUniversalRelay,
} from "./screenshare.js";
import { connectWebSocket } from "./ws.js";

// Registra os vínculos entre módulos (sem ciclos na inicialização)
registerAudioCodecHooks({ renderPeers, sendVoiceState });
registerInviteHooks({ connectWebSocket, selectShareMode });
registerSidebarHooks({
  toggleMobileSidebar,
  stopScreenShare,
  closePeerConnection,
  renderWebcamStrip,
});
registerChatHooks({ setLayoutViewMode, toggleMute, toggleDeaf });
registerVoiceHooks({ renderPeers, renegotiateAllPeers });
registerWebRtcHooks({
  fallbackWebRtcToUniversalRelay,
  renderWebcamStrip,
  renderStreamTabs,
  updateStageView,
  renderPeers,
  cleanupPeerVideoCodecs,
});
registerStageHooks({ renderPeers, renegotiateAllPeers });
registerScreenShareHooks({
  toggleMobileSidebar,
  updateStageView,
  renegotiateAllPeers,
  closeActivePiP,
});

function init() {
  applyAppearancePreferences();
  renderLucideIcons();
  initFeedbackListeners();
  const savedName = localStorage.getItem("drocsid_username") || ("Amigo-" + Math.floor(100 + Math.random() * 899));
  document.getElementById("usernameInput").value = savedName;
  const stageVolEl = document.getElementById("stageVolumeSlider");
  if (stageVolEl) stageVolEl.value = String(Math.round((state.stageVolume ?? 1) * 100));
  renderRooms();
  updateVoiceRelayStatusUi();
  try { initStageResizer(); } catch (err) { console.error("Erro em initStageResizer:", err); }
  try { initChatPasteAndShortcuts(); } catch (err) { console.error("Erro em initChatPasteAndShortcuts:", err); }
  initVoiceListeners();

  if (!window.isSecureContext) {
    appendChatEntry({
      username: "Sistema",
      text: "⚠️ Acesso via HTTP detectado: navegadores bloqueiam microfone e captura de tela fora de HTTPS ou localhost. Use o Link HTTPS do convite.",
      is_system: true
    });
  }
  if (AUTH.invite) {
    const parsedInvite = parseInviteInput(AUTH.invite);
    if (parsedInvite) {
      applyRemoteInvite(parsedInvite);
      if (AUTH.host) checkTunnelStatus();
      setInterval(updateTelemetryHud, 1000);
      return;
    }
  }
  if (!AUTH.host && !AUTH.key) {
    document.getElementById("stageEmpty").innerHTML = `
      <h3>Convite necessário para entrar na sala</h3>
      <p>Este endereço não contém a chave da sala. Cole o código (<code>DROCSID-...</code>) ou o link completo enviado pelo anfitrião:</p>
      <button class="btn" style="background: var(--brand); margin: 0 auto; padding: 9px 16px;" onclick="openJoinRemoteModal()">🔗 Inserir Código ou Link</button>
    `;
    openJoinRemoteModal();
    return;
  }
  connectWebSocket();
  if (AUTH.host) checkTunnelStatus();
  setInterval(updateTelemetryHud, 1000);
}

// Eventos globais de desbloqueio de áudio e título não lido
document.addEventListener("pointerdown", () => {
  const btn = document.getElementById("btnUnlockAudio");
  if (btn && btn.style.display !== "none") {
    unlockBrowserAudio();
  } else if (state.voicePlaybackCtx && state.voicePlaybackCtx.state === "suspended") {
    state.voicePlaybackCtx.resume().catch(() => {});
  }
}, { passive: true });

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.unreadCount > 0) {
    state.unreadCount = 0;
    document.title = BASE_DOC_TITLE;
  }
});

// Exposição global dos handlers usados nos atributos onclick/oninput/onchange/onsubmit
Object.assign(window, {
  toggleMobileSidebar,
  toggleSidebarPanel,
  toggleRoomExpand,
  setTheme,
  toggleTheme,
  setDensity,
  toggleDensity,
  toggleShowTechDetails,
  toggleNetworkCard,
  toggleOptionsMenu,
  closeOptionsMenu,
  openSettingsModal,
  closeSettingsModal,
  selectSettingsTab,
  toggleInfoAccordion,
  openTurnModal,
  closeTurnModal,
  saveTurnConfig,
  clearTurnConfig,
  startInternetTunnel,
  stopInternetTunnel,
  toggleInviteQr,
  openJoinRemoteModal,
  closeJoinRemoteModal,
  connectToFriendInvite,
  resetToLocalServer,
  copyInviteToClipboard,
  rotateRoomKey,
  promptNewRoom,
  updateProfile,
  toggleVoiceConnection,
  toggleMute,
  toggleDeaf,
  handleGoLiveButton,
  toggleWebcam,
  toggleSoundboard,
  openAudioSettingsModal,
  closeAudioSettingsModal,
  saveAudioSettings,
  previewMicGainChange,
  previewVadThresholdChange,
  toggleMicLoopbackTest,
  startCapturePttBind,
  toggleForceVoiceRelay,
  shutdownHostApp,
  setLayoutViewMode,
  unlockBrowserAudio,
  setStageVolume,
  toggleGridMode,
  togglePinGridPeer,
  toggleLaserMode,
  toggleTheaterMode,
  setSelfPreviewEnabled,
  togglePiP,
  toggleStageFullscreen,
  sendSoundEffect,
  sendChatMessage,
  startReplyTo,
  cancelReplyTo,
  startEditMessage,
  reactToMessage,
  deleteChatMessage,
  scrollToMessage,
  triggerChatImagePicker,
  resolveDialogModal,
  closeImageLightbox,
  closeGoLiveModal,
  selectShareMode,
  toggleEngineHelp,
  loadNativeScreenPreviews,
  confirmStartScreenShare,
  stopScreenShare,
  selectWatchedStreamer,
  setPeerVolume,
  kickPeer,
  banPeer,
  togglePeerServerMute,
  toggleRoomLock,
  deleteRoom,
  clearCurrentRoomChat,
  unbanAllPeers,
  resolveJoinApproval,
});

window.addEventListener("DOMContentLoaded", init);
