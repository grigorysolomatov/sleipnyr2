// The kernel: loads the config and the plugins, serves the shell, the kernel
// HTTP API and each plugin's routes and web files. See README.md.
//
//   bun kernel/server.ts [config.json]      (or SLEIPNYR2_CONFIG=...)
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, normalize, resolve } from "node:path";
import {
  CONTRACT_VERSION, ITEM_TOPIC,
  type Events, type Handler, type Kernel, type Manifest, type ServerPlugin, type Services,
} from "./contract.ts";
import { Actions, type ActionsConfig } from "./actions.ts";
import { Store } from "./store.ts";

const ROOT = resolve(import.meta.dir, "..");
/** Release id (the deployed commit dir name, e.g. releases/<sha>); the web shell offers an update when it changes. */
const BUILD = basename(realpathSync(ROOT));

export interface Config {
  listen: { host: string; port: number };
  dataDir: string;
  app: { name: string; shortName: string; home: string; agentName?: string }; // home = plugin shown at "/"; agentName = how the UI names the agent
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
const RENAMED_PLUGINS: Record<string, string> = { sessions: "blackboards" };

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
      ping = setInterval(() => { try { ctl.enqueue(enc.encode(": ping\n\n")); } catch { close(); } }, 20000);
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

  const kernelFor = (id: string): Kernel => ({
    contract: CONTRACT_VERSION, items: store.items(id), links: store.links(), files: store.files(id),
    events, services, config: config.plugins[id] || {}, user: config.user, app: { ...config.app, agentName: config.app.agentName || "Agent" },
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
      return new Response(bytes, { headers: { "content-type": it.data.mime, "cache-control": "private, max-age=31536000, immutable",
        "content-disposition": `inline; filename="${encodeURIComponent(it.data.name)}"` } });
    }
    if (what === "events" && m === "GET") return sse(events, url.searchParams.getAll("topic"), req);
    if (what === "mcp") return actions.mcp(req);
    if (what === "actions" && !id && m === "GET") return json(actions.recent(Number(url.searchParams.get("limit")) || 50));
    if (what === "actions" && id === "stop" && m === "POST") { actions.stop(); return json({ ok: true }); }
    if (what === "actions" && id && m === "POST") {
      try {
        const it = actions.report(id, await req.json() as { status?: string; note?: string });
        return it ? json(it) : json({ error: "not found" }, 404);
      } catch (e) { return json({ error: (e as Error).message }, 400); }
    }
    if (what === "plugins" && m === "GET") return json({ contract: CONTRACT_VERSION, build: BUILD, app: config.app, user: config.user, plugins: plugins.map(p => p.manifest) });
    return json({ error: "not found" }, 404);
  };

  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url), parts = url.pathname.split("/").filter(Boolean);
    try {
      if (parts[0] === "k") return await kernelApi(req, parts.slice(1), url);
      if (parts[0] === "p" && parts[1]) {
        const p = byId.get(parts[1]);
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
  return { fetch, stop, plugins, store, events, actions };
}

function webManifest(c: Config) {
  return {
    name: c.app.name, short_name: c.app.shortName, start_url: "/", scope: "/", display: "standalone",
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