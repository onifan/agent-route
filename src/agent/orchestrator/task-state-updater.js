"use strict";

const taskRuntime = require("../tasks");
const memoryRuntime = require("../memory");
const workerEvidence = require("../verification/evidence");

const { TASK_STATUS } = taskRuntime;

function compactText(value = "", limit = 1800) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function compactWorkerResultForEvent(workerResult = {}) {
  const normalized = taskRuntime.normalizeWorkerResult(workerResult);
  return {
    ...normalized,
    output: compactText(normalized.output, 1800),
    error: compactText(normalized.error, 1200),
    nextStep: compactText(normalized.nextStep, 1000),
    actions: Array.isArray(normalized.actions) ? normalized.actions.slice(0, 20) : [],
    artifacts: Array.isArray(normalized.artifacts) ? normalized.artifacts.slice(0, 20) : [],
    memoryCandidates: Array.isArray(normalized.memoryCandidates) ? normalized.memoryCandidates.slice(0, 10) : [],
    evidence: workerEvidence.compactEvidence(normalized.evidence || {}),
    context: {
      model: normalized.context && normalized.context.model,
      elapsedMs: normalized.context && normalized.context.elapsedMs,
      status: normalized.context && normalized.context.status,
      evidenceProvided: normalized.context && normalized.context.evidenceProvided
    }
  };
}

function latest(history) {
  return Array.isArray(history) && history.length ? history[history.length - 1] : null;
}

function shouldEmitBudget(budget) {
  return Boolean(
    budget &&
    (budget.blockedReason || budget.degradationLevel !== "none" || (budget.warnings && budget.warnings.length))
  );
}

function authenticityPayload(goalId, task, verification = {}) {
  return {
    goal_id: goalId,
    task: task,
    authenticity: {
      score: Number(verification.authenticityScore || 0),
      warnings: verification.authenticityWarnings || [],
      reasons: verification.authenticityReasons || [],
      signals: verification.authenticitySignals || [],
      decisionSource: verification.decisionSource || "",
      suggestedNextState: verification.suggestedNextState || "",
      reasonCode: verification.reasonCode || "",
      missingEvidence: verification.missingEvidence || [],
      rejectedEvidence: verification.rejectedEvidence || []
    }
  };
}

function correctivePayload(goalId, task, actions = [], summary = null) {
  return {
    goal_id: goalId,
    task,
    recommendedActions: actions,
    correctiveSummary: summary
  };
}

function actionDecisionPayload(goalId, task, rankedActions = [], recommendedAction = null, summary = null) {
  return {
    goal_id: goalId,
    task,
    rankedActions,
    recommendedAction,
    actionDecisionSummary: summary
  };
}

function actionLearningPayload(goalId, task, latestLearning = null, summary = null) {
  return {
    goal_id: goalId,
    task,
    actionLearning: latestLearning,
    actionLearningSummary: summary
  };
}

function decisionAttributionPayload(goalId, task, latestAttribution = null, summary = null) {
  return {
    goal_id: goalId,
    task,
    decisionAttribution: latestAttribution,
    decisionAttributionSummary: summary
  };
}

