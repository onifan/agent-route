"use strict";

const budgetGovernor = require("../budget");
const resultNormalizer = require("./result-normalizer");

function normalizeAndRecordWorkerResult({ result, runningTask, goalBudget, emitBudget }) {
  const workerResult = resultNormalizer.makeWorkerRuntimeResult(result, runningTask);
  const workerUsageSource =
    runningTask.modelPool === "codex-cli" ? workerResult : { ...workerResult, output: "", result: "", content: "" };
  const workerBudgetEvaluation = budgetGovernor.recordGoalUsage(
    goalBudget,
    budgetGovernor.usageFromWorkerResult(workerUsageSource, {
      model: result.model || runningTask.modelPool,
      elapsedMs: result.elapsedMs || 0,
      taskId: runningTask.id
    }),
    { phase: "worker_result", taskId: runningTask.id, model: result.model || runningTask.modelPool }
  );
  if (workerBudgetEvaluation) emitBudget("worker_result", workerBudgetEvaluation, runningTask);

  return {
    workerBudgetEvaluation,
    workerResult
  };
}

module.exports = {
  normalizeAndRecordWorkerResult
};
