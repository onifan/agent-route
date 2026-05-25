"use strict";

const { appendRecord, clearRecords, listRecords, recordStorePath } = require("./record-store");

function defaultRiskStorePath() {
  return recordStorePath("risk-records", "AGENT_ROUTE_RISK_RECORDS");
}

function recordRiskEvaluation(record = {}, options = {}) {
  return appendRecord(record, {
    file: options.file || defaultRiskStorePath(),
    collection: "riskRecords",
    maxRecords: options.maxRecords || 1000
  });
}

function listRiskRecords(filter = {}, options = {}) {
  return listRecords(filter, {
    file: options.file || defaultRiskStorePath(),
    collection: "riskRecords",
    maxRecords: options.maxRecords || 1000
  });
}

function clearRiskRecords(filter = {}, options = {}) {
  return clearRecords(filter, {
    file: options.file || defaultRiskStorePath(),
    collection: "riskRecords",
    maxRecords: options.maxRecords || 1000
  });
}

module.exports = {
  clearRiskRecords,
  defaultRiskStorePath,
  listRiskRecords,
  recordRiskEvaluation
};
