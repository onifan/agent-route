"use strict";

const taskRuntime = require("../tasks");
const memoryRuntime = require("../memory");

const { TASK_STATUS, WORKER_OUTCOME } = taskRuntime;

function handleStartGate({
  goalId,
  runningTask,
  allTasks,
  workerResults,
  executedTaskIds,
  send,
  emitBudget,
  taskSummary
}) {
  if (runningTask.status === TASK_STATUS.RUNNING) return null;

  const riskEvaluation = runningTask.riskHistory && runningTask.riskHistory[runningTask.riskHistory.length - 1];
  const budgetEvaluation = runningTask.budgetHistory && runningTask.budgetHistory[runningTask.budgetHistory.length - 1];
  const blocked = runningTask.status === TASK_STATUS.BLOCKED;
  const gateModel = budgetEvaluation && budgetEvaluation.blockedReason ? "budget-governor" : "risk-engine";
  const workerResult = {
    status: blocked ? WORKER_OUTCOME.BLOCKED : WORKER_OUTCOME.AWAITING_CONFIRMATION,
    actions: [],
    output: runningTask.approvalReason || runningTask.blockedReason || "",
    error: runningTask.blockedReason || "",
    nextStep: blocked ? "Revise the task before retrying." : "Wait for human approval before executing.",
    artifacts: [],
    blockedReason: runningTask.blockedReason || "",
    context: { riskEvaluation }
  };
  const generatedMemories = memoryRuntime.captureTaskMemory({
    goalId,
    task: runningTask,
    workerResult,
    source: "risk-engine"
  });
  const storedIndex = allTasks.findIndex((item) => item.id === runningTask.id);
  if (storedIndex >= 0) allTasks[storedIndex] = runningTask;
  const recordedResult = {
    task: runningTask,
    ok: false,
    model: gateModel,
    content: runningTask.approvalReason || runningTask.blockedReason || "",
    error: runningTask.blockedReason || "",
    status: runningTask.status,
    elapsedMs: 0
  };
  workerResults.push(recordedResult);
  executedTaskIds.add(runningTask.id);
  send("risk", {
    goal_id: goalId,
    task: taskSummary(runningTask),
    evaluation: riskEvaluation
  });
  if (budgetEvaluation) emitBudget("task_gate", budgetEvaluation, runningTask);
  send("worker_done", {
    task: taskSummary(runningTask),
    status: runningTask.status,
    ok: false,
    model: gateModel,
    content: runningTask.approvalReason || "",
    error: runningTask.blockedReason || "",
    elapsedMs: 0,
    worker_result: taskRuntime.normalizeWorkerResult(workerResult)
  });
  if (generatedMemories.length) {
    send("memory", {
      goal_id: goalId,
      task_id: runningTask.id,
      count: generatedMemories.length,
      memories: generatedMemories
    });
  }

  return {
    gated: true,
    recordedResult
  };
}

module.exports = {
  handleStartGate
};
