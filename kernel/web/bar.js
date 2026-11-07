// The modality bar: the one bottom bar every view shares (text, voice,
// images). It belongs to the shell, not to a view. Views offer targets;
// the bar sends what the person typed, said or attached to the focused one.
//
//   const bar = createBar(ctx)       the shell does this once; ctx.bar = bar
//   bar.offer({ id, label, send, shown?, placeholder?, busy? }) -> withdraw()
//       send({ text, files, voice, mode? }) -> Promise   files = attached file ids,
//         voice = file id of a recording (or undefined); reject = not sent
//         mode = "queue" | "now", only when busy() said a turn runs there:
//         a choice popover at the send button asked (Esc / Enter / outside = queue)
//       shown() -> whether the view is on screen now (default: always)
//   bar.focus(id)                     the target the bar talks to
//   bar.focused()                     its id
//   bar.say(text, isError)            a line above the bar ("" clears)
//   bar.refresh()                     re-check which targets are shown
//   bar.onChange(fn)                  fn(focusedId, several) after a focus or
//                                     layout change; several = more than one
//                                     target on screen (mark the focused view)
//   bar.el                            the bar element (extensions may add rows)
//   bar.deliver({text, files, voice}) send to the focused target as if typed
//                                     (a Blackboard window: its parent's bar)
//
// While more than one offered target is on screen (desktop: thread list and
// thread side by side), the bar names its target with the "you are here"
// accent; tapping the name switches to the next one shown.
// Keys: Alt+M type, Alt+V voice (again to send), Enter sends (Shift+Enter or
// a touch keyboard = new line). Paste or drop files (any type) anywhere; the
// + picker takes any file. Images show as thumbnails, other files as chips.
import { startRecording, MAX_SECONDS } from "./voice.js";

const svg = s => { const t = document.createElement("template"); t.innerHTML = s; return t.content.firstChild; };
const MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>';
const SEND = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
const KEYS = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h2M10 10h2M14 10h2M18 10h0M7 14h10"/></svg>';
const FILE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
const IMAGE = /^image\//;
const MAX_MB = 50; // the kernel takes requests up to 64 MB
const size = n => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

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

// Send feedback: a soft two-note blip (Web Audio, no file). Off with
// localStorage "sleipnyr2.sounds" = "off".
let audioCtx = null;
function blip() {
  if (localStorage.getItem("sleipnyr2.sounds") === "off") return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime, o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "sine"; o.frequency.setValueAtTime(660, t); o.frequency.exponentialRampToValueAtTime(990, t + 0.09);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.06, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.18);
  } catch { /* no audio: visual feedback only */ }
}

