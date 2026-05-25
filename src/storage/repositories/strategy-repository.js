"use strict";

const goalRepository = require("./goal-repository");
const { clone, nowIso } = require("./json-file-store");

function getCurrentStrategy(goalId, options = {}) {
  const goal = goalRepository.getGoal(goalId, options);
  return goal && goal.strategyState ? clone(goal.strategyState) : null;
}

function listStrategyHistory(goalId, options = {}) {
  const goal = goalRepository.getGoal(goalId, options);
  return goal && Array.isArray(goal.strategyHistory) ? goal.strategyHistory.map(clone) : [];
}

function recordStrategy(goalId, strategy = {}, context = {}, options = {}) {
  const goal = goalRepository.getGoal(goalId, options) || goalRepository.createGoal({ goalId }, options);
  const previous = goal.strategyState ? clone(goal.strategyState) : null;
  const next = { ...clone(strategy), updatedAt: strategy.updatedAt || strategy.updated_at || nowIso() };
  const history = Array.isArray(goal.strategyHistory) ? goal.strategyHistory.map(clone) : [];
  history.push({
    ...clone(next),
    event: previous ? "strategy_revised" : "strategy_created",
    previousVersion: previous ? previous.version || 0 : 0,
    context: clone(context || {})
  });
  return goalRepository.updateGoal(
    goal.goalId,
    {
      ...goal,
      strategyState: next,
      strategyHistory: history.slice(-50),
      updatedAt: nowIso()
    },
    options
  ).strategyState;
}

module.exports = {
  getCurrentStrategy,
  listStrategyHistory,
  recordStrategy
};
