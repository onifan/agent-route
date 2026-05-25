"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-decision-attribution-"));
process.env.AGENT_ROUTE_HOME = testRoot;
process.env.AGENT_ROUTE_TASKS = path.join(testRoot, "tasks.json");
process.env.AGENT_ROUTE_OBSERVABILITY = path.join(testRoot, "observability.json");
process.env.AGENT_ROUTE_ACTION_LEARNING = path.join(testRoot, "action-learning.json");
process.env.AGENT_ROUTE_DECISION_ATTRIBUTION = path.join(testRoot, "decision-attribution.json");

const actionLearning = require("./agent/action-learning");
const actionDecision = require("./agent/action-decision");
const attribution = require("./agent/decision-attribution");
const corrective = require("./agent/corrective");
const taskRuntime = require("./agent/tasks");
const actionApi = require("./agent/orchestrator/action-api");

function task(overrides = {}) {
  return {
    id: "attribution-task",
    goalId: "attribution-goal",
    title: "检查结果真实性",
    type: "research",
    riskLevel: "low",
    recommendedAction: corrective.action(
      corrective.CORRECTIVE_ACTION.RETRY_TASK,
      corrective.PRIORITY.HIGH,
      "重复项目",
      "duplicate_items"
    ),
    ...overrides
  };
}

function testSystemRecommendationAttribution() {
  const record = attribution.attributeDecision({
    goalId: "g1",
    taskId: "t1",
    task: task({ id: "t1" }),
    recommendedAction: corrective.action(corrective.CORRECTIVE_ACTION.CONTINUE),
    actualAction: corrective.CORRECTIVE_ACTION.CONTINUE,
    status: "completed"
  });
  assert.equal(record.decisionSource, "system_recommendation");
  assert.equal(record.wasOverridden, false);
  assert.equal(record.attributionScore, 1);
  assert.equal(record.success, true);
}

function testUserOverrideAttribution() {
  const record = attribution.attributeDecision({
    goalId: "g1",
    taskId: "t2",
    task: task({ id: "t2" }),
    recommendedAction: corrective.CORRECTIVE_ACTION.RETRY_TASK,
    actualAction: corrective.CORRECTIVE_ACTION.REQUEST_HUMAN_REVIEW,
    decisionSource: "user_override",
    status: "waiting_human",
    success: true
  });
  assert.equal(record.decisionSource, "user_override");
  assert.equal(record.wasOverridden, true);
  assert.equal(record.attributionScore, 0);
  assert.equal(record.success, true);
}

function testHumanRecoverySources() {
  const human = attribution.attributeDecision({
    recommendedAction: corrective.CORRECTIVE_ACTION.RETRY_TASK,
    actualAction: corrective.CORRECTIVE_ACTION.REQUEST_HUMAN_REVIEW,
    reason: "human approved after review",
    status: "waiting_human"
  });
  assert.equal(human.decisionSource, "human_review");
  const recovery = attribution.attributeDecision({
    recommendedAction: corrective.CORRECTIVE_ACTION.RETRY_TASK,
    reason: "worker_process_lost during recovery",
    status: "blocked"
  });
  assert.equal(recovery.decisionSource, "recovery");
}

function testLearningTracksSourceSpecificRates() {
  actionLearning.resetActionLearning();
  attribution.resetDecisionAttribution();
  actionLearning.recordActionOutcome({
    goalId: "learning-attribution",
    taskId: "system-success",
    task: task({ id: "system-success", goalId: "learning-attribution" }),
    action: corrective.action(corrective.CORRECTIVE_ACTION.RETRY_TASK),
    recommendedAction: corrective.CORRECTIVE_ACTION.RETRY_TASK,
    actualAction: corrective.CORRECTIVE_ACTION.RETRY_TASK,
    decisionSource: "system_recommendation",
    status: "completed"
  });
  actionLearning.recordActionOutcome({
    goalId: "learning-attribution",
    taskId: "override-success",
    task: task({ id: "override-success", goalId: "learning-attribution" }),
    action: corrective.action(corrective.CORRECTIVE_ACTION.RETRY_TASK),
    recommendedAction: corrective.CORRECTIVE_ACTION.RETRY_TASK,
    actualAction: corrective.CORRECTIVE_ACTION.RETRY_TASK,
    decisionSource: "user_override",
    wasOverridden: true,
    status: "failed"
  });
  const stats = actionLearning.getActionStats({ goalId: "learning-attribution" }).retry_task;
  assert.equal(stats.runs, 2);
  assert.equal(stats.systemRuns, 1);
  assert.equal(stats.systemSuccessRate, 1);
  assert.equal(stats.overrideRuns, 1);
  assert.equal(stats.overrideSuccessRate, 0);
}

