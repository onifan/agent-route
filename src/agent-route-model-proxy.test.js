"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-model-proxy-"));
process.env.AGENT_ROUTE_HOME = testRoot;
process.env.AGENT_ROUTE_TASKS = path.join(testRoot, "tasks.json");
process.env.AGENT_ROUTE_MEMORY = path.join(testRoot, "memory.json");
process.env.AGENT_ROUTE_DB = path.join(testRoot, "missing.sqlite");
process.env.AGENT_ROUTE_CONFIG = path.join(testRoot, "config.json");
fs.writeFileSync(
  process.env.AGENT_ROUTE_CONFIG,
  JSON.stringify({
    dynamicFreeModels: false,
    maxTasks: 2,
    maxGoalIterations: 1,
    verifierModelEnabled: false,
    modelPools: {
      commander: ["cx/gpt-test-commander"],
      strong: ["openrouter/test-strong"],
      coding: ["openrouter/test-coding"],
      free: ["openrouter/test-free:free"]
    }
  })
);

delete process.env.AGENT_ROUTE_UPSTREAM_CHAT_URL;
delete process.env.AGENT_ROUTE_MODEL_PROXY_URL;
delete process.env.AGENT_ROUTE_UPSTREAM_RESPONSES_URL;
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_API_KEY;

const agentRoute = require("./agent-route");
const coreRouter = require("./core/router");
const modelRoutingService = require("./agent/orchestrator/model-routing-service");
const taskRuntime = require("./agent-route-task-runtime");
const memoryRuntime = require("./agent-route-memory-runtime");

function request(url, body) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function createProviderDb(dbPath, connections) {
  const Database = require("better-sqlite3");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(
    [
      "CREATE TABLE settings(id INTEGER PRIMARY KEY, data TEXT)",
      "CREATE TABLE providerConnections(id TEXT PRIMARY KEY, provider TEXT, authType TEXT, name TEXT, email TEXT, priority INTEGER, isActive INTEGER, data TEXT, createdAt TEXT, updatedAt TEXT)"
    ].join(";")
  );
  db.prepare("INSERT INTO settings(id, data) VALUES(1, ?)").run(JSON.stringify({ outboundProxyEnabled: false }));
  const insert = db.prepare(
    [
      "INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)",
      "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")
  );
  for (const connection of connections) {
    insert.run(
      connection.id,
      connection.provider,
      connection.authType || "apikey",
      connection.name || null,
      null,
      connection.priority || 1,
      connection.isActive === false ? 0 : 1,
      JSON.stringify(connection.data || {}),
      new Date().toISOString(),
      new Date().toISOString()
    );
  }
  db.close();
}

