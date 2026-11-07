// Hands-free talk: the microphone tap, as an AudioWorklet. Sends the main
// thread blocks of 512 samples (~11 ms at 48 kHz): the raw samples and their loudness (RMS). The
// main thread (talk.js) decides what is speech and what is silence.
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(512); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) {
        let sum = 0;
        for (let j = 0; j < this.n; j++) sum += this.buf[j] * this.buf[j];
        const block = this.buf.slice(0);
        this.port.postMessage({ rms: Math.sqrt(sum / this.n), block }, [block.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("talk-tap", Tap);
