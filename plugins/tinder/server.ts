// Task Tinder: agent suggestions as a card stack; swipe right = accept (the
// task is queued as a Kanban card that actually runs), left = reject (kept,
// sinks, comes back later). Nothing is ever deleted.
//
// Saved items:
//   suggestion {title, why, board, tier, cost, key, state, score, rejects, until?, card?, verdicts}
//     state   "queued" | "accepted" | "rejected" | "archived" (set by hand, e.g. test items: out of stack and history)
//     key     normalised words of the title: a rewording of a known task is the same task
//     score   1 when new; each reject halves it, so repeated rejects sink further
//     until   (rejected) ms; after it the card is back in the stack, below the fresh ones
//     card    the Kanban task id made on accept, with its board
//     verdicts [{at, verdict}] what the user did with it, for the agent's next round
//
// Routes (/p/tinder):
//   GET  /settings             {tiers: {id: {label, doc}}, defaultTier, defaultBoard, sources} for the view
//   GET  /queue[?now=ms]       the stack (best first) + counts; now = look ahead (tests)
//   GET  /history              decided suggestions, newest first (for the agent)
//   POST /suggest              {title, why, board, tier, cost} -> {item, merged, skipped?}
//   POST /:id/accept           -> {item, card}   creates the Kanban card
//   POST /:id/reject           -> {item}
//
// Config (plugins.tinder): kanbanUrl (default http://127.0.0.1:9120, the
//   allowlist kanban-proxy), keyEnv (default KANBAN_PROXY_KEY), assignee
//   (default "default"), defaultBoard (default "default"),
//   cooldownHours (default 24; the n-th reject waits 24 h * 3^(n-1)),
//   tiers {id: {model?, provider?, label, doc?}} (defaultTier names the default,
//   else the first; no
//   model = the assignee profile's own model), rules [lines added to every
//   accepted card; "{user}" = the user's name], sources (extra places the agent
//   should look for ideas, e.g. a notes folder; one phrase), apiUrl (how the agent
//   reaches this app, default http://127.0.0.1:8180).
import { bad, type Item, type Kernel, type ServerPlugin } from "../../kernel/contract.ts";

export interface Tier { model?: string; provider?: string; label: string; doc?: string }
/** Used when the config names no tiers: the card runs on the assignee profile's own model. */
export const DEFAULT_TIERS: Record<string, Tier> = { default: { label: "Default model" } };
export const DEFAULT_RULES = ["Hard rule: no email or contact with anyone without {user}'s per-message OK. Produce drafts only; never send."];

export interface Suggestion {
  title: string; why: string; board: string; tier: string; cost: string; key: string;
  state: "queued" | "accepted" | "rejected" | "archived"; score: number; rejects: number; until?: number;
  card?: { id: string; board: string }; verdicts: { at: number; verdict: "accept" | "reject" }[];
}

const STOP = new Set("a an the and or of for to in on at by with from into my his your our this that these those is be it as up out new".split(" "));
/** Words that carry the meaning, crudely stemmed and sorted: the same task reworded gives (nearly) the same key. */
export function keyOf(title: string): string {
  const words = String(title).toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")
    .filter(w => w && !STOP.has(w)).map(w => w.replace(/(ing|ed|es|s)$/, "").slice(0, 8)).filter(w => w.length > 1);
  return [...new Set(words)].sort().join(" ");
}
/** Same task: the word sets overlap by at least 60 % (Jaccard), or one contains the other. */
export function sameTask(a: string, b: string): boolean {
  const x = new Set(a.split(" ").filter(Boolean)), y = new Set(b.split(" ").filter(Boolean));
  if (!x.size || !y.size) return false;
  const both = [...x].filter(w => y.has(w)).length;
  return both / (x.size + y.size - both) >= 0.6 || (both === Math.min(x.size, y.size) && both >= 2);
}

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

class Refused extends Error { constructor(readonly status: number, message: string) { super(message); } }

