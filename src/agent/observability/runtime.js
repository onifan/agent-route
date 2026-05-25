"use strict";

const { agentRoutePath } = require("../../shared/utils/agent-home");
const { corsHeaders } = require("../../security/cors");
const { eventRepository } = require("../../storage/repositories");
const budgetGovernor = require("../budget");
const evidenceSanitizer = require("../evidence/evidence-sanitizer");

const EVENT_SEVERITY = Object.freeze({
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
  CRITICAL: "critical"
});

const MAX_EVENTS = 3000;
const MAX_FIELD_LENGTH = 1200;
const SENSITIVE_KEY =
  /(authorization|api[_-]?key|token|cookie|password|secret|credential|session|bearer|private[_-]?key)/i;

let storeLoaded = false;
let eventStore = { version: 1, updatedAt: "", events: [] };
let storageFile = process.env.AGENT_ROUTE_OBSERVABILITY || agentRoutePath("agent-route-observability.json");
const listeners = new Set();

function nowIso() {
  return new Date().toISOString();
}

function uid(prefix = "evt") {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function array(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function safeString(value, maxLength = MAX_FIELD_LENGTH) {
  const text = evidenceSanitizer.redactSensitiveText(String(value == null ? "" : value));
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function sanitize(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return safeString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  if (typeof value !== "object") return safeString(value);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      output[key] = "[redacted]";
      continue;
    }
    if (/url$/i.test(key) || key === "url") {
      output[key] = safeString(evidenceSanitizer.sanitizeUrl(item));
      continue;
    }
    if (/path$/i.test(key) || key === "path") {
      output[key] = safeString(evidenceSanitizer.sanitizePathForDisplay(item));
      continue;
    }
    output[key] = sanitize(item, depth + 1);
  }
  return output;
}

function loadStore() {
  if (storeLoaded) return;
  storeLoaded = true;
  if (!storageFile) return;
  try {
    const raw = eventRepository.loadEventStore({ file: storageFile, maxEvents: MAX_EVENTS });
    eventStore = {
      version: 1,
      updatedAt: raw.updatedAt || raw.updated_at || "",
      events: array(raw.events).map(normalizeEvent).slice(-MAX_EVENTS)
    };
  } catch (err) {
    console.warn("[agent-route-observability] failed to load store:", err.message);
  }
}

function saveStore() {
  if (!storageFile) return;
  try {
    eventRepository.saveEventStore(eventStore, {
      file: storageFile,
      maxEvents: MAX_EVENTS,
      updatedAt: nowIso()
    });
  } catch (err) {
    console.warn("[agent-route-observability] failed to save store:", err.message);
  }
}

function setStorageFile(file) {
  storageFile = file ? String(file) : "";
  eventStore = { version: 1, updatedAt: "", events: [] };
  storeLoaded = false;
}

function resetRuntime() {
  loadStore();
  eventStore = { version: 1, updatedAt: nowIso(), events: [] };
  saveStore();
}

function eventSeverity(type, data = {}) {
  const eventType = String(type || "").toLowerCase();
  const riskLevel = String(
    (data.evaluation && data.evaluation.riskLevel) || (data.task && data.task.riskLevel) || ""
  ).toLowerCase();
  const authenticityScore = Number(
    (data.authenticity && data.authenticity.score) || (data.task && data.task.authenticityScore) || 0
  );
  if (riskLevel === "critical") return EVENT_SEVERITY.CRITICAL;
  if (eventType.includes("authenticityblocked") || eventType.includes("authenticity_blocked"))
    return EVENT_SEVERITY.WARN;
  if (
    eventType.includes("authenticitywarning") ||
    eventType.includes("authenticity_warning") ||
    (authenticityScore && authenticityScore < 0.7)
  )
    return EVENT_SEVERITY.WARN;
  if (eventType.includes("correctiveactionsuggested"))
    return data.correctiveSummary && data.correctiveSummary.shouldBlock ? EVENT_SEVERITY.WARN : EVENT_SEVERITY.INFO;
  if (eventType.includes("actionranked"))
    return data.actionDecisionSummary && data.actionDecisionSummary.riskLevel === "critical"
      ? EVENT_SEVERITY.WARN
      : EVENT_SEVERITY.INFO;
  if (eventType.includes("actionlearningupdated")) return EVENT_SEVERITY.INFO;
  if (eventType.includes("decisionattributed")) return EVENT_SEVERITY.INFO;
  if (eventType.includes("error") || eventType.includes("failed")) return EVENT_SEVERITY.ERROR;
  if (eventType.includes("blocked") || eventType.includes("pause") || eventType.includes("rejected"))
    return EVENT_SEVERITY.WARN;
  if (eventType.includes("risk") && ["high", "critical"].includes(riskLevel)) return EVENT_SEVERITY.WARN;
  if (
    eventType.includes("verification") &&
    /unverified|failed|blocked/i.test(JSON.stringify(data.verification || data.task || {}))
  )
    return EVENT_SEVERITY.WARN;
  if (
    eventType.includes("budget") &&
    /warning|degraded|blocked|exhausted/i.test(JSON.stringify(data.evaluation || data.budget || {}))
  )
    return EVENT_SEVERITY.WARN;
  return EVENT_SEVERITY.INFO;
}

function eventMessage(type, data = {}) {
  const task = data.task || {};
  const evaluation = data.evaluation || {};
  const verification = data.verification || {};
  if (data.message) return safeString(data.message, 260);
  if (type === "start") return `Goal started with ${data.commander_model || "agent-auto"}`;
  if (type === "plan") return `Plan produced ${array(data.tasks).length} tasks`;
  if (type === "worker_start") return `Worker started ${task.title || data.model || "task"}`;
  if (type === "worker_done") return `Worker finished ${task.title || task.id || data.model || "task"}`;
  if (type === "verification")
    return `Verification ${verification.verificationStatus || verification.status || task.verificationStatus || "updated"}`;
  if (/^authenticitychecked$/i.test(type))
    return `Authenticity checked ${Number((data.authenticity && data.authenticity.score) || task.authenticityScore || 0).toFixed(2)}`;
  if (/^authenticitywarning$/i.test(type))
    return `Authenticity warning ${Number((data.authenticity && data.authenticity.score) || task.authenticityScore || 0).toFixed(2)}`;
  if (/^authenticityblocked$/i.test(type))
    return `Authenticity blocked ${Number((data.authenticity && data.authenticity.score) || task.authenticityScore || 0).toFixed(2)}`;
  if (/^correctiveactionsuggested$/i.test(type)) {
    const action =
      (data.correctiveSummary && data.correctiveSummary.primaryAction) ||
      array(data.recommendedActions)[0]?.type ||
      "review";
    return `Corrective action suggested ${action}`;
  }
  if (/^actionranked$/i.test(type)) {
    const action =
      (data.actionDecisionSummary && data.actionDecisionSummary.recommendedAction) ||
      (data.recommendedAction && data.recommendedAction.type) ||
      array(data.rankedActions)[0]?.type ||
      "review";
    return `Action ranked ${action}`;
  }
  if (/^actionlearningupdated$/i.test(type)) {
    const learning = data.actionLearning || {};
    return `Action learning updated ${learning.actionType || "action"}`;
  }
  if (/^decisionattributed$/i.test(type)) {
    const attribution = data.decisionAttribution || {};
    return `Decision attributed ${attribution.decisionSource || "system_recommendation"}`;
  }
  if (type === "risk") return `Risk ${evaluation.riskLevel || task.riskLevel || "updated"}`;
  if (type === "budget")
    return `Budget ${evaluation.status || "updated"}${evaluation.degradationLevel ? ` / ${evaluation.degradationLevel}` : ""}`;
  if (type === "strategy") return `Strategy ${data.event || "updated"}`;
  if (type === "graph") return `Graph ${data.event || "updated"}`;
  if (type === "final") return "Final answer emitted";
  if (type === "done") return "Event stream closed";
  return safeString(type || "event", 260);
}

function normalizeEvent(raw = {}) {
  const data = sanitize(raw.data || raw.payload || {});
  const task = data.task || raw.task || {};
  return {
    id: String(raw.id || uid("evt")),
    at: String(raw.at || raw.timestamp || nowIso()),
    type: String(raw.type || raw.event || "event"),
    severity: String(raw.severity || eventSeverity(raw.type || raw.event, data)),
    goalId: String(raw.goalId || raw.goal_id || data.goal_id || data.goalId || task.goalId || task.goal_id || ""),
    taskId: String(raw.taskId || raw.task_id || data.task_id || data.taskId || task.id || ""),
    source: String(raw.source || data.source || "agent-route"),
    phase: String(raw.phase || data.phase || ""),
    model: String(raw.model || data.model || data.source_model || data.commander_model || task.model || ""),
    message: String(raw.message || eventMessage(raw.type || raw.event, data)),
    correlationId: String(
      raw.correlationId || raw.correlation_id || raw.goalId || raw.goal_id || data.goal_id || data.goalId || ""
    ),
    parentEventId: String(raw.parentEventId || raw.parent_event_id || ""),
    previousGoalEventId: String(raw.previousGoalEventId || raw.previous_goal_event_id || ""),
    previousTaskEventId: String(raw.previousTaskEventId || raw.previous_task_event_id || ""),
    data
  };
}

function lastEventFor(goalId, taskId = "") {
  const events = eventStore.events;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (taskId && event.goalId === goalId && event.taskId === taskId) return event;
    if (!taskId && event.goalId === goalId) return event;
  }
  return null;
}

