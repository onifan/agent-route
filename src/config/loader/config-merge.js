"use strict";

const { DEFAULT_CONFIG, DEFAULT_MODEL_POOLS, DEFAULT_PROMPT_SETTINGS } = require("./runtime-config");

function clone(value) {
  return JSON.parse(JSON.stringify(value == null ? null : value));
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function uniqueModels(models) {
  return [
    ...new Set(
      (models || [])
        .filter(Boolean)
        .map((model) => String(model).trim())
        .filter(Boolean)
    )
  ];
}

function normalizeCommanderModelId(value) {
  const model = String(value || "").trim();
  if (/^(?:cx|codex)\/gpt-?5\.5$/i.test(model) || /^gpt-?5\.5$/i.test(model)) return "gpt5.5";
  return model;
}

function isSupportedCommanderModel(model) {
  return normalizeCommanderModelId(model).toLowerCase() === "gpt5.5";
}

function promptText(value, fallback) {
  const text = String(value == null ? "" : value).trim();
  return (text || fallback || "").slice(0, 8000);
}

function normalizePromptSettings(raw, defaults = DEFAULT_PROMPT_SETTINGS) {
  const source = isObject(raw) ? raw : {};
  const tierSource = isObject(source.tierPrompts || source.tier_prompts)
    ? source.tierPrompts || source.tier_prompts
    : {};
  const fallback = isObject(defaults) ? defaults : DEFAULT_PROMPT_SETTINGS;
  return {
    commanderSystem: promptText(source.commanderSystem || source.commander_system, fallback.commanderSystem),
    plannerInstructions: promptText(
      source.plannerInstructions || source.planner_instructions,
      fallback.plannerInstructions
    ),
    reviewSystem: promptText(source.reviewSystem || source.review_system, fallback.reviewSystem),
    finalSystem: promptText(source.finalSystem || source.final_system, fallback.finalSystem),
    workerSystem: promptText(source.workerSystem || source.worker_system, fallback.workerSystem),
    codexCliSystem: promptText(source.codexCliSystem || source.codex_cli_system, fallback.codexCliSystem),
    tierPrompts: {
      commander: promptText(tierSource.commander, fallback.tierPrompts && fallback.tierPrompts.commander),
      strong: promptText(tierSource.strong, fallback.tierPrompts && fallback.tierPrompts.strong),
      coding: promptText(tierSource.coding, fallback.tierPrompts && fallback.tierPrompts.coding),
      free: promptText(tierSource.free, fallback.tierPrompts && fallback.tierPrompts.free),
      "codex-cli": promptText(
        tierSource["codex-cli"] || tierSource.codexCli || tierSource.codex_cli,
        fallback.tierPrompts && fallback.tierPrompts["codex-cli"]
      )
    }
  };
}

function isCommanderGradeModel(model) {
  const id = String(model || "").toLowerCase();
  return id === "gpt5.5" || id.includes("gpt-5") || id.includes("codex-xhigh") || id.includes("cx/gpt-");
}

function cleanModelPoolsForTier(modelPools, defaults = DEFAULT_MODEL_POOLS) {
  const output = { ...(isObject(modelPools) ? modelPools : {}) };
  for (const key of ["commander", "strong", "coding", "free", "codex-cli"]) {
    const raw = Array.isArray(output[key]) ? output[key] : String(output[key] || "").split(/[\n,]+/);
    const fallback = Array.isArray(defaults[key]) ? defaults[key] : [];
    const models = uniqueModels(raw);
    output[key] = models.length ? models : fallback.slice();
  }
  output.commander = uniqueModels(output.commander.map(normalizeCommanderModelId)).filter(isSupportedCommanderModel);
  if (!output.commander.length) output.commander = (defaults.commander || []).slice();
  output.coding = uniqueModels(output.coding).filter((model) => !isCommanderGradeModel(model));
  if (!output.coding.length) output.coding = (defaults.coding || []).slice();
  return output;
}

function dedupeModelPoolsByTier(modelPools, defaults = DEFAULT_MODEL_POOLS) {
  const cleaned = cleanModelPoolsForTier(modelPools, defaults);
  const output = {};
  for (const pool of ["commander", "strong", "coding", "free"]) {
    output[pool] = uniqueModels(cleaned && cleaned[pool]);
  }
  return {
    ...cleaned,
    ...output,
    "codex-cli": uniqueModels(cleaned["codex-cli"] || defaults["codex-cli"] || ["codex-cli"])
  };
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function mergeSection(defaults = {}, source = {}) {
  const output = { ...(defaults || {}) };
  if (!isObject(source)) return output;
  for (const [key, value] of Object.entries(source)) {
    const fallback = output[key];
    output[key] = typeof fallback === "number" ? numberOr(value, fallback) : value;
  }
  return output;
}

function normalizeBudgetPolicy(raw, defaults = DEFAULT_CONFIG.budget) {
  const source = isObject(raw) ? raw : {};
  const fallback = isObject(defaults) ? defaults : DEFAULT_CONFIG.budget;
  const mode = String(source.mode || source.budgetMode || source.budget_mode || fallback.mode || "").toLowerCase();
  const unlimited =
    source.unlimited === true ||
    source.disabled === true ||
    source.enabled === false ||
    mode === "unlimited" ||
    mode === "disabled" ||
    mode === "off";

  return {
    unlimited,
    mode: unlimited ? "unlimited" : "limited",
    goal: mergeSection(fallback.goal, source.goal || source.goalBudget || source.goal_budget),
    task: mergeSection(fallback.task, source.task || source.taskBudget || source.task_budget),
    worker: mergeSection(fallback.worker, source.worker || source.workerBudget || source.worker_budget),
    browser: mergeSection(fallback.browser, source.browser || source.browserBudget || source.browser_budget),
    verification: mergeSection(
      fallback.verification,
      source.verification || source.verificationBudget || source.verification_budget
    ),
    thresholds: mergeSection(fallback.thresholds, source.thresholds)
  };
}

function deepMerge(base, override) {
  if (!isObject(base)) return isObject(override) ? clone(override) : override;
  const output = clone(base);
  if (!isObject(override)) return output;
  for (const [key, value] of Object.entries(override)) {
    if (isObject(value) && isObject(output[key])) {
      output[key] = deepMerge(output[key], value);
    } else if (Array.isArray(value)) {
      output[key] = value.slice();
    } else {
      output[key] = value;
    }
  }
  return output;
}

function mergeRuntimeConfig(base = DEFAULT_CONFIG, override = {}) {
  const source = isObject(override) ? override : {};
  const merged = deepMerge(base, source);
  merged.modelPools = dedupeModelPoolsByTier(
    {
      ...(base.modelPools || {}),
      ...(source.modelPools || source.model_pools || {})
    },
    base.modelPools || DEFAULT_MODEL_POOLS
  );
  merged.promptSettings = normalizePromptSettings(
    source.promptSettings || source.prompt_settings || merged.promptSettings,
    base.promptSettings || DEFAULT_PROMPT_SETTINGS
  );
  merged.budget = normalizeBudgetPolicy(merged.budget, base.budget || DEFAULT_CONFIG.budget);
  merged.runtimePaths = {
    ...(base.runtimePaths || {}),
    ...(isObject(source.runtimePaths || source.runtime_paths) ? source.runtimePaths || source.runtime_paths : {})
  };
  merged.featureFlags = {
    ...(base.featureFlags || {}),
    ...(isObject(source.featureFlags || source.feature_flags) ? source.featureFlags || source.feature_flags : {})
  };
  return merged;
}

function requestModelPools(body) {
  if (!isObject(body)) return null;
  return (
    body.model_pools ||
    body.modelPools ||
    (body.agent_route && (body.agent_route.model_pools || body.agent_route.modelPools)) ||
    (body.agentRoute && (body.agentRoute.modelPools || body.agentRoute.model_pools)) ||
    null
  );
}

function requestPromptSettings(body) {
  if (!isObject(body)) return null;
  return (
    body.prompt_settings ||
    body.promptSettings ||
    (body.agent_route && (body.agent_route.prompt_settings || body.agent_route.promptSettings)) ||
    (body.agentRoute && (body.agentRoute.promptSettings || body.agentRoute.prompt_settings)) ||
    null
  );
}

function requestBudgetPolicy(body) {
  if (!isObject(body)) return null;
  return (
    body.budget ||
    body.budgetPolicy ||
    body.budget_policy ||
    (body.agent_route &&
      (body.agent_route.budget || body.agent_route.budgetPolicy || body.agent_route.budget_policy)) ||
    (body.agentRoute && (body.agentRoute.budget || body.agentRoute.budgetPolicy || body.agentRoute.budget_policy)) ||
    null
  );
}

function normalizeRequestModelPools(raw) {
  if (!isObject(raw)) return null;
  const keys = ["commander", "strong", "coding", "free", "codex-cli"];
  const pools = {};
  for (const key of keys) {
    const value = raw[key];
    const models = uniqueModels(Array.isArray(value) ? value : String(value || "").split(/[\n,]+/)).slice(0, 80);
    if (models.length) pools[key] = models;
  }
  return Object.keys(pools).length ? pools : null;
}

function applyRequestModelPools(config, body) {
  const pools = normalizeRequestModelPools(requestModelPools(body));
  if (!pools) return config;
  return {
    ...config,
    modelPools: dedupeModelPoolsByTier(
      {
        ...(config.modelPools || {}),
        ...pools
      },
      config.modelPools || DEFAULT_MODEL_POOLS
    )
  };
}

function applyRequestPromptSettings(config, body) {
  const prompts = requestPromptSettings(body);
  if (!isObject(prompts)) return config;
  return {
    ...config,
    promptSettings: normalizePromptSettings(
      {
        ...(config.promptSettings || {}),
        ...prompts,
        tierPrompts: {
          ...((config.promptSettings && config.promptSettings.tierPrompts) || {}),
          ...((prompts && (prompts.tierPrompts || prompts.tier_prompts)) || {})
        }
      },
      config.promptSettings || DEFAULT_PROMPT_SETTINGS
    )
  };
}

function applyRequestBudget(config, body) {
  const budget = requestBudgetPolicy(body);
  if (!isObject(budget)) return config;
  const current = config.budget || {};
  return {
    ...config,
    budget: normalizeBudgetPolicy(
      {
        unlimited: budget.unlimited == null ? current.unlimited : budget.unlimited,
        mode: budget.mode || budget.budgetMode || budget.budget_mode || current.mode,
        disabled: budget.disabled == null ? current.disabled : budget.disabled,
        enabled: budget.enabled == null ? current.enabled : budget.enabled,
        goal: { ...(current.goal || {}), ...(budget.goal || budget.goalBudget || budget.goal_budget || {}) },
        task: { ...(current.task || {}), ...(budget.task || budget.taskBudget || budget.task_budget || {}) },
        worker: { ...(current.worker || {}), ...(budget.worker || budget.workerBudget || budget.worker_budget || {}) },
        browser: {
          ...(current.browser || {}),
          ...(budget.browser || budget.browserBudget || budget.browser_budget || {})
        },
        verification: {
          ...(current.verification || {}),
          ...(budget.verification || budget.verificationBudget || budget.verification_budget || {})
        },
        thresholds: { ...(current.thresholds || {}), ...(budget.thresholds || {}) }
      },
      current
    )
  };
}

function applyRequestConfig(config, body) {
  return applyRequestBudget(applyRequestPromptSettings(applyRequestModelPools(config, body), body), body);
}

module.exports = {
  applyRequestBudget,
  applyRequestConfig,
  applyRequestModelPools,
  applyRequestPromptSettings,
  cleanModelPoolsForTier,
  dedupeModelPoolsByTier,
  deepMerge,
  isObject,
  mergeRuntimeConfig,
  normalizeBudgetPolicy,
  normalizePromptSettings,
  normalizeRequestModelPools,
  promptText,
  requestBudgetPolicy,
  requestModelPools,
  requestPromptSettings,
  uniqueModels
};
