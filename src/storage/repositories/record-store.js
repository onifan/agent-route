"use strict";

const { agentRoutePath } = require("../../shared/utils/agent-home");
const { clone, normalizeArray, nowIso, readJsonFile, writeJsonFile } = require("./json-file-store");

function recordStorePath(name, envName = "") {
  return envName && process.env[envName] ? process.env[envName] : agentRoutePath(`agent-route-${name}.json`);
}

function loadRecordStore({ file, collection = "records" } = {}) {
  const raw = readJsonFile(file, { version: 1, updatedAt: "", [collection]: [] });
  return {
    version: Number(raw.version || 1),
    updatedAt: raw.updatedAt || raw.updated_at || "",
    [collection]: normalizeArray(raw[collection] || raw.records)
  };
}

function saveRecordStore(store = {}, { file, collection = "records", maxRecords = 1000 } = {}) {
  writeJsonFile(file, {
    version: Number(store.version || 1),
    updatedAt: store.updatedAt || nowIso(),
    [collection]: normalizeArray(store[collection]).slice(-maxRecords)
  });
}

function appendRecord(record = {}, options = {}) {
  const collection = options.collection || "records";
  const store = loadRecordStore(options);
  const list = normalizeArray(store[collection]);
  const next = {
    id: String(record.id || `${collection}_${Date.now()}_${Math.random().toString(16).slice(2)}`),
    at: record.at || record.createdAt || nowIso(),
    ...clone(record)
  };
  list.push(next);
  store[collection] = list;
  store.updatedAt = nowIso();
  saveRecordStore(store, options);
  return clone(next);
}

function listRecords(filter = {}, options = {}) {
  const collection = options.collection || "records";
  const goalId = String(filter.goalId || filter.goal_id || "");
  const taskId = String(filter.taskId || filter.task_id || "");
  const limit = Math.max(1, Math.min(Number(filter.limit || 200), Number(options.maxRecords || 1000)));
  return normalizeArray(loadRecordStore(options)[collection])
    .filter((record) => !goalId || record.goalId === goalId || record.goal_id === goalId)
    .filter((record) => !taskId || record.taskId === taskId || record.task_id === taskId)
    .slice(-limit)
    .map(clone)
    .reverse();
}

function clearRecords(filter = {}, options = {}) {
  const collection = options.collection || "records";
  const store = loadRecordStore(options);
  const goalId = String(filter.goalId || filter.goal_id || "");
  const taskId = String(filter.taskId || filter.task_id || "");
  const before = normalizeArray(store[collection]).length;
  if (!goalId && !taskId) {
    store[collection] = [];
  } else {
    store[collection] = normalizeArray(store[collection]).filter((record) => {
      if (goalId && record.goalId !== goalId && record.goal_id !== goalId) return true;
      if (taskId && record.taskId !== taskId && record.task_id !== taskId) return true;
      return false;
    });
  }
  store.updatedAt = nowIso();
  saveRecordStore(store, options);
  return { deleted: before - store[collection].length, remaining: store[collection].length };
}

module.exports = {
  appendRecord,
  clearRecords,
  listRecords,
  loadRecordStore,
  recordStorePath,
  saveRecordStore
};
