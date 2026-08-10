/* MONOLITH MCP — мост между твоим хранилищем и любым ИИ
   =========================================================================
   Что это: один Cloudflare Worker, который отдаёт хранилище по
   протоколу MCP. Notion, Claude, Cursor и любой другой агент
   подключаются к нему как к обычному коннектору и могут:
     search_vault  — искать по смыслу в твоих ссылках;
     get_item      — открыть материал и прочитать README/статью целиком;
     list_topics   — посмотреть категории, теги и размер хранилища;
     find_external — найти снаружи то, чего у тебя нет;
     add_link      — добавить найденное себе (только если ты разрешил).

   Правила, заданные владельцем:
     - читать можно всегда, писать — только с явного разрешения;
     - логика поиска та же, что на сайте (assets/search.js), чтобы
       агент и сайт отвечали одинаково;
     - мусор отсекается теми же фильтрами: форки, архивы, пустые
       описания и заброшенные проекты не показываются;
     - никаких зависимостей: чистый fetch, деплой одной командой.

   Деплой и подключение к Notion: см. mcp/README.md
   ========================================================================= */

const OWNER = "Zitr3X39";
const REPO = "monolith";
const BRANCH = "main";
const RAW = "https://raw.githubusercontent.com/" + OWNER + "/" + REPO + "/" + BRANCH + "/";
const SITE = "https://zitr3x39.github.io/monolith/";
const UA = "monolith-mcp/1.0 (+" + SITE + ")";
const TTL = 5 * 60 * 1000;
const SERVER_NAME = "monolith-vault";
const SERVER_VERSION = "1.0.0";
const FALLBACK_PROTO = "2025-06-18";

const CFG = {
  minStars: 60,
  nicheStars: 12,
  staleMonths: 30,
  reader: "https://r.jina.ai/",
  fuzzyMin: 0.44,
  readChars: 12000
};

/* =========================================================================
   Кэш хранилища. Worker живёт между запросами, так что держим
   индекс в памяти 5 минут: агент часто бьёт несколько запросов
   подряд, и тянуть links.json каждый раз — лишняя задержка.
   ========================================================================= */

let cache = { at: 0, recs: [], cats: [], byKey: null, updated: null, raw: null };

