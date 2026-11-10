// Web Push (phone notifications) without any package; the kernel owns it and
// offers it to plugins as the "push" service (contract.ts PushService).
//   - VAPID (RFC 8292): one ECDSA P-256 keypair, made once in
//     <dataDir>/push/vapid.json (dir 700, file 600; never in git). Its public
//     key is the page's applicationServerKey (GET /k/push/key).
//   - subscriptions: table push_subs in the kernel database (endpoint, keys,
//     label, created, last_ok, fails). A push service answering 404/410 means
//     the subscription is gone: the row is dropped.
//   - payload encryption: RFC 8291 (aes128gcm, one record) on WebCrypto.
//   - notify({tag, title, body, url}): to every subscription. tag = one slot on
//     the phone: a newer notification with the same tag replaces the older one
//     (web/sw.js); it is also the push Topic, so an offline phone gets only
//     the newest one per tag.
//   - presence: an open page tells which tags it shows (POST /k/push/here every
//     15 s while visible); while any device shows a tag nobody gets a push for
//     it (he is looking at it), and tags
//     seen since their last push travel with the next push as `read`, so the
//     service worker closes them on every device.
// Endpoints must be https on a known push service (FCM, Mozilla, Apple,
// Windows); SLEIPNYR2_PUSH_TEST_HOSTS (comma list, http allowed) adds hosts
// for tests.
import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PushNote } from "./contract.ts";

export interface Sub { endpoint: string; keys: { p256dh: string; auth: string } }
export interface SendResult { endpoint: string; status: number; ok: boolean; dropped?: boolean; error?: string }
interface Row { endpoint: string; p256dh: string; auth: string; label: string; created: number; last_ok: number | null; fails: number }

/** a page beats every 15 s; after this long without one it no longer counts as looking */
export const HERE_MS = 40_000;
const bad = (msg: string) => Object.assign(new Error(msg), { status: 400 });

const enc = new TextEncoder();
export const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
type Bytes = Uint8Array<ArrayBuffer>;
export const unb64u = (s: string): Bytes => { const b = Buffer.from(s.replace(/=+$/, ""), "base64url"); const o = new Uint8Array(b.length); o.set(b); return o; };
const cat = (...a: Uint8Array[]): Bytes => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const subtle = crypto.subtle;

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number) {
  const k = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, bytes * 8));
}

/** RFC 8291 encryption of one message for one subscription -> the request body (aes128gcm, one record).
 * as / salt may be given for test vectors; normally both are fresh per message. */
export async function encrypt(plain: Uint8Array, p256dh: string, auth: string,
  o: { as?: CryptoKeyPair; salt?: Bytes } = {}): Promise<Bytes> {
  const uaPub = unb64u(p256dh), secret = unb64u(auth);
  if (uaPub.length !== 65 || uaPub[0] !== 4) throw new Error("p256dh: not an uncompressed P-256 point");
  if (secret.length < 16) throw new Error("auth: too short");
  const as = o.as ?? await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPub = new Uint8Array(await subtle.exportKey("raw", as.publicKey));
  const ua = await subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: ua }, as.privateKey, 256));
  const ikm = await hkdf(secret, ecdh, cat(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = o.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(plain, new Uint8Array([2]))));
  const rs = 4096, head = new Uint8Array(21);
  head.set(salt, 0); new DataView(head.buffer).setUint32(16, rs); head[20] = asPub.length;
  return cat(head, asPub, ct);
}

/** The receiving side (what the browser does): for tests. uaPriv = the subscription's ECDH key. */
export async function decrypt(body: Bytes, ua: CryptoKeyPair, auth: Bytes): Promise<Bytes> {
  const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  const uaPub = new Uint8Array(await subtle.exportKey("raw", ua.publicKey));
  const as = await subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: as }, ua.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, cat(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const p = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct));
  let i = p.length - 1; while (i >= 0 && p[i] === 0) i--; // padding, then the 0x02 last-record delimiter
  if (p[i] !== 2) throw new Error("bad record delimiter");
  return p.slice(0, i);
}

