"use strict";

const riskEngine = require("../risk");
const resultNormalizer = require("./result-normalizer");

function evaluateTaskRisk(task, context = {}) {
  return riskEngine.evaluateTaskRisk(task, context);
}

function applyRiskToTask(task, evaluation) {
  return resultNormalizer.applyRiskEvaluationToTaskSummary(task, evaluation);
}

function shouldBlockForRisk(evaluation, task = {}) {
  return resultNormalizer.shouldGateRisk(evaluation, task);
}

function blockedWorkerResult(task, evaluation) {
  return resultNormalizer.riskGateWorkerResult(task, evaluation);
}

module.exports = {
  applyRiskToTask,
  blockedWorkerResult,
  evaluateTaskRisk,
  shouldBlockForRisk
};
