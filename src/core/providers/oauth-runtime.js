"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { providerStatus, upsertProviderConnection } = require("./provider-settings-store");
const { normalizeCatalogProvider, knownProvider } = require("./provider-catalog");

const DEFAULT_SCOPES = {
  claude: "org:create_api_key user:profile user:inference",
  codex: "openid profile email offline_access",
  github: "read:user",
  gitlab: "api read_user",
  antigravity:
    "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs",
  "gemini-cli":
    "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
  qwen: "openid profile email model.completion"
};

const PUBLIC_OAUTH_CLIENTS = {
  claude: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  codex: "app_EMoamEEZ73f0CkXaXp7hrann",
  github: "Iv1.b507a08c87ecfe98",
  "gemini-cli": "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
  qwen: "f0304373b74a44d2b584a3fb70ca9e56",
  "kimi-coding": "17e5f671-d194-4dfb-9706-5516cb48c098"
};

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createPkce() {
  const codeVerifier = base64url(crypto.randomBytes(48));
  const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

function providerEnvKey(provider) {
  return String(provider || "")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function stringFrom(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

let localEnvCache = {
  filePath: "",
  mtimeMs: -1,
  values: {}
};

function parseEnvFile(text) {
  const values = {};
  String(text || "")
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return;
      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      if (!key) return;
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      values[key] = value.replace(/\\n/g, "\n");
    });
  return values;
}

function readLocalEnvValues() {
  if (process.env.AGENT_ROUTE_DISABLE_LOCAL_ENV === "1") return {};
  const filePath = path.join(process.cwd(), ".env.local");
  try {
    const stat = fs.statSync(filePath);
    if (localEnvCache.filePath === filePath && localEnvCache.mtimeMs === stat.mtimeMs) return localEnvCache.values;
    const values = parseEnvFile(fs.readFileSync(filePath, "utf8"));
    localEnvCache = { filePath, mtimeMs: stat.mtimeMs, values };
    return values;
  } catch {
    localEnvCache = { filePath, mtimeMs: -1, values: {} };
    return {};
  }
}

function envValue(key) {
  return stringFrom(process.env[key], readLocalEnvValues()[key]);
}

function readQuery(searchParams, key) {
  if (!searchParams || typeof searchParams.get !== "function") return "";
  return searchParams.get(key) || "";
}

function normalizeMeta(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function response(status, body) {
  return {
    status,
    body: {
      valid: status >= 200 && status < 300,
      ...body
    }
  };
}

function error(status, provider, action, message, code = "oauth_error", extra = {}) {
  return response(status, {
    provider,
    action,
    error: message,
    code,
    ...extra
  });
}

function providerBaseUrl(provider, meta = {}) {
  if (provider === "gitlab")
    return stringFrom(meta.baseUrl, meta.instanceUrl, "https://gitlab.com").replace(/\/+$/g, "");
  return "";
}

function defaultOAuthConfig(provider, meta = {}) {
  const baseUrl = providerBaseUrl(provider, meta);
  if (provider === "claude") {
    return {
      clientId: PUBLIC_OAUTH_CLIENTS.claude,
      authorizationUrl: "https://claude.ai/oauth/authorize",
      tokenUrl: "https://api.anthropic.com/v1/oauth/token",
      scope: DEFAULT_SCOPES.claude
    };
  }
  if (provider === "codex") {
    return {
      clientId: PUBLIC_OAUTH_CLIENTS.codex,
      authorizationUrl: "https://auth.openai.com/oauth/authorize",
      tokenUrl: "https://auth.openai.com/oauth/token",
      scope: DEFAULT_SCOPES.codex,
      extraParams: {
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: "codex_cli_rs"
      }
    };
  }
  if (provider === "github") {
    return {
      clientId: PUBLIC_OAUTH_CLIENTS.github,
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      deviceCodeUrl: "https://github.com/login/device/code",
      scope: DEFAULT_SCOPES.github
    };
  }
  if (provider === "gemini-cli") {
    return {
      clientId: PUBLIC_OAUTH_CLIENTS["gemini-cli"],
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scope: DEFAULT_SCOPES["gemini-cli"],
      requiresClientSecret: true,
      extraParams: {
        access_type: "offline",
        prompt: "consent"
      }
    };
  }
  if (provider === "antigravity") {
    return {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scope: DEFAULT_SCOPES.antigravity,
      requiresClientSecret: true,
      extraParams: {
        access_type: "offline",
        prompt: "consent"
      }
    };
  }
  if (provider === "qwen") {
    return {
      clientId: PUBLIC_OAUTH_CLIENTS.qwen,
      deviceCodeUrl: "https://chat.qwen.ai/api/v1/oauth2/device/code",
      tokenUrl: "https://chat.qwen.ai/api/v1/oauth2/token",
      scope: DEFAULT_SCOPES.qwen
    };
  }
  if (provider === "kimi-coding") {
    return {
      clientId: PUBLIC_OAUTH_CLIENTS["kimi-coding"],
      deviceCodeUrl: "https://auth.kimi.com/api/oauth/device_authorization",
      tokenUrl: "https://auth.kimi.com/api/oauth/token"
    };
  }
  if (provider === "gitlab") {
    return {
      authorizationUrl: `${baseUrl}/oauth/authorize`,
      tokenUrl: `${baseUrl}/oauth/token`,
      scope: DEFAULT_SCOPES.gitlab
    };
  }
  return {
    scope: DEFAULT_SCOPES[provider] || ""
  };
}

function oauthConfig(provider, { body = {}, searchParams = new URLSearchParams() } = {}) {
  const normalizedProvider = normalizeCatalogProvider(provider);
  const envKey = providerEnvKey(normalizedProvider);
  const meta = normalizeMeta(body.meta || body.oauthMeta || body.providerMeta);
  const queryMeta = {
    ...meta,
    baseUrl: stringFrom(meta.baseUrl, readQuery(searchParams, "baseUrl"), readQuery(searchParams, "instanceUrl")),
    instanceUrl: stringFrom(meta.instanceUrl, readQuery(searchParams, "instanceUrl"))
  };
  const defaults = defaultOAuthConfig(normalizedProvider, queryMeta);
  const redirectUri = stringFrom(body.redirectUri, body.redirect_uri, readQuery(searchParams, "redirect_uri"));
  return {
    provider: normalizedProvider,
    clientId: stringFrom(
      meta.clientId,
      meta.client_id,
      body.clientId,
      body.client_id,
      readQuery(searchParams, "clientId"),
      readQuery(searchParams, "client_id"),
      envValue(`AGENT_ROUTE_OAUTH_${envKey}_CLIENT_ID`),
      defaults.clientId
    ),
    clientSecret: stringFrom(
      meta.clientSecret,
      meta.client_secret,
      body.clientSecret,
      body.client_secret,
      envValue(`AGENT_ROUTE_OAUTH_${envKey}_CLIENT_SECRET`)
    ),
    authorizationUrl: stringFrom(
      meta.authorizationUrl,
      meta.authorization_url,
      meta.authUrl,
      body.authorizationUrl,
      body.authorization_url,
      readQuery(searchParams, "authorizationUrl"),
      readQuery(searchParams, "authorization_url"),
      envValue(`AGENT_ROUTE_OAUTH_${envKey}_AUTHORIZE_URL`),
      defaults.authorizationUrl
    ),
    tokenUrl: stringFrom(
      meta.tokenUrl,
      meta.token_url,
      body.tokenUrl,
      body.token_url,
      envValue(`AGENT_ROUTE_OAUTH_${envKey}_TOKEN_URL`),
      defaults.tokenUrl
    ),
    deviceCodeUrl: stringFrom(
      meta.deviceCodeUrl,
      meta.device_code_url,
      body.deviceCodeUrl,
      body.device_code_url,
      envValue(`AGENT_ROUTE_OAUTH_${envKey}_DEVICE_CODE_URL`),
      defaults.deviceCodeUrl
    ),
    scope: stringFrom(
      meta.scope,
      body.scope,
      readQuery(searchParams, "scope"),
      envValue(`AGENT_ROUTE_OAUTH_${envKey}_SCOPE`),
      defaults.scope
    ),
    audience: stringFrom(meta.audience, body.audience, envValue(`AGENT_ROUTE_OAUTH_${envKey}_AUDIENCE`)),
    redirectUri,
    meta,
    extraParams: defaults.extraParams || {},
    requiresClientSecret: Boolean(defaults.requiresClientSecret)
  };
}

function missingConfig(provider, action, missing) {
  return error(
    400,
    provider,
    action,
    `OAuth ${provider} 缺少必要配置：${missing.join("、")}。请在环境变量 AGENT_ROUTE_OAUTH_${providerEnvKey(
      provider
    )}_* 中配置，或由前端授权参数传入。`,
    "oauth_config_missing",
    { missing }
  );
}

function ensureKnownProvider(provider) {
  const normalizedProvider = normalizeCatalogProvider(provider);
  if (knownProvider(normalizedProvider)) return normalizedProvider;
  return normalizedProvider;
}

function buildAuthorizeUrl(config, state, codeChallenge) {
  const url = new URL(config.authorizationUrl);
  url.searchParams.set("client_id", config.clientId);
  if (config.redirectUri) url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (config.scope) url.searchParams.set("scope", config.scope);
  if (config.audience) url.searchParams.set("audience", config.audience);
  Object.entries(config.extraParams || {}).forEach(([key, value]) => {
    const text = String(value || "").trim();
    if (text) url.searchParams.set(key, text);
  });
  return url.toString();
}

async function parseFetchJson(fetchResponse) {
  const text = await fetchResponse.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

async function postOAuthForm(url, fields, { acceptJson = true } = {}) {
  const form = new URLSearchParams();
  Object.entries(fields).forEach(([key, value]) => {
    const text = String(value || "").trim();
    if (text) form.set(key, text);
  });
  const timeoutMs = Math.max(1000, Number(process.env.AGENT_ROUTE_OAUTH_FETCH_TIMEOUT_MS || 15000));
  const fetchResponse = await fetch(url, {
    method: "POST",
    headers: {
      Accept: acceptJson ? "application/json" : "*/*",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form.toString(),
    signal:
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(timeoutMs)
        : undefined
  });
  const data = await parseFetchJson(fetchResponse);
  return { ok: fetchResponse.ok, status: fetchResponse.status, data };
}

function tokenExpiresAt(tokenData = {}) {
  if (tokenData.expires_at) return String(tokenData.expires_at);
  const expiresIn = Number(tokenData.expires_in || tokenData.expiresIn || 0);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) return "";
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

function oauthConnectionPayload(provider, tokenData = {}, overrides = {}) {
  const accessToken = stringFrom(
    tokenData.access_token,
    tokenData.accessToken,
    tokenData.api_key,
    tokenData.apiKey,
    overrides.accessToken
  );
  const refreshToken = stringFrom(tokenData.refresh_token, tokenData.refreshToken, overrides.refreshToken);
  const idToken = stringFrom(tokenData.id_token, tokenData.idToken, overrides.idToken);
  const scope = stringFrom(tokenData.scope, overrides.scope);
  return {
    provider,
    name: stringFrom(overrides.name, `${provider} OAuth`),
    email: stringFrom(overrides.email, tokenData.email),
    oauth: {
      accessToken,
      refreshToken,
      idToken,
      tokenType: stringFrom(tokenData.token_type, tokenData.tokenType, "Bearer"),
      scope,
      expiresAt: stringFrom(overrides.expiresAt, tokenExpiresAt(tokenData)),
      providerAuthMethod: stringFrom(overrides.providerAuthMethod, "oauth"),
      machineId: stringFrom(overrides.machineId, tokenData.machineId),
      importedAt: new Date().toISOString()
    },
    testStatus: "manual_review"
  };
}

function saveOAuthProvider(provider, tokenData, overrides = {}) {
  const payload = oauthConnectionPayload(provider, tokenData, overrides);
  return upsertProviderConnection(payload);
}

async function authorize(provider, body, searchParams) {
  const normalizedProvider = ensureKnownProvider(provider);
  const config = oauthConfig(normalizedProvider, { body, searchParams });
  const missing = [];
  if (!config.authorizationUrl) missing.push("authorizationUrl");
  if (!config.clientId) missing.push("clientId");
  if (config.requiresClientSecret && !config.clientSecret) missing.push("clientSecret");
  if (!config.redirectUri) missing.push("redirectUri");
  if (missing.length) return missingConfig(normalizedProvider, "authorize", missing);

  const { codeVerifier, codeChallenge } = createPkce();
  const state = crypto.randomUUID();
  return response(200, {
    provider: normalizedProvider,
    action: "authorize",
    authUrl: buildAuthorizeUrl(config, state, codeChallenge),
    state,
    codeVerifier,
    redirectUri: config.redirectUri,
    scope: config.scope || ""
  });
}

async function exchange(provider, body, searchParams) {
  const normalizedProvider = ensureKnownProvider(provider);
  const config = oauthConfig(normalizedProvider, { body, searchParams });
  const code = stringFrom(body.code);
  const codeVerifier = stringFrom(body.codeVerifier, body.code_verifier);
  const redirectUri = stringFrom(body.redirectUri, body.redirect_uri, config.redirectUri);
  const missing = [];
  if (!config.tokenUrl) missing.push("tokenUrl");
  if (!config.clientId) missing.push("clientId");
  if (config.requiresClientSecret && !config.clientSecret) missing.push("clientSecret");
  if (!code) missing.push("code");
  if (!redirectUri) missing.push("redirectUri");
  if (!codeVerifier) missing.push("codeVerifier");
  if (missing.length) return missingConfig(normalizedProvider, "exchange", missing);

  const result = await postOAuthForm(config.tokenUrl, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: codeVerifier
  });
  if (!result.ok || result.data.error) {
    return error(
      result.status || 400,
      normalizedProvider,
      "exchange",
      result.data.error_description || result.data.error || "OAuth token exchange failed.",
      result.data.error || "oauth_exchange_failed"
    );
  }
  const status = saveOAuthProvider(normalizedProvider, result.data, {
    providerAuthMethod: "authorization_code",
    scope: config.scope
  });
  return response(200, {
    provider: normalizedProvider,
    action: "exchange",
    success: true,
    providerSettings: status
  });
}

async function deviceCode(provider, body, searchParams) {
  const normalizedProvider = ensureKnownProvider(provider);
  const config = oauthConfig(normalizedProvider, { body, searchParams });
  const missing = [];
  if (!config.deviceCodeUrl) missing.push("deviceCodeUrl");
  if (!config.clientId) missing.push("clientId");
  if (missing.length) return missingConfig(normalizedProvider, "device-code", missing);

  const { codeVerifier, codeChallenge } = createPkce();
  const result = await postOAuthForm(config.deviceCodeUrl, {
    client_id: config.clientId,
    scope: config.scope,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  });
  if (!result.ok || result.data.error) {
    return error(
      result.status || 400,
      normalizedProvider,
      "device-code",
      result.data.error_description || result.data.error || "OAuth device code request failed.",
      result.data.error || "oauth_device_code_failed"
    );
  }
  return response(200, {
    provider: normalizedProvider,
    action: "device-code",
    ...result.data,
    codeVerifier
  });
}

async function poll(provider, body, searchParams) {
  const normalizedProvider = ensureKnownProvider(provider);
  const config = oauthConfig(normalizedProvider, { body, searchParams });
  const deviceCodeValue = stringFrom(body.deviceCode, body.device_code);
  const missing = [];
  if (!config.tokenUrl) missing.push("tokenUrl");
  if (!config.clientId) missing.push("clientId");
  if (!deviceCodeValue) missing.push("deviceCode");
  if (missing.length) return missingConfig(normalizedProvider, "poll", missing);

  const result = await postOAuthForm(config.tokenUrl, {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceCodeValue,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: body.codeVerifier || body.code_verifier
  });
  if (result.data.error) {
    return response(200, {
      provider: normalizedProvider,
      action: "poll",
      success: false,
      error: result.data.error,
      errorDescription: result.data.error_description || ""
    });
  }
  if (!result.ok || !result.data.access_token) {
    return error(result.status || 400, normalizedProvider, "poll", "OAuth device polling failed.", "oauth_poll_failed");
  }
  const status = saveOAuthProvider(normalizedProvider, result.data, {
    providerAuthMethod: "device_code",
    scope: config.scope
  });
  return response(200, {
    provider: normalizedProvider,
    action: "poll",
    success: true,
    providerSettings: status
  });
}

async function importToken(provider, body) {
  const normalizedProvider = ensureKnownProvider(provider);
  const refreshToken = stringFrom(body.refreshToken, body.refresh_token);
  const accessToken = stringFrom(body.accessToken, body.access_token, body.token);
  if (!refreshToken && !accessToken) {
    return error(400, normalizedProvider, "import", "缺少 accessToken 或 refreshToken。", "oauth_token_required");
  }
  const status = saveOAuthProvider(
    normalizedProvider,
    {},
    {
      providerAuthMethod: "manual_import",
      accessToken,
      refreshToken,
      machineId: stringFrom(body.machineId, body.machine_id),
      name: stringFrom(body.name, `${normalizedProvider} 导入连接`)
    }
  );
  return response(200, {
    provider: normalizedProvider,
    action: "import",
    success: true,
    providerSettings: status
  });
}

async function autoImport(provider) {
  return response(200, {
    provider: normalizeCatalogProvider(provider),
    action: "auto-import",
    found: false,
    error: "当前版本不会自动读取本机应用 token。请手动导入 token，或改用标准 OAuth 授权流程。"
  });
}

async function pat(provider, body) {
  const normalizedProvider = ensureKnownProvider(provider);
  const token = stringFrom(body.token, body.pat, body.accessToken);
  if (!token) return error(400, normalizedProvider, "pat", "缺少 Personal Access Token。", "oauth_token_required");
  const status = saveOAuthProvider(
    normalizedProvider,
    { access_token: token, token_type: "Bearer" },
    {
      providerAuthMethod: "personal_access_token",
      name: `${normalizedProvider} PAT`
    }
  );
  return response(200, {
    provider: normalizedProvider,
    action: "pat",
    success: true,
    providerSettings: status
  });
}

async function cookieExchange(provider, body) {
  const normalizedProvider = ensureKnownProvider(provider);
  const cookie = stringFrom(body.cookie);
  if (!cookie) return error(400, normalizedProvider, "cookie", "缺少 cookie。", "oauth_cookie_required");
  const envKey = providerEnvKey(normalizedProvider);
  const exchangeUrl = process.env[`AGENT_ROUTE_OAUTH_${envKey}_COOKIE_EXCHANGE_URL`];
  if (!exchangeUrl) {
    return error(
      400,
      normalizedProvider,
      "cookie",
      `当前不会直接保存浏览器 cookie。请配置 AGENT_ROUTE_OAUTH_${envKey}_COOKIE_EXCHANGE_URL 用于安全换取 token/API Key，或改用标准 OAuth。`,
      "oauth_cookie_exchange_not_configured"
    );
  }
  const fetchResponse = await fetch(exchangeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cookie })
  });
  const data = await parseFetchJson(fetchResponse);
  if (!fetchResponse.ok || data.error) {
    return error(
      fetchResponse.status || 400,
      normalizedProvider,
      "cookie",
      data.error_description || data.error || "Cookie exchange failed.",
      data.error || "oauth_cookie_exchange_failed"
    );
  }
  const status = saveOAuthProvider(normalizedProvider, data, {
    providerAuthMethod: "cookie_exchange",
    name: `${normalizedProvider} Cookie Exchange`
  });
  return response(200, {
    provider: normalizedProvider,
    action: "cookie",
    success: true,
    providerSettings: status
  });
}

