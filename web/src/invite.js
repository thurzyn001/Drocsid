// Túnel na internet, convites DROCSID-/LHR-, QR Code offline e ações de anfitrião

import qrcode from "qrcode-generator";
import { state, escapeHtml, hostFetch } from "./state.js";
import { showToast, showConfirmModal, openImageLightbox } from "./ui-feedback.js";

let hooks = {
  connectWebSocket: () => {},
  selectShareMode: () => {},
};

let lastQrSvg = "";

export function registerInviteHooks(h) {
  hooks = { ...hooks, ...h };
}

export function toggleNetworkCard(force) {
  state.networkCardOpen = typeof force === "boolean" ? force : !state.networkCardOpen;
  const wrap = document.getElementById("networkDetailsWrap");
  const btn = document.getElementById("btnToggleNetworkCard");
  if (wrap) wrap.classList.toggle("open", state.networkCardOpen);
  if (btn) btn.setAttribute("aria-expanded", state.networkCardOpen ? "true" : "false");
}

export function applyRoleVisibility() {
  const hostOnly = state.isHost && !state.customServerOrigin;
  const hostTunnelBtn = document.getElementById("btnHostTunnel");
  if (hostTunnelBtn) hostTunnelBtn.style.display = hostOnly ? "flex" : "none";
  const rotateBtn = document.getElementById("btnRotateKey");
  if (rotateBtn) rotateBtn.style.display = hostOnly ? "inline-flex" : "none";
  const nativeCard = document.getElementById("modeNativeCard");
  if (nativeCard) nativeCard.style.display = hostOnly ? "block" : "none";
  const shutdownBtn = document.getElementById("btnShutdownApp");
  if (shutdownBtn) shutdownBtn.style.display = hostOnly ? "flex" : "none";
  const shutdownSettingsBtn = document.getElementById("btnShutdownAppSettings");
  if (shutdownSettingsBtn) shutdownSettingsBtn.style.display = hostOnly ? "inline-flex" : "none";
  const btnClearChat = document.getElementById("btnHostClearChat");
  if (btnClearChat) btnClearChat.style.display = state.isHost ? "inline-flex" : "none";
  const btnUnbanAll = document.getElementById("btnHostUnbanAll");
  if (btnUnbanAll) btnUnbanAll.style.display = state.isHost ? "inline-flex" : "none";
  if (!hostOnly) {
    const stopBtn = document.getElementById("btnStopTunnel");
    if (stopBtn) stopBtn.style.display = "none";
  }
  if (!hostOnly && state.selectedShareMode === "native_host") {
    hooks.selectShareMode("web_rtc");
  }
}

