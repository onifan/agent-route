"use strict";

const { DEFAULT_BUDGET_POLICY } = require("../../config/loader");

const BUDGET_STATUS = Object.freeze({
  OK: "ok",
  WARNING: "warning",
  DEGRADED: "degraded",
  EXHAUSTED: "exhausted",
  BLOCKED: "blocked"
});

const DEGRADATION_LEVEL = Object.freeze({
  NONE: "none",
  LIGHT: "light",
  STRICT: "strict",
  EMERGENCY: "emergency"
});

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function booleanOr(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value == null || value === "") return fallback;
  const raw = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on", "unlimited", "disabled"].includes(raw)) return true;
  if (["false", "0", "no", "off", "limited", "enabled"].includes(raw)) return false;
  return fallback;
}

function mergeSection(defaults, input) {
  const source = isObject(input) ? input : {};
  const out = { ...defaults };
  for (const key of Object.keys(out)) {
    if (source[key] != null) out[key] = numberOr(source[key], out[key]);
    const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    if (source[snake] != null) out[key] = numberOr(source[snake], out[key]);
  }
  return out;
}

function normalizeBudgetPolicy(raw = {}) {
  const source = isObject(raw) ? raw : {};
  const unlimited = Boolean(
    booleanOr(source.unlimited, false) ||
    String(source.mode || "").toLowerCase() === "unlimited" ||
    String(source.budgetMode || source.budget_mode || "").toLowerCase() === "unlimited" ||
    booleanOr(source.disabled, false) ||
    source.enabled === false
  );
  return {
    unlimited,
    mode: unlimited ? "unlimited" : "limited",
    goal: mergeSection(DEFAULT_BUDGET_POLICY.goal, source.goal || source.goalBudget || source.goal_budget),
    task: mergeSection(DEFAULT_BUDGET_POLICY.task, source.task || source.taskBudget || source.task_budget),
    worker: mergeSection(DEFAULT_BUDGET_POLICY.worker, source.worker || source.workerBudget || source.worker_budget),
    browser: mergeSection(
      DEFAULT_BUDGET_POLICY.browser,
      source.browser || source.browserBudget || source.browser_budget
    ),
    verification: mergeSection(
      DEFAULT_BUDGET_POLICY.verification,
      source.verification || source.verificationBudget || source.verification_budget
    ),
    thresholds: mergeSection(DEFAULT_BUDGET_POLICY.thresholds, source.thresholds)
  };
}

function isUnlimitedPolicy(policy = {}) {
  return Boolean(
    policy &&
    (policy.unlimited ||
      policy.disabled ||
      policy.enabled === false ||
      String(policy.mode || policy.budgetMode || policy.budget_mode || "").toLowerCase() === "unlimited")
  );
}

function emptyUsage() {
  return {
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    estimatedCostUsd: 0,
    actualCostUsd: 0,
    runtimeMs: 0,
    steps: 0,
    retries: 0,
    browserActions: 0,
    browserReloads: 0,
    browserNavigations: 0,
    browserTabs: 0,
    browserSubmitAttempts: 0,
    screenshots: 0,
    shellActions: 0,
    verificationRetries: 0,
    verifierModelCalls: 0,
    modelCalls: {},
    taskCosts: {}
  };
}

function normalizeUsage(raw = {}) {
  const usage = emptyUsage();
  const source = isObject(raw) ? raw : {};
  const tokens = source.tokenUsage || source.token_usage || {};
  usage.tokenUsage.prompt = numberOr(tokens.prompt || tokens.promptTokens || tokens.prompt_tokens, 0);
  usage.tokenUsage.completion = numberOr(tokens.completion || tokens.completionTokens || tokens.completion_tokens, 0);
  usage.tokenUsage.total = numberOr(
    tokens.total || tokens.totalTokens || tokens.total_tokens,
    usage.tokenUsage.prompt + usage.tokenUsage.completion
  );
  usage.estimatedCostUsd = numberOr(source.estimatedCostUsd || source.estimated_cost_usd, 0);
  usage.actualCostUsd = numberOr(source.actualCostUsd || source.actual_cost_usd, 0);
  usage.runtimeMs = numberOr(source.runtimeMs || source.runtime_ms, 0);
  usage.steps = numberOr(source.steps, 0);
  usage.retries = numberOr(source.retries, 0);
  usage.browserActions = numberOr(source.browserActions || source.browser_actions, 0);
  usage.browserReloads = numberOr(source.browserReloads || source.browser_reloads, 0);
  usage.browserNavigations = numberOr(source.browserNavigations || source.browser_navigations, 0);
  usage.browserTabs = numberOr(source.browserTabs || source.browser_tabs, 0);
  usage.browserSubmitAttempts = numberOr(source.browserSubmitAttempts || source.browser_submit_attempts, 0);
  usage.screenshots = numberOr(source.screenshots, 0);
  usage.shellActions = numberOr(source.shellActions || source.shell_actions, 0);
  usage.verificationRetries = numberOr(source.verificationRetries || source.verification_retries, 0);
  usage.verifierModelCalls = numberOr(source.verifierModelCalls || source.verifier_model_calls, 0);
  usage.modelCalls = isObject(source.modelCalls || source.model_calls)
    ? clone(source.modelCalls || source.model_calls)
    : {};
  usage.taskCosts = isObject(source.taskCosts || source.task_costs) ? clone(source.taskCosts || source.task_costs) : {};
  return usage;
}

