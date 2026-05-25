"use strict";

const { normalizeAction } = require("../corrective/corrective-actions");
const actionLearning = require("../action-learning");

const VALID_RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);

function list(value) {
  if (Array.isArray(value)) return value.filter((item) => item != null && item !== "");
  if (value == null || value === "") return [];
  return [value];
}

function text(value) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function clamp(value, min = 0, max = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function normalizeRiskLevel(value, fallback = "low") {
  const level = lower(value || fallback);
  return VALID_RISK_LEVELS.has(level) ? level : fallback;
}

function normalizeActions(input = {}) {
  const raw =
    input.recommendedActions ||
    input.recommended_actions ||
    input.actions ||
    (input.task && (input.task.recommendedActions || input.task.recommended_actions)) ||
    [];
  return list(raw).map(normalizeAction).slice(0, 12);
}

function normalizeBudget(input = {}) {
  const task = input.task || {};
  const raw = input.budget || input.budgetEvaluation || input.budget_evaluation || {};
  const status =
    lower(raw.status || raw.budgetStatus || raw.budget_status || task.budgetStatus || task.budget_status || "ok") ||
    "ok";
  const degradationLevel =
    lower(raw.degradationLevel || raw.degradation_level || task.degradationLevel || task.degradation_level || "none") ||
    "none";
  const remainingBudget =
    raw.remainingBudget || raw.remaining_budget || task.remainingBudget || task.remaining_budget || {};
  const warnings = list(
    raw.warnings || raw.budgetWarnings || raw.budget_warnings || task.budgetWarnings || task.budget_warnings
  )
    .map(text)
    .filter(Boolean);
  return {
    status,
    degradationLevel,
    remainingBudget,
    warnings,
    blockedReason: text(
      raw.blockedReason || raw.blocked_reason || task.budgetBlockedReason || task.budget_blocked_reason || ""
    ),
    usage: raw.usage || raw.budgetUsage || raw.budget_usage || task.budgetUsage || task.budget_usage || {},
    unlimited: Boolean(raw.unlimited || raw.mode === "unlimited" || (task.budget && task.budget.unlimited))
  };
}

function budgetPressure(budget = {}) {
  if (budget.unlimited) return 0;
  if (budget.status === "blocked" || budget.status === "exhausted") return 1;
  if (budget.degradationLevel === "emergency") return 0.95;
  if (budget.degradationLevel === "strict") return 0.82;
  if (budget.status === "degraded") return 0.7;
  if (budget.status === "warning" || budget.degradationLevel === "light") return 0.52;
  if (budget.warnings && budget.warnings.length) return 0.45;
  return 0.15;
}

function normalizeHistory(input = {}) {
  const task = input.task || {};
  const history = input.history || {};
  const learnedActionStats = actionLearning.getActionStats({
    goalId: input.goalId || input.goal_id || task.goalId || task.goal_id || "",
    taskType: input.taskType || input.task_type || task.type || task.taskType || "",
    goalType: input.goalType || input.goal_type || task.goalType || task.goal_type || ""
  });
  const providedActionStats =
    history.actionStats || history.action_stats || task.actionStats || task.action_stats || {};
  const actionStats = {
    ...learnedActionStats,
    ...providedActionStats
  };
  const recoverySummaryCount = task.recoverySummary
    ? Number(task.recoverySummary.recoveredTasks || task.recoverySummary.interruptedTasks || 0)
    : 0;
  const taskBudgetRetries = task.budgetUsage && task.budgetUsage.retries != null ? Number(task.budgetUsage.retries) : 0;
  const recoveryCount = Number(
    history.recoveryCount ??
      history.recovery_count ??
      task.recoveryCount ??
      task.recovery_count ??
      recoverySummaryCount ??
      0
  );
  const retryCount = Number(
    history.retryCount ?? history.retry_count ?? task.attempts ?? task.retries ?? taskBudgetRetries ?? 0
  );
  return {
    actionStats,
    recoveryCount: Number.isFinite(recoveryCount) ? Math.max(0, recoveryCount) : 0,
    retryCount: Number.isFinite(retryCount) ? Math.max(0, retryCount) : 0,
    correctiveHistory: list(
      history.correctiveHistory || history.corrective_history || task.correctiveHistory || task.corrective_history
    ),
    actionDecisionHistory: list(
      history.actionDecisionHistory ||
        history.action_decision_history ||
        task.actionDecisionHistory ||
        task.action_decision_history
    )
  };
}

function historicalSuccessRate(actionType, history = {}) {
  const stats = history.actionStats && history.actionStats[actionType];
  if (
    stats &&
    Number(stats.systemRuns || stats.system_runs || 0) > 0 &&
    Number.isFinite(Number(stats.systemSuccessRate ?? stats.system_success_rate))
  ) {
    return clamp(stats.systemSuccessRate ?? stats.system_success_rate);
  }
  if (stats && Number.isFinite(Number(stats.successRate ?? stats.success_rate))) {
    return clamp(stats.successRate ?? stats.success_rate);
  }
  if (
    stats &&
    Number.isFinite(Number(stats.success)) &&
    Number.isFinite(Number(stats.total)) &&
    Number(stats.total) > 0
  ) {
    return clamp(Number(stats.success) / Number(stats.total));
  }
  return 0.5;
}

function normalizeDecisionInput(input = {}) {
  const task = input.task || {};
  const verification = input.verification || {};
  const risk = input.risk || input.riskEvaluation || input.risk_evaluation || {};
  const authenticity = input.authenticity || {};
  const authenticityScore = clamp(
    input.authenticityScore ??
      authenticity.score ??
      authenticity.authenticityScore ??
      verification.authenticityScore ??
      verification.authenticity_score ??
      task.authenticityScore ??
      task.authenticity_score ??
      0
  );
  const budget = normalizeBudget(input);
  const history = normalizeHistory(input);
  const riskLevel = normalizeRiskLevel(
    risk.riskLevel || risk.risk_level || input.riskLevel || task.riskLevel || task.risk_level || "low"
  );
  return {
    task,
    verification,
    actions: normalizeActions(input),
    budget,
    history,
    risk,
    riskLevel,
    requiresHumanApproval: Boolean(
      risk.requiresHumanApproval ||
      risk.requires_human_approval ||
      task.requiresHumanApproval ||
      task.requiresHumanConfirmation
    ),
    authenticityScore,
    authenticityWarnings: list(
      authenticity.warnings ||
        authenticity.authenticityWarnings ||
        verification.authenticityWarnings ||
        verification.authenticity_warnings ||
        task.authenticityWarnings ||
        task.authenticity_warnings
    )
      .map(text)
      .filter(Boolean),
    budgetPressure: budgetPressure(budget),
    taskId: text(input.taskId || input.task_id || task.id || "")
  };
}

module.exports = {
  clamp,
  historicalSuccessRate,
  list,
  lower,
  normalizeDecisionInput,
  normalizeRiskLevel,
  text
};
