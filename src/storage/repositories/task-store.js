"use strict";

const { agentRoutePath } = require("../../shared/utils/agent-home");
const { clone, normalizeArray, nowIso, readJsonFile, writeJsonFile } = require("./json-file-store");

function defaultTaskStorePath() {
  return process.env.AGENT_ROUTE_TASKS || agentRoutePath("agent-route-tasks.json");
}

function normalizeGoal(raw = {}) {
  const goalId = String(raw.goalId || raw.goal_id || "default-goal");
  return {
    ...clone(raw),
    goalId,
    createdAt: raw.createdAt || raw.created_at || nowIso(),
    updatedAt: raw.updatedAt || raw.updated_at || nowIso(),
    tasks: normalizeArray(raw.tasks)
  };
}

function loadTaskStore(options = {}) {
  const file = options.file || defaultTaskStorePath();
  const raw = readJsonFile(file, { version: 1, updatedAt: "", goals: [] });
  return {
    version: Number(raw.version || 1),
    updatedAt: raw.updatedAt || raw.updated_at || "",
    goals: normalizeArray(raw.goals).map(normalizeGoal)
  };
}

function saveTaskStore(store = {}, options = {}) {
  const file = options.file || defaultTaskStorePath();
  const goals = normalizeArray(store.goals).map(normalizeGoal);
  writeJsonFile(file, {
    version: Number(store.version || 1),
    updatedAt: options.updatedAt || store.updatedAt || nowIso(),
    goals
  });
}

function mutateTaskStore(mutator, options = {}) {
  const store = loadTaskStore(options);
  const result = mutator(store);
  saveTaskStore(store, options);
  return result;
}

module.exports = {
  defaultTaskStorePath,
  loadTaskStore,
  mutateTaskStore,
  normalizeGoal,
  saveTaskStore
};
