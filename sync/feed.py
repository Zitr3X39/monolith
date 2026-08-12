#!/usr/bin/env python3
"""MONOLITH news feed collector v2.

Запускается из GitHub Actions раз в день (09:00 по Калининграду).
Собирает свежие находки СТРОГО по темам владельца:
  - AI-инструменты и AI-агенты
  - AI-скиллы
  - полезные GitHub-репозитории и инструменты разработки
  - UX и веб-дизайн
  - автоматизация
  - продуктивность

Источники: GitHub Trending, Hacker News, dev.to, Reddit, Product Hunt.

Отличия v2:
  - тема обязательна: новость вне тем владельца не публикуется вообще;
  - quality gate: без пригодного русского текста карточка не попадает в items;
  - разделены title_ru / summary_ru / why_it_matters_ru / use_cases_ru / caveats_ru;
  - опциональная AI-обработка через NEWS_AI_API_URL / NEWS_AI_API_KEY / NEWS_AI_MODEL
    (OpenAI-совместимый chat endpoint). Без секретов работает правилами;
  - mshots не используется нигде;
  - лента ограничена 35 карточками, записи старше 7 дней вычищаются;
  - если собрать не удалось ничего — файл ленты не перезаписывается.

Ссылки, которые уже есть в хранилище (data/links.json), пропускаются.

v2.1: перед сбором ленты дотягиваем названия и описания для ссылок самого
хранилища: сайт, бот и MCP кладут ссылку без описания, а vl.enrich() до сихпор
вызывался только в ручных скриптах импорта, которые ночью не запускаются.
"""
import json
import os
import re
import sys
import html
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) monolith-feed/2.0"}
FEED_PATH = "data/feed.json"
LINKS_PATH = "data/links.json"
CATS_PATH = "data/categories.json"
MAX_AGE_DAYS = 7
MAX_ITEMS = 35
MAX_OG_FETCH = 22  # сколько страниц максимум обходим за запуск за og-данными
MIN_QUALITY = 45   # порог публикации
TRACK = re.compile(r"^(utm_|fbclid|gclid|yclid|igshid|si$|ref$|ref_src)", re.IGNORECASE)

# хранилище: сколько ссылок обходим за ночь и что считаем пустым описанием
DESC_MIN = 24
MAX_VAULT_ENRICH = 40
VAULT_TRIES = 3

# vaultlib лежит рядом; при запуске «python3 sync/feed.py» каталог sync уже в sys.path
try:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import vaultlib as vl
except Exception as _e:  # без библиотеки лента всё равно собирается
    print("vaultlib недоступна, хранилище не обогащаю:", _e)
    vl = None

# ---------- темы владельца (главный фильтр «о чём») ----------
# Новость без совпадения хотя бы с одной темой не публикуется.
TOPICS = [
    ("ai-skills", "AI-скиллы", [
        "skill.md", "agent skill", "claude skill", "skills.sh", "agents.md",
        "skills for", "ai skill", "системный промпт", "system prompt",
    ]),
    ("ai-agents", "AI / агенты", [
        "llm", "gpt", "claude", "openai", "anthropic", "gemini", "deepseek",
        "mistral", "qwen", "agent", "agentic", "copilot", "neural", "нейрос",
        "machine learning", " ai ", " ai-", "ai-powered", "artificial intelligence",
        "text-to-", "text to video", "diffusion", "transformer", "inference",
        "fine-tun", "embedding", "rag", "mcp", "context window", "vibe cod",
        "вайбкод", "вайб-код",
    ]),
    ("ux-design", "UX / веб-дизайн", [
        "design", "дизайн", "ui ", " ux", "ui/", "figma", "typograph", "шрифт",
        "css", "tailwind", "landing", "анимаци", "animation", "frontend",
        "front-end", "веб-дизайн", "interface", "redesign", "logo", "логотип",
    ]),
    ("automation", "Автоматизация", [
        "automation", "автоматиз", "workflow", "scraper", "scraping", "парсер",
        "parser", "webhook", "cron", "n8n", "zapier", "bot ", "telegram bot",
        "playwright", "selenium", "puppeteer", "headless", "pipeline",
    ]),
    ("dev-tools", "Инструменты разработки", [
        "cli", "tool", "utility", "framework", "library", "sdk", " api",
        "database", "postgres", "sqlite", "git ", "github", "editor", "terminal",
        "docker", "kubernetes", "self-hosted", "selfhosted", "auth", "testing",
        "benchmark", "compiler", "debugging", "observability", "monitoring",
        "open source", "open-source", "devtools", "dev tools", "code review",
        "ide ", "plugin", "extension", "расширен",
    ]),
    ("productivity", "Продуктивность", [
        "productivity", "продуктивн", "notes", "заметк", "todo", "planner",
        "knowledge", "bookmark", "закладк", "obsidian", "notion", "pkm",
        "second brain", "habit", "привычк", "организац",
    ]),
]


