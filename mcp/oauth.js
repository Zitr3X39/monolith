/* MONOLITH MCP — подключение одной кнопкой (OAuth 2.1 + DCR)
   =========================================================================
   Зачем этот файл. Notion (а также Claude, Cursor, VS Code) при добавлении
   MCP-сервера сначала пытается зарегистрироваться сам — по RFC 7591.
   Если сервер так не умеет, Notion пишет «Failed to set up OAuth client
   registration», и кнопка Connect молча ничего не делает. Именно это и было.

   Что здесь есть:
     GET  /.well-known/oauth-protected-resource   — «я защищённый ресурс» (RFC 9728)
     GET  /.well-known/oauth-authorization-server — где брать код и токен (RFC 8414)
     POST /register                               — клиент регистрируется сам (RFC 7591)
     GET  /authorize                              — экран «Подключить»
     POST /token                                  — обмен кода на токен (PKCE S256)
     POST /revoke                                 — отключение

   Состояние нигде не хранится: и код, и токен — это подписанные HMAC-SHA256
   строки со сроком годности внутри. Ни базы, ни KV не нужно. Хранилище
   открыто на чтение, поэтому вход подтверждается одной кнопкой, без паролей.
   Если позже появится AUTH_TOKEN — работает и он, и OAuth одновременно.
   ========================================================================= */

const SITE = "https://zitr3x39.github.io/monolith/";
const SERVER_NAME = "monolith-vault";
const OWNER = "Zitr3X39";

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers":
    "content-type, authorization, mcp-session-id, mcp-protocol-version, accept, last-event-id, x-requested-with",
  "access-control-expose-headers": "mcp-session-id, www-authenticate",
  "access-control-max-age": "86400"
};

const OAUTH = {
  codeTtl: 10 * 60 * 1000,
  accessTtl: 30 * 24 * 60 * 60 * 1000,
  refreshTtl: 365 * 24 * 60 * 60 * 1000,
  scopes: ["mcp", "read", "write"]
};

const TE = new TextEncoder();
const TD = new TextDecoder();

function b64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function packJson(obj) {
  return b64url(TE.encode(JSON.stringify(obj)));
}

function unpackJson(s) {
  try {
    return JSON.parse(TD.decode(unb64url(s)));
  } catch (e) {
    return null;
  }
}

function signingSecret(env) {
  if (env && env.OAUTH_SECRET) return String(env.OAUTH_SECRET);
  if (env && env.AUTH_TOKEN) return "tok:" + String(env.AUTH_TOKEN);
  return SERVER_NAME + "::" + OWNER + "::monolith-oauth-v1";
}

