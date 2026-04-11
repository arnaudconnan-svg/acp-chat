const SHELL_CACHE = "facilitatio-shell-v0.9.6-test";
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/images/icon-512.png",
  "/images/logo.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
        .filter(key => key !== SHELL_CACHE)
        .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  
  if (url.origin === self.location.origin && SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(
      fetch(request).catch(() => caches.match(request))
    );
  }
});