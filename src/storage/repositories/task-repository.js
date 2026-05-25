"use strict";

const { clone, nowIso } = require("./json-file-store");
const { loadTaskStore, mutateTaskStore } = require("./task-store");

function goalIdOf(goalId) {
  return String(goalId || "default-goal");
}

function taskIdOf(taskId) {
  return String(taskId || "");
}

function ensureGoal(store, goalId) {
  const id = goalIdOf(goalId);
  let goal = store.goals.find((item) => item.goalId === id);
  if (!goal) {
    goal = { goalId: id, createdAt: nowIso(), updatedAt: nowIso(), tasks: [] };
    store.goals.push(goal);
  }
  goal.tasks = Array.isArray(goal.tasks) ? goal.tasks : [];
  return goal;
}

function listTasks(goalId, options = {}) {
  const goal = loadTaskStore(options).goals.find((item) => item.goalId === goalIdOf(goalId));
  return goal ? (goal.tasks || []).map(clone) : [];
}

function listTasksByStatus(goalId, status, options = {}) {
  const wanted = String(status || "");
  return listTasks(goalId, options).filter((task) => !wanted || String(task.status || "") === wanted);
}

function getTask(goalId, taskId, options = {}) {
  const id = taskIdOf(taskId);
  return listTasks(goalId, options).find((task) => String(task.id || "") === id) || null;
}

function saveTasksForGoal(goalId, tasks = [], options = {}) {
  const id = goalIdOf(goalId);
  return mutateTaskStore((store) => {
    const goal = ensureGoal(store, id);
    goal.tasks = Array.isArray(tasks) ? tasks.map(clone) : [];
    goal.updatedAt = options.updatedAt || nowIso();
    return goal.tasks.map(clone);
  }, options);
}

function upsertTask(goalId, task = {}, options = {}) {
  const id = taskIdOf(task.id || options.taskId);
  if (!id) throw new Error("task id is required");
  return mutateTaskStore((store) => {
    const goal = ensureGoal(store, goalId);
    const index = goal.tasks.findIndex((item) => String(item.id || "") === id);
    const next = {
      ...(index >= 0 ? goal.tasks[index] : {}),
      ...clone(task),
      id,
      goalId: goal.goalId,
      updatedAt: task.updatedAt || task.updated_at || nowIso()
    };
    if (!next.createdAt) next.createdAt = nowIso();
    if (index >= 0) goal.tasks[index] = next;
    else goal.tasks.push(next);
    goal.updatedAt = nowIso();
    return clone(next);
  }, options);
}

function updateTask(goalId, taskId, patch = {}, options = {}) {
  const current = getTask(goalId, taskId, options);
  if (!current) return null;
  return upsertTask(goalId, { ...current, ...clone(patch), id: taskIdOf(taskId) }, options);
}

function deleteTask(goalId, taskId, options = {}) {
  const id = taskIdOf(taskId);
  return mutateTaskStore((store) => {
    const goal = ensureGoal(store, goalId);
    const before = goal.tasks.length;
    goal.tasks = goal.tasks.filter((task) => String(task.id || "") !== id);
    goal.updatedAt = nowIso();
    return { goalId: goal.goalId, taskId: id, deleted: before - goal.tasks.length };
  }, options);
}

module.exports = {
  deleteTask,
  getTask,
  listTasks,
  listTasksByStatus,
  saveTasksForGoal,
  updateTask,
  upsertTask
};
