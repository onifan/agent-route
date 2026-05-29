"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-observability-"));
process.env.AGENT_ROUTE_HOME = testRoot;
process.env.AGENT_ROUTE_TASKS = path.join(testRoot, "tasks.json");
process.env.AGENT_ROUTE_MEMORY = path.join(testRoot, "memory.json");
process.env.AGENT_ROUTE_OBSERVABILITY = path.join(testRoot, "observability.json");

const taskRuntime = require("./agent-route-task-runtime");
const observability = require("./agent-route-observability-runtime");
const { TASK_STATUS, WORKER_OUTCOME } = taskRuntime;

function reset() {
  taskRuntime.resetRuntime();
  observability.resetRuntime();
}

function semanticEvidence(summary, overrides = {}) {
  return {
    summary,
    semantic: {
      outputSummary: summary,
      addressesCriteria: true,
      criteriaCoverage: 1,
      qualityScore: 0.9,
      qualityIssues: [],
      ...overrides
    }
  };
}

function registerFixture(goalId) {
  return taskRuntime.registerGoalTasks(
    goalId,
    [
      {
        id: "collect",
        title: "Collect inputs",
        type: "analysis",
        modelPool: "free",
        riskLevel: "low",
        produces: ["input_pack"],
        successCriteria: ["Inputs collected"]
      },
      {
        id: "draft",
        title: "Draft output",
        type: "analysis",
        modelPool: "strong",
        riskLevel: "low",
        dependsOn: ["collect"],
        consumes: ["input_pack"],
        produces: ["draft_doc"],
        successCriteria: ["Draft exists"]
      },
      {
        id: "submit",
        title: "Submit output",
        type: "browser",
        modelPool: "codex-cli",
        riskLevel: "high",
        dependsOn: ["draft"],
        successCriteria: ["Human approved submit"]
      }
    ],
    { replace: true, source: "test" }
  );
}

function completeCollect(goalId) {
  taskRuntime.startTask(goalId, "collect", { source: "test", model: "qwen/test-free:free" });
  const completed = taskRuntime.applyWorkerResult(
    goalId,
    "collect",
    {
      status: WORKER_OUTCOME.SUCCESS,
      actions: ["analysis"],
      output: "Collected inputs with concrete evidence.",
      artifacts: [{ id: "input_pack", name: "input_pack" }],
      evidence: semanticEvidence("Collected inputs with concrete evidence.")
    },
    { source: "test", model: "qwen/test-free:free", elapsedMs: 80 }
  );
  assert.equal(completed.status, TASK_STATUS.COMPLETED);
  return completed;
}

function failDraftVerification(goalId) {
  taskRuntime.startTask(goalId, "draft", { source: "test", model: "claude/claude-sonnet-4-5" });
  return taskRuntime.applyWorkerResult(
    goalId,
    "draft",
    {
      status: WORKER_OUTCOME.SUCCESS,
      actions: ["model: draft"],
      output: "done",
      evidence: {
        summary: "Worker claimed success without a real draft.",
        semantic: {
          outputSummary: "done",
          addressesCriteria: false,
          criteriaCoverage: 0.1,
          qualityScore: 0.2,
          qualityIssues: ["too thin"]
        }
      }
    },
    { source: "test", model: "claude/claude-sonnet-4-5", elapsedMs: 140 }
  );
}

function testEventChainCorrectness() {
  reset();
  const goalId = "goal-event-chain";
  const first = observability.recordEvent("TaskCreated", { goal_id: goalId, task: { id: "a", title: "A" } });
  const second = observability.recordEvent("TaskCompleted", { goal_id: goalId, task: { id: "a", title: "A" } });
  const third = observability.recordEvent("VerificationPassed", {
    goal_id: goalId,
    task: { id: "a", title: "A" },
    verification: { verificationStatus: "verified" }
  });
  const fourth = observability.recordEvent("AuthenticityWarning", {
    goal_id: goalId,
    task: { id: "a", title: "A", authenticityScore: 0.42 },
    authenticity: { score: 0.42, warnings: ["duplicate_items"], decisionSource: "authenticity" }
  });
  assert.equal(second.previousGoalEventId, first.id);
  assert.equal(second.previousTaskEventId, first.id);
  assert.equal(third.previousTaskEventId, second.id);
  assert.equal(fourth.previousTaskEventId, third.id);
  const chain = observability.trace(goalId, "a").chain;
  assert.ok(chain.some((event) => event.type === "VerificationPassed"));
  assert.ok(chain.some((event) => event.type === "AuthenticityWarning"));
  assert.equal(observability.listEvents({ goalId, type: "AuthenticityWarning" }).length, 1);
}

