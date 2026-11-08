// People: person-to-person chat between two Sleipnyr 2 instances (trial).
// No agent takes part: messages are never sent to an agent, and this plugin
// needs no agent service.
//
// Each instance has its own Ed25519 key pair. The private key is made on first
// use (Invite or Accept invite) and kept in the plugin's private folder
// (<dataDir>/private/people/key, mode 0600; never an item, a file or API
// output). An environment variable (keyEnv, default PEOPLE_KEY: base64 PKCS#8)
// still wins when set. A message goes as one signed POST from the sender's
// server to the peer's inbox: a second, separate listener (inbox.host/port)
// that answers only POST /peer/inbox, POST /peer/pair and GET /peer/ping, so
// exposing it (Tailscale Funnel or a shared node) never exposes the app itself.
//
// Pairing (docs/PEERS.md): Invite makes one code = base64url {name, url, key,
// one-time token, expiry}. The other side pastes it; its server POSTs a pairing
// request signed with its own key and carrying the token to the inviter's
// inbox; the inviter adds it (token single use, 7 days) and answers signed, so
// both sides list each other at once, no restart. Both show a safety code made
// from both public keys, to compare by phone.
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
//   keyEnv    environment variable with the private key (default PEOPLE_KEY; optional)
//   inbox     {host, port} of the inbox listener (default 127.0.0.1:8183); it
//             starts as soon as a key exists
//   publicUrl this instance's inbox address as others reach it (https://...);
//             else it is set once in the People view
//   peers     [{id, name, url, key}]  url = the peer's inbox base URL (https://...),
//             key = the peer's public key; merged with the people added by invite
//             (<private>/peers.json)
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Bytes, Item, Kernel, ServerPlugin } from "../../kernel/contract.ts";

export interface Peer { id: string; name: string; url: string; key: string }
export interface Sent { name: string; mime: string; id: string }
export interface PeerMessage {
  peer: string; uid: string; dir: "out" | "in"; name: string; text: string; files: string[]; voice?: string;
  sent: number; state: "queued" | "sent" | "failed" | "received"; tries?: number; next?: number; error?: string; delivered?: number;
}
export interface Invite { v: 1; name: string; url: string; key: string; token: string; exp: number }
interface PairWire { v: 1; to: string; token: string; name: string; url: string; key: string }
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
const INVITE_PREFIX = "sleipnyr-invite-";
const INVITE_DAYS = 7;
const URL_RE = /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/;
export const FUNNEL_PORT = 10000;

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
/** A fresh private key, base64 PKCS#8 (what PEOPLE_KEY or the key file holds). */
export const newKey = () => generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
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

// ---------------------------------------------------------------- invites

/** One copyable invite code. */
export function encodeInvite(i: Invite) {
  return INVITE_PREFIX + Buffer.from(JSON.stringify(i)).toString("base64url");
}
/** The invite in a pasted code (spaces, line breaks and a surrounding message are ignored), or an error. */
export function decodeInvite(code: string, now = Date.now()): Invite | { error: string } {
  const at = String(code || "").indexOf(INVITE_PREFIX);
  if (at < 0) return { error: "That is not an invite code (it starts with " + INVITE_PREFIX + ")." };
  // the code may be wrapped over lines and followed by more text: try the longest run of pieces that parses
  const pieces = (String(code).slice(at + INVITE_PREFIX.length).match(/^[A-Za-z0-9_\-\s]*/)?.[0] || "").split(/\s+/).filter(Boolean);
  let i: Partial<Invite> | null = null;
  for (let n = pieces.length; n > 0 && !i; n--)
    try { i = JSON.parse(Buffer.from(pieces.slice(0, n).join(""), "base64url").toString("utf8")); } catch { i = null; }
  if (!i) return { error: "The invite code is cut off or mistyped." };
  if (i?.v !== 1 || !i.name || !URL_RE.test(String(i.url)) || !KEY.test(String(i.key)) || !/^[A-Za-z0-9_-]{20,}$/.test(String(i.token)) || typeof i.exp !== "number")
    return { error: "The invite code is cut off or mistyped." };
  if (i.exp < now) return { error: "This invite has expired: ask for a new one." };
  return { v: 1, name: String(i.name).slice(0, 80), url: String(i.url).replace(/\/+$/, ""), key: String(i.key), token: String(i.token), exp: i.exp };
}
/** The short code both sides show, made from both public keys (order does not matter). */
export function safetyCode(a: string, b: string) {
  const d = createHash("sha256").update([a, b].sort().join("\n")).digest();
  const n = (d.readUInt32BE(0) % 1_000_000).toString().padStart(6, "0");
  return `${n.slice(0, 3)} ${n.slice(3)}`;
}
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
/** A short lowercase id from a name, not among `taken`. */
export function idFor(name: string, taken: string[]) {
  const base = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "person";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}
