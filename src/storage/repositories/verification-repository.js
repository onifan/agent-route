"use strict";

const { appendRecord, clearRecords, listRecords, recordStorePath } = require("./record-store");

function defaultVerificationStorePath() {
  return recordStorePath("verification-records", "AGENT_ROUTE_VERIFICATION_RECORDS");
}

function recordVerificationResult(record = {}, options = {}) {
  return appendRecord(record, {
    file: options.file || defaultVerificationStorePath(),
    collection: "verificationRecords",
    maxRecords: options.maxRecords || 1000
  });
}

function listVerificationRecords(filter = {}, options = {}) {
  return listRecords(filter, {
    file: options.file || defaultVerificationStorePath(),
    collection: "verificationRecords",
    maxRecords: options.maxRecords || 1000
  });
}

function clearVerificationRecords(filter = {}, options = {}) {
  return clearRecords(filter, {
    file: options.file || defaultVerificationStorePath(),
    collection: "verificationRecords",
    maxRecords: options.maxRecords || 1000
  });
}

module.exports = {
  clearVerificationRecords,
  defaultVerificationStorePath,
  listVerificationRecords,
  recordVerificationResult
};
