"use strict";

const configLoader = require("../../config/loader");
const { budgetRepository, goalRepository, taskEventRepository, taskRepository } = require("../../storage/repositories");
const taskRuntime = require("../tasks");
const { recordRecoveryEvent } = require("./recovery-events");
const {
  deriveGoalRecovery,
  extractBrowserSessionIds,
  isBrowserLikeTask,
  retryReadyRecovery,
  runningTaskRecoveryReason
} = require("./recovery-rules");
const { addUnique, emptyRecoverySummary, summarizeRecovery } = require("./recovery-summary");

let startupRecoveryRan = false;
let lastRecoverySummary = null;

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizePolicy(options = {}) {
  const config = options.config || configLoader.loadRuntimeConfig();
  return {
    ...(config.recoveryPolicy || configLoader.DEFAULT_CONFIG.recoveryPolicy || {}),
    ...(options.policy || {})
  };
}

function isTerminalGoalStatus(status) {
  return ["completed", "failed", "canceled", "paused"].includes(String(status || "").toLowerCase());
}

function skippedGoalIds(options = {}) {
  return new Set(
    []
      .concat(options.skipGoalIds || options.skip_goal_ids || [])
      .concat(options.skipGoalId || options.skip_goal_id || [])
      .map((item) => String(item || "").trim())
      .filter(Boolean)
  );
}

function goalTaskList(goal = {}) {
  return Array.isArray(goal.tasks) ? goal.tasks : [];
}

function latestRecoverySummaryFromEvents() {
  const event = (require("../observability").listEvents({ type: "RecoveryCompleted", limit: 1 }) || [])[0];
  return event && event.data && event.data.summary ? event.data.summary : null;
}

function updateTaskPatch(patches, goalId, taskId, patch) {
  patches.push({ goalId, taskId, patch: clone(patch) });
}

function appendTaskRecoveryEvent(events, goalId, taskId, event) {
  events.push({ goalId, taskId, event: clone(event) });
}

function budgetInterruptedRecord(goalId, task, reason) {
  budgetRepository.recordBudgetEvaluation({
    goalId,
    taskId: task.id,
    evaluation: {
      at: nowIso(),
      phase: "recovery_interrupted",
      status: "warning",
      blockedReason: "",
      warnings: ["Task was interrupted while running; exact additional cost is unknown."],
      usage: task.budgetUsage || {},
      unknownCost: true
    },
    usage: task.budgetUsage || {},
    context: {
      source: "runtime-recovery",
      reason
    }
  });
}

