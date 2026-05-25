"use strict";

const { agentRoutePath } = require("../../shared/utils/agent-home");
const {
  artifactRepository,
  budgetRepository,
  goalRepository,
  riskRepository,
  verificationRepository
} = require("../../storage/repositories");
const actionLearning = require("../action-learning");
const budgetGovernor = require("../budget");
const actionDecisionEngine = require("../action-decision");
const decisionAttribution = require("../decision-attribution");
const correctiveEngine = require("../corrective");
const dependencyEngine = require("../graph");
const riskEngine = require("../risk");
const strategyEngine = require("../strategies");
const verificationEngine = require("../verification");
const workerEvidence = require("../verification/evidence");

const TASK_STATUS = Object.freeze({
  WAITING: "waiting",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  RETRY_READY: "retry_ready",
  NEEDS_EVIDENCE: "needs_evidence",
  BLOCKED: "blocked",
  WAITING_HUMAN: "waiting_human",
  AWAITING_CONFIRMATION: "awaiting_confirmation",
  CANCELED: "canceled"
});

const WORKER_OUTCOME = Object.freeze({
  SUCCESS: "success",
  FAILURE: "failure",
  RETRY: "retry",
  BLOCKED: "blocked",
  AWAITING_CONFIRMATION: "awaiting_confirmation"
});

const ALLOWED_TRANSITIONS = Object.freeze({
  [TASK_STATUS.WAITING]: new Set([
    TASK_STATUS.RUNNING,
    TASK_STATUS.BLOCKED,
    TASK_STATUS.WAITING_HUMAN,
    TASK_STATUS.AWAITING_CONFIRMATION,
    TASK_STATUS.CANCELED
  ]),
  [TASK_STATUS.RUNNING]: new Set([
    TASK_STATUS.COMPLETED,
    TASK_STATUS.FAILED,
    TASK_STATUS.RETRY_READY,
    TASK_STATUS.NEEDS_EVIDENCE,
    TASK_STATUS.BLOCKED,
    TASK_STATUS.WAITING_HUMAN,
    TASK_STATUS.AWAITING_CONFIRMATION,
    TASK_STATUS.CANCELED
  ]),
  [TASK_STATUS.RETRY_READY]: new Set([
    TASK_STATUS.WAITING,
    TASK_STATUS.BLOCKED,
    TASK_STATUS.WAITING_HUMAN,
    TASK_STATUS.CANCELED
  ]),
  [TASK_STATUS.NEEDS_EVIDENCE]: new Set([TASK_STATUS.WAITING, TASK_STATUS.CANCELED]),
  [TASK_STATUS.BLOCKED]: new Set([TASK_STATUS.WAITING, TASK_STATUS.CANCELED]),
  [TASK_STATUS.WAITING_HUMAN]: new Set([TASK_STATUS.WAITING, TASK_STATUS.COMPLETED, TASK_STATUS.CANCELED]),
  [TASK_STATUS.AWAITING_CONFIRMATION]: new Set([TASK_STATUS.WAITING, TASK_STATUS.COMPLETED, TASK_STATUS.CANCELED]),
  [TASK_STATUS.COMPLETED]: new Set([]),
  [TASK_STATUS.FAILED]: new Set([]),
  [TASK_STATUS.CANCELED]: new Set([])
});

const goals = new Map();
let storeLoaded = false;
let storageFile = process.env.AGENT_ROUTE_TASKS || agentRoutePath("agent-route-tasks.json");

function nowIso() {
  return new Date().toISOString();
}

function uid(prefix = "task") {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function compactText(value = "", maxLength = 6000) {
  const text = String(value == null ? "" : value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function compactValue(value, options = {}, depth = 0) {
  const maxDepth = Number(options.maxDepth || 5);
  const maxArray = Number(options.maxArray || 40);
  const maxString = Number(options.maxString || 4000);
  if (value == null) return value;
  if (typeof value === "string") return compactText(value, maxString);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= maxDepth) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(-maxArray).map((item) => compactValue(item, options, depth + 1));
  }
  if (typeof value !== "object") return compactText(value, maxString);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const keyString = String(key);
    const nestedOptions =
      /^(body|bodyPreview|textPreview|pageText|stdout|stderr|output|result|content)$/i.test(keyString) ||
      /(?:body|text|content|output|result)$/i.test(keyString)
        ? { ...options, maxString: Math.min(maxString, 1600), maxArray }
        : options;
    output[key] = compactValue(item, nestedOptions, depth + 1);
  }
  return output;
}

function compactHistoryContext(context = {}) {
  const source = context && typeof context === "object" ? context : {};
  const skipped = new Set([
    "workerResult",
    "worker_result",
    "evidence",
    "apiResponses",
    "api_responses",
    "browserEvidence",
    "browser_evidence",
    "normalizedEvidence",
    "normalized_evidence",
    "browser",
    "shell",
    "files",
    "stdout",
    "stderr",
    "output",
    "result",
    "content",
    "policy",
    "budgetPolicy"
  ]);
  const output = {};
  for (const [key, value] of Object.entries(source)) {
    if (skipped.has(key)) continue;
    if (key === "verification" && value && typeof value === "object") {
      output.verification = {
        verificationStatus: value.verificationStatus || value.status || "",
        confidence: Number(value.confidence || 0),
        suggestedNextState: value.suggestedNextState || "",
        reasonCode: value.reasonCode || "",
        missingEvidence: Array.isArray(value.missingEvidence)
          ? value.missingEvidence
              .slice(0, 5)
              .map((item) => compactValue(item, { maxString: 300, maxArray: 5, maxDepth: 2 }))
          : [],
        reasons: normalizeList(value.reasons).slice(0, 5),
        detectedIssues: Array.isArray(value.detectedIssues)
          ? value.detectedIssues
              .slice(0, 5)
              .map((item) => compactValue(item, { maxString: 300, maxArray: 5, maxDepth: 2 }))
          : []
      };
      continue;
    }
    if ((key === "riskEvaluation" || key === "risk") && value && typeof value === "object") {
      output[key] = {
        riskLevel: value.riskLevel || "",
        requiresHumanApproval: Boolean(value.requiresHumanApproval),
        blockedReason: compactText(value.blockedReason || "", 500),
        approvalReason: compactText(value.approvalReason || "", 500)
      };
      continue;
    }
    if ((key === "budgetEvaluation" || key === "budget") && value && typeof value === "object") {
      output[key] = {
        status: value.status || "",
        degradationLevel: value.degradationLevel || "",
        blockedReason: compactText(value.blockedReason || "", 500),
        warnings: normalizeList(value.warnings).slice(0, 5)
      };
      continue;
    }
    output[key] = compactValue(value, { maxString: 500, maxArray: 8, maxDepth: 2 });
  }
  return output;
}

function compactHistoryEntry(entry = {}) {
  if (!entry || typeof entry !== "object") return entry;
  return {
    ...compactValue(entry, { maxString: 1600, maxArray: 20, maxDepth: 4 }),
    context: compactHistoryContext(entry.context || {})
  };
}

function compactTaskForBoundary(task = {}, options = {}) {
  const output = {};
  for (const [key, value] of Object.entries(task || {})) {
    if (key === "result" || key === "output" || key === "content") {
      output[key] = compactText(value, options.resultLimit || 12000);
    } else if (key === "actionLearningSummary" && value && typeof value === "object") {
      output[key] = {
        runs: Number(value.runs || 0),
        success: Number(value.success || 0),
        failure: Number(value.failure || 0),
        successRate: Number(value.successRate || 0),
        avgCost: Number(value.avgCost || 0),
        avgDuration: Number(value.avgDuration || 0),
        latestAction: compactValue(value.latestAction || null, { maxString: 1200, maxArray: 10, maxDepth: 3 })
      };
    } else if (key === "decisionAttributionSummary" && value && typeof value === "object") {
      output[key] = {
        runs: Number(value.runs || 0),
        success: Number(value.success || 0),
        failure: Number(value.failure || 0),
        successRate: Number(value.successRate || 0),
        overridden: Number(value.overridden || 0),
        overrideRate: Number(value.overrideRate || 0),
        avgAttributionScore: Number(value.avgAttributionScore || 0),
        latestAttribution: compactValue(value.latestAttribution || null, { maxString: 1200, maxArray: 10, maxDepth: 3 })
      };
    } else if (key === "error" || key === "blockedReason" || key === "budgetBlockedReason") {
      output[key] = compactText(value, 2000);
    } else if (key === "input" || key === "prompt" || key === "description") {
      output[key] = compactText(value, 6000);
    } else if (/History$/.test(key) || key === "history") {
      output[key] = Array.isArray(value) ? value.slice(-(options.historyLimit || 12)).map(compactHistoryEntry) : [];
    } else if (key === "riskSignals" || key === "authenticitySignals" || key === "fileIntentChecks") {
      output[key] = compactValue(value, { maxString: 500, maxArray: 10, maxDepth: 3 });
    } else if (Array.isArray(value)) {
      output[key] = compactValue(value, { maxString: 2400, maxArray: options.arrayLimit || 50, maxDepth: 5 });
    } else if (value && typeof value === "object") {
      output[key] = compactValue(value, { maxString: 2400, maxArray: options.arrayLimit || 50, maxDepth: 5 });
    } else {
      output[key] = value;
    }
  }
  return output;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map((item) => String(item));
  if (!value) return [];
  return [String(value)];
}

function taskError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function serializeGoal(goal) {
  return {
    goalId: goal.goalId,
    status: goal.status || "",
    blockedReason: goal.blockedReason || "",
    recoverySummary: goal.recoverySummary ? clone(goal.recoverySummary) : null,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    budgetState: goal.budgetState
      ? compactValue(goal.budgetState, { maxString: 1600, maxArray: 40, maxDepth: 5 })
      : null,
    strategyState: goal.strategyState
      ? compactValue(goal.strategyState, { maxString: 2400, maxArray: 40, maxDepth: 5 })
      : null,
    strategyHistory: Array.isArray(goal.strategyHistory)
      ? goal.strategyHistory
          .map((item) => compactValue(item, { maxString: 1800, maxArray: 30, maxDepth: 5 }))
          .slice(-30)
      : [],
    tasks: [...goal.tasks.values()]
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((task) => compactTaskForBoundary(task, { resultLimit: 20000, historyLimit: 30, arrayLimit: 50 }))
  };
}

