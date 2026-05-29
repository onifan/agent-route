"use strict";

const fs = require("fs");
const path = require("path");
const { agentRoutePath } = require("../shared/utils/agent-home");

const MODEL_API_PROVIDERS = {
  openai: {
    id: "openai",
    label: "OpenAI",
    protocol: "openai",
    prefixes: ["openai/", "local/"],
    aliases: ["local"],
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.5",
    sampleModels: ["gpt-5.5", "gpt-5.2", "gpt-5-mini"],
    docsUrl: "https://platform.openai.com/docs/api-reference/chat/create"
  },
  claude: {
    id: "claude",
    label: "Claude",
    protocol: "anthropic",
    prefixes: ["claude/", "anthropic/"],
    aliases: ["anthropic"],
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-5",
    sampleModels: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
    docsUrl: "https://docs.anthropic.com/en/api/messages",
    anthropicVersion: "2023-06-01"
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    protocol: "openai",
    prefixes: ["gemini/", "gc/"],
    aliases: ["google"],
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-pro",
    sampleModels: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
    docsUrl: "https://ai.google.dev/gemini-api/docs/openai"
  },
  grok: {
    id: "grok",
    label: "Grok",
    protocol: "openai",
    prefixes: ["grok/", "xai/"],
    aliases: ["xai", "x-ai"],
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-4",
    sampleModels: ["grok-4", "grok-3", "grok-code-fast-1"],
    docsUrl: "https://docs.x.ai/docs/api-reference"
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    protocol: "openai",
    prefixes: ["deepseek/"],
    aliases: [],
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-pro",
    sampleModels: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
    docsUrl: "https://api-docs.deepseek.com/api/create-chat-completion"
  },
  qwen: {
    id: "qwen",
    label: "Qwen",
    protocol: "openai",
    prefixes: ["qwen/", "qw/"],
    aliases: ["dashscope"],
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    sampleModels: ["qwen-plus", "qwen-max", "qwen3-coder-plus"],
    docsUrl: "https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope"
  },
  glm: {
    id: "glm",
    label: "GLM",
    protocol: "openai",
    prefixes: ["glm/", "zhipu/", "bigmodel/"],
    aliases: ["zhipu", "bigmodel"],
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-5.1",
    sampleModels: ["glm-5.1", "glm-4.7", "glm-4.5"],
    docsUrl: "https://docs.bigmodel.cn/cn/guide/develop/openai/introduction"
  },
  kimi: {
    id: "kimi",
    label: "Kimi",
    protocol: "openai",
    prefixes: ["kimi/", "moonshot/"],
    aliases: ["moonshot"],
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k2.5",
    sampleModels: ["kimi-k2.5", "kimi-k2-thinking", "moonshot-v1-128k"],
    docsUrl: "https://platform.moonshot.cn/docs/guide/kimi-k2-5-quickstart"
  }
};

const MODEL_API_PROVIDER_ORDER = ["openai", "claude", "gemini", "grok", "deepseek", "qwen", "glm", "kimi"];

let cache = { expiresAt: 0, dbPath: "", status: null };

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

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function database() {
  const Database = require("better-sqlite3");
  const dbPath = dataDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(
    [
      [
        "CREATE TABLE IF NOT EXISTS modelApiSettings(",
        "provider TEXT PRIMARY KEY,",
        "enabled INTEGER,",
        "apiKey TEXT,",
        "baseUrl TEXT,",
        "defaultModel TEXT,",
        "models TEXT,",
        "settings TEXT,",
        "createdAt TEXT,",
        "updatedAt TEXT",
        ")"
      ].join(" "),
      "CREATE TABLE IF NOT EXISTS kv(scope TEXT, key TEXT, value TEXT, PRIMARY KEY(scope, key))",
      "CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY, data TEXT)"
    ].join(";")
  );
  return db;
}

function clearModelApiCache() {
  cache = { expiresAt: 0, dbPath: "", status: null };
}

function providerId(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) return "";
  for (const provider of Object.values(MODEL_API_PROVIDERS)) {
    if (provider.id === raw || provider.aliases.includes(raw)) return provider.id;
  }
  return "";
}

function normalizeBaseUrl(value, provider) {
  const text = String(value || provider.defaultBaseUrl || "").trim();
  return text.replace(/\/+$/g, "");
}

function chatUrlForProvider(provider, baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl, provider);
  if (provider.protocol === "anthropic") {
    if (normalized.endsWith("/messages")) return normalized;
    return `${normalized}/messages`;
  }
  if (normalized.endsWith("/chat/completions")) return normalized;
  return `${normalized}/chat/completions`;
}