async function socialAuthorize(provider, body, searchParams) {
  const socialProvider = stringFrom(body.provider, readQuery(searchParams, "provider"));
  const meta = { ...(body.meta || {}), socialProvider };
  return authorize(provider, { ...body, meta }, searchParams);
}

async function socialExchange(provider, body, searchParams) {
  return exchange(provider, { ...body, meta: { ...(body.meta || {}), socialProvider: body.provider } }, searchParams);
}

async function startProxy(provider) {
  return response(200, {
    provider: normalizeCatalogProvider(provider),
    action: "start-proxy",
    success: false,
    serverSide: false,
    error: "本地 OAuth callback proxy 尚未启用；请使用手动回调 URL 粘贴方式完成授权。"
  });
}

async function pollStatus(provider) {
  return response(200, {
    provider: normalizeCatalogProvider(provider),
    action: "poll-status",
    status: "pending"
  });
}

async function stopProxy(provider) {
  return response(200, {
    provider: normalizeCatalogProvider(provider),
    action: "stop-proxy",
    success: true
  });
}

async function handleOAuthRequest({
  method = "GET",
  provider,
  action,
  body = {},
  searchParams = new URLSearchParams()
}) {
  void method;
  const normalizedProvider = normalizeCatalogProvider(provider);
  const normalizedAction = String(action || "")
    .trim()
    .toLowerCase();
  try {
    if (normalizedAction === "authorize") return authorize(normalizedProvider, body, searchParams);
    if (normalizedAction === "exchange") return exchange(normalizedProvider, body, searchParams);
    if (normalizedAction === "device-code") return deviceCode(normalizedProvider, body, searchParams);
    if (normalizedAction === "poll") return poll(normalizedProvider, body, searchParams);
    if (normalizedAction === "import") return importToken(normalizedProvider, body);
    if (normalizedAction === "auto-import") return autoImport(normalizedProvider);
    if (normalizedAction === "pat") return pat(normalizedProvider, body);
    if (normalizedAction === "cookie") return cookieExchange(normalizedProvider, body);
    if (normalizedAction === "social-authorize") return socialAuthorize(normalizedProvider, body, searchParams);
    if (normalizedAction === "social-exchange") return socialExchange(normalizedProvider, body, searchParams);
    if (normalizedAction === "start-proxy") return startProxy(normalizedProvider, body, searchParams);
    if (normalizedAction === "poll-status") return pollStatus(normalizedProvider, body, searchParams);
    if (normalizedAction === "stop-proxy") return stopProxy(normalizedProvider, body, searchParams);
    if (normalizedAction === "status") {
      return response(200, {
        provider: normalizedProvider,
        action: "status",
        providerSettings: providerStatus()
      });
    }
    return error(
      404,
      normalizedProvider,
      normalizedAction,
      `未知 OAuth action：${normalizedAction}`,
      "oauth_action_not_found"
    );
  } catch (err) {
    return error(
      500,
      normalizedProvider,
      normalizedAction,
      err && err.message ? err.message : String(err),
      err && err.code ? err.code : "oauth_internal_error"
    );
  }
}

module.exports = {
  createPkce,
  handleOAuthRequest,
  oauthConfig,
  saveOAuthProvider
};
