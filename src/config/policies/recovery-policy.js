"use strict";

const DEFAULT_RECOVERY_POLICY = Object.freeze({
  enabled: true,
  autoOnAgentRouteStart: true,
  runningTaskTargetStatus: "blocked",
  runningTaskReason: "process_restarted_or_worker_lost",
  retryReadyPolicy: "waiting_if_budget_allows",
  staleBrowserSessionPolicy: "mark_stale",
  maxAutoRecoveredTasks: 200,
  recordObservabilityEvents: true,
  allowAutoResumePendingTasks: false
});

module.exports = {
  DEFAULT_RECOVERY_POLICY
};
