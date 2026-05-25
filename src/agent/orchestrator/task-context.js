"use strict";

const taskRuntime = require("../tasks");
const memoryRuntime = require("../memory");
const { messagesToText } = require("./content-utils");

function startWorkerTask({ goalId, task, goalMemoryQuery, startedAt, config, userInitiated }) {
  return taskRuntime.startTask(goalId, task.id, {
    reason: "worker_started",
    modelPool: task.modelPool,
    difficulty: task.difficulty || task.complexity,
    riskLevel: task.riskLevel,
    strategyId: task.strategyId,
    strategicObjective: task.strategicObjective,
    strategicPhase: task.strategicPhase,
    goal: goalMemoryQuery,
    runElapsedMs: Date.now() - startedAt,
    budgetPolicy: config.budget,
    userInitiated: Boolean(userInitiated)
  });
}

function prepareWorkerExecutionContext({
  goalId,
  runningTask,
  messages,
  config,
  commanderRoute,
  goalBudget,
  modelsForTask
}) {
  const workerMemory = memoryRuntime.relevantMemoriesForPrompt({
    goalId,
    task: runningTask,
    query: `${messagesToText(messages)} ${runningTask.title || ""} ${runningTask.description || ""}`,
    types: ["knowledge", "procedure", "episodic", "working"],
    limit: 6
  }).text;
  const pool = modelsForTask(config, runningTask, commanderRoute, goalBudget);

  return {
    pool,
    workerMemory
  };
}

module.exports = {
  prepareWorkerExecutionContext,
  startWorkerTask
};
