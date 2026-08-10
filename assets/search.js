/* MONOLITH — умный поиск «РАДАР» v1
   =========================================================================
   Зачем: штатный поиск в app.js (строка 321) — это
   [title, description, note, url, tags, source].join(" ").includes(q).
   Он находит только дословное вхождение подстроки: «наклон» не
   найдёт tilt, «оффлайн» не найдёт service worker, опечатка
   убивает весь результат.

   Что делает этот файл:
     1) строит свой индекс по всем полям хранилища с весами;
     2) понимает смысл без ИИ: русская морфология, 24 синонимических
        кластера предметной области, транслит, триграммы против опечаток;
     3) добирает связанное по графу тегов/категорий («рядом»);
     4) если у тебя такого нет — ищет снаружи (GitHub, npm, PyPI,
        awesome-каталоги, любые статьи) с жёстким фильтром мусора;
     5) даёт прочитать материал целиком в правой панели и забрать себе.

   Границы: app.js, styles.css и данные не трогаем. Добавление
   ссылки идёт через штатный диалог #dlgAdd, чтобы сработала
   обычная синхронизация с GitHub и не возникло второго пути записи.

   Гнездо под ИИ: если появится ключ, выстави
   window.MONOLITH_AI = { key: "...", model: "..." } до загрузки этого файла —
   появится кнопка «переформулировать запрос», остальное работает без ключа.
   ========================================================================= */