async function signKey(env) {
  return await crypto.subtle.importKey(
    "raw",
    TE.encode(signingSecret(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function mint(env, payload, ttl) {
  const now = Date.now();
  const head = packJson(Object.assign({}, payload, { iat: now, exp: now + ttl }));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await signKey(env), TE.encode(head)));
  return head + "." + b64url(sig);
}

async function openToken(env, token, kind) {
  if (typeof token !== "string" || !token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const head = token.slice(0, dot);
  let sig;
  try {
    sig = unb64url(token.slice(dot + 1));
  } catch (e) {
    return null;
  }
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", await signKey(env), sig, TE.encode(head));
  } catch (e) {
    ok = false;
  }
  if (!ok) return null;
  const body = unpackJson(head);
  if (!body || typeof body !== "object") return null;
  if (kind && body.k !== kind) return null;
  if (!body.exp || Date.now() > body.exp) return null;
  return body;
}

async function pkceOk(challenge, verifier, method) {
  if (!challenge) return true;
  if (!verifier) return false;
  const m = (method || "plain").toUpperCase();
  if (m === "PLAIN") return verifier === challenge;
  const dig = new Uint8Array(await crypto.subtle.digest("SHA-256", TE.encode(verifier)));
  return b64url(dig) === challenge;
}

function randomId(prefix) {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return (prefix || "") + s;
}

const BAD_SCHEMES = ["javascript:", "data:", "file:", "vbscript:", "blob:"];

function safeRedirect(uri) {
  if (typeof uri !== "string" || !uri) return null;
  let u;
  try {
    u = new URL(uri);
  } catch (e) {
    return null;
  }
  if (BAD_SCHEMES.indexOf(u.protocol) >= 0) return null;
  if (u.protocol === "https:") return u;
  if (u.protocol === "http:") {
    const h = u.hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1" ? u : null;
  }
  return u;
}

function oauthAuthMeta(origin) {
  return {
    issuer: origin,
    authorization_endpoint: origin + "/authorize",
    token_endpoint: origin + "/token",
    registration_endpoint: origin + "/register",
    revocation_endpoint: origin + "/revoke",
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256", "plain"],
    scopes_supported: OAUTH.scopes,
    service_documentation: SITE + "mcp.html",
    ui_locales_supported: ["ru", "en"]
  };
}

function oauthResourceMeta(origin) {
  return {
    resource: origin,
    resource_name: "MONOLITH — хранилище и умный поиск",
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: OAUTH.scopes,
    resource_documentation: SITE + "mcp.html"
  };
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SHELL_CSS = [
  ":root{--bg:#0a0b0e;--card:#111318;--line:rgba(255,255,255,.09);--tx:#f4f3f0;--tx2:#a8adbc;--tx3:#6e7488;--acc:#5aa9ff;--mint:#22d3a7;--red:#ff8b7a}",
  "@media(prefers-color-scheme:light){:root{--bg:#f7f5f0;--card:#fff;--line:rgba(20,22,30,.10);--tx:#14161c;--tx2:#565c6b;--tx3:#858b9b}}",
  "*{box-sizing:border-box}",
  "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--bg);color:var(--tx);font:400 15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Arial,sans-serif}",
  ".card{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px 26px 22px}",
  ".mark{display:flex;align-items:center;gap:10px;margin-bottom:20px}",
  ".dot{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,var(--acc),var(--mint))}",
  ".mark b{font-size:14px;letter-spacing:.14em;text-transform:uppercase;color:var(--tx2);font-weight:600}",
  "h1{margin:0 0 8px;font-size:23px;line-height:1.25;letter-spacing:-.01em}",
  "p{margin:0 0 16px;color:var(--tx2)}",
  ".who{display:inline-block;color:var(--tx);font-weight:600}",
  "ul{margin:0 0 22px;padding:0;list-style:none}",
  "li{display:flex;gap:10px;padding:9px 0;border-top:1px solid var(--line);color:var(--tx2);font-size:14px}",
  "li:last-child{border-bottom:1px solid var(--line)}",
  "li i{font-style:normal;color:var(--mint)}",
  "li.no i{color:var(--tx3)}",
  ".go{display:flex;align-items:center;justify-content:center;height:52px;border-radius:14px;background:var(--acc);color:#06121f;font-weight:700;font-size:16px;text-decoration:none}",
  ".go:hover{filter:brightness(1.06)}",
  ".back{display:block;margin-top:12px;text-align:center;color:var(--tx3);font-size:13px;text-decoration:none}",
  ".back:hover{color:var(--tx2)}",
  ".bad{color:var(--red)}",
  ".mono{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--tx3);word-break:break-all}"
].join("");

function pageShell(title, inner) {
  return (
    '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>" + esc(title) + "</title><style>" + SHELL_CSS + "</style></head><body>" +
    '<main class="card"><div class="mark"><span class="dot"></span><b>Monolith</b></div>' +
    inner +
    "</main></body></html>"
  );
}

function htmlResponse(html, status) {
  return new Response(html, {
    status: status || 200,
    headers: Object.assign({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, CORS)
  });
}

function consentPage(clientName, href, cancelHref) {
  const who = clientName ? esc(clientName) : "Приложение";
  return pageShell(
    "Подключить MONOLITH",
    "<h1>Подключить хранилище</h1>" +
      '<p><span class="who">' + who + "</span> просит доступ к твоему хранилищу MONOLITH.</p>" +
      "<ul>" +
      "<li><i>+</i><span>Искать и читать твои ссылки и категории</span></li>" +
      "<li><i>+</i><span>Искать похожее снаружи: GitHub, npm, PyPI, статьи</span></li>" +
      '<li class="no"><i>—</i><span>Добавлять ссылки — только когда ты разрешишь отдельно</span></li>' +
      "</ul>" +
      '<a class="go" href="' + esc(href) + '">Подключить</a>' +
      (cancelHref ? '<a class="back" href="' + esc(cancelHref) + '">Отмена</a>' : "")
  );
}

function oauthErrorPage(text, detail) {
  return pageShell(
    "Не получилось подключить",
    '<h1 class="bad">Не получилось подключить</h1><p>' +
      esc(text) +
      "</p>" +
      (detail ? '<p class="mono">' + esc(detail) + "</p>" : "") +
      '<a class="go" href="' + SITE + 'mcp.html">Как подключать</a>'
  );
}

async function readParams(request, url) {
  const params = new URLSearchParams(url.search);
  if (request.method === "POST") {
    const ct = (request.headers.get("content-type") || "").toLowerCase();
    try {
      if (ct.indexOf("application/json") >= 0) {
        const b = await request.json();
        if (b && typeof b === "object") {
          for (const k of Object.keys(b)) if (b[k] != null) params.set(k, String(b[k]));
        }
      } else {
        const t = await request.text();
        const f = new URLSearchParams(t);
        f.forEach((v, k) => params.set(k, v));
      }
    } catch (e) {
      /* пустое тело — не беда */
    }
  }
  return params;
}

/* Возвращает ответ, если адрес относится к авторизации, иначе null. */
export async function handleOAuth(request, env, url) {
  const origin = url.origin;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const pub = (body, status, extra) =>
    new Response(JSON.stringify(body, null, 2), {
      status: status || 200,
      headers: Object.assign(
        { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        CORS,
        extra || {}
      )
    });

  if (path.indexOf("/.well-known/oauth-authorization-server") === 0 || path === "/.well-known/openid-configuration") {
    return pub(oauthAuthMeta(origin));
  }
  if (path.indexOf("/.well-known/oauth-protected-resource") === 0) {
    return pub(oauthResourceMeta(origin));
  }

  if (path === "/register") {
    if (request.method !== "POST") return pub({ error: "invalid_request", error_description: "Нужен POST." }, 405);
    let body = {};
    try {
      body = await request.json();
    } catch (e) {
      body = {};
    }
    const redirects = Array.isArray(body && body.redirect_uris)
      ? body.redirect_uris.filter((x) => typeof x === "string")
      : [];
    return pub(
      {
        client_id: randomId("mono_"),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name:
          body && typeof body.client_name === "string" && body.client_name ? body.client_name : "MCP client",
        redirect_uris: redirects,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: OAUTH.scopes.join(" ")
      },
      201
    );
  }

  if (path === "/authorize") {
    if (request.method !== "GET" && request.method !== "POST") {
      return htmlResponse(oauthErrorPage("Этот адрес открывается браузером.", request.method), 405);
    }
    const p = await readParams(request, url);
    const target = safeRedirect(p.get("redirect_uri") || "");
    if (!target) {
      return htmlResponse(
        oauthErrorPage(
          "Приложение прислало неверный адрес возврата. Попробуй подключить заново.",
          p.get("redirect_uri") || "redirect_uri пустой"
        ),
        400
      );
    }
    const state = p.get("state") || "";
    const rt = p.get("response_type") || "code";
    if (rt !== "code") {
      const bad = new URL(target.href);
      bad.searchParams.set("error", "unsupported_response_type");
      if (state) bad.searchParams.set("state", state);
      return new Response(null, {
        status: 302,
        headers: Object.assign({ location: bad.href, "cache-control": "no-store" }, CORS)
      });
    }
    const code = await mint(
      env,
      {
        k: "code",
        cc: p.get("code_challenge") || "",
        cm: p.get("code_challenge_method") || "",
        ru: p.get("redirect_uri") || "",
        sc: p.get("scope") || OAUTH.scopes.join(" "),
        cl: p.get("client_id") || "",
        rs: p.get("resource") || origin
      },
      OAUTH.codeTtl
    );
    const back = new URL(target.href);
    back.searchParams.set("code", code);
    if (state) back.searchParams.set("state", state);

    if ((p.get("prompt") || "") === "none" || p.get("approve") === "1") {
      return new Response(null, {
        status: 302,
        headers: Object.assign({ location: back.href, "cache-control": "no-store" }, CORS)
      });
    }
    const cancel = new URL(target.href);
    cancel.searchParams.set("error", "access_denied");
    if (state) cancel.searchParams.set("state", state);
    return htmlResponse(consentPage(p.get("client_name") || "", back.href, cancel.href));
  }

  if (path === "/token") {
    if (request.method !== "POST") return pub({ error: "invalid_request", error_description: "Нужен POST." }, 405);
    const f = await readParams(request, url);
    const grant = f.get("grant_type") || "";

    if (grant === "authorization_code") {
      const code = await openToken(env, f.get("code") || "", "code");
      if (!code) {
        return pub(
          { error: "invalid_grant", error_description: "Код устарел или неверный. Нажми «Подключить» ещё раз." },
          400
        );
      }
      const ru = f.get("redirect_uri");
      if (ru && code.ru && ru !== code.ru) {
        return pub({ error: "invalid_grant", error_description: "Адрес возврата не совпадает с тем, что был при входе." }, 400);
      }
      if (!(await pkceOk(code.cc, f.get("code_verifier") || "", code.cm))) {
        return pub({ error: "invalid_grant", error_description: "Проверка PKCE не прошла." }, 400);
      }
      const scope = code.sc || OAUTH.scopes.join(" ");
      return pub({
        access_token: await mint(env, { k: "at", sc: scope, cl: code.cl }, OAUTH.accessTtl),
        token_type: "Bearer",
        expires_in: Math.floor(OAUTH.accessTtl / 1000),
        refresh_token: await mint(env, { k: "rt", sc: scope, cl: code.cl }, OAUTH.refreshTtl),
        scope: scope
      });
    }

    if (grant === "refresh_token") {
      const old = await openToken(env, f.get("refresh_token") || "", "rt");
      if (!old) return pub({ error: "invalid_grant", error_description: "Ключ обновления устарел. Подключи заново." }, 400);
      const scope = f.get("scope") || old.sc || OAUTH.scopes.join(" ");
      return pub({
        access_token: await mint(env, { k: "at", sc: scope, cl: old.cl }, OAUTH.accessTtl),
        token_type: "Bearer",
        expires_in: Math.floor(OAUTH.accessTtl / 1000),
        refresh_token: await mint(env, { k: "rt", sc: scope, cl: old.cl }, OAUTH.refreshTtl),
        scope: scope
      });
    }

    return pub(
      { error: "unsupported_grant_type", error_description: "Поддерживаются authorization_code и refresh_token." },
      400
    );
  }

  if (path === "/revoke") {
    if (request.method !== "POST") return pub({ error: "invalid_request" }, 405);
    return pub({});
  }

  return null;
}

/* Кто стучится: свой статический ключ, токен из OAuth или открытое чтение. */
export async function checkAuth(request, env) {
  const raw = (request.headers.get("authorization") || "").trim();
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  const tok = m ? m[1].trim() : "";
  if (env && env.AUTH_TOKEN && tok && tok === String(env.AUTH_TOKEN)) return { ok: true, via: "token" };
  if (tok) {
    const at = await openToken(env, tok, "at");
    if (at) return { ok: true, via: "oauth", scope: at.sc };
  }
  if (!(env && env.AUTH_TOKEN)) return { ok: true, via: "open" };
  return { ok: false };
}
