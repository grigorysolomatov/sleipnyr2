// Kernel and plugin tests against a temporary data folder and stub agent and
// transcriber services (no network).
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type Config } from "../kernel/server.ts";
import { content, toEvent } from "../plugins/agent-hermes/server.ts";
import { extractMedia, titleFrom } from "../plugins/chat/server.ts";
import { clean, css } from "../plugins/theme/server.ts";

const dir = mkdtempSync(join(tmpdir(), "sleipnyr2-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const config: Config = {
  listen: { host: "127.0.0.1", port: 0 },
  dataDir: dir,
  app: { name: "Test", shortName: "Test", home: "chat" },
  user: { id: "me", name: "Me" },
  plugins: { theme: {}, "agent-hermes": { agents: [] }, "transcribe-http": { url: "" }, chat: { agent: "stub" } },
};
const app = await createApp(config);
afterAll(() => app.stop());


const call = async (method: string, path: string, body?: unknown, type = "application/json") => {
  const init: RequestInit = { method };
  if (body !== undefined) { init.body = typeof body === "string" || body instanceof Uint8Array ? body as any : JSON.stringify(body); init.headers = { "content-type": type }; }
  const r = await app.fetch(new Request("http://x" + path, init));
  return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() };
};

test("items get a permanent address and can be updated", async () => {
  const made = await call("POST", "/k/items", { type: "note", data: { text: "hi", n: 1 } });
  expect(made.status).toBe(201);
  const id = made.body.id;
  const up = await call("PATCH", `/k/items/${id}`, { text: "hello", n: null });
  expect(up.body.data).toEqual({ text: "hello" });
  expect((await call("GET", `/k/items/${id}`)).body.data.text).toBe("hello");
  expect((await call("GET", `/i/${id}`)).status).toBe(200); // the address opens the app
});

