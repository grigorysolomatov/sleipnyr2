// Hands-free talk: the two server halves of a spoken turn.
//   POST /p/talk/hear   body = one turn of speech (audio/wav from the page)
//                       -> {file, text, seconds}: saved as a file item and
//                       transcribed by the fast model (the page then posts it
//                       to the thread as a voice message with that transcript)
//   POST /p/talk/speak  {text} -> audio/wav: one sentence of the reply, spoken
// Config (plugins.talk): hearUrl (the transcriber's fast path), speakUrl (the
// Kokoro sidecar, tools/speak), maxSeconds (longest turn, default 120).
import type { Kernel, ServerPlugin } from "../../kernel/contract.ts";

const HEAR = "http://127.0.0.1:8181/api/transcribe?fast=1";
const SPEAK = "http://127.0.0.1:8182/api/speak";
const MAX_TEXT = 600; // one sentence or two: the page speaks the reply in pieces

const fail = (error: string, status: number) => Response.json({ error }, { status });

/** The reply text as it should sound: no markup, links, action or media lines. */
export function speakable(text: string): string {
  return text
    .split("\n").filter(l => !/^\s*(@[a-z-]+\b|MEDIA:)/.test(l)).join("\n")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/[*_`#>|~]+/g, " ")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ").trim();
}

const plugin: ServerPlugin = {
  routes(k: Kernel) {
    const hearUrl = String(k.config.hearUrl || HEAR), speakUrl = String(k.config.speakUrl || SPEAK);
    const maxBytes = Math.min(600, Number(k.config.maxSeconds || 120)) * 32_000 + 1024; // 16 kHz 16-bit mono
    return {
      "POST /hear": async req => {
        const audio = new Uint8Array(await req.arrayBuffer());
        if (audio.length < 1000) return fail("no audio", 400);
        if (audio.length > maxBytes) return fail("turn too long", 413);
        const mime = (req.headers.get("content-type") || "audio/wav").split(";")[0];
        if (!/^audio\/[a-z0-9.+-]+$/.test(mime)) return fail("not audio", 415);
        let out: { text?: string; seconds?: number; detail?: string };
        try {
          const r = await fetch(hearUrl, { method: "POST", body: audio, headers: { "content-type": mime }, signal: AbortSignal.timeout(60_000) });
          out = await r.json().catch(() => ({}));
          if (!r.ok) return fail(out.detail || `transcriber HTTP ${r.status}`, 502);
        } catch (e) {
          return fail(`transcriber unreachable (${(e as Error).name})`, 502);
        }
        const text = String(out.text || "").trim();
        // silence or noise is not kept; a real turn becomes the message's voice file
        const file = text ? k.files.put(`talk-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.wav`, mime, audio).id : null;
        return Response.json({ file, text, seconds: out.seconds });
      },
      "POST /speak": async req => {
        const b = await req.json().catch(() => ({})) as { text?: string; voice?: string };
        const text = speakable(String(b.text || "")).slice(0, MAX_TEXT);
        if (!text) return fail("nothing to say", 400);
        try {
          const r = await fetch(speakUrl, { method: "POST", body: JSON.stringify({ text, ...(b.voice ? { voice: String(b.voice) } : {}) }),
            headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(30_000) });
          if (!r.ok) return fail(`speech HTTP ${r.status}`, 502);
          return new Response(await r.arrayBuffer(), { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
        } catch (e) {
          return fail(`speech unreachable (${(e as Error).name})`, 502);
        }
      },
    };
  },
};
export default plugin;
