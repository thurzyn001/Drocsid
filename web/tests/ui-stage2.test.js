// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("../src/rnnoise-loader.js", () => ({
  createRnnoiseNode: vi.fn(async () => null),
}));
vi.mock("../src/voice-worklet.js", () => ({
  VOICE_CAPTURE_WORKLET_CODE: "",
  registerVoiceCaptureWorklet: vi.fn(async () => false),
}));

import { state } from "../src/state.js";
import { renderMarkdownSafe, appendChatEntry, updateChatEntryElement } from "../src/chat.js";
import { renderRooms, toggleRoomExpand, setTheme, toggleTheme, toggleDensity, applyAppearancePreferences } from "../src/sidebar.js";
import {
  showToast,
  showConfirmModal,
  showPromptModal,
  resolveDialogModal,
  renderLucideIcons,
  toggleOptionsMenu,
  openSettingsModal,
  selectSettingsTab,
} from "../src/ui-feedback.js";
import { toggleEngineHelp, updateGoLiveButtonState } from "../src/screenshare.js";
import { toggleDeaf, refreshMuteButtonUi } from "../src/voice.js";
import { toggleNetworkCard } from "../src/invite.js";
import { togglePinGridPeer, updateStageView, toggleSidebarPanel, togglePiP, setSelfPreviewEnabled } from "../src/stage.js";

const uiHtmlPath = path.resolve(__dirname, "..", "..", "src", "ui.html");

function loadHtmlFixture() {
  const html = fs.readFileSync(uiHtmlPath, "utf8");
  document.documentElement.innerHTML = html;
}