function recordEvent(type, data = {}, options = {}) {
  loadStore();
  const draft = normalizeEvent({
    type,
    data,
    source: options.source || "event-bus",
    goalId: options.goalId || data.goal_id || data.goalId,
    taskId: options.taskId || data.task_id || data.taskId || (data.task && data.task.id),
    phase: options.phase || data.phase,
    model: options.model || data.model,
    severity: options.severity,
    message: options.message
  });
  const previousGoal = draft.goalId ? lastEventFor(draft.goalId) : null;
  const previousTask = draft.goalId && draft.taskId ? lastEventFor(draft.goalId, draft.taskId) : null;
  draft.previousGoalEventId = draft.previousGoalEventId || (previousGoal && previousGoal.id) || "";
  draft.previousTaskEventId = draft.previousTaskEventId || (previousTask && previousTask.id) || "";
  draft.parentEventId = draft.parentEventId || draft.previousTaskEventId || draft.previousGoalEventId || "";
  eventStore.events.push(draft);
  eventStore.events = eventStore.events.slice(-MAX_EVENTS);
  eventStore.updatedAt = nowIso();
  saveStore();
  for (const listener of listeners) {
    try {
      listener(draft);
    } catch {}
  }
  return clone(draft);
}

function listEvents(filter = {}) {
  loadStore();
  const goalId = String(filter.goalId || filter.goal_id || "");
  const taskId = String(filter.taskId || filter.task_id || "");
  const type = String(filter.type || "");
  const severity = String(filter.severity || "");
  const minSeverity = String(filter.minSeverity || filter.min_severity || "");
  const limit = Math.max(1, Math.min(Number(filter.limit || 200), 1000));
  const severityRank = { debug: 0, info: 1, warn: 2, error: 3, critical: 4 };
  return eventStore.events
    .filter((event) => !goalId || event.goalId === goalId)
    .filter((event) => !taskId || event.taskId === taskId)
    .filter((event) => !type || event.type === type)
    .filter((event) => !severity || event.severity === severity)
    .filter((event) => !minSeverity || severityRank[event.severity] >= severityRank[minSeverity])
    .slice(-limit)
    .map(clone)
    .reverse();
}

