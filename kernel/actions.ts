// Declared agent actions (docs/decision-agent-actions.md). Each plugin's
// manifest lists what an agent may do to its view, as typed tools. The kernel
// serves all of them as one MCP server (POST /k/mcp: JSON-RPC 2.0, Streamable
// HTTP transport with plain JSON replies). It checks who calls (a bearer key
// per agent, from the config) and what that agent was granted per plugin,
// saves every call as an "action-call" item (refused ones too) and relays an
// allowed call to the open pages over the event stream (ACTION_TOPIC). Pages
// run the effect and report back (POST /k/actions/<id>); POST
// /k/actions/stop ends every running effect; a reload resets a page.
// There is no "run any JavaScript" action: a plugin can only offer what its
// own page code implements.
// Besides the plugins' own actions the kernel declares generic ones that work
// on whatever view is on screen (VIEW_ACTIONS, granted as plugin "view"):
// every view marks the things an agent may point at with data-k-id, and the
// page runtime (kernel/web/actions.js) describes, marks, scrolls to, focuses,
// animates and (where the view supports it) reorders them.
import { timingSafeEqual } from "node:crypto";
import {
  ACTION_LEVELS, ACTION_TOPIC,
  type ActionDecl, type ActionLevel, type ActionParam, type Events, type Item, type Items, type Manifest,
} from "./contract.ts";

/** config "actions": which agents may call, with which key, up to which level per plugin. */
export interface ActionsConfig {
  agents?: Record<string, { keyEnv: string; grants?: Record<string, ActionLevel> }>;
  /** how long a call waits for the first page to report (ms) */
  ackMs?: number;
}

export type CallStatus = "refused" | "invalid" | "sent" | "no page" | "running" | "done" | "stopped" | "failed";

export interface ActionCall {
  tool: string; // MCP tool name, <plugin>_<action>
  plugin: string;
  action: string;
  agent: string; // "?" = unknown caller
  args: Record<string, unknown>;
  status: CallStatus;
  note?: string; // what happened, in words
  pages?: number; // how many open pages ran it
}

interface Tool { name: string; plugin: string; decl: ActionDecl; kernel?: boolean }

/** the grant name of the kernel's generic view actions */
export const VIEW_PLUGIN = "view";
const ID = "[A-Za-z0-9_.:-]{1,80}";
const COLOR = "|#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,24}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|hwb)\\([0-9a-zA-Z.,%/ +-]{1,80}\\)|var\\(--[a-z0-9-]{1,40}\\)";
/** properties an animation frame may set (anything else is refused, here and on the page) */
export const ANIM_PROPS = ["opacity", "scale", "rotate", "translate", "background-color", "color", "outline-color",
  "outline-width", "outline-offset", "border-color", "box-shadow", "filter"];
const VALUE = "[-+0-9a-zA-Z.,%#() /]{1,120}";
const FRAME = `(${ANIM_PROPS.join("|")}):${VALUE}(;(${ANIM_PROPS.join("|")}):${VALUE}){0,5}`;
const viewP = { type: "string", doc: "which view: \"\" = the one on screen; else a modality id (chat, columns, blackboards, tinder, projects, picker) optionally /<sub>, e.g. projects/sleipnyr2; it is opened first", pattern: "|[a-z0-9-]{1,40}(/[A-Za-z0-9_.-]{1,80})?", default: "" } as const;
const targetsP = { type: "array", items: "string", doc: "item ids (data-k-id) as listed by view_describe, e.g. a thread t_..., a message m_..., a panel or window id", min: 1, max: 60, pattern: ID } as const;
const durP = (def: number) => ({ type: "integer", doc: "how long it stays, ms (stop control and reload end it earlier)", min: 500, max: 600000, default: def } as const);

