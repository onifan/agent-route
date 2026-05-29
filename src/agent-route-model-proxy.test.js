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
      commander: ["gpt5.5"],
      strong: ["openai/gpt-5.5", "qwen/qwen-plus"],
      coding: ["qwen/qwen3-coder-plus"],
      free: ["gemini/gemini-2.5-flash", "qwen/qwen-plus"]
    }
  })
);

delete process.env.AGENT_ROUTE_UPSTREAM_CHAT_URL;
delete process.env.AGENT_ROUTE_MODEL_PROXY_URL;
delete process.env.AGENT_ROUTE_UPSTREAM_RESPONSES_URL;
delete process.env.AGENT_ROUTE_UPSTREAM_API_KEY;
delete process.env.AGENT_ROUTE_UPSTREAM_FORWARD_AUTH;
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_API_KEY;

const agentRoute = require("./agent-route");
const orchestratorRuntime = require("./agent/orchestrator/runtime");
const protocol = require("./agent/orchestrator/protocol");
const coreRouter = require("./core/router");
const modelApiSettings = require("./core/model-api-settings");
const modelRoutingService = require("./agent/orchestrator/model-routing-service");
const taskRuntime = require("./agent-route-task-runtime");
const memoryRuntime = require("./agent-route-memory-runtime");

function request(url, body, options = {}) {
  return new Request(url, {
    method: options.method || "POST",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: JSON.stringify(body),
    signal: options.signal
  });
}

function functionCompletion(kind, argumentsValue) {
  return {
    choices: [
      {
        message: {
          content: "",
          tool_calls: [
            {
              type: "function",
              function: {
                name: protocol.functionNameForKind(kind),
                arguments: JSON.stringify(argumentsValue)
              }
            }
          ]
        }
      }
    ]
  };
}

function useDb(name) {
  process.env.AGENT_ROUTE_DB = path.join(testRoot, name, "data.sqlite");
  coreRouter.clearProviderDbCache();
  modelApiSettings.clearModelApiCache();
  return process.env.AGENT_ROUTE_DB;
}

function saveModelApi(payload) {
  const status = modelApiSettings.saveModelApiSetting({
    enabled: true,
    ...payload
  });
  assert.equal(status.ok, true);
  return status;
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

async function testUnconfiguredModelProxyHasSpecificError() {
  useDb("unconfigured");
  const response = await coreRouter.handleModelProxy(
    request("http://localhost/api/v1/chat/completions", {
      model: "qwen/qwen-plus",
      messages: [{ role: "user", content: "hello" }]
    }),
    { endpointMode: "chat" }
  );
  assert.equal(response.status, 503);
  const json = await response.json();
  assert.equal(json.error.code, "model_proxy_unconfigured");
  assert.match(json.error.message, /model API settings/);
  assert.doesNotMatch(json.error.message, /AGENT_ROUTE_UPSTREAM/);
}

async function testOldGenericUpstreamEnvIsIgnored() {
  useDb("old-env-ignored");
  const previousUrl = process.env.AGENT_ROUTE_UPSTREAM_CHAT_URL;
  const previousKey = process.env.AGENT_ROUTE_UPSTREAM_API_KEY;
  const previousFetch = global.fetch;
  let called = false;
  process.env.AGENT_ROUTE_UPSTREAM_CHAT_URL = "https://legacy.example.test/v1/chat/completions";
  process.env.AGENT_ROUTE_UPSTREAM_API_KEY = "legacy-key";
  global.fetch = async () => {
    called = true;
    return new Response(JSON.stringify({ choices: [{ message: { content: "legacy" } }] }), { status: 200 });
  };

  try {
    const response = await coreRouter.handleModelProxy(
      request("http://localhost/api/v1/chat/completions", {
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hello" }]
      }),
      { endpointMode: "chat" }
    );
    assert.equal(response.status, 503);
    assert.equal(called, false);
  } finally {
    if (previousUrl == null) delete process.env.AGENT_ROUTE_UPSTREAM_CHAT_URL;
    else process.env.AGENT_ROUTE_UPSTREAM_CHAT_URL = previousUrl;
    if (previousKey == null) delete process.env.AGENT_ROUTE_UPSTREAM_API_KEY;
    else process.env.AGENT_ROUTE_UPSTREAM_API_KEY = previousKey;
    global.fetch = previousFetch;
  }
}

async function testModelProxyResolvesModelAliasThroughModelApiSettings() {
  useDb("model-api-alias");
  const previousFetch = global.fetch;
  const calls = [];
  saveModelApi({
    provider: "openai",
    apiKey: "local-secret",
    baseUrl: "http://localhost:48761/v1",
    defaultModel: "gpt-5.5",
    models: ["gpt-5.5"]
  });
  modelApiSettings.upsertModelAlias("gpt5.5", "local/gpt-5.5");
  global.fetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      headers: options.headers || {},
      body: JSON.parse(options.body || "{}")
    });
    return new Response(
      JSON.stringify({
        model: "gpt-5.5",
        choices: [{ message: { content: "ok from local model api" } }]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    const response = await coreRouter.handleModelProxy(
      request("http://localhost/api/v1/chat/completions", {
        model: "gpt5.5",
        messages: [{ role: "user", content: "hello" }],
        response_format: { type: "json_object" },
        tools: [
          {
            type: "function",
            function: {
              name: "health_check",
              parameters: {
                type: "object",
                properties: { ok: { type: "boolean" } },
                required: ["ok"]
              }
            }
          }
        ],
        tool_choice: { type: "function", function: { name: "health_check" } }
      }),
      { endpointMode: "chat" }
    );
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.choices[0].message.content, "ok from local model api");
    assert.equal(calls[0].url, "http://localhost:48761/v1/chat/completions");
    assert.equal(calls[0].body.model, "gpt-5.5");
    assert.equal(calls[0].body.response_format.type, "json_object");
    assert.equal(calls[0].body.tools[0].function.name, "health_check");
    assert.equal(calls[0].body.tool_choice.function.name, "health_check");
    assert.equal(calls[0].headers.Authorization, "Bearer local-secret");
  } finally {
    global.fetch = previousFetch;
  }
}