function clearEvents(filter = {}) {
  loadStore();
  const goalId = String(filter.goalId || filter.goal_id || "");
  const taskId = String(filter.taskId || filter.task_id || "");
  const type = String(filter.type || "");
  const source = String(filter.source || "");
  const types = new Set(array(filter.types || filter.eventTypes || filter.event_types).map((item) => String(item)));
  const before = eventStore.events.length;
  if (!goalId && !taskId && !type && !source && !types.size) {
    eventStore.events = [];
  } else {
    eventStore.events = eventStore.events.filter((event) => {
      if (goalId && event.goalId !== goalId) return true;
      if (taskId && event.taskId !== taskId) return true;
      if (type && event.type !== type) return true;
      if (source && event.source !== source) return true;
      if (types.size && !types.has(event.type)) return true;
      return false;
    });
  }
  eventStore.updatedAt = nowIso();
  saveStore();
  return {
    deleted: before - eventStore.events.length,
    remaining: eventStore.events.length,
    goalId,
    taskId,
    type,
    source,
    types: Array.from(types)
  };
}

function taskRuntime() {
  return require("../tasks");
}

function runtimeGoals(goalId = "") {
  const runtime = taskRuntime();
  if (!goalId) return runtime.listGoals();
  const goal = runtime.getGoal(goalId);
  return goal ? [runtime.publicGoal(goal)] : [];
}

function maxRiskLevel(tasks = []) {
  const rank = { low: 0, medium: 1, high: 2, critical: 3 };
  const levels = tasks.map((task) => String(task.riskLevel || "low").toLowerCase());
  return levels.sort((a, b) => (rank[b] || 0) - (rank[a] || 0))[0] || "low";
}

function taskCounts(tasks = []) {
  const counts = {};
  for (const task of tasks) counts[task.status || "unknown"] = (counts[task.status || "unknown"] || 0) + 1;
  return counts;
}

function isDone(status) {
  return ["completed", "done"].includes(String(status || ""));
}

function isFailed(status) {
  return ["failed", "blocked", "canceled"].includes(String(status || ""));
}

function goalStatusFromTasks(goal = {}, events = []) {
  const tasks = array(goal.tasks);
  const orderedEvents = array(events)
    .slice()
    .sort((a, b) => Date.parse(b.at || 0) - Date.parse(a.at || 0));
  const terminalEvent = orderedEvents.find((event) => {
    const type = String(event.type || "").toLowerCase();
    const status = String(
      (event.data && (event.data.status || event.data.finalStatus || event.data.final_status)) || ""
    ).toLowerCase();
    return type === "error" || (type === "done" && status) || (type === "final" && status);
  });
  if (terminalEvent) {
    const type = String(terminalEvent.type || "").toLowerCase();
    const status = String(
      (terminalEvent.data &&
        (terminalEvent.data.status || terminalEvent.data.finalStatus || terminalEvent.data.final_status)) ||
        ""
    ).toLowerCase();
    if (type === "error") return "failed";
    if (["failed", "blocked", "waiting_human", "awaiting_confirmation", "completed"].includes(status)) return status;
  }
  const latestPause = orderedEvents.find((event) => event.type === "pause");
  if (latestPause) return (latestPause.data && latestPause.data.status) || "paused";
  const storedStatus = String(goal.status || "").toLowerCase();
  if (!tasks.length) {
    if (["failed", "blocked", "waiting_human", "awaiting_confirmation", "completed", "running"].includes(storedStatus))
      return storedStatus;
    return "planning";
  }
  if (tasks.some((task) => task.status === "running")) return "running";
  if (tasks.some((task) => task.status === "waiting_human" || task.status === "awaiting_confirmation"))
    return "waiting_human";
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  if (tasks.every((task) => isDone(task.status))) return "completed";
  if (tasks.every((task) => isDone(task.status) || isFailed(task.status))) return "failed";
  return "waiting";
}

function verificationHealth(tasks = []) {
  const histories = tasks.flatMap((task) =>
    array(task.verificationHistory).map((entry) => ({ ...entry, taskId: task.id }))
  );
  const verified = tasks.filter((task) => task.verificationStatus === "verified").length;
  const partial = tasks.filter((task) => task.verificationStatus === "partially_verified").length;
  const unverified = tasks.filter((task) => task.verificationStatus === "unverified").length;
  const checked = verified + partial + unverified;
  const confidenceValues = tasks.map((task) => Number(task.verificationConfidence || 0)).filter((value) => value > 0);
  const authenticityValues = tasks.map((task) => Number(task.authenticityScore || 0)).filter((value) => value > 0);
  const averageConfidence = confidenceValues.length
    ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
    : 0;
  const averageAuthenticityScore = authenticityValues.length
    ? authenticityValues.reduce((sum, value) => sum + value, 0) / authenticityValues.length
    : 0;
  const authenticityWarnings = tasks.flatMap((task) =>
    array(task.authenticityWarnings).map((warning) => ({
      taskId: task.id,
      title: task.title,
      score: Number(task.authenticityScore || 0),
      warning
    }))
  );
  return {
    checked,
    verified,
    partial,
    unverified,
    passRate: checked ? Number(((verified + partial * 0.5) / checked).toFixed(3)) : 0,
    averageConfidence: Number(averageConfidence.toFixed(3)),
    averageAuthenticityScore: Number(averageAuthenticityScore.toFixed(3)),
    suspiciousAuthenticity: tasks.filter(
      (task) => Number(task.authenticityScore || 0) > 0 && Number(task.authenticityScore || 0) < 0.7
    ).length,
    authenticityWarnings: authenticityWarnings.slice(-20),
    failures: histories.filter(
      (entry) =>
        entry.verificationStatus === "unverified" ||
        entry.suggestedNextState === "failed" ||
        entry.suggestedNextState === "needs_evidence" ||
        entry.suggestedNextState === "blocked"
    ).length,
    latestIssues: histories
      .flatMap((entry) =>
        array(entry.detectedIssues).map((issue) => ({
          taskId: entry.taskId,
          issue: issue.issue || String(issue),
          severity: issue.severity || "medium",
          retryable: issue.retryable !== false
        }))
      )
      .concat(
        authenticityWarnings.map((item) => ({
          taskId: item.taskId,
          issue: item.warning,
          severity: item.score < 0.35 ? "critical" : "high",
          retryable: item.score >= 0.35
        }))
      )
      .slice(-20)
  };
}

