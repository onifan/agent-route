"use strict";

const { appendRecord, clearRecords, listRecords, recordStorePath } = require("./record-store");

function defaultBudgetStorePath() {
  return recordStorePath("budget-records", "AGENT_ROUTE_BUDGET_RECORDS");
}

function recordBudgetEvaluation(record = {}, options = {}) {
  return appendRecord(record, {
    file: options.file || defaultBudgetStorePath(),
    collection: "budgetRecords",
    maxRecords: options.maxRecords || 1000
  });
}

function listBudgetRecords(filter = {}, options = {}) {
  return listRecords(filter, {
    file: options.file || defaultBudgetStorePath(),
    collection: "budgetRecords",
    maxRecords: options.maxRecords || 1000
  });
}

function clearBudgetRecords(filter = {}, options = {}) {
  return clearRecords(filter, {
    file: options.file || defaultBudgetStorePath(),
    collection: "budgetRecords",
    maxRecords: options.maxRecords || 1000
  });
}

module.exports = {
  clearBudgetRecords,
  defaultBudgetStorePath,
  listBudgetRecords,
  recordBudgetEvaluation
};
