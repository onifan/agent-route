"use strict";

const { CORRECTIVE_ACTION, normalizeAction } = require("../corrective/corrective-actions");

const DECISION_SOURCE = Object.freeze({
  SYSTEM_RECOMMENDATION: "system_recommendation",
  USER_OVERRIDE: "user_override",
  MANUAL_ACTION: "manual_action",
  HUMAN_REVIEW: "human_review",
  RECOVERY: "recovery"
});

const VALID_SOURCES = new Set(Object.values(DECISION_SOURCE));

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

function clamp(value, min = 0, max = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function normalizeSource(value, fallback = DECISION_SOURCE.SYSTEM_RECOMMENDATION) {
  const source = lower(value || fallback);
  return VALID_SOURCES.has(source) ? source : fallback;
}

function actionType(value) {
  if (!value) return "";
  if (typeof value === "string") return lower(value);
  if (typeof value === "object") {
    const raw = value.type || value.action || value.actionType || value.action_type;
    if (raw) {
      const type = lower(raw);
      return Object.values(CORRECTIVE_ACTION).includes(type) ? type : type;
    }
    try {
      return normalizeAction(value).type;
    } catch {
      return "";
    }
  }
  return "";
}

function recommendedActionType(input = {}) {
  const task = input.task || {};
  return actionType(
    input.recommendedAction ||
      input.recommended_action ||
      task.recommendedAction ||
      task.recommended_action ||
      (Array.isArray(task.rankedActions) && task.rankedActions[0]) ||
      (Array.isArray(task.ranked_actions) && task.ranked_actions[0]) ||
      (Array.isArray(task.recommendedActions) && task.recommendedActions[0]) ||
      (Array.isArray(task.recommended_actions) && task.recommended_actions[0])
  );
}

function inferActualAction(input = {}) {
  const explicit = actionType(input.actualAction || input.actual_action || input.action);
  if (explicit) return explicit;
  const status = lower(
    input.status || input.taskStatus || input.task_status || input.to || (input.task && input.task.status) || ""
  );
  if (status === "completed") return CORRECTIVE_ACTION.CONTINUE;
  if (status === "retry_ready") return CORRECTIVE_ACTION.RETRY_TASK;
  if (status === "blocked") return CORRECTIVE_ACTION.MARK_AS_BLOCKED;
  if (status === "waiting_human" || status === "awaiting_confirmation") return CORRECTIVE_ACTION.REQUEST_HUMAN_REVIEW;
  if (status === "failed") return CORRECTIVE_ACTION.MARK_AS_BLOCKED;
  if (status === "canceled" || status === "cancelled") return "cancel_task";
  return recommendedActionType(input) || "";
}

function inferDecisionSource(input = {}, recommended = "", actual = "") {
  const explicit = input.decisionSource || input.decision_source || input.source;
  if (explicit && VALID_SOURCES.has(lower(explicit))) return normalizeSource(explicit);
  const haystack = lower(
    [
      input.reason,
      input.status,
      input.taskStatus,
      input.from,
      input.to,
      input.metadata && input.metadata.source,
      input.metadata && input.metadata.reason,
      input.context && input.context.source,
      input.context && input.context.reason,
      input.task && input.task.id,
      input.task && input.task.title
    ]
      .filter(Boolean)
      .join(" ")
  );
  if (/recovery|recover|worker_lost|browser_session_lost|process_restarted/.test(haystack))
    return DECISION_SOURCE.RECOVERY;
  if (/human|人工|approve|approved|reject|rejected|confirm|confirmed|manual_review/.test(haystack))
    return DECISION_SOURCE.HUMAN_REVIEW;
  if (/manual|user|用户/.test(haystack)) return DECISION_SOURCE.MANUAL_ACTION;
  if (recommended && actual && recommended !== actual) return DECISION_SOURCE.USER_OVERRIDE;
  return DECISION_SOURCE.SYSTEM_RECOMMENDATION;
}

function inferAttributionScore({ recommendedAction, actualAction, decisionSource, attributionScore } = {}) {
  if (attributionScore != null) return clamp(attributionScore);
  if (recommendedAction && actualAction && recommendedAction === actualAction) return 1;
  if (decisionSource === DECISION_SOURCE.SYSTEM_RECOMMENDATION) return 1;
  if (decisionSource === DECISION_SOURCE.USER_OVERRIDE) return 0;
  if (decisionSource === DECISION_SOURCE.HUMAN_REVIEW) return 0;
  if (decisionSource === DECISION_SOURCE.MANUAL_ACTION) return 0;
  if (decisionSource === DECISION_SOURCE.RECOVERY) return 0;
  return 0.5;
}

function inferSuccess(input = {}) {
  if (input.success != null) return Boolean(input.success);
  const status = lower(
    input.status || input.taskStatus || input.task_status || input.to || (input.task && input.task.status) || ""
  );
  if (status === "completed") return true;
  if (status === "waiting_human" || status === "awaiting_confirmation") return true;
  if (status === "blocked" && inferActualAction(input) === CORRECTIVE_ACTION.MARK_AS_BLOCKED) return true;
  return false;
}

function normalizeAttributionRecord(input = {}) {
  const task = input.task || {};
  const recommendedAction = recommendedActionType(input);
  const actualAction = inferActualAction(input);
  const decisionSource = normalizeSource(inferDecisionSource(input, recommendedAction, actualAction));
  const wasOverridden =
    input.wasOverridden == null && input.was_overridden == null
      ? Boolean(
          (recommendedAction && actualAction && recommendedAction !== actualAction) ||
          decisionSource === DECISION_SOURCE.USER_OVERRIDE
        )
      : Boolean(input.wasOverridden ?? input.was_overridden);
  const attributionScore = inferAttributionScore({
    recommendedAction,
    actualAction,
    decisionSource,
    attributionScore: input.attributionScore ?? input.attribution_score
  });
  return {
    goalId: text(input.goalId || input.goal_id || task.goalId || task.goal_id || ""),
    taskId: text(input.taskId || input.task_id || task.id || ""),
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
    recommendedAction,
    actualAction,
    decisionSource,
    wasOverridden,
    success: inferSuccess(input),
    attributionScore,
    status: lower(input.status || input.taskStatus || input.task_status || input.to || task.status || ""),
    reason: text(input.reason || input.decisionReason || input.decision_reason || ""),
    timestamp: input.timestamp || input.at || nowIso(),
    metadata: input.metadata && typeof input.metadata === "object" ? { ...input.metadata } : {}
  };
}

module.exports = {
  DECISION_SOURCE,
  actionType,
  clamp,
  inferActualAction,
  inferAttributionScore,
  inferDecisionSource,
  normalizeAttributionRecord,
  normalizeSource,
  text
};