function hydrateGoal(raw = {}) {
  const goal = {
    goalId: String(raw.goalId || raw.goal_id || "default-goal"),
    status: String(raw.status || raw.goalStatus || raw.goal_status || ""),
    blockedReason: String(raw.blockedReason || raw.blocked_reason || ""),
    recoverySummary:
      raw.recoverySummary || raw.recovery_summary ? clone(raw.recoverySummary || raw.recovery_summary) : null,
    createdAt: raw.createdAt || raw.created_at || nowIso(),
    updatedAt: raw.updatedAt || raw.updated_at || nowIso(),
    budgetState:
      raw.budgetState || raw.budget_state
        ? budgetGovernor.normalizeGoalBudgetState(raw.budgetState || raw.budget_state, {
            goalId: raw.goalId || raw.goal_id || "default-goal",
            startedAt: Date.parse(raw.createdAt || raw.created_at || "") || Date.now()
          })
        : null,
    strategyState:
      raw.strategyState || raw.strategy_state
        ? strategyEngine.normalizeStrategy(raw.strategyState || raw.strategy_state, {
            goalId: raw.goalId || raw.goal_id || "default-goal"
          })
        : null,
    strategyHistory: Array.isArray(raw.strategyHistory || raw.strategy_history)
      ? (raw.strategyHistory || raw.strategy_history)
          .map((item) => ({
            ...strategyEngine.normalizeStrategy(item, {
              goalId: raw.goalId || raw.goal_id || "default-goal"
            }),
            event: String(item.event || ""),
            previousVersion: Number(item.previousVersion || item.previous_version || 0),
            context: item.context && typeof item.context === "object" ? clone(item.context) : {}
          }))
          .slice(-50)
      : [],
    tasks: new Map()
  };
  const rawTasks = Array.isArray(raw.tasks)
    ? raw.tasks
    : raw.tasks && typeof raw.tasks === "object"
      ? Object.values(raw.tasks)
      : [];
  for (const [index, rawTask] of rawTasks.entries()) {
    const task = normalizeTask(rawTask, goal.goalId, index);
    goal.tasks.set(task.id, task);
  }
  return goal;
}

function taskStorePath() {
  return storageFile;
}

function setStorageFile(file) {
  storageFile = file ? String(file) : "";
  goals.clear();
  storeLoaded = false;
}

function loadStore() {
  if (storeLoaded) return;
  storeLoaded = true;
  if (!storageFile) return;
  try {
    const rawGoals = goalRepository.listGoals({ file: storageFile });
    goals.clear();
    for (const rawGoal of rawGoals) {
      const goal = hydrateGoal(rawGoal);
      goals.set(goal.goalId, goal);
    }
  } catch (err) {
    console.warn("[agent-route-task-runtime] failed to load store:", err.message);
  }
}

function saveStore() {
  if (!storageFile) return;
  try {
    goalRepository.saveGoals([...goals.values()].map(serializeGoal), {
      file: storageFile,
      updatedAt: nowIso()
    });
  } catch (err) {
    console.warn("[agent-route-task-runtime] failed to save store:", err.message);
  }
}

function reloadRuntime() {
  goals.clear();
  storeLoaded = false;
  loadStore();
}

function ensureGoal(goalId) {
  loadStore();
  const id = String(goalId || "default-goal");
  if (!goals.has(id)) {
    goals.set(id, {
      goalId: id,
      status: "running",
      blockedReason: "",
      recoverySummary: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      budgetState: null,
      strategyState: null,
      strategyHistory: [],
      tasks: new Map()
    });
  }
  return goals.get(id);
}

function getGoal(goalId) {
  loadStore();
  return goals.get(String(goalId || "default-goal")) || null;
}

function normalizeTask(raw = {}, goalId, index = 0) {
  const at = raw.createdAt || raw.created_at || nowIso();
  const id = String(raw.id || uid("task"));
  const requiresHumanApproval = Boolean(
    raw.requiresHumanApproval ||
    raw.requires_human_approval ||
    raw.requiresHumanConfirmation ||
    raw.requires_human_confirmation
  );
  const approvalStatus = riskEngine.normalizeApprovalStatus(
    raw.approvalStatus || raw.approval_status,
    requiresHumanApproval
  );
  const status =
    raw.status && TASK_STATUS[raw.status.toUpperCase()]
      ? TASK_STATUS[raw.status.toUpperCase()]
      : Object.values(TASK_STATUS).includes(raw.status)
        ? raw.status
        : TASK_STATUS.WAITING;
  const graphFields = dependencyEngine.normalizeTaskGraphFields({ ...raw, id });
  return {
    id,
    goalId: String(goalId || raw.goalId || raw.goal_id || "default-goal"),
    title: String(raw.title || raw.name || `Task ${index + 1}`),
    description: String(raw.description || raw.prompt || raw.goal || raw.title || ""),
    type: String(raw.type || raw.taskType || raw.task_type || raw.modelPool || "general"),
    modelPool: String(raw.modelPool || raw.model_pool || "free"),
    toolWorker: String(raw.toolWorker || raw.tool_worker || ""),
    source: String(raw.source || raw.createdBy || raw.created_by || raw.creationSource || raw.creation_source || ""),
    createdByTaskId: String(
      raw.createdByTaskId || raw.created_by_task_id || raw.invokedByTaskId || raw.invoked_by_task_id || ""
    ),
    createdByTaskTitle: String(
      raw.createdByTaskTitle || raw.created_by_task_title || raw.invokedByTaskTitle || raw.invoked_by_task_title || ""
    ),
    difficulty: String(raw.difficulty || raw.complexity || "medium"),
    complexity: String(raw.complexity || raw.difficulty || "medium"),
    riskLevel: String(raw.riskLevel || raw.risk_level || "low"),
    input: raw.input == null ? raw.prompt || "" : raw.input,
    successCriteria: normalizeList(
      raw.successCriteria || raw.success_criteria || raw.acceptanceCriteria || raw.acceptance_criteria
    ),
    dependencies: graphFields.dependencies,
    dependsOn: graphFields.dependsOn,
    produces: graphFields.produces,
    consumes: graphFields.consumes,
    strategyId: String(raw.strategyId || raw.strategy_id || ""),
    strategicObjective: String(raw.strategicObjective || raw.strategic_objective || ""),
    strategicPhase: String(raw.strategicPhase || raw.strategic_phase || ""),
    strategicRationale: String(raw.strategicRationale || raw.strategic_rationale || ""),
    prompt: String(raw.prompt || raw.description || raw.title || ""),
    routingReason: String(raw.routingReason || raw.routing_reason || raw.reason || ""),
    result: compactText(raw.result || raw.output || "", 20000),
    error: compactText(raw.error || "", 4000),
    attempts: Number.isFinite(Number(raw.attempts)) ? Number(raw.attempts) : 0,
    maxAttempts: Math.max(1, Number(raw.maxAttempts || raw.max_attempts || 2)),
    requiresHumanApproval,
    requiresHumanConfirmation: requiresHumanApproval,
    approvalReason: String(raw.approvalReason || raw.approval_reason || ""),
    approvalStatus,
    riskReasons: normalizeList(raw.riskReasons || raw.risk_reasons),
    riskSignals: Array.isArray(raw.riskSignals || raw.risk_signals) ? clone(raw.riskSignals || raw.risk_signals) : [],
    riskHistory: Array.isArray(raw.riskHistory || raw.risk_history)
      ? (raw.riskHistory || raw.risk_history).map(compactHistoryEntry).slice(-30)
      : [],
    escalationReason: String(raw.escalationReason || raw.escalation_reason || ""),
    suggestedAction: String(raw.suggestedAction || raw.suggested_action || ""),
    verified: Boolean(raw.verified),
    verificationStatus: String(raw.verificationStatus || raw.verification_status || ""),
    verificationConfidence: Number.isFinite(Number(raw.verificationConfidence || raw.verification_confidence))
      ? Number(raw.verificationConfidence || raw.verification_confidence)
      : 0,
    verificationReasons: normalizeList(raw.verificationReasons || raw.verification_reasons),
    detectedIssues: Array.isArray(raw.detectedIssues || raw.detected_issues)
      ? clone(raw.detectedIssues || raw.detected_issues)
      : [],
    verificationReasonCode: String(raw.verificationReasonCode || raw.verification_reason_code || raw.reasonCode || ""),
    missingEvidence: Array.isArray(raw.missingEvidence || raw.missing_evidence)
      ? clone(raw.missingEvidence || raw.missing_evidence).slice(0, 30)
      : [],
    rejectedEvidence: Array.isArray(raw.rejectedEvidence || raw.rejected_evidence)
      ? clone(raw.rejectedEvidence || raw.rejected_evidence).slice(0, 30)
      : [],
    authenticityScore: Number.isFinite(Number(raw.authenticityScore || raw.authenticity_score))
      ? Number(raw.authenticityScore || raw.authenticity_score)
      : 0,
    authenticityWarnings: normalizeList(raw.authenticityWarnings || raw.authenticity_warnings),
    authenticityReasons: normalizeList(raw.authenticityReasons || raw.authenticity_reasons),
    authenticitySignals: Array.isArray(raw.authenticitySignals || raw.authenticity_signals)
      ? clone(raw.authenticitySignals || raw.authenticity_signals).slice(0, 20)
      : [],
    decisionSource: String(raw.decisionSource || raw.decision_source || ""),
    fileIntentConfidence: Number.isFinite(Number(raw.fileIntentConfidence || raw.file_intent_confidence))
      ? Number(raw.fileIntentConfidence || raw.file_intent_confidence)
      : 0,
    fileIntentReason: String(raw.fileIntentReason || raw.file_intent_reason || ""),
    falseFileDetectionCount: Number.isFinite(Number(raw.falseFileDetectionCount || raw.false_file_detection_count))
      ? Number(raw.falseFileDetectionCount || raw.false_file_detection_count)
      : 0,
    fileIntentChecks: Array.isArray(raw.fileIntentChecks || raw.file_intent_checks)
      ? clone(raw.fileIntentChecks || raw.file_intent_checks).slice(0, 30)
      : [],
    verificationHistory: Array.isArray(raw.verificationHistory || raw.verification_history)
      ? (raw.verificationHistory || raw.verification_history).map(compactHistoryEntry).slice(-30)
      : [],
    verificationSuggestedNextState: String(
      raw.verificationSuggestedNextState || raw.verification_suggested_next_state || ""
    ),
    verificationRetryable:
      raw.verificationRetryable == null && raw.verification_retryable == null
        ? true
        : Boolean(raw.verificationRetryable ?? raw.verification_retryable),
    recommendedActions: Array.isArray(raw.recommendedActions || raw.recommended_actions)
      ? clone(raw.recommendedActions || raw.recommended_actions).slice(0, 12)
      : [],
    correctiveSummary:
      raw.correctiveSummary && typeof raw.correctiveSummary === "object" ? clone(raw.correctiveSummary) : null,
    correctiveHistory: Array.isArray(raw.correctiveHistory || raw.corrective_history)
      ? (raw.correctiveHistory || raw.corrective_history).map(compactHistoryEntry).slice(-20)
      : [],
    rankedActions: Array.isArray(raw.rankedActions || raw.ranked_actions)
      ? clone(raw.rankedActions || raw.ranked_actions).slice(0, 12)
      : [],
    recommendedAction:
      raw.recommendedAction && typeof raw.recommendedAction === "object"
        ? clone(raw.recommendedAction)
        : raw.recommended_action && typeof raw.recommended_action === "object"
          ? clone(raw.recommended_action)
          : null,
    actionDecisionSummary:
      raw.actionDecisionSummary && typeof raw.actionDecisionSummary === "object"
        ? clone(raw.actionDecisionSummary)
        : raw.action_decision_summary && typeof raw.action_decision_summary === "object"
          ? clone(raw.action_decision_summary)
          : null,
    actionDecisionHistory: Array.isArray(raw.actionDecisionHistory || raw.action_decision_history)
      ? (raw.actionDecisionHistory || raw.action_decision_history).map(compactHistoryEntry).slice(-20)
      : [],
    actionLearningSummary:
      raw.actionLearningSummary && typeof raw.actionLearningSummary === "object"
        ? clone(raw.actionLearningSummary)
        : raw.action_learning_summary && typeof raw.action_learning_summary === "object"
          ? clone(raw.action_learning_summary)
          : null,
    actionLearningHistory: Array.isArray(raw.actionLearningHistory || raw.action_learning_history)
      ? (raw.actionLearningHistory || raw.action_learning_history).map(compactHistoryEntry).slice(-20)
      : [],
    decisionAttributionSummary:
      raw.decisionAttributionSummary && typeof raw.decisionAttributionSummary === "object"
        ? clone(raw.decisionAttributionSummary)
        : raw.decision_attribution_summary && typeof raw.decision_attribution_summary === "object"
          ? clone(raw.decision_attribution_summary)
          : null,
    decisionAttributionHistory: Array.isArray(raw.decisionAttributionHistory || raw.decision_attribution_history)
      ? (raw.decisionAttributionHistory || raw.decision_attribution_history).map(compactHistoryEntry).slice(-20)
      : [],
    budget: raw.budget && typeof raw.budget === "object" ? clone(raw.budget) : {},
    budgetUsage: budgetGovernor.normalizeUsage(raw.budgetUsage || raw.budget_usage),
    budgetStatus: String(raw.budgetStatus || raw.budget_status || "ok"),
    degradationLevel: String(raw.degradationLevel || raw.degradation_level || "none"),
    budgetWarnings: normalizeList(raw.budgetWarnings || raw.budget_warnings),
    budgetBlockedReason: String(raw.budgetBlockedReason || raw.budget_blocked_reason || ""),
    budgetHistory: Array.isArray(raw.budgetHistory || raw.budget_history)
      ? (raw.budgetHistory || raw.budget_history).map(compactHistoryEntry).slice(-30)
      : [],
    blockedReason: String(raw.blockedReason || raw.blocked_reason || ""),
    artifacts: graphFields.artifacts,
    priority: graphFields.priority,
    retryPolicy: graphFields.retryPolicy,
    graphDepth: Number.isFinite(Number(raw.graphDepth || raw.graph_depth))
      ? Number(raw.graphDepth || raw.graph_depth)
      : 0,
    dependencyStatus: String(raw.dependencyStatus || raw.dependency_status || ""),
    dependencyReasons: normalizeList(raw.dependencyReasons || raw.dependency_reasons),
    blockedBy: normalizeList(raw.blockedBy || raw.blocked_by),
    missingArtifacts: normalizeList(raw.missingArtifacts || raw.missing_artifacts),
    status,
    createdAt: at,
    startedAt: raw.startedAt || raw.started_at || "",
    finishedAt: raw.finishedAt || raw.finished_at || "",
    updatedAt: raw.updatedAt || raw.updated_at || at,
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : index,
    history: Array.isArray(raw.history) ? raw.history.map(compactHistoryEntry).slice(-30) : []
  };
}

