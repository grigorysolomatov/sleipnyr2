// People: person-to-person chat between two Sleipnyr 2 instances (trial).
// No agent takes part: messages are never sent to an agent, and this plugin
// needs no agent service.
//
// Each instance has its own Ed25519 key pair. The private key lives in an
// environment variable (keyEnv, default PEOPLE_KEY: base64 PKCS#8, made by
// `bun plugins/people/keygen.ts`); the public key is what peers put in their
// config. A message goes as one signed POST from the sender's server to the
// peer's inbox: a second, separate listener (inbox.host/port) that answers
// nothing but POST /peer/inbox, so exposing it (Tailscale Funnel or a shared
// node) never exposes the app itself.
//
// Saved items:
//   peer-message {peer, uid, dir, name, text, files, voice?, sent, state, tries?, next?, error?, delivered?}
//     peer = the peer's id in the config; uid = the message's id on both sides
//     dir "out" (written here) | "in" (received); name = who wrote it
//     sent = the writer's clock (ms), the order of the conversation on both sides
//     state (out): "queued" (waiting or retrying) | "sent" | "failed" (refused by the peer: no retry
//     until asked); in: "received"
//   Links: peer-message -file-> file.
//
// Config (plugins.people):
//   name      how peers see this user (default user.name)
//   keyEnv    environment variable with the private key (default PEOPLE_KEY)
//   inbox     {host, port} of the inbox listener (default 127.0.0.1:8183); it only
//             starts when the key is set and at least one peer is configured
//   peers     [{id, name, url, key}]  url = the peer's inbox base URL (https://...),
//             key = the peer's public key (base64url, from keygen.ts or GET /p/people/me)
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import type { Bytes, Item, Kernel, ServerPlugin } from "../../kernel/contract.ts";

export interface Peer { id: string; name: string; url: string; key: string }
export interface Sent { name: string; mime: string; id: string }
export interface PeerMessage {
  peer: string; uid: string; dir: "out" | "in"; name: string; text: string; files: string[]; voice?: string;
  sent: number; state: "queued" | "sent" | "failed" | "received"; tries?: number; next?: number; error?: string; delivered?: number;
}
interface Wire { v: 1; to: string; uid: string; sent: number; name: string; text: string; files: { name: string; mime: string; data: string }[]; voice?: number }

export const TYPE = "peer-message";
const CONTEXT = "sleipnyr2-people-v1";
const SKEW_MS = 5 * 60_000; // a signed request older or newer than this is refused
const MAX_BYTES = 8 * 1024 * 1024; // attachments per message
const MAX_TEXT = 20_000;
const TICK_MS = 3000;
const TIMEOUT_MS = 15_000;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/; // a raw Ed25519 public key, base64url

/** The configured peers, cleaned (bad entries are left out). */
export function peersOf(list: unknown): Peer[] {
  return (Array.isArray(list) ? list : []).flatMap(p => {
    const x = p as Partial<Peer>;
    const url = String(x?.url || "").replace(/\/+$/, "");
    return x && ID.test(String(x.id)) && x.name && /^https?:\/\//.test(url) && KEY.test(String(x.key))
      ? [{ id: String(x.id), name: String(x.name), url, key: String(x.key) }] : [];
  });
}

/** A key pair from a base64 PKCS#8 private key. */
export function keysOf(b64: string): { priv: KeyObject; pub: string } {
  const priv = createPrivateKey({ key: Buffer.from(b64.trim(), "base64"), format: "der", type: "pkcs8" });
  if (priv.asymmetricKeyType !== "ed25519") throw new Error("the people key must be Ed25519");
  return { priv, pub: String((createPublicKey(priv).export({ format: "jwk" }) as { x: string }).x) };
}
const pubKey = (x: string) => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });

/** What gets signed: the context, the time, the path and the body's hash. */
export function signed(time: string, path: string, body: string) {
  return Buffer.from(`${CONTEXT}\n${time}\n${path}\n${createHash("sha256").update(body).digest("hex")}`);
}
export function signRequest(priv: KeyObject, pub: string, path: string, body: string, now = Date.now()) {
  const time = String(now);
  return { "x-people-key": pub, "x-people-time": time, "x-people-sig": sign(null, signed(time, path, body), priv).toString("base64url") };
}
/** The peer that signed this request, or an error (the reason is for the log; the answer stays short). */
export function checkRequest(peers: Peer[], h: Headers, path: string, body: string, now = Date.now()): { peer: Peer } | { error: string; status: number } {
  const key = h.get("x-people-key") || "", time = h.get("x-people-time") || "", sig = h.get("x-people-sig") || "";
  const peer = peers.find(p => p.key === key);
  if (!peer) return { error: "unknown key", status: 403 };
  if (!/^\d{10,16}$/.test(time) || Math.abs(now - Number(time)) > SKEW_MS) return { error: "stale or bad time", status: 401 };
  let ok = false;
  try { ok = verify(null, signed(time, path, body), pubKey(peer.key), Buffer.from(sig, "base64url")); } catch { ok = false; }
  return ok ? { peer } : { error: "bad signature", status: 401 };
}

