"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { agentRoutePath } = require("../../shared/utils/agent-home");
const { OPENAI_COMPAT_PROVIDER_TARGETS, PROVIDER_ALIASES, clearProviderDbCache } = require("../router");
const {
  knownProvider,
  modelsForProvider,
  normalizeCatalogProvider,
  providerAuthType,
  providerCatalog
} = require("./provider-catalog");

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

function safeJsonValue(value, fallback = null) {
  try {
    return JSON.parse(String(value || "null"));
  } catch {
    return fallback;
  }
}

function database() {
  const Database = require("better-sqlite3");
  const dbPath = dataDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(
    [
      "CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY, data TEXT)",
      [
        "CREATE TABLE IF NOT EXISTS providerConnections(",
        "id TEXT PRIMARY KEY,",
        "provider TEXT,",
        "authType TEXT,",
        "name TEXT,",
        "email TEXT,",
        "priority INTEGER,",
        "isActive INTEGER,",
        "data TEXT,",
        "createdAt TEXT,",
        "updatedAt TEXT",
        ")"
      ].join(" "),
      [
        "CREATE TABLE IF NOT EXISTS providerNodes(",
        "id TEXT PRIMARY KEY,",
        "type TEXT,",
        "name TEXT,",
        "data TEXT,",
        "createdAt TEXT,",
        "updatedAt TEXT",
        ")"
      ].join(" "),
      "CREATE TABLE IF NOT EXISTS kv(scope TEXT, key TEXT, value TEXT, PRIMARY KEY(scope, key))"
    ].join(";")
  );
  return db;
}

function sanitizeProviderNode(row) {
  const data = safeJsonObject(row.data);
  const prefix = String(data.prefix || row.id || "")
    .trim()
    .toLowerCase();
  return {
    id: String(row.id || ""),
    type: String(row.type || data.type || "openai-compatible"),
    name: String(row.name || data.name || row.id || ""),
    prefix,
    baseUrl: String(data.baseUrl || data.base_url || ""),
    apiType: String(data.apiType || data.api_type || "chat"),
    models: Array.isArray(data.models) ? data.models : [],
    createdAt: String(row.createdAt || ""),
    updatedAt: String(row.updatedAt || "")
  };
}

function readProviderNodes(db) {
  try {
    return db
      .prepare("SELECT id, type, name, data, createdAt, updatedAt FROM providerNodes ORDER BY createdAt DESC")
      .all()
      .map(sanitizeProviderNode);
  } catch {
    return [];
  }
}

function providerNodeById(db, id) {
  if (!id) return null;
  try {
    const row = db.prepare("SELECT id, type, name, data, createdAt, updatedAt FROM providerNodes WHERE id = ?").get(id);
    return row ? sanitizeProviderNode(row) : null;
  } catch {
    return null;
  }
}

function supportedProviders(nodes = []) {
  const catalog = providerCatalog({ proxyTargets: OPENAI_COMPAT_PROVIDER_TARGETS });
  const customProviders = nodes.map((node) => ({
    id: node.id,
    label: node.name,
    name: node.name,
    alias: node.prefix || node.id,
    authType: "apikey",
    category: "custom",
    modelPrefixes: [node.prefix || node.id],
    models: node.models || [],
    sampleModels: (node.models || []).slice(0, 5).map((model) => `${node.prefix || node.id}/${model.id || model}`),
    proxySupported: node.type === "openai-compatible",
    defaultUrl: node.baseUrl,
    custom: true
  }));
  return [...catalog.providers, ...customProviders];
}

function providerGroups(nodes = []) {
  const catalog = providerCatalog({ proxyTargets: OPENAI_COMPAT_PROVIDER_TARGETS });
  return {
    oauthProviders: catalog.oauthProviders,
    apiKeyProviders: catalog.apiKeyProviders,
    customProviders: supportedProviders(nodes).filter((provider) => provider.custom),
    providerModels: catalog.providerModels
  };
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "••••";
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

function normalizeOAuthData(value = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    accessToken: String(input.accessToken || input.access_token || "").trim(),
    refreshToken: String(input.refreshToken || input.refresh_token || "").trim(),
    idToken: String(input.idToken || input.id_token || "").trim(),
    tokenType: String(input.tokenType || input.token_type || "").trim(),
    scope: String(input.scope || "").trim(),
    expiresAt: String(input.expiresAt || input.expires_at || "").trim(),
    providerAuthMethod: String(input.providerAuthMethod || input.provider_auth_method || "").trim(),
    machineId: String(input.machineId || input.machine_id || "").trim(),
    importedAt: String(input.importedAt || input.imported_at || "").trim()
  };
}

