"use strict";

const { DEFAULT_CONFIG, DEFAULT_MODEL_POOLS, DEFAULT_PROMPT_SETTINGS } = require("./runtime-config");
const { dedupeModelPoolsByTier, isObject, normalizeBudgetPolicy, normalizePromptSettings } = require("./config-merge");

const RISK_LEVELS = ["low", "medium", "high", "critical"];

function clone(value) {
  return JSON.parse(JSON.stringify(value == null ? null : value));
}

function numberInRange(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return fallback;
  return number;
}

function stringArray(value, fallback = []) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  return fallback.slice();
}

function hasNegativeNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) && value < 0;
  if (Array.isArray(value)) return value.some(hasNegativeNumber);
  if (isObject(value)) return Object.values(value).some(hasNegativeNumber);
  return false;
}

function validateRiskPolicy(policy, defaults = DEFAULT_CONFIG.riskPolicy, warnings = []) {
  const source = isObject(policy) ? clone(policy) : {};
  const fallback = isObject(defaults) ? defaults : DEFAULT_CONFIG.riskPolicy;
  const levels = stringArray(source.levels, fallback.levels || RISK_LEVELS);
  if (!RISK_LEVELS.every((level) => levels.includes(level))) {
    warnings.push("riskPolicy.levels was invalid; default risk levels were restored.");
    source.levels = (fallback.levels || RISK_LEVELS).slice();
  } else {
    source.levels = levels;
  }
  source.shell = isObject(source.shell) ? source.shell : clone(fallback.shell || {});
  source.browser = isObject(source.browser) ? source.browser : clone(fallback.browser || {});
  source.escalation = {
    ...(fallback.escalation || {}),
    ...(isObject(source.escalation) ? source.escalation : {})
  };
  for (const key of ["mediumRetryAttempts", "highRetryAttempts", "longLoopMs"]) {
    const fixed = numberInRange(source.escalation[key], fallback.escalation && fallback.escalation[key], 0);
    if (fixed !== source.escalation[key]) warnings.push(`riskPolicy.escalation.${key} was invalid; default was used.`);
    source.escalation[key] = fixed;
  }
  return source;
}

function validateVerificationPolicy(policy, defaults = DEFAULT_CONFIG.verificationPolicy, warnings = []) {
  const source = isObject(policy) ? clone(policy) : {};
  const fallback = isObject(defaults) ? defaults : DEFAULT_CONFIG.verificationPolicy;
  source.depth = String(source.depth || fallback.depth || "rule_based");
  source.confidence = {
    ...(fallback.confidence || {}),
    ...(isObject(source.confidence) ? source.confidence : {})
  };
  for (const key of Object.keys(source.confidence)) {
    const fixed = numberInRange(source.confidence[key], fallback.confidence && fallback.confidence[key], 0, 1);
    if (fixed !== source.confidence[key])
      warnings.push(`verificationPolicy.confidence.${key} was invalid; default was used.`);
    source.confidence[key] = fixed;
  }
  source.failureHandling = {
    ...(fallback.failureHandling || {}),
    ...(isObject(source.failureHandling) ? source.failureHandling : {})
  };
  source.semantic = {
    ...(fallback.semantic || {}),
    ...(isObject(source.semantic) ? source.semantic : {})
  };
  for (const key of ["minCriteriaCoverage", "minQualityScore"]) {
    const fixed = numberInRange(source.semantic[key], fallback.semantic && fallback.semantic[key], 0, 1);
    if (fixed !== source.semantic[key])
      warnings.push(`verificationPolicy.semantic.${key} was invalid; default was used.`);
    source.semantic[key] = fixed;
  }
  return source;
}

function validateHumanApprovalPolicy(policy, defaults = DEFAULT_CONFIG.humanApprovalPolicy, warnings = []) {
  const source = isObject(policy) ? clone(policy) : {};
  const fallback = isObject(defaults) ? defaults : DEFAULT_CONFIG.humanApprovalPolicy;
  const level = String(source.requireApprovalAtRiskLevel || fallback.requireApprovalAtRiskLevel || "high");
  if (!RISK_LEVELS.includes(level)) {
    warnings.push("humanApprovalPolicy.requireApprovalAtRiskLevel was invalid; default was used.");
    source.requireApprovalAtRiskLevel = fallback.requireApprovalAtRiskLevel || "high";
  } else {
    source.requireApprovalAtRiskLevel = level;
  }
  source.actions = stringArray(source.actions, fallback.actions || []);
  source.blockedWithoutApproval = stringArray(source.blockedWithoutApproval, fallback.blockedWithoutApproval || []);
  return source;
}