def match_topic(url, text):
    """Возвращает (topic_id, topic_name) или None — тема обязательна."""
    hay = " " + ((url or "") + " " + (text or "")).lower() + " "
    for tid, name, words in TOPICS:
        for w in words:
            if w in hay:
                return tid, name
    return None


# ---------- базовые помощники ----------

def http_text(url, timeout=25, limit=None):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read(limit) if limit else r.read()
        return data.decode("utf-8", "replace")


def http_json(url):
    return json.loads(http_text(url))


def clean_url(raw):
    s = (raw or "").strip()
    if not s:
        return ""
    if not s.lower().startswith(("http://", "https://")):
        s = "https://" + s.lstrip("/")
    try:
        u = urllib.parse.urlsplit(s)
        host = (u.hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        query = [(k, v) for k, v in urllib.parse.parse_qsl(u.query) if not TRACK.match(k)]
        path = u.path[:-1] if len(u.path) > 1 and u.path.endswith("/") else u.path
        return urllib.parse.urlunsplit((u.scheme, host + ((":" + str(u.port)) if u.port else ""), path, urllib.parse.urlencode(query), ""))
    except Exception:
        return ""


def url_key(url):
    return url.split("://", 1)[-1].lower()


def host_of(url):
    try:
        return (urllib.parse.urlsplit(url).hostname or "").lower()
    except Exception:
        return ""


def detect_type(url):
    host = host_of(url)
    if host.endswith("github.com"):
        return "github"
    if host in ("t.me", "telegram.me") or host.endswith("telegram.org"):
        return "telegram"
    if host.endswith("tiktok.com"):
        return "tiktok"
    if host.endswith("youtube.com") or host == "youtu.be":
        return "youtube"
    if host.endswith("twitter.com") or host.endswith("x.com"):
        return "twitter"
    if host.endswith("reddit.com"):
        return "reddit"
    if host in ("chromewebstore.google.com", "microsoftedge.microsoft.com") or host.endswith("addons.mozilla.org"):
        return "extension"
    return "site"


def load_rules():
    try:
        with open(CATS_PATH, encoding="utf-8") as f:
            return json.load(f).get("rules", [])
    except Exception:
        return []


RULES = load_rules()
EXTRA_RULES = [
    ("vibecoding", ["llm", "gpt", "claude", "openai", "anthropic", " ai", "ai ", "ai-", "neural", "machine learning", "agent"]),
    ("video", ["video", "видео", "shorts", "youtube", "stream"]),
    ("gamedev", ["game", "игр", "godot", "unity", "unreal"]),
    ("design", ["design", "дизайн", "figma", "ui", "ux"]),
    ("automation", ["automation", "автоматиз", "workflow", "scraper", "bot"]),
    ("devops", ["deploy", "docker", "kubernetes", "ci/cd", "cloud", "server"]),
    ("security", ["security", "vulnerability", "безопасност", "exploit"]),
    ("learning", ["tutorial", "guide", "course", "learn", "docs"]),
    ("tools", ["cli", "tool", "utility", "converter"]),
]


def detect_category(url, text):
    hay = ((url or "") + " " + (text or "")).lower()
    host = host_of(url)
    for rule in RULES:
        for d in rule.get("domains", []):
            d = d.lower()
            if host == d or host.endswith("." + d):
                return rule["cat"]
    for rule in RULES:
        for w in rule.get("words", []):
            if w.lower() in hay:
                return rule["cat"]
    for cat, words in EXTRA_RULES:
        if any(w in hay for w in words):
            return cat
    return "other"


def clean_text(s):
    """Убирает HTML-теги и декодирует сущности (&amp; -> &)."""
    return html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s or ""))).strip()