function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || "");
  return Math.max(0, Math.ceil(String(text || "").length / 4));
}

function estimateMessagesTokens(messages = []) {
  return estimateTokens(
    (messages || [])
      .map(
        (message) =>
          `${message.role || "user"}:${typeof message.content === "string" ? message.content : JSON.stringify(message.content || "")}`
      )
      .join("\n")
  );
}

function modelTier(model = "") {
  const id = String(model || "").toLowerCase();
  if (!id || id === "codex-cli" || id.includes(":free") || id.startsWith("gc/")) return "free";
  if (
    id === "gpt5.5" ||
    id.includes("gpt-5.5") ||
    id.includes("claude") ||
    id.includes("sonnet") ||
    id.includes("gemini-3.1-pro")
  )
    return "expensive";
  if (
    id.includes("gpt-5.4") ||
    id.includes("gemini-2.5-pro") ||
    id.includes("deepseek-r1") ||
    id.includes("qwen3-235b")
  )
    return "strong";
  if (id.includes("coder") || id.includes("coding")) return "coding";
  return "standard";
}

function estimatedCostPer1k(model = "") {
  const tier = modelTier(model);
  if (tier === "free") return 0;
  if (tier === "coding") return 0.0015;
  if (tier === "standard") return 0.003;
  if (tier === "strong") return 0.008;
  if (tier === "expensive") return 0.02;
  return 0.004;
}

function estimateModelCost(model, tokens) {
  return Number(((Math.max(0, Number(tokens || 0)) / 1000) * estimatedCostPer1k(model)).toFixed(6));
}

function estimateModelCallUsage({ model = "", messages = [], content = "", elapsedMs = 0, label = "" } = {}) {
  const prompt = estimateMessagesTokens(messages);
  const completion = estimateTokens(content);
  const total = prompt + completion;
  return {
    tokenUsage: { prompt, completion, total },
    estimatedCostUsd: estimateModelCost(model, total),
    actualCostUsd: 0,
    runtimeMs: numberOr(elapsedMs, 0),
    steps: 1,
    model,
    label
  };
}

function actionText(action) {
  if (action == null) return "";
  if (typeof action === "string") return action;
  if (!isObject(action)) return String(action);
  return [
    action.type,
    action.kind,
    action.action,
    action.name,
    action.label,
    action.text,
    action.selector,
    action.url,
    action.command,
    action.path,
    action.target,
    action.description
  ]
    .filter(Boolean)
    .join(" ");
}

