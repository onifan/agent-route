"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-action-learning-"));
process.env.AGENT_ROUTE_HOME = testRoot;
process.env.AGENT_ROUTE_TASKS = path.join(testRoot, "tasks.json");
process.env.AGENT_ROUTE_OBSERVABILITY = path.join(testRoot, "observability.json");
process.env.AGENT_ROUTE_ACTION_LEARNING = path.join(testRoot, "action-learning.json");

const actionLearning = require("./agent/action-learning");
const actionDecision = require("./agent/action-decision");
const corrective = require("./agent/corrective");
const taskRuntime = require("./agent/tasks");
const actionApi = require("./agent/orchestrator/action-api");

function action(type, priority = corrective.PRIORITY.MEDIUM, reason = "", trigger = "") {
  return corrective.action(type, priority, reason, trigger || type);
}

function task(overrides = {}) {
  return {
    id: "learning-task",
    goalId: "learning-goal",
    title: "读取网页并总结",
    type: "browser_read",
    riskLevel: "low",
    authenticityScore: 0.86,
    budgetUsage: { estimatedCostUsd: 0.03, runtimeMs: 1200, retries: 0 },
    ...overrides
  };
}

function workerResult(output = "完整摘要，包含页面标题、主要内容和来源链接。") {
  return {
    status: "success",
    output,
    actions: ["read page"],
    evidence: {
      provided: true,
      summary: "Browser read result.",
      browser: {
        type: "browser",
        ok: true,
        url: "https://example.test",
        title: "Example",
        textPreview: "Example page text"
      },
      semantic: {
        outputSummary: output,
        addressesCriteria: true,
        criteriaCoverage: 1,
        qualityScore: 0.95
      }
    }
  };
}

function testRecordAndStats() {
  actionLearning.resetActionLearning();
  actionLearning.recordActionOutcome({
    goalId: "learning-goal",
    taskId: "task-1",
    task: task({ id: "task-1" }),
    action: action(corrective.CORRECTIVE_ACTION.RETRY_TASK),
    status: "completed",
    cost: 0.08,
    durationMs: 30000,
    retryCount: 1,
    authenticityScore: 0.8
  });
  actionLearning.recordActionOutcome({
    goalId: "learning-goal",
    taskId: "task-2",
    task: task({ id: "task-2" }),
    action: action(corrective.CORRECTIVE_ACTION.RETRY_TASK),
    status: "failed",
    cost: 0.04,
    durationMs: 10000,
    retryCount: 2,
    authenticityScore: 0.2
  });
  const status = actionLearning.getActionLearningStatus({ goalId: "learning-goal" });
  assert.equal(status.summary.runs, 2);
  assert.equal(status.actionStats.retry_task.runs, 2);
  assert.equal(status.actionStats.retry_task.successRate, 0.5);
  assert.equal(status.actionStats.retry_task.avgCost, 0.06);
}

function testHistoryInfluencesDecisionScore() {
  actionLearning.resetActionLearning();
  const noHistory = actionDecision.rankActions({
    task: task({ id: "no-history", goalId: "history-goal", type: "research" }),
    recommendedActions: [
      action(corrective.CORRECTIVE_ACTION.RETRY_TASK, corrective.PRIORITY.HIGH, "重复结果", "duplicate_items")
    ],
    authenticityScore: 0.5,
    risk: { riskLevel: "low" }
  }).recommendedAction;

  for (let index = 0; index < 5; index += 1) {
    actionLearning.recordActionOutcome({
      goalId: "history-goal",
      taskId: `retry-${index}`,
      task: task({ id: `retry-${index}`, goalId: "history-goal", type: "research" }),
      action: action(corrective.CORRECTIVE_ACTION.RETRY_TASK),
      status: "failed",
      cost: 0.2,
      durationMs: 90000,
      retryCount: index + 1,
      authenticityScore: 0.3
    });
  }

  const withHistory = actionDecision.rankActions({
    task: task({ id: "with-history", goalId: "history-goal", type: "research" }),
    recommendedActions: [
      action(corrective.CORRECTIVE_ACTION.RETRY_TASK, corrective.PRIORITY.HIGH, "重复结果", "duplicate_items")
    ],
    authenticityScore: 0.5,
    risk: { riskLevel: "low" }
  }).recommendedAction;
  assert.equal(withHistory.historyRuns, 5);
  assert.equal(withHistory.historicalSuccessRate, 0);
  assert.ok(withHistory.score < noHistory.score);
}

function testNoHistoryKeepsRuleScore() {
  actionLearning.resetActionLearning();
  const result = actionDecision.rankActions({
    task: task({ id: "empty-history", goalId: "empty-history-goal", type: "research" }),
    recommendedActions: [
      action(corrective.CORRECTIVE_ACTION.CONTINUE, corrective.PRIORITY.LOW, "未发现问题", "no_correction_needed")
    ],
    authenticityScore: 0.92,
    risk: { riskLevel: "low" }
  });
  assert.equal(result.recommendedAction.type, corrective.CORRECTIVE_ACTION.CONTINUE);
  assert.equal(result.recommendedAction.historyRuns, 0);
  assert.equal(result.recommendedAction.historyScore, null);
}

async function testTaskRuntimeAndApiExposeLearning() {
  actionLearning.resetActionLearning();
  taskRuntime.resetRuntime();
  taskRuntime.registerGoalTasks(
    "learning-runtime-goal",
    [task({ id: "runtime-task", goalId: "learning-runtime-goal", successCriteria: ["摘要", "来源"] })],
    { replace: true, source: "learning-test" }
  );
  const next = taskRuntime.nextWaitingTask("learning-runtime-goal");
  taskRuntime.startTask("learning-runtime-goal", next.id, { source: "learning-test" });
  const updated = taskRuntime.applyWorkerResult("learning-runtime-goal", next.id, workerResult(), {
    source: "learning-test"
  });
  assert.ok(updated.actionLearningHistory.length);
  assert.ok(Object.values(corrective.CORRECTIVE_ACTION).includes(updated.actionLearningHistory[0].actionType));
  assert.equal(updated.actionLearningHistory[0].actualAction, updated.actionLearningHistory[0].actionType);

  const response = await actionApi.handleAgentRouteAction({
    action: "action_learning_status",
    goal_id: "learning-runtime-goal",
    task_id: next.id
  });
  const json = await response.json();
  assert.equal(json.ok, true);
  assert.ok(json.actionLearning.summary.runs >= 1);
  assert.ok(Object.values(json.actionLearning.actionStats).some((stats) => stats.runs >= 1));
}

async function main() {
  try {
    testRecordAndStats();
    testHistoryInfluencesDecisionScore();
    testNoHistoryKeepsRuleScore();
    await testTaskRuntimeAndApiExposeLearning();
    console.log("agent action learning tests passed");
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
