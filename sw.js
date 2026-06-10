/* RC Manager service worker — NETWORK-FIRST (per BCH rulebook).
   Always tries the network so updates show immediately; falls back to
   cache only when offline. Bump CACHE on every deploy to evict old files. */
const CACHE = "rc-manager-v18";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./logo.png"
];

self.addEventListener("install", (e)=>{
  // activate this new worker immediately, don't wait for old tabs to close
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));
});

self.addEventListener("activate", (e)=>{
  e.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener("message", (e)=>{
  if(e.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (e)=>{
  if(e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  // never cache cross-origin (Supabase API, CDN) — always go to network
  if(url.origin !== self.location.origin){ return; }

  e.respondWith(
    fetch(e.request)
      .then(resp=>{
        // refresh the cache with the latest copy
        const copy = resp.clone();
        caches.open(CACHE).then(c=>c.put(e.request, copy)).catch(()=>{});
        return resp;
      })
      .catch(()=>
        // offline: serve cached, falling back to the app shell for navigations
        caches.match(e.request).then(c=> c || caches.match("./index.html"))
      )
  );
});
