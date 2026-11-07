// Service "agent" backed by the Hermes API server (gateway platform api_server).
//
// Per conversation one Hermes session (POST /api/sessions). A turn is a
// background run (POST /v1/runs, Idempotency-Key = turn key) followed through
// its event stream (GET /v1/runs/<id>/events). The run lives inside Hermes, so
// after a kernel restart resume() follows the same run again (GET /v1/runs/<id>).
//
// Config (plugins.agent-hermes):
//   agents: [{ id, name, url, keyEnv, titlePrefix? }]   keyEnv = env var holding the API key
//   timeoutSeconds: liveness limit without any sign of life (default 600)
//   filesUrl: where the agent (same machine) downloads attachments
//             (default http://127.0.0.1:8180/k/files)
//
// Attachments: images go as vision input; small text files are inlined; every
// file is listed with a download URL so the agent can read anything else
// (PDF, office, zip, audio) with its own tools.
import type {
  AgentEvent, AgentService, AgentTurn, AttachedFile, Kernel, ServerPlugin,
} from "../../kernel/contract.ts";

interface AgentConfig { id: string; name: string; url: string; keyEnv: string; titlePrefix?: string }

const VISION = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const VISION_BUDGET = 6 * 1024 * 1024; // Hermes caps a request at 10 MB; base64 grows by 4/3
const POLL_MS = 2000;
const TEXT = /^text\/|^application\/(json|xml|x-yaml|yaml|csv|x-sh|javascript|x-python|toml|x-tex)\b|\+(json|xml)$/;
const TEXT_EXT = /\.(txt|md|org|csv|tsv|json|ya?ml|toml|xml|html?|css|js|ts|py|sh|el|nix|tex|bib|log|ini|cfg|conf)$/i;
const INLINE_BUDGET = 100 * 1024; // text inlined per turn, all files together
let filesUrl = "http://127.0.0.1:8180/k/files";

/** Text of a small text file, or null (binary, too big, not valid UTF-8). */
function asText(f: AttachedFile, budget: number): string | null {
  if (f.bytes.length > budget || !(TEXT.test(f.mime) || TEXT_EXT.test(f.name))) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(f.bytes); } catch { return null; }
}

/** One user turn as OpenAI-style content: text, a list of attached files, image parts. */
export function content(text: string, files: AttachedFile[], base = filesUrl): string | object[] {
  if (!files.length) return text;
  let budget = VISION_BUDGET, inline = INLINE_BUDGET;
  const parts: object[] = [], notes: string[] = [], texts: string[] = [];
  for (const f of files) {
    const url = f.id ? ` download: ${base.replace(/\/+$/, "")}/${encodeURIComponent(f.id)}` : "";
    notes.push(`- ${f.name} (${f.mime}, ${f.bytes.length} bytes)${url}`);
    const t = VISION.has(f.mime) ? null : asText(f, inline);
    if (t !== null) { inline -= f.bytes.length; texts.push(`[${f.name}]\n${t}\n[end of ${f.name}]`); }
    if (VISION.has(f.mime) && f.bytes.length <= budget) {
      budget -= f.bytes.length;
      parts.push({ type: "image_url", image_url: { url: `data:${f.mime};base64,${Buffer.from(f.bytes).toString("base64")}` } });
    }
  }
  const how = files.some(f => f.id) ? "\n(Images are attached for viewing and text files are inlined below; fetch any other file from its download URL, e.g. curl -s <url> -o /tmp/<name>, then read it with a suitable tool such as pdftotext.)" : "";
  return [{ type: "text", text: (text ? text + "\n\n" : "") + "[Attached files]\n" + notes.join("\n") + how
    + (texts.length ? "\n\n" + texts.join("\n\n") : "") }, ...parts];
}

class HermesAgent {
  constructor(readonly cfg: AgentConfig, readonly author: { id: string; name: string }, readonly timeoutMs: number) {}