function publicTask(task) {
  return compactTaskForBoundary(task, { resultLimit: 12000, historyLimit: 20, arrayLimit: 40 });
}

function publicGoal(goal) {
  if (!goal) return null;
  return {
    goalId: goal.goalId,
    status: goal.status || "",
    blockedReason: goal.blockedReason || "",
    recoverySummary: goal.recoverySummary ? clone(goal.recoverySummary) : null,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    budgetState: goal.budgetState
      ? compactValue(goal.budgetState, { maxString: 1600, maxArray: 40, maxDepth: 5 })
      : null,
    strategyState: goal.strategyState
      ? compactValue(goal.strategyState, { maxString: 2400, maxArray: 40, maxDepth: 5 })
      : null,
    strategyHistory: Array.isArray(goal.strategyHistory)
      ? goal.strategyHistory
          .map((item) => compactValue(item, { maxString: 1800, maxArray: 30, maxDepth: 5 }))
          .slice(-30)
      : [],
    tasks: [...goal.tasks.values()].sort((a, b) => (a.order || 0) - (b.order || 0)).map(publicTask)
  };
}

function setGoalStatus(goalId, status, context = {}) {
  const goal = ensureGoal(goalId);
  if (status) goal.status = String(status);
  if (Object.prototype.hasOwnProperty.call(context, "blockedReason")) {
    goal.blockedReason = String(context.blockedReason || "");
  }
  if (context.recoverySummary && typeof context.recoverySummary === "object") {
    goal.recoverySummary = clone(context.recoverySummary);
  }
  goal.updatedAt = nowIso();
  saveStore();
  return publicGoal(goal);
}

function listGoals() {
  loadStore();
  return [...goals.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(publicGoal);
}

function getTask(goalId, taskId) {
  const goal = getGoal(goalId);
  if (!goal) return null;
  return goal.tasks.get(String(taskId || "")) || null;
}

function listTasks(goalId) {
  const goal = getGoal(goalId);
  return goal ? publicGoal(goal).tasks : [];
}

function getTaskHistory(goalId, taskId) {
  const task = getTask(goalId, taskId);
  return task ? clone(task.history) : [];
}

function getGoalBudgetState(goalId) {
  const goal = getGoal(goalId);
  return goal && goal.budgetState ? clone(goal.budgetState) : null;
}

function ensureGoalBudgetState(goalId, fallback = {}) {
  const goal = ensureGoal(goalId);
  if (!goal.budgetState) {
    goal.budgetState = budgetGovernor.createGoalBudgetState({
      goalId: goal.goalId,
      policy: fallback.policy || fallback.budget || {},
      startedAt: fallback.startedAt || fallback.started_at || Date.parse(goal.createdAt) || Date.now()
    });
    goal.updatedAt = nowIso();
    saveStore();
  }
  return clone(goal.budgetState);
}

function setGoalBudgetState(goalId, state = {}, fallback = {}) {
  const goal = ensureGoal(goalId);
  goal.budgetState = budgetGovernor.normalizeGoalBudgetState(state, {
    goalId: goal.goalId,
    policy: fallback.policy || fallback.budget || {},
    startedAt: fallback.startedAt || fallback.started_at || Date.parse(goal.createdAt) || Date.now()
  });
  goal.updatedAt = nowIso();
  saveStore();
  return clone(goal.budgetState);
}

function getGoalStrategy(goalId) {
  const goal = getGoal(goalId);
  return goal && goal.strategyState ? clone(goal.strategyState) : null;
}

function getGoalStrategyHistory(goalId) {
  const goal = getGoal(goalId);
  return goal && Array.isArray(goal.strategyHistory) ? goal.strategyHistory.map(clone) : [];
}

function setGoalStrategy(goalId, strategy = {}, context = {}) {
  const goal = ensureGoal(goalId);
  const normalized = strategyEngine.normalizeStrategy(strategy, {
    goalId: goal.goalId,
    revisionReason: context.reason || context.revisionReason || context.revision_reason || strategy.revisionReason
  });
  const previous = goal.strategyState ? clone(goal.strategyState) : null;
  goal.strategyState = normalized;
  goal.strategyHistory = Array.isArray(goal.strategyHistory) ? goal.strategyHistory : [];
  goal.strategyHistory.push({
    ...clone(normalized),
    event: previous ? "strategy_revised" : "strategy_created",
    previousVersion: previous ? previous.version : 0,
    context: compactHistoryContext(context || {})
  });
  goal.strategyHistory = goal.strategyHistory.slice(-50);
  goal.updatedAt = nowIso();
  saveStore();
  return clone(goal.strategyState);
}

function assertTransition(from, to) {
  if (from === to) return;
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) {
    throw taskError(`Illegal task status transition: ${from} -> ${to}`, "illegal_task_transition", { from, to });
  }
}

function orderedGoalTasks(goal) {
  return [...goal.tasks.values()].sort((a, b) => (a.order || 0) - (b.order || 0));
}