(function () {
  "use strict";

  var doc = document;
  var AI = window.MONOLITH_AI || null;

  var CFG = {
    minQuery: 2,
    localTop: 20,
    nearTop: 6,
    extTop: 6,
    minStars: 60,          // обычный порог качества для GitHub
    nicheStars: 12,        // для узких тем (скиллы, mcp) — там звёзд мало
    staleMonths: 30,       // старше — отбрасываем
    reader: "https://r.jina.ai/",
    fuzzyMin: 0.44
  };

  /* =======================================================================
     1. Текст: нормализация, стемминг, транслит, триграммы
     ======================================================================= */

  function norm(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/\u0451/g, "\u0435")
      .replace(/[_\-\/\\.,:;!?()\[\]{}"'`\u00ab\u00bb\u2014\u2013+*#@|~^$%&=<>]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Лёгкий стеммер: не лингвистически точный, но для поиска
  // достаточный: сводит «агенты/агентами/агентов» к одной основе.
  var RU_END = [
    "иями", "ями", "ами", "иях", "ях", "ах", "ием", "ем", "ом", "ам",
    "ов", "ев", "ий", "ый", "ой", "ей", "ая", "яя", "ое", "ее",
    "ые", "ие", "ых", "их", "юю", "ую", "ого", "его", "ому", "ему",
    "ишь", "ить", "ать", "ять", "еть", "уть", "ыть", "лся", "ся",
    "ет", "ит", "ат", "ят", "ут", "ют", "ли", "ла", "ло", "на",
    "ы", "и", "а", "я", "о", "е", "у", "ю", "ь"
  ];
  var EN_END = ["ing", "edly", "ers", "er", "ies", "es", "ed", "ly", "s"];

  function stem(w) {
    if (w.length < 4) return w;
    var i, e;
    if (/[\u0430-\u044f]/.test(w)) {
      for (i = 0; i < RU_END.length; i++) {
        e = RU_END[i];
        if (w.length - e.length >= 3 && w.slice(-e.length) === e) return w.slice(0, -e.length);
      }
      return w;
    }
    for (i = 0; i < EN_END.length; i++) {
      e = EN_END[i];
      if (w.length - e.length >= 3 && w.slice(-e.length) === e) return w.slice(0, -e.length);
    }
    return w;
  }

  var TR = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ж": "zh", "з": "z",
    "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p",
    "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c", "ч": "ch",
    "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya"
  };

  function translit(w) {
    var out = "", i, c;
    for (i = 0; i < w.length; i++) {
      c = w[i];
      out += TR[c] != null ? TR[c] : c;
    }
    return out;
  }

  function trigrams(s) {
    var t = " " + s + " ", out = [], i;
    for (i = 0; i < t.length - 2; i++) out.push(t.slice(i, i + 3));
    return out;
  }

  // коэффициент Сёренсена–Дайса по триграммам — терпимость к опечаткам
  function dice(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    var A = trigrams(a), B = trigrams(b), m = {}, hit = 0, i;
    for (i = 0; i < A.length; i++) m[A[i]] = (m[A[i]] || 0) + 1;
    for (i = 0; i < B.length; i++) {
      if (m[B[i]] > 0) { m[B[i]]--; hit++; }
    }
    return (2 * hit) / (A.length + B.length);
  }

  function words(s) {
    var n = norm(s);
    return n ? n.split(" ").filter(function (w) { return w.length > 1; }) : [];
  }

  /* =======================================================================
     2. Смысл без ИИ: синонимические кластеры предметной области.
     Каждый кластер — одно понятие на двух языках плюс жаргон.
     Именно это даёт еффект «ищет по всему, с чем связано».
     ======================================================================= */

  var CLUSTERS = [
    ["агент", "agent", "ассистент", "assistant", "llm", "autonomous", "crew", "swarm", "orchestration"],
    ["скилл", "skill", "промт", "промпт", "prompt", "instruction", "инструкция", "system prompt", "claude", "anthropic"],
    ["mcp", "model context protocol", "сервер", "server", "tool", "инструмент", "коннектор", "connector", "интеграция", "integration"],
    ["поиск", "search", "fuzzy", "индекс", "index", "embedding", "вектор", "vector", "semantic", "семантика", "rag", "retrieval", "bm25", "meilisearch", "typesense", "elastic"],
    ["сайт", "site", "website", "web", "верстка", "frontend", "фронт", "landing", "лендинг", "html", "css", "spa"],
    ["оффлайн", "офлайн", "offline", "pwa", "service worker", "кеш", "cache", "local first", "localstorage", "indexeddb", "синхронизация", "sync"],
    ["дизайн", "design", "ui", "ux", "интерфейс", "interface", "figma", "фигма", "типографика", "typography", "макет", "layout", "шрифт", "font", "палитра", "palette", "цвет", "color", "тема", "theme"],
    ["анимация", "animation", "motion", "наклон", "tilt", "transform", "параллакс", "parallax", "gsap", "framer", "transition", "hover", "курсор", "cursor", "скролл", "scroll", "3d", "webgl", "three"],
    ["видео", "video", "youtube", "ютуб", "монтаж", "editing", "ffmpeg", "premiere", "davinci", "capcut", "shorts", "шортс", "reels", "рендер", "render"],
    ["бот", "bot", "telegram", "телеграм", "discord", "дискорд", "chatbot", "webhook", "вебхук", "aiogram", "telethon"],
    ["деплой", "deploy", "hosting", "хостинг", "vercel", "netlify", "cloudflare", "worker", "pages", "github actions", "ci", "docker", "докер", "serverless"],
    ["база", "database", "sql", "sqlite", "postgres", "supabase", "firebase", "redis", "хранилище", "storage", "kv"],
    ["api", "rest", "graphql", "endpoint", "запрос", "request", "fetch", "http", "json", "sdk", "клиент", "client"],
    ["код", "code", "ide", "cursor", "vscode", "copilot", "codex", "вайб", "vibe", "vibecoding", "рефакторинг", "refactor", "дебаг", "debug", "тест", "test", "playwright", "vitest"],
    ["новости", "news", "лента", "feed", "rss", "парсер", "parser", "scraping", "скрапинг", "crawler", "дайджест", "digest"],
    ["продуктивность", "productivity", "заметки", "notes", "notion", "obsidian", "обсидиан", "todo", "задачи", "task", "kanban", "канбан", "планирование", "planning"],
    ["безопасность", "security", "токен", "token", "ключ", "key", "secret", "секрет", "auth", "авторизация", "oauth", "шифрование", "encryption"],
    ["производительность", "performance", "скорость", "speed", "оптимизация", "optimization", "lighthouse", "bundle", "lazy", "ленивая"],
    ["доступность", "accessibility", "a11y", "aria", "контраст", "contrast", "клавиатура", "keyboard", "screen reader"],
    ["мобильный", "mobile", "телефон", "phone", "responsive", "адаптив", "touch", "тач", "viewport", "ios", "android"],
    ["картинка", "изображение", "image", "svg", "иконка", "icon", "лого", "logo", "превью", "preview", "thumbnail", "og", "screenshot", "скриншот"],
    ["текст", "text", "перевод", "translate", "translation", "локализация", "i18n", "суммаризация", "summary", "tldr", "копирайт", "copywriting"],
    ["деньги", "money", "оплата", "payment", "stripe", "монетизация", "monetization", "подписка", "subscription", "бесплатно", "free"],
    ["обучение", "learning", "курс", "course", "туториал", "tutorial", "гайд", "guide", "документация", "docs", "пример", "example", "шаблон", "template", "boilerplate", "starter"]
  ];

  // термин (основа) -> список индексов кластеров
  var TERM2CL = {};
  CLUSTERS.forEach(function (cl, ci) {
    cl.forEach(function (term) {
      words(term).forEach(function (w) {
        var k = stem(w);
        (TERM2CL[k] = TERM2CL[k] || []).push(ci);
      });
    });
  });

  // расширение запроса: свои слова (вес 1) + соседи по кластеру (0.55)
  // + транслит русских слов (0.8), чтобы «клоудфлер» шёл к cloudflare
  function expand(q) {
    var out = {}, seenCl = {};
    function put(term, w) {
      var k = stem(term);
      if (k.length < 2) return;
      if (!out[k] || out[k] < w) out[k] = w;
    }
    var ws = words(q);
    ws.forEach(function (w) {
      put(w, 1);
      if (/[\u0430-\u044f]/.test(w)) put(translit(w), 0.8);
      var cls = TERM2CL[stem(w)] || [];
      cls.forEach(function (ci) { seenCl[ci] = true; });
    });
    Object.keys(seenCl).forEach(function (ci) {
      CLUSTERS[ci].forEach(function (term) {
        words(term).forEach(function (w) { put(w, 0.55); });
      });
    });
    return { terms: out, raw: ws, clusters: Object.keys(seenCl).map(Number) };
  }

  /* =======================================================================
     3. Индекс хранилища
     ======================================================================= */

  var FIELDS = [
    ["title", 6],
    ["tags", 4],
    ["catName", 3],
    ["note", 3],
    ["domain", 2.5],
    ["description", 2],
    ["url", 1.5],
    ["type", 1],
    ["source", 1]
  ];

  var DB = { items: [], cats: {}, catList: [], byKey: {}, ready: false, error: null };

  function urlKey(u) {
    return String(u || "")
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  }

  function fieldStems(v) {
    var s = Array.isArray(v) ? v.join(" ") : v;
    var res = {};
    words(s).forEach(function (w) { res[stem(w)] = true; });
    return res;
  }

  function indexItem(it) {
    var cat = DB.cats[it.category];
    var rec = {
      raw: it,
      key: it.url_key || urlKey(it.url),
      catName: cat ? cat.name : it.category || "",
      catColor: cat ? cat.color : "#8A8E88",
      stems: {},
      bag: {}
    };
    FIELDS.forEach(function (f) {
      var name = f[0];
      var val = name === "catName" ? rec.catName : it[name];
      rec.stems[name] = fieldStems(val);
      Object.keys(rec.stems[name]).forEach(function (k) {
        rec.bag[k] = Math.max(rec.bag[k] || 0, f[1]);
      });
    });
    rec.tagSet = {};
    (it.tags || []).forEach(function (t) { rec.tagSet[norm(t)] = true; });
    return rec;
  }

  // черновики из localStorage тоже должны находиться: если ссылка добавлена,
  // но ещё не уехала в репозиторий, она не должна считаться «нет у меня».
  function localDrafts() {
    var out = [], i, k, v, parsed;
    try {
      for (i = 0; i < localStorage.length; i++) {
        k = localStorage.key(i);
        v = localStorage.getItem(k);
        if (!v || v.charAt(0) !== "{" && v.charAt(0) !== "[") continue;
        try { parsed = JSON.parse(v); } catch (e) { continue; }
        var arr = Array.isArray(parsed) ? parsed : (parsed && parsed.items);
        if (!Array.isArray(arr)) continue;
        arr.forEach(function (o) {
          if (o && typeof o === "object" && o.url && (o.title != null || o.url_key)) out.push(o);
        });
      }
    } catch (e) {}
    return out;
  }

  function loadDB() {
    var stamp = "?t=" + Date.now();
    return Promise.all([
      fetch("data/links.json" + stamp, { cache: "no-store" }).then(function (r) { return r.json(); }),
      fetch("data/categories.json" + stamp, { cache: "no-store" }).then(function (r) { return r.json(); }).catch(function () { return null; })
    ]).then(function (res) {
      var links = res[0], cats = res[1];
      DB.catList = (cats && cats.categories) || [];
      DB.catList.forEach(function (c) { DB.cats[c.id] = c; });

      // имена категорий сами становятся синонимами своего id
      DB.catList.forEach(function (c) {
        var extra = words(c.name).concat(words(String(c.id).replace(/-/g, " ")));
        if (extra.length > 1) {
          CLUSTERS.push(extra);
          var ci = CLUSTERS.length - 1;
          extra.forEach(function (w) {
            var k = stem(w);
            (TERM2CL[k] = TERM2CL[k] || []).push(ci);
          });
        }
      });

      var all = ((links && links.items) || []).slice();
      var seen = {};
      all.forEach(function (it) { seen[it.url_key || urlKey(it.url)] = true; });
      localDrafts().forEach(function (it) {
        var k = it.url_key || urlKey(it.url);
        if (!seen[k]) { seen[k] = true; it.__draft = true; all.push(it); }
      });

      DB.items = all.map(indexItem);
      DB.items.forEach(function (r) { DB.byKey[r.key] = r; });
      DB.ready = true;
      DB.updated = (links && links.updated_at) || null;
      return DB;
    }).catch(function (e) {
      DB.error = e && e.message ? e.message : String(e);
      throw e;
    });
  }

  /* =======================================================================
     4. Оценка релевантности по хранилищу
     ======================================================================= */

  function scoreItem(rec, ex) {
    var total = 0, why = {}, terms = ex.terms, keys = Object.keys(terms);
    var bagKeys = Object.keys(rec.bag);

    keys.forEach(function (t) {
      var w = terms[t], best = 0, hitKind = "";
      // точное совпадение основы
      if (rec.bag[t] != null) { best = rec.bag[t]; hitKind = "точно"; }
      if (!best) {
        // префикс: «search» находит «searching» / «поиск» — «поисковый»
        for (var i = 0; i < bagKeys.length; i++) {
          var bk = bagKeys[i];
          if (bk.length >= 4 && t.length >= 4 && (bk.indexOf(t) === 0 || t.indexOf(bk) === 0)) {
            if (rec.bag[bk] * 0.7 > best) { best = rec.bag[bk] * 0.7; hitKind = "похожее слово"; }
          }
        }
      }
      if (!best && t.length >= 4) {
        // опечатки
        for (var j = 0; j < bagKeys.length; j++) {
          var b2 = bagKeys[j];
          if (Math.abs(b2.length - t.length) > 3) continue;
          if (dice(t, b2) >= CFG.fuzzyMin) {
            if (rec.bag[b2] * 0.5 > best) { best = rec.bag[b2] * 0.5; hitKind = "опечатка"; }
          }
        }
      }
      if (best > 0) {
        total += best * w;
        if (w >= 0.9) why[t] = hitKind;
        else if (Object.keys(why).length < 6) why[t] = "по смыслу";
      }
    });

    if (total <= 0) return null;

    // мягкие бонусы: избранное, звёзды, свежесть — не перебивают смысл
    if (rec.raw.favorite) total += 2;
    if (rec.raw.stars) total += Math.min(2, Math.log10(rec.raw.stars + 1) * 0.5);
    if (rec.raw.note) total += 0.6;

    return { rec: rec, score: total, why: why };
  }

  function searchLocal(q) {
    var ex = expand(q), out = [];
    DB.items.forEach(function (rec) {
      var s = scoreItem(rec, ex);
      if (s) out.push(s);
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return { ex: ex, hits: out.slice(0, CFG.localTop), all: out };
  }

  // «Рядом»: граф по общим тегам и категории — то, что связано с найденным,
  // но само по словам не нашлось.
  function neighbours(hits) {
    if (!hits.length) return [];
    var inHits = {}, tagW = {}, catW = {};
    hits.slice(0, 6).forEach(function (h, i) {
      inHits[h.rec.key] = true;
      var w = 1 / (i + 1);
      Object.keys(h.rec.tagSet).forEach(function (t) { tagW[t] = (tagW[t] || 0) + w; });
      var c = h.rec.raw.category;
      if (c) catW[c] = (catW[c] || 0) + w * 0.6;
    });
    var out = [];
    DB.items.forEach(function (rec) {
      if (inHits[rec.key]) return;
      var s = 0, shared = [];
      Object.keys(rec.tagSet).forEach(function (t) {
        if (tagW[t]) { s += tagW[t] * 1.4; shared.push(t); }
      });
      if (catW[rec.raw.category]) s += catW[rec.raw.category];
      if (s > 0.75) out.push({ rec: rec, score: s, shared: shared });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, CFG.nearTop);
  }

  /* =======================================================================
     5. Поиск снаружи — с жёстким фильтром мусора.
     Правило от владельца: лучше мало и по делу, чем много и мусор.
     Ключи не нужны: api.github.com, registry.npmjs.org и pypi.org отвечают
     браузеру напрямую (CORS разрешён).
     ======================================================================= */

  function jget(url, headers) {
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, 9000) : null;
    return fetch(url, { headers: headers || {}, signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        if (t) clearTimeout(t);
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }, function (e) {
        if (t) clearTimeout(t);
        throw e;
      });
  }

  var EMOJI_ONLY = /^[\s\p{Extended_Pictographic}\u2190-\u21ff\u2600-\u27bf]*$/u;

  function monthsAgo(iso) {
    if (!iso) return 999;
    var d = new Date(iso).getTime();
    if (!d) return 999;
    return (Date.now() - d) / (1000 * 60 * 60 * 24 * 30.4);
  }

  // сколько слов запроса реально встречается в кандидате
  function relevance(text, ex) {
    var bag = {};
    words(text).forEach(function (w) { bag[stem(w)] = true; });
    var strong = 0, soft = 0;
    Object.keys(ex.terms).forEach(function (t) {
      if (!bag[t]) return;
      if (ex.terms[t] >= 0.9) strong++; else soft++;
    });
    return { strong: strong, soft: soft, ok: strong > 0 || soft >= 2 };
  }

  function nicheQuery(ex) {
    // скиллы/промты/mcp — узкие темы, там 60 звёзд отрезало бы всё живое
    return ex.clusters.indexOf(1) >= 0 || ex.clusters.indexOf(2) >= 0;
  }

  function ghSearch(qs, ex, sort) {
    var url = "https://api.github.com/search/repositories?q=" + encodeURIComponent(qs) +
      "&sort=" + (sort || "stars") + "&order=desc&per_page=30";
    return jget(url, { Accept: "application/vnd.github+json" }).then(function (d) {
      var floor = nicheQuery(ex) ? CFG.nicheStars : CFG.minStars;
      var out = [];
      (d.items || []).forEach(function (r) {
        if (r.fork || r.archived || r.is_template) return;
        var desc = r.description || "";
        if (desc.length < 18 || EMOJI_ONLY.test(desc)) return;
        if ((r.stargazers_count || 0) < floor) return;
        if (monthsAgo(r.pushed_at) > CFG.staleMonths) return;
        var hay = r.full_name + " " + desc + " " + (r.topics || []).join(" ");
        var rel = relevance(hay, ex);
        if (!rel.ok) return;
        out.push({
          kind: "github",
          url: r.html_url,
          title: r.full_name,
          desc: desc,
          stars: r.stargazers_count,
          lang: r.language || "",
          topics: (r.topics || []).slice(0, 6),
          updated: r.pushed_at,
          score: rel.strong * 3 + rel.soft + Math.log10(r.stargazers_count + 1)
        });
      });
      return out;
    });
  }

  function npmSearch(qs, ex) {
    var url = "https://registry.npmjs.org/-/v1/search?size=12&text=" + encodeURIComponent(qs);
    return jget(url).then(function (d) {
      var out = [];
      (d.objects || []).forEach(function (o) {
        var p = o.package || {}, det = (o.score && o.score.detail) || {};
        var desc = p.description || "";
        if (desc.length < 18) return;
        if ((det.popularity || 0) < 0.045) return;
        if (monthsAgo(p.date) > CFG.staleMonths) return;
        var rel = relevance(p.name + " " + desc + " " + (p.keywords || []).join(" "), ex);
        if (!rel.ok) return;
        out.push({
          kind: "npm",
          url: (p.links && (p.links.repository || p.links.npm)) || ("https://www.npmjs.com/package/" + p.name),
          title: p.name,
          desc: desc,
          updated: p.date,
          topics: (p.keywords || []).slice(0, 5),
          pop: det.popularity,
          score: rel.strong * 3 + rel.soft + (det.popularity || 0) * 4
        });
      });
      return out;
    });
  }

  function pypiLookup(name, ex) {
    if (!/^[a-z0-9][a-z0-9._-]{1,30}$/i.test(name)) return Promise.resolve([]);
    return jget("https://pypi.org/pypi/" + encodeURIComponent(name) + "/json").then(function (d) {
      var i = d.info || {}, desc = i.summary || "";
      if (desc.length < 12) return [];
      var rel = relevance(i.name + " " + desc + " " + (i.keywords || ""), ex);
      if (!rel.ok) return [];
      return [{
        kind: "pypi",
        url: i.project_url || ("https://pypi.org/project/" + i.name + "/"),
        title: i.name + " · PyPI",
        desc: desc,
        score: rel.strong * 3 + rel.soft + 1
      }];
    });
  }

  function searchExternal(q, ex, picks) {
    var raw = ex.raw.join(" ");
    var jobs = [], want = picks || { gh: true, awesome: true, pkg: true };
    var fails = 0, lastErr = null;

    // Ошибку одного источника глотаем, но считаем: если легли все,
    // надо сказать «не получилось спросить интернет», а не «ничего нет».
    function soft(p) {
      return p.catch(function (e) { fails++; lastErr = e; return []; });
    }

    if (want.gh) {
      jobs.push(soft(ghSearch(raw + " in:name,description,readme", ex)));
      if (nicheQuery(ex)) {
        jobs.push(soft(ghSearch(raw + " topic:mcp OR topic:claude-skill OR topic:ai-agent", ex, "updated")));
      }
    }
    if (want.awesome) {
      jobs.push(soft(ghSearch("awesome " + raw + " in:name,description", ex).then(function (rs) {
        return rs.filter(function (r) { return /awesome/i.test(r.title); })
          .map(function (r) { r.kind = "awesome"; r.score += 1.5; return r; });
      })));
    }
    if (want.pkg) {
      jobs.push(soft(npmSearch(raw, ex)));
      if (ex.raw.length === 1) jobs.push(soft(pypiLookup(ex.raw[0], ex)));
    }

    return Promise.all(jobs).then(function (lists) {
      var flat = [], seen = {}, out = [], owned = [];
      lists.forEach(function (l) { flat = flat.concat(l || []); });
      flat.sort(function (a, b) { return b.score - a.score; });
      flat.forEach(function (r) {
        var k = urlKey(r.url);
        if (seen[k]) return;
        seen[k] = true;
        if (DB.byKey[k]) { owned.push({ ext: r, rec: DB.byKey[k] }); return; }
        if (out.length < CFG.extTop) out.push(r);
      });
      if (!out.length && fails >= jobs.length) {
        var m = lastErr && lastErr.message ? lastErr.message : "нет сети";
        if (/abort/i.test(m)) m = "истекло время ожидания";
        else if (/rate limit|403/i.test(m)) m = "GitHub ограничил число запросов, попробуй через минуту";
        else if (/failed to fetch|networkerror|load failed/i.test(m)) m = "нет сети";
        throw new Error(m);
      }
      return { found: out, owned: owned, tried: jobs.length, fails: fails };
    });
  }

  /* =======================================================================
     6. Чтение материала целиком (то, чего не хватает в ленте новостей)
     ======================================================================= */

  function ghSlug(u) {
    var m = String(u).match(/^https?:\/\/(?:www\.)?github\.com\/([^\/]+)\/([^\/#?]+)/i);
    return m ? { owner: m[1], repo: m[2].replace(/\.git$/, "") } : null;
  }

  function fetchText(url, headers) {
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, 12000) : null;
    return fetch(url, { headers: headers || {}, signal: ctl ? ctl.signal : undefined }).then(function (r) {
      if (t) clearTimeout(t);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    }, function (e) {
      if (t) clearTimeout(t);
      throw e;
    });
  }

  function readSource(url) {
    var g = ghSlug(url);
    if (g) {
      return fetchText("https://api.github.com/repos/" + g.owner + "/" + g.repo + "/readme",
        { Accept: "application/vnd.github.raw" })
        .then(function (t) { return { text: t, via: "README с GitHub", md: true }; })
        .catch(function () {
          return fetchText("https://raw.githubusercontent.com/" + g.owner + "/" + g.repo + "/HEAD/README.md")
            .then(function (t) { return { text: t, via: "README (raw)", md: true }; });
        })
        .catch(function () { return readerProxy(url); });
    }
    return readerProxy(url);
  }

  function readerProxy(url) {
    return fetchText(CFG.reader + url.replace(/^https?:\/\//, ""))
      .then(function (t) { return { text: t, via: "читалка r.jina.ai", md: true }; });
  }

  /* =======================================================================
     7. Markdown -> HTML — минимальный безопасный рендерер.
     Сначала экранируем всё, потом возвращаем только свои теги.
     Значки-бейджи (shields.io и пр.) выбрасываем — это шум.
     ======================================================================= */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function mdToHtml(src) {
    var text = String(src || "").slice(0, 60000);
    text = text.replace(/\r\n/g, "\n");
    // вырезаем бейджи и строки, состоящие только из картинок
    text = text.replace(/!\[[^\]]*\]\([^)]*(?:shields\.io|badge|img\.shields|badgen|travis-ci|circleci)[^)]*\)/gi, "");
    text = text.replace(/^\s*(?:\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)\s*)+$/gm, "");
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "");
    text = text.replace(/<!--[\s\S]*?-->/g, "");

    var blocks = text.split(/```/), html = "", i;
    for (i = 0; i < blocks.length; i++) {
      if (i % 2 === 1) {
        var code = blocks[i].replace(/^[a-z0-9+#-]*\n/i, "");
        html += '<pre class="md-code"><code>' + esc(code) + "</code></pre>";
        continue;
      }
      html += inlineBlocks(blocks[i]);
    }
    return html;
  }

  function inlineBlocks(chunk) {
    var lines = String(chunk).split("\n"), out = [], list = null, para = [];

    function flushPara() {
      if (para.length) { out.push("<p>" + inline(para.join(" ")) + "</p>"); para = []; }
    }
    function flushList() {
      if (list) { out.push("<ul>" + list.join("") + "</ul>"); list = null; }
    }

    lines.forEach(function (ln) {
      var t = ln.trim();
      if (!t) { flushPara(); flushList(); return; }

      var h = t.match(/^(#{1,6})\s+(.+)$/);
      if (h) {
        flushPara(); flushList();
        var lvl = Math.min(4, Math.max(3, h[1].length + 2));
        out.push("<h" + lvl + ">" + inline(h[2]) + "</h" + lvl + ">");
        return;
      }
      if (/^(?:[-*_]\s*){3,}$/.test(t)) { flushPara(); flushList(); out.push("<hr>"); return; }

      var li = t.match(/^[-*+]\s+(.+)$/) || t.match(/^\d+[.)]\s+(.+)$/);
      if (li) {
        flushPara();
        list = list || [];
        list.push("<li>" + inline(li[1]) + "</li>");
        return;
      }
      if (/^>\s?/.test(t)) {
        flushPara(); flushList();
        out.push("<blockquote>" + inline(t.replace(/^>\s?/, "")) + "</blockquote>");
        return;
      }
      if (/^\|.*\|$/.test(t)) { flushPara(); flushList(); return; } // таблицы пропускаем
      flushList();
      para.push(t);
    });
    flushPara(); flushList();
    return out.join("");
  }

  function inline(s) {
    var t = esc(s);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    t = t.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<i>$2</i>");
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    return t;
  }

  /* =======================================================================
     8. Интерфейс
     Главное правило владельца: внешнее не должно выглядеть так,
     будто оно уже в хранилище. Поэтому две разные зоны с разным
     визуальным языком: своё — залитые карточки с цветом категории,
     внешнее — пунктир, без заливки, моноширинные метаданные,
     метка «снаружи» и кнопка «Забрать себе».
     ======================================================================= */

  var UI = { open: false, q: "", sel: -1, rows: [], extState: "idle", extData: null, lastLocal: null };
  var el = {};

  var ICON_SEARCH = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>';

  function build() {
    var wrap = doc.createElement("div");
    wrap.className = "radar";
    wrap.id = "radar";
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="radar-scrim" data-close="1"></div>' +
      '<section class="radar-shell" role="dialog" aria-modal="true" aria-label="Умный поиск">' +
        '<header class="radar-head">' +
          '<div class="radar-field">' + ICON_SEARCH +
            '<input id="radarQ" type="text" autocomplete="off" spellcheck="false" ' +
            'placeholder="Спроси словами: «что есть про оффлайн и кэш»">' +
            '<span class="radar-kbd">Esc</span>' +
          "</div>" +
          '<div class="radar-scopes">' +
            '<button type="button" class="radar-scope is-on" data-scope="vault">Своё</button>' +
            '<button type="button" class="radar-scope is-on" data-scope="out">Снаружи</button>' +
          "</div>" +
        "</header>" +
        '<div class="radar-body">' +
          '<div class="radar-stream" id="radarStream" tabindex="-1"></div>' +
          '<aside class="radar-read" id="radarRead" hidden></aside>' +
        "</div>" +
      "</section>";
    doc.body.appendChild(wrap);

    el.root = wrap;
    el.input = wrap.querySelector("#radarQ");
    el.stream = wrap.querySelector("#radarStream");
    el.read = wrap.querySelector("#radarRead");
    el.scopes = wrap.querySelectorAll(".radar-scope");

    wrap.addEventListener("click", onClick);
    el.input.addEventListener("input", onType);
    el.input.addEventListener("keydown", onKeyInField);
    return wrap;
  }

  function scopeOn(name) {
    var b = el.root.querySelector('.radar-scope[data-scope="' + name + '"]');
    return !!(b && b.classList.contains("is-on"));
  }

  var typeTimer = null;
  function onType() {
    UI.q = el.input.value;
    if (typeTimer) clearTimeout(typeTimer);
    typeTimer = setTimeout(run, 200);
  }

  function onKeyInField(e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (UI.sel >= 0) activate(UI.rows[UI.sel], e.metaKey || e.ctrlKey ? "open" : "read");
      else runExternal(true);
    }
  }

  function onClick(e) {
    var t = e.target;
    if (t.closest("[data-close]")) { close(); return; }

    var scope = t.closest(".radar-scope");
    if (scope) {
      scope.classList.toggle("is-on");
      scope.setAttribute("aria-pressed", scope.classList.contains("is-on") ? "true" : "false");
      UI.extState = "idle"; UI.extData = null;
      run();
      return;
    }
    if (t.closest("[data-run-ext]")) { runExternal(true); return; }
    if (t.closest("[data-read-close]")) { hideRead(); return; }

    var act = t.closest("[data-act]");
    if (act) {
      var card = act.closest("[data-url]");
      if (!card) return;
      var kind = act.getAttribute("data-act");
      if (kind === "read") readInto(card.getAttribute("data-url"), card.getAttribute("data-title"));
      else if (kind === "take") takeIt(card.getAttribute("data-url"));
      return;
    }
    var row = t.closest(".rr, .rx");
    if (row && !t.closest("a")) {
      readInto(row.getAttribute("data-url"), row.getAttribute("data-title"));
    }
  }

  /* ---------- рендер ---------- */

  function whyChips(why) {
    var ks = Object.keys(why || {});
    if (!ks.length) return "";
    var parts = ks.slice(0, 5).map(function (k) {
      return '<i class="why-t">' + esc(k) + "</i>";
    });
    var kinds = {};
    ks.forEach(function (k) { kinds[why[k]] = true; });
    var note = Object.keys(kinds).filter(Boolean).join(", ");
    return '<div class="rr-why">найдено по ' + parts.join("") +
      (note ? ' <span class="why-k">' + esc(note) + "</span>" : "") + "</div>";
  }

  function vaultCard(h) {
    var it = h.rec.raw;
    return '<article class="rr" data-url="' + esc(it.url) + '" data-title="' + esc(it.title) + '">' +
      '<span class="rr-rail" style="background:' + esc(h.rec.catColor) + '"></span>' +
      '<div class="rr-main">' +
        '<div class="rr-meta">' +
          '<span class="rr-cat" style="color:' + esc(h.rec.catColor) + '">' + esc(h.rec.catName) + "</span>" +
          '<span class="rr-dot">·</span><span class="rr-dom">' + esc(it.domain || "") + "</span>" +
          (it.stars ? '<span class="rr-dot">·</span><span class="rr-num">★ ' + it.stars + "</span>" : "") +
          (it.favorite ? '<span class="rr-fav">в избранном</span>' : "") +
          (it.__draft ? '<span class="rr-fav">ещё не синхронизировано</span>' : "") +
        "</div>" +
        "<h3>" + esc(it.title) + "</h3>" +
        (it.description ? "<p>" + esc(it.description) + "</p>" : "") +
        (it.note ? '<p class="rr-note">твоя заметка: ' + esc(it.note) + "</p>" : "") +
        whyChips(h.why) +
        '<div class="rr-acts">' +
          '<button type="button" class="rr-btn" data-act="read">Читать</button>' +
          '<a class="rr-btn rr-btn-ghost" href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer">Открыть ↗</a>' +
        "</div>" +
      "</div></article>";
  }

  function nearCard(n) {
    var it = n.rec.raw;
    return '<article class="rr rr-near" data-url="' + esc(it.url) + '" data-title="' + esc(it.title) + '">' +
      '<span class="rr-rail" style="background:' + esc(n.rec.catColor) + '"></span>' +
      '<div class="rr-main">' +
        '<div class="rr-meta"><span class="rr-dom">' + esc(it.domain || "") + "</span>" +
        (n.shared.length ? '<span class="rr-dot">·</span><span class="rr-num">общие теги: ' +
          esc(n.shared.slice(0, 3).join(", ")) + "</span>" : "") + "</div>" +
        "<h3>" + esc(it.title) + "</h3>" +
        '<div class="rr-acts"><button type="button" class="rr-btn rr-btn-ghost" data-act="read">Читать</button></div>' +
      "</div></article>";
  }

  var KIND_LABEL = { github: "GitHub", awesome: "каталог", npm: "npm", pypi: "PyPI", web: "статья" };

  function agoText(iso) {
    var m = monthsAgo(iso);
    if (m > 900) return "";
    if (m < 1) return "обновлён на этой неделе";
    if (m < 2) return "обновлён в этом месяце";
    return "обновлён " + Math.round(m) + " мес. назад";
  }

  function extCard(r) {
    return '<article class="rx" data-url="' + esc(r.url) + '" data-title="' + esc(r.title) + '">' +
      '<div class="rx-flag">снаружи · нет в хранилище</div>' +
      "<h3>" + esc(r.title) + "</h3>" +
      "<p>" + esc(r.desc) + "</p>" +
      '<div class="rx-meta">' +
        '<span class="rx-kind">' + esc(KIND_LABEL[r.kind] || r.kind) + "</span>" +
        (r.stars ? "<span>★ " + r.stars + "</span>" : "") +
        (r.lang ? "<span>" + esc(r.lang) + "</span>" : "") +
        (r.pop != null ? "<span>популярность " + Math.round(r.pop * 100) + "%</span>" : "") +
        (agoText(r.updated) ? "<span>" + esc(agoText(r.updated)) + "</span>" : "") +
      "</div>" +
      (r.topics && r.topics.length ? '<div class="rx-topics">' + r.topics.map(function (t) {
        return "<i>" + esc(t) + "</i>";
      }).join("") + "</div>" : "") +
      '<div class="rx-acts">' +
        '<button type="button" class="rx-btn" data-act="read">Читать целиком</button>' +
        '<button type="button" class="rx-btn rx-take" data-act="take">Забрать себе</button>' +
        '<a class="rx-btn rx-btn-ghost" href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer">Открыть ↗</a>' +
      "</div></article>";
  }

  function section(title, sub, body, cls) {
    return '<section class="radar-sec ' + (cls || "") + '">' +
      '<div class="radar-sec-head"><h2>' + esc(title) + "</h2>" +
      (sub ? "<p>" + sub + "</p>" : "") + "</div>" + body + "</section>";
  }

  function skeleton(n) {
    var s = "";
    for (var i = 0; i < (n || 3); i++) s += '<div class="rx rx-skel"><span></span><span></span><span></span></div>';
    return s;
  }

  function renderAll() {
    var q = (UI.q || "").trim();

    if (!DB.ready) {
      el.stream.innerHTML = DB.error
        ? '<div class="radar-note radar-bad">Не удалось прочитать хранилище: ' + esc(DB.error) + "</div>"
        : '<div class="radar-note">Готовлю индекс…</div>';
      return;
    }

    if (q.length < CFG.minQuery) {
      el.stream.innerHTML = emptyState();
      UI.rows = [];
      return;
    }

    var html = "";
    var loc = UI.lastLocal;
    var vaultOn = scopeOn("vault");
    var outOn = scopeOn("out");

    if (vaultOn) {
      if (loc && loc.hits.length) {
        html += section(
          "В твоём хранилище — " + loc.all.length,
          "поиск шёл по заголовкам, описаниям, твоим заметкам, тегам, категориям и адресам",
          loc.hits.map(vaultCard).join(""),
          "sec-own"
        );
        var near = neighbours(loc.hits);
        if (near.length) {
          html += section("Рядом по смыслу", "словами не совпало, но связано тегами и категорией",
            near.map(nearCard).join(""), "sec-near");
        }
      } else {
        html += section("В твоём хранилище — ничего",
          "проверено " + DB.items.length + " ссылок по всем полям, с учётом синонимов и опечаток",
          "", "sec-own sec-empty");
      }
    }

    if (outOn) {
      var body = "", sub = "";
      if (UI.extState === "loading") {
        sub = "смотрю GitHub, каталоги и пакеты…";
        body = skeleton(3);
      } else if (UI.extState === "error") {
        body = '<div class="radar-note radar-bad">Снаружи посмотреть не получилось: ' +
          esc(UI.extError || "нет сети") +
          '. Своё хранилище искалось как обычно. ' +
          '<button type="button" class="rx-btn" data-run-ext="1">Повторить</button></div>';
      } else if (UI.extState === "done" && UI.extData) {
        var d = UI.extData;
        sub = d.found.length
          ? "отобрано " + d.found.length + " из десятков: отброшены форки, архивы, без описания, заброшенные и не по теме"
          : "подходящего не нашлось — лучше ничего, чем мусор";
        body = d.found.map(extCard).join("");
        if (d.owned.length) {
          body += '<div class="radar-note radar-owned">Уже у тебя есть: ' +
            d.owned.slice(0, 4).map(function (o) {
              return '<a href="' + esc(o.rec.raw.url) + '" target="_blank" rel="noopener noreferrer">' +
                esc(o.rec.raw.title) + "</a>";
            }).join(", ") + " — из внешнего списка убрал.</div>";
        }
      } else {
        body = '<div class="radar-note">' +
          '<button type="button" class="rx-btn" data-run-ext="1">Посмотреть снаружи</button>' +
          " <span>GitHub, awesome-каталоги, npm и PyPI. Ничего не добавляется без твоего клика.</span></div>";
      }
      html += section("Снаружи — чего у тебя нет", sub, body, "sec-out");
    }

    el.stream.innerHTML = html;
    UI.rows = [].slice.call(el.stream.querySelectorAll(".rr, .rx:not(.rx-skel)"));
    UI.sel = -1;
  }

  function emptyState() {
    var top = DB.catList.slice(0, 7).map(function (c) {
      return '<i class="radar-seed" style="border-color:' + esc(c.color) + '33;color:' + esc(c.color) + '">' +
        esc(c.name) + "</i>";
    }).join("");
    return '<div class="radar-hero">' +
      "<h2>Спроси смыслом, а не названием</h2>" +
      "<p>«что есть про оффлайн и кэш», «чем сделать наклон карточки», " +
      "«телеграм бот на python». Найдёт у тебя, а если нет — принесёт снаружи.</p>" +
      '<div class="radar-seeds">' + top + "</div>" +
      '<div class="radar-legend">' +
        '<span class="lg lg-own">так выглядит твоё</span>' +
        '<span class="lg lg-out">а так — внешнее</span>' +
      "</div>" +
      (DB.updated ? '<p class="radar-upd">индекс: ' + DB.items.length + " ссылок, обновлено " +
        esc(String(DB.updated).slice(0, 10)) + "</p>" : "") +
      "</div>";
  }

  /* ---------- запуск поиска ---------- */

  function run() {
    var q = (UI.q || "").trim();
    if (!DB.ready || q.length < CFG.minQuery) {
      UI.lastLocal = null;
      renderAll();
      return;
    }
    UI.lastLocal = searchLocal(q);
    UI.extState = "idle";
    UI.extData = null;
    renderAll();

    // Правило владельца: если у меня такого нет — предлагай из интернета сам.
    var strong = UI.lastLocal.all.filter(function (h) { return h.score >= 4; }).length;
    if (scopeOn("out") && strong < 3) runExternal(false);
  }

  function runExternal(force) {
    var q = (UI.q || "").trim();
    if (q.length < CFG.minQuery) return;
    if (!force && UI.extState === "loading") return;
    var ex = (UI.lastLocal && UI.lastLocal.ex) || expand(q);
    UI.extState = "loading";
    UI.extError = null;
    renderAll();
    var mine = q;
    searchExternal(q, ex, null).then(function (d) {
      if ((UI.q || "").trim() !== mine) return;
      UI.extData = d;
      UI.extState = "done";
      renderAll();
    }).catch(function (e) {
      if ((UI.q || "").trim() !== mine) return;
      UI.extError = e && e.message ? e.message : String(e);
      UI.extState = "error";
      renderAll();
    });
  }

  /* ---------- панель чтения ---------- */

  function hideRead() {
    el.read.hidden = true;
    el.root.classList.remove("has-read");
    el.read.innerHTML = "";
  }

  function readInto(url, title) {
    if (!url) return;
    var owned = DB.byKey[urlKey(url)];
    var host = "";
    try { host = new URL(url).hostname.replace(/^www\./, ""); } catch (e) {}

    el.read.hidden = false;
    el.root.classList.add("has-read");
    el.read.innerHTML =
      '<header class="rd-head">' +
        '<div class="rd-meta"><span>' + esc(host) + "</span>" +
          (owned ? '<span class="rd-own">уже в хранилище</span>'
                 : '<span class="rd-out">снаружи</span>') + "</div>" +
        "<h2>" + esc(title || url) + "</h2>" +
        '<div class="rd-acts">' +
          '<a class="rx-btn rx-btn-ghost" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Открыть источник ↗</a>' +
          (owned ? "" : '<button type="button" class="rx-btn rx-take" data-act="take">Забрать себе</button>') +
          '<button type="button" class="rx-btn rx-btn-ghost" data-read-close="1">Закрыть</button>' +
        "</div>" +
      "</header>" +
      '<div class="rd-body"><div class="rd-load">Читаю источник…</div></div>';
    el.read.setAttribute("data-url", url);

    var body = el.read.querySelector(".rd-body");
    readSource(url).then(function (res) {
      if (el.read.getAttribute("data-url") !== url) return;
      var htmlText = mdToHtml(res.text);
      if (!htmlText || htmlText.replace(/<[^>]+>/g, "").trim().length < 40) {
        body.innerHTML = '<div class="radar-note">Источник отдал почти пустой текст. ' +
          '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Открыть в новой вкладке</a></div>';
        return;
      }
      body.innerHTML = '<div class="rd-src">источник текста: ' + esc(res.via) + "</div>" +
        '<article class="md">' + htmlText + "</article>";
      body.scrollTop = 0;
    }).catch(function (e) {
      if (el.read.getAttribute("data-url") !== url) return;
      body.innerHTML = '<div class="radar-note radar-bad">Не удалось вытащить текст: ' +
        esc(e && e.message ? e.message : String(e)) + ". " +
        '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Открыть источник</a></div>';
    });
  }

  /* ---------- забрать себе: только штатным путём ---------- */

  function takeIt(url) {
    if (!url) return;
    var btn = doc.getElementById("btnAdd");
    var field = doc.getElementById("addText");
    var enrich = doc.getElementById("addEnrich");
    close();
    if (!btn || !field) { window.open(url, "_blank", "noopener"); return; }
    btn.click();
    setTimeout(function () {
      field.value = url;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      if (enrich && !enrich.checked) enrich.checked = true;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }, 70);
  }

  /* ---------- навигация клавиатурой ---------- */

  function move(dir) {
    if (!UI.rows.length) return;
    UI.sel = (UI.sel + dir + UI.rows.length + 1) % (UI.rows.length + 1);
    if (UI.sel === UI.rows.length) UI.sel = dir > 0 ? 0 : UI.rows.length - 1;
    UI.rows.forEach(function (r, i) { r.classList.toggle("is-sel", i === UI.sel); });
    var node = UI.rows[UI.sel];
    if (node && node.scrollIntoView) node.scrollIntoView({ block: "nearest" });
  }

  function activate(node, mode) {
    if (!node) return;
    var url = node.getAttribute("data-url");
    if (mode === "open") { window.open(url, "_blank", "noopener"); return; }
    readInto(url, node.getAttribute("data-title"));
  }

  /* ---------- открытие / закрытие ---------- */

  function open(q) {
    if (!el.root) build();
    UI.open = true;
    el.root.hidden = false;
    doc.documentElement.classList.add("radar-lock");
    if (q != null) { el.input.value = q; UI.q = q; }
    el.input.focus();
    el.input.setSelectionRange(el.input.value.length, el.input.value.length);
    if (!DB.ready && !DB.error) {
      renderAll();
      loadDB().then(run).catch(renderAll);
    } else {
      run();
    }
  }

  function close() {
    if (!el.root) return;
    UI.open = false;
    el.root.hidden = true;
    hideRead();
    doc.documentElement.classList.remove("radar-lock");
  }

  /* ---------- встраивание в сайт ---------- */

  function hookSite() {
    var q = doc.getElementById("q");
    var form = doc.getElementById("searchForm");

    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        open(q ? q.value : "");
      });
    }
    if (q) {
      var hint = doc.createElement("button");
      hint.type = "button";
      hint.className = "search-smart-hint";
      hint.title = "Искать по смыслу и снаружи (Enter, / или Ctrl+K)";
      hint.innerHTML = "умный поиск <b>\u21b5</b>";
      var box = q.closest(".search") || q.parentNode;
      if (box) {
        box.appendChild(hint);
        box.classList.add("show-hint");
      }
      hint.addEventListener("click", function () { open(q.value); });
    }

    doc.addEventListener("keydown", function (e) {
      var k = e.key;
      if ((e.metaKey || e.ctrlKey) && (k === "k" || k === "K" || k === "\u043b" || k === "\u041b")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        UI.open ? close() : open(q ? q.value : "");
        return;
      }
      if (!UI.open && k === "/") {
        var t = e.target;
        var tag = t && t.tagName ? t.tagName.toLowerCase() : "";
        if (tag === "input" || tag === "textarea" || (t && t.isContentEditable)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        open("");
        return;
      }
      if (!UI.open) return;
      var a = doc.activeElement;
      var inField = !!(a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable));
      if (k === "Escape") {
        e.preventDefault();
        if (!el.read.hidden) hideRead(); else close();
      } else if (k === "ArrowDown") {
        e.preventDefault();
        move(1);
      } else if (k === "ArrowUp") {
        e.preventDefault();
        move(-1);
      } else if (!inField && (k === "j" || k === "\u043e")) {
        move(1);
      } else if (!inField && (k === "k" || k === "\u043b")) {
        move(-1);
      }
      // Пока радар открыт, клавиши наши: иначе fx.js на «n» откроет «Добавить»,
      // на «t» сменит тему, а на «f» включит избранное прямо во время набора.
      e.stopImmediatePropagation();
    });
  }

  /* ---------- старт ---------- */

  function boot() {
    build();
    hookSite();
    loadDB().catch(function () {});
  }

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", boot);
  else boot();

  // Публичный API — нужен для автотестов и для сверки с MCP-сервером:
  // один и тот же запрос должен давать один и тот же топ.
  window.MONOLITH_RADAR = {
    open: open,
    close: close,
    db: DB,
    load: loadDB,
    expand: expand,
    searchLocal: searchLocal,
    searchExternal: searchExternal,
    neighbours: neighbours,
    read: readSource,
    md: mdToHtml,
    ai: AI ? { on: true } : { on: false }
  };
})();