test("a conditional update refuses when the item changed since", async () => {
  const it = (await call("POST", "/k/items", { type: "note", data: { n: 1 } })).body;
  const r1 = await app.fetch(new Request(`http://x/k/items/${it.id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-if-updated": String(it.updated) }, body: JSON.stringify({ n: 2 }) }));
  expect(r1.status).toBe(200);
  const r2 = await app.fetch(new Request(`http://x/k/items/${it.id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-if-updated": String(it.updated) }, body: JSON.stringify({ n: 3 }) }));
  expect(r2.status).toBe(409);
  expect((await r2.json() as any).item.data.n).toBe(2);
});

test("links and linked queries", async () => {
  const a = (await call("POST", "/k/items", { type: "note", data: {} })).body.id;
  const b = (await call("POST", "/k/items", { type: "note", data: {} })).body.id;
  await call("POST", "/k/links", { src: a, rel: "about", dst: b });
  expect((await call("GET", `/k/links?dst=${b}`)).body.map((l: any) => l.src)).toEqual([a]);
  expect((await call("GET", `/k/items?rel=about&to=${b}`)).body.map((i: any) => i.id)).toEqual([a]);
});

test("files round-trip as items", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const f = await call("POST", "/k/files?name=x.png", bytes, "image/png");
  expect(f.body.data).toMatchObject({ name: "x.png", mime: "image/png", size: 7 });
  const r = await app.fetch(new Request(`http://x/k/files/${f.body.id}`));
  expect(new Uint8Array(await r.arrayBuffer())).toEqual(bytes);
});

test("bad item types are refused", async () => {
  expect((await call("POST", "/k/items", { type: "Bad Type" })).status).toBe(400);
});

test("plugin web files: typescript converted, no escape from web/", async () => {
  const js = await app.fetch(new Request("http://x/p/chat/web/chat.js"));
  expect(js.status).toBe(200);
  expect((await call("GET", "/p/chat/web/../server.ts")).status).toBe(404);
  expect((await call("GET", "/p/chat/web/%2e%2e/server.ts")).status).toBe(404);
});

test("manifests are listed with their contract", async () => {
  const info = (await call("GET", "/k/plugins")).body;
  expect(info.contract).toBe(1);
  expect(info.plugins.map((p: any) => p.id)).toEqual(["theme", "agent-hermes", "transcribe-http", "chat"]);
});

test("theme css uses only safe tokens", () => {
  const out = css({ bg: "#111", text: "red; } body { x" } as any);
  expect(out).toContain("--bg: #111;");
  expect(out).not.toContain("body {");
});

test("theme values are checked: hex colours and pixel sizes in range only", () => {
  expect(clean("accent-here", "#F08")).toBe("#ff0088");
  expect(clean("accent-here", "#12abef")).toBe("#12abef");
  expect(clean("accent-here", "red")).toBeNull();
  expect(clean("accent-here", "#123; } body {")).toBeNull();
  expect(clean("radius", "12px")).toBe("12px");
  expect(clean("radius", "99px")).toBeNull();
  expect(clean("font", "#ffffff")).toBeNull(); // fonts are not editable here
});

test("theme tokens: a hand change saves to the active theme, null resets, bad values are refused", async () => {
  const before = (await call("GET", "/p/theme/tokens")).body;
  expect(before.tokens["accent-here"]).toBe("#ff0088");
  const up = await call("PATCH", "/p/theme/tokens", { tokens: { "accent-here": "#00aaff", radius: "4px" } });
  expect(up.status).toBe(200);
  expect(up.body.id).toBe(before.id); // the same theme item, never a delete
  expect(await (await app.fetch(new Request("http://x/p/theme/theme.css"))).text()).toContain("--accent-here: #00aaff;");
  for (const bad of [{ "accent-here": "url(x)" }, { font: "x" }, { radius: "100px" }, { "accent-here": "#00ff00", link: "nope" }])
    expect((await call("PATCH", "/p/theme/tokens", { tokens: bad })).status).toBe(400);
  expect((await call("GET", "/p/theme/tokens")).body.tokens["accent-here"]).toBe("#00aaff"); // all or nothing
  const reset = await call("PATCH", "/p/theme/tokens", { tokens: { "accent-here": null, radius: null } });
  expect(reset.body.tokens["accent-here"]).toBe("#ff0088");
  expect(reset.body.tokens.radius).toBe("8px");
});

test("chat: a thread with no agent reports an error, not a hang", async () => {
  const t = (await call("POST", "/p/chat/threads", {})).body;
  const out = await call("POST", `/p/chat/threads/${t.id}/messages`, { text: "hello there" });
  expect(out.status).toBe(201);
  for (let i = 0; i < 50; i++) {
    const msgs = (await call("GET", `/p/chat/threads/${t.id}/messages`)).body;
    if (msgs[1]?.data.status === "error") { expect(msgs[1].data.error).toContain("unknown agent"); break; }
    await Bun.sleep(20);
    if (i === 49) throw new Error("reply never failed");
  }
  expect((await call("GET", `/k/items/${t.id}`)).body.data.title).toBe("hello there");
});

test("chat refuses empty messages and unknown files", async () => {
  const t = (await call("POST", "/p/chat/threads", {})).body;
  expect((await call("POST", `/p/chat/threads/${t.id}/messages`, { text: " " })).status).toBe(400);
  expect((await call("POST", `/p/chat/threads/${t.id}/messages`, { text: "x", files: ["f_nope"] })).status).toBe(400);
});

test("agent content: images become vision parts, others a note", () => {
  const png = { name: "a.png", mime: "image/png", bytes: new Uint8Array([1, 2]) };
  const pdf = { name: "b.pdf", mime: "application/pdf", bytes: new Uint8Array([3]) };
  const c = content("look", [png, pdf]) as any[];
  expect(c[0].text).toContain("a.png");
  expect(c[0].text).toContain("b.pdf");
  expect(c.length).toBe(2);
  expect(c[1].image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  expect(content("plain", [])).toBe("plain");
  // every file gets a download URL; small text files are inlined; binaries are not
  const txt = { id: "f_t", name: "n.txt", mime: "text/plain", bytes: new TextEncoder().encode("secret line") };
  const doc = { id: "f_d", name: "d.pdf", mime: "application/pdf", bytes: new Uint8Array([0x25, 0x50]) };
  const c2 = content("read", [txt, doc], "http://h/k/files") as any[];
  expect(c2.length).toBe(1);
  expect(c2[0].text).toContain("download: http://h/k/files/f_d");
  expect(c2[0].text).toContain("[n.txt]\nsecret line");
  expect(c2[0].text).not.toContain("[d.pdf]\n");
});

test("hermes events map to agent events", () => {
  expect(toEvent({ event: "message.delta", delta: "hi" })).toEqual({ type: "delta", text: "hi" });
  expect(toEvent({ event: "run.completed", output: "x" })).toEqual({ type: "done", text: "x" });
  expect(toEvent({ event: "run.failed", error: "boom" })?.type).toBe("error");
  expect(toEvent({ event: "message.interim", text: "x", already_streamed: true })).toBeNull();
});

test("thread titles", () => {
  expect(titleFrom("  one two three four five six seven eight ")).toBe("one two three four five six seven");
  expect(titleFrom("")).toBe("Voice message");
});

test("chat: MEDIA: lines become files, text keeps the rest", () => {
  const r = extractMedia("Here you go.\n\nMEDIA:/srv/x/audio_cache/a.mp3\n[[audio_as_voice]]\nMEDIA: /tmp/p.png\nBye");
  expect(r.paths).toEqual(["/srv/x/audio_cache/a.mp3", "/tmp/p.png"]);
  const q = extractMedia("Listen: `MEDIA:/h/v.mp3`\nMEDIA:/h/v.mp3");
  expect(q).toEqual({ text: "Listen:", paths: ["/h/v.mp3"] });
  expect(extractMedia("no media here\n\n\nok")).toEqual({ text: "no media here\n\n\nok", paths: [] });
  expect(extractMedia("MEDIA:relative.mp3").paths).toEqual([]);
});

// ---- thread titles ----
import { cleanTitle, retitleDue } from "../plugins/chat/server.ts";

test("cleanTitle: <= 6 words, plain, no trailing period", () => {
  expect(cleanTitle('"Planning the coral colour experiments today now."')).toBe("Planning the coral colour experiments");
  expect(cleanTitle("Title: **Fix the status bar**\nextra line")).toBe("Fix the status bar");
  expect(cleanTitle("a".repeat(80)).length).toBeLessThanOrEqual(40);
  expect(cleanTitle("")).toBe("");
});

test("retitleDue: turns 1, 3, 6, 10 and every 10th after", () => {
  expect([1, 2, 3, 4, 5, 6, 7, 10, 11, 15, 20, 30].filter(retitleDue)).toEqual([1, 3, 6, 10, 20, 30]);
});

test("thread titles: manual rename wins, the agent's rename answers 409 afterwards", async () => {
  const t = (await call("POST", "/p/chat/threads", {})).body;
  expect(t.data.title).toBe("New thread");
  const a = await call("POST", `/p/chat/threads/${t.id}/title`, { title: "Sway bar fixes." });
  expect(a.status).toBe(200);
  expect(a.body.data.title).toBe("Sway bar fixes");
  const m = await call("PATCH", `/p/chat/threads/${t.id}`, { title: "My own name" });
  expect(m.body.data).toMatchObject({ title: "My own name", titleAuto: false });
  const again = await call("POST", `/p/chat/threads/${t.id}/title`, { title: "Agent name" });
  expect(again.status).toBe(409);
  expect((await call("GET", `/k/items/${t.id}`)).body.data.title).toBe("My own name");
  // the first-message placeholder never overrides it either
  await call("POST", `/p/chat/threads/${t.id}/messages`, { text: "hello there general" });
  expect((await call("GET", `/k/items/${t.id}`)).body.data.title).toBe("My own name");
  expect((await call("PATCH", `/p/chat/threads/${t.id}`, { title: "  " })).status).toBe(400);
  expect((await call("POST", "/p/chat/threads/nope/title", { title: "x" })).status).toBe(404);
});

// ---- next thread (plugin next-thread) ----
import { nextThread } from "../plugins/next-thread/server.ts";

test("next thread: clear and continue make fresh threads linked to the old one", async () => {
  const k = { items: { get: (id: string) => app.store.items("user").get(id), create: (t: string, d: object) => app.store.items("next-thread").create(t, d) },
    links: app.store.links() } as any;
  const old = (await call("POST", "/p/chat/threads", {})).body;
  app.store.items("chat").update(old.id, { state: { session_id: "busy-session", run_id: "hung-run" } });
  const c = nextThread(k, old.id, "continue");
  expect(c.data).toMatchObject({ title: "New thread", agent: "stub", state: {}, from: old.id, continues: true });
  expect(app.store.links().list({ src: c.id, rel: "from" }).map(l => l.dst)).toEqual([old.id]);
  expect(nextThread(k, old.id, "clear").data).toMatchObject({ state: {}, continues: false });
  expect(() => nextThread(k, old.id, "nope")).toThrow();
  expect(() => nextThread(k, "nope", "clear")).toThrow();
});

test("next thread from a view's conversation: the new one takes over the view, the old one is archived", async () => {
  const items = app.store.items("next-thread");
  const k = { items: { get: (id: string) => items.get(id), create: (t: string, d: object) => items.create(t, d), update: (id: string, p: object) => items.update(id, p as any) },
    links: app.store.links() } as any;
  const old = (await call("POST", "/p/chat/views/threads/thread")).body;
  const t = nextThread(k, old.id, "clear");
  expect(t.data).toMatchObject({ view: "threads", state: {}, from: old.id, title: old.data.title });
  expect((await call("POST", "/p/chat/views/threads/thread")).body.id).toBe(t.id);
  const listed = (await call("GET", "/p/chat/threads")).body.map((x: any) => x.id);
  expect(listed).not.toContain(old.id);
  expect(listed).not.toContain(t.id);
  const archived = (await call("GET", "/p/chat/threads?hidden=1")).body.map((x: any) => x.id);
  expect(archived).toContain(old.id);
});

test("chat: a message sent from another view keeps where it came from and what that view showed", async () => {
  const t = (await call("POST", "/p/chat/threads", {})).body;
  const out = await call("POST", `/p/chat/threads/${t.id}/messages`, { text: "which is newest?", from: "thread list", context: "[threads on screen: a, b]" });
  expect(out.status).toBe(201);
  expect(out.body.user.data.from).toBe("thread list");
  expect(out.body.user.data.context).toContain("threads on screen");
  const plain = await call("POST", `/p/chat/threads/${t.id}/messages`, { text: "and now?" });
  expect(plain.body.user.data.from).toBeUndefined();
});

// ---- the thread list acts on itself (HCP) ----
import { extractActions } from "../plugins/chat/server.ts";

test("list replies: @name lines become actions, the rest is the answer", () => {
  const r = extractActions("Opened it.\n@open t_abc\n- `@rename t_abc New name here`\n@hide t_x");
  expect(r.text).toBe("Opened it.");
  expect(r.actions).toEqual([{ name: "open", args: "t_abc" }, { name: "rename", args: "t_abc New name here" }, { name: "hide", args: "t_x" }]);
  expect(extractActions("mail me @ noon").actions).toEqual([]);
});

test("an action line may carry a body up to @end", () => {
  const r = extractActions("Made it.\n@note Survey\n- state: ready\n  details\n@end\n@highlight w1");
  expect(r.text).toBe("Made it.");
  expect(r.actions).toEqual([{ name: "note", args: "Survey", body: "- state: ready\n  details" }, { name: "highlight", args: "w1" }]);
  // no @end: the following lines stay text
  const n = extractActions("@title w1 Hello\nsome words");
  expect(n.actions).toEqual([{ name: "title", args: "w1 Hello" }]);
  expect(n.text).toBe("some words");
});

test("hide is reversible and a view's history thread is one, reused, never listed", async () => {
  const t = (await call("POST", "/p/chat/threads", {})).body;
  expect((await call("PATCH", `/p/chat/threads/${t.id}`, { hidden: true })).body.data.hidden).toBe(true);
  expect((await call("GET", "/p/chat/threads")).body.map((x: any) => x.id)).not.toContain(t.id);
  expect((await call("GET", "/p/chat/threads?hidden=1")).body.map((x: any) => x.id)).toContain(t.id);
  expect((await call("PATCH", `/p/chat/threads/${t.id}`, { hidden: false })).body.data.hidden).toBeUndefined();
  expect((await call("GET", "/p/chat/threads")).body.map((x: any) => x.id)).toContain(t.id);
  const a = (await call("POST", "/p/chat/views/threads/thread")).body, b = (await call("POST", "/p/chat/views/threads/thread")).body;
  expect(a.id).toBe(b.id);
  expect(a.data.view).toBe("threads");
  expect((await call("GET", "/p/chat/threads")).body.map((x: any) => x.id)).not.toContain(a.id);
  expect((await call("PATCH", `/p/chat/threads/${a.id}`, { hidden: true })).status).toBe(400);
  expect((await call("PATCH", `/p/chat/threads/${t.id}`, {})).status).toBe(400);
});

// ---------------------------------------------------------------- declared agent actions (MCP)
import { checkArgs } from "../kernel/actions.ts";

const KEY = "test-key-agent-0123456789", OTHER = "test-key-nobody-0123456789";
process.env.S2_TEST_AGENT = KEY; process.env.S2_TEST_GUEST = OTHER;
// A second app, made when these tests start: plugins keep one instance per
// process (chat's module state), so making it at load time would take over
// the first app's chat before the tests above run.
let actApp: Awaited<ReturnType<typeof createApp>>;
test("actions: an app with agent grants starts", async () => {
  app.stop();
  actApp = await createApp({ ...config, dataDir: mkdtempSync(join(tmpdir(), "sleipnyr2-act-")),
    actions: { ackMs: 300, agents: { assistant: { keyEnv: "S2_TEST_AGENT", grants: { chat: "look" } }, guest: { keyEnv: "S2_TEST_GUEST" } } } });
});
afterAll(() => actApp?.stop());
const mcp = async (body: unknown, key?: string) => {
  const r = await actApp.fetch(new Request("http://x/k/mcp", { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(key ? { authorization: `Bearer ${key}` } : {}) } }));
  return { status: r.status, body: r.status === 202 ? null : await r.json() as any };
};

test("actions: the MCP server lists the plugins' declared actions to a granted agent", async () => {
  const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, KEY);
  expect(init.body.result.capabilities.tools).toBeTruthy();
  expect((await mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, KEY)).status).toBe(202);
  const list = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, KEY);
  const names = list.body.result.tools.map((t: any) => t.name);
  expect(names).toEqual(expect.arrayContaining(["chat_blink", "chat_highlight", "chat_reply_open"]));
  const blink = list.body.result.tools.find((t: any) => t.name === "chat_blink");
  expect(blink.inputSchema.properties.times).toMatchObject({ type: "integer", minimum: 1, maximum: 20 });
  // an agent with no grant sees nothing
  expect((await mcp({ jsonrpc: "2.0", id: 3, method: "tools/list" }, OTHER)).body.result.tools).toEqual([]);
});