const tailscaleHint = (port: number) => `sudo tailscale funnel --bg --https=${FUNNEL_PORT} http://127.0.0.1:${port}`;

const nextTry = (tries: number) => Math.min(300_000, 5000 * 2 ** Math.max(0, tries - 1));

export class People {
  configPeers: Peer[];
  keys: { priv: KeyObject; pub: string } | null = null;
  keyError = "";
  keyFrom: "env" | "file" | "" = "";
  name: string;
  configUrl: string;
  dir: string;
  busy = new Set<string>(); // peers with a delivery running
  timer: ReturnType<typeof setInterval> | null = null;
  inbox: ReturnType<typeof Bun.serve> | null = null;
  inboxCfg: { host?: string; port?: number } = {};
  inboxError = "";

  constructor(public k: Kernel, env: Record<string, string | undefined> = process.env, public post: typeof fetch = fetch) {
    const c = k.config as { name?: string; keyEnv?: string; peers?: unknown; publicUrl?: string; inbox?: { host?: string; port?: number } };
    this.inboxCfg = c.inbox || {};
    this.configPeers = peersOf(c.peers);
    this.name = String(c.name || k.user.name || "Me");
    this.configUrl = URL_RE.test(String(c.publicUrl || "")) ? String(c.publicUrl).replace(/\/+$/, "") : "";
    this.dir = k.privateDir || "";
    const raw = env[String(c.keyEnv || "PEOPLE_KEY")];
    if (raw) try { this.keys = keysOf(raw); this.keyFrom = "env"; } catch (e) { this.keyError = (e as Error).message; }
    else if (this.dir && existsSync(join(this.dir, "key")))
      try { this.keys = keysOf(readFileSync(join(this.dir, "key"), "utf8")); this.keyFrom = "file"; } catch (e) { this.keyError = (e as Error).message; }
  }
  /** the inbox listens (a key exists) */
  get ready() { return !!this.keys; }

  // private folder: key, peers.json, invites.json, settings.json (all 0600)
  private read<T>(name: string, fallback: T): T {
    if (!this.dir) return fallback;
    try { return JSON.parse(readFileSync(join(this.dir, name), "utf8")) as T; } catch { return fallback; }
  }
  private save(name: string, text: string) {
    if (!this.dir) throw new Error("no private folder for the people plugin");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const tmp = join(this.dir, `.${name}.tmp`);
    writeFileSync(tmp, text, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, join(this.dir, name));
  }
  /** configured people first, then the ones added by invite (a key already configured is not added twice) */
  get peers(): Peer[] {
    const added = peersOf(this.read<unknown[]>("peers.json", []));
    const keys = new Set(this.configPeers.map(p => p.key)), ids = new Set(this.configPeers.map(p => p.id));
    return [...this.configPeers, ...added.filter(p => !keys.has(p.key) && !ids.has(p.id))];
  }
  private addPeer(p: { name: string; url: string; key: string }): Peer {
    const have = this.peers.find(x => x.key === p.key);
    const stored = peersOf(this.read<unknown[]>("peers.json", []));
    if (have) { // paired again (new address or name): update the stored entry, keep the id and the conversation
      if (this.configPeers.some(x => x.key === p.key)) return have;
      const next = stored.map(x => (x.key === p.key ? { ...x, name: p.name, url: p.url } : x));
      this.save("peers.json", JSON.stringify(next, null, 2));
      return { ...have, name: p.name, url: p.url };
    }
    const peer = { id: idFor(p.name, this.peers.map(x => x.id)), name: p.name, url: p.url, key: p.key };
    this.save("peers.json", JSON.stringify([...stored, peer], null, 2));
    return peer;
  }
  get publicUrl() { return this.configUrl || String(this.read<{ publicUrl?: string }>("settings.json", {}).publicUrl || ""); }
  setPublicUrl(url: string) {
    const u = String(url || "").trim().replace(/\/+$/, "");
    if (this.configUrl) throw Object.assign(new Error("the address is set in the config (plugins.people.publicUrl)"), { status: 409 });
    if (u && !URL_RE.test(u)) throw new Error("the address must look like https://name.example.ts.net:10000");
    this.save("settings.json", JSON.stringify({ ...this.read<object>("settings.json", {}), publicUrl: u }, null, 2));
    return u;
  }
  /** The key, made and saved now if there is none yet; the inbox starts with it. */
  ensureKey() {
    if (this.keys) return this.keys;
    if (this.keyError) throw new Error(`the people key is unusable: ${this.keyError}`);
    const der = newKey();
    this.save("key", der + "\n");
    this.keys = keysOf(der); this.keyFrom = "file";
    this.listen();
    return this.keys;
  }

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

