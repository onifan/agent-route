"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testStore = path.join(os.tmpdir(), `agent-route-runtime-test-${process.pid}.json`);
process.env.AGENT_ROUTE_TASKS = testStore;

const runtime = require("./agent-route-task-runtime");
const actionApi = require("./agent/orchestrator/action-api");
const taskExecutor = require("./agent/orchestrator/task-executor");
const budgetGovernor = require("./agent-route-budget-governor");
const strategyEngine = require("./agent-route-strategy-engine");
const verificationEngine = require("./agent-route-verification-engine");
const workerEvidence = require("./agent-route-worker-evidence");

const { TASK_STATUS, WORKER_OUTCOME } = runtime;

function reset() {
  runtime.resetRuntime();
}

function createTask(goalId, task = {}) {
  const [created] = runtime.registerGoalTasks(
    goalId,
    [
      {
        id: task.id || "task-1",
        title: task.title || "Test task",
        description: task.description || "Exercise task lifecycle",
        type: task.type || "general",
        modelPool: task.modelPool || "free",
        difficulty: task.difficulty || "low",
        riskLevel: task.riskLevel || "low",
        successCriteria: task.successCriteria || ["Task finishes"],
        dependencies: task.dependencies || task.dependsOn || [],
        dependsOn: task.dependsOn || task.dependencies || [],
        produces: task.produces || [],
        consumes: task.consumes || [],
        priority: task.priority || 0,
        retryPolicy: task.retryPolicy || {},
        maxAttempts: task.maxAttempts || 2,
        attempts: Number(task.attempts || 0),
        prompt: task.prompt || task.description || "",
        budget: task.budget || {},
        budgetUsage: task.budgetUsage || {},
        approvalStatus: task.approvalStatus || "",
        requiresHumanApproval: Boolean(task.requiresHumanApproval),
        requiresHumanConfirmation: Boolean(task.requiresHumanConfirmation)
      }
    ],
    { replace: true, source: "test" }
  );
  return created;
}

function assertHistoryEntry(entry, from, to) {
  assert.equal(entry.from, from);
  assert.equal(entry.to, to);
  assert.ok(entry.reason);
  assert.ok(entry.at);
  assert.equal(typeof entry.context, "object");
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

function testNormalCompletion() {
  reset();
  const goalId = "goal-normal";
  const created = createTask(goalId, { id: "normal" });
  assert.equal(created.status, TASK_STATUS.WAITING);

  const running = runtime.startTask(goalId, "normal", { reason: "test_start" });
  assert.equal(running.status, TASK_STATUS.RUNNING);
  assert.equal(running.attempts, 1);

  const completed = runtime.applyWorkerResult(
    goalId,
    "normal",
    {
      status: WORKER_OUTCOME.SUCCESS,
      output: "Task finished with a concrete unit-test result and verifiable summary.",
      actions: ["unit-test"],
      evidence: semanticEvidence("Task finished with a concrete unit-test result and verifiable summary.")
    },
    { test: "normal" }
  );
  assert.equal(completed.status, TASK_STATUS.COMPLETED);
  assert.equal(completed.result, "Task finished with a concrete unit-test result and verifiable summary.");
  assert.equal(completed.verificationStatus, "verified");

  const history = runtime.getTaskHistory(goalId, "normal");
  assert.equal(history.length, 3);
  assertHistoryEntry(history[0], null, TASK_STATUS.WAITING);
  assertHistoryEntry(history[1], TASK_STATUS.WAITING, TASK_STATUS.RUNNING);
  assertHistoryEntry(history[2], TASK_STATUS.RUNNING, TASK_STATUS.COMPLETED);
}

function testRetryFlow() {
  reset();
  const goalId = "goal-retry";
  createTask(goalId, { id: "retry", maxAttempts: 2 });

  runtime.startTask(goalId, "retry", { reason: "first_attempt" });
  const retryReady = runtime.applyWorkerResult(
    goalId,
    "retry",
    {
      status: WORKER_OUTCOME.FAILURE,
      error: "temporary failure"
    },
    { test: "retry" }
  );
  assert.equal(retryReady.status, TASK_STATUS.RETRY_READY);
  assert.equal(retryReady.error, "temporary failure");

  const waiting = runtime.scheduleRetry(goalId, "retry", "retry_after_failure", { test: true });
  assert.equal(waiting.status, TASK_STATUS.WAITING);

  const history = runtime.getTaskHistory(goalId, "retry");
  assert.equal(history.length, 4);
  assertHistoryEntry(history[2], TASK_STATUS.RUNNING, TASK_STATUS.RETRY_READY);
  assertHistoryEntry(history[3], TASK_STATUS.RETRY_READY, TASK_STATUS.WAITING);
}

function testHumanConfirmationFlow() {
  reset();
  const goalId = "goal-human";
  createTask(goalId, { id: "human" });

  runtime.startTask(goalId, "human", { reason: "needs_review" });
  const paused = runtime.applyWorkerResult(
    goalId,
    "human",
    {
      status: WORKER_OUTCOME.AWAITING_CONFIRMATION,
      output: "please confirm"
    },
    { test: "human" }
  );
  assert.equal(paused.status, TASK_STATUS.AWAITING_CONFIRMATION);
  assert.equal(paused.requiresHumanConfirmation, true);

  assert.throws(
    () => runtime.transitionTask(goalId, "human", TASK_STATUS.RUNNING, "illegal_continue"),
    /Illegal task status transition/
  );

  const confirmed = runtime.confirmTask(goalId, "human", { userConfirmed: true });
  assert.equal(confirmed.status, TASK_STATUS.WAITING);

  const runningAgain = runtime.startTask(goalId, "human", { reason: "after_confirmation" });
  assert.equal(runningAgain.status, TASK_STATUS.RUNNING);
  assert.equal(runningAgain.attempts, 2);
}

function testHighRiskTaskWaitsForHumanBeforeWorker() {
  reset();
  const goalId = "goal-risk-human";
  createTask(goalId, {
    id: "submit-proposal",
    title: "Submit proposal",
    description: "Click submit on a real client proposal form.",
    type: "browser",
    riskLevel: "high"
  });

  let called = false;
  return runtime
    .executeNextTask(goalId, async () => {
      called = true;
      return { status: WORKER_OUTCOME.SUCCESS, output: "should not run" };
    })
    .then((result) => {
      assert.equal(called, false);
      assert.equal(result.ok, false);
      assert.equal(result.task.status, TASK_STATUS.WAITING_HUMAN);
      assert.equal(result.task.requiresHumanApproval, true);
      assert.equal(result.task.approvalStatus, "pending");
      assert.equal(result.task.attempts, 0);
    });
}

function testLowRiskTaskCanExecuteAutomatically() {
  reset();
  const goalId = "goal-low-risk";
  createTask(goalId, {
    id: "read-page",
    title: "Read page",
    description: "Extract visible text from a web page.",
    type: "browser",
    riskLevel: "low"
  });

  return runtime
    .executeNextTask(goalId, async () => ({
      status: WORKER_OUTCOME.SUCCESS,
      actions: ["browser: read page"],
      output: "Read-only page extraction captured the visible heading and body text.",
      context: {
        browser: {
          currentUrl: "https://example.com/page",
          pageText: "Example Domain visible heading and body text"
        }
      },
      evidence: {
        summary: "Read-only page evidence captured.",
        browser: {
          currentUrl: "https://example.com/page",
          pageText: "Example Domain visible heading and body text"
        },
        semantic: {
          outputSummary: "Read-only page extraction captured the visible heading and body text.",
          addressesCriteria: true,
          criteriaCoverage: 1,
          qualityScore: 0.9
        }
      }
    }))
    .then((result) => {
      assert.equal(result.ok, true);
      assert.equal(result.task.status, TASK_STATUS.COMPLETED);
      assert.equal(result.task.verificationStatus, "verified");
    });
}

async function testExecuteNextTaskRequiresWorker() {
  reset();
  const goalId = "goal-worker-required";
  createTask(goalId, { id: "worker-required" });

  const result = await runtime.executeNextTask(goalId);
  const task = runtime.getTask(goalId, "worker-required");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "worker_required");
  assert.equal(result.result.status, WORKER_OUTCOME.FAILURE);
  assert.equal(result.task.status, TASK_STATUS.WAITING);
  assert.equal(task.status, TASK_STATUS.WAITING);
  assert.equal(task.attempts, 0);
}

async function testExecuteNextTaskActionRequiresWorkerResult() {
  reset();
  const goalId = "goal-api-worker-required";
  createTask(goalId, { id: "api-worker-required" });

  const response = await actionApi.handleAgentRouteAction({
    action: "execute_next_task",
    goal_id: goalId
  });
  const json = await response.json();
  const task = runtime.getTask(goalId, "api-worker-required");

  assert.equal(response.status, 400);
  assert.equal(json.error.code, "worker_result_required");
  assert.equal(task.status, TASK_STATUS.WAITING);
  assert.equal(task.attempts, 0);
}

