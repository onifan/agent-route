"use strict";

const fs = require("fs");
const { agentRoutePath } = require("../../shared/utils/agent-home");
const { corsHeaders } = require("../../security/cors");
const { checkRequestAuth } = require("../../security/request-auth");

let localApiKeyCache = { expiresAt: 0, key: "" };
let providerDbCache = {
  expiresAt: 0,
  dbPath: "",
  snapshot: { settings: {}, connections: [], providerNodes: [], modelAliases: {} }
};

const OPENAI_COMPAT_PROVIDER_TARGETS = {
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    modelPrefix: "openrouter/",
    headers: () => ({
      "HTTP-Referer": envValue("AGENT_ROUTE_PUBLIC_URL") || "http://localhost:20128",
      "X-Title": "AgentRoute Studio"
    })
  },
  openai: {
    url: "https://api.openai.com/v1/chat/completions",
    modelPrefix: "openai/"
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    modelPrefixes: ["gemini/", "gc/"]
  },
  deepseek: {
    url: "https://api.deepseek.com/v1/chat/completions",
    modelPrefix: "deepseek/"
  },
  kimi: {
    url: "https://api.moonshot.cn/v1/chat/completions",
    modelPrefixes: ["kimi/", "moonshot/"]
  },
  moonshot: {
    url: "https://api.moonshot.cn/v1/chat/completions",
    modelPrefixes: ["moonshot/", "kimi/"]
  },
  glm: {
    url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    modelPrefixes: ["glm/", "zhipu/", "bigmodel/"]
  },
  zhipu: {
    url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    modelPrefixes: ["zhipu/", "glm/", "bigmodel/"]
  }
};

const PROVIDER_ALIASES = {
  codex: ["codex"],
  openrouter: ["openrouter"],
  openai: ["openai"],
  gemini: ["gemini"],
  deepseek: ["deepseek"],
  kimi: ["kimi", "moonshot"],
  moonshot: ["moonshot", "kimi"],
  glm: ["glm", "zhipu", "bigmodel"],
  zhipu: ["zhipu", "glm", "bigmodel"]
};

function jsonResponse(body, status = 200, extraHeaders = {}, requestOrOrigin = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(requestOrOrigin, {
      "Content-Type": "application/json",
      ...extraHeaders
    })
  });
}

function cloneHeaders(headers) {
  const nextHeaders = new Headers(headers || {});
  nextHeaders.set("Content-Type", "application/json");
  nextHeaders.delete("content-length");
  return nextHeaders;
}

function dataDbPath() {
  return process.env.AGENT_ROUTE_DB || agentRoutePath("db", "data.sqlite");
}

function safeJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function safeJsonValue(value, fallback = "") {
  try {
    return JSON.parse(String(value || "null")) || fallback;
  } catch {
    return fallback;
  }
}

function normalizeOAuthData(value = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    accessToken: String(input.accessToken || input.access_token || "").trim(),
    refreshToken: String(input.refreshToken || input.refresh_token || "").trim(),
    idToken: String(input.idToken || input.id_token || "").trim(),
    tokenType: String(input.tokenType || input.token_type || "Bearer").trim() || "Bearer",
    scope: String(input.scope || "").trim(),
    expiresAt: String(input.expiresAt || input.expires_at || "").trim(),
    providerAuthMethod: String(input.providerAuthMethod || input.provider_auth_method || "").trim(),
    machineId: String(input.machineId || input.machine_id || "").trim()
  };
}

function getLocalApiKey() {
  const now = Date.now();
  if (localApiKeyCache.expiresAt > now) return localApiKeyCache.key;

  const dbPath = dataDbPath();
  try {
    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT key FROM apiKeys WHERE isActive = 1 ORDER BY createdAt ASC LIMIT 1").get();
    db.close();
    localApiKeyCache = { expiresAt: now + 60 * 1000, key: row && row.key ? String(row.key) : "" };
  } catch (err) {
    console.warn("[core-router] failed to read local API key:", err.message);
    localApiKeyCache = { expiresAt: now + 10 * 1000, key: "" };
  }
  return localApiKeyCache.key;
}

function withLocalApiKey(req) {
  const headers = cloneHeaders(req.headers);
  if (!headers.has("authorization")) {
    const key = getLocalApiKey();
    if (key) headers.set("Authorization", `Bearer ${key}`);
  }
  return new Request(req, { headers });
}