function compactOAuthData(value = {}) {
  return Object.fromEntries(Object.entries(normalizeOAuthData(value)).filter(([, item]) => Boolean(item)));
}

function hasOAuthCredential(value = {}) {
  const oauth = normalizeOAuthData(value);
  return Boolean(oauth.accessToken || oauth.refreshToken || oauth.idToken);
}

function normalizeProvider(value, db = null) {
  const provider = normalizeCatalogProvider(value);
  if (!provider) return "";
  if (knownProvider(provider)) return provider;
  if (db && providerNodeById(db, provider)) return provider;
  return "";
}

function providerRecord(provider, nodeMap = {}) {
  const known = knownProvider(provider);
  if (known) {
    return {
      id: provider,
      label: known.name,
      name: known.name,
      authType: providerAuthType(provider),
      alias: known.alias || provider,
      custom: false
    };
  }
  const node = nodeMap[provider];
  if (node) {
    return {
      id: node.id,
      label: node.name,
      name: node.name,
      authType: "apikey",
      alias: node.prefix || node.id,
      custom: true
    };
  }
  return {
    id: provider,
    label: provider,
    name: provider,
    authType: "apikey",
    alias: provider,
    custom: false
  };
}

function sanitizeConnection(row, nodeMap = {}) {
  const data = safeJsonObject(row.data);
  const providerSpecificData =
    data.providerSpecificData && typeof data.providerSpecificData === "object" ? data.providerSpecificData : {};
  const oauth = normalizeOAuthData(data.oauth);
  const provider = normalizeCatalogProvider(row.provider);
  const providerInfo = providerRecord(provider, nodeMap);
  return {
    id: String(row.id || ""),
    provider,
    providerLabel: providerInfo.label,
    providerAlias: providerInfo.alias,
    providerCustom: Boolean(providerInfo.custom),
    authType: String(row.authType || "apikey").toLowerCase(),
    name: String(row.name || ""),
    email: String(row.email || data.email || ""),
    priority: Number(row.priority || 1),
    isActive: row.isActive !== 0,
    hasApiKey: Boolean(data.apiKey),
    apiKeyMasked: maskSecret(data.apiKey),
    hasOAuthToken: hasOAuthCredential(oauth),
    oauthTokenType: oauth.tokenType || "",
    oauthScope: oauth.scope || "",
    oauthExpiresAt: oauth.expiresAt || "",
    oauthProviderAuthMethod: oauth.providerAuthMethod || "",
    baseUrl: String(providerSpecificData.baseUrl || providerSpecificData.baseURL || providerSpecificData.apiBase || ""),
    defaultModel: String(data.defaultModel || providerSpecificData.defaultModel || ""),
    connectionProxyEnabled: Boolean(providerSpecificData.connectionProxyEnabled),
    connectionProxyUrl: String(providerSpecificData.connectionProxyUrl || ""),
    connectionNoProxy: String(providerSpecificData.connectionNoProxy || ""),
    testStatus: String(data.testStatus || "").toLowerCase(),
    testMessage: String(data.testMessage || ""),
    models: nodeMap[provider] ? nodeMap[provider].models || [] : modelsForProvider(provider),
    createdAt: String(row.createdAt || ""),
    updatedAt: String(row.updatedAt || "")
  };
}

function providerStatus() {
  try {
    const db = database();
    const nodes = readProviderNodes(db);
    const nodeMap = Object.fromEntries(nodes.map((node) => [node.id, node]));
    const rows = db
      .prepare(
        [
          "SELECT id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt",
          "FROM providerConnections",
          "ORDER BY COALESCE(priority, 9999) ASC, createdAt DESC"
        ].join(" ")
      )
      .all();
    db.close();
    return {
      ok: true,
      available: true,
      dbPath: dataDbPath(),
      supportedProviders: supportedProviders(nodes),
      providerGroups: providerGroups(nodes),
      providerNodes: nodes,
      connections: rows.map((row) => sanitizeConnection(row, nodeMap))
    };
  } catch (err) {
    return {
      ok: false,
      available: false,
      dbPath: dataDbPath(),
      supportedProviders: supportedProviders(),
      providerGroups: providerGroups(),
      providerNodes: [],
      connections: [],
      error: err && err.message ? err.message : String(err)
    };
  }
}

