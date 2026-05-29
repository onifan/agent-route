"use strict";

const fs = require("fs");
const { agentRoutePath } = require("../../shared/utils/agent-home");
const { corsHeaders } = require("../../security/cors");
const { checkRequestAuth } = require("../../security/request-auth");
const modelApiSettings = require("../model-api-settings");

let localApiKeyCache = { expiresAt: 0, key: "" };
let providerDbCache = {
  expiresAt: 0,
  dbPath: "",
  snapshot: { settings: {} }
};

const OPENAI_COMPAT_PROVIDER_TARGETS = {
  openai: {
    url: "https://api.openai.com/v1/chat/completions",
    modelPrefix: "openai/"
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    modelPrefixes: ["gemini/", "gc/"]
  },
  grok: {
    url: "https://api.x.ai/v1/chat/completions",
    modelPrefixes: ["grok/", "xai/"]
  },
  deepseek: {
    url: "https://api.deepseek.com/chat/completions",
    modelPrefix: "deepseek/"
  },
  qwen: {
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    modelPrefixes: ["qwen/", "qw/"]
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
  openai: ["openai"],
  claude: ["claude", "anthropic"],
  anthropic: ["anthropic", "claude"],
  gemini: ["gemini"],
  grok: ["grok", "xai", "x-ai"],
  deepseek: ["deepseek"],
  qwen: ["qwen", "dashscope"],
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

  const snapshot = { settings: {} };
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
    db.close();
  } catch (err) {
    console.warn("[core-router] failed to read router settings:", err.message);
  }
  providerDbCache = { expiresAt: now + 30 * 1000, dbPath, snapshot };
  return snapshot;
}

function clearProviderDbCache() {
  providerDbCache = {
    expiresAt: 0,
    dbPath: "",
    snapshot: { settings: {} }
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

function targetsFromConfiguredProvider(model) {
  const target = modelApiSettings.targetForModelApi(model);
  return target ? [target] : [];
}

function resolveModelAlias(model) {
  return modelApiSettings.resolveModelAlias(model);
}

function configuredProviderDiagnostic(model) {
  return modelApiSettings.modelApiDiagnostic(model);
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

function systemInstructionsFromChatMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => String((message && message.role) || "").toLowerCase() === "system")
    .map((message) => messageContentToText(message && message.content))
    .filter(Boolean)
    .join("\n\n");
}

function anthropicMessagesFromChatMessages(messages = []) {
  const output = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = String((message && message.role) || "user").toLowerCase();
    if (role === "system") continue;
    const content = messageContentToText(message && message.content);
    if (!content) continue;
    output.push({
      role: role === "assistant" ? "assistant" : "user",
      content
    });
  }
  return output.length ? output : [{ role: "user", content: "" }];
}

function anthropicToolsFromOpenAiTools(tools = []) {
  return (Array.isArray(tools) ? tools : [])
    .filter((tool) => tool && tool.type === "function" && tool.function && tool.function.name)
    .map((tool) => ({
      name: String(tool.function.name),
      description: String(tool.function.description || ""),
      input_schema:
        tool.function.parameters && typeof tool.function.parameters === "object"
          ? tool.function.parameters
          : { type: "object", properties: {} }
    }));
}

function anthropicToolChoiceFromOpenAiChoice(toolChoice) {
  if (!toolChoice || toolChoice === "auto") return undefined;
  if (toolChoice === "none") return { type: "none" };
  if (toolChoice === "required") return { type: "any" };
  const name = toolChoice && toolChoice.function && toolChoice.function.name;
  return name ? { type: "tool", name: String(name) } : undefined;
}

function requestBodyForAnthropicTarget(target, body = {}) {
  const maxTokens = body.max_tokens || body.max_completion_tokens || body.max_output_tokens || 4096;
  const tools = anthropicToolsFromOpenAiTools(body.tools);
  const requestBody = {
    model: target.model,
    messages: anthropicMessagesFromChatMessages(body.messages),
    system: systemInstructionsFromChatMessages(body.messages) || undefined,
    max_tokens: maxTokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: false
  };
  if (tools.length) requestBody.tools = tools;
  const toolChoice = anthropicToolChoiceFromOpenAiChoice(body.tool_choice);
  if (toolChoice) requestBody.tool_choice = toolChoice;
  return Object.fromEntries(Object.entries(requestBody).filter(([, value]) => value !== undefined));
}

function requestBodyForTarget(target, body = {}) {
  if (target && target.kind === "anthropic") return requestBodyForAnthropicTarget(target, body);
  return { ...body, model: target.model };
}

function anthropicStopReason(reason = "") {
  const value = String(reason || "");
  if (value === "max_tokens") return "length";
  if (value === "tool_use") return "tool_calls";
  if (value === "end_turn" || value === "stop_sequence") return "stop";
  return value || "stop";
}

function openAiChatCompletionFromAnthropic(data = {}, requestedModel = "") {
  const created = Math.floor(Date.now() / 1000);
  const content = Array.isArray(data.content) ? data.content : [];
  const text = content
    .filter((part) => part && part.type === "text")
    .map((part) => part.text || "")
    .filter(Boolean)
    .join("\n");
  const toolCalls = content
    .filter((part) => part && part.type === "tool_use" && part.name)
    .map((part, index) => ({
      id: part.id || `call_${cryptoRandomId(index)}`,
      type: "function",
      function: {
        name: String(part.name),
        arguments: JSON.stringify(part.input || {})
      }
    }));
  const message = {
    role: "assistant",
    content: text || null
  };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const inputTokens = Number(data.usage?.input_tokens || 0);
  const outputTokens = Number(data.usage?.output_tokens || 0);
  return {
    id: data.id || `chatcmpl-anthropic-${created}`,
    object: "chat.completion",
    created,
    model: requestedModel || data.model || "",
    choices: [
      {
        index: 0,
        message,
        finish_reason: anthropicStopReason(data.stop_reason)
      }
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens
    }
  };
}

function cryptoRandomId(index = 0) {
  try {
    return require("crypto").randomUUID().replace(/-/g, "");
  } catch {
    return `${Date.now()}_${index}`;
  }
}

async function responseForSuccessfulUpstream(upstream, target, originalBody, endpointMode, requestOrOrigin) {
  if (target && target.kind === "anthropic" && endpointMode === "chat") {
    const text = await upstream.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}
    if (!data || typeof data !== "object") {
      return jsonResponse(
        {
          error: {
            message: "Claude model API returned a non-JSON response.",
            type: "model_proxy_error",
            code: "model_proxy_invalid_response"
          }
        },
        502,
        {},
        requestOrOrigin
      );
    }
    return jsonResponse(
      openAiChatCompletionFromAnthropic(data, (originalBody && originalBody.model) || target.model),
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

function modelProxyTargets(body, endpointMode) {
  const model = resolveModelAlias(body && body.model);
  if (endpointMode !== "chat") return [];
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
            ? "Responses-compatible model proxying is disabled. Use the goal-driven agent endpoint with a chat-compatible model API entry."
            : internal
              ? "Configure an active model API entry in AgentRoute model API settings."
              : "Configure an active model API entry in AgentRoute model API settings."
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

  if (target.kind === "anthropic" && body.stream) {
    return jsonResponse(
      {
        error: {
          message: internalModelMode(internalOptions)
            ? "Claude internal model API requests are translated through the Messages API and do not support streaming here."
            : "Claude model API requests are translated through the Messages API and do not support streaming here.",
          type: "model_proxy_error",
          code: "model_proxy_stream_unsupported"
        }
      },
      400,
      {},
      req
    );
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
