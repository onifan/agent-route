"use strict";

const taskRuntime = require("../tasks");
const memoryRuntime = require("../memory");
const budgetGovernor = require("../budget");
const strategyEngine = require("../strategies");
const { messagesToText } = require("./content-utils");

function createRunState({
  body,
  config,
  messages,
  startedAt,
  defaultConfig,
  makeBaseBody,
  resolveCommanderRoute,
  shouldUseCodexCliWorker
}) {
  const goalId = String(
    body.goal_id ||
      body.goalId ||
      (body.agent_route && (body.agent_route.goal_id || body.agent_route.goalId)) ||
      `goal-${startedAt}`
  ).trim();
  const needsLocalExecution = shouldUseCodexCliWorker(messages);
  const resumeGoal = Boolean(
    body.resume_goal ||
    body.resumeGoal ||
    (body.agent_route && (body.agent_route.resume_goal || body.agent_route.resumeGoal))
  );
  const maxGoalIterations = Math.max(
    1,
    Math.min(Number(config.maxGoalIterations || defaultConfig.maxGoalIterations), 8)
  );

  return {
    baseBody: makeBaseBody(body, "chat"),
    commanderRoute: resolveCommanderRoute(body, config),
    goalId,
    needsLocalExecution,
    resumeGoal,
    maxGoalIterations,
    allTasks: [],
    executedTaskIds: new Set(),
    knownTaskIds: new Set(),
    workerResults: [],
    goalMemoryQuery: messagesToText(messages)
  };
}

function loadGoalMemories({ goalId, messages, goalMemoryQuery }) {
  const explicitMemories = memoryRuntime.captureExplicitUserMemories(messages, { goalId, source: "user" });
  const plannerMemory = memoryRuntime.relevantMemoriesForPrompt({
    goalId,
    query: goalMemoryQuery,
    types: ["knowledge", "procedure", "episodic"],
    limit: 8
  }).text;

  return {
    explicitMemories,
    plannerMemory
  };
}

function prepareGoalState({ goalId, resumeGoal, config, startedAt, goalMemoryQuery, plannerMemory }) {
  let goalBudget;
  let goalStrategy;
  if (!resumeGoal) {
    goalBudget = budgetGovernor.createGoalBudgetState({ goalId, policy: config.budget, startedAt });
    goalStrategy = strategyEngine.generateStrategy({
      goalId,
      goalText: goalMemoryQuery,
      memoryText: plannerMemory,
      budgetPolicy: config.budget,
      revisionReason: "initial strategy"
    });
    taskRuntime.registerGoalTasks(goalId, [], {
      replace: true,
      source: "agent_route_run",
      budgetState: goalBudget,
      strategyState: goalStrategy,
      strategyReason: "initial strategy"
    });
    goalStrategy = taskRuntime.getGoalStrategy(goalId) || goalStrategy;
  } else {
    goalBudget =
      taskRuntime.getGoalBudgetState(goalId) ||
      taskRuntime.ensureGoalBudgetState(goalId, { policy: config.budget, startedAt });
    goalStrategy = taskRuntime.getGoalStrategy(goalId);
    if (!goalStrategy) {
      goalStrategy = strategyEngine.generateStrategy({
        goalId,
        goalText: goalMemoryQuery,
        memoryText: plannerMemory,
        budgetPolicy: config.budget,
        revisionReason: "strategy recovered on resume"
      });
      goalStrategy = taskRuntime.setGoalStrategy(goalId, goalStrategy, {
        source: "agent_route_resume",
        reason: "strategy recovered on resume"
      });
    }
  }

  return {
    goalBudget,
    goalStrategy
  };
}

module.exports = {
  createRunState,
  loadGoalMemories,
  prepareGoalState
};
