import { describe, it, expect, vi } from "vitest";

vi.mock("../src/rnnoise-loader.js", () => ({
  createRnnoiseNode: vi.fn(async () => null),
}));
vi.mock("../src/voice-worklet.js", () => ({
  VOICE_CAPTURE_WORKLET_CODE: "",
  registerVoiceCaptureWorklet: vi.fn(async () => false),
}));

import { codeToWin32Vk, rmsToVuPercent } from "../src/voice.js";
import { canUseOpusAudioRelay } from "../src/audio-codec.js";
import { canUseVp8VideoRelay } from "../src/screenshare.js";
import { state } from "../src/state.js";

describe("Etapa 3: PTT Global, VU Meter e Negociação de Codecs", () => {
  it("mapeia teclas comuns para Win32 Virtual-Key codes", () => {
    expect(codeToWin32Vk("KeyV")).toBe(0x56);
    expect(codeToWin32Vk("Space")).toBe(0x20);
    expect(codeToWin32Vk("F9")).toBe(0x78);
    expect(codeToWin32Vk("ShiftLeft")).toBe(0x10);
  });

  it("converte RMS em porcentagem de VU meter dentro de [0, 100]", () => {
    expect(rmsToVuPercent(0)).toBe(0);
    expect(rmsToVuPercent(0.015)).toBeGreaterThan(20);
    expect(rmsToVuPercent(0.5)).toBe(100);
  });

  it("desativa V2 quando qualquer peer na sala não anuncia suporte", () => {
    const prevCaps = state.clientCaps;
    const prevMyId = state.myPeerId;
    const prevPeers = new Map(state.peers);

    state.myPeerId = "me";
    state.clientCaps = { opus_relay: true, vp8_relay: true, h264_relay: false };
    state.peers.clear();
    state.peers.set("me", { peer_id: "me", caps: state.clientCaps });
    state.peers.set("ios", { peer_id: "ios", caps: { opus_relay: false, vp8_relay: false, h264_relay: false } });

    expect(canUseOpusAudioRelay()).toBe(false);
    expect(canUseVp8VideoRelay()).toBe(false);

    state.clientCaps = prevCaps;
    state.myPeerId = prevMyId;
    state.peers = prevPeers;
  });
});