function summarizeBudget(tasks = [], goalBudgetState = null) {
  let usage = budgetGovernor.emptyUsage();
  const taskBudgets = [];
  for (const task of tasks) {
    const taskUsage = budgetGovernor.normalizeUsage(task.budgetUsage || task.budget_usage);
    usage = budgetGovernor.addUsage(usage, taskUsage);
    taskBudgets.push({
      taskId: task.id,
      title: task.title,
      status: task.status,
      usage: taskUsage,
      budgetStatus: task.budgetStatus || "ok",
      degradationLevel: task.degradationLevel || "none",
      warnings: task.budgetWarnings || [],
      blockedReason: task.budgetBlockedReason || task.blockedReason || ""
    });
  }
  const goalUsage =
    goalBudgetState && goalBudgetState.usage ? budgetGovernor.normalizeUsage(goalBudgetState.usage) : usage;
  const topTasks = taskBudgets
    .slice()
    .sort((a, b) => {
      const aCost = Number(a.usage.estimatedCostUsd || 0) + Number(a.usage.actualCostUsd || 0);
      const bCost = Number(b.usage.estimatedCostUsd || 0) + Number(b.usage.actualCostUsd || 0);
      return bCost - aCost || Number(b.usage.tokenUsage.total || 0) - Number(a.usage.tokenUsage.total || 0);
    })
    .slice(0, 10);
  return {
    usage: goalUsage,
    remainingBudget: goalBudgetState
      ? budgetGovernor.compactEvaluation(budgetGovernor.evaluateGoalBudget(goalBudgetState, { phase: "monitor" }))
          .remainingBudget
      : {},
    degradationLevel: (goalBudgetState && goalBudgetState.degradationLevel) || "none",
    warnings: taskBudgets.flatMap((task) => task.warnings || []).slice(-30),
    taskBudgets,
    topTasks,
    modelUsage: goalUsage.modelCalls || {}
  };
}

function goalDashboard(goalId = "") {
  const goals = runtimeGoals(goalId);
  const events = listEvents({ goalId, limit: 1000 }).slice().reverse();
  return goals.map((goal) => {
    const tasks = array(goal.tasks);
    const goalEvents = events.filter((event) => !goalId || event.goalId === goal.goalId);
    const counts = taskCounts(tasks);
    const completed = tasks.filter((task) => isDone(task.status)).length;
    const failed = tasks.filter((task) => isFailed(task.status)).length;
    const active = tasks.filter((task) => task.status === "running");
    const blocked = tasks.filter((task) => ["blocked", "waiting_human", "awaiting_confirmation"].includes(task.status));
    const budget = summarizeBudget(tasks, goal.budgetState);
    return {
      goalId: goal.goalId,
      status: goalStatusFromTasks(goal, goalEvents.slice().reverse()),
      currentPhase:
        (goal.strategyState &&
          goal.strategyState.phasePlan &&
          goal.strategyState.phasePlan[0] &&
          goal.strategyState.phasePlan[0].id) ||
        latestPhase(goalEvents),
      progress: tasks.length ? Math.round(((completed + failed) / tasks.length) * 100) : 0,
      activeTasks: active.map((task) => task.id),
      completedTasks: completed,
      blockedTasks: blocked.length,
      retryCount: tasks.reduce((sum, task) => sum + Math.max(0, Number(task.attempts || 0) - 1), 0),
      riskLevel: maxRiskLevel(tasks),
      budget,
      runtimeMs:
        goal.budgetState && goal.budgetState.usage
          ? goal.budgetState.usage.runtimeMs
          : runtimeMs(goal.createdAt, goal.updatedAt),
      verificationHealth: verificationHealth(tasks),
      recentActivityAt: latestActivity(goal, goalEvents),
      currentStrategy: goal.strategyState || null,
      taskCounts: counts,
      latestEvents: goalEvents.slice(-10).reverse()
    };
  });
}

function latestPhase(events = []) {
  const latest = events
    .slice()
    .reverse()
    .find((event) => event.phase || event.type);
  return latest ? latest.phase || latest.type : "";
}

function latestActivity(goal = {}, events = []) {
  const latest = events[events.length - 1];
  return (latest && latest.at) || goal.updatedAt || goal.createdAt || "";
}

function runtimeMs(start, end) {
  const startMs = Date.parse(start || "");
  const endMs = Date.parse(end || "") || Date.now();
  return Number.isFinite(startMs) ? Math.max(0, endMs - startMs) : 0;
}

