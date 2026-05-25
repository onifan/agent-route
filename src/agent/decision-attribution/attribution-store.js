"use strict";

const { agentRoutePath } = require("../../shared/utils/agent-home");
const { appendRecord, clearRecords, listRecords, recordStorePath } = require("../../storage/repositories/record-store");
const { normalizeAttributionRecord } = require("./attribution-normalizer");

const COLLECTION = "records";
let storageFile =
  process.env.AGENT_ROUTE_DECISION_ATTRIBUTION ||
  recordStorePath("decision-attribution", "AGENT_ROUTE_DECISION_ATTRIBUTION") ||
  agentRoutePath("agent-route-decision-attribution.json");

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

function recordAttribution(record = {}) {
  return appendRecord(normalizeAttributionRecord(record), storeOptions());
}

function listAttributionRecords(filter = {}) {
  const records = listRecords(filter, storeOptions());
  const source = String(filter.decisionSource || filter.decision_source || "").trim();
  const actualAction = String(
    filter.actualAction || filter.actual_action || filter.actionType || filter.action_type || ""
  ).trim();
  return records
    .filter((record) => !source || record.decisionSource === source || record.decision_source === source)
    .filter((record) => !actualAction || record.actualAction === actualAction || record.actual_action === actualAction);
}

function clearAttributionRecords(filter = {}) {
  return clearRecords(filter, storeOptions());
}

module.exports = {
  clearAttributionRecords,
  listAttributionRecords,
  recordAttribution,
  setStorageFile
};
