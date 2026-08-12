/* MONOLITH v14.9 — офлайн без залипания старой версии.

   Почему файл переписан 12.08. Здесь было cache-first: страница получала
   копию из кеша, а свежий файл догружался в фоне и ложился в кеш «на
   следующий раз». Из-за этого браузер стабильно показывал прошлую версию
   кода: правки уезжали в репозиторий, обновление страницы ничего не
   меняло, а часть файлов иногда успевала обновиться, часть нет — и одна и
   та же страница выглядела то так, то этак. Вдобавок caches.match стоял с
   ignoreSearch:true, из-за чего смена ?v=25 на ?v=26 не дала бы ничего:
   параметр в ключе просто игнорировался.

   Теперь наоборот: сначала сеть, кеш — страховка на случай обрыва. Офлайн
   работает как работал: оболочка и данные лежат в кеше и отдаются, когда
   сети нет.

   И ещё: при смене версии воркер сам перезагружает открытые вкладки,
   иначе свежий код доезжал бы только со второго обновления. */
var CACHE = "monolith-v149";
var SHELL = [
  "./",
  "./index.html",
  "./mcp.html",
  "./manifest.webmanifest",
  "./assets/styles.css?v=25",
  "./assets/mcp.css?v=25",
  "./assets/v141.css?v=25",
  "./assets/news.css?v=25",
  "./assets/v142.css?v=25",
  "./assets/v143.css?v=25",
  "./assets/search.css?v=25",
  "./assets/news.js?v=25",
  "./assets/app.js?v=25",
  "./assets/search.js?v=25",
  "./assets/search-ui.js?v=25",
  "./assets/flow.js?v=25",
  "./assets/fx.js?v=25",
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
    }).then(function () {
      return self.clients.claim();
    }).then(function () {
      return self.clients.matchAll({ type: "window" });
    }).then(function (list) {
      /* новая версия воркера — сразу показываем новый код, без второго обновления */
      list.forEach(function (c) { try { c.navigate(c.url); } catch (err) {} });
    }).catch(function () {})
  );
});

function sameOrigin(url) {
  try { return new URL(url).origin === self.location.origin; } catch (e) { return false; }
}

function offline(text) {
  return new Response(text, { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function keep(req, res) {
  if (res && res.ok && res.type !== "opaque") {
    var copy = res.clone();
    caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
  }
  return res;
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  if (!sameOrigin(req.url)) return;               /* чужие домены не трогаем */

  /* cache:"no-cache" — спросить сервер, а не молча отдать из HTTP-кеша.
     Если файл не менялся, придёт лёгкий 304, а не весь файл заново. */
  e.respondWith(
    fetch(req, { cache: "no-cache" }).then(function (res) {
      return keep(req, res);
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        if (req.mode === "navigate") {
          return caches.match("./index.html", { ignoreSearch: true }).then(function (idx) {
            return idx || offline("Нет сети и кеша пока тоже нет.");
          });
        }
        if (/\/data\/[^/]+\.json/.test(req.url)) {
          return new Response('{"items":[]}', { headers: { "content-type": "application/json" } });
        }
        return offline("Нет сети и кеша пока тоже нет.");
      });
    })
  );
});

self.addEventListener("message", function (e) {
  if (e.data === "skip-waiting") self.skipWaiting();
});
