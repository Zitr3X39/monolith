/* MONOLITH MCP — точка входа Worker'а.
   =========================================================================
   Сначала смотрим, не спрашивает ли клиент про подключение (oauth.js).
   Если нет — передаём запрос самому серверу хранилища (worker.js).

   Разделил так нарочно: логика поиска и инструментов в worker.js остаётся
   нетронутой, а всё, что касается входа, живёт отдельно и не мешает.
   ========================================================================= */

import vault from "./worker.js";
import { handleOAuth, checkAuth, CORS } from "./oauth.js";
import { shrinkToolCall } from "./query.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    /* Точки подключения открыты всегда, иначе клиент не сможет даже начать вход. */
    const gateway = await handleOAuth(request, env, url);
    if (gateway) return gateway;

    /* Конец сессии в Streamable HTTP — просто соглашаемся. */
    if (request.method === "DELETE") return new Response(null, { status: 204, headers: CORS });

    /* Проверка здоровья — без проверки доступа, её дёргает сам сайт. */
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if ((request.method === "GET" || request.method === "HEAD") && path === "/health") {
      return await vault.fetch(request, env, ctx);
    }

    /* Адрес открыли в браузере — объясняем, куда его вставлять. */
    if (request.method === "GET" || request.method === "HEAD") {
      return new Response(
        JSON.stringify(
          {
            server: "monolith-vault",
            hint:
              "Это MCP-сервер хранилища MONOLITH. Скопируй этот адрес и вставь в Notion, Claude, Cursor или VS Code как MCP-коннектор, потом нажми Connect.",
            instructions: "https://zitr3x39.github.io/monolith/mcp.html"
          },
          null,
          2
        ),
        { status: 405, headers: Object.assign({ "content-type": "application/json; charset=utf-8" }, CORS) }
      );
    }

    const pass = await checkAuth(request, env);
    if (!pass.ok) {
      return new Response(
        JSON.stringify({
          error:
            "Нужен доступ. Нажми Connect и подтверди подключение, либо добавь заголовок Authorization: Bearer <твой AUTH_TOKEN>."
        }),
        {
          status: 401,
          headers: Object.assign(
            {
              "content-type": "application/json; charset=utf-8",
              "www-authenticate":
                'Bearer realm="MONOLITH", resource_metadata="' +
                url.origin +
                '/.well-known/oauth-protected-resource"'
            },
            CORS
          )
        }
      );
    }

    if (request.method !== "POST") return await vault.fetch(request, env, ctx);

    /* Тело читаем один раз. По пути ужимаем длинный человеческий вопрос для
       поиска снаружи — иначе GitHub и npm вернут пустоту. И, если вошли по
       кнопке Connect, а на сервере стоит статический пароль, подставляем его,
       чтобы старая проверка внутри worker.js тоже пропустила. */
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    if (pass.via === "oauth" && env && env.AUTH_TOKEN) {
      headers.set("authorization", "Bearer " + String(env.AUTH_TOKEN));
    }
    const body = shrinkToolCall(await request.text());
    return await vault.fetch(new Request(request.url, { method: "POST", headers, body }), env, ctx);
  }
};