export class Tinder {
  constructor(readonly k: Kernel, readonly create: (body: Record<string, unknown>, board: string) => Promise<string>) {}
  private cfg = (n: string, d: unknown) => (this.k.config[n] ?? d);
  tiers(): Record<string, Tier> {
    const t = this.k.config.tiers as Record<string, Tier> | undefined;
    return t && typeof t === "object" && Object.keys(t).length ? t : DEFAULT_TIERS;
  }
  defaultTier() { const t = this.tiers(), d = String(this.cfg("defaultTier", "")); return t[d] ? d : Object.keys(t)[0]; }
  settings() {
    const tiers = Object.fromEntries(Object.entries(this.tiers()).map(([id, t]) => [id, { label: t.label || id, doc: t.doc || "" }]));
    return { tiers, defaultTier: this.defaultTier(), defaultBoard: String(this.cfg("defaultBoard", "default")),
      assignee: String(this.cfg("assignee", "default")), sources: String(this.cfg("sources", "")),
      apiUrl: String(this.cfg("apiUrl", "http://127.0.0.1:8180")).replace(/\/+$/, "") };
  }
  all() { return this.k.items.list<Suggestion>({ type: "suggestion", order: "created", limit: 10000 }); }
  get(id: string) {
    const s = this.k.items.get<Suggestion>(id);
    if (!s || s.type !== "suggestion") throw new Refused(404, "no such suggestion");
    return s;
  }

  /** The stack: fresh ones by score, then rejected ones whose cooldown has passed (lower score). */
  queue(now = Date.now()) {
    const all = this.all();
    const live = all.filter(s => s.data.state === "queued" || (s.data.state === "rejected" && (s.data.until || 0) <= now));
    live.sort((a, b) => b.data.score - a.data.score || a.created - b.created);
    return { cards: live, counts: { accepted: all.filter(s => s.data.state === "accepted").length,
      rejected: all.filter(s => s.data.state === "rejected").length, waiting: all.filter(s => s.data.state === "rejected" && (s.data.until || 0) > now).length } };
  }
  history() {
    return this.all().filter(s => s.data.verdicts?.length && s.data.state !== "archived").sort((a, b) => b.updated - a.updated).slice(0, 60);
  }

  suggest(b: Record<string, unknown>) {
    const title = clip(b.title, 120), why = clip(b.why, 240);
    if (!title) throw new Refused(400, "title is required");
    const key = keyOf(title);
    const tier = this.tiers()[String(b.tier)] ? String(b.tier) : this.defaultTier();
    const board = SLUG.test(String(b.board || "")) ? String(b.board) : String(this.cfg("defaultBoard", "default"));
    const cost = clip(b.cost, 40);
    const known = this.all().find(s => sameTask(s.data.key, key));
    if (known) {
      // a rewording of a known task is that task: accepted stays done, a rejected one keeps its score and cooldown
      if (known.data.state === "queued") return { item: this.k.items.update<Suggestion>(known.id, { why: why || known.data.why, cost: cost || known.data.cost }), merged: true };
      return { item: known, merged: true, skipped: known.data.state === "accepted" ? "already accepted" : "rejected before; it comes back on its own" };
    }
    const item = this.k.items.create<Suggestion>("suggestion", { title, why, board, tier, cost, key, state: "queued", score: 1, rejects: 0, verdicts: [] });
    return { item, merged: false };
  }

  reject(id: string, now = Date.now()) {
    const s = this.get(id);
    if (s.data.state === "accepted") throw new Refused(409, "already accepted");
    const rejects = (s.data.rejects || 0) + 1, hours = Number(this.cfg("cooldownHours", 24));
    return this.k.items.update<Suggestion>(id, { state: "rejected", rejects, score: (s.data.score || 1) / 2,
      until: now + hours * 3600e3 * 3 ** (rejects - 1), verdicts: [...(s.data.verdicts || []), { at: now, verdict: "reject" }] });
  }