def og_fetch(url):
    """Лучшее из возможного со страницы: og:description / og:image."""
    out = {}
    try:
        raw = http_text(url, timeout=10, limit=200000)
    except Exception:
        return out

    def pick(prop):
        m = re.search(r'<meta[^>]+(?:property|name)=["\']%s["\'][^>]+content=["\']([^"\']+)["\']' % re.escape(prop), raw, re.I)
        if not m:
            m = re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']%s["\']' % re.escape(prop), raw, re.I)
        return html.unescape(m.group(1).strip()) if m else ""

    d = pick("og:description") or pick("description")
    i = pick("og:image")
    if d:
        out["description"] = clean_text(d)[:400]
    if i and i.startswith(("http://", "https://")):
        out["image"] = i
    return out


# ---------- русский текст и качество ----------

def cyr_ratio(t):
    letters = re.findall(r"[A-Za-z\u0400-\u04FF]", t or "")
    if not letters:
        return 0.0
    cyr = [c for c in letters if "\u0400" <= c <= "\u04FF"]
    return len(cyr) / len(letters)


def needs_ru(t):
    letters = re.findall(r"[A-Za-z\u0400-\u04FF]", t or "")
    if len(letters) < 4:
        return False
    cyr = [c for c in letters if "\u0400" <= c <= "\u04FF"]
    return len(cyr) / len(letters) < 0.45


def translate_ru(text):
    q = text[:480]
    try:
        u = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ru&dt=t&q=" + urllib.parse.quote(q)
        data = json.loads(http_text(u, timeout=15))
        out = "".join(part[0] for part in (data[0] or []) if part and part[0]).strip()
        return out
    except Exception:
        return ""


def has_html_junk(t):
    return bool(re.search(r"&[a-z]+;|&#\d+;|<[a-z/][^>]*>", t or "", re.I))


def ru_text_ok(t, min_len=30):
    """Грубая проверка, что русский текст пригоден для показа."""
    t = (t or "").strip()
    if len(t) < min_len:
        return False
    if has_html_junk(t):
        return False
    if cyr_ratio(t) < 0.5:
        return False
    return True


AI_SYS_PROMPT = (
    "Ты редактор личной ленты полезных инструментов MONOLITH. "
    "На входе: оригинальный заголовок, описание, домен, категория и извлечённый текст. "
    "Верни только JSON. Пиши естественно по-русски, без дословной кальки. "
    "Не переводи имена продуктов, репозиториев и технологий. "
    "title_ru: понятный русский заголовок (имя продукта сохраняется). "
    "summary_ru: 1-2 предложения, что это такое. "
    "why_it_matters_ru: 2-4 предложения, чем это полезно человеку, который сохраняет "
    "AI-инструменты, репозитории, материалы по автоматизации, дизайну и видео. "
    "use_cases_ru: 2-4 конкретных сценария, не общие слова. "
    "caveats_ru: реальные ограничения, только если видны из исходных данных. "
    "Не придумывай функции и цены. Если исходных данных недостаточно, верни {\"rejected\": true}."
)