function validateUnattendedPolicy(policy, defaults = DEFAULT_CONFIG.unattendedPolicy, warnings = []) {
  const source = isObject(policy) ? clone(policy) : {};
  const fallback = isObject(defaults) ? defaults : DEFAULT_CONFIG.unattendedPolicy;
  source.enabled = source.enabled == null ? fallback.enabled !== false : source.enabled !== false;
  source.requiresAutonomousContext =
    source.requiresAutonomousContext == null
      ? fallback.requiresAutonomousContext !== false
      : source.requiresAutonomousContext !== false;
  const night = isObject(source.nightHours) ? source.nightHours : {};
  source.nightHours = {
    start: numberInRange(night.start, fallback.nightHours && fallback.nightHours.start, 0, 23),
    end: numberInRange(night.end, fallback.nightHours && fallback.nightHours.end, 0, 23)
  };
  if (source.requiresAutonomousContext === false) {
    warnings.push(
      "unattendedPolicy.requiresAutonomousContext=false can affect ordinary runs; keep this override intentional."
    );
  }
  return source;
}

function validateBrowserToolPolicy(
  policy,
  defaults = DEFAULT_CONFIG.tools && DEFAULT_CONFIG.tools.browser,
  warnings = []
) {
  const source = isObject(policy) ? clone(policy) : {};
  const fallback = isObject(defaults) ? defaults : {};
  const adapter = String(source.adapter || fallback.adapter || "mock")
    .trim()
    .toLowerCase();
  if (!["mock", "playwright"].includes(adapter)) {
    warnings.push("tools.browser.adapter was invalid; mock adapter was used.");
    source.adapter = "mock";
  } else {
    source.adapter = adapter;
  }
  source.allowRealBrowser = source.allowRealBrowser === true;
  source.useMockAdapter =
    source.useMockAdapter == null ? fallback.useMockAdapter !== false : source.useMockAdapter !== false;
  source.allowMockFallback =
    source.allowMockFallback == null ? fallback.allowMockFallback !== false : source.allowMockFallback !== false;
  source.browserType = String(source.browserType || fallback.browserType || "chromium");
  source.headless = source.headless == null ? fallback.headless !== false : source.headless !== false;
  source.timeoutMs = numberInRange(source.timeoutMs, fallback.timeoutMs || 30000, 1);
  source.sessionTtlMs = numberInRange(source.sessionTtlMs, fallback.sessionTtlMs || 10 * 60 * 1000, 1000);
  source.maxTextLength = numberInRange(source.maxTextLength, fallback.maxTextLength || 4000, 100);
  source.maxSnapshotBytes = numberInRange(source.maxSnapshotBytes, fallback.maxSnapshotBytes || 24000, 1000);
  source.screenshotDir = String(source.screenshotDir || fallback.screenshotDir || "");
  source.snapshotDir = String(source.snapshotDir || fallback.snapshotDir || "");
  return source;
}

function validateRecoveryPolicy(policy, defaults = DEFAULT_CONFIG.recoveryPolicy, warnings = []) {
  const source = isObject(policy) ? clone(policy) : {};
  const fallback = isObject(defaults) ? defaults : DEFAULT_CONFIG.recoveryPolicy || {};
  source.enabled = source.enabled == null ? fallback.enabled !== false : source.enabled !== false;
  source.autoOnAgentRouteStart =
    source.autoOnAgentRouteStart == null
      ? fallback.autoOnAgentRouteStart !== false
      : source.autoOnAgentRouteStart !== false;
  const target = String(source.runningTaskTargetStatus || fallback.runningTaskTargetStatus || "blocked").toLowerCase();
  if (!["blocked", "retry_ready"].includes(target)) {
    warnings.push("recoveryPolicy.runningTaskTargetStatus was invalid; blocked was used.");
    source.runningTaskTargetStatus = "blocked";
  } else {
    source.runningTaskTargetStatus = target;
  }
  const retryPolicy = String(source.retryReadyPolicy || fallback.retryReadyPolicy || "waiting_if_budget_allows");
  if (!["waiting_if_budget_allows", "keep_retry_ready", "blocked"].includes(retryPolicy)) {
    warnings.push("recoveryPolicy.retryReadyPolicy was invalid; waiting_if_budget_allows was used.");
    source.retryReadyPolicy = "waiting_if_budget_allows";
  } else {
    source.retryReadyPolicy = retryPolicy;
  }
  source.runningTaskReason = String(
    source.runningTaskReason || fallback.runningTaskReason || "process_restarted_or_worker_lost"
  );
  source.staleBrowserSessionPolicy = String(
    source.staleBrowserSessionPolicy || fallback.staleBrowserSessionPolicy || "mark_stale"
  );
  source.maxAutoRecoveredTasks = Math.max(
    1,
    Math.floor(numberInRange(source.maxAutoRecoveredTasks, fallback.maxAutoRecoveredTasks || 200, 1))
  );
  source.recordObservabilityEvents =
    source.recordObservabilityEvents == null
      ? fallback.recordObservabilityEvents !== false
      : source.recordObservabilityEvents !== false;
  source.allowAutoResumePendingTasks = source.allowAutoResumePendingTasks === true;
  return source;
}

