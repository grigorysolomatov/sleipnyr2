// Recording context: what the person saw and did while recording a voice
// message (kernel/web/recctx.js logs it in the page). The chat stores a
// cleaned copy on the user message (data.recording) and adds a short
// timeline block to what the agent gets for that message. Switched by the
// feature "recordingContext": off = nothing is stored or sent.

export interface RecEvent { t: number; text: string }
export interface RecSnap { t: number; why?: string; text: string }
export interface Recording { v: 1; ms: number; events: RecEvent[]; snaps: RecSnap[] }

export const FEATURE = "recordingContext";
const EVENTS_MAX = 80, TEXT_MAX = 240, SNAP_MAX = 2500, SNAPS_MAX = 4, BUDGET = 8000;
const num = (x: unknown, max: number) => Math.max(0, Math.min(max, Math.round(Number(x) || 0)));
const str = (x: unknown, n: number) => String(x ?? "").replace(/[\u0000-\u0008\u000b-\u001f]/g, " ").slice(0, n);
const oneLine = (x: unknown, n: number) => str(x, n).replace(/\s+/g, " ").trim();

/** A recording log from a page, cut to size and shape; null when there is nothing in it. */
export function cleanRecording(x: unknown): Recording | null {
  if (!x || typeof x !== "object") return null;
  const r = x as { ms?: unknown; events?: unknown; snaps?: unknown };
  const ms = num(r.ms, 6 * 3600e3);
  const events = (Array.isArray(r.events) ? r.events : []).slice(0, EVENTS_MAX + 1)
    .map(e => ({ t: num((e as RecEvent)?.t, ms || 6 * 3600e3), text: oneLine((e as RecEvent)?.text, TEXT_MAX) })).filter(e => e.text);
  const snaps = (Array.isArray(r.snaps) ? r.snaps : []).slice(0, SNAPS_MAX)
    .map(s => ({ t: num((s as RecSnap)?.t, ms || 6 * 3600e3), why: oneLine((s as RecSnap)?.why, 20), text: str((s as RecSnap)?.text, SNAP_MAX).trim() }))
    .filter(s => s.text);
  if (!events.length && !snaps.length) return null;
  const out: Recording = { v: 1, ms, events, snaps };
  while (out.snaps.length && JSON.stringify(out).length > BUDGET + 1000) out.snaps.pop();
  return out;
}

/** 0:07, 1:23 */
export const clock = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/**
 * The block the agent gets after the message, e.g.
 *   [While recording (0:41): 0:00 on Columns 'Work' ...; 0:12 column on screen: c2 'Misc'; 0:30 folded p6 'Jobs']
 * followed, only when the user went to another view meanwhile, by what the
 * page showed at the start / end (view_describe text), leaving out a
 * snapshot the message's context already holds. In one view the timeline
 * plus the view's own context says it already.
 */
export function recordingNote(r: Recording | null | undefined, context = ""): string {
  if (!r || (!r.events?.length && !r.snaps?.length)) return "";
  const line = r.events.map(e => `${clock(e.t)} ${e.text}`).join("; ");
  const head = `[While recording this voice message (${clock(r.ms)} long), ${"what the user saw and did on the page"}`
    + `${line ? `: ${line}` : ""}]`;
  const moved = r.events.some(e => e.text.startsWith("now on "));
  const snaps = (moved ? r.snaps || [] : []).filter(s => !context.includes(s.text))
    .map(s => `[On screen at ${clock(s.t)}${s.why ? ` (${s.why})` : ""}:]\n${s.text}`);
  return [head, ...snaps].join("\n");
}