function testLocalOpenAiPrefixRoutesToConfiguredModelApi() {
  useDb("local-openai-prefix");
  saveModelApi({
    provider: "openai",
    apiKey: "local-secret",
    baseUrl: "http://localhost:48761/v1",
    defaultModel: "local/gpt-5.5",
    models: ["local/gpt-5.5"]
  });

  const target = modelApiSettings.targetForModelApi("local/gpt-5.5");
  assert.equal(target.provider, "openai");
  assert.equal(target.kind, "openai-compatible");
  assert.equal(target.url, "http://localhost:48761/v1/chat/completions");
  assert.equal(target.model, "gpt-5.5");

  const pools = modelApiSettings.configuredModelPools();
  assert.deepEqual(pools.commander, ["gpt5.5"]);
  assert.ok(pools.strong.includes("local/gpt-5.5"));
}

async function testModelProxyRoutesConfiguredQwenProvider() {
  useDb("model-api-qwen");
  const previousFetch = global.fetch;
  let captured = null;
  saveModelApi({
    provider: "qwen",
    apiKey: "dashscope-key",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    models: ["qwen-plus"]
  });
  global.fetch = async (url, options = {}) => {
    captured = {
      url: String(url),
      headers: options.headers || {},
      body: JSON.parse(options.body || "{}")
    };
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok from qwen" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const response = await coreRouter.handleModelProxy(
      request("http://localhost/api/v1/chat/completions", {
        model: "qwen/qwen-plus",
        messages: [{ role: "user", content: "hello" }]
      }),
      { endpointMode: "chat" }
    );
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.choices[0].message.content, "ok from qwen");
    assert.equal(captured.url, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    assert.equal(captured.body.model, "qwen-plus");
    assert.equal(captured.headers.Authorization, "Bearer dashscope-key");
  } finally {
    global.fetch = previousFetch;
  }
}