def ai_enrich(it):
    """Провайдер-независимое обогащение через OpenAI-совместимый endpoint.

    Без NEWS_AI_API_URL / NEWS_AI_API_KEY возвращает None — это нормальный
    режим работы: лента собирается правилами без AI.
    """
    api_url = (os.environ.get("NEWS_AI_API_URL") or "").strip()
    api_key = (os.environ.get("NEWS_AI_API_KEY") or "").strip()
    if not api_url or not api_key:
        return None
    model = (os.environ.get("NEWS_AI_MODEL") or "").strip() or "gpt-4o-mini"
    payload = {
        "model": model,
        "temperature": 0.3,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": AI_SYS_PROMPT},
            {"role": "user", "content": json.dumps({
                "title": it.get("title") or "",
                "description": it.get("description") or "",
                "domain": it.get("domain") or "",
                "category": it.get("category") or "",
                "topic": it.get("topic_name") or "",
            }, ensure_ascii=False)},
        ],
    }
    try:
        req = urllib.request.Request(
            api_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"},
        )
        raw = http_text_req(req)
        data = json.loads(raw)
        content = (((data.get("choices") or [{}])[0]).get("message") or {}).get("content") or ""
        out = json.loads(content)
        if not isinstance(out, dict) or out.get("rejected"):
            return None
        return out
    except Exception as e:
        print("AI-обогащение не удалось (%s): %s" % (it.get("url_key") or "?", e))
        return None


def http_text_req(req, timeout=40):
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


# ---------- описания для ссылок хранилища ----------

def vault_needs(it):
    """Ссылке нужно описание, если его нет и попытки ещё не исчерпаны."""
    desc = (it.get("description") or "").strip()
    if len(desc) >= DESC_MIN:
        return False
    if not it.get("enriched"):
        return True
    return int(it.get("desc_tries") or 0) < VAULT_TRIES


def enrich_vault():
    """Дотягивает название, описание и картинку для ссылок из data/links.json.

    Ссылки, добавленные с сайта, из бота и через MCP, попадают в хранилище
    с пустым описанием: vl.enrich() вызывался только в ручных скриптах
    импорта. Ночью Actions запускает только этот файл, поэтому обогащение
    хранилища живёт здесь и идёт первым шагом.
    """
    if vl is None:
        return 0
    data = vl.load_links()
    items = data.get("items") or []
    todo = [i for i in items if vault_needs(i)][:MAX_VAULT_ENRICH]
    if not todo:
        print("Хранилище: описания на месте у всех ссылок")
        return 0

    for i in todo:
        i["desc_tries"] = int(i.get("desc_tries") or 0) + 1
        i["enriched"] = False  # чтобы vl.enrich() взял ссылку в работу

    try:
        vl.enrich(todo)
    except Exception as e:
        print("vaultlib.enrich не отработала:", e)

    # запасной путь: og-обход силами feed.py там, где vaultlib ничего не вытащила
    for i in todo:
        if (i.get("description") or "").strip():
            continue
        og = og_fetch(i.get("url") or "")
        if og.get("description"):
            i["description"] = og["description"][:300]
            i["enriched"] = True
        if og.get("image") and not (i.get("image") or ""):
            i["image"] = og["image"]

    filled = sum(1 for i in todo if (i.get("description") or "").strip())
    try:
        vl.save_links(data)
    except Exception as e:
        print("Хранилище не сохранилось:", e)
        return 0
    print("Хранилище: обошли %d ссылок, описание есть у %d" % (len(todo), filled))
    return filled


# ---------- collectors ----------

def from_hackernews(limit=10):
    out = []
    try:
        ids = http_json("https://hacker-news.firebaseio.com/v0/topstories.json")[:60]
    except Exception as e:
        print("HN список недоступен:", e)
        return out
    for i in ids:
        if len(out) >= limit:
            break
        try:
            it = http_json("https://hacker-news.firebaseio.com/v0/item/%d.json" % i)
        except Exception:
            continue
        if not it or it.get("type") != "story":
            continue
        title = clean_text(it.get("title") or "")
        score = it.get("score") or 0
        if not title or score < 40:
            continue
        url = clean_url(it.get("url") or ("https://news.ycombinator.com/item?id=%s" % i))
        if not url:
            continue
        out.append({"url": url, "title": title, "description": "", "image": "", "source": "Hacker News", "score": score})
    print("Hacker News:", len(out))
    return out