function countBrowserActions(actions = [], evidence = {}) {
  let browserActions = 0;
  let browserReloads = 0;
  let browserNavigations = 0;
  let browserSubmitAttempts = 0;
  let screenshots = 0;
  let browserTabs = 0;
  for (const action of actions || []) {
    const text = actionText(action).toLowerCase();
    if (
      /\b(browser|click|fill|type|input|submit|scroll|navigate|url|dom|page|reload|screenshot|tab|download|upload|login|publish|pay|delete)\b/.test(
        text
      )
    )
      browserActions += 1;
    if (/\breload|refresh\b/.test(text)) browserReloads += 1;
    if (/\bnavigate|go to|open url|url\b/.test(text)) browserNavigations += 1;
    if (/\bsubmit|send|apply|publish|pay|delete\b/.test(text)) browserSubmitAttempts += 1;
    if (/\bscreenshot|capture\b/.test(text)) screenshots += 1;
    if (/\bnew tab|tab\b/.test(text)) browserTabs += 1;
  }
  const browserEvidence = [
    ...(Array.isArray(evidence.browserEvidence) ? evidence.browserEvidence : []),
    ...(evidence.normalizedEvidence && Array.isArray(evidence.normalizedEvidence.browser)
      ? evidence.normalizedEvidence.browser
      : []),
    ...(evidence.browser ? [evidence.browser] : [])
  ].filter(Boolean);
  const seenBrowserEvidence = new Set();
  for (const entry of browserEvidence) {
    const metadata = isObject(entry.metadata) ? entry.metadata : {};
    const readOnlyWebToolEvidence =
      String(entry.evidenceSource || entry.evidence_source || "").toLowerCase() === "web-tool" ||
      String(metadata.tool || "").toLowerCase() === "web";
    if (readOnlyWebToolEvidence) continue;
    const evidenceKey = [
      entry.evidenceSource || "",
      entry.detectedActionType || entry.action || "",
      entry.url || entry.currentUrl || entry.nextUrl || "",
      entry.textPreview || entry.pageText || "",
      entry.screenshotPath || entry.snapshotPath || ""
    ].join("|");
    if (seenBrowserEvidence.has(evidenceKey)) continue;
    seenBrowserEvidence.add(evidenceKey);
    const usage = isObject(entry.resourceUsage || entry.resource_usage)
      ? entry.resourceUsage || entry.resource_usage
      : {};
    const detected = String(entry.detectedActionType || entry.detected_action_type || entry.action || "").toLowerCase();
    browserActions += Math.max(
      0,
      numberOr(
        usage.actionCount || usage.action_count,
        detected || entry.url || entry.currentUrl || entry.textPreview ? 1 : 0
      )
    );
    browserNavigations += numberOr(
      usage.navigationCount || usage.navigation_count,
      entry.urlChanged || entry.navigated ? 1 : 0
    );
    screenshots += numberOr(
      usage.screenshotCount || usage.screenshot_count,
      entry.screenshotPath || entry.screenshot_path ? 1 : 0
    );
    if (/submit|delete|payment|pay|publish|login|upload|send|apply/.test(detected)) browserSubmitAttempts += 1;
    if (/navigate|read_page|open_page/.test(detected)) browserNavigations += 1;
  }
  const browser = evidence.browser || {};
  if (browser.beforeUrl || browser.afterUrl || browser.currentUrl) browserActions = Math.max(browserActions, 1);
  if (browser.navigated || (browser.beforeUrl && browser.afterUrl && browser.beforeUrl !== browser.afterUrl))
    browserNavigations += 1;
  if (browser.screenshotPath) screenshots += 1;
  return { browserActions, browserReloads, browserNavigations, browserSubmitAttempts, screenshots, browserTabs };
}

function countShellActions(actions = [], evidence = {}) {
  let shellActions = evidence.shell && evidence.shell.command ? 1 : 0;
  for (const action of actions || []) {
    if (/\b(shell|terminal|command|exec|npm|pnpm|yarn|bun|bash|zsh)\b/i.test(actionText(action))) shellActions += 1;
  }
  return shellActions;
}

function usageFromWorkerResult(workerResult = {}, context = {}) {
  const evidence = workerResult.evidence || {};
  const actions = Array.isArray(workerResult.actions) ? workerResult.actions : [];
  const browser = countBrowserActions(actions, evidence);
  const shellActions = countShellActions(actions, evidence);
  const promptTokens = numberOr(context.promptTokens || context.prompt_tokens, 0);
  const completionTokens = numberOr(
    workerResult.context && (workerResult.context.completionTokens || workerResult.context.completion_tokens),
    estimateTokens(workerResult.output || workerResult.result || workerResult.content || "")
  );
  const totalTokens = promptTokens + completionTokens;
  return {
    tokenUsage: { prompt: promptTokens, completion: completionTokens, total: totalTokens },
    estimatedCostUsd: estimateModelCost(
      context.model || (workerResult.context && workerResult.context.model) || "",
      totalTokens
    ),
    actualCostUsd: numberOr(context.actualCostUsd || context.actual_cost_usd, 0),
    runtimeMs: numberOr(
      context.elapsedMs || context.elapsed_ms || (workerResult.context && workerResult.context.elapsedMs),
      0
    ),
    steps: 1,
    retries: 0,
    ...browser,
    shellActions,
    verificationRetries: 0,
    verifierModelCalls: 0,
    model: context.model || (workerResult.context && workerResult.context.model) || "",
    taskId: context.taskId || context.task_id || ""
  };
}

