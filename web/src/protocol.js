// Protocolo binário Drocsid (DVP\x01 / DVF\x01 / DVP\x02 / DVF\x02 / DAP\x01 / DAF\x01 / DAP\x02 / DAF\x02) + μ-law

export const VIDEO_CODEC_VP8 = 1;
export const VIDEO_CODEC_H264 = 2;

export const MULAW_DECODE_TABLE = (() => {
  const tbl = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const mu = (~i) & 0xff;
    const sign = (mu & 0x80) ? -1 : 1;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    tbl[i] = (sign * sample) / 32768.0;
  }
  return tbl;
})();

export function linearToMulaw(sampleFloat) {
  let s = Math.max(-1, Math.min(1, sampleFloat));
  let pcm = (s * 32767) | 0;
  const sign = pcm < 0 ? 0x80 : 0x00;
  if (pcm < 0) pcm = -pcm;
  if (pcm > 32635) pcm = 32635;
  pcm += 0x84;
  let exponent = 7;
  for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

export function formatUuidBytes(bytes) {
  const hex = [];
  for (let i = 0; i < 16; i++) {
    hex.push(bytes[i].toString(16).padStart(2, "0"));
  }
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

export function buildClientBinaryFrame(frameSeq, width, height, jpegBytes) {
  const src = jpegBytes instanceof Uint8Array ? jpegBytes : new Uint8Array(jpegBytes);
  const header = new ArrayBuffer(16 + src.byteLength);
  const view = new DataView(header);
  view.setUint8(0, 68); // 'D'
  view.setUint8(1, 86); // 'V'
  view.setUint8(2, 80); // 'P'
  view.setUint8(3, 1);
  view.setBigUint64(4, BigInt(frameSeq), false);
  view.setUint16(12, width & 0xffff, false);
  view.setUint16(14, height & 0xffff, false);
  new Uint8Array(header, 16).set(src);
  return header;
}

export function buildClientBinaryAudioFrame(sampleRate, mulawBytes) {
  const src = mulawBytes instanceof Uint8Array ? mulawBytes : new Uint8Array(mulawBytes);
  const pkt = new Uint8Array(8 + src.length);
  const view = new DataView(pkt.buffer);
  pkt[0] = 68; // 'D'
  pkt[1] = 65; // 'A'
  pkt[2] = 80; // 'P'
  pkt[3] = 1;
  view.setUint32(4, sampleRate, false);
  pkt.set(src, 8);
  return pkt.buffer;
}

export function parseServerBinaryVideoHeader(buffer) {
  if (!buffer || buffer.byteLength <= 32) return null;
  const view = new DataView(buffer);
  if (
    view.getUint8(0) !== 68 || // 'D'
    view.getUint8(1) !== 86 || // 'V'
    view.getUint8(2) !== 70 || // 'F'
    view.getUint8(3) !== 1
  ) {
    return null;
  }
  return {
    streamerId: formatUuidBytes(new Uint8Array(buffer, 4, 16)),
    frameSeq: Number(view.getBigUint64(20, false)),
    width: view.getUint16(28, false),
    height: view.getUint16(30, false),
    payload: new Uint8Array(buffer, 32),
  };
}

export function parseServerBinaryAudioHeader(buffer) {
  if (!buffer || buffer.byteLength <= 24) return null;
  const view = new DataView(buffer);
  if (
    view.getUint8(0) !== 68 || // 'D'
    view.getUint8(1) !== 65 || // 'A'
    view.getUint8(2) !== 70 || // 'F'
    view.getUint8(3) !== 1
  ) {
    return null;
  }
  return {
    version: 1,
    senderId: formatUuidBytes(new Uint8Array(buffer, 4, 16)),
    sampleRate: view.getUint32(20, false),
    payload: new Uint8Array(buffer, 24),
  };
}

export function buildClientBinaryVideoV2Frame(frameSeq, width, height, codecId, isKeyframe, chunkBytes) {
  const src = chunkBytes instanceof Uint8Array ? chunkBytes : new Uint8Array(chunkBytes);
  const header = new ArrayBuffer(18 + src.byteLength);
  const view = new DataView(header);
  view.setUint8(0, 68); // 'D'
  view.setUint8(1, 86); // 'V'
  view.setUint8(2, 80); // 'P'
  view.setUint8(3, 2);
  view.setBigUint64(4, BigInt(frameSeq), false);
  view.setUint16(12, width & 0xffff, false);
  view.setUint16(14, height & 0xffff, false);
  view.setUint8(16, codecId & 0xff);
  view.setUint8(17, isKeyframe ? 1 : 0);
  new Uint8Array(header, 18).set(src);
  return header;
}

export function parseServerBinaryVideoV2Header(buffer) {
  if (!buffer || buffer.byteLength <= 34) return null;
  const view = new DataView(buffer);
  if (
    view.getUint8(0) !== 68 || // 'D'
    view.getUint8(1) !== 86 || // 'V'
    view.getUint8(2) !== 70 || // 'F'
    view.getUint8(3) !== 2
  ) {
    return null;
  }
  return {
    version: 2,
    streamerId: formatUuidBytes(new Uint8Array(buffer, 4, 16)),
    frameSeq: Number(view.getBigUint64(20, false)),
    width: view.getUint16(28, false),
    height: view.getUint16(30, false),
    codecId: view.getUint8(32),
    isKeyframe: (view.getUint8(33) & 1) !== 0,
    payload: new Uint8Array(buffer, 34),
  };
}

export function buildClientBinaryAudioV2Frame(sampleRate, timestampUs, opusBytes) {
  const src = opusBytes instanceof Uint8Array ? opusBytes : new Uint8Array(opusBytes);
  const pkt = new Uint8Array(16 + src.length);
  const view = new DataView(pkt.buffer);
  pkt[0] = 68; // 'D'
  pkt[1] = 65; // 'A'
  pkt[2] = 80; // 'P'
  pkt[3] = 2;
  view.setUint32(4, sampleRate >>> 0, false);
  view.setBigUint64(8, BigInt(Math.max(0, Math.round(timestampUs))), false);
  pkt.set(src, 16);
  return pkt.buffer;
}

export function parseServerBinaryAudioV2Header(buffer) {
  if (!buffer || buffer.byteLength <= 32) return null;
  const view = new DataView(buffer);
  if (
    view.getUint8(0) !== 68 || // 'D'
    view.getUint8(1) !== 65 || // 'A'
    view.getUint8(2) !== 70 || // 'F'
    view.getUint8(3) !== 2
  ) {
    return null;
  }
  return {
    version: 2,
    senderId: formatUuidBytes(new Uint8Array(buffer, 4, 16)),
    sampleRate: view.getUint32(20, false),
    timestampUs: Number(view.getBigUint64(24, false)),
    payload: new Uint8Array(buffer, 32),
  };
}