  // ------------------------------------------------------------ invites

  /** A new one-time invite code (the key is made now if needed). */
  invite(now = Date.now()) {
    const keys = this.ensureKey();
    if (!this.publicUrl) throw Object.assign(new Error("set your inbox address first"), { status: 409 });
    const token = randomBytes(24).toString("base64url"), exp = now + INVITE_DAYS * 86_400_000;
    const list = this.read<{ hash: string; exp: number; used?: number }[]>("invites.json", []).filter(t => t.exp > now && !t.used);
    this.save("invites.json", JSON.stringify([...list, { hash: hashToken(token), exp }], null, 2));
    return { code: encodeInvite({ v: 1, name: this.name, url: this.publicUrl, key: keys.pub, token, exp }), expires: exp };
  }

  /** Accept someone's invite: a signed pairing request to their inbox; on success both sides list each other. */
  async accept(code: string, now = Date.now()): Promise<{ peer: Peer; safety: string; warning?: string }> {
    const inv = decodeInvite(code, now);
    if ("error" in inv) throw new Error(inv.error);
    const keys = this.ensureKey();
    if (inv.key === keys.pub) throw new Error("This is your own invite: send it to the other person.");
    if (!this.publicUrl) throw Object.assign(new Error("set your inbox address first"), { status: 409 });
    const path = "/peer/pair";
    const body = JSON.stringify({ v: 1, to: inv.key, token: inv.token, name: this.name, url: this.publicUrl, key: keys.pub } satisfies PairWire);
    let r: Response;
    try {
      r = await this.post(inv.url + path, { method: "POST", body, signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "content-type": "application/json", ...signRequest(keys.priv, keys.pub, path, body, now) } });
    } catch (e) { throw new Error(`${inv.name}'s inbox is not reachable (${(e as Error).message}). Ask them to check their inbox address, then try again.`); }
    const text = await r.text();
    if (r.status === 403) throw new Error("This invite was already used or has expired: ask for a new one.");
    if (!r.ok) throw new Error(`${inv.name}'s server refused the pairing: HTTP ${r.status}`);
    // the answer is signed by the key in the invite: the address really belongs to the inviter
    const who = checkRequest([{ id: "inviter", name: inv.name, url: inv.url, key: inv.key }], r.headers, path + "#ok", text, now);
    if ("error" in who) throw new Error(`The answer from ${inv.url} was not signed by ${inv.name}'s key: not paired.`);
    let ans: { name?: string; reach?: boolean };
    try { ans = JSON.parse(text); } catch { ans = {}; }
    const peer = this.addPeer({ name: String(ans.name || inv.name).slice(0, 80), url: inv.url, key: inv.key });
    queueMicrotask(() => this.flush(peer.id));
    return { peer, safety: safetyCode(keys.pub, inv.key),
      ...(ans.reach === false ? { warning: `${peer.name}'s server cannot reach your inbox yet, so their messages will wait until it can.` } : {}) };
  }

  /** The inbox side of pairing: a valid unused token + a request signed by the key it names adds that person. */
  async pair(req: Request, body: string, now = Date.now()): Promise<Response> {
    const keys = this.keys!;
    let w: Partial<PairWire>;
    try { w = JSON.parse(body); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
    if (w.v !== 1 || w.to !== keys.pub || !w.name || !URL_RE.test(String(w.url)) || !KEY.test(String(w.key)) || typeof w.token !== "string")
      return Response.json({ error: "bad request" }, { status: 400 });
    const list = this.read<{ hash: string; exp: number; used?: number }[]>("invites.json", []);
    const t = list.find(x => x.hash === hashToken(String(w.token)));
    if (!t || t.used || t.exp < now) { this.k.log("pairing refused: unknown, used or expired invite"); return Response.json({ error: "refused" }, { status: 403 }); }
    const self = { id: "new", name: String(w.name), url: String(w.url), key: String(w.key) };
    const who = checkRequest([self], req.headers, "/peer/pair", body, now);
    if ("error" in who) { this.k.log(`pairing refused: ${who.error}`); return Response.json({ error: "refused" }, { status: who.status }); }
    t.used = now;
    this.save("invites.json", JSON.stringify(list, null, 2));
    const peer = this.addPeer({ name: String(w.name).slice(0, 80), url: String(w.url).replace(/\/+$/, ""), key: String(w.key) });
    this.k.log(`paired with ${peer.name} (${peer.id})`);
    const reach = await this.ping(peer.url, peer.key);
    this.k.events?.publish?.("people", { paired: peer.id });
    const out = JSON.stringify({ ok: true, name: this.name, reach: reach.ok });
    return new Response(out, { status: 201, headers: { "content-type": "application/json", ...signRequest(keys.priv, keys.pub, "/peer/pair#ok", out, now) } });
  }

  /** Does the inbox at `url` answer with `key`? (own address: the self-check; a new peer's: can we reach them) */
  async ping(url: string, key: string): Promise<{ ok: boolean; why?: string }> {
    try {
      const r = await this.post(url.replace(/\/+$/, "") + "/peer/ping", { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return { ok: false, why: `HTTP ${r.status}` };
      const j = await r.json().catch(() => ({})) as { key?: string };
      return j.key === key ? { ok: true } : { ok: false, why: "another server answers there" };
    } catch (e) { return { ok: false, why: (e as Error).message }; }
  }

  /** The self-check shown in the view: is the inbox reachable at the public address? */
  async check(): Promise<{ ok: boolean; text: string; command?: string }> {
    const port = this.inboxCfg.port ?? 8183;
    if (!this.keys) return { ok: false, text: "Not set up yet: Invite or Accept invite makes this instance's key and starts its inbox." };
    if (this.inboxError) return { ok: false, text: `The inbox could not start: ${this.inboxError}` };
    if (!this.publicUrl) return { ok: false, text: "Set the address where others reach your inbox. To publish it with Tailscale Funnel, run this once:", command: tailscaleHint(port) };
    const r = await this.ping(this.publicUrl, this.keys.pub);
    return r.ok
      ? { ok: true, text: "Your inbox answers at this address." }
      : { ok: false, text: `Your inbox does not answer at this address (${r.why}). If it is not published yet, run this once and approve Funnel when Tailscale asks:`, command: tailscaleHint(port) };
  }

  /** The inbox: a signed message from a peer, a pairing request, or a ping. */
  async receive(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/peer/ping") return Response.json({ ok: true, key: this.keys?.pub || "" });
    if (req.method === "POST" && url.pathname === "/peer/pair") return this.pair(req, await req.text());
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

  start(inbox: { host?: string; port?: number } = this.inboxCfg) {
    this.inboxCfg = inbox;
    if (this.keyError) this.k.log(`people key unusable: ${this.keyError}`);
    this.listen();
  }
  /** The inbox listener and the retry timer: on as soon as a key exists. */
  listen() {
    if (!this.keys || this.inbox) return;
    try {
      this.inbox = Bun.serve({ hostname: this.inboxCfg.host || "127.0.0.1", port: this.inboxCfg.port ?? 8183, maxRequestBodySize: 16 * 1024 * 1024,
        fetch: req => this.receive(req).catch(e => { this.k.log("inbox", e); return Response.json({ error: "failed" }, { status: 500 }); }) });
      this.inboxError = "";
      this.k.log(`inbox on ${this.inbox.hostname}:${this.inbox.port}, ${this.peers.length} peer(s)`);
    } catch (e) { this.inboxError = (e as Error).message; this.k.log(`inbox not started: ${this.inboxError}`); }
    this.timer ??= setInterval(() => { for (const p of this.peers) this.flush(p.id); }, TICK_MS);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.inbox?.stop(true); }

  summary() {
    const all = this.all();
    return {
      me: { name: this.name, key: this.keys?.pub || "", ready: this.ready, keyError: this.keyError || undefined,
        publicUrl: this.publicUrl, urlFromConfig: !!this.configUrl, inboxPort: this.inbox?.port ?? (this.inboxCfg.port ?? 8183),
        inboxError: this.inboxError || undefined, command: tailscaleHint(this.inboxCfg.port ?? 8183) },
      peers: this.peers.map(p => {
        const mine = all.filter(m => m.data.peer === p.id), last = mine[mine.length - 1];
        return { id: p.id, name: p.name, safety: this.keys ? safetyCode(this.keys.pub, p.key) : "", last: last ? { text: last.data.text || (last.data.voice ? "Voice message" : "Attachment"), sent: last.data.sent, dir: last.data.dir } : null,
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
    "POST /url": async req => {
      const b = await req.json().catch(() => ({})) as { url?: string };
      try { return Response.json({ publicUrl: need().setPublicUrl(String(b.url || "")) }); } catch (e) { return bad(e); }
    },
    "POST /check": async () => Response.json(await need().check()),
    "POST /invite": () => { try { return Response.json(need().invite(), { status: 201 }); } catch (e) { return bad(e); } },
    "POST /accept": async req => {
      const b = await req.json().catch(() => ({})) as { code?: string };
      try { return Response.json(await need().accept(String(b.code || "")), { status: 201 }); } catch (e) { return bad(e); }
    },
  }),
  stop() { people?.stop(); people = null; },
};
export default plugin;