function taskTimeline(goalId, taskId = "") {
  const runtime = taskRuntime();
  const tasks = taskId ? [runtime.getTask(goalId, taskId)].filter(Boolean) : runtime.listTasks(goalId);
  return tasks.map((task) => {
    const history = array(task.history).map((entry) => ({
      at: entry.at || task.updatedAt,
      kind: "status",
      severity: isFailed(entry.to) ? EVENT_SEVERITY.WARN : EVENT_SEVERITY.INFO,
      from: entry.from,
      to: entry.to,
      reason: entry.reason || "",
      context: sanitize(entry.context || {})
    }));
    const risk = array(task.riskHistory).map((entry) => ({
      at: entry.at || (entry.context && entry.context.at) || task.updatedAt,
      kind: "risk",
      severity:
        entry.riskLevel === "critical"
          ? EVENT_SEVERITY.CRITICAL
          : entry.requiresHumanApproval || entry.blockedReason
            ? EVENT_SEVERITY.WARN
            : EVENT_SEVERITY.INFO,
      riskLevel: entry.riskLevel,
      reason:
        entry.blockedReason || entry.approvalReason || entry.escalationReason || array(entry.riskReasons)[0] || "",
      context: sanitize(entry.context || {})
    }));
    const verification = array(task.verificationHistory).map((entry) => ({
      at: entry.at || (entry.context && entry.context.at) || task.updatedAt,
      kind: "verification",
      severity:
        entry.verificationStatus === "unverified" ||
        entry.suggestedNextState === "needs_evidence" ||
        entry.suggestedNextState === "blocked"
          ? EVENT_SEVERITY.WARN
          : EVENT_SEVERITY.INFO,
      verificationStatus: entry.verificationStatus,
      confidence: Number(entry.confidence || 0),
      reason: array(entry.reasons)[0] || array(entry.detectedIssues)[0]?.issue || "",
      context: sanitize(entry.context || {})
    }));
    const authenticity = array(task.verificationHistory)
      .filter((entry) => entry.authenticityScore != null)
      .map((entry) => ({
        at: entry.at || (entry.context && entry.context.at) || task.updatedAt,
        kind: "authenticity",
        severity: Number(entry.authenticityScore || 0) < 0.7 ? EVENT_SEVERITY.WARN : EVENT_SEVERITY.INFO,
        score: Number(entry.authenticityScore || 0),
        reason: array(entry.authenticityWarnings)[0] || array(entry.authenticityReasons)[0] || "",
        decisionSource: entry.decisionSource || "",
        context: sanitize(entry.context || {})
      }));
    const budget = array(task.budgetHistory).map((entry) => ({
      at: entry.at || (entry.context && entry.context.at) || task.updatedAt,
      kind: "budget",
      severity: entry.blockedReason
        ? EVENT_SEVERITY.WARN
        : entry.status === "warning" || entry.degradationLevel !== "none"
          ? EVENT_SEVERITY.WARN
          : EVENT_SEVERITY.INFO,
      status: entry.status,
      degradationLevel: entry.degradationLevel,
      reason: entry.blockedReason || array(entry.warnings)[0] || "",
      context: sanitize(entry.context || {})
    }));
    const corrective = array(task.correctiveHistory).map((entry) => ({
      at: entry.at || task.updatedAt,
      kind: "corrective",
      severity: entry.summary && entry.summary.shouldBlock ? EVENT_SEVERITY.WARN : EVENT_SEVERITY.INFO,
      action: (entry.summary && entry.summary.primaryAction) || array(entry.recommendedActions)[0]?.type || "",
      priority: (entry.summary && entry.summary.highestPriority) || "",
      reason: array(entry.recommendedActions)[0]?.reason || "",
      context: sanitize(entry.sourceSignals || {})
    }));
    const actionDecision = array(task.actionDecisionHistory).map((entry) => ({
      at: entry.at || task.updatedAt,
      kind: "action_decision",
      severity: entry.summary && entry.summary.riskLevel === "critical" ? EVENT_SEVERITY.WARN : EVENT_SEVERITY.INFO,
      action:
        (entry.summary && entry.summary.recommendedAction) ||
        (entry.recommendedAction && entry.recommendedAction.type) ||
        "",
      score:
        (entry.summary && entry.summary.topScore) || (entry.recommendedAction && entry.recommendedAction.score) || 0,
      reason: (entry.recommendedAction && entry.recommendedAction.reason) || "",
      context: sanitize(entry.sourceSignals || {})
    }));
    const actionLearning = array(task.actionLearningHistory).map((entry) => ({
      at: entry.at || task.updatedAt,
      kind: "action_learning",
      severity: EVENT_SEVERITY.INFO,
      action: entry.actionType || "",
      success: Boolean(entry.success),
      score: (entry.stats && entry.stats.successRate) || 0,
      reason: entry.success ? "learned_success" : "learned_failure",
      context: sanitize({ status: entry.status, cost: entry.cost, durationMs: entry.durationMs })
    }));
    const decisionAttribution = array(task.decisionAttributionHistory).map((entry) => ({
      at: entry.at || task.updatedAt,
      kind: "decision_attribution",
      severity: EVENT_SEVERITY.INFO,
      action: entry.actualAction || "",
      recommendedAction: entry.recommendedAction || "",
      actualAction: entry.actualAction || "",
      decisionSource: entry.decisionSource || "",
      wasOverridden: Boolean(entry.wasOverridden),
      score: Number(entry.attributionScore || 0),
      success: Boolean(entry.success),
      reason: entry.wasOverridden ? "decision_overridden" : "decision_followed",
      context: sanitize({ status: entry.status, reason: entry.reason })
    }));
    const events = listEvents({ goalId, taskId: task.id, limit: 200 }).map((event) => ({
      at: event.at,
      kind: "event",
      severity: event.severity,
      type: event.type,
      reason: event.message,
      eventId: event.id
    }));
    return {
      taskId: task.id,
      title: task.title,
      status: task.status,
      model: task.model || task.modelPool || "",
      executor: task.modelPool || task.type || "",
      timeline: [
        ...history,
        ...risk,
        ...verification,
        ...authenticity,
        ...budget,
        ...corrective,
        ...actionDecision,
        ...actionLearning,
        ...decisionAttribution,
        ...events
      ].sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")))
    };
  });
}

