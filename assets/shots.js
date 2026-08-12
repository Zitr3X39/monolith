/* MONOLITH v14.8 — «доктор карточек»: превью, описания и режим ленты.

   Файл ничего не знает о внутренностях app.js и news.js. Он работает
   только с готовым DOM и с публичными адресами: не нашёл, что чинить —
   не делает ничего и сломать ничего не может. Подключается последним.

   ЧТО И ПОЧЕМУ ЧИНИТСЯ.

   1. ПРЕВЬЮ. app.js строит обложку через чужой сервис скриншотов
      s.wordpress.com/mshots. Сервис рисует страницу в фоновой очереди:
      на первый запрос отдаёт серую заглушку и только потом готовит
      картинку — значит у ссылки, добавленной пять минут назад, превью
      не будет никогда, пока страницу не перезагрузишь в нужный момент.
      Для github.com скриншот бесполезен даже когда получается: это
      серая шапка репозитория. И отдельно: если обложки в разметке нет
      вообще, ждать нечего.
      Теперь так. Есть mshots-картинка — для репозитория подменяем её
      на штатную социальную карточку GitHub (отдаётся сразу, без
      очереди, на ней видно имя, описание, язык и звёзды), для обычного
      сайта один раз переспрашиваем через 6 секунд. Обложки нет совсем —
      достраиваем её сами по ссылке карточки. Картинка всегда грузится
      в памяти и встаёт на место только целиком, поэтому карточка не
      моргает пустотой.

   2. ОПИСАНИЯ. В data/links.json описание есть у всех 46 ссылок, а
      app.js рисует <p class="card-desc"> ровно тогда, когда описание
      непустое. Значит пустые карточки — это ссылки, которых в
      links.json нет: добавленные прямо в браузере, они лежат в
      локальном слое lv.overlay.v1 и ждут отправки в репозиторий, а
      описания дописывает python-скрипт уже на стороне GitHub Actions.
      До отправки такая карточка так и стоит немой.
      Теперь описание подставляется на лету: сначала ищем ссылку в
      links.json, если её там нет и это репозиторий — берём настоящее
      описание из открытого GitHub API вместе с языком и звёздами.
      Запросов к API не больше двенадцати за загрузку, чтобы не упереться
      в лимит для незалогиненных.

   3. ЛЕНТА. Режим «как в TikTok» в news.js лежит с ночи, но включался
      он только флагом monolith.news.shorts в localStorage, а по
      умолчанию флага нет — вот почему новости выглядели ровно как
      раньше. Включаем флаг сами при первом заходе; если потом выключить
      режим руками, файл больше не лезет.
      Дрожание верхней плашки: она была sticky и на каждом кадре
      пересчитывала свою высоту под глобальной панелью, а строка
      «пришло N новых» меняла высоту под ней — отсюда прыжки и мигание
      «свежих находок». Плашку отлепляем, высоту строки фиксируем,
      переходы на ней глушим.

   4. НОМЕР ВЕРСИИ в левой панели переписывается на v14.8. Это простой
      способ проверить, что новый код действительно доехал: видишь
      v14.8 — значит работает всё из этой поставки. */

