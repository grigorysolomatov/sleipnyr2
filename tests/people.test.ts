// People: two instances in one process exchange signed messages; a peer that
// is offline gets them later in order; a wrong key is refused.
import { afterAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../kernel/server.ts";
import { checkRequest, decodeInvite, encodeInvite, idFor, keysOf, People, peersOf, safetyCode, signRequest } from "../plugins/people/server.ts";
import { existsSync, readFileSync, statSync } from "node:fs";

const key = () => generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const A = key(), B = key(), EVE = key();
const dirs: string[] = [];
async function instance(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `sleipnyr2-people-${name}-`)); dirs.push(dir);
  return createApp({ listen: { host: "127.0.0.1", port: 0 }, dataDir: dir, app: { name, shortName: name, home: "chat" },
    user: { id: "me", name }, plugins: { theme: {} } });
}
const a = await instance("Ada"), b = await instance("Bo");
afterAll(() => { for (const x of [a, b]) x.stop(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// wire the two People objects straight to each other's receive(); "offline" makes B unreachable
let offline = false;
const kOf = (app: typeof a, name: string, peers: unknown) => ({
  items: app.store.items("people"), links: app.store.links(), files: app.store.files("people"),
  config: { peers }, user: { id: "me", name }, log: () => {},
}) as any;
const pa = new People(kOf(a, "Ada", [{ id: "bo", name: "Bo", url: "http://bo.test", key: keysOf(B).pub }]), { PEOPLE_KEY: A },
  (async (_u: string, init: RequestInit) => {
    if (offline) throw new Error("connection refused");
    return pb.receive(new Request("http://bo.test/peer/inbox", init));
  }) as any);
const pb = new People(kOf(b, "Bo", [{ id: "ada", name: "Ada", url: "http://ada.test", key: keysOf(A).pub }]), { PEOPLE_KEY: B },
  (async (_u: string, init: RequestInit) => pa.receive(new Request("http://ada.test/peer/inbox", init))) as any);

test("bad peer entries are left out", () => {
  expect(peersOf([{ id: "x", name: "X", url: "ftp://x", key: keysOf(A).pub }, { id: "y", name: "Y", url: "https://y/", key: keysOf(A).pub }, null]))
    .toEqual([{ id: "y", name: "Y", url: "https://y", key: keysOf(A).pub }]);
});

test("messages go both ways and are stored on both sides", async () => {
  pa.write("bo", { text: "Hi Bo" });
  await pa.flush("bo");
  const got = pb.all("ada");
  expect(got.map(m => [m.data.dir, m.data.name, m.data.text])).toEqual([["in", "Ada", "Hi Bo"]]);
  expect(pa.all("bo")[0].data.state).toBe("sent");
  pb.write("ada", { text: "Hi Ada" });
  await pb.flush("ada");
  expect(pa.all("bo").map(m => [m.data.dir, m.data.text])).toEqual([["out", "Hi Bo"], ["in", "Hi Ada"]]);
});

test("an attachment arrives as a file on the other side", async () => {
  const f = a.store.files("user").put("note.txt", "text/plain", new TextEncoder().encode("hello file") as any);
  pa.write("bo", { text: "see file", files: [f.id] });
  await pa.flush("bo");
  const last = pb.all("ada").at(-1)!;
  expect(last.data.files.length).toBe(1);
  expect(new TextDecoder().decode((await b.store.files("people").read(last.data.files[0]))!)).toBe("hello file");
});

test("offline peer: queued in order, delivered once it is back, no duplicates", async () => {
  offline = true;
  pa.write("bo", { text: "one" }); pa.write("bo", { text: "two" });
  await pa.flush("bo");
  const q = pa.all("bo").filter(m => m.data.state === "queued");
  expect(q.map(m => m.data.text)).toEqual(["one", "two"]);
  expect(q[0].data.tries).toBe(1);
  expect(q[0].data.error).toContain("not reachable");
  offline = false;
  await pa.flush("bo", () => Date.now() + 60_000); // the retry is due
  expect(pb.all("ada").filter(m => m.data.dir === "in").map(m => m.data.text).slice(-2)).toEqual(["one", "two"]);
  // the same signed message again (a lost answer) is stored once
  const m = pa.all("bo").at(-1)!;
  pa.k.items.update(m.id, { state: "queued", next: 0 });
  await pa.flush("bo");
  expect(pb.all("ada").filter(x => x.data.text === "two").length).toBe(1);
});

test("when the peer writes, what waits for it goes out at once", async () => {
  offline = true;
  pa.write("bo", { text: "queued until Bo writes" });
  await pa.flush("bo");
  const m = pa.all("bo").at(-1)!;
  expect(m.data.state).toBe("queued");
  expect(m.data.next! > Date.now() + 1000).toBe(true); // next retry is later
  offline = false;
  pb.write("ada", { text: "I am back" });
  await pb.flush("ada");
  await Bun.sleep(20); // receive() queues the flush
  expect(pa.k.items.get(m.id)!.data.state).toBe("sent");
});

test("a wrong key, a forged signature or an old request is refused", async () => {
  const path = "/peer/inbox", body = JSON.stringify({ v: 1, to: keysOf(B).pub, uid: crypto.randomUUID(), sent: 1, name: "Eve", text: "x", files: [] });
  const eve = keysOf(EVE);
  const r1 = await pb.receive(new Request("http://bo.test" + path, { method: "POST", body, headers: signRequest(eve.priv, eve.pub, path, body) }));
  expect(r1.status).toBe(403);
  const ak = keysOf(A), forged = signRequest(eve.priv, ak.pub, path, body); // claims Ada's key, signed by Eve
  const r2 = await pb.receive(new Request("http://bo.test" + path, { method: "POST", body, headers: forged }));
  expect(r2.status).toBe(401);
  const old = signRequest(ak.priv, ak.pub, path, body, Date.now() - 3_600_000);
  expect("error" in checkRequest(pb.peers, new Headers(old), path, body)).toBe(true);
  expect(pb.all("ada").some(m => m.data.name === "Eve")).toBe(false);
});

test("a refused message is marked failed and not retried until asked", async () => {
  const wrong = new People(kOf(a, "Ada", [{ id: "bo", name: "Bo", url: "http://bo.test", key: keysOf(EVE).pub }]), { PEOPLE_KEY: A },
    (async (_u: string, init: RequestInit) => pb.receive(new Request("http://bo.test/peer/inbox", init))) as any);
  const m = wrong.write("bo", { text: "to the wrong key" });
  await wrong.flush("bo");
  expect(wrong.k.items.get(m.id)!.data.state).toBe("failed");
});

test("without a key or peers nothing listens and the summary says so", () => {
  const none = new People(kOf(a, "Ada", []), {});
  expect(none.ready).toBe(false);
  expect(none.summary().me.key).toBe("");
  expect(() => none.write("bo", { text: "x" })).toThrow();
});

// ---------------------------------------------------------------- invite pairing

const pk = (app: typeof a, name: string, dir: string, extra: Record<string, unknown> = {}) => ({
  items: app.store.items("people"), links: app.store.links(), files: app.store.files("people"),
  config: { inbox: { port: 0 }, ...extra }, user: { id: "me", name }, log: () => {}, privateDir: dir, events: { publish: () => {}, subscribe: () => () => {} },
}) as any;
const tmp = (n: string) => { const d = mkdtempSync(join(tmpdir(), `sleipnyr2-people-${n}-`)); dirs.push(d); return join(d, "private"); };

test("invite codes round-trip, survive line breaks and a surrounding message, and expire", () => {
  const inv = { v: 1 as const, name: "Ada", url: "https://ada.example.ts.net:10000", key: keysOf(A).pub, token: "t".repeat(32), exp: Date.now() + 1000 };
  const code = encodeInvite(inv);
  expect(decodeInvite(code)).toEqual(inv);
  expect(decodeInvite(`Hi! Here is my code:\n${code.slice(0, 30)}\n${code.slice(30)} \nbye`)).toEqual(inv);
  expect("error" in decodeInvite(code, inv.exp + 1)).toBe(true);
  expect("error" in decodeInvite("hello")).toBe(true);
  expect("error" in decodeInvite(code.slice(0, -10))).toBe(true);
});

test("safety codes match on both sides and differ per pair; ids are unique", () => {
  const ka = keysOf(A).pub, kb = keysOf(B).pub, ke = keysOf(EVE).pub;
  expect(safetyCode(ka, kb)).toBe(safetyCode(kb, ka));
  expect(safetyCode(ka, kb)).toMatch(/^\d{3} \d{3}$/);
  expect(safetyCode(ka, ke)).not.toBe(safetyCode(ka, kb));
  expect(idFor("Jón Ó", ["jon-o"])).toBe("jon-o-2");
});

test("invite -> accept pairs both sides without a restart; the token is single use; keys stay private", async () => {
  const da = tmp("ia"), db = tmp("ib"), de = tmp("ie");
  let qa: People, qb: People, qe: People;
  const net = (async (u: string, init: RequestInit = {}) => {
    const target = u.startsWith("https://ada.test") ? qa : u.startsWith("https://bo.test") ? qb : null;
    if (!target) throw new Error("connection refused");
    return target.receive(new Request(u, init));
  }) as any;
  qa = new People(pk(a, "Cy", da, { publicUrl: "https://ada.test" }), {}, net);
  qb = new People(pk(b, "Dee", db), {}, net);
  qe = new People(pk(b, "Eve", de, { publicUrl: "https://eve.test" }), {}, net);
  expect(qa.ready).toBe(false);
  expect(existsSync(join(da, "key"))).toBe(false);
  // B has no address yet: accepting asks for it first
  const { code } = qa.invite();
  expect(qa.ready).toBe(true);
  expect(statSync(join(da, "key")).mode & 0o777).toBe(0o600);
  expect(statSync(da).mode & 0o777).toBe(0o700);
  expect(JSON.stringify(qa.summary())).not.toContain(readFileSync(join(da, "key"), "utf8").trim());
  expect(code).not.toContain(readFileSync(join(da, "key"), "utf8").trim().slice(20, 60));
  await expect(qb.accept(code)).rejects.toThrow(/address/);
  qb.setPublicUrl("https://bo.test/");
  const got = await qb.accept(code);
  expect(got.peer.name).toBe("Cy");
  expect(got.warning).toBeUndefined(); // A could reach B's inbox
  expect(qa.peers.map(p => p.name)).toEqual(["Dee"]);
  expect(qb.peers.map(p => p.name)).toEqual(["Cy"]);
  expect(qa.summary().peers[0].safety).toBe(got.safety);
  expect(qb.summary().peers[0].safety).toBe(got.safety);
  // messages flow both ways right away
  qb.write(got.peer.id, { text: "paired!" }); await qb.flush(got.peer.id);
  expect(qa.all(qa.peers[0].id).map(m => m.data.text)).toEqual(["paired!"]);
  // the same code again (Eve copied it): refused, nothing added
  await expect(qe.accept(code)).rejects.toThrow(/already used|expired/);
  expect(qa.peers.length).toBe(1);
  // a fresh token, but the request is signed by a key other than the one it names: refused
  const { code: c2 } = qa.invite(), inv = decodeInvite(c2) as any;
  const ev = keysOf(EVE), body = JSON.stringify({ v: 1, to: inv.key, token: inv.token, name: "Mallory", url: "https://m.test", key: keysOf(B).pub });
  const r = await qa.receive(new Request("https://ada.test/peer/pair", { method: "POST", body, headers: signRequest(ev.priv, keysOf(B).pub, "/peer/pair", body) }));
  expect(r.status).toBe(401);
  expect(qa.peers.length).toBe(1);
  // an unknown token
  const r2 = await qa.receive(new Request("https://ada.test/peer/pair", { method: "POST", body: body.replace(inv.token, "x".repeat(32)), headers: {} }));
  expect(r2.status).toBe(403);
  // own invite
  await expect(qa.accept(c2)).rejects.toThrow(/own invite/);
  // restart: the key and the people come back from the private folder
  const again = new People(pk(a, "Cy", da, { publicUrl: "https://ada.test" }), {}, net);
  expect(again.keys!.pub).toBe(qa.keys!.pub);
  expect(again.peers.map(p => p.name)).toEqual(["Dee"]);
  for (const x of [qa, qb, qe, again]) x.stop();
});

test("PEOPLE_KEY in the environment wins over a key file", () => {
  const d = tmp("env");
  const q = new People(pk(a, "Ada", d, { publicUrl: "https://ada.test" }), {}, (async () => { throw new Error("x"); }) as any);
  q.invite(); q.stop();
  const e = new People(pk(a, "Ada", d), { PEOPLE_KEY: A });
  expect(e.keys!.pub).toBe(keysOf(A).pub);
  expect(e.keyFrom).toBe("env");
});