function addUsage(left = {}, right = {}) {
  const out = normalizeUsage(left);
  const delta = normalizeUsage(right);
  out.tokenUsage.prompt += delta.tokenUsage.prompt;
  out.tokenUsage.completion += delta.tokenUsage.completion;
  out.tokenUsage.total += delta.tokenUsage.total;
  for (const key of [
    "estimatedCostUsd",
    "actualCostUsd",
    "runtimeMs",
    "steps",
    "retries",
    "browserActions",
    "browserReloads",
    "browserNavigations",
    "browserTabs",
    "browserSubmitAttempts",
    "screenshots",
    "shellActions",
    "verificationRetries",
    "verifierModelCalls"
  ]) {
    out[key] += delta[key] || 0;
  }
  if (right.model) out.modelCalls[right.model] = (out.modelCalls[right.model] || 0) + 1;
  if (right.taskId)
    out.taskCosts[right.taskId] = Number(
      ((out.taskCosts[right.taskId] || 0) + (right.estimatedCostUsd || 0) + (right.actualCostUsd || 0)).toFixed(6)
    );
  out.estimatedCostUsd = Number(out.estimatedCostUsd.toFixed(6));
  out.actualCostUsd = Number(out.actualCostUsd.toFixed(6));
  return out;
}

function ratio(used, limit) {
  if (!Number.isFinite(Number(limit)) || Number(limit) <= 0) return 0;
  return Number(used || 0) / Number(limit);
}

function highestRatio(usage = {}, policy = {}) {
  const checks = [
    ratio(usage.tokenUsage && usage.tokenUsage.total, policy.maxTokens),
    ratio((usage.estimatedCostUsd || 0) + (usage.actualCostUsd || 0), policy.maxCostUsd),
    ratio(usage.runtimeMs, policy.maxRuntimeMs),
    ratio(usage.steps, policy.maxSteps),
    ratio(usage.browserActions, policy.maxBrowserActions),
    ratio(usage.retries, policy.maxRetries)
  ];
  return Math.max(...checks.filter((value) => Number.isFinite(value)), 0);
}

function degradationLevelForUsage(usage = {}, policy = {}, thresholds = DEFAULT_BUDGET_POLICY.thresholds) {
  const used = highestRatio(usage, policy);
  if (used >= (thresholds.emergency || 0.97)) return DEGRADATION_LEVEL.EMERGENCY;
  if (used >= (thresholds.degraded || 0.85)) return DEGRADATION_LEVEL.STRICT;
  if (used >= (thresholds.warning || 0.7)) return DEGRADATION_LEVEL.LIGHT;
  return DEGRADATION_LEVEL.NONE;
}

function makeRemaining(usage = {}, policy = {}) {
  return {
    tokens: Math.max(0, numberOr(policy.maxTokens, 0) - numberOr(usage.tokenUsage && usage.tokenUsage.total, 0)),
    costUsd: Math.max(
      0,
      numberOr(policy.maxCostUsd, 0) - numberOr(usage.estimatedCostUsd, 0) - numberOr(usage.actualCostUsd, 0)
    ),
    runtimeMs: Math.max(0, numberOr(policy.maxRuntimeMs, 0) - numberOr(usage.runtimeMs, 0)),
    steps: Math.max(0, numberOr(policy.maxSteps, 0) - numberOr(usage.steps, 0)),
    browserActions: Math.max(0, numberOr(policy.maxBrowserActions, 0) - numberOr(usage.browserActions, 0)),
    retries: Math.max(0, numberOr(policy.maxRetries, 0) - numberOr(usage.retries, 0))
  };
}

function unlimitedRemaining() {
  return {
    tokens: "unlimited",
    costUsd: "unlimited",
    runtimeMs: "unlimited",
    steps: "unlimited",
    browserActions: "unlimited",
    retries: "unlimited",
    shellActions: "unlimited",
    verificationRetries: "unlimited"
  };
}

function unlimitedEvaluation(usage = {}, phase = "budget") {
  return {
    at: nowIso(),
    phase,
    status: BUDGET_STATUS.OK,
    usage: normalizeUsage(usage),
    remainingBudget: unlimitedRemaining(),
    degradationLevel: DEGRADATION_LEVEL.NONE,
    warnings: [],
    exceeded: [],
    suggestedAction: "allow",
    blockedReason: "",
    maxConcurrentWorkers: Number.MAX_SAFE_INTEGER,
    unlimited: true,
    mode: "unlimited"
  };
}

function pushExceeded(items, key, used, limit, label) {
  if (Number.isFinite(Number(limit)) && Number(limit) >= 0 && Number(used) > Number(limit)) {
    items.push({ key, used: Number(used), limit: Number(limit), label });
  }
}

