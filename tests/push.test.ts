// Phone notifications (kernel/push.ts, web/sw.js): RFC 8291 test vector, VAPID key
// file + JWT, the /k/push routes against a fake push service that decrypts what
// the kernel sent (like a phone), presence (a device showing the tag gets
// nothing; seen tags travel as `read`), 404/410 drops, the "notifications"
// feature switch, chat's reply notification, and the service worker's handlers
// in a fake worker scope.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../kernel/server.ts";
import { allowedEndpoint, b64u, decrypt, encrypt, unb64u } from "../kernel/push.ts";
import { replyNote } from "../plugins/chat/server.ts";

const subtle = crypto.subtle;
type Bytes = Uint8Array<ArrayBuffer>;
const ecdh = async (d: string, pub: string) => {
  const p = unb64u(pub), jwk = { kty: "EC", crv: "P-256", d, x: b64u(p.slice(1, 33)), y: b64u(p.slice(33)), ext: true };
  const { d: _, ...pubJwk } = jwk;
  return { privateKey: await subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]),
    publicKey: await subtle.importKey("jwk", pubJwk, { name: "ECDH", namedCurve: "P-256" }, true, []) } as CryptoKeyPair;
};

test("RFC 8291 Appendix A test vector", async () => {
  const as = await ecdh("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
  const uaPub = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
  const body = await encrypt(new TextEncoder().encode("When I grow up, I want to be a watermelon"), uaPub, "BTBZMqHH6r4Tts7J_aSIgg",
    { as, salt: unb64u("DGv6ra1nlYgDCS1FRnbzlw") });
  expect(b64u(body)).toBe(b64u(new Uint8Array([...unb64u("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"), ...unb64u("8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ")])));
  const ua = await ecdh("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94", uaPub);
  expect(new TextDecoder().decode(await decrypt(body, ua, unb64u("BTBZMqHH6r4Tts7J_aSIgg")))).toBe("When I grow up, I want to be a watermelon");
});

test("known push services only; https", () => {
  for (const u of ["https://fcm.googleapis.com/fcm/send/x", "https://jmt17.google.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/x"])
    expect(allowedEndpoint(u)).toBe(true);
  for (const u of ["http://fcm.googleapis.com/x", "https://google.com.evil.example/x", "https://evilgoogle.com/x", "not a url"])
    expect(allowedEndpoint(u)).toBe(false);
});

test("chat's reply notification: thread tag, address, plain body", () => {
  const t = (data: any) => ({ id: "t_1", type: "thread", data, created: 0, updated: 0 }) as any;
  expect(replyNote(t({ title: "Jobs", agent: "a", state: {} }), "**Done.** See `x`\n@open t_2\nMEDIA:/tmp/a.png", 0, "Ag"))
    .toEqual({ tag: "thread:t_1", title: "Jobs", body: "Done. See x", url: "/i/t_1" });
  expect(replyNote(t({ title: "Columns conversation", view: "columns-c_9", place: { level: "columns", sub: "c_9", name: "Growth" }, agent: "a", state: {} }), "", 2, "Ag"))
    .toEqual({ tag: "thread:t_1", title: "Growth", body: "Ag sent 2 files", url: "/m/columns/c_9" });
  expect(replyNote(t({ title: "Picker", view: "picker", place: { level: "picker", sub: "", name: "" }, agent: "a", state: {} }), "x".repeat(300), 0, "Ag").body!.length).toBe(180);
  expect(replyNote(t({ title: "", view: "threads", agent: "a", state: {} }), "hi", 0, "Ag")).toMatchObject({ title: "Ag", url: "/" });
});

// ---- kernel + fake push service ----
let dir = "", app: Awaited<ReturnType<typeof createApp>>, fake: ReturnType<typeof Bun.serve>, fakeBase = "";
const got: { path: string; headers: Record<string, string>; body: Bytes }[] = [];
let answer = 201;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sleipnyr2-push-"));
  fake = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const headers: Record<string, string> = {}; req.headers.forEach((v, k) => { headers[k] = v; });
    got.push({ path: new URL(req.url).pathname, headers, body: new Uint8Array(await req.arrayBuffer()) });
    return new Response("", { status: answer });
  } });
  fakeBase = `http://127.0.0.1:${fake.port}`;
  process.env.SLEIPNYR2_PUSH_TEST_HOSTS = `127.0.0.1:${fake.port}`;
  app = await createApp({ listen: { host: "127.0.0.1", port: 0 }, dataDir: dir, app: { name: "Test", shortName: "Test", home: "chat", agentName: "Ag" },
    user: { id: "me", name: "Me" }, plugins: { settings: {}, "agent-hermes": { agents: [] }, "transcribe-http": { url: "" }, chat: { agent: "stub" } } });
});
afterAll(() => { app?.stop(); fake?.stop(true); rmSync(dir, { recursive: true, force: true }); delete process.env.SLEIPNYR2_PUSH_TEST_HOSTS; });

