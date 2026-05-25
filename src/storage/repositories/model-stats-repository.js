"use strict";

const { appendRecord, clearRecords, listRecords, recordStorePath } = require("./record-store");

function defaultModelStatsStorePath() {
  return recordStorePath("model-stats", "AGENT_ROUTE_MODEL_STATS");
}

function recordModelCall(record = {}, options = {}) {
  return appendRecord(record, {
    file: options.file || defaultModelStatsStorePath(),
    collection: "modelCalls",
    maxRecords: options.maxRecords || 2000
  });
}

function listModelCalls(filter = {}, options = {}) {
  return listRecords(filter, {
    file: options.file || defaultModelStatsStorePath(),
    collection: "modelCalls",
    maxRecords: options.maxRecords || 2000
  }).filter((record) => !filter.model || String(record.model || "") === String(filter.model));
}

function modelStats(filter = {}, options = {}) {
  const calls = listModelCalls(filter, options);
  const byModel = {};
  for (const call of calls) {
    const model = String(call.model || "unknown");
    const item = byModel[model] || {
      model,
      calls: 0,
      successes: 0,
      failures: 0,
      retries: 0,
      totalLatencyMs: 0,
      totalCostUsd: 0
    };
    item.calls += 1;
    if (/success|ok|completed/i.test(String(call.status || call.outcome || ""))) item.successes += 1;
    if (/fail|error|blocked/i.test(String(call.status || call.outcome || ""))) item.failures += 1;
    if (/retry/i.test(String(call.status || call.outcome || ""))) item.retries += 1;
    item.totalLatencyMs += Number(call.latencyMs || call.elapsedMs || 0) || 0;
    item.totalCostUsd += Number(call.costUsd || call.estimatedCostUsd || call.actualCostUsd || 0) || 0;
    byModel[model] = item;
  }
  return Object.values(byModel).map((item) => ({
    ...item,
    averageLatencyMs: item.calls ? item.totalLatencyMs / item.calls : 0,
    averageCostUsd: item.calls ? item.totalCostUsd / item.calls : 0,
    successRate: item.calls ? item.successes / item.calls : 0
  }));
}

function clearModelCalls(filter = {}, options = {}) {
  return clearRecords(filter, {
    file: options.file || defaultModelStatsStorePath(),
    collection: "modelCalls",
    maxRecords: options.maxRecords || 2000
  });
}

module.exports = {
  clearModelCalls,
  defaultModelStatsStorePath,
  listModelCalls,
  modelStats,
  recordModelCall
};