/** The kernel's generic actions on any view (tool names view_<name>). */
export const VIEW_ACTIONS: ActionDecl[] = [
  { name: "describe", level: "read",
    doc: "List what is on the user's open Sleipnyr page: the view (modality and sub page), and every item an agent can address (id, kind, label, whether it is on screen, whether the view can reorder it). Call it first to get ids for the other view_* actions. Each open page answers; the first answer is returned.",
    params: { view: viewP } },
  { name: "mark", level: "look",
    doc: "Mark items in any view for a while: frame | tint | underline | pulse, in any CSS colour, with a reason shown as the item's tooltip. Marks coexist (group things by colour with several calls); a later call on the same item takes over. Works in every view (thread list, messages, Columns panels, Blackboards windows, Tinder cards, projects, the modality picker) without reloading.",
    params: { targets: targetsP, view: viewP,
      style: { type: "string", doc: "frame = outline; tint = coloured background; underline = line under it; pulse = beating glow", enum: ["frame", "tint", "underline", "pulse"], default: "frame" },
      color: { type: "string", doc: "any CSS colour or a theme token var(--accent-here); empty = pink", pattern: COLOR, default: "" },
      reason: { type: "string", doc: "why, a few words: the tooltip on the item", max: 120, default: "" },
      duration_ms: durP(20000) },
    required: ["targets"] },
  { name: "scroll_to", level: "look",
    doc: "Bring one item into view in its own scroll area (smoothly; Columns shows its column, Blackboards pans to the window). Nothing opens or changes.",
    params: { target: { type: "string", doc: "item id (data-k-id)", pattern: ID }, view: viewP,
      block: { type: "string", doc: "where it lands", enum: ["start", "center", "end", "nearest"], default: "center" } },
    required: ["target"] },
  { name: "focus", level: "look",
    doc: "Open a view (optional `view`) and/or bring one item to the front and into view with a short pink pulse, so the user's eye goes there (Blackboards: raises and centres the window; Columns: shows the column and the panel).",
    params: { target: { type: "string", doc: "item id (data-k-id); empty = just open the view", pattern: `|${ID}`, default: "" }, view: viewP,
      pulse_ms: { type: "integer", doc: "how long the pink pulse lasts, ms (0 = none)", min: 0, max: 20000, default: 2500 } } },
  { name: "animate", level: "look",
    doc: "A bounded presentation effect on items: CSS keyframes over whitelisted properties only (" + ANIM_PROPS.join(", ") + "), each frame \"prop:value;prop:value\" (values: numbers, units, colours, var(--token); no url, no code). phase_ms delays each next target (a wave or rainbow across rows). Clears itself after loops, on the stop control or a reload. Example rainbow: frames [\"background-color:red\", \"background-color:orange\", \"background-color:yellow\", \"background-color:green\", \"background-color:blue\", \"background-color:violet\"], phase_ms 150.",
    params: { targets: targetsP, view: viewP,
      frames: { type: "array", items: "string", doc: "2-12 keyframes, evenly spaced, each \"prop:value(;prop:value)*\"", min: 2, max: 12, pattern: FRAME },
      duration_ms: { type: "integer", doc: "one pass through the frames, ms", min: 100, max: 20000, default: 1200 },
      loops: { type: "integer", doc: "how many passes", min: 1, max: 100, default: 3 },
      phase_ms: { type: "integer", doc: "extra delay per next target, ms", min: 0, max: 5000, default: 0 },
      easing: { type: "string", doc: "timing", enum: ["linear", "ease", "ease-in", "ease-out", "ease-in-out", "steps"], default: "ease-in-out" },
      alternate: { type: "boolean", doc: "run every second pass backwards", default: false } },
    required: ["targets", "frames"] },
  { name: "order", level: "act",
    doc: "Reorder items in a view that supports it, animated, saved in the view's own item (no reload): Columns panels (with `into` = a column id: move them there, at position `at`; without: the listed panels swap into each other's places in the given order) and Blackboards windows (the listed windows trade places so they read in the given order). view_describe says which items can be ordered. Thread list order is not supported.",
    params: { ids: { type: "array", items: "string", doc: "the items in the wanted order", min: 1, max: 60, pattern: ID }, view: viewP,
      into: { type: "string", doc: "Columns: target column id (empty = where they are)", pattern: `|${ID}`, default: "" },
      at: { type: "integer", doc: "with `into`: 1 = top; 0 = bottom", min: 0, max: 500, default: 0 } },
    required: ["ids"] },
];

const NAME = /^[a-z][a-z0-9_]{0,40}$/;
const FINAL: CallStatus[] = ["done", "stopped", "failed", "no page", "refused", "invalid"];