  private accepting = new Map<string, Promise<{ item: Item<Suggestion>; card: string }>>();
  accept(id: string) {
    let p = this.accepting.get(id);
    if (!p) { p = this.doAccept(id).finally(() => this.accepting.delete(id)); this.accepting.set(id, p); }
    return p;
  }
  private async doAccept(id: string) {
    const s = this.get(id);
    if (s.data.state === "accepted" && s.data.card) return { item: s, card: s.data.card.id };
    const tiers = this.tiers(), t = tiers[s.data.tier] || tiers[this.defaultTier()], d = s.data;
    const user = this.k.user?.name || "the user", agent = this.k.app?.agentName || "the agent";
    const rules = (Array.isArray(this.k.config.rules) ? this.k.config.rules as unknown[] : DEFAULT_RULES).map(r => String(r).replaceAll("{user}", user));
    const body = [
      `Accepted by ${user} in Sleipnyr 2 Task Tinder (swipe right) on ${new Date().toLocaleString("sv-SE").slice(0, 16)}.`,
      "", `Task: ${d.title}`, `Why (${agent}'s suggestion): ${d.why || "-"}`, `Rough cost: ${d.cost || "?"}; tier: ${t.label}.`, "",
      "Scope: do exactly this task. If it is underspecified, do the smallest sensible version and say so in the handoff.",
      ...rules,
      `Origin: Sleipnyr 2 suggestion ${id}.`,
    ].join("\n");
    const card = await this.create({ title: d.title, body, assignee: String(this.cfg("assignee", "default")),
      ...(t.model ? { model_override: t.model } : {}), ...(t.provider ? { provider_override: t.provider } : {}),
      workspace_kind: "scratch", // a board's project worktree may not be a git repo; the body names the task, the worker finds the files
      idempotency_key: `sleipnyr2-tinder-${id}` }, d.board);
    const item = this.k.items.update<Suggestion>(id, { state: "accepted", until: null, card: { id: card, board: d.board },
      verdicts: [...(d.verdicts || []), { at: Date.now(), verdict: "accept" }] });
    return { item, card };
  }
}

/** Creates a card through the allowlist kanban-proxy; returns its task id. */
export function proxyCreate(k: Kernel) {
  return async (body: Record<string, unknown>, board: string) => {
    const url = String(k.config.kanbanUrl || "http://127.0.0.1:9120").replace(/\/+$/, "");
    const key = process.env[String(k.config.keyEnv || "KANBAN_PROXY_KEY")] || "";
    if (!key) throw new Refused(503, "no Kanban key configured");
    const r = await fetch(`${url}/api/plugins/kanban/tasks?board=${encodeURIComponent(board)}`, {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000) });
    const out = await r.json().catch(() => ({})) as { task?: { id?: string }; detail?: unknown };
    if (!r.ok || !out.task?.id) throw new Refused(502, `Kanban refused (HTTP ${r.status}: ${clip(JSON.stringify(out.detail ?? out), 160)})`);
    return out.task.id;
  };
}

let tinder: Tinder | null = null;

const plugin: ServerPlugin = {
  start(k) { tinder = new Tinder(k, proxyCreate(k)); },
  routes: () => ({
    "GET /settings": () => Response.json(tinder!.settings()),
    "GET /queue": req => { const n = Number(new URL(req.url).searchParams.get("now")); return Response.json(tinder!.queue(n > 0 ? n : undefined)); },
    "GET /history": () => Response.json(tinder!.history()),
    "POST /suggest": async req => { try { return Response.json(tinder!.suggest(await req.json().catch(() => ({}))), { status: 201 }); } catch (e) { return bad(e); } },
    "POST /:id/accept": async (_r, p) => { try { return Response.json(await tinder!.accept(p.id)); } catch (e) { return bad(e); } },
    "POST /:id/reject": (_r, p) => { try { return Response.json({ item: tinder!.reject(p.id) }); } catch (e) { return bad(e); } },
  }),
};
export default plugin;
