// Chat rico em Markdown seguro, respostas, reações, edição/exclusão, digitação, drag-and-drop e lightbox

import { Marked } from "marked";
import DOMPurify from "dompurify";
import { state, AUTH, escapeHtml, isMobileDevice, sendWs } from "./state.js";
import { showToast, showConfirmModal, openImageLightbox } from "./ui-feedback.js";

let hooks = {
  setLayoutViewMode: () => {},
  toggleMute: () => {},
  toggleDeaf: () => {},
};

let lastTypingSentAt = 0;
let stopTypingTimer = null;
let lastRenderedMeta = null;

export function registerChatHooks(h) {
  hooks = { ...hooks, ...h };
}

const chatMarked = new Marked({
  gfm: true,
  breaks: true,
});

chatMarked.use({
  renderer: {
    html(token) {
      return escapeHtml(token.raw || token.text || "");
    },
    link(token) {
      const href = String(token.href || "").trim();
      const labelHtml = this.parser.parseInline(token.tokens || []);
      if (!/^https?:\/\//i.test(href)) {
        return labelHtml || escapeHtml(href);
      }
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`;
    },
    image(token) {
      return escapeHtml(token.text || token.href || "[imagem]");
    },
  },
});

function getDomPurifier() {
  if (DOMPurify && typeof DOMPurify.sanitize === "function") return DOMPurify;
  if (typeof DOMPurify === "function" && typeof window !== "undefined") {
    return DOMPurify(window);
  }
  return null;
}

export function linkifyText(escapedText) {
  let html = escapedText.replace(
    /(https?:\/\/[^\s<"]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  return html;
}

export function renderMarkdownSafe(rawText) {
  const text = String(rawText || "");
  if (!text.trim()) return "";
  try {
    const parsedHtml = chatMarked.parse(text);
    const purifier = getDomPurifier();
    if (purifier) {
      return purifier.sanitize(parsedHtml, {
        ALLOWED_TAGS: [
          "p",
          "br",
          "strong",
          "b",
          "em",
          "i",
          "del",
          "s",
          "code",
          "pre",
          "blockquote",
          "ul",
          "ol",
          "li",
          "a",
        ],
        ALLOWED_ATTR: ["href", "target", "rel"],
        ALLOW_DATA_ATTR: false,
      });
    }
    return linkifyText(escapeHtml(text));
  } catch (_) {
    return linkifyText(escapeHtml(text));
  }
}

export function resetChatUiState() {
  state.chatEntriesById.clear();
  state.typingPeers.clear();
  state.replyingTo = null;
  state.editingMessageId = null;
  lastRenderedMeta = null;
  const banner = document.getElementById("chatReplyBanner");
  if (banner) banner.style.display = "none";
  renderTypingIndicator();
}

function isImageEntry(entry) {
  return (
    typeof entry?.text === "string" &&
    (entry.text.startsWith("[drocsid-img]data:image/") || entry.text.startsWith("[drocsid-media]"))
  );
}

export function buildMediaAuthQuery() {
  if (state.customServerOrigin) {
    return `key=${encodeURIComponent(state.remoteKey || "")}`;
  }
  if (AUTH?.host) {
    return `host=${encodeURIComponent(AUTH.host)}`;
  }
  return `key=${encodeURIComponent(AUTH?.key || "")}`;
}

export function resolveMediaUrl(relUrl) {
  const raw = String(relUrl || "").trim();
  if (raw.startsWith("https://") || raw.startsWith("http://")) {
    return raw;
  }
  if (!raw.startsWith("/api/media/")) {
    return "";
  }
  const base = state.customServerOrigin ? `${state.customServerOrigin}${raw}` : raw;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${buildMediaAuthQuery()}`;
}

function buildMessageBodyHtml(entry) {
  if (entry.deleted) {
    return `<span class="msg-deleted">(mensagem removida)</span>`;
  }
  const text = String(entry.text || "");
  if (text.startsWith("[drocsid-img]data:image/")) {
    const dataUrl = text.slice("[drocsid-img]".length);
    const safeSrc = escapeHtml(dataUrl);
    return `<img class="chat-img" src="${safeSrc}" data-img-author="${escapeHtml(entry.username || "Amigo")}" alt="Imagem enviada no chat" />`;
  }
  if (text.startsWith("[drocsid-media]")) {
    const resolved = resolveMediaUrl(text.slice("[drocsid-media]".length));
    if (resolved) {
      const safeSrc = escapeHtml(resolved);
      return `<img class="chat-img" src="${safeSrc}" data-img-author="${escapeHtml(entry.username || "Amigo")}" alt="Mídia enviada no chat" />`;
    }
  }
  const mdHtml = renderMarkdownSafe(text);
  const editedTag = entry.edited_at_ms ? ` <span class="msg-edited">(editada)</span>` : "";
  return `${mdHtml}${editedTag}`;
}

function buildReplyQuoteHtml(entry) {
  if (!entry.reply_to || entry.deleted) return "";
  const r = entry.reply_to;
  return `<div class="msg-reply-quote" onclick="scrollToMessage('${escapeHtml(r.id)}')" title="Ir para mensagem original">↩️ <strong>${escapeHtml(r.username)}</strong>: ${escapeHtml(r.snippet)}</div>`;
}

function buildActionsHtml(entry) {
  if (entry.is_system || entry.deleted || !entry.id) return "";
  const idAttr = escapeHtml(entry.id);
  const isOwner = entry.peer_id && entry.peer_id === state.myPeerId;
  const canDelete = isOwner || state.isHost;
  const canEdit = isOwner && !isImageEntry(entry);

  const quickEmojis = ["👍", "😂", "❤️", "🔥"];
  const reactBtns = quickEmojis
    .map(
      (emoji) =>
        `<button type="button" class="msg-action-btn" title="Reagir ${emoji}" onclick="reactToMessage('${idAttr}', '${emoji}')">${emoji}</button>`
    )
    .join("");
  const replyBtn = `<button type="button" class="msg-action-btn" title="Responder" onclick="startReplyTo('${idAttr}')">↩️</button>`;
  const editBtn = canEdit
    ? `<button type="button" class="msg-action-btn" title="Editar" onclick="startEditMessage('${idAttr}')">✏️</button>`
    : "";
  const deleteBtn = canDelete
    ? `<button type="button" class="msg-action-btn danger" title="Apagar" onclick="deleteChatMessage('${idAttr}')">🗑️</button>`
    : "";

  return `<div class="msg-actions">${reactBtns}${replyBtn}${editBtn}${deleteBtn}</div>`;
}

function buildReactionsHtml(entry) {
  if (entry.deleted || !entry.id || !entry.reactions || typeof entry.reactions !== "object") return "";
  const idAttr = escapeHtml(entry.id);
  const chips = [];
  for (const [emoji, peerIds] of Object.entries(entry.reactions)) {
    if (!Array.isArray(peerIds) || peerIds.length === 0) continue;
    const mine = state.myPeerId && peerIds.includes(state.myPeerId);
    chips.push(
      `<button type="button" class="reaction-chip${mine ? " active" : ""}" onclick="reactToMessage('${idAttr}', '${escapeHtml(emoji)}')"><span>${escapeHtml(emoji)}</span><span>${peerIds.length}</span></button>`
    );
  }
  return chips.length > 0 ? `<div class="msg-reactions">${chips.join("")}</div>` : "";
}

function bindChatImages(rootEl, entry) {
  rootEl.querySelectorAll("img.chat-img").forEach((imgEl) => {
    imgEl.onclick = () => {
      openImageLightbox({
        src: imgEl.getAttribute("src") || "",
        caption: `Enviada por ${entry.username || "Amigo"}`,
        downloadName: `drocsid-${entry.id || Date.now()}.jpg`,
      });
    };
  });
}

function renderMessageInnerHtml(entry, grouped) {
  const date = new Date(entry.timestamp_ms || Date.now());
  const timeStr = date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const headerHtml = grouped
    ? ""
    : `<div class="msg-header"><span class="msg-author">${escapeHtml(entry.username)}</span><span class="msg-time">${timeStr}</span></div>`;

  return `
    ${buildActionsHtml(entry)}
    ${buildReplyQuoteHtml(entry)}
    ${headerHtml}
    <div class="msg-text">${buildMessageBodyHtml(entry)}</div>
    ${buildReactionsHtml(entry)}
  `;
}

export function appendChatEntry(entry) {
  const container = document.getElementById("messagesContainer");
  if (!container || !entry) return;
  if (entry.id) {
    state.chatEntriesById.set(entry.id, entry);
  }

  const shouldGroup = Boolean(
    !entry.is_system &&
    !entry.reply_to &&
    lastRenderedMeta &&
    !lastRenderedMeta.is_system &&
    entry.peer_id &&
    lastRenderedMeta.peer_id === entry.peer_id &&
    lastRenderedMeta.username === entry.username &&
    Math.abs((entry.timestamp_ms || 0) - (lastRenderedMeta.timestamp_ms || 0)) <= 5 * 60 * 1000
  );

  const div = document.createElement("div");
  div.className = "msg" + (entry.is_system ? " system" : "") + (shouldGroup ? " msg-grouped" : "");
  if (entry.id) div.dataset.msgId = entry.id;
  div.dataset.grouped = shouldGroup ? "1" : "0";
  div.innerHTML = renderMessageInnerHtml(entry, shouldGroup);
  bindChatImages(div, entry);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;

  lastRenderedMeta = {
    peer_id: entry.peer_id || null,
    username: entry.username || "",
    timestamp_ms: entry.timestamp_ms || Date.now(),
    is_system: Boolean(entry.is_system),
  };
}

function findMessageElementById(msgId) {
  if (!msgId || typeof document === "undefined") return null;
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return document.querySelector(`.msg[data-msg-id="${CSS.escape(msgId)}"]`);
  }
  return (
    Array.from(document.querySelectorAll(".msg[data-msg-id]")).find(
      (el) => el.dataset.msgId === msgId
    ) || null
  );
}

export function updateChatEntryElement(entry) {
  if (!entry || !entry.id) return;
  state.chatEntriesById.set(entry.id, entry);
  const el = findMessageElementById(entry.id);
  if (!el) return;
  const grouped = el.dataset.grouped === "1" && !entry.reply_to;
  el.innerHTML = renderMessageInnerHtml(entry, grouped);
  bindChatImages(el, entry);
}

export function scrollToMessage(msgId) {
  if (!msgId) return;
  const el = findMessageElementById(msgId);
  if (!el) {
    showToast("Mensagem original não encontrada no histórico visível.", "info", 2200);
    return;
  }
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  const prevBg = el.style.background;
  el.style.background = "rgba(88, 101, 242, 0.24)";
  setTimeout(() => {
    el.style.background = prevBg;
  }, 1300);
}

export function startReplyTo(msgId) {
  const entry = state.chatEntriesById.get(msgId);
  if (!entry) return;
  state.editingMessageId = null;
  state.replyingTo = {
    id: entry.id,
    username: entry.username,
    snippet: isImageEntry(entry) ? "[imagem]" : String(entry.text || "").slice(0, 80),
  };
  const banner = document.getElementById("chatReplyBanner");
  const bannerText = document.getElementById("chatReplyBannerText");
  if (banner && bannerText) {
    bannerText.textContent = `Respondendo a ${entry.username}: ${state.replyingTo.snippet}`;
    banner.style.display = "flex";
  }
  document.getElementById("chatInput")?.focus();
}

export function startEditMessage(msgId) {
  const entry = state.chatEntriesById.get(msgId);
  if (!entry || entry.peer_id !== state.myPeerId || entry.deleted || isImageEntry(entry)) return;
  state.replyingTo = null;
  state.editingMessageId = msgId;
  const banner = document.getElementById("chatReplyBanner");
  const bannerText = document.getElementById("chatReplyBannerText");
  if (banner && bannerText) {
    bannerText.textContent = "Editando sua mensagem (Enter para salvar, × para cancelar)";
    banner.style.display = "flex";
  }
  const input = document.getElementById("chatInput");
  if (input) {
    input.value = entry.text || "";
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

export function cancelReplyTo() {
  const wasEditing = Boolean(state.editingMessageId);
  state.replyingTo = null;
  state.editingMessageId = null;
  const banner = document.getElementById("chatReplyBanner");
  if (banner) banner.style.display = "none";
  if (wasEditing) {
    const input = document.getElementById("chatInput");
    if (input) input.value = "";
  }
}

export function reactToMessage(msgId, emoji) {
  if (!msgId || !emoji) return;
  sendWs({ type: "react_chat_message", message_id: msgId, emoji });
}

export async function deleteChatMessage(msgId) {
  if (!msgId) return;
  const ok = await showConfirmModal({
    title: "Apagar mensagem",
    message: "Remover esta mensagem para todos na sala?",
    confirmText: "Apagar",
    danger: true,
  });
  if (!ok) return;
  sendWs({ type: "delete_chat_message", message_id: msgId });
}

export function handlePeerTyping(peerId, username, isTyping) {
  if (!peerId || peerId === state.myPeerId) return;
  if (isTyping) {
    state.typingPeers.set(peerId, {
      username: username || "Amigo",
      expiresAt: Date.now() + 4500,
    });
  } else {
    state.typingPeers.delete(peerId);
  }
  renderTypingIndicator();
}

export function renderTypingIndicator() {
  const el = document.getElementById("typingIndicator");
  if (!el) return;
  const now = Date.now();
  const names = [];
  for (const [pid, info] of state.typingPeers.entries()) {
    if (info.expiresAt <= now) {
      state.typingPeers.delete(pid);
    } else {
      names.push(info.username);
    }
  }
  if (names.length === 0) {
    el.textContent = "";
  } else if (names.length === 1) {
    el.textContent = `${names[0]} está digitando...`;
  } else if (names.length === 2) {
    el.textContent = `${names[0]} e ${names[1]} estão digitando...`;
  } else {
    el.textContent = `${names.length} pessoas estão digitando...`;
  }
}

function notifyTypingActivity(active) {
  const now = Date.now();
  if (!active) {
    if (stopTypingTimer) {
      clearTimeout(stopTypingTimer);
      stopTypingTimer = null;
    }
    if (lastTypingSentAt > 0) {
      lastTypingSentAt = 0;
      sendWs({ type: "typing", is_typing: false });
    }
    return;
  }

  if (now - lastTypingSentAt > 2000) {
    lastTypingSentAt = now;
    sendWs({ type: "typing", is_typing: true });
  }
  if (stopTypingTimer) clearTimeout(stopTypingTimer);
  stopTypingTimer = setTimeout(() => {
    lastTypingSentAt = 0;
    sendWs({ type: "typing", is_typing: false });
  }, 3000);
}

export function clearChatDom(history = []) {
  resetChatUiState();
  const container = document.getElementById("messagesContainer");
  if (!container) return;
  container.innerHTML = "";
  for (const entry of history) {
    appendChatEntry(entry);
  }
}

async function uploadMediaBlob(blob, filename) {
  const form = new FormData();
  form.append("file", blob, filename || "imagem.webp");
  const base = state.customServerOrigin ? `${state.customServerOrigin}/api/upload` : "/api/upload";
  const res = await fetch(`${base}?${buildMediaAuthQuery()}`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const json = await res.json();
  if (!json || typeof json.url !== "string" || !json.url.startsWith("/api/media/")) {
    throw new Error("Resposta de upload inválida");
  }
  return json.url;
}

export async function sendCompressedImageFile(file) {
  if (!file || !file.type || !file.type.startsWith("image/")) {
    showToast("Selecione um arquivo de imagem válido.", "warn");
    return;
  }

  // Preserva GIFs animados até ~3.8 MB via upload HTTP direto
  if (file.type === "image/gif" && file.size <= 3.8 * 1024 * 1024) {
    try {
      const mediaUrl = await uploadMediaBlob(file, file.name || "animacao.gif");
      sendWs({
        type: "chat_message",
        text: `[drocsid-media]${mediaUrl}`,
        reply_to_id: state.replyingTo ? state.replyingTo.id : null,
      });
      if (state.replyingTo) cancelReplyTo();
      return;
    } catch (_) {
      // Segue para fallback em canvas
    }
  }

  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = async () => {
    URL.revokeObjectURL(url);
    const maxSide = 1600;
    const scale = Math.min(1, maxSide / Math.max(img.width || 1, img.height || 1));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);

    try {
      const blob = await new Promise((resolve) =>
        c.toBlob((b) => (b ? resolve(b) : c.toBlob(resolve, "image/jpeg", 0.85)), "image/webp", 0.86)
      );
      if (blob && blob.size <= 3.8 * 1024 * 1024) {
        const mediaUrl = await uploadMediaBlob(blob, "imagem.webp");
        sendWs({
          type: "chat_message",
          text: `[drocsid-media]${mediaUrl}`,
          reply_to_id: state.replyingTo ? state.replyingTo.id : null,
        });
        if (state.replyingTo) cancelReplyTo();
        return;
      }
    } catch (_) {
      // Fallback para inline [drocsid-img] quando /api/upload não estiver disponível
    }

    let dataUrl = c.toDataURL("image/jpeg", 0.72);
    if (dataUrl.length > 190000) dataUrl = c.toDataURL("image/jpeg", 0.52);
    if (dataUrl.length > 190000) dataUrl = c.toDataURL("image/jpeg", 0.36);

    if (dataUrl.length > 190000) {
      showToast("A imagem ficou grande demais mesmo comprimida (limite ~190 KB neste modo).", "warn");
      return;
    }
    sendWs({
      type: "chat_message",
      text: `[drocsid-img]${dataUrl}`,
      reply_to_id: state.replyingTo ? state.replyingTo.id : null,
    });
    if (state.replyingTo) cancelReplyTo();
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    showToast("Não foi possível ler a imagem selecionada.", "error");
  };
  img.src = url;
}

export function triggerChatImagePicker() {
  document.getElementById("chatFileInput")?.click();
}

export function initChatPasteAndShortcuts() {
  const chatInput = document.getElementById("chatInput");
  if (chatInput) {
    chatInput.addEventListener("paste", (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type && item.type.startsWith("image/")) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (blob) sendCompressedImageFile(blob);
          break;
        }
      }
    });

    chatInput.addEventListener("input", () => {
      const hasVal = chatInput.value.trim().length > 0;
      notifyTypingActivity(hasVal && !state.editingMessageId);
    });

    let autoSwitchedForKeyboard = false;
    chatInput.addEventListener("focus", () => {
      if (isMobileDevice() && state.layoutViewMode === "split") {
        setTimeout(() => {
          if (document.activeElement === chatInput && window.innerHeight < 560) {
            autoSwitchedForKeyboard = true;
            hooks.setLayoutViewMode("chat");
          }
        }, 250);
      }
    });
    chatInput.addEventListener("blur", () => {
      if (autoSwitchedForKeyboard && state.layoutViewMode === "chat") {
        autoSwitchedForKeyboard = false;
        setTimeout(() => hooks.setLayoutViewMode("split"), 150);
      }
    });
  }

  const fileInput = document.getElementById("chatFileInput");
  if (fileInput && !fileInput.dataset.boundChange) {
    fileInput.dataset.boundChange = "1";
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      if (file) sendCompressedImageFile(file);
      fileInput.value = "";
    });
  }

  const chatContainer = document.getElementById("chatContainer");
  if (chatContainer && !chatContainer.dataset.boundDrop) {
    chatContainer.dataset.boundDrop = "1";
    chatContainer.addEventListener("dragover", (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
        e.preventDefault();
        chatContainer.style.outline = "2px dashed var(--brand)";
      }
    });
    chatContainer.addEventListener("dragleave", () => {
      chatContainer.style.outline = "";
    });
    chatContainer.addEventListener("drop", (e) => {
      chatContainer.style.outline = "";
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const imgFile = Array.from(files).find((f) => f.type && f.type.startsWith("image/"));
      if (imgFile) {
        e.preventDefault();
        sendCompressedImageFile(imgFile);
      }
    });
  }

  setInterval(renderTypingIndicator, 1500);

  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "m") {
        e.preventDefault();
        hooks.toggleMute();
      } else if (k === "d") {
        e.preventDefault();
        hooks.toggleDeaf();
      }
    }
  });
}

export function sendChatMessage(e) {
  e.preventDefault();
  const input = document.getElementById("chatInput");
  const text = input.value.trim();
  if (!text) return;

  notifyTypingActivity(false);

  if (state.editingMessageId) {
    sendWs({
      type: "edit_chat_message",
      message_id: state.editingMessageId,
      text,
    });
    cancelReplyTo();
    input.value = "";
    return;
  }

  const replyToId = state.replyingTo ? state.replyingTo.id : null;
  sendWs({
    type: "chat_message",
    text,
    reply_to_id: replyToId,
  });
  if (state.replyingTo) cancelReplyTo();
  input.value = "";
}
