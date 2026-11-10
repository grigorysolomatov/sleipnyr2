// The kernel: loads the config and the plugins, serves the shell, the kernel
// HTTP API and each plugin's routes and web files. See README.md.
//
//   bun kernel/server.ts [config.json]      (or SLEIPNYR2_CONFIG=...)
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, normalize, resolve } from "node:path";
import {
  CONTRACT_VERSION, ITEM_TOPIC, SETTINGS_TYPE, type AppSettings, type Items,
  type Events, type Handler, type Kernel, type Manifest, type ServerPlugin, type Services,
} from "./contract.ts";
import { Actions, type ActionsConfig } from "./actions.ts";
import { Push } from "./push.ts";
import { Store } from "./store.ts";

const ROOT = resolve(import.meta.dir, "..");
/** Release id (the deployed commit dir name, e.g. releases/<sha>); the web shell offers an update when it changes. */
const BUILD = basename(realpathSync(ROOT));

export interface Config {
  listen: { host: string; port: number };
  dataDir: string;
  app: { name: string; shortName: string; home: string; agentName?: string; features?: Record<string, boolean>; pickerHidden?: string[]; viewNotes?: Record<string, string> }; // home = plugin shown at "/"; agentName = how the UI names the agent
  user: { id: string; name: string };
  plugins: Record<string, Record<string, unknown>>; // enabled plugins and their settings
  actions?: ActionsConfig; // which agents may call the plugins' declared actions (kernel/actions.ts)
}

/** Voice recordings from some phones (Android Chrome WebM) carry a timestamp jump after the first
 * packet, so players show a duration many times too long. Re-encode them with fresh timestamps.
 * Needs ffmpeg (SLEIPNYR2_FFMPEG, or "ffmpeg" on PATH); without it, or on any failure, the
 * original bytes are kept. */
export async function fixAudio(bytes: Uint8Array, mime: string): Promise<{ bytes: Uint8Array; mime: string }> {
  if (!/^audio\/(webm|ogg)\b/i.test(mime)) return { bytes, mime };
  const dir = mkdtempSync(join(tmpdir(), "s2audio-"));
  try {
    const inp = join(dir, "in"), out = join(dir, "out.webm");
    writeFileSync(inp, bytes);
    const p = Bun.spawn([process.env.SLEIPNYR2_FFMPEG || "ffmpeg", "-v", "error", "-y", "-i", inp, "-vn",
      "-af", "asetpts=N/SR/TB", "-c:a", "libopus", "-b:a", "32k", "-f", "webm", out], { stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => p.kill(), 120_000);
    const code = await p.exited; clearTimeout(timer);
    if (code !== 0 || !existsSync(out)) return { bytes, mime };
    const fixed = new Uint8Array(readFileSync(out));
    return fixed.length ? { bytes: fixed, mime: "audio/webm" } : { bytes, mime };
  } catch { return { bytes, mime }; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

export function loadConfig(path: string): Config {
  const c = JSON.parse(readFileSync(path, "utf8")) as Config;
  c.dataDir = resolve(ROOT, c.dataDir);
  return c;
}

// ---------------------------------------------------------------- events

function eventBus(): Events {
  const subs = new Map<string, Set<(d: unknown) => void>>();
  return {
    publish(topic, data) {
      for (const fn of [...(subs.get(topic) || [])]) {
        try { fn(data); } catch (e) { console.error(`event ${topic}:`, e); }
      }
    },
    subscribe(topic, fn) {
      if (!subs.has(topic)) subs.set(topic, new Set());
      subs.get(topic)!.add(fn);
      return () => { subs.get(topic)?.delete(fn); };
    },
  };
}

function serviceRegistry(): Services {
  const m = new Map<string, unknown>();
  return {
    provide(name, impl) { m.set(name, impl); },
    get<T>(name: string) {
      if (!m.has(name)) throw new Error(`no plugin provides service "${name}"`);
      return m.get(name) as T;
    },
    has: name => m.has(name),
  };
}

// ---------------------------------------------------------------- plugins

export interface Loaded { manifest: Manifest; dir: string; server?: ServerPlugin; routes: Route[] }
interface Route { method: string; parts: string[]; handler: Handler }

/** Plugin renames: old config name -> plugin folder (the saved data is unchanged). */
const RENAMED_PLUGINS: Record<string, string> = { sessions: "blackboards", theme: "settings" };

function readManifest(dir: string, id: string): Manifest {
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  if (m.id !== id) throw new Error(`plugin folder ${id} has manifest id ${m.id}`);
  if (m.contract !== CONTRACT_VERSION) throw new Error(`plugin ${id} wants contract ${m.contract}, kernel has ${CONTRACT_VERSION}`);
  if (!m.permissions) throw new Error(`plugin ${id}: manifest has no permissions`);
  return m;
}

function compileRoutes(table: Record<string, Handler>): Route[] {
  return Object.entries(table).map(([key, handler]) => {
    const [method, path] = key.split(" ");
    return { method, parts: path.split("/").filter(Boolean), handler };
  });
}

function matchRoute(routes: Route[], method: string, parts: string[]) {
  for (const r of routes) {
    if (r.method !== method || r.parts.length !== parts.length) continue;
    const params: Record<string, string> = {};
    if (r.parts.every((p, i) => p.startsWith(":") ? (params[p.slice(1)] = decodeURIComponent(parts[i]), true) : p === parts[i]))
      return { route: r, params };
  }
  return null;
}

// ---------------------------------------------------------------- web files

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".ts": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};
const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });
const tsCache = new Map<string, { mtime: number; js: string }>();