function splitModels(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[\n,]+/);
  const seen = new Set();
  const output = [];
  for (const item of raw) {
    const text = String(item && item.id ? item.id : item || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }
  return output;
}

function firstJsonErrorMessage(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    return (
      parsed?.error?.message ||
      parsed?.error?.code ||
      parsed?.message ||
      parsed?.detail ||
      parsed?.type ||
      raw.slice(0, 800)
    );
  } catch {
    return raw.slice(0, 800);
  }
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "••••";
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

function sanitizeRow(row) {
  if (!row) return null;
  const provider = MODEL_API_PROVIDERS[row.provider];
  if (!provider) return null;
  const settings = safeJsonObject(row.settings);
  const models = splitModels(safeJsonArray(row.models));
  return {
    provider: provider.id,
    label: provider.label,
    protocol: provider.protocol,
    prefixes: provider.prefixes.slice(),
    enabled: row.enabled === 1,
    hasApiKey: Boolean(row.apiKey),
    apiKeyMasked: maskSecret(row.apiKey),
    baseUrl: normalizeBaseUrl(row.baseUrl, provider),
    chatUrl: chatUrlForProvider(provider, row.baseUrl),
    defaultModel: String(row.defaultModel || provider.defaultModel || "").trim(),
    models,
    sampleModels: provider.sampleModels.slice(),
    docsUrl: provider.docsUrl,
    anthropicVersion: String(settings.anthropicVersion || provider.anthropicVersion || "").trim(),
    createdAt: String(row.createdAt || ""),
    updatedAt: String(row.updatedAt || "")
  };
}

function defaultSetting(provider) {
  return {
    provider: provider.id,
    label: provider.label,
    protocol: provider.protocol,
    prefixes: provider.prefixes.slice(),
    enabled: false,
    hasApiKey: false,
    apiKeyMasked: "",
    baseUrl: provider.defaultBaseUrl,
    chatUrl: chatUrlForProvider(provider, provider.defaultBaseUrl),
    defaultModel: provider.defaultModel,
    models: provider.sampleModels.slice(),
    sampleModels: provider.sampleModels.slice(),
    docsUrl: provider.docsUrl,
    anthropicVersion: provider.anthropicVersion || "",
    createdAt: "",
    updatedAt: ""
  };
}

function modelApiStatus() {
  const now = Date.now();
  const dbPath = dataDbPath();
  if (cache.status && cache.expiresAt > now && cache.dbPath === dbPath) return cache.status;
  try {
    const db = database();
    const rows = db.prepare("SELECT * FROM modelApiSettings").all();
    db.close();
    const byProvider = new Map(rows.map((row) => [String(row.provider || "").toLowerCase(), sanitizeRow(row)]));
    const providers = MODEL_API_PROVIDER_ORDER.map(
      (id) => byProvider.get(id) || defaultSetting(MODEL_API_PROVIDERS[id])
    );
    const status = {
      ok: true,
      available: true,
      dbPath,
      providers,
      supportedProviders: MODEL_API_PROVIDER_ORDER.map((id) => ({
        ...MODEL_API_PROVIDERS[id],
        aliases: MODEL_API_PROVIDERS[id].aliases.slice(),
        prefixes: MODEL_API_PROVIDERS[id].prefixes.slice(),
        sampleModels: MODEL_API_PROVIDERS[id].sampleModels.slice()
      }))
    };
    cache = { expiresAt: now + 30 * 1000, dbPath, status };
    return status;
  } catch (err) {
    return {
      ok: false,
      available: false,
      dbPath,
      providers: MODEL_API_PROVIDER_ORDER.map((id) => defaultSetting(MODEL_API_PROVIDERS[id])),
      supportedProviders: Object.values(MODEL_API_PROVIDERS),
      error: err && err.message ? err.message : String(err)
    };
  }
}

function modelApiRuntimeSettings() {
  const status = modelApiStatus();
  if (!status.available) return [];
  const db = database();
  try {
    const rows = db.prepare("SELECT * FROM modelApiSettings WHERE enabled = 1 ORDER BY updatedAt DESC").all();
    return rows
      .map((row) => {
        const provider = MODEL_API_PROVIDERS[String(row.provider || "").toLowerCase()];
        if (!provider) return null;
        const settings = safeJsonObject(row.settings);
        return {
          provider: provider.id,
          label: provider.label,
          protocol: provider.protocol,
          prefixes: provider.prefixes.slice(),
          apiKey: String(row.apiKey || "").trim(),
          baseUrl: normalizeBaseUrl(row.baseUrl, provider),
          url: chatUrlForProvider(provider, row.baseUrl),
          defaultModel: String(row.defaultModel || provider.defaultModel || "").trim(),
          models: splitModels(safeJsonArray(row.models)),
          anthropicVersion: String(settings.anthropicVersion || provider.anthropicVersion || "").trim()
        };
      })
      .filter((item) => item && item.apiKey);
  } finally {
    db.close();
  }
}

