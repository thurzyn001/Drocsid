// Barra lateral: salas com indicadores, aparência (tema/densidade), perfil e participantes

import { state, escapeHtml, peerAvatarColor, sendWs } from "./state.js";
import { isWebRtcP2pAudioReceiving, shouldTransmitVoiceRelay } from "./audio-codec.js";
import { showToast, showConfirmModal, showPromptModal, renderLucideIcons } from "./ui-feedback.js";

let hooks = {
  toggleMobileSidebar: () => {},
  stopScreenShare: () => {},
  closePeerConnection: () => {},
  renderWebcamStrip: () => {},
};

export function registerSidebarHooks(h) {
  hooks = { ...hooks, ...h };
}

export function applyAppearancePreferences() {
  if (typeof document === "undefined") return;
  const theme = ["dark", "amoled", "light"].includes(state.theme) ? state.theme : "dark";
  const density = state.density === "compact" ? "compact" : "cozy";
  state.theme = theme;
  state.density = density;

  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.density = density;
  document.documentElement.style.colorScheme = theme === "light" ? "light" : "dark";
  if (document.body) {
    document.body.dataset.theme = theme;
    document.body.dataset.density = density;
  }

  document.querySelectorAll("[data-theme-choice]").forEach((el) => {
    el.classList.toggle("active", el.dataset.themeChoice === theme);
  });

  document.querySelectorAll("[data-density-choice]").forEach((el) => {
    el.classList.toggle("active", el.dataset.densityChoice === density);
  });

  const techCb = document.getElementById("showTechDetailsCheckbox");
  if (techCb) techCb.checked = Boolean(state.showTechDetails);
}

export function setTheme(nextTheme, notify = true) {
  const valid = ["dark", "amoled", "light"].includes(nextTheme) ? nextTheme : "dark";
  state.theme = valid;
  try { localStorage.setItem("drocsid_theme", state.theme); } catch (_) {}
  applyAppearancePreferences();
  if (notify) {
    const labels = { dark: "Escuro Padrão", amoled: "Preto AMOLED", light: "Claro Suave" };
    showToast(`Tema: ${labels[state.theme]}`, "info", 1800);
  }
}

export function toggleTheme() {
  const order = ["dark", "amoled", "light"];
  const idx = order.indexOf(state.theme);
  setTheme(order[(idx + 1) % order.length], true);
}

export function setDensity(nextDensity, notify = true) {
  state.density = nextDensity === "compact" ? "compact" : "cozy";
  try { localStorage.setItem("drocsid_density", state.density); } catch (_) {}
  applyAppearancePreferences();
  if (notify) {
    showToast(`Espaçamento: ${state.density === "compact" ? "Compacto" : "Confortável"}`, "info", 1800);
  }
}

export function toggleDensity() {
  setDensity(state.density === "compact" ? "cozy" : "compact", true);
}

export function toggleShowTechDetails(force) {
  state.showTechDetails = typeof force === "boolean" ? force : !state.showTechDetails;
  try { localStorage.setItem("drocsid_show_tech", state.showTechDetails ? "true" : "false"); } catch (_) {}
  applyAppearancePreferences();
}

export function toggleRoomExpand(room, force) {
  if (!room) return;
  const open = typeof force === "boolean" ? force : !state.expandedRooms.has(room);
  if (open) {
    state.expandedRooms.add(room);
  } else {
    state.expandedRooms.delete(room);
  }
  renderRooms();
}