def from_devto(limit=10):
    out = []
    try:
        arts = http_json("https://dev.to/api/articles?top=1&per_page=30")
    except Exception as e:
        print("dev.to недоступен:", e)
        return out
    for a in arts or []:
        if len(out) >= limit:
            break
        url = clean_url(a.get("url") or "")
        title = clean_text(a.get("title") or "")
        if not url or not title:
            continue
        desc = clean_text(a.get("description") or "")[:400]
        img = a.get("cover_image") or ""
        out.append({"url": url, "title": title, "description": desc, "image": img,
                    "source": "dev.to", "score": a.get("positive_reactions_count") or 0})
    print("dev.to:", len(out))
    return out


def from_reddit(subs=("artificial", "webdev", "SideProject"), limit=6):
    out = []
    for sub in subs:
        got = 0
        try:
            data = http_json("https://www.reddit.com/r/%s/top.json?t=day&limit=%d&raw_json=1" % (sub, limit * 2))
        except Exception as e:
            print("Reddit r/%s недоступен:" % sub, e)
            continue
        for ch in ((data.get("data") or {}).get("children") or []):
            if got >= limit:
                break
            d = ch.get("data") or {}
            if d.get("stickied"):
                continue
            title = clean_text(d.get("title") or "")
            url = clean_url(d.get("url") or "")
            if not title or not url:
                continue
            desc = clean_text(d.get("selftext") or "")[:400]
            img = ""
            try:
                img = html.unescape(d["preview"]["images"][0]["source"]["url"])
            except Exception:
                th = d.get("thumbnail") or ""
                if th.startswith("http"):
                    img = th
            out.append({"url": url, "title": title, "description": desc, "image": img,
                        "source": "Reddit r/" + sub, "score": d.get("score") or 0})
            got += 1
        print("Reddit r/%s:" % sub, got)
    return out


def from_github_trending(limit=14):
    out = []
    try:
        page = http_text("https://github.com/trending?since=daily")
    except Exception as e:
        print("GitHub Trending недоступен:", e)
        return out
    blocks = re.findall(r'<article[^>]*class="[^"]*Box-row[^"]*"[^>]*>(.*?)</article>', page, re.S)
    for b in blocks:
        if len(out) >= limit:
            break
        m = re.search(r'<h2[^>]*>\s*<a[^>]*href="(/[^"]+)"', b)
        if not m:
            continue
        path = m.group(1).strip()
        url = clean_url("https://github.com" + path)
        if not url:
            continue
        name = "/".join([p for p in path.split("/") if p])
        dm = re.search(r'<p[^>]*class="[^"]*col-9[^"]*"[^>]*>(.*?)</p>', b, re.S)
        desc = clean_text(dm.group(1))[:400] if dm else ""
        sm = re.search(r"([\d,]+)\s*stars\s*today", b)
        stars = int(sm.group(1).replace(",", "")) if sm else 0
        seg = [p for p in path.split("/") if p]
        img = "https://opengraph.githubassets.com/1/" + seg[0] + "/" + seg[1] if len(seg) >= 2 else ""
        out.append({"url": url, "title": name, "description": desc, "image": img,
                    "source": "GitHub Trending", "score": stars})
    print("GitHub Trending:", len(out))
    return out


def from_producthunt(limit=8):
    out = []
    try:
        xml = http_text("https://www.producthunt.com/feed")
    except Exception as e:
        print("Product Hunt недоступен:", e)
        return out
    for block in re.findall(r"<item>(.*?)</item>", xml, re.S):
        if len(out) >= limit:
            break

        def pick(tag):
            m = re.search(r"<%s>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</%s>" % (tag, tag), block, re.S)
            return m.group(1).strip() if m else ""

        title = clean_text(pick("title"))
        url = clean_url(pick("link"))
        desc = clean_text(pick("description"))[:400]
        if not title or not url:
            continue
        out.append({"url": url, "title": title, "description": desc, "image": "",
                    "source": "Product Hunt", "score": 0})
    print("Product Hunt:", len(out))
    return out


# ---------- качество ----------

def norm_title(t):
    return re.sub(r"[^a-z0-9\u0400-\u04ff]+", "", (t or "").lower())