test("actions: unknown callers and ungranted agents are refused, and the refusals are logged", async () => {
  const call = { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "chat_blink", arguments: {} } };
  expect((await mcp(call)).status).toBe(401);
  expect((await mcp(call, "wrong-key-wrong-key-wrong")).status).toBe(401);
  const guest = await mcp(call, OTHER);
  expect(guest.body.result.isError).toBe(true);
  expect(guest.body.result.content[0].text).toContain("Refused");
  const log = await actApp.fetch(new Request("http://x/k/actions"));
  const rows = await log.json() as any[];
  expect(rows.filter(r => r.data.status === "refused").map(r => r.data.agent)).toEqual(expect.arrayContaining(["?", "guest"]));
});

test("actions: arguments are typed and bounded; there is no code argument", () => {
  const decl = actApp.actions.tools.get("chat_blink")!.decl;
  expect(checkArgs(decl, {})).toEqual({ args: { target: "selection", times: 3, interval_ms: 500, colours: ["#ffdd00"] } });
  expect("error" in checkArgs(decl, { times: 99 })).toBe(true);
  expect("error" in checkArgs(decl, { times: 2.5 })).toBe(true);
  expect("error" in checkArgs(decl, { colours: ["red;}body{display:none"] })).toBe(true);
  expect("error" in checkArgs(decl, { target: "a\"] *" })).toBe(true);
  expect("error" in checkArgs(decl, { script: "alert(1)" })).toBe(true);
});