const nextTry = (tries: number) => Math.min(300_000, 5000 * 2 ** Math.max(0, tries - 1));

export class People {
  peers: Peer[];
  keys: { priv: KeyObject; pub: string } | null = null;
  keyError = "";
  name: string;
  busy = new Set<string>(); // peers with a delivery running
  timer: ReturnType<typeof setInterval> | null = null;
  inbox: ReturnType<typeof Bun.serve> | null = null;

  constructor(public k: Kernel, env: Record<string, string | undefined> = process.env, public post: typeof fetch = fetch) {
    const c = k.config as { name?: string; keyEnv?: string; peers?: unknown };
    this.peers = peersOf(c.peers);
    this.name = String(c.name || k.user.name || "Me");
    const raw = env[String(c.keyEnv || "PEOPLE_KEY")];
    if (raw) try { this.keys = keysOf(raw); } catch (e) { this.keyError = (e as Error).message; }
  }
  get ready() { return !!this.keys && this.peers.length > 0; }

  all(peer?: string) {
    const list = this.k.items.list<PeerMessage>({ type: TYPE, order: "created", limit: 10000 });
    return (peer ? list.filter(m => m.data.peer === peer) : list)
      .sort((a, b) => a.data.sent - b.data.sent || a.created - b.created);
  }

  write(peerId: string, b: { text?: string; files?: string[]; voice?: string }, now = Date.now()) {
    const peer = this.peers.find(p => p.id === peerId);
    if (!peer) throw Object.assign(new Error("no such person"), { status: 404 });
    if (!this.keys) throw Object.assign(new Error("this instance has no people key yet (docs/PEERS.md)"), { status: 409 });
    const text = String(b.text || "").slice(0, MAX_TEXT), files = (b.files || []).map(String), voice = b.voice ? String(b.voice) : undefined;
    if (!text.trim() && !files.length && !voice) throw new Error("empty message");
    const size = [...files, ...(voice ? [voice] : [])].reduce((n, id) => {
      const f = this.k.items.get<{ size: number }>(id);
      if (!f || f.type !== "file") throw new Error(`no file ${id}`);
      return n + (f.data.size || 0);
    }, 0);
    if (size > MAX_BYTES) throw Object.assign(new Error(`attachments over ${MAX_BYTES / 1048576} MB`), { status: 413 });
    const it = this.k.items.create<PeerMessage>(TYPE, {
      peer: peer.id, uid: crypto.randomUUID(), dir: "out", name: this.name, text, files, ...(voice ? { voice } : {}),
      sent: now, state: "queued", tries: 0, next: now,
    });
    for (const f of [...files, ...(voice ? [voice] : [])]) this.k.links.add(it.id, "file", f);
    queueMicrotask(() => this.flush(peer.id));
    return it;
  }

  /** Try now (a person tapped retry, or the peer just wrote: it is online). */
  kick(peerId: string) {
    for (const m of this.all(peerId)) if (m.data.dir === "out" && m.data.state !== "sent")
      this.k.items.update(m.id, { state: "queued", next: Date.now(), error: null });
    return this.flush(peerId);
  }

  /** The peer is evidently up: retry its waiting messages now (refused ones stay refused). */
  due(peerId: string) {
    for (const m of this.all(peerId)) if (m.data.dir === "out" && m.data.state === "queued" && (m.data.next || 0) > Date.now())
      this.k.items.update(m.id, { next: Date.now() });
    return this.flush(peerId);
  }

  /** Deliver a peer's waiting messages in order; stops at the first that does not go through. */
  async flush(peerId: string, now = () => Date.now()) {
    const peer = this.peers.find(p => p.id === peerId);
    if (!peer || !this.keys || this.busy.has(peerId)) return;
    this.busy.add(peerId);
    try {
      for (const m of this.all(peerId)) {
        if (m.data.dir !== "out" || m.data.state !== "queued") continue;
        if ((m.data.next || 0) > now()) break;
        const res = await this.deliver(peer, m);
        if (res === true) { this.k.items.update(m.id, { state: "sent", delivered: now(), next: null, error: null }); continue; }
        const tries = (m.data.tries || 0) + 1;
        if (res.refused) this.k.items.update(m.id, { state: "failed", tries, error: res.error, next: null });
        else this.k.items.update(m.id, { tries, next: now() + nextTry(tries), error: res.error });
        break; // keep the order: later messages wait for this one
      }
    } finally { this.busy.delete(peerId); }
  }

