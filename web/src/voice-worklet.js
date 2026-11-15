/**
 * AudioWorkletProcessor offline embarcado como Blob URL para captura de voz a 48 kHz.
 * Substitui ScriptProcessorNode evitando glitches na thread principal.
 */
export const VOICE_CAPTURE_WORKLET_CODE = `
class DrocsidVoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._frameSamples = 960; // 20 ms a 48 kHz
    this._buf = new Float32Array(this._frameSamples);
    this._pos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true;
    }
    const ch = input[0];
    let offset = 0;
    while (offset < ch.length) {
      const space = this._frameSamples - this._pos;
      const take = Math.min(space, ch.length - offset);
      this._buf.set(ch.subarray(offset, offset + take), this._pos);
      this._pos += take;
      offset += take;

      if (this._pos >= this._frameSamples) {
        const out = this._buf;
        this._buf = new Float32Array(this._frameSamples);
        this._pos = 0;
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
}

registerProcessor("drocsid-voice-capture", DrocsidVoiceCaptureProcessor);
`;

export async function registerVoiceCaptureWorklet(audioCtx) {
  if (!audioCtx?.audioWorklet) return false;
  if (audioCtx.__drocsidVoiceWorkletLoaded) return true;
  const blob = new Blob([VOICE_CAPTURE_WORKLET_CODE], { type: "application/javascript" });
  const blobUrl = URL.createObjectURL(blob);
  try {
    await audioCtx.audioWorklet.addModule(blobUrl);
    audioCtx.__drocsidVoiceWorkletLoaded = true;
    return true;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
