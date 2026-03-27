const SHELL_CACHE = "facilitatio-shell-v0.9.6";
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
  
  if (request.mode === "navigate") {
  event.respondWith(
    caches.match("/index.html").then(async cachedIndex => {
      if (cachedIndex) {
        const text = await cachedIndex.text();
        const marked = text.replace(
          "<body>",
          '<body data-source="cache">'
        );
        return new Response(marked, {
          headers: { "Content-Type": "text/html" }
        });
      }
      
      const res = await fetch(request);
      const text = await res.text();
      const marked = text.replace(
        "<body>",
        '<body data-source="network">'
      );
      return new Response(marked, {
        headers: { "Content-Type": "text/html" }
      });
    })
  );
  return;
}
  
  const url = new URL(request.url);
  
  if (url.origin === self.location.origin && SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) {
          console.log("[SW] ASSET -> CACHE", url.pathname);
          return cached;
        }
        
        console.log("[SW] ASSET -> NETWORK", url.pathname);
        return fetch(request);
      })
    );
  }
});