async function testModelProxyUsesCodexOAuthConnectionsWithFailover() {
  const providerDb = path.join(testRoot, "provider-db-codex-oauth-failover", "data.sqlite");
  createProviderDb(providerDb, [
    {
      id: "codex-oauth-primary",
      provider: "codex",
      authType: "oauth",
      priority: 1,
      data: {
        oauth: {
          accessToken: "codex-exhausted-token",
          tokenType: "Bearer"
        },
        providerSpecificData: {
          baseUrl: "https://codex-oauth-proxy.example.test/v1"
        },
        testStatus: "active"
      }
    },
    {
      id: "codex-oauth-secondary",
      provider: "codex",
      authType: "oauth",
      priority: 2,
      data: {
        oauth: {
          accessToken: "codex-healthy-token",
          tokenType: "Bearer"
        },
        providerSpecificData: {
          baseUrl: "https://codex-oauth-proxy.example.test/v1"
        },
        testStatus: "active"
      }
    }
  ]);

  const previousDb = process.env.AGENT_ROUTE_DB;
  const previousFetch = global.fetch;
  process.env.AGENT_ROUTE_DB = providerDb;
  const attempts = [];
  global.fetch = async (url, options = {}) => {
    attempts.push({
      url: String(url),
      authorization: options.headers && options.headers.Authorization,
      body: JSON.parse(options.body || "{}")
    });
    if (options.headers.Authorization === "Bearer codex-exhausted-token") {
      return new Response(JSON.stringify({ error: { message: "usage limit reached" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(
      JSON.stringify({
        model: "cx/gpt-5.2-codex",
        choices: [{ message: { content: "ok from second Codex OAuth account" } }]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  };

  try {
    const response = await coreRouter.handleModelProxy(
      request("http://localhost/api/v1/chat/completions", {
        model: "cx/gpt-5.2-codex",
        messages: [{ role: "user", content: "hello" }]
      }),
      { endpointMode: "chat" }
    );
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.choices[0].message.content, "ok from second Codex OAuth account");
    assert.equal(json.model, "cx/gpt-5.2-codex");
    assert.deepEqual(
      attempts.map((attempt) => attempt.authorization),
      ["Bearer codex-exhausted-token", "Bearer codex-healthy-token"]
    );
    assert.equal(attempts[0].url, "https://codex-oauth-proxy.example.test/v1/chat/completions");
    assert.equal(attempts[0].body.model, "gpt-5.2-codex");
    assert.equal(attempts[0].body.messages[0].content, "hello");
  } finally {
    process.env.AGENT_ROUTE_DB = previousDb;
    global.fetch = previousFetch;
  }
}

async function testUnconfiguredModelProxyHasSpecificError() {
  const response = await coreRouter.handleModelProxy(
    request("http://localhost/api/v1/chat/completions", {
      model: "cx/test-commander",
      messages: [{ role: "user", content: "hello" }]
    }),
    { endpointMode: "chat" }
  );
  assert.equal(response.status, 503);
  const json = await response.json();
  assert.equal(json.error.code, "model_proxy_unconfigured");
  assert.match(json.error.message, /No upstream model route is configured/);
  assert.doesNotMatch(json.error.message, /only handles goal-driven agent requests/i);
}

async function testModelProxyReadsConfiguredOpenRouterProvider() {
  const providerDb = path.join(testRoot, "provider-db", "data.sqlite");
  createProviderDb(providerDb, [
    {
      id: "openrouter-1",
      provider: "openrouter",
      data: {
        apiKey: "stub-key",
        testStatus: "active"
      }
    }
  ]);

  const previousDb = process.env.AGENT_ROUTE_DB;
  const previousFetch = global.fetch;
  process.env.AGENT_ROUTE_DB = providerDb;
  let captured = null;
  global.fetch = async (url, options = {}) => {
    captured = {
      url: String(url),
      headers: options.headers || {},
      body: JSON.parse(options.body || "{}")
    };
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok from configured provider" } }]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  };

  try {
    const response = await coreRouter.handleModelProxy(
      request("http://localhost/api/v1/chat/completions", {
        model: "openrouter/qwen/qwen3-coder:free",
        messages: [{ role: "user", content: "hello" }]
      }),
      { endpointMode: "chat" }
    );
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.choices[0].message.content, "ok from configured provider");
    assert.equal(captured.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(captured.body.model, "qwen/qwen3-coder:free");
    assert.equal(captured.headers.Authorization, "Bearer stub-key");
  } finally {
    process.env.AGENT_ROUTE_DB = previousDb;
    global.fetch = previousFetch;
  }
}

async function testModelProxyFailsOverConfiguredConnectionsOnProviderLimit() {
  const providerDb = path.join(testRoot, "provider-db-failover", "data.sqlite");
  createProviderDb(providerDb, [
    {
      id: "provider-primary",
      provider: "openrouter",
      priority: 1,
      data: {
        apiKey: "exhausted-key",
        testStatus: "active"
      }
    },
    {
      id: "provider-secondary",
      provider: "openrouter",
      priority: 2,
      data: {
        apiKey: "healthy-key",
        testStatus: "active"
      }
    }
  ]);

  const previousDb = process.env.AGENT_ROUTE_DB;
  const previousFetch = global.fetch;
  process.env.AGENT_ROUTE_DB = providerDb;
  const attempts = [];
  global.fetch = async (url, options = {}) => {
    attempts.push({
      url: String(url),
      authorization: options.headers && options.headers.Authorization,
      body: JSON.parse(options.body || "{}")
    });
    if (options.headers.Authorization === "Bearer exhausted-key") {
      return new Response(
        JSON.stringify({
          error: {
            message: "The provider account has insufficient_quota for this request.",
            code: "insufficient_quota"
          }
        }),
        {
          status: 429,
          headers: { "Content-Type": "application/json" }
        }
      );
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok from second configured provider connection" } }]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  };

  try {
    const response = await coreRouter.handleModelProxy(
      request("http://localhost/api/v1/chat/completions", {
        model: "openrouter/generic-model",
        messages: [{ role: "user", content: "hello" }]
      }),
      { endpointMode: "chat" }
    );
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.choices[0].message.content, "ok from second configured provider connection");
    assert.equal(attempts.length, 2);
    assert.deepEqual(
      attempts.map((attempt) => attempt.authorization),
      ["Bearer exhausted-key", "Bearer healthy-key"]
    );
    assert.equal(attempts[0].body.model, "generic-model");
    assert.equal(attempts[1].body.model, "generic-model");
  } finally {
    process.env.AGENT_ROUTE_DB = previousDb;
    global.fetch = previousFetch;
  }
}

async function testProviderEnvKeyCanFailOverToConfiguredConnectionOnProviderLimit() {
  const providerDb = path.join(testRoot, "provider-db-env-failover", "data.sqlite");
  createProviderDb(providerDb, [
    {
      id: "openai-db-connection",
      provider: "openai",
      priority: 1,
      data: {
        apiKey: "db-healthy-key",
        testStatus: "active"
      }
    }
  ]);

  const previousDb = process.env.AGENT_ROUTE_DB;
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  const previousFetch = global.fetch;
  process.env.AGENT_ROUTE_DB = providerDb;
  process.env.OPENAI_API_KEY = "env-exhausted-key";
  const attempts = [];
  global.fetch = async (url, options = {}) => {
    attempts.push({
      url: String(url),
      authorization: options.headers && options.headers.Authorization,
      body: JSON.parse(options.body || "{}")
    });
    if (options.headers.Authorization === "Bearer env-exhausted-key") {
      return new Response(JSON.stringify({ error: { message: "rate_limit_exceeded", code: "rate_limit_exceeded" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok from configured connection" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const response = await coreRouter.handleModelProxy(
      request("http://localhost/api/v1/chat/completions", {
        model: "openai/generic-model",
        messages: [{ role: "user", content: "hello" }]
      }),
      { endpointMode: "chat" }
    );
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.choices[0].message.content, "ok from configured connection");
    assert.deepEqual(
      attempts.map((attempt) => attempt.authorization),
      ["Bearer env-exhausted-key", "Bearer db-healthy-key"]
    );
    assert.equal(attempts[0].body.model, "generic-model");
    assert.equal(attempts[1].body.model, "generic-model");
  } finally {
    process.env.AGENT_ROUTE_DB = previousDb;
    if (previousOpenAiKey == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
    global.fetch = previousFetch;
  }
}

function testCommanderRouteHonorsExplicitGptClaudePoolBeforeActiveProviders() {
  const providerDb = path.join(testRoot, "provider-db-commander-priority", "data.sqlite");
  createProviderDb(providerDb, [
    {
      id: "deepseek-active",
      provider: "deepseek",
      data: {
        apiKey: "stub-key",
        defaultModel: "deepseek-chat",
        testStatus: "active"
      }
    }
  ]);

  const previousDb = process.env.AGENT_ROUTE_DB;
  process.env.AGENT_ROUTE_DB = providerDb;
  try {
    const config = {
      modelPools: {
        commander: [
          "cx/gpt-5.5",
          "openrouter/anthropic/claude-sonnet-4.5",
          "gemini/gemini-3.1-pro-preview",
          "deepseek/deepseek-chat"
        ],
        strong: [],
        coding: [],
        free: []
      }
    };
    const merged = modelRoutingService.applyActiveProviderModels(config);
    assert.deepEqual(merged.modelPools.commander, ["cx/gpt-5.5"]);
    assert.ok(merged.modelPools.strong.some((model) => String(model).includes("deepseek")));

    const gptRoute = modelRoutingService.resolveCommanderRoute({ commander_model: "cx/gpt-5.5" }, merged);
    assert.equal(gptRoute.selected, "cx/gpt-5.5");
    assert.equal(gptRoute.models[0], "cx/gpt-5.5");
    assert.equal(
      gptRoute.models.some((model) => String(model).includes("deepseek")),
      false
    );

    const rejectedRoute = modelRoutingService.resolveCommanderRoute(
      { commander_model: "deepseek/deepseek-chat" },
      merged
    );
    assert.equal(rejectedRoute.selected, "cx/gpt-5.5");
    assert.equal(
      rejectedRoute.models.some((model) => /deepseek|gemini/i.test(String(model))),
      false
    );
  } finally {
    process.env.AGENT_ROUTE_DB = previousDb;
  }
}

async function testModelProxyDoesNotFailOverInvalidRequestToAnotherConnection() {
  const providerDb = path.join(testRoot, "provider-db-no-failover", "data.sqlite");
  createProviderDb(providerDb, [
    {
      id: "provider-primary-invalid-request",
      provider: "openrouter",
      priority: 1,
      data: {
        apiKey: "primary-key",
        testStatus: "active"
      }
    },
    {
      id: "provider-secondary-unused",
      provider: "openrouter",
      priority: 2,
      data: {
        apiKey: "secondary-key",
        testStatus: "active"
      }
    }
  ]);

  const previousDb = process.env.AGENT_ROUTE_DB;
  const previousFetch = global.fetch;
  process.env.AGENT_ROUTE_DB = providerDb;
  const attempts = [];
  global.fetch = async (url, options = {}) => {
    attempts.push(options.headers && options.headers.Authorization);
    return new Response(
      JSON.stringify({
        error: {
          message: "Invalid request body.",
          code: "invalid_request_error"
        }
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" }
      }
    );
  };

  try {
    const response = await coreRouter.handleModelProxy(
      request("http://localhost/api/v1/chat/completions", {
        model: "openrouter/generic-model",
        messages: [{ role: "user", content: "hello" }]
      }),
      { endpointMode: "chat" }
    );
    assert.equal(response.status, 400);
    const json = await response.json();
    assert.equal(json.error.code, "invalid_request_error");
    assert.deepEqual(attempts, ["Bearer primary-key"]);
  } finally {
    process.env.AGENT_ROUTE_DB = previousDb;
    global.fetch = previousFetch;
  }
}

async function testOutboundProxyEnvAppliesToConfiguredModelFetch() {
  const providerDb = path.join(testRoot, "provider-db-proxy", "data.sqlite");
  createProviderDb(providerDb, [
    {
      id: "gemini-1",
      provider: "gemini",
      data: {
        apiKey: "stub-key",
        testStatus: "active"
      }
    }
  ]);

  const previousDb = process.env.AGENT_ROUTE_DB;
  const previousProxy = process.env.AGENT_ROUTE_OUTBOUND_PROXY_URL;
  const previousFetch = global.fetch;
  process.env.AGENT_ROUTE_DB = providerDb;
  process.env.AGENT_ROUTE_OUTBOUND_PROXY_URL = "http://127.0.0.1:19492";
  let captured = null;
  global.fetch = async (url, options = {}) => {
    captured = {
      url: String(url),
      dispatcher: options.dispatcher,
      body: JSON.parse(options.body || "{}")
    };
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok through proxy" } }]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  };

  try {
    const response = await coreRouter.handleModelProxy(
      request("http://localhost/api/v1/chat/completions", {
        model: "gemini/gemini-2.5-flash",
        messages: [{ role: "user", content: "hello" }]
      }),
      { endpointMode: "chat" }
    );
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.choices[0].message.content, "ok through proxy");
    assert.equal(captured.url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    assert.equal(captured.body.model, "gemini-2.5-flash");
    assert.ok(captured.dispatcher, "configured model fetch should receive an undici proxy dispatcher");
  } finally {
    process.env.AGENT_ROUTE_DB = previousDb;
    if (previousProxy == null) delete process.env.AGENT_ROUTE_OUTBOUND_PROXY_URL;
    else process.env.AGENT_ROUTE_OUTBOUND_PROXY_URL = previousProxy;
    global.fetch = previousFetch;
  }
}

async function testModelProxyFallsBackToCurlWhenFetchResets() {
  const providerDb = path.join(testRoot, "provider-db-curl", "data.sqlite");
  createProviderDb(providerDb, [
    {
      id: "deepseek-1",
      provider: "deepseek",
      data: {
        apiKey: "stub-key",
        testStatus: "active"
      }
    }
  ]);

  const previousDb = process.env.AGENT_ROUTE_DB;
  const previousProxy = process.env.AGENT_ROUTE_OUTBOUND_PROXY_URL;
  const previousFetch = global.fetch;
  const childProcess = require("node:child_process");
  const previousExecFile = childProcess.execFile;
  process.env.AGENT_ROUTE_DB = providerDb;
  process.env.AGENT_ROUTE_OUTBOUND_PROXY_URL = "http://127.0.0.1:19492";
  global.fetch = async () => {
    const err = new TypeError("fetch failed");
    err.cause = { code: "ECONNRESET" };
    throw err;
  };
  let capturedArgs = [];
  childProcess.execFile = (bin, args, options, callback) => {
    capturedArgs = [bin, ...args];
    callback(
      null,
      `${JSON.stringify({
        choices: [{ message: { content: "ok from curl fallback" } }]
      })}\n__AGENT_ROUTE_HTTP_STATUS__:200`,
      ""
    );
  };

  try {
    const response = await coreRouter.handleModelProxy(
      request("http://localhost/api/v1/chat/completions", {
        model: "deepseek/deepseek-chat",
        messages: [{ role: "user", content: "hello" }]
      }),
      { endpointMode: "chat" }
    );
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.choices[0].message.content, "ok from curl fallback");
    assert.equal(capturedArgs[0], "curl");
    assert.ok(capturedArgs.includes("https://api.deepseek.com/v1/chat/completions"));
    assert.ok(capturedArgs.some((item) => item === "Authorization: Bearer stub-key"));
    assert.ok(capturedArgs.includes("--proxy"));
    assert.ok(capturedArgs.includes("http://127.0.0.1:19492"));
  } finally {
    process.env.AGENT_ROUTE_DB = previousDb;
    if (previousProxy == null) delete process.env.AGENT_ROUTE_OUTBOUND_PROXY_URL;
    else process.env.AGENT_ROUTE_OUTBOUND_PROXY_URL = previousProxy;
    global.fetch = previousFetch;
    childProcess.execFile = previousExecFile;
  }
}

async function testModelProxyDoesNotCurlFallbackAfterTimeout() {
  const previousFetch = global.fetch;
  const childProcess = require("node:child_process");
  const previousExecFile = childProcess.execFile;
  const previousUpstream = process.env.AGENT_ROUTE_UPSTREAM_CHAT_URL;
  const previousKey = process.env.AGENT_ROUTE_UPSTREAM_API_KEY;
  process.env.AGENT_ROUTE_UPSTREAM_CHAT_URL = "https://example.test/v1/chat/completions";
  process.env.AGENT_ROUTE_UPSTREAM_API_KEY = "stub-key";
  global.fetch = async () => {
    const err = new Error("timeout");
    err.name = "AbortError";
    throw err;
  };
  let curlCalled = false;
  childProcess.execFile = () => {
    curlCalled = true;
    throw new Error("curl should not be called after timeout");
  };

  try {
    const response = await coreRouter.handleModelProxy(
      request("http://localhost/api/v1/chat/completions", {
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hello" }]
      }),
      { endpointMode: "chat", timeoutMs: 5 }
    );
    assert.equal(response.status, 504);
    const json = await response.json();
    assert.equal(json.error.code, "model_proxy_timeout");
    assert.equal(curlCalled, false);
  } finally {
    global.fetch = previousFetch;
    childProcess.execFile = previousExecFile;
    if (previousUpstream == null) delete process.env.AGENT_ROUTE_UPSTREAM_CHAT_URL;
    else process.env.AGENT_ROUTE_UPSTREAM_CHAT_URL = previousUpstream;
    if (previousKey == null) delete process.env.AGENT_ROUTE_UPSTREAM_API_KEY;
    else process.env.AGENT_ROUTE_UPSTREAM_API_KEY = previousKey;
  }
}

async function testModelProxyDoesNotForceAcceptHeaderForNonStreamingChat() {
  const previousFetch = global.fetch;
  const previousUpstream = process.env.AGENT_ROUTE_UPSTREAM_CHAT_URL;
  const previousKey = process.env.AGENT_ROUTE_UPSTREAM_API_KEY;
  process.env.AGENT_ROUTE_UPSTREAM_CHAT_URL = "https://example.test/v1/chat/completions";
  process.env.AGENT_ROUTE_UPSTREAM_API_KEY = "stub-key";
  let capturedHeaders = null;
  global.fetch = async (url, options = {}) => {
    capturedHeaders = options.headers || {};
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok without accept" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const response = await coreRouter.handleModelProxy(
      request("http://localhost/api/v1/chat/completions", {
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hello" }]
      }),
      { endpointMode: "chat", timeoutMs: 1000 }
    );
    assert.equal(response.status, 200);
    assert.equal(capturedHeaders.Accept, undefined);
    assert.equal(capturedHeaders.Authorization, "Bearer stub-key");
  } finally {
    global.fetch = previousFetch;
    if (previousUpstream == null) delete process.env.AGENT_ROUTE_UPSTREAM_CHAT_URL;
    else process.env.AGENT_ROUTE_UPSTREAM_CHAT_URL = previousUpstream;
    if (previousKey == null) delete process.env.AGENT_ROUTE_UPSTREAM_API_KEY;
    else process.env.AGENT_ROUTE_UPSTREAM_API_KEY = previousKey;
  }
}

async function testProviderSettingsActionSavesWithoutLeakingKey() {
  const providerDb = path.join(testRoot, "provider-action-db", "data.sqlite");
  const previousDb = process.env.AGENT_ROUTE_DB;
  const previousFetch = global.fetch;
  process.env.AGENT_ROUTE_DB = providerDb;
  global.fetch = async (url, options = {}) =>
    new Response(
      JSON.stringify({
        url: String(url),
        choices: [{ message: { content: "ok from provider action" } }],
        capturedAuth: options.headers && options.headers.Authorization
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );

  try {
    const saveResponse = await agentRoute.handleAgentRouteRun(
      request("http://localhost/api/agent-route/run", {
        action: "save_provider",
        provider: "openrouter",
        name: "OpenRouter Test",
        apiKey: "top-secret-provider-key",
        priority: 1,
        isActive: true
      }),
      (upstreamRequest) => agentRoute.handleInternalModelRequest(upstreamRequest, { endpointMode: "chat" })
    );
    assert.equal(saveResponse.status, 200);
    const saveJson = await saveResponse.json();
    assert.equal(saveJson.ok, true);
    assert.equal(saveJson.providers[0].provider, "openrouter");
    assert.equal(saveJson.providers[0].hasApiKey, true);
    assert.doesNotMatch(JSON.stringify(saveJson), /top-secret-provider-key/);

    const statusResponse = await agentRoute.handleAgentRouteRun(
      request("http://localhost/api/agent-route/run", { action: "provider_status" }),
      (upstreamRequest) => agentRoute.handleInternalModelRequest(upstreamRequest, { endpointMode: "chat" })
    );
    const statusJson = await statusResponse.json();
    assert.equal(statusJson.ok, true);
    assert.equal(statusJson.providers.length, 1);
    assert.ok(
      statusJson.providerSettings.providerGroups.oauthProviders.some((provider) => provider.id === "claude"),
      "original provider OAuth providers are exposed"
    );
    assert.ok(
      statusJson.providerSettings.providerGroups.apiKeyProviders.some((provider) => provider.id === "minimax"),
      "original provider API key providers are exposed"
    );
    assert.doesNotMatch(JSON.stringify(statusJson), /top-secret-provider-key/);

    const proxyResponse = await coreRouter.handleModelProxy(
      request("http://localhost/api/v1/chat/completions", {
        model: "openrouter/qwen/qwen3-coder:free",
        messages: [{ role: "user", content: "hello" }]
      }),
      { endpointMode: "chat" }
    );
    assert.equal(proxyResponse.status, 200);
    const proxyJson = await proxyResponse.json();
    assert.equal(proxyJson.choices[0].message.content, "ok from provider action");
    assert.equal(proxyJson.capturedAuth, "Bearer top-secret-provider-key");

    const nodeResponse = await agentRoute.handleAgentRouteRun(
      request("http://localhost/api/agent-route/run", {
        action: "save_provider_node",
        id: "myapi",
        name: "My API",
        prefix: "myapi",
        baseUrl: "https://api.example.test/v1",
        models: "test-model"
      }),
      (upstreamRequest) => agentRoute.handleInternalModelRequest(upstreamRequest, { endpointMode: "chat" })
    );
    const nodeJson = await nodeResponse.json();
    assert.equal(nodeJson.ok, true);
    assert.equal(nodeJson.providerNodes[0].id, "myapi");

    const customConnection = await agentRoute.handleAgentRouteRun(
      request("http://localhost/api/agent-route/run", {
        action: "save_provider",
        provider: "myapi",
        name: "My API Key",
        apiKey: "custom-secret-provider-key",
        priority: 1,
        isActive: true
      }),
      (upstreamRequest) => agentRoute.handleInternalModelRequest(upstreamRequest, { endpointMode: "chat" })
    );
    const customJson = await customConnection.json();
    assert.equal(customJson.ok, true);
    assert.doesNotMatch(JSON.stringify(customJson), /custom-secret-provider-key/);

    let customCaptured = null;
    global.fetch = async (url, options = {}) => {
      customCaptured = {
        url: String(url),
        headers: options.headers || {},
        body: JSON.parse(options.body || "{}")
      };
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok from custom provider" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const customProxy = await coreRouter.handleModelProxy(
      request("http://localhost/api/v1/chat/completions", {
        model: "myapi/test-model",
        messages: [{ role: "user", content: "hello" }]
      }),
      { endpointMode: "chat" }
    );
    const customProxyJson = await customProxy.json();
    assert.equal(customProxy.status, 200);
    assert.equal(customProxyJson.choices[0].message.content, "ok from custom provider");
    assert.equal(customCaptured.url, "https://api.example.test/v1/chat/completions");
    assert.equal(customCaptured.body.model, "test-model");
    assert.equal(customCaptured.headers.Authorization, "Bearer custom-secret-provider-key");
  } finally {
    process.env.AGENT_ROUTE_DB = previousDb;
    global.fetch = previousFetch;
  }
}

async function testAgentRouteStopsWhenCommanderCannotPlan() {
  taskRuntime.resetRuntime();
  memoryRuntime.resetRuntime();
  const response = await agentRoute.handleAgentRouteRun(
    request("http://localhost/api/agent-route/run", {
      goal_id: "goal-commander-error",
      goal: "分析这个目标并给出一个安全的执行计划",
      commander_model: "cx/gpt-test-commander",
      model_pools: {
        commander: ["cx/gpt-test-commander"],
        strong: ["openrouter/test-strong"],
        coding: ["openrouter/test-coding"],
        free: ["openrouter/test-free:free"]
      }
    }),
    (upstreamRequest) => agentRoute.handleInternalModelRequest(upstreamRequest, { endpointMode: "chat" })
  );

  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /Commander could not create a plan:/);
  assert.doesNotMatch(text, /rule-planner/);
  assert.doesNotMatch(text, /event: plan/);
  assert.doesNotMatch(text, /event: worker_start[\s\S]*Analyze the user goal and constraints/);
}

async function testInvalidPlannerEndpointContentStopsRoute() {
  taskRuntime.resetRuntime();
  memoryRuntime.resetRuntime();
  const endpointMessage = "AgentRoute Studio only handles goal-driven agent requests on this endpoint.";
  const response = await agentRoute.handleAgentRouteRun(
    request("http://localhost/api/agent-route/run", {
      goal_id: "goal-invalid-planner-content",
      goal: "创建一个计划",
      commander_model: "cx/gpt-test-commander",
      model_pools: {
        commander: ["cx/gpt-test-commander"],
        strong: ["openrouter/test-strong"],
        coding: ["openrouter/test-coding"],
        free: ["openrouter/test-free:free"]
      }
    }),
    () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: endpointMessage } }]
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
  );

  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(
    text,
    /Planner response did not contain a valid AgentRoute plan protocol object|Commander returned an invalid or empty plan/
  );
  assert.doesNotMatch(text, /rule-planner/);
  assert.doesNotMatch(text, /event: plan/);
}

async function testReviewFinalMarksGoalCompleted() {
  taskRuntime.resetRuntime();
  memoryRuntime.resetRuntime();
  const goalId = "goal-review-final-completed";
  let callCount = 0;
  const response = await agentRoute.handleAgentRouteRun(
    request("http://localhost/api/agent-route/run", {
      goal_id: goalId,
      goal: "基于用户提供的两条事实生成中文摘要，不需要读取文件或联网。",
      commander_model: "cx/gpt-test-commander",
      model_pools: {
        commander: ["cx/gpt-test-commander"],
        strong: ["openrouter/test-strong"],
        coding: ["openrouter/test-coding"],
        free: ["openrouter/test-free:free"]
      },
      budget: { unlimited: true }
    }),
    async () => {
      callCount += 1;
      const content =
        callCount === 1
          ? JSON.stringify({
              kind: "plan",
              schemaVersion: 1,
              tasks: [
                {
                  id: "summarize-provided-facts",
                  title: "整理用户提供事实",
                  description: "只基于用户已提供的事实生成中文摘要，不读取文件、不联网。",
                  type: "analysis",
                  modelPool: "free",
                  riskLevel: "low",
                  successCriteria: ["输出中文摘要", "不声称读取文件或联网"]
                }
              ]
            })
          : callCount === 2
            ? JSON.stringify({
                kind: "worker_result",
                schemaVersion: 1,
                status: "success",
                output: "摘要：系统应基于已提供事实完成分析，并清楚说明没有读取文件或联网。",
                actions: ["called:openrouter/test-free:free"],
                evidence: {
                  provided: true,
                  summary: "Worker used only the user-provided task description.",
                  semantic: {
                    outputSummary: "Worker produced a Chinese summary from provided facts.",
                    addressesCriteria: true,
                    criteriaCoverage: 1,
                    qualityScore: 0.95
                  }
                }
              })
            : JSON.stringify({
                kind: "goal_review",
                schemaVersion: 1,
                status: "done",
                progress_summary: "摘要任务已验证完成。",
                final_answer: "最终答案：已基于用户提供事实生成中文摘要，未读取文件或联网。",
                next_tasks: [],
                memory_candidates: []
              });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  );

  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /event: final/);
  assert.match(text, /最终答案/);
  assert.equal(taskRuntime.getGoal(goalId).status, "completed");
}

async function testCancelInternalRouteStepIsNoop() {
  taskRuntime.resetRuntime();
  const response = await agentRoute.handleAgentRouteRun(
    request("http://localhost/api/agent-route/run", {
      action: "cancel_task",
      goal_id: "goal-cancel-internal",
      task_id: "plan"
    }),
    (upstreamRequest) => agentRoute.handleInternalModelRequest(upstreamRequest, { endpointMode: "chat" })
  );

  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.ok, true);
  assert.equal(json.skipped, true);
  assert.equal(json.task_id, "plan");
}

async function testPublicCompatibleApiRoutesAreDisabled() {
  const routeFiles = [
    "../app/api/v1/chat/completions/route.js",
    "../app/api/v1/responses/route.js",
    "../app/v1/chat/completions/route.js",
    "../app/v1/responses/route.js"
  ];
  for (const relative of routeFiles) {
    const route = await import(pathToFileURL(path.join(__dirname, relative)).href);
    const response = await route.POST(
      request("http://localhost/v1/chat/completions", {
        model: "openrouter/test-free",
        messages: [{ role: "user", content: "hello" }]
      })
    );
    assert.equal(response.status, 404);
    const json = await response.json();
    assert.equal(json.error.code, "external_compatible_api_disabled");
  }
}

async function run() {
  try {
    await testModelProxyUsesCodexOAuthConnectionsWithFailover();
    await testUnconfiguredModelProxyHasSpecificError();
    await testModelProxyReadsConfiguredOpenRouterProvider();
    await testModelProxyFailsOverConfiguredConnectionsOnProviderLimit();
    await testProviderEnvKeyCanFailOverToConfiguredConnectionOnProviderLimit();
    testCommanderRouteHonorsExplicitGptClaudePoolBeforeActiveProviders();
    await testModelProxyDoesNotFailOverInvalidRequestToAnotherConnection();
    await testOutboundProxyEnvAppliesToConfiguredModelFetch();
    await testModelProxyFallsBackToCurlWhenFetchResets();
    await testModelProxyDoesNotCurlFallbackAfterTimeout();
    await testModelProxyDoesNotForceAcceptHeaderForNonStreamingChat();
    await testProviderSettingsActionSavesWithoutLeakingKey();
    await testAgentRouteStopsWhenCommanderCannotPlan();
    await testInvalidPlannerEndpointContentStopsRoute();
    await testReviewFinalMarksGoalCompleted();
    await testCancelInternalRouteStepIsNoop();
    await testPublicCompatibleApiRoutesAreDisabled();
    console.log("agent-route-model-proxy tests passed");
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