/** Checks the declarations once at start: a bad manifest stops the kernel, not a call later. */
function toolsOf(manifests: Manifest[]): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  if (manifests.some(m => m.id === VIEW_PLUGIN)) throw new Error(`plugin id ${VIEW_PLUGIN} is reserved for the kernel's view actions`);
  const kernel = { id: VIEW_PLUGIN, actions: VIEW_ACTIONS } as Manifest;
  for (const m of [kernel, ...manifests]) for (const decl of m.actions || []) {
    const where = `plugin ${m.id}, action ${decl.name}`;
    if (!NAME.test(decl.name)) throw new Error(`${where}: name must be lowercase a-z0-9_`);
    if (!ACTION_LEVELS.includes(decl.level)) throw new Error(`${where}: level must be one of ${ACTION_LEVELS.join(", ")}`);
    if (!decl.doc) throw new Error(`${where}: doc required`);
    for (const r of decl.required || []) if (!decl.params?.[r]) throw new Error(`${where}: required "${r}" is not a param`);
    for (const [k, p] of Object.entries(decl.params || {})) {
      if (!p.doc) throw new Error(`${where}: param ${k} needs a doc`);
      if (p.pattern) new RegExp(p.pattern); // a bad pattern fails here, at start
    }
    const name = `${m.id.replace(/-/g, "_")}_${decl.name}`;
    if (tools.has(name)) throw new Error(`${where}: tool ${name} declared twice`);
    tools.set(name, { name, plugin: m.id, decl, kernel: m === kernel });
  }
  return tools;
}

function schemaOf(p: ActionParam): Record<string, unknown> {
  const s: Record<string, unknown> = { type: p.type, description: p.doc };
  if (p.enum) s.enum = p.enum;
  if (p.default !== undefined) s.default = p.default;
  if (p.pattern && p.type === "string") s.pattern = `^(?:${p.pattern})$`;
  if (p.type === "array") {
    s.items = { type: p.items || "string", ...(p.pattern ? { pattern: `^(?:${p.pattern})$` } : {}) };
    if (p.min !== undefined) s.minItems = p.min;
    if (p.max !== undefined) s.maxItems = p.max;
  } else if (p.type === "string") {
    if (p.min !== undefined) s.minLength = p.min;
    if (p.max !== undefined) s.maxLength = p.max;
  } else if (p.type === "integer" || p.type === "number") {
    if (p.min !== undefined) s.minimum = p.min;
    if (p.max !== undefined) s.maximum = p.max;
  }
  return s;
}

const typeOk = (t: string, v: unknown) =>
  t === "integer" ? Number.isInteger(v) : t === "number" ? typeof v === "number" && Number.isFinite(v) : typeof v === t;

/** The arguments with defaults filled in, or an error saying what is wrong. Unknown keys are refused. */
export function checkArgs(decl: ActionDecl, raw: unknown): { args: Record<string, unknown> } | { error: string } {
  const given = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const params = decl.params || {}, args: Record<string, unknown> = {};
  for (const k of Object.keys(given)) if (!params[k]) return { error: `unknown parameter "${k}"` };
  for (const [k, p] of Object.entries(params)) {
    const v = given[k] ?? p.default;
    const re = p.pattern ? new RegExp(`^(?:${p.pattern})$`) : null;
    if (v === undefined) { if (decl.required?.includes(k)) return { error: `"${k}" is required` }; continue; }
    if (p.type === "array") {
      if (!Array.isArray(v)) return { error: `"${k}" must be a list` };
      if (!v.every(x => typeOk(p.items || "string", x))) return { error: `"${k}" must be a list of ${p.items || "string"}s` };
      if (p.min !== undefined && v.length < p.min) return { error: `"${k}" needs at least ${p.min} entries` };
      if (p.max !== undefined && v.length > p.max) return { error: `"${k}" takes at most ${p.max} entries` };
      if (v.some(x => typeof x === "string" && x.length > 200)) return { error: `"${k}": entries are at most 200 characters` };
      if (re && v.some(x => !re.test(String(x)))) return { error: `"${k}": an entry has the wrong form` };
    } else {
      if (!typeOk(p.type, v)) return { error: `"${k}" must be ${p.type === "integer" ? "an integer" : `a ${p.type}`}` };
      if (p.enum && !p.enum.includes(v as string)) return { error: `"${k}" must be one of ${p.enum.join(", ")}` };
      const size = typeof v === "string" ? v.length : typeof v === "number" ? v : undefined;
      if (size !== undefined && p.min !== undefined && size < p.min) return { error: `"${k}" is below ${p.min}` };
      if (size !== undefined && p.max !== undefined && size > p.max) return { error: `"${k}" is above ${p.max}` };
      if (typeof v === "string" && v.length > 2000) return { error: `"${k}" is too long` };
      if (re && typeof v === "string" && !re.test(v)) return { error: `"${k}" has the wrong form` };
    }
    args[k] = v;
  }
  return { args };
}