function existingConnection(db, id) {
  if (!id) return null;
  const row = db
    .prepare(
      "SELECT id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt FROM providerConnections WHERE id = ?"
    )
    .get(id);
  return row || null;
}

function sanitizeConnectionRow(db, row) {
  if (!row) return null;
  const nodes = readProviderNodes(db);
  const nodeMap = Object.fromEntries(nodes.map((node) => [node.id, node]));
  return sanitizeConnection(row, nodeMap);
}

function getProviderConnection(id) {
  const db = database();
  try {
    return sanitizeConnectionRow(db, existingConnection(db, id));
  } finally {
    db.close();
  }
}

function providerDetails(id) {
  const providerId = normalizeCatalogProvider(id);
  const status = providerStatus();
  const connection = status.connections.find((item) => item.id === id) || null;
  const provider =
    status.supportedProviders.find((item) => item.id === providerId || item.alias === providerId) ||
    status.supportedProviders.find((item) => item.id === id) ||
    null;
  const node = status.providerNodes.find((item) => item.id === providerId || item.prefix === providerId) || null;
  const providerKey = provider?.id || node?.id || connection?.provider || providerId;
  return {
    ok: true,
    provider: provider || (node ? { ...node, authType: "apikey", custom: true } : null),
    connection,
    connections: status.connections.filter(
      (item) => item.provider === providerKey || item.providerAlias === providerKey
    ),
    providerNode: node,
    supportedProviders: status.supportedProviders,
    providerGroups: status.providerGroups,
    providerNodes: status.providerNodes
  };
}

