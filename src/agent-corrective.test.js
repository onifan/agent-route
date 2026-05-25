"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-corrective-"));
process.env.AGENT_ROUTE_HOME = testRoot;
process.env.AGENT_ROUTE_TASKS = path.join(testRoot, "tasks.json");
process.env.AGENT_ROUTE_OBSERVABILITY = path.join(testRoot, "observability.json");

const corrective = require("./agent/corrective");
const verification = require("./agent/verification");
const taskRuntime = require("./agent/tasks");
const actionApi = require("./agent/orchestrator/action-api");

function listTask(overrides = {}) {
  return {
    id: "project-list",
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

function verify(output, task = listTask()) {
  return verification.verifyTaskResult(task, workerResult(output), { cwd: testRoot });
}

function types(result) {
  return result.recommendedActions.map((item) => item.type);
}

function testDuplicateItemsSuggestRetry() {
  const task = listTask();
  const result = corrective.suggestCorrectiveActions({
    task,
    verification: verify(
      [
        "1. Python 自动化报表脚本 · $120 fixed · https://jobs.test/python-reporting",
        "2. Python 自动化报表脚本 · $120 fixed · https://jobs.test/python-reporting",
        "3. Python 自动化报表脚本 · $120 fixed · https://jobs.test/python-reporting",
        "4. Python 自动化报表脚本 · $120 fixed · https://jobs.test/python-reporting",
        "5. Python 自动化报表脚本 · $120 fixed · https://jobs.test/python-reporting"
      ].join("\n"),
      task
    )
  });
  assert.ok(types(result).includes(corrective.CORRECTIVE_ACTION.RETRY_TASK));
}

function testEmptyLinkSuggestsBrowserRerun() {
  const task = listTask();
  const result = corrective.suggestCorrectiveActions({
    task,
    verification: verify(
      [
        "1. Python 自动化报表脚本 · $120 fixed",
        "2. API 数据同步工具 · $25/hr",
        "3. 浏览器数据提取流程 · $200 fixed",
        "4. CSV 清洗与仪表盘 · $150 fixed",
        "5. 定时邮件摘要机器人 · $30/hr"
      ].join("\n"),
      task
    )
  });
  assert.ok(types(result).includes(corrective.CORRECTIVE_ACTION.RERUN_BROWSER));
}

function testLowAuthenticitySuggestsBlocked() {
  const task = listTask();
  const result = corrective.suggestCorrectiveActions({
    task,
    verification: verify(
      [
        "1. TBD · $0 · https://jobs.test/placeholder",
        "2. TBD · $0 · https://jobs.test/placeholder",
        "3. TBD · $0 · https://jobs.test/placeholder",
        "4. TBD · $0 · https://jobs.test/placeholder",
        "5. TBD · $0 · https://jobs.test/placeholder"
      ].join("\n"),
      task
    )
  });
  assert.ok(types(result).includes(corrective.CORRECTIVE_ACTION.MARK_AS_BLOCKED));
  assert.equal(result.summary.shouldBlock, true);
}

function testHighRiskSuggestsHumanReview() {
  const result = corrective.suggestCorrectiveActions({
    task: listTask({ riskLevel: "high", requiresHumanApproval: true, riskReasons: ["真实提交前必须人工确认"] }),
    verification: {
      verificationStatus: "verified",
      authenticityScore: 0.9,
      authenticityWarnings: [],
      suggestedNextState: "completed"
    }
  });
  assert.ok(types(result).includes(corrective.CORRECTIVE_ACTION.REQUEST_HUMAN_REVIEW));
}

function testNormalTaskContinues() {
  const result = corrective.suggestCorrectiveActions({
    task: listTask(),
    verification: {
      verificationStatus: "verified",
      authenticityScore: 0.91,
      authenticityWarnings: [],
      suggestedNextState: "completed"
    }
  });
  assert.deepEqual(types(result), [corrective.CORRECTIVE_ACTION.CONTINUE]);
}

async function testTaskRuntimeAndApiExposeCorrectiveActions() {
  taskRuntime.resetRuntime();
  taskRuntime.registerGoalTasks("corrective-goal", [listTask()], { replace: true, source: "corrective-test" });
  const task = taskRuntime.nextWaitingTask("corrective-goal");
  taskRuntime.startTask("corrective-goal", task.id, { source: "corrective-test" });
  const updated = taskRuntime.applyWorkerResult(
    "corrective-goal",
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
    { source: "corrective-test" }
  );
  assert.ok(updated.recommendedActions.some((item) => item.type === corrective.CORRECTIVE_ACTION.MARK_AS_BLOCKED));

  const response = await actionApi.handleAgentRouteAction({
    action: "corrective_status",
    goal_id: "corrective-goal",
    task_id: task.id
  });
  const json = await response.json();
  assert.equal(json.ok, true);
  assert.ok(json.corrective.recommendedActions.length);
  assert.equal(json.corrective.summary.shouldBlock, true);
}

async function main() {
  try {
    testDuplicateItemsSuggestRetry();
    testEmptyLinkSuggestsBrowserRerun();
    testLowAuthenticitySuggestsBlocked();
    testHighRiskSuggestsHumanReview();
    testNormalTaskContinues();
    await testTaskRuntimeAndApiExposeCorrectiveActions();
    console.log("agent corrective tests passed");
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