function evaluateGoalBudget(goalState = {}, context = {}) {
  const normalized = normalizeBudgetPolicy(goalState.policy || context.policy || context.budget || {});
  const policy = normalized.goal;
  const thresholds = normalized.thresholds;
  const startedAt = Number(goalState.startedAt || context.startedAt || Date.now());
  const usage = normalizeUsage(goalState.usage || {});
  usage.runtimeMs = Math.max(usage.runtimeMs, Date.now() - startedAt);
  if (normalized.unlimited) return unlimitedEvaluation(usage, context.phase || "goal");
  const exceeded = [];
  pushExceeded(exceeded, "tokens", usage.tokenUsage.total, policy.maxTokens, "Goal token budget exceeded.");
  pushExceeded(
    exceeded,
    "cost",
    usage.estimatedCostUsd + usage.actualCostUsd,
    policy.maxCostUsd,
    "Goal cost budget exceeded."
  );
  pushExceeded(exceeded, "runtime", usage.runtimeMs, policy.maxRuntimeMs, "Goal runtime budget exceeded.");
  pushExceeded(exceeded, "steps", usage.steps, policy.maxSteps, "Goal step budget exceeded.");
  pushExceeded(
    exceeded,
    "browser_actions",
    usage.browserActions,
    policy.maxBrowserActions,
    "Goal browser action budget exceeded."
  );
  pushExceeded(exceeded, "retries", usage.retries, policy.maxRetries, "Goal retry budget exceeded.");
  const degradationLevel = degradationLevelForUsage(usage, policy, thresholds);
  const warnings = [];
  if (degradationLevel !== DEGRADATION_LEVEL.NONE)
    warnings.push(`Goal budget is ${degradationLevel}; use cheaper models and shorter context.`);
  for (const item of exceeded) warnings.push(item.label);
  return {
    at: nowIso(),
    phase: context.phase || "goal",
    status: exceeded.length
      ? BUDGET_STATUS.EXHAUSTED
      : degradationLevel === DEGRADATION_LEVEL.NONE
        ? BUDGET_STATUS.OK
        : BUDGET_STATUS.DEGRADED,
    usage,
    remainingBudget: makeRemaining(usage, policy),
    degradationLevel,
    warnings,
    exceeded,
    suggestedAction: exceeded.length ? "pause" : degradationLevel === DEGRADATION_LEVEL.NONE ? "allow" : "degrade",
    blockedReason: exceeded.length ? exceeded[0].label : "",
    maxConcurrentWorkers: Math.max(1, Math.floor(policy.maxConcurrentWorkers || 1))
  };
}

function taskPolicyFor(task = {}, policy = {}) {
  const normalized = normalizeBudgetPolicy(policy);
  if (normalized.unlimited || isUnlimitedPolicy(task.budget || task.taskBudget || task.task_budget)) {
    return {
      unlimited: true,
      task: mergeSection(normalized.task, {}),
      browser: mergeSection(normalized.browser, {}),
      verification: mergeSection(normalized.verification, {})
    };
  }
  const taskBudget = isObject(task.budget || task.taskBudget || task.task_budget)
    ? task.budget || task.taskBudget || task.task_budget
    : {};
  const taskSection = isObject(taskBudget.task || taskBudget.taskBudget || taskBudget.task_budget)
    ? taskBudget.task || taskBudget.taskBudget || taskBudget.task_budget
    : taskBudget;
  const browserSection =
    task.browserBudget ||
    task.browser_budget ||
    taskBudget.browser ||
    taskBudget.browserBudget ||
    taskBudget.browser_budget;
  const verificationSection =
    task.verificationBudget ||
    task.verification_budget ||
    taskBudget.verification ||
    taskBudget.verificationBudget ||
    taskBudget.verification_budget;
  return {
    task: mergeSection(normalized.task, taskSection),
    browser: mergeSection(normalized.browser, browserSection),
    verification: mergeSection(normalized.verification, verificationSection)
  };
}