describe("Etapa 2: Markdown seguro, salas, modais, toasts e Grid incremental", () => {
  beforeEach(() => {
    loadHtmlFixture();
    localStorage.clear();
    state.peers.clear();
    state.roomSummaries.clear();
    state.expandedRooms = new Set();
    state.sidebarCollapsed = false;
    state.knownRooms = ["geral", "jogos"];
    state.currentRoom = "geral";
    state.theme = "dark";
    state.density = "cozy";
    state.gridMode = false;
    state.pinnedGridPeerId = null;
    state.pipActive = false;
    state.pipProxyVideoEl = null;
    state.pipOwnsProxyTracks = false;
    state.pipNativeCanvasEl = null;
    state.pipNativeMode = false;
    state.pipStreamMode = null;
    state.myScreenShareMode = null;
    state.localCaptureSurface = "";
    state.localDisplayStream = null;
    state.selfPreviewEnabled = false;
    state.watchedStreamerId = null;
    state.myPeerId = "me";
    document.body.classList.remove("sidebar-collapsed");
  });

  it("renderMarkdownSafe renderiza GFM com segurança e neutraliza XSS", () => {
    const out = renderMarkdownSafe(
      '**negrito** `código` https://example.com [evil](javascript:alert(1)) <script>alert(1)</script> <img src="x" onerror="alert(2)">'
    );
    expect(out).toContain("<strong>negrito</strong>");
    expect(out).toContain("<code>código</code>");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out.toLowerCase()).not.toContain("<script");
    expect(out.toLowerCase()).not.toContain("<img");
    expect(out.toLowerCase()).not.toContain("javascript:");
    const parsed = new DOMParser().parseFromString(out, "text/html");
    expect(parsed.querySelectorAll("script, img, [onerror]").length).toBe(0);
    expect(parsed.body.textContent).toContain("<script>alert(1)</script>");
  });

  it("renderLucideIcons converte placeholders em SVGs offline", () => {
    renderLucideIcons(document);
    expect(document.querySelectorAll("svg.lucide").length).toBeGreaterThan(5);
  });

  it("renderRooms exibe badges e permite expandir cada sala para ver participantes", () => {
    state.roomSummaries.set("geral", {
      name: "geral",
      peer_count: 3,
      voice_count: 2,
      live_count: 1,
      locked: false,
      peers: [
        { username: "Arthur", is_host: true, in_voice: true, is_live: true },
        { username: "Bia", is_host: false, in_voice: true, self_mute: true, is_live: false },
      ],
    });
    renderRooms();
    const listEl = document.getElementById("roomList");
    expect(listEl.textContent).toContain("#geral");
    expect(listEl.textContent).toContain("AO VIVO");
    expect(listEl.textContent).toContain("2");
    expect(listEl.textContent).not.toContain("Arthur");

    toggleRoomExpand("geral", true);
    expect(listEl.textContent).toContain("Arthur");
    expect(listEl.textContent).toContain("Bia");
    expect(state.currentRoom).toBe("geral");

    toggleRoomExpand("jogos", true);
    expect(listEl.textContent).toContain("Ninguém na sala");
  });

  it("toggleSidebarPanel recolhe e reabre a barra lateral no desktop", () => {
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    toggleSidebarPanel(false);
    expect(state.sidebarCollapsed).toBe(true);
    expect(document.getElementById("sidebar").classList.contains("collapsed")).toBe(true);
    expect(document.body.classList.contains("sidebar-collapsed")).toBe(true);

    toggleSidebarPanel();
    expect(state.sidebarCollapsed).toBe(false);
    expect(document.getElementById("sidebar").classList.contains("collapsed")).toBe(false);
    expect(document.body.classList.contains("sidebar-collapsed")).toBe(false);
  });

  it("togglePiP funciona mesmo com prévia da própria tela oculta e não é quebrado ao alternar Prévia", async () => {
    const fakeTrackStop = vi.fn();
    const fakeStream = { id: "stream-own", getVideoTracks: () => [{ getSettings: () => ({ width: 1280, height: 720 }) }], getTracks: () => [{ stop: fakeTrackStop }] };
    state.myScreenShareMode = "web_rtc";
    state.localCaptureSurface = "monitor";
    state.localDisplayStream = fakeStream;
    state.selfPreviewEnabled = false;
    state.watchedStreamerId = "me";
    state.remoteVideoStreams.set("me", fakeStream);
    state.peers.set("me", {
      peer_id: "me",
      username: "Você",
      screen_share: { mode: "web_rtc", width: 1280, height: 720, fps: 30 },
    });

    const stageVideo = document.getElementById("stageVideo");
    const stageCanvas = document.getElementById("stageCanvas");
    stageCanvas.getContext = vi.fn(() => ({ clearRect: vi.fn() }));
    stageVideo.play = vi.fn().mockResolvedValue(undefined);
    const createOrig = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag) => {
      const el = createOrig(tag);
      if (tag === "video") {
        el.play = vi.fn().mockResolvedValue(undefined);
        el.requestPictureInPicture = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(el, "readyState", { value: 2, configurable: true });
      }
      return el;
    });

    updateStageView();
    await togglePiP();
    expect(state.pipActive).toBe(true);
    expect(state.pipOwnsProxyTracks).toBe(false);
    expect(stageVideo.srcObject).toBeNull();

    setSelfPreviewEnabled(true);
    expect(stageVideo.srcObject).toBe(fakeStream);
    expect(state.pipActive).toBe(true);

    setSelfPreviewEnabled(false);
    expect(stageVideo.srcObject).toBeNull();
    expect(state.pipActive).toBe(true);
    expect(fakeTrackStop).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it("toggleTheme e toggleDensity persistem preferências em html/body dataset e localStorage", () => {
    applyAppearancePreferences();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.body.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.density).toBe("cozy");
    expect(document.body.dataset.density).toBe("cozy");

    toggleTheme();
    expect(state.theme).toBe("amoled");
    expect(document.documentElement.dataset.theme).toBe("amoled");
    expect(document.body.dataset.theme).toBe("amoled");
    expect(localStorage.getItem("drocsid_theme")).toBe("amoled");

    setTheme("light", false);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.body.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");

    toggleDensity();
    expect(state.density).toBe("compact");
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(document.body.dataset.density).toBe("compact");
  });

  it("Menus de Opções/Configurações, cards explicativos sob demanda e rótulos pt-BR funcionam sem poluição", () => {
    toggleOptionsMenu(true);
    expect(document.getElementById("optionsPopover").classList.contains("open")).toBe(true);

    openSettingsModal("network");
    expect(document.getElementById("optionsPopover").classList.contains("open")).toBe(false);
    expect(document.getElementById("settingsModal").classList.contains("open")).toBe(true);
    expect(document.querySelector('[data-settings-panel="network"]').classList.contains("active")).toBe(true);

    selectSettingsTab("appearance");
    expect(document.querySelector('[data-settings-panel="appearance"]').classList.contains("active")).toBe(true);

    expect(document.getElementById("modeHelpWebRtc").classList.contains("open")).toBe(false);
    toggleEngineHelp("web_rtc");
    expect(document.getElementById("modeHelpWebRtc").classList.contains("open")).toBe(true);
    expect(document.getElementById("modeHelpRelay").classList.contains("open")).toBe(false);

    toggleNetworkCard(true);
    expect(document.getElementById("networkDetailsWrap").classList.contains("open")).toBe(true);

    state.selfDeaf = false;
    toggleDeaf();
    expect(document.getElementById("btnDeaf").textContent).toBe("🙉 Som Desativado");
    toggleDeaf();
    expect(document.getElementById("btnDeaf").textContent).toBe("🎧 Sem Áudio");

    state.selfMute = false;
    refreshMuteButtonUi();
    expect(document.getElementById("mBtnMute").textContent).toBe("🎤 Mutar");

    updateGoLiveButtonState(false);
    expect(document.getElementById("btnGoLive").textContent).toBe("🖥️ Transmitir Tela");
    expect(document.getElementById("mBtnGoLive").textContent).toBe("🖥️ Tela");
  });

  it("showToast e modais assíncronos funcionam sem bloquear a thread", async () => {
    showToast("Convite copiado", "success", 0);
    expect(document.querySelectorAll("#toastContainer .toast").length).toBe(1);

    const confirmPromise = showConfirmModal({ title: "Teste", message: "Confirmar?" });
    expect(document.getElementById("dialogModal").classList.contains("open")).toBe(true);
    resolveDialogModal(true);
    expect(await confirmPromise).toBe(true);

    const promptPromise = showPromptModal({ title: "Sala", message: "Nome:", defaultValue: "squad" });
    document.getElementById("dialogPromptInput").value = "rpg";
    resolveDialogModal(true);
    expect(await promptPromise).toBe("rpg");
  });

  it("appendChatEntry agrupa mensagens consecutivas e updateChatEntryElement atualiza reações/edição", () => {
    const baseTs = 1700000000000;
    appendChatEntry({
      id: "m1",
      peer_id: "p1",
      username: "Alice",
      text: "oi **pessoal**",
      timestamp_ms: baseTs,
      is_system: false,
    });
    appendChatEntry({
      id: "m2",
      peer_id: "p1",
      username: "Alice",
      text: "tudo bem?",
      timestamp_ms: baseTs + 30000,
      is_system: false,
    });
    const msgs = document.querySelectorAll("#messagesContainer .msg");
    expect(msgs.length).toBe(2);
    expect(msgs[0].classList.contains("msg-grouped")).toBe(false);
    expect(msgs[1].classList.contains("msg-grouped")).toBe(true);

    updateChatEntryElement({
      id: "m1",
      peer_id: "p1",
      username: "Alice",
      text: "oi **editado**",
      timestamp_ms: baseTs,
      edited_at_ms: baseTs + 5000,
      reactions: { "👍": ["p1"] },
      is_system: false,
    });
    expect(msgs[0].textContent).toContain("(editada)");
    expect(msgs[0].textContent).toContain("👍");
  });

  it("Grid 2x2 reconcilia tiles incrementalmente sem destruir canvases existentes e suporta Pin 1+N", () => {
    state.gridMode = true;
    state.peers.set("p1", {
      peer_id: "p1",
      username: "Alice",
      screen_share: { mode: "universal_relay", source_id: "s1", source_name: "Tela", width: 1280, height: 720, fps: 15 },
    });
    state.peers.set("p2", {
      peer_id: "p2",
      username: "Bob",
      screen_share: { mode: "native_host", source_id: "s2", source_name: "Monitor", width: 1920, height: 1080, fps: 30 },
    });

    updateStageView();
    const firstCanvas = document.getElementById("grid-canvas-p1");
    expect(firstCanvas).not.toBeNull();

    // Segunda atualização: não deve recriar o nó DOM <canvas id="grid-canvas-p1">
    updateStageView();
    expect(document.getElementById("grid-canvas-p1")).toBe(firstCanvas);

    togglePinGridPeer("p2");
    const grid = document.getElementById("stageGrid");
    expect(grid.classList.contains("has-pin")).toBe(true);
    expect(grid.firstElementChild.dataset.peerId).toBe("p2");
    expect(grid.firstElementChild.classList.contains("pinned")).toBe(true);
  });
});
