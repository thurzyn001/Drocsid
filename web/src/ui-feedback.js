// Feedback sonoro (notificações e soundboard), ícones Lucide, toasts, modais e lightbox

import {
  createIcons,
  SunMoon,
  Rows3,
  X,
  Globe,
  Settings,
  Radio,
  Link2,
  Copy,
  QrCode,
  KeyRound,
  Square,
  Volume2,
  Grid2x2,
  Crosshair,
  Clapperboard,
  PictureInPicture2,
  Maximize,
  Paperclip,
  Send,
  Pin,
  Trash2,
  Pencil,
  Reply,
  Smile,
  Eye,
  SlidersHorizontal,
  ChevronDown,
  HelpCircle,
  Sparkles,
  Power,
  Menu,
} from "lucide";
import { state, sendWs } from "./state.js";

const LUCIDE_ICONS = {
  SunMoon,
  Rows3,
  X,
  Globe,
  Settings,
  Radio,
  Link2,
  Copy,
  QrCode,
  KeyRound,
  Square,
  Volume2,
  Grid2x2,
  Crosshair,
  Clapperboard,
  PictureInPicture2,
  Maximize,
  Paperclip,
  Send,
  Pin,
  Trash2,
  Pencil,
  Reply,
  Smile,
  Eye,
  SlidersHorizontal,
  ChevronDown,
  HelpCircle,
  Sparkles,
  Power,
  Menu,
};

export function renderLucideIcons(root = document) {
  if (typeof document === "undefined" || !root) return;
  try {
    createIcons({
      icons: LUCIDE_ICONS,
      attrs: { width: 15, height: 15, "stroke-width": 2 },
      root,
    });
  } catch (_) {}
}

export function showToast(message, kind = "info", durationMs = 3400) {
  if (typeof document === "undefined") return;
  const container = document.getElementById("toastContainer");
  if (!container) return;

  while (container.children.length >= 5) {
    container.firstElementChild?.remove();
  }

  const toast = document.createElement("div");
  const safeKind = ["info", "success", "warn", "error"].includes(kind) ? kind : "info";
  toast.className = `toast toast-${safeKind}`;
  toast.setAttribute("role", "status");

  const msgSpan = document.createElement("span");
  msgSpan.className = "toast-msg";
  msgSpan.textContent = String(message || "");

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "toast-close";
  closeBtn.setAttribute("aria-label", "Fechar notificação");
  closeBtn.textContent = "×";

  let timer = null;
  const dismiss = () => {
    if (timer) clearTimeout(timer);
    toast.remove();
  };
  closeBtn.onclick = dismiss;
  toast.onclick = (e) => {
    if (e.target === toast || e.target === msgSpan) dismiss();
  };

  toast.appendChild(msgSpan);
  toast.appendChild(closeBtn);
  container.appendChild(toast);

  if (durationMs > 0) {
    timer = setTimeout(dismiss, durationMs);
  }
}

let pendingDialog = null;

function openDialogBase({
  title,
  message,
  isPrompt = false,
  placeholder = "",
  defaultValue = "",
  confirmText = "Confirmar",
  cancelText = "Cancelar",
  danger = false,
}) {
  if (typeof document === "undefined") {
    return Promise.resolve(isPrompt ? null : false);
  }
  const modal = document.getElementById("dialogModal");
  const titleEl = document.getElementById("dialogTitle");
  const msgEl = document.getElementById("dialogMessage");
  const inputWrap = document.getElementById("dialogInputWrap");
  const inputEl = document.getElementById("dialogPromptInput");
  const cancelBtn = document.getElementById("dialogCancelBtn");
  const confirmBtn = document.getElementById("dialogConfirmBtn");
  if (!modal || !titleEl || !msgEl || !confirmBtn || !cancelBtn) {
    return Promise.resolve(isPrompt ? null : false);
  }

  if (pendingDialog) {
    resolveDialogModal(false);
  }

  titleEl.textContent = title || "Confirmar";
  msgEl.textContent = message || "";
  if (inputWrap && inputEl) {
    inputWrap.style.display = isPrompt ? "block" : "none";
    inputEl.placeholder = placeholder;
    inputEl.value = defaultValue;
  }
  cancelBtn.textContent = cancelText;
  confirmBtn.textContent = confirmText;
  confirmBtn.style.background = danger ? "var(--red)" : "var(--brand)";

  modal.classList.add("open");
  setTimeout(() => {
    if (isPrompt && inputEl) {
      inputEl.focus();
      inputEl.select();
    } else {
      confirmBtn.focus();
    }
  }, 15);

  return new Promise((resolve) => {
    pendingDialog = { resolve, isPrompt };
  });
}