async function testActionApiListPayloadsAreCompact() {
  reset();
  const goalId = "goal-compact-api-payload";
  createTask(goalId, {
    id: "compact",
    title: "Compact public task payload",
    successCriteria: ["Task finishes with independent API evidence"]
  });
  runtime.startTask(goalId, "compact", { reason: "start" });
  const hugeOutput = `${"public evidence output ".repeat(800)}output-tail-marker`;
  const hugeBody = `${"api evidence body ".repeat(2000)}api-body-tail-marker`;
  runtime.applyWorkerResult(goalId, "compact", {
    status: WORKER_OUTCOME.SUCCESS,
    output: hugeOutput,
    evidence: {
      summary: "API evidence for compact payload test.",
      apiResponses: [{ method: "GET", url: "https://example.test/evidence", status: 200, body: hugeBody }],
      semantic: {
        outputSummary: "API evidence for compact payload test.",
        addressesCriteria: true,
        criteriaCoverage: 1,
        qualityScore: 0.9
      }
    }
  });
  const storedTask = runtime.getTask(goalId, "compact");
  const storedHistory = JSON.stringify({
    history: storedTask.history,
    riskHistory: storedTask.riskHistory,
    budgetHistory: storedTask.budgetHistory,
    verificationHistory: storedTask.verificationHistory
  });
  assert.ok(JSON.stringify(storedTask).length < 70000);
  assert.doesNotMatch(storedHistory, /api-body-tail-marker/);
  assert.doesNotMatch(storedHistory, /api evidence body api evidence body/);
  assert.doesNotMatch(storedHistory, /workerResult|apiResponses|browserEvidence|normalizedEvidence/);

  const tasksResponse = await actionApi.handleAgentRouteAction({ action: "list_tasks", goal_id: goalId });
  const tasksJson = await tasksResponse.json();
  const tasksSerialized = JSON.stringify(tasksJson);
  assert.equal(tasksResponse.status, 200);
  assert.ok(tasksSerialized.length < 30000);
  assert.doesNotMatch(tasksSerialized, /api-body-tail-marker/);
  assert.ok(tasksJson.tasks[0].result.length < hugeOutput.length);

  const goalsResponse = await actionApi.handleAgentRouteAction({ action: "list_goals" });
  const goalsJson = await goalsResponse.json();
  const goalsSerialized = JSON.stringify(goalsJson);
  assert.equal(goalsResponse.status, 200);
  assert.ok(goalsSerialized.length < 40000);
  assert.doesNotMatch(goalsSerialized, /api-body-tail-marker/);
}

async function testActionApiDerivesFailedGoalStatusFromTasks() {
  reset();
  const goalId = "goal-derived-failed-status";
  runtime.registerGoalTasks(
    goalId,
    [
      { id: "a", title: "Failed A", status: TASK_STATUS.FAILED },
      { id: "b", title: "Failed B", status: TASK_STATUS.FAILED }
    ],
    { replace: true, source: "test" }
  );
  runtime.setGoalStatus(goalId, TASK_STATUS.RUNNING);

  const response = await actionApi.handleAgentRouteAction({ action: "list_goals" });
  const json = await response.json();
  const goal = json.goals.find((item) => item.goalId === goalId);

  assert.equal(response.status, 200);
  assert.equal(goal.status, TASK_STATUS.FAILED);
  assert.match(goal.blockedReason, /所有任务都失败/);
}

function testDangerousShellIsBlockedAfterWorker() {
  reset();
  const goalId = "goal-shell-risk";
  createTask(goalId, { id: "shell", title: "Run local command", type: "local_execution", riskLevel: "low" });

  runtime.startTask(goalId, "shell", { reason: "start" });
  const blocked = runtime.applyWorkerResult(
    goalId,
    "shell",
    {
      status: WORKER_OUTCOME.SUCCESS,
      actions: ["shell: rm -rf /"],
      output: "deleted"
    },
    { model: "codex-cli" }
  );
  assert.equal(blocked.status, TASK_STATUS.BLOCKED);
  assert.match(blocked.blockedReason, /recursive forced deletion|deletion/i);
  assert.notEqual(blocked.status, TASK_STATUS.COMPLETED);
}

function testRetryCountEscalatesRisk() {
  reset();
  const goalId = "goal-risk-escalation";
  createTask(goalId, {
    id: "retry-risk",
    title: "Retry browser task",
    type: "browser",
    riskLevel: "medium",
    attempts: 4,
    maxAttempts: 6
  });

  const paused = runtime.startTask(goalId, "retry-risk", { reason: "retry_start" });
  assert.equal(paused.status, TASK_STATUS.WAITING_HUMAN);
  assert.equal(paused.riskLevel, "high");
  assert.match(paused.escalationReason, /Retry count/i);
}

function testBrowserSubmitTriggersHumanApproval() {
  reset();
  const goalId = "goal-browser-submit";
  createTask(goalId, { id: "browser-submit", title: "Review form", type: "browser", riskLevel: "low" });

  runtime.startTask(goalId, "browser-submit", { reason: "start" });
  const paused = runtime.applyWorkerResult(
    goalId,
    "browser-submit",
    {
      status: WORKER_OUTCOME.SUCCESS,
      actions: [{ type: "browser", action: "click", label: "Submit proposal", url: "https://example.com/proposals" }],
      output: "submitted"
    },
    { model: "browser-worker" }
  );
  assert.equal(paused.status, TASK_STATUS.WAITING_HUMAN);
  assert.equal(paused.requiresHumanApproval, true);
  assert.match(paused.approvalReason, /submit|external/i);
}

function testWorkerCannotBypassRiskEngine() {
  reset();
  const goalId = "goal-bypass";
  createTask(goalId, { id: "bypass", title: "Worker says safe", type: "general", riskLevel: "low" });

  runtime.startTask(goalId, "bypass", { reason: "start" });
  const updated = runtime.applyWorkerResult(
    goalId,
    "bypass",
    {
      status: WORKER_OUTCOME.SUCCESS,
      actions: ["browser: click delete account"],
      output: "done"
    },
    { model: "free-model" }
  );
  assert.equal(updated.status, TASK_STATUS.WAITING_HUMAN);
  assert.notEqual(updated.status, TASK_STATUS.COMPLETED);
}

function testWorkerSuccessButVerificationFails() {
  reset();
  const goalId = "goal-verification-fail";
  createTask(goalId, {
    id: "fake-submit",
    title: "Submit proposal",
    description: "Submit a proposal form and confirm success.",
    type: "browser",
    riskLevel: "low",
    approvalStatus: "approved",
    maxAttempts: 2
  });

  runtime.startTask(goalId, "fake-submit", { reason: "start" });
  const updated = runtime.applyWorkerResult(
    goalId,
    "fake-submit",
    {
      status: WORKER_OUTCOME.SUCCESS,
      actions: [{ type: "browser", action: "click", label: "Submit proposal" }],
      output: "submit success",
      evidence: {
        summary: "Worker claims submit was clicked but has no confirmation.",
        browser: {
          beforeUrl: "https://example.com/proposals/new",
          afterUrl: "https://example.com/proposals/new"
        },
        semantic: {
          outputSummary: "submit success",
          addressesCriteria: false,
          criteriaCoverage: 0.2,
          qualityScore: 0.2
        }
      }
    },
    { model: "browser-worker" }
  );
  assert.equal(updated.status, TASK_STATUS.RETRY_READY);
  assert.equal(updated.verificationStatus, "unverified");
  assert.match(updated.detectedIssues.map((item) => item.issue).join(" "), /independent confirmation/i);
  assert.notEqual(updated.status, TASK_STATUS.COMPLETED);
}

function testBrowserSubmitVerificationPasses() {
  reset();
  const goalId = "goal-browser-verify-pass";
  createTask(goalId, {
    id: "submit-ok",
    title: "Submit proposal",
    description: "Submit a proposal form and confirm success.",
    type: "browser",
    riskLevel: "low",
    approvalStatus: "approved",
    maxAttempts: 1
  });

  runtime.startTask(goalId, "submit-ok", { reason: "start" });
  const completed = runtime.applyWorkerResult(
    goalId,
    "submit-ok",
    {
      status: WORKER_OUTCOME.SUCCESS,
      actions: [{ type: "browser", action: "click", label: "Submit proposal" }],
      output: "Proposal submit completed with confirmation shown.",
      context: {
        browser: {
          beforeUrl: "https://example.com/proposals/new",
          afterUrl: "https://example.com/proposals/123",
          successMessage: "Proposal submitted",
          formDisappeared: true
        }
      },
      evidence: {
        summary: "Proposal submit confirmation was observed.",
        browser: {
          beforeUrl: "https://example.com/proposals/new",
          afterUrl: "https://example.com/proposals/123",
          successMessage: "Proposal submitted",
          formDisappeared: true
        },
        semantic: {
          outputSummary: "Proposal submit completed with confirmation shown.",
          addressesCriteria: true,
          criteriaCoverage: 1,
          qualityScore: 0.95
        }
      }
    },
    { model: "browser-worker" }
  );
  assert.equal(completed.status, TASK_STATUS.COMPLETED);
  assert.equal(completed.verificationStatus, "verified");
  assert.ok(completed.verificationConfidence >= 0.7);
}

