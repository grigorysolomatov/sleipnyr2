// The plugin contract, version 1.
//
// Everything a plugin may use is declared in this file. A plugin is a folder
// under plugins/<id>/ with a manifest.json (type Manifest) and, optionally:
//   server.ts  default-exports a ServerPlugin (runs inside the kernel)
//   web/       static files for the browser (.js served as is, .ts converted
//              to JavaScript per request)
// Plugins never import each other or kernel internals. They talk through the
// Kernel object handed to them: saved items, links, files, live events and
// named services (one plugin provides, others use).
//
// Changing anything here is a contract change: bump CONTRACT_VERSION and say
// what changed in README.md.

export const CONTRACT_VERSION = 1;

// ---------------------------------------------------------------- manifest

export interface Command {
  name: string; // unique within the plugin, e.g. "new-thread"
  doc: string; // one line shown in command lists
  key?: string; // optional key binding, e.g. "Alt+N"
}

/** What the plugin may touch. Declared now, enforced in a later version. */
export interface Permissions {
  read?: string[]; // item types it reads ("*" = all)
  write?: string[]; // item types it creates or changes
  network?: string[]; // hosts or config keys of hosts it contacts
}

export interface Manifest {
  id: string; // = folder name, lowercase a-z0-9-
  name: string;
  version: string;
  contract: number; // must equal CONTRACT_VERSION
  doc: string;
  commands?: Command[];
  permissions: Permissions;
  /** what an agent may do to this plugin's view (docs/decision-agent-actions.md) */
  actions?: ActionDecl[];
  /** a composed modality (a way of working with the agent) listed in the shell's modality picker;
   *  its web entry then exports mount(box, ctx) and is mounted on first visit at /m/<id> */
  modality?: { title: string; doc?: string; icon?: string /* inline stroked SVG */ };
  provides?: string[]; // service names it registers
  needs?: string[]; // service names it uses
  web?: {
    // module path under /p/<id>/: the home plugin's exports mount(root, ctx); any other plugin's is an
    // extension exporting extend(host, ctx), host = what the home plugin's mount() returned
    entry?: string; // e.g. "web/chat.ts"
    styles?: string[]; // stylesheet paths under /p/<id>/ the shell loads first, e.g. "web/chat.css"
    restyleOn?: string[]; // item types whose change makes every open page reload these styles (the theme)
  };
}

// ---------------------------------------------------------------- agent actions

/** Permission levels, lowest first; a grant includes every level below it. */
export const ACTION_LEVELS = ["look", "read", "act", "script"] as const;
export type ActionLevel = (typeof ACTION_LEVELS)[number];

export interface ActionParam {
  type: "string" | "integer" | "number" | "boolean" | "array";
  doc: string;
  items?: "string" | "integer" | "number"; // element type of an array
  enum?: string[];
  pattern?: string; // regex a string (or each string entry) must match whole
  min?: number; // number: value; string: length; array: entries
  max?: number;
  default?: unknown;
}

/**
 * One action an agent may perform on the plugin's view: a typed tool. The
 * kernel serves every plugin's actions as one MCP server (tool name
 * <plugin>_<name>, dashes as underscores), checks the calling agent's grant
 * for the plugin and relays allowed calls to open pages on ACTION_TOPIC.
 * The plugin's web code runs them (extensions: ctx.actions.handle(name, fn)).
 */
export interface ActionDecl {
  name: string; // lowercase a-z0-9_
  doc: string;
  level: ActionLevel;
  params?: Record<string, ActionParam>;
  required?: string[];
  /** the call returns the page's own first word on what happened (e.g.
   *  "playing" or "waiting for a tap"), not just that a page took it */
  answers?: boolean;
}

/** Event topic: {run: {id, plugin, action, args}} or {stop: true}. */
export const ACTION_TOPIC = "action";

// ---------------------------------------------------------------- items

/** A saved thing. Its id is its permanent address (/i/<id>). */
export interface Item<D = Record<string, unknown>> {
  id: string;
  type: string;
  data: D;
  created: number; // ms since epoch
  updated: number;
  by: string; // plugin id or "user" that made the last change
}

export interface ItemQuery {
  type?: string;
  /** only items with a link (item -rel-> to) */
  linkedTo?: { rel: string; to: string };
  order?: "created" | "-created" | "updated" | "-updated";
  limit?: number;
}