export function createBar(ctx, app) {
  const targets = new Map(); // id -> target, in offer order
  let current = "";
  const changes = new Set();
  const b = { pending: [], recording: null, sending: false, asking: null }; // pending = attachments {file, url, id, error, upload}

  // ------------------------------------------------------------ layout
  const tray = h("div", { class: "mb-tray", hidden: true });
  const note = h("div", { class: "mb-note", hidden: true });
  const to = h("button", { class: "mb-btn mb-to", type: "button", hidden: true, onclick: () => cycle() });
  const ta = h("textarea", { class: "mb-input", rows: 1, placeholder: `Message ${ctx.app?.agentName || "the agent"}`, enterkeyhint: "send" });
  // two pickers: phones only offer the gallery when the input asks for images
  const picker = h("input", { type: "file", multiple: true, hidden: true });
  const photos = h("input", { type: "file", accept: "image/*,video/*", multiple: true, hidden: true });
  // the phone's back camera straight away (desktops without one fall back to a file picker)
  const camera = h("input", { type: "file", accept: "image/*", capture: "environment", hidden: true });
  const choose = inp => { pick.hidden = true; inp.click(); };
  const pick = h("div", { class: "mb-pick", hidden: true },
    h("button", { class: "mb-btn", type: "button", "data-tip": "Pick photos or screenshots from the gallery", "aria-label": "Photos", onclick: () => choose(photos) }, "Photos"),
    h("button", { class: "mb-btn", type: "button", "data-tip": "Take a photo with the camera", "aria-label": "Camera", onclick: () => choose(camera) }, "Camera"),
    h("button", { class: "mb-btn", type: "button", "data-tip": "Pick any file", "aria-label": "Files", onclick: () => choose(picker) }, "Files"));
  const attach = h("button", { class: "mb-btn mb-attach", type: "button", "data-tip": "Attach photos, a camera shot or files", "aria-label": "Attach photos, a camera shot or files", onclick: () => { pick.hidden = !pick.hidden; } }, "+");
  const lvBars = [0, 1, 2, 3, 4].map(() => h("u"));
  const recTime = h("b", {}, "0:00"), recHint = h("small", {}, "recording");
  const recBar = h("div", { class: "mb-rec", hidden: true },
    h("button", { class: "mb-btn", type: "button", "data-tip": "Discard recording", "aria-label": "Discard recording", onclick: () => stopVoice(false) }, "✕"),
    h("span", { class: "mb-dot", "aria-hidden": "true" }), recTime, h("span", { class: "mb-lv", "aria-hidden": "true" }, lvBars), recHint);
  // each mode hides behind a button (text, voice); tooltips on hover / long-press
  const mic = h("button", { class: "mb-btn mb-ic mb-mic", type: "button", "data-tip": "Voice message (Alt+V)", "aria-label": "Voice message", onclick: () => toggleVoice() }, svg(MIC));
  const keys = h("button", { class: "mb-btn mb-ic mb-keys", type: "button", "data-tip": "Type a message (Alt+M)", "aria-label": "Type a message", onclick: () => openText() }, svg(KEYS));
  const send = h("button", { class: "mb-btn mb-ic mb-send", type: "submit", "data-tip": "Send (Enter)", "aria-label": "Send" }, svg(SEND));
  const close = h("button", { class: "mb-btn mb-close", type: "button", "data-tip": "Close the text field", "aria-label": "Close the text field", onclick: () => closeText() }, "✕");
  const modes = h("div", { class: "mb-modes" }, attach, keys, mic);
  // sending while the target is busy: queue it (default) or send it now; anchored at the send button
  const queueBtn = h("button", { class: "mb-btn mb-def", type: "button", "data-tip": "Runs after the current answer (Enter, Esc)", onclick: () => answer("queue") }, "Queue");
  const nowBtn = h("button", { class: "mb-btn", type: "button", "data-tip": "Adds it to the running answer if the agent can take it, else stops that answer and sends this one at once",
    onclick: () => answer("now") }, "Send now");
  const when = h("div", { class: "mb-when", role: "dialog", "aria-label": `${ctx.app?.agentName || "The agent"} is still busy`, hidden: true }, queueBtn, nowBtn);
  const form = h("form", { class: "mb", onsubmit: e => { e.preventDefault(); sendNow(); } },
    tray, note, pick, h("div", { class: "mb-row" }, to, modes, close, ta, recBar, send, when), picker, photos, camera);

  const say = (text, isError) => { note.hidden = !text; note.textContent = text || ""; note.classList.toggle("bad", !!isError); };

  // ------------------------------------------------------------ targets
  const isShown = t => { try { return !t.shown || !!t.shown(); } catch { return false; } };
  const shownTargets = () => [...targets.values()].filter(isShown);
  function drawTarget() {
    const t = targets.get(current), many = shownTargets().length > 1;
    to.hidden = !t || !many;
    if (t) {
      to.textContent = t.label?.() ?? t.id;
      to.dataset.tip = `Talking to: ${to.textContent}. Tap to switch`;
      to.setAttribute("aria-label", to.dataset.tip);
      ta.placeholder = t.placeholder?.() || `Message ${ctx.app?.agentName || "the agent"}`;
    }
    form.dataset.target = current;
    for (const fn of changes) try { fn(current, many); } catch (e) { console.error(e); }
  }
  function focus(id) { if (targets.has(id)) { current = id; drawTarget(); } }
  function cycle() {
    const list = shownTargets(), i = list.findIndex(t => t.id === current);
    if (list.length > 1) focus(list[(i + 1) % list.length].id);
  }
  function offer(t) {
    targets.set(t.id, t);
    if (!current) current = t.id;
    drawTarget();
    return () => { targets.delete(t.id); if (current === t.id) current = targets.keys().next().value || ""; drawTarget(); };
  }
  addEventListener("resize", () => drawTarget());

  // the focused target; when it is off screen (phone), the one that is shown
  const aim = () => { const cur = targets.get(current); return cur && isShown(cur) ? cur : shownTargets()[0] || cur; };
  async function deliver(input) {
    const t = aim();
    if (!t) throw new Error("nothing on screen takes input");
    await t.send(input);
  }

  // "" = the target is idle (no choice), else what the user picked; nothing they send is ever lost
  function whenMode() {
    let busy = false;
    try { busy = !!aim()?.busy?.(); } catch { /* treat as idle */ }
    if (!busy) return Promise.resolve("");
    when.hidden = false; queueBtn.focus({ preventScroll: true });
    return new Promise(res => { b.asking = res; });
  }
  function answer(mode) {
    const res = b.asking;
    if (!res) return;
    b.asking = null; when.hidden = true;
    res(mode);
  }
  addEventListener("keydown", e => {
    if (!b.asking || (e.key !== "Escape" && e.key !== "Enter")) return;
    if (e.key === "Enter" && document.activeElement === nowBtn) return; // the focused button decides
    e.preventDefault(); e.stopPropagation(); answer("queue");
  }, true);
  addEventListener("pointerdown", e => { if (b.asking && !when.contains(e.target)) answer("queue"); }, true);

  // ------------------------------------------------------------ attachments
  function addFiles(files) {
    for (const file of files) {
      if (file.size > MAX_MB * 1048576) { say(`${file.name || "That file"} is too big to attach (${size(file.size)}; limit ${MAX_MB} MB).`, true); continue; }
      const p = { file, url: IMAGE.test(file.type) ? URL.createObjectURL(file) : "", id: "", error: "" };
      b.pending.push(p);
      p.upload = ctx.upload(file).then(it => { p.id = it.id; }, e => { p.error = e.message; drawTray(); });
    }
    drawTray();
  }

  function drawTray() {
    tray.hidden = !b.pending.length; form.classList.toggle("has-files", !!b.pending.length);
    tray.replaceChildren(...b.pending.map(p => {
      const what = p.url ? "image" : "file";
      const rm = h("button", { class: "mb-btn", type: "button", "data-tip": `Remove ${what}`, "aria-label": `Remove ${what}`, onclick: () => {
        b.pending = b.pending.filter(x => x !== p); if (p.url) URL.revokeObjectURL(p.url); drawTray();
      } }, "✕");
      return p.url
        ? h("figure", { class: p.error ? "bad" : "" }, h("img", { src: p.url, alt: "image to send" }), rm)
        : h("figure", { class: "mb-chip" + (p.error ? " bad" : ""), "data-tip": `${p.file.name || "file"} (${size(p.file.size)})` },
          svg(FILE), h("span", {}, p.file.name || "file"), h("small", {}, size(p.file.size)), rm);
    }));
  }

  // tap-time feedback: blip + a pulse class on the bar; the message then slides in (the view's part)
  function sentFx() {
    blip();
    form.classList.remove("sent"); void form.offsetWidth; form.classList.add("sent");
    setTimeout(() => form.classList.remove("sent"), 1000);
  }

  function openText() { form.classList.add("typing"); ta.focus(); }
  function closeText() { if (!ta.value.trim()) { form.classList.remove("typing"); ta.blur(); } }
  ta.addEventListener("blur", () => setTimeout(() => { if (!ta.value.trim() && document.activeElement !== ta) form.classList.remove("typing"); }, 150));

  addEventListener("paste", e => {
    if (e.target !== ta && e.target.closest?.("input, textarea")) return;
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    addFiles(files.map((f, i) => f.name && f.name !== "image.png" ? f
      : new File([f], `pasted-${Date.now()}${i ? "-" + i : ""}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`, { type: f.type })));
  });
  for (const inp of [picker, photos, camera]) inp.addEventListener("change", () => { addFiles([...inp.files]); inp.value = ""; });
  addEventListener("pointerdown", e => { if (!pick.hidden && !pick.contains(e.target) && !attach.contains(e.target)) pick.hidden = true; });
  addEventListener("keydown", e => { if (e.key === "Escape") pick.hidden = true; });
  // drop anywhere in the app: the whole screen shows the drop hint
  app.addEventListener("dragover", e => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); app.classList.add("mb-drop"); } });
  app.addEventListener("dragleave", e => { if (!app.contains(e.relatedTarget)) app.classList.remove("mb-drop"); });
  app.addEventListener("drop", e => {
    app.classList.remove("mb-drop");
    if (!e.dataTransfer.files.length) return;
    e.preventDefault(); addFiles([...e.dataTransfer.files]);
  });

  // ------------------------------------------------------------ sending
  const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, innerHeight * 0.4) + "px"; };
  ta.addEventListener("input", grow);
  ta.addEventListener("keydown", e => {
    const touch = matchMedia("(pointer: coarse)").matches;
    if (e.key === "Enter" && !e.shiftKey && !touch && !e.isComposing) { e.preventDefault(); sendNow(); }
  });

  async function sendNow() {
    if (b.recording) return stopVoice(true);
    const text = ta.value.trim();
    if (b.sending || b.asking || (!text && !b.pending.length)) return;
    const mode = await whenMode();
    b.sending = true; form.classList.add("busy"); say(""); sentFx();
    try {
      await Promise.all(b.pending.map(p => p.upload));
      const failed = b.pending.find(p => p.error);
      if (failed) throw new Error(`upload of ${failed.file.name || "a file"} failed: ${failed.error}`);
      await deliver({ text, files: b.pending.map(p => p.id), ...(mode ? { mode } : {}) });
      ta.value = ""; grow(); if (document.activeElement !== ta) form.classList.remove("typing");
      b.pending.forEach(p => p.url && URL.revokeObjectURL(p.url)); b.pending = []; drawTray();
    } catch (e) { say(`Not sent: ${e.message}`, true); }
    finally { b.sending = false; form.classList.remove("busy"); }
  }

  // ------------------------------------------------------------ voice
  const SHAPE = [0.55, 0.8, 1, 0.8, 0.55];
  async function toggleVoice() { b.recording ? stopVoice(true) : startVoice(); }

  const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  let left = Infinity;
  async function startVoice() {
    say(""); left = Infinity;
    try {
      b.recording = "starting";
      b.recording = await startRecording({
        onTick: s => {
          recTime.textContent = clock(s);
          left = MAX_SECONDS - s; // the last 30 s count down to the automatic send
          if (left <= 30) recHint.textContent = `sends in ${Math.max(0, Math.ceil(left))} s`;
        },
        onLevel: (lv, quiet) => {
          lvBars.forEach((u, i) => { u.style.transform = `scaleY(${Math.max(0.15, Math.min(1, lv * SHAPE[i] * (0.85 + Math.random() * 0.3)))})`; });
          recBar.classList.toggle("quiet", quiet);
          if (left > 30) recHint.textContent = quiet ? "no mic signal" : "recording";
        },
        onLimit: () => stopVoice(true), // the recorder stopped at its limit: send what we have
      });
      recTime.textContent = "0:00"; form.classList.add("rec"); recBar.hidden = false;
    } catch (e) { b.recording = null; say(e.message, true); }
  }

  async function stopVoice(keep) {
    const rec = b.recording;
    if (!rec || rec === "starting") return;
    b.recording = null; form.classList.remove("rec"); recBar.hidden = true;
    const file = keep ? await rec.stop() : await rec.cancel();
    if (!file) return keep && say("Nothing was recorded.", true);
    sentFx(); form.classList.add("sending");
    const files = b.pending; // attachments waiting in the tray go with the voice message
    try {
      const voice = await ctx.upload(file);
      await Promise.all(files.map(p => p.upload));
      const failed = files.find(p => p.error);
      if (failed) throw new Error(`upload of ${failed.file.name || "a file"} failed: ${failed.error}`);
      const mode = await whenMode();
      await deliver({ text: ta.value.trim(), voice: voice.id, files: files.map(p => p.id), ...(mode ? { mode } : {}) });
      form.classList.remove("sending");
      ta.value = ""; grow();
      files.forEach(p => p.url && URL.revokeObjectURL(p.url));
      b.pending = b.pending.filter(p => !files.includes(p)); drawTray();
    } catch (e) {
      form.classList.remove("sending");
      say(`Voice message not sent: ${e.message}`, true);
      // keep the clip reachable: offer it as a download
      note.append(" ", h("a", { href: URL.createObjectURL(file), download: file.name }, "save recording"));
    }
  }

  addEventListener("keydown", e => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    if (k === "v") { e.preventDefault(); toggleVoice(); }
    else if (k === "m") { e.preventDefault(); openText(); }
  });

  return { el: form, offer, focus, focused: () => current, say, refresh: drawTarget, deliver,
    onChange: fn => { changes.add(fn); return () => changes.delete(fn); } };
}

