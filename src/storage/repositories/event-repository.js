"use strict";

const { agentRoutePath } = require("../../shared/utils/agent-home");
const { clone, normalizeArray, nowIso, readJsonFile, writeJsonFile } = require("./json-file-store");

const DEFAULT_MAX_EVENTS = 3000;

function defaultEventStorePath() {
  return process.env.AGENT_ROUTE_OBSERVABILITY || agentRoutePath("agent-route-observability.json");
}

function loadEventStore(options = {}) {
  const file = options.file || defaultEventStorePath();
  const maxEvents = Math.max(1, Number(options.maxEvents || DEFAULT_MAX_EVENTS));
  const raw = readJsonFile(file, { version: 1, updatedAt: "", events: [] });
  return {
    version: Number(raw.version || 1),
    updatedAt: raw.updatedAt || raw.updated_at || "",
    events: normalizeArray(raw.events).slice(-maxEvents)
  };
}

function saveEventStore(store = {}, options = {}) {
  const file = options.file || defaultEventStorePath();
  const maxEvents = Math.max(1, Number(options.maxEvents || DEFAULT_MAX_EVENTS));
  writeJsonFile(file, {
    version: Number(store.version || 1),
    updatedAt: options.updatedAt || store.updatedAt || nowIso(),
    events: normalizeArray(store.events).slice(-maxEvents)
  });
}

function listEvents(filter = {}, options = {}) {
  const goalId = String(filter.goalId || filter.goal_id || "");
  const taskId = String(filter.taskId || filter.task_id || "");
  const type = String(filter.type || "");
  const limit = Math.max(1, Math.min(Number(filter.limit || 200), 1000));
  return loadEventStore(options)
    .events.filter((event) => !goalId || event.goalId === goalId || event.goal_id === goalId)
    .filter((event) => !taskId || event.taskId === taskId || event.task_id === taskId)
    .filter((event) => !type || event.type === type || event.event === type)
    .slice(-limit)
    .map(clone)
    .reverse();
}

function recordEvent(event = {}, options = {}) {
  const store = loadEventStore(options);
  const next = {
    id: String(event.id || `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`),
    at: event.at || event.timestamp || nowIso(),
    type: String(event.type || event.event || "event"),
    ...clone(event)
  };
  store.events.push(next);
  store.updatedAt = nowIso();
  saveEventStore(store, options);
  return clone(next);
}

function clearEvents(filter = {}, options = {}) {
  const store = loadEventStore(options);
  const goalId = String(filter.goalId || filter.goal_id || "");
  const taskId = String(filter.taskId || filter.task_id || "");
  const before = store.events.length;
  store.events = store.events.filter((event) => {
    if (goalId && event.goalId !== goalId && event.goal_id !== goalId) return true;
    if (taskId && event.taskId !== taskId && event.task_id !== taskId) return true;
    return false;
  });
  if (!goalId && !taskId) store.events = [];
  saveEventStore(store, options);
  return { deleted: before - store.events.length, remaining: store.events.length, goalId, taskId };
}

module.exports = {
  clearEvents,
  defaultEventStorePath,
  listEvents,
  loadEventStore,
  recordEvent,
  saveEventStore
};