async function testClaudeProviderUsesAnthropicMessagesAndReturnsOpenAiShape() {
  useDb("model-api-claude");
  const previousFetch = global.fetch;
  let captured = null;
  saveModelApi({
    provider: "claude",
    apiKey: "claude-key",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-5",
    models: ["claude-sonnet-4-5"],
    anthropicVersion: "2023-06-01"
  });
  global.fetch = async (url, options = {}) => {
    captured = {
      url: String(url),
      headers: options.headers || {},
      body: JSON.parse(options.body || "{}")
    };
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        model: "claude-sonnet-4-5",
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "toolu_1", name: "health_check", input: { ok: true } }
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 7, output_tokens: 3 }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    const response = await coreRouter.handleModelProxy(
      request("http://localhost/api/v1/chat/completions", {
        model: "claude/claude-sonnet-4-5",
        messages: [
          { role: "system", content: "You are precise." },
          { role: "user", content: "run health check" }
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "health_check",
              description: "Return health",
              parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }
            }
          }
        ],
        tool_choice: { type: "function", function: { name: "health_check" } }
      }),
      { endpointMode: "chat" }
    );
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(captured.url, "https://api.anthropic.com/v1/messages");
    assert.equal(captured.headers["x-api-key"], "claude-key");
    assert.equal(captured.headers["anthropic-version"], "2023-06-01");
    assert.equal(captured.body.model, "claude-sonnet-4-5");
    assert.equal(captured.body.system, "You are precise.");
    assert.equal(captured.body.messages[0].role, "user");
    assert.equal(captured.body.tools[0].name, "health_check");
    assert.deepEqual(captured.body.tool_choice, { type: "tool", name: "health_check" });
    assert.equal(json.object, "chat.completion");
    assert.equal(json.choices[0].finish_reason, "tool_calls");
    assert.equal(json.choices[0].message.tool_calls[0].function.name, "health_check");
  } finally {
    global.fetch = previousFetch;
  }
}

async function testConfiguredProviderErrorSurfacesDirectly() {
  useDb("provider-error-direct");
  const previousFetch = global.fetch;
  saveModelApi({
    provider: "openai",
    apiKey: "bad-key",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.5",
    models: ["gpt-5.5"]
  });
  global.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "invalid request", code: "invalid_request_error" } }), {
      status: 400,
      statusText: "Bad Request",
      headers: { "Content-Type": "application/json" }
    });

  try {
    const response = await coreRouter.handleModelProxy(
      request("http://localhost/api/v1/chat/completions", {
        model: "openai/gpt-5.5",
        messages: [{ role: "user", content: "hello" }]
      }),
      { endpointMode: "chat" }
    );
    assert.equal(response.status, 400);
    const json = await response.json();
    assert.equal(json.error.code, "invalid_request_error");
  } finally {
    global.fetch = previousFetch;
  }
}

async function testModelApiConnectionTestUsesDraftSettings() {
  useDb("model-api-test-draft");
  const previousFetch = global.fetch;
  let captured = null;
  saveModelApi({
    provider: "qwen",
    apiKey: "saved-key",
    baseUrl: "https://saved.example/v1",
    defaultModel: "qwen-plus",
    models: ["qwen-plus"]
  });
  global.fetch = async (url, options = {}) => {
    captured = {
      url: String(url),
      headers: options.headers || {},
      body: JSON.parse(options.body || "{}")
    };
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const result = await modelApiSettings.testModelApiSetting({
      provider: "qwen",
      apiKey: "draft-key",
      baseUrl: "https://proxy.example/openai",
      defaultModel: "qwen/qwen-plus"
    });
    assert.equal(result.ok, true);
    assert.equal(result.url, "https://proxy.example/openai/chat/completions");
    assert.equal(result.model, "qwen-plus");
    assert.equal(captured.url, "https://proxy.example/openai/chat/completions");
    assert.equal(captured.headers.Authorization, "Bearer draft-key");
    assert.equal(captured.body.model, "qwen-plus");
    assert.equal(captured.body.stream, false);
  } finally {
    global.fetch = previousFetch;
  }
}

async function testModelApiConnectionTestSurfacesProviderError() {
  useDb("model-api-test-error");
  const previousFetch = global.fetch;
  saveModelApi({
    provider: "openai",
    apiKey: "bad-key",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.5",
    models: ["gpt-5.5"]
  });
  global.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "invalid api key", code: "invalid_api_key" } }), {
      status: 401,
      statusText: "Unauthorized",
      headers: { "Content-Type": "application/json" }
    });

  try {
    await assert.rejects(
      () => modelApiSettings.testModelApiSetting({ provider: "openai" }),
      (err) => {
        assert.equal(err.code, "model_api_test_failed");
        assert.equal(err.statusCode, 401);
        assert.match(err.message, /invalid api key/);
        return true;
      }
    );
  } finally {
    global.fetch = previousFetch;
  }
}

