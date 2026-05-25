"use strict";

const store = require("./attribution-store");
const { DECISION_SOURCE, normalizeAttributionRecord } = require("./attribution-normalizer");

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(Number(value || 0) * scale) / scale;
}

function emptySourceStats(source = "") {
  return {
    source,
    runs: 0,
    success: 0,
    successRate: 0,
    avgAttributionScore: 0
  };
}

function summarizeAttributions(records = []) {
  const normalized = records.map(normalizeAttributionRecord);
  const sourceStats = {};
  const actionStats = {};
  let success = 0;
  let overridden = 0;
  let scoreTotal = 0;
  for (const record of normalized) {
    if (record.success) success += 1;
    if (record.wasOverridden) overridden += 1;
    scoreTotal += Number(record.attributionScore || 0);
    const source = record.decisionSource || DECISION_SOURCE.SYSTEM_RECOMMENDATION;
    const sourceEntry = sourceStats[source] || emptySourceStats(source);
    sourceEntry.runs += 1;
    if (record.success) sourceEntry.success += 1;
    sourceEntry.avgAttributionScore += Number(record.attributionScore || 0);
    sourceStats[source] = sourceEntry;
    const action = record.actualAction || "unknown";
    const actionEntry = actionStats[action] || {
      actionType: action,
      runs: 0,
      success: 0,
      systemRuns: 0,
      systemSuccess: 0,
      overrideRuns: 0,
      overrideSuccess: 0,
      humanRuns: 0,
      humanSuccess: 0,
      successRate: 0,
      systemSuccessRate: 0,
      overrideSuccessRate: 0,
      humanSuccessRate: 0
    };
    actionEntry.runs += 1;
    if (record.success) actionEntry.success += 1;
    if (record.decisionSource === DECISION_SOURCE.SYSTEM_RECOMMENDATION && !record.wasOverridden) {
      actionEntry.systemRuns += 1;
      if (record.success) actionEntry.systemSuccess += 1;
    }
    if (record.wasOverridden || record.decisionSource === DECISION_SOURCE.USER_OVERRIDE) {
      actionEntry.overrideRuns += 1;
      if (record.success) actionEntry.overrideSuccess += 1;
    }
    if (record.decisionSource === DECISION_SOURCE.HUMAN_REVIEW) {
      actionEntry.humanRuns += 1;
      if (record.success) actionEntry.humanSuccess += 1;
    }
    actionStats[action] = actionEntry;
  }
  for (const stats of Object.values(sourceStats)) {
    stats.successRate = stats.runs ? round(stats.success / stats.runs) : 0;
    stats.avgAttributionScore = stats.runs ? round(stats.avgAttributionScore / stats.runs) : 0;
  }
  for (const stats of Object.values(actionStats)) {
    stats.successRate = stats.runs ? round(stats.success / stats.runs) : 0;
    stats.systemSuccessRate = stats.systemRuns ? round(stats.systemSuccess / stats.systemRuns) : 0;
    stats.overrideSuccessRate = stats.overrideRuns ? round(stats.overrideSuccess / stats.overrideRuns) : 0;
    stats.humanSuccessRate = stats.humanRuns ? round(stats.humanSuccess / stats.humanRuns) : 0;
  }
  return {
    runs: normalized.length,
    success,
    failure: Math.max(0, normalized.length - success),
    successRate: normalized.length ? round(success / normalized.length) : 0,
    overridden,
    overrideRate: normalized.length ? round(overridden / normalized.length) : 0,
    avgAttributionScore: normalized.length ? round(scoreTotal / normalized.length) : 0,
    sourceStats,
    actionStats,
    recentAttributions: normalized.slice(-12).reverse()
  };
}

function recordDecisionAttribution(input = {}) {
  const record = store.recordAttribution(input);
  const status = getDecisionAttributionStatus({ limit: 500 });
  return {
    at: record.at || record.timestamp,
    record,
    stats: (status.summary.actionStats && status.summary.actionStats[record.actualAction]) || null,
    summary: status.summary
  };
}

function getDecisionAttributionStatus(filter = {}) {
  const records = store.listAttributionRecords(filter);
  const summary = summarizeAttributions(records);
  return {
    at: new Date().toISOString(),
    records,
    summary,
    sourceStats: summary.sourceStats,
    actionStats: summary.actionStats,
    recentAttributions: summary.recentAttributions
  };
}

function resetDecisionAttribution(filter = {}) {
  return store.clearAttributionRecords(filter);
}

module.exports = {
  DECISION_SOURCE,
  attributeDecision: normalizeAttributionRecord,
  getDecisionAttributionStatus,
  normalizeAttributionRecord,
  recordDecisionAttribution,
  resetDecisionAttribution,
  setStorageFile: store.setStorageFile,
  summarizeAttributions
};