const call = async (method: string, path: string, body?: unknown) => {
  const r = await app.fetch(new Request("http://x" + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) }));
  return { status: r.status, body: await r.json().catch(() => ({})) as any };
};
async function device() { // a browser's subscription: its own ECDH key + auth secret
  const ua = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const p256dh = b64u(await subtle.exportKey("raw", ua.publicKey));
  return { ua, auth, sub: { endpoint: `${fakeBase}/push/${crypto.randomUUID()}`, keys: { p256dh, auth: b64u(auth) } } };
}
type Dev = Awaited<ReturnType<typeof device>>;
const received = async (d: Dev) => {
  const g = got.find(x => d.sub.endpoint.endsWith(x.path));
  return g ? JSON.parse(new TextDecoder().decode(await decrypt(g.body, d.ua, d.auth))) : null;
};

describe("kernel push", () => {
  test("VAPID key made once: file 600 in a 700 dir; GET /k/push/key", async () => {
    const k1 = (await call("GET", "/k/push/key")).body.key;
    expect(unb64u(k1).length).toBe(65);
    const f = join(dir, "push", "vapid.json");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "push")).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(f, "utf8")).d).toBeTruthy();
    expect((await call("GET", "/k/push/key")).body.key).toBe(k1);
  });
  test("subscribe validates endpoint + keys; here validates tags", async () => {
    const d = await device();
    expect((await call("POST", "/k/push/subscribe", { subscription: { ...d.sub, endpoint: "https://evil.example/x" } })).status).toBe(400);
    expect((await call("POST", "/k/push/subscribe", { subscription: { ...d.sub, keys: { p256dh: "AAAA", auth: d.sub.keys.auth } } })).status).toBe(400);
    expect((await call("POST", "/k/push/here", { endpoint: d.sub.endpoint, tags: "x" })).status).toBe(400);
  });
  test("test push: VAPID JWT verifies, payload decrypts, topic + urgency set; unknown device 404", async () => {
    const d = await device();
    expect((await call("POST", "/k/push/subscribe", { subscription: d.sub, label: "test device" })).body).toMatchObject({ created: true });
    expect((await call("GET", "/k/push/devices")).body.devices.some((x: any) => x.label === "test device")).toBe(true);
    got.length = 0;
    expect((await call("POST", "/k/push/test", { endpoint: d.sub.endpoint })).body).toMatchObject({ sent: 1, results: [{ ok: true, status: 201 }] });
    expect(got.length).toBe(1);
    const h = got[0].headers;
    expect(h["content-encoding"]).toBe("aes128gcm");
    expect(h.urgency).toBe("high");
    expect(Number(h.ttl)).toBe(600);
    expect(h.topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h.authorization)!;
    expect(m).toBeTruthy();
    const claims = JSON.parse(Buffer.from(m[2], "base64url").toString());
    expect(claims.aud).toBe(fakeBase);
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
    expect(claims.sub).toMatch(/^mailto:/);
    const vk = await subtle.importKey("raw", unb64u(m[4]), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, vk, unb64u(m[3]), new TextEncoder().encode(`${m[1]}.${m[2]}`))).toBe(true);
    expect(await received(d)).toMatchObject({ tag: "test", title: "Test: test", url: "/m/settings", test: true });
    expect((await call("POST", "/k/push/test", { endpoint: `${fakeBase}/push/none` })).status).toBe(404);
    await call("POST", "/k/push/unsubscribe", { endpoint: d.sub.endpoint });
  });
  test("presence: the device showing the tag gets nothing; seen tags close everywhere with the next push; 410 drops", async () => {
    const a = await device(), b = await device();
    for (const x of [a, b]) await call("POST", "/k/push/subscribe", { subscription: x.sub });
    got.length = 0;
    await app.push.notify({ tag: "thread:t_a", title: "One", body: "first", url: "/i/t_a" });
    expect(await received(a)).toMatchObject({ tag: "thread:t_a", title: "One", url: "/i/t_a" });
    expect(await received(b)).toMatchObject({ tag: "thread:t_a" });
    // a shows that thread: he is looking at it, so no device gets a push for it
    await call("POST", "/k/push/here", { endpoint: a.sub.endpoint, tags: ["thread:t_a"] });
    expect(app.push.looking("thread:t_a")).toBe(true);
    got.length = 0;
    expect(await app.push.notify({ tag: "thread:t_a", title: "Two" })).toEqual([]);
    expect(got.length).toBe(0);
    // another thread still reaches both
    await app.push.notify({ tag: "thread:t_z", title: "Other" });
    // ... and tells b that t_a was read (seen after its last push), so b closes it
    expect(await received(b)).toMatchObject({ title: "Other", read: ["thread:t_a"] });
    await call("POST", "/k/push/here", { endpoint: a.sub.endpoint, tags: [] });
    expect(app.push.looking("thread:t_a")).toBe(false);
    got.length = 0;
    await app.push.notify({ tag: "thread:t_c", title: "Four" });
    expect((await received(b)).read).toBeUndefined(); // only once
    answer = 410;
    await app.push.notify({ tag: "thread:t_d", title: "Gone" });
    answer = 201;
    expect((await call("GET", "/k/push/devices")).body.devices.length).toBe(0);
  });
  test("Settings > Features > Notifications off: no push at all", async () => {
    const d = await device();
    await call("POST", "/k/push/subscribe", { subscription: d.sub });
    expect((await call("PATCH", "/k/settings", { features: { notifications: false } })).status).toBe(200);
    got.length = 0;
    expect(await app.push.notify({ tag: "thread:t_x", title: "Off" })).toEqual([]);
    expect((await call("GET", "/k/push/devices")).body.on).toBe(false);
    await call("PATCH", "/k/settings", { features: { notifications: null } });
    expect((await app.push.notify({ tag: "thread:t_x", title: "On" })).length).toBe(1);
  });
});