test("view actions: the kernel's generic tools are declared once, typed and need a grant on \"view\"", async () => {
  const names = [...actApp.actions.tools.keys()].filter(n => n.startsWith("view_"));
  expect(names.sort()).toEqual(["view_animate", "view_describe", "view_focus", "view_mark", "view_order", "view_scroll_to"]);
  // the assistant holds chat only: no view tools listed, a call is refused
  const list = await mcp({ jsonrpc: "2.0", id: 7, method: "tools/list" }, KEY);
  expect(list.body.result.tools.some((t: any) => t.name.startsWith("view_"))).toBe(false);
  const r = await mcp({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "view_mark", arguments: { targets: ["t_x"] } } }, KEY);
  expect(r.body.result.content[0].text).toContain("Refused");
  const anim = actApp.actions.tools.get("view_animate")!.decl;
  expect("error" in checkArgs(anim, { targets: ["a"], frames: ["opacity:0", "opacity:1"] })).toBe(false);
  expect("error" in checkArgs(anim, { targets: ["a"], frames: ["opacity:0", "background-image:url(x)"] })).toBe(true);
  expect("error" in checkArgs(anim, { targets: ["a"], frames: ["opacity:0", "opacity:1;}body{display:none"] })).toBe(true);
  expect("error" in checkArgs(anim, { targets: ["a"], frames: ["opacity:0", "content:'x'"] })).toBe(true);
  const mark = actApp.actions.tools.get("view_mark")!.decl;
  expect("error" in checkArgs(mark, { targets: ["a\"] *"] })).toBe(true);
  expect("error" in checkArgs(mark, { targets: ["a"], color: "var(--accent-here)" })).toBe(false);
});

