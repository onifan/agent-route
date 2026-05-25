"use strict";

const observabilityRuntime = require("../observability");

function shouldRecord(policy = {}) {
  return policy.recordObservabilityEvents !== false;
}

function recordRecoveryEvent(type, data = {}, options = {}) {
  if (!shouldRecord(options.policy)) return null;
  return observabilityRuntime.recordEvent(type, data, {
    source: "runtime-recovery",
    goalId: options.goalId || data.goalId || data.goal_id || "",
    taskId: options.taskId || data.taskId || data.task_id || "",
    severity: options.severity || data.severity || "warn",
    phase: "recovery"
  });
}

module.exports = {
  recordRecoveryEvent
};
