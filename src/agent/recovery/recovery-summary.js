"use strict";

function nowIso() {
  return new Date().toISOString();
}

function emptyRecoverySummary(input = {}) {
  return {
    version: 1,
    at: input.at || nowIso(),
    trigger: String(input.trigger || "manual"),
    scannedGoals: 0,
    scannedTasks: 0,
    recoveredTasks: 0,
    recoveredGoals: 0,
    interruptedTasks: 0,
    staleBrowserSessions: 0,
    workerLost: 0,
    warnings: [],
    errors: [],
    actionsRecommended: [],
    tasks: [],
    goals: []
  };
}

function addUnique(list, value, limit = 50) {
  const text = String(value || "").trim();
  if (!text || list.includes(text)) return;
  list.push(text);
  if (list.length > limit) list.splice(0, list.length - limit);
}

function summarizeRecovery(summary = {}) {
  const out = {
    ...emptyRecoverySummary(summary),
    ...summary
  };
  out.warnings = Array.isArray(out.warnings) ? out.warnings.slice(-50) : [];
  out.errors = Array.isArray(out.errors) ? out.errors.slice(-50) : [];
  out.actionsRecommended = Array.isArray(out.actionsRecommended) ? out.actionsRecommended.slice(-50) : [];
  out.tasks = Array.isArray(out.tasks) ? out.tasks.slice(-200) : [];
  out.goals = Array.isArray(out.goals) ? out.goals.slice(-100) : [];
  return out;
}

module.exports = {
  addUnique,
  emptyRecoverySummary,
  summarizeRecovery
};
