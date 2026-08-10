/* MONOLITH v14.4 — один поиск вместо двух.

   Зачем отдельным файлом: движок умного поиска (search.js) большой и рабочий,
   ломать его целиком ради внешнего вида неправильно. Этот модуль решает три бага:

     1. Не было иконки лупы: разметка есть, но стили её не ставили в поле.
        Здесь иконка гарантированно создаётся и позиционируется слева внутри поля.
     2. Плашка «умный поиск ↵» висела рядом и перекрывалась панелью разделов.
        Убираем её и ставим тумблер внутрь самого поля — перекрываться больше нечему.
     3. Два режима путали: теперь одно поле и один тумблер.
        выключен — быстрый фильтр по своему хранилищу;
        включён — умный поиск: по смыслу, синонимам, опечаткам и снаружи. */
(function () {
  "use strict";

  var KEY = "monolith.smart";
  var PH_PLAIN = "Найти ссылку, описание, тег…";
  var PH_SMART = "Спроси как угодно — поищу по смыслу и снаружи…";
  var smart = false;
  var timer = null;

  try { smart = localStorage.getItem(KEY) === "1"; } catch (e) {}

  var CSS = [
    ".search{position:relative!important;z-index:6}",
    ".search .search-icon{position:absolute!important;left:14px;top:50%;transform:translateY(-50%);",
    "display:block!important;opacity:1!important;visibility:visible!important;width:16px;height:16px;",
    "color:var(--text-3);pointer-events:none;z-index:3}",
    ".search:focus-within .search-icon{color:var(--text-2)}",
    ".search input#q{padding-left:42px!important;padding-right:132px!important}",
    ".search .kbd{right:104px}",
    ".search-smart-hint{display:none!important}",

    ".smart-sw{position:absolute;right:8px;top:50%;transform:translateY(-50%);z-index:4;",
    "display:inline-flex;align-items:center;gap:8px;height:32px;padding:0 10px 0 11px;",
    "border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--text-3);",
    "font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;",
    "transition:color .18s ease,border-color .18s ease,background .18s ease}",
    ".smart-sw:hover{color:var(--text-2);border-color:var(--line-strong)}",
    ".smart-sw-track{position:relative;width:26px;height:15px;border-radius:999px;",
    "background:rgba(255,255,255,.13);transition:background .2s ease;flex:0 0 auto}",
    ".smart-sw-track i{position:absolute;left:2px;top:2px;width:11px;height:11px;border-radius:50%;",
    "background:var(--text-3);transition:transform .2s cubic-bezier(.22,1,.36,1),background .2s ease}",
    '.smart-sw[aria-checked="true"]{color:#0b1220;background:#5aa9ff;border-color:#5aa9ff;font-weight:600}',
    '.smart-sw[aria-checked="true"] .smart-sw-track{background:rgba(6,14,26,.28)}',
    '.smart-sw[aria-checked="true"] .smart-sw-track i{transform:translateX(11px);background:#0b1220}',
    ".smart-sw:focus-visible{outline:2px solid #5aa9ff;outline-offset:2px}",
    ".smart-sw.is-live .smart-sw-track{box-shadow:0 0 0 3px rgba(90,169,255,.22)}",

    "@media (max-width:900px){.search input#q{padding-right:120px!important}}",
    "@media (max-width:620px){.smart-sw{height:36px;padding:0 9px}.smart-sw-txt{display:none}",
    ".search input#q{padding-right:64px!important}.search .kbd{display:none}}",
    "@media (prefers-reduced-motion:reduce){.smart-sw,.smart-sw-track,.smart-sw-track i{transition:none}}"
  ].join("");

  function injectCss() {
    if (document.getElementById("smartSwCss")) return;
    var st = document.createElement("style");
    st.id = "smartSwCss";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function radar() { return window.MONOLITH_RADAR || null; }

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

  function killHint(form) {
    form.classList.remove("show-hint");
    var old = form.querySelectorAll(".search-smart-hint");
    for (var i = 0; i < old.length; i++) old[i].remove();
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
    sw.title = "Умный поиск: по смыслу, синонимам, опечаткам и снаружи (Ctrl+K)";
    sw.innerHTML = '<span class="smart-sw-txt">Умный</span>' +
      '<span class="smart-sw-track" aria-hidden="true"><i></i></span>';
    form.appendChild(sw);

    sw.addEventListener("click", function () {
      setSmart(!smart, input, true);
    });
    return sw;
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

    var R = radar();
    if (smart) {
      var q = input && input.value.trim();
      if (R && typeof R.open === "function") R.open(q || "");
      else if (input) input.focus();
    } else if (R && typeof R.close === "function") {
      R.close();
      if (input) input.focus();
    }
  }

  function liveSearch(input) {
    if (!smart) return;
    var q = input.value.trim();
    if (timer) clearTimeout(timer);
    if (q.length < 2) return;
    var sw = document.querySelector(".smart-sw");
    if (sw) sw.classList.add("is-live");
    timer = setTimeout(function () {
      timer = null;
      if (sw) sw.classList.remove("is-live");
      var R = radar();
      if (R && typeof R.open === "function") R.open(q);
    }, 340);
  }

  function hook() {
    injectCss();
    var form = document.getElementById("searchForm");
    var input = document.getElementById("q");
    if (!form || !input) return;

    ensureIcon(form);
    killHint(form);
    buildSwitch(form, input);
    paint(form, input);

    /* если движок поиска создаст свою плашку позже — уберём тоже */
    if (window.MutationObserver) {
      new MutationObserver(function () {
        if (form.querySelector(".search-smart-hint")) killHint(form);
        if (!form.querySelector(".smart-sw")) buildSwitch(form, input);
        if (!form.querySelector(".search-icon")) ensureIcon(form);
      }).observe(form, { childList: true });
    }

    /* в простом режиме Enter не должен открывать умный поиск.
       Перехват на document в фазе погружения — раньше обработчика формы. */
    document.addEventListener("submit", function (e) {
      if (e.target !== form) return;
      e.preventDefault();
      if (!smart) {
        e.stopPropagation();
        input.blur();
      }
    }, true);

    input.addEventListener("input", function () { liveSearch(input); });

    /* Стрелка вниз из поля в умном режиме — сразу в результаты */
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" && smart) {
        var R = radar();
        if (R && typeof R.open === "function") R.open(input.value.trim());
      }
    });

    /* если умный поиск открыли горячей клавишей — тумблер должен это показывать */
    var box = document.getElementById("radar");
    if (box && window.MutationObserver) {
      new MutationObserver(function () {
        if (!box.hidden && !smart) setSmart(true, input, false);
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
    set: function (v) { setSmart(v, document.getElementById("q"), true); }
  };
})();
