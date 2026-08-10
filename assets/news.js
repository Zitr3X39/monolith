/* MONOLITH v14.2 — рендер раздела «Новости».

   Контракт с app.js (не ломать):
     window.MONOLITH_NEWS.render({ items, updatedAt, filter, query, known })
     кнопки отдают data-feed-add="<url_key>" / data-feed-copy="<url_key>"
     чипы — .chip с data-value, клик ловит делегация на #feedChips

   Фильтр приходит одной строкой (state.feedSrc), поэтому кодируем тип:
     ""                    — всё
     "topic:ai-agents"     — по теме
     "src:GitHub Trending" — по источнику
   Старые значения без префикса трактуются как источник (совместимость с URL v14.1).

   Варианты компоновки для выбора: ?variant=A|B|C
     A — текст сверху, медиа под заголовком (по умолчанию)
     B — медиа справа узкой колонкой
     C — плотный список без медиа */
(function () {
  "use strict";

  var MAX_VISIBLE = 40;

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

  /* §10.2: скриншотные прокси дают «Generating Preview…» вместо картинки */
  function badImage(u) {
    if (!u) return true;
    return /mshots|screenshot(api|machine)|thum\.io|image\.thum/i.test(u);
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
    return OTHER;
  }

  function titleOf(it) {
    var t = txt(it.title_ru);
    if (t && !junk(t)) return t;
    return txt(it.title) || txt(it.domain) || "Без названия";
  }

  /* Сначала разбор, потом перевод, потом оригинал. Если русского нет —
     помечаем карточку как оригинал EN, а не выбрасываем: 13 из 35
     записей пока без перевода (meta.ai = 0). */
  function summaryOf(it) {
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

  function whenOf(it) {
    var raw = txt(it.published_at) || txt(it.found_at);
    if (!raw) return "";
    var d = new Date(raw);
    if (isNaN(d.getTime())) return "";
    var diff = (Date.now() - d.getTime()) / 36e5;
    if (diff < 0) return "";
    if (diff < 1) return "только что";
    if (diff < 24) return Math.round(diff) + " ч назад";
    var days = Math.round(diff / 24);
    if (days === 1) return "вчера";
    if (days < 7) return days + " дн назад";
    try {
      return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(d);
    } catch (e) { return ""; }
  }

  /* ---------- блоки карточки ---------- */

  function coverHtml(it) {
    var img = txt(it.image);
    var dom = domainOf(it);
    var letter = esc((dom.charAt(0) || "M").toUpperCase());
    var inner = badImage(img)
      ? '<span class="news-letter" aria-hidden="true">' + letter + "</span>"
      : '<img src="' + esc(img) + '" alt="" loading="lazy" decoding="async" onerror="this.remove()" />';
    return '<a class="news-cover" href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer" ' +
      'tabindex="-1" aria-hidden="true">' + inner +
      '<span class="news-domain">' + esc(dom) + "</span></a>";
  }

  function moreHtml(it) {
    var why = txt(it.why_it_matters_ru);
    if (junk(why)) why = "";
    var uses = asList(it.use_cases_ru);
    var caveats = asList(it.caveats_ru);
    if (!why && !uses.length && !caveats.length) return "";

    var parts = "";
    if (why) {
      parts += '<div><p class="news-sub">Зачем это тебе</p><p>' + esc(why) + "</p></div>";
    }
    if (uses.length) {
      parts += '<div><p class="news-sub">Как применить</p><ul class="news-list">' +
        uses.map(function (u) { return "<li>" + esc(u) + "</li>"; }).join("") + "</ul></div>";
    }
    if (caveats.length) {
      parts += '<div><p class="news-sub">На что смотреть</p><ul class="news-list is-warn">' +
        caveats.map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("") + "</ul></div>";
    }
    return '<details class="news-more"><summary>Разбор</summary>' +
      '<div class="news-more-in">' + parts + "</div></details>";
  }

  function cardHtml(it, isKnown, variant) {
    var tp = topicOf(it);
    var sum = summaryOf(it);
    var key = esc(it.url_key);
    var when = whenOf(it);
    var src = txt(it.source);
    var extra = Number(it.source_count || 0) > 1 ? " +" + (Number(it.source_count) - 1) : "";

    var kicker = '<div class="news-kicker">' +
      '<span class="news-topic">' + esc(tp.name) + "</span>" +
      (src ? '<i class="news-sep"></i><span>' + esc(src + extra) + "</span>" : "") +
      (when ? '<i class="news-sep"></i><span>' + esc(when) + "</span>" : "") +
      (sum.ru ? "" : '<i class="news-sep"></i><span>оригинал EN</span>') +
      "</div>";

    var title = '<h3 class="news-title"><a href="' + esc(it.url) +
      '" target="_blank" rel="noopener noreferrer">' + esc(titleOf(it)) + "</a></h3>";

    var summary = sum.text
      ? '<p class="news-summary' + (sum.ru ? "" : " is-dim") + '">' + esc(sum.text) + "</p>"
      : "";

    var addBtn = isKnown
      ? '<span class="btn is-done">В хранилище ✓</span>'
      : '<button type="button" class="btn btn-primary" data-feed-add="' + key + '">В хранилище</button>';

    var foot = '<div class="news-foot">' +
      '<div class="news-metrics">' +
        (Number(it.score) ? '<span class="news-q"><i></i>' + esc(String(Math.round(Number(it.score)))) + "</span>" : "") +
      "</div>" +
      '<div class="news-actions">' +
        '<button type="button" class="btn" data-feed-copy="' + key + '">Ссылка</button>' +
        addBtn +
      "</div></div>";

    var cover = variant === "C" ? "" : coverHtml(it);
    var body = kicker + title + summary;

    var inner = variant === "B"
      ? '<div class="news-body">' + body + "</div>" + cover + moreHtml(it) + foot
      : body + cover + moreHtml(it) + foot;

    return '<article class="news-card rv" style="--cat:' + tp.color +
      '" data-topic="' + esc(tp.id) + '">' + inner + "</article>";
  }

  /* ---------- фильтры ---------- */

  function parseFilter(f) {
    f = txt(f);
    /* app.js инициализирует state.feedSrc значением "all", а не пустой строкой —
       без этой ветки лента при первом открытии была бы пустой. */
    if (!f || f === "all" || f === "*" || f === "все" || f === "всё") return { kind: "all", value: "" };
    if (f.indexOf("topic:") === 0) return { kind: "topic", value: f.slice(6) };
    if (f.indexOf("src:") === 0) return { kind: "src", value: f.slice(4) };
    return { kind: "src", value: f };
  }

  function renderFilters(box, items, f) {
    if (!box) return;
    var topicsBox = box.querySelector('[data-role="topics"]');
    var srcBox = box.querySelector('[data-role="sources"]');

    if (topicsBox) {
      var counts = {};
      items.forEach(function (it) {
        var id = topicOf(it).id;
        counts[id] = (counts[id] || 0) + 1;
      });
      var html = '<button type="button" class="chip' + (f.kind === "all" ? " is-on" : "") +
        '" data-value="">Всё<span class="chip-num">' + items.length + "</span></button>";
      TOPICS.concat([OTHER]).forEach(function (t) {
        var n = counts[t.id] || 0;
        if (!n) return;
        var on = f.kind === "topic" && f.value === t.id;
        html += '<button type="button" class="chip' + (on ? " is-on" : "") +
          '" data-value="topic:' + esc(t.id) + '" data-topic-chip="' + esc(t.id) +
          '" style="--cat:' + t.color + '">' + esc(t.name) +
          '<span class="chip-num">' + n + "</span></button>";
      });
      topicsBox.innerHTML = html;
    }

    if (srcBox) {
      var srcs = {};
      items.forEach(function (it) {
        var s = txt(it.source);
        if (s) srcs[s] = (srcs[s] || 0) + 1;
      });
      var keys = Object.keys(srcs).sort(function (a, b) { return srcs[b] - srcs[a]; });
      srcBox.innerHTML = keys.map(function (s) {
        var on = f.kind === "src" && f.value === s;
        return '<button type="button" class="chip' + (on ? " is-on" : "") +
          '" data-value="src:' + esc(s) + '">' + esc(s) + " · " + srcs[s] + "</button>";
      }).join("");
    }
  }

  /* ---------- reveal ---------- */

  var io = null;
  function observe(list) {
    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var cards = list.querySelectorAll(".news-card");
    if (reduce || !("IntersectionObserver" in window)) {
      Array.prototype.forEach.call(cards, function (c) { c.classList.add("in"); });
      return;
    }
    if (io) io.disconnect();
    io = new IntersectionObserver(function (rows) {
      rows.forEach(function (r) {
        if (r.isIntersecting) { r.target.classList.add("in"); io.unobserve(r.target); }
      });
    }, { rootMargin: "0px 0px -6% 0px", threshold: 0.08 });
    Array.prototype.forEach.call(cards, function (c, i) {
      if (i < 4) c.classList.add("in"); else io.observe(c);
    });
  }

  /* J / K — листание по карточкам естественным скроллом документа */
  var keysBound = false;
  function bindKeys() {
    if (keysBound) return;
    keysBound = true;
    document.addEventListener("keydown", function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var k = (e.key || "").toLowerCase();
      if (k !== "j" && k !== "k") return;
      var t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      var wrap = document.getElementById("feedWrap");
      if (!wrap || wrap.hidden) return;
      var cards = document.querySelectorAll("#feedList .news-card");
      if (!cards.length) return;
      e.preventDefault();
      var top = 110, next = -1;
      for (var i = 0; i < cards.length; i++) {
        if (cards[i].getBoundingClientRect().top > top + 4) { next = i; break; }
      }
      var idx = k === "j"
        ? (next === -1 ? cards.length - 1 : next)
        : (next === -1 ? cards.length : next) - 2;
      if (idx < 0) idx = 0;
      if (idx > cards.length - 1) idx = cards.length - 1;
      var y = cards[idx].getBoundingClientRect().top + window.pageYOffset - top;
      window.scrollTo({ top: y, behavior: "smooth" });
    });
  }

  /* ---------- главный рендер ---------- */

  function variantNow() {
    var v = "";
    try { v = (new URLSearchParams(location.search).get("variant") || "").toUpperCase(); } catch (e) {}
    return v === "B" || v === "C" ? v : "A";
  }

  function render(ctx) {
    ctx = ctx || {};
    var list = document.getElementById("feedList");
    if (!list) return;
    var meta = document.getElementById("feedMeta");
    var empty = document.getElementById("feedEmpty");
    var badge = document.getElementById("feedBadge");
    var chips = document.getElementById("feedChips");

    var known = ctx.known || {};
    var variant = variantNow();
    list.dataset.variant = variant;

    var all = (Array.isArray(ctx.items) ? ctx.items : []).filter(function (it) {
      return it && txt(it.url) && !junk(titleOf(it));
    });

    var f = parseFilter(ctx.filter);

    /* Защита от фильтра, которого нет в данных (старые ссылки, смена схемы
       источников): показать всё, а не пустой экран. */
    if (f.kind === "src" && !all.some(function (it) { return txt(it.source) === f.value; })) {
      f = { kind: "all", value: "" };
    }
    if (f.kind === "topic" && !all.some(function (it) { return topicOf(it).id === f.value; })) {
      f = { kind: "all", value: "" };
    }

    renderFilters(chips, all, f);

    var rows = all.filter(function (it) {
      if (f.kind === "topic" && topicOf(it).id !== f.value) return false;
      if (f.kind === "src" && txt(it.source) !== f.value) return false;
      return true;
    });

    var q = txt(ctx.query).toLowerCase();
    if (q) {
      rows = rows.filter(function (it) {
        var hay = [titleOf(it), summaryOf(it).text, it.source, it.domain, topicOf(it).name]
          .join(" ").toLowerCase();
        return hay.indexOf(q) !== -1;
      });
    }

    rows.sort(function (a, b) { return Number(b.score || 0) - Number(a.score || 0); });
    var shown = rows.slice(0, MAX_VISIBLE);

    if (meta) {
      var when = "";
      if (ctx.updatedAt) {
        var d = new Date(ctx.updatedAt);
        if (!isNaN(d.getTime())) {
          try {
            when = new Intl.DateTimeFormat("ru-RU", {
              day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
            }).format(d);
          } catch (e) {}
        }
      }
      meta.textContent = shown.length + " из " + all.length + (when ? " · обновлено " + when : "");
    }

    if (badge) {
      var fresh = all.filter(function (it) { return !known[it.url_key]; }).length;
      badge.textContent = String(fresh);
      badge.hidden = fresh === 0;
    }

    if (!all.length) {
      list.innerHTML = "";
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    if (!shown.length) {
      list.innerHTML = '<p class="news-note">Ничего не нашлось по этому фильтру.<br>' +
        '<button type="button" class="btn" data-news-reset>Показать всё</button></p>';
      var reset = list.querySelector("[data-news-reset]");
      if (reset) reset.addEventListener("click", function () {
        var b = chips && chips.querySelector('.chip[data-value=""]');
        if (b) b.click();
      });
      return;
    }

    list.innerHTML = shown.map(function (it) {
      return cardHtml(it, !!known[it.url_key], variant);
    }).join("");

    observe(list);
    bindKeys();
  }

  window.MONOLITH_NEWS = { render: render, topics: TOPICS };
})();