function evaluateTaskBudget(task = {}, context = {}) {
  const policy = taskPolicyFor(task, context.policy || context.budgetPolicy || context.budget || {});
  const usage = normalizeUsage(task.budgetUsage || task.budget_usage || {});
  const phase = context.phase || "task";
  if (policy.unlimited) {
    const startedAt = task.startedAt ? Date.parse(task.startedAt) : 0;
    if (startedAt && !Number.isNaN(startedAt)) usage.runtimeMs = Math.max(usage.runtimeMs, Date.now() - startedAt);
    return {
      ...unlimitedEvaluation(usage, phase),
      riskLevel: "low",
      riskReasons: [],
      budgetSignals: []
    };
  }
  const rawNextAttempt = context.nextAttempt ?? context.next_attempt;
  const hasNextAttempt = rawNextAttempt != null;
  const nextAttempt = hasNextAttempt
    ? numberOr(rawNextAttempt, Number(task.attempts || 0) + 1)
    : Number(task.attempts || 0);
  const startedAt = task.startedAt ? Date.parse(task.startedAt) : 0;
  if (startedAt && !Number.isNaN(startedAt)) usage.runtimeMs = Math.max(usage.runtimeMs, Date.now() - startedAt);
  const exceeded = [];
  const retryLimit = Math.min(numberOr(task.maxAttempts, policy.task.maxRetries + 1), policy.task.maxRetries + 1);
  if (hasNextAttempt && nextAttempt > retryLimit) {
    exceeded.push({ key: "retry", used: nextAttempt - 1, limit: retryLimit - 1, label: "Task retry budget exceeded." });
  }
  pushExceeded(exceeded, "tokens", usage.tokenUsage.total, policy.task.maxTokens, "Task token budget exceeded.");
  pushExceeded(exceeded, "runtime", usage.runtimeMs, policy.task.maxRuntimeMs, "Task runtime budget exceeded.");
  pushExceeded(
    exceeded,
    "browser_actions",
    usage.browserActions,
    Math.min(policy.task.maxBrowserActions, policy.browser.maxActions),
    "Task browser action budget exceeded."
  );
  pushExceeded(
    exceeded,
    "shell_actions",
    usage.shellActions,
    policy.task.maxShellActions,
    "Task shell action budget exceeded."
  );
  pushExceeded(
    exceeded,
    "verification_retries",
    usage.verificationRetries,
    Math.min(policy.task.maxVerificationRetries, policy.verification.maxRetries),
    "Task verification retry budget exceeded."
  );
  pushExceeded(
    exceeded,
    "submit_attempts",
    usage.browserSubmitAttempts,
    policy.browser.maxSubmitAttempts,
    "Browser submit retry budget exceeded."
  );
  pushExceeded(exceeded, "reloads", usage.browserReloads, policy.browser.maxReloads, "Browser reload budget exceeded.");
  pushExceeded(
    exceeded,
    "navigations",
    usage.browserNavigations,
    policy.browser.maxNavigations,
    "Browser navigation depth budget exceeded."
  );
  pushExceeded(
    exceeded,
    "screenshots",
    usage.screenshots,
    policy.browser.maxScreenshots,
    "Browser screenshot budget exceeded."
  );
  const degradationLevel = degradationLevelForUsage(
    usage,
    {
      maxTokens: policy.task.maxTokens,
      maxCostUsd: 1,
      maxRuntimeMs: policy.task.maxRuntimeMs,
      maxSteps: Math.max(1, retryLimit),
      maxBrowserActions: Math.min(policy.task.maxBrowserActions, policy.browser.maxActions),
      maxRetries: Math.max(0, retryLimit - 1)
    },
    normalizeBudgetPolicy(context.policy || context.budgetPolicy || {}).thresholds
  );
  const warnings = [];
  if (degradationLevel !== DEGRADATION_LEVEL.NONE)
    warnings.push(`Task budget is ${degradationLevel}; avoid retries and optional work.`);
  for (const item of exceeded) warnings.push(item.label);
  return {
    at: nowIso(),
    phase,
    status: exceeded.length
      ? BUDGET_STATUS.BLOCKED
      : degradationLevel === DEGRADATION_LEVEL.NONE
        ? BUDGET_STATUS.OK
        : BUDGET_STATUS.DEGRADED,
    usage,
    remainingBudget: {
      tokens: Math.max(0, policy.task.maxTokens - usage.tokenUsage.total),
      runtimeMs: Math.max(0, policy.task.maxRuntimeMs - usage.runtimeMs),
      retries: Math.max(0, retryLimit - 1 - Number(task.attempts || 0)),
      browserActions: Math.max(
        0,
        Math.min(policy.task.maxBrowserActions, policy.browser.maxActions) - usage.browserActions
      ),
      shellActions: Math.max(0, policy.task.maxShellActions - usage.shellActions),
      verificationRetries: Math.max(
        0,
        Math.min(policy.task.maxVerificationRetries, policy.verification.maxRetries) - usage.verificationRetries
      )
    },
    degradationLevel,
    warnings,
    exceeded,
    suggestedAction: exceeded.length ? "block" : degradationLevel === DEGRADATION_LEVEL.NONE ? "allow" : "degrade",
    blockedReason: exceeded.length ? exceeded[0].label : "",
    riskLevel: exceeded.length ? "high" : degradationLevel === DEGRADATION_LEVEL.NONE ? "low" : "medium",
    riskReasons: warnings.slice(0, 6),
    budgetSignals: exceeded.map((item) => ({
      source: "budget_governor",
      riskLevel: "high",
      reason: item.label,
      details: item
    }))
  };
}