async function jfetch(url, headers, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 9000);
  try {
    const r = await fetch(url, {
      headers: Object.assign({ "user-agent": UA, accept: "application/json" }, headers || {}),
      signal: ctl.signal
    });
    if (!r.ok) throw new Error("HTTP " + r.status + " от " + new URL(url).hostname);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function tfetch(url, headers, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 12000);
  try {
    const r = await fetch(url, {
      headers: Object.assign({ "user-agent": UA }, headers || {}),
      signal: ctl.signal
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

async function loadDB(force) {
  if (!force && cache.byKey && Date.now() - cache.at < TTL) return cache;
  const [links, cats] = await Promise.all([
    jfetch(RAW + "data/links.json?t=" + Date.now()),
    jfetch(RAW + "data/categories.json?t=" + Date.now()).catch(() => ({ categories: [] }))
  ]);
  const catList = (cats && cats.categories) || [];
  const catMap = new Map(catList.map((c) => [c.id, c]));
  const items = (links && links.items) || [];

  // имена категорий становятся синонимами своих id — точно как на сайте
  resetClusters();
  for (const c of catList) {
    const extra = words(c.name).concat(words(String(c.id).replace(/-/g, " ")));
    if (extra.length > 1) addCluster(extra);
  }

  const recs = items.map((it) => indexItem(it, catMap));
  cache = {
    at: Date.now(),
    recs,
    cats: catList,
    byKey: new Map(recs.map((r) => [r.key, r])),
    updated: (links && links.updated_at) || null,
    raw: links || null
  };
  return cache;
}

/* =========================================================================
   Текст: нормализация, стемминг, транслит, триграммы.
   Копия логики из assets/search.js — один и тот же запрос обязан
   давать один и тот же топ и в браузере, и у агента.
   ========================================================================= */

function norm(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .replace(/\u0451/g, "\u0435")
    .replace(/[_\-\/\\.,:;!?()\[\]{}"'`\u00ab\u00bb\u2014\u2013+*#@|~^$%&=<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const RU_END = [
  "иями", "ями", "ами", "иях", "ях", "ах", "ием", "ем", "ом", "ам",
  "ов", "ев", "ий", "ый", "ой", "ей", "ая", "яя", "ое", "ее",
  "ые", "ие", "ых", "их", "юю", "ую", "ого", "его", "ому", "ему",
  "ишь", "ить", "ать", "ять", "еть", "уть", "ыть", "лся", "ся",
  "ет", "ит", "ат", "ят", "ут", "ют", "ли", "ла", "ло", "на",
  "ы", "и", "а", "я", "о", "е", "у", "ю", "ь"
];
const EN_END = ["ing", "edly", "ers", "er", "ies", "es", "ed", "ly", "s"];

function stem(w) {
  if (w.length < 4) return w;
  const list = /[\u0430-\u044f]/.test(w) ? RU_END : EN_END;
  for (const e of list) {
    if (w.length - e.length >= 3 && w.slice(-e.length) === e) return w.slice(0, -e.length);
  }
  return w;
}

const TR = {
  "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ж": "zh", "з": "z",
  "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p",
  "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c", "ч": "ch",
  "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya"
};

function translit(w) {
  let out = "";
  for (const c of w) out += TR[c] != null ? TR[c] : c;
  return out;
}

function trigrams(s) {
  const t = " " + s + " ";
  const out = [];
  for (let i = 0; i < t.length - 2; i++) out.push(t.slice(i, i + 3));
  return out;
}

function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = trigrams(a), B = trigrams(b), m = new Map();
  let hit = 0;
  for (const g of A) m.set(g, (m.get(g) || 0) + 1);
  for (const g of B) {
    const n = m.get(g) || 0;
    if (n > 0) { m.set(g, n - 1); hit++; }
  }
  return (2 * hit) / (A.length + B.length);
}

function words(s) {
  const n = norm(s);
  return n ? n.split(" ").filter((w) => w.length > 1) : [];
}

/* =========================================================================
   Смысл без ИИ: те же синонимические кластеры, что на сайте.
   Записаны строкой через «|» — короче читать и легче править.
   ========================================================================= */

const BASE_CLUSTERS = [
  "агент|agent|ассистент|assistant|llm|autonomous|crew|swarm|orchestration",
  "скилл|skill|промт|промпт|prompt|instruction|инструкция|system prompt|claude|anthropic",
  "mcp|model context protocol|сервер|server|tool|инструмент|коннектор|connector|интеграция|integration",
  "поиск|search|fuzzy|индекс|index|embedding|вектор|vector|semantic|семантика|rag|retrieval|bm25|meilisearch|typesense|elastic|память|memory",
  "сайт|site|website|web|верстка|frontend|фронт|landing|лендинг|html|css|spa",
  "оффлайн|офлайн|offline|pwa|service worker|кеш|cache|local first|localstorage|indexeddb|синхронизация|sync",
  "дизайн|design|ui|ux|интерфейс|interface|figma|фигма|типографика|typography|макет|layout|шрифт|font|палитра|palette|цвет|color|тема|theme",
  "анимация|animation|motion|наклон|tilt|transform|параллакс|parallax|gsap|framer|transition|hover|курсор|cursor|скролл|scroll|3d|webgl|three",
  "видео|video|youtube|ютуб|монтаж|editing|ffmpeg|premiere|davinci|capcut|shorts|шортс|reels|рендер|render",
  "бот|bot|telegram|телеграм|discord|дискорд|chatbot|webhook|вебхук|aiogram|telethon",
  "деплой|deploy|hosting|хостинг|vercel|netlify|cloudflare|worker|pages|github actions|ci|docker|докер|serverless",
  "база|database|sql|sqlite|postgres|supabase|firebase|redis|хранилище|storage|kv",
  "api|rest|graphql|endpoint|запрос|request|fetch|http|json|sdk|клиент|client",
  "код|code|ide|cursor|vscode|copilot|codex|вайб|vibe|vibecoding|рефакторинг|refactor|дебаг|debug|тест|test|playwright|vitest",
  "новости|news|лента|feed|rss|парсер|parser|scraping|скрапинг|crawler|дайджест|digest",
  "продуктивность|productivity|заметки|notes|notion|obsidian|обсидиан|todo|задачи|task|kanban|канбан|планирование|planning",
  "безопасность|security|токен|token|ключ|key|secret|секрет|auth|авторизация|oauth|шифрование|encryption",
  "производительность|performance|скорость|speed|оптимизация|optimization|lighthouse|bundle|lazy|ленивая",
  "доступность|accessibility|a11y|aria|контраст|contrast|клавиатура|keyboard|screen reader",
  "мобильный|mobile|телефон|phone|responsive|адаптив|touch|тач|viewport|ios|android",
  "картинка|изображение|image|svg|иконка|icon|лого|logo|превью|preview|thumbnail|og|screenshot|скриншот",
  "текст|text|перевод|translate|translation|локализация|i18n|суммаризация|summary|tldr|копирайт|copywriting",
  "деньги|money|оплата|payment|stripe|монетизация|monetization|подписка|subscription|бесплатно|free",
  "обучение|learning|курс|course|туториал|tutorial|гайд|guide|документация|docs|пример|example|шаблон|template|boilerplate|starter"
];

let CLUSTERS = [];
let TERM2CL = new Map();

function addCluster(terms) {
  CLUSTERS.push(terms);
  const ci = CLUSTERS.length - 1;
  for (const term of terms) {
    for (const w of words(term)) {
      const k = stem(w);
      const arr = TERM2CL.get(k);
      if (arr) arr.push(ci);
      else TERM2CL.set(k, [ci]);
    }
  }
}

function resetClusters() {
  CLUSTERS = [];
  TERM2CL = new Map();
  for (const line of BASE_CLUSTERS) addCluster(line.split("|"));
}
resetClusters();

function expand(q) {
  const out = new Map();
  const seenCl = new Set();
  const put = (term, w) => {
    const k = stem(term);
    if (k.length < 2) return;
    if (!out.has(k) || out.get(k) < w) out.set(k, w);
  };
  const ws = words(q);
  for (const w of ws) {
    put(w, 1);
    if (/[\u0430-\u044f]/.test(w)) put(translit(w), 0.8);
    for (const ci of TERM2CL.get(stem(w)) || []) seenCl.add(ci);
  }
  for (const ci of seenCl) {
    for (const term of CLUSTERS[ci]) {
      for (const w of words(term)) put(w, 0.55);
    }
  }
  return { terms: out, raw: ws, clusters: [...seenCl] };
}

/* =========================================================================
   Индекс и оценка — веса полей один в один с сайтом.
   ========================================================================= */

const FIELDS = [
  ["title", 6], ["tags", 4], ["catName", 3], ["note", 3], ["domain", 2.5],
  ["description", 2], ["url", 1.5], ["type", 1], ["source", 1]
];

function urlKey(u) {
  return String(u || "")
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function indexItem(it, catMap) {
  const cat = catMap.get(it.category);
  const rec = {
    raw: it,
    key: it.url_key || urlKey(it.url),
    catName: cat ? cat.name : it.category || "",
    catColor: cat ? cat.color : "#8A8E88",
    bag: new Map(),
    tagSet: new Set((it.tags || []).map((t) => norm(t)))
  };
  for (const [name, weight] of FIELDS) {
    const val = name === "catName" ? rec.catName : it[name];
    const s = Array.isArray(val) ? val.join(" ") : val;
    for (const w of words(s)) {
      const k = stem(w);
      if (!rec.bag.has(k) || rec.bag.get(k) < weight) rec.bag.set(k, weight);
    }
  }
  return rec;
}

function scoreItem(rec, ex) {
  let total = 0;
  const why = {};
  const bagKeys = [...rec.bag.keys()];

  for (const [t, w] of ex.terms) {
    let best = 0, kind = "";
    if (rec.bag.has(t)) { best = rec.bag.get(t); kind = "точно"; }
    if (!best) {
      for (const bk of bagKeys) {
        if (bk.length >= 4 && t.length >= 4 && (bk.startsWith(t) || t.startsWith(bk))) {
          const v = rec.bag.get(bk) * 0.7;
          if (v > best) { best = v; kind = "похожее слово"; }
        }
      }
    }
    if (!best && t.length >= 4) {
      for (const bk of bagKeys) {
        if (Math.abs(bk.length - t.length) > 3) continue;
        if (dice(t, bk) >= CFG.fuzzyMin) {
          const v = rec.bag.get(bk) * 0.5;
          if (v > best) { best = v; kind = "опечатка"; }
        }
      }
    }
    if (best > 0) {
      total += best * w;
      if (w >= 0.9) why[t] = kind;
      else if (Object.keys(why).length < 6) why[t] = "по смыслу";
    }
  }
  if (total <= 0) return null;
  if (rec.raw.favorite) total += 2;
  if (rec.raw.stars) total += Math.min(2, Math.log10(rec.raw.stars + 1) * 0.5);
  if (rec.raw.note) total += 0.6;
  return { rec, score: total, why };
}

function shape(h) {
  const it = h.rec.raw;
  return {
    title: it.title,
    url: it.url,
    category: h.rec.catName,
    description: it.description || "",
    my_note: it.note || "",
    tags: it.tags || [],
    favorite: !!it.favorite,
    stars: it.stars || null,
    added_at: it.added_at || null,
    found_by: h.why ? Object.keys(h.why) : [],
    match: h.why ? [...new Set(Object.values(h.why).filter(Boolean))].join(", ") : "",
    score: Math.round(h.score * 100) / 100
  };
}

function neighbours(hits, recs, limit) {
  if (!hits.length) return [];
  const inHits = new Set(), tagW = new Map(), catW = new Map();
  hits.slice(0, 6).forEach((h, i) => {
    inHits.add(h.rec.key);
    const w = 1 / (i + 1);
    for (const t of h.rec.tagSet) tagW.set(t, (tagW.get(t) || 0) + w);
    const c = h.rec.raw.category;
    if (c) catW.set(c, (catW.get(c) || 0) + w * 0.6);
  });
  const out = [];
  for (const rec of recs) {
    if (inHits.has(rec.key)) continue;
    let s = 0;
    const shared = [];
    for (const t of rec.tagSet) {
      if (tagW.has(t)) { s += tagW.get(t) * 1.4; shared.push(t); }
    }
    if (catW.has(rec.raw.category)) s += catW.get(rec.raw.category);
    if (s > 0.75) out.push({ rec, score: s, shared });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit || 6).map((n) => ({
    title: n.rec.raw.title,
    url: n.rec.raw.url,
    category: n.rec.catName,
    why: n.shared.length ? "общие теги: " + n.shared.slice(0, 3).join(", ") : "та же категория"
  }));
}

/* =========================================================================
   Чтение материала целиком. Агенту нужен текст, а не ссылка:
   если это GitHub — тянем README, иначе читалку r.jina.ai.
   ========================================================================= */

function ghSlug(u) {
  const m = String(u).match(/^https?:\/\/(?:www\.)?github\.com\/([^\/]+)\/([^\/#?]+)/i);
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/, "") } : null;
}

function cleanText(t) {
  return String(t || "")
    .replace(/\r\n/g, "\n")
    .replace(/!\[[^\]]*\]\([^)]*(?:shields\.io|badge|img\.shields|badgen|travis-ci|circleci)[^)]*\)/gi, "")
    .replace(/^\s*(?:\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)\s*)+$/gm, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readSource(url, env) {
  const g = ghSlug(url);
  if (g) {
    const h = { accept: "application/vnd.github.raw" };
    if (env && env.GITHUB_TOKEN) h.authorization = "Bearer " + env.GITHUB_TOKEN;
    try {
      const t = await tfetch("https://api.github.com/repos/" + g.owner + "/" + g.repo + "/readme", h);
      return { text: t, via: "README с GitHub" };
    } catch (e) {
      try {
        const t = await tfetch("https://raw.githubusercontent.com/" + g.owner + "/" + g.repo + "/HEAD/README.md");
        return { text: t, via: "README (raw)" };
      } catch (e2) { /* падаем на читалку */ }
    }
  }
  const t = await tfetch(CFG.reader + String(url).replace(/^https?:\/\//, ""));
  return { text: t, via: "читалка r.jina.ai" };
}

/* =========================================================================
   Поиск снаружи. Отбрасываем форки, архивы, пустые описания,
   заброшенное и не по теме. Лучше мало и по делу, чем много и мусор.
   ========================================================================= */

const EMOJI_ONLY = /^[\s\p{Extended_Pictographic}\u2190-\u21ff\u2600-\u27bf]*$/u;

function monthsAgo(iso) {
  if (!iso) return 999;
  const d = new Date(iso).getTime();
  if (!d) return 999;
  return (Date.now() - d) / (1000 * 60 * 60 * 24 * 30.4);
}

function relevance(text, ex) {
  const bag = new Set(words(text).map((w) => stem(w)));
  let strong = 0, soft = 0;
  for (const [t, w] of ex.terms) {
    if (!bag.has(t)) continue;
    if (w >= 0.9) strong++; else soft++;
  }
  return { strong, soft, ok: strong > 0 || soft >= 2 };
}

function nicheQuery(ex) {
  return ex.clusters.includes(1) || ex.clusters.includes(2);
}

async function ghSearch(qs, ex, env, sort) {
  const url = "https://api.github.com/search/repositories?q=" + encodeURIComponent(qs) +
    "&sort=" + (sort || "stars") + "&order=desc&per_page=30";
  const h = { accept: "application/vnd.github+json" };
  if (env && env.GITHUB_TOKEN) h.authorization = "Bearer " + env.GITHUB_TOKEN;
  const d = await jfetch(url, h);
  const floor = nicheQuery(ex) ? CFG.nicheStars : CFG.minStars;
  const out = [];
  for (const r of d.items || []) {
    if (r.fork || r.archived || r.is_template) continue;
    const desc = r.description || "";
    if (desc.length < 18 || EMOJI_ONLY.test(desc)) continue;
    if ((r.stargazers_count || 0) < floor) continue;
    if (monthsAgo(r.pushed_at) > CFG.staleMonths) continue;
    const rel = relevance(r.full_name + " " + desc + " " + (r.topics || []).join(" "), ex);
    if (!rel.ok) continue;
    out.push({
      kind: "github",
      url: r.html_url,
      title: r.full_name,
      description: desc,
      stars: r.stargazers_count,
      language: r.language || "",
      topics: (r.topics || []).slice(0, 6),
      updated: r.pushed_at,
      score: rel.strong * 3 + rel.soft + Math.log10(r.stargazers_count + 1)
    });
  }
  return out;
}

async function npmSearch(qs, ex) {
  const d = await jfetch("https://registry.npmjs.org/-/v1/search?size=12&text=" + encodeURIComponent(qs));
  const out = [];
  for (const o of d.objects || []) {
    const p = o.package || {}, det = (o.score && o.score.detail) || {};
    const desc = p.description || "";
    if (desc.length < 18) continue;
    if ((det.popularity || 0) < 0.045) continue;
    if (monthsAgo(p.date) > CFG.staleMonths) continue;
    const rel = relevance(p.name + " " + desc + " " + (p.keywords || []).join(" "), ex);
    if (!rel.ok) continue;
    out.push({
      kind: "npm",
      url: (p.links && (p.links.repository || p.links.npm)) || "https://www.npmjs.com/package/" + p.name,
      title: p.name,
      description: desc,
      topics: (p.keywords || []).slice(0, 5),
      updated: p.date,
      score: rel.strong * 3 + rel.soft + (det.popularity || 0) * 4
    });
  }
  return out;
}

async function findExternal(q, limit, env) {
  const db = await loadDB();
  const ex = expand(q);
  const raw = ex.raw.join(" ");
  let fails = 0, lastErr = null;
  const soft = (p) => p.catch((e) => { fails++; lastErr = e; return []; });

  const jobs = [
    soft(ghSearch(raw + " in:name,description,readme", ex, env)),
    soft(ghSearch("awesome " + raw + " in:name,description", ex, env).then((rs) =>
      rs.filter((r) => /awesome/i.test(r.title)).map((r) => { r.kind = "awesome"; r.score += 1.5; return r; })
    )),
    soft(npmSearch(raw, ex))
  ];
  if (nicheQuery(ex)) {
    jobs.push(soft(ghSearch(raw + " topic:mcp OR topic:claude-skill OR topic:ai-agent", ex, env, "updated")));
  }

  const lists = await Promise.all(jobs);
  const flat = lists.flat().sort((a, b) => b.score - a.score);
  const seen = new Set(), found = [], owned = [];
  const cap = Math.min(Math.max(limit || 6, 1), 12);
  for (const r of flat) {
    const k = urlKey(r.url);
    if (seen.has(k)) continue;
    seen.add(k);
    if (db.byKey.has(k)) { owned.push({ title: db.byKey.get(k).raw.title, url: r.url }); continue; }
    if (found.length < cap) found.push(r);
  }
  if (!found.length && fails >= jobs.length) {
    let m = lastErr && lastErr.message ? lastErr.message : "нет сети";
    if (/abort/i.test(m)) m = "истекло время ожидания";
    else if (/rate limit|403/i.test(m)) m = "GitHub ограничил число запросов, попробуй через минуту";
    throw new Error("Снаружи посмотреть не получилось: " + m);
  }
  return {
    important: "Это НЕ из хранилища Кирилла. Внешние находки из интернета: если пересказываешь — говори «нашёл снаружи», а не «у тебя есть».",
    query: q,
    terms_used: ex.terms.size,
    found,
    already_in_vault: owned,
    sources_failed: fails
  };
}

/* =========================================================================
   Запись. По умолчанию ЗАКРЫТА. Чтобы агент мог добавлять ссылки,
   нужны три вещи одновременно: WRITE_ENABLED=1, GITHUB_TOKEN и
   confirm:true в самом вызове. Любого одного не хватит — отказ.
   ========================================================================= */

function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./i, ""); } catch (e) { return ""; }
}

function guessType(u) {
  const h = hostOf(u);
  if (/github\.com$/.test(h)) return "github";
  if (/(youtube\.com|youtu\.be)$/.test(h)) return "youtube";
  if (/t\.me$/.test(h)) return "telegram";
  return "site";
}

async function addLink(args, env) {
  if (!env || env.WRITE_ENABLED !== "1") {
    throw new Error("Запись выключена. Кирилл должен сам включить её: в настройках Worker поставить WRITE_ENABLED=1. Сейчас я только читаю.");
  }
  if (!env.GITHUB_TOKEN) {
    throw new Error("Нет токена GitHub в настройках Worker — добавить ссылку некуда.");
  }
  if (args.confirm !== true) {
    throw new Error("Нужно явное разрешение: спроси у Кирилла и передай confirm: true.");
  }
  const url = String(args.url || "").trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("Нужна нормальная ссылка, начинающаяся на http");

  const api = "https://api.github.com/repos/" + OWNER + "/" + REPO + "/contents/data/links.json";
  const auth = { authorization: "Bearer " + env.GITHUB_TOKEN, accept: "application/vnd.github+json" };
  const meta = await jfetch(api + "?ref=" + BRANCH, auth);
  const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(meta.content.replace(/\n/g, "")), (c) => c.charCodeAt(0))));

  const key = urlKey(url);
  if ((json.items || []).some((i) => (i.url_key || urlKey(i.url)) === key)) {
    return { added: false, reason: "Такая ссылка уже есть в хранилище — ничего не менял.", url };
  }

  const db = await loadDB();
  const catIds = new Set(db.cats.map((c) => c.id));
  const category = catIds.has(args.category) ? args.category : "other";
  const item = {
    url,
    url_key: key,
    title: String(args.title || url).slice(0, 200),
    description: String(args.description || "").slice(0, 600),
    note: String(args.note || "").slice(0, 400),
    domain: hostOf(url),
    category,
    type: guessType(url),
    source: "Агент (MCP)",
    tags: Array.isArray(args.tags) ? args.tags.slice(0, 8).map(String) : [],
    favorite: false,
    stars: typeof args.stars === "number" ? args.stars : 0,
    enriched: true,
    added_at: new Date().toISOString()
  };
  json.items = [item, ...(json.items || [])];
  json.updated_at = new Date().toISOString();

  const put = await fetch(api, {
    method: "PUT",
    headers: Object.assign({ "user-agent": UA, "content-type": "application/json" }, auth),
    body: JSON.stringify({
      message: "MCP: добавлена ссылка — " + item.title,
      content: b64(JSON.stringify(json, null, 2) + "\n"),
      sha: meta.sha,
      branch: BRANCH
    })
  });
  if (!put.ok) throw new Error("GitHub не принял запись: HTTP " + put.status);
  cache.at = 0;
  return {
    added: true,
    item: { title: item.title, url: item.url, category: item.category, tags: item.tags },
    note: "Ссылка уехала в репозиторий. На сайте появится через минуту-две, когда GitHub Pages пересоберёт."
  };
}

/* =========================================================================
   Сами инструменты, которые видит агент.
   ========================================================================= */

async function searchVault(args) {
  const q = String(args.query || "").trim();
  if (q.length < 2) throw new Error("Слишком короткий запрос — напиши хотя бы два символа.");
  const db = await loadDB();
  const ex = expand(q);
  const limit = Math.min(Math.max(args.limit || 10, 1), 25);

  let pool = db.recs;
  if (args.category) {
    const c = String(args.category).toLowerCase();
    pool = pool.filter((r) => r.raw.category === c || norm(r.catName) === norm(c));
  }
  const hits = [];
  for (const rec of pool) {
    const h = scoreItem(rec, ex);
    if (h) hits.push(h);
  }
  hits.sort((a, b) => b.score - a.score);

  const top = hits.slice(0, limit);
  const res = {
    source: "хранилище Кирилла (своё, уже собранное)",
    query: q,
    vault_size: db.recs.length,
    updated_at: db.updated,
    understood_as: [...ex.terms.keys()].slice(0, 14),
    found: top.length,
    items: top.map(shape)
  };
  if (args.include_related !== false) res.related = neighbours(hits, db.recs, 6);
  if (!top.length) {
    res.hint = "В хранилище по этому ничего нет. Можно позвать find_external и поискать снаружи.";
  }
  return res;
}

async function getItem(args, env) {
  const db = await loadDB();
  let rec = null;
  if (args.url) {
    rec = db.byKey.get(urlKey(args.url)) || null;
  } else if (args.query) {
    const r = await searchVault({ query: args.query, limit: 1, include_related: false });
    if (r.items.length) rec = db.byKey.get(urlKey(r.items[0].url)) || null;
  }
  const url = rec ? rec.raw.url : String(args.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Не понял, что открывать: передай url или query.");
  }
  const src = await readSource(url, env);
  const text = cleanText(src.text);
  const cut = text.length > CFG.readChars;
  return {
    url,
    in_vault: !!rec,
    ownership: rec
      ? "Это есть в хранилище Кирилла."
      : "Этого В ХРАНИЛИЩЕ НЕТ — внешний материал из интернета.",
    title: rec ? rec.raw.title : null,
    category: rec ? rec.catName : null,
    my_note: rec ? rec.raw.note || "" : "",
    tags: rec ? rec.raw.tags || [] : [],
    via: src.via,
    chars: text.length,
    truncated: cut,
    content: cut ? text.slice(0, CFG.readChars) + "\n\n… текст обрезан, остальное по ссылке." : text
  };
}

async function listTopics() {
  const db = await loadDB();
  const byCat = new Map(), tagCount = new Map();
  for (const rec of db.recs) {
    const c = rec.raw.category || "other";
    byCat.set(c, (byCat.get(c) || 0) + 1);
    for (const t of rec.raw.tags || []) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  }
  return {
    source: "хранилище Кирилла",
    total_links: db.recs.length,
    updated_at: db.updated,
    site: SITE,
    categories: db.cats
      .map((c) => ({ id: c.id, name: c.name, count: byCat.get(c.id) || 0 }))
      .sort((a, b) => b.count - a.count),
    top_tags: [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
      .map(([tag, count]) => ({ tag, count })),
    favorites: db.recs.filter((r) => r.raw.favorite).length
  };
}

const TOOLS = [
  {
    name: "search_vault",
    title: "Найти в хранилище",
    description: "Смысловой поиск по личному хранилищу ссылок MONOLITH. Ищет не только по названию и описанию, а по тегам, категориям, личным заметкам и доменам; понимает русские и английские слова, синонимы, транслит и опечатки. Начинай с этого инструмента, прежде чем искать в интернете.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Запрос своими словами, любой язык. Например: «что есть про оффлайн и кеш»." },
        limit: { type: "number", description: "Сколько результатов, 1–25. По умолчанию 10." },
        category: { type: "string", description: "Необязательно: id или имя категории для сужения поиска." },
        include_related: { type: "boolean", description: "Добавлять блок «рядом по смыслу». По умолчанию да." }
      },
      required: ["query"]
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: "get_item",
    title: "Прочитать целиком",
    description: "Открывает материал и возвращает его текст: для GitHub — README, для сайтов и статей — читаемый текст без рекламы и бейджей. Работает и для своих ссылок, и для внешних; в ответе всегда сказано, своё это или внешнее.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Ссылка на материал." },
        query: { type: "string", description: "Если ссылки нет: описание словами — возьмёт лучшее совпадение из хранилища." }
      }
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  {
    name: "list_topics",
    title: "Категории и теги",
    description: "Карта хранилища: все категории с количеством ссылок, частые теги, размер и дата обновления. Вызывай первым, если надо понять, чем вообще наполнено хранилище.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false }
  },
  {
    name: "find_external",
    title: "Найти снаружи",
    description: "Ищет В ИНТЕРНЕТЕ то, чего в хранилище нет: репозитории GitHub, awesome-каталоги, скиллы, пакеты npm. Отбрасывает форки, архивы и заброшенное. ВАЖНО: результаты НЕ принадлежат пользователю — говори про них «нашёл снаружи», никогда не подавай их как уже имеющиеся.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Что искать, своими словами." },
        limit: { type: "number", description: "Сколько находок, 1–12. По умолчанию 6 — лучше мало и по делу." }
      },
      required: ["query"]
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  {
    name: "add_link",
    title: "Добавить в хранилище",
    description: "Добавляет новую ссылку в хранилище. ТРЕБУЕТ ЯВНОГО РАЗРЕШЕНИЯ владельца: сначала спроси его, потом вызывай с confirm: true. Если запись не включена в настройках сервера — вернёт отказ, это нормально.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Ссылка (обязательно)." },
        title: { type: "string", description: "Название." },
        description: { type: "string", description: "Короткое описание по-русски." },
        note: { type: "string", description: "Зачем это нужно именно ему — личная заметка." },
        category: { type: "string", description: "id категории из list_topics. Если не угадать — будет other." },
        tags: { type: "array", items: { type: "string" }, description: "До 8 тегов." },
        confirm: { type: "boolean", description: "Обязательно true — подтверждение, что владелец разрешил запись." }
      },
      required: ["url", "confirm"]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, requiresConfirmation: true, openWorldHint: false }
  }
];

