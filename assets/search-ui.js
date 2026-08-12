/* MONOLITH v14.6 — умный поиск без отдельного экрана.

   Что чинит эта версия (правка №3 из списка от 12.08):
     1. Плашка «/» убрана из поля: синему тумблеру больше не на что наезжать.
     2. Тумблер фиксированной ширины и без смены жирности — при включении
        ничего не «прыгает» и текст в поле не обрезается.
     3. Включение умного режима больше НЕ открывает полноэкранный радар.
        Пишешь в том же поле — ответы падают списком прямо под ним.
        Полный экран остался на Ctrl+K и на кнопке «Открыть полностью».
     4. Стрелки ходят по подсказкам, Enter открывает, Esc закрывает.

   Движок поиска (search.js) не тронут: берём из него searchLocal/searchExternal
   и рисуем результат сами. */
(function () {
  "use strict";

  var KEY = "monolith.smart";
  var PH_PLAIN = "Найти ссылку, описание, тег…";
  var PH_SMART = "Спроси как угодно — найду по смыслу…";
  var MIN = 2;
  var LIMIT = 8;

  var smart = false;
  var timer = null;
  var reqId = 0;
  var sel = -1;
  var lastQ = "";

  try { smart = localStorage.getItem(KEY) === "1"; } catch (e) {}

  var DOT = {
    github: "#8B7CFF", youtube: "#FF5D5D", telegram: "#5AA9FF", twitter: "#7CC4FF",
    tiktok: "#E85D9E", reddit: "#FF8A3D", site: "#8A8E88", article: "#22D3A7"
  };

  var CSS = [
    ".search{position:relative!important;z-index:6}",
    ".search .search-icon{position:absolute!important;left:14px;top:50%;transform:translateY(-50%);",
    "display:block!important;opacity:1!important;visibility:visible!important;width:16px;height:16px;",
    "color:var(--text-3);pointer-events:none;z-index:3}",
    ".search:focus-within .search-icon{color:var(--text-2)}",
    ".search input#q{padding-left:42px!important;padding-right:128px!important}",
    ".search .kbd{display:none!important}",
    ".search-smart-hint{display:none!important}",

    /* тумблер: ширина прибита, поэтому включение не меняет геометрию поля */
    ".smart-sw{position:absolute;right:8px;top:50%;transform:translateY(-50%);z-index:4;",
    "box-sizing:border-box;display:inline-flex;align-items:center;justify-content:space-between;",
    "width:110px;height:34px;padding:0 9px 0 12px;touch-action:manipulation;",
    "border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--text-3);",
    "font:inherit;font-size:12px;font-weight:500;line-height:1;cursor:pointer;white-space:nowrap;",
    "transition:color .18s ease,border-color .18s ease,background .18s ease}",
    ".smart-sw:hover{color:var(--text-2);border-color:var(--line-strong,rgba(255,255,255,.17))}",
    ".smart-sw-txt{pointer-events:none}",
    ".smart-sw-track{position:relative;width:26px;height:15px;border-radius:999px;flex:0 0 auto;",
    "background:rgba(255,255,255,.13);transition:background .2s ease;pointer-events:none}",
    ".smart-sw-track i{position:absolute;left:2px;top:2px;width:11px;height:11px;border-radius:50%;",
    "background:var(--text-3);transition:transform .2s cubic-bezier(.22,1,.36,1),background .2s ease}",
    '.smart-sw[aria-checked="true"]{color:#0b1220;background:#5aa9ff;border-color:#5aa9ff}',
    '.smart-sw[aria-checked="true"] .smart-sw-track{background:rgba(6,14,26,.28)}',
    '.smart-sw[aria-checked="true"] .smart-sw-track i{transform:translateX(11px);background:#0b1220}',
    ".smart-sw:focus-visible{outline:2px solid #5aa9ff;outline-offset:2px}",
    ".smart-sw.is-live .smart-sw-track{box-shadow:0 0 0 3px rgba(90,169,255,.22)}",

    /* выпадающие ответы прямо под полем */
    ".sp{position:absolute;left:0;right:0;top:calc(100% + 8px);z-index:20;display:none;",
    "box-sizing:border-box;max-height:min(62vh,520px);overflow:auto;overscroll-behavior:contain;",
    "padding:6px;border:1px solid var(--line);border-radius:14px;background:var(--surface);",
    "box-shadow:0 18px 48px rgba(0,0,0,.46)}",
    ".sp.is-open{display:block}",
    ".sp-h{display:flex;align-items:center;justify-content:space-between;gap:10px;",
    "padding:8px 10px 6px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-3)}",
    ".sp-h b{font-weight:500;font-variant-numeric:tabular-nums;letter-spacing:0}",
    ".sp-row{display:grid;grid-template-columns:8px minmax(0,1fr) auto;gap:10px;align-items:start;",
    "padding:9px 10px;border-radius:10px;text-decoration:none;color:inherit;cursor:pointer}",
    ".sp-row:hover,.sp-row.is-sel{background:rgba(255,255,255,.06)}",
    ".sp-row:focus-visible{outline:2px solid #5aa9ff;outline-offset:-2px}",
    ".sp-dot{width:8px;height:8px;margin-top:6px;border-radius:50%;background:#8A8E88}",
    ".sp-txt{min-width:0}",
    ".sp-t{display:block;font-size:13.5px;line-height:1.35;color:var(--text);",
    "overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".sp-d{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;",
    "margin-top:3px;font-size:12px;line-height:1.45;color:var(--text-3)}",
    ".sp-m{font-size:11px;line-height:1.5;color:var(--text-3);white-space:nowrap;",
    "font-variant-numeric:tabular-nums;padding-top:2px}",
    ".sp-note{padding:12px 10px;font-size:12.5px;line-height:1.5;color:var(--text-3)}",
    ".sp-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;",
    "margin-top:4px;padding:9px 10px 6px;border-top:1px solid var(--line);",
    "font-size:11.5px;color:var(--text-3)}",
    ".sp-full{border:1px solid var(--line);background:transparent;color:var(--text-2);",
    "border-radius:999px;padding:6px 12px;font:inherit;font-size:11.5px;cursor:pointer;",
    "touch-action:manipulation;transition:color .18s ease,border-color .18s ease}",
    ".sp-full:hover{color:var(--text);border-color:var(--line-strong,rgba(255,255,255,.17))}",
    ".sp-full:focus-visible{outline:2px solid #5aa9ff;outline-offset:2px}",

    "@media (max-width:900px){.search input#q{padding-right:128px!important}}",
    "@media (max-width:620px){.smart-sw{width:56px;height:36px;padding:0 10px;justify-content:center}",
    ".smart-sw-txt{display:none}.search input#q{padding-right:74px!important}",
    ".sp{max-height:min(70vh,560px)}}",
    "@media (prefers-reduced-motion:reduce){.smart-sw,.smart-sw-track,.smart-sw-track i,",
    ".sp-full{transition:none}}"
  ].join("");

  function injectCss() {
    var st = document.getElementById("smartSwCss");
    if (!st) {
      st = document.createElement("style");
      st.id = "smartSwCss";
      document.head.appendChild(st);
    }
    if (st.textContent !== CSS) st.textContent = CSS;
  }

  function radar() { return window.MONOLITH_RADAR || null; }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function domainOf(url) {
    try {
      return String(new URL(url).hostname || "").replace(/^www\./, "");
    } catch (e) { return ""; }
  }

  function ensureIcon(form) {
    var ic = form.querySelector(".search-icon");
    if (ic) return ic;
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "search-icon");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = '<circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" stroke-width="2"/>' +
      '<path d="m14 14 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
    form.insertBefore(svg, form.firstChild);
    return svg;
  }

  /* «/» и старая подсказка про Enter больше не нужны */
  function killHint(form) {
    form.classList.remove("show-hint");
    var junk = form.querySelectorAll(".search-smart-hint, .kbd");
    for (var i = 0; i < junk.length; i++) junk[i].setAttribute("hidden", "hidden");
  }

  function buildSwitch(form, input) {
    var sw = form.querySelector(".smart-sw");
    if (sw) return sw;
    sw = document.createElement("button");
    sw.type = "button";
    sw.className = "smart-sw";
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-checked", String(smart));
    sw.setAttribute("aria-label", "Умный поиск");
    sw.title = "Умный поиск: по смыслу, синонимам и опечаткам. Ответы появляются под полем";
    sw.innerHTML = '<span class="smart-sw-txt">Умный</span>' +
      '<span class="smart-sw-track" aria-hidden="true"><i></i></span>';
    form.appendChild(sw);
    sw.addEventListener("click", function () { setSmart(!smart, input, true); });
    return sw;
  }

  function buildPanel(form) {
    var p = form.querySelector(".sp");
    if (p) return p;
    p = document.createElement("div");
    p.className = "sp";
    p.id = "smartPanel";
    p.setAttribute("role", "listbox");
    p.setAttribute("aria-label", "Подсказки умного поиска");
    form.appendChild(p);

    p.addEventListener("mousedown", function (e) {
      var full = e.target.closest ? e.target.closest(".sp-full") : null;
      if (full) e.preventDefault();
    });
    p.addEventListener("click", function (e) {
      var full = e.target.closest ? e.target.closest(".sp-full") : null;
      if (full) {
        var R = radar();
        var input = document.getElementById("q");
        if (R && typeof R.open === "function") R.open(input ? input.value.trim() : "");
        closePanel();
        return;
      }
      var row = e.target.closest ? e.target.closest(".sp-row") : null;
      if (row) closePanel();
    });
    return p;
  }

  function panel() { return document.getElementById("smartPanel"); }

  function openPanel(html) {
    var p = panel();
    if (!p) return;
    p.innerHTML = html;
    p.classList.add("is-open");
    sel = -1;
  }

  function closePanel() {
    var p = panel();
    if (!p) return;
    p.classList.remove("is-open");
    p.innerHTML = "";
    sel = -1;
  }

  function isOpen() {
    var p = panel();
    return !!(p && p.classList.contains("is-open"));
  }

  function rowEls() {
    var p = panel();
    return p ? p.querySelectorAll(".sp-row") : [];
  }

  function highlight(i) {
    var els = rowEls();
    if (!els.length) return;
    if (i < 0) i = els.length - 1;
    if (i >= els.length) i = 0;
    for (var k = 0; k < els.length; k++) els[k].classList.toggle("is-sel", k === i);
    sel = i;
    if (els[i].scrollIntoView) els[i].scrollIntoView({ block: "nearest" });
  }

  /* результаты движка приходят по-разному — приводим к плоскому списку записей */
  function recsOf(res) {
    var arr = [];
    if (!res) return arr;
    if (Array.isArray(res)) arr = res;
    else if (Array.isArray(res.all)) arr = res.all;
    else if (Array.isArray(res.items)) arr = res.items;
    else if (Array.isArray(res.local)) arr = res.local;
    else if (Array.isArray(res.results)) arr = res.results;
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var x = arr[i];
      if (!x) continue;
      var rec = x.rec || x.item || x;
      if (rec && (rec.url || rec.title)) out.push(rec);
    }
    return out;
  }

  function ready(R) {
    try {
      if (R.db && R.db().ready) return Promise.resolve();
      if (typeof R.load === "function") {
        var p = R.load();
        if (p && typeof p.then === "function") return p;
      }
    } catch (e) {}
    return Promise.resolve();
  }

  function externalOf(R, q) {
    if (!R || typeof R.searchExternal !== "function") return Promise.resolve([]);
    var p;
    try { p = R.searchExternal(q); } catch (e) { return Promise.resolve([]); }
    if (!p) return Promise.resolve([]);
    if (typeof p.then === "function") {
      return p.then(function (r) { return recsOf(r); }, function () { return []; });
    }
    return Promise.resolve(recsOf(p));
  }

  function rowHtml(rec) {
    var url = String(rec.url || "");
    var title = String(rec.title || rec.name || domainOf(url) || url);
    var desc = String(rec.description || rec.note || "");
    var meta = String(rec.domain || domainOf(url) || "");
    if (rec.stars) meta += " · " + rec.stars + "★";
    var color = DOT[String(rec.type || "site")] || DOT.site;
    return '<a class="sp-row" role="option" href="' + esc(url) + '" target="_blank" rel="noopener">' +
      '<span class="sp-dot" style="background:' + color + '" aria-hidden="true"></span>' +
      '<span class="sp-txt"><span class="sp-t">' + esc(title) + '</span>' +
      (desc ? '<span class="sp-d">' + esc(desc) + '</span>' : "") +
      '</span><span class="sp-m">' + esc(meta) + '</span></a>';
  }

  function listHtml(label, recs) {
    if (!recs.length) return "";
    var html = '<div class="sp-h"><span>' + esc(label) + '</span><b>' + recs.length + '</b></div>';
    for (var i = 0; i < recs.length; i++) html += rowHtml(recs[i]);
    return html;
  }

  function footHtml() {
    return '<div class="sp-foot"><span>↑↓ выбрать · Enter открыть · Esc закрыть</span>' +
      '<button type="button" class="sp-full">Открыть полностью</button></div>';
  }

  function run(q) {
    var R = radar();
    var my = ++reqId;
    lastQ = q;

    if (!R || typeof R.searchLocal !== "function") {
      openPanel('<div class="sp-note">Движок поиска ещё грузится. Секунду…</div>');
      return;
    }

    ready(R).then(function () {
      if (my !== reqId) return;
      var mine = [];
      try { mine = recsOf(R.searchLocal(q)); } catch (e) { mine = []; }
      mine = mine.slice(0, LIMIT);

      var html = listHtml("В твоём хранилище", mine);
      if (!html) html = '<div class="sp-note">У тебя такого нет. Смотрю снаружи…</div>';
      openPanel(html + footHtml());

      if (mine.length >= 4 || q.length < 3) return;

      externalOf(R, q).then(function (out) {
        if (my !== reqId || !isOpen()) return;
        out = out.slice(0, 5);
        var head = listHtml("В твоём хранилище", mine);
        var tail = listHtml("Снаружи", out);
        if (!head && !tail) {
          openPanel('<div class="sp-note">Ничего не нашлось. Попробуй другими словами.</div>' + footHtml());
          return;
        }
        openPanel((head || "") + (tail || "") + footHtml());
      });
    });
  }

  function paint(form, input) {
    var sw = form.querySelector(".smart-sw");
    if (sw) sw.setAttribute("aria-checked", String(smart));
    if (input) input.placeholder = smart ? PH_SMART : PH_PLAIN;
  }

  function setSmart(on, input, act) {
    smart = !!on;
    try { localStorage.setItem(KEY, smart ? "1" : "0"); } catch (e) {}
    var form = document.getElementById("searchForm");
    if (form) paint(form, input);
    if (!act) return;

    if (!smart) {
      closePanel();
      var R = radar();
      if (R && typeof R.close === "function") R.close();
      if (input) input.focus();
      return;
    }

    /* включили — остаёмся в том же поле, никакого полного экрана */
    if (input) {
      input.focus();
      var q = input.value.trim();
      if (q.length >= MIN) run(q);
    }
  }

  function liveSearch(input) {
    if (!smart) { closePanel(); return; }
    var q = input.value.trim();
    if (timer) clearTimeout(timer);
    if (q.length < MIN) { reqId++; closePanel(); return; }
    var sw = document.querySelector(".smart-sw");
    if (sw) sw.classList.add("is-live");
    timer = setTimeout(function () {
      timer = null;
      if (sw) sw.classList.remove("is-live");
      run(q);
    }, 300);
  }

  function hook() {
    injectCss();
    var form = document.getElementById("searchForm");
    var input = document.getElementById("q");
    if (!form || !input) return;

    ensureIcon(form);
    killHint(form);
    buildSwitch(form, input);
    buildPanel(form);
    paint(form, input);
    if (form.dataset && form.dataset.smartBound === "1") return;
    if (form.dataset) form.dataset.smartBound = "1";

    if (window.MutationObserver) {
      new MutationObserver(function () {
        if (form.querySelector(".search-smart-hint:not([hidden])")) killHint(form);
        if (!form.querySelector(".smart-sw")) buildSwitch(form, input);
        if (!form.querySelector(".search-icon")) ensureIcon(form);
        if (!form.querySelector(".sp")) buildPanel(form);
      }).observe(form, { childList: true });
    }

    /* Enter не открывает радар ни в одном режиме: в умном — открывает выбранное */
    document.addEventListener("submit", function (e) {
      if (e.target !== form) return;
      e.preventDefault();
      e.stopPropagation();
      if (!smart) { input.blur(); return; }
      var els = rowEls();
      var i = sel >= 0 ? sel : 0;
      if (els.length && els[i]) { els[i].click(); return; }
      var q = input.value.trim();
      if (q.length >= MIN) run(q);
    }, true);

    input.addEventListener("input", function () { liveSearch(input); });

    input.addEventListener("keydown", function (e) {
      if (!smart) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!isOpen()) { liveSearch(input); return; }
        highlight(sel + 1);
      } else if (e.key === "ArrowUp") {
        if (!isOpen()) return;
        e.preventDefault();
        highlight(sel - 1);
      } else if (e.key === "Escape") {
        if (!isOpen()) return;
        e.preventDefault();
        e.stopPropagation();
        closePanel();
      }
    });

    document.addEventListener("click", function (e) {
      if (!isOpen()) return;
      if (form.contains(e.target)) return;
      closePanel();
    });

    /* радар открыли горячей клавишей — тумблер это показывает, панель убираем */
    var box = document.getElementById("radar");
    if (box && window.MutationObserver) {
      new MutationObserver(function () {
        if (!box.hidden) {
          closePanel();
          if (!smart) setSmart(true, input, false);
        }
      }).observe(box, { attributes: true, attributeFilter: ["hidden"] });
    }
  }

  function boot() {
    hook();
    /* search.js вешает своё на DOMContentLoaded — подчищаем после него */
    setTimeout(hook, 0);
    setTimeout(hook, 400);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.MONOLITH_SEARCH_UI = {
    isSmart: function () { return smart; },
    set: function (v) { setSmart(v, document.getElementById("q"), true); },
    close: closePanel,
    query: function () { return lastQ; }
  };
})();
