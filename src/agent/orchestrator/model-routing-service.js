"use strict";

const budgetGovernor = require("../budget");
const planner = require("./planner");
const configLoader = require("../../config/loader");
const providerSettings = require("../../core/providers");

const { DEFAULT_COMMANDER_MODELS, DEFAULT_CONFIG, dedupeModelPoolsByTier, loadRuntimeConfig, uniqueModels } =
  configLoader;

let dynamicFreeCache = { expiresAt: 0, models: [] };

function splitModelList(value) {
  return uniqueModels(String(value || "").split(/[\n,]+/));
}

function configuredCommanderModelsFromEnv() {
  return splitModelList(process.env.AGENT_ROUTE_COMMANDER_MODELS || process.env.AGENT_ROUTE_COMMANDER_MODEL || "");
}

function modelIdFromProviderModel(connection, model) {
  const id = String((model && model.id) || model || "").trim();
  if (!id) return "";
  if (id.includes("/")) return id;
  const prefix = String(connection.providerAlias || connection.provider || "").trim();
  return prefix ? `${prefix}/${id}` : id;
}

function isUsableProviderConnection(connection) {
  if (!connection || connection.isActive === false) return false;
  if (String(connection.authType || "").toLowerCase() !== "apikey") return false;
  if (!connection.hasApiKey && !connection.hasOAuthToken) return false;
  const status = String(connection.testStatus || "").toLowerCase();
  return !["unavailable", "invalid", "failed", "error", "disabled"].includes(status);
}

function isUsableCodexOAuthConnection(connection) {
  if (!connection || connection.isActive === false) return false;
  if (String(connection.provider || "").toLowerCase() !== "codex") return false;
  if (String(connection.authType || "").toLowerCase() !== "oauth") return false;
  if (!connection.hasOAuthToken) return false;
  const status = String(connection.testStatus || "").toLowerCase();
  return !["unavailable", "invalid", "failed", "error", "disabled"].includes(status);
}

function activeProviderModelPools() {
  let status = null;
  try {
    status = providerSettings.providerStatus();
  } catch {
    return {};
  }
  if (!status || !Array.isArray(status.connections)) return {};
  const pools = { commander: [], strong: [], coding: [], free: [] };
  for (const connection of status.connections) {
    if (isUsableCodexOAuthConnection(connection)) {
      const models = connection.defaultModel ? [{ id: connection.defaultModel }] : connection.models || [];
      for (const model of models) {
        const id = modelIdFromProviderModel(connection, model);
        if (id && isAllowedCommanderModel(id)) pools.commander.push(id);
      }
      continue;
    }
    if (!isUsableProviderConnection(connection)) continue;
    const provider = String(connection.provider || "").toLowerCase();
    if (provider === "openrouter") continue;
    const models = connection.defaultModel ? [{ id: connection.defaultModel }] : connection.models || [];
    for (const model of models) {
      const id = modelIdFromProviderModel(connection, model);
      if (!id) continue;
      const lower = id.toLowerCase();
      if (/vision|embed|tts|image|audio/.test(lower)) continue;
      pools.free.push(id);
      if (/coder|code|chat|flash|mini|lite/.test(lower)) pools.coding.push(id);
      if (/pro|reason|sonnet|opus|gpt-5|kimi|qwen|deepseek|glm/.test(lower)) pools.strong.push(id);
    }
  }
  const sortByInteractiveCost = (models) =>
    uniqueModels(models).sort((left, right) => activeProviderModelScore(left) - activeProviderModelScore(right));
  return {
    commander: sortByInteractiveCost(pools.commander),
    strong: sortByInteractiveCost(pools.strong),
    coding: sortByInteractiveCost(pools.coding),
    free: sortByInteractiveCost(pools.free)
  };
}

function activeProviderModelScore(model) {
  const id = String(model || "").toLowerCase();
  let score = 50;
  if (/flash|turbo|haiku|mini|lite|small/.test(id)) score -= 30;
  if (/chat|instruct/.test(id)) score -= 45;
  if (/coder|code/.test(id)) score -= 5;
  if (/pro|reason|thinking|opus/.test(id)) score += 30;
  return score;
}

function isAllowedCommanderModel(model) {
  const id = String(model || "").toLowerCase();
  const explicitCommanderModels = configuredCommanderModelsFromEnv().map((item) => item.toLowerCase());
  if (explicitCommanderModels.length) return explicitCommanderModels.includes(id);
  return /^(cx|codex)\/gpt-[a-z0-9_.-]+$/.test(id);
}