const keyMatch = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const rpc = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], isError });

export class Actions {
  readonly tools: Map<string, Tool>;
  private waiting = new Map<string, (c: ActionCall) => void>(); // call id -> first page report

  constructor(manifests: Manifest[], private items: Items, private events: Events, private cfg: ActionsConfig,
    private env: Record<string, string | undefined> = process.env) {
    this.tools = toolsOf(manifests);
  }

  /** The agent whose key the request carries, or null. Agents without a key set (or a short one) never match. */
  caller(req: Request): string | null {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") || "");
    if (!m) return null;
    for (const [id, a] of Object.entries(this.cfg.agents || {})) {
      const key = this.env[a.keyEnv] || "";
      if (key.length >= 16 && keyMatch(m[1], key)) return id;
    }
    return null;
  }

  /** May this agent call this tool? (a grant includes every level below it) */
  allowed(agent: string, t: Tool): boolean {
    const grant = this.cfg.agents?.[agent]?.grants?.[t.plugin];
    return !!grant && ACTION_LEVELS.indexOf(grant) >= ACTION_LEVELS.indexOf(t.decl.level);
  }

  private log(c: ActionCall): Item<ActionCall> {
    const it = this.items.create<ActionCall>("action-call", c);
    console.log(`[actions] ${c.agent} ${c.tool} ${JSON.stringify(c.args)} -> ${c.status}${c.note ? ` (${c.note})` : ""}`);
    return it;
  }