function readProviderDbSnapshot() {
  const now = Date.now();
  const dbPath = dataDbPath();
  if (providerDbCache.expiresAt > now && providerDbCache.dbPath === dbPath) return providerDbCache.snapshot;

  const snapshot = { settings: {}, connections: [], providerNodes: [], modelAliases: {} };
  try {
    if (!fs.existsSync(dbPath)) {
      providerDbCache = { expiresAt: now + 10 * 1000, dbPath, snapshot };
      return snapshot;
    }
    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare("SELECT data FROM settings WHERE id = 1").get();
      snapshot.settings = safeJsonObject(row && row.data);
    } catch {}
    try {
      const rows = db
        .prepare(
          [
            "SELECT id, provider, authType, name, priority, isActive, data, createdAt, updatedAt",
            "FROM providerConnections",
            "WHERE isActive = 1",
            "ORDER BY COALESCE(priority, 9999) ASC, createdAt DESC"
          ].join(" ")
        )
        .all();
      snapshot.connections = rows
        .map((row) => {
          const data = safeJsonObject(row.data);
          return {
            id: String(row.id || ""),
            provider: String(row.provider || "").toLowerCase(),
            authType: String(row.authType || "").toLowerCase(),
            name: String(row.name || ""),
            priority: Number(row.priority || 9999),
            data,
            apiKey: String(data.apiKey || ""),
            oauth: normalizeOAuthData(data.oauth),
            testStatus: String(data.testStatus || "").toLowerCase(),
            providerSpecificData:
              data.providerSpecificData && typeof data.providerSpecificData === "object"
                ? data.providerSpecificData
                : {}
          };
        })
        .filter((connection) => connection.provider);
    } catch {}
    try {
      const rows = db.prepare("SELECT id, type, name, data, createdAt, updatedAt FROM providerNodes").all();
      snapshot.providerNodes = rows
        .map((row) => {
          const data = safeJsonObject(row.data);
          return {
            id: String(row.id || "").toLowerCase(),
            type: String(row.type || data.type || "openai-compatible"),
            name: String(row.name || ""),
            prefix: String(data.prefix || row.id || "").toLowerCase(),
            baseUrl: String(data.baseUrl || data.base_url || ""),
            apiType: String(data.apiType || data.api_type || "chat")
          };
        })
        .filter((node) => node.id && node.baseUrl);
    } catch {}
    try {
      const rows = db.prepare("SELECT key, value FROM kv WHERE scope = 'modelAliases'").all();
      snapshot.modelAliases = Object.fromEntries(
        rows
          .map((row) => [String(row.key || "").trim(), safeJsonValue(row.value, "")])
          .filter(([key, value]) => key && value)
      );
    } catch {}
    db.close();
  } catch (err) {
    console.warn("[core-router] failed to read provider database:", err.message);
  }
  providerDbCache = { expiresAt: now + 30 * 1000, dbPath, snapshot };
  return snapshot;
}

function clearProviderDbCache() {
  providerDbCache = {
    expiresAt: 0,
    dbPath: "",
    snapshot: { settings: {}, connections: [], providerNodes: [], modelAliases: {} }
  };
  localApiKeyCache = { expiresAt: 0, key: "" };
}

