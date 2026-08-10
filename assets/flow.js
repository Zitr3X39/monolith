/* MONOLITH v14.5 — Signal Flow.

   Надстройка поверх готовых движков (news.js и search.js не трогаем):

     1. Большое описание само появляется в карточке: когда карточка доходит
        до экрана, тянем текст из самого материала и кладём рядом с картинкой.
        Ничего не придумываем — только реальный текст источника.
     2. Шапка ленты сжимается при прокрутке и показывает полоску прогресса.
     3. Очередь «Потом»: кнопка в каждой карточке, счётчик и панель.
     4. Утренний брифинг над лентой — собран из реальных чисел ленты.
     5. Режим чтения (V) и очередь (Q) с клавиатуры.
     6. Офлайн: service worker кеширует оболочку и данные.
     7. Переход между разделами — плавный (View Transitions, где есть). */
(function () {
  "use strict";

  var QKEY = "monolith.queue.v1";
  var AKEY = "monolith.about.v1";
  var BKEY = "monolith.brief.hidden";
  var ABOUT_MAX = 1100;      /* сколько символов описания тянем в карточку */
  var ABOUT_PAR = 4;         /* максимум абзацев */
  var PARALLEL = 2;          /* сколько материалов тянем одновременно */

  var aboutCache = {};
  var aboutQueue = [];
  var aboutBusy = 0;
  var io = null;
  var focusOn = false;

  /* ---------- мелкие помощники ---------- */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function ls(k, def) {
    try {
      var v = localStorage.getItem(k);
      return v == null ? def : JSON.parse(v);
    } catch (e) { return def; }
  }

  function save(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }

  function ss(k, def) {
    try {
      var v = sessionStorage.getItem(k);
      return v == null ? def : JSON.parse(v);
    } catch (e) { return def; }
  }

  function ssSave(k, v) {
    try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }

  function toast(msg) {
    var t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    t.classList.add("is-on");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      t.classList.remove("is-on");
      t.hidden = true;
    }, 2600);
  }

  function radar() { return window.MONOLITH_RADAR || null; }

  function feedOpen() {
    var w = document.getElementById("feedWrap");
    return !!(w && !w.hidden);
  }

  function cards() {
    return Array.prototype.slice.call(document.querySelectorAll("#feedList .news-card"));
  }

  function urlOf(card) {
    return card ? (card.getAttribute("data-url") || "") : "";
  }

  function titleOf(card) {
    var t = card && card.querySelector(".news-title");
    return t ? t.textContent.trim() : "";
  }

  /* =======================================================
     1. БОЛЬШОЕ ОПИСАНИЕ
     Текст берём тем же движком, что и читалка — README с GitHub
     или статью через читалку. Ничего не выдумываем.
     ======================================================= */

  function looksJunk(s) {
    if (!s) return true;
    var t = s.trim();
    if (t.length < 40) return true;
    if (/^\s*(table of contents|contents|license|installation|install|usage|contributing|badges?)\s*$/i.test(t)) return true;
    if (/^[\W_]+$/.test(t)) return true;
    if ((t.match(/\|/g) || []).length > 4) return true;          /* обломки таблиц */
    if (/^https?:\/\/\S+$/i.test(t)) return true;
    if (/npm install|pip install|yarn add|git clone/i.test(t) && t.length < 90) return true;
    return false;
  }

  function paragraphsFrom(html) {
    var box = document.createElement("div");
    box.innerHTML = html || "";
    var out = [];
    var nodes = box.querySelectorAll("p, li, blockquote");
    var total = 0;
    for (var i = 0; i < nodes.length && out.length < ABOUT_PAR && total < ABOUT_MAX; i++) {
      var txt = (nodes[i].textContent || "").replace(/\s+/g, " ").trim();
      if (looksJunk(txt)) continue;
      if (out.indexOf(txt) !== -1) continue;
      if (txt.length > 420) txt = txt.slice(0, 400).replace(/[\s,;:.—-]+\S*$/, "") + "…";
      out.push(txt);
      total += txt.length;
    }
    return out;
  }

  function aboutHtml(parts, via, more) {
    var body = parts.map(function (p) { return "<p>" + esc(p) + "</p>"; }).join("");
    return '<p class="nc-about-h">о чём это' + (via ? " · " + esc(via) : "") + "</p>" +
      '<div class="nc-about-body">' + body + "</div>" +
      (more ? '<button type="button" class="nc-about-more">Показать целиком →</button>' : "");
  }

  function mountAbout(card) {
    if (!card || card.querySelector(".nc-about")) return null;
    var box = document.createElement("div");
    box.className = "nc-about";
    box.innerHTML = '<p class="nc-about-h">о чём это</p>' +
      '<div class="nc-about-skel"><span></span><span></span><span></span><span></span></div>';
    var anchor = card.querySelector(".news-tags") || card.querySelector(".news-gal");
    if (anchor) card.insertBefore(box, anchor);
    else card.appendChild(box);
    return box;
  }

  function fillAbout(card, box, data) {
    if (!box) return;
    if (!data || !data.parts || !data.parts.length) {
      box.innerHTML = '<p class="nc-about-h">о чём это</p>' +
        '<p class="nc-about-note">Текст из источника не подтянулся. Нажми «Читать здесь» или открой оригинал.</p>';
      return;
    }
    box.innerHTML = aboutHtml(data.parts, data.via, data.parts.length >= ABOUT_PAR);
    box.classList.add("is-clamped");
    var more = box.querySelector(".nc-about-more");
    if (more) {
      more.addEventListener("click", function () {
        var rd = card.querySelector("[data-read]");
        if (rd) rd.click();
        box.classList.remove("is-clamped");
        more.remove();
      });
    }
  }

  function pump() {
    while (aboutBusy < PARALLEL && aboutQueue.length) {
      (function (job) {
        aboutBusy++;
        var R = radar();
        var done = function (data) {
          aboutBusy--;
          if (data) {
            aboutCache[job.url] = data;
            var mem = ss(AKEY, {});
            mem[job.url] = data;
            ssSave(AKEY, mem);
          }
          fillAbout(job.card, job.box, data);
          pump();
        };
        if (!R || typeof R.read !== "function") { done(null); return; }
        var killed = false;
        var timer = setTimeout(function () { killed = true; done(null); }, 14000);
        Promise.resolve()
          .then(function () { return R.read(job.url); })
          .then(function (res) {
            if (killed) return;
            clearTimeout(timer);
            var raw = res && res.text ? res.text : "";
            if (!raw) { done(null); return; }
            var html = (res.md && R.md) ? R.md(raw) : "<p>" + esc(raw).replace(/\n{2,}/g, "</p><p>") + "</p>";
            var parts = paragraphsFrom(html);
            done(parts.length ? { parts: parts, via: res.via || "" } : null);
          })
          .catch(function () {
            if (killed) return;
            clearTimeout(timer);
            done(null);
          });
      })(aboutQueue.shift());
    }
  }

  function wantAbout(card) {
    var url = urlOf(card);
    if (!url) return;
    if (card.getAttribute("data-about") === "1") return;
    card.setAttribute("data-about", "1");

    var mem = aboutCache[url] || ss(AKEY, {})[url];
    var lead = card.querySelector(".news-lead");
    var leadLen = lead ? lead.textContent.trim().length : 0;

    if (mem && mem.parts && mem.parts.length) {
      var box0 = mountAbout(card);
      fillAbout(card, box0, mem);
      return;
    }
    /* если у источника и без того длинное описание — не лезем в сеть */
    if (leadLen > 420) return;

    var box = mountAbout(card);
    aboutQueue.push({ card: card, box: box, url: url });
    pump();
  }

  function observeCards() {
    if (!("IntersectionObserver" in window)) {
      cards().slice(0, 6).forEach(wantAbout);
      return;
    }
    if (!io) {
      io = new IntersectionObserver(function (list) {
        list.forEach(function (en) {
          if (en.isIntersecting) {
            wantAbout(en.target);
            io.unobserve(en.target);
          }
        });
      }, { rootMargin: "260px 0px", threshold: 0.01 });
    }
    cards().forEach(function (c) {
      if (c.getAttribute("data-about") === "1") return;
      io.observe(c);
    });
  }

  /* =======================================================
     2. ОЧЕРЕДЬ «ПОТОМ»
     ======================================================= */

  function queue() {
    var q = ls(QKEY, []);
    return Object.prototype.toString.call(q) === "[object Array]" ? q : [];
  }

  function inQueue(url) {
    var q = queue();
    for (var i = 0; i < q.length; i++) if (q[i] && q[i].url === url) return true;
    return false;
  }

  function queueAdd(url, title, domain) {
    if (!url || inQueue(url)) return;
    var q = queue();
    q.unshift({ url: url, title: title || url, domain: domain || "", at: Date.now() });
    save(QKEY, q.slice(0, 60));
  }

  function queueDrop(url) {
    save(QKEY, queue().filter(function (it) { return it && it.url !== url; }));
  }

  function domainOf(u) {
    try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
  }

  var CLOCK = '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" fill="none">' +
    '<circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.7"/>' +
    '<path d="M10 6v4.3l2.7 1.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

  function paintQueueBtn(btn, on) {
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.innerHTML = CLOCK + "<span>" + (on ? "В очереди" : "Потом") + "</span>";
  }

  function decorateCards() {
    cards().forEach(function (card) {
      if (card.querySelector("[data-flowq]")) return;
      var acts = card.querySelector(".news-actions") || card.querySelector(".news-foot");
      if (!acts) return;
      var url = urlOf(card);
      if (!url) return;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "nc-chip";
      b.setAttribute("data-flowq", "1");
      b.title = "Отложить на потом (Q — список)";
      paintQueueBtn(b, inQueue(url));
      b.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (inQueue(url)) {
          queueDrop(url);
          paintQueueBtn(b, false);
          toast("Убрал из очереди");
        } else {
          queueAdd(url, titleOf(card), domainOf(url));
          paintQueueBtn(b, true);
          toast("Отложил на потом · кнопка внизу справа");
        }
        paintDock();
      });
      acts.appendChild(b);
    });
  }

  function dockEl() {
    var d = document.getElementById("flowDock");
    if (d) return d;
    d = document.createElement("button");
    d.type = "button";
    d.id = "flowDock";
    d.className = "flow-dock";
    d.setAttribute("aria-label", "Очередь чтения");
    d.addEventListener("click", function () { openPanel(); });
    document.body.appendChild(d);
    return d;
  }

  function paintDock() {
    var d = dockEl();
    var n = queue().length;
    d.innerHTML = CLOCK + "<span>Потом</span><b>" + n + "</b>";
    d.classList.toggle("is-on", n > 0 && feedOpen());
  }

  function panelEl() {
    var p = document.getElementById("flowPanel");
    if (p) return p;
    p = document.createElement("div");
    p.id = "flowPanel";
    p.className = "flow-panel";
    p.hidden = true;
    p.innerHTML = '<div class="flow-panel-scrim" data-flowclose="1"></div>' +
      '<div class="flow-panel-box" role="dialog" aria-modal="true" aria-label="Очередь чтения">' +
      '<div class="flow-panel-head"><h3>Почитать потом</h3>' +
      '<button type="button" data-flowclose="1">Закрыть · Esc</button></div>' +
      '<p class="flow-panel-sub"></p><div class="flow-panel-list"></div></div>';
    p.addEventListener("click", function (e) {
      var t = e.target;
      while (t && t !== p) {
        if (t.getAttribute && t.getAttribute("data-flowclose")) { closePanel(); return; }
        t = t.parentNode;
      }
    });
    document.body.appendChild(p);
    return p;
  }

  function renderPanel() {
    var p = panelEl();
    var list = p.querySelector(".flow-panel-list");
    var sub = p.querySelector(".flow-panel-sub");
    var q = queue();
    if (!q.length) {
      sub.textContent = "Пусто.";
      list.innerHTML = '<p class="flow-empty">Нажми «Потом» в любой карточке — материал ляжет сюда и не потеряется.</p>';
      return;
    }
    sub.textContent = q.length + (q.length === 1 ? " материал ждёт" : " материалов ждут") + " · хранятся в этом браузере";
    list.innerHTML = q.map(function (it) {
      return '<div class="flow-row" data-u="' + esc(it.url) + '">' +
        '<div class="flow-row-main"><b>' + esc(it.title) + "</b><span>" + esc(it.domain || domainOf(it.url)) + "</span></div>" +
        '<button type="button" data-flowgo="1">Читать</button>' +
        '<a href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer">Оригинал</a>' +
        '<button type="button" class="is-x" data-flowdrop="1">Убрать</button></div>';
    }).join("");

    list.querySelectorAll("[data-flowdrop]").forEach(function (b) {
      b.addEventListener("click", function () {
        var row = b.closest(".flow-row");
        var u = row ? row.getAttribute("data-u") : "";
        queueDrop(u);
        var card = document.querySelector('#feedList .news-card[data-url="' + (window.CSS && CSS.escape ? CSS.escape(u) : u) + '"]');
        if (card) {
          var btn = card.querySelector("[data-flowq]");
          if (btn) paintQueueBtn(btn, false);
        }
        renderPanel();
        paintDock();
      });
    });

    list.querySelectorAll("[data-flowgo]").forEach(function (b) {
      b.addEventListener("click", function () {
        var row = b.closest(".flow-row");
        var u = row ? row.getAttribute("data-u") : "";
        closePanel();
        var card = null;
        cards().forEach(function (c) { if (urlOf(c) === u) card = c; });
        if (card) {
          card.scrollIntoView({ behavior: "smooth", block: "start" });
          var rd = card.querySelector("[data-read]");
          if (rd && rd.textContent.indexOf("Свернуть") === -1) setTimeout(function () { rd.click(); }, 420);
        } else {
          window.open(u, "_blank", "noopener");
        }
      });
    });
  }

  function openPanel() {
    var p = panelEl();
    renderPanel();
    p.hidden = false;
    var b = p.querySelector(".flow-panel-head button");
    if (b) b.focus();
  }

  function closePanel() {
    var p = document.getElementById("flowPanel");
    if (p) p.hidden = true;
  }

  function panelOpen() {
    var p = document.getElementById("flowPanel");
    return !!(p && !p.hidden);
  }

  /* =======================================================
     3. УТРЕННИЙ БРИФИНГ — только реальные числа из ленты
     ======================================================= */

  function today() {
    var d = new Date();
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  }

  function greet() {
    var h = new Date().getHours();
    if (h < 5) return "Ночная сводка";
    if (h < 12) return "Доброе утро";
    if (h < 18) return "Дневная сводка";
    return "Вечерняя сводка";
  }

  function briefFrom(feed) {
    var items = (feed && feed.items) || [];
    if (!items.length) return null;
    var meta = feed.meta || {};
    var byTopic = {};
    items.forEach(function (it) {
      var n = it.topic_name || "Другое";
      byTopic[n] = (byTopic[n] || 0) + 1;
    });
    var tape = Object.keys(byTopic).map(function (k) { return { k: k, n: byTopic[k] }; })
      .sort(function (a, b) { return b.n - a.n; }).slice(0, 5);
    var top = items.slice().sort(function (a, b) {
      return (b.score || 0) - (a.score || 0);
    }).slice(0, 3);
    return {
      total: items.length,
      fresh: meta.fresh || 0,
      tape: tape,
      top: top,
      updated: feed.updated_at || ""
    };
  }

  function renderBrief(data) {
    if (!data) return;
    var wrap = document.getElementById("feedWrap");
    var list = document.getElementById("feedList");
    if (!wrap || !list) return;
    if (ls(BKEY, "") === today()) return;
    var old = document.getElementById("flowBrief");
    if (old) old.remove();

    var box = document.createElement("section");
    box.id = "flowBrief";
    box.className = "flow-brief";

    var tape = data.tape.map(function (t) {
      return "<span>" + esc(t.k) + " · " + t.n + "</span>";
    }).join("");

    var ol = data.top.map(function (it) {
      var why = [];
      if (it.score) why.push(it.score >= 1000 ? Math.round(it.score / 100) / 10 + "k ★" : it.score + " ★");
      if (it.source) why.push(it.source);
      return "<li><a href=\"" + esc(it.url) + "\" target=\"_blank\" rel=\"noopener noreferrer\">" +
        esc(it.title_ru || it.title || it.url) + "</a>" +
        (why.length ? " — " + esc(why.join(" · ")) : "") +
        (it.summary_ru ? "<br>" + esc(it.summary_ru) : "") + "</li>";
    }).join("");

    var line = data.fresh
      ? "С прошлого сбора пришло " + data.fresh + " новых, всего в ленте " + data.total + "."
      : "В ленте " + data.total + " материалов.";

    box.innerHTML =
      '<p class="flow-brief-eyebrow">' + esc(greet()) + " · брифинг</p>" +
      "<h3>" + esc(line) + "</h3>" +
      '<div class="flow-brief-tape">' + tape + "</div>" +
      "<p>Самое заметное сегодня:</p><ol>" + ol + "</ol>" +
      '<div class="flow-brief-acts">' +
      '<button type="button" class="nc-chip" data-brief="first">Начать с первого</button>' +
      '<button type="button" class="nc-chip" data-brief="fresh">Только свежее</button>' +
      '<button type="button" class="nc-chip" data-brief="hide">Скрыть на сегодня</button>' +
      "</div>";

    list.parentNode.insertBefore(box, list);

    box.querySelectorAll("[data-brief]").forEach(function (b) {
      b.addEventListener("click", function () {
        var k = b.getAttribute("data-brief");
        if (k === "hide") {
          save(BKEY, today());
          box.remove();
          toast("Скрыл брифинг до завтра");
          return;
        }
        if (k === "fresh") {
          var sb = document.querySelector('[data-sort="new"]');
          if (sb) sb.click();
          return;
        }
        var first = cards()[0];
        if (first) {
          first.scrollIntoView({ behavior: "smooth", block: "start" });
          var rd = first.querySelector("[data-read]");
          if (rd && rd.textContent.indexOf("Свернуть") === -1) setTimeout(function () { rd.click(); }, 460);
        }
      });
    });
  }

  function loadBrief() {
    if (ls(BKEY, "") === today()) return;
    if (document.getElementById("flowBrief")) return;
    fetch("data/feed.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { renderBrief(briefFrom(j)); })
      .catch(function () {});
  }

  /* =======================================================
     4. ШАПКА ЛЕНТЫ: сжатие и полоска прогресса
     ======================================================= */

  var barFill = null;
  var ticking = false;

  function ensureBar() {
    var top = document.querySelector(".news-top");
    if (!top) return null;
    if (barFill && top.contains(barFill)) return barFill;
    var old = top.querySelector(".flow-progress");
    if (old) old.remove();
    var bar = document.createElement("div");
    bar.className = "flow-progress";
    bar.innerHTML = "<i></i>";
    top.appendChild(bar);
    barFill = bar.firstChild;
    return barFill;
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      var top = document.querySelector(".news-top");
      if (!top) return;
      var y = window.pageYOffset || document.documentElement.scrollTop || 0;
      top.classList.toggle("is-min", feedOpen() && y > 150);
      var f = ensureBar();
      if (f) {
        var h = document.documentElement.scrollHeight - window.innerHeight;
        var p = h > 0 ? Math.min(100, Math.max(0, (y / h) * 100)) : 0;
        f.style.width = p.toFixed(1) + "%";
      }
    });
  }

  /* =======================================================
     5. РЕЖИМ ЧТЕНИЯ — всё лишнее гаснет
     ======================================================= */

  function centerCard() {
    var sel = document.querySelector("#feedList .news-card.is-sel");
    if (sel) return sel;
    var best = null;
    var bestD = 1e9;
    var mid = window.innerHeight / 2;
    cards().forEach(function (c) {
      var r = c.getBoundingClientRect();
      var d = Math.abs((r.top + r.bottom) / 2 - mid);
      if (d < bestD) { bestD = d; best = c; }
    });
    return best;
  }

  function tipEl() {
    var t = document.getElementById("flowTip");
    if (t) return t;
    t = document.createElement("div");
    t.id = "flowTip";
    t.className = "flow-focus-tip";
    t.hidden = true;
    t.textContent = "Режим чтения · V или Esc — выйти";
    document.body.appendChild(t);
    return t;
  }

  function setFocus(on) {
    focusOn = !!on;
    document.body.classList.toggle("flow-focus", focusOn);
    tipEl().hidden = !focusOn;
    cards().forEach(function (c) { c.classList.remove("is-focus"); });
    if (focusOn) {
      var c = centerCard();
      if (c) {
        c.classList.add("is-focus");
        c.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  }

  /* =======================================================
     6. КЛАВИШИ: Q — очередь, V — режим чтения
     ======================================================= */

  function typing(e) {
    var t = e.target;
    if (!t) return false;
    var tag = (t.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (t.isContentEditable) return true;
    return false;
  }

  function radarOpen() {
    var r = document.getElementById("radar");
    return !!(r && !r.hidden);
  }

  function anyDialog() {
    return !!document.querySelector("dialog[open]");
  }

  function bindKeys() {
    /* ставимся на захват, чтобы Esc закрывал нашу панель раньше,
       чем fx.js успеет перезагрузить страницу */
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if (panelOpen()) {
          e.preventDefault();
          e.stopImmediatePropagation();
          closePanel();
          return;
        }
        if (focusOn) {
          e.preventDefault();
          e.stopImmediatePropagation();
          setFocus(false);
          return;
        }
        /* старый fx.js на Esc делает ПОЛНУЮ перезагрузку сайта, потому что
           в адресе живёт ?tab=feed. Гасим это: вместо перезагрузки просто
           чистим поиск. Шпаргалка .keys и диалоги закрываются как раньше. */
        if (!anyDialog() && !radarOpen() && !document.querySelector(".keys")) {
          e.stopImmediatePropagation();
          var qi = document.getElementById("q");
          if (qi && qi.value) {
            qi.value = "";
            qi.dispatchEvent(new Event("input", { bubbles: true }));
          }
          return;
        }
      }
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (radarOpen() || anyDialog()) return;
      var k = (e.key || "").toLowerCase();
      if (k === "q" || k === "й") {
        e.preventDefault();
        if (panelOpen()) closePanel(); else openPanel();
        return;
      }
      if (k === "v" || k === "м") {
        if (!feedOpen()) return;
        e.preventDefault();
        setFocus(!focusOn);
      }
    }, true);
  }

  /* =======================================================
     7. ПЛАВНЫЙ ПЕРЕХОД МЕЖДУ РАЗДЕЛАМИ
     ======================================================= */

  function wireTabs() {
    document.addEventListener("click", function (e) {
      var t = e.target;
      while (t && t !== document.body) {
        if (t.classList && t.classList.contains("tab")) {
          document.body.classList.add("flow-swap");
          clearTimeout(wireTabs._t);
          wireTabs._t = setTimeout(function () {
            document.body.classList.remove("flow-swap");
            paintDock();
            loadBrief();
            decorateCards();
            observeCards();
          }, 340);
          return;
        }
        t = t.parentNode;
      }
    }, true);
  }

  /* =======================================================
     8. ОФЛАЙН
     ======================================================= */

  function wireSW() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol !== "http:" && location.protocol !== "https:") return;
    try {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    } catch (e) {}
  }

  /* =======================================================
     9. СБОРКА
     ======================================================= */

  function refresh() {
    decorateCards();
    observeCards();
    paintDock();
    ensureBar();
  }

  function watchList() {
    var list = document.getElementById("feedList");
    if (!list || list.__flow) return;
    list.__flow = true;
    var mo = new MutationObserver(function () {
      clearTimeout(watchList._t);
      watchList._t = setTimeout(refresh, 90);
    });
    mo.observe(list, { childList: true });

    var wrap = document.getElementById("feedWrap");
    if (wrap) {
      var mo2 = new MutationObserver(function () {
        paintDock();
        if (feedOpen()) { loadBrief(); refresh(); }
      });
      mo2.observe(wrap, { attributes: true, attributeFilter: ["hidden"] });
    }
  }

  var booted = false;

  function boot() {
    watchList();
    refresh();
    if (!booted) {
      booted = true;
      bindKeys();
      wireTabs();
      wireSW();
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onScroll, { passive: true });
    }
    onScroll();
    if (feedOpen()) loadBrief();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
  setTimeout(boot, 700);
  setTimeout(refresh, 1800);

  window.MONOLITH_FLOW = {
    queue: queue,
    open: openPanel,
    close: closePanel,
    focus: setFocus,
    refresh: refresh,
    about: wantAbout
  };
})();