test("actions: a call is relayed to open pages, which report back; stop is broadcast", async () => {
  const seen: any[] = [];
  const off = actApp.events.subscribe("action", m => {
    seen.push(m);
    const run = (m as any).run;
    if (run) actApp.fetch(new Request(`http://x/k/actions/${run.id}`, { method: "POST", body: JSON.stringify({ status: "running" }) }))
      .then(() => actApp.fetch(new Request(`http://x/k/actions/${run.id}`, { method: "POST", body: JSON.stringify({ status: "done", note: "blinked 5×" }) })));
  });
  const r = await mcp({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "chat_blink", arguments: { times: 5, interval_ms: 500 } } }, KEY);
  expect(r.body.result.isError).toBe(false);
  expect(seen[0].run).toMatchObject({ plugin: "chat", action: "blink", args: { times: 5, interval_ms: 500, target: "selection" } });
  await Bun.sleep(50);
  const it = (await (await actApp.fetch(new Request(`http://x/k/items/${seen[0].run.id}`))).json()) as any;
  expect(it.data).toMatchObject({ agent: "assistant", status: "done", note: "blinked 5×", pages: 1 });
  await actApp.fetch(new Request("http://x/k/actions/stop", { method: "POST", body: "{}" }));
  expect(seen.at(-1)).toEqual({ stop: true });
  off();
  // no page open: the agent is told nothing ran
  const none = await mcp({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "chat_reply_open", arguments: {} } }, KEY);
  expect(none.body.result.content[0].text).toContain("no Sleipnyr page is open");
});