async function callTool(name, args, env) {
  args = args || {};
  if (name === "search_vault") return await searchVault(args);
  if (name === "get_item") return await getItem(args, env);
  if (name === "list_topics") return await listTopics();
  if (name === "find_external") return await findExternal(String(args.query || ""), args.limit, env);
  if (name === "add_link") return await addLink(args, env);
  throw new Error("Нет такого инструмента: " + name);
}

/* =========================================================================
   Протокол: JSON-RPC 2.0 поверх HTTP (Streamable HTTP transport).
   ========================================================================= */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-session-id, mcp-protocol-version, accept",
  "access-control-expose-headers": "mcp-session-id",
  "access-control-max-age": "86400"
};

const INSTRUCTIONS = [
  "Это личное хранилище ссылок MONOLITH (владелец — Кирилл, сайт " + SITE + ").",
  "Порядок работы: 1) search_vault — посмотри, есть ли уже своё; 2) get_item — прочитай целиком, прежде чем советовать; 3) find_external — только если своего не хватает.",
  "Строго разделяй своё и внешнее. Результаты find_external — это находки из интернета, а не его материалы; никогда не пиши «у тебя есть» про них.",
  "Отвечай по-русски, простыми словами, без технического жаргона.",
  "Добавлять ссылки (add_link) можно только с его явного разрешения. Читать можно всегда."
].join(" ");