function setGraphMetadata(goal, graph) {
  const byId = new Map((graph.nodes || []).map((node) => [node.id, node]));
  for (const task of goal.tasks.values()) {
    const node = byId.get(task.id);
    if (!node) continue;
    task.graphDepth = Number(node.depth || 0);
    task.dependencyStatus = node.readiness ? node.readiness.status : "";
    task.dependencyReasons = node.readiness ? node.readiness.reasons || [] : [];
    task.blockedBy = node.readiness ? node.readiness.blockedBy || [] : [];
    task.missingArtifacts = node.readiness ? node.readiness.missingArtifacts || [] : [];
    task.dependsOn = dependencyEngine.normalizeDependencyIds(task);
    task.dependencies = task.dependsOn;
  }
}

function refreshGoalGraph(goalId) {
  const goal = ensureGoal(goalId);
  const graph = dependencyEngine.buildExecutionGraph(orderedGoalTasks(goal));
  setGraphMetadata(goal, graph);
  goal.updatedAt = nowIso();
  saveStore();
  return graph;
}

function blockGraphTask(goal, task, reason, context = {}) {
  if (
    !task ||
    [TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.CANCELED, TASK_STATUS.BLOCKED].includes(task.status)
  )
    return false;
  const from = task.status;
  if (!ALLOWED_TRANSITIONS[from] || !ALLOWED_TRANSITIONS[from].has(TASK_STATUS.BLOCKED)) return false;
  const at = nowIso();
  task.status = TASK_STATUS.BLOCKED;
  task.blockedReason = String(reason || "Dependency graph blocked this task.");
  task.updatedAt = at;
  task.history.push({
    from,
    to: TASK_STATUS.BLOCKED,
    reason: "dependency_blocked",
    at,
    context: compactHistoryContext(context || {})
  });
  return true;
}

function applyGraphValidation(goal, context = {}) {
  const graph = dependencyEngine.buildExecutionGraph(orderedGoalTasks(goal));
  setGraphMetadata(goal, graph);
  const blocked = [];
  for (const taskId of graph.cycles.flat()) {
    const task = goal.tasks.get(taskId);
    if (
      blockGraphTask(goal, task, "Dependency cycle detected.", {
        ...context,
        graphEvent: dependencyEngine.GRAPH_EVENT.INVALID,
        cycles: graph.cycles
      })
    )
      blocked.push(taskId);
  }
  for (const item of graph.unknownDependencies || []) {
    const task = goal.tasks.get(item.taskId);
    if (
      blockGraphTask(goal, task, `Missing dependency: ${item.dependency}`, {
        ...context,
        graphEvent: dependencyEngine.GRAPH_EVENT.INVALID,
        missingDependency: item.dependency
      })
    )
      blocked.push(item.taskId);
  }
  for (const chain of graph.blockedChains || []) {
    const task = goal.tasks.get(chain.taskId);
    const reason =
      Array.isArray(chain.reasons) && chain.reasons.length ? chain.reasons[0] : "Dependency graph blocked this task.";
    if (
      blockGraphTask(goal, task, reason, {
        ...context,
        graphEvent: dependencyEngine.GRAPH_EVENT.BLOCK_PROPAGATED,
        blockedBy: chain.blockedBy || []
      })
    )
      blocked.push(chain.taskId);
  }
  if (graph.valid) {
    for (const task of goal.tasks.values()) {
      const latest = Array.isArray(task.history) ? task.history[task.history.length - 1] : null;
      const graphBlocked =
        latest &&
        latest.reason === "dependency_blocked" &&
        /Missing dependency|Dependency cycle/i.test(task.blockedReason || "");
      if (
        task.status === TASK_STATUS.BLOCKED &&
        graphBlocked &&
        ALLOWED_TRANSITIONS[TASK_STATUS.BLOCKED].has(TASK_STATUS.WAITING)
      ) {
        const at = nowIso();
        task.history.push({
          from: TASK_STATUS.BLOCKED,
          to: TASK_STATUS.WAITING,
          reason: "dependency_unblocked",
          at,
          context: compactHistoryContext(context || {})
        });
        task.status = TASK_STATUS.WAITING;
        task.blockedReason = "";
        task.updatedAt = at;
      }
    }
  }
  return { graph, blocked };
}

const ACTION_LEARNING_STATUSES = new Set([
  TASK_STATUS.COMPLETED,
  TASK_STATUS.FAILED,
  TASK_STATUS.RETRY_READY,
  TASK_STATUS.NEEDS_EVIDENCE,
  TASK_STATUS.BLOCKED,
  TASK_STATUS.WAITING_HUMAN,
  TASK_STATUS.AWAITING_CONFIRMATION,
  TASK_STATUS.CANCELED
]);

function maybeRecordActionLearning(goalId, task, from, to, reason, context = {}, at = nowIso()) {
  if (from === to || !ACTION_LEARNING_STATUSES.has(to)) return null;
  const action = task.recommendedAction || (Array.isArray(task.rankedActions) && task.rankedActions[0]) || null;
  if (!action || !action.type) return null;
  const attribution = decisionAttribution.attributeDecision({
    goalId,
    taskId: task.id,
    task,
    recommendedAction: action,
    actualAction: context.actualAction || context.actual_action,
    decisionSource: context.decisionSource || context.decision_source,
    wasOverridden: context.wasOverridden ?? context.was_overridden,
    status: to,
    from,
    to,
    reason,
    success: context.success,
    metadata: {
      source: context.source || context.phase || "",
      workerStatus: context.workerStatus || ""
    }
  });
  const actionForLearning = attribution.actualAction ? { ...action, type: attribution.actualAction } : action;
  const key = `${task.id}:${action.type}:${attribution.actualAction || ""}:${to}:${task.attempts || 0}:${String(reason || "")}`;
  const existing = Array.isArray(task.actionLearningHistory) ? task.actionLearningHistory : [];
  if (existing.some((entry) => entry.key === key)) return null;
  const durationMs =
    Number(context.elapsedMs || context.elapsed_ms || 0) ||
    (task.startedAt ? Math.max(0, Date.parse(at) - Date.parse(task.startedAt)) : 0);
  const recordedAttribution = decisionAttribution.recordDecisionAttribution({
    ...attribution,
    timestamp: at,
    metadata: {
      ...compactHistoryContext(attribution.metadata || {}),
      from,
      to,
      reason: String(reason || ""),
      source: context.source || context.phase || ""
    }
  });
  const learning = actionLearning.recordActionOutcome({
    goalId,
    taskId: task.id,
    task,
    action: actionForLearning,
    recommendedAction: attribution.recommendedAction || action.type,
    actualAction: attribution.actualAction || action.type,
    decisionSource: attribution.decisionSource,
    wasOverridden: attribution.wasOverridden,
    attributionScore: attribution.attributionScore,
    attribution: recordedAttribution.record,
    status: to,
    reason,
    durationMs,
    retryCount: task.attempts || 0,
    budgetUsage: task.budgetUsage,
    riskLevel: task.riskLevel,
    authenticityScore: task.authenticityScore,
    metadata: {
      from,
      to,
      reason: String(reason || ""),
      source: context.source || context.phase || ""
    }
  });
  const entry = {
    key,
    at: learning.record.at || learning.record.timestamp || at,
    recordId: learning.record.id,
    actionType: learning.record.actionType,
    recommendedAction: learning.record.recommendedAction,
    actualAction: learning.record.actualAction,
    decisionSource: learning.record.decisionSource,
    wasOverridden: learning.record.wasOverridden,
    attributionScore: learning.record.attributionScore,
    attributionRecordId: recordedAttribution.record.id,
    success: Boolean(learning.record.success),
    status: to,
    cost: learning.record.cost,
    durationMs: learning.record.durationMs,
    retryCount: learning.record.retryCount,
    stats: learning.stats
  };
  task.actionLearningSummary = {
    ...(learning.summary || {}),
    latestAction: entry
  };
  task.actionLearningHistory = existing.concat(entry).slice(-30);
  const attributionEntry = {
    key,
    at: recordedAttribution.record.at || recordedAttribution.record.timestamp || at,
    recordId: recordedAttribution.record.id,
    recommendedAction: recordedAttribution.record.recommendedAction,
    actualAction: recordedAttribution.record.actualAction,
    decisionSource: recordedAttribution.record.decisionSource,
    wasOverridden: Boolean(recordedAttribution.record.wasOverridden),
    success: Boolean(recordedAttribution.record.success),
    attributionScore: recordedAttribution.record.attributionScore,
    status: to,
    reason: String(reason || ""),
    stats: recordedAttribution.stats
  };
  const existingAttributions = Array.isArray(task.decisionAttributionHistory) ? task.decisionAttributionHistory : [];
  task.decisionAttributionSummary = {
    ...(recordedAttribution.summary || {}),
    latestAttribution: attributionEntry
  };
  task.decisionAttributionHistory = existingAttributions.concat(attributionEntry).slice(-30);
  return entry;
}

function propagateDependencyBlocks(goalId, sourceTaskId, context = {}) {
  const goal = getGoal(goalId);
  if (!goal) return [];
  const targets = dependencyEngine.propagationTargets(orderedGoalTasks(goal), sourceTaskId);
  const blocked = [];
  for (const target of targets) {
    if (!target.shouldBlock) continue;
    const task = goal.tasks.get(target.taskId);
    if (
      blockGraphTask(goal, task, target.reason, {
        ...context,
        graphEvent: dependencyEngine.GRAPH_EVENT.BLOCK_PROPAGATED,
        sourceTaskId: target.sourceTaskId
      })
    ) {
      blocked.push({
        taskId: target.taskId,
        sourceTaskId: target.sourceTaskId,
        reason: target.reason
      });
    }
  }
  if (blocked.length) {
    const graph = dependencyEngine.buildExecutionGraph(orderedGoalTasks(goal));
    setGraphMetadata(goal, graph);
    goal.updatedAt = nowIso();
    saveStore();
  }
  return blocked;
}