function markRunningTaskRecovered({ goal, task, policy, summary, taskPatches }) {
  const goalId = goal.goalId;
  const reason = runningTaskRecoveryReason(task, policy);
  const browserLike = isBrowserLikeTask(task);
  const sessionIds = extractBrowserSessionIds(task);
  const target =
    policy.runningTaskTargetStatus === taskRuntime.TASK_STATUS.RETRY_READY
      ? taskRuntime.TASK_STATUS.RETRY_READY
      : taskRuntime.TASK_STATUS.BLOCKED;
  const blockedReason =
    reason === "browser_session_lost"
      ? "Browser session was lost during process restart; task needs review before retry."
      : "Worker process was lost during process restart; task needs review before retry.";

  let recovered;
  try {
    recovered = taskRuntime.transitionTask(goalId, task.id, target, reason, {
      source: "runtime-recovery",
      recoveryReason: reason,
      staleBrowserSessions: sessionIds,
      skipDependencyPropagation: false
    });
  } catch (err) {
    summary.errors.push(`Failed to recover running task ${task.id}: ${err.message}`);
    recordRecoveryEvent(
      "RecoveryWarning",
      {
        goal_id: goalId,
        task_id: task.id,
        message: `Failed to recover running task: ${err.message}`
      },
      { goalId, taskId: task.id, policy, severity: "error" }
    );
    return;
  }

  const riskPatch = browserLike
    ? {
        riskLevel: "high",
        riskReasons: [
          ...(Array.isArray(task.riskReasons) ? task.riskReasons : []),
          "Browser session became stale during recovery."
        ],
        riskSignals: [
          ...(Array.isArray(task.riskSignals) ? task.riskSignals : []),
          {
            source: "runtime-recovery",
            riskLevel: "high",
            reason: "Browser session lost while task outcome is unknown.",
            details: { sessionIds }
          }
        ].slice(-20)
      }
    : {};
  updateTaskPatch(taskPatches, goalId, task.id, {
    blockedReason: target === taskRuntime.TASK_STATUS.BLOCKED ? blockedReason : task.blockedReason || "",
    recoveryState: {
      recoveredAt: nowIso(),
      reason,
      targetStatus: target,
      workerLost: true,
      staleBrowserSessions: sessionIds
    },
    ...riskPatch
  });

  budgetInterruptedRecord(goalId, task, reason);
  summary.recoveredTasks += 1;
  summary.interruptedTasks += 1;
  summary.workerLost += 1;
  if (browserLike) {
    summary.staleBrowserSessions += Math.max(1, sessionIds.length);
    addUnique(summary.actionsRecommended, "Review stale browser tasks manually before retrying.");
    recordRecoveryEvent(
      "BrowserSessionMarkedStale",
      {
        goal_id: goalId,
        task_id: task.id,
        sessionIds,
        message: "Browser session was marked stale after recovery."
      },
      { goalId, taskId: task.id, policy, severity: "warn" }
    );
  }
  addUnique(summary.actionsRecommended, "Review interrupted tasks before retrying or deleting them.");
  summary.tasks.push({
    goalId,
    taskId: task.id,
    from: taskRuntime.TASK_STATUS.RUNNING,
    to: target,
    reason,
    blockedReason: target === taskRuntime.TASK_STATUS.BLOCKED ? blockedReason : "",
    workerLost: true,
    staleBrowserSessions: sessionIds
  });
  recordRecoveryEvent(
    "WorkerLostDetected",
    {
      goal_id: goalId,
      task_id: task.id,
      task: recovered,
      reason,
      message: "Running worker was lost during process restart."
    },
    { goalId, taskId: task.id, policy, severity: "warn" }
  );
  recordRecoveryEvent(
    "TaskRecovered",
    {
      goal_id: goalId,
      task_id: task.id,
      from: taskRuntime.TASK_STATUS.RUNNING,
      to: target,
      reason,
      blockedReason
    },
    { goalId, taskId: task.id, policy, severity: "warn" }
  );
}

function recoverRetryReadyTask({ goal, task, policy, summary, taskPatches, taskEvents }) {
  const goalId = goal.goalId;
  let budgetEvaluation = null;
  try {
    budgetEvaluation = taskRuntime.evaluateTaskBudget(goalId, task.id, {
      phase: "recovery_retry",
      nextAttempt: Number(task.attempts || 0) + 1
    }).evaluation;
  } catch (err) {
    summary.warnings.push(`Could not evaluate retry budget for ${task.id}: ${err.message}`);
  }
  const decision = retryReadyRecovery(task, budgetEvaluation, policy);
  if (decision.targetStatus === taskRuntime.TASK_STATUS.RETRY_READY) {
    appendTaskRecoveryEvent(taskEvents, goalId, task.id, {
      from: taskRuntime.TASK_STATUS.RETRY_READY,
      to: taskRuntime.TASK_STATUS.RETRY_READY,
      reason: decision.reason,
      at: nowIso(),
      context: { source: "runtime-recovery" }
    });
    return;
  }
  try {
    taskRuntime.transitionTask(goalId, task.id, decision.targetStatus, decision.reason, {
      source: "runtime-recovery",
      budgetEvaluation,
      skipDependencyPropagation: false
    });
    if (decision.blockedReason) {
      updateTaskPatch(taskPatches, goalId, task.id, {
        blockedReason: decision.blockedReason,
        recoveryState: {
          recoveredAt: nowIso(),
          reason: decision.reason,
          targetStatus: decision.targetStatus
        }
      });
    }
    summary.recoveredTasks += 1;
    summary.tasks.push({
      goalId,
      taskId: task.id,
      from: taskRuntime.TASK_STATUS.RETRY_READY,
      to: decision.targetStatus,
      reason: decision.reason,
      blockedReason: decision.blockedReason || ""
    });
    recordRecoveryEvent(
      "TaskRecovered",
      {
        goal_id: goalId,
        task_id: task.id,
        from: taskRuntime.TASK_STATUS.RETRY_READY,
        to: decision.targetStatus,
        reason: decision.reason,
        blockedReason: decision.blockedReason || ""
      },
      {
        goalId,
        taskId: task.id,
        policy,
        severity: decision.targetStatus === taskRuntime.TASK_STATUS.BLOCKED ? "warn" : "info"
      }
    );
  } catch (err) {
    summary.errors.push(`Failed to recover retry-ready task ${task.id}: ${err.message}`);
  }
}

