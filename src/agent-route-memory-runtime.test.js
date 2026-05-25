"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const memoryStore = path.join(os.tmpdir(), `agent-route-memory-test-${process.pid}.json`);
const taskStore = path.join(os.tmpdir(), `agent-route-memory-task-test-${process.pid}.json`);
process.env.AGENT_ROUTE_MEMORY = memoryStore;
process.env.AGENT_ROUTE_TASKS = taskStore;

const memory = require("./agent-route-memory-runtime");
const taskRuntime = require("./agent-route-task-runtime");

function reset() {
  memory.resetRuntime();
  taskRuntime.resetRuntime();
}

function cleanup() {
  fs.rmSync(memoryStore, { force: true });
  fs.rmSync(taskStore, { force: true });
}

function testCompletedTaskCreatesMemory() {
  reset();
  const created = memory.captureTaskMemory({
    goalId: "goal-proposal",
    task: {
      id: "proposal-style",
      goalId: "goal-proposal",
      title: "Write Python automation proposal",
      type: "proposal",
      modelPool: "strong",
      difficulty: "high",
      riskLevel: "medium",
      status: "completed",
      result: "A concise proposal with milestones worked well."
    },
    workerResult: {
      status: "success",
      actions: ["used milestone sections", "kept pricing clear"],
      output: "A concise proposal with milestones worked well.",
      nextStep: "Reuse milestone-first proposal structure."
    },
    source: "worker:test"
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].type, memory.MEMORY_TYPE.EPISODIC);
  assert.match(created[0].summary, /completed successfully/);
}

function testFailedTaskRecordsReusableFailureReason() {
  reset();
  const created = memory.captureTaskMemory({
    goalId: "goal-search",
    task: {
      id: "search-client",
      title: "Search freelance jobs",
      type: "search",
      modelPool: "free",
      status: "failed",
      error: "Search query was too broad and returned low-fit jobs."
    },
    workerResult: {
      status: "failure",
      error: "Search query was too broad and returned low-fit jobs.",
      nextStep: "Narrow by Python automation and verified budget."
    },
    source: "worker:test"
  });
  assert.equal(created.length, 1);
  assert.match(created[0].summary, /too broad/);
  assert.match(created[0].summary, /Narrow/);
}

function testRelevantRetrievalDoesNotReturnEverything() {
  reset();
  memory.createMemory({
    goalId: "goal-a",
    type: "knowledge",
    importance: 4,
    title: "Proposal style",
    summary: "User prefers concise Python automation proposals with milestones and clear pricing.",
    tags: ["proposal", "python"]
  });
  memory.createMemory({
    goalId: "goal-b",
    type: "procedure",
    importance: 4,
    title: "Browser testing",
    summary: "For UI bugs, inspect screenshots and verify with browser automation.",
    tags: ["browser", "ui"]
  });
  const found = memory.searchMemories({
    goalId: "goal-a",
    query: "write Python proposal pricing",
    limit: 5
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].title, "Proposal style");
}

function testDuplicateMemoryIsMerged() {
  reset();
  const first = memory.createMemory({
    goalId: "goal-merge",
    type: "knowledge",
    importance: 3,
    title: "Proposal preference",
    summary: "User prefers concise Python automation proposals with milestone pricing.",
    tags: ["proposal", "python"]
  });
  const second = memory.createMemory({
    goalId: "goal-merge",
    type: "knowledge",
    importance: 5,
    title: "Proposal preference",
    summary: "User prefers concise Python automation proposals with milestone pricing.",
    tags: ["proposal", "pricing"]
  });
  assert.equal(second.id, first.id);
  assert.equal(second.importance, 5);
  assert.equal(second.seenCount, 2);
  assert.equal(memory.searchMemories({ goalId: "goal-merge", query: "Python proposal pricing" }).length, 1);
}

function testMemoryFiltersByStatusTypeAndImportance() {
  reset();
  const active = memory.createMemory({
    goalId: "goal-filter",
    type: "procedure",
    importance: 4,
    title: "Search workflow",
    summary: "For freelance search, start with narrow Python automation keywords and verified budgets."
  });
  memory.createMemory({
    goalId: "goal-filter",
    type: "knowledge",
    importance: 2,
    title: "Tone preference",
    summary: "Use concise direct proposal language."
  });
  memory.disableMemory(active.id, "workflow replaced", memory.MEMORY_STATUS.STALE);

  assert.equal(memory.searchMemories({ goalId: "goal-filter", type: "procedure", status: "stale" }).length, 1);
  assert.equal(memory.searchMemories({ goalId: "goal-filter", type: "procedure" }).length, 0);
  assert.equal(memory.searchMemories({ goalId: "goal-filter", minImportance: 4, includeInactive: true }).length, 1);
}

function testSensitiveInformationIsRejected() {
  reset();
  const saved = memory.createMemory({
    type: "knowledge",
    title: "Secret",
    summary: "password=superSecret123 should never be stored"
  });
  assert.equal(saved, null);
  assert.equal(memory.searchMemories({ query: "superSecret123", includeInactive: true }).length, 0);

  const genericToken = memory.createMemory({
    type: "knowledge",
    title: "Generic token",
    summary: "token=abcdef1234567890 should never be stored either"
  });
  assert.equal(genericToken, null);
  assert.equal(memory.searchMemories({ query: "abcdef1234567890", includeInactive: true }).length, 0);
}