function envValue(...names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function normalizeProxyUrl(value = "") {
  const proxy = String(value || "").trim();
  if (!proxy) return "";
  if (/^(https?|socks[45]?):\/\//i.test(proxy)) return proxy;
  return `http://${proxy}`;
}

function bearerHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function stripModelPrefix(model, prefix) {
  const text = String(model || "").trim();
  return text.toLowerCase().startsWith(prefix) ? text.slice(prefix.length) : text;
}

function modelProviderKey(model) {
  const lower = String(model || "")
    .trim()
    .toLowerCase();
  if (!lower.includes("/")) return "";
  const prefix = lower.split("/")[0];
  if (prefix === "cx") return "codex";
  if (prefix === "gc") return "gemini";
  if (prefix === "kimi") return "kimi";
  if (prefix === "zhipu" || prefix === "bigmodel") return "glm";
  return prefix;
}

function stripProviderModelPrefix(model, target) {
  const prefixes = target.modelPrefixes || [target.modelPrefix].filter(Boolean);
  const prefix = prefixes.find((item) =>
    String(model || "")
      .trim()
      .toLowerCase()
      .startsWith(item)
  );
  return prefix ? stripModelPrefix(model, prefix) : String(model || "").trim();
}

function activeApiKeyConnections(provider, extraAliases = []) {
  const aliases = new Set([...(PROVIDER_ALIASES[provider] || [provider]), ...extraAliases].filter(Boolean));
  return readProviderDbSnapshot()
    .connections.filter(
      (connection) => aliases.has(connection.provider) && connection.authType === "apikey" && connection.apiKey
    )
    .sort((a, b) => {
      const activeA = a.testStatus === "active" ? 0 : 1;
      const activeB = b.testStatus === "active" ? 0 : 1;
      return activeA - activeB || a.priority - b.priority;
    });
}

function activeOAuthConnections(provider, extraAliases = []) {
  const aliases = new Set([...(PROVIDER_ALIASES[provider] || [provider]), ...extraAliases].filter(Boolean));
  return readProviderDbSnapshot()
    .connections.filter((connection) => {
      const oauth = connection.oauth || {};
      return (
        aliases.has(connection.provider) && connection.authType === "oauth" && String(oauth.accessToken || "").trim()
      );
    })
    .sort((a, b) => {
      const activeA = a.testStatus === "active" ? 0 : 1;
      const activeB = b.testStatus === "active" ? 0 : 1;
      return activeA - activeB || a.priority - b.priority;
    });
}

function targetForProviderConnection(model, provider, target, connection) {
  const providerSpecificData = connection.providerSpecificData || {};
  const baseUrl = String(
    providerSpecificData.baseUrl || providerSpecificData.baseURL || providerSpecificData.apiBase || ""
  ).trim();
  const normalizedBaseUrl = baseUrl.replace(/\/+$/g, "");
  const url = normalizedBaseUrl
    ? normalizedBaseUrl.endsWith("/chat/completions")
      ? normalizedBaseUrl
      : `${normalizedBaseUrl}/chat/completions`
    : target.url;
  const extraHeaders = typeof target.headers === "function" ? target.headers(connection) : {};
  return {
    url,
    model: stripProviderModelPrefix(model, target),
    headers: {
      ...bearerHeaders(connection.apiKey),
      ...extraHeaders
    },
    proxy: {
      enabled: Boolean(providerSpecificData.connectionProxyEnabled),
      url: String(providerSpecificData.connectionProxyUrl || ""),
      noProxy: String(providerSpecificData.connectionNoProxy || "")
    },
    provider,
    connectionId: connection.id || "",
    connectionName: connection.name || ""
  };
}

function stripCodexModelPrefix(model) {
  const text = String(model || "").trim();
  if (/^cx\//i.test(text)) return text.slice(3);
  if (/^codex\//i.test(text)) return text.slice(6);
  return text;
}

function endpointUrl(baseUrl, suffix) {
  const normalized = String(baseUrl || "")
    .trim()
    .replace(/\/+$/g, "");
  if (!normalized) return "";
  if (normalized.endsWith("/chat/completions") || normalized.endsWith("/responses")) return normalized;
  return `${normalized}/${suffix}`;
}

function codexOAuthEndpoint(connection, endpointMode) {
  const providerSpecificData = connection.providerSpecificData || {};
  const explicitEndpoint =
    endpointMode === "responses"
      ? envValue("AGENT_ROUTE_CODEX_OAUTH_RESPONSES_URL")
      : envValue("AGENT_ROUTE_CODEX_OAUTH_CHAT_URL");
  if (explicitEndpoint) {
    const url = endpointUrl(explicitEndpoint, endpointMode === "responses" ? "responses" : "chat/completions");
    return {
      url,
      wireMode: url.endsWith("/responses") ? "responses" : "chat"
    };
  }
  const baseUrl = String(
    providerSpecificData.baseUrl ||
      providerSpecificData.baseURL ||
      providerSpecificData.apiBase ||
      envValue("AGENT_ROUTE_CODEX_OAUTH_BASE_URL") ||
      ""
  ).trim();
  if (baseUrl) {
    const url = endpointUrl(baseUrl, endpointMode === "responses" ? "responses" : "chat/completions");
    return {
      url,
      wireMode: url.endsWith("/responses") ? "responses" : "chat"
    };
  }
  return {
    url: "",
    wireMode: ""
  };
}

function targetForCodexOAuthConnection(model, connection, endpointMode) {
  const endpoint = codexOAuthEndpoint(connection, endpointMode);
  if (!endpoint.url) return null;
  const oauth = connection.oauth || {};
  const tokenType = String(oauth.tokenType || "Bearer").trim() || "Bearer";
  const providerSpecificData = connection.providerSpecificData || {};
  const accountId = String(
    providerSpecificData.accountId || providerSpecificData.account_id || connection.data?.accountId || ""
  ).trim();
  return {
    kind: "codex-oauth",
    url: endpoint.url,
    wireMode: endpoint.wireMode,
    model: stripCodexModelPrefix(model),
    headers: {
      Authorization: `${tokenType} ${oauth.accessToken}`,
      ...(accountId ? { "ChatGPT-Account-Id": accountId } : {})
    },
    proxy: {
      enabled: Boolean(providerSpecificData.connectionProxyEnabled),
      url: String(providerSpecificData.connectionProxyUrl || ""),
      noProxy: String(providerSpecificData.connectionNoProxy || "")
    },
    provider: "codex",
    connectionId: connection.id || "",
    connectionName: connection.name || ""
  };
}

function targetsFromCodexOAuthProvider(model, endpointMode) {
  if (!/^(cx|codex)\//i.test(String(model || ""))) return [];
  return activeOAuthConnections("codex")
    .map((connection) => targetForCodexOAuthConnection(model, connection, endpointMode))
    .filter(Boolean);
}

function targetsFromConfiguredProvider(model) {
  const provider = modelProviderKey(model);
  if (!provider) return [];
  const snapshot = readProviderDbSnapshot();
  const customNode = snapshot.providerNodes.find((node) => node.id === provider || node.prefix === provider);
  const customBaseUrl = customNode ? customNode.baseUrl.replace(/\/+$/g, "") : "";
  const target =
    OPENAI_COMPAT_PROVIDER_TARGETS[provider] ||
    (customNode && customNode.type === "openai-compatible"
      ? {
          url: customBaseUrl.endsWith("/chat/completions") ? customBaseUrl : `${customBaseUrl}/chat/completions`,
          modelPrefixes: [`${customNode.prefix || customNode.id}/`, `${customNode.id}/`]
        }
      : null);
  if (!target) return [];
  const connectionAliases = customNode ? [customNode.id, customNode.prefix] : [];
  return activeApiKeyConnections(provider, connectionAliases).map((connection) =>
    targetForProviderConnection(model, provider, target, connection)
  );
}

function resolveModelAlias(model) {
  let current = String(model || "").trim();
  if (!current) return "";
  const seen = new Set();
  for (let index = 0; index < 8; index += 1) {
    const aliases = readProviderDbSnapshot().modelAliases || {};
    const lower = current.toLowerCase();
    const next = String(aliases[current] || aliases[lower] || "").trim();
    if (!next || next === current || seen.has(next)) return current;
    seen.add(current);
    current = next;
  }
  return current;
}

function uniqueModelProxyTargets(targets = []) {
  const seen = new Set();
  return targets.filter((target) => {
    if (!target) return false;
    const key = [
      target.kind || "",
      target.url || "",
      target.model || "",
      target.connectionId || "",
      (target.headers && target.headers.Authorization) || ""
    ].join("\n");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function providerEnvTargetWithConfiguredTargets(envTarget, model) {
  return uniqueModelProxyTargets([envTarget, ...targetsFromConfiguredProvider(model)]);
}

function configuredProviderDiagnostic(model) {
  if (!model) return "";
  const provider = modelProviderKey(model);
  if (!provider) return "The model id does not include a provider prefix.";
  const aliases = new Set(PROVIDER_ALIASES[provider] || [provider]);
  const connections = readProviderDbSnapshot().connections.filter((connection) => aliases.has(connection.provider));
  if (!connections.length) return `No active provider connection was found for '${provider}'.`;
  if (provider === "codex") {
    if (!connections.some((connection) => connection.authType === "oauth" && connection.oauth?.accessToken)) {
      const authTypes =
        [...new Set(connections.map((connection) => connection.authType).filter(Boolean))].join(", ") || "unknown";
      return `Provider 'codex' is configured, but no active Codex OAuth connection with an access token is available. Auth types: ${authTypes}.`;
    }
    return [
      "Provider 'codex' has active OAuth accounts, but no explicit Codex OAuth model route is configured.",
      "Configure AGENT_ROUTE_CODEX_OAUTH_BASE_URL / AGENT_ROUTE_CODEX_OAUTH_CHAT_URL, or set a per-connection Base URL."
    ].join(" ");
  }
  if (!OPENAI_COMPAT_PROVIDER_TARGETS[provider]) {
    const authTypes =
      [...new Set(connections.map((connection) => connection.authType).filter(Boolean))].join(", ") || "unknown";
    return `Provider '${provider}' is configured with ${authTypes} auth, but the internal model service only supports OpenAI-compatible API-key providers for this provider.`;
  }
  if (!connections.some((connection) => connection.authType === "apikey" && connection.apiKey)) {
    const authTypes =
      [...new Set(connections.map((connection) => connection.authType).filter(Boolean))].join(", ") || "unknown";
    return `Provider '${provider}' is configured, but no active API-key connection is available for internal OpenAI-compatible model calls. Auth types: ${authTypes}.`;
  }
  return `Provider '${provider}' is configured, but no usable route could be built for this request.`;
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function noProxyMatches(hostname, rules) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;
  return String(rules || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) => {
      if (rule === "*") return true;
      if (rule === host) return true;
      if (rule.startsWith(".") && host.endsWith(rule)) return true;
      if (rule.includes("/") && /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) return true;
      return false;
    });
}

function proxyConfigForTarget(target) {
  const host = hostnameFromUrl(target && target.url);
  const explicitProxy = target && target.proxy && target.proxy.enabled && target.proxy.url ? target.proxy : null;
  if (explicitProxy && !noProxyMatches(host, explicitProxy.noProxy)) return explicitProxy.url;
  const settings = readProviderDbSnapshot().settings || {};
  const globalUrl = String(settings.outboundProxyUrl || "");
  if (settings.outboundProxyEnabled && globalUrl && !noProxyMatches(host, settings.outboundNoProxy)) return globalUrl;
  const envProxy = normalizeProxyUrl(
    envValue(
      "AGENT_ROUTE_OUTBOUND_PROXY_URL",
      "AGENT_ROUTE_SYSTEM_PROXY",
      "AGENT_ROUTE_HTTPS_PROXY",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "ALL_PROXY"
    )
  );
  if (envProxy && !noProxyMatches(host, envValue("AGENT_ROUTE_NO_PROXY", "NO_PROXY"))) return envProxy;
  return "";
}

function fetchOptionsForTarget(target, headers, body, signal) {
  const options = {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal
  };
  const proxyUrl = proxyConfigForTarget(target);
  if (!proxyUrl) return options;
  try {
    const { ProxyAgent } = require("undici");
    options.dispatcher = new ProxyAgent(proxyUrl);
  } catch (err) {
    console.warn("[core-router] configured proxy could not be used:", err.message);
  }
  return options;
}

function redactErrorText(text) {
  return String(text || "").replace(/([A-Za-z0-9_-]{20,})/g, "[REDACTED]");
}

function messageContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") return part.text || part.content || "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  return String(content);
}

function responsesInputFromChatMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => String((message && message.role) || "").toLowerCase() !== "system")
    .map((message) => ({
      role: String((message && message.role) || "user").toLowerCase() === "assistant" ? "assistant" : "user",
      content: messageContentToText(message && message.content)
    }))
    .filter((message) => message.content);
}

function systemInstructionsFromChatMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => String((message && message.role) || "").toLowerCase() === "system")
    .map((message) => messageContentToText(message && message.content))
    .filter(Boolean)
    .join("\n\n");
}

function requestBodyForTarget(target, body = {}) {
  if (target && target.kind === "codex-oauth" && target.wireMode === "responses") {
    const maxOutputTokens = body.max_output_tokens || body.max_completion_tokens || body.max_tokens;
    return {
      model: target.model,
      input: responsesInputFromChatMessages(body.messages),
      instructions: systemInstructionsFromChatMessages(body.messages) || undefined,
      temperature: body.temperature,
      top_p: body.top_p,
      max_output_tokens: maxOutputTokens,
      stream: false
    };
  }
  return { ...body, model: target.model };
}

function extractResponsesOutputText(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.output_text === "string") return data.output_text;
  if (Array.isArray(data.output)) {
    return data.output
      .flatMap((item) => (Array.isArray(item && item.content) ? item.content : []))
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        if (typeof part.text === "string") return part.text;
        if (typeof part.content === "string") return part.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function openAiChatCompletionFromText({ model, content, promptTokens = 0, completionTokens = 0 }) {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl-codex-oauth-${created}`,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: String(content || "")
        },
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    }
  };
}

function estimateTokens(text = "") {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

async function responseForSuccessfulUpstream(upstream, target, originalBody, endpointMode, requestOrOrigin) {
  if (target && target.kind === "codex-oauth" && target.wireMode === "responses" && endpointMode === "chat") {
    const text = await upstream.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}
    const content = extractResponsesOutputText(data);
    if (!content) {
      return jsonResponse(
        {
          error: {
            message: "Codex OAuth provider returned a Responses payload without assistant text.",
            type: "model_proxy_error",
            code: "model_proxy_empty_response"
          }
        },
        502,
        {},
        requestOrOrigin
      );
    }
    return jsonResponse(
      openAiChatCompletionFromText({
        model: (originalBody && originalBody.model) || target.model,
        content,
        promptTokens: estimateTokens(
          JSON.stringify(originalBody && originalBody.messages ? originalBody.messages : [])
        ),
        completionTokens: estimateTokens(content)
      }),
      200,
      {},
      requestOrOrigin
    );
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: filteredProxyHeaders(upstream.headers, requestOrOrigin)
  });
}

function requestPathname(req) {
  try {
    return new URL(req.url).pathname;
  } catch {
    return "";
  }
}

function inferEndpointMode(req, options = {}) {
  if (options.endpointMode) return options.endpointMode;
  return requestPathname(req).includes("/responses") ? "responses" : "chat";
}

function isAgentRouteRunUrl(url) {
  try {
    const parsed = new URL(url, "http://localhost");
    return parsed.pathname === "/api/agent-route/run";
  } catch {
    return false;
  }
}

function modelProxyTargets(body, endpointMode) {
  const model = resolveModelAlias(body && body.model);
  const lower = model.toLowerCase();
  if (/^(cx|codex)\//i.test(model)) return targetsFromCodexOAuthProvider(model, endpointMode);
  const genericUrl =
    endpointMode === "responses"
      ? envValue("AGENT_ROUTE_UPSTREAM_RESPONSES_URL")
      : envValue("AGENT_ROUTE_UPSTREAM_CHAT_URL", "AGENT_ROUTE_MODEL_PROXY_URL");
  if (genericUrl) {
    if (isAgentRouteRunUrl(genericUrl)) return [];
    return [
      {
        url: genericUrl,
        model,
        headers: bearerHeaders(envValue("AGENT_ROUTE_UPSTREAM_API_KEY"))
      }
    ];
  }
  if (endpointMode !== "chat") return [];
  if (lower.startsWith("openrouter/")) {
    const apiKey = envValue("OPENROUTER_API_KEY");
    if (!apiKey) return targetsFromConfiguredProvider(model);
    return providerEnvTargetWithConfiguredTargets(
      {
        url: "https://openrouter.ai/api/v1/chat/completions",
        model: stripModelPrefix(model, "openrouter/"),
        headers: {
          ...bearerHeaders(apiKey),
          "HTTP-Referer": envValue("AGENT_ROUTE_PUBLIC_URL") || "http://localhost:20128",
          "X-Title": "AgentRoute Studio"
        },
        provider: "openrouter",
        connectionId: "env"
      },
      model
    );
  }
  if (lower.startsWith("openai/")) {
    const apiKey = envValue("OPENAI_API_KEY");
    if (!apiKey) return targetsFromConfiguredProvider(model);
    return providerEnvTargetWithConfiguredTargets(
      {
        url: envValue("OPENAI_CHAT_COMPLETIONS_URL") || "https://api.openai.com/v1/chat/completions",
        model: stripModelPrefix(model, "openai/"),
        headers: bearerHeaders(apiKey),
        provider: "openai",
        connectionId: "env"
      },
      model
    );
  }
  if (lower.startsWith("gemini/") || lower.startsWith("gc/")) {
    const apiKey = envValue("GEMINI_API_KEY", "GOOGLE_API_KEY");
    if (!apiKey) return targetsFromConfiguredProvider(model);
    return providerEnvTargetWithConfiguredTargets(
      {
        url:
          envValue("GEMINI_OPENAI_CHAT_URL") ||
          "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        model: lower.startsWith("gc/") ? stripModelPrefix(model, "gc/") : stripModelPrefix(model, "gemini/"),
        headers: bearerHeaders(apiKey),
        provider: "gemini",
        connectionId: "env"
      },
      model
    );
  }
  if (lower.startsWith("oc/")) {
    const url = envValue("OC_CHAT_COMPLETIONS_URL", "AGENT_ROUTE_OC_CHAT_URL");
    const apiKey = envValue("OC_API_KEY", "AGENT_ROUTE_OC_API_KEY");
    if (!url || !apiKey) return [];
    return [
      {
        url,
        model: stripModelPrefix(model, "oc/"),
        headers: bearerHeaders(apiKey)
      }
    ];
  }
  return targetsFromConfiguredProvider(model);
}

function filteredProxyHeaders(headers, requestOrOrigin = null) {
  const output = new Headers();
  const blocked = new Set(["connection", "content-length", "content-encoding", "transfer-encoding"]);
  for (const [key, value] of headers || []) {
    if (!blocked.has(key.toLowerCase())) output.set(key, value);
  }
  for (const [key, value] of Object.entries(corsHeaders(requestOrOrigin))) output.set(key, value);
  return output;
}

function extractProviderErrorMessage(text = "") {
  const raw = String(text || "");
  if (!raw) return "";
  try {
    const data = JSON.parse(raw);
    if (data && data.error) {
      if (typeof data.error === "string") return data.error;
      if (typeof data.error.message === "string") return data.error.message;
      return JSON.stringify(data.error);
    }
    if (typeof data.message === "string") return data.message;
  } catch {}
  return raw;
}

function isProviderConnectionFailoverError(status, text = "", err = null) {
  if (err) return true;
  const errorText = extractProviderErrorMessage(text);
  if (status === 402 || status === 408 || status === 409 || status === 425 || status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  if (
    status >= 400 &&
    /(insufficient[_\s-]?quota|rate[_\s-]?limit|billing|quota|credit|usage limit|not enough credits|insufficient credits|can only afford)/i.test(
      errorText
    )
  ) {
    return true;
  }
  if (
    status === 401 &&
    /(api.?key|token|credential|auth|unauthorized|incorrect|invalid|expired|revoked)/i.test(errorText)
  ) {
    return true;
  }
  if (
    status === 403 &&
    /(quota|credit|billing|rate.?limit|permission|not authorized|forbidden|access|insufficient|disabled|blocked|not allowed)/i.test(
      errorText
    )
  ) {
    return true;
  }
  return false;
}

function failoverAttemptSummary(target, status, text = "", err = null) {
  const message = err
    ? err && err.name === "AbortError"
      ? "timeout"
      : (err && err.message) || String(err)
    : extractProviderErrorMessage(text) || `HTTP ${status}`;
  return {
    provider: target.provider || "",
    connectionId: target.connectionId || "",
    status: status || 0,
    error: redactErrorText(message).slice(0, 360)
  };
}

function internalModelMode(options = {}) {
  return Boolean(options.internalModelRequest || options.internal_model_request || options.internal);
}

function modelServiceLabel(options = {}) {
  return internalModelMode(options) ? "Internal model request" : "Upstream model request";
}

function allProviderConnectionsFailedResponse(model, attempts, fallbackStatus, requestOrOrigin = null, options = {}) {
  const parts = attempts
    .map((attempt) => {
      const label = [attempt.provider, attempt.connectionId].filter(Boolean).join(":") || "upstream";
      const status = attempt.status ? `HTTP ${attempt.status}` : "request failed";
      return `${label} ${status}: ${attempt.error}`;
    })
    .filter(Boolean);
  return jsonResponse(
    {
      error: {
        message: [
          `All configured ${internalModelMode(options) ? "internal model" : "provider"} connections failed for ${model || "(missing model)"}.`,
          ...parts
        ]
          .filter(Boolean)
          .join(" "),
        type: "model_proxy_error",
        code: "model_proxy_all_connections_failed",
        attempts
      }
    },
    fallbackStatus || 502,
    {},
    requestOrOrigin
  );
}

function unconfiguredModelProxyResponse(model, endpointMode, requestOrOrigin = null, options = {}) {
  const diagnostic = configuredProviderDiagnostic(model);
  const internal = internalModelMode(options);
  return jsonResponse(
    {
      error: {
        message: [
          internal
            ? `No internal model route is configured for ${model || "(missing model)"}.`
            : `No upstream model route is configured for ${model || "(missing model)"}.`,
          diagnostic,
          endpointMode === "responses"
            ? "Configure AGENT_ROUTE_UPSTREAM_RESPONSES_URL, or use the goal-driven agent endpoint with a chat-compatible model pool."
            : internal
              ? "Configure AGENT_ROUTE_UPSTREAM_CHAT_URL, or add an active provider connection for the agent's internal model service."
              : "Configure AGENT_ROUTE_UPSTREAM_CHAT_URL/AGENT_ROUTE_MODEL_PROXY_URL, or add an active OpenAI-compatible provider connection."
        ]
          .filter(Boolean)
          .join(" "),
        type: "model_proxy_error",
        code: "model_proxy_unconfigured"
      }
    },
    503,
    {},
    requestOrOrigin
  );
}

async function handleModelProxy(req, options = {}) {
  const authDenied = checkRequestAuth(req);
  if (authDenied) return authDenied;

  const internalOptions = internalModelMode(options) ? { ...options, internalModelRequest: true } : options;
  let body;
  try {
    body = await req.clone().json();
  } catch {
    return jsonResponse(
      {
        error: {
          message: internalModelMode(internalOptions)
            ? "Expected JSON body for internal model request."
            : "Expected JSON body for model request.",
          type: "invalid_request_error",
          code: "invalid_json"
        }
      },
      400,
      {},
      req
    );
  }
  const endpointMode = inferEndpointMode(req, options);
  const targets = modelProxyTargets(body, endpointMode);
  if (!targets.length) return unconfiguredModelProxyResponse(body && body.model, endpointMode, req, internalOptions);
  const target = targets[0];

  if (target.kind === "codex-oauth" && body.stream) {
    if (body.stream) {
      return jsonResponse(
        {
          error: {
            message: internalModelMode(internalOptions)
              ? "Codex OAuth internal model request does not support streaming responses."
              : "Codex OAuth model request does not support streaming responses.",
            type: "model_proxy_error",
            code: "model_proxy_stream_unsupported"
          }
        },
        400,
        {},
        req
      );
    }
  }

  const attempts = [];
  const timeoutMs = Number(options.timeoutMs || 120000);
  for (let index = 0; index < targets.length; index += 1) {
    const currentTarget = targets[index];
    const hasNextTarget = index < targets.length - 1;
    const headers = {
      ...(body.stream ? { Accept: "text/event-stream, application/json" } : {}),
      "Content-Type": "application/json",
      ...currentTarget.headers
    };
    if (envValue("AGENT_ROUTE_UPSTREAM_FORWARD_AUTH") === "true") {
      const authorization = req.headers.get("authorization");
      if (authorization && !headers.Authorization) headers.Authorization = authorization;
    }
    const controller = new AbortController();
    const abortFromRequest = () => controller.abort(req.signal && req.signal.reason);
    if (req.signal) {
      if (req.signal.aborted) controller.abort(req.signal.reason);
      else req.signal.addEventListener("abort", abortFromRequest, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const upstream = await fetch(
        currentTarget.url,
        fetchOptionsForTarget(currentTarget, headers, requestBodyForTarget(currentTarget, body), controller.signal)
      );
      if (upstream.ok) {
        return responseForSuccessfulUpstream(upstream, currentTarget, body, endpointMode, req);
      }
      if (!hasNextTarget) {
        if (attempts.length) {
          const text = await upstream.text();
          if (isProviderConnectionFailoverError(upstream.status, text, null)) {
            attempts.push(failoverAttemptSummary(currentTarget, upstream.status, text));
            return allProviderConnectionsFailedResponse(
              body && body.model,
              attempts,
              upstream.status,
              req,
              internalOptions
            );
          }
          return new Response(text, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: filteredProxyHeaders(upstream.headers, req)
          });
        }
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: filteredProxyHeaders(upstream.headers, req)
        });
      }
      const text = await upstream.text();
      if (!isProviderConnectionFailoverError(upstream.status, text, null)) {
        return new Response(text, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: filteredProxyHeaders(upstream.headers, req)
        });
      }
      attempts.push(failoverAttemptSummary(currentTarget, upstream.status, text));
    } catch (err) {
      if (err && err.name === "AbortError") {
        attempts.push(failoverAttemptSummary(currentTarget, 0, "", err));
        if (hasNextTarget) continue;
        return jsonResponse(
          {
            error: {
              message: `${modelServiceLabel(internalOptions)} timed out.`,
              type: "model_proxy_error",
              code: "model_proxy_timeout",
              attempts
            }
          },
          504,
          {},
          req
        );
      }
      attempts.push(failoverAttemptSummary(currentTarget, 0, "", err));
      if (hasNextTarget) continue;
      return jsonResponse(
        {
          error: {
            message:
              err && err.name === "AbortError"
                ? `${modelServiceLabel(internalOptions)} timed out.`
                : `${modelServiceLabel(internalOptions)} failed: ${redactErrorText((err && err.message) || String(err))}`,
            type: "model_proxy_error",
            code: err && err.name === "AbortError" ? "model_proxy_timeout" : "model_proxy_failed",
            attempts
          }
        },
        err && err.name === "AbortError" ? 504 : 502,
        {},
        req
      );
    } finally {
      clearTimeout(timer);
      if (req.signal) req.signal.removeEventListener("abort", abortFromRequest);
    }
  }
  return allProviderConnectionsFailedResponse(body && body.model, attempts, 502, req, internalOptions);
}

async function handleInternalModelRequest(req, options = {}) {
  return handleModelProxy(req, { ...options, internalModelRequest: true });
}

module.exports = {
  OPENAI_COMPAT_PROVIDER_TARGETS,
  PROVIDER_ALIASES,
  clearProviderDbCache,
  handleInternalModelRequest,
  handleModelProxy,
  withLocalApiKey
};
