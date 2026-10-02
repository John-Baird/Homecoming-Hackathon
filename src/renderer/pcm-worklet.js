// AudioWorklet: collects mono float samples at the context's sample rate and posts
// 100 ms frames of 16-bit PCM plus their RMS level (used for VAD and the level meter).
class PcmFramer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSize = Math.round(sampleRate / 10);
    this.buf = new Float32Array(this.frameSize);
    this.len = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channels = input.length;
    const n = input[0].length;
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let c = 0; c < channels; c++) v += input[c][i];
      this.buf[this.len++] = v / channels;
      if (this.len === this.frameSize) this.flush();
    }
    return true;
  }

  flush() {
    const out = new Int16Array(this.frameSize);
    let sum = 0;
    for (let i = 0; i < this.frameSize; i++) {
      const s = Math.max(-1, Math.min(1, this.buf[i]));
      sum += s * s;
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const rms = Math.sqrt(sum / this.frameSize);
    this.port.postMessage({ pcm: out.buffer, rms }, [out.buffer]);
    this.len = 0;
  }
}

registerProcessor('pcm-framer', PcmFramer);
