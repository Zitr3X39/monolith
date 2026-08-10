/* MONOLITH v14.5 — офлайн.
   Оболочка и стили кладутся в кеш навсегда (cache-first),
   а данные — сначала из сети и только при обрыве из кеша,
   чтобы в метро или без сети хранилище всё равно открывалось. */
var CACHE = "monolith-v145";
var SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./assets/styles.css?v=24",
  "./assets/v141.css?v=24",
  "./assets/news.css?v=24",
  "./assets/v142.css?v=24",
  "./assets/v143.css?v=24",
  "./assets/search.css?v=24",
  "./assets/news.js?v=24",
  "./assets/app.js?v=24",
  "./assets/search.js?v=24",
  "./assets/search-ui.js?v=24",
  "./assets/flow.js?v=24",
  "./assets/fx.js?v=24",
  "./data/links.json",
  "./data/categories.json",
  "./data/feed.json"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.allSettled(SHELL.map(function (u) { return c.add(new Request(u, { cache: "reload" })); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function sameOrigin(url) {
  try { return new URL(url).origin === self.location.origin; } catch (e) { return false; }
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  if (!sameOrigin(req.url)) return;               /* чужие домены не трогаем */

  var isData = /\/data\/[^/]+\.json/.test(req.url);

  if (isData) {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(req, { ignoreSearch: true }).then(function (hit) {
          return hit || new Response('{"items":[]}', { headers: { "content-type": "application/json" } });
        });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) {
        fetch(req).then(function (res) {
          if (res && res.ok) caches.open(CACHE).then(function (c) { c.put(req, res.clone()); });
        }).catch(function () {});
        return hit;
      }
      return fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match("./index.html").then(function (idx) {
          return idx || new Response("Нет сети и кеша пока тоже нет.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
        });
      });
    })
  );
});

self.addEventListener("message", function (e) {
  if (e.data === "skip-waiting") self.skipWaiting();
});