function saveModelApiSetting(payload = {}) {
  const id = providerId(payload.provider || payload.id);
  const provider = MODEL_API_PROVIDERS[id];
  if (!provider) {
    const err = new Error("未知模型 API。");
    err.code = "invalid_model_api_provider";
    throw err;
  }
  const db = database();
  try {
    const existing = db.prepare("SELECT * FROM modelApiSettings WHERE provider = ?").get(id);
    const incomingKey = String(payload.apiKey || payload.api_key || "").trim();
    const existingModels = existing ? splitModels(safeJsonArray(existing.models)) : provider.sampleModels;
    const models = splitModels(payload.models || payload.modelList || payload.model_list || existingModels);
    const now = new Date().toISOString();
    const settings = {
      ...safeJsonObject(existing && existing.settings),
      anthropicVersion: String(
        payload.anthropicVersion || payload.anthropic_version || provider.anthropicVersion || ""
      ).trim()
    };
    db.prepare(
      [
        "INSERT INTO modelApiSettings(provider, enabled, apiKey, baseUrl, defaultModel, models, settings, createdAt, updatedAt)",
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
        "ON CONFLICT(provider) DO UPDATE SET",
        "enabled = excluded.enabled,",
        "apiKey = excluded.apiKey,",
        "baseUrl = excluded.baseUrl,",
        "defaultModel = excluded.defaultModel,",
        "models = excluded.models,",
        "settings = excluded.settings,",
        "updatedAt = excluded.updatedAt"
      ].join(" ")
    ).run(
      id,
      payload.enabled === false || payload.isActive === false || payload.is_active === false ? 0 : 1,
      payload.clearApiKey ? "" : incomingKey || String(existing?.apiKey || ""),
      normalizeBaseUrl(payload.baseUrl || payload.base_url || existing?.baseUrl || provider.defaultBaseUrl, provider),
      String(
        payload.defaultModel || payload.default_model || existing?.defaultModel || provider.defaultModel || ""
      ).trim(),
      JSON.stringify(models.length ? models : provider.sampleModels),
      JSON.stringify(settings),
      existing?.createdAt || now,
      now
    );
    clearModelApiCache();
    try {
      const router = require("./router");
      if (router && typeof router.clearProviderDbCache === "function") router.clearProviderDbCache();
    } catch {}
    return modelApiStatus();
  } finally {
    db.close();
  }
}

function rowForProvider(id) {
  const db = database();
  try {
    return db.prepare("SELECT * FROM modelApiSettings WHERE provider = ?").get(id);
  } finally {
    db.close();
  }
}

function mergedDraftSetting(payload = {}) {
  const id = providerId(payload.provider || payload.id);
  const provider = MODEL_API_PROVIDERS[id];
  if (!provider) {
    const err = new Error("未知模型 API。");
    err.code = "invalid_model_api_provider";
    throw err;
  }
  const existing = rowForProvider(id);
  const existingSettings = safeJsonObject(existing && existing.settings);
  const incomingKey = String(payload.apiKey || payload.api_key || "").trim();
  const models = splitModels(
    payload.models ||
      payload.modelList ||
      payload.model_list ||
      (existing ? splitModels(safeJsonArray(existing.models)) : provider.sampleModels)
  );
  return {
    provider,
    id,
    apiKey: payload.clearApiKey ? "" : incomingKey || String(existing?.apiKey || "").trim(),
    baseUrl: normalizeBaseUrl(
      payload.baseUrl || payload.base_url || existing?.baseUrl || provider.defaultBaseUrl,
      provider
    ),
    defaultModel: String(
      payload.defaultModel || payload.default_model || existing?.defaultModel || provider.defaultModel || ""
    ).trim(),
    models: models.length ? models : provider.sampleModels.slice(),
    anthropicVersion: String(
      payload.anthropicVersion ||
        payload.anthropic_version ||
        existingSettings.anthropicVersion ||
        provider.anthropicVersion ||
        ""
    ).trim()
  };
}

function testModelBody(setting) {
  const model = stripPrefix(
    setting.defaultModel || setting.models[0] || setting.provider.defaultModel,
    setting.provider.prefixes
  );
  if (setting.provider.protocol === "anthropic") {
    return {
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with ok." }]
    };
  }
  return {
    model,
    messages: [{ role: "user", content: "Reply with ok." }],
    max_tokens: 16,
    stream: false
  };
}