function riskMonitor(goalId = "") {
  const goals = goalId ? goalDashboard(goalId) : goalDashboard();
  const runtime = taskRuntime();
  const tasks = goalId ? runtime.listTasks(goalId) : runtime.listGoals().flatMap((goal) => goal.tasks || []);
  return {
    highRiskTasks: tasks.filter((task) => ["high", "critical"].includes(String(task.riskLevel || "").toLowerCase())),
    waitingHuman: tasks.filter(
      (task) => task.status === "waiting_human" || task.status === "awaiting_confirmation" || task.requiresHumanApproval
    ),
    escalations: tasks
      .flatMap((task) =>
        array(task.riskHistory)
          .filter((entry) => entry.escalationReason)
          .map((entry) => ({ taskId: task.id, title: task.title, ...entry }))
      )
      .slice(-50),
    blockedDangerousActions: tasks.filter(
      (task) => task.blockedReason && /risk|danger|delete|submit|shell|verification/i.test(task.blockedReason)
    ),
    repeatedDangerousRetries: tasks.filter(
      (task) =>
        Number(task.attempts || 0) > 2 && ["high", "critical"].includes(String(task.riskLevel || "").toLowerCase())
    ),
    goalRisk: goals.map((goal) => ({ goalId: goal.goalId, riskLevel: goal.riskLevel, blockedTasks: goal.blockedTasks }))
  };
}

function verificationMonitor(goalId = "") {
  const runtime = taskRuntime();
  const tasks = goalId ? runtime.listTasks(goalId) : runtime.listGoals().flatMap((goal) => goal.tasks || []);
  const health = verificationHealth(tasks);
  const histories = tasks.flatMap((task) =>
    array(task.verificationHistory).map((entry) => ({
      taskId: task.id,
      title: task.title,
      model: task.model || task.modelPool,
      ...entry
    }))
  );
  return {
    ...health,
    falseSuccessDetected: histories.filter(
      (entry) =>
        entry.verificationStatus === "unverified" && /success|completed|done/i.test(JSON.stringify(entry.context || {}))
    ).length,
    authenticityWarnings: health.authenticityWarnings || [],
    suspiciousAuthenticity: health.suspiciousAuthenticity || 0,
    averageAuthenticityScore: health.averageAuthenticityScore || 0,
    retryAfterVerification: tasks.filter(
      (task) => task.status === "retry_ready" && /verification/i.test(JSON.stringify(task.history || []))
    ).length,
    lowConfidenceTasks: tasks.filter(
      (task) => task.verificationStatus && Number(task.verificationConfidence || 0) < 0.6
    ),
    semanticIssues: histories.flatMap((entry) =>
      array(entry.detectedIssues)
        .filter((issue) => /semantic|quality|empty|hallucinat|criteria/i.test(issue.issue || ""))
        .map((issue) => ({ taskId: entry.taskId, title: entry.title, issue }))
    ),
    histories: histories.slice(-80)
  };
}

function workerHealth(goalId = "") {
  const events = listEvents({ goalId, limit: 1000 }).slice().reverse();
  const groups = new Map();
  const starts = new Map();
  for (const event of events) {
    if (event.type === "worker_start") {
      const taskId = event.taskId || (event.data && event.data.task && event.data.task.id) || "";
      if (taskId) starts.set(taskId, event);
    }
    if (event.type !== "worker_done") continue;
    const task = (event.data && event.data.task) || {};
    const model = event.model || (event.data && event.data.model) || task.model || task.modelPool || "unknown";
    if (!groups.has(model)) {
      groups.set(model, {
        model,
        total: 0,
        success: 0,
        failed: 0,
        blocked: 0,
        retries: 0,
        crashes: 0,
        totalRuntimeMs: 0,
        verificationPasses: 0,
        verificationFailures: 0,
        hallucinationSignals: 0,
        estimatedCostUsd: 0
      });
    }
    const item = groups.get(model);
    item.total += 1;
    if (event.data && event.data.ok) item.success += 1;
    else item.failed += 1;
    if (task.status === "blocked") item.blocked += 1;
    if (task.status === "retry_ready") item.retries += 1;
    if (event.data && event.data.error) item.crashes += 1;
    item.totalRuntimeMs += Number((event.data && event.data.elapsedMs) || 0);
    const verification = task.verificationStatus || "";
    if (verification === "verified" || verification === "partially_verified") item.verificationPasses += 1;
    if (verification === "unverified") item.verificationFailures += 1;
    if (/hallucinat|fake|unsupported|insufficient evidence/i.test(JSON.stringify(task.detectedIssues || [])))
      item.hallucinationSignals += 1;
    const budgetUsage = budgetGovernor.normalizeUsage(task.budgetUsage || {});
    item.estimatedCostUsd += Number(budgetUsage.estimatedCostUsd || 0);
    const start = starts.get(task.id);
    if (start && !event.parentEventId) event.parentEventId = start.id;
  }
  return [...groups.values()]
    .map((item) => ({
      ...item,
      successRate: item.total ? Number((item.success / item.total).toFixed(3)) : 0,
      failureRate: item.total ? Number((item.failed / item.total).toFixed(3)) : 0,
      verificationPassRate:
        item.verificationPasses + item.verificationFailures
          ? Number((item.verificationPasses / (item.verificationPasses + item.verificationFailures)).toFixed(3))
          : 0,
      averageRuntimeMs: item.total ? Math.round(item.totalRuntimeMs / item.total) : 0,
      averageCostUsd: item.total ? Number((item.estimatedCostUsd / item.total).toFixed(6)) : 0
    }))
    .sort((a, b) => b.failed - a.failed || b.total - a.total);
}

