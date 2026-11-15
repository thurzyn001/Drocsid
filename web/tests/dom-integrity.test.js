// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const rootDir = path.resolve(__dirname, "..", "..");
const uiHtmlPath = path.join(rootDir, "src", "ui.html");

describe("integridade de src/ui.html", () => {
  it("contém HTML, CSS e JS válidos e expõe todos os handlers inline", () => {
    const html = fs.readFileSync(uiHtmlPath, "utf8");
    const doc = new DOMParser().parseFromString(html, "text/html");

    const scriptEl = doc.querySelector("script");
    expect(scriptEl).not.toBeNull();
    expect(() => new Function(scriptEl.textContent)).not.toThrow();

    const expectedIds = [
      "sidebar",
      "roomList",
      "peerList",
      "usernameInput",
      "btnVoice",
      "btnMute",
      "btnDeaf",
      "btnGoLive",
      "stageVideo",
      "stageCanvas",
      "stageGrid",
      "messagesContainer",
      "chatInput",
      "goLiveModal",
      "joinRemoteModal",
      "turnModal",
      "audioSettingsModal",
      "btnThemeToggle",
      "btnDensityToggle",
      "versionMismatchBadge",
      "inviteQrWrap",
      "btnToggleQr",
      "btnStopTunnel",
      "btnPiP",
      "typingIndicator",
      "chatReplyBanner",
      "chatFileInput",
      "btnAttachImage",
      "shareTurnRow",
      "shareTurnCheckbox",
      "toastContainer",
      "dialogModal",
      "lightboxModal",
    ];
    for (const id of expectedIds) {
      expect(doc.getElementById(id), `ID ausente no DOM: ${id}`).not.toBeNull();
    }

    const scriptBody = scriptEl.textContent;
    const handlerRe = /\son(?:click|input|change|submit)="([a-zA-Z0-9_$]+)\(/g;
    let match;
    const handlers = new Set();
    while ((match = handlerRe.exec(html)) !== null) {
      handlers.add(match[1]);
    }
    expect(handlers.size).toBeGreaterThan(20);
    for (const fn of handlers) {
      expect(scriptBody.includes(fn), `Handler ausente no bundle: ${fn}`).toBe(true);
    }
  });
});
