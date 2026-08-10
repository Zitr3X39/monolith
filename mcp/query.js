/* MONOLITH — сжатие запроса для поиска снаружи.
   =========================================================================
   GitHub и npm ищут по словам, а не по человеческим фразам. Если отдать им
   целое предложение, да ещё по-русски, они честно вернут ноль находок.
   Поэтому длинный вопрос ужимаем до нескольких сильных слов на латинице,
   а всё служебное выбрасываем. Поиск по хранилищу это не трогает.
   ========================================================================= */

const STOP = new Set([
  "для", "и", "или", "а", "но", "что", "чтобы", "чтоб", "как", "всё", "все", "это", "этот", "эта",
  "мне", "меня", "мой", "моя", "мои", "он", "она", "оно", "они", "там", "тут", "же", "бы", "ли",
  "не", "на", "в", "во", "с", "со", "по", "из", "от", "до", "за", "при", "про", "под", "над", "без",
  "через", "между", "тп", "тд", "типа", "какие", "какой", "какая", "какое", "нибудь", "какие-то",
  "нужно", "надо", "хочу", "можешь", "найди", "найти", "поищи", "покажи", "дай", "есть", "быть",
  "самый", "самые", "лучший", "лучшие", "хороший", "хорошие", "новый", "новые", "просто", "ещё", "еще",
  "the", "a", "an", "and", "or", "for", "with", "to", "of", "in", "on", "at", "by", "from", "is", "are",
  "my", "me", "i", "you", "it", "this", "that", "some", "any", "find", "search", "show", "give", "need",
  "want", "can", "best", "good", "new", "just", "about", "how", "what", "which", "please"
]);

const MAP = {
  "геймдев": "gamedev", "игра": "game", "игры": "game", "игр": "game", "игру": "game", "игровой": "game",
  "скилл": "skill", "скиллы": "skill", "навык": "skill", "навыки": "skill",
  "агент": "agent", "агенты": "agent", "сервер": "server", "поиск": "search", "искать": "search",
  "память": "memory", "редактор": "editor", "редактором": "editor", "движок": "engine",
  "нейросеть": "ai", "ии": "ai", "интеллект": "ai", "бот": "bot", "парсер": "parser",
  "видео": "video", "музыка": "music", "звук": "audio", "голос": "voice", "озвучка": "voice",
  "дизайн": "design", "интерфейс": "ui", "анимация": "animation", "картинка": "image",
  "изображение": "image", "текст": "text", "перевод": "translate", "переводчик": "translate",
  "код": "code", "кодинг": "coding", "программа": "app", "приложение": "app",
  "сайт": "site", "страница": "page", "браузер": "browser", "база": "database", "данные": "data",
  "тест": "test", "тесты": "test", "отладка": "debug", "ошибка": "error", "ошибки": "error",
  "документация": "docs", "инструкция": "guide", "гайд": "guide", "шаблон": "template",
  "генерация": "generator", "генератор": "generator", "создание": "create", "создать": "create",
  "автоматизация": "automation", "безопасность": "security", "шифрование": "encryption",
  "телеграм": "telegram", "почта": "mail", "заметки": "notes", "обучение": "learning", "курс": "course",
  "уровень": "level", "уровни": "level", "физика": "physics", "персонаж": "character",
  "камера": "camera", "сцена": "scene", "сцены": "scene", "спрайт": "sprite", "шейдер": "shader",
  "модель": "model", "модели": "model", "мультиплеер": "multiplayer", "сохранение": "save"
};

const LATIN = /^[a-z0-9][a-z0-9+#._-]*$/;
const SPLIT = /[^a-z0-9а-яё+#._-]+/i;

/* Оставляем не больше нескольких сильных слов. Русское слово либо переводим
   по словарю, либо отбрасываем: GitHub по-русски всё равно ничего не найдёт. */
export function compactQuery(input, max) {
  const src = String(input == null ? "" : input);
  const cap = Math.min(Math.max(max || 4, 2), 8);
  const words = src.toLowerCase().split(SPLIT).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const w of words) {
    if (w.length < 2 || STOP.has(w)) continue;
    let t = MAP[w] || (LATIN.test(w) ? w : null);
    for (let cut = 1; cut <= 3 && !t && w.length - cut >= 4; cut++) t = MAP[w.slice(0, -cut)] || null;
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= cap) break;
  }
  return out.length ? out.join(" ") : src.trim();
}

/* Ловим только вызов find_external и подменяем в нём запрос. Всё остальное
   проходит насквозь байт в байт. Кривой JSON не трогаем вовсе. */
export function shrinkToolCall(bodyText) {
  const text = String(bodyText == null ? "" : bodyText);
  if (!text || text.indexOf("find_external") < 0) return text;
  let data;
  try { data = JSON.parse(text); } catch (e) { return text; }
  let touched = false;
  const fix = (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.method !== "tools/call") return;
    const p = msg.params;
    if (!p || p.name !== "find_external") return;
    const a = p.arguments;
    if (!a || typeof a.query !== "string") return;
    const short = compactQuery(a.query, 4);
    if (short && short !== a.query) { a.query = short; touched = true; }
  };
  if (Array.isArray(data)) data.forEach(fix); else fix(data);
  return touched ? JSON.stringify(data) : text;
}
