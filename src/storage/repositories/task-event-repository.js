"use strict";

const taskRepository = require("./task-repository");
const { clone, nowIso } = require("./json-file-store");

function normalizeEvent(event = {}) {
  return {
    from: event.from == null ? null : String(event.from),
    to: event.to == null ? "" : String(event.to),
    reason: String(event.reason || event.event || "task_event"),
    at: event.at || event.createdAt || nowIso(),
    context: event.context && typeof event.context === "object" ? clone(event.context) : {}
  };
}

function listTaskEvents(goalId, taskId, options = {}) {
  const task = taskRepository.getTask(goalId, taskId, options);
  return task && Array.isArray(task.history) ? task.history.map(clone) : [];
}

function appendTaskEvent(goalId, taskId, event = {}, options = {}) {
  const task = taskRepository.getTask(goalId, taskId, options);
  if (!task) return null;
  const normalized = normalizeEvent(event);
  const history = Array.isArray(task.history) ? task.history.map(clone) : [];
  history.push(normalized);
  taskRepository.upsertTask(
    goalId,
    {
      ...task,
      history,
      status: normalized.to || task.status,
      updatedAt: normalized.at
    },
    options
  );
  return clone(normalized);
}

module.exports = {
  appendTaskEvent,
  listTaskEvents,
  normalizeEvent
};