function strategyAnalytics(goalId = "") {
  const goals = runtimeGoals(goalId);
  return goals.map((goal) => {
    const tasks = array(goal.tasks);
    const strategy = goal.strategyState || {};
    return {
      goalId: goal.goalId,
      strategyId: strategy.id || "",
      version: strategy.version || 0,
      status: strategy.status || "",
      revisionCount: array(goal.strategyHistory).filter((item) => item.event === "strategy_revised").length,
      successRate: tasks.length
        ? Number((tasks.filter((task) => isDone(task.status)).length / tasks.length).toFixed(3))
        : 0,
      riskDistribution: tasks.reduce((acc, task) => {
        const level = task.riskLevel || "low";
        acc[level] = (acc[level] || 0) + 1;
        return acc;
      }, {}),
      budgetEfficiency: summarizeBudget(tasks, goal.budgetState).usage,
      phasePlan: strategy.phasePlan || [],
      stopConditions: strategy.stopConditions || [],
      latestRevisionReason: strategy.revisionReason || ""
    };
  });
}

function diagnostics(goalId = "") {
  const runtime = taskRuntime();
  const goals = runtimeGoals(goalId);
  return goals.map((goal) => {
    const tasks = array(goal.tasks);
    const reasons = [];
    const failedTasks = tasks.filter((task) => isFailed(task.status) || task.status === "retry_ready");
    const needsEvidence = tasks.filter((task) => task.status === "needs_evidence");
    const verificationFailures = tasks.filter(
      (task) => task.verificationStatus === "unverified" && task.status !== "needs_evidence"
    );
    const budgetBlocked = tasks.filter(
      (task) => task.budgetBlockedReason || task.budgetStatus === "blocked" || task.budgetStatus === "exhausted"
    );
    const riskBlocked = tasks.filter((task) => task.blockedReason && /risk|approval|danger/i.test(task.blockedReason));
    const graph = goal.goalId ? runtime.getExecutionGraph(goal.goalId) : { blockedChains: [] };
    if (verificationFailures.length)
      reasons.push({
        code: "verification_failed",
        message: `${verificationFailures.length} task(s) failed verification`,
        taskIds: verificationFailures.map((task) => task.id)
      });
    if (needsEvidence.length)
      reasons.push({
        code: "needs_evidence",
        message: `${needsEvidence.length} task(s) need additional evidence`,
        taskIds: needsEvidence.map((task) => task.id)
      });
    if (budgetBlocked.length)
      reasons.push({
        code: "budget_exceeded",
        message: `${budgetBlocked.length} task(s) blocked by budget`,
        taskIds: budgetBlocked.map((task) => task.id)
      });
    if (riskBlocked.length)
      reasons.push({
        code: "risk_blocked",
        message: `${riskBlocked.length} task(s) blocked by risk`,
        taskIds: riskBlocked.map((task) => task.id)
      });
    if (array(graph.blockedChains).length)
      reasons.push({
        code: "dependency_blocked",
        message: `${array(graph.blockedChains).length} dependency chain(s) blocked`,
        chains: graph.blockedChains
      });
    if (failedTasks.some((task) => Number(task.attempts || 0) >= Number(task.maxAttempts || 1)))
      reasons.push({
        code: "retry_exhausted",
        message: "One or more tasks exhausted retry budget",
        taskIds: failedTasks
          .filter((task) => Number(task.attempts || 0) >= Number(task.maxAttempts || 1))
          .map((task) => task.id)
      });
    return {
      goalId: goal.goalId,
      status: goalStatusFromTasks(goal, listEvents({ goalId: goal.goalId, limit: 100 })),
      rootCauses: reasons,
      summary: reasons.length
        ? `Goal has ${reasons.length} observable blocker category/categories.`
        : "No major blocker detected.",
      suggestedNextAction: reasons[0] ? suggestionForReason(reasons[0].code) : "Continue monitoring ready tasks."
    };
  });
}

function suggestionForReason(code) {
  if (code === "verification_failed") return "Inspect task evidence and retry only after changing the approach.";
  if (code === "budget_exceeded") return "Reduce scope, downgrade models, or request human budget approval.";
  if (code === "risk_blocked") return "Wait for human approval or revise the task to avoid risky side effects.";
  if (code === "dependency_blocked") return "Fix or rerun the upstream dependency before downstream work continues.";
  if (code === "retry_exhausted") return "Stop retrying and revise strategy or task graph.";
  return "Review the latest event chain.";
}

function trace(goalId, taskId = "") {
  const events = listEvents({ goalId, taskId, limit: 1000 }).slice().reverse();
  const timelines = taskTimeline(goalId, taskId);
  return {
    goalId,
    taskId,
    events,
    timelines,
    chain: events.map((event) => ({
      id: event.id,
      at: event.at,
      type: event.type,
      severity: event.severity,
      taskId: event.taskId,
      message: event.message,
      parentEventId: event.parentEventId,
      previousGoalEventId: event.previousGoalEventId,
      previousTaskEventId: event.previousTaskEventId
    }))
  };
}

