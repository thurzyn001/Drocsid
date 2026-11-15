/**
 * Carregador offline do supressor de ruído neural RNNoise (@sapphi-red/web-noise-suppressor).
 * Todos os bytes de worklet e WASM são embutidos no bundle único pelo esbuild.
 */
import { RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletCode from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?text";
import rnnoiseWasmBytes from "@sapphi-red/web-noise-suppressor/rnnoise.wasm";
import rnnoiseSimdWasmBytes from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm";

function pickRnnoiseWasmCopy() {
  let bytes = rnnoiseWasmBytes;
  try {
    if (typeof WebAssembly !== "undefined" && typeof WebAssembly.validate === "function") {
      if (WebAssembly.validate(rnnoiseSimdWasmBytes)) {
        bytes = rnnoiseSimdWasmBytes;
      }
    }
  } catch {
    bytes = rnnoiseWasmBytes;
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export async function createRnnoiseNode(audioCtx) {
  if (!audioCtx?.audioWorklet) return null;
  if (!audioCtx.__drocsidRnnoiseLoaded) {
    const blob = new Blob([rnnoiseWorkletCode], { type: "application/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    try {
      await audioCtx.audioWorklet.addModule(blobUrl);
      audioCtx.__drocsidRnnoiseLoaded = true;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  return new RnnoiseWorkletNode(audioCtx, {
    maxChannels: 1,
    wasmBinary: pickRnnoiseWasmCopy(),
  });
}
