"use strict";

const crypto = require("crypto");
const configLoader = require("../../config/loader");
const mockAdapter = require("./adapter-mock");
const playwrightAdapter = require("./adapter-playwright");

const sessions = new Map();

function nowIso() {
  return new Date().toISOString();
}

function sessionId() {
  return `browser-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function browserConfig(options = {}) {
  const loaded = options.config || configLoader.loadRuntimeConfig();
  return {
    ...((loaded.tools && loaded.tools.browser) || {}),
    ...(options.browser || options.browserConfig || {})
  };
}

function sessionStatus(session) {
  return {
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    browserType: session.browserType,
    headless: session.headless,
    adapter: session.adapterName,
    currentUrl: session.currentUrl || "",
    status: session.status
  };
}

async function createAdapter(config, options = {}) {
  const requested = String(
    options.adapter || config.adapter || (config.useMockAdapter ? "mock" : "playwright")
  ).toLowerCase();
  const wantsPlaywright =
    requested === "playwright" || (config.allowRealBrowser === true && config.useMockAdapter === false);
  if (wantsPlaywright) {
    try {
      return await playwrightAdapter.createSession({ ...config, ...options });
    } catch (err) {
      if (config.allowMockFallback === false || options.allowMockFallback === false) throw err;
      const fallback = await mockAdapter.createSession({ ...config, ...options });
      fallback.fallbackReason = err && err.message ? err.message : String(err);
      return fallback;
    }
  }
  return mockAdapter.createSession({ ...config, ...options });
}

async function createBrowserSession(options = {}) {
  const startedAt = Date.now();
  const config = browserConfig(options);
  try {
    const adapter = await createAdapter(config, options);
    const id = options.sessionId || sessionId();
    const session = {
      sessionId: id,
      adapter,
      adapterName: adapter.adapter || "mock",
      browserType: adapter.browserType || config.browserType || "mock",
      headless: adapter.headless !== false,
      createdAt: nowIso(),
      lastUsedAt: nowIso(),
      currentUrl: "",
      status: "active",
      ttlMs: Number(config.sessionTtlMs || 10 * 60 * 1000),
      config
    };
    sessions.set(id, session);
    return {
      ok: true,
      action: "create_session",
      ...sessionStatus(session),
      durationMs: Date.now() - startedAt,
      metadata: adapter.fallbackReason ? { fallbackReason: adapter.fallbackReason } : {},
      error: ""
    };
  } catch (err) {
    return {
      ok: false,
      action: "create_session",
      sessionId: "",
      durationMs: Date.now() - startedAt,
      metadata: {},
      error: err && err.message ? err.message : String(err)
    };
  }
}

function getBrowserSession(id) {
  return sessions.get(String(id || ""));
}

function touchSession(session, currentUrl) {
  session.lastUsedAt = nowIso();
  if (currentUrl != null) session.currentUrl = String(currentUrl || "");
}

function listBrowserSessions() {
  return [...sessions.values()].map(sessionStatus);
}

function getBrowserSessionStatus(id) {
  const session = getBrowserSession(id);
  return session ? sessionStatus(session) : null;
}

async function closeBrowserSession(id) {
  const startedAt = Date.now();
  const session = getBrowserSession(id);
  if (!session) {
    return {
      ok: false,
      action: "close_session",
      sessionId: String(id || ""),
      durationMs: Date.now() - startedAt,
      error: "Browser session not found."
    };
  }
  try {
    await session.adapter.close();
    session.status = "closed";
    sessions.delete(session.sessionId);
    return {
      ok: true,
      action: "close_session",
      ...sessionStatus(session),
      durationMs: Date.now() - startedAt,
      error: ""
    };
  } catch (err) {
    sessions.delete(session.sessionId);
    return {
      ok: false,
      action: "close_session",
      ...sessionStatus(session),
      durationMs: Date.now() - startedAt,
      error: err && err.message ? err.message : String(err)
    };
  }
}

async function cleanupExpiredSessions() {
  const now = Date.now();
  const closed = [];
  for (const session of sessions.values()) {
    const last = Date.parse(session.lastUsedAt || session.createdAt || "");
    if (Number.isFinite(last) && now - last > Number(session.ttlMs || 0)) {
      await closeBrowserSession(session.sessionId);
      closed.push(session.sessionId);
    }
  }
  return closed;
}

module.exports = {
  cleanupExpiredSessions,
  closeBrowserSession,
  createBrowserSession,
  getBrowserSession,
  getBrowserSessionStatus,
  listBrowserSessions,
  sessionStatus,
  touchSession
};