function transitionTask(goalId, taskId, nextStatus, reason, context = {}) {
  const goal = ensureGoal(goalId);
  const task = goal.tasks.get(String(taskId || ""));
  if (!task) throw taskError(`Task not found: ${taskId}`, "task_not_found", { goalId, taskId });
  const from = task.status;
  const to = String(nextStatus || "");
  assertTransition(from, to);
  const at = nowIso();
  if (from !== to) {
    task.history.push({
      from,
      to,
      reason: String(reason || "status changed"),
      at,
      context: compactHistoryContext(context || {})
    });
  }
  task.status = to;
  task.updatedAt = at;
  if (to === TASK_STATUS.RUNNING && !task.startedAt) task.startedAt = at;
  if ([TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.NEEDS_EVIDENCE, TASK_STATUS.CANCELED].includes(to))
    task.finishedAt = at;
  maybeRecordActionLearning(goalId, task, from, to, reason, context, at);
  goal.updatedAt = at;
  if (!context.skipDependencyPropagation) {
    propagateDependencyBlocks(goalId, task.id, {
      ...context,
      sourceReason: reason
    });
  }
  const graph = dependencyEngine.buildExecutionGraph(orderedGoalTasks(goal));
  setGraphMetadata(goal, graph);
  saveStore();
  return publicTask(task);
}

function riskHistoryEntry(evaluation = {}, context = {}) {
  const compact = riskEngine.compactEvaluation(evaluation);
  return {
    ...compact,
    context: compactHistoryContext(context || {})
  };
}

function applyRiskEvaluation(goalId, taskId, evaluation, context = {}) {
  const task = getTask(goalId, taskId);
  if (!task) throw taskError(`Task not found: ${taskId}`, "task_not_found", { goalId, taskId });
  const compact = riskEngine.compactEvaluation(evaluation);
  task.riskLevel = compact.riskLevel;
  task.riskReasons = compact.riskReasons;
  task.riskSignals = compact.riskSignals;
  task.requiresHumanApproval = Boolean(compact.requiresHumanApproval);
  task.requiresHumanConfirmation = Boolean(compact.requiresHumanApproval);
  task.approvalReason = compact.approvalReason || "";
  task.escalationReason = compact.escalationReason || "";
  task.suggestedAction = compact.suggestedAction || "";
  if (compact.requiresHumanApproval) {
    task.approvalStatus = riskEngine.APPROVAL_STATUS.PENDING;
  } else if (!task.approvalStatus) {
    task.approvalStatus = riskEngine.APPROVAL_STATUS.NOT_REQUIRED;
  }
  if (compact.blockedReason) task.blockedReason = compact.blockedReason;
  task.riskHistory = Array.isArray(task.riskHistory) ? task.riskHistory : [];
  task.riskHistory.push(riskHistoryEntry(compact, context));
  task.riskHistory = task.riskHistory.slice(-50);
  task.updatedAt = nowIso();
  saveStore();
  riskRepository.recordRiskEvaluation({
    goalId,
    taskId,
    evaluation: compact,
    context: compactHistoryContext(context || {})
  });
  return { task: publicTask(task), evaluation: compact };
}

function evaluateTaskRisk(goalId, taskId, context = {}) {
  const task = getTask(goalId, taskId);
  if (!task) throw taskError(`Task not found: ${taskId}`, "task_not_found", { goalId, taskId });
  const evaluation = riskEngine.evaluateTaskRisk(task, context);
  return applyRiskEvaluation(goalId, taskId, evaluation, context);
}

function riskGateStatus(evaluation = {}, task = {}) {
  if (evaluation.blockedReason) return TASK_STATUS.BLOCKED;
  if (evaluation.requiresHumanApproval && task.approvalStatus !== riskEngine.APPROVAL_STATUS.APPROVED) {
    return TASK_STATUS.WAITING_HUMAN;
  }
  return "";
}

function budgetHistoryEntry(evaluation = {}, context = {}) {
  const compact = budgetGovernor.compactEvaluation(evaluation);
  return {
    ...compact,
    context: compactHistoryContext(context || {})
  };
}

function applyBudgetEvaluation(goalId, taskId, evaluation, context = {}) {
  const task = getTask(goalId, taskId);
  if (!task) throw taskError(`Task not found: ${taskId}`, "task_not_found", { goalId, taskId });
  const compact = budgetGovernor.compactEvaluation(evaluation);
  task.budgetUsage = compact.usage;
  task.budgetStatus = compact.status;
  task.degradationLevel = compact.degradationLevel;
  task.budgetWarnings = compact.warnings;
  task.budgetBlockedReason = compact.blockedReason || "";
  if (compact.blockedReason) task.blockedReason = compact.blockedReason;
  task.budgetHistory = Array.isArray(task.budgetHistory) ? task.budgetHistory : [];
  task.budgetHistory.push(budgetHistoryEntry(compact, context));
  task.budgetHistory = task.budgetHistory.slice(-50);
  task.updatedAt = nowIso();
  saveStore();
  budgetRepository.recordBudgetEvaluation({
    goalId,
    taskId,
    evaluation: compact,
    usage: compact.usage,
    context: compactHistoryContext(context || {})
  });
  return { task: publicTask(task), evaluation: compact };
}

function evaluateTaskBudget(goalId, taskId, context = {}) {
  const task = getTask(goalId, taskId);
  if (!task) throw taskError(`Task not found: ${taskId}`, "task_not_found", { goalId, taskId });
  const evaluation = budgetGovernor.evaluateTaskBudget(task, context);
  return applyBudgetEvaluation(goalId, taskId, evaluation, context);
}

function addTaskBudgetUsage(goalId, taskId, delta = {}) {
  const task = getTask(goalId, taskId);
  if (!task) throw taskError(`Task not found: ${taskId}`, "task_not_found", { goalId, taskId });
  task.budgetUsage = budgetGovernor.addUsage(task.budgetUsage, delta);
  task.updatedAt = nowIso();
  saveStore();
  return publicTask(task);
}

function applyBudgetRisk(goalId, taskId, evaluation, context = {}) {
  const risk = budgetGovernor.riskEvaluationFromBudget(evaluation);
  if (!risk) return null;
  return applyRiskEvaluation(goalId, taskId, risk, {
    ...context,
    phase: "budget"
  });
}

function budgetGateStatus(evaluation = {}) {
  if (
    evaluation.blockedReason ||
    evaluation.status === budgetGovernor.BUDGET_STATUS.BLOCKED ||
    evaluation.status === budgetGovernor.BUDGET_STATUS.EXHAUSTED
  ) {
    return TASK_STATUS.BLOCKED;
  }
  return "";
}

function verificationHistoryEntry(verification = {}, context = {}) {
  const compact = verificationEngine.compactVerification(verification);
  return {
    ...compact,
    context: compactHistoryContext(context || {})
  };
}

function applyVerificationResult(goalId, taskId, verification, context = {}) {
  const task = getTask(goalId, taskId);
  if (!task) throw taskError(`Task not found: ${taskId}`, "task_not_found", { goalId, taskId });
  const compact = verificationEngine.compactVerification(verification);
  task.verified = compact.verified;
  task.verificationStatus = compact.verificationStatus;
  task.verificationConfidence = compact.confidence;
  task.verificationReasons = compact.reasons;
  task.detectedIssues = compact.detectedIssues;
  task.verificationReasonCode = compact.reasonCode;
  task.missingEvidence = compact.missingEvidence;
  task.rejectedEvidence = compact.rejectedEvidence;
  task.authenticityScore = compact.authenticityScore;
  task.authenticityWarnings = compact.authenticityWarnings;
  task.authenticityReasons = compact.authenticityReasons;
  task.authenticitySignals = compact.authenticitySignals;
  task.decisionSource = compact.decisionSource;
  task.fileIntentConfidence = compact.fileIntentConfidence;
  task.fileIntentReason = compact.fileIntentReason;
  task.falseFileDetectionCount = compact.falseFileDetectionCount;
  task.fileIntentChecks = compact.fileIntentChecks;
  task.verificationSuggestedNextState = compact.suggestedNextState;
  task.verificationRetryable = compact.retryable;
  const corrective = correctiveEngine.suggestCorrectiveActions({
    task,
    verification: compact,
    risk:
      Array.isArray(task.riskHistory) && task.riskHistory.length
        ? task.riskHistory[task.riskHistory.length - 1]
        : {
            riskLevel: task.riskLevel,
            riskReasons: task.riskReasons,
            requiresHumanApproval: task.requiresHumanApproval,
            blockedReason: task.blockedReason
          }
  });
  task.recommendedActions = corrective.recommendedActions;
  task.correctiveSummary = corrective.summary;
  task.correctiveHistory = Array.isArray(task.correctiveHistory) ? task.correctiveHistory : [];
  task.correctiveHistory.push(corrective);
  task.correctiveHistory = task.correctiveHistory.slice(-30);
  const actionDecision = actionDecisionEngine.rankActions({
    task,
    recommendedActions: corrective.recommendedActions,
    verification: compact,
    risk:
      Array.isArray(task.riskHistory) && task.riskHistory.length
        ? task.riskHistory[task.riskHistory.length - 1]
        : {
            riskLevel: task.riskLevel,
            riskReasons: task.riskReasons,
            requiresHumanApproval: task.requiresHumanApproval,
            blockedReason: task.blockedReason
          },
    budget: {
      status: task.budgetStatus,
      degradationLevel: task.degradationLevel,
      warnings: task.budgetWarnings,
      blockedReason: task.budgetBlockedReason,
      usage: task.budgetUsage
    },
    history: {
      correctiveHistory: task.correctiveHistory,
      actionDecisionHistory: task.actionDecisionHistory,
      retryCount: task.attempts
    }
  });
  task.rankedActions = actionDecision.rankedActions;
  task.recommendedAction = actionDecision.recommendedAction;
  task.actionDecisionSummary = actionDecision.summary;
  task.actionDecisionHistory = Array.isArray(task.actionDecisionHistory) ? task.actionDecisionHistory : [];
  task.actionDecisionHistory.push(actionDecision);
  task.actionDecisionHistory = task.actionDecisionHistory.slice(-30);
  task.verificationHistory = Array.isArray(task.verificationHistory) ? task.verificationHistory : [];
  task.verificationHistory.push(verificationHistoryEntry(compact, context));
  task.verificationHistory = task.verificationHistory.slice(-50);
  task.updatedAt = nowIso();
  saveStore();
  verificationRepository.recordVerificationResult({
    goalId,
    taskId,
    verification: compact,
    context: compactHistoryContext(context || {})
  });
  return { task: publicTask(task), verification: compact };
}