export function showConfirmModal(opts = {}) {
  return openDialogBase({ ...opts, isPrompt: false });
}

export function showPromptModal(opts = {}) {
  return openDialogBase({
    confirmText: "Criar",
    ...opts,
    isPrompt: true,
  });
}

export function resolveDialogModal(accepted) {
  const modal = typeof document !== "undefined" ? document.getElementById("dialogModal") : null;
  if (modal) modal.classList.remove("open");
  if (!pendingDialog) return;
  const current = pendingDialog;
  pendingDialog = null;
  if (current.isPrompt) {
    const inputEl = document.getElementById("dialogPromptInput");
    current.resolve(accepted ? (inputEl ? inputEl.value : "") : null);
  } else {
    current.resolve(Boolean(accepted));
  }
}

function isAllowedMediaSrc(src) {
  if (typeof src !== "string") return false;
  return (
    src.startsWith("data:image/") ||
    src.startsWith("https://") ||
    src.startsWith("http://") ||
    src.startsWith("/api/media/") ||
    src.startsWith("blob:")
  );
}

export function openImageLightbox({ src = "", svgHtml = "", caption = "", downloadName = "drocsid-imagem.jpg" } = {}) {
  if (typeof document === "undefined") return;
  const modal = document.getElementById("lightboxModal");
  const body = document.getElementById("lightboxBody");
  const captionEl = document.getElementById("lightboxCaption");
  const downloadEl = document.getElementById("lightboxDownloadLink");
  if (!modal || !body) return;

  body.innerHTML = "";
  if (captionEl) captionEl.textContent = caption || "Visualização";

  if (svgHtml) {
    const card = document.createElement("div");
    card.style.cssText = "background:#fff;padding:16px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;max-width:90vw;max-height:76vh;";
    card.innerHTML = svgHtml;
    const svgEl = card.querySelector("svg");
    if (svgEl) {
      svgEl.style.width = "min(320px, 75vw)";
      svgEl.style.height = "auto";
    }
    body.appendChild(card);
    if (downloadEl) {
      const svgMarkup = card.innerHTML;
      downloadEl.href = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgMarkup);
      downloadEl.download = downloadName || "drocsid-convite-qr.svg";
      downloadEl.style.display = "inline-flex";
    }
  } else if (isAllowedMediaSrc(src)) {
    const img = document.createElement("img");
    img.src = src;
    img.alt = caption || "Imagem ampliada";
    body.appendChild(img);
    if (downloadEl) {
      downloadEl.href = src;
      downloadEl.download = downloadName || "drocsid-imagem.jpg";
      downloadEl.style.display = "inline-flex";
    }
  } else {
    if (downloadEl) downloadEl.style.display = "none";
    return;
  }

  modal.classList.add("open");
}

export function closeImageLightbox() {
  if (typeof document === "undefined") return;
  const modal = document.getElementById("lightboxModal");
  const body = document.getElementById("lightboxBody");
  if (modal) modal.classList.remove("open");
  if (body) body.innerHTML = "";
}

export function initFeedbackListeners() {
  if (typeof document === "undefined") return;
  const inputEl = document.getElementById("dialogPromptInput");
  if (inputEl && !inputEl.dataset.boundEnter) {
    inputEl.dataset.boundEnter = "1";
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        resolveDialogModal(true);
      }
    });
  }

  const lightbox = document.getElementById("lightboxModal");
  if (lightbox && !lightbox.dataset.boundBackdrop) {
    lightbox.dataset.boundBackdrop = "1";
    lightbox.addEventListener("click", (e) => {
      if (e.target === lightbox) closeImageLightbox();
    });
  }

  const dialog = document.getElementById("dialogModal");
  if (dialog && !dialog.dataset.boundBackdrop) {
    dialog.dataset.boundBackdrop = "1";
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) resolveDialogModal(false);
    });
  }

  const settingsModal = document.getElementById("settingsModal");
  if (settingsModal && !settingsModal.dataset.boundBackdrop) {
    settingsModal.dataset.boundBackdrop = "1";
    settingsModal.addEventListener("click", (e) => {
      if (e.target === settingsModal) closeSettingsModal();
    });
  }

  if (!document.body.dataset.boundOutsideOptions) {
    document.body.dataset.boundOutsideOptions = "1";
    document.addEventListener("click", (e) => {
      const wrap = document.getElementById("optionsMenuWrap");
      const pop = document.getElementById("optionsPopover");
      if (pop && pop.classList.contains("open") && wrap && !wrap.contains(e.target)) {
        closeOptionsMenu();
      }
    });
  }

  if (!document.body.dataset.boundModalEsc) {
    document.body.dataset.boundModalEsc = "1";
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const pop = document.getElementById("optionsPopover");
      if (pop && pop.classList.contains("open")) {
        closeOptionsMenu();
        return;
      }
      if (settingsModal && settingsModal.classList.contains("open")) {
        closeSettingsModal();
        return;
      }
      if (lightbox && lightbox.classList.contains("open")) {
        closeImageLightbox();
        return;
      }
      if (dialog && dialog.classList.contains("open")) {
        resolveDialogModal(false);
      }
    });
  }
}