def quality_score(it, now):
    """Формула из ТЗ: свежесть + сигнал источника + полнота + медиа."""
    score = 0.0
    try:
        age_h = (now - datetime.fromisoformat(str(it.get("found_at")).replace("Z", "+00:00"))).total_seconds() / 3600
    except Exception:
        age_h = 72
    freshness = max(0.0, 1.0 - age_h / (24 * MAX_AGE_DAYS))
    score += freshness * 25
    src = it.get("source_score") or 0
    score += min(src, 800) / 800 * 20
    score += 25  # тема уже гарантирована фильтром
    completeness = 0
    if it.get("summary_ru"):
        completeness += 0.6
    if it.get("description"):
        completeness += 0.2
    if it.get("title_ru"):
        completeness += 0.2
    score += completeness * 20
    if it.get("image"):
        score += 10
    return round(score)


def publishable(it):
    """Жёсткий quality gate: плохое не публикуем вообще."""
    if not it.get("topic"):
        return False
    if not (it.get("title_ru") or "").strip():
        return False
    if has_html_junk(it.get("title_ru")):
        return False
    # имена репозиториев/продуктов латиницей — ок; статьи должны быть по-русски
    if it.get("type") != "github" and cyr_ratio(it.get("title_ru")) < 0.4:
        return False
    if not ru_text_ok(it.get("summary_ru")):
        return False
    return True


# ---------- main ----------