export function renderRooms() {
  const list = document.getElementById("roomList");
  if (!list) return;
  list.innerHTML = "";
  const iAmHost = state.isHost || Boolean(state.peers.get(state.myPeerId)?.is_host);
  for (const room of state.knownRooms) {
    const summary = state.roomSummaries?.get(room) || {
      peer_count: 0,
      voice_count: 0,
      live_count: 0,
      locked: false,
      peers: [],
    };
    const isExpanded = state.expandedRooms?.has(room);
    const roomPeers = Array.isArray(summary.peers) ? summary.peers : [];
    const badges = [];
    if (summary.locked) {
      badges.push(`<span class="room-badge-count" title="Sala trancada">🔒</span>`);
    }
    if (summary.live_count > 0) {
      badges.push(`<span class="room-badge-live" title="${summary.live_count} transmitindo">AO VIVO</span>`);
    }
    if (summary.voice_count > 0) {
      badges.push(`<span class="room-badge-voice" title="${summary.voice_count} em chamada">🎙️ ${summary.voice_count}</span>`);
    } else if (summary.peer_count > 0) {
      badges.push(`<span class="room-badge-count" title="${summary.peer_count} na sala">${summary.peer_count}</span>`);
    }

    const group = document.createElement("div");
    group.className = "room-group";

    const row = document.createElement("div");
    row.className = "room-row";

    const expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "btn room-expand-btn" + (isExpanded ? " expanded" : "");
    expandBtn.setAttribute("aria-expanded", isExpanded ? "true" : "false");
    expandBtn.title = isExpanded ? `Recolher pessoas de #${room}` : `Ver quem está em #${room}`;
    expandBtn.innerHTML = `<i data-lucide="${isExpanded ? "chevron-down" : "chevron-right"}"></i>`;
    expandBtn.onclick = (e) => {
      e.stopPropagation();
      toggleRoomExpand(room);
    };
    row.appendChild(expandBtn);

    const btn = document.createElement("button");
    btn.className = "room-btn" + (room === state.currentRoom ? " active" : "");
    btn.innerHTML = `<span class="room-name-wrap"><span>🔊</span> <span>#${escapeHtml(room)}</span></span><span class="room-badges">${badges.join("")}</span>`;
    btn.onclick = () => switchRoom(room);
    row.appendChild(btn);

    if (iAmHost && room !== "geral") {
      const hostActions = document.createElement("div");
      hostActions.className = "room-host-actions";

      const lockBtn = document.createElement("button");
      lockBtn.type = "button";
      lockBtn.className = "btn room-mini-btn";
      lockBtn.textContent = summary.locked ? "🔓" : "🔒";
      lockBtn.title = summary.locked ? `Destrancar #${room}` : `Trancar #${room} (exigir aprovação)`;
      lockBtn.onclick = (e) => {
        e.stopPropagation();
        toggleRoomLock(room);
      };
      hostActions.appendChild(lockBtn);

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn room-mini-btn";
      delBtn.textContent = "🗑️";
      delBtn.title = `Excluir sala #${room}`;
      delBtn.onclick = (e) => {
        e.stopPropagation();
        deleteRoom(room);
      };
      hostActions.appendChild(delBtn);

      row.appendChild(hostActions);
    }

    group.appendChild(row);

    if (isExpanded) {
      const membersWrap = document.createElement("div");
      membersWrap.className = "room-members-sublist";
      if (roomPeers.length === 0) {
        const emptyRow = document.createElement("div");
        emptyRow.className = "room-member-empty";
        emptyRow.textContent = "Ninguém na sala";
        membersWrap.appendChild(emptyRow);
      } else {
        for (const rp of roomPeers) {
          const item = document.createElement("div");
          item.className = "room-member-item";
          const initials = (rp.username || "A").slice(0, 2).toUpperCase();
          const statusTags = [];
          if (rp.is_host) statusTags.push(`<span title="Anfitrião">👑</span>`);
          if (rp.is_live) statusTags.push(`<span class="room-member-live">AO VIVO</span>`);
          if (rp.in_voice) {
            if (rp.server_muted || rp.self_mute) {
              statusTags.push(`<span title="Mutado">🔇</span>`);
            } else {
              statusTags.push(`<span title="Na voz">🎙️</span>`);
            }
          }
          if (rp.self_deaf) statusTags.push(`<span title="Sem áudio">🙉</span>`);
          item.innerHTML = `
            <span class="room-member-left">
              <span class="room-member-dot">${escapeHtml(initials)}</span>
              <span class="room-member-name">${escapeHtml(rp.username)}</span>
            </span>
            <span class="room-member-status">${statusTags.join("")}</span>
          `;
          membersWrap.appendChild(item);
        }
      }
      group.appendChild(membersWrap);
    }

    list.appendChild(group);
  }
  renderLucideIcons(list);
}

export function switchRoom(room, force = false) {
  if (room === state.currentRoom && !force) {
    hooks.toggleMobileSidebar(false);
    return;
  }
  const summary = state.roomSummaries?.get(room);
  const iAmHost = state.isHost || Boolean(state.peers.get(state.myPeerId)?.is_host);
  if (!force && !iAmHost && summary?.locked) {
    hooks.toggleMobileSidebar(false);
    sendWs({
      type: "join_room",
      username: document.getElementById("usernameInput").value.trim(),
      room,
    });
    return;
  }
  if (state.myScreenShareMode) {
    hooks.stopScreenShare();
  }
  for (const peerId of Array.from(state.peerConnections.keys())) {
    hooks.closePeerConnection(peerId);
  }
  state.watchedStreamerId = null;
  state.pinnedGridPeerId = null;
  state.currentRoom = room;
  document.getElementById("currentRoomLabel").textContent = "#" + room;
  renderRooms();
  hooks.toggleMobileSidebar(false);
  sendWs({
    type: "join_room",
    username: document.getElementById("usernameInput").value.trim(),
    room: state.currentRoom
  });
}

