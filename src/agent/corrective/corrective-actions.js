"use strict";

const CORRECTIVE_ACTION = Object.freeze({
  RETRY_TASK: "retry_task",
  RETRY_WITH_DIFFERENT_MODEL: "retry_with_different_model",
  RERUN_BROWSER: "rerun_browser",
  REQUEST_HUMAN_REVIEW: "request_human_review",
  REQUEST_MORE_DATA: "request_more_data",
  MARK_AS_BLOCKED: "mark_as_blocked",
  CONTINUE: "continue"
});

const PRIORITY = Object.freeze({
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical"
});

function normalizeAction(action = {}) {
  const type = String(action.type || action.action || "")
    .trim()
    .toLowerCase();
  const priority = String(action.priority || PRIORITY.MEDIUM)
    .trim()
    .toLowerCase();
  return {
    type: Object.values(CORRECTIVE_ACTION).includes(type) ? type : CORRECTIVE_ACTION.REQUEST_HUMAN_REVIEW,
    priority: Object.values(PRIORITY).includes(priority) ? priority : PRIORITY.MEDIUM,
    reason: String(action.reason || ""),
    trigger: String(action.trigger || ""),
    source: String(action.source || "corrective"),
    automatic: false,
    safeToAutoExecute: false,
    createdAt: action.createdAt || new Date().toISOString(),
    metadata: action.metadata && typeof action.metadata === "object" ? { ...action.metadata } : {}
  };
}

function action(type, priority, reason, trigger, source = "corrective", metadata = {}) {
  return normalizeAction({ type, priority, reason, trigger, source, metadata });
}

module.exports = {
  CORRECTIVE_ACTION,
  PRIORITY,
  action,
  normalizeAction
};