def main():
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()

    # шаг 0: у ссылок хранилища часто нет описания — дотягиваем его первым делом,
    # чтобы правка доезжала до сайта даже если лента сегодня не соберётся
    try:
        enrich_vault()
    except Exception as e:
        print("Обогащение хранилища не удалось:", e)

    # что уже лежит в хранилище — не предлагать повторно
    vault_keys = set()
    try:
        with open(LINKS_PATH, encoding="utf-8") as f:
            for it in json.load(f).get("items", []):
                k = it.get("url_key") or url_key(clean_url(it.get("url", "")))
                if k:
                    vault_keys.add(k)
    except Exception:
        pass

    fresh = []
    seen = set()
    seen_titles = set()
    rejected = 0
    for batch in (from_github_trending(), from_hackernews(), from_devto(), from_reddit(), from_producthunt()):
        for it in batch:
            key = url_key(it["url"])
            if not key or key in seen or key in vault_keys:
                continue
            text = it.get("title", "") + " " + it.get("description", "")
            topic = match_topic(it["url"], text)
            if not topic:
                rejected += 1
                continue
            nt = norm_title(it["title"])
            if nt and nt in seen_titles:
                continue
            seen.add(key)
            if nt:
                seen_titles.add(nt)
            fresh.append({
                "url": it["url"],
                "url_key": key,
                "canonical_url": it["url"],
                "title": it["title"][:160],
                "title_original": it["title"][:160],
                "description": (it.get("description") or "")[:400],
                "image": it.get("image") or "",
                "media_kind": "image" if it.get("image") else "fallback",
                "source": it["source"],
                "sources": [{"name": it["source"], "url": it["url"]}],
                "source_count": 1,
                "type": detect_type(it["url"]),
                "category": detect_category(it["url"], text),
                "topic": topic[0],
                "topic_name": topic[1],
                "domain": host_of(it["url"]),
                "score": it.get("score") or 0,
                "source_score": it.get("score") or 0,
                "found_at": now_iso,
            })

    # дотягиваем og-данные там, где пусто
    og_done = 0
    for it in fresh:
        if it["description"] and it["image"]:
            continue
        if og_done >= MAX_OG_FETCH:
            break
        og_done += 1
        og = og_fetch(it["url"])
        if og.get("description") and not it["description"]:
            it["description"] = og["description"]
        if og.get("image") and not it["image"]:
            it["image"] = og["image"]
            it["media_kind"] = "image"
    print("og-обход:", og_done)

    # русский контент: AI-обогащение при наличии секретов, иначе правильный перевод
    ai_used = 0
    for it in fresh:
        out = ai_enrich(it)
        if out and ru_text_ok(out.get("summary_ru")) and (out.get("title_ru") or "").strip():
            it["title_ru"] = clean_text(out["title_ru"])[:160]
            it["summary_ru"] = clean_text(out["summary_ru"])[:600]
            it["why_it_matters_ru"] = clean_text(out.get("why_it_matters_ru") or "")[:900]
            uc = out.get("use_cases_ru") or []
            it["use_cases_ru"] = [clean_text(x)[:60] for x in uc if x][:4] if isinstance(uc, list) else []
            cv = out.get("caveats_ru") or []
            if isinstance(cv, str):
                cv = [cv] if cv.strip() else []
            it["caveats_ru"] = [clean_text(x)[:200] for x in cv if x][:3]
            it["translation_status"] = "reviewed"
            it["description_ru"] = it["summary_ru"][:240]
            ai_used += 1
            continue
        # fallback без AI: перевод + жёсткая проверка результата
        title_src = it.get("title") or ""
        desc_src = it.get("description") or ""
        if it.get("type") == "github":
            # имя репозитория не переводим
            it["title_ru"] = title_src
        else:
            tr_t = translate_ru(title_src) if needs_ru(title_src) else title_src
            it["title_ru"] = clean_text(tr_t)[:160] if tr_t else title_src
        summary = ""
        if desc_src:
            summary = translate_ru(desc_src) if needs_ru(desc_src) else desc_src
        summary = clean_text(summary)
        if ru_text_ok(summary):
            it["summary_ru"] = summary[:600]
            it["description_ru"] = summary[:240]
            it["translation_status"] = "reviewed" if not needs_ru(desc_src) else "generated"
        else:
            it["summary_ru"] = ""
            it["description_ru"] = ""
            it["translation_status"] = "failed"
        it.setdefault("why_it_matters_ru", "")
        it.setdefault("use_cases_ru", [])
        it.setdefault("caveats_ru", [])
    print("AI-обогащено:", ai_used)

    # quality gate + оценка
    ready = []
    for it in fresh:
        if not publishable(it):
            rejected += 1
            continue
        it["content_status"] = "ready"
        it["quality_score"] = quality_score(it, now)
        if it["quality_score"] < MIN_QUALITY:
            rejected += 1
            continue
        it["published_at"] = now_iso
        ready.append(it)

    # старые записи ленты: держим неделю, не дублируя свежие; только прошедшие gate
    old = []
    try:
        with open(FEED_PATH, encoding="utf-8") as f:
            old = json.load(f).get("items", [])
    except Exception:
        old = []
    cutoff = (now - timedelta(days=MAX_AGE_DAYS)).isoformat()
    kept = []
    for it in old:
        k = it.get("url_key") or ""
        if not k or k in seen or k in vault_keys:
            continue
        if str(it.get("found_at") or "") < cutoff:
            continue
        if it.get("version2") is not True and not it.get("summary_ru"):
            # старые v1-записи без summary_ru доживают максимум до конца окна,
            # но в новую ленту попадают только если проходят gate по теме
            if not it.get("topic"):
                topic = match_topic(it.get("url", ""), (it.get("title", "") + " " + it.get("description", "")))
                if not topic:
                    continue
                it["topic"] = topic[0]
                it["topic_name"] = topic[1]
        seen.add(k)
        kept.append(it)

    items = ready + kept
    items.sort(key=lambda x: (x.get("quality_score") or 0, str(x.get("found_at") or "")), reverse=True)
    items = items[:MAX_ITEMS]

    if not items:
        print("ВНИМАНИЕ: собралось 0 карточек — ленту НЕ перезаписываю, оставляю прошлую.")
        sys.exit(1)

    payload = {
        "version": 2,
        "updated_at": now_iso,
        "meta": {"fresh": len(ready), "rejected": rejected, "ai": ai_used},
        "items": items,
    }
    with open(FEED_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print("Лента v2: всего", len(items), "| новых:", len(ready), "| отсеяно:", rejected, "| AI:", ai_used)


if __name__ == "__main__":
    main()
