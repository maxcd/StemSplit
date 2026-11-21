// Offline support: caches the app shell so the library and mixer work without internet.
const VERSION = "stemsplit-v4";
const SHELL = [
  "./", "index.html", "styles.css", "app.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-512-maskable.png", "icons/apple-touch-icon.png", "mp3-worker.js", "vendor/fflate.js", "vendor/lame.min.js",
];
const CDN = "https://cdn.jsdelivr.net/npm/@gradio/client@2.8.0/dist/index.min.js";

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })));
    try { await c.add(new Request(CDN, { mode: "cors" })); } catch {}
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isCdn = url.href.startsWith("https://cdn.jsdelivr.net/npm/@gradio/client@");
  if (!sameOrigin && !isCdn) return; // never touch Hugging Face traffic

  if (isCdn) {
    // pinned version → cache-first
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(req, copy));
      return res;
    })));
    return;
  }
  // app shell → network-first so updates arrive, cache fallback when offline
  e.respondWith((async () => {
    try {
      // bypass the browser's HTTP cache so a new page never runs with old code
      const res = await fetch(new Request(req.url, { cache: "no-cache", credentials: "same-origin" }));
      if (res.ok) (await caches.open(VERSION)).put(req, res.clone());
      return res;
    } catch {
      return (await caches.match(req, { ignoreSearch: true })) ||
        (req.mode === "navigate" ? caches.match("index.html") : Response.error());
    }
  })());
});
