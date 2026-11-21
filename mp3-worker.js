// Encodes decoded audio to MP3 off the main thread (lamejs, LGPL).
importScripts("vendor/lame.min.js");

self.onmessage = (e) => {
  try {
    const { left, right, sampleRate, kbps } = e.data;
    const enc = new lamejs.Mp3Encoder(2, sampleRate, kbps || 192);
    const BLOCK = 1152 * 20;
    const n = left.length;
    const l16 = new Int16Array(BLOCK), r16 = new Int16Array(BLOCK);
    const parts = [];
    let lastPost = 0;
    for (let i = 0; i < n; i += BLOCK) {
      const len = Math.min(BLOCK, n - i);
      for (let j = 0; j < len; j++) {
        let a = left[i + j], b = right[i + j];
        a = a < -1 ? -1 : a > 1 ? 1 : a;
        b = b < -1 ? -1 : b > 1 ? 1 : b;
        l16[j] = a < 0 ? a * 0x8000 : a * 0x7fff;
        r16[j] = b < 0 ? b * 0x8000 : b * 0x7fff;
      }
      const out = len === BLOCK ? enc.encodeBuffer(l16, r16) : enc.encodeBuffer(l16.subarray(0, len), r16.subarray(0, len));
      if (out.length) parts.push(new Uint8Array(out));
      const now = Date.now();
      if (now - lastPost > 200) { lastPost = now; self.postMessage({ progress: i / n }); }
    }
    const end = enc.flush();
    if (end.length) parts.push(new Uint8Array(end));
    self.postMessage({ blob: new Blob(parts, { type: "audio/mpeg" }) });
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
