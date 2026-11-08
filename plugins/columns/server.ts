// Columns: decisions on panels. Any panel of any board may carry a `decide`
// record; the view then shows Accept, Comment and Dismiss on it (a board of
// suggested tasks is the first user). A decision is recorded on the panel
// and handed to the agent: accept and comment make an unassigned Kanban card
// (nothing runs by itself; the agent picks it up), dismiss only archives the
// panel (recoverable: reopen). Nothing is ever deleted.
//
// Panel field (inside the board's columns item, panels[]):
//   decide {state: "open" | "accepted" | "dismissed", board?: Kanban board slug,
//           log: [{at, verdict, comment?, card?, error?}], card?: {id, board}}
//
// Routes (/p/columns):
//   POST /:board/decide   {panel, verdict: accept|dismiss|comment|reopen, comment?}
//                         -> {item, card?, error?}  (error: recorded, but the card failed)
//
// Config (plugins.columns): kanbanUrl (default http://127.0.0.1:9120, the
//   allowlist kanban-proxy), keyEnv (default KANBAN_PROXY_KEY), decideBoard
//   (default "default": the Kanban board when a panel names none), rules
//   (lines added to every card; "{user}" = the user's name).
import type { Item, Kernel, ServerPlugin } from "../../kernel/contract.ts";

export type Verdict = "accept" | "dismiss" | "comment" | "reopen";
export interface LogEntry { at: number; verdict: Verdict; comment?: string; card?: string; error?: string }
export interface Decide { state: "open" | "accepted" | "dismissed"; board?: string; log?: LogEntry[]; card?: { id: string; board: string } }
interface Panel { id: string; col: string; title?: string; text?: string; decide?: Decide; [k: string]: unknown }
interface Board { title?: string; columns?: { id: string; title: string }[]; panels?: Panel[]; [k: string]: unknown }

export const DEFAULT_RULES = ["Hard rule: no email or contact with anyone without {user}'s per-message OK. Produce drafts only; never send."];
const VERDICTS = new Set(["accept", "dismiss", "comment", "reopen"]);
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const clip = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);

export class Refused extends Error { constructor(readonly status: number, message: string) { super(message); } }

export class Decisions {
  constructor(readonly k: Kernel, readonly create: (body: Record<string, unknown>, board: string) => Promise<string>) {}

  private board(id: string) {
    const it = this.k.items.get<Board>(id);
    if (!it || it.type !== "columns") throw new Refused(404, "no such board");
    return it;
  }
  private panel(it: Item<Board>, pid: string) {
    const p = (it.data.panels || []).find(x => x.id === pid);
    if (!p) throw new Refused(404, `no panel ${pid}`);
    if (!p.decide) throw new Refused(400, `panel ${pid} takes no decisions`);
    return p;
  }

  async decide(boardId: string, b: { panel?: unknown; verdict?: unknown; comment?: unknown }) {
    const verdict = String(b.verdict || "") as Verdict, comment = clip(b.comment, 4000), pid = String(b.panel || "");
    if (!VERDICTS.has(verdict)) throw new Refused(400, "verdict must be accept, dismiss, comment or reopen");
    if (verdict === "comment" && !comment) throw new Refused(400, "an empty comment");
    const it = this.board(boardId), p = this.panel(it, pid), d = p.decide!;
    const n = (d.log || []).length;
    const entry: LogEntry = { at: Date.now(), verdict, ...(comment ? { comment } : {}) };
    let card: { id: string; board: string } | undefined;
    // accept and comment hand the decision to the agent as a card; accepting twice keeps the first card
    if ((verdict === "accept" && !d.card) || verdict === "comment") {
      const kb = SLUG.test(String(d.board || "")) ? String(d.board) : String(this.k.config.decideBoard || "default");
      try {
        const id = await this.create(this.cardBody(it, p, verdict, comment, n), kb);
        card = { id, board: kb }; entry.card = id;
      } catch (e) { entry.error = clip((e as Error).message, 200); }
    }
    // read again right before writing: the card call took a moment and the board may have changed meanwhile
    const now = this.board(boardId), q = this.panel(now, pid), qd = q.decide!;
    const next: Decide = { ...qd, log: [...(qd.log || []), entry],
      state: verdict === "accept" ? "accepted" : verdict === "dismiss" ? "dismissed" : verdict === "reopen" ? "open" : qd.state,
      ...(verdict === "accept" && card ? { card } : {}) };
    const panels = (now.data.panels || []).map(x => (x.id === pid ? { ...x, decide: next } : x));
    const item = this.k.items.update<Board>(boardId, { panels });
    return { item, ...(card ? { card: card.id } : {}), ...(entry.error ? { error: entry.error } : {}) };
  }

  cardBody(it: Item<Board>, p: Panel, verdict: Verdict, comment: string, n: number) {
    const user = this.k.user?.name || "the user", agent = this.k.app?.agentName || "the agent";
    const col = (it.data.columns || []).find(c => c.id === p.col)?.title || p.col;
    const rules = (Array.isArray(this.k.config.rules) ? this.k.config.rules as unknown[] : DEFAULT_RULES).map(r => String(r).replaceAll("{user}", user));
    const title = clip(p.title || "Suggestion", 100);
    const head = verdict === "accept"
      ? `${user} ACCEPTED this suggestion on the Sleipnyr board "${it.data.title || it.id}" (column ${col}).`
      : `${user} COMMENTED on this suggestion on the Sleipnyr board "${it.data.title || it.id}" (column ${col}): a request to change it, not an acceptance.`;
    const body = [
      head, "",
      ...(comment ? [`${user}'s comment: ${comment}`, ""] : []),
      "The suggestion as shown:", "", String(p.text || "").slice(0, 6000), "",
      `This card is unassigned on purpose: nothing runs by itself. ${agent} reads it, scopes it (for a comment: revise the suggestion on the board or do the changed task), assigns it and reports back.`,
      ...rules,
      `Origin: Sleipnyr columns board ${it.id}, panel ${p.id}.`,
    ].join("\n");
    return { title: (verdict === "accept" ? "" : "Comment: ") + title, body,
      idempotency_key: `sleipnyr2-decide-${it.id}-${p.id}-${verdict}-${n}` };
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

let decisions: Decisions | null = null;
const bad = (e: unknown) => Response.json({ error: (e as Error).message || String(e) }, { status: (e as Refused).status || 400 });

const plugin: ServerPlugin = {
  start(k) { decisions = new Decisions(k, proxyCreate(k)); },
  routes: () => ({
    "POST /:board/decide": async (req, p) => {
      try { return Response.json(await decisions!.decide(p.board, await req.json().catch(() => ({})))); } catch (e) { return bad(e); }
    },
  }),
};
export default plugin;