function applyWorkerResultAndPublish({
  goalId,
  runningTask,
  result,
  workerResultForRuntime,
  config,
  allTasks,
  workerResults,
  executedTaskIds,
  send,
  emitBudget,
  taskSummary
}) {
  let updatedTask = taskRuntime.applyWorkerResult(goalId, runningTask.id, workerResultForRuntime, {
    source: "agent_route_worker",
    model: result.model || "",
    elapsedMs: result.elapsedMs || 0,
    budgetPolicy: config.budget
  });
  const generatedMemories = memoryRuntime.captureTaskMemory({
    goalId,
    task: updatedTask,
    workerResult: workerResultForRuntime,
    source: result.model || runningTask.modelPool || "worker"
  });
  const latestVerification = latest(updatedTask.verificationHistory);
  if (latestVerification) {
    send("verification", {
      goal_id: goalId,
      task: taskSummary(updatedTask),
      verification: latestVerification
    });
    const score = Number(latestVerification.authenticityScore || 0);
    const warnings = latestVerification.authenticityWarnings || [];
    if (score || warnings.length || latestVerification.decisionSource === "authenticity") {
      const task = taskSummary(updatedTask);
      send("AuthenticityChecked", authenticityPayload(goalId, task, latestVerification));
      if (warnings.length || score < 0.7 || latestVerification.decisionSource === "authenticity") {
        send("AuthenticityWarning", authenticityPayload(goalId, task, latestVerification));
      }
      if (
        score < 0.35 ||
        (latestVerification.suggestedNextState === "blocked" && latestVerification.decisionSource === "authenticity")
      ) {
        send("AuthenticityBlocked", authenticityPayload(goalId, task, latestVerification));
      }
    }
    if (Array.isArray(updatedTask.recommendedActions) && updatedTask.recommendedActions.length) {
      send(
        "CorrectiveActionSuggested",
        correctivePayload(
          goalId,
          taskSummary(updatedTask),
          updatedTask.recommendedActions,
          updatedTask.correctiveSummary
        )
      );
    }
    if (Array.isArray(updatedTask.rankedActions) && updatedTask.rankedActions.length) {
      send(
        "ActionRanked",
        actionDecisionPayload(
          goalId,
          taskSummary(updatedTask),
          updatedTask.rankedActions,
          updatedTask.recommendedAction,
          updatedTask.actionDecisionSummary
        )
      );
    }
    if (Array.isArray(updatedTask.actionLearningHistory) && updatedTask.actionLearningHistory.length) {
      send(
        "ActionLearningUpdated",
        actionLearningPayload(
          goalId,
          taskSummary(updatedTask),
          updatedTask.actionLearningHistory[updatedTask.actionLearningHistory.length - 1],
          updatedTask.actionLearningSummary
        )
      );
    }
    if (Array.isArray(updatedTask.decisionAttributionHistory) && updatedTask.decisionAttributionHistory.length) {
      send(
        "DecisionAttributed",
        decisionAttributionPayload(
          goalId,
          taskSummary(updatedTask),
          updatedTask.decisionAttributionHistory[updatedTask.decisionAttributionHistory.length - 1],
          updatedTask.decisionAttributionSummary
        )
      );
    }
  }
  const latestRisk = latest(updatedTask.riskHistory);
  if (latestRisk && (latestRisk.blockedReason || latestRisk.requiresHumanApproval || latestRisk.escalationReason)) {
    send("risk", {
      goal_id: goalId,
      task: taskSummary(updatedTask),
      evaluation: latestRisk
    });
  }
  const latestBudget = latest(updatedTask.budgetHistory);
  if (shouldEmitBudget(latestBudget)) {
    emitBudget("task_budget", latestBudget, updatedTask);
  }
  if (updatedTask.status === TASK_STATUS.RETRY_READY && updatedTask.attempts < updatedTask.maxAttempts) {
    updatedTask = taskRuntime.scheduleRetry(goalId, runningTask.id, "retry_scheduled_after_worker_failure", {
      source: "agent_route_worker",
      model: result.model || "",
      attempt: updatedTask.attempts,
      budgetPolicy: config.budget
    });
    const retryBudget = latest(updatedTask.budgetHistory);
    if (retryBudget) emitBudget("retry_budget", retryBudget, updatedTask);
  }
  const storedIndex = allTasks.findIndex((item) => item.id === updatedTask.id);
  if (storedIndex >= 0) allTasks[storedIndex] = updatedTask;
  const completed = updatedTask.status === TASK_STATUS.COMPLETED;
  const shouldRunAgain = updatedTask.status === TASK_STATUS.WAITING && updatedTask.attempts < updatedTask.maxAttempts;
  const recordedResult = {
    ...result,
    task: updatedTask,
    ok: completed,
    content: updatedTask.result || result.content || "",
    error: updatedTask.error || result.error || "",
    status: updatedTask.status
  };
  workerResults.push(recordedResult);
  if (!shouldRunAgain) executedTaskIds.add(runningTask.id);
  send("worker_done", {
    task: taskSummary(updatedTask),
    status: updatedTask.status,
    ok: completed,
    model: result.model,
    content: compactText(updatedTask.result || result.content || "", 2400),
    error: compactText(updatedTask.error || result.error || "", 1200),
    elapsedMs: result.elapsedMs,
    worker_result: compactWorkerResultForEvent(workerResultForRuntime)
  });
  if (generatedMemories.length) {
    send("memory", {
      goal_id: goalId,
      task_id: updatedTask.id,
      count: generatedMemories.length,
      memories: generatedMemories
    });
  }
  return recordedResult;
}

module.exports = {
  applyWorkerResultAndPublish
};
