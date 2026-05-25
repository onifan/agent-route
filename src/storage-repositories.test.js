"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-repositories-"));
process.env.AGENT_ROUTE_HOME = testRoot;
delete process.env.AGENT_ROUTE_TASKS;
delete process.env.AGENT_ROUTE_MEMORY;
delete process.env.AGENT_ROUTE_OBSERVABILITY;
delete process.env.AGENT_ROUTE_ARTIFACTS;
delete process.env.AGENT_ROUTE_BUDGET_RECORDS;
delete process.env.AGENT_ROUTE_RISK_RECORDS;
delete process.env.AGENT_ROUTE_VERIFICATION_RECORDS;
delete process.env.AGENT_ROUTE_MODEL_STATS;

const repositories = require("./storage/repositories");
const taskRuntime = require("./agent-route-task-runtime");

const {
  artifactRepository,
  budgetRepository,
  eventRepository,
  goalRepository,
  memoryRepository,
  modelStatsRepository,
  riskRepository,
  taskEventRepository,
  taskRepository,
  verificationRepository
} = repositories;

function assertInsideHome(file) {
  assert.ok(file.startsWith(testRoot), `${file} should live inside AGENT_ROUTE_HOME`);
}

function testGoalAndTaskRepositories() {
  const goal = goalRepository.createGoal({ goalId: "goal-repo", strategyState: { id: "strategy-1" } });
  assert.equal(goal.goalId, "goal-repo");
  assertInsideHome(path.join(testRoot, "agent-route-tasks.json"));
  assert.ok(fs.existsSync(path.join(testRoot, "agent-route-tasks.json")));

  const task = taskRepository.upsertTask("goal-repo", {
    id: "task-repo",
    title: "Repository task",
    status: "waiting",
    history: []
  });
  assert.equal(task.id, "task-repo");
  assert.equal(task.goalId, "goal-repo");
  assert.equal(taskRepository.getTask("goal-repo", "task-repo").title, "Repository task");
  assert.equal(taskRepository.listTasks("goal-repo").length, 1);
  assert.equal(taskRepository.listTasksByStatus("goal-repo", "waiting").length, 1);
}

function testTaskEventRepository() {
  const event = taskEventRepository.appendTaskEvent("goal-repo", "task-repo", {
    from: "waiting",
    to: "running",
    reason: "repository_test",
    context: { source: "test" }
  });
  assert.equal(event.reason, "repository_test");
  const events = taskEventRepository.listTaskEvents("goal-repo", "task-repo");
  assert.equal(events.length, 1);
  assert.equal(events[0].to, "running");
}

function testMemoryAndEventRepositoriesAreSeparate() {
  memoryRepository.upsertMemory({
    id: "memory-1",
    goalId: "goal-repo",
    type: "knowledge",
    status: "active",
    title: "Reusable lesson",
    summary: "This is a real memory, not a runtime log."
  });
  eventRepository.recordEvent({
    type: "runtime_log",
    goalId: "goal-repo",
    message: "This is an event, not memory."
  });
  const memories = memoryRepository.listMemories({ goalId: "goal-repo" });
  const events = eventRepository.listEvents({ goalId: "goal-repo" });
  assert.equal(memories.length, 1);
  assert.equal(events.length, 1);
  assert.equal(memories[0].id, "memory-1");
  assert.notEqual(events[0].id, memories[0].id);
}

function testAuxiliaryRepositories() {
  artifactRepository.registerArtifact({
    id: "artifact-1",
    goalId: "goal-repo",
    taskId: "task-repo",
    type: "json",
    path: "/tmp/result.json",
    size: 32,
    hash: "sha256:test",
    status: "verified",
    sensitive: false
  });
  budgetRepository.recordBudgetEvaluation({ goalId: "goal-repo", taskId: "task-repo", usage: { tokens: 12 } });
  riskRepository.recordRiskEvaluation({ goalId: "goal-repo", taskId: "task-repo", evaluation: { riskLevel: "low" } });
  verificationRepository.recordVerificationResult({
    goalId: "goal-repo",
    taskId: "task-repo",
    verification: { verificationStatus: "verified", confidence: 1 }
  });
  modelStatsRepository.recordModelCall({
    goalId: "goal-repo",
    taskId: "task-repo",
    model: "openrouter/test-free:free",
    status: "success",
    latencyMs: 25
  });

  assert.equal(artifactRepository.listArtifacts({ goalId: "goal-repo" }).length, 1);
  assert.equal(budgetRepository.listBudgetRecords({ goalId: "goal-repo" }).length, 1);
  assert.equal(riskRepository.listRiskRecords({ goalId: "goal-repo" }).length, 1);
  assert.equal(verificationRepository.listVerificationRecords({ goalId: "goal-repo" }).length, 1);
  assert.equal(modelStatsRepository.modelStats({ goalId: "goal-repo" })[0].successRate, 1);
}

function testLegacyTaskRuntimeStillWorks() {
  const runtimeStore = path.join(testRoot, "runtime-tasks.json");
  taskRuntime.setStorageFile(runtimeStore);
  taskRuntime.resetRuntime();
  taskRuntime.registerGoalTasks(
    "legacy-goal",
    [
      {
        id: "legacy-task",
        title: "Legacy task",
        type: "analysis",
        modelPool: "free",
        riskLevel: "low",
        successCriteria: ["Task exists"]
      }
    ],
    { replace: true, source: "repository-test" }
  );
  assert.equal(taskRuntime.listTasks("legacy-goal").length, 1);
  assert.equal(goalRepository.getGoal("legacy-goal", { file: runtimeStore }).tasks[0].id, "legacy-task");
}

testGoalAndTaskRepositories();
testTaskEventRepository();
testMemoryAndEventRepositoriesAreSeparate();
testAuxiliaryRepositories();
testLegacyTaskRuntimeStillWorks();

console.log("storage repository tests passed");