  private headers(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${process.env[this.cfg.keyEnv] ?? ""}`, "content-type": "application/json", ...extra };
  }

  private async call(path: string, init: RequestInit = {}, ms = 60000): Promise<Response> {
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
    const r = await fetch(this.cfg.url.replace(/\/+$/, "") + path, { ...init, headers: this.headers(init.headers as any), signal });
    if (r.status === 401 || r.status === 403) throw new Error(`agent rejected the API key (HTTP ${r.status})`);
    return r;
  }

  private async newSession(turn: AgentTurn): Promise<string> {
    const id = `sleipnyr2-${turn.conversation}-${crypto.randomUUID().slice(0, 8)}`;
    const title = `${this.cfg.titlePrefix ?? "sleipnyr2"} ${turn.title.slice(0, 60)} ${id.slice(-8)}`.trim();
    const r = await this.call("/api/sessions", { method: "POST", body: JSON.stringify({ id, title, source: "api_server" }), signal: turn.signal });
    if (!r.ok) throw new Error(`could not open an agent session (HTTP ${r.status}: ${(await r.text()).slice(0, 160)})`);
    return id;
  }

  private async startRun(session: string, turn: AgentTurn, key: string): Promise<string | null> {
    const body = { session_id: session, author: { ...this.author, is_bot: false },
      input: [{ role: "user", content: content(turn.text, turn.files) }] };
    const r = await this.call("/v1/runs", { method: "POST", headers: { "idempotency-key": key }, body: JSON.stringify(body), signal: turn.signal });
    if (r.status === 404 && (await r.clone().text()).toLowerCase().includes("session")) return null; // session gone
    if (!r.ok) throw new Error(`agent refused the message (HTTP ${r.status}: ${(await r.text()).slice(0, 160)})`);
    return (await r.json() as { run_id: string }).run_id;
  }

  /** One-shot completion (no session, no stream) through the same API server: a thread title, or throws. */
  async title(transcript: string, signal?: AbortSignal): Promise<string> {
    const r = await this.call("/v1/chat/completions", { method: "POST", signal, body: JSON.stringify({ messages: [
      { role: "system", content: "You name chat threads. Reply with ONLY a title of at most 6 words (at most 40 characters) "
        + "that summarises what the whole conversation is about now. No quotes, no markdown, no tools, no final period." },
      { role: "user", content: transcript }] }) }, 120000);
    if (!r.ok) throw new Error(`title call failed (HTTP ${r.status})`);
    const j: any = await r.json();
    return String(j?.choices?.[0]?.message?.content ?? "");
  }

  /** Adds a message to the running run (POST /v1/runs/<id>/steer); false = no run or not taken. */
  async steer(state: Record<string, unknown>, text: string): Promise<boolean> {
    const run = state.run_id as string | undefined;
    if (!run) return false;
    const r = await this.call(`/v1/runs/${run}/steer`, { method: "POST", body: JSON.stringify({ input: text }) }, 15000);
    if (!r.ok) return false;
    return (await r.json().catch(() => ({})) as { accepted?: boolean }).accepted === true;
  }

  /** Ends a run (POST /v1/runs/<id>/stop); a failure is only logged. */
  private async stopRun(run: string) {
    try {
      const r = await this.call(`/v1/runs/${run}/stop`, { method: "POST", body: "{}" }, 10000);
      if (!r.ok) console.error(`agent-hermes: stopping run ${run} answered HTTP ${r.status}`);
    } catch (e) { console.error(`agent-hermes: stopping run ${run} failed:`, (e as Error).message); }
  }

  /** Follows a run; when the turn is cancelled, the run itself is stopped too. */
  private async *followOrStop(run: string, turn: AgentTurn): AsyncGenerator<AgentEvent> {
    try { yield* this.follow(run, turn.signal); }
    catch (e) { if (turn.cancel?.aborted) await this.stopRun(run); throw e; }
  }

  async *send(turn: AgentTurn): AsyncGenerator<AgentEvent> {
    turn = { ...turn, signal: both(turn) };
    const key = `sleipnyr2-${crypto.randomUUID()}`;
    let session = turn.state.session_id as string | undefined;
    if (!session) { session = await this.newSession(turn); yield { type: "state", state: { session_id: session } }; }
    let run = await this.startRun(session, turn, key);
    if (run === null) { // the agent forgot the session: open a new one
      session = await this.newSession(turn);
      yield { type: "state", state: { session_id: session } };
      run = await this.startRun(session, turn, key + "-2");
      if (run === null) throw new Error("agent session vanished twice");
    }
    yield { type: "state", state: { session_id: session, run_id: run } };
    yield* this.followOrStop(run, turn);
  }

  async *resume(turn: AgentTurn): AsyncGenerator<AgentEvent> {
    const run = turn.state.run_id as string | undefined;
    if (!run) { yield { type: "error", message: "the message never reached the agent; please send it again" }; return; }
    yield* this.followOrStop(run, { ...turn, signal: both(turn) });
  }

  /** A run's events until it settles: the live stream first, then polling its status. */
  private async *follow(run: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const idle = new AbortController();
    let timer = setTimeout(() => idle.abort(), this.timeoutMs);
    const alive = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(), this.timeoutMs); };
    try {
      const sig = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
      const r = await fetch(`${this.cfg.url.replace(/\/+$/, "")}/v1/runs/${run}/events`, { headers: this.headers(), signal: sig });
      if (r.ok && r.body) {
        const dec = new TextDecoder();
        let buf = "";
        for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
          alive();
          buf += dec.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            let e: any;
            try { e = JSON.parse(line.slice(5)); } catch { continue; }
            const ev = toEvent(e);
            if (ev) yield ev;
            if (ev?.type === "done" || ev?.type === "error") { r.body.cancel().catch(() => {}); return; }
          }
        }
      }
    } catch (e) {
      if (signal?.aborted) throw e; // the stream broke or went quiet: the status decides below
    } finally { clearTimeout(timer); }

    let lastSign = Date.now();
    while (true) {
      if (signal?.aborted) throw signal.reason;
      try {
        const r = await this.call(`/v1/runs/${run}`, { signal });
        if (r.status === 404) { yield { type: "error", message: "the agent forgot this run (agent restarted?)" }; return; }
        const s = await r.json() as { status: string; output?: string; error?: string; pending_steer?: string };
        lastSign = Date.now();
        if (s.status === "completed") { yield { type: "done", text: s.output || "", ...(s.pending_steer ? { unsent: String(s.pending_steer) } : {}) }; return; }
        if (["failed", "cancelled", "interrupted"].includes(s.status)) { yield { type: "error", message: `run ${s.status}: ${s.error || ""}`.trim() }; return; }
      } catch (e) {
        if (signal?.aborted) throw e;
        if (Date.now() - lastSign > this.timeoutMs) { yield { type: "error", message: "agent unreachable" }; return; }
      }
      await Bun.sleep(POLL_MS);
    }
  }
}

/** The turn's signals as one: the kernel stopping or the turn cancelled. */
const both = (t: AgentTurn) => AbortSignal.any([t.signal, t.cancel].filter((x): x is AbortSignal => !!x));

const shorten = (s: unknown, n = 90) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/** A Hermes run event -> a contract AgentEvent (or null if it is not shown). */
export function toEvent(e: any): AgentEvent | null {
  switch (e?.event) {
    case "message.delta": return e.delta ? { type: "delta", text: e.delta } : null;
    case "run.queued": return { type: "progress", text: "queued behind an earlier message" };
    case "tool.started": return { type: "progress", text: shorten(`${e.tool || "tool"}${e.preview ? " · " + shorten(e.preview, 70) : ""}`) };
    case "message.interim": return e.already_streamed ? null : { type: "progress", text: shorten(e.text) };
    case "subagent.start": return { type: "progress", text: shorten(`subagent · ${e.goal || e.preview || "started"}`) };
    case "run.completed": return { type: "done", text: e.output || "", ...(e.pending_steer ? { unsent: String(e.pending_steer) } : {}) };
    case "run.failed": case "run.cancelled": case "run.interrupted":
      return { type: "error", message: `${e.event}${e.error ? ": " + e.error : ""}`.slice(0, 300) };
    default: return null;
  }
}

let agents = new Map<string, HermesAgent>();

const plugin: ServerPlugin = {
  start(k: Kernel) {
    const list = (k.config.agents || []) as AgentConfig[];
    const timeoutMs = Number(k.config.timeoutSeconds || 600) * 1000;
    if (k.config.filesUrl) filesUrl = String(k.config.filesUrl);
    agents = new Map(list.map(a => [a.id, new HermesAgent(a, k.user, timeoutMs)]));
    for (const a of list) if (!process.env[a.keyEnv]) k.log(`warning: ${a.keyEnv} is not set; agent ${a.id} will refuse`);
    const get = (id: string) => { const a = agents.get(id); if (!a) throw new Error(`unknown agent ${id}`); return a; };
    const service: AgentService = {
      agents: () => list.map(a => ({ id: a.id, name: a.name })),
      send: (id, turn) => get(id).send(turn),
      resume: (id, turn) => get(id).resume(turn),
      title: (id, transcript, signal) => get(id).title(transcript, signal),
      steer: (id, state, text) => get(id).steer(state, text),
    };
    k.services.provide("agent", service);
  },
};
export default plugin;