function metrics(goalId = "") {
  const goals = goalDashboard(goalId);
  const allTasks = goals.flatMap((goal) => taskRuntime().listTasks(goal.goalId));
  const completedGoals = goals.filter((goal) => goal.status === "completed").length;
  const failedGoals = goals.filter((goal) => ["failed", "blocked"].includes(goal.status)).length;
  const totalCost = goals.reduce(
    (sum, goal) => sum + Number(goal.budget.usage.estimatedCostUsd || 0) + Number(goal.budget.usage.actualCostUsd || 0),
    0
  );
  const totalRetries = allTasks.reduce((sum, task) => sum + Math.max(0, Number(task.attempts || 0) - 1), 0);
  const totalRuntime = allTasks.reduce(
    (sum, task) => sum + runtimeMs(task.startedAt || task.createdAt, task.finishedAt || task.updatedAt),
    0
  );
  const verification = verificationHealth(allTasks);
  return {
    goalSuccessRate: goals.length ? Number((completedGoals / goals.length).toFixed(3)) : 0,
    goalFailureRate: goals.length ? Number((failedGoals / goals.length).toFixed(3)) : 0,
    averageRetriesPerGoal: goals.length ? Number((totalRetries / goals.length).toFixed(3)) : 0,
    averageCostPerGoalUsd: goals.length ? Number((totalCost / goals.length).toFixed(6)) : 0,
    averageTaskRuntimeMs: allTasks.length ? Math.round(totalRuntime / allTasks.length) : 0,
    verificationFailureRate: verification.checked
      ? Number((verification.unverified / verification.checked).toFixed(3))
      : 0,
    riskEscalationRate: allTasks.length
      ? Number(
          (
            allTasks.filter(
              (task) => task.escalationReason || array(task.riskHistory).some((entry) => entry.escalationReason)
            ).length / allTasks.length
          ).toFixed(3)
        )
      : 0,
    workerHealth: workerHealth(goalId),
    modelEfficiency: workerHealth(goalId).map((item) => ({
      model: item.model,
      successRate: item.successRate,
      averageCostUsd: item.averageCostUsd,
      verificationPassRate: item.verificationPassRate
    }))
  };
}

function memoryCandidatesFromMonitoring(snapshot = {}) {
  const candidates = [];
  for (const worker of array(snapshot.workerHealth)) {
    if (worker.total >= 3 && worker.verificationPassRate < 0.5) {
      candidates.push({
        type: "procedure",
        importance: 4,
        title: `Worker instability: ${worker.model}`,
        summary: `${worker.model} has low verification pass rate (${Math.round(worker.verificationPassRate * 100)}%) across ${worker.total} observed task(s). Prefer safer routing or extra verification for similar tasks.`,
        tags: ["observability", "worker-health", "verification"]
      });
    }
  }
  const diagnosticsList = array(snapshot.diagnostics);
  for (const item of diagnosticsList) {
    for (const reason of array(item.rootCauses)) {
      if (reason.code === "dependency_blocked" || reason.code === "verification_failed") {
        candidates.push({
          type: "episodic",
          importance: 3,
          title: `Goal blocker: ${reason.code}`,
          summary: `Goal ${item.goalId} was blocked by ${reason.message}. Suggested next action: ${item.suggestedNextAction}`,
          tags: ["observability", "diagnostic", reason.code]
        });
      }
    }
  }
  return candidates.slice(0, 10);
}

function snapshot(options = {}) {
  const goalId = String(options.goalId || options.goal_id || "");
  const taskId = String(options.taskId || options.task_id || "");
  const dashboard = goalDashboard(goalId);
  const data = {
    generatedAt: nowIso(),
    goalId,
    taskId,
    goals: dashboard,
    taskTimelines: goalId ? taskTimeline(goalId, taskId) : [],
    eventTimeline: listEvents({ goalId, taskId, limit: options.limit || 200 }),
    budgetMonitor: goalId
      ? summarizeBudget(taskRuntime().listTasks(goalId), taskRuntime().getGoalBudgetState(goalId))
      : {
          usage: dashboard.reduce(
            (usage, goal) => budgetGovernor.addUsage(usage, goal.budget.usage),
            budgetGovernor.emptyUsage()
          ),
          topTasks: dashboard.flatMap((goal) => goal.budget.topTasks).slice(0, 10)
        },
    riskMonitor: riskMonitor(goalId),
    verificationMonitor: verificationMonitor(goalId),
    workerHealth: workerHealth(goalId),
    strategyAnalytics: strategyAnalytics(goalId),
    dependencyGraph: goalId ? taskRuntime().getExecutionGraph(goalId) : null,
    diagnostics: diagnostics(goalId),
    trace: goalId ? trace(goalId, taskId) : { events: [], timelines: [], chain: [] },
    metrics: metrics(goalId)
  };
  data.generatedMemoryCandidates = memoryCandidatesFromMonitoring(data);
  return data;
}

function streamEvents(options = {}) {
  const goalId = String(options.goalId || options.goal_id || "");
  const taskId = String(options.taskId || options.task_id || "");
  const replay = Number(options.replay || 50);
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat = null;
  let listener = null;
  const cleanup = () => {
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    if (listener) listeners.delete(listener);
    listener = null;
  };
  return new Response(
    new ReadableStream({
      start(controller) {
        const writeEvent = (event) => {
          if (closed) return;
          if (goalId && event.goalId !== goalId) return;
          if (taskId && event.taskId !== taskId) return;
          try {
            controller.enqueue(encoder.encode(`event: observability\ndata: ${JSON.stringify(event)}\n\n`));
          } catch {
            cleanup();
          }
        };
        for (const event of listEvents({ goalId, taskId, limit: replay }).slice().reverse()) writeEvent(event);
        heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(": observability heartbeat\n\n"));
          } catch {
            cleanup();
          }
        }, 5000);
        listener = (event) => writeEvent(event);
        listeners.add(listener);
      },
      cancel() {
        cleanup();
      }
    }),
    {
      headers: corsHeaders(options.request || options.origin || null, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      })
    }
  );
}

module.exports = {
  EVENT_SEVERITY,
  clearEvents,
  diagnostics,
  goalDashboard,
  listEvents,
  memoryCandidatesFromMonitoring,
  metrics,
  recordEvent,
  resetRuntime,
  riskMonitor,
  setStorageFile,
  snapshot,
  strategyAnalytics,
  streamEvents,
  taskTimeline,
  trace,
  verificationMonitor,
  workerHealth
};
