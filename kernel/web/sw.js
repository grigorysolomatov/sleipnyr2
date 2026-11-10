// Service worker: makes the app installable, shows the last loaded shell when
// offline and shows phone notifications. Everything is network-first, so a
// deploy shows up on the next load; API calls and events are never cached.
const CACHE = "sleipnyr2-shell-v3";
const SHELL = ["/", "/web/base.css", "/web/bar.css", "/web/shell.js", "/web/bar.js", "/web/voice.js", "/web/push.js", "/web/icons/icon.svg", "/web/icons/icon-192.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/k/")) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok && (SHELL.includes(url.pathname) || url.pathname.startsWith("/p/"))) {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
    }
    return r;
  }).catch(() => caches.match(e.request).then(hit => hit || caches.match("/"))));
});

// ---- phone notifications (server: kernel/push.ts, page: web/push.js) ----
// push = {tag, title, body, url, test, read?}. One notification per tag: the older one with
// the same tag is closed and the new one posted, so it is the newest and alerts again.
// read = tags seen on some device since their last push: closed here too.
// Every push shows something (userVisibleOnly). A tap focuses an open window and moves it
// to url, else opens url (own origin only).
async function closeTags(tags) {
  if (!tags.length || !self.registration.getNotifications) return;
  for (const n of await self.registration.getNotifications()) if (tags.includes(n.tag)) n.close();
}
async function show(d) {
  const tag = String(d.tag || "sleipnyr2"), read = Array.isArray(d.read) ? d.read.map(String) : [];
  try { await closeTags([tag, ...read]); } catch {}
  await self.registration.showNotification(String(d.title || "Sleipnyr"), {
    body: String(d.body || ""), tag, renotify: true, timestamp: Date.now(),
    icon: "/web/icons/icon-192.png", badge: "/web/icons/badge-96.png",
    data: { url: typeof d.url === "string" && d.url ? d.url : "/" } });
}
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(show(d));
});
async function openUrl(url) {
  let to = new URL(url, self.location.origin);
  if (to.origin !== self.location.origin) to = new URL("/", self.location.origin);
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const w = wins.find(c => new URL(c.url).origin === to.origin);
  if (w) { const f = await w.focus(); if (w.url !== to.href && f && "navigate" in f) { try { await f.navigate(to.href); } catch {} } return f; }
  return self.clients.openWindow(to.href);
}
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(openUrl((e.notification.data && e.notification.data.url) || "/"));
});
// the push service replaced or expired this device's subscription: subscribe again with the
// server's key and tell the server (web/push.js renews on every app open too)
async function resubscribe(e) {
  const { key } = await (await fetch("/k/push/key", { cache: "no-store" })).json();
  const raw = atob(key.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - key.length % 4) % 4));
  const s = (e && e.newSubscription) || await self.registration.pushManager.subscribe({ userVisibleOnly: true,
    applicationServerKey: Uint8Array.from(raw, c => c.charCodeAt(0)) });
  const old = e && e.oldSubscription && e.oldSubscription.endpoint;
  const post = (path, body) => fetch(`/k/push/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (old && old !== s.endpoint) await post("unsubscribe", { endpoint: old }).catch(() => {});
  await post("subscribe", { subscription: s.toJSON(), label: "renewed " + new Date().toISOString().slice(0, 10) });
}
self.addEventListener("pushsubscriptionchange", e => { e.waitUntil(resubscribe(e).catch(() => {})); });
