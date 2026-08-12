/* =========================================================================
   MONOLITH — доктор интерфейса.  v15.0  «после видео-обзора 12.08, 17:27»

   Этот файл грузится последним и правит то, что уже нарисовано другими
   скриптами. Так можно лечить app.js / news.js / search-ui.js, не переписывая
   их целиком (они по 55 КБ, любая полная перезапись уже один раз ломала сайт).

   Что делает, по жалобам с видео (время — по SRT):
   0:16  синий тумблер «Умный» режет глаз      → нейтральная перекраска
   0:49  текст в выпадашке не видно             → контраст и фон панели
   1:24  жёлтый акцент «Снаружи» не мой стиль    → перекраска по факту цвета
   1:43  «что это за полоска» ×4                 → тонкая полоса-прогресс убрана
   2:00  шапка дёргается                         → геометрия шапки заморожена
   2:39  «что за прогресс бар»                   → строка счётчика собрана заново
   2:49  «это вообще не читается»                → чистка сырого README из карточек
   2:56  «залазит друг на друга»                 → дата вместо ISO-простыни
   3:11  «сайт должен быть как шортсы»            → шортсы включаются сами
   3:36  «почему она не посередине»               → шортсы на весь экран, по центру
   3:50  «нету описания»                         → описания с кэшем в браузере
   ========================================================================= */