function applyActiveProviderModels(config) {
  const explicitCommanderModels = configuredCommanderModelsFromEnv();
  if (explicitCommanderModels.length) {
    return {
      ...config,
      modelPools: dedupeModelPoolsByTier({
        ...(config.modelPools || {}),
        commander: explicitCommanderModels
      })
    };
  }
  const active = activeProviderModelPools();
  if (!Object.values(active).some((models) => Array.isArray(models) && models.length)) return config;
  const modelPools = config.modelPools || {};
  return {
    ...config,
    modelPools: dedupeModelPoolsByTier({
      ...modelPools,
      commander: uniqueModels([...(modelPools.commander || [])]).filter(isAllowedCommanderModel),
      strong: uniqueModels([...(active.strong || []), ...(modelPools.strong || [])]),
      coding: uniqueModels([...(active.coding || []), ...(modelPools.coding || [])]),
      free: uniqueModels([...(active.free || []), ...(modelPools.free || [])])
    })
  };
}

function loadConfig() {
  return loadRuntimeConfig({
    onWarning: (warning) => console.warn("[agent-route] config warning:", warning)
  });
}

function freeModelScore(model) {
  const id = String(model || "").toLowerCase();
  const baseRules = [
    ["glm-4.5-air", 121],
    ["gpt-oss-120b", 120],
    ["gemini-3-flash", 118],
    ["gemini-3.1-flash", 117],
    ["qwen3-coder", 116],
    ["qwen3-235b", 114],
    ["qwen3-next-80b", 112],
    ["nemotron-3-super-120b", 110],
    ["hermes-3-llama-3.1-405b", 108],
    ["gemma-4-31b", 107],
    ["deepseek-v4", 106],
    ["deepseek-r1", 104],
    ["glm-4.5", 102],
    ["kimi-k2", 100],
    ["minimax-m2", 98],
    ["llama-3.3-70b", 96],
    ["gemma-4-26b", 90],
    ["mistral-small", 88],
    ["gpt-oss-20b", 84]
  ];
  const modifierRules = [
    ["flash-lite", 8],
    ["reasoning", 6],
    ["thinking", 5],
    ["coder", 4]
  ];
  const base = (baseRules.find((rule) => id.includes(rule[0])) || [null, 0])[1];
  return modifierRules.reduce((score, rule) => (id.includes(rule[0]) ? score + rule[1] : score), base);
}

