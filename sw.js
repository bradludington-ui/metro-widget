// Minimal service worker. It makes the app installable (so Edge/Chrome
// offer "Install this site as an app" -> pin to taskbar) and shows the
// board's notifications, which Chrome on Android only allows from here.
// The train feed is never cached.
const CACHE = "next-train-v2";
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

// Tapping a notification brings the board back to the front.
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(cs => {
    for (const c of cs) if ("focus" in c) return c.focus();
    return self.clients.openWindow("./");
  }));
});