export async function promptNewRoom() {
  const name = await showPromptModal({
    title: "Nova Sala",
    message: "Digite o nome da nova sala (ex: squad, filmes):",
    placeholder: "squad",
    confirmText: "Criar Sala",
  });
  if (!name) return;
  const clean = name.trim().toLowerCase().replace(/\s+/g, "-");
  if (!clean) return;
  if (!state.knownRooms.includes(clean)) state.knownRooms.push(clean);
  renderRooms();
  switchRoom(clean);
}

export function updateProfile() {
  const name = document.getElementById("usernameInput").value.trim();
  if (name) {
    localStorage.setItem("drocsid_username", name);
    sendWs({
      type: "set_username",
      username: name
    });
  }
}

export function syncMyUsernameInput() {
  const me = state.peers.get(state.myPeerId);
  const input = document.getElementById("usernameInput");
  if (me && input && document.activeElement !== input) {
    input.value = me.username;
  }
}

export async function kickPeer(peerId) {
  const target = state.peers.get(peerId);
  const label = target ? target.username : peerId;
  const ok = await showConfirmModal({
    title: "Expulsar participante",
    message: `Expulsar ${label} da sala agora?`,
    confirmText: "Expulsar",
    danger: true,
  });
  if (!ok) return;
  sendWs({ type: "kick_peer", target_id: peerId, ban: false });
}

export async function banPeer(peerId) {
  const target = state.peers.get(peerId);
  const label = target ? target.username : peerId;
  const ok = await showConfirmModal({
    title: "Banir participante da sessão",
    message: `Expulsar e bloquear ${label} (IP/sessão) até reiniciar ou limpar a lista de banidos?`,
    confirmText: "Banir",
    danger: true,
  });
  if (!ok) return;
  sendWs({ type: "kick_peer", target_id: peerId, ban: true });
}

export function togglePeerServerMute(peerId, muted) {
  sendWs({ type: "set_peer_server_mute", target_id: peerId, muted: Boolean(muted) });
}

export function toggleRoomLock(room) {
  if (!room || room === "geral") return;
  sendWs({ type: "toggle_room_lock", room });
}

export async function deleteRoom(room) {
  if (!room || room === "geral") return;
  const ok = await showConfirmModal({
    title: "Excluir sala",
    message: `Excluir a sala #${room}? Participantes nela serão movidos para #geral e o histórico da sala será removido.`,
    confirmText: "Excluir",
    danger: true,
  });
  if (!ok) return;
  sendWs({ type: "delete_room", room });
}

export async function clearCurrentRoomChat() {
  const room = state.currentRoom || "geral";
  const ok = await showConfirmModal({
    title: "Limpar histórico do chat",
    message: `Apagar todas as mensagens da sala #${room} para todos os participantes?`,
    confirmText: "Limpar Chat",
    danger: true,
  });
  if (!ok) return;
  sendWs({ type: "clear_chat", room });
}

export async function unbanAllPeers() {
  const ok = await showConfirmModal({
    title: "Limpar lista de banidos",
    message: "Remover todos os banimentos ativos desta sessão?",
    confirmText: "Desbanir Todos",
  });
  if (!ok) return;
  sendWs({ type: "unban_all" });
}

export function resolveJoinApproval(targetId, room, approve) {
  state.pendingJoinApprovals = (state.pendingJoinApprovals || []).filter(
    (req) => !(req.peer_id === targetId && req.room === room)
  );
  renderJoinApprovalBanner();
  sendWs({
    type: "resolve_join_approval",
    target_id: targetId,
    room,
    approve: Boolean(approve),
  });
}

export function renderJoinApprovalBanner() {
  if (typeof document === "undefined") return;
  const banner = document.getElementById("approvalBanner");
  if (!banner) return;
  const list = state.pendingJoinApprovals || [];
  if (list.length === 0) {
    banner.style.display = "none";
    banner.innerHTML = "";
    return;
  }
  const req = list[0];
  const extra = list.length > 1 ? ` (+${list.length - 1} pendente)` : "";
  banner.style.display = "flex";
  banner.innerHTML = `
    <span>🔒 <strong>${escapeHtml(req.username)}</strong> pediu para entrar em <strong>#${escapeHtml(req.room)}</strong>${extra}</span>
    <span style="display:flex; gap:6px; flex-shrink:0;">
      <button type="button" class="btn active-green" style="padding:3px 9px; font-size:12px;" onclick="resolveJoinApproval('${escapeHtml(req.peer_id)}','${escapeHtml(req.room)}',true)">✅ Aprovar</button>
      <button type="button" class="btn active-red" style="padding:3px 9px; font-size:12px;" onclick="resolveJoinApproval('${escapeHtml(req.peer_id)}','${escapeHtml(req.room)}',false)">❌ Recusar</button>
    </span>
  `;
}