function validateRuntimeConfig(config = {}, defaults = DEFAULT_CONFIG, options = {}) {
  const warnings = [];
  const source = isObject(config) ? clone(config) : {};
  const fallback = isObject(defaults) ? defaults : DEFAULT_CONFIG;

  source.promptSettings = normalizePromptSettings(
    source.promptSettings,
    fallback.promptSettings || DEFAULT_PROMPT_SETTINGS
  );
  source.modelPools = dedupeModelPoolsByTier(source.modelPools, fallback.modelPools || DEFAULT_MODEL_POOLS);
  if (hasNegativeNumber(source.budget))
    warnings.push("budget policy contained negative values; defaults were used for those fields.");
  source.budget = normalizeBudgetPolicy(source.budget, fallback.budget || DEFAULT_CONFIG.budget);
  source.riskPolicy = validateRiskPolicy(source.riskPolicy, fallback.riskPolicy, warnings);
  source.verificationPolicy = validateVerificationPolicy(
    source.verificationPolicy,
    fallback.verificationPolicy,
    warnings
  );
  source.humanApprovalPolicy = validateHumanApprovalPolicy(
    source.humanApprovalPolicy,
    fallback.humanApprovalPolicy,
    warnings
  );
  source.unattendedPolicy = validateUnattendedPolicy(source.unattendedPolicy, fallback.unattendedPolicy, warnings);
  source.recoveryPolicy = validateRecoveryPolicy(source.recoveryPolicy, fallback.recoveryPolicy, warnings);
  source.tools = {
    ...(isObject(fallback.tools) ? fallback.tools : {}),
    ...(isObject(source.tools) ? source.tools : {})
  };
  source.tools.browser = validateBrowserToolPolicy(
    source.tools.browser,
    fallback.tools && fallback.tools.browser,
    warnings
  );
  source.maxTasks = Math.max(1, Math.floor(numberInRange(source.maxTasks, fallback.maxTasks || 3, 1)));
  source.maxGoalIterations = Math.max(
    1,
    Math.floor(numberInRange(source.maxGoalIterations, fallback.maxGoalIterations || 4, 1))
  );
  source.callTimeoutMs = numberInRange(source.callTimeoutMs, fallback.callTimeoutMs || 120000, 1);
  source.commanderTimeoutMs = numberInRange(source.commanderTimeoutMs, fallback.commanderTimeoutMs || 120000, 1);
  source.modelMaxAttempts = Math.max(
    1,
    Math.floor(numberInRange(source.modelMaxAttempts, fallback.modelMaxAttempts || 3, 1, 10))
  );
  source.toolMaxAttempts = Math.max(
    1,
    Math.floor(numberInRange(source.toolMaxAttempts, fallback.toolMaxAttempts || 3, 1, 10))
  );
  source.toolRetryDelayMs = Math.floor(
    numberInRange(source.toolRetryDelayMs, fallback.toolRetryDelayMs || 500, 0, 10000)
  );
  source.planMaxTokens = Math.floor(numberInRange(source.planMaxTokens, fallback.planMaxTokens || 1600, 512, 5000));
  source.reviewMaxTokens = Math.floor(
    numberInRange(source.reviewMaxTokens, fallback.reviewMaxTokens || 2600, 512, 5000)
  );
  source.freeCallTimeoutMs = numberInRange(source.freeCallTimeoutMs, fallback.freeCallTimeoutMs || 30000, 1);
  source.codexCliTimeoutMs = numberInRange(source.codexCliTimeoutMs, fallback.codexCliTimeoutMs || 180000, 1);
  source.verifierTimeoutMs = numberInRange(source.verifierTimeoutMs, fallback.verifierTimeoutMs || 45000, 1);
  source.discoveryTimeoutMs = numberInRange(source.discoveryTimeoutMs, fallback.discoveryTimeoutMs || 2500, 1);
  source.maxFreeCandidates = Math.max(
    1,
    Math.floor(numberInRange(source.maxFreeCandidates, fallback.maxFreeCandidates || 40, 1))
  );
  source.runtimePaths = {
    ...(fallback.runtimePaths || {}),
    ...(isObject(source.runtimePaths) ? source.runtimePaths : {})
  };
  source.featureFlags = isObject(source.featureFlags) ? source.featureFlags : {};

  if (options.strict && warnings.length) {
    const error = new Error(`Invalid AgentRoute config: ${warnings.join(" ")}`);
    error.warnings = warnings;
    throw error;
  }
  return { config: source, warnings };
}

module.exports = {
  RISK_LEVELS,
  validateHumanApprovalPolicy,
  validateRiskPolicy,
  validateRuntimeConfig,
  validateBrowserToolPolicy,
  validateRecoveryPolicy,
  validateUnattendedPolicy,
  validateVerificationPolicy
};