function rpcOk(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcErr(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleRpc(msg, env) {
  const id = msg && msg.id !== undefined ? msg.id : null;
  const method = msg && msg.method;

  if (method === "initialize") {
    const asked = (msg.params && msg.params.protocolVersion) || FALLBACK_PROTO;
    return rpcOk(id, {
      protocolVersion: asked,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, title: "MONOLITH — хранилище и умный поиск", version: SERVER_VERSION },
      instructions: INSTRUCTIONS
    });
  }
  if (method === "ping") return rpcOk(id, {});
  if (method === "tools/list") return rpcOk(id, { tools: TOOLS });
  if (method === "resources/list") return rpcOk(id, { resources: [] });
  if (method === "prompts/list") return rpcOk(id, { prompts: [] });

  if (method === "tools/call") {
    const p = msg.params || {};
    try {
      const data = await callTool(p.name, p.arguments, env);
      return rpcOk(id, {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
        isError: false
      });
    } catch (e) {
      return rpcOk(id, {
        content: [{ type: "text", text: "Не получилось: " + (e && e.message ? e.message : String(e)) }],
        isError: true
      });
    }
  }
  if (typeof method === "string" && method.startsWith("notifications/")) return null;
  return rpcErr(id, -32601, "Метод не поддерживается: " + method);
}

export default {
  async fetch(request, env) {
    const json = (body, status) =>
      new Response(JSON.stringify(body), {
        status: status || 200,
        headers: Object.assign({ "content-type": "application/json; charset=utf-8" }, CORS)
      });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (env && env.AUTH_TOKEN) {
      const got = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (got !== env.AUTH_TOKEN) {
        return json({ error: "Нужен ключ доступа. Добавь заголовок Authorization: Bearer <твой AUTH_TOKEN>." }, 401);
      }
    }

    if (request.method === "GET") {
      const u = new URL(request.url);
      if (u.pathname === "/health") {
        try {
          const db = await loadDB();
          return json({ ok: true, links: db.recs.length, categories: db.cats.length, updated_at: db.updated });
        } catch (e) {
          return json({ ok: false, error: e.message }, 502);
        }
      }
      return new Response(
        "MONOLITH MCP работает.\n\n" +
        "Этот адрес нужно вставить в Notion как MCP-коннектор, а не открывать в браузере.\n" +
        "Проверить живой ли он: добавь /health в конец адреса.\n" +
        "Инструменты: search_vault, get_item, list_topics, find_external, add_link.\n",
        { status: 405, headers: Object.assign({ "content-type": "text/plain; charset=utf-8", allow: "POST, OPTIONS" }, CORS) }
      );
    }

    if (request.method !== "POST") {
      return json(rpcErr(null, -32600, "Нужен POST с JSON-RPC."), 405);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json(rpcErr(null, -32700, "Не смог разобрать JSON."), 400);
    }

    try {
      if (Array.isArray(body)) {
        const out = [];
        for (const m of body) {
          const r = await handleRpc(m, env);
          if (r) out.push(r);
        }
        return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
      }
      const res = await handleRpc(body, env);
      if (!res) return new Response(null, { status: 202, headers: CORS });
      return json(res);
    } catch (e) {
      return json(rpcErr(body && body.id !== undefined ? body.id : null, -32603, e && e.message ? e.message : String(e)), 500);
    }
  }
};