function testDecisionUsesSystemSuccessRate() {
  actionLearning.resetActionLearning();
  for (let index = 0; index < 4; index += 1) {
    actionLearning.recordActionOutcome({
      goalId: "decision-attribution",
      taskId: `system-${index}`,
      task: task({ id: `system-${index}`, goalId: "decision-attribution" }),
      action: corrective.action(corrective.CORRECTIVE_ACTION.RETRY_TASK),
      recommendedAction: corrective.CORRECTIVE_ACTION.RETRY_TASK,
      actualAction: corrective.CORRECTIVE_ACTION.RETRY_TASK,
      decisionSource: "system_recommendation",
      status: "failed"
    });
  }
  for (let index = 0; index < 4; index += 1) {
    actionLearning.recordActionOutcome({
      goalId: "decision-attribution",
      taskId: `override-${index}`,
      task: task({ id: `override-${index}`, goalId: "decision-attribution" }),
      action: corrective.action(corrective.CORRECTIVE_ACTION.RETRY_TASK),
      recommendedAction: corrective.CORRECTIVE_ACTION.REQUEST_HUMAN_REVIEW,
      actualAction: corrective.CORRECTIVE_ACTION.RETRY_TASK,
      decisionSource: "user_override",
      wasOverridden: true,
      status: "completed"
    });
  }
  const result = actionDecision.rankActions({
    task: task({ goalId: "decision-attribution" }),
    recommendedActions: [corrective.action(corrective.CORRECTIVE_ACTION.RETRY_TASK)],
    risk: { riskLevel: "low" }
  });
  assert.equal(result.recommendedAction.historyRuns, 8);
  assert.equal(result.recommendedAction.historicalSuccessRate, 0);
  assert.equal(result.recommendedAction.overrideSuccessRate, 1);
}

async function testRuntimeAndApiExposeAttribution() {
  taskRuntime.resetRuntime();
  actionLearning.resetActionLearning();
  attribution.resetDecisionAttribution();
  taskRuntime.registerGoalTasks(
    "runtime-attribution",
    [task({ id: "runtime-task", goalId: "runtime-attribution", successCriteria: ["摘要"] })],
    { replace: true, source: "attribution-test" }
  );
  const next = taskRuntime.nextWaitingTask("runtime-attribution");
  taskRuntime.startTask("runtime-attribution", next.id, { source: "attribution-test" });
  const updated = taskRuntime.applyWorkerResult(
    "runtime-attribution",
    next.id,
    {
      status: "success",
      output: "完整摘要，包含事实、来源和下一步建议。",
      evidence: {
        provided: true,
        semantic: {
          outputSummary: "完整摘要，包含事实、来源和下一步建议。",
          addressesCriteria: true,
          criteriaCoverage: 1,
          qualityScore: 0.95
        }
      }
    },
    { source: "attribution-test" }
  );
  assert.ok(updated.decisionAttributionHistory.length);
  assert.equal(updated.decisionAttributionHistory[0].decisionSource, "system_recommendation");

  const response = await actionApi.handleAgentRouteAction({
    action: "decision_attribution_status",
    goal_id: "runtime-attribution",
    task_id: next.id
  });
  const json = await response.json();
  assert.equal(json.ok, true);
  assert.ok(json.decisionAttribution.summary.runs >= 1);
}

async function main() {
  try {
    testSystemRecommendationAttribution();
    testUserOverrideAttribution();
    testHumanRecoverySources();
    testLearningTracksSourceSpecificRates();
    testDecisionUsesSystemSuccessRate();
    await testRuntimeAndApiExposeAttribution();
    console.log("agent decision attribution tests passed");
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
