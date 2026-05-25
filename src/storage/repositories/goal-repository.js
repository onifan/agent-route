"use strict";

const { clone, nowIso } = require("./json-file-store");
const { loadTaskStore, mutateTaskStore, saveTaskStore } = require("./task-store");

function goalIdOf(goalId) {
  return String(goalId || "default-goal");
}

function listGoals(options = {}) {
  return loadTaskStore(options).goals.map(clone);
}

function getGoal(goalId, options = {}) {
  const id = goalIdOf(goalId);
  return listGoals(options).find((goal) => goal.goalId === id) || null;
}

function saveGoals(goals = [], options = {}) {
  const normalized = Array.isArray(goals) ? goals.map(clone) : [];
  saveTaskStore({ version: 1, updatedAt: options.updatedAt || nowIso(), goals: normalized }, options);
  return normalized.map(clone);
}

function createGoal(goal = {}, options = {}) {
  const id = goalIdOf(goal.goalId || goal.goal_id || options.goalId);
  return mutateTaskStore((store) => {
    let existing = store.goals.find((item) => item.goalId === id);
    if (!existing) {
      existing = {
        goalId: id,
        createdAt: goal.createdAt || goal.created_at || nowIso(),
        updatedAt: goal.updatedAt || goal.updated_at || nowIso(),
        budgetState: goal.budgetState || goal.budget_state || null,
        strategyState: goal.strategyState || goal.strategy_state || null,
        strategyHistory: Array.isArray(goal.strategyHistory || goal.strategy_history)
          ? clone(goal.strategyHistory || goal.strategy_history)
          : [],
        tasks: []
      };
      store.goals.push(existing);
    }
    return clone(existing);
  }, options);
}

function updateGoal(goalId, patch = {}, options = {}) {
  const id = goalIdOf(goalId);
  return mutateTaskStore((store) => {
    let goal = store.goals.find((item) => item.goalId === id);
    if (!goal) {
      goal = { goalId: id, createdAt: nowIso(), updatedAt: nowIso(), tasks: [] };
      store.goals.push(goal);
    }
    Object.assign(goal, clone(patch), { goalId: id, updatedAt: patch.updatedAt || patch.updated_at || nowIso() });
    return clone(goal);
  }, options);
}

function deleteGoal(goalId, options = {}) {
  const id = goalIdOf(goalId);
  return mutateTaskStore((store) => {
    const before = store.goals.length;
    store.goals = store.goals.filter((goal) => goal.goalId !== id);
    return { goalId: id, deleted: before - store.goals.length };
  }, options);
}

module.exports = {
  createGoal,
  deleteGoal,
  getGoal,
  listGoals,
  saveGoals,
  updateGoal
};