function verificationRiskEvaluation(verification = {}) {
  const findings = Array.isArray(verification.riskFindings) ? verification.riskFindings : [];
  if (!findings.length) return null;
  const levels = findings.map((finding) => finding.riskLevel || "medium");
  const riskLevel = riskEngine.maxRiskLevel(...levels);
  const reasons = findings.map((finding) => finding.reason || finding.blockedReason).filter(Boolean);
  const blockedReason =
    findings.find((finding) => finding.blockedReason)?.blockedReason ||
    (riskLevel === "critical" ? reasons[0] || "Verification detected critical risk." : "");
  return {
    at: nowIso(),
    phase: "verification",
    riskLevel,
    riskReasons: reasons,
    requiresHumanApproval: !blockedReason && riskEngine.isRiskAtLeast(riskLevel, "high"),
    approvalReason:
      !blockedReason && riskEngine.isRiskAtLeast(riskLevel, "high")
        ? reasons[0] || "Verification detected high risk."
        : "",
    approvalStatus:
      !blockedReason && riskEngine.isRiskAtLeast(riskLevel, "high")
        ? riskEngine.APPROVAL_STATUS.PENDING
        : riskEngine.APPROVAL_STATUS.NOT_REQUIRED,
    escalationReason: reasons[0] || "",
    suggestedAction: blockedReason
      ? "block"
      : riskEngine.isRiskAtLeast(riskLevel, "high")
        ? "request_human_approval"
        : "proceed_with_caution",
    blockedReason,
    riskSignals: findings.map((finding) => ({
      source: "verification",
      riskLevel: riskEngine.normalizeRiskLevel(finding.riskLevel || riskLevel),
      reason: String(finding.reason || finding.blockedReason || "Verification risk finding"),
      details: finding.details || {}
    }))
  };
}

function nextStatusFromVerification(task = {}, verification = {}) {
  if (verification.suggestedNextState === verificationEngine.SUGGESTED_NEXT_STATE.BLOCKED) return TASK_STATUS.BLOCKED;
  if (verification.suggestedNextState === verificationEngine.SUGGESTED_NEXT_STATE.WAITING_HUMAN)
    return TASK_STATUS.WAITING_HUMAN;
  if (verification.suggestedNextState === verificationEngine.SUGGESTED_NEXT_STATE.COMPLETED)
    return TASK_STATUS.COMPLETED;
  if (verification.suggestedNextState === verificationEngine.SUGGESTED_NEXT_STATE.NEEDS_EVIDENCE)
    return TASK_STATUS.NEEDS_EVIDENCE;
  if (verification.suggestedNextState === verificationEngine.SUGGESTED_NEXT_STATE.FAILED) return TASK_STATUS.FAILED;
  if (verification.retryable !== false && Number(task.attempts || 0) < Number(task.maxAttempts || 1)) {
    return TASK_STATUS.RETRY_READY;
  }
  return TASK_STATUS.NEEDS_EVIDENCE;
}

function transitionReasonFromVerification(status, verification = {}) {
  if (status === TASK_STATUS.COMPLETED) {
    return verification.verificationStatus === verificationEngine.VERIFICATION_STATUS.PARTIALLY_VERIFIED
      ? "partial_verification"
      : "verification_passed";
  }
  if (status === TASK_STATUS.RETRY_READY) return "verification_retry";
  if (status === TASK_STATUS.NEEDS_EVIDENCE) return "verification_needs_evidence";
  if (status === TASK_STATUS.BLOCKED) return "verification_blocked";
  if (status === TASK_STATUS.WAITING_HUMAN) return "verification_waiting_human";
  return "verification_failed";
}

function isReadOnlyEvidenceCollectionTask(task = {}) {
  const type = String(task.type || task.taskType || "").toLowerCase();
  const toolWorker = String(task.toolWorker || task.tool_worker || "").toLowerCase();
  if (
    toolWorker === "web" ||
    /^(web_search|web_read|web_fetch|api_read|http_fetch|public_web_read|public_api_read)$/.test(type)
  ) {
    return true;
  }
  if (toolWorker === "browser" || type === "browser") {
    const text = [task.title, task.description, task.prompt, task.input, ...(task.successCriteria || [])]
      .filter(Boolean)
      .join("\n");
    return !/\b(submit|send|apply|publish|pay|payment|delete|login|upload|fill|type|input|write|save|export|提交|发送|申请|发布|支付|删除|登录|上传|填写|输入|写入|保存|导出)\b/i.test(
      text
    );
  }
  return false;
}

function evidenceKindForTask(task = {}) {
  const type = String(task.type || task.taskType || "").toLowerCase();
  const toolWorker = String(task.toolWorker || task.tool_worker || "").toLowerCase();
  if (type === "web_search") return "web_search_result";
  if (type === "api_read" || type === "public_api_read" || type === "http_fetch") return "api_response";
  if (toolWorker === "web" || /^web_/.test(type)) return "web_page";
  if (toolWorker === "browser" || type === "browser") return "browser_observation";
  return "evidence";
}

function evidenceFieldsForKind(kind = "") {
  if (kind === "web_search_result" || kind === "web_page") return ["url", "status", "title", "text", "timestamp"];
  if (kind === "api_response") return ["url", "status", "body", "timestamp"];
  if (kind === "browser_observation") return ["url", "title", "visibleText", "timestamp"];
  return ["summary", "claims", "timestamp"];
}

function markWorkerNeedsEvidence(task, result = {}, context = {}) {
  const kind = evidenceKindForTask(task);
  const description = compactText(
    result.error || result.blockedReason || result.nextStep || "Worker did not produce usable evidence.",
    800
  );
  task.verificationSuggestedNextState = verificationEngine.SUGGESTED_NEXT_STATE.NEEDS_EVIDENCE;
  task.verificationRetryable = false;
  task.verificationReasonCode = "worker_evidence_unavailable";
  task.missingEvidence = [
    {
      id: `${task.id}:missing_evidence:worker`,
      taskId: task.id,
      kind,
      reasonCode: "worker_evidence_unavailable",
      description,
      requiredFields: evidenceFieldsForKind(kind),
      retryable: false,
      sourcePhase: String(context.phase || "worker")
    }
  ];
  task.rejectedEvidence = [
    {
      id: `${task.id}:rejected_evidence:worker`,
      taskId: task.id,
      reasonCode: "worker_evidence_unavailable",
      reason: description,
      severity: "high",
      retryable: false
    }
  ];
}

function registerGoalTasks(goalId, rawTasks = [], options = {}) {
  const goal = ensureGoal(goalId);
  if (options.replace) goal.tasks.clear();
  const created = [];
  if (options.budgetState || options.budget_state) {
    goal.budgetState = budgetGovernor.normalizeGoalBudgetState(options.budgetState || options.budget_state, {
      goalId: goal.goalId,
      startedAt: Date.parse(goal.createdAt) || Date.now()
    });
  }
  if (options.strategyState || options.strategy_state || options.strategy) {
    setGoalStrategy(goal.goalId, options.strategyState || options.strategy_state || options.strategy, {
      source: options.source || "planner",
      reason: options.strategyReason || options.strategy_reason || "strategy provided while registering tasks"
    });
  }
  const strategyExpanded = goal.strategyState
    ? dependencyEngine.expandStrategyApprovalTasks(rawTasks, goal.strategyState, {
        existingTasks: orderedGoalTasks(goal)
      })
    : { tasks: rawTasks, inserted: [] };
  const creationSource = String(options.source || "planner");
  const defaultCreatedByTaskId =
    options.createdByTaskId ||
    options.created_by_task_id ||
    (/^(commander|planner)$/i.test(creationSource) ? "plan" : "");
  const defaultCreatedByTaskTitle =
    options.createdByTaskTitle ||
    options.created_by_task_title ||
    (defaultCreatedByTaskId === "plan" ? "Create execution plan" : "");
  for (const [index, raw] of strategyExpanded.tasks.entries()) {
    const strategy = goal.strategyState;
    const task = normalizeTask(
      strategy
        ? {
            strategyId: strategy.id,
            strategicObjective: strategy.objective,
            strategicPhase: strategy.phasePlan && strategy.phasePlan[0] && strategy.phasePlan[0].id,
            ...raw,
            source: raw.source || creationSource,
            createdByTaskId: raw.createdByTaskId || raw.created_by_task_id || defaultCreatedByTaskId,
            createdByTaskTitle: raw.createdByTaskTitle || raw.created_by_task_title || defaultCreatedByTaskTitle
          }
        : {
            ...raw,
            source: raw.source || creationSource,
            createdByTaskId: raw.createdByTaskId || raw.created_by_task_id || defaultCreatedByTaskId,
            createdByTaskTitle: raw.createdByTaskTitle || raw.created_by_task_title || defaultCreatedByTaskTitle
          },
      goal.goalId,
      index
    );
    if (goal.tasks.has(task.id)) {
      task.id = `${task.id}-${index + 1}`;
    }
    task.history.push({
      from: null,
      to: task.status,
      reason: "task_created",
      at: task.createdAt,
      context: {
        source: creationSource,
        modelPool: task.modelPool,
        difficulty: task.difficulty,
        riskLevel: task.riskLevel,
        requiresHumanApproval: task.requiresHumanApproval,
        approvalStatus: task.approvalStatus,
        createdByTaskId: task.createdByTaskId,
        createdByTaskTitle: task.createdByTaskTitle,
        dependencies: task.dependencies,
        produces: task.produces,
        consumes: task.consumes
      }
    });
    goal.tasks.set(task.id, task);
    created.push(publicTask(task));
  }
  const graphResult = applyGraphValidation(goal, {
    source: options.source || "planner",
    insertedApprovalTasks: strategyExpanded.inserted.map((task) => task.id)
  });
  goal.updatedAt = nowIso();
  saveStore();
  if (graphResult.blocked.length) {
    return created.map((task) => publicTask(goal.tasks.get(task.id) || task));
  }
  return created.map((task) => publicTask(goal.tasks.get(task.id) || task));
}

function nextWaitingTask(goalId) {
  const goal = getGoal(goalId);
  if (!goal) return null;
  const graph = refreshGoalGraph(goalId);
  const next = dependencyEngine.nextReadyTask(orderedGoalTasks(goal), { graph });
  return next ? publicTask(goal.tasks.get(next.task.id) || next.task) : null;
}