function scanStableTask({ goal, task, policy, summary, taskEvents }) {
  const goalId = goal.goalId;
  if (task.status === taskRuntime.TASK_STATUS.BLOCKED) {
    appendTaskRecoveryEvent(taskEvents, goalId, task.id, {
      from: taskRuntime.TASK_STATUS.BLOCKED,
      to: taskRuntime.TASK_STATUS.BLOCKED,
      reason: "recovery_blocked_task_preserved",
      at: nowIso(),
      context: { source: "runtime-recovery", blockedReason: task.blockedReason || "" }
    });
    recordRecoveryEvent(
      "TaskRecovered",
      {
        goal_id: goalId,
        task_id: task.id,
        from: taskRuntime.TASK_STATUS.BLOCKED,
        to: taskRuntime.TASK_STATUS.BLOCKED,
        reason: "recovery_blocked_task_preserved"
      },
      { goalId, taskId: task.id, policy, severity: "info" }
    );
  }
}

function applyDeferredTaskWrites(taskPatches, taskEvents) {
  for (const { goalId, taskId, patch } of taskPatches) {
    taskRepository.updateTask(goalId, taskId, patch);
  }
  for (const { goalId, taskId, event } of taskEvents) {
    taskEventRepository.appendTaskEvent(goalId, taskId, event);
  }
}

function recoverGoalStatuses(summary, policy, options = {}) {
  taskRuntime.reloadRuntime();
  const goals = taskRuntime.listGoals();
  const skipped = skippedGoalIds(options);
  for (const goal of goals) {
    if (skipped.has(String(goal.goalId || goal.goal_id || ""))) continue;
    const current = String(goal.status || "running").toLowerCase();
    if (isTerminalGoalStatus(current)) {
      continue;
    }
    const decision = deriveGoalRecovery({ ...goal, status: current || "running" });
    if (decision.status !== current || (decision.blockedReason && goal.blockedReason !== decision.blockedReason)) {
      goalRepository.updateGoal(goal.goalId, {
        status: decision.status,
        blockedReason: decision.blockedReason || "",
        recoverySummary: {
          at: summary.at,
          trigger: summary.trigger,
          reason: decision.reason
        }
      });
      summary.recoveredGoals += 1;
      summary.goals.push({
        goalId: goal.goalId,
        from: current || "running",
        to: decision.status,
        reason: decision.reason,
        blockedReason: decision.blockedReason || ""
      });
      recordRecoveryEvent(
        "GoalRecovered",
        {
          goal_id: goal.goalId,
          from: current || "running",
          to: decision.status,
          reason: decision.reason,
          blockedReason: decision.blockedReason || ""
        },
        { goalId: goal.goalId, policy, severity: decision.status === "blocked" ? "warn" : "info" }
      );
    }
  }
  taskRuntime.reloadRuntime();
}

