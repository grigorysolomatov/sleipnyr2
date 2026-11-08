// Hands-free talk: a voice conversation without touching the screen (phone
// in a pocket or on a shelf). It is a modality of the shared bar: one tap on
// the sound-wave button (between keyboard and mic, in every view) starts it,
// and each turn goes to whatever the bar talks to (the open thread, the
// thread list's conversation, a Columns board...):
//   - the mic stays open; an AudioWorklet (vad.js) taps it and this module
//     finds each turn: speech, then SILENCE_MS of quiet = end of turn
//   - the turn (16 kHz WAV) goes to POST /p/talk/hear (fast transcription),
//     then through the bar (ctx.bar.deliver) as a normal voice message with
//     that transcript, so that conversation keeps everything
//   - while it runs the bar shows its live row: X (or Esc) ends it, level
//     bars, what happens (listening / hearing you / thinking / speaking) and
//     the elapsed time, a pause button on the right
//   - the reply is spoken while it streams, a sentence at a time
//     (POST /p/talk/speak, Kokoro); listening goes on during playback, and
//     talking over the reply stops it (barge-in)
//   - spoken controls: "pause" (only "resume" / "stop listening" count
//     until resumed), "stop" (quiet now), "stop listening" (ends it)
//   - a screen wake lock keeps the phone awake while it runs
// Plain JavaScript, an extension: extend(host, ctx); it only needs ctx.bar.
const WAVE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h2M7 8v8M11 4v16M15 8v8M19 11v2M21 12h0"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6v12M15 6v12"/></svg>';
const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>';
const icon = s => { const t = document.createElement("template"); t.innerHTML = s; return t.content.firstChild; };
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter(k => k != null && k !== false));
  return el;
};

const API = "/p/talk";
const RATE = 16000; // what the transcriber wants
const SILENCE_MS = 1200; // quiet after speech = end of turn
const START_MS = 120; // this much speech starts a turn
const MIN_SPEECH_MS = 350; // shorter = a cough or a click, dropped
const PREROLL_MS = 1000; // kept from before the turn started: echo
// cancellation mutes the mic while a reply plays, so a barge-in is noticed
// late and its first words would otherwise be lost ("stop listening")
const MAX_TURN_MS = 120000;
const BARGE_MS = 300; // talking this long over a reply stops it
const NOTE = "[Hands-free voice conversation: the user is listening, not reading, while busy with something else. "
  + "Answer first, in one to three short spoken sentences; no lists, markdown, links or code. "
  + "Action and MEDIA lines are not spoken.]";