function compactEvaluation(evaluation = {}) {
  return {
    at: evaluation.at || nowIso(),
    phase: evaluation.phase || "budget",
    status: evaluation.status || BUDGET_STATUS.OK,
    usage: normalizeUsage(evaluation.usage || {}),
    remainingBudget: evaluation.remainingBudget || {},
    degradationLevel: evaluation.degradationLevel || DEGRADATION_LEVEL.NONE,
    warnings: Array.isArray(evaluation.warnings) ? evaluation.warnings.slice(0, 20) : [],
    exceeded: Array.isArray(evaluation.exceeded) ? evaluation.exceeded.slice(0, 20) : [],
    suggestedAction: evaluation.suggestedAction || "allow",
    blockedReason: evaluation.blockedReason || "",
    unlimited: Boolean(evaluation.unlimited),
    mode: evaluation.mode || (evaluation.unlimited ? "unlimited" : "limited")
  };
}

function riskEvaluationFromBudget(evaluation = {}) {
  const compact = compactEvaluation(evaluation);
  if (compact.status === BUDGET_STATUS.OK && compact.degradationLevel === DEGRADATION_LEVEL.NONE) return null;
  const riskLevel =
    compact.status === BUDGET_STATUS.BLOCKED || compact.status === BUDGET_STATUS.EXHAUSTED ? "high" : "medium";
  return {
    at: compact.at,
    phase: "budget",
    riskLevel,
    riskReasons: compact.warnings.length ? compact.warnings : ["Budget governor changed execution risk."],
    requiresHumanApproval: false,
    approvalReason: "",
    approvalStatus: "not_required",
    escalationReason: compact.warnings[0] || "",
    suggestedAction: compact.suggestedAction === "block" ? "block" : "proceed_with_caution",
    blockedReason: compact.blockedReason,
    riskSignals: compact.exceeded.map((item) => ({
      source: "budget_governor",
      riskLevel,
      reason: item.label || compact.blockedReason,
      details: item
    }))
  };
}

function createGoalBudgetState({ goalId = "", policy = {}, startedAt = Date.now() } = {}) {
  return {
    goalId,
    policy: normalizeBudgetPolicy(policy),
    startedAt,
    usage: emptyUsage(),
    history: [],
    degradationLevel: DEGRADATION_LEVEL.NONE,
    warnings: []
  };
}

function normalizeGoalBudgetState(raw = {}, fallback = {}) {
  const source = isObject(raw) ? raw : {};
  const state = createGoalBudgetState({
    goalId: source.goalId || source.goal_id || fallback.goalId || fallback.goal_id || "",
    policy: source.policy || source.budget || fallback.policy || fallback.budget || {},
    startedAt: numberOr(source.startedAt || source.started_at, fallback.startedAt || fallback.started_at || Date.now())
  });
  state.usage = normalizeUsage(source.usage || source.budgetUsage || source.budget_usage || {});
  state.history = Array.isArray(source.history)
    ? source.history
        .map((item) => ({
          ...compactEvaluation(item),
          context: clone((item && item.context) || {})
        }))
        .slice(-80)
    : [];
  state.degradationLevel = source.degradationLevel || source.degradation_level || DEGRADATION_LEVEL.NONE;
  state.warnings = Array.isArray(source.warnings) ? source.warnings.slice(0, 20) : [];
  return state;
}

function recordGoalUsage(state, delta = {}, context = {}) {
  if (!state) return null;
  state.usage = addUsage(state.usage, delta);
  const evaluation = evaluateGoalBudget(state, context);
  state.degradationLevel = evaluation.degradationLevel;
  state.warnings = evaluation.warnings;
  state.history.push({ ...compactEvaluation(evaluation), context: clone(context || {}) });
  state.history = state.history.slice(-80);
  return evaluation;
}

function routeModels(models = [], { budgetState = null, task = null } = {}) {
  const unique = [...new Set((models || []).filter(Boolean))];
  if (!budgetState) return unique;
  if (isUnlimitedPolicy(budgetState.policy)) return unique;
  const evaluation = evaluateGoalBudget(budgetState, { phase: "routing" });
  const level = evaluation.degradationLevel;
  if (level === DEGRADATION_LEVEL.NONE) return unique;
  const free = unique.filter((model) => modelTier(model) === "free");
  const cheap = unique.filter((model) => ["coding", "standard"].includes(modelTier(model)));
  const strong = unique.filter((model) => modelTier(model) === "strong");
  const expensive = unique.filter((model) => modelTier(model) === "expensive");
  const highValue =
    /critical|high/i.test(`${task && (task.riskLevel || task.difficulty || task.complexity || "")}`) ||
    /\b(plan|review|final|risk|verification|recovery)\b/i.test(`${task && (task.type || task.title || "")}`);
  if (level === DEGRADATION_LEVEL.LIGHT)
    return highValue ? [...strong, ...cheap, ...free, ...expensive] : [...free, ...cheap, ...strong, ...expensive];
  if (level === DEGRADATION_LEVEL.STRICT)
    return highValue ? [...cheap, ...free, ...strong.slice(0, 1)] : [...free, ...cheap];
  return free.length ? free : cheap.length ? cheap : unique.slice(-1);
}

