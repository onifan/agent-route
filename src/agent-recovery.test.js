"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-recovery-"));
process.env.AGENT_ROUTE_HOME = testRoot;
process.env.AGENT_ROUTE_TASKS = path.join(testRoot, "tasks.json");
process.env.AGENT_ROUTE_OBSERVABILITY = path.join(testRoot, "observability.json");
process.env.AGENT_ROUTE_BUDGET_RECORDS = path.join(testRoot, "budget-records.json");

const actionApi = require("./agent/orchestrator/action-api");
const observability = require("./agent/observability");
const recovery = require("./agent/recovery");
const taskRuntime = require("./agent/tasks");
const coreRouter = require("./core/router");
const { goalRepository } = require("./storage/repositories");

const { TASK_STATUS } = taskRuntime;

function reset() {
  taskRuntime.resetRuntime();
  recovery.resetRecoveryRuntime();
  observability.setStorageFile(process.env.AGENT_ROUTE_OBSERVABILITY);
  observability.resetRuntime();
}

function setGoalStatus(goalId, status = "running") {
  goalRepository.updateGoal(goalId, { status });
  taskRuntime.reloadRuntime();
}

function register(goalId, tasks) {
  taskRuntime.registerGoalTasks(goalId, tasks, { replace: true, source: "recovery-test" });
  setGoalStatus(goalId, "running");
}

function testRunningTaskIsSafelyBlocked() {
  reset();
  const goalId = "goal-recover-running";
  register(goalId, [
    {
      id: "run",
      title: "Browser task in progress",
      type: "browser",
      modelPool: "codex-cli",
      status: TASK_STATUS.RUNNING,
      history: [
        {
          from: TASK_STATUS.WAITING,
          to: TASK_STATUS.RUNNING,
          reason: "worker_start",
          at: new Date().toISOString(),
          context: {
            browser: { sessionId: "browser-lost-1", currentUrl: "https://example.com/page?token=secret-token" }
          }
        }
      ]
    },
    {
      id: "downstream",
      title: "Use browser result",
      status: TASK_STATUS.WAITING,
      dependsOn: ["run"]
    }
  ]);

  const summary = recovery.runRuntimeRecovery({ trigger: "test", force: true });
  const task = taskRuntime.getTask(goalId, "run");
  const downstream = taskRuntime.getTask(goalId, "downstream");
  assert.equal(task.status, TASK_STATUS.BLOCKED);
  assert.match(task.blockedReason, /Browser session|restart/i);
  assert.match(
    taskRuntime
      .getTaskHistory(goalId, "run")
      .map((item) => item.reason)
      .join(" "),
    /browser_session_lost/
  );
  assert.equal(downstream.status, TASK_STATUS.BLOCKED);
  assert.ok(summary.interruptedTasks >= 1);
  assert.ok(summary.staleBrowserSessions >= 1);
  assert.ok(summary.workerLost >= 1);
  assert.ok(summary.actionsRecommended.some((item) => /Review interrupted/i.test(item)));
  assert.equal(taskRuntime.getGoal(goalId).status, "blocked");
}

function testStableTaskStatusesArePreserved() {
  reset();
  const goalId = "goal-recover-stable";
  register(goalId, [
    { id: "human", status: TASK_STATUS.WAITING_HUMAN, requiresHumanApproval: true },
    { id: "done", status: TASK_STATUS.COMPLETED },
    { id: "failed", status: TASK_STATUS.FAILED },
    { id: "canceled", status: TASK_STATUS.CANCELED }
  ]);
  recovery.runRuntimeRecovery({ trigger: "test", force: true });
  assert.equal(taskRuntime.getTask(goalId, "human").status, TASK_STATUS.WAITING_HUMAN);
  assert.equal(taskRuntime.getTask(goalId, "done").status, TASK_STATUS.COMPLETED);
  assert.equal(taskRuntime.getTask(goalId, "failed").status, TASK_STATUS.FAILED);
  assert.equal(taskRuntime.getTask(goalId, "canceled").status, TASK_STATUS.CANCELED);
}

