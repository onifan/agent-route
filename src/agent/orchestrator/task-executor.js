"use strict";

const taskRuntime = require("../tasks");
const budgetGovernor = require("../budget");

const { TASK_STATUS } = taskRuntime;

function compactText(value, maxLength = 1200) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function compactHistoryItem(item = {}) {
  if (!item || typeof item !== "object") return item;
  const copy = { ...item };
  delete copy.context;
  delete copy.workerResult;
  delete copy.budgetPolicy;
  delete copy.policy;
  if (copy.error) copy.error = compactText(copy.error, 600);
  if (copy.reason) copy.reason = compactText(copy.reason, 600);
  if (copy.blockedReason) copy.blockedReason = compactText(copy.blockedReason, 600);
  return copy;
}

function compactHistory(value, limit = 5) {
  return Array.isArray(value) ? value.slice(-limit).map(compactHistoryItem) : [];
}

function compactValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return compactText(value, 900);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => compactValue(item, depth + 1));
  if (typeof value !== "object") return compactText(value, 900);
  const output = {};
  for (const [key, item] of Object.entries(value)) output[key] = compactValue(item, depth + 1);
  return output;
}

function compactActionLearningSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  return {
    runs: Number(summary.runs || 0),
    success: Number(summary.success || 0),
    failure: Number(summary.failure || 0),
    successRate: Number(summary.successRate || 0),
    avgCost: Number(summary.avgCost || 0),
    avgDuration: Number(summary.avgDuration || 0),
    latestAction: compactValue(summary.latestAction || null)
  };
}

function compactDecisionAttributionSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  return {
    runs: Number(summary.runs || 0),
    success: Number(summary.success || 0),
    failure: Number(summary.failure || 0),
    successRate: Number(summary.successRate || 0),
    overridden: Number(summary.overridden || 0),
    overrideRate: Number(summary.overrideRate || 0),
    avgAttributionScore: Number(summary.avgAttributionScore || 0),
    latestAttribution: compactValue(summary.latestAttribution || null)
  };
}

