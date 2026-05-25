"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-config-loader-"));
process.env.AGENT_ROUTE_HOME = testRoot;
process.env.AGENT_ROUTE_TASKS = path.join(testRoot, "tasks.json");
process.env.AGENT_ROUTE_MEMORY = path.join(testRoot, "memory.json");
process.env.AGENT_ROUTE_DB = path.join(testRoot, "missing.sqlite");
delete process.env.AGENT_ROUTE_CONFIG;

const configLoader = require("./config/loader");

function testLoadsDefaultConfig() {
  const config = configLoader.loadRuntimeConfig({
    configFile: path.join(testRoot, "missing-agent-route.json")
  });
  assert.equal(config.runtimePaths.home, testRoot);
  assert.ok(config.promptSettings.commanderSystem);
  assert.ok(config.modelPools.commander.length > 0);
  assert.deepEqual(config.modelPools["codex-cli"], ["codex-cli"]);
  assert.equal(config.tools.browser.adapter, "mock");
  assert.equal(config.recoveryPolicy.runningTaskTargetStatus, "blocked");
  assert.equal(config.configSources.defaults, true);
}

function testUserConfigOverridesDefaults() {
  const configFile = path.join(testRoot, "agent-route.json");
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      maxTasks: 2,
      dynamicFreeModels: false,
      modelPools: {
        commander: ["cx/test-commander"],
        strong: ["openrouter/test-strong"],
        coding: ["cx/gpt-5.5"],
        free: ["openrouter/test-free:free"]
      },
      promptSettings: {
        workerSystem: "Custom worker prompt"
      },
      budget: {
        goal: { maxTokens: 1234 },
        task: { maxRetries: 1 }
      },
      tools: {
        browser: {
          adapter: "playwright",
          allowRealBrowser: true,
          maxTextLength: 1200
        }
      },
      recoveryPolicy: {
        retryReadyPolicy: "blocked",
        maxAutoRecoveredTasks: 5
      }
    })
  );
  const config = configLoader.loadRuntimeConfig({ configFile });
  assert.equal(config.maxTasks, 2);
  assert.equal(config.dynamicFreeModels, false);
  assert.equal(config.modelPools.commander[0], "gpt5.5");
  assert.equal(config.modelPools.strong[0], "openrouter/test-strong");
  assert.equal(config.modelPools.free[0], "openrouter/test-free:free");
  assert.doesNotMatch(config.modelPools.coding.join(" "), /cx\/gpt-5\.5/);
  assert.equal(config.promptSettings.workerSystem, "Custom worker prompt");
  assert.equal(config.budget.goal.maxTokens, 1234);
  assert.equal(config.budget.task.maxRetries, 1);
  assert.equal(config.tools.browser.adapter, "playwright");
  assert.equal(config.tools.browser.allowRealBrowser, true);
  assert.equal(config.tools.browser.maxTextLength, 1200);
  assert.equal(config.recoveryPolicy.retryReadyPolicy, "blocked");
  assert.equal(config.recoveryPolicy.maxAutoRecoveredTasks, 5);
}

function testMissingUserConfigFallsBack() {
  const config = configLoader.loadRuntimeConfig({
    configFile: path.join(testRoot, "does-not-exist.json")
  });
  assert.equal(config.maxTasks, configLoader.DEFAULT_CONFIG.maxTasks);
  assert.equal(config.configSources.user, "");
}

function testRequestModelPoolsAllowSameModelAcrossTiers() {
  const config = configLoader.applyRequestConfig(configLoader.createDefaultRuntimeConfig(), {
    model_pools: {
      commander: ["deepseek/deepseek-chat"],
      strong: ["deepseek/deepseek-chat"],
      coding: ["deepseek/deepseek-chat"],
      free: ["deepseek/deepseek-chat"]
    }
  });
  assert.deepEqual(config.modelPools.commander, ["gpt5.5"]);
  assert.deepEqual(config.modelPools.strong, ["deepseek/deepseek-chat"]);
  assert.deepEqual(config.modelPools.coding, ["deepseek/deepseek-chat"]);
  assert.deepEqual(config.modelPools.free, ["deepseek/deepseek-chat"]);
}