function upsertProviderConnection(payload = {}) {
  const db = database();
  const provider = normalizeProvider(payload.provider, db);
  if (!provider) {
    db.close();
    const err = new Error("请选择已支持的供应商或已配置的自定义 Provider。");
    err.code = "invalid_provider";
    throw err;
  }

  const now = new Date().toISOString();
  const id = String(payload.id || "").trim() || `${provider}-${crypto.randomUUID()}`;
  try {
    const existing = existingConnection(db, id);
    const authType = providerAuthType(provider) || "apikey";
    const existingData = existing ? safeJsonObject(existing.data) : {};
    const existingOAuth = compactOAuthData(existingData.oauth);
    const incomingOAuthInput = payload.oauth && typeof payload.oauth === "object" ? { ...payload.oauth } : {};
    [
      ["accessToken", "access_token"],
      ["refreshToken", "refresh_token"],
      ["idToken", "id_token"],
      ["tokenType", "token_type"],
      ["expiresAt", "expires_at"],
      ["providerAuthMethod", "provider_auth_method"],
      ["machineId", "machine_id"],
      ["importedAt", "imported_at"]
    ].forEach(([camelKey, snakeKey]) => {
      const value = payload[camelKey] || payload[snakeKey];
      if (value) incomingOAuthInput[camelKey] = value;
    });
    if (payload.scope) incomingOAuthInput.scope = payload.scope;
    const incomingOAuth = compactOAuthData(incomingOAuthInput);
    const existingProviderData =
      existingData.providerSpecificData && typeof existingData.providerSpecificData === "object"
        ? existingData.providerSpecificData
        : {};
    const incomingKey = String(payload.apiKey || payload.api_key || "").trim();
    if (!incomingKey && !existingData.apiKey && authType === "apikey") {
      const err = new Error("新建 API Key 供应商连接需要填写 API Key。");
      err.code = "provider_api_key_required";
      throw err;
    }
    if (authType === "oauth" && !hasOAuthCredential({ ...existingOAuth, ...incomingOAuth })) {
      const err = new Error("新建 OAuth 供应商连接需要先完成授权、设备码确认或手动导入 token。");
      err.code = "provider_oauth_token_required";
      throw err;
    }
    const providerSpecificData = {
      ...existingProviderData,
      baseUrl: String(payload.baseUrl || payload.base_url || existingProviderData.baseUrl || "").trim(),
      defaultModel: String(
        payload.defaultModel || payload.default_model || existingProviderData.defaultModel || ""
      ).trim(),
      connectionProxyEnabled: Boolean(payload.connectionProxyEnabled || payload.connection_proxy_enabled),
      connectionProxyUrl: String(payload.connectionProxyUrl || payload.connection_proxy_url || "").trim(),
      connectionNoProxy: String(payload.connectionNoProxy || payload.connection_no_proxy || "").trim()
    };
    const data = {
      ...existingData,
      apiKey: payload.clearApiKey ? "" : incomingKey || existingData.apiKey || "",
      oauth: authType === "oauth" ? { ...existingOAuth, ...incomingOAuth } : existingData.oauth,
      testStatus: String(payload.testStatus || existingData.testStatus || "").toLowerCase(),
      defaultModel: String(payload.defaultModel || payload.default_model || existingData.defaultModel || "").trim(),
      providerSpecificData
    };
    const known = knownProvider(provider);
    const record = {
      id,
      provider,
      authType,
      name: String(payload.name || existing?.name || known?.name || provider).trim(),
      email: String(payload.email || existing?.email || existingData.email || "").trim() || null,
      priority: Number.isFinite(Number(payload.priority)) ? Number(payload.priority) : Number(existing?.priority || 1),
      isActive: payload.isActive === false || payload.is_active === false ? 0 : 1,
      data: JSON.stringify(data),
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    db.prepare(
      [
        "INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)",
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        "ON CONFLICT(id) DO UPDATE SET",
        "provider = excluded.provider,",
        "authType = excluded.authType,",
        "name = excluded.name,",
        "email = excluded.email,",
        "priority = excluded.priority,",
        "isActive = excluded.isActive,",
        "data = excluded.data,",
        "updatedAt = excluded.updatedAt"
      ].join(" ")
    ).run(
      record.id,
      record.provider,
      record.authType,
      record.name,
      record.email,
      record.priority,
      record.isActive,
      record.data,
      record.createdAt,
      record.updatedAt
    );
    clearProviderDbCache();
  } finally {
    db.close();
  }
  return providerStatus();
}

function createProviderConnection(payload = {}) {
  return upsertProviderConnection(payload);
}

function updateProviderConnection(id, payload = {}) {
  const db = database();
  let existing;
  try {
    existing = existingConnection(db, id);
    if (!existing) {
      const err = new Error("供应商连接不存在。");
      err.code = "provider_connection_not_found";
      throw err;
    }
  } finally {
    db.close();
  }
  const existingData = safeJsonObject(existing.data);
  const existingProviderData =
    existingData.providerSpecificData && typeof existingData.providerSpecificData === "object"
      ? existingData.providerSpecificData
      : {};
  return upsertProviderConnection({
    id,
    provider: payload.provider || existing.provider,
    name: payload.name ?? existing.name,
    apiKey: payload.apiKey || payload.api_key || "",
    clearApiKey: payload.clearApiKey,
    priority: payload.priority ?? existing.priority,
    isActive: Object.prototype.hasOwnProperty.call(payload, "isActive")
      ? payload.isActive
      : Object.prototype.hasOwnProperty.call(payload, "is_active")
        ? payload.is_active
        : existing.isActive !== 0,
    baseUrl: payload.baseUrl ?? payload.base_url ?? existingProviderData.baseUrl,
    defaultModel: payload.defaultModel ?? payload.default_model ?? existingData.defaultModel,
    connectionProxyEnabled: payload.connectionProxyEnabled ?? existingProviderData.connectionProxyEnabled,
    connectionProxyUrl: payload.connectionProxyUrl ?? existingProviderData.connectionProxyUrl,
    connectionNoProxy: payload.connectionNoProxy ?? existingProviderData.connectionNoProxy,
    testStatus: payload.testStatus ?? existingData.testStatus
  });
}

function validateProviderConnection(payload = {}) {
  const db = database();
  try {
    const provider = normalizeProvider(payload.provider || payload.id, db);
    if (!provider) return { valid: false, error: "未知供应商。" };
    const authType = providerAuthType(provider) || "apikey";
    if (authType === "oauth") {
      return { valid: true, warning: "OAuth 授权需要通过对应授权流程完成。" };
    }
    const existing = payload.id ? existingConnection(db, payload.id) : null;
    const existingData = existing ? safeJsonObject(existing.data) : {};
    const apiKey = String(payload.apiKey || payload.api_key || existingData.apiKey || "").trim();
    if (!apiKey) return { valid: false, error: "API Key 不能为空。" };
    return { valid: true };
  } finally {
    db.close();
  }
}

function upsertProviderNode(payload = {}) {
  const type = String(payload.type || "openai-compatible").trim();
  if (!["openai-compatible", "anthropic-compatible"].includes(type)) {
    const err = new Error("自定义 Provider 类型只支持 openai-compatible 或 anthropic-compatible。");
    err.code = "invalid_provider_node_type";
    throw err;
  }
  const prefix = String(payload.prefix || payload.id || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  if (!prefix) {
    const err = new Error("自定义 Provider 需要配置模型前缀。");
    err.code = "provider_node_prefix_required";
    throw err;
  }
  const name = String(payload.name || prefix).trim();
  const baseUrl = String(payload.baseUrl || payload.base_url || "").trim();
  if (!baseUrl) {
    const err = new Error("自定义 Provider 需要配置 Base URL。");
    err.code = "provider_node_base_url_required";
    throw err;
  }
  const now = new Date().toISOString();
  const id = prefix;
  const models = Array.isArray(payload.models)
    ? payload.models
    : String(payload.models || "")
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => ({ id: item }));
  const data = {
    prefix,
    baseUrl,
    apiType: String(payload.apiType || payload.api_type || "chat").trim(),
    models
  };
  const db = database();
  try {
    const existing = providerNodeById(db, id);
    db.prepare(
      [
        "INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt)",
        "VALUES(?, ?, ?, ?, ?, ?)",
        "ON CONFLICT(id) DO UPDATE SET",
        "type = excluded.type,",
        "name = excluded.name,",
        "data = excluded.data,",
        "updatedAt = excluded.updatedAt"
      ].join(" ")
    ).run(id, type, name, JSON.stringify(data), existing?.createdAt || now, now);
    clearProviderDbCache();
  } finally {
    db.close();
  }
  return providerStatus();
}

function listProviderNodes() {
  const db = database();
  try {
    return readProviderNodes(db);
  } finally {
    db.close();
  }
}

function getProviderNode(id) {
  const db = database();
  try {
    return providerNodeById(db, id);
  } finally {
    db.close();
  }
}

function validateProviderNode(payload = {}) {
  const prefix = String(payload.prefix || payload.id || "")
    .trim()
    .toLowerCase();
  const baseUrl = String(payload.baseUrl || payload.base_url || "").trim();
  const type = String(payload.type || "openai-compatible").trim();
  if (!prefix) return { valid: false, error: "模型前缀不能为空。" };
  if (!/^[a-z0-9_-]+$/.test(prefix)) return { valid: false, error: "模型前缀只能包含小写字母、数字、下划线和短横线。" };
  if (!baseUrl) return { valid: false, error: "Base URL 不能为空。" };
  if (!/^https?:\/\//i.test(baseUrl)) return { valid: false, error: "Base URL 必须是 http 或 https 地址。" };
  if (!["openai-compatible", "anthropic-compatible"].includes(type)) {
    return { valid: false, error: "自定义 Provider 类型不支持。" };
  }
  return { valid: true };
}

function deleteProviderNode(id) {
  const nodeId = String(id || "").trim();
  if (!nodeId) {
    const err = new Error("缺少自定义 Provider ID。");
    err.code = "provider_node_id_required";
    throw err;
  }
  const db = database();
  try {
    db.prepare("DELETE FROM providerNodes WHERE id = ?").run(nodeId);
    db.prepare("DELETE FROM providerConnections WHERE provider = ?").run(nodeId);
    clearProviderDbCache();
  } finally {
    db.close();
  }
  return providerStatus();
}

function testProviderConnection(id) {
  const connectionId = String(id || "").trim();
  if (!connectionId) {
    const err = new Error("缺少供应商连接 ID。");
    err.code = "provider_connection_id_required";
    throw err;
  }
  const db = database();
  try {
    const row = existingConnection(db, connectionId);
    if (!row) {
      const err = new Error("供应商连接不存在。");
      err.code = "provider_connection_not_found";
      throw err;
    }
    const data = safeJsonObject(row.data);
    const authType = String(row.authType || "").toLowerCase();
    const hasOAuth = hasOAuthCredential(data.oauth);
    const canRoute =
      authType === "apikey" &&
      Boolean(data.apiKey) &&
      Boolean(OPENAI_COMPAT_PROVIDER_TARGETS[normalizeCatalogProvider(row.provider)]);
    const testStatus = canRoute || hasOAuth ? "active" : "manual_review";
    const testMessage = canRoute
      ? "本地配置完整；实际可用性会在模型代理请求时由上游响应确认。"
      : hasOAuth
        ? "OAuth 凭据已保存；当前连接会在对应 OAuth 供应商运行时由上游响应确认。"
        : "该连接不是当前 Agent 内部模型调用可直接测试的 OpenAI-compatible API Key 连接。";
    const nextData = {
      ...data,
      testStatus,
      testMessage
    };
    db.prepare("UPDATE providerConnections SET data = ?, updatedAt = ? WHERE id = ?").run(
      JSON.stringify(nextData),
      new Date().toISOString(),
      connectionId
    );
    clearProviderDbCache();
    return {
      ok: canRoute || hasOAuth,
      valid: canRoute || hasOAuth,
      testStatus,
      message: testMessage,
      providerSettings: providerStatus()
    };
  } finally {
    db.close();
  }
}

function testProviderBatch(payload = {}) {
  const status = providerStatus();
  const mode = String(payload.mode || "").toLowerCase();
  const providerId = normalizeCatalogProvider(payload.providerId || payload.provider_id || payload.provider || "");
  const candidates = status.connections.filter((connection) => {
    if (providerId && connection.provider !== providerId) return false;
    if (mode === "oauth" && connection.authType !== "oauth") return false;
    if ((mode === "apikey" || mode === "api-key") && connection.authType !== "apikey") return false;
    return true;
  });
  const results = [];
  for (const connection of candidates) {
    try {
      const result = testProviderConnection(connection.id);
      results.push({
        id: connection.id,
        provider: connection.provider,
        name: connection.name,
        valid: Boolean(result.valid),
        message: result.message || ""
      });
    } catch (err) {
      results.push({
        id: connection.id,
        provider: connection.provider,
        name: connection.name,
        valid: false,
        error: err && err.message ? err.message : String(err)
      });
    }
  }
  return {
    ok: true,
    summary: {
      total: results.length,
      passed: results.filter((item) => item.valid).length,
      failed: results.filter((item) => !item.valid).length
    },
    results,
    providerSettings: providerStatus()
  };
}

function providerModels(id) {
  const providerId = normalizeCatalogProvider(id);
  const status = providerStatus();
  const connection = status.connections.find((item) => item.id === id) || null;
  const node = status.providerNodes.find((item) => item.id === providerId || item.prefix === providerId) || null;
  const provider = connection?.provider || node?.id || providerId;
  const catalogProvider =
    status.supportedProviders.find((item) => item.id === provider || item.alias === provider) ||
    status.supportedProviders.find((item) => item.id === id);
  const models = node ? node.models || [] : catalogProvider?.models || modelsForProvider(provider);
  return {
    ok: true,
    provider,
    connection,
    models: (models || []).map((model) => (typeof model === "string" ? { id: model } : model))
  };
}

function readModelAliases() {
  const db = database();
  try {
    const rows = db.prepare("SELECT key, value FROM kv WHERE scope = 'modelAliases' ORDER BY key ASC").all();
    return Object.fromEntries(rows.map((row) => [row.key, safeJsonValue(row.value, "")]).filter(([, value]) => value));
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
    clearProviderDbCache();
  } finally {
    db.close();
  }
  return readModelAliases();
}

function deleteModelAlias(alias) {
  const cleanAlias = String(alias || "").trim();
  if (!cleanAlias) return readModelAliases();
  const db = database();
  try {
    db.prepare("DELETE FROM kv WHERE scope = 'modelAliases' AND key = ?").run(cleanAlias);
    clearProviderDbCache();
  } finally {
    db.close();
  }
  return readModelAliases();
}

function deleteProviderConnection(id) {
  const connectionId = String(id || "").trim();
  if (!connectionId) {
    const err = new Error("缺少供应商连接 ID。");
    err.code = "provider_connection_id_required";
    throw err;
  }
  const db = database();
  try {
    db.prepare("DELETE FROM providerConnections WHERE id = ?").run(connectionId);
    clearProviderDbCache();
  } finally {
    db.close();
  }
  return providerStatus();
}

module.exports = {
  createProviderConnection,
  providerStatus,
  providerDetails,
  getProviderConnection,
  updateProviderConnection,
  validateProviderConnection,
  upsertProviderConnection,
  deleteProviderConnection,
  upsertProviderNode,
  listProviderNodes,
  getProviderNode,
  validateProviderNode,
  deleteProviderNode,
  testProviderConnection,
  testProviderBatch,
  providerModels,
  readModelAliases,
  upsertModelAlias,
  deleteModelAlias,
  supportedProviders,
  sanitizeConnection
};
