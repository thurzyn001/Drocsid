import { describe, it, expect } from "vitest";
import {
  MULAW_DECODE_TABLE,
  VIDEO_CODEC_VP8,
  VIDEO_CODEC_H264,
  linearToMulaw,
  formatUuidBytes,
  buildClientBinaryFrame,
  buildClientBinaryAudioFrame,
  parseServerBinaryVideoHeader,
  parseServerBinaryAudioHeader,
  buildClientBinaryVideoV2Frame,
  parseServerBinaryVideoV2Header,
  buildClientBinaryAudioV2Frame,
  parseServerBinaryAudioV2Header,
} from "../src/protocol.js";
import { updateJitterEstimate, downsampleToMuLaw16k } from "../src/audio-codec.js";

describe("protocolo binário e codec μ-law", () => {
  it("formata UUID de 16 bytes corretamente", () => {
    const bytes = new Uint8Array([
      0x12, 0x34, 0x56, 0x78,
      0x9a, 0xbc, 0xde, 0xf0,
      0x11, 0x22, 0x33, 0x44,
      0x55, 0x66, 0x77, 0x88,
    ]);
    expect(formatUuidBytes(bytes)).toBe("12345678-9abc-def0-1122-334455667788");
  });

  it("codifica DVP\\x01 com big-endian sequence e dimensões", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const buf = buildClientBinaryFrame(42, 1920, 1080, jpeg);
    const view = new DataView(buf);
    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2))).toBe("DVP");
    expect(view.getUint8(3)).toBe(1);
    expect(Number(view.getBigUint64(4, false))).toBe(42);
    expect(view.getUint16(12, false)).toBe(1920);
    expect(view.getUint16(14, false)).toBe(1080);
    expect(Array.from(new Uint8Array(buf, 16))).toEqual([0xff, 0xd8, 0xff, 0xd9]);
  });

  it("codifica DAP\\x01 com sampleRate big-endian", () => {
    const audio = new Uint8Array([0x7f, 0xfe]);
    const buf = buildClientBinaryAudioFrame(16000, audio);
    const view = new DataView(buf);
    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2))).toBe("DAP");
    expect(view.getUint8(3)).toBe(1);
    expect(view.getUint32(4, false)).toBe(16000);
    expect(Array.from(new Uint8Array(buf, 8))).toEqual([0x7f, 0xfe]);
  });

  it("faz round-trip aproximado de linearToMulaw / MULAW_DECODE_TABLE", () => {
    for (const sample of [-0.8, -0.25, 0.0, 0.25, 0.8]) {
      const encoded = linearToMulaw(sample);
      const decoded = MULAW_DECODE_TABLE[encoded];
      expect(Math.abs(decoded - sample)).toBeLessThan(0.06);
    }
  });

  it("interpreta pacotes DVF\\x01 e DAF\\x01 do servidor e rejeita headers inválidos", () => {
    const dvf = new ArrayBuffer(36);
    const v = new DataView(dvf);
    v.setUint8(0, 68); v.setUint8(1, 86); v.setUint8(2, 70); v.setUint8(3, 1);
    for (let i = 0; i < 16; i++) v.setUint8(4 + i, i);
    v.setBigUint64(20, 7n, false);
    v.setUint16(28, 1280, false);
    v.setUint16(30, 720, false);
    v.setUint8(32, 0xaa);
    const parsedV = parseServerBinaryVideoHeader(dvf);
    expect(parsedV.frameSeq).toBe(7);
    expect(parsedV.width).toBe(1280);
    expect(parsedV.height).toBe(720);
    expect(Array.from(parsedV.payload)).toEqual([0xaa, 0, 0, 0]);

    const daf = new ArrayBuffer(26);
    const a = new DataView(daf);
    a.setUint8(0, 68); a.setUint8(1, 65); a.setUint8(2, 70); a.setUint8(3, 1);
    a.setUint32(20, 16000, false);
    a.setUint8(24, 0x55);
    const parsedA = parseServerBinaryAudioHeader(daf);
    expect(parsedA.sampleRate).toBe(16000);
    expect(Array.from(parsedA.payload)).toEqual([0x55, 0]);

    expect(parseServerBinaryVideoHeader(new ArrayBuffer(10))).toBeNull();
    expect(parseServerBinaryAudioHeader(new ArrayBuffer(10))).toBeNull();
  });

  it("codifica e decodifica DVP\\x02 / DVF\\x02 (WebCodecs V2)", () => {
    const chunk = new Uint8Array([0x10, 0x20, 0x30]);
    const cBuf = buildClientBinaryVideoV2Frame(99, 1280, 720, VIDEO_CODEC_VP8, 1, chunk);
    const cv = new DataView(cBuf);
    expect(cv.getUint8(3)).toBe(2);
    expect(Number(cv.getBigUint64(4, false))).toBe(99);
    expect(cv.getUint16(12, false)).toBe(1280);
    expect(cv.getUint16(14, false)).toBe(720);
    expect(cv.getUint8(16)).toBe(VIDEO_CODEC_VP8);
    expect(cv.getUint8(17)).toBe(1);
    expect(Array.from(new Uint8Array(cBuf, 18))).toEqual([0x10, 0x20, 0x30]);

    const sBuf = new ArrayBuffer(37);
    const sv = new DataView(sBuf);
    sv.setUint8(0, 68); sv.setUint8(1, 86); sv.setUint8(2, 70); sv.setUint8(3, 2);
    sv.setBigUint64(20, 55n, false);
    sv.setUint16(28, 1920, false);
    sv.setUint16(30, 1080, false);
    sv.setUint8(32, VIDEO_CODEC_H264);
    sv.setUint8(33, 0);
    sv.setUint8(34, 0xde);
    sv.setUint8(35, 0xad);
    sv.setUint8(36, 0xbe);
    const parsed = parseServerBinaryVideoV2Header(sBuf);
    expect(parsed.frameSeq).toBe(55);
    expect(parsed.codecId).toBe(VIDEO_CODEC_H264);
    expect(parsed.isKeyframe).toBe(false);
    expect(Array.from(parsed.payload)).toEqual([0xde, 0xad, 0xbe]);
    expect(parseServerBinaryVideoV2Header(new ArrayBuffer(20))).toBeNull();
  });

  it("codifica e decodifica DAP\\x02 / DAF\\x02 (Opus V2)", () => {
    const opus = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const cBuf = buildClientBinaryAudioV2Frame(48000, 1_234_567, opus);
    const cv = new DataView(cBuf);
    expect(cv.getUint8(3)).toBe(2);
    expect(cv.getUint32(4, false)).toBe(48000);
    expect(Number(cv.getBigUint64(8, false))).toBe(1_234_567);

    const sBuf = new ArrayBuffer(34);
    const sv = new DataView(sBuf);
    sv.setUint8(0, 68); sv.setUint8(1, 65); sv.setUint8(2, 70); sv.setUint8(3, 2);
    sv.setUint32(20, 48000, false);
    sv.setBigUint64(24, 9_000_000n, false);
    sv.setUint8(32, 0x77);
    sv.setUint8(33, 0x88);
    const parsed = parseServerBinaryAudioV2Header(sBuf);
    expect(parsed.sampleRate).toBe(48000);
    expect(parsed.timestampUs).toBe(9_000_000);
    expect(Array.from(parsed.payload)).toEqual([0x77, 0x88]);
    expect(parseServerBinaryAudioV2Header(new ArrayBuffer(20))).toBeNull();
  });

  it("jitter buffer adaptativo aumenta delay com variação e mantém bounds seguros", () => {
    const jState = { lastArrivalMs: 0, jitterMs: 10, targetDelaySec: 0.06 };
    updateJitterEstimate(jState, 1000, 0.02);
    const calm = updateJitterEstimate(jState, 1020, 0.02);
    const spiky = updateJitterEstimate(jState, 1140, 0.02);
    expect(calm).toBeGreaterThanOrEqual(0.035);
    expect(spiky).toBeGreaterThan(calm);
    expect(spiky).toBeLessThanOrEqual(0.24);
  });

  it("faz downsample 48 kHz -> 16 kHz μ-law no fallback sem corrupção", () => {
    const pcm48k = new Float32Array(960);
    pcm48k.fill(0.25);
    const mulaw = downsampleToMuLaw16k(pcm48k, 48000);
    expect(mulaw.length).toBe(320);
    expect(Math.abs(MULAW_DECODE_TABLE[mulaw[0]] - 0.25)).toBeLessThan(0.06);
  });
});
