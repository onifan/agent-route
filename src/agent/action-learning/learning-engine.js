"use strict";

const store = require("./learning-store");
const { aggregateActionStats, summarizeLearning } = require("./learning-metrics");
const { normalizeLearningRecord } = require("./learning-normalizer");

function recordActionOutcome(input = {}) {
  const record = store.recordAction(input);
  const status = getActionLearningStatus({ limit: 500 });
  return {
    at: record.at || record.timestamp,
    record,
    stats: status.actionStats[record.actionType] || null,
    summary: status.summary
  };
}

function getActionStats(filter = {}) {
  return aggregateActionStats(store.listActionRecords(filter));
}

function getActionLearningStatus(filter = {}) {
  const records = store.listActionRecords(filter);
  const summary = summarizeLearning(records);
  return {
    at: new Date().toISOString(),
    records,
    summary,
    actionStats: summary.actionStats,
    recentActions: summary.recentActions
  };
}

function resetActionLearning(filter = {}) {
  return store.clearActionRecords(filter);
}

module.exports = {
  getActionLearningStatus,
  getActionStats,
  normalizeLearningRecord,
  recordActionOutcome,
  resetActionLearning,
  setStorageFile: store.setStorageFile
};