(function () {
  "use strict";

  var MSHOT = "https://s.wordpress.com/mshots/v1/";
  var OG = "https://opengraph.githubassets.com/1/";
  var API = "https://api.github.com/repos/";
  var RETRY_MS = 6000;
  var DONE = "data-shot-done";
  var DDONE = "data-desc-done";
  var NO_SHOT = ["chromewebstore.google.com", "curseforge.com", "t.me", "tiktok.com", "vm.tiktok.com"];

  var apiLeft = 12;
  var linksP = null;
  var timer = 0;

  /* ---------- помощники ---------- */

  function toUrl(raw) {
    try { return new URL(raw, location.href); } catch (e) { return null; }
  }

  function hostOf(url) { return url.hostname.replace(/^www\./, ""); }

  function repoOf(url) {
    if (!url || hostOf(url) !== "github.com") return null;
    var p = url.pathname.split("/").filter(Boolean);
    if (p.length < 2) return null;
    var owner = p[0];
    var repo = p[1].replace(/\.git$/, "");
    if (!owner || !repo) return null;
    return { owner: owner, repo: repo };
  }

  function blocked(url) {
    var h = hostOf(url);
    for (var i = 0; i < NO_SHOT.length; i++) {
      if (h === NO_SHOT[i]) return true;
      if (h.slice(-(NO_SHOT[i].length + 1)) === "." + NO_SHOT[i]) return true;
    }
    return false;
  }

  /* ключ как в links.json: домен без www + путь, в нижнем регистре */
  function keyOf(raw) {
    var url = toUrl(raw);
    return url ? (hostOf(url) + url.pathname).toLowerCase() : "";
  }

  /* грузим в памяти и показываем только готовое — без мигания */
  function ready(src, ok) {
    var probe = new Image();
    probe.onload = function () { if (probe.naturalWidth > 1) ok(src); };
    probe.src = src;
  }

  function linkOf(card) {
    var a = card.querySelector('a[href^="http"]');
    return a ? a.href : "";
  }

  /* ---------- 1. превью ---------- */

  function targetOf(shot) {
    if (!shot || shot.indexOf(MSHOT) !== 0) return null;
    var enc = shot.slice(MSHOT.length).split("?")[0];
    try { return toUrl(decodeURIComponent(enc)); } catch (e) { return null; }
  }

  function ghCard(shot) {
    var r = repoOf(targetOf(shot));
    if (!r) return "";
    return OG + encodeURIComponent(r.owner) + "/" + encodeURIComponent(r.repo);
  }

  /* чем закрыть обложку, которой нет вообще */
  function shotFor(raw) {
    var url = toUrl(raw);
    if (!url) return "";
    var r = repoOf(url);
    if (r) return OG + encodeURIComponent(r.owner) + "/" + encodeURIComponent(r.repo);
    if (blocked(url)) return "";
    return MSHOT + encodeURIComponent(url.origin + url.pathname) + "?w=640&h=360";
  }

  function handle(el, current, apply) {
    if (!current || current.indexOf(MSHOT) !== 0) return;
    if (el.getAttribute(DONE)) return;
    el.setAttribute(DONE, "1");
    var card = ghCard(current);
    if (card) { ready(card, apply); return; }
    setTimeout(function () {
      ready(current + (current.indexOf("?") < 0 ? "?" : "&") + "mono=1", apply);
    }, RETRY_MS);
  }

  function fixImg(img) {
    handle(img, img.getAttribute("src") || "", function (src) {
      img.setAttribute("loading", "lazy");
      img.setAttribute("decoding", "async");
      img.src = src;
    });
  }

  function fixBg(el) {
    var style = el.getAttribute("style") || "";
    if (style.indexOf("mshots") < 0) return;
    var m = style.match(/url\((['\"]?)([^'\")]+)\1\)/);
    if (!m) return;
    handle(el, m[2], function (src) { el.style.backgroundImage = 'url("' + src + '")'; });
  }

  /* обложки нет совсем — рисуем сами */
  function hasCover(media) {
    if (media.querySelector("img:not(.cover-fav)")) return true;
    return (media.getAttribute("style") || "").indexOf("url(") >= 0;
  }

  function addCover(card) {
    var media = card.querySelector(".card-media");
    if (!media || media.getAttribute(DONE) || hasCover(media)) return;
    var src = shotFor(linkOf(card));
    if (!src) return;
    media.setAttribute(DONE, "1");

    function put(url) {
      if (media.querySelector(".mono-shot")) return;
      var img = document.createElement("img");
      img.className = "mono-shot";
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.src = url;
      media.insertBefore(img, media.firstChild);
      media.classList.add("has-img");
    }

    ready(src, put);
    if (src.indexOf(MSHOT) === 0) {
      setTimeout(function () {
        if (!media.querySelector(".mono-shot")) ready(src + "&mono=1", put);
      }, RETRY_MS);
    }
  }

  /* ---------- 2. описания ---------- */

  function links() {
    if (linksP) return linksP;
    linksP = fetch("data/links.json?mono=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var map = {};
        var arr = (j && j.items) || [];
        for (var i = 0; i < arr.length; i++) {
          var k = String(arr[i].url_key || keyOf(arr[i].url) || "").toLowerCase();
          if (k) map[k] = arr[i];
        }
        return map;
      })
      .catch(function () { return {}; });
    return linksP;
  }

  function putDesc(card, text) {
    text = String(text || "").trim();
    if (!text || card.querySelector(".card-desc")) return;
    var p = document.createElement("p");
    p.className = "card-desc mono-desc";
    p.textContent = text;
    var note = card.querySelector(".card-note");
    var title = card.querySelector(".card-title");
    if (note && note.parentNode) note.parentNode.insertBefore(p, note);
    else if (title && title.parentNode) title.parentNode.insertBefore(p, title.nextSibling);
  }

  function fromGithub(url, ok) {
    var r = repoOf(url);
    if (!r || apiLeft <= 0) return;
    apiLeft--;
    fetch(API + encodeURIComponent(r.owner) + "/" + encodeURIComponent(r.repo), {
      headers: { Accept: "application/vnd.github+json" }
    })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (j) {
        if (!j) return;
        var t = String(j.description || "").trim();
        if (!t) return;
        var tail = [];
        if (j.language) tail.push(j.language);
        if (j.stargazers_count) tail.push("★ " + j.stargazers_count);
        ok(tail.length ? t + " · " + tail.join(" · ") : t);
      })
      .catch(function () {});
  }

  function fixDesc(card) {
    if (card.getAttribute(DDONE) || card.querySelector(".card-desc")) return;
    var href = linkOf(card);
    if (!href) return;
    card.setAttribute(DDONE, "1");
    links().then(function (map) {
      var it = map[keyOf(href)];
      if (it && String(it.description || "").trim()) { putDesc(card, it.description); return; }
      fromGithub(toUrl(href), function (t) { putDesc(card, t); });
    });
  }

  /* ---------- 3. лента ---------- */

  function newsMode() {
    try {
      if (localStorage.getItem("monolith.news.shorts") !== null) return;
      localStorage.setItem("monolith.news.shorts", "1");
      var n = window.MONOLITH_NEWS;
      if (n && typeof n.shorts === "function") n.shorts(true);
    } catch (e) {}
  }

  var CSS =
    ".card-media{position:relative}" +
    ".card-media .mono-shot{position:absolute;inset:0;width:100%;height:100%;" +
    "object-fit:cover;display:block;border-radius:inherit;z-index:0}" +
    ".mono-desc{margin:0}" +
    ".news-top{position:static!important;top:auto!important}" +
    "#feedMeta{min-height:36px}" +
    "#feedMeta .nm-row{min-height:36px;align-items:center}" +
    ".news-top,.news-top *,#feedMeta,#feedMeta *{transition:none!important;animation:none!important}";

  function css() {
    if (document.getElementById("mono-v148-css")) return;
    var s = document.createElement("style");
    s.id = "mono-v148-css";
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function stamp() {
    var v = document.querySelector(".ver-line");
    if (v && v.textContent.indexOf("14.8") < 0) v.textContent = "MONOLITH v14.8";
  }

  /* ---------- обход ---------- */

  function scan() {
    var i;
    var imgs = document.querySelectorAll('img[src^="' + MSHOT + '"]');
    for (i = 0; i < imgs.length; i++) fixImg(imgs[i]);
    var bgs = document.querySelectorAll('[style*="mshots"]');
    for (i = 0; i < bgs.length; i++) fixBg(bgs[i]);

    var cards = document.querySelectorAll("#grid .card");
    for (i = 0; i < cards.length; i++) {
      if (cards[i].classList.contains("skel")) continue;
      addCover(cards[i]);
      fixDesc(cards[i]);
    }
    stamp();
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(function () { timer = 0; scan(); }, 120);
  }

  function boot() {
    css();
    newsMode();
    scan();
    if (!window.MutationObserver) return;
    new MutationObserver(schedule).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "style", "class"]
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.MONOLITH_SHOTS = { scan: scan, card: ghCard, shot: shotFor };
})();
