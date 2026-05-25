"use strict";

const taskRuntime = require("../tasks");

const GOAL_STATUS = Object.freeze({
  RUNNING: "running",
  WAITING_HUMAN: "waiting_human",
  BLOCKED: "blocked",
  COMPLETED: "completed",
  FAILED: "failed",
  PAUSED: "paused",
  CANCELED: "canceled"
});

const TERMINAL_TASK_STATUSES = new Set([
  taskRuntime.TASK_STATUS.COMPLETED,
  taskRuntime.TASK_STATUS.FAILED,
  taskRuntime.TASK_STATUS.CANCELED
]);

const PRESERVED_GOAL_STATUSES = new Set([
  GOAL_STATUS.PAUSED,
  GOAL_STATUS.COMPLETED,
  GOAL_STATUS.CANCELED,
  GOAL_STATUS.FAILED
]);

function isTerminalTaskStatus(status) {
  return TERMINAL_TASK_STATUSES.has(String(status || ""));
}

function isBrowserLikeTask(task = {}) {
  const text = [
    task.type,
    task.modelPool,
    task.title,
    task.description,
    task.prompt,
    task.approvalReason,
    task.blockedReason,
    Array.isArray(task.actions) ? task.actions.join(" ") : ""
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/\b(browser|page|click|submit|login|captcha|url|playwright|浏览器|页面|点击|提交|登录|验证码)\b/i.test(text))
    return true;
  return extractBrowserSessionIds(task).length > 0;
}

function isWorkerProcessTask(task = {}) {
  const text = `${task.type || ""} ${task.modelPool || ""} ${task.title || ""}`.toLowerCase();
  return /\b(codex-cli|worker|shell|terminal|browser|local_execution|tool)\b/.test(text);
}

function extractBrowserSessionIds(task = {}) {
  const ids = new Set();
  const visit = (value, depth = 0) => {
    if (value == null || depth > 6) return;
    if (typeof value === "string") {
      const matches = value.match(/\bbrowser-[A-Za-z0-9_-]+/g) || [];
      for (const match of matches) ids.add(match);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (/sessionId|session_id|browserSessionId|browser_session_id/i.test(key) && item) ids.add(String(item));
      else if (/browser|evidence|context|metadata|history/i.test(key)) visit(item, depth + 1);
    }
  };
  visit(task);
  return [...ids].filter(Boolean);
}

function runningTaskRecoveryReason(task = {}, policy = {}) {
  if (isBrowserLikeTask(task)) return "browser_session_lost";
  if (String(task.modelPool || "").toLowerCase() === "codex-cli") return "worker_process_lost";
  if (isWorkerProcessTask(task)) return "worker_process_lost";
  return policy.runningTaskReason || "process_restarted_or_worker_lost";
}

function retryReadyRecovery(task = {}, budgetEvaluation = {}, policy = {}) {
  if (policy.retryReadyPolicy === "blocked") {
    return {
      targetStatus: taskRuntime.TASK_STATUS.BLOCKED,
      reason: "recovery_retry_blocked_by_policy",
      blockedReason: "Recovery policy blocks retry-ready tasks after restart."
    };
  }
  if (policy.retryReadyPolicy === "keep_retry_ready") {
    return {
      targetStatus: taskRuntime.TASK_STATUS.RETRY_READY,
      reason: "recovery_retry_ready_preserved",
      blockedReason: ""
    };
  }
  if (Number(task.attempts || 0) >= Number(task.maxAttempts || 1)) {
    return {
      targetStatus: taskRuntime.TASK_STATUS.BLOCKED,
      reason: "recovery_retry_budget_exhausted",
      blockedReason: "Retry budget exhausted before recovery could requeue the task."
    };
  }
  if (budgetEvaluation && budgetEvaluation.blockedReason) {
    return {
      targetStatus: taskRuntime.TASK_STATUS.BLOCKED,
      reason: "recovery_budget_blocked_retry",
      blockedReason: budgetEvaluation.blockedReason
    };
  }
  return { targetStatus: taskRuntime.TASK_STATUS.WAITING, reason: "recovery_retry_requeued", blockedReason: "" };
}

function deriveGoalRecovery(goal = {}) {
  const current = String(goal.status || "").toLowerCase();
  if (PRESERVED_GOAL_STATUSES.has(current)) {
    return { status: current, reason: "goal_status_preserved", blockedReason: goal.blockedReason || "" };
  }
  const tasks = Array.isArray(goal.tasks) ? goal.tasks : [];
  if (!tasks.length) {
    const createdAtMs = Date.parse(goal.createdAt || goal.created_at || "");
    const ageMs = Number.isFinite(createdAtMs) ? Date.now() - createdAtMs : Infinity;
    if (ageMs >= 0 && ageMs < 5 * 60 * 1000) {
      return {
        status: GOAL_STATUS.RUNNING,
        reason: "recovery_goal_empty_recently_created",
        blockedReason: ""
      };
    }
    return {
      status: GOAL_STATUS.BLOCKED,
      reason: "recovery_goal_has_no_tasks",
      blockedReason: "Goal has no tasks after recovery and needs review."
    };
  }
  const statuses = tasks.map((task) => String(task.status || ""));
  const hasWaitingHuman = statuses.some(
    (status) =>
      status === taskRuntime.TASK_STATUS.WAITING_HUMAN || status === taskRuntime.TASK_STATUS.AWAITING_CONFIRMATION
  );
  const hasRunnable = statuses.some(
    (status) =>
      status === taskRuntime.TASK_STATUS.WAITING ||
      status === taskRuntime.TASK_STATUS.RETRY_READY ||
      status === taskRuntime.TASK_STATUS.RUNNING
  );
  const hasBlocked = statuses.includes(taskRuntime.TASK_STATUS.BLOCKED);
  const allTerminal = statuses.every(isTerminalTaskStatus);
  const allCompleted = statuses.length > 0 && statuses.every((status) => status === taskRuntime.TASK_STATUS.COMPLETED);

  if (allCompleted)
    return { status: GOAL_STATUS.COMPLETED, reason: "recovery_goal_all_tasks_completed", blockedReason: "" };
  if (allTerminal)
    return {
      status: GOAL_STATUS.FAILED,
      reason: "recovery_goal_all_tasks_terminal_without_success",
      blockedReason: "All tasks are terminal but the goal is not completed."
    };
  if (hasRunnable)
    return { status: GOAL_STATUS.RUNNING, reason: "recovery_goal_has_runnable_tasks", blockedReason: "" };
  if (hasWaitingHuman)
    return { status: GOAL_STATUS.WAITING_HUMAN, reason: "recovery_goal_waiting_human", blockedReason: "" };
  if (hasBlocked)
    return {
      status: GOAL_STATUS.BLOCKED,
      reason: "recovery_goal_blocked_tasks",
      blockedReason: "Goal has blocked tasks after recovery."
    };
  return {
    status: GOAL_STATUS.BLOCKED,
    reason: "recovery_goal_needs_review",
    blockedReason: "Goal state is uncertain after recovery and needs review."
  };
}

module.exports = {
  GOAL_STATUS,
  deriveGoalRecovery,
  extractBrowserSessionIds,
  isBrowserLikeTask,
  isTerminalTaskStatus,
  isWorkerProcessTask,
  retryReadyRecovery,
  runningTaskRecoveryReason
};