function testValidationRepairsInvalidPolicyValues() {
  const config = configLoader.loadRuntimeConfig({
    userConfig: {
      budget: {
        goal: { maxTokens: -1 },
        thresholds: { warning: -2 }
      },
      riskPolicy: {
        levels: ["low", "mystery"],
        escalation: { highRetryAttempts: -5 }
      },
      verificationPolicy: {
        confidence: {
          verified: 2,
          partialTechnical: -1
        },
        semantic: {
          minQualityScore: 4
        }
      }
    }
  });
  assert.equal(config.budget.goal.maxTokens, configLoader.DEFAULT_CONFIG.budget.goal.maxTokens);
  assert.equal(config.budget.thresholds.warning, configLoader.DEFAULT_CONFIG.budget.thresholds.warning);
  assert.deepEqual(config.riskPolicy.levels, configLoader.DEFAULT_CONFIG.riskPolicy.levels);
  assert.equal(
    config.riskPolicy.escalation.highRetryAttempts,
    configLoader.DEFAULT_CONFIG.riskPolicy.escalation.highRetryAttempts
  );
  assert.equal(
    config.verificationPolicy.confidence.verified,
    configLoader.DEFAULT_CONFIG.verificationPolicy.confidence.verified
  );
  assert.equal(
    config.verificationPolicy.confidence.partialTechnical,
    configLoader.DEFAULT_CONFIG.verificationPolicy.confidence.partialTechnical
  );
  assert.equal(
    config.verificationPolicy.semantic.minQualityScore,
    configLoader.DEFAULT_CONFIG.verificationPolicy.semantic.minQualityScore
  );
  assert.ok(config.configWarnings.some((warning) => /budget policy/i.test(warning)));
  assert.ok(config.configWarnings.some((warning) => /riskPolicy\.levels/i.test(warning)));
  assert.ok(config.configWarnings.some((warning) => /verificationPolicy\.confidence\.verified/i.test(warning)));
}

function testSanitizerRedactsSecrets() {
  const sanitized = configLoader.sanitizeConfig({
    apiKey: "secret-key",
    nested: {
      cookie: "session-cookie",
      authorizationHeader: "Bearer secret",
      normal: "visible"
    }
  });
  assert.equal(sanitized.apiKey, "[REDACTED]");
  assert.equal(sanitized.nested.cookie, "[REDACTED]");
  assert.equal(sanitized.nested.authorizationHeader, "[REDACTED]");
  assert.equal(sanitized.nested.normal, "visible");
}

function testCompatExportsAndRouterIsolation() {
  const agentRoute = require("./agent-route");
  const coreRouter = require("./core/router");
  assert.ok(agentRoute.DEFAULT_CONFIG.promptSettings.workerSystem);
  assert.ok(agentRoute.DEFAULT_PROMPT_SETTINGS.workerSystem);
  assert.ok(agentRoute.DEFAULT_MODEL_POOLS.commander.length > 0);
  assert.ok(agentRoute.COMMANDER_MODEL_OPTIONS.length > 0);
  assert.equal(typeof coreRouter.handleInternalModelRequest, "function");
  assert.equal(Object.prototype.hasOwnProperty.call(coreRouter, "DEFAULT_CONFIG"), false);
}

async function testConfigStatusActionIsSanitized() {
  const previous = process.env.AGENT_ROUTE_CONFIG;
  const configFile = path.join(testRoot, "secret-config.json");
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      apiKey: "redact",
      nested: { token: "hidden" }
    })
  );
  process.env.AGENT_ROUTE_CONFIG = configFile;
  const actionApi = require("./agent/orchestrator/action-api");
  const response = await actionApi.handleAgentRouteAction({ action: "config_status" });
  const json = await response.json();
  assert.equal(json.config.apiKey, "[REDACTED]");
  assert.equal(json.config.nested.token, "[REDACTED]");
  assert.equal(json.sources.user, configFile);
  if (previous == null) delete process.env.AGENT_ROUTE_CONFIG;
  else process.env.AGENT_ROUTE_CONFIG = previous;
}

async function main() {
  testLoadsDefaultConfig();
  testUserConfigOverridesDefaults();
  testMissingUserConfigFallsBack();
  testRequestModelPoolsAllowSameModelAcrossTiers();
  testValidationRepairsInvalidPolicyValues();
  testSanitizerRedactsSecrets();
  testCompatExportsAndRouterIsolation();
  await testConfigStatusActionIsSanitized();
  console.log("config-loader tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
