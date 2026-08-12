/* MONOLITH v14.7 — превью карточек хранилища.

   Жалоба 12.08: у свежедобавленных сайтов, скиллов и репозиториев
   превью то есть, то нет.

   Причина. app.js строит обложку через чужой сервис скриншотов
   s.wordpress.com/mshots. Сервис рисует страницу в фоновой очереди:
   на первый запрос он отдаёт серую заглушку и только потом готовит
   картинку. Для ссылки, добавленной пять минут назад, это всегда
   означает «превью нет». Плюс на github.com скриншот бесполезен даже
   когда получается: это просто серая шапка репозитория.

   Что делает этот файл.
   1. Для github.com/<owner>/<repo> подменяет скриншот на штатную
      социальную карточку GitHub: opengraph.githubassets.com/1/owner/repo.
      Она отдаётся сразу, без очереди на рендер, и на ней видно имя
      репозитория, описание, язык и звёзды. Больше половины хранилища —
      это GitHub, так что это закрывает основную часть пустых обложек.
   2. Для обычных сайтов один раз переспрашивает mshots через 6 секунд —
      к этому моменту скриншот обычно уже готов. Новая картинка
      грузится в памяти и встаёт на место только после того, как
      загрузилась полностью, чтобы карточка не моргала пустотой.

   Почему отдельным файлом, а не правкой в app.js. Этот код не знает
   ничего о внутренностях app.js и не зависит ни от одного его класса.
   Он ищет только картинки, чей адрес начинается с точного префикса
   mshots. Нет таких картинок — файл не делает вообще ничего и ничего
   не может сломать. Подключается последним в index.html. */

(function () {
  "use strict";

  var MSHOT = "https://s.wordpress.com/mshots/v1/";
  var OG = "https://opengraph.githubassets.com/1/";
  var RETRY_MS = 6000;
  var DONE = "data-shot-done";

  /* Из адреса скриншота достаём ссылку, которую он снимает. */
  function targetOf(shot) {
    if (!shot || shot.indexOf(MSHOT) !== 0) return null;
    var enc = shot.slice(MSHOT.length).split("?")[0];
    var raw;
    try {
      raw = decodeURIComponent(enc);
    } catch (e) {
      return null;
    }
    try {
      return new URL(raw);
    } catch (e) {
      return null;
    }
  }

  /* github.com/owner/repo -> социальная карточка GitHub. */
  function ghCard(shot) {
    var u = targetOf(shot);
    if (!u) return "";
    var host = u.hostname.replace(/^www\./, "");
    if (host !== "github.com") return "";
    var parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return "";
    var owner = parts[0];
    var repo = parts[1].replace(/\.git$/, "");
    if (!owner || !repo) return "";
    return OG + encodeURIComponent(owner) + "/" + encodeURIComponent(repo);
  }

  /* Грузим в памяти и показываем только готовое — без мигания. */
  function swapWhenReady(apply, src) {
    var probe = new Image();
    probe.onload = function () {
      if (probe.naturalWidth > 1) apply(src);
    };
    probe.src = src;
  }

  function retryShot(shot) {
    return shot + (shot.indexOf("?") < 0 ? "?" : "&") + "mono=1";
  }

  function handle(el, current, apply) {
    if (!current || current.indexOf(MSHOT) !== 0) return;
    if (el.getAttribute(DONE)) return;
    el.setAttribute(DONE, "1");

    var card = ghCard(current);
    if (card) {
      swapWhenReady(apply, card);
      return;
    }
    /* Не GitHub: даём сервису время нарисовать и спрашиваем один раз. */
    setTimeout(function () {
      swapWhenReady(apply, retryShot(current));
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
    if (style.indexOf(MSHOT) < 0) return;
    var m = style.match(/url\((['"]?)([^'")]+)\1\)/);
    if (!m) return;
    handle(el, m[2], function (src) {
      el.style.backgroundImage = 'url("' + src + '")';
    });
  }

  function scan(root) {
    if (!root || root.nodeType !== 1) {
      root = document.body || document.documentElement;
      if (!root) return;
    }
    if (root.tagName === "IMG") fixImg(root);
    else fixBg(root);

    if (!root.querySelectorAll) return;
    var imgs = root.querySelectorAll('img[src^="' + MSHOT + '"]');
    var i;
    for (i = 0; i < imgs.length; i++) fixImg(imgs[i]);
    var bgs = root.querySelectorAll('[style*="mshots"]');
    for (i = 0; i < bgs.length; i++) fixBg(bgs[i]);
  }

  function boot() {
    scan(document.body);
    if (!window.MutationObserver) return;
    var mo = new MutationObserver(function (recs) {
      for (var i = 0; i < recs.length; i++) {
        var r = recs[i];
        if (r.type === "attributes") {
          scan(r.target);
          continue;
        }
        for (var j = 0; j < r.addedNodes.length; j++) {
          if (r.addedNodes[j].nodeType === 1) scan(r.addedNodes[j]);
        }
      }
    });
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "style"]
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.MONOLITH_SHOTS = { scan: scan, card: ghCard };
})();