function testClearEvents() {
  reset();
  observability.recordEvent("TaskCreated", { goal_id: "goal-clear-a", task: { id: "a" } });
  observability.recordEvent("TaskCreated", { goal_id: "goal-clear-b", task: { id: "b" } });

  const goalClear = observability.clearEvents({ goalId: "goal-clear-a" });
  assert.equal(goalClear.deleted, 1);
  assert.equal(observability.listEvents({ goalId: "goal-clear-a" }).length, 0);
  assert.equal(observability.listEvents({ goalId: "goal-clear-b" }).length, 1);

  const allClear = observability.clearEvents();
  assert.equal(allClear.deleted, 1);
  assert.equal(observability.listEvents().length, 0);
}

function testTaskLifecycleAndDependencyVisualization() {
  reset();
  const goalId = "goal-lifecycle";
  registerFixture(goalId);
  completeCollect(goalId);
  const timeline = observability.taskTimeline(goalId, "collect")[0];
  assert.ok(timeline.timeline.some((event) => event.reason === "task_created"));
  assert.ok(timeline.timeline.some((event) => event.reason === "verification_passed"));
  const graph = observability.snapshot({ goalId }).dependencyGraph;
  assert.ok(graph.nodes.some((node) => node.id === "draft"));
  assert.ok(graph.edges.some((edge) => edge.from === "collect" && edge.to === "draft"));
  assert.ok(graph.readyTaskIds.includes("draft"));
}

function testBudgetVerificationRiskAndDiagnostics() {
  reset();
  const goalId = "goal-diagnostics";
  registerFixture(goalId);
  completeCollect(goalId);
  const failed = failDraftVerification(goalId);
  assert.equal(failed.verificationStatus, "unverified");

  const snapshot = observability.snapshot({ goalId });
  assert.ok(snapshot.budgetMonitor.usage.tokenUsage.total >= 0);
  assert.ok(snapshot.verificationMonitor.failures >= 1);
  assert.ok(Number(snapshot.verificationMonitor.averageAuthenticityScore || 0) >= 0);
  assert.ok(snapshot.diagnostics[0].rootCauses.some((reason) => reason.code === "needs_evidence"));
  assert.ok(snapshot.riskMonitor.highRiskTasks.some((task) => task.id === "submit"));
}

function testWorkerHealthAndMetrics() {
  reset();
  const goalId = "goal-worker-health";
  registerFixture(goalId);
  observability.recordEvent("worker_start", {
    goal_id: goalId,
    task: { id: "draft", title: "Draft output", modelPool: "strong" },
    model: "qwen/test-strong"
  });
  observability.recordEvent("worker_done", {
    goal_id: goalId,
    task: {
      id: "draft",
      title: "Draft output",
      modelPool: "strong",
      verificationStatus: "unverified",
      detectedIssues: [{ issue: "hallucinated success", severity: "high" }]
    },
    model: "qwen/test-strong",
    ok: false,
    elapsedMs: 220,
    error: "verification failed"
  });
  const health = observability.workerHealth(goalId);
  assert.equal(health[0].model, "qwen/test-strong");
  assert.equal(health[0].failed, 1);
  assert.equal(health[0].hallucinationSignals, 1);
  const metrics = observability.metrics(goalId);
  assert.ok(Array.isArray(metrics.modelEfficiency));
}

function testPlanningFailureGoalStatusIsTerminal() {
  reset();
  const goalId = "goal-plan-failed";
  taskRuntime.setGoalStatus(goalId, TASK_STATUS.FAILED, {
    blockedReason: "Commander could not create a plan: provider credits exhausted."
  });
  observability.recordEvent(
    "error",
    {
      goal_id: goalId,
      message: "Commander could not create a plan: provider credits exhausted.",
      status: TASK_STATUS.FAILED
    },
    { goalId, severity: "error" }
  );
  observability.recordEvent(
    "done",
    {
      goal_id: goalId,
      status: TASK_STATUS.FAILED,
      message: "Commander could not create a plan: provider credits exhausted."
    },
    { goalId, severity: "error" }
  );
  const snapshot = observability.snapshot({ goalId });
  assert.equal(snapshot.goals[0].status, TASK_STATUS.FAILED);
}

async function testRealtimeStreamReceivesUpdates() {
  reset();
  const goalId = "goal-realtime";
  const response = observability.streamEvents({ goalId, replay: 0 });
  const reader = response.body.getReader();
  const pending = reader.read();
  const emitted = observability.recordEvent(
    "BudgetExceeded",
    { goal_id: goalId, message: "budget exhausted" },
    { severity: "warn" }
  );
  const chunk = await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error("stream timeout")), 1000))
  ]);
  await reader.cancel().catch(() => {});
  const text = new TextDecoder().decode(chunk.value);
  assert.match(text, /BudgetExceeded/);
  assert.match(text, new RegExp(emitted.id));
}

async function run() {
  try {
    testEventChainCorrectness();
    testClearEvents();
    testTaskLifecycleAndDependencyVisualization();
    testBudgetVerificationRiskAndDiagnostics();
    testWorkerHealthAndMetrics();
    testPlanningFailureGoalStatusIsTerminal();
    await testRealtimeStreamReceivesUpdates();
    console.log("agent-route-observability-runtime tests passed");
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