function testCommanderRouteUsesOnlyGpt55Commander() {
  useDb("commander-priority");
  saveModelApi({
    provider: "deepseek",
    apiKey: "stub-key",
    defaultModel: "deepseek-v4-pro",
    models: ["deepseek-v4-pro"]
  });
  const config = {
    modelPools: {
      commander: ["gpt5.5", "openai/gpt-5.5", "deepseek/deepseek-v4-pro"],
      strong: [],
      coding: [],
      free: []
    }
  };
  const merged = modelRoutingService.applyActiveProviderModels(config);
  assert.deepEqual(merged.modelPools.commander, ["gpt5.5"]);
  assert.ok(merged.modelPools.strong.some((model) => String(model).includes("deepseek")));

  const gptRoute = modelRoutingService.resolveCommanderRoute({ commander_model: "gpt-5.5" }, merged);
  assert.equal(gptRoute.selected, "gpt5.5");
  assert.equal(gptRoute.models[0], "gpt5.5");

  const localRoute = modelRoutingService.resolveCommanderRoute({ commander_model: "local/gpt-5.5" }, merged);
  assert.equal(localRoute.selected, "gpt5.5");
  assert.equal(localRoute.models[0], "gpt5.5");

  const rejectedRoute = modelRoutingService.resolveCommanderRoute(
    { commander_model: "deepseek/deepseek-v4-pro" },
    merged
  );
  assert.equal(rejectedRoute.selected, "gpt5.5");
  assert.equal(
    rejectedRoute.models.some((model) => /deepseek|gemini|qwen/i.test(String(model))),
    false
  );
}

function testActiveProviderModelsFollowCapabilityTiers() {
  useDb("capability-tier-routing");
  saveModelApi({
    provider: "qwen",
    apiKey: "qwen-key",
    defaultModel: "qwen-plus",
    models: ["qwen-plus", "qwen3-coder-plus"]
  });
  saveModelApi({
    provider: "gemini",
    apiKey: "gemini-key",
    defaultModel: "ag/gemini-3-flash",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"]
  });
  saveModelApi({
    provider: "deepseek",
    apiKey: "deepseek-key",
    defaultModel: "deepseek-v4-pro",
    models: ["deepseek-v4-pro"]
  });
  saveModelApi({
    provider: "openai",
    apiKey: "openai-key",
    defaultModel: "gpt-5.5",
    models: ["gpt-5.5"]
  });

  const pools = modelApiSettings.configuredModelPools();
  assert.ok(pools.free.includes("gemini/ag/gemini-3-flash"));
  assert.ok(!pools.free.includes("ag/gemini-3-flash"));
  const target = modelApiSettings.targetForModelApi("gemini/ag/gemini-3-flash");
  assert.equal(target.provider, "gemini");
  assert.equal(target.model, "ag/gemini-3-flash");

  const active = modelRoutingService.activeProviderModelPools();
  assert.equal(active.strong[0], "openai/gpt-5.5");
  assert.ok(active.strong.indexOf("gemini/gemini-2.5-pro") < active.strong.indexOf("qwen/qwen-plus"));
  assert.ok(active.strong.indexOf("deepseek/deepseek-v4-pro") < active.strong.indexOf("qwen/qwen-plus"));
  assert.ok(active.free.indexOf("gemini/ag/gemini-3-flash") < active.free.indexOf("qwen/qwen-plus"));
}

async function testModelProxyCancelsUpstreamFetchWhenIncomingRequestAborts() {
  useDb("abort");
  saveModelApi({
    provider: "openai",
    apiKey: "stub-key",
    baseUrl: "https://example.test/v1",
    defaultModel: "gpt-5.5",
    models: ["gpt-5.5"]
  });
  const previousFetch = global.fetch;
  let fetchAborted = false;
  global.fetch = async (url, options = {}) =>
    new Promise((resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => {
          fetchAborted = true;
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true }
      );
    });

  try {
    const controller = new AbortController();
    const incoming = request(
      "http://localhost/api/v1/chat/completions",
      {
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hello" }]
      },
      { signal: controller.signal }
    );
    const pending = coreRouter.handleModelProxy(incoming, { endpointMode: "chat", timeoutMs: 1000 });
    await Promise.resolve();
    controller.abort();
    const response = await pending;
    assert.equal(response.status, 504);
    assert.equal(fetchAborted, true);
  } finally {
    global.fetch = previousFetch;
  }
}