  async deliver(peer: Peer, m: Item<PeerMessage>): Promise<true | { error: string; refused?: boolean }> {
    const keys = this.keys!;
    const files: Wire["files"] = [];
    for (const id of [...m.data.files, ...(m.data.voice ? [m.data.voice] : [])]) {
      const f = this.k.items.get<{ name: string; mime: string }>(id), bytes = await this.k.files.read(id);
      if (!f || !bytes) return { error: `file ${id} is gone`, refused: true };
      files.push({ name: f.data.name, mime: f.data.mime, data: Buffer.from(bytes).toString("base64") });
    }
    const wire: Wire = { v: 1, to: peer.key, uid: m.data.uid, sent: m.data.sent, name: m.data.name, text: m.data.text, files,
      ...(m.data.voice ? { voice: files.length - 1 } : {}) };
    const body = JSON.stringify(wire), path = "/peer/inbox";
    try {
      const r = await this.post(peer.url + path, { method: "POST", body, signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "content-type": "application/json", ...signRequest(keys.priv, keys.pub, path, body) } });
      if (r.ok) return true;
      const why = await r.text().catch(() => "");
      // 4xx: the peer refused it (wrong key, too big); retrying the same will not help
      return { error: `${peer.name} refused it: HTTP ${r.status} ${why.slice(0, 120)}`, refused: r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429 };
    } catch (e) {
      return { error: `${peer.name} not reachable: ${(e as Error).message}` };
    }
  }

  /** The inbox: one signed message from a peer. */
  async receive(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/peer/inbox") return new Response("not found", { status: 404 });
    const body = await req.text();
    const who = checkRequest(this.peers, req.headers, url.pathname, body);
    if ("error" in who) { this.k.log(`inbox refused: ${who.error}`); return Response.json({ error: "refused" }, { status: who.status }); }
    let w: Wire;
    try { w = JSON.parse(body) as Wire; } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
    if (w.v !== 1 || w.to !== this.keys!.pub || typeof w.uid !== "string" || !/^[0-9a-f-]{36}$/.test(w.uid))
      return Response.json({ error: "not for this instance" }, { status: 400 });
    const peer = who.peer;
    // the same message twice (a retry after a lost answer) is stored once
    if (this.all(peer.id).some(m => m.data.uid === w.uid && m.data.dir === "in")) return Response.json({ ok: true, again: true });
    const ids: string[] = [];
    for (const f of Array.isArray(w.files) ? w.files.slice(0, 20) : []) {
      const bytes = Buffer.from(String(f.data || ""), "base64");
      ids.push(this.k.files.put(String(f.name || "file").slice(0, 200), String(f.mime || "application/octet-stream").slice(0, 100),
        new Uint8Array(bytes) as Bytes).id);
    }
    const voice = typeof w.voice === "number" && ids[w.voice] ? ids[w.voice] : undefined;
    const it = this.k.items.create<PeerMessage>(TYPE, {
      peer: peer.id, uid: w.uid, dir: "in", name: peer.name, text: String(w.text || "").slice(0, MAX_TEXT),
      files: ids.filter(id => id !== voice), ...(voice ? { voice } : {}), sent: Number(w.sent) || Date.now(), state: "received",
    });
    for (const id of ids) this.k.links.add(it.id, "file", id);
    queueMicrotask(() => this.due(peer.id)); // the peer is online: send what waits for it
    return Response.json({ ok: true }, { status: 201 });
  }

  start(inbox: { host?: string; port?: number } = {}) {
    if (this.keyError) this.k.log(`people key unusable: ${this.keyError}`);
    if (!this.ready) return;
    this.inbox = Bun.serve({ hostname: inbox.host || "127.0.0.1", port: inbox.port ?? 8183, maxRequestBodySize: 16 * 1024 * 1024,
      fetch: req => this.receive(req).catch(e => { this.k.log("inbox", e); return Response.json({ error: "failed" }, { status: 500 }); }) });
    this.k.log(`inbox on ${this.inbox.hostname}:${this.inbox.port}, ${this.peers.length} peer(s)`);
    this.timer = setInterval(() => { for (const p of this.peers) this.flush(p.id); }, TICK_MS);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.inbox?.stop(true); }

  summary() {
    const all = this.all();
    return {
      me: { name: this.name, key: this.keys?.pub || "", ready: this.ready, keyError: this.keyError || undefined },
      peers: this.peers.map(p => {
        const mine = all.filter(m => m.data.peer === p.id), last = mine[mine.length - 1];
        return { id: p.id, name: p.name, last: last ? { text: last.data.text || (last.data.voice ? "Voice message" : "Attachment"), sent: last.data.sent, dir: last.data.dir } : null,
          waiting: mine.filter(m => m.data.dir === "out" && m.data.state !== "sent").length };
      }),
    };
  }
}

let people: People | null = null;
const need = () => { if (!people) throw new Error("people not started"); return people; };
const bad = (e: unknown) => Response.json({ error: (e as Error).message || String(e) }, { status: (e as { status?: number }).status || 400 });

const plugin: ServerPlugin = {
  start(k) { people = new People(k); people.start((k.config as { inbox?: { host?: string; port?: number } }).inbox); },
  routes: () => ({
    "GET /me": () => Response.json(need().summary()),
    "GET /peers/:id/messages": (_r, p) => Response.json(need().all(p.id)),
    "POST /peers/:id/messages": async (req, p) => {
      const b = await req.json().catch(() => ({})) as { text?: string; files?: string[]; voice?: string };
      try { return Response.json(need().write(p.id, b), { status: 201 }); } catch (e) { return bad(e); }
    },
    "POST /peers/:id/retry": async (_r, p) => { await need().kick(p.id); return Response.json({ ok: true }); },
  }),
  stop() { people?.stop(); people = null; },
};
export default plugin;
