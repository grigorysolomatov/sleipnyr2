// People: two instances in one process exchange signed messages; a peer that
// is offline gets them later in order; a wrong key is refused.
import { afterAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../kernel/server.ts";
import { checkRequest, keysOf, People, peersOf, signRequest } from "../plugins/people/server.ts";

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
