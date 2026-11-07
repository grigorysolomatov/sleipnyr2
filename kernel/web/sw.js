// Minimal service worker: makes the app installable and shows the last
// loaded shell when offline. Everything is network-first, so a deploy shows
// up on the next load; API calls and events are never cached.
const CACHE = "sleipnyr2-shell-v2";
const SHELL = ["/", "/web/base.css", "/web/bar.css", "/web/shell.js", "/web/bar.js", "/web/voice.js", "/web/icons/icon.svg", "/web/icons/icon-192.png"];

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