export function playNotificationBeep(freq = 660, durationMs = 80) {
  if (state.selfDeaf) return;
  try {
    if (!state.notifAudioCtx) {
      state.notifAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    const osc = state.notifAudioCtx.createOscillator();
    const gain = state.notifAudioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.value = 0.05 * state.masterVolume;
    osc.connect(gain);
    gain.connect(state.notifAudioCtx.destination);
    osc.start();
    setTimeout(() => {
      try { osc.stop(); } catch (_) {}
    }, durationMs);
  } catch (_) {}
}

export function toggleSoundboard() {
  const bar = document.getElementById("soundboardBar");
  const btn = document.getElementById("btnSoundboard");
  if (!bar) return;
  const open = bar.classList.toggle("open");
  if (btn) btn.classList.toggle("active-green", open);
}

export function closeOptionsMenu() {
  const pop = document.getElementById("optionsPopover");
  const btn = document.getElementById("btnOptionsMenu");
  if (pop) pop.classList.remove("open");
  if (btn) btn.setAttribute("aria-expanded", "false");
}

export function toggleOptionsMenu(force) {
  const pop = document.getElementById("optionsPopover");
  const btn = document.getElementById("btnOptionsMenu");
  if (!pop) return;
  const open = typeof force === "boolean" ? force : !pop.classList.contains("open");
  pop.classList.toggle("open", open);
  if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
}

export function selectSettingsTab(tab = "appearance") {
  const validTabs = ["appearance", "network", "guides"];
  const chosen = validTabs.includes(tab) ? tab : "appearance";
  document.querySelectorAll("[data-settings-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.settingsTab === chosen);
  });
  document.querySelectorAll("[data-settings-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.settingsPanel === chosen);
  });
}

export function openSettingsModal(tab = "appearance") {
  closeOptionsMenu();
  selectSettingsTab(tab);
  const modal = document.getElementById("settingsModal");
  if (modal) modal.classList.add("open");
}

export function closeSettingsModal() {
  const modal = document.getElementById("settingsModal");
  if (modal) modal.classList.remove("open");
}

export function toggleInfoAccordion(panelId) {
  if (!panelId) return;
  const el = document.getElementById(panelId);
  if (!el) return;
  el.classList.toggle("open");
}

export function sendSoundEffect(kind) {
  sendWs({ type: "sound_effect", kind });
}

export function playSoundboardEffect(kind, username) {
  if (state.selfDeaf) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    const vol = 0.16 * state.masterVolume;
    const playTone = (freq, start, dur, type = "triangle", endFreq = null) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now + start);
      if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, now + start + dur);
      gain.gain.setValueAtTime(Math.max(0.001, vol), now + start);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.02);
    };

    if (kind === "party") {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => playTone(f, i * 0.08, 0.18, "triangle"));
    } else if (kind === "alert") {
      playTone(880, 0, 0.14, "square");
      playTone(660, 0.15, 0.14, "square");
      playTone(880, 0.30, 0.18, "square");
    } else if (kind === "badum") {
      playTone(170, 0, 0.12, "sine", 70);
      playTone(140, 0.16, 0.12, "sine", 65);
      playTone(1200, 0.32, 0.35, "sawtooth", 300);
    } else {
      playTone(350, 0, 0.36, "sawtooth");
      playTone(440, 0, 0.36, "sawtooth");
    }
    setTimeout(() => ctx.close().catch(() => {}), 900);
  } catch (_) {}
  const hud = document.getElementById("hudStatus");
  if (hud && username) {
    hud.dataset.soundNotice = `${username} tocou ${kind}`;
  }
}
