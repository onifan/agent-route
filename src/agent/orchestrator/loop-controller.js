"use strict";

const budgetGovernor = require("../budget");
const strategyEngine = require("../strategies");
const resultNormalizer = require("./result-normalizer");

function evaluateIterationGuards({ iteration, goalBudget, goalStrategy, allTasks }) {
  const iterationBudget = budgetGovernor.evaluateGoalBudget(goalBudget, { phase: `iteration:${iteration}` });
  const budgetBlocked = resultNormalizer.shouldGateBudget(iterationBudget);
  const strategyStop = strategyEngine.evaluateStopConditions(goalStrategy, {
    budgetEvaluation: iterationBudget,
    tasks: allTasks
  });
  return {
    iterationBudget,
    budgetBlocked,
    strategyStop
  };
}

module.exports = {
  evaluateIterationGuards
};