(function () {
  "use strict";

  var VER = "v15.0";
  var MSHOT = "https://s.wordpress.com/mshots/v1/";
  var OG = "https://opengraph.githubassets.com/1/";
  var API = "https://api.github.com/repos/";
  var RETRY_MS = 6000;
  var DONE = "data-shot-done";
  var DDONE = "data-desc-done";
  var NO_SHOT = ["chromewebstore.google.com", "curseforge.com", "t.me", "tiktok.com", "vm.tiktok.com"];

  /* Бюджет запросов к GitHub: без токена он даёт 60 в час на адрес.
     Поэтому результат кладём в браузер — со второго захода описания
     появляются мгновенно и бюджет тратится только на новые ссылки. */
  var CKEY = "mono.desc.v1";
  var apiLeft = 28;
  var cache = {};
  try { cache = JSON.parse(localStorage.getItem(CKEY) || "{}") || {}; } catch (e) { cache = {}; }
  var cacheDirty = false;
  function saveCache() {
    if (!cacheDirty) return;
    cacheDirty = false;
    try { localStorage.setItem(CKEY, JSON.stringify(cache)); } catch (e) {}
  }

  var linksP = null;
  var timer = null;

  /* ---------- мелкие помощники ---------- */
  function toUrl(u) { try { return new URL(u, location.href); } catch (e) { return null; } }
  function hostOf(u) { var x = toUrl(u); return x ? x.hostname.replace(/^www\./, "") : ""; }
  function keyOf(u) { var x = toUrl(u); return x ? (x.hostname.replace(/^www\./, "") + x.pathname).toLowerCase() : ""; }
  function blocked(u) { var h = hostOf(u); for (var i = 0; i < NO_SHOT.length; i++) if (h === NO_SHOT[i]) return true; return false; }
  function repoOf(u) {
    var x = toUrl(u);
    if (!x || hostOf(u) !== "github.com") return null;
    var p = x.pathname.split("/").filter(Boolean);
    if (p.length < 2) return null;
    return { owner: p[0], repo: p[1].replace(/\.git$/, "") };
  }
  function pad(n) { return n < 10 ? "0" + n : String(n); }
  function nk(n) {
    n = Number(n) || 0;
    if (n >= 10000) return Math.round(n / 1000) + "k";
    if (n >= 1000) return (n / 1000).toFixed(1).replace(".0", "") + "k";
    return String(n);
  }
  function ready(src, ok) {
    var im = new Image();
    im.onload = function () { if (im.naturalWidth > 1) ok(); };
    im.src = src;
  }
  function linkOf(card) { return card.querySelector('a[href^="http"]'); }

  /* ==================== 1. ПРЕВЬЮ ==================== */
  function targetOf(u) {
    var g = repoOf(u);
    if (g) return OG + g.owner + "/" + g.repo;
    if (blocked(u)) return "";
    var x = toUrl(u);
    return x ? MSHOT + encodeURIComponent(x.origin + x.pathname) + "?w=640&h=360" : "";
  }
  function hasCover(media) {
    var im = media.querySelector("img:not(.cover-fav)");
    return !!(im && im.getAttribute("src"));
  }
  function addCover(media, src) {
    if (media.querySelector(".mono-shot")) return;
    var im = document.createElement("img");
    im.className = "mono-shot";
    im.setAttribute("loading", "lazy");
    im.setAttribute("decoding", "async");
    im.setAttribute("alt", "");
    im.src = src;
    im.onerror = function () { im.remove(); };
    media.insertBefore(im, media.firstChild);
    media.classList.add("has-img");
  }
  function fixMedia(card) {
    var media = card.querySelector(".card-media");
    if (!media || media.getAttribute(DONE)) return;
    var a = linkOf(card);
    if (!a) return;
    media.setAttribute(DONE, "1");
    if (hasCover(media)) return;
    var src = targetOf(a.href);
    if (!src) return;
    ready(src, function () { addCover(media, src); });
    if (src.indexOf(MSHOT) === 0) {
      setTimeout(function () {
        if (media.querySelector(".mono-shot")) return;
        var again = src + "&mono=1";
        ready(again, function () { addCover(media, again); });
      }, RETRY_MS);
    }
  }

  /* ==================== 2. ОПИСАНИЯ ==================== */
  function links() {
    if (linksP) return linksP;
    linksP = fetch("data/links.json?mono=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var map = {};
        var arr = (j && j.items) || [];
        for (var i = 0; i < arr.length; i++) {
          var it = arr[i];
          var k = it.url_key || keyOf(it.url || "");
          if (k) map[k] = it;
        }
        return map;
      })
      .catch(function () { return {}; });
    return linksP;
  }

  /* «· TypeScript» — это мой же прошлый промах: если у репозитория нет своего
     описания, строка начиналась с точки. Теперь такое считаем пустым. */
  function weak(txt) {
    var t = (txt || "").trim();
    if (!t) return true;
    if (/^[·•\-–—,.\s]/.test(t)) return true;
    return t.replace(/[^A-Za-zА-Яа-яЁё0-9]/g, "").length < 12;
  }
  function putDesc(card, text) {
    if (!text) return;
    var old = card.querySelector(".card-desc");
    if (old && !weak(old.textContent)) return;
    if (old) { old.textContent = text; old.classList.add("mono-desc"); return; }
    var p = document.createElement("p");
    p.className = "card-desc mono-desc";
    p.textContent = text;
    var note = card.querySelector(".card-note");
    var title = card.querySelector(".card-title");
    if (note && note.parentNode) note.parentNode.insertBefore(p, note);
    else if (title && title.parentNode) title.parentNode.insertBefore(p, title.nextSibling);
    else card.appendChild(p);
  }
  function ghText(j) {
    var d = (j.description || "").trim();
    var tail = [];
    if (j.language) tail.push(j.language);
    if (j.stargazers_count) tail.push("★ " + nk(j.stargazers_count));
    if (d) return tail.length ? d + " · " + tail.join(" · ") : d;
    var t = "Репозиторий " + (j.full_name || "");
    if (j.language) t += " на " + j.language;
    if (j.stargazers_count) t += ", ★ " + nk(j.stargazers_count);
    var tp = (j.topics || []).slice(0, 4);
    if (tp.length) t += " · " + tp.join(", ");
    return t.trim() + ".";
  }
  function fromGithub(card, url, key) {
    var g = repoOf(url);
    if (!g || apiLeft <= 0) return;
    apiLeft--;
    fetch(API + g.owner + "/" + g.repo, { headers: { Accept: "application/vnd.github+json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return;
        var t = ghText(j);
        if (!t) return;
        cache[key] = t;
        cacheDirty = true;
        putDesc(card, t);
        saveCache();
      })
      .catch(function () {});
  }
  function fixDesc(card) {
    if (card.getAttribute(DDONE)) return;
    var a = linkOf(card);
    if (!a) return;
    card.setAttribute(DDONE, "1");
    var have = card.querySelector(".card-desc");
    if (have && !weak(have.textContent)) return;
    var key = keyOf(a.href);
    if (cache[key]) { putDesc(card, cache[key]); return; }
    var url = a.href;
    links().then(function (map) {
      var it = map[key];
      if (it && !weak(it.description)) { putDesc(card, String(it.description).trim()); return; }
      fromGithub(card, url, key);
    });
  }

  /* ==================== 3. ЛЕНТА ==================== */
  var HAS_TAG = /<\/?[a-zA-Z!][^>]*>/;
  function cleanText(s) {
    return s
      .replace(/<\/?[a-zA-Z!][^>]*>/g, " ")
      .replace(/!?\[\s*\]\([^)]*\)/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[|]{2,}/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  /* Сырой README влезал в карточку как есть: <p align="center">, <img src=...>,
     пустые бейджи [](...). Именно это на видео названо «не читается». */
  function cleanReadme() {
    var list = document.getElementById("feedList");
    if (!list) return;
    var nodes = list.querySelectorAll("p,li,figcaption");
    for (var i = 0; i < nodes.length && i < 500; i++) {
      var el = nodes[i];
      if (el.getAttribute("data-mono-clean")) continue;
      if (el.children.length) continue;
      var raw = el.textContent || "";
      el.setAttribute("data-mono-clean", "1");
      if (!raw || (!HAS_TAG.test(raw) && raw.indexOf("](") < 0)) continue;
      var out = cleanText(raw);
      if (out.length < 14) { el.remove(); continue; }
      if (out !== raw) el.textContent = out;
    }
  }
  /* «обновлено 2026-08-12T08:08:33.583173+00:00» → «обновлено 12.08, 11:08» */
  function fixUpd() {
    var el = document.querySelector("#feedMeta .nm-upd");
    if (!el || el.getAttribute("data-mono-upd")) return;
    var m = /(\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:[+-]\d{2}:?\d{2}|Z)?)/.exec(el.textContent || "");
    if (!m) return;
    var d = new Date(m[1]);
    if (isNaN(d.getTime())) return;
    el.setAttribute("data-mono-upd", "1");
    el.textContent = "обновлено " + pad(d.getDate()) + "." + pad(d.getMonth() + 1) + ", " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  /* Лента сразу как шортсы: жмём настоящую кнопку, чтобы пройти обычным путём. */
  var forced = false;
  function newsMode() {
    if (forced) return;
    var list = document.getElementById("feedList");
    if (!list || !list.offsetParent) return;
    var btn = document.querySelector("[data-shorts-toggle]");
    if (btn) {
      forced = true;
      if (btn.getAttribute("aria-pressed") !== "true") { try { btn.click(); } catch (e) { forced = false; } }
      return;
    }
    var N = window.MONOLITH_NEWS;
    if (N && typeof N.shorts === "function") {
      forced = true;
      try { N.shorts(true); } catch (e) { forced = false; }
    }
  }
  function shortsWatch() {
    var list = document.getElementById("feedList");
    var on = !!(list && list.classList.contains("is-shorts"));
    document.documentElement.classList.toggle("mono-shorts", on);
  }

  /* ==================== 4. ЖЁЛТЫЙ → МОНОХРОМ ==================== */
  function isYellow(c) {
    var m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(c || "");
    if (!m) return false;
    var r = +m[1], g = +m[2], b = +m[3];
    return r > 120 && g > 90 && b < 120 && (r - b) > 55 && Math.abs(r - g) < 90;
  }
  function overlays() {
    var out = [];
    var all = document.querySelectorAll("div,section,dialog,aside");
    for (var i = 0; i < all.length && i < 1200; i++) {
      var el = all[i];
      if (el.clientHeight < window.innerHeight * 0.55) continue;
      var cs = getComputedStyle(el);
      if (cs.position === "fixed" && cs.display !== "none" && cs.visibility !== "hidden") out.push(el);
    }
    return out;
  }
  function deyellow() {
    var roots = overlays();
    for (var i = 0; i < roots.length; i++) {
      var nodes = roots[i].querySelectorAll("*");
      for (var j = 0; j < nodes.length && j < 1600; j++) {
        var el = nodes[j];
        if (el.getAttribute("data-mono-hue")) continue;
        el.setAttribute("data-mono-hue", "1");
        var cs = getComputedStyle(el);
        if (isYellow(cs.color)) el.style.setProperty("color", "#f1f2ee", "important");
        if (isYellow(cs.backgroundColor)) {
          el.style.setProperty("background", "rgba(255,255,255,.09)", "important");
          el.style.setProperty("color", "#f1f2ee", "important");
        }
        if (isYellow(cs.borderTopColor) || isYellow(cs.borderLeftColor) || isYellow(cs.borderBottomColor)) {
          el.style.setProperty("border-color", "rgba(255,255,255,.22)", "important");
        }
        if (cs.borderTopStyle === "dashed" || cs.borderLeftStyle === "dashed") {
          el.style.setProperty("border-style", "solid", "important");
        }
        if (isYellow(cs.outlineColor)) el.style.setProperty("outline-color", "rgba(255,255,255,.22)", "important");
      }
    }
  }

  /* ==================== 5. СТИЛИ ==================== */
  function css() {
    if (document.getElementById("mono-v150-css")) return;
    var s = document.createElement("style");
    s.id = "mono-v150-css";
    s.textContent = [
      ".card-media{position:relative}",
      ".card-media .mono-shot{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;border-radius:inherit;z-index:0}",
      ".mono-desc{margin:0}",

      /* Шапка: при is-scrolled она меняла тип позиционирования и уезжала влево,
         из-за этого менялась высота документа и скролл сам себя выталкивал
         обратно за порог — отсюда бесконечное дрожание. Геометрию фиксируем. */
      ".topbar{transition:none!important;animation:none!important}",
      ".is-scrolled .topbar,html.is-scrolled .topbar,body.is-scrolled .topbar{position:sticky!important;top:0!important;left:auto!important;right:auto!important;bottom:auto!important;transform:none!important;translate:none!important;scale:none!important;width:auto!important;max-width:none!important;margin-left:0!important;margin-right:0!important;transition:none!important;animation:none!important;z-index:60!important}",

      /* Шапка ленты и строка счётчика */
      ".news-top{position:static!important;top:auto!important}",
      ".news-top,.news-top *,#feedMeta,#feedMeta *{transition:none!important;animation:none!important}",
      "#feedMeta .nm-bar{display:none!important}",
      "#feedMeta{min-height:34px}",
      "#feedMeta .nm-row{display:flex!important;align-items:center!important;gap:14px!important;min-height:34px;flex-wrap:nowrap!important}",
      "#feedMeta .nm-gap{flex:1 1 auto}",
      "#feedMeta .nm-upd{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:38%;opacity:.7}",
      "#feedMeta .nm-mode{flex:0 0 auto;margin-left:10px}",

      /* Тумблер «Умный» — без синей заливки */
      ".smart-sw{background:rgba(255,255,255,.06)!important;border:1px solid rgba(255,255,255,.17)!important;box-shadow:none!important;color:#c9cbc6!important}",
      ".smart-sw *{color:inherit!important}",
      '.smart-sw[aria-pressed="true"],.smart-sw.is-on{background:rgba(255,255,255,.14)!important;border-color:rgba(255,255,255,.34)!important;color:#f1f2ee!important}',
      ".smart-sw i,.smart-sw b,.smart-sw em,.smart-sw [class*='knob'],.smart-sw [class*='dot']{background:#f1f2ee!important;box-shadow:none!important}",

      /* Выпадашка поиска: её было не видно и её перекрывали вкладки */
      "#smartPanel{z-index:120!important;background:#0d0f12!important;border:1px solid rgba(255,255,255,.17)!important;box-shadow:0 26px 64px rgba(0,0,0,.62)!important}",
      "#smartPanel,#smartPanel *{color:#e9ebe7}",
      "#smartPanel small,#smartPanel [class*='hint'],#smartPanel [class*='foot'],#smartPanel [class*='muted'],#smartPanel [class*='empty']{color:#a9aca6!important;opacity:1!important}",

      /* Шортсы: на весь экран и по центру */
      "html.mono-shorts,html.mono-shorts body{overflow:hidden!important}",
      "html.mono-shorts .topbar,html.mono-shorts .news-top,html.mono-shorts #feedMeta,html.mono-shorts #feedChips{display:none!important}",
      "#feedList.is-shorts{position:fixed!important;inset:0!important;width:100vw!important;max-width:none!important;margin:0!important;padding:0!important;background:#050607!important;z-index:90!important}",
      "#feedList.is-shorts>*{left:0!important;right:0!important;margin-left:auto!important;margin-right:auto!important}",
      "#feedList.is-shorts>.sh-chrome{width:100%!important;max-width:none!important}"
    ].join("\n");
    document.head.appendChild(s);
  }

  function stamp() {
    var v = document.querySelector(".ver-line");
    if (v && v.textContent.indexOf(VER) < 0) v.textContent = "MONOLITH " + VER;
  }

  /* ==================== 6. ЗАПУСК ==================== */
  function scan() {
    css();
    stamp();
    var cards = document.querySelectorAll(".card");
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (c.classList.contains("skel")) continue;
      fixMedia(c);
      fixDesc(c);
    }
    fixUpd();
    cleanReadme();
    shortsWatch();
    newsMode();
    deyellow();
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(scan, 140);
  }
  function boot() {
    scan();
    try {
      new MutationObserver(schedule).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "style", "class", "aria-pressed"]
      });
    } catch (e) {}
    window.addEventListener("hashchange", schedule);
    window.addEventListener("popstate", schedule);
    setTimeout(scan, 900);
    setTimeout(scan, 2600);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.MONOLITH_SHOTS = { scan: scan, shot: targetOf, deyellow: deyellow, clean: cleanReadme };
})();
