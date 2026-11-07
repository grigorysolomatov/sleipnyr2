// Recording a voice message, with a live input level for a meter.
//   const rec = await startRecording({ onLevel(level0to1, quiet), onTick(seconds), onLimit() })
//   rec.stop() -> Promise<File|null>      rec.cancel()
// At MAX_SECONDS the recorder stops itself and calls onLimit(): the caller
// must send the clip then, so nothing said after the limit is lost.
// Throws Error with a readable message when the microphone is unavailable.

export const MAX_SECONDS = 30 * 60; // ~7 MB of 32 kbit/s opus; the transcriber takes the whole clip
const QUIET_DB = -75, QUIET_MS = 4000; // a dead or muted mic gives digital silence (about -120 dBFS)

const fileName = type => `voice-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.`
  + (/mp4|aac/.test(type) ? "m4a" : /ogg/.test(type) ? "ogg" : "webm");

export async function startRecording({ onLevel = () => {}, onTick = () => {}, onLimit = () => {} } = {}) {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
    throw new Error(window.isSecureContext ? "This browser cannot record audio." : "Voice needs HTTPS.");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    throw new Error(e.name === "NotAllowedError" ? "Microphone blocked: allow it for this site, then try again."
      : e.name === "NotFoundError" ? "No microphone found." : `Microphone unavailable (${e.name || e.message}).`);
  }
  const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]
    .find(t => MediaRecorder.isTypeSupported(t)) || "";
  const mr = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
  const chunks = [], t0 = Date.now();
  mr.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
  const stopMeter = meter(stream, onLevel);
  const tick = setInterval(() => {
    const s = (Date.now() - t0) / 1000;
    onTick(s);
    if (s >= MAX_SECONDS && mr.state === "recording") { mr.stop(); onLimit(); }
  }, 250);
  const ended = new Promise(ok => { mr.onstop = ok; });
  mr.start(1000);
  navigator.vibrate?.(10);

  const finish = async keep => {
    if (mr.state !== "inactive") mr.stop();
    await ended;
    clearInterval(tick); stopMeter(); stream.getTracks().forEach(t => t.stop());
    if (!keep) return null;
    const mime = (mr.mimeType || type || "audio/webm").split(";")[0];
    const blob = new Blob(chunks, { type: mime });
    return blob.size ? new File([blob], fileName(mime), { type: mime }) : null;
  };
  return { stop: () => finish(true), cancel: () => finish(false) };
}

/** Calls onLevel(level 0..1, quiet) about 20 times a second; returns stop(). */
function meter(stream, onLevel) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return () => {};
  let ac, src, an;
  try {
    ac = new AC(); src = ac.createMediaStreamSource(stream); an = ac.createAnalyser();
    an.fftSize = 1024; src.connect(an);
  } catch { try { ac?.close(); } catch {} return () => {}; }
  if (ac.state !== "running") ac.resume().catch(() => {});
  const buf = new Float32Array(an.fftSize);
  let loud = Date.now(), smooth = 0, timer = 0, alive = true;
  const step = () => {
    if (!alive) return;
    const now = Date.now();
    if (ac.state === "running") {
      an.getFloatTimeDomainData(buf);
      let sum = 0; for (const v of buf) sum += v * v;
      const db = 10 * Math.log10(sum / buf.length || 1e-12);
      if (db > QUIET_DB) loud = now;
      const level = Math.max(0, Math.min(1, (db + 60) / 48)); // -60..-12 dBFS
      smooth = level > smooth ? level : smooth * 0.8 + level * 0.2; // fast attack, slow release
      onLevel(smooth, now - loud > QUIET_MS);
    } else { loud = now; onLevel(0, false); }
    timer = setTimeout(step, 50);
  };
  step();
  return () => { alive = false; clearTimeout(timer); try { src.disconnect(); } catch {} ac.close().catch(() => {}); };
}