async function fetchDynamicFreeModels(config) {
  if (!config.dynamicFreeModels || typeof fetch !== "function") return [];
  const now = Date.now();
  if (dynamicFreeCache.expiresAt > now) return dynamicFreeCache.models;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(config.discoveryTimeoutMs || 2500));
  try {
    const response = await fetch(config.openRouterModelsEndpoint || DEFAULT_CONFIG.openRouterModelsEndpoint, {
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const models = uniqueModels(
      (data.data || [])
        .map((model) => model && model.id)
        .filter((id) => typeof id === "string" && id.endsWith(":free"))
        .map((id) => `openrouter/${id}`)
    )
      .sort((a, b) => freeModelScore(b) - freeModelScore(a) || a.localeCompare(b))
      .slice(0, Number(config.maxFreeCandidates || DEFAULT_CONFIG.maxFreeCandidates));
    dynamicFreeCache = { expiresAt: now + 10 * 60 * 1000, models };
    return models;
  } catch (err) {
    dynamicFreeCache = { expiresAt: now + 60 * 1000, models: [] };
    console.warn("[agent-route] dynamic free model discovery failed:", err.message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function resolveConfig() {
  const config = loadConfig();
  const dynamicFreeModels = await fetchDynamicFreeModels(config);
  const free = uniqueModels([...dynamicFreeModels, ...(config.modelPools.free || [])]).sort(
    (a, b) => freeModelScore(b) - freeModelScore(a)
  );

  return {
    ...config,
    modelPools: dedupeModelPoolsByTier({
      ...config.modelPools,
      free
    })
  };
}

function modelsForPool(config, poolName) {
  if (poolName === "codex-cli") return ["codex-cli"];
  const pool = config.modelPools[poolName] || config.modelPools.free || [];
  if (poolName === "commander" || poolName === "free") return pool;
  return uniqueModels([...pool, ...(config.modelPools.free || [])]);
}

function modelsForTask(config, task, commanderRoute, budgetState = null) {
  if ((task && task.modelPool) === "codex-cli") return ["codex-cli"];
  const modelPool = task && task.modelPool ? task.modelPool : "free";
  const complexity = planner.normalizeComplexity(task && task.complexity, planner.defaultComplexityForPool(modelPool));
  const riskLevel = planner.normalizeRiskLevel(task && task.riskLevel, "low");
  const commander = commanderRoute && commanderRoute.models ? commanderRoute.models : config.modelPools.commander || [];
  const strong = config.modelPools.strong || [];
  const coding = config.modelPools.coding || [];
  const free = config.modelPools.free || [];
  const requested = modelsForPool(config, modelPool);

  if (riskLevel === "critical" || complexity === "critical") {
    return budgetGovernor.routeModels(uniqueModels([...commander, ...strong, ...coding, ...free]), {
      budgetState,
      task
    });
  }
  if (riskLevel === "high" && modelPool === "free") {
    return budgetGovernor.routeModels(uniqueModels([...strong, ...commander, ...free]), { budgetState, task });
  }
  if (complexity === "high") {
    if (modelPool === "coding")
      return budgetGovernor.routeModels(uniqueModels([...coding, ...strong, ...commander, ...free]), {
        budgetState,
        task
      });
    if (modelPool === "free")
      return budgetGovernor.routeModels(uniqueModels([...strong, ...commander, ...free]), { budgetState, task });
    return budgetGovernor.routeModels(uniqueModels([...requested, ...strong, ...coding, ...free]), {
      budgetState,
      task
    });
  }
  if (complexity === "medium") {
    if (modelPool === "free")
      return budgetGovernor.routeModels(uniqueModels([...free, ...strong.slice(0, 2)]), { budgetState, task });
    return budgetGovernor.routeModels(uniqueModels([...requested, ...free]), { budgetState, task });
  }
  return budgetGovernor.routeModels(modelPool === "free" ? free : uniqueModels([...requested, ...free]), {
    budgetState,
    task
  });
}

function isFreeFallbackModel(model) {
  const id = String(model || "").toLowerCase();
  return (
    id.includes(":free") ||
    id.startsWith("oc/") ||
    id.startsWith("gc/") ||
    id.includes("/gemini-3-flash") ||
    id.includes("/gemini-3.1-flash") ||
    id.includes("/gemini-2.5-flash") ||
    id.includes("/gemma-")
  );
}

function getRequestedCommanderModel(body, config) {
  const explicitCommanderModels = configuredCommanderModelsFromEnv();
  const raw =
    body &&
    (body.commander_model ||
      body.commanderModel ||
      (body.agent_route && body.agent_route.commander_model) ||
      (body.agentRoute && body.agentRoute.commanderModel));
  const requested = String(raw || "").trim();
  if (!requested) return "";
  if (explicitCommanderModels.length) {
    const allowed = new Set(explicitCommanderModels.map((model) => model.toLowerCase()));
    return allowed.has(requested.toLowerCase()) ? requested : "";
  }
  const allowed = new Set(
    uniqueModels([...DEFAULT_COMMANDER_MODELS, ...((config.modelPools || {}).commander || [])]).filter(
      isAllowedCommanderModel
    )
  );
  return allowed.has(requested) ? requested : "";
}

function resolveCommanderRoute(body, config) {
  const explicitCommanderModels = configuredCommanderModelsFromEnv();
  const selected = getRequestedCommanderModel(body, config);
  if (explicitCommanderModels.length) {
    const models = uniqueModels([selected, ...explicitCommanderModels]).filter(Boolean);
    return {
      selected: models[0],
      models
    };
  }
  const configuredCommander = uniqueModels((config.modelPools || {}).commander || DEFAULT_COMMANDER_MODELS).filter(
    isAllowedCommanderModel
  );
  const activeCommander = (activeProviderModelPools().commander || []).filter(isAllowedCommanderModel);
  const models = uniqueModels(
    configuredCommander.length ? [selected, ...configuredCommander] : [selected, ...activeCommander]
  ).filter(Boolean);
  const safeModels = models.length ? models : DEFAULT_COMMANDER_MODELS.filter(isAllowedCommanderModel);
  return {
    selected: safeModels[0] || DEFAULT_COMMANDER_MODELS[0],
    models: safeModels
  };
}

module.exports = {
  applyActiveProviderModels,
  activeProviderModelPools,
  fetchDynamicFreeModels,
  freeModelScore,
  getRequestedCommanderModel,
  isAllowedCommanderModel,
  isFreeFallbackModel,
  loadConfig,
  modelsForPool,
  modelsForTask,
  resolveCommanderRoute,
  resolveConfig
};