  /** POST /k/mcp */
  async mcp(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    const agent = this.caller(req);
    let body: unknown;
    try { body = await req.json(); } catch { return Response.json(rpcError(null, -32700, "parse error"), { status: 400 }); }
    const msgs = Array.isArray(body) ? body : [body];
    if (!agent) {
      // a call attempt from an unknown caller is logged too, then refused
      for (const m of msgs as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }[])
        if (m?.method === "tools/call") {
          const t = this.tools.get(String(m.params?.name));
          this.log({ tool: String(m.params?.name || "?"), plugin: t?.plugin || "?", action: t?.decl.name || "?", agent: "?",
            args: {}, status: "refused", note: "unknown caller (no or wrong key)" });
        }
      return Response.json(rpcError(null, -32001, "unauthorised: send Authorization: Bearer <this agent's key>"),
        { status: 401, headers: { "www-authenticate": 'Bearer realm="sleipnyr2"' } });
    }
    const out = [];
    for (const m of msgs as { id?: unknown; method?: string; params?: Record<string, unknown> }[]) {
      if (!m || typeof m !== "object" || m.method === undefined) continue; // responses / junk
      const r = await this.handle(agent, m);
      if (m.id !== undefined && r) out.push(r);
    }
    if (!out.length) return new Response(null, { status: 202 });
    return Response.json(Array.isArray(body) ? out : out[0]);
  }

  private async handle(agent: string, m: { id?: unknown; method?: string; params?: Record<string, unknown> }) {
    switch (m.method) {
      case "initialize":
        return rpc(m.id, {
          protocolVersion: String(m.params?.protocolVersion || "2025-06-18"),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "sleipnyr2", version: "1" },
          instructions: "Live effects on the user's open Sleipnyr 2 pages (blink, highlight, mark any message part, scroll, reopen the reply). "
            + "The view_* tools work on whatever view is on screen: view_describe lists its items, then mark, scroll_to, focus, animate or order them. "
            + "Effects are temporary: the page's stop control or a reload ends them. Every call is logged and shown in the thread.",
        });
      case "ping": return rpc(m.id, {});
      case "tools/list":
        return rpc(m.id, { tools: [...this.tools.values()].filter(t => this.allowed(agent, t)).map(t => ({
          name: t.name, description: `${t.decl.doc} (level: ${t.decl.level})`,
          inputSchema: { type: "object", properties: Object.fromEntries(Object.entries(t.decl.params || {}).map(([k, p]) => [k, schemaOf(p)])),
            required: t.decl.required || [], additionalProperties: false },
        })) });
      case "tools/call": return rpc(m.id, await this.call(agent, String(m.params?.name || ""), m.params?.arguments));
      default:
        if (m.method?.startsWith("notifications/")) return null;
        return rpcError(m.id, -32601, `method ${m.method} not supported`);
    }
  }

  /** One tool call: check, log, relay, wait briefly for the first page. */
  async call(agent: string, name: string, raw: unknown) {
    const t = this.tools.get(name);
    if (!t) {
      this.log({ tool: name || "?", plugin: "?", action: "?", agent, args: {}, status: "refused", note: "no such action" });
      return text(`No action ${name}.`, true);
    }
    const base = { tool: t.name, plugin: t.plugin, action: t.decl.name, agent };
    if (!this.allowed(agent, t)) {
      this.log({ ...base, args: {}, status: "refused", note: `needs level ${t.decl.level} on ${t.plugin}; not granted` });
      return text(`Refused: ${agent} may not call ${t.name} (needs a ${t.decl.level} grant on ${t.plugin}).`, true);
    }
    const checked = checkArgs(t.decl, raw);
    if ("error" in checked) {
      this.log({ ...base, args: {}, status: "invalid", note: checked.error });
      return text(`Not run: ${checked.error}.`, true);
    }
    const it = this.log({ ...base, args: checked.args, status: "sent" });
    const first = new Promise<ActionCall | null>(ok => {
      const timer = setTimeout(() => { this.waiting.delete(it.id); ok(null); }, this.cfg.ackMs ?? 2500);
      // a read (view_describe) answers with its final report; effects return once a page runs them
      this.waiting.set(it.id, c => {
        if (t.decl.level === "read" && c.status === "running") return;
        clearTimeout(timer); this.waiting.delete(it.id); ok(c);
      });
    });
    this.events.publish(ACTION_TOPIC, { run: { id: it.id, plugin: t.plugin, action: t.decl.name, args: checked.args } });
    const got = await first;
    if (!got) {
      const note = t.kernel ? "no open Sleipnyr page shows that view or those items (see view_describe), so nothing ran"
        : "no Sleipnyr page is open, so nothing ran";
      this.items.update(it.id, { status: "no page", note });
      return text(`Not shown: ${note}.`, true);
    }
    const failed = got.status === "failed";
    if (t.decl.name === "describe" && t.kernel && !failed) return text(got.note || "(nothing)");
    return text(failed ? `Failed on the page: ${got.note || "unknown error"}.` : `${got.status === "done" ? "Done" : "Running"} on the open page: ${got.note || t.decl.name}.`, failed);
  }

  /** POST /k/actions/<id>: a page reports what it did with a call. */
  report(id: string, b: { status?: string; note?: string }): Item<ActionCall> | null {
    const it = this.items.get<ActionCall>(id);
    if (!it || it.type !== "action-call") return null;
    const status = String(b.status) as CallStatus;
    if (!["running", "done", "stopped", "failed"].includes(status)) throw new Error("status must be running, done, stopped or failed");
    const note = String(b.note || "").slice(0, 4000); // a describe answer lists the view's items
    const patch: Record<string, unknown> = {};
    if (status === "running") patch.pages = (it.data.pages || 0) + 1;
    // refused/invalid never change; an ended call never goes back to running
    const cur = it.data.status;
    if (!["refused", "invalid"].includes(cur) && !(status === "running" && FINAL.includes(cur))) patch.status = status;
    if (note && (!it.data.note || status !== "running")) patch.note = note;
    const up = Object.keys(patch).length ? this.items.update<ActionCall>(id, patch) : it;
    this.waiting.get(id)?.(up.data);
    return up;
  }

  /** POST /k/actions/stop: every open page ends its running effects. */
  stop() { this.events.publish(ACTION_TOPIC, { stop: true }); }

  /** GET /k/actions: the latest calls, newest first (the audit log). */
  recent(limit = 50) { return this.items.list<ActionCall>({ type: "action-call", order: "-created", limit }); }
}