function getExecutionGraph(goalId) {
  return refreshGoalGraph(goalId);
}

function readyTasks(goalId) {
  const goal = getGoal(goalId);
  if (!goal) return [];
  refreshGoalGraph(goalId);
  return dependencyEngine
    .readyTasks(orderedGoalTasks(goal))
    .map((item) => publicTask(goal.tasks.get(item.task.id) || item.task));
}

function retryImpactScope(goalId, taskId) {
  const goal = getGoal(goalId);
  if (!goal) return { taskId: String(taskId || ""), retryOnly: [], affectedDownstream: [] };
  return dependencyEngine.retryImpactScope(orderedGoalTasks(goal), taskId);
}

function startTask(goalId, taskId, context = {}) {
  const task = getTask(goalId, taskId);
  if (!task) throw taskError(`Task not found: ${taskId}`, "task_not_found", { goalId, taskId });
  const budget = evaluateTaskBudget(goalId, taskId, {
    ...context,
    phase: context.phase || "before",
    nextAttempt: Number(task.attempts || 0) + 1
  });
  applyBudgetRisk(goalId, taskId, budget.evaluation, context);
  const budgetStatus = budgetGateStatus(budget.evaluation);
  if (budgetStatus) {
    return transitionTask(goalId, taskId, budgetStatus, "budget_blocked_before_worker", {
      ...context,
      budgetEvaluation: budget.evaluation
    });
  }
  const risk = evaluateTaskRisk(goalId, taskId, {
    ...context,
    phase: context.phase || "before",
    nextAttempt: Number(task.attempts || 0) + 1
  });
  const gatedStatus = riskGateStatus(risk.evaluation, risk.task);
  if (gatedStatus) {
    const reason =
      gatedStatus === TASK_STATUS.BLOCKED ? "risk_blocked_before_worker" : "risk_waiting_human_before_worker";
    return transitionTask(goalId, taskId, gatedStatus, reason, {
      ...context,
      riskEvaluation: risk.evaluation
    });
  }
  transitionTask(goalId, taskId, TASK_STATUS.RUNNING, context.reason || "task_started", context);
  const stored = getTask(goalId, taskId);
  stored.attempts += 1;
  stored.updatedAt = nowIso();
  saveStore();
  return publicTask(stored);
}

function normalizeWorkerResult(result = {}) {
  const raw = String(result.status || result.outcome || result.kind || "").toLowerCase();
  let status = raw;
  if (result.ok === true || raw === "ok" || raw === "done" || raw === "completed") status = WORKER_OUTCOME.SUCCESS;
  if (result.ok === false && !status) status = WORKER_OUTCOME.FAILURE;
  if (raw === "failed" || raw === "error") status = WORKER_OUTCOME.FAILURE;
  if (raw === "needs_retry" || raw === "retry_ready") status = WORKER_OUTCOME.RETRY;
  if (raw === "needs_confirmation" || raw === "awaiting-confirmation") status = WORKER_OUTCOME.AWAITING_CONFIRMATION;
  if (!Object.values(WORKER_OUTCOME).includes(status)) status = WORKER_OUTCOME.FAILURE;
  const evidence = workerEvidence.normalizeEvidence(result.evidence, {
    context: result.context || {},
    artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
    actions: Array.isArray(result.actions) ? result.actions : [],
    output: result.output || result.result || result.content || ""
  });
  const evidenceContext = workerEvidence.evidenceToContext(evidence);
  return {
    status,
    actions: Array.isArray(result.actions) ? result.actions : [],
    output: compactText(result.output || result.result || result.content || "", 20000),
    error: compactText(result.error || "", 4000),
    nextStep: result.nextStep || result.next_step || result.next || "",
    artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
    evidence,
    blockedReason: result.blockedReason || result.blocked_reason || "",
    memoryCandidates: Array.isArray(result.memoryCandidates || result.memory_candidates)
      ? result.memoryCandidates || result.memory_candidates
      : [],
    verification: result.verification || null,
    context: {
      ...(result.context || {}),
      ...evidenceContext
    }
  };
}

function applyWorkerResult(goalId, taskId, workerResult, context = {}) {
  const task = getTask(goalId, taskId);
  if (!task) throw taskError(`Task not found: ${taskId}`, "task_not_found", { goalId, taskId });
  if (task.status !== TASK_STATUS.RUNNING) {
    throw taskError(
      `Worker result can only be applied to a running task: ${task.status}`,
      "invalid_worker_result_state",
      {
        goalId,
        taskId,
        status: task.status
      }
    );
  }
  const result = normalizeWorkerResult(workerResult);
  const mergedContext = {
    ...context,
    workerStatus: result.status,
    actions: result.actions,
    nextStep: result.nextStep,
    artifacts: result.artifacts,
    ...(result.context || {})
  };
  const stored = getTask(goalId, taskId);
  stored.result = result.output || stored.result;
  stored.error = result.error || "";
  stored.artifacts = result.artifacts;
  if (result.artifacts && result.artifacts.length) {
    artifactRepository.registerArtifacts(result.artifacts, { goalId, taskId });
  }
  if ((!stored.produces || !stored.produces.length) && result.artifacts && result.artifacts.length) {
    stored.produces = dependencyEngine.normalizeArtifacts(result.artifacts, taskId);
  }
  stored.blockedReason = result.blockedReason || "";

  addTaskBudgetUsage(
    goalId,
    taskId,
    budgetGovernor.usageFromWorkerResult(result, {
      ...context,
      model: context.model || (result.context && result.context.model) || "",
      elapsedMs: context.elapsedMs || context.elapsed_ms || (result.context && result.context.elapsedMs) || 0,
      taskId
    })
  );
  const budget = evaluateTaskBudget(goalId, taskId, {
    ...mergedContext,
    phase: "after",
    budgetPolicy: context.budgetPolicy || context.budget
  });
  applyBudgetRisk(goalId, taskId, budget.evaluation, mergedContext);
  const budgetStatus = budgetGateStatus(budget.evaluation);
  if (budgetStatus) {
    const current = getTask(goalId, taskId);
    current.blockedReason = budget.evaluation.blockedReason || "Budget governor blocked this task.";
    saveStore();
    return transitionTask(goalId, taskId, budgetStatus, "budget_blocked_after_worker", {
      ...mergedContext,
      budgetEvaluation: budget.evaluation
    });
  }

  const risk = evaluateTaskRisk(goalId, taskId, {
    ...context,
    phase: context.phase || "after",
    workerResult: result
  });
  const gatedStatus = riskGateStatus(risk.evaluation, getTask(goalId, taskId));
  if (gatedStatus === TASK_STATUS.BLOCKED) {
    stored.blockedReason =
      risk.evaluation.blockedReason || result.blockedReason || result.error || "risk engine blocked this action";
    return transitionTask(goalId, taskId, TASK_STATUS.BLOCKED, "risk_blocked_after_worker", {
      ...mergedContext,
      riskEvaluation: risk.evaluation
    });
  }
  if (gatedStatus === TASK_STATUS.WAITING_HUMAN) {
    stored.requiresHumanApproval = true;
    stored.requiresHumanConfirmation = true;
    stored.approvalReason = risk.evaluation.approvalReason || "Risk engine requires human approval.";
    stored.approvalStatus = riskEngine.APPROVAL_STATUS.PENDING;
    return transitionTask(goalId, taskId, TASK_STATUS.WAITING_HUMAN, "risk_waiting_human_after_worker", {
      ...mergedContext,
      riskEvaluation: risk.evaluation
    });
  }

  if (result.status === WORKER_OUTCOME.SUCCESS) {
    const verification = result.verification
      ? verificationEngine.compactVerification(result.verification)
      : verificationEngine.verifyTaskResult(getTask(goalId, taskId), result, {
          ...context,
          phase: "after_worker",
          attempts: stored.attempts,
          maxAttempts: stored.maxAttempts
        });
    const verificationApplied = applyVerificationResult(goalId, taskId, verification, {
      ...mergedContext,
      source: "verification_engine"
    });
    const verificationRisk = verificationRiskEvaluation(verificationApplied.verification);
    if (verificationRisk) {
      const appliedRisk = applyRiskEvaluation(goalId, taskId, verificationRisk, {
        ...mergedContext,
        phase: "verification"
      });
      const riskStatus = riskGateStatus(appliedRisk.evaluation, getTask(goalId, taskId));
      if (riskStatus === TASK_STATUS.BLOCKED) {
        const current = getTask(goalId, taskId);
        current.blockedReason =
          appliedRisk.evaluation.blockedReason ||
          verificationApplied.verification.detectedIssues[0]?.issue ||
          "Verification detected risk.";
        saveStore();
        return transitionTask(goalId, taskId, TASK_STATUS.BLOCKED, "verification_blocked", {
          ...mergedContext,
          verification: verificationApplied.verification,
          riskEvaluation: appliedRisk.evaluation
        });
      }
      if (riskStatus === TASK_STATUS.WAITING_HUMAN) {
        const current = getTask(goalId, taskId);
        current.approvalReason = appliedRisk.evaluation.approvalReason || "Verification detected high risk.";
        current.approvalStatus = riskEngine.APPROVAL_STATUS.PENDING;
        current.requiresHumanApproval = true;
        current.requiresHumanConfirmation = true;
        saveStore();
        return transitionTask(goalId, taskId, TASK_STATUS.WAITING_HUMAN, "verification_waiting_human", {
          ...mergedContext,
          verification: verificationApplied.verification,
          riskEvaluation: appliedRisk.evaluation
        });
      }
    }
    const current = getTask(goalId, taskId);
    const nextStatus = nextStatusFromVerification(current, verificationApplied.verification);
    if (nextStatus === TASK_STATUS.RETRY_READY) {
      addTaskBudgetUsage(goalId, taskId, { verificationRetries: 1 });
      const retryBudget = evaluateTaskBudget(goalId, taskId, {
        ...mergedContext,
        phase: "verification_retry",
        budgetPolicy: context.budgetPolicy || context.budget,
        nextAttempt: Number(current.attempts || 0) + 1
      });
      applyBudgetRisk(goalId, taskId, retryBudget.evaluation, mergedContext);
      const retryBudgetStatus = budgetGateStatus(retryBudget.evaluation);
      if (retryBudgetStatus) {
        const blockedTask = getTask(goalId, taskId);
        blockedTask.blockedReason =
          retryBudget.evaluation.blockedReason || "Budget governor blocked verification retry.";
        saveStore();
        return transitionTask(goalId, taskId, retryBudgetStatus, "budget_blocked_verification_retry", {
          ...mergedContext,
          verification: verificationApplied.verification,
          budgetEvaluation: retryBudget.evaluation
        });
      }
    }
    if (nextStatus === TASK_STATUS.BLOCKED) {
      current.blockedReason =
        verificationApplied.verification.detectedIssues[0]?.issue || "Verification blocked task completion.";
      saveStore();
    }
    return transitionTask(
      goalId,
      taskId,
      nextStatus,
      transitionReasonFromVerification(nextStatus, verificationApplied.verification),
      {
        ...mergedContext,
        verification: verificationApplied.verification
      }
    );
  }
  if (result.status === WORKER_OUTCOME.RETRY) {
    return transitionTask(goalId, taskId, TASK_STATUS.RETRY_READY, "worker_requested_retry", mergedContext);
  }
  if (result.status === WORKER_OUTCOME.BLOCKED) {
    stored.blockedReason = result.blockedReason || result.error || "external blocker";
    return transitionTask(goalId, taskId, TASK_STATUS.BLOCKED, "worker_blocked", mergedContext);
  }
  if (result.status === WORKER_OUTCOME.AWAITING_CONFIRMATION) {
    stored.requiresHumanApproval = true;
    stored.requiresHumanConfirmation = true;
    stored.approvalStatus = riskEngine.APPROVAL_STATUS.PENDING;
    return transitionTask(
      goalId,
      taskId,
      TASK_STATUS.AWAITING_CONFIRMATION,
      "worker_requested_human_confirmation",
      mergedContext
    );
  }
  if (stored.attempts < stored.maxAttempts) {
    return transitionTask(goalId, taskId, TASK_STATUS.RETRY_READY, "worker_failed_retry_available", mergedContext);
  }
  if (isReadOnlyEvidenceCollectionTask(stored)) {
    markWorkerNeedsEvidence(stored, result, mergedContext);
    saveStore();
    return transitionTask(goalId, taskId, TASK_STATUS.NEEDS_EVIDENCE, "worker_needs_evidence", mergedContext);
  }
  return transitionTask(goalId, taskId, TASK_STATUS.FAILED, "worker_failed", mergedContext);
}