// Chrome/FCM: fcm.googleapis.com and per-region hosts such as jmt17.google.com/fcm/send/...
const PUSH_HOSTS = [/(^|\.)googleapis\.com$/, /(^|\.)google\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
export function allowedEndpoint(s: string): boolean {
  let u: URL; try { u = new URL(s); } catch { return false; }
  const test = (process.env.SLEIPNYR2_PUSH_TEST_HOSTS || "").split(",").map(x => x.trim()).filter(Boolean);
  if (test.includes(u.host) || test.includes(u.hostname)) return u.protocol === "https:" || u.protocol === "http:";
  return u.protocol === "https:" && PUSH_HOSTS.some(r => r.test(u.hostname));
}

export class Push {
  db: Database; dir: string; subject: string;
  private keys: { pub: string; priv: CryptoKey } | null = null;
  /** endpoint -> what that device shows now */
  private here = new Map<string, { tags: string[]; at: number }>();
  /** tag -> when it was last pushed / last seen on any device */
  private pushed = new Map<string, number>();
  private seen = new Map<string, number>();
  constructor(db: Database, dataDir: string, o: { subject?: string } = {}) {
    this.db = db; this.dir = join(dataDir, "push");
    this.subject = o.subject || "mailto:sleipnyr2@localhost";
    db.run(`CREATE TABLE IF NOT EXISTS push_subs(endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      label TEXT DEFAULT '', created REAL, last_ok REAL, fails INTEGER DEFAULT 0)`);
  }

  /** VAPID keypair: made once (file 600 in a 700 dir), then read. */
  async vapid(): Promise<{ pub: string; priv: CryptoKey }> {
    if (this.keys) return this.keys;
    const f = join(this.dir, "vapid.json");
    let jwk: JsonWebKey;
    if (existsSync(f)) jwk = JSON.parse(readFileSync(f, "utf8"));
    else {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 }); chmodSync(this.dir, 0o700);
      const k = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
      jwk = await subtle.exportKey("jwk", k.privateKey);
      writeFileSync(f, JSON.stringify(jwk) + "\n", { mode: 0o600, flag: "wx" });
      chmodSync(f, 0o600);
    }
    const priv = await subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const pub = b64u(cat(new Uint8Array([4]), unb64u(jwk.x!), unb64u(jwk.y!)));
    return (this.keys = { pub, priv });
  }
  async publicKey() { return (await this.vapid()).pub; }

  /** Authorization header: vapid t=<ES256 JWT for the endpoint's origin, 12 h>, k=<public key>. */
  async authHeader(endpoint: string, now = Date.now()): Promise<string> {
    const { pub, priv } = await this.vapid();
    const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
    const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: this.subject })));
    const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, enc.encode(`${head}.${claims}`)); // raw r||s = JWS
    return `vapid t=${head}.${claims}.${b64u(sig)}, k=${pub}`;
  }

  add(s: Sub, label = ""): { endpoint: string; created: boolean } {
    if (!s || typeof s.endpoint !== "string" || !allowedEndpoint(s.endpoint)) throw bad("endpoint: not a known push service");
    const k = s.keys || ({} as Sub["keys"]);
    if (typeof k.p256dh !== "string" || unb64u(k.p256dh).length !== 65 || typeof k.auth !== "string" || unb64u(k.auth).length < 16)
      throw bad("keys: p256dh (65 bytes) and auth (16 bytes) required");
    const had = this.has(s.endpoint);
    this.db.run(`INSERT INTO push_subs(endpoint, p256dh, auth, label, created, fails) VALUES (?,?,?,?,?,0)
      ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, label=excluded.label, fails=0`,
      [s.endpoint, k.p256dh, k.auth, String(label).slice(0, 80), Date.now()]);
    return { endpoint: s.endpoint, created: !had };
  }
  remove(endpoint: string): boolean { this.here.delete(endpoint); return this.db.run("DELETE FROM push_subs WHERE endpoint=?", [endpoint]).changes > 0; }
  list(): Row[] { return this.db.query("SELECT * FROM push_subs ORDER BY created").all() as Row[]; }
  has(endpoint: string) { return !!this.db.query("SELECT 1 FROM push_subs WHERE endpoint=?").get(endpoint); }
  /** the devices, without their keys (Settings, tests) */
  devices() { return this.list().map(r => ({ host: new URL(r.endpoint).host, label: r.label, created: r.created, lastOk: r.last_ok, fails: r.fails })); }

  /** A page shows these tags now ([] = nothing); endpoint = that device's subscription. */
  setHere(endpoint: string, tags: unknown, now = Date.now()) {
    if (typeof endpoint !== "string" || !endpoint) throw bad("endpoint required");
    if (!Array.isArray(tags) || tags.length > 8 || tags.some(t => typeof t !== "string" || !t || t.length > 200)) throw bad("tags: up to 8 strings");
    if (!tags.length) { this.here.delete(endpoint); return; }
    this.here.set(endpoint, { tags: tags as string[], at: now });
    for (const t of tags as string[]) this.seen.set(t, now);
  }
  private shows(endpoint: string, tag: string, now: number) { const h = this.here.get(endpoint); return !!h && now - h.at < HERE_MS && h.tags.includes(tag); }
  /** whether some device looks at `tag` now */
  looking(tag: string, now = Date.now()) { return [...this.here.keys()].some(e => this.shows(e, tag, now)); }
  /** tags seen on some device since their last push: the next push closes them everywhere */
  private readTags(except: string): string[] {
    const out: string[] = [];
    for (const [tag, at] of this.pushed) if (tag !== except && (this.seen.get(tag) || 0) > at) { out.push(tag); this.pushed.delete(tag); }
    return out.slice(0, 40);
  }

  /** One push to one subscription. 404/410 -> row dropped. ttl = seconds the push service keeps it for an offline
   * phone. Urgency high: with "normal" FCM may hold it until an idle (Doze) Android phone wakes up. */
  async send(s: { endpoint: string; p256dh: string; auth: string }, n: PushNote & { read?: string[] }, o: { ttl?: number } = {}): Promise<SendResult> {
    const payload = enc.encode(JSON.stringify({ tag: n.tag || "sleipnyr2", title: n.title, body: n.body || "", url: n.url || "/", test: !!n.test,
      ...(n.read?.length ? { read: n.read } : {}) }));
    try {
      const body = await encrypt(payload, s.p256dh, s.auth);
      const headers: Record<string, string> = { authorization: await this.authHeader(s.endpoint), "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream", ttl: String(o.ttl ?? 24 * 3600), urgency: "high" };
      if (n.tag) headers.topic = b64u(new Uint8Array(await subtle.digest("SHA-256", enc.encode(n.tag)))).slice(0, 32);
      const r = await fetch(s.endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(15000) });
      const ok = r.status >= 200 && r.status < 300;
      const error = ok ? undefined : (await r.text().catch(() => "")).slice(0, 300);
      if (ok) this.db.run("UPDATE push_subs SET last_ok=?, fails=0 WHERE endpoint=?", [Date.now(), s.endpoint]);
      else if (r.status === 404 || r.status === 410) { this.remove(s.endpoint); return { endpoint: s.endpoint, status: r.status, ok, dropped: true, error }; }
      else this.db.run("UPDATE push_subs SET fails=fails+1 WHERE endpoint=?", [s.endpoint]);
      return { endpoint: s.endpoint, status: r.status, ok, error };
    } catch (e) {
      this.db.run("UPDATE push_subs SET fails=fails+1 WHERE endpoint=?", [s.endpoint]);
      return { endpoint: s.endpoint, status: 0, ok: false, error: `${(e as Error)?.name}: ${(e as Error)?.message}` };
    }
  }

  /** To every subscription except devices showing that tag now (only = one endpoint, e.g. a test). Never throws
   * for delivery problems; -> one result per push. */
  async notify(n: PushNote, o: { only?: string; ttl?: number; now?: number } = {}): Promise<SendResult[]> {
    if (!n || typeof n.title !== "string" || !n.title) throw bad("title required");
    const now = o.now ?? Date.now();
    // he is looking at it on some device: no device needs telling (and it counts as seen)
    if (n.tag && !o.only && this.looking(n.tag, now)) { this.seen.set(n.tag, now + 1); return []; }
    const subs = this.list().filter(s => !o.only || s.endpoint === o.only);
    if (n.tag && !o.only) this.pushed.set(n.tag, now);
    const read = this.readTags(n.tag || "");
    const res = await Promise.all(subs.map(s => this.send(s, { ...n, read }, o)));
    for (const r of res) if (!r.ok) console.log(`push: ${r.status} ${new URL(r.endpoint).host}${r.dropped ? " (dropped)" : ""} ${r.error || ""}`);
    return res;
  }
}
