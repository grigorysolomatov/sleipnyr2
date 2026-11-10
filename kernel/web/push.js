// Phone notifications, page side (server: kernel/push.ts; shown by web/sw.js).
// ctx.push:
//   state()   -> {supported, perm: "default"|"granted"|"denied"|"", on: subscribed here}
//   enable()  asks for permission (needs a tap), subscribes, tells the server
//   disable() unsubscribes this device
//   test()    a test push to this device only
//   shows(fn) a view says which notification tags it shows now (fn() -> ["thread:<id>", ...]);
//             while the page is visible, the server hears them every 15 s and sends no push
//             for them to this device, and their notifications here are closed.
// On every app open with permission granted, the subscription is renewed if the
// browser dropped it or the server's key changed.
const BEAT_MS = 15000, LOOK_MS = 1500;
const reg = () => ("serviceWorker" in navigator ? navigator.serviceWorker.getRegistration("/").catch(() => null) : Promise.resolve(null));
const keyBytes = k => { const raw = atob(k.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - k.length % 4) % 4)); return Uint8Array.from(raw, c => c.charCodeAt(0)); };
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const label = () => { const ua = navigator.userAgent; return (/Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "Desktop") + " " + new Date().toISOString().slice(0, 10); };

export function createPush(ctx) {
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const providers = new Set();
  let endpoint = "", sent = "", sentAt = 0;
  const sub = async () => { const r = await reg(); return r?.pushManager ? r.pushManager.getSubscription() : null; };
  const post = (path, json) => ctx.api(`/k/push/${path}`, { method: "POST", json });
  async function subscribe(r) {
    const { key } = await ctx.api("/k/push/key");
    let s = await r.pushManager.getSubscription();
    const cur = s?.options?.applicationServerKey;
    if (s && cur && b64u(cur) !== key) { await s.unsubscribe().catch(() => {}); s = null; } // the server's key changed
    s ||= await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
    await post("subscribe", { subscription: s.toJSON(), label: label() });
    endpoint = s.endpoint; sent = "";
    return s;
  }
  const api = {
    async state() {
      if (!supported) return { supported, perm: "", on: false };
      const s = await sub().catch(() => null);
      return { supported, perm: Notification.permission, on: !!s && Notification.permission === "granted" };
    },
    async enable() {
      if (!supported) throw new Error("this browser has no notifications");
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error(perm === "denied" ? "notifications are blocked for this site in the browser settings" : "permission not given");
      const r = await navigator.serviceWorker.ready;
      await subscribe(r);
      return api.state();
    },
    async disable() {
      const s = await sub();
      if (s) { await post("unsubscribe", { endpoint: s.endpoint }).catch(() => {}); await s.unsubscribe().catch(() => {}); }
      endpoint = "";
      return api.state();
    },
    async test() {
      const s = await sub();
      if (!s) throw new Error("not enabled on this device");
      return post("test", { endpoint: s.endpoint });
    },
    shows(fn) { providers.add(fn); look(); return () => providers.delete(fn); },
  };
  // what the page shows now: tags of every provider, only while the page is visible
  const tags = () => document.visibilityState !== "visible" ? [] : [...new Set([...providers].flatMap(f => { try { return f() || []; } catch { return []; } }))].slice(0, 8);
  async function look() {
    if (!endpoint) return;
    const t = tags(), key = t.join(" ");
    if (key === sent && (!t.length || Date.now() - sentAt < BEAT_MS)) return;
    sent = key; sentAt = Date.now();
    post("here", { endpoint, tags: t }).catch(() => { sent = ""; });
    if (t.length) reg().then(r => r?.getNotifications ? r.getNotifications() : []).then(ns => ns.forEach(n => { if (t.includes(n.tag)) n.close(); })).catch(() => {});
  }
  if (supported) {
    // keep the subscription fresh on every open (the browser may drop it; the key may change)
    navigator.serviceWorker.ready.then(async r => {
      if (Notification.permission !== "granted") return;
      const s = await r.pushManager.getSubscription();
      if (s) { endpoint = s.endpoint; await subscribe(r).catch(e => console.warn("push renew:", e)); }
    }).catch(() => {});
    setInterval(look, LOOK_MS);
    document.addEventListener("visibilitychange", look);
  }
  return api;
}