// Themed tooltips for every [data-tip] in the app: hover on a mouse, hold on
// touch (the hold does not also tap). Placed above the element, or below it
// when that would leave the screen (header buttons).
export function tooltips(scope) {
  const tip = h("div", { class: "k-tip", role: "tooltip", hidden: true });
  document.body.append(tip);
  let tipTimer = 0, held = false;
  const showTip = el => {
    tip.textContent = el.dataset.tip; tip.hidden = false;
    const r = el.getBoundingClientRect(), w = tip.offsetWidth;
    tip.style.left = Math.max(4, Math.min(innerWidth - w - 4, r.left + r.width / 2 - w / 2)) + "px";
    const above = r.top - tip.offsetHeight - 6;
    tip.style.top = (above >= 4 ? above : r.bottom + 6) + "px";
  };
  const hideTip = () => { clearTimeout(tipTimer); tip.hidden = true; };
  scope.addEventListener("pointerover", e => { const el = e.target.closest("[data-tip]"); if (el && e.pointerType === "mouse") { clearTimeout(tipTimer); tipTimer = setTimeout(() => showTip(el), 350); } });
  scope.addEventListener("pointerout", e => { if (e.pointerType === "mouse") hideTip(); });
  let start = null; // a hold is a tooltip, a drag (resizing the embedded chat, scrolling) is not
  scope.addEventListener("pointerdown", e => { const el = e.target.closest("[data-tip]"); held = false; start = [e.clientX, e.clientY]; if (el && e.pointerType !== "mouse") tipTimer = setTimeout(() => { held = true; showTip(el); }, 450); });
  scope.addEventListener("pointermove", e => { if (start && e.buttons && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 8) { start = null; held = false; hideTip(); } });
  scope.addEventListener("pointerup", e => { if (e.pointerType !== "mouse") { clearTimeout(tipTimer); if (held) setTimeout(hideTip, 1200); } });
  scope.addEventListener("pointercancel", hideTip);
  scope.addEventListener("contextmenu", e => { if (e.target.closest("[data-tip]")) e.preventDefault(); });
  scope.addEventListener("click", e => { if (held) { held = false; e.preventDefault(); e.stopPropagation(); } }, true);
}
