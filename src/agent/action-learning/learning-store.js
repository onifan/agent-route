"use strict";

const { agentRoutePath } = require("../../shared/utils/agent-home");
const { appendRecord, clearRecords, listRecords, recordStorePath } = require("../../storage/repositories/record-store");
const { normalizeLearningRecord } = require("./learning-normalizer");

const COLLECTION = "records";
let storageFile =
  process.env.AGENT_ROUTE_ACTION_LEARNING ||
  recordStorePath("action-learning", "AGENT_ROUTE_ACTION_LEARNING") ||
  agentRoutePath("agent-route-action-learning.json");

function setStorageFile(file) {
  storageFile = file ? String(file) : "";
}

function storeOptions() {
  return {
    file: storageFile,
    collection: COLLECTION,
    maxRecords: 5000
  };
}

function recordAction(record = {}) {
  return appendRecord(normalizeLearningRecord(record), storeOptions());
}

function listActionRecords(filter = {}) {
  const records = listRecords(filter, storeOptions());
  const actionType = String(filter.actionType || filter.action_type || "").trim();
  const taskType = String(filter.taskType || filter.task_type || "").trim();
  const goalType = String(filter.goalType || filter.goal_type || "").trim();
  return records
    .filter((record) => !actionType || record.actionType === actionType || record.action_type === actionType)
    .filter((record) => !taskType || record.taskType === taskType || record.task_type === taskType)
    .filter((record) => !goalType || record.goalType === goalType || record.goal_type === goalType);
}

function clearActionRecords(filter = {}) {
  return clearRecords(filter, storeOptions());
}

module.exports = {
  clearActionRecords,
  listActionRecords,
  recordAction,
  setStorageFile
};