// spoken controls: the whole turn must be just the phrase
const said = t => t.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
const CONTROLS = [
  [/^(ok(ay)? )?(stop|end|quit) (listening|talking|the conversation|conversation|talk mode)( now)?( please)?$/, "end"],
  [/^(ok(ay)? )?(pause|paws|pause listening|pause please|hold on|wait)$/, "pause"],
  [/^(ok(ay)? )?(resume|continue|unpause|i'm back|go on)( please)?$/, "resume"],
  [/^(ok(ay)? )?(stop|quiet|shush|be quiet|enough)( please)?$/, "hush"],
];
export const control = text => { const s = said(text); return CONTROLS.find(([re]) => re.test(s))?.[1] || null; };

/** 16-bit mono WAV at RATE from float samples at `from` Hz. */
function wav(chunks, from) {
  const n = chunks.reduce((a, c) => a + c.length, 0), all = new Float32Array(n);
  let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  const ratio = from / RATE, m = Math.floor(n / ratio), pcm = new Int16Array(m);
  for (let i = 0; i < m; i++) { // average each output sample's input span (a simple low-pass)
    const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let s = 0; for (let j = a; j < b; j++) s += all[j];
    pcm[i] = Math.max(-1, Math.min(1, s / (b - a))) * 32767;
  }
  const buf = new ArrayBuffer(44 + pcm.byteLength), v = new DataView(buf);
  const str = (p, s) => { for (let i = 0; i < s.length; i++) v.setUint8(p + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + pcm.byteLength, true); str(8, "WAVEfmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, pcm.byteLength, true); new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}

/** Cuts the next speakable piece off the reply text: up to a sentence end or a line break. */
export function nextPiece(text, from, first, final) {
  const rest = text.slice(from);
  const m = /[.!?…:;](?=["')\]]*(\s|$))|\n/.exec(rest);
  if (m && (m.index > 0 || rest[0] === "\n")) {
    let end = m.index + m[0].length;
    while (end < rest.length && /["')\]]/.test(rest[end])) end++;
    // a sentence end at the very end of the text so far is spoken at once,
    // unless it may be a decimal point ("3." of "3.50")
    if (end < rest.length || final || !/\d$/.test(rest.slice(0, m.index))) return { piece: rest.slice(0, end), to: from + end };
  }
  // a long first sentence: start speaking at a comma rather than wait for its end
  if (first && rest.length > 140) { const c = rest.lastIndexOf(", ", 140); if (c > 30) return { piece: rest.slice(0, c + 1), to: from + c + 1 }; }
  return final && rest.trim() ? { piece: rest, to: text.length } : null;
}

export function extend(host, ctx) {
  if (!ctx.bar?.modality || !navigator.mediaDevices?.getUserMedia) return;
  const log = window.__talkLog = []; // timings for tests: {t, ev, ...}
  const mark = (ev, extra = {}) => { const e = { t: Math.round(performance.now()), ev, ...extra }; log.push(e); if (log.length > 400) log.shift(); return e; };

  // ------------------------------------------------------------ controls
  // the entry point: a modality button in the shared bar, between keyboard
  // and mic (the mic stays rightmost, nearest the thumb, as the most used)
  const mod = ctx.bar.modality({ id: "talk", tip: "Hands-free talk", icon: WAVE, order: 30, onclick: () => (s ? stop() : start()) });
  const pauseBtn = h("button", { class: "mb-btn mb-ic tk-pause", type: "button", "data-tip": "Pause (or say \u201cpause\u201d)", "aria-label": "Pause",
    onclick: () => (s?.paused ? resume() : pause()) }, icon(PAUSE));
  // state words and their colour in the bar: pink = it hears you, purple = the agent speaks
  const TONE = { hear: "here", speak: "agent" };
  const show = (what, cls) => { if (s) mod.word(what, TONE[cls]); };

  // ------------------------------------------------------------ sounds
  // short tones so the user knows what happens without looking
  function tone(freqs, gap = 0.09, vol = 0.12) {
    if (!s?.ac) return;
    const t0 = s.ac.currentTime + 0.01;
    freqs.forEach((f, i) => {
      const o = s.ac.createOscillator(), g = s.ac.createGain();
      o.frequency.value = f; o.type = "sine";
      g.gain.setValueAtTime(0, t0 + i * gap); g.gain.linearRampToValueAtTime(vol, t0 + i * gap + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * gap + 0.12);
      o.connect(g).connect(s.ac.destination); o.start(t0 + i * gap); o.stop(t0 + i * gap + 0.14);
    });
  }

  // ------------------------------------------------------------ session
  let s = null; // the running conversation
  async function start() {
    if (s) return;
    const session = s = { paused: false, mode: "listening", turn: null, ring: [], floor: 0.004, speech: 0, quiet: 0,
      reply: null, queue: [], playing: null, busy: 0, lock: null, ac: null, stream: null, wake: null };
    mod.live({ stop: () => stop(), stopTip: "Stop hands-free talk (Esc, or say \u201cstop listening\u201d)", extra: [pauseBtn] });
    pauseBtn.replaceChildren(icon(PAUSE)); pauseBtn.dataset.tip = "Pause (or say \u201cpause\u201d)";
    show("Starting\u2026", "busy");
    try {
      session.ac = new AudioContext();
      await session.ac.resume(); // inside the tap: unlocks playback for the whole session
      session.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      await session.ac.audioWorklet.addModule(`${API}/web/vad.js`);
      const src = session.ac.createMediaStreamSource(session.stream);
      const tap = new AudioWorkletNode(session.ac, "talk-tap");
      const mute = session.ac.createGain(); mute.gain.value = 0;
      src.connect(tap).connect(mute).connect(session.ac.destination); // keeps the worklet pulled
      tap.port.onmessage = e => { if (s === session) hearBlock(e.data.rms, e.data.block); };
      session.tap = tap;
      if (s !== session) return;
      await wakeLock();
      mark("start", { target: ctx.bar.focused() });
      tone([520, 780]); show("Listening", "listen");
    } catch (e) {
      console.error(e); const why = e?.name === "NotAllowedError" ? "Microphone blocked" : `Could not start: ${e.message || e}`;
      stop(why);
      ctx.bar.say(why, true);
    }
  }

  function stop(why = "") {
    const session = s; if (!session) return;
    hush();
    if (session.ac) { tone([780, 520]); setTimeout(() => session.ac.close().catch(() => {}), 400); }
    session.stream?.getTracks().forEach(t => t.stop());
    session.wake?.release().catch(() => {});
    s = null; mark("stop", { why });
    mod.end();
    if (why) { ctx.bar.say(why); setTimeout(() => { if (!s) ctx.bar.say(""); }, 2500); }
  }
  addEventListener("pagehide", () => stop());

  async function wakeLock() {
    if (!s || !("wakeLock" in navigator)) return;
    try { s.wake = await navigator.wakeLock.request("screen"); mark("wakelock", { ok: true }); }
    catch (e) { mark("wakelock", { ok: false, why: e.name }); }
  }
  document.addEventListener("visibilitychange", () => {
    mark("visibility", { state: document.visibilityState });
    if (s && document.visibilityState === "visible" && (!s.wake || s.wake.released)) wakeLock();
  });

  function pause() { if (!s) return; hush(); s.paused = true; tone([600, 450]); show("Paused \u00b7 say \u201cresume\u201d", "pause"); pauseBtn.replaceChildren(icon(PLAY)); pauseBtn.dataset.tip = "Resume (or say \u201cresume\u201d)"; }
  function resume() { if (!s) return; s.paused = false; tone([450, 600]); idle(); pauseBtn.replaceChildren(icon(PAUSE)); pauseBtn.dataset.tip = "Pause (or say \u201cpause\u201d)"; }
  function idle() {
    if (!s || s.paused) return;
    if (s.playing || s.queue.length) show("Speaking", "speak");
    else if (s.busy || s.reply) show("Thinking\u2026", "busy");
    else show("Listening", "listen");
  }

  // ------------------------------------------------------------ turns (VAD)
  function hearBlock(rms, block) {
    const ms = block.length / s.ac.sampleRate * 1000, playing = !!s.playing;
    // noise floor: falls at once, rises slowly; speech is well above it
    s.floor = rms < s.floor ? rms : s.floor * 0.999 + rms * 0.001;
    const loud = rms > Math.max(playing ? 0.03 : 0.012, s.floor * (playing ? 6 : 3.5));
    window.__talkLevel = { rms, floor: s.floor, playing, loud }; // for tests
    mod.level(Math.min(1, rms * 25));
    if (!s.turn) {
      s.ring.push(block); while (s.ring.length * ms > PREROLL_MS) s.ring.shift();
      s.speech = loud ? s.speech + ms : 0;
      if (s.speech >= (playing ? BARGE_MS : START_MS)) {
        if (playing) { mark("barge-in"); hush(); }
        s.turn = { chunks: [...s.ring], voiced: s.speech, quiet: 0, ms: s.ring.length * ms };
        s.ring = []; mark("turn-start");
        if (!s.paused) show("Hearing you", "hear");
      }
      return;
    }
    const t = s.turn;
    t.chunks.push(block); t.ms += ms;
    if (loud) { t.voiced += ms; t.quiet = 0; t.lastVoice = performance.now(); } else t.quiet += ms;
    if (t.quiet >= SILENCE_MS || t.ms >= MAX_TURN_MS) {
      s.turn = null; s.speech = 0;
      if (t.voiced < MIN_SPEECH_MS) { mark("turn-dropped", { voiced: Math.round(t.voiced) }); idle(); if (s.paused) show("Paused \u00b7 say \u201cresume\u201d", "pause"); return; }
      const ended = mark("turn-end", { voiced: Math.round(t.voiced), ms: Math.round(t.ms), speechEnd: Math.round(t.lastVoice || performance.now()) });
      send(wav(t.chunks, s.ac.sampleRate), ended);
    }
  }

  async function send(blob, ended) {
    const session = s; session.busy++; idle();
    if (!session.paused) tone([880], 0, 0.06); // "got it"
    try {
      const heard = await (await fetch(`${API}/hear`, { method: "POST", body: blob, headers: { "content-type": "audio/wav" } })).json();
      mark("heard", { text: heard.text, ms: Math.round(performance.now() - ended.t), error: heard.error });
      if (s !== session) return;
      if (heard.error) throw new Error(heard.error);
      const text = (heard.text || "").trim();
      if (!text || !heard.file) return;
      const c = control(text);
      if (c === "end") return stop("Hands-free talk stopped: \u201cstop listening\u201d");
      if (c === "pause") return pause();
      if (c === "resume") return resume();
      if (c === "hush") { hush(); return; }
      if (session.paused) { mark("ignored-paused", { text }); return; }
      // to whatever the bar talks to now: that view's conversation answers
      const out = await ctx.bar.deliver({ voice: heard.file, transcript: text, text: "", files: [], context: NOTE });
      if (!out?.reply?.id) throw new Error("this view does not answer by voice");
      mark("posted", { reply: out.reply.id, target: ctx.bar.focused(), ms: Math.round(performance.now() - ended.t) });
      if (s !== session) return;
      session.reply = { id: out.reply.id, text: "", spoken: 0, done: false, pieces: 0, ended };
    } catch (e) {
      console.error(e); mark("error", { message: String(e.message || e) });
      if (s === session) { tone([300, 240], 0.12); show(`Trouble: ${e.message || e}`, "pause"); setTimeout(idle, 2500); }
    } finally { session.busy--; idle(); }
  }

  // ------------------------------------------------------------ replies (speech)
  ctx.on("chat", ev => {
    const r = s?.reply; if (!r || ev.message !== r.id || !ev.delta) return;
    if (!r.text) mark("first-delta", { ms: Math.round(performance.now() - r.ended.t) });
    r.text += ev.delta; speakMore(r);
  });
  ctx.on("item", ({ item }) => {
    const r = s?.reply; if (!r || item.id !== r.id) return;
    const st = item.data.status;
    if (!["done", "error", "stopped", "cancelled"].includes(st)) return;
    if (st === "done" && item.data.text && item.data.text.startsWith(r.text)) r.text = item.data.text;
    if (st === "error" && !r.text) r.text = "Sorry, that failed.";
    r.done = true; mark("reply-done", { status: st, ms: Math.round(performance.now() - r.ended.t) });
    speakMore(r);
  });

  function speakMore(r) {
    if (!s || s.reply !== r) return;
    let cut;
    while ((cut = nextPiece(r.text, r.spoken, r.pieces === 0, r.done))) {
      r.spoken = cut.to;
      if (!cut.piece.trim() || /^\s*(@[a-z-]+\b|MEDIA:)/.test(cut.piece)) continue;
      r.pieces++;
      const piece = { text: cut.piece, first: r.pieces === 1, r, audio: fetchSpeech(cut.piece) };
      s.queue.push(piece);
    }
    if (r.done && r.spoken >= r.text.length) { if (s.reply === r) s.reply = null; }
    play(); idle();
  }

  async function fetchSpeech(text) {
    const session = s;
    const res = await fetch(`${API}/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    if (!res.ok) return null; // e.g. nothing speakable in it
    return session.ac.decodeAudioData(await res.arrayBuffer());
  }

  async function play() {
    if (!s || s.playing || !s.queue.length || s.paused) return;
    const session = s, piece = s.queue[0];
    session.playing = piece; idle();
    let buf = null;
    try { buf = await piece.audio; } catch (e) { mark("error", { message: `speech: ${e.message || e}` }); }
    if (s !== session || session.playing !== piece) return; // hushed meanwhile
    session.queue.shift();
    if (!buf) { session.playing = null; return play(); }
    const node = session.ac.createBufferSource(); node.buffer = buf; node.connect(session.ac.destination);
    piece.node = node;
    node.onended = () => { if (session.playing === piece) { session.playing = null; play(); if (!session.playing && !session.queue.length) mark("speak-end"); idle(); } };
    node.start();
    if (piece.first) mark("first-audio", { ms: Math.round(performance.now() - piece.r.ended.t), afterSpeech: Math.round(performance.now() - piece.r.ended.speechEnd) });
  }

  /** Quiet now: the rest of the current reply is not spoken. */
  function hush() {
    if (!s) return;
    const p = s.playing; s.playing = null; s.queue = []; s.reply = null;
    try { p?.node?.stop(); } catch { /* not started */ }
    idle();
  }
}