async function testCommanderTimeoutAbortsInternalModelRequest() {
  let requestAborted = false;
  const attempt = await orchestratorRuntime.callRoutedModel({
    req: request("http://localhost/api/agent-route/ui-stream", { goal: "hello" }),
    nextHandler: async (upstreamRequest) =>
      new Promise((resolve) => {
        upstreamRequest.signal.addEventListener(
          "abort",
          () => {
            requestAborted = true;
            resolve(
              new Response(JSON.stringify({ error: { message: "aborted" } }), {
                status: 504,
                headers: { "Content-Type": "application/json" }
              })
            );
          },
          { once: true }
        );
      }),
    baseBody: {},
    models: ["gpt5.5"],
    messages: [{ role: "user", content: "hello" }],
    config: { callTimeoutMs: 5, modelMaxAttempts: 1 },
    label: "plan",
    trace: [],
    endpointMode: "chat",
    timeoutMsOverride: 5
  });

  assert.equal(attempt.ok, false);
  assert.equal(requestAborted, true);
}

async function testCommanderModelTimeoutRetriesBeforeSurfacing() {
  let calls = 0;
  const events = [];
  const attempt = await orchestratorRuntime.callRoutedModel({
    req: request("http://localhost/api/agent-route/ui-stream", { goal: "hello" }),
    nextHandler: async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          error: {
            message: "Internal model request timed out.",
            code: "model_proxy_timeout"
          }
        }),
        {
          status: 504,
          headers: { "Content-Type": "application/json" }
        }
      );
    },
    baseBody: {},
    models: ["gpt5.5"],
    messages: [{ role: "user", content: "hello" }],
    config: { callTimeoutMs: 1000, modelMaxAttempts: 3 },
    label: "plan",
    trace: [],
    endpointMode: "chat",
    onModelEvent: (event, data) => events.push({ event, data })
  });

  assert.equal(attempt.ok, false);
  assert.equal(calls, 3);
  assert.match(String(attempt.error), /timed out/i);
  assert.deepEqual(
    events.map((item) => item.event),
    [
      "model_attempt",
      "model_timeout",
      "model_retry",
      "model_attempt",
      "model_timeout",
      "model_retry",
      "model_attempt",
      "model_timeout"
    ]
  );
}

async function testNonStreamingChatDoesNotForceAcceptHeader() {
  useDb("accept-header");
  saveModelApi({
    provider: "openai",
    apiKey: "stub-key",
    baseUrl: "https://example.test/v1",
    defaultModel: "gpt-5.5",
    models: ["gpt-5.5"]
  });
  const previousFetch = global.fetch;
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
  }
}

async function testLegacyProviderActionsReturnGone() {
  const actions = ["provider_status", "save_provider", "save_provider_node"];
  for (const action of actions) {
    const response = await agentRoute.handleAgentRouteRun(
      request("http://localhost/api/agent-route/run", { action, provider: "openai", apiKey: "secret" }),
      (upstreamRequest) => agentRoute.handleInternalModelRequest(upstreamRequest, { endpointMode: "chat" })
    );
    assert.equal(response.status, 410);
    const json = await response.json();
    assert.equal(json.error.code, "legacy_provider_removed");
    assert.doesNotMatch(JSON.stringify(json), /secret/);
  }
}

