"use strict";

const budgetGovernor = require("../budget");
const planner = require("./planner");
const configLoader = require("../../config/loader");
const modelApiSettings = require("../../core/model-api-settings");

const { DEFAULT_COMMANDER_MODELS, dedupeModelPoolsByTier, loadRuntimeConfig, uniqueModels } = configLoader;

function commanderModelAlias(model) {
  const id = String(model || "")
    .trim()
    .toLowerCase();
  if (/^(?:cx|codex|local|openai)\/gpt-?5\.5$/.test(id) || /^gpt-?5\.5$/.test(id)) return "gpt5.5";
  return id;
}

function splitModelList(value) {
  return uniqueModels(
    String(value || "")
      .split(/[\n,]+/)
      .map(commanderModelAlias)
  );
}

function configuredCommanderModelsFromEnv() {
  return splitModelList(
    process.env.AGENT_ROUTE_COMMANDER_MODELS || process.env.AGENT_ROUTE_COMMANDER_MODEL || ""
  ).filter((model) => model === "gpt5.5");
}

function activeProviderModelPools() {
  const pools = modelApiSettings.configuredModelPools();
  const sortByCapability = (models) =>
    uniqueModels(models).sort((left, right) => activeProviderModelScore(left) - activeProviderModelScore(right));
  return {
    commander: sortByCapability(pools.commander),
    strong: sortByCapability(pools.strong),
    coding: sortByCapability(pools.coding),
    free: sortByCapability(pools.free)
  };
}

function capabilityTier(model) {
  const id = String(model || "").toLowerCase();
  if (/^(gpt5\.5|gpt-?5\.5)$/.test(id) || id.startsWith("openai/") || id.startsWith("claude/")) return 1;
  if (id.startsWith("anthropic/")) return 1;
  if (id.startsWith("gemini/") || id.startsWith("gc/") || id.startsWith("deepseek/")) return 2;
  if (id.startsWith("glm/") || id.startsWith("zhipu/") || id.startsWith("bigmodel/")) return 3;
  if (id.startsWith("qwen/") || id.startsWith("qw/")) return 3;
  return 9;
}

function activeProviderModelScore(model) {
  const id = String(model || "").toLowerCase();
  let score = capabilityTier(id) * 100;
  if (/gpt5\.5|gpt-?5\.5|opus|sonnet|pro|reason|reasoner|thinking|max/.test(id)) score -= 20;
  if (/coder|code/.test(id)) score -= 8;
  if (/(^|[-_/])(flash|turbo|haiku|mini|lite|small|chat|instruct)([-_/]|$)/.test(id)) score += 12;
  return score;
}

function isAllowedCommanderModel(model) {
  const id = String(model || "")
    .trim()
    .toLowerCase();
  const alias = commanderModelAlias(id);
  const explicitCommanderModels = configuredCommanderModelsFromEnv().map((item) => item.toLowerCase());
  if (explicitCommanderModels.length) {
    return explicitCommanderModels.includes(id) || explicitCommanderModels.map(commanderModelAlias).includes(alias);
  }
  return alias === "gpt5.5";
}

function matchingAllowedCommanderModel(requested, allowedModels = []) {
  const requestedId = String(requested || "")
    .trim()
    .toLowerCase();
  if (!requestedId) return "";
  const requestedAlias = commanderModelAlias(requestedId);
  for (const model of allowedModels) {
    const modelId = String(model || "").trim();
    if (!modelId) continue;
    if (modelId.toLowerCase() === requestedId || commanderModelAlias(modelId) === requestedAlias) {
      return commanderModelAlias(modelId) === "gpt5.5" ? "gpt5.5" : modelId;
    }
  }
  return "";
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
    ["gpt-5.5", 300],
    ["gpt5.5", 300],
    ["claude", 290],
    ["gemini", 220],
    ["deepseek", 210],
    ["glm", 130],
    ["qwen", 120],
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

async function resolveConfig() {
  const config = loadConfig();
  const free = uniqueModels(config.modelPools.free || []).sort((a, b) => freeModelScore(b) - freeModelScore(a));

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

function isLowCostModel(model) {
  const id = String(model || "").toLowerCase();
  return (
    id.includes(":free") ||
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
    return matchingAllowedCommanderModel(requested, explicitCommanderModels);
  }
  const allowedModels = uniqueModels([
    ...DEFAULT_COMMANDER_MODELS,
    ...((config.modelPools || {}).commander || [])
  ]).filter(isAllowedCommanderModel);
  return matchingAllowedCommanderModel(requested, allowedModels);
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
  freeModelScore,
  getRequestedCommanderModel,
  isAllowedCommanderModel,
  isLowCostModel,
  loadConfig,
  modelsForPool,
  modelsForTask,
  resolveCommanderRoute,
  resolveConfig
};
