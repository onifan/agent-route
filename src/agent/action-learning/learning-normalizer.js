"use strict";

const { CORRECTIVE_ACTION, normalizeAction } = require("../corrective/corrective-actions");

const VALID_RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);
const VALID_DECISION_SOURCES = new Set([
  "system_recommendation",
  "user_override",
  "manual_action",
  "human_review",
  "recovery"
]);

function nowIso() {
  return new Date().toISOString();
}

function text(value) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function number(value, fallback = 0) {
  const out = Number(value);
  return Number.isFinite(out) && out >= 0 ? out : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, number(value, min)));
}

function normalizeRiskLevel(value) {
  const risk = lower(value || "low");
  return VALID_RISK_LEVELS.has(risk) ? risk : "low";
}

function normalizeDecisionSource(value) {
  const source = lower(value || "system_recommendation");
  return VALID_DECISION_SOURCES.has(source) ? source : "system_recommendation";
}

function actionType(value) {
  if (!value) return "";
  if (typeof value === "string") return lower(value);
  if (typeof value === "object")
    return lower(value.type || value.action || value.actionType || value.action_type || "");
  return "";
}

function inferActionSuccess(actionType, status = "") {
  const state = lower(status);
  if (state === "completed") return true;
  if (actionType === CORRECTIVE_ACTION.MARK_AS_BLOCKED && state === "blocked") return true;
  if (
    actionType === CORRECTIVE_ACTION.REQUEST_HUMAN_REVIEW &&
    (state === "waiting_human" || state === "awaiting_confirmation")
  )
    return true;
  if (
    actionType === CORRECTIVE_ACTION.REQUEST_MORE_DATA &&
    (state === "waiting_human" || state === "awaiting_confirmation")
  )
    return true;
  if (
    [
      CORRECTIVE_ACTION.RETRY_TASK,
      CORRECTIVE_ACTION.RETRY_WITH_DIFFERENT_MODEL,
      CORRECTIVE_ACTION.RERUN_BROWSER
    ].includes(actionType) &&
    state === "retry_ready"
  )
    return true;
  return false;
}

function usageCost(usage = {}) {
  return number(
    usage.actualCostUsd ?? usage.actual_cost_usd ?? usage.estimatedCostUsd ?? usage.estimated_cost_usd ?? 0
  );
}

function usageDuration(usage = {}) {
  return number(usage.runtimeMs ?? usage.runtime_ms ?? 0);
}

function normalizeLearningRecord(input = {}) {
  const task = input.task || {};
  const attribution = input.attribution && typeof input.attribution === "object" ? input.attribution : {};
  const action = normalizeAction(
    input.action || {
        type:
          input.actualAction ||
          input.actual_action ||
          input.actionType ||
          input.action_type ||
          input.recommendedAction ||
          input.recommended_action ||
          (task.recommendedAction && task.recommendedAction.type) ||
          (task.recommended_action && task.recommended_action.type)
      } ||
      task.recommendedAction || {
        type: input.actionType || input.action_type
      }
  );
  const recommendedAction =
    actionType(
      input.recommendedAction ||
        input.recommended_action ||
        attribution.recommendedAction ||
        attribution.recommended_action ||
        task.recommendedAction ||
        task.recommended_action
    ) || action.type;
  const actualAction =
    actionType(
      input.actualAction || input.actual_action || attribution.actualAction || attribution.actual_action || action
    ) || action.type;
  const decisionSource = normalizeDecisionSource(
    input.decisionSource || input.decision_source || attribution.decisionSource || attribution.decision_source
  );
  const wasOverridden =
    input.wasOverridden == null &&
    input.was_overridden == null &&
    attribution.wasOverridden == null &&
    attribution.was_overridden == null
      ? Boolean(
          (recommendedAction && actualAction && recommendedAction !== actualAction) ||
          decisionSource === "user_override"
        )
      : Boolean(input.wasOverridden ?? input.was_overridden ?? attribution.wasOverridden ?? attribution.was_overridden);
  const attributionScore = clamp(
    input.attributionScore ??
      input.attribution_score ??
      attribution.attributionScore ??
      attribution.attribution_score ??
      (wasOverridden ? 0 : 1)
  );
  const budgetUsage = input.budgetUsage || input.budget_usage || task.budgetUsage || task.budget_usage || {};
  const status = lower(input.status || input.taskStatus || input.task_status || task.status || "");
  const success =
    input.success == null ? inferActionSuccess(actualAction || action.type, status) : Boolean(input.success);
  const cost = number(input.cost ?? input.estimatedCost ?? usageCost(budgetUsage), 0);
  const duration = number(input.duration ?? input.durationMs ?? input.duration_ms ?? usageDuration(budgetUsage), 0);
  return {
    actionType: actualAction || action.type,
    taskType: lower(input.taskType || input.task_type || task.type || task.taskType || "general") || "general",
    goalType:
      lower(
        input.goalType ||
          input.goal_type ||
          task.goalType ||
          task.goal_type ||
          input.goalId ||
          input.goal_id ||
          "general"
      ) || "general",
    success,
    cost,
    duration,
    durationMs: duration,
    retryCount: number(
      input.retryCount ?? input.retry_count ?? task.attempts ?? task.retries ?? budgetUsage.retries ?? 0,
      0
    ),
    riskLevel: normalizeRiskLevel(input.riskLevel || input.risk_level || task.riskLevel || task.risk_level || "low"),
    authenticityScore: clamp(
      input.authenticityScore ?? input.authenticity_score ?? task.authenticityScore ?? task.authenticity_score ?? 0
    ),
    recommendedAction,
    actualAction,
    decisionSource,
    wasOverridden,
    attributionScore,
    taskId: text(input.taskId || input.task_id || task.id || ""),
    goalId: text(input.goalId || input.goal_id || task.goalId || task.goal_id || ""),
    status,
    reason: text(input.reason || input.decisionReason || input.decision_reason || action.reason || ""),
    timestamp: input.timestamp || input.at || nowIso(),
    metadata: input.metadata && typeof input.metadata === "object" ? { ...input.metadata } : {}
  };
}

module.exports = {
  clamp,
  inferActionSuccess,
  normalizeDecisionSource,
  normalizeLearningRecord,
  number,
  text
};