export interface Items {
  get<D = Record<string, unknown>>(id: string): Item<D> | null;
  list<D = Record<string, unknown>>(q?: ItemQuery): Item<D>[];
  create<D extends object>(type: string, data: D): Item<D>;
  /** shallow-merges patch into data; null values remove keys */
  update<D = Record<string, unknown>>(id: string, patch: Record<string, unknown>): Item<D>;
}

export interface Link {
  src: string;
  rel: string;
  dst: string;
  created: number;
}

export interface Links {
  add(src: string, rel: string, dst: string): Link;
  list(q: { src?: string; rel?: string; dst?: string }): Link[];
}

/** Bytes backed by a plain ArrayBuffer (usable as a fetch or Response body). */
export type Bytes = Uint8Array<ArrayBuffer>;

/** File bytes. Each file is also an item of type "file". */
export interface FileData {
  name: string;
  mime: string;
  size: number;
  sha256: string;
}

export interface Files {
  put(name: string, mime: string, bytes: Bytes): Item<FileData>;
  read(id: string): Promise<Bytes | null>;
}

// ---------------------------------------------------------------- events

/** Live, unsaved notifications (streamed text, progress). Saved state goes in items. */
export interface Events {
  publish(topic: string, data: unknown): void;
  subscribe(topic: string, fn: (data: unknown) => void): () => void;
}

/** Kernel topics: "item" ({item}) on every create/update. */
export const ITEM_TOPIC = "item";

// ---------------------------------------------------------------- services

export interface Services {
  provide<T>(name: string, impl: T): void;
  /** throws if no plugin provides it */
  get<T>(name: string): T;
  has(name: string): boolean;
}

// Well-known services. A plugin providing one implements this interface.

export interface AttachedFile {
  name: string;
  mime: string;
  bytes: Bytes;
  /** the file item's id, when it is one (GET /k/files/<id> serves it) */
  id?: string;
}

export type AgentEvent =
  | { type: "delta"; text: string } // streamed reply text, appended
  | { type: "progress"; text: string } // one line of what the agent does now
  | { type: "state"; state: Record<string, unknown> } // remember for this conversation
  | { type: "done"; text: string; unsent?: string } // finished, whole reply; unsent = steer text it never took in
  | { type: "error"; message: string };

export interface AgentTurn {
  conversation: string; // stable id of the conversation (e.g. thread item id)
  title: string;
  state: Record<string, unknown>; // what the agent asked to remember
  text: string;
  files: AttachedFile[];
  signal?: AbortSignal; // stop following the turn (the kernel stops; the run itself goes on)
  cancel?: AbortSignal; // stop the turn itself: the agent ends its run
}

/** service "agent": talk to one or more agents */
export interface AgentService {
  agents(): { id: string; name: string }[];
  send(agentId: string, turn: AgentTurn): AsyncIterable<AgentEvent>;
  /** continue a turn after a kernel restart, from state saved via "state" events */
  resume?(agentId: string, turn: AgentTurn): AsyncIterable<AgentEvent>;
  /** one-shot completion (no session): a short title for a transcript; may be absent */
  title?(agentId: string, transcript: string, signal?: AbortSignal): Promise<string>;
  /** add a message to a running turn (state = what that turn's "state" events said); false = not taken */
  steer?(agentId: string, state: Record<string, unknown>, text: string): Promise<boolean>;
}

/** service "transcribe": speech to text */
export interface TranscribeService {
  transcribe(audio: Bytes, mime: string): Promise<{ text: string; seconds?: number }>;
}

// ---------------------------------------------------------------- the kernel

export interface Kernel {
  contract: number;
  items: Items;
  links: Links;
  files: Files;
  events: Events;
  services: Services;
  /** this plugin's section of the config ("plugins.<id>"), plus shared "user" */
  config: Record<string, unknown>;
  user: { id: string; name: string };
  /** shared app settings: agentName = how prompts and the UI name the agent (default "Agent") */
  app: { name: string; shortName: string; home: string; agentName: string };
  log(...args: unknown[]): void;
}

export type Handler = (req: Request, params: Record<string, string>) => Response | Promise<Response>;

export interface ServerPlugin {
  /** called once after all plugins are loaded and before requests are served */
  start?(kernel: Kernel): void | Promise<void>;
  /** HTTP routes under /p/<id>, keyed "METHOD /path" (":name" segments become params) */
  routes?(kernel: Kernel): Record<string, Handler>;
  stop?(): void | Promise<void>;
}