export async function rotateRoomKey() {
  if (!state.isHost) return;
  const ok = await showConfirmModal({
    title: "Gerar nova chave da sala",
    message: "Links, QR Codes e códigos antigos deixarão de funcionar. Continuar?",
    confirmText: "Gerar Chave",
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await hostFetch("/api/room/rotate-key", { method: "POST" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    await res.json();
    await checkTunnelStatus();
    showToast("Nova chave da sala gerada!", "success");
  } catch (err) {
    showToast("Erro ao rotacionar chave: " + err.message, "error");
  }
}

export async function shutdownHostApp() {
  if (!state.isHost) return;
  const ok = await showConfirmModal({
    title: "Encerrar Drocsid",
    message: "Encerrar o Drocsid (servidor local e túnel ativo) agora?",
    confirmText: "Encerrar",
    danger: true,
  });
  if (!ok) return;
  try {
    await hostFetch("/api/shutdown", { method: "POST" });
  } catch (_) {}
  window.close();
}

export async function startInternetTunnel() {
  const btn = document.getElementById("btnHostTunnel");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Abrindo...";
  }
  const lbl = document.getElementById("tunnelProviderLabel");
  if (lbl) lbl.textContent = "Conectando...";

  try {
    const res = await hostFetch("/api/tunnel/start", { method: "POST" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    pollTunnelUntilReady();
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "📡 Convidar";
    }
    showToast("Erro ao iniciar convite pela internet: " + err.message, "error");
  }
}

export async function stopInternetTunnel() {
  if (!state.isHost) return;
  const stopBtn = document.getElementById("btnStopTunnel");
  if (stopBtn) stopBtn.disabled = true;
  try {
    const res = await hostFetch("/api/tunnel/stop", { method: "POST" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    state.currentInviteText = "";
    state.qrExpanded = false;
    lastQrSvg = "";
    await checkTunnelStatus();
    showToast("Túnel de internet encerrado.", "info");
  } catch (err) {
    showToast("Erro ao parar túnel: " + err.message, "error");
  } finally {
    if (stopBtn) stopBtn.disabled = false;
  }
}

export function pollTunnelUntilReady() {
  let attempts = 0;
  const timer = setInterval(async () => {
    attempts++;
    const ready = await checkTunnelStatus();
    if (ready || attempts >= 40) {
      clearInterval(timer);
    }
  }, 1500);
}

export function toggleInviteQr() {
  state.qrExpanded = !state.qrExpanded;
  const wrap = document.getElementById("inviteQrWrap");
  const btn = document.getElementById("btnToggleQr");
  if (wrap) {
    wrap.style.display = state.qrExpanded && lastQrSvg ? "flex" : "none";
  }
  if (btn) {
    btn.classList.toggle("active-green", state.qrExpanded);
  }
}

function renderInviteQrIntoDom(st) {
  const wrap = document.getElementById("inviteQrWrap");
  if (!wrap || !st.invite_link) return;
  try {
    const qr = qrcode(0, "M");
    qr.addData(st.invite_link);
    qr.make();
    const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    lastQrSvg = svg;
    wrap.innerHTML = `${svg}<span class="invite-qr-hint">Toque para ampliar QR</span>`;
    wrap.onclick = () => {
      openImageLightbox({
        svgHtml: svg,
        caption: `Convite Drocsid • ${st.invite_code || ""}`,
        downloadName: "drocsid-convite-qr.svg",
      });
    };
    wrap.style.display = state.qrExpanded ? "flex" : "none";
  } catch (_) {}
}

export async function checkTunnelStatus() {
  try {
    const res = await hostFetch("/api/tunnel/status");
    if (!res.ok) return false;
    const st = await res.json();
    document.getElementById("tunnelProviderLabel").textContent =
      st.provider && st.provider !== "none" ? st.provider : "Local";
    if (st.status_message && !st.active && st.provider === "error") {
      const btn = document.getElementById("btnHostTunnel");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "📡 Convidar";
      }
      showToast(st.status_message, "error", 5000);
    }
    if (st.active && !st.public_url && st.status_message) {
      document.getElementById("tunnelProviderLabel").textContent = st.status_message.slice(0, 32);
    }

    const box = document.getElementById("inviteCodeBox");
    const copyBtn = document.getElementById("btnCopyInvite");
    const qrBtn = document.getElementById("btnToggleQr");
    const stopBtn = document.getElementById("btnStopTunnel");
    const qrWrap = document.getElementById("inviteQrWrap");

    if (st.active && st.public_url) {
      box.style.display = "block";
      state.currentInviteText = `Entre na minha sala do Drocsid:\nCódigo: ${st.invite_code}\nLink: ${st.invite_link}`;
      box.innerHTML = `<strong>Código:</strong> ${escapeHtml(st.invite_code)}<br/><span style="color:var(--text-muted)">${escapeHtml(st.invite_link)}</span>`;

      if (copyBtn) copyBtn.style.display = "flex";
      if (qrBtn) {
        qrBtn.style.display = "inline-flex";
        qrBtn.classList.toggle("active-green", state.qrExpanded);
      }
      if (stopBtn && state.isHost && !state.customServerOrigin) {
        stopBtn.style.display = "inline-flex";
      }
      renderInviteQrIntoDom(st);
      toggleNetworkCard(true);

      const btn = document.getElementById("btnHostTunnel");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "✅ Online";
      }
      if (!state.customServerOrigin) {
        const badge = document.getElementById("connectionBadge");
        if (badge) {
          badge.textContent = "Online";
          badge.style.background = "var(--green)";
        }
      }
      return true;
    }

    if (!st.active) {
      if (box) box.style.display = "none";
      if (copyBtn) copyBtn.style.display = "none";
      if (qrBtn) qrBtn.style.display = "none";
      if (stopBtn) stopBtn.style.display = "none";
      if (qrWrap) qrWrap.style.display = "none";
      const btn = document.getElementById("btnHostTunnel");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "📡 Convidar";
      }
      if (!state.customServerOrigin) {
        const badge = document.getElementById("connectionBadge");
        if (badge) {
          badge.textContent = "Local";
          badge.style.background = "var(--brand)";
        }
      }
    }
  } catch (_) {}
  return false;
}

export function copyInviteToClipboard() {
  if (!state.currentInviteText) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(state.currentInviteText).catch(() => {});
  }
  showToast("Convite copiado! Envie para os amigos.", "success");
  const btn = document.getElementById("btnCopyInvite");
  if (btn) {
    const oldHtml = btn.innerHTML;
    btn.textContent = "✅ Copiado! Envie aos amigos";
    setTimeout(() => { btn.innerHTML = oldHtml; }, 2200);
  }
}

export function openJoinRemoteModal() {
  document.getElementById("joinRemoteModal").classList.add("open");
}

export function closeJoinRemoteModal() {
  document.getElementById("joinRemoteModal").classList.remove("open");
}

export function parseInviteInput(rawInput) {
  const s = (rawInput || "").trim();
  if (!s) return null;

  // Link completo (pode vir colado dentro de uma mensagem)
  const urlMatch = s.match(/https?:\/\/[^\s)'"]+/i);
  if (urlMatch) {
    const token = urlMatch[0];
    const hashIdx = token.indexOf("#");
    const base = (hashIdx >= 0 ? token.slice(0, hashIdx) : token).replace(/\/+$/, "");
    const fragment = hashIdx >= 0 ? token.slice(hashIdx + 1) : "";
    const params = new URLSearchParams(fragment);
    const key = params.get("key") || "";
    if (key.length < 16) return null;
    return { origin: base, key };
  }

  const upper = s.toUpperCase();
  let rest = "";
  let domain = "";
  if (upper.startsWith("DROCSID-")) {
    rest = s.slice(8).trim();
    domain = "trycloudflare.com";
  } else if (upper.startsWith("LHR-")) {
    rest = s.slice(4).trim();
    domain = "lhr.life";
  } else {
    return null;
  }

  const lastDash = rest.lastIndexOf("-");
  if (lastDash <= 0) return null;
  const sub = rest.slice(0, lastDash).toLowerCase();
  const key = rest.slice(lastDash + 1);
  if (!sub || key.length < 16 || !/^[a-z0-9-]+$/i.test(sub) || !/^[a-z0-9]+$/i.test(key)) {
    return null;
  }
  return { origin: `https://${sub}.${domain}`, key };
}

export function applyRemoteInvite(parsed) {
  state.customServerOrigin = parsed.origin;
  state.remoteKey = parsed.key;
  applyRoleVisibility();
  closeJoinRemoteModal();
  const pill = document.getElementById("activeServerPill");
  if (pill) {
    pill.textContent = `Remoto: ${parsed.origin.replace(/^https?:\/\//i, "")}`;
    pill.style.display = "inline-flex";
  }
  const badge = document.getElementById("connectionBadge");
  if (badge) {
    badge.textContent = "Remoto";
    badge.style.background = "var(--green)";
  }
  hooks.connectWebSocket();
}

export function connectToFriendInvite() {
  const raw = document.getElementById("remoteInviteInput").value;
  const parsed = parseInviteInput(raw);
  if (!parsed) {
    showToast("Convite inválido. Cole o código completo (ex: DROCSID-xxx-chave) ou o link com #key=...", "warn");
    return;
  }
  applyRemoteInvite(parsed);
}

export function resetToLocalServer() {
  state.customServerOrigin = null;
  state.remoteKey = null;
  applyRoleVisibility();
  closeJoinRemoteModal();
  const pill = document.getElementById("activeServerPill");
  if (pill) {
    pill.textContent = "Local";
    pill.style.display = "none";
  }
  const badge = document.getElementById("connectionBadge");
  if (badge) {
    badge.textContent = "Local";
    badge.style.background = "var(--brand)";
  }
  hooks.connectWebSocket();
}