export function renderPeers() {
  const list = document.getElementById("peerList");
  list.innerHTML = "";
  document.getElementById("peerCount").textContent = state.peers.size;
  const iAmHost = state.isHost || Boolean(state.peers.get(state.myPeerId)?.is_host);

  for (const peer of state.peers.values()) {
    const item = document.createElement("div");
    item.className = "peer-item";

    const initials = (peer.username || "A").slice(0, 2).toUpperCase();
    const speakingClass = peer.speaking ? " speaking" : "";
    const isMe = peer.peer_id === state.myPeerId ? " (você)" : "";
    const avatarBg = peerAvatarColor(peer.peer_id);

    let badgesHtml = "";
    if (peer.is_host) {
      badgesHtml += `<span class="status-icon" title="Anfitrião da Sala">👑</span>`;
    }
    if (peer.screen_share) {
      badgesHtml += `<button class="live-pill" onclick="selectWatchedStreamer('${peer.peer_id}')" title="Assistir transmissão de ${escapeHtml(peer.username)}">AO VIVO</button>`;
    }
    if (peer.in_voice && !peer.self_mute && !peer.self_deaf && !peer.server_muted) {
      badgesHtml += `<span class="status-icon" title="Na chamada de voz">🎙️</span>`;
    }
    if (peer.server_muted) {
      badgesHtml += `<span class="status-icon" title="Silenciado pelo anfitrião">🔇🔒</span>`;
    } else if (peer.self_mute) {
      badgesHtml += `<span class="status-icon" title="Mutado">🔇</span>`;
    }
    if (peer.self_deaf) {
      badgesHtml += `<span class="status-icon" title="Áudio desativado">🙉</span>`;
    }
    if (peer.peer_id !== state.myPeerId) {
      if (peer.in_voice || state.voiceEnabled) {
        const pc = state.peerConnections.get(peer.peer_id);
        const ice = pc ? pc.iceConnectionState : "new";
        const inboundRelay = state.voiceRelayInboundPeers.has(peer.peer_id);
        if (!state.forceVoiceRelay && isWebRtcP2pAudioReceiving(peer.peer_id) && !inboundRelay) {
          badgesHtml += `<span class="status-icon" style="color:var(--green);font-size:10px;font-weight:700;" title="Voz em conexão direta com menor atraso">Direto</span>`;
        } else if (state.forceVoiceRelay || peer.voice_relay || inboundRelay || (state.voiceEnabled && shouldTransmitVoiceRelay())) {
          badgesHtml += `<span class="status-icon" style="color:var(--brand);font-size:10px;font-weight:700;" title="Voz pelo modo compatível (túnel da sala)">Túnel</span>`;
        } else if (ice === "failed" || ice === "disconnected") {
          badgesHtml += `<span class="status-icon" style="color:var(--yellow);font-size:10px;font-weight:700;" title="Rede restrita detectada — alternando para o modo compatível">Rede</span>`;
        } else {
          badgesHtml += `<span class="status-icon" style="color:var(--text-muted);font-size:10px;" title="Conectando rota de áudio (${escapeHtml(ice)})">...</span>`;
        }
      }
      const curPeerVol = state.peerVolumes.has(peer.peer_id) ? state.peerVolumes.get(peer.peer_id) : 100;
      badgesHtml += `<input type="range" min="0" max="100" value="${curPeerVol}" style="width: 48px; accent-color: var(--brand); cursor: pointer;" title="Volume de ${escapeHtml(peer.username)}" oninput="setPeerVolume('${peer.peer_id}', this.value)" />`;
      if (iAmHost) {
        const nextMuted = !peer.server_muted;
        const muteIcon = peer.server_muted ? "🎙️" : "🔇";
        const muteTitle = peer.server_muted
          ? `Liberar microfone de ${escapeHtml(peer.username)}`
          : `Silenciar ${escapeHtml(peer.username)} no servidor`;
        badgesHtml += `<button class="btn" style="padding: 2px 5px; font-size: 11px;" onclick="togglePeerServerMute('${peer.peer_id}', ${nextMuted})" title="${muteTitle}">${muteIcon}</button>`;
        badgesHtml += `<button class="btn" style="padding: 2px 5px; font-size: 11px;" onclick="kickPeer('${peer.peer_id}')" title="Expulsar ${escapeHtml(peer.username)}">🚫</button>`;
        badgesHtml += `<button class="btn" style="padding: 2px 5px; font-size: 11px;" onclick="banPeer('${peer.peer_id}')" title="Banir ${escapeHtml(peer.username)} da sessão">⛔</button>`;
      }
    }

    item.innerHTML = `
      <div class="peer-left">
        <div class="avatar${speakingClass}" style="background: ${avatarBg};">${escapeHtml(initials)}</div>
        <span class="peer-name">${escapeHtml(peer.username)}${isMe}</span>
      </div>
      <div class="peer-badges">${badgesHtml}</div>
    `;
    list.appendChild(item);
  }
  hooks.renderWebcamStrip();
}