function maxPromptTokensForState(policy = {}, budgetState = null) {
  const normalized = normalizeBudgetPolicy(policy);
  if (normalized.unlimited || isUnlimitedPolicy(budgetState && budgetState.policy)) return Number.MAX_SAFE_INTEGER;
  const level = budgetState
    ? evaluateGoalBudget(budgetState, { phase: "context" }).degradationLevel
    : DEGRADATION_LEVEL.NONE;
  const base = normalized.worker.maxPromptTokens;
  if (level === DEGRADATION_LEVEL.EMERGENCY) return Math.max(1200, Math.floor(base * 0.25));
  if (level === DEGRADATION_LEVEL.STRICT) return Math.max(2000, Math.floor(base * 0.45));
  if (level === DEGRADATION_LEVEL.LIGHT) return Math.max(4000, Math.floor(base * 0.7));
  return base;
}

function compactMessages(messages = [], { maxTokens = DEFAULT_BUDGET_POLICY.worker.maxPromptTokens } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  if (estimateMessagesTokens(list) <= maxTokens) return list;
  const budgetChars = Math.max(1000, Math.floor(maxTokens * 4));
  const system = list.filter((message) => message.role === "system" || message.role === "developer");
  const rest = list.filter((message) => message.role !== "system" && message.role !== "developer");
  const tail = rest.slice(-4);
  const compressed = tail.map((message) => {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content || "");
    return {
      ...message,
      content:
        content.length > budgetChars / Math.max(1, tail.length)
          ? `${content.slice(0, Math.floor(budgetChars / Math.max(1, tail.length)))}\n[context truncated by budget governor]`
          : content
    };
  });
  return [...system.slice(-2), ...compressed];
}

function shouldUseVerifierModel({ budgetState = null, policy = {}, verification = null } = {}) {
  const normalized = normalizeBudgetPolicy(policy);
  if (normalized.unlimited || isUnlimitedPolicy(budgetState && budgetState.policy)) {
    return !(verification && verification.suggestedNextState === "blocked");
  }
  if (
    budgetState &&
    Number((budgetState.usage && budgetState.usage.verifierModelCalls) || 0) >= normalized.verification.maxModelCalls
  )
    return false;
  if (budgetState) {
    const evaluation = evaluateGoalBudget(budgetState, { phase: "verification" });
    if (
      evaluation.degradationLevel === DEGRADATION_LEVEL.STRICT ||
      evaluation.degradationLevel === DEGRADATION_LEVEL.EMERGENCY
    )
      return false;
  }
  if (verification && verification.suggestedNextState === "blocked") return false;
  return true;
}

function memorySavingsFromText(memoryText = "") {
  const text = String(memoryText || "");
  if (!text.trim()) return { estimatedTokensSaved: 0, reasons: [] };
  const repeatedSignals = (
    text.match(/\b(avoid|reuse|repeat|retry|failed|verification|risk|browser|proposal|workflow)\b/gi) || []
  ).length;
  const estimatedTokensSaved = Math.min(6000, Math.max(400, estimateTokens(text) * 2 + repeatedSignals * 120));
  return {
    estimatedTokensSaved,
    reasons: repeatedSignals
      ? ["Relevant memory can avoid repeated analysis or retries."]
      : ["Relevant memory can reduce context needed for rediscovery."]
  };
}

module.exports = {
  BUDGET_STATUS,
  DEFAULT_BUDGET_POLICY,
  DEGRADATION_LEVEL,
  addUsage,
  compactEvaluation,
  compactMessages,
  createGoalBudgetState,
  emptyUsage,
  estimateMessagesTokens,
  estimateModelCallUsage,
  estimateModelCost,
  estimateTokens,
  evaluateGoalBudget,
  evaluateTaskBudget,
  isUnlimitedPolicy,
  maxPromptTokensForState,
  memorySavingsFromText,
  modelTier,
  normalizeGoalBudgetState,
  normalizeBudgetPolicy,
  normalizeUsage,
  recordGoalUsage,
  riskEvaluationFromBudget,
  routeModels,
  shouldUseVerifierModel,
  usageFromWorkerResult
};
