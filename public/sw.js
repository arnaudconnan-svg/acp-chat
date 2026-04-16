const SHELL_CACHE = "facilitatio-shell-v0.9.9";
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/auth.html",
  "/account.html",
  "/manifest.json",
  "/images/icon-512.png",
  "/images/logo.png"
];

function isApiRequest(url) {
  return (
    url.pathname === "/chat" ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/session/")
  );
}

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

  if (request.method !== "GET") {
    return;
  }

  if (url.origin !== self.location.origin) {
    return;
  }

  // Keep chat/API requests real-time: no cache fallback for dynamic endpoints.
  if (isApiRequest(url)) {
    return;
  }

  // For app navigation, prefer network then fallback to cached shell.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cachedPage = await caches.match(request);
        if (cachedPage) {
          return cachedPage;
        }
        const cachedIndex = await caches.match("/index.html");
        return cachedIndex || caches.match("/");
      })
    );
    return;
  }
  
  if (url.origin === self.location.origin && SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(
      fetch(request).catch(() => caches.match(request))
    );
    return;
  }

  // For same-origin static files, use cache-first then refresh in background.
  event.respondWith(
    caches.match(request).then(cached => {
      const networkFetch = fetch(request)
        .then(response => {
          if (response && response.ok) {
            caches.open(SHELL_CACHE).then(cache => cache.put(request, response.clone())).catch(() => {});
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});