function testUpdateAndDisableMemory() {
  reset();
  const saved = memory.createMemory({
    type: "procedure",
    title: "Old workflow",
    summary: "Use broad search first, then filter later.",
    importance: 2
  });
  const updated = memory.updateMemory(saved.id, {
    summary: "Use narrow targeted search first, then expand only if needed.",
    importance: 4
  });
  assert.equal(updated.importance, 4);
  assert.match(updated.summary, /narrow targeted/);

  const disabled = memory.disableMemory(saved.id, "strategy no longer works");
  assert.equal(disabled.status, memory.MEMORY_STATUS.DISABLED);
  assert.equal(memory.searchMemories({ query: "targeted search" }).length, 0);
  assert.equal(memory.searchMemories({ query: "targeted search", includeInactive: true }).length, 1);
}

function testPromptReceivesRelevantSummary() {
  reset();
  memory.createMemory({
    type: "knowledge",
    importance: 5,
    title: "Proposal preference",
    summary: "User prefers proposals that emphasize Python automation ROI and fast delivery.",
    tags: ["proposal", "python"]
  });
  const prompt = memory.relevantMemoriesForPrompt({
    query: "draft a Python automation proposal",
    limit: 3
  }).text;
  assert.match(prompt, /Relevant long-term memory/);
  assert.match(prompt, /Python automation ROI/);
}

function testTaskEventsAndMemoryRemainSeparate() {
  reset();
  taskRuntime.registerGoalTasks(
    "goal-events",
    [{ id: "task-events", title: "Complete task", successCriteria: ["done"] }],
    { replace: true, source: "test" }
  );
  taskRuntime.startTask("goal-events", "task-events", { reason: "start" });
  const completed = taskRuntime.applyWorkerResult("goal-events", "task-events", {
    status: "success",
    output: "task-events completed with concrete result evidence",
    evidence: {
      summary: "task-events completed with concrete result evidence",
      semantic: {
        outputSummary: "task-events completed with concrete result evidence",
        addressesCriteria: true,
        criteriaCoverage: 1,
        qualityScore: 0.9
      }
    }
  });
  const history = taskRuntime.getTaskHistory("goal-events", "task-events");
  assert.ok(history.length >= 3);

  const memories = memory.captureTaskMemory({
    goalId: "goal-events",
    task: completed,
    workerResult: {
      status: "success",
      output: "task-events completed with concrete result evidence",
      evidence: {
        summary: "task-events completed with concrete result evidence",
        semantic: {
          outputSummary: "task-events completed with concrete result evidence",
          addressesCriteria: true,
          criteriaCoverage: 1,
          qualityScore: 0.9
        }
      }
    },
    source: "worker:test"
  });
  assert.equal(memories.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(memories[0], "history"), false);
  assert.equal(memories[0].sourceRef.event, "task_completed");
}

function testRiskMemoryCanBeRecorded() {
  reset();
  const created = memory.captureTaskMemory({
    goalId: "goal-risk-memory",
    task: {
      id: "risk-submit",
      goalId: "goal-risk-memory",
      title: "Submit proposal",
      type: "browser",
      modelPool: "codex-cli",
      riskLevel: "high",
      status: "waiting_human",
      approvalReason: "Browser action may submit data or send a real message.",
      riskReasons: ["Browser action may submit data or send a real message."]
    },
    workerResult: {
      status: "awaiting_confirmation",
      output: "approval required"
    },
    source: "risk-engine:test"
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].sourceRef.event, "task_waiting_human");
  assert.match(created[0].summary, /risk engine classified/);
  assert.ok(created[0].tags.includes("risk-high"));
}

function testVerificationMemoryCanBeRecorded() {
  reset();
  const created = memory.captureTaskMemory({
    goalId: "goal-verification-memory",
    task: {
      id: "verify-submit",
      goalId: "goal-verification-memory",
      title: "Submit proposal",
      type: "browser",
      modelPool: "free",
      riskLevel: "medium",
      status: "retry_ready",
      verificationStatus: "unverified",
      verificationConfidence: 0.22,
      verificationReasons: [],
      detectedIssues: [{ issue: "Browser submit-like action has no independent confirmation.", severity: "high" }],
      verificationHistory: [
        {
          verificationStatus: "unverified",
          confidence: 0.22,
          detectedIssues: [{ issue: "Browser submit-like action has no independent confirmation.", severity: "high" }],
          generatedMemoryCandidates: [
            {
              type: "episodic",
              importance: 4,
              title: "Verification issue: Submit proposal",
              summary:
                "Verification status: unverified. Issues: Browser submit-like action has no independent confirmation.",
              tags: ["verification", "unverified", "browser"]
            }
          ]
        }
      ]
    },
    workerResult: {
      status: "success",
      output: "submitted"
    },
    source: "verification:test"
  });
  assert.equal(created.length >= 1, true);
  assert.ok(created.some((item) => item.summary.includes("Verification")));
  assert.ok(created.some((item) => item.tags.includes("verification")));
}

function main() {
  testCompletedTaskCreatesMemory();
  testFailedTaskRecordsReusableFailureReason();
  testRelevantRetrievalDoesNotReturnEverything();
  testDuplicateMemoryIsMerged();
  testMemoryFiltersByStatusTypeAndImportance();
  testSensitiveInformationIsRejected();
  testUpdateAndDisableMemory();
  testPromptReceivesRelevantSummary();
  testTaskEventsAndMemoryRemainSeparate();
  testRiskMemoryCanBeRecorded();
  testVerificationMemoryCanBeRecorded();
  cleanup();
}

try {
  main();
  console.log("agent-route-memory-runtime tests passed");
} catch (err) {
  cleanup();
  console.error(err);
  process.exitCode = 1;
}