function testShellBuildVerification() {
  reset();
  const goalId = "goal-shell-build";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-studio-build-"));
  const distDir = path.join(tmpDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  createTask(goalId, {
    id: "build",
    title: "Run build",
    description: "Run npm build and verify dist output.",
    type: "local_execution",
    riskLevel: "medium",
    successCriteria: ["dist output exists"],
    maxAttempts: 1
  });

  runtime.startTask(goalId, "build", { reason: "start" });
  const completed = runtime.applyWorkerResult(
    goalId,
    "build",
    {
      status: WORKER_OUTCOME.SUCCESS,
      actions: ["shell: npm run build"],
      output: "npm run build completed successfully",
      context: {
        cwd: tmpDir,
        exitCode: 0,
        stdout: "build completed successfully",
        stderr: "",
        outputDirs: [distDir]
      },
      evidence: {
        summary: "Build command exited successfully and dist exists.",
        shell: {
          command: "npm run build",
          exitCode: 0,
          stdout: "build completed successfully",
          stderr: "",
          outputDirs: [distDir]
        },
        semantic: {
          outputSummary: "npm run build completed successfully and dist output exists.",
          addressesCriteria: true,
          criteriaCoverage: 1,
          qualityScore: 0.95
        }
      }
    },
    { model: "codex-cli" }
  );
  assert.equal(completed.status, TASK_STATUS.COMPLETED);
  assert.equal(completed.verificationStatus, "verified");
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function testFileChangeVerification() {
  reset();
  const goalId = "goal-file-change";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-studio-file-"));
  const filePath = path.join(tmpDir, "config.json");
  fs.writeFileSync(filePath, JSON.stringify({ enabled: true }));
  const size = fs.statSync(filePath).size;
  createTask(goalId, {
    id: "file-change",
    title: "Update config file",
    description: "Update config.json and verify it exists.",
    type: "file",
    riskLevel: "medium",
    successCriteria: ["config.json updated"],
    maxAttempts: 1
  });

  runtime.startTask(goalId, "file-change", { reason: "start" });
  const completed = runtime.applyWorkerResult(
    goalId,
    "file-change",
    {
      status: WORKER_OUTCOME.SUCCESS,
      output: "config.json updated with enabled true",
      artifacts: [{ path: filePath, beforeSize: 0, afterSize: size, expectedContent: "enabled" }],
      evidence: {
        summary: "config.json exists and contains expected content.",
        files: [{ path: filePath, beforeSize: 0, afterSize: size, expectedContent: "enabled" }],
        semantic: {
          outputSummary: "config.json updated with enabled true",
          addressesCriteria: true,
          criteriaCoverage: 1,
          qualityScore: 0.95
        }
      }
    },
    { model: "file-worker" }
  );
  assert.equal(completed.status, TASK_STATUS.COMPLETED);
  assert.equal(completed.verificationStatus, "verified");
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function testVerificationCausesRetryAndRequeue() {
  reset();
  const goalId = "goal-verification-retry";
  createTask(goalId, {
    id: "retry-submit",
    title: "Submit proposal",
    description: "Submit a proposal form and verify confirmation.",
    type: "browser",
    riskLevel: "low",
    approvalStatus: "approved",
    maxAttempts: 2
  });

  const result = await runtime.executeNextTask(goalId, async () => ({
    status: WORKER_OUTCOME.SUCCESS,
    actions: [{ type: "browser", action: "click", label: "Submit" }],
    output: "submitted",
    evidence: {
      summary: "Submit was clicked without confirmation evidence.",
      browser: {
        beforeUrl: "https://example.com/form",
        afterUrl: "https://example.com/form"
      },
      semantic: {
        outputSummary: "submitted",
        addressesCriteria: false,
        criteriaCoverage: 0.1,
        qualityScore: 0.2
      }
    }
  }));
  assert.equal(result.ok, false);
  assert.equal(result.task.status, TASK_STATUS.WAITING);
  assert.equal(result.task.verificationStatus, "unverified");
  const history = runtime.getTaskHistory(goalId, "retry-submit");
  assert.ok(history.some((entry) => entry.reason === "verification_retry"));
  assert.ok(history.some((entry) => entry.reason === "retry_ready_requeued"));
}

function testVerificationBlockedAndRiskEscalated() {
  reset();
  const goalId = "goal-verification-blocked";
  createTask(goalId, {
    id: "delete-cache",
    title: "Clean cache",
    description: "Clean only the cache folder.",
    type: "file",
    riskLevel: "low",
    maxAttempts: 1
  });

  runtime.startTask(goalId, "delete-cache", { reason: "start" });
  const blocked = runtime.applyWorkerResult(
    goalId,
    "delete-cache",
    {
      status: WORKER_OUTCOME.SUCCESS,
      output: "cache deletion completed",
      context: {
        fileChanges: [{ path: "/tmp/project", deleted: true, expected: false, broad: true }]
      },
      evidence: {
        summary: "Unexpected deletion was detected.",
        sideEffects: [{ type: "file_delete", target: "/tmp/project", deleted: true, expected: false, broad: true }],
        semantic: {
          outputSummary: "cache deletion completed",
          addressesCriteria: false,
          criteriaCoverage: 0.2,
          qualityScore: 0.2
        }
      }
    },
    { model: "file-worker" }
  );
  assert.equal(blocked.status, TASK_STATUS.BLOCKED);
  assert.equal(blocked.riskLevel, "critical");
  assert.match(blocked.blockedReason, /unexpected file deletion/i);
  assert.ok(blocked.riskHistory.some((entry) => entry.phase === "verification"));
}

function testTaskDoesNotCompleteOnThinSuccess() {
  reset();
  const goalId = "goal-thin-success";
  createTask(goalId, {
    id: "thin",
    title: "Thin success",
    type: "general",
    riskLevel: "low",
    maxAttempts: 1
  });

  runtime.startTask(goalId, "thin", { reason: "start" });
  const needsEvidence = runtime.applyWorkerResult(goalId, "thin", {
    status: WORKER_OUTCOME.SUCCESS,
    output: "done"
  });
  assert.equal(needsEvidence.status, TASK_STATUS.NEEDS_EVIDENCE);
  assert.equal(needsEvidence.verificationStatus, "unverified");
  assert.match(needsEvidence.detectedIssues.map((item) => item.issue).join(" "), /too thin/i);
  assert.ok(needsEvidence.missingEvidence.length);
}

function testMissingEvidenceBlocksWorkerSuccess() {
  reset();
  const goalId = "goal-missing-evidence";
  createTask(goalId, {
    id: "missing-evidence",
    title: "Write summary",
    description: "Write a concise summary.",
    type: "analysis",
    riskLevel: "low",
    maxAttempts: 1
  });

  runtime.startTask(goalId, "missing-evidence", { reason: "start" });
  const needsEvidence = runtime.applyWorkerResult(goalId, "missing-evidence", {
    status: WORKER_OUTCOME.SUCCESS,
    output: "The requested summary is complete and addresses the provided topic in detail."
  });
  assert.equal(needsEvidence.status, TASK_STATUS.NEEDS_EVIDENCE);
  assert.equal(needsEvidence.verificationStatus, "unverified");
  assert.match(needsEvidence.detectedIssues.map((item) => item.issue).join(" "), /standardized evidence/i);
  assert.ok(needsEvidence.missingEvidence.length);
}

function testEvidenceNormalizerMapsLegacyContext() {
  const evidence = workerEvidence.normalizeEvidence(null, {
    context: {
      browser: {
        currentUrl: "https://example.com/done",
        successMessage: "Saved"
      },
      exitCode: 0,
      stderr: ""
    },
    artifacts: [{ path: "/tmp/example.txt", afterSize: 42 }],
    output: "Saved file"
  });
  assert.equal(evidence.provided, false);
  assert.equal(evidence.browser.currentUrl, "https://example.com/done");
  assert.equal(evidence.shell.exitCode, 0);
  assert.equal(evidence.files[0].path, "/tmp/example.txt");
}

function testVerifierModelCanImproveSemanticVerification() {
  const task = {
    id: "proposal",
    title: "Draft proposal",
    description: "Draft a proposal that matches the user's skills.",
    type: "proposal",
    modelPool: "strong",
    successCriteria: ["proposal matches skills", "proposal is not empty"],
    attempts: 1,
    maxAttempts: 1
  };
  const workerResult = {
    status: WORKER_OUTCOME.SUCCESS,
    output: "Proposal draft matches the user's automation skills and includes milestones.",
    evidence: semanticEvidence("Proposal draft matches the user's automation skills and includes milestones.", {
      addressesCriteria: true,
      criteriaCoverage: 0.65,
      qualityScore: 0.6
    })
  };
  const rule = verificationEngine.verifyTaskResult(task, workerResult, { attempts: 1, maxAttempts: 1 });
  assert.equal(verificationEngine.shouldUseVerifierModel(task, workerResult, rule), true);
  const merged = verificationEngine.mergeModelVerification(rule, {
    verificationStatus: "verified",
    confidence: 0.86,
    reasons: ["Proposal is non-empty, skill-aligned, and specific."],
    suggestedNextState: "completed",
    retryable: false
  });
  assert.equal(merged.verificationStatus, "verified");
  assert.equal(merged.suggestedNextState, "completed");
  assert.ok(merged.reasons.some((reason) => /Verifier model/.test(reason)));
}

function testTaskRetryBudgetBlocksStart() {
  reset();
  const goalId = "goal-budget-retry";
  createTask(goalId, {
    id: "retry-budget",
    title: "Retry limited task",
    attempts: 1,
    maxAttempts: 5,
    budget: { task: { maxRetries: 0 } }
  });

  const blocked = runtime.startTask(goalId, "retry-budget", { reason: "budget_retry_start" });
  assert.equal(blocked.status, TASK_STATUS.BLOCKED);
  assert.equal(blocked.budgetStatus, "blocked");
  assert.match(blocked.blockedReason, /retry budget/i);
  assert.equal(blocked.riskLevel, "high");
  assert.ok(blocked.riskHistory.some((entry) => entry.phase === "budget"));
}

function testGoalRuntimeBudgetExhaustion() {
  const state = budgetGovernor.createGoalBudgetState({
    goalId: "goal-budget-runtime",
    policy: { goal: { maxRuntimeMs: 1 } },
    startedAt: Date.now() - 20
  });
  const evaluation = budgetGovernor.evaluateGoalBudget(state, { phase: "runtime_test" });
  assert.equal(evaluation.status, "exhausted");
  assert.match(evaluation.blockedReason, /runtime budget/i);
}

function testGoalBudgetPersistsAcrossReload() {
  reset();
  const goalId = "goal-budget-persist";
  const state = budgetGovernor.createGoalBudgetState({
    goalId,
    policy: { goal: { maxTokens: 100 } },
    startedAt: Date.now()
  });
  budgetGovernor.recordGoalUsage(
    state,
    {
      tokenUsage: { prompt: 25, completion: 10, total: 35 },
      browserActions: 2,
      model: "openrouter/qwen/qwen3-32b:free"
    },
    { phase: "test" }
  );
  runtime.setGoalBudgetState(goalId, state);
  runtime.reloadRuntime();
  const restored = runtime.getGoalBudgetState(goalId);
  assert.equal(restored.goalId, goalId);
  assert.equal(restored.usage.tokenUsage.total, 35);
  assert.equal(restored.usage.browserActions, 2);
  assert.equal(restored.history.length, 1);
}

function testBrowserActionBudgetBlocksWorker() {
  reset();
  const goalId = "goal-budget-browser";
  createTask(goalId, {
    id: "browser-budget",
    title: "Read page with too many browser actions",
    type: "browser",
    riskLevel: "low",
    budget: {
      task: { maxBrowserActions: 1 },
      browser: { maxActions: 1 }
    }
  });

  runtime.startTask(goalId, "browser-budget", { reason: "start" });
  const blocked = runtime.applyWorkerResult(
    goalId,
    "browser-budget",
    {
      status: WORKER_OUTCOME.SUCCESS,
      actions: ["browser: scroll page", "browser: extract page text"],
      output: "Read page content with enough concrete text for verification.",
      evidence: semanticEvidence("Read page content with enough concrete text for verification.")
    },
    { model: "browser-worker" }
  );
  assert.equal(blocked.status, TASK_STATUS.BLOCKED);
  assert.match(blocked.blockedReason, /browser action budget/i);
  assert.notEqual(blocked.status, TASK_STATUS.COMPLETED);
}

function testReadOnlyWebToolEvidenceDoesNotUseBrowserNavigationBudget() {
  const usage = budgetGovernor.usageFromWorkerResult({
    status: WORKER_OUTCOME.SUCCESS,
    actions: ["web:search"],
    output: "Public web evidence was collected.",
    evidence: {
      browserEvidence: Array.from({ length: 12 }, (_, index) => ({
        type: "browser",
        evidenceSource: "web-tool",
        action: "web_search",
        detectedActionType: "read_page",
        url: `https://example.test/source-${index}`,
        textPreview: "Read-only public evidence.",
        metadata: { tool: "web", readOnly: true }
      })),
      semantic: {
        outputSummary: "Public web evidence was collected.",
        addressesCriteria: true,
        criteriaCoverage: 1,
        qualityScore: 0.9
      }
    }
  });
  assert.equal(usage.browserNavigations, 0);
  assert.equal(usage.browserActions, 0);
}

function testTokenBudgetBlocksWorker() {
  reset();
  const goalId = "goal-budget-token";
  createTask(goalId, {
    id: "token-budget",
    title: "Verbose worker",
    type: "analysis",
    riskLevel: "low",
    budget: { task: { maxTokens: 5 } }
  });

  runtime.startTask(goalId, "token-budget", { reason: "start" });
  const blocked = runtime.applyWorkerResult(
    goalId,
    "token-budget",
    {
      status: WORKER_OUTCOME.SUCCESS,
      output: "This worker output is intentionally long enough to exceed a tiny token budget.",
      evidence: semanticEvidence("This worker output is intentionally long enough to exceed a tiny token budget.")
    },
    { model: "free-model" }
  );
  assert.equal(blocked.status, TASK_STATUS.BLOCKED);
  assert.match(blocked.blockedReason, /token budget/i);
  assert.notEqual(blocked.status, TASK_STATUS.COMPLETED);
}

function testUnlimitedBudgetDoesNotBlockOrDowngrade() {
  reset();
  const goalId = "goal-budget-unlimited";
  createTask(goalId, {
    id: "unlimited-budget",
    title: "Verbose worker in test mode",
    type: "analysis",
    riskLevel: "low",
    maxAttempts: 10,
    budget: { unlimited: true, task: { maxRetries: 0, maxTokens: 1 } }
  });

  const running = runtime.startTask(goalId, "unlimited-budget", { reason: "start" });
  assert.equal(running.status, TASK_STATUS.RUNNING);
  const completed = runtime.applyWorkerResult(
    goalId,
    "unlimited-budget",
    {
      status: WORKER_OUTCOME.SUCCESS,
      output: "This intentionally verbose worker output would exceed the tiny normal token budget.",
      evidence: semanticEvidence("This intentionally verbose worker output would exceed the tiny normal token budget.")
    },
    { model: "free-model" }
  );
  assert.equal(completed.status, TASK_STATUS.COMPLETED);
  assert.equal(completed.budgetStatus, "ok");
  assert.equal(completed.degradationLevel, "none");

  const state = budgetGovernor.createGoalBudgetState({
    goalId,
    policy: { unlimited: true, goal: { maxTokens: 1, maxSteps: 0 }, verification: { maxModelCalls: 0 } },
    startedAt: Date.now() - 60 * 60 * 1000
  });
  budgetGovernor.recordGoalUsage(
    state,
    { tokenUsage: { prompt: 5000, completion: 5000, total: 10000 }, steps: 100 },
    { phase: "test" }
  );
  const evaluation = budgetGovernor.evaluateGoalBudget(state, { phase: "assert" });
  assert.equal(evaluation.status, "ok");
  assert.equal(evaluation.unlimited, true);
  assert.equal(evaluation.blockedReason, "");
  const routed = budgetGovernor.routeModels(["cx/gpt-5.5", "openrouter/qwen/qwen3-32b:free"], { budgetState: state });
  assert.equal(routed[0], "cx/gpt-5.5");
  assert.equal(budgetGovernor.shouldUseVerifierModel({ budgetState: state, policy: state.policy }), true);
}

function testBudgetModelDowngrade() {
  const state = budgetGovernor.createGoalBudgetState({
    goalId: "goal-budget-routing",
    policy: { goal: { maxTokens: 100 } },
    startedAt: Date.now()
  });
  budgetGovernor.recordGoalUsage(state, { tokenUsage: { prompt: 90, completion: 0, total: 90 } }, { phase: "test" });
  const routed = budgetGovernor.routeModels(
    ["cx/gpt-5.5", "openrouter/google/gemini-2.5-pro", "openrouter/qwen/qwen3-32b:free"],
    {
      budgetState: state,
      task: { id: "extract", type: "extraction", riskLevel: "low", difficulty: "low" }
    }
  );
  assert.equal(routed[0], "openrouter/qwen/qwen3-32b:free");
  assert.ok(!routed.includes("cx/gpt-5.5"));
}

function testVerificationRetryBudgetBlocks() {
  reset();
  const goalId = "goal-budget-verification";
  createTask(goalId, {
    id: "verify-budget",
    title: "Submit proposal",
    description: "Submit a proposal form and confirm success.",
    type: "browser",
    riskLevel: "low",
    approvalStatus: "approved",
    maxAttempts: 2,
    budget: {
      task: { maxVerificationRetries: 0 },
      verification: { maxRetries: 0 }
    }
  });

  runtime.startTask(goalId, "verify-budget", { reason: "start" });
  const blocked = runtime.applyWorkerResult(
    goalId,
    "verify-budget",
    {
      status: WORKER_OUTCOME.SUCCESS,
      actions: [{ type: "browser", action: "click", label: "Submit" }],
      output: "submit success",
      evidence: {
        summary: "Submit was clicked without confirmation.",
        browser: {
          beforeUrl: "https://example.com/form",
          afterUrl: "https://example.com/form"
        },
        semantic: {
          outputSummary: "submit success",
          addressesCriteria: false,
          criteriaCoverage: 0.1,
          qualityScore: 0.2
        }
      }
    },
    { model: "browser-worker" }
  );
  assert.equal(blocked.status, TASK_STATUS.BLOCKED);
  assert.match(blocked.blockedReason, /verification retry budget/i);
  assert.notEqual(blocked.status, TASK_STATUS.COMPLETED);
}

function testMemoryCanReduceRepeatedWorkBudget() {
  const savings = budgetGovernor.memorySavingsFromText(
    "Avoid repeating failed proposal submit attempts; reuse the prior browser verification lesson."
  );
  assert.ok(savings.estimatedTokensSaved > 0);
  assert.ok(savings.reasons.length);
}

function testGoalStrategyCanBeGeneratedAndStored() {
  reset();
  const goalId = "goal-strategy-store";
  const strategy = strategyEngine.generateStrategy({
    goalId,
    goalText: "30天内提升 Freelancer Python automation 接单率",
    memoryText: "User is strong at Python automation and wants to avoid low-value proposal spam.",
    budgetPolicy: { goal: { maxTokens: 1000, maxRetries: 3 } }
  });
  runtime.registerGoalTasks(goalId, [], {
    replace: true,
    source: "test",
    strategyState: strategy
  });
  const stored = runtime.getGoalStrategy(goalId);
  assert.equal(stored.goalId, goalId);
  assert.match(stored.objective, /Freelancer|接单率/);
  assert.ok(stored.priorities.some((item) => /Python automation/.test(item)));
  assert.ok(stored.riskPolicy.requiresHumanApproval.some((item) => /proposal/i.test(item)));
  assert.equal(runtime.getGoalStrategyHistory(goalId).length, 1);
}

function testStrategyUsesModelDeclaredRiskForApprovalBoundary() {
  const strategy = strategyEngine.generateStrategy({
    goalId: "goal-strategy-block",
    goalText: "30天内提升 Freelancer 接单率"
  });
  const constrained = strategyEngine.constrainPlan(
    {
      tasks: [
        {
          id: "auto-submit",
          title: "Automatically submit proposal",
          description: "Click submit proposal on a live Freelancer proposal form.",
          type: "browser",
          modelPool: "codex-cli",
          riskLevel: "high",
          successCriteria: ["Proposal is submitted"]
        }
      ]
    },
    strategy
  );
  assert.equal(constrained.tasks.length, 0);
  assert.ok(constrained.violations.some((item) => item.code === "high_risk_without_approval"));
}

function testStrategyRevisionAndStopConditions() {
  const strategy = strategyEngine.generateStrategy({
    goalId: "goal-strategy-revise",
    goalText: "90天内达到月入3000美元"
  });
  const revisionSignal = strategyEngine.shouldReviseStrategy(strategy, {
    budgetEvaluation: { degradationLevel: "severe" },
    tasks: [{ status: TASK_STATUS.FAILED }, { status: TASK_STATUS.BLOCKED }, { status: TASK_STATUS.RETRY_READY }],
    review: { status: "continue", nextTasks: [] }
  });
  assert.equal(revisionSignal.shouldRevise, true);
  const revised = strategyEngine.reviseStrategy(strategy, { reason: revisionSignal.revisionReason });
  assert.equal(revised.version, strategy.version + 1);
  assert.equal(revised.executionStyle, "lightweight_budget_preserving");
  const stop = strategyEngine.evaluateStopConditions(revised, {
    budgetEvaluation: { status: "blocked", blockedReason: "Goal runtime budget exhausted." }
  });
  assert.equal(stop.shouldStop, true);
  assert.match(stop.reasons.join(" "), /budget/i);
}

function testTaskCanLinkToStrategy() {
  reset();
  const goalId = "goal-task-strategy-link";
  const strategy = strategyEngine.generateStrategy({
    goalId,
    goalText: "Build a reliable coding workflow"
  });
  runtime.registerGoalTasks(
    goalId,
    [
      {
        id: "linked",
        title: "Run focused implementation",
        successCriteria: ["Implementation is verified"]
      }
    ],
    {
      replace: true,
      source: "test",
      strategyState: strategy
    }
  );
  const task = runtime.getTask(goalId, "linked");
  assert.equal(task.strategyId, runtime.getGoalStrategy(goalId).id);
  assert.equal(task.strategicPhase, "stage_1");
  assert.ok(task.strategicObjective);
}

function testStrategyMemoryCandidate() {
  const strategy = strategyEngine.generateStrategy({
    goalId: "goal-strategy-memory",
    goalText: "Avoid repeating failed browser submit attempts"
  });
  const memory = strategyEngine.memoryCandidateForStrategy(strategy);
  assert.equal(memory.type, "procedure");
  assert.ok(memory.tags.includes("strategy"));
  assert.match(memory.summary, /Objective/);
}

function testDependencySatisfiedMakesTaskReady() {
  reset();
  const goalId = "goal-dep-ready";
  runtime.registerGoalTasks(
    goalId,
    [
      {
        id: "search",
        title: "Search projects",
        produces: ["project_list"],
        successCriteria: ["Project list exists"]
      },
      {
        id: "analyze",
        title: "Analyze projects",
        dependsOn: ["search"],
        consumes: ["project_list"],
        successCriteria: ["Analysis exists"]
      }
    ],
    { replace: true, source: "test" }
  );

  assert.deepEqual(
    runtime.readyTasks(goalId).map((task) => task.id),
    ["search"]
  );
  runtime.startTask(goalId, "search", { reason: "start" });
  runtime.applyWorkerResult(goalId, "search", {
    status: WORKER_OUTCOME.SUCCESS,
    output: "Found enough projects for analysis.",
    evidence: semanticEvidence("Found enough projects for analysis.")
  });
  assert.deepEqual(
    runtime.readyTasks(goalId).map((task) => task.id),
    ["analyze"]
  );
  assert.equal(runtime.nextWaitingTask(goalId).id, "analyze");
}

function testDependencyMissingBlocksTask() {
  reset();
  const goalId = "goal-dep-missing";
  runtime.registerGoalTasks(
    goalId,
    [
      {
        id: "analyze",
        title: "Analyze projects",
        dependsOn: ["search"],
        successCriteria: ["Analysis exists"]
      }
    ],
    { replace: true, source: "test" }
  );
  const task = runtime.getTask(goalId, "analyze");
  assert.equal(task.status, TASK_STATUS.BLOCKED);
  assert.match(task.blockedReason, /Missing dependency/);
  const graph = runtime.getExecutionGraph(goalId);
  assert.equal(graph.valid, false);
  assert.ok(graph.unknownDependencies.some((item) => item.dependency === "search"));
}

function testCycleDetectionBlocksInvalidTasks() {
  reset();
  const goalId = "goal-cycle";
  runtime.registerGoalTasks(
    goalId,
    [
      { id: "a", title: "A", dependsOn: ["b"], successCriteria: ["A done"] },
      { id: "b", title: "B", dependsOn: ["a"], successCriteria: ["B done"] }
    ],
    { replace: true, source: "test" }
  );
  const graph = runtime.getExecutionGraph(goalId);
  assert.equal(graph.valid, false);
  assert.ok(graph.cycles.length);
  assert.equal(runtime.getTask(goalId, "a").status, TASK_STATUS.BLOCKED);
  assert.equal(runtime.getTask(goalId, "b").status, TASK_STATUS.BLOCKED);
}

function testVerificationNeedsEvidenceDoesNotBlockDownstream() {
  reset();
  const goalId = "goal-verification-downstream";
  runtime.registerGoalTasks(
    goalId,
    [
      {
        id: "extract",
        title: "Extract data",
        produces: ["dataset"],
        maxAttempts: 1,
        successCriteria: ["Dataset exists"]
      },
      {
        id: "use",
        title: "Use dataset",
        dependsOn: ["extract"],
        consumes: ["dataset"],
        successCriteria: ["Dataset is used"]
      }
    ],
    { replace: true, source: "test" }
  );
  runtime.startTask(goalId, "extract", { reason: "start" });
  const failed = runtime.applyWorkerResult(goalId, "extract", {
    status: WORKER_OUTCOME.SUCCESS,
    output: "done"
  });
  assert.equal(failed.status, TASK_STATUS.NEEDS_EVIDENCE);
  assert.equal(failed.verificationSuggestedNextState, verificationEngine.SUGGESTED_NEXT_STATE.NEEDS_EVIDENCE);
  assert.ok(failed.missingEvidence.length);
  assert.equal(runtime.getTask(goalId, "use").status, TASK_STATUS.WAITING);
  assert.equal(runtime.getTask(goalId, "use").dependencyStatus, "waiting");
}

function testAlternativeVerifiedEvidenceUnblocksConsumedArtifact() {
  reset();
  const goalId = "goal-alternative-evidence";
  runtime.registerGoalTasks(
    goalId,
    [
      {
        id: "extract",
        title: "Extract data from source A",
        produces: ["dataset"],
        maxAttempts: 1,
        successCriteria: ["Dataset exists"]
      },
      {
        id: "use",
        title: "Use dataset",
        dependsOn: ["extract"],
        consumes: ["dataset"],
        successCriteria: ["Dataset is used"]
      },
      {
        id: "extract-alt",
        title: "Extract data from another source",
        produces: ["dataset"],
        maxAttempts: 1,
        successCriteria: ["Dataset exists"]
      }
    ],
    { replace: true, source: "test" }
  );
  runtime.startTask(goalId, "extract", { reason: "start" });
  runtime.applyWorkerResult(goalId, "extract", {
    status: WORKER_OUTCOME.SUCCESS,
    output: "done"
  });
  assert.equal(runtime.getTask(goalId, "use").dependencyStatus, "waiting");

  runtime.startTask(goalId, "extract-alt", { reason: "start" });
  runtime.applyWorkerResult(goalId, "extract-alt", {
    status: WORKER_OUTCOME.SUCCESS,
    output: "dataset is available from verified evidence.",
    evidence: semanticEvidence("dataset is available from verified evidence.")
  });
  const use = runtime.getTask(goalId, "use");
  assert.equal(use.status, TASK_STATUS.WAITING);
  assert.equal(use.dependencyStatus, "ready");
  assert.deepEqual(
    runtime.readyTasks(goalId).map((task) => task.id),
    ["use"]
  );
}

function testReadOnlyToolFailureNeedsEvidenceInsteadOfHardFailure() {
  reset();
  const goalId = "goal-readonly-tool-evidence-gap";
  runtime.registerGoalTasks(
    goalId,
    [
      {
        id: "read-source",
        title: "Read public source",
        type: "web_read",
        toolWorker: "web",
        produces: ["source_evidence"],
        maxAttempts: 1,
        successCriteria: ["URL, status, title and text evidence are present"]
      },
      {
        id: "analyze",
        title: "Analyze source evidence",
        dependsOn: ["read-source"],
        consumes: ["source_evidence"],
        successCriteria: ["Analysis uses verified evidence"]
      }
    ],
    { replace: true, source: "test" }
  );
  runtime.startTask(goalId, "read-source", { reason: "start" });
  const read = runtime.applyWorkerResult(goalId, "read-source", {
    status: WORKER_OUTCOME.FAILURE,
    error: "HTTP 403 from selected public page."
  });
  assert.equal(read.status, TASK_STATUS.NEEDS_EVIDENCE);
  assert.equal(read.verificationReasonCode, "worker_evidence_unavailable");
  assert.ok(read.missingEvidence[0].requiredFields.includes("url"));
  const analyze = runtime.getTask(goalId, "analyze");
  assert.equal(analyze.status, TASK_STATUS.WAITING);
  assert.equal(analyze.dependencyStatus, "waiting");
}

function testRetryScopeCorrectness() {
  reset();
  const goalId = "goal-retry-scope";
  runtime.registerGoalTasks(
    goalId,
    [
      { id: "search", title: "Search", successCriteria: ["done"] },
      { id: "score", title: "Score", dependsOn: ["search"], successCriteria: ["done"] },
      { id: "draft", title: "Draft", dependsOn: ["score"], successCriteria: ["done"] }
    ],
    { replace: true, source: "test" }
  );
  const scope = runtime.retryImpactScope(goalId, "search");
  assert.deepEqual(scope.retryOnly, ["search"]);
  assert.deepEqual(scope.affectedDownstream, ["score", "draft"]);
}

function testArtifactDependencyValidation() {
  reset();
  const goalId = "goal-artifact";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-studio-artifact-"));
  const artifactPath = path.join(tmpDir, "project_list.json");
  fs.writeFileSync(artifactPath, JSON.stringify([{ title: "Project" }]));
  runtime.registerGoalTasks(
    goalId,
    [
      {
        id: "produce",
        title: "Produce artifact",
        produces: ["project_list_artifact"],
        successCriteria: ["artifact exists"]
      },
      {
        id: "consume",
        title: "Consume artifact",
        consumes: ["project_list_artifact"],
        successCriteria: ["artifact read"]
      }
    ],
    { replace: true, source: "test" }
  );
  assert.deepEqual(
    runtime.readyTasks(goalId).map((task) => task.id),
    ["produce"]
  );
  runtime.startTask(goalId, "produce", { reason: "start" });
  runtime.applyWorkerResult(goalId, "produce", {
    status: WORKER_OUTCOME.SUCCESS,
    output: "project_list_artifact produced with valid content.",
    artifacts: [{ path: artifactPath, expectedContent: "Project" }],
    evidence: {
      summary: "project_list_artifact produced with valid content.",
      files: [{ path: artifactPath, expectedContent: "Project" }],
      semantic: {
        outputSummary: "project_list_artifact produced with valid content.",
        addressesCriteria: true,
        criteriaCoverage: 1,
        qualityScore: 0.95
      }
    }
  });
  assert.deepEqual(
    runtime.readyTasks(goalId).map((task) => task.id),
    ["consume"]
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function testParallelReadyTaskDetection() {
  reset();
  const goalId = "goal-parallel-ready";
  runtime.registerGoalTasks(
    goalId,
    [
      { id: "base", title: "Base", produces: ["base"], successCriteria: ["done"] },
      { id: "budget", title: "Analyze budget", dependsOn: ["base"], consumes: ["base"], successCriteria: ["done"] },
      { id: "client", title: "Analyze client", dependsOn: ["base"], consumes: ["base"], successCriteria: ["done"] }
    ],
    { replace: true, source: "test" }
  );
  runtime.startTask(goalId, "base", { reason: "start" });
  runtime.applyWorkerResult(goalId, "base", {
    status: WORKER_OUTCOME.SUCCESS,
    output: "Base data is ready for parallel analysis.",
    evidence: semanticEvidence("Base data is ready for parallel analysis.")
  });
  const ready = runtime
    .readyTasks(goalId)
    .map((task) => task.id)
    .sort();
  assert.deepEqual(ready, ["budget", "client"]);
  const graph = runtime.getExecutionGraph(goalId);
  assert.ok(graph.parallelGroups.some((group) => group.taskIds.includes("budget") && group.taskIds.includes("client")));
}

function testStrategyDoesNotGenerateKeywordApprovalDependency() {
  reset();
  const goalId = "goal-approval-graph";
  const strategy = strategyEngine.generateStrategy({
    goalId,
    goalText: "30天内提升 Freelancer 接单率，不自动提交 proposal"
  });
  runtime.registerGoalTasks(
    goalId,
    [
      {
        id: "submit",
        title: "Submit proposal",
        description: "Submit proposal to a real client.",
        type: "browser",
        riskLevel: "high",
        successCriteria: ["Proposal submitted"]
      }
    ],
    {
      replace: true,
      source: "test",
      strategyState: strategy
    }
  );
  const tasks = runtime.listTasks(goalId);
  const submit = runtime.getTask(goalId, "submit");
  assert.equal(
    tasks.some((task) => task.type === "human_approval"),
    false
  );
  assert.deepEqual(submit.dependencies, []);
  assert.deepEqual(submit.consumes, []);
}

function testReadOnlyExternalResearchDoesNotNeedApprovalDependency() {
  reset();
  const goalId = "goal-readonly-research-graph";
  const strategy = strategyEngine.generateStrategy({
    goalId,
    goalText: "查询公开市场数据并整理金融风险报告"
  });
  runtime.registerGoalTasks(
    goalId,
    [
      {
        id: "collect_market_news",
        title: "采集当日市场与新闻证据",
        description: "查询公开网页和公开 API 的市场数据。",
        prompt: "Use public sources only. Do not trade, log in, submit forms, upload files, or use credentials.",
        type: "browser",
        modelPool: "codex-cli",
        riskLevel: "low",
        riskReasons: ["只进行公开网页或公开 API 读取，无提交、登录、交易或外部副作用"],
        successCriteria: ["Evidence includes URLs and timestamps"]
      }
    ],
    {
      replace: true,
      source: "test",
      strategyState: strategy
    }
  );
  const tasks = runtime.listTasks(goalId);
  assert.equal(
    tasks.some((task) => task.type === "human_approval"),
    false
  );
  const collect = runtime.getTask(goalId, "collect_market_news");
  assert.deepEqual(collect.dependsOn, []);
  assert.deepEqual(collect.consumes, []);
}

function testReadOnlyWebSearchWithNegatedSideEffectsDoesNotNeedApprovalDependency() {
  reset();
  const goalId = "goal-readonly-web-news-graph";
  const strategy = strategyEngine.generateStrategy({
    goalId,
    goalText: "查询日元汇率、国债收益率和国际新闻，写金融风险报告。不要登录，不要提交表单，不要付款，不要发送消息。"
  });
  runtime.registerGoalTasks(
    goalId,
    [
      {
        id: "news_evidence",
        title: "采集近期国际新闻证据",
        description: "只读联网查询至少3条近期与日元、利率、央行政策、美国收益率或全球风险偏好相关的国际新闻。",
        prompt: "使用只读web工具搜索近期国际新闻。不要登录、不要提交表单、不要付款、不要发送消息、不要修改文件。",
        type: "web_search",
        modelPool: "free",
        toolWorker: "web",
        riskLevel: "low",
        riskReasons: ["只读公开新闻取证", "不登录不提交不修改"],
        successCriteria: ["Evidence includes URLs, status, titles, timestamps, and readable news text."]
      }
    ],
    {
      replace: true,
      source: "test",
      strategyState: strategy
    }
  );
  const tasks = runtime.listTasks(goalId);
  assert.equal(
    tasks.some((task) => task.type === "human_approval"),
    false
  );
  const news = runtime.getTask(goalId, "news_evidence");
  assert.deepEqual(news.dependsOn, []);
  assert.deepEqual(news.consumes, []);
  assert.equal(news.toolWorker, "web");
}

function testReadOnlyNewsSearchWithPublishTimestampDoesNotNeedApprovalDependency() {
  reset();
  const goalId = "goal-readonly-news-publish-time";
  const strategy = strategyEngine.generateStrategy({
    goalId,
    goalText: "查询日元汇率、国债收益率和国际新闻，写金融风险报告。不要登录，不要提交表单，不要付款，不要发送消息。"
  });
  runtime.registerGoalTasks(
    goalId,
    [
      {
        id: "collect_news",
        title: "收集近期国际金融新闻",
        description:
          "检索过去7天内至少3条与美元/日元汇率、美国国债收益率或全球金融风险相关的国际新闻。记录新闻标题、来源、发布时间及主要内容摘要。",
        prompt: "搜索过去7天内与美元/日元汇率、美国国债收益率相关的国际财经新闻。",
        type: "web_search",
        modelPool: "free",
        toolWorker: "web",
        riskLevel: "low",
        successCriteria: ["返回至少3条新闻条目，包含标题、来源、发布时间及摘要"]
      }
    ],
    {
      replace: true,
      source: "test",
      strategyState: strategy
    }
  );
  const tasks = runtime.listTasks(goalId);
  assert.equal(
    tasks.some((task) => task.type === "human_approval"),
    false
  );
  const news = runtime.getTask(goalId, "collect_news");
  assert.deepEqual(news.dependsOn, []);
  assert.deepEqual(news.consumes, []);
}

function testReadOnlyNewsSearchWithPublishUpdateDateDoesNotNeedApprovalDependency() {
  reset();
  const goalId = "goal-readonly-news-publish-update-date";
  const strategy = strategyEngine.generateStrategy({
    goalId,
    goalText: "查询日元汇率、国债收益率和国际新闻，写金融风险报告。不要登录，不要提交表单，不要付款，不要发送消息。"
  });
  runtime.registerGoalTasks(
    goalId,
    [
      {
        id: "news_evidence",
        title: "检索近期国际新闻证据",
        description:
          "只读检索至少3条近期国际新闻，覆盖日元、日美利率/央行政策、全球风险或地缘/贸易因素，并提供可验证证据。",
        prompt:
          "Search and read recent international news. Return URL, HTTP status, title, publish/update date, short evidence text. Do not log in, submit forms, pay, message, or write files.",
        type: "web_search",
        modelPool: "free",
        toolWorker: "web",
        riskLevel: "low",
        riskReasons: ["只读公开网页搜索和读取", "不登录、不提交表单、不修改文件"],
        successCriteria: ["每条包含URL、HTTP状态、标题、发布日期/更新时间和关键正文证据"]
      }
    ],
    {
      replace: true,
      source: "test",
      strategyState: strategy
    }
  );
  const tasks = runtime.listTasks(goalId);
  assert.equal(
    tasks.some((task) => task.type === "human_approval"),
    false
  );
  const news = runtime.getTask(goalId, "news_evidence");
  assert.deepEqual(news.dependsOn, []);
  assert.deepEqual(news.consumes, []);
}

function testBlockedPropagation() {
  reset();
  const goalId = "goal-block-propagation";
  runtime.registerGoalTasks(
    goalId,
    [
      { id: "fetch", title: "Fetch source data", successCriteria: ["data fetched"] },
      { id: "search", title: "Search", dependsOn: ["fetch"], successCriteria: ["search done"] }
    ],
    { replace: true, source: "test" }
  );
  runtime.startTask(goalId, "fetch", { reason: "start" });
  runtime.applyWorkerResult(goalId, "fetch", {
    status: WORKER_OUTCOME.BLOCKED,
    blockedReason: "Source API is unavailable.",
    error: "unavailable"
  });
  const downstream = runtime.getTask(goalId, "search");
  assert.equal(downstream.status, TASK_STATUS.BLOCKED);
  assert.match(downstream.blockedReason, /Dependency fetch is blocked/);
}

async function testReadyDrainContinuesAfterDependencyPropagationBlock() {
  reset();
  const goalId = "goal-drain-propagation";
  runtime.registerGoalTasks(
    goalId,
    [
      { id: "fetch", title: "Fetch source data", maxAttempts: 1, successCriteria: ["data fetched"] },
      { id: "verify", title: "Verify source data", dependsOn: ["fetch"], successCriteria: ["verification done"] },
      { id: "independent", title: "Independent lookup", maxAttempts: 1, successCriteria: ["lookup done"] }
    ],
    { replace: true, source: "test" }
  );
  const allTasks = runtime.listTasks(goalId);
  const executedTaskIds = new Set();
  const runOrder = [];
  const syncRuntimeTasks = () => {
    const latest = runtime.listTasks(goalId);
    for (const task of latest) {
      const index = allTasks.findIndex((item) => item.id === task.id);
      if (index >= 0) allTasks[index] = task;
      else allTasks.push(task);
    }
    return latest;
  };
  const result = await taskExecutor.drainReadyTasks({
    goalId,
    iteration: 1,
    config: { maxTasks: 2 },
    defaultConfig: { maxTasks: 2 },
    executedTaskIds,
    allTasks,
    syncRuntimeTasks,
    emitGraph: () => runtime.getExecutionGraph(goalId),
    trace: [],
    runWorkerTask: async (task) => {
      runOrder.push(task.id);
      runtime.startTask(goalId, task.id, { reason: "start" });
      if (task.id === "independent") {
        const updated = runtime.applyWorkerResult(goalId, task.id, {
          status: WORKER_OUTCOME.SUCCESS,
          output: "Independent lookup returned valid evidence.",
          evidence: semanticEvidence("Independent lookup returned valid evidence.")
        });
        syncRuntimeTasks();
        executedTaskIds.add(task.id);
        return { task: updated, status: updated.status, ok: true, content: updated.result };
      }
      const updated = runtime.applyWorkerResult(goalId, task.id, {
        status: WORKER_OUTCOME.FAILURE,
        error: "Source API is unavailable."
      });
      syncRuntimeTasks();
      executedTaskIds.add(task.id);
      return { task: updated, status: updated.status, ok: false, error: updated.error };
    }
  });
  assert.equal(result.pausedTask, null);
  assert.deepEqual(runOrder.sort(), ["fetch", "independent"]);
  assert.equal(runtime.getTask(goalId, "verify").status, TASK_STATUS.BLOCKED);
  assert.match(runtime.getTask(goalId, "verify").blockedReason, /Dependency fetch is failed/);
  assert.equal(executedTaskIds.has("verify"), false);
}

function testDynamicGraphUpdate() {
  reset();
  const goalId = "goal-dynamic-graph";
  createTask(goalId, { id: "base", produces: ["base_artifact"], maxAttempts: 1 });
  runtime.startTask(goalId, "base", { reason: "start" });
  runtime.applyWorkerResult(goalId, "base", {
    status: WORKER_OUTCOME.SUCCESS,
    output: "base_artifact is available.",
    evidence: semanticEvidence("base_artifact is available.")
  });
  runtime.registerGoalTasks(
    goalId,
    [
      {
        id: "later",
        title: "Later task",
        dependsOn: ["base"],
        consumes: ["base_artifact"],
        successCriteria: ["later done"]
      }
    ],
    { source: "dynamic" }
  );
  assert.equal(runtime.nextWaitingTask(goalId).id, "later");
}

function testDynamicTasksDependingOnFailedTaskAreBlocked() {
  reset();
  const goalId = "goal-dynamic-failed-dependency";
  createTask(goalId, { id: "base", produces: ["base_artifact"], maxAttempts: 1 });
  runtime.startTask(goalId, "base", { reason: "start" });
  runtime.applyWorkerResult(goalId, "base", {
    status: WORKER_OUTCOME.FAILURE,
    error: "Source API is unavailable."
  });
  runtime.registerGoalTasks(
    goalId,
    [
      {
        id: "later",
        title: "Later task",
        dependsOn: ["base"],
        consumes: ["base_artifact"],
        successCriteria: ["later done"]
      }
    ],
    { source: "dynamic" }
  );
  const later = runtime.getTask(goalId, "later");
  assert.equal(later.status, TASK_STATUS.BLOCKED);
  assert.match(later.blockedReason, /Dependency base is failed/);
  assert.deepEqual(
    runtime.readyTasks(goalId).map((task) => task.id),
    []
  );
}

function testDeleteTaskRemovesTaskAndUpdatesGraph() {
  reset();
  const goalId = "goal-delete-task";
  runtime.registerGoalTasks(
    goalId,
    [
      { id: "extract", title: "Extract", produces: ["project_list"], successCriteria: ["done"] },
      { id: "analyze", title: "Analyze", dependsOn: ["extract"], consumes: ["project_list"], successCriteria: ["done"] }
    ],
    { replace: true, source: "test" }
  );

  const deletion = runtime.deleteTask(goalId, "extract", { source: "test" });
  assert.equal(deletion.task.id, "extract");
  assert.equal(deletion.taskId, "extract");
  assert.equal(runtime.getTask(goalId, "extract"), null);
  assert.deepEqual(
    runtime.listTasks(goalId).map((task) => task.id),
    ["analyze"]
  );

  const graph = runtime.getExecutionGraph(goalId);
  assert.deepEqual(
    graph.nodes.map((node) => node.id),
    ["analyze"]
  );
  assert.equal(graph.nodes[0].readiness.status, "blocked");
  assert.equal(runtime.getTask(goalId, "analyze").dependencyStatus, "blocked");

  runtime.startTask(goalId, "analyze", { reason: "force_running_for_delete_test" });
  assert.throws(() => runtime.deleteTask(goalId, "analyze", { source: "test" }), /Running task cannot be deleted/);
}

function testIllegalTransitions() {
  reset();
  const goalId = "goal-illegal";
  createTask(goalId, { id: "illegal" });

  assert.throws(
    () => runtime.transitionTask(goalId, "illegal", TASK_STATUS.COMPLETED, "skip_running"),
    /Illegal task status transition/
  );

  runtime.startTask(goalId, "illegal", { reason: "start" });
  runtime.applyWorkerResult(goalId, "illegal", {
    status: WORKER_OUTCOME.SUCCESS,
    output: "Task completed with enough concrete details for semantic verification.",
    evidence: semanticEvidence("Task completed with enough concrete details for semantic verification.")
  });
  assert.throws(
    () => runtime.transitionTask(goalId, "illegal", TASK_STATUS.RUNNING, "restart_done"),
    /Illegal task status transition/
  );
}

function testExecuteNextTaskLoop() {
  reset();
  const goalId = "goal-loop";
  runtime.registerGoalTasks(
    goalId,
    [
      { id: "one", title: "First", modelPool: "free", successCriteria: ["done"] },
      { id: "two", title: "Second", modelPool: "coding", dependencies: ["one"], successCriteria: ["done"] }
    ],
    { replace: true, source: "test" }
  );

  return runtime
    .executeNextTask(goalId, async (task) => ({
      status: WORKER_OUTCOME.SUCCESS,
      output: `finished ${task.id} with concrete task evidence`,
      evidence: semanticEvidence(`finished ${task.id} with concrete task evidence`)
    }))
    .then((result) => {
      assert.equal(result.ok, true);
      assert.equal(result.task.id, "one");
      assert.equal(result.task.status, TASK_STATUS.COMPLETED);
      const next = runtime.nextWaitingTask(goalId);
      assert.equal(next.id, "two");
    });
}

function testPersistence() {
  reset();
  const goalId = "goal-persist";
  createTask(goalId, { id: "persist" });
  runtime.startTask(goalId, "persist", { reason: "persist_start" });
  runtime.applyWorkerResult(goalId, "persist", {
    status: WORKER_OUTCOME.SUCCESS,
    output: "persisted task result with concrete verification evidence",
    evidence: semanticEvidence("persisted task result with concrete verification evidence")
  });

  assert.ok(fs.existsSync(testStore));
  runtime.reloadRuntime();
  const [task] = runtime.listTasks(goalId);
  assert.equal(task.id, "persist");
  assert.equal(task.status, TASK_STATUS.COMPLETED);
  assert.equal(task.result, "persisted task result with concrete verification evidence");
  assert.equal(task.history.length, 3);
}

async function main() {
  testNormalCompletion();
  testRetryFlow();
  testHumanConfirmationFlow();
  await testHighRiskTaskWaitsForHumanBeforeWorker();
  await testLowRiskTaskCanExecuteAutomatically();
  await testExecuteNextTaskRequiresWorker();
  await testExecuteNextTaskActionRequiresWorkerResult();
  await testActionApiListPayloadsAreCompact();
  await testActionApiDerivesFailedGoalStatusFromTasks();
  testDangerousShellIsBlockedAfterWorker();
  testRetryCountEscalatesRisk();
  testBrowserSubmitTriggersHumanApproval();
  testWorkerCannotBypassRiskEngine();
  testWorkerSuccessButVerificationFails();
  testBrowserSubmitVerificationPasses();
  testShellBuildVerification();
  testFileChangeVerification();
  await testVerificationCausesRetryAndRequeue();
  testVerificationBlockedAndRiskEscalated();
  testTaskDoesNotCompleteOnThinSuccess();
  testMissingEvidenceBlocksWorkerSuccess();
  testEvidenceNormalizerMapsLegacyContext();
  testVerifierModelCanImproveSemanticVerification();
  testTaskRetryBudgetBlocksStart();
  testGoalRuntimeBudgetExhaustion();
  testGoalBudgetPersistsAcrossReload();
  testBrowserActionBudgetBlocksWorker();
  testReadOnlyWebToolEvidenceDoesNotUseBrowserNavigationBudget();
  testTokenBudgetBlocksWorker();
  testUnlimitedBudgetDoesNotBlockOrDowngrade();
  testBudgetModelDowngrade();
  testVerificationRetryBudgetBlocks();
  testMemoryCanReduceRepeatedWorkBudget();
  testGoalStrategyCanBeGeneratedAndStored();
  testStrategyUsesModelDeclaredRiskForApprovalBoundary();
  testStrategyRevisionAndStopConditions();
  testTaskCanLinkToStrategy();
  testStrategyMemoryCandidate();
  testDependencySatisfiedMakesTaskReady();
  testDependencyMissingBlocksTask();
  testCycleDetectionBlocksInvalidTasks();
  testVerificationNeedsEvidenceDoesNotBlockDownstream();
  testAlternativeVerifiedEvidenceUnblocksConsumedArtifact();
  testReadOnlyToolFailureNeedsEvidenceInsteadOfHardFailure();
  testRetryScopeCorrectness();
  testArtifactDependencyValidation();
  testParallelReadyTaskDetection();
  testStrategyDoesNotGenerateKeywordApprovalDependency();
  testReadOnlyExternalResearchDoesNotNeedApprovalDependency();
  testReadOnlyWebSearchWithNegatedSideEffectsDoesNotNeedApprovalDependency();
  testReadOnlyNewsSearchWithPublishTimestampDoesNotNeedApprovalDependency();
  testReadOnlyNewsSearchWithPublishUpdateDateDoesNotNeedApprovalDependency();
  testBlockedPropagation();
  await testReadyDrainContinuesAfterDependencyPropagationBlock();
  testDynamicGraphUpdate();
  testDynamicTasksDependingOnFailedTaskAreBlocked();
  testDeleteTaskRemovesTaskAndUpdatesGraph();
  testIllegalTransitions();
  await testExecuteNextTaskLoop();
  testPersistence();
  fs.rmSync(testStore, { force: true });
}

main()
  .then(() => {
    console.log("agent-route-task-runtime tests passed");
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