async function testAgentRouteStopsWhenCommanderCannotPlan() {
  taskRuntime.resetRuntime();
  memoryRuntime.resetRuntime();
  const response = await agentRoute.handleAgentRouteUiStream(
    request("http://localhost/api/agent-route/ui-stream", {
      goal_id: "goal-commander-error",
      goal: "分析这个目标并给出一个安全的执行计划",
      commander_model: "gpt5.5",
      model_pools: {
        commander: ["gpt5.5"],
        strong: ["openai/gpt-5.5"],
        coding: ["qwen/qwen3-coder-plus"],
        free: ["qwen/qwen-plus"]
      }
    }),
    (upstreamRequest) => agentRoute.handleInternalModelRequest(upstreamRequest, { endpointMode: "chat" })
  );

  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /Commander could not create a plan:/);
  assert.doesNotMatch(text, /rule-planner/);
  assert.doesNotMatch(text, /data-agent-plan/);
  assert.doesNotMatch(text, /data-agent-task[\s\S]*Analyze the user goal and constraints/);
}

async function testInvalidPlannerEndpointContentStopsRoute() {
  taskRuntime.resetRuntime();
  memoryRuntime.resetRuntime();
  const endpointMessage = "AgentRoute Studio only handles goal-driven agent requests on this endpoint.";
  const response = await agentRoute.handleAgentRouteUiStream(
    request("http://localhost/api/agent-route/ui-stream", {
      goal_id: "goal-invalid-planner-content",
      goal: "创建一个计划",
      commander_model: "gpt5.5",
      model_pools: {
        commander: ["gpt5.5"],
        strong: ["openai/gpt-5.5"],
        coding: ["qwen/qwen3-coder-plus"],
        free: ["qwen/qwen-plus"]
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
  assert.match(text, /Structured model response must call agent_route_plan exactly once/);
  assert.doesNotMatch(text, /rule-planner/);
  assert.doesNotMatch(text, /data-agent-plan/);
}

async function testReviewFinalMarksGoalCompleted() {
  taskRuntime.resetRuntime();
  memoryRuntime.resetRuntime();
  const goalId = "goal-review-final-completed";
  let callCount = 0;
  const response = await agentRoute.handleAgentRouteUiStream(
    request("http://localhost/api/agent-route/ui-stream", {
      goal_id: goalId,
      goal: "基于用户提供的两条事实生成中文摘要，不需要读取文件或联网。",
      commander_model: "gpt5.5",
      model_pools: {
        commander: ["gpt5.5"],
        strong: ["openai/gpt-5.5"],
        coding: ["qwen/qwen3-coder-plus"],
        free: ["qwen/qwen-plus"]
      },
      budget: { unlimited: true }
    }),
    async () => {
      callCount += 1;
      const completion =
        callCount === 1
          ? functionCompletion(protocol.KIND.PLAN, {
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
            ? functionCompletion(protocol.KIND.WORKER_RESULT, {
                kind: "worker_result",
                schemaVersion: 1,
                status: "success",
                output: "摘要：系统应基于已提供事实完成分析，并清楚说明没有读取文件或联网。",
                actions: ["called:qwen/qwen-plus"],
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
            : functionCompletion(protocol.KIND.GOAL_REVIEW, {
                kind: "goal_review",
                schemaVersion: 1,
                status: "done",
                progress_summary: "摘要任务已验证完成。",
                final_answer: "最终答案：已基于用户提供事实生成中文摘要，未读取文件或联网。",
                next_tasks: [],
                memory_candidates: []
              });
      return new Response(JSON.stringify(completion), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  );

  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /data-agent-final/);
  assert.match(text, /最终答案/);
  assert.equal(taskRuntime.getGoal(goalId).status, "completed");
}

async function testUiStreamGoalRunDetachesFromClientAbort() {
  taskRuntime.resetRuntime();
  memoryRuntime.resetRuntime();
  const goalId = "goal-ui-stream-detached";
  const controller = new AbortController();
  let callCount = 0;
  let releasePlanner;
  const plannerCanContinue = new Promise((resolve) => {
    releasePlanner = resolve;
  });
  const upstreamSignals = [];
  const response = await agentRoute.handleAgentRouteUiStream(
    request(
      "http://localhost/api/agent-route/ui-stream",
      {
        goal_id: goalId,
        goal: "基于用户提供内容写一句确认，不需要联网。",
        commander_model: "gpt5.5",
        model_pools: {
          commander: ["gpt5.5"],
          strong: ["openai/gpt-5.5"],
          coding: ["qwen/qwen3-coder-plus"],
          free: ["qwen/qwen-plus"]
        },
        budget: { unlimited: true }
      },
      { signal: controller.signal }
    ),
    async (upstreamRequest) => {
      callCount += 1;
      upstreamSignals.push(upstreamRequest.signal);
      if (callCount === 1) await plannerCanContinue;
      const completion =
        callCount === 1
          ? functionCompletion(protocol.KIND.PLAN, {
              kind: "plan",
              schemaVersion: 1,
              tasks: [
                {
                  id: "confirm-provided-content",
                  title: "确认用户提供内容",
                  description: "只基于用户提供内容写一句确认，不联网。",
                  type: "analysis",
                  modelPool: "free",
                  riskLevel: "low",
                  successCriteria: ["输出一句确认", "不声称联网"]
                }
              ]
            })
          : callCount === 2
            ? functionCompletion(protocol.KIND.WORKER_RESULT, {
                kind: "worker_result",
                schemaVersion: 1,
                status: "success",
                output: "确认：已基于用户提供内容完成，不涉及联网。",
                actions: ["called:qwen/qwen-plus"],
                evidence: {
                  provided: true,
                  summary: "Worker used only the provided prompt.",
                  claims: ["No web access was needed."],
                  semantic: {
                    outputSummary: "Worker produced a confirmation sentence.",
                    addressesCriteria: true,
                    criteriaCoverage: 1,
                    qualityScore: 0.95
                  }
                }
              })
            : functionCompletion(protocol.KIND.GOAL_REVIEW, {
                kind: "goal_review",
                schemaVersion: 1,
                status: "done",
                progress_summary: "确认任务已完成。",
                final_answer: "最终答案：已基于用户提供内容完成确认，未联网。",
                next_tasks: [],
                memory_candidates: []
              });
      return new Response(JSON.stringify(completion), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  );

  assert.equal(response.status, 200);
  const textPromise = response.text();
  await waitFor(() => upstreamSignals.length > 0);
  controller.abort();
  releasePlanner();
  const text = await textPromise;
  assert.equal(upstreamSignals[0].aborted, false);
  assert.match(text, /data-agent-final/);
  assert.equal(taskRuntime.getGoal(goalId).status, "completed");
}

async function testLegacySseGoalRunIsDisabled() {
  taskRuntime.resetRuntime();
  memoryRuntime.resetRuntime();
  const response = await agentRoute.handleAgentRouteRun(
    request("http://localhost/api/agent-route/run", {
      goal_id: "legacy-sse-disabled",
      goal: "这个目标不应通过旧 SSE 入口运行"
    }),
    (upstreamRequest) => agentRoute.handleInternalModelRequest(upstreamRequest, { endpointMode: "chat" })
  );

  assert.equal(response.status, 410);
  const json = await response.json();
  assert.equal(json.error.code, "agent_route_legacy_sse_disabled");
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
        model: "qwen/qwen-plus",
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
    await testUnconfiguredModelProxyHasSpecificError();
    await testOldGenericUpstreamEnvIsIgnored();
    await testModelProxyResolvesModelAliasThroughModelApiSettings();
    testLocalOpenAiPrefixRoutesToConfiguredModelApi();
    await testModelProxyRoutesConfiguredQwenProvider();
    await testClaudeProviderUsesAnthropicMessagesAndReturnsOpenAiShape();
    await testConfiguredProviderErrorSurfacesDirectly();
    await testModelApiConnectionTestUsesDraftSettings();
    await testModelApiConnectionTestSurfacesProviderError();
    testCommanderRouteUsesOnlyGpt55Commander();
    testActiveProviderModelsFollowCapabilityTiers();
    await testModelProxyCancelsUpstreamFetchWhenIncomingRequestAborts();
    await testCommanderTimeoutAbortsInternalModelRequest();
    await testCommanderModelTimeoutRetriesBeforeSurfacing();
    await testNonStreamingChatDoesNotForceAcceptHeader();
    await testLegacyProviderActionsReturnGone();
    await testAgentRouteStopsWhenCommanderCannotPlan();
    await testInvalidPlannerEndpointContentStopsRoute();
    await testReviewFinalMarksGoalCompleted();
    await testUiStreamGoalRunDetachesFromClientAbort();
    await testLegacySseGoalRunIsDisabled();
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