/** A file under base, or null (no escaping base). TypeScript is converted to JavaScript per request. */
function webFile(base: string, rel: string): Response | null {
  const path = normalize(join(base, rel));
  if (!path.startsWith(base + "/") || !existsSync(path) || !statSync(path).isFile()) return null;
  const ext = extname(path), headers = { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-cache" };
  if (ext !== ".ts") return new Response(Bun.file(path), { headers });
  const mtime = statSync(path).mtimeMs;
  let hit = tsCache.get(path);
  if (!hit || hit.mtime !== mtime) tsCache.set(path, hit = { mtime, js: transpiler.transformSync(readFileSync(path, "utf8")) });
  return new Response(hit.js, { headers });
}

// ---------------------------------------------------------------- the app

const json = (v: unknown, status = 200) => Response.json(v, { status, headers: { "cache-control": "no-store" } });

/** Server-sent events for the given topics; the client reconnects by itself. */
function sse(events: Events, topics: string[], req: Request): Response {
  const enc = new TextEncoder();
  let offs: (() => void)[] = [], ping: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(ctl) {
      const send = (topic: string, data: unknown) => {
        try { ctl.enqueue(enc.encode(`data: ${JSON.stringify({ topic, data })}\n\n`)); } catch { close(); }
      };
      const close = () => { offs.forEach(f => f()); offs = []; clearInterval(ping); };
      offs = topics.map(t => events.subscribe(t, d => send(t, d)));
      // a named event the page can see: no ping for a while = a dead stream it reopens
      ping = setInterval(() => { try { ctl.enqueue(enc.encode("event: ping\ndata: 1\n\n")); } catch { close(); } }, 20000);
      ctl.enqueue(enc.encode("retry: 2000\n: open\n\n"));
      req.signal.addEventListener("abort", () => { close(); try { ctl.close(); } catch {} });
    },
    cancel() { offs.forEach(f => f()); clearInterval(ping); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
}

export async function createApp(config: Config) {
  const store = new Store(config.dataDir);
  const events = eventBus(), services = serviceRegistry();
  store.onChange = item => events.publish(ITEM_TOPIC, { item });
  store.onRemove = item => events.publish(ITEM_TOPIC, { item, removed: true });
  const push = new Push(store.db, config.dataDir);

  // ---- app settings: one kernel-owned item, changed by hand in Settings
  const VIEW_NOTES_MAX = 4000;
  const kItems = store.items("kernel");
  const settingsItem = () => kItems.list<Partial<AppSettings>>({ type: SETTINGS_TYPE, order: "-updated", limit: 1 })[0] || null;
  const settings = (): AppSettings => {
    const d = settingsItem()?.data || {};
    const features: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(config.app.features || {})) features[k] = v !== false;
    for (const [k, v] of Object.entries(d.features || {})) if (typeof v === "boolean") features[k] = v;
    const pickerHidden = Array.isArray(d.pickerHidden) ? d.pickerHidden : config.app.pickerHidden || [];
    const viewNotes: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...(config.app.viewNotes || {}), ...(d.viewNotes || {}) })) if (typeof v === "string" && v) viewNotes[k] = v;
    return { allowDelete: d.allowDelete === true, features, pickerHidden, viewNotes };
  };
  const setSettings = (b: { allowDelete?: unknown; features?: unknown; pickerHidden?: unknown; viewNotes?: unknown }): AppSettings => {
    const patch: Record<string, unknown> = {};
    if (b.allowDelete !== undefined) {
      if (typeof b.allowDelete !== "boolean") throw Object.assign(new Error("allowDelete must be true or false"), { status: 400 });
      patch.allowDelete = b.allowDelete;
    }
    if (b.features !== undefined) {
      if (!b.features || typeof b.features !== "object" || Array.isArray(b.features)) throw Object.assign(new Error("features must be {name: true|false}"), { status: 400 });
      const f: Record<string, boolean | null> = { ...(settingsItem()?.data.features || {}) };
      for (const [k, v] of Object.entries(b.features as Record<string, unknown>)) {
        if (!/^[a-zA-Z][a-zA-Z0-9]{0,40}$/.test(k) || (typeof v !== "boolean" && v !== null)) throw Object.assign(new Error(`bad feature ${k}`), { status: 400 });
        if (v === null) delete f[k]; else f[k] = v;
      }
      patch.features = f;
    }
    if (b.pickerHidden !== undefined) {
      const known = new Set(plugins.filter(p => p.manifest.modality).map(p => p.manifest.id));
      const v = b.pickerHidden;
      if (v === null) patch.pickerHidden = null; // back to the config default
      else if (!Array.isArray(v) || v.some(x => typeof x !== "string" || !known.has(x)))
        throw Object.assign(new Error("pickerHidden must be a list of modality ids"), { status: 400 });
      else patch.pickerHidden = [...new Set(v as string[])];
    }
    if (b.viewNotes !== undefined) {
      // {view: text} replaces that view's notes ("" = none), null = back to the config default
      if (!b.viewNotes || typeof b.viewNotes !== "object" || Array.isArray(b.viewNotes)) throw Object.assign(new Error("viewNotes must be {view: text|null}"), { status: 400 });
      const n: Record<string, string | null> = { ...(settingsItem()?.data.viewNotes || {}) };
      for (const [k, v] of Object.entries(b.viewNotes as Record<string, unknown>)) {
        if (!/^[a-z][a-z0-9-]{0,40}$/.test(k) || (typeof v !== "string" && v !== null)) throw Object.assign(new Error(`bad view notes ${k}`), { status: 400 });
        if (typeof v === "string" && v.length > VIEW_NOTES_MAX) throw Object.assign(new Error(`notes for ${k} longer than ${VIEW_NOTES_MAX} characters`), { status: 400 });
        if (v === null) delete n[k]; else n[k] = v;
      }
      patch.viewNotes = n;
    }
    if (!Object.keys(patch).length) throw Object.assign(new Error("allowDelete, features, pickerHidden or viewNotes required"), { status: 400 });
    const cur = settingsItem();
    if (cur) kItems.update(cur.id, patch); else kItems.create(SETTINGS_TYPE, { allowDelete: false, features: {}, ...patch });
    return settings();
  };
  const offError = () => Object.assign(new Error("deletion is off (turn it on in Settings > Data)"), { status: 403 });
  // deleting is a gated capability: refused unless Settings > Data allows it
  const gated = (items: Items): Items => ({ ...items, remove: (id: string) => { if (!settings().allowDelete) throw offError(); return items.remove(id); } });

  // phone notifications: the feature switch "notifications" (default on) stops every push
  const pushOn = () => settings().features.notifications !== false;
  const pushService = { notify: (n: Parameters<Push["notify"]>[0]) => (pushOn() ? push.notify(n) : Promise.resolve([])), looking: (t: string) => push.looking(t) };
  const kernelFor = (id: string): Kernel => ({ push: pushService,
    contract: CONTRACT_VERSION, items: gated(store.items(id)), links: store.links(), files: store.files(id), settings,
    events, services, config: config.plugins[id] || {}, user: config.user, privateDir: join(config.dataDir, "private", id), app: { ...config.app, agentName: config.app.agentName || "Agent" },
    log: (...a) => console.log(`[${id}]`, ...a),
  });

  // load every enabled plugin, then check that each needed service is provided
  const plugins: Loaded[] = [];
  for (const key of Object.keys(config.plugins)) {
    // a renamed plugin still loads under its old config name (config updated later)
    const id = RENAMED_PLUGINS[key] || key;
    if (id !== key) { if (id in config.plugins) continue; config.plugins[id] = config.plugins[key]; }
    const dir = join(ROOT, "plugins", id);
    const manifest = readManifest(dir, id);
    const entry = join(dir, "server.ts");
    const server = existsSync(entry) ? ((await import(entry)).default as ServerPlugin) : undefined;
    plugins.push({ manifest, dir, server, routes: [] });
  }
  const provided = new Set(plugins.flatMap(p => p.manifest.provides || []));
  for (const p of plugins) for (const n of p.manifest.needs || [])
    if (!provided.has(n)) throw new Error(`plugin ${p.manifest.id} needs service "${n}", which no enabled plugin provides`);
  // providers start first, so a plugin may use its services from start() on
  const startOrder = [...plugins].sort((a, b) => Number(!a.manifest.provides?.length) - Number(!b.manifest.provides?.length));
  for (const p of startOrder) await p.server?.start?.(kernelFor(p.manifest.id));
  for (const p of plugins) p.routes = compileRoutes(p.server?.routes?.(kernelFor(p.manifest.id)) || {});

  const userItems = store.items("user"), userFiles = store.files("user"), links = store.links();
  const shellDir = join(ROOT, "kernel", "web");
  const byId = new Map(plugins.map(p => [p.manifest.id, p]));
  const actions = new Actions(plugins.map(p => p.manifest), store.items("kernel"), events, config.actions || {});

  const kernelApi = async (req: Request, parts: string[], url: URL): Promise<Response> => {
    const [what, id] = parts, m = req.method;
    if (what === "items" && !id && m === "GET") {
      const rel = url.searchParams.get("rel"), to = url.searchParams.get("to");
      return json(userItems.list({
        type: url.searchParams.get("type") || undefined,
        linkedTo: rel && to ? { rel, to } : undefined,
        order: (url.searchParams.get("order") || undefined) as any,
        limit: Number(url.searchParams.get("limit")) || undefined,
      }));
    }
    if (what === "items" && id && m === "GET") { const it = userItems.get(id); return it ? json(it) : json({ error: "not found" }, 404); }
    if (what === "items" && !id && m === "POST") {
      const b = await req.json() as { type?: string; data?: object };
      if (!b.type || !/^[a-z][a-z0-9-]*$/.test(b.type)) return json({ error: "type must be lowercase a-z0-9-" }, 400);
      return json(userItems.create(b.type, b.data || {}), 201);
    }
    if (what === "items" && id && m === "PATCH") {
      const cur = userItems.get(id);
      if (!cur) return json({ error: "not found" }, 404);
      // conditional write: "x-if-updated: <updated>" fails with 409 when someone changed it since
      const want = req.headers.get("x-if-updated");
      if (want && Number(want) !== cur.updated) return json({ error: "changed", item: cur }, 409);
      return json(userItems.update(id, await req.json() as Record<string, unknown>));
    }
    if (what === "items" && id && m === "DELETE") {
      if (!settings().allowDelete) return json({ error: offError().message }, 403);
      const cur = userItems.get(id);
      if (!cur) return json({ error: "not found" }, 404);
      if (cur.type === SETTINGS_TYPE) return json({ error: "settings are never deleted" }, 400);
      if (cur.type === "file" && userItems.usedBy(id).length) return json({ error: "still used by other items" }, 409);
      userItems.remove(id);
      return json({ ok: true, id });
    }
    if (what === "settings" && !id && m === "GET") return json(settings());
    if (what === "settings" && !id && m === "PATCH") {
      try { return json(setSettings(await req.json() as Record<string, unknown>)); }
      catch (e) { return json({ error: (e as Error).message }, (e as { status?: number }).status || 400); }
    }
    if (what === "links" && m === "GET")
      return json(links.list({ src: url.searchParams.get("src") || undefined, rel: url.searchParams.get("rel") || undefined, dst: url.searchParams.get("dst") || undefined }));
    if (what === "links" && m === "POST") {
      const b = await req.json() as { src: string; rel: string; dst: string };
      if (!b.src || !b.rel || !b.dst) return json({ error: "src, rel, dst required" }, 400);
      return json(links.add(b.src, b.rel, b.dst), 201);
    }
    if (what === "files" && !id && m === "POST") {
      const name = url.searchParams.get("name") || "file", mime = req.headers.get("content-type") || "application/octet-stream";
      const fixed = await fixAudio(new Uint8Array(await req.arrayBuffer()), mime);
      return json(userFiles.put(name, fixed.mime, fixed.bytes as Uint8Array<ArrayBuffer>), 201);
    }
    if (what === "files" && id && m === "GET") {
      const it = userItems.get<{ mime: string; name: string }>(id), bytes = await userFiles.read(id);
      if (!it || !bytes) return json({ error: "not found" }, 404);
      const headers: Record<string, string> = { "content-type": it.data.mime, "cache-control": "private, max-age=31536000, immutable",
        "content-disposition": `inline; filename="${encodeURIComponent(it.data.name)}"`, "accept-ranges": "bytes" };
      // a byte range (players seek in long audio without loading it all)
      const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") || ""), size = bytes.length;
      if (r && (r[1] || r[2])) {
        const start = r[1] ? Number(r[1]) : Math.max(0, size - Number(r[2])), end = r[1] && r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
        if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
        return new Response(bytes.subarray(start, end + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}` } });
      }
      return new Response(bytes, { headers });
    }
    if (what === "push") {
      // GET key = the VAPID public key; subscribe {subscription, label} / unsubscribe {endpoint};
      // here {endpoint, tags}: what this device shows now ([] = nothing); devices; test {endpoint?, title?, body?}
      const body = async () => (await req.json().catch(() => ({}))) as Record<string, any>;
      try {
        if (id === "key" && m === "GET") return json({ key: await push.publicKey() });
        if (id === "devices" && m === "GET") return json({ on: pushOn(), devices: push.devices() });
        if (id === "subscribe" && m === "POST") { const b = await body(); return json(push.add(b.subscription, String(b.label || "")), 201); }
        if (id === "unsubscribe" && m === "POST") { const b = await body(); return json({ removed: push.remove(String(b.endpoint || "")) }); }
        if (id === "here" && m === "POST") { const b = await body(); push.setHere(b.endpoint, b.tags ?? []); return json({ ok: true }); }
        if (id === "test" && m === "POST") {
          const b = await body(), only = typeof b.endpoint === "string" && b.endpoint ? b.endpoint : undefined;
          if (only && !push.has(only)) return json({ error: "this device is not subscribed" }, 404);
          const res = await push.notify({ tag: "test", test: true, title: String(b.title || `${config.app.shortName}: test`).slice(0, 120),
            body: String(b.body || "Notifications work on this device.").slice(0, 300), url: "/m/settings" }, { only, ttl: 600 });
          return json({ sent: res.length, results: res.map(r => ({ host: new URL(r.endpoint).host, status: r.status, ok: r.ok, dropped: !!r.dropped, error: r.error })) });
        }
      } catch (e) { return json({ error: (e as Error).message }, (e as { status?: number }).status || 400); }
      return json({ error: "not found" }, 404);
    }
    if (what === "events" && m === "GET") return sse(events, url.searchParams.getAll("topic"), req);
    if (what === "mcp") return actions.mcp(req);
    if (what === "actions" && !id && m === "GET") return json(actions.recent(Number(url.searchParams.get("limit")) || 50));
    if (what === "actions" && id === "stop" && m === "POST") { actions.stop(); return json({ ok: true }); }
    if (what === "actions" && id && m === "POST") {
      try {
        const it = actions.report(id, await req.json() as { status?: string; note?: string; say?: boolean });
        return it ? json(it) : json({ error: "not found" }, 404);
      } catch (e) { return json({ error: (e as Error).message }, 400); }
    }
    if (what === "plugins" && m === "GET") return json({ contract: CONTRACT_VERSION, build: BUILD, app: config.app, settings: settings(), user: config.user, plugins: plugins.map(p => p.manifest) });
    return json({ error: "not found" }, 404);
  };

  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url), parts = url.pathname.split("/").filter(Boolean);
    try {
      if (parts[0] === "k") return await kernelApi(req, parts.slice(1), url);
      if (parts[0] === "p" && parts[1]) {
        const p = byId.get(parts[1]) || byId.get(RENAMED_PLUGINS[parts[1]] || ""); // old addresses (/p/theme/theme.css in saved pages) keep working
        if (!p) return json({ error: "no such plugin" }, 404);
        if (parts[2] === "web" && req.method === "GET") return webFile(join(p.dir, "web"), parts.slice(3).join("/")) || json({ error: "not found" }, 404);
        const hit = matchRoute(p.routes, req.method, parts.slice(2));
        return hit ? await hit.route.handler(req, hit.params) : json({ error: "not found" }, 404);
      }
      if (url.pathname === "/manifest.webmanifest") return json(webManifest(config));
      if (url.pathname === "/sw.js") return webFile(shellDir, "sw.js")!;
      if (parts[0] === "web") return webFile(shellDir, parts.slice(1).join("/")) || json({ error: "not found" }, 404);
      if (url.pathname === "/" || parts[0] === "i" || parts[0] === "m") return webFile(shellDir, "index.html")!; // /i/<id> = an item's address, /m[/<modality>] = a level
      return json({ error: "not found" }, 404);
    } catch (e) {
      console.error(req.method, url.pathname, e);
      return json({ error: String((e as Error)?.message || e) }, 500);
    }
  };

  const stop = async () => { for (const p of plugins) await p.server?.stop?.(); store.db.close(); };
  return { fetch, stop, plugins, store, events, actions, push: pushService };
}

function webManifest(c: Config) {
  return {
    id: "/", name: c.app.name, short_name: c.app.shortName, start_url: "/", scope: "/", display: "standalone",
    background_color: "#000000", theme_color: "#000000",
    icons: [
      { src: "/web/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/web/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/web/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

if (import.meta.main) {
  const path = resolve(process.argv[2] || process.env.SLEIPNYR2_CONFIG || join(ROOT, "config.json"));
  const config = loadConfig(path);
  const app = await createApp(config);
  const server = Bun.serve({ hostname: config.listen.host, port: config.listen.port, fetch: app.fetch, idleTimeout: 0, maxRequestBodySize: 64 * 1024 * 1024 });
  console.log(`${config.app.name}: http://${server.hostname}:${server.port} (plugins: ${app.plugins.map(p => p.manifest.id).join(", ")})`);
  const quit = async () => { server.stop(true); await app.stop(); process.exit(0); };
  process.on("SIGTERM", quit); process.on("SIGINT", quit);
}