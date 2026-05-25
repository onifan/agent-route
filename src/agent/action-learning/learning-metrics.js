"use strict";

const { normalizeLearningRecord, number } = require("./learning-normalizer");

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(Number(value || 0) * scale) / scale;
}

function emptyStats(actionType = "") {
  return {
    actionType,
    runs: 0,
    success: 0,
    failure: 0,
    successRate: 0,
    systemRuns: 0,
    systemSuccess: 0,
    systemSuccessRate: 0,
    overrideRuns: 0,
    overrideSuccess: 0,
    overrideSuccessRate: 0,
    humanRuns: 0,
    humanSuccess: 0,
    humanSuccessRate: 0,
    avgCost: 0,
    avgDuration: 0,
    avgRetryCount: 0,
    avgAuthenticityScore: 0,
    avgAttributionScore: 0,
    latestAt: ""
  };
}

function finalizeStats(stats = {}) {
  if (!stats.runs) return stats;
  stats.failure = Math.max(0, stats.runs - stats.success);
  stats.successRate = round(stats.success / stats.runs);
  stats.systemSuccessRate = stats.systemRuns ? round(stats.systemSuccess / stats.systemRuns) : 0;
  stats.overrideSuccessRate = stats.overrideRuns ? round(stats.overrideSuccess / stats.overrideRuns) : 0;
  stats.humanSuccessRate = stats.humanRuns ? round(stats.humanSuccess / stats.humanRuns) : 0;
  stats.avgCost = round(stats.avgCost / stats.runs);
  stats.avgDuration = round(stats.avgDuration / stats.runs);
  stats.avgRetryCount = round(stats.avgRetryCount / stats.runs);
  stats.avgAuthenticityScore = round(stats.avgAuthenticityScore / stats.runs);
  stats.avgAttributionScore = round(stats.avgAttributionScore / stats.runs);
  return stats;
}

function aggregateActionStats(records = []) {
  const byAction = new Map();
  for (const raw of records) {
    const record = normalizeLearningRecord(raw);
    const stats = byAction.get(record.actionType) || emptyStats(record.actionType);
    stats.runs += 1;
    if (record.success) stats.success += 1;
    if (record.decisionSource === "system_recommendation" && !record.wasOverridden) {
      stats.systemRuns += 1;
      if (record.success) stats.systemSuccess += 1;
    }
    if (record.wasOverridden || record.decisionSource === "user_override") {
      stats.overrideRuns += 1;
      if (record.success) stats.overrideSuccess += 1;
    }
    if (record.decisionSource === "human_review") {
      stats.humanRuns += 1;
      if (record.success) stats.humanSuccess += 1;
    }
    stats.avgCost += number(record.cost, 0);
    stats.avgDuration += number(record.durationMs || record.duration, 0);
    stats.avgRetryCount += number(record.retryCount, 0);
    stats.avgAuthenticityScore += number(record.authenticityScore, 0);
    stats.avgAttributionScore += number(record.attributionScore, 0);
    stats.latestAt =
      !stats.latestAt || String(record.timestamp || record.at || "").localeCompare(stats.latestAt) > 0
        ? record.timestamp || record.at || ""
        : stats.latestAt;
    byAction.set(record.actionType, stats);
  }
  const actionStats = {};
  for (const [actionType, stats] of byAction.entries()) {
    actionStats[actionType] = finalizeStats(stats);
  }
  return actionStats;
}

function summarizeLearning(records = []) {
  const normalized = records.map(normalizeLearningRecord);
  const actionStats = aggregateActionStats(normalized);
  const runs = normalized.length;
  const success = normalized.filter((record) => record.success).length;
  return {
    runs,
    success,
    failure: Math.max(0, runs - success),
    successRate: runs ? round(success / runs) : 0,
    avgCost: runs ? round(normalized.reduce((sum, record) => sum + number(record.cost, 0), 0) / runs) : 0,
    avgDuration: runs
      ? round(normalized.reduce((sum, record) => sum + number(record.durationMs || record.duration, 0), 0) / runs)
      : 0,
    actionStats,
    recentActions: normalized.slice(-12).reverse()
  };
}

module.exports = {
  aggregateActionStats,
  emptyStats,
  summarizeLearning
};