// ---- service worker handlers in a fake worker scope ----
describe("sw.js push + notificationclick", () => {
  async function loadSw(wins: any[]) {
    const handlers: Record<string, (ev: any) => void> = {}, notes: any[] = [], opened: string[] = [];
    const self: any = {
      location: new URL("https://app.example/sw.js"),
      addEventListener: (t: string, f: any) => { handlers[t] = f; },
      registration: { showNotification: async (title: string, o: any) => { const n = { title, ...o, close: () => { const i = notes.indexOf(n); if (i >= 0) notes.splice(i, 1); } }; notes.push(n); },
        getNotifications: async () => [...notes] },
      clients: { matchAll: async () => wins, openWindow: async (u: string) => { opened.push(u); return {}; }, claim: async () => {} },
      skipWaiting: () => {},
    };
    const src = readFileSync(join(import.meta.dir, "..", "kernel", "web", "sw.js"), "utf8");
    new Function("self", "caches", "fetch", src)(self, { open: async () => ({ addAll: async () => {} }), keys: async () => [] }, async () => new Response("{}"));
    const fire = async (type: string, ev: any) => { let p: Promise<any> = Promise.resolve(); handlers[type]({ ...ev, waitUntil: (x: Promise<any>) => { p = x; } }); await p; };
    return { fire, notes, opened };
  }
  const data = (d: any) => ({ data: { json: () => d, text: () => JSON.stringify(d) } });
  test("push shows one notification per tag; read closes others", async () => {
    const s = await loadSw([]);
    await s.fire("push", data({ tag: "thread:a", title: "A", body: "1", url: "/i/a" }));
    await s.fire("push", data({ tag: "thread:b", title: "B", body: "1", url: "/i/b" }));
    await s.fire("push", data({ tag: "thread:a", title: "A", body: "2", url: "/i/a" }));
    expect(s.notes.map(n => [n.tag, n.body])).toEqual([["thread:b", "1"], ["thread:a", "2"]]);
    expect(s.notes[1]).toMatchObject({ renotify: true, data: { url: "/i/a" }, icon: "/web/icons/icon-192.png", badge: "/web/icons/badge-96.png" });
    await s.fire("push", data({ tag: "thread:c", title: "C", read: ["thread:a", "thread:b"] }));
    expect(s.notes.map(n => n.tag)).toEqual(["thread:c"]);
  });
  test("tap focuses an open window and moves it; else opens; never another origin", async () => {
    const nav: string[] = [];
    const win: any = { url: "https://app.example/", focus: async () => win, navigate: async (u: string) => { nav.push(u); } };
    const s = await loadSw([win]);
    let closed = false;
    await s.fire("notificationclick", { notification: { data: { url: "/m/columns/c_1" }, close: () => { closed = true; } } });
    expect(closed).toBe(true);
    expect(nav).toEqual(["https://app.example/m/columns/c_1"]);
    const s2 = await loadSw([]);
    await s2.fire("notificationclick", { notification: { data: { url: "https://evil.example/x" }, close: () => {} } });
    expect(s2.opened).toEqual(["https://app.example/"]);
  });
});
