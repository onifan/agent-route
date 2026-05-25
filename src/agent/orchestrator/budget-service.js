"use strict";

const budgetGovernor = require("../budget");
const resultNormalizer = require("./result-normalizer");

function evaluateGoalBudget(goalBudget, context = {}) {
  return budgetGovernor.evaluateGoalBudget(goalBudget, context);
}

function shouldBlockForBudget(evaluation) {
  return resultNormalizer.shouldGateBudget(evaluation);
}

function applyBudgetToTask(task, evaluation) {
  return resultNormalizer.applyBudgetEvaluationToTaskSummary(task, evaluation);
}

function blockedWorkerResult(task, evaluation) {
  return resultNormalizer.budgetGateWorkerResult(task, evaluation);
}

function recordWorkerUsage(goalBudget, workerResult, metadata = {}) {
  const usage = budgetGovernor.usageFromWorkerResult(workerResult, metadata);
  return budgetGovernor.recordGoalUsage(goalBudget, usage, metadata);
}

module.exports = {
  applyBudgetToTask,
  blockedWorkerResult,
  evaluateGoalBudget,
  recordWorkerUsage,
  shouldBlockForBudget
};
