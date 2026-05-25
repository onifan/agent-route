"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-action-decision-"));
process.env.AGENT_ROUTE_HOME = testRoot;
process.env.AGENT_ROUTE_TASKS = path.join(testRoot, "tasks.json");
process.env.AGENT_ROUTE_OBSERVABILITY = path.join(testRoot, "observability.json");

const actionDecision = require("./agent/action-decision");
const corrective = require("./agent/corrective");
const taskRuntime = require("./agent/tasks");
const actionApi = require("./agent/orchestrator/action-api");

function listTask(overrides = {}) {
  return {
    id: "decision-project-list",
    title: "搜索5个自由职业项目并整理结果",
    type: "research",
    modelPool: "free",
    riskLevel: "low",
    successCriteria: ["5 个项目", "标题", "预算", "链接"],
    attempts: 0,
    maxAttempts: 2,
    ...overrides
  };
}

function action(type, priority = corrective.PRIORITY.MEDIUM, reason = "", trigger = "") {
  return corrective.action(type, priority, reason, trigger || type);
}

function workerResult(output) {
  return {
    status: "success",
    output,
    actions: ["search projects"],
    evidence: {
      provided: true,
      summary: "Structured project list.",
      semantic: {
        outputSummary: output,
        addressesCriteria: true,
        criteriaCoverage: 1,
        qualityScore: 0.95
      }
    }
  };
}

function testLowAuthenticityRanksBlockFirst() {
  const result = actionDecision.rankActions({
    task: listTask({ authenticityScore: 0.22 }),
    recommendedActions: [
      action(corrective.CORRECTIVE_ACTION.RETRY_TASK, corrective.PRIORITY.HIGH, "重复项目", "duplicate_items"),
      action(
        corrective.CORRECTIVE_ACTION.MARK_AS_BLOCKED,
        corrective.PRIORITY.CRITICAL,
        "真实性太低",
        "authenticity_below_0_35"
      ),
      action(
        corrective.CORRECTIVE_ACTION.REQUEST_HUMAN_REVIEW,
        corrective.PRIORITY.HIGH,
        "人工复核",
        "placeholder_content"
      )
    ],
    authenticityScore: 0.22,
    risk: { riskLevel: "low" },
    budget: { status: "ok", degradationLevel: "none" }
  });
  assert.equal(result.recommendedAction.type, corrective.CORRECTIVE_ACTION.MARK_AS_BLOCKED);
  assert.ok(result.rankedActions[0].score >= result.rankedActions[1].score);
}

function testHighRiskRanksHumanReviewFirst() {
  const result = actionDecision.rankActions({
    task: listTask({ riskLevel: "high", requiresHumanApproval: true }),
    recommendedActions: [
      action(corrective.CORRECTIVE_ACTION.RETRY_TASK, corrective.PRIORITY.HIGH, "尝试重跑", "verification_unverified"),
      action(
        corrective.CORRECTIVE_ACTION.REQUEST_HUMAN_REVIEW,
        corrective.PRIORITY.HIGH,
        "真实提交前必须人工确认",
        "high_risk"
      )
    ],
    authenticityScore: 0.8,
    risk: { riskLevel: "high", requiresHumanApproval: true }
  });
  assert.equal(result.recommendedAction.type, corrective.CORRECTIVE_ACTION.REQUEST_HUMAN_REVIEW);
  assert.equal(result.recommendedAction.requiresHuman, true);
}

function testBudgetPressureDownranksExpensiveActions() {
  const result = actionDecision.rankActions({
    task: listTask({ authenticityScore: 0.4, attempts: 4 }),
    recommendedActions: [
      action(corrective.CORRECTIVE_ACTION.RERUN_BROWSER, corrective.PRIORITY.HIGH, "缺少链接", "empty_link"),
      action(
        corrective.CORRECTIVE_ACTION.RETRY_WITH_DIFFERENT_MODEL,
        corrective.PRIORITY.MEDIUM,
        "换模型",
        "free_model_unverified"
      ),
      action(
        corrective.CORRECTIVE_ACTION.MARK_AS_BLOCKED,
        corrective.PRIORITY.HIGH,
        "预算耗尽后先阻塞",
        "budget_exhausted"
      )
    ],
    authenticityScore: 0.4,
    budget: { status: "exhausted", degradationLevel: "emergency", warnings: ["budget exhausted"] },
    history: { retryCount: 4 }
  });
  assert.equal(result.recommendedAction.type, corrective.CORRECTIVE_ACTION.MARK_AS_BLOCKED);
  assert.ok(
    result.rankedActions.find((item) => item.type === corrective.CORRECTIVE_ACTION.RERUN_BROWSER).score <
      result.recommendedAction.score
  );
}

function testNormalTaskContinues() {
  const result = actionDecision.rankActions({
    task: listTask({ authenticityScore: 0.92 }),
    recommendedActions: [
      action(corrective.CORRECTIVE_ACTION.CONTINUE, corrective.PRIORITY.LOW, "未发现问题", "no_correction_needed")
    ],
    authenticityScore: 0.92,
    risk: { riskLevel: "low" },
    budget: { status: "ok", degradationLevel: "none" }
  });
  assert.equal(result.recommendedAction.type, corrective.CORRECTIVE_ACTION.CONTINUE);
  assert.equal(result.rankedActions[0].riskLevel, "low");
}

async function testTaskRuntimeAndApiExposeActionDecision() {
  taskRuntime.resetRuntime();
  taskRuntime.registerGoalTasks("action-decision-goal", [listTask()], { replace: true, source: "decision-test" });
  const task = taskRuntime.nextWaitingTask("action-decision-goal");
  taskRuntime.startTask("action-decision-goal", task.id, { source: "decision-test" });
  const updated = taskRuntime.applyWorkerResult(
    "action-decision-goal",
    task.id,
    workerResult(
      [
        "1. TBD · $0 · https://jobs.test/placeholder",
        "2. TBD · $0 · https://jobs.test/placeholder",
        "3. TBD · $0 · https://jobs.test/placeholder",
        "4. TBD · $0 · https://jobs.test/placeholder",
        "5. TBD · $0 · https://jobs.test/placeholder"
      ].join("\n")
    ),
    { source: "decision-test" }
  );
  assert.ok(updated.rankedActions.length);
  assert.equal(updated.recommendedAction.type, corrective.CORRECTIVE_ACTION.MARK_AS_BLOCKED);

  const response = await actionApi.handleAgentRouteAction({
    action: "action_decision_status",
    goal_id: "action-decision-goal",
    task_id: task.id
  });
  const json = await response.json();
  assert.equal(json.ok, true);
  assert.ok(json.actionDecision.rankedActions.length);
  assert.equal(json.actionDecision.recommendedAction.type, corrective.CORRECTIVE_ACTION.MARK_AS_BLOCKED);
}

async function main() {
  try {
    testLowAuthenticityRanksBlockFirst();
    testHighRiskRanksHumanReviewFirst();
    testBudgetPressureDownranksExpensiveActions();
    testNormalTaskContinues();
    await testTaskRuntimeAndApiExposeActionDecision();
    console.log("agent action decision tests passed");
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