function taskSummary(task) {
  return {
    id: task.id,
    goalId: task.goalId || task.goal_id || "",
    title: task.title,
    description: task.description || "",
    type: task.type || task.taskType || "general",
    modelPool: task.modelPool,
    toolWorker: task.toolWorker || task.tool_worker || "",
    source: task.source || task.createdBy || task.created_by || task.creationSource || task.creation_source || "",
    createdByTaskId: task.createdByTaskId || task.created_by_task_id || task.invokedByTaskId || "",
    createdByTaskTitle: task.createdByTaskTitle || task.created_by_task_title || task.invokedByTaskTitle || "",
    difficulty: task.difficulty || task.complexity || "medium",
    complexity: task.complexity,
    riskLevel: task.riskLevel || "low",
    riskReasons: task.riskReasons || [],
    riskSignals: compactHistory(task.riskSignals),
    riskHistory: compactHistory(task.riskHistory),
    input: compactText(task.input, 1200),
    successCriteria: task.successCriteria || [],
    dependencies: task.dependencies || [],
    dependsOn: task.dependsOn || task.depends_on || task.dependencies || [],
    produces: task.produces || task.producedArtifacts || task.produced_artifacts || [],
    consumes: task.consumes || task.requiredArtifacts || task.required_artifacts || [],
    priority: Number(task.priority || 0),
    retryPolicy: task.retryPolicy || task.retry_policy || {},
    graphDepth: Number(task.graphDepth || task.graph_depth || 0),
    dependencyStatus: task.dependencyStatus || task.dependency_status || "",
    dependencyReasons: task.dependencyReasons || task.dependency_reasons || [],
    blockedBy: task.blockedBy || task.blocked_by || [],
    missingArtifacts: task.missingArtifacts || task.missing_artifacts || [],
    strategyId: task.strategyId || task.strategy_id || "",
    strategicObjective: task.strategicObjective || task.strategic_objective || "",
    strategicPhase: task.strategicPhase || task.strategic_phase || "",
    strategicRationale: task.strategicRationale || task.strategic_rationale || "",
    result: compactText(task.result, 1600),
    error: compactText(task.error, 1000),
    attempts: Number(task.attempts || 0),
    maxAttempts: Number(task.maxAttempts || 1),
    requiresHumanApproval: Boolean(task.requiresHumanApproval),
    requiresHumanConfirmation: Boolean(task.requiresHumanConfirmation),
    approvalReason: task.approvalReason || "",
    approvalStatus: task.approvalStatus || "",
    escalationReason: task.escalationReason || "",
    suggestedAction: task.suggestedAction || "",
    verified: Boolean(task.verified),
    verificationStatus: task.verificationStatus || "",
    verificationConfidence: Number(task.verificationConfidence || 0),
    verificationReasons: task.verificationReasons || [],
    detectedIssues: task.detectedIssues || [],
    verificationReasonCode: task.verificationReasonCode || task.verification_reason_code || task.reasonCode || "",
    missingEvidence: task.missingEvidence || task.missing_evidence || [],
    rejectedEvidence: task.rejectedEvidence || task.rejected_evidence || [],
    authenticityScore: Number(task.authenticityScore || 0),
    authenticityWarnings: task.authenticityWarnings || [],
    authenticityReasons: task.authenticityReasons || [],
    authenticitySignals: task.authenticitySignals || [],
    decisionSource: task.decisionSource || "",
    recommendedActions: compactValue(task.recommendedActions || []),
    correctiveSummary: compactValue(task.correctiveSummary || null),
    correctiveHistory: compactHistory(task.correctiveHistory),
    rankedActions: compactValue(task.rankedActions || []),
    recommendedAction: compactValue(task.recommendedAction || null),
    actionDecisionSummary: compactValue(task.actionDecisionSummary || null),
    actionDecisionHistory: compactHistory(task.actionDecisionHistory),
    actionLearningSummary: compactActionLearningSummary(task.actionLearningSummary),
    actionLearningHistory: compactHistory(task.actionLearningHistory),
    decisionAttributionSummary: compactDecisionAttributionSummary(task.decisionAttributionSummary),
    decisionAttributionHistory: compactHistory(task.decisionAttributionHistory),
    verificationHistory: compactHistory(task.verificationHistory),
    verificationSuggestedNextState: task.verificationSuggestedNextState || "",
    verificationRetryable: task.verificationRetryable !== false,
    budget: task.budget || {},
    budgetUsage: budgetGovernor.normalizeUsage(task.budgetUsage || task.budget_usage || {}),
    budgetStatus: task.budgetStatus || task.budget_status || "ok",
    degradationLevel: task.degradationLevel || task.degradation_level || "none",
    budgetWarnings: task.budgetWarnings || task.budget_warnings || [],
    budgetBlockedReason: task.budgetBlockedReason || task.budget_blocked_reason || "",
    budgetHistory: compactHistory(task.budgetHistory || task.budget_history),
    blockedReason: compactText(task.blockedReason, 1000),
    internal: Boolean(task.internal || task.routeInternal || task.route_internal),
    routeInternal: Boolean(task.internal || task.routeInternal || task.route_internal),
    status: task.status || TASK_STATUS.WAITING,
    createdAt: task.createdAt || "",
    startedAt: task.startedAt || "",
    finishedAt: task.finishedAt || "",
    updatedAt: task.updatedAt || "",
    routingReason: compactText(task.routingReason, 1000),
    prompt: compactText(task.prompt, 1600)
  };
}

function isDependencyPropagationBlock(task = {}) {
  if (!task || typeof task !== "object") return false;
  if (task.status !== TASK_STATUS.BLOCKED) return false;
  const reasonText = [
    task.blockedReason,
    task.blocked_reason,
    ...(Array.isArray(task.dependencyReasons || task.dependency_reasons)
      ? task.dependencyReasons || task.dependency_reasons
      : []),
    ...(Array.isArray(task.history)
      ? task.history.map((entry) => [entry.reason, entry.blockedReason].filter(Boolean).join(" "))
      : [])
  ]
    .filter(Boolean)
    .join("\n");
  return /dependency_blocked|Dependency .+ is (?:failed|blocked|canceled)|Missing dependency|Dependency cycle/i.test(
    reasonText
  );
}

function isPausedTaskStatus(taskOrStatus) {
  const task = taskOrStatus && typeof taskOrStatus === "object" ? taskOrStatus : { status: taskOrStatus };
  const status = task.status;
  return (
    status === TASK_STATUS.AWAITING_CONFIRMATION ||
    status === TASK_STATUS.WAITING_HUMAN ||
    (status === TASK_STATUS.BLOCKED && !isDependencyPropagationBlock(task))
  );
}

function isTerminalTaskStatus(status) {
  return status === TASK_STATUS.COMPLETED || status === TASK_STATUS.FAILED || status === TASK_STATUS.CANCELED;
}

module.exports = {
  isDependencyPropagationBlock,
  isPausedTaskStatus,
  isTerminalTaskStatus,
  taskSummary
};