function runRuntimeRecovery(options = {}) {
  const policy = normalizePolicy(options);
  const summary = emptyRecoverySummary({
    trigger: options.trigger || "manual"
  });
  if (!policy.enabled && !options.force) {
    summary.skipped = true;
    summary.reason = "recovery_disabled";
    lastRecoverySummary = summarizeRecovery(summary);
    return lastRecoverySummary;
  }

  recordRecoveryEvent(
    "RecoveryStarted",
    {
      trigger: summary.trigger,
      policy: {
        runningTaskTargetStatus: policy.runningTaskTargetStatus,
        retryReadyPolicy: policy.retryReadyPolicy,
        maxAutoRecoveredTasks: policy.maxAutoRecoveredTasks
      }
    },
    { policy, severity: "info" }
  );

  const taskPatches = [];
  const taskEvents = [];
  const skipped = skippedGoalIds(options);
  try {
    taskRuntime.reloadRuntime();
    const goals = taskRuntime.listGoals();
    summary.scannedGoals = goals.length;
    for (const goal of goals) {
      if (skipped.has(String(goal.goalId || goal.goal_id || ""))) continue;
      const tasks = goalTaskList(goal);
      summary.scannedTasks += tasks.length;
      for (const task of tasks) {
        if (summary.recoveredTasks >= Number(policy.maxAutoRecoveredTasks || 200)) {
          addUnique(summary.warnings, "Recovery stopped after maxAutoRecoveredTasks limit.");
          break;
        }
        if (task.status === taskRuntime.TASK_STATUS.RUNNING) {
          markRunningTaskRecovered({ goal, task, policy, summary, taskPatches });
        } else if (task.status === taskRuntime.TASK_STATUS.RETRY_READY) {
          recoverRetryReadyTask({ goal, task, policy, summary, taskPatches, taskEvents });
        } else {
          scanStableTask({ goal, task, policy, summary, taskEvents });
        }
      }
    }
    applyDeferredTaskWrites(taskPatches, taskEvents);
    recoverGoalStatuses(summary, policy, options);
  } catch (err) {
    summary.errors.push(err && err.message ? err.message : String(err));
    recordRecoveryEvent(
      "RecoveryWarning",
      {
        message: err && err.message ? err.message : String(err)
      },
      { policy, severity: "error" }
    );
  }

  if (summary.interruptedTasks > 0) {
    addUnique(summary.warnings, `${summary.interruptedTasks} running task(s) were interrupted and safely stopped.`);
  }
  if (summary.staleBrowserSessions > 0) {
    addUnique(summary.warnings, `${summary.staleBrowserSessions} browser session reference(s) were marked stale.`);
  }

  lastRecoverySummary = summarizeRecovery(summary);
  recordRecoveryEvent(
    "RecoveryCompleted",
    {
      summary: lastRecoverySummary
    },
    {
      policy,
      severity: lastRecoverySummary.errors.length ? "error" : lastRecoverySummary.warnings.length ? "warn" : "info"
    }
  );
  return lastRecoverySummary;
}

function runStartupRecovery(options = {}) {
  if (startupRecoveryRan && !options.force) {
    return (
      lastRecoverySummary ||
      latestRecoverySummaryFromEvents() ||
      summarizeRecovery(emptyRecoverySummary({ trigger: options.trigger || "startup_cached" }))
    );
  }
  const policy = normalizePolicy(options);
  if (policy.autoOnAgentRouteStart === false && !options.force) {
    return summarizeRecovery({
      ...emptyRecoverySummary({ trigger: options.trigger || "startup" }),
      skipped: true,
      reason: "auto_recovery_disabled"
    });
  }
  startupRecoveryRan = true;
  return runRuntimeRecovery({
    ...options,
    policy,
    trigger: options.trigger || "startup"
  });
}

function recoveryStatus() {
  return (
    lastRecoverySummary ||
    latestRecoverySummaryFromEvents() ||
    summarizeRecovery(emptyRecoverySummary({ trigger: "none" }))
  );
}

function resetRecoveryRuntime() {
  startupRecoveryRan = false;
  lastRecoverySummary = null;
}

module.exports = {
  recoveryStatus,
  resetRecoveryRuntime,
  runRuntimeRecovery,
  runStartupRecovery
};
