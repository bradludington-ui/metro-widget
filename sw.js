// Minimal service worker. Its only job is to make the app installable
// (so Edge/Chrome offer "Install this site as an app" -> pin to taskbar).
// The train feed is never cached.
const CACHE = "next-train-v1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks =>
    Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return;           // always live
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))  // network first, cache as fallback
  );
});