async function testModelApiSetting(payload = {}) {
  const setting = mergedDraftSetting(payload);
  if (!setting.apiKey) {
    const err = new Error("缺少 API Key，无法测试连接。");
    err.code = "model_api_key_required";
    err.statusCode = 400;
    throw err;
  }
  const url = chatUrlForProvider(setting.provider, setting.baseUrl);
  const headers =
    setting.provider.protocol === "anthropic"
      ? {
          "content-type": "application/json",
          "x-api-key": setting.apiKey,
          "anthropic-version": setting.anthropicVersion || setting.provider.anthropicVersion || "2023-06-01"
        }
      : {
          "content-type": "application/json",
          Authorization: `Bearer ${setting.apiKey}`
        };
  const body = testModelBody(setting);
  const startedAt = Date.now();
  const timeoutMs = Math.max(1000, Math.min(60000, Number(payload.timeoutMs || payload.timeout_ms || 25000)));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    const elapsedMs = Date.now() - startedAt;
    if (!response.ok) {
      const err = new Error(
        `模型 API 测试失败（HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}）：${firstJsonErrorMessage(text)}`
      );
      err.code = "model_api_test_failed";
      err.statusCode = response.status || 502;
      err.details = { provider: setting.id, url, model: body.model, elapsedMs };
      throw err;
    }
    return {
      ok: true,
      provider: setting.id,
      label: setting.provider.label,
      protocol: setting.provider.protocol,
      url,
      model: body.model,
      status: response.status,
      elapsedMs,
      responsePreview: firstJsonErrorMessage(text)
    };
  } catch (err) {
    if (err && err.name === "AbortError") {
      const timeoutErr = new Error(`模型 API 测试超时（${timeoutMs}ms）：${url}`);
      timeoutErr.code = "model_api_test_timeout";
      timeoutErr.statusCode = 504;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function readModelAliases() {
  const db = database();
  try {
    const rows = db.prepare("SELECT key, value FROM kv WHERE scope = 'modelAliases' ORDER BY key ASC").all();
    return Object.fromEntries(
      rows
        .map((row) => {
          try {
            return [String(row.key || "").trim(), JSON.parse(String(row.value || "null"))];
          } catch {
            return [String(row.key || "").trim(), ""];
          }
        })
        .filter(([key, value]) => key && value)
    );
  } finally {
    db.close();
  }
}

function upsertModelAlias(alias, target) {
  const cleanAlias = String(alias || "").trim();
  const cleanTarget = String(target || "").trim();
  if (!cleanAlias || !cleanTarget) {
    const err = new Error("缺少 alias 或目标模型。");
    err.code = "model_alias_required";
    throw err;
  }
  const db = database();
  try {
    db.prepare("INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)").run(
      cleanAlias,
      JSON.stringify(cleanTarget)
    );
    clearModelApiCache();
    return readModelAliases();
  } finally {
    db.close();
  }
}

function deleteModelAlias(alias) {
  const cleanAlias = String(alias || "").trim();
  if (!cleanAlias) return readModelAliases();
  const db = database();
  try {
    db.prepare("DELETE FROM kv WHERE scope = 'modelAliases' AND key = ?").run(cleanAlias);
    clearModelApiCache();
    return readModelAliases();
  } finally {
    db.close();
  }
}

function resolveModelAlias(model) {
  let current = String(model || "").trim();
  if (!current) return "";
  const seen = new Set();
  for (let index = 0; index < 8; index += 1) {
    const aliases = readModelAliases();
    const lower = current.toLowerCase();
    const next = String(aliases[current] || aliases[lower] || "").trim();
    if (!next || next === current || seen.has(next)) return current;
    seen.add(current);
    current = next;
  }
  return current;
}

function stripPrefix(model, prefixes = []) {
  const text = String(model || "").trim();
  const lower = text.toLowerCase();
  const prefix = prefixes.find((item) => lower.startsWith(item));
  return prefix ? text.slice(prefix.length) : text;
}

function modelProviderId(model) {
  const lower = String(model || "")
    .trim()
    .toLowerCase();
  if (!lower.includes("/")) return "";
  const first = lower.split("/")[0];
  for (const provider of Object.values(MODEL_API_PROVIDERS)) {
    if (provider.id === first || provider.aliases.includes(first)) return provider.id;
    if (provider.prefixes.some((prefix) => prefix.replace(/\/$/, "") === first)) return provider.id;
  }
  return "";
}

function hasKnownModelApiPrefix(model) {
  return Boolean(modelProviderId(model));
}

function unprefixedModelMatches(setting, model) {
  const requested = String(model || "").trim();
  if (!requested || requested.includes("/")) return false;
  return Boolean(matchingUnprefixedModel(setting, requested));
}

function modelMatchKey(model) {
  const text = String(model || "")
    .trim()
    .toLowerCase();
  if (/^gpt-?5\.5$/.test(text)) return "gpt5.5";
  return text;
}

function matchingUnprefixedModel(setting, model) {
  const requested = modelMatchKey(model);
  if (!requested || String(model || "").includes("/")) return "";
  return [setting.defaultModel, ...setting.models].find((candidate) => modelMatchKey(candidate) === requested) || "";
}

function targetForModelApi(model) {
  const resolvedModel = resolveModelAlias(model);
  const providerFromPrefix = modelProviderId(resolvedModel);
  const settings = modelApiRuntimeSettings();
  const setting =
    settings.find((item) => item.provider === providerFromPrefix) ||
    settings.find((item) => unprefixedModelMatches(item, resolvedModel));
  if (!setting) return null;
  const provider = MODEL_API_PROVIDERS[setting.provider];
  const upstreamModel = providerFromPrefix
    ? stripPrefix(resolvedModel, provider.prefixes)
    : String(matchingUnprefixedModel(setting, resolvedModel) || resolvedModel).trim();
  return {
    kind: provider.protocol === "anthropic" ? "anthropic" : "openai-compatible",
    url: setting.url,
    model: upstreamModel,
    headers:
      provider.protocol === "anthropic"
        ? {
            "x-api-key": setting.apiKey,
            "anthropic-version": setting.anthropicVersion || provider.anthropicVersion || "2023-06-01"
          }
        : { Authorization: `Bearer ${setting.apiKey}` },
    provider: provider.id,
    connectionId: `model-api:${provider.id}`,
    connectionName: provider.label
  };
}

function modelApiDiagnostic(model) {
  const requested = String(model || "").trim();
  if (!requested) return "The request did not include a model id.";
  const resolved = resolveModelAlias(requested);
  const provider = modelProviderId(resolved);
  const settings = modelApiRuntimeSettings();
  if (provider) {
    if (!settings.some((item) => item.provider === provider)) {
      return `模型 ${resolved} 需要启用 ${MODEL_API_PROVIDERS[provider].label} 模型 API，并填写 API Key。`;
    }
    return `${MODEL_API_PROVIDERS[provider].label} 模型 API 已启用，但没有生成可用路由。`;
  }
  if (!settings.some((item) => unprefixedModelMatches(item, resolved))) {
    return `模型 ${resolved} 没有 provider 前缀，也没有出现在任何已启用模型 API 的默认模型或模型列表里。`;
  }
  return `模型 ${resolved} 匹配到模型 API 配置，但没有生成可用路由。`;
}

function configuredModelPools() {
  const pools = { commander: [], strong: [], coding: [], free: [] };
  for (const setting of modelApiStatus().providers.filter((item) => item.enabled && item.hasApiKey)) {
    const models = splitModels([setting.defaultModel, ...setting.models]);
    const prefix = setting.prefixes[0] || "";
    for (const model of models) {
      const id = hasKnownModelApiPrefix(model) || !prefix ? model : `${prefix}${model}`;
      const upstreamModel = stripPrefix(model, setting.prefixes || []);
      const lower = id.toLowerCase();
      if (/embed|image|vision|audio|tts/.test(lower)) continue;
      pools.free.push(id);
      if (/coder|code|chat|flash|mini|lite|haiku|turbo/.test(lower)) pools.coding.push(id);
      if (/pro|reason|thinking|opus|sonnet|gpt-5|grok|kimi|qwen|max|deepseek|glm/.test(lower)) pools.strong.push(id);
      if (/^gpt5\.5$/i.test(upstreamModel) || /^gpt-?5\.5$/i.test(upstreamModel)) pools.commander.push("gpt5.5");
    }
  }
  const unique = (items) => [...new Set(items.filter(Boolean))];
  return {
    commander: unique(pools.commander),
    strong: unique(pools.strong),
    coding: unique(pools.coding),
    free: unique(pools.free)
  };
}

module.exports = {
  MODEL_API_PROVIDERS,
  MODEL_API_PROVIDER_ORDER,
  clearModelApiCache,
  configuredModelPools,
  deleteModelAlias,
  modelApiDiagnostic,
  modelApiRuntimeSettings,
  modelApiStatus,
  providerId,
  readModelAliases,
  resolveModelAlias,
  saveModelApiSetting,
  targetForModelApi,
  testModelApiSetting,
  upsertModelAlias
};