function scheduleRetry(goalId, taskId, reason = "retry_scheduled", context = {}) {
  const task = getTask(goalId, taskId);
  if (!task) throw taskError(`Task not found: ${taskId}`, "task_not_found", { goalId, taskId });
  addTaskBudgetUsage(goalId, taskId, { retries: 1 });
  const budget = evaluateTaskBudget(goalId, taskId, {
    ...context,
    phase: "retry",
    budgetPolicy: context.budgetPolicy || context.budget,
    nextAttempt: Number(task.attempts || 0) + 1
  });
  applyBudgetRisk(goalId, taskId, budget.evaluation, context);
  const budgetStatus = budgetGateStatus(budget.evaluation);
  if (budgetStatus) {
    const current = getTask(goalId, taskId);
    current.blockedReason = budget.evaluation.blockedReason || "Budget governor blocked retry.";
    saveStore();
    return transitionTask(goalId, taskId, budgetStatus, "budget_blocked_retry", {
      ...context,
      budgetEvaluation: budget.evaluation
    });
  }
  return transitionTask(goalId, taskId, TASK_STATUS.WAITING, reason, context);
}

function confirmTask(goalId, taskId, context = {}) {
  const task = getTask(goalId, taskId);
  if (!task) throw taskError(`Task not found: ${taskId}`, "task_not_found", { goalId, taskId });
  task.approvalStatus = riskEngine.APPROVAL_STATUS.APPROVED;
  task.requiresHumanApproval = false;
  task.requiresHumanConfirmation = false;
  task.approvalReason = task.approvalReason || String(context.reason || "");
  task.updatedAt = nowIso();
  saveStore();
  if (String(task.type || "").toLowerCase() === "human_approval") {
    task.result = task.result || "Human approval recorded.";
    task.verified = true;
    task.verificationStatus = "verified";
    task.verificationConfidence = 1;
    saveStore();
    if (task.status === TASK_STATUS.WAITING) {
      transitionTask(goalId, taskId, TASK_STATUS.WAITING_HUMAN, "human_approval_requested", {
        ...context,
        skipDependencyPropagation: true
      });
    }
    return transitionTask(goalId, taskId, TASK_STATUS.COMPLETED, "human_approval_completed", {
      ...context,
      approvalStatus: task.approvalStatus
    });
  }
  return transitionTask(goalId, taskId, TASK_STATUS.WAITING, "human_confirmed", {
    ...context,
    approvalStatus: task.approvalStatus
  });
}

function rejectTask(goalId, taskId, context = {}) {
  const task = getTask(goalId, taskId);
  if (!task) throw taskError(`Task not found: ${taskId}`, "task_not_found", { goalId, taskId });
  task.approvalStatus = riskEngine.APPROVAL_STATUS.REJECTED;
  task.requiresHumanApproval = false;
  task.requiresHumanConfirmation = false;
  task.blockedReason = String(
    context.reason || task.blockedReason || task.approvalReason || "Human rejected the risk approval request."
  );
  task.updatedAt = nowIso();
  saveStore();
  return transitionTask(goalId, taskId, TASK_STATUS.CANCELED, "human_rejected", {
    ...context,
    approvalStatus: task.approvalStatus
  });
}

function cancelTask(goalId, taskId, context = {}) {
  return transitionTask(goalId, taskId, TASK_STATUS.CANCELED, "task_canceled", context);
}

function deleteTask(goalId, taskId, context = {}) {
  const goal = ensureGoal(goalId);
  const id = String(taskId || "");
  const task = goal.tasks.get(id);
  if (!task) throw taskError(`Task not found: ${taskId}`, "task_not_found", { goalId, taskId });
  if (task.status === TASK_STATUS.RUNNING && !context.force) {
    throw taskError("Running task cannot be deleted before it is stopped.", "task_running", { goalId, taskId });
  }
  const deleted = publicTask(task);
  goal.tasks.delete(id);
  const at = nowIso();
  goal.updatedAt = at;
  const graph = dependencyEngine.buildExecutionGraph(orderedGoalTasks(goal));
  setGraphMetadata(goal, graph);
  saveStore();
  return {
    task: deleted,
    taskId: id,
    deletedAt: at,
    graph,
    tasks: orderedGoalTasks(goal).map(publicTask)
  };
}

function missingWorkerResult(task) {
  return {
    status: WORKER_OUTCOME.FAILURE,
    actions: [],
    output: "",
    error: "executeNextTask requires a real worker function.",
    nextStep: "Provide a worker implementation before executing a task.",
    artifacts: [],
    blockedReason: "Missing worker implementation."
  };
}

async function executeNextTask(goalId, worker, context = {}) {
  const next = nextWaitingTask(goalId);
  if (!next) {
    return { ok: false, reason: "no_waiting_task", task: null };
  }
  if (typeof worker !== "function") {
    return {
      ok: false,
      reason: "worker_required",
      result: missingWorkerResult(next),
      task: next
    };
  }
  const running = startTask(goalId, next.id, { ...context, modelPool: next.modelPool });
  if (running.status !== TASK_STATUS.RUNNING) {
    return {
      ok: false,
      reason: running.status === TASK_STATUS.WAITING_HUMAN ? "waiting_human_approval" : "risk_blocked",
      result: {
        status: running.status === TASK_STATUS.BLOCKED ? WORKER_OUTCOME.BLOCKED : WORKER_OUTCOME.AWAITING_CONFIRMATION,
        actions: [],
        output: running.approvalReason || running.blockedReason || "",
        error: running.blockedReason || "",
        nextStep:
          running.status === TASK_STATUS.WAITING_HUMAN
            ? "Wait for human approval before executing."
            : "Revise the task before retrying.",
        artifacts: [],
        blockedReason: running.blockedReason || "",
        context: { riskEvaluation: running.riskHistory && running.riskHistory[running.riskHistory.length - 1] }
      },
      task: running
    };
  }
  let result;
  try {
    result = await worker(running);
  } catch (err) {
    result = {
      status: WORKER_OUTCOME.FAILURE,
      error: err && err.message ? err.message : String(err),
      actions: [],
      output: ""
    };
  }
  const updated = applyWorkerResult(goalId, next.id, result, context);
  if (updated.status === TASK_STATUS.RETRY_READY) {
    const retryTask = scheduleRetry(goalId, next.id, "retry_ready_requeued", context);
    return { ok: false, result: normalizeWorkerResult(result), task: retryTask };
  }
  return { ok: updated.status === TASK_STATUS.COMPLETED, result: normalizeWorkerResult(result), task: updated };
}

function resetRuntime() {
  loadStore();
  goals.clear();
  saveStore();
}

module.exports = {
  TASK_STATUS,
  WORKER_OUTCOME,
  ALLOWED_TRANSITIONS,
  applyWorkerResult,
  cancelTask,
  confirmTask,
  deleteTask,
  executeNextTask,
  evaluateTaskBudget,
  evaluateTaskRisk,
  ensureGoalBudgetState,
  getExecutionGraph,
  getGoal,
  getGoalBudgetState,
  getGoalStrategy,
  getGoalStrategyHistory,
  getTask,
  getTaskHistory,
  listGoals,
  listTasks,
  nextWaitingTask,
  normalizeTask,
  normalizeWorkerResult,
  publicGoal,
  readyTasks,
  rejectTask,
  registerGoalTasks,
  reloadRuntime,
  resetRuntime,
  retryImpactScope,
  scheduleRetry,
  setGoalStatus,
  setGoalBudgetState,
  setGoalStrategy,
  setStorageFile,
  startTask,
  taskStorePath,
  transitionTask
};
