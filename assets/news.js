/* MONOLITH v14.5 — раздел «Новости»: Signal Reader + режим «Шортсы».

   Контракт с app.js (не ломать):
     window.MONOLITH_NEWS.render({ items, updatedAt, filter, query, known })
     кнопки отдают data-feed-add="<url_key>" / data-feed-copy="<url_key>"
     чипы — .chip с data-value, клик ловит делегация на #feedChips

   Фильтр приходит одной строкой (state.feedSrc):
     "" | "all"            — всё
     "topic:ai-agents"     — по теме
     "src:GitHub Trending" — по источнику

   v14.5 добавила: режим «Шортсы» (одна карточка на экран, один жест —
   один перелёт), неподвижную шапку ленты и рабочий прогресс-бар. */
(function () {
  "use strict";

  var PAGE = 12;
  var SEEN_KEY = "monolith.news.seen";
  var SORT_KEY = "monolith.news.sort";
  var SHORTS_KEY = "monolith.news.shorts";

  var TOPICS = [
    { id: "ai-agents",    name: "AI и агенты",       color: "#8B7CFF" },
    { id: "ai-skills",    name: "Скиллы и промпты", color: "#22D3A7" },
    { id: "dev-tools",    name: "Инструменты",      color: "#5AA9FF" },
    { id: "ux-design",    name: "Дизайн и UX",       color: "#FF7A59" },
    { id: "automation",   name: "Автоматизация",    color: "#FFB020" },
    { id: "productivity", name: "Продуктивность",   color: "#E85D9E" }
  ];

  var TMAP = {};
  TOPICS.forEach(function (t) { TMAP[t.id] = t; });
  var OTHER = { id: "other", name: "Другое", color: "#8A8E88" };

  var TYPE_LABEL = {
    github: "репозиторий",
    youtube: "видео",
    telegram: "канал",
    article: "статья",
    site: "сайт"
  };

  /* состояние модуля */
  var lastCtx = null;
  var shownCount = PAGE;
  var sortMode = "hot";
  var seenAt = 0;
  var readCache = {};
  var imgCache = {};
  var selIdx = -1;
  var keysBound = false;
  var io = null;

  /* состояние режима «Шортсы» */
  var shorts = false;
  var curIdx = 0;
  var lastFlip = 0;
  var shChrome = null;
  var shBound = false;
  var modeBound = false;

  try {
    var s0 = localStorage.getItem(SORT_KEY);
    if (s0 === "new" || s0 === "hot") sortMode = s0;
    var v0 = Number(localStorage.getItem(SEEN_KEY) || 0);
    if (v0 > 0) seenAt = v0;
    shorts = localStorage.getItem(SHORTS_KEY) === "1";
  } catch (e) {}

  /* ---------- утилиты ---------- */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function txt(v) { return typeof v === "string" ? v.trim() : ""; }

  function hasCyr(s) { return /[а-яё]/i.test(s || ""); }

  /* Клиентский quality gate: явный мусор не показываем ни в каком виде. */
  function junk(s) {
    if (!s) return true;
    if (/generating\s+preview/i.test(s)) return true;
    if (/&(#\d+|[a-z]+);/i.test(s)) return true;
    if (/^(read more|continue reading|comments?)$/i.test(s.trim())) return true;
    return s.trim().length < 3;
  }

  /* Скриншотные прокси отдают «Generating Preview…» вместо картинки. */
  function badImage(u) {
    if (!u) return true;
    if (!/^https?:\/\//i.test(u)) return true;
    if (/mshots|screenshot(api|machine)|thum\.io|image\.thum/i.test(u)) return true;
    if (/shields\.io|badgen|badge|travis-ci|circleci|codecov|\.svg($|\?)/i.test(u)) return true;
    return false;
  }

  function asList(v) {
    var out = [];
    if (Array.isArray(v)) {
      v.forEach(function (x) { var s = txt(x); if (s && !junk(s)) out.push(s); });
    } else {
      var s = txt(v);
      if (s && !junk(s)) {
        s.split(/\s*(?:•|\n|;)\s*/).forEach(function (p) {
          p = p.trim().replace(/^[-–—*]\s*/, "");
          if (p.length > 2) out.push(p);
        });
      }
    }
    return out.slice(0, 4);
  }

  function topicOf(it) {
    var id = txt(it.topic);
    if (TMAP[id]) return TMAP[id];
    var c = txt(it.category);
    if (c === "design" || c === "3d") return TMAP["ux-design"];
    if (c === "ai-skills") return TMAP["ai-skills"];
    if (c === "tools" || c === "vibecoding") return TMAP["dev-tools"];
    if (c === "automation") return TMAP["automation"];
    if (c === "productivity") return TMAP["productivity"];
    return OTHER;
  }

  function titleOf(it) {
    var t = txt(it.title_ru);
    if (t && !junk(t)) return t;
    return txt(it.title) || txt(it.domain) || "Без названия";
  }

  /* Сначала разбор, потом перевод, потом оригинал. Нет русского — помечаем
     карточку как оригинал EN, а не выбрасываем. */
  function leadOf(it) {
    var cands = [it.summary_ru, it.description_ru, it.description];
    for (var i = 0; i < cands.length; i++) {
      var s = txt(cands[i]);
      if (s && !junk(s)) return { text: s, ru: hasCyr(s) };
    }
    return { text: "", ru: false };
  }

  function domainOf(it) {
    var d = txt(it.domain);
    if (d) return d.replace(/^www\./, "");
    try { return new URL(it.url).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
  }

  function stamp(it) {
    var raw = txt(it.published_at) || txt(it.found_at);
    if (!raw) return 0;
    var d = new Date(raw);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }

  function whenOf(it) {
    var ms = stamp(it);
    if (!ms) return "";
    var diff = (Date.now() - ms) / 36e5;
    if (diff < 0) return "";
    if (diff < 1) return "только что";
    if (diff < 24) return Math.round(diff) + " ч назад";
    var days = Math.round(diff / 24);
    if (days === 1) return "вчера";
    if (days < 7) return days + " дн назад";
    try {
      return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(new Date(ms));
    } catch (e) { return ""; }
  }

  function ghSlug(url) {
    var m = /^https?:\/\/(?:www\.)?github\.com\/([^\/#?]+)\/([^\/#?]+)/i.exec(url || "");
    if (!m) return null;
    return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
  }

  function num(n) {
    n = Number(n || 0);
    if (!n) return "";
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(".0", "") + "k";
    return String(Math.round(n));
  }

  /* ---------- собственный CSS раздела ----------
     Стили шортсов и правка шапки живут здесь, а не в news.css: так режим
     автономен — не нужно подключать новый файл в index.html, дописывать его
     в precache sw.js и гонять версию кэша. */

  function injectCss() {
    if (document.getElementById("news-v145-css")) return;
    var css = [
      /* 1. Шапка ленты. Причин тряски было три: .news-top висела на top:0 ровно
         там же, где глобальный .topbar; фон был градиентом в прозрачность и
         контент просвечивал насквозь; внутри липкого блока стояла своя
         прокрутка со scroll-snap, которую браузер пересчитывал каждый кадр. */
      ".news-top{top:var(--news-stick,0px)!important;",
      "background:var(--ink)!important;backdrop-filter:none!important;",
      "-webkit-backdrop-filter:none!important;box-shadow:0 1px 0 var(--line)}",
      ".news-topics{scroll-snap-type:none!important;scrollbar-width:none}",
      ".news-topics::-webkit-scrollbar{width:0;height:0}",

      /* 2. Строка статуса и прогресс-бар. */
      "#feedMeta{display:block!important;width:100%}",
      ".nm-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;",
      "font-family:var(--font-mono,var(--mono,monospace));font-size:11.5px;",
      "letter-spacing:.03em;color:var(--text-3)}",
      ".nm-fresh{display:inline-flex;align-items:center;gap:6px;height:22px;",
      "padding:0 9px;border-radius:999px;background:rgba(90,169,255,.14);",
      "color:var(--news-accent,#5aa9ff);font-weight:600}",
      ".nm-fresh i{width:5px;height:5px;border-radius:50%;background:currentColor}",
      ".nm-count{font-variant-numeric:tabular-nums;color:var(--text-2)}",
      ".nm-gap{flex:1 1 auto;min-width:8px}",
      ".nm-mode{display:inline-flex;align-items:center;gap:6px;height:26px;",
      "padding:0 11px;border-radius:999px;border:1px solid var(--line);",
      "background:transparent;color:var(--text-2);font:inherit;cursor:pointer;",
      "transition:background .18s ease,color .18s ease,border-color .18s ease}",
      ".nm-mode:hover{color:var(--text);border-color:var(--line-strong,rgba(255,255,255,.17))}",
      ".nm-mode:focus-visible{outline:2px solid var(--news-accent,#5aa9ff);outline-offset:2px}",
      '.nm-mode[aria-pressed="true"]{background:var(--news-accent,#5aa9ff);',
      "border-color:var(--news-accent,#5aa9ff);color:#0b1220;font-weight:600}",
      ".nm-bar{position:relative;height:2px;margin-top:10px;border-radius:2px;",
      "background:var(--line);overflow:hidden}",
      ".nm-bar i{position:absolute;left:0;top:0;bottom:0;display:block;border-radius:2px;",
      "background:var(--news-accent,#5aa9ff);transition:width .32s cubic-bezier(.22,.61,.36,1)}",

      /* 3. Режим «Шортсы»: карточки становятся слоями в одном фиксированном
         контейнере. Следующая ждёт снизу, прошлая уходит вверх. */
      "html.is-shorts,body.is-shorts{overflow:hidden!important}",
      "#feedList.is-shorts{position:fixed;inset:0;z-index:120;margin:0;padding:0;",
      "display:block;background:var(--ink);overflow:hidden;overscroll-behavior:contain}",
      "#feedList.is-shorts>.news-note{display:none}",
      "#feedList.is-shorts>.news-card{position:absolute;left:50%;top:0;",
      "width:min(760px,100%);max-width:none;height:100vh;height:100svh;margin:0;",
      "border-radius:0;overflow-y:auto;overscroll-behavior:contain;touch-action:pan-y;",
      "padding:64px 22px calc(72px + env(safe-area-inset-bottom,0px));",
      "opacity:0;pointer-events:none;transform:translate3d(-50%,100%,0);",
      "transition:transform .48s cubic-bezier(.22,.61,.36,1),opacity .3s ease;",
      "will-change:transform}",
      "#feedList.is-shorts>.news-card::-webkit-scrollbar{width:0}",
      "#feedList.is-shorts>.news-card.is-prev{transform:translate3d(-50%,-100%,0);opacity:0}",
      "#feedList.is-shorts>.news-card.is-cur{transform:translate3d(-50%,0,0);opacity:1;",
      "pointer-events:auto}",
      "#feedList.is-shorts .news-gal{max-height:46svh}",

      /* 4. Обвязка шортсов: выход, счётчик, вертикальный индикатор. */
      ".sh-chrome{position:fixed;inset:0;z-index:121;display:none;pointer-events:none}",
      ".sh-chrome.on{display:block}",
      ".sh-top{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;",
      "gap:12px;padding:12px 16px;pointer-events:auto;",
      "background:linear-gradient(180deg,rgba(5,6,7,.94),rgba(5,6,7,0))}",
      ".sh-exit{width:34px;height:34px;display:grid;place-items:center;border-radius:10px;",
      "border:1px solid var(--line);background:rgba(13,15,18,.85);color:var(--text-2);",
      "cursor:pointer;padding:0}",
      ".sh-exit:hover{color:var(--text)}",
      ".sh-exit:focus-visible{outline:2px solid var(--news-accent,#5aa9ff);outline-offset:2px}",
      ".sh-num{margin-left:auto;font-family:var(--font-mono,var(--mono,monospace));",
      "font-variant-numeric:tabular-nums;font-size:12px;color:var(--text-2);",
      "background:rgba(13,15,18,.85);border:1px solid var(--line);border-radius:999px;",
      "padding:5px 11px}",
      ".sh-rail{position:absolute;right:10px;top:66px;bottom:66px;width:3px;",
      "border-radius:3px;background:rgba(255,255,255,.09);overflow:hidden}",
      ".sh-rail i{position:absolute;left:0;right:0;top:0;display:block;border-radius:3px;",
      "background:var(--news-accent,#5aa9ff);transition:height .34s cubic-bezier(.22,.61,.36,1)}",
      ".sh-hint{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);",
      "font-family:var(--font-mono,var(--mono,monospace));font-size:11px;letter-spacing:.04em;",
      "color:var(--text-3);background:rgba(13,15,18,.82);border:1px solid var(--line);",
      "border-radius:999px;padding:6px 13px;white-space:nowrap}",

      /* 5. Уважаем prefers-reduced-motion. */
      "@media (prefers-reduced-motion:reduce){",
      "#feedList.is-shorts>.news-card{transition:none}",
      ".nm-bar i,.sh-rail i{transition:none}}",
      "@media (max-width:560px){.sh-hint{display:none}}"
    ].join("");
    var st = document.createElement("style");
    st.id = "news-v145-css";
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  /* Шапка ленты должна липнуть ПОД глобальной панелью, а не в ту же точку.
     Высоту берём замером: панель переносится на две строки на узких экранах. */
  function stickTop() {
    var tb = document.querySelector(".topbar");
    var h = 0;
    if (tb) {
      var pos = "";
      try { pos = getComputedStyle(tb).position; } catch (e) {}
      if (pos === "fixed" || pos === "sticky") h = Math.round(tb.getBoundingClientRect().height);
    }
    document.documentElement.style.setProperty("--news-stick", h + "px");
  }

  /* ---------- картинки из самого материала ---------- */

  function imagesFromText(text, url) {
    var out = [], seen = {}, m;
    var gh = ghSlug(url);
    var base = gh ? "https://raw.githubusercontent.com/" + gh.owner + "/" + gh.repo + "/HEAD/" : null;
    var origin = "";
    try { origin = new URL(url).origin; } catch (e) {}

    function push(raw) {
      var u = String(raw || "").trim().replace(/^<|>$/g, "").split(/\s+/)[0];
      if (!u) return;
      if (/^\/\//.test(u)) u = "https:" + u;
      if (!/^https?:\/\//i.test(u)) {
        if (base) u = base + u.replace(/^\.?\//, "");
        else if (origin) u = origin + (u.charAt(0) === "/" ? "" : "/") + u.replace(/^\.?\//, "");
        else return;
      }
      if (badImage(u)) return;
      if (!/\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i.test(u)) return;
      var k = u.split("?")[0];
      if (seen[k]) return;
      seen[k] = 1;
      out.push(u);
    }

    var reMd = /!\[[^\]]*\]\(([^)]+)\)/g;
    while ((m = reMd.exec(text)) && out.length < 8) push(m[1]);
    var reImg = /<img[^>]+src\s*=\s*["']?([^"'\s>]+)/gi;
    while ((m = reImg.exec(text)) && out.length < 8) push(m[1]);
    return out.slice(0, 6);
  }

  function coverOf(it) {
    var u = txt(it.image);
    return u && !badImage(u) ? u : "";
  }

  /* ---------- галерея ---------- */

  function slideHtml(src, i) {
    var fit = /opengraph\.githubassets|og-image|\/og\//i.test(src) ? " is-fit" : "";
    return '<div class="news-slide' + fit + '" data-si="' + i + '">' +
      '<img src="' + esc(src) + '" alt="" loading="lazy" decoding="async" draggable="false" />' +
      "</div>";
  }

  function arrow(dir) {
    var d = dir < 0 ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7";
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"/></svg>';
  }

  function galHtml(it, srcs) {
    if (!srcs.length) {
      var letter = (titleOf(it).replace(/[^0-9A-Za-zА-яа-я]/g, "").charAt(0) || "M").toUpperCase();
      return '<div class="news-gal" data-gal="empty">' +
        '<div class="news-rail"><div class="news-slide"><span class="news-letter">' + esc(letter) + "</span></div></div>" +
        '<span class="news-gal-meta">' + esc(domainOf(it)) + "</span>" +
        '<button type="button" class="news-gal-more" data-more="1">Картинки из материала</button>' +
        "</div>";
    }
    var slides = srcs.map(slideHtml).join("");
    var dots = srcs.map(function (_, i) { return "<i" + (i ? "" : ' class="on"') + "></i>"; }).join("");
    return '<div class="news-gal">' +
      '<div class="news-rail" tabindex="0" role="group" aria-label="Картинки материала">' + slides + "</div>" +
      '<button type="button" class="news-gal-nav prev" data-nav="-1" aria-label="Назад"' + (srcs.length > 1 ? "" : " hidden") + ">" + arrow(-1) + "</button>" +
      '<button type="button" class="news-gal-nav next" data-nav="1" aria-label="Вперёд"' + (srcs.length > 1 ? "" : " hidden") + ">" + arrow(1) + "</button>" +
      '<span class="news-gal-meta" data-count>' + (srcs.length > 1 ? "1 / " + srcs.length : esc(domainOf(it))) + "</span>" +
      '<div class="news-gal-dots" data-dots' + (srcs.length > 1 ? "" : " hidden") + ">" + dots + "</div>" +
      '<button type="button" class="news-gal-more" data-more="1">Ещё из материала</button>' +
      "</div>";
  }

  /* Листание галереи: scroll-snap + тянуть мышью/пальцем. Колесо здесь не
     перехватываем: вертикальная навигация принадлежит шортсам. */
  function wireGal(gal) {
    if (!gal || gal.__wired) return;
    gal.__wired = true;
    var rail = gal.querySelector(".news-rail");
    if (!rail) return;

    function slides() { return rail.querySelectorAll(".news-slide"); }

    function index() {
      var w = rail.clientWidth || 1;
      return Math.round(rail.scrollLeft / w);
    }

    function sync() {
      var i = index(), n = slides().length;
      var dots = gal.querySelectorAll("[data-dots] i");
      for (var k = 0; k < dots.length; k++) dots[k].className = k === i ? "on" : "";
      var c = gal.querySelector("[data-count]");
      if (c && n > 1) c.textContent = (i + 1) + " / " + n;
      var prev = gal.querySelector(".news-gal-nav.prev");
      var next = gal.querySelector(".news-gal-nav.next");
      if (prev) prev.style.visibility = i <= 0 ? "hidden" : "";
      if (next) next.style.visibility = i >= n - 1 ? "hidden" : "";
    }

    gal.__go = function (dir) {
      var w = rail.clientWidth || 1;
      rail.scrollTo({ left: (index() + dir) * w, behavior: "smooth" });
    };

    gal.addEventListener("click", function (e) {
      var nav = e.target.closest("[data-nav]");
      if (!nav) return;
      e.preventDefault();
      gal.__go(Number(nav.getAttribute("data-nav")) || 1);
    });

    var t = null;
    rail.addEventListener("scroll", function () {
      if (t) return;
      t = setTimeout(function () { t = null; sync(); }, 60);
    }, { passive: true });

    var down = false, x0 = 0, l0 = 0, moved = 0;
    rail.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "touch") return;
      down = true; moved = 0; x0 = e.clientX; l0 = rail.scrollLeft;
      rail.classList.add("is-drag");
    });
    rail.addEventListener("pointermove", function (e) {
      if (!down) return;
      var dx = e.clientX - x0;
      moved = Math.max(moved, Math.abs(dx));
      rail.scrollLeft = l0 - dx;
      if (moved > 6) e.preventDefault();
    });
    function up() {
      if (!down) return;
      down = false;
      rail.classList.remove("is-drag");
      var w = rail.clientWidth || 1;
      rail.scrollTo({ left: Math.round(rail.scrollLeft / w) * w, behavior: "smooth" });
      setTimeout(sync, 220);
    }
    rail.addEventListener("pointerup", up);
    rail.addEventListener("pointercancel", up);
    rail.addEventListener("pointerleave", up);

    rail.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft") { e.preventDefault(); gal.__go(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); gal.__go(1); }
    });

    rail.addEventListener("error", function (e) {
      var img = e.target;
      if (!img || img.tagName !== "IMG") return;
      var sl = img.closest(".news-slide");
      if (sl && rail.querySelectorAll(".news-slide").length > 1) sl.remove();
      rebuildDots(gal);
    }, true);

    sync();
  }

  function rebuildDots(gal) {
    var rail = gal.querySelector(".news-rail");
    var box = gal.querySelector("[data-dots]");
    if (!rail || !box) return;
    var n = rail.querySelectorAll(".news-slide").length;
    var html = "";
    for (var i = 0; i < n; i++) html += "<i" + (i ? "" : ' class="on"') + "></i>";
    box.innerHTML = html;
    box.hidden = n < 2;
    var prev = gal.querySelector(".news-gal-nav.prev");
    var next = gal.querySelector(".news-gal-nav.next");
    if (prev) prev.hidden = n < 2;
    if (next) next.hidden = n < 2;
    var c = gal.querySelector("[data-count]");
    if (c && n > 1) c.textContent = "1 / " + n;
  }

  function addSlides(gal, srcs) {
    if (!gal) return 0;
    var rail = gal.querySelector(".news-rail");
    if (!rail || !srcs.length) return 0;
    var have = {};
    rail.querySelectorAll("img").forEach(function (im) { have[im.getAttribute("src").split("?")[0]] = 1; });
    var letter = rail.querySelector(".news-letter");
    var added = 0;
    srcs.forEach(function (u) {
      if (have[u.split("?")[0]]) return;
      rail.insertAdjacentHTML("beforeend", slideHtml(u, 99));
      added++;
    });
    if (added && letter) {
      var host = letter.closest(".news-slide");
      if (host) host.remove();
      gal.removeAttribute("data-gal");
      if (!gal.querySelector("[data-dots]")) {
        gal.insertAdjacentHTML("beforeend",
          '<button type="button" class="news-gal-nav prev" data-nav="-1" aria-label="Назад">' + arrow(-1) + "</button>" +
          '<button type="button" class="news-gal-nav next" data-nav="1" aria-label="Вперёд">' + arrow(1) + "</button>" +
          '<div class="news-gal-dots" data-dots></div>');
        gal.__wired = false;
      }
    }
    rebuildDots(gal);
    wireGal(gal);
    return added;
  }

  /* ---------- факты из текста материала ----------
     Всё, что показываем в блоке фактов, реально взято из текста. Ничего не
     додумываем — иначе информации нельзя верить. */

  function factsFrom(text) {
    var out = { install: "", parts: [], stack: [] };
    if (!text) return out;

    var fences = [], m;
    var re = /```([A-Za-z0-9+#._-]*)\n([\s\S]*?)```/g;
    while ((m = re.exec(text)) && fences.length < 40) fences.push({ lang: m[1].toLowerCase(), body: m[2] });

    var langs = {};
    fences.forEach(function (f) {
      if (!f.lang) return;
      if (/^(bash|sh|shell|zsh|console|text|txt|diff|json|yaml|yml|toml|ini|env)$/.test(f.lang)) return;
      langs[f.lang] = (langs[f.lang] || 0) + 1;
    });
    out.stack = Object.keys(langs).sort(function (a, b) { return langs[b] - langs[a]; }).slice(0, 3);

    var installRe = /^\s*(?:\$\s*)?((?:npm\s+(?:i|install)|npx|pnpm\s+(?:add|dlx)|yarn\s+add|bun(?:x)?\s+\S+|pip3?\s+install|uv\s+(?:pip\s+)?(?:add|install)|uvx|brew\s+install|cargo\s+install|go\s+install|docker\s+run|git\s+clone)\s+[^\n&|;]+)/im;
    for (var i = 0; i < fences.length && !out.install; i++) {
      var hit = installRe.exec(fences[i].body);
      if (hit) out.install = hit[1].trim().slice(0, 120);
    }
    if (!out.install) {
      var inline = /`((?:npm\s+(?:i|install)|npx|pnpm\s+add|yarn\s+add|pip3?\s+install|uvx?|brew\s+install)\s+[^`]{2,80})`/i.exec(text);
      if (inline) out.install = inline[1].trim();
    }

    var heads = [], hm;
    var hre = /^\s{0,3}#{2,3}\s+(.+?)\s*#*\s*$/gm;
    var skip = /^(license|licence|contributing|contributors|stars?|star history|acknowledge?ments?|sponsors?|citation|badges?|table of contents|содержание|лицензия)\b/i;
    while ((hm = hre.exec(text)) && heads.length < 6) {
      var h = hm[1].replace(/[`*_\[\]()#]/g, "").replace(/<[^>]+>/g, "").trim();
      h = h.replace(/^[\u{1F300}-\u{1FAFF}\u2600-\u27BF\uFE0F\s]+/u, "").trim();
      if (!h || h.length < 3 || h.length > 46) continue;
      if (skip.test(h)) continue;
      if (heads.indexOf(h) >= 0) continue;
      heads.push(h);
    }
    out.parts = heads.slice(0, 5);
    return out;
  }

  function factsHtml(f) {
    var rows = [];
    if (f.install) {
      rows.push('<dl class="news-why"><dt>Поставить себе</dt><dd><code>' + esc(f.install) + "</code></dd></dl>");
    }
    if (f.parts.length) {
      rows.push('<dl class="news-why"><dt>Что внутри</dt><dd>' +
        f.parts.map(function (p) { return esc(p); }).join(" · ") + "</dd></dl>");
    }
    if (f.stack.length) {
      rows.push('<dl class="news-why"><dt>На чём сделано</dt><dd>' +
        f.stack.map(function (p) { return esc(p); }).join(", ") + "</dd></dl>");
    }
    return rows.join("");
  }

  /* ---------- чтение материала ---------- */

  function radar() {
    return window.MONOLITH_RADAR && typeof window.MONOLITH_RADAR.read === "function"
      ? window.MONOLITH_RADAR : null;
  }

  function fetchText(url) {
    var R = radar();
    if (R) return R.read(url);

    var gh = ghSlug(url);
    if (gh) {
      return fetch("https://api.github.com/repos/" + gh.owner + "/" + gh.repo + "/readme",
        { headers: { Accept: "application/vnd.github.raw" } })
        .then(function (r) { if (!r.ok) throw new Error("gh " + r.status); return r.text(); })
        .then(function (t) { return { text: t, via: "README с GitHub", md: true }; });
    }
    return fetch("https://r.jina.ai/" + url.replace(/^https?:\/\//, ""))
      .then(function (r) { if (!r.ok) throw new Error("reader " + r.status); return r.text(); })
      .then(function (t) { return { text: t, via: "читалка r.jina.ai", md: true }; });
  }

  function toHtml(res) {
    var R = radar();
    if (R && typeof R.md === "function") return R.md(res.text);
    var safe = esc(res.text).slice(0, 20000);
    return "<p>" + safe.replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br/>") + "</p>";
  }

  /* «Похожее у тебя»: та же морфология и граф тегов, что в умном поиске. */
  function nearMine(it) {
    var R = window.MONOLITH_RADAR;
    if (!R || typeof R.searchLocal !== "function") return Promise.resolve([]);
    var start = R.db && R.db().ready ? Promise.resolve() :
      (typeof R.load === "function" ? Promise.resolve(R.load()) : Promise.resolve());
    var q = titleOf(it).replace(/[^0-9A-Za-zА-яа-я\s-]/g, " ").trim().slice(0, 60);
    return start.then(function () {
      var res = R.searchLocal(q);
      var hits = (res && res.all ? res.all : []).slice(0, 3);
      return hits.map(function (h) {
        var raw = h.rec && h.rec.raw ? h.rec.raw : {};
        return { title: raw.title || raw.url || "", url: raw.url || "" };
      }).filter(function (x) { return x.title && x.url; });
    }).catch(function () { return []; });
  }

  function openRead(card, it) {
    var host = card.querySelector("[data-readhost]");
    if (!host) return;
    var btn = card.querySelector("[data-read]");

    if (host.getAttribute("data-open") === "1") {
      host.innerHTML = "";
      host.removeAttribute("data-open");
      if (btn) btn.innerHTML = icon("book") + "Читать здесь";
      return;
    }

    host.setAttribute("data-open", "1");
    if (btn) btn.innerHTML = icon("up") + "Свернуть";
    host.innerHTML = '<div class="news-read"><div class="news-read-head">' +
      '<span class="news-read-src">грузим материал…</span></div>' +
      '<div class="news-skel"><i></i><i></i><i></i><i></i><i></i></div></div>';

    var key = it.url;
    var job = readCache[key] ? Promise.resolve(readCache[key]) :
      fetchText(it.url).then(function (res) { readCache[key] = res; return res; });

    job.then(function (res) {
      if (host.getAttribute("data-open") !== "1") return;
      var f = factsFrom(res.text || "");
      var body = toHtml(res);
      var long = (res.text || "").length > 2600;

      var pics = imgCache[key] || imagesFromText(res.text || "", it.url);
      imgCache[key] = pics;
      var gal = card.querySelector(".news-gal");
      if (gal && pics.length) addSlides(gal, pics);

      host.innerHTML = '<div class="news-read">' +
        '<div class="news-read-head">' +
          '<span class="news-read-src">' + icon("doc") + esc(res.via || "материал") + "</span>" +
          '<span class="news-read-src">' + esc(domainOf(it)) + "</span>" +
        "</div>" +
        factsHtml(f) +
        '<div class="news-read-body' + (long ? " news-read-fade" : "") + '" data-body>' + body + "</div>" +
        (long ? '<button type="button" class="news-btn news-btn-ghost" data-expand="1">Показать целиком</button>' : "") +
        '<div data-near></div>' +
      "</div>";

      nearMine(it).then(function (list) {
        var box = host.querySelector("[data-near]");
        if (!box || !list.length) return;
        box.innerHTML = '<div class="news-near"><span class="news-near-t">Похожее уже есть у тебя</span>' +
          '<div class="news-near-row">' + list.map(function (x) {
            return '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + icon("box") + esc(x.title) + "</a>";
          }).join("") + "</div></div>";
      });
    }).catch(function (err) {
      if (host.getAttribute("data-open") !== "1") return;
      host.innerHTML = '<div class="news-read"><div class="news-bad">Прочитать целиком не получилось: ' +
        esc(err && err.message ? err.message : "источник не ответил") +
        '. Открой оригинал — там точно есть.</div></div>';
    });
  }

  /* ---------- иконки (SVG, не эмодзи) ---------- */

  var ICONS = {
    book: '<path d="M4 5.5A1.5 1.5 0 015.5 4H10a2 2 0 012 2v12a2 2 0 00-2-2H4V5.5z"/><path d="M20 5.5A1.5 1.5 0 0018.5 4H14a2 2 0 00-2 2v12a2 2 0 012-2h6V5.5z"/>',
    up: '<path d="M6 15l6-6 6 6"/>',
    doc: '<path d="M14 3v5h5"/><path d="M19 8v11a2 2 0 01-2 2H7a2 2 0 01-2-2V5a2 2 0 012-2h7l5 5z"/>',
    box: '<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/>',
    add: '<path d="M12 5v14M5 12h14"/>',
    ok: '<path d="M20 6L9 17l-5-5"/>',
    link: '<path d="M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1"/><path d="M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1"/>',
    out: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4"/>',
    play: '<path d="M7 4.5l12 7.5-12 7.5v-15z"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>'
  };

  function icon(name) {
    return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICONS[name] || "") + "</svg>";
  }

  /* ---------- карточка ---------- */

  function knownHas(known, key) {
    if (!known || !key) return false;
    if (typeof known.has === "function") return known.has(key);
    if (Array.isArray(known)) return known.indexOf(key) >= 0;
    return !!known[key];
  }

  function cardHtml(it, i, known) {
    var tp = topicOf(it);
    var lead = leadOf(it);
    var key = txt(it.url_key) || txt(it.url);
    var added = knownHas(known, key);
    var when = whenOf(it);
    var dom = domainOf(it);
    var src = txt(it.source);
    var typeName = TYPE_LABEL[txt(it.type)] || "";
    var isNew = seenAt > 0 && stamp(it) > seenAt;

    var kick = ['<span class="news-topic"><i></i>' + esc(tp.name) + "</span>"];
    if (src) kick.push('<span class="news-sep"></span>' + esc(src));
    if (dom && dom !== src) kick.push('<span class="news-sep"></span>' + esc(dom));
    if (when) kick.push('<span class="news-sep"></span>' + esc(when));
    if (lead.text && !lead.ru) kick.push('<span class="news-en" title="Оригинал на английском">EN</span>');

    var why = asList(it.why_it_matters_ru);
    var uses = asList(it.use_cases_ru);
    var care = asList(it.caveats_ru);

    var extra = "";
    if (why.length) extra += '<dl class="news-why"><dt>Зачем тебе</dt><dd>' + esc(why.join(" · ")) + "</dd></dl>";
    if (uses.length) extra += '<dl class="news-why"><dt>Где пригодится</dt><dd>' + esc(uses.join(" · ")) + "</dd></dl>";
    if (care.length) extra += '<dl class="news-why"><dt>На что смотреть</dt><dd>' + esc(care.join(" · ")) + "</dd></dl>";

    var tags = [];
    if (typeName) tags.push('<span class="news-tag">' + esc(typeName) + "</span>");
    tags.push('<span class="news-tag">' + esc(tp.name) + "</span>");
    if (Number(it.source_count) > 1) tags.push('<span class="news-tag is-num">' + it.source_count + " источника</span>");
    var st = num(it.score);
    if (st) tags.push('<span class="news-tag is-num">' + esc(st) + " ★</span>");
    if (dom) tags.push('<span class="news-tag is-num">' + esc(dom) + "</span>");

    var cover = coverOf(it);
    var pics = imgCache[it.url] || (cover ? [cover] : []);
    if (cover && pics.indexOf(cover) < 0) pics = [cover].concat(pics);

    var q = Number(it.quality_score || 0);
    var metrics = [];
    if (q) metrics.push('<span class="news-q"><i></i>качество ' + q + "</span>");
    if (txt(it.translation_status) === "generated") metrics.push("перевод автоматический");

    return '<article class="news-card" style="--cat:' + esc(tp.color) + '" data-topic="' + esc(tp.id) +
      '" data-idx="' + i + '" data-url="' + esc(it.url) + '" data-key="' + esc(key) + '"' +
      (isNew ? ' data-new="1"' : "") + ">" +
      '<div class="news-kicker">' + kick.join("") + "</div>" +
      '<h3 class="news-title"><a href="' + esc(it.url) + '" target="_blank" rel="noopener">' + esc(titleOf(it)) + "</a></h3>" +
      (lead.text
        ? '<p class="news-lead' + (lead.ru ? "" : " is-dim") + '">' + esc(lead.text) + "</p>"
        : '<p class="news-lead is-dim">Описание у источника пустое. Нажми «Читать здесь» — подтяну текст из самого материала.</p>') +
      extra +
      '<div class="news-tags">' + tags.join("") + "</div>" +
      galHtml(it, pics) +
      '<div class="news-foot">' +
        '<div class="news-metrics">' + (metrics.join('<span class="news-sep"></span>') || "&nbsp;") + "</div>" +
        '<div class="news-actions">' +
          '<button type="button" class="news-btn news-btn-key" data-read="1">' + icon("book") + "Читать здесь</button>" +
          (added
            ? '<span class="news-btn is-done">' + icon("ok") + "Уже в хранилище</span>"
            : '<button type="button" class="news-btn" data-feed-add="' + esc(key) + '">' + icon("add") + "Забрать себе</button>") +
          '<button type="button" class="news-btn news-btn-ghost" data-feed-copy="' + esc(key) + '">' + icon("link") + "Ссылка</button>" +
          '<a class="news-btn news-btn-ghost" href="' + esc(it.url) + '" target="_blank" rel="noopener">' + icon("out") + "Оригинал</a>" +
        "</div>" +
      "</div>" +
      '<div data-readhost></div>' +
      "</article>";
  }

  /* ---------- фильтры ---------- */

  function parseFilter(f) {
    var s = txt(f).toLowerCase();
    if (!s || s === "all" || s === "*" || s === "все" || s === "всё") return { kind: "all", value: "" };
    if (s.indexOf("topic:") === 0) return { kind: "topic", value: txt(f).slice(6) };
    if (s.indexOf("src:") === 0) return { kind: "src", value: txt(f).slice(4) };
    return { kind: "src", value: txt(f) };
  }

  function matchQuery(it, q) {
    if (!q) return true;
    var hay = [it.title, it.title_ru, it.description, it.description_ru, it.summary_ru,
      it.source, it.domain, it.topic_name, it.category, it.url].join(" ").toLowerCase();
    return q.split(/\s+/).every(function (w) { return hay.indexOf(w) >= 0; });
  }

  function renderFilters(items, pf) {
    var box = document.getElementById("feedChips");
    if (!box) return;
    var topics = box.querySelector('[data-role="topics"]');
    var sources = box.querySelector('[data-role="sources"]');

    if (topics) {
      var counts = {}, order = [];
      items.forEach(function (it) {
        var t = topicOf(it);
        if (!counts[t.id]) { counts[t.id] = { t: t, n: 0 }; order.push(t.id); }
        counts[t.id].n++;
      });
      order.sort(function (a, b) { return counts[b].n - counts[a].n; });
      var html = '<button type="button" class="chip' + (pf.kind === "all" ? " is-on" : "") +
        '" data-value="" aria-pressed="' + (pf.kind === "all") + '">Всё <span class="chip-num">' + items.length + "</span></button>";
      order.forEach(function (id) {
        var c = counts[id];
        var on = pf.kind === "topic" && pf.value === id;
        html += '<button type="button" class="chip' + (on ? " is-on" : "") + '" style="--cat:' + esc(c.t.color) +
          '" data-value="topic:' + esc(id) + '" aria-pressed="' + on + '">' +
          '<span class="chip-dot"></span>' + esc(c.t.name) + ' <span class="chip-num">' + c.n + "</span></button>";
      });
      topics.innerHTML = html;
    }

    if (sources) {
      var sc = {}, so = [];
      items.forEach(function (it) {
        var s = txt(it.source) || "без источника";
        if (!sc[s]) { sc[s] = 0; so.push(s); }
        sc[s]++;
      });
      so.sort(function (a, b) { return sc[b] - sc[a]; });
      var h2 = '<button type="button" class="chip' + (pf.kind !== "src" ? " is-on" : "") +
        '" data-value="">Все источники<b>' + items.length + "</b></button>";
      so.forEach(function (s) {
        var on = pf.kind === "src" && pf.value === s;
        h2 += '<button type="button" class="chip' + (on ? " is-on" : "") + '" data-value="src:' + esc(s) + '">' +
          esc(s) + "<b>" + sc[s] + "</b></button>";
      });
      sources.innerHTML = h2;
    }

    var sortBox = box.querySelector(".news-sort");
    if (sortBox) {
      sortBox.querySelectorAll("[data-sort]").forEach(function (b) {
        b.setAttribute("aria-pressed", String(b.getAttribute("data-sort") === sortMode));
      });
    }
  }

  /* ---------- появление карточек ---------- */

  function observe(list) {
    var cs = list.querySelectorAll(".news-card");
    /* В шортсах карточки по устройству режима лежат вне экрана, поэтому
       наблюдатель никогда бы их не показал. */
    if (shorts || !("IntersectionObserver" in window)) {
      cs.forEach(function (c) { c.classList.add("in"); });
      return;
    }
    if (io) io.disconnect();
    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add("in");
          io.unobserve(en.target);
        }
      });
    }, { rootMargin: "0px 0px -5% 0px", threshold: 0.06 });

    cs.forEach(function (c, i) {
      if (i < 3) c.classList.add("in");
      else io.observe(c);
    });
  }

  /* ---------- режим «Шортсы» ---------- */

  function shSlides() {
    var list = document.getElementById("feedList");
    if (!list) return [];
    return Array.prototype.filter.call(list.children, function (el) {
      return el.classList && el.classList.contains("news-card");
    });
  }

  function buildChrome() {
    if (shChrome && shChrome.isConnected) return shChrome;
    shChrome = document.createElement("div");
    shChrome.className = "sh-chrome";
    shChrome.innerHTML =
      '<div class="sh-top">' +
        '<button type="button" class="sh-exit" data-sh-exit aria-label="Выйти из шортсов">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
          ICONS.close + "</svg></button>" +
        '<span class="sh-num" data-sh-num aria-live="polite">1 / 1</span>' +
      "</div>" +
      '<div class="sh-rail"><i data-sh-rail></i></div>' +
      '<div class="sh-hint">колесо · стрелки · свайп — одна карточка за раз · Esc — выход</div>';
    document.body.appendChild(shChrome);
    shChrome.addEventListener("click", function (e) {
      if (e.target.closest("[data-sh-exit]")) setShorts(false);
    });
    return shChrome;
  }

  function paintShorts() {
    var cs = shSlides();
    var n = cs.length;
    if (!n) return;
    if (curIdx > n - 1) curIdx = n - 1;
    if (curIdx < 0) curIdx = 0;

    cs.forEach(function (c, k) {
      c.classList.add("in");
      c.classList.toggle("is-cur", k === curIdx);
      c.classList.toggle("is-prev", k < curIdx);
      if (k !== curIdx && c.scrollTop) c.scrollTop = 0;
    });

    var ch = buildChrome();
    var numEl = ch.querySelector("[data-sh-num]");
    if (numEl) numEl.textContent = (curIdx + 1) + " / " + n;
    var rail = ch.querySelector("[data-sh-rail]");
    if (rail) rail.style.height = Math.round(((curIdx + 1) / n) * 100) + "%";

    selIdx = curIdx;
  }

  function go(dir) {
    var cs = shSlides();
    if (!cs.length) return;
    var next = curIdx + dir;

    if (next < 0) { curIdx = 0; paintShorts(); return; }

    if (next > cs.length - 1) {
      /* дошли до конца порции — тихо подгружаем следующую */
      var before = cs.length;
      if (lastCtx) {
        shownCount += PAGE;
        render(lastCtx);
        if (shSlides().length > before) { curIdx = before; paintShorts(); }
      }
      return;
    }

    curIdx = next;
    paintShorts();
  }

  function setShorts(on) {
    shorts = !!on;
    try { localStorage.setItem(SHORTS_KEY, shorts ? "1" : "0"); } catch (e) {}
    if (shorts && curIdx < 0) curIdx = 0;
    applyShorts();
    if (!shorts) {
      var list = document.getElementById("feedList");
      if (list) observe(list);
    }
  }

  function applyShorts() {
    var list = document.getElementById("feedList");
    if (!list) return;
    var root = document.documentElement;
    var ch = buildChrome();
    var can = shorts && feedVisible() && shSlides().length > 0;

    if (can) {
      list.classList.add("is-shorts");
      ch.classList.add("on");
      root.classList.add("is-shorts");
      document.body.classList.add("is-shorts");
      bindShorts(list);
      paintShorts();
    } else {
      list.classList.remove("is-shorts");
      ch.classList.remove("on");
      root.classList.remove("is-shorts");
      document.body.classList.remove("is-shorts");
      shSlides().forEach(function (c) {
        c.classList.remove("is-cur");
        c.classList.remove("is-prev");
      });
    }

    var btn = document.querySelector("[data-shorts-toggle]");
    if (btn) btn.setAttribute("aria-pressed", String(shorts));
  }

  /* Край карточки: длинный материал сначала дочитывается внутри и только на
     краю жест перелистывает на следующую. */
  function atEdge(card, dir) {
    if (!card) return true;
    if (card.scrollHeight - card.clientHeight <= 24) return true;
    if (dir > 0) return card.scrollTop + card.clientHeight >= card.scrollHeight - 2;
    return card.scrollTop <= 2;
  }

  function bindShorts(list) {
    if (shBound) return;
    shBound = true;

    /* Колесо: один жест — одна карточка. Обычной прокрутки страницы нет. */
    list.addEventListener("wheel", function (e) {
      if (!shorts) return;
      e.preventDefault();
      var d = e.deltaY;
      if (Math.abs(d) < 4) return;
      var cur = shSlides()[curIdx];
      if (!atEdge(cur, d)) { cur.scrollTop += d; return; }
      var now = Date.now();
      if (now - lastFlip < 560) return;
      lastFlip = now;
      go(d > 0 ? 1 : -1);
    }, { passive: false });

    /* Свайп пальцем — тот же шаг в одну карточку. */
    var ty = 0, tt = 0;
    list.addEventListener("touchstart", function (e) {
      if (!shorts || !e.touches[0]) return;
      ty = e.touches[0].clientY;
      tt = Date.now();
    }, { passive: true });
    list.addEventListener("touchend", function (e) {
      if (!shorts || !e.changedTouches[0]) return;
      var dy = ty - e.changedTouches[0].clientY;
      if (Date.now() - tt > 900 || Math.abs(dy) < 48) return;
      var cur = shSlides()[curIdx];
      if (!atEdge(cur, dy)) return;
      var now = Date.now();
      if (now - lastFlip < 400) return;
      lastFlip = now;
      go(dy > 0 ? 1 : -1);
    }, { passive: true });
  }

  function bindMode() {
    if (modeBound) return;
    modeBound = true;
    document.addEventListener("click", function (e) {
      var b = e.target.closest("[data-shorts-toggle]");
      if (!b) return;
      e.preventDefault();
      setShorts(!shorts);
    });
  }

  /* Ушли с вкладки «Новости» — фиксированный слой обязан исчезнуть. */
  function watchWrap() {
    var w = document.getElementById("feedWrap");
    if (!w || w.__shWatch || !("MutationObserver" in window)) return;
    w.__shWatch = true;
    new MutationObserver(function () { applyShorts(); })
      .observe(w, { attributes: true, attributeFilter: ["hidden"] });
  }

  /* ---------- клавиши, выделение, клики ---------- */

  function feedVisible() {
    var w = document.getElementById("feedWrap");
    return !!w && !w.hidden;
  }

  function busy() {
    var a = document.activeElement;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) return true;
    if (document.querySelector("dialog[open]")) return true;
    var r = document.getElementById("radar");
    if (r && !r.hidden) return true;
    return false;
  }

  function cards() { return document.querySelectorAll("#feedList .news-card"); }

  function select(i, scroll) {
    var cs = cards();
    if (!cs.length) return;
    if (i < 0) i = 0;
    if (i > cs.length - 1) i = cs.length - 1;
    cs.forEach(function (c, k) { c.classList.toggle("is-sel", k === i); });
    selIdx = i;
    if (scroll !== false && !shorts) {
      window.scrollTo({
        top: cs[i].getBoundingClientRect().top + window.scrollY - 118,
        behavior: "smooth"
      });
    }
  }

  function itemOf(card) {
    var i = Number(card.getAttribute("data-idx"));
    var arr = (lastCtx && lastCtx.__rows) || [];
    return arr[i] || { url: card.getAttribute("data-url") };
  }

  function bindKeys() {
    if (keysBound) return;
    keysBound = true;
    document.addEventListener("keydown", function (e) {
      if (!feedVisible() || busy()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var k = e.key;

      if (shorts) {
        if (k === "Escape") { e.preventDefault(); setShorts(false); return; }
        if (k === "ArrowDown" || k === "PageDown" || k === " " || k === "Spacebar" || k === "j" || k === "о") {
          e.preventDefault(); go(1); return;
        }
        if (k === "ArrowUp" || k === "PageUp" || k === "k" || k === "л") {
          e.preventDefault(); go(-1); return;
        }
      } else {
        if (k === "j" || k === "о") { e.preventDefault(); select(selIdx + 1); return; }
        if (k === "k" || k === "л") { e.preventDefault(); select(selIdx - 1); return; }
      }

      var cur = cards()[selIdx < 0 ? 0 : selIdx];
      if (!cur) return;

      if (k === "ArrowLeft" || k === "ArrowRight") {
        var gal = cur.querySelector(".news-gal");
        if (gal && gal.__go) { e.preventDefault(); gal.__go(k === "ArrowLeft" ? -1 : 1); }
        return;
      }
      if (k === "r" || k === "к") { e.preventDefault(); openRead(cur, itemOf(cur)); return; }
      if (k === "o" || k === "щ") {
        var u = cur.getAttribute("data-url");
        if (u) { e.preventDefault(); window.open(u, "_blank", "noopener"); }
      }
    });
  }

  function wireList(list) {
    if (list.__wired) return;
    list.__wired = true;

    list.addEventListener("click", function (e) {
      var card = e.target.closest(".news-card");

      if (card && e.target.closest("[data-read]")) {
        e.preventDefault();
        openRead(card, itemOf(card));
        return;
      }

      var exp = e.target.closest("[data-expand]");
      if (card && exp) {
        e.preventDefault();
        var body = card.querySelector("[data-body]");
        if (body) body.classList.remove("news-read-fade");
        exp.remove();
        return;
      }

      var more = e.target.closest("[data-more]");
      if (card && more) {
        e.preventDefault();
        var it = itemOf(card);
        var gal = card.querySelector(".news-gal");
        more.disabled = true;
        more.textContent = "ищу картинки…";
        var key = it.url;
        var job = readCache[key] ? Promise.resolve(readCache[key]) :
          fetchText(it.url).then(function (res) { readCache[key] = res; return res; });
        job.then(function (res) {
          var pics = imagesFromText(res.text || "", it.url);
          imgCache[key] = pics;
          var n = addSlides(gal, pics);
          more.disabled = false;
          more.textContent = n ? "Ещё из материала" : "Больше картинок нет";
        }).catch(function () {
          more.disabled = false;
          more.textContent = "Источник не ответил";
        });
        return;
      }

      if (e.target.closest("[data-more-cards]")) {
        e.preventDefault();
        shownCount += PAGE;
        if (lastCtx) render(lastCtx);
        return;
      }

      if (e.target.closest("[data-news-reset]")) {
        e.preventDefault();
        var all = document.querySelector('#feedChips [data-value=""]');
        if (all) all.click();
        return;
      }

      if (card && !e.target.closest("a") && !e.target.closest("button")) {
        select(Number(card.getAttribute("data-idx")), false);
      }
    });
  }

  function wireTop() {
    var box = document.getElementById("feedChips");
    if (!box || box.__wiredSort) return;
    box.__wiredSort = true;
    box.addEventListener("click", function (e) {
      var b = e.target.closest("[data-sort]");
      if (!b) return;
      e.preventDefault();
      sortMode = b.getAttribute("data-sort") === "new" ? "new" : "hot";
      try { localStorage.setItem(SORT_KEY, sortMode); } catch (err) {}
      shownCount = PAGE;
      curIdx = 0;
      if (lastCtx) render(lastCtx);
    });
  }

  /* ---------- сборка ---------- */

  function render(ctx) {
    ctx = ctx || {};
    lastCtx = ctx;
    injectCss();
    stickTop();

    var list = document.getElementById("feedList");
    if (!list) return;
    var empty = document.getElementById("feedEmpty");
    var meta = document.getElementById("feedMeta");
    var badge = document.getElementById("feedBadge");

    var all = Array.isArray(ctx.items) ? ctx.items.slice() : [];
    var known = ctx.known;
    var pf = parseFilter(ctx.filter);
    var q = txt(ctx.query).toLowerCase();

    renderFilters(all, pf);

    var rows = all.filter(function (it) {
      if (!txt(it.url)) return false;
      if (pf.kind === "topic" && topicOf(it).id !== pf.value) return false;
      if (pf.kind === "src" && txt(it.source) !== pf.value) return false;
      return matchQuery(it, q);
    });

    rows.sort(function (a, b) {
      if (sortMode === "new") return stamp(b) - stamp(a);
      var qa = Number(a.quality_score || 0), qb = Number(b.quality_score || 0);
      if (qb !== qa) return qb - qa;
      return stamp(b) - stamp(a);
    });

    /* Сменился фильтр или сортировка — начинаем ленту заново. */
    var key = pf.kind + "|" + pf.value + "|" + q + "|" + sortMode;
    if (render.__key !== key) {
      render.__key = key;
      shownCount = PAGE;
      curIdx = 0;
    }

    var shown = rows.slice(0, shownCount);
    ctx.__rows = shown;

    if (badge) badge.textContent = all.length ? String(all.length) : "";

    var fresh = all.filter(function (it) { return seenAt > 0 && stamp(it) > seenAt; }).length;
    var upd = txt(ctx.updatedAt);
    var pct = rows.length ? Math.round((shown.length / rows.length) * 100) : 0;

    if (meta) {
      meta.innerHTML =
        '<div class="nm-row">' +
          (fresh ? '<span class="nm-fresh"><i></i>' + fresh + " новых с твоего захода</span>" : "") +
          '<span class="nm-count">' + shown.length + " из " + rows.length + "</span>" +
          '<span class="nm-gap"></span>' +
          (upd ? '<span class="nm-upd">обновлено ' + esc(upd) + "</span>" : "") +
          '<button type="button" class="nm-mode" data-shorts-toggle aria-pressed="' + shorts + '">' +
            icon("play") + "Шортсы</button>" +
        "</div>" +
        '<div class="nm-bar"><i style="width:' + pct + '%"></i></div>';
    }

    bindMode();
    watchWrap();

    if (!rows.length) {
      list.innerHTML = "";
      if (empty) empty.hidden = false;
      applyShorts();
      return;
    }
    if (empty) empty.hidden = true;

    var html = shown.map(function (it, i) { return cardHtml(it, i, known); }).join("");
    if (shown.length < rows.length) {
      html += '<div class="news-note"><button type="button" class="news-btn" data-more-cards="1">Показать ещё ' +
        Math.min(PAGE, rows.length - shown.length) + "</button></div>";
    }
    list.innerHTML = html;

    list.querySelectorAll(".news-gal").forEach(wireGal);
    observe(list);
    wireList(list);
    wireTop();
    bindKeys();
    selIdx = -1;
    applyShorts();

    if (!render.__stamped) {
      render.__stamped = true;
      try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch (e) {}
    }
  }

  /* ---------- старт ---------- */

  injectCss();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", stickTop);
  } else {
    stickTop();
  }
  var rt = 0;
  window.addEventListener("resize", function () {
    if (rt) return;
    rt = requestAnimationFrame(function () { rt = 0; stickTop(); });
  });

  window.MONOLITH_NEWS = {
    render: render,
    topics: TOPICS,
    facts: factsFrom,
    images: imagesFromText,
    shorts: setShorts
  };
})();