function testRetryReadyRecoveryUsesRetryBudget() {
  reset();
  const goalId = "goal-recover-retry";
  register(goalId, [
    { id: "retry-ok", status: TASK_STATUS.RETRY_READY, attempts: 0, maxAttempts: 2 },
    { id: "retry-exhausted", status: TASK_STATUS.RETRY_READY, attempts: 2, maxAttempts: 2 }
  ]);
  const summary = recovery.runRuntimeRecovery({ trigger: "test", force: true });
  assert.equal(taskRuntime.getTask(goalId, "retry-ok").status, TASK_STATUS.WAITING);
  assert.equal(taskRuntime.getTask(goalId, "retry-exhausted").status, TASK_STATUS.BLOCKED);
  assert.match(taskRuntime.getTask(goalId, "retry-exhausted").blockedReason, /Retry budget exhausted/i);
  assert.ok(summary.recoveredTasks >= 2);
  assert.equal(taskRuntime.getGoal(goalId).status, "running");
}

function testRecoveryEventsAndSummary() {
  reset();
  const goalId = "goal-recover-events";
  register(goalId, [{ id: "run", status: TASK_STATUS.RUNNING, modelPool: "codex-cli" }]);
  const summary = recovery.runRuntimeRecovery({ trigger: "test", force: true });
  const events = observability.listEvents({ goalId, limit: 20 });
  assert.ok(
    events.some(
      (event) => event.type === "RecoveryStarted" || event.type === "TaskRecovered" || event.type === "GoalRecovered"
    )
  );
  assert.ok(observability.listEvents({ type: "RecoveryCompleted", limit: 1 })[0]);
  assert.equal(recovery.recoveryStatus().at, summary.at);
}

function testRecentEmptyGoalIsNotBlockedByRecovery() {
  reset();
  const goalId = "goal-recover-new-empty";
  goalRepository.createGoal({
    goalId,
    status: "running",
    createdAt: new Date().toISOString()
  });
  goalRepository.updateGoal(goalId, { status: "running" });
  taskRuntime.reloadRuntime();
  recovery.runRuntimeRecovery({ trigger: "test", force: true });
  assert.equal(taskRuntime.getGoal(goalId).status, "running");
}

function testStartupRecoveryCanSkipCurrentGoal() {
  reset();
  const goalId = "goal-recover-skip-current";
  goalRepository.createGoal({
    goalId,
    status: "running",
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
  });
  goalRepository.updateGoal(goalId, { status: "running" });
  taskRuntime.reloadRuntime();
  recovery.runRuntimeRecovery({ trigger: "test", force: true, skipGoalId: goalId });
  assert.equal(taskRuntime.getGoal(goalId).status, "running");
}

async function testRecoveryApiActions() {
  reset();
  const goalId = "goal-recover-api";
  register(goalId, [{ id: "run", status: TASK_STATUS.RUNNING, modelPool: "codex-cli" }]);
  const runResponse = await actionApi.handleAgentRouteAction({ action: "run_recovery", goal_id: goalId });
  const runJson = await runResponse.json();
  assert.equal(runJson.ok, true);
  assert.ok(runJson.recovery.interruptedTasks >= 1);

  const statusResponse = await actionApi.handleAgentRouteAction({ action: "recovery_status" });
  const statusJson = await statusResponse.json();
  assert.equal(statusJson.ok, true);
  assert.equal(statusJson.recovery.at, runJson.recovery.at);
}

function testCoreRouterIsIndependent() {
  assert.equal(typeof coreRouter.handleInternalModelRequest, "function");
  assert.equal(Object.prototype.hasOwnProperty.call(coreRouter, "runRuntimeRecovery"), false);
}

async function main() {
  testRunningTaskIsSafelyBlocked();
  testStableTaskStatusesArePreserved();
  testRetryReadyRecoveryUsesRetryBudget();
  testRecoveryEventsAndSummary();
  testRecentEmptyGoalIsNotBlockedByRecovery();
  testStartupRecoveryCanSkipCurrentGoal();
  await testRecoveryApiActions();
  testCoreRouterIsIndependent();
  console.log("agent recovery tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
