"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-dashboard-"));
process.env.AGENT_ROUTE_HOME = testRoot;
process.env.AGENT_ROUTE_TASKS = path.join(testRoot, "tasks.json");
process.env.AGENT_ROUTE_OBSERVABILITY = path.join(testRoot, "observability.json");
process.env.AGENT_ROUTE_BUDGET_RECORDS = path.join(testRoot, "budget-records.json");

const actionApi = require("./agent/orchestrator/action-api");
const eventStream = require("./agent/orchestrator/event-stream");
const observability = require("./agent/observability");
const recovery = require("./agent/recovery");
const taskRuntime = require("./agent/tasks");

function studioSource() {
  return fs.readFileSync(path.join(__dirname, "..", "app", "agent-route", "studio.js"), "utf8");
}

function testDashboardRecoverySourceWiring() {
  const source = studioSource();
  assert.match(source, /function RecoveryPanel/, "dashboard renders recovery panel");
  assert.match(source, /action:\s*"recovery_status"/, "dashboard can request recovery status");
  assert.match(source, /action:\s*"run_recovery"/, "dashboard can trigger recovery scan");
  assert.match(source, /recoverycompleted/, "event timeline knows recovery completed events");
  assert.match(source, /WorkerLostDetected|workerlostdetected/, "event timeline knows worker-lost events");
  assert.match(
    source,
    /BrowserSessionMarkedStale|browsersessionmarkedstale/,
    "event timeline knows stale browser session events"
  );
  assert.match(source, /taskRecoveryInfo/, "task cards surface recovery state");
  assert.match(source, /worker_process_lost/, "blocked task reason is localized");
  assert.match(source, /browser_session_lost/, "browser recovery reason is localized");
  assert.match(source, /safeDisplayText/, "recovery display uses redaction helper");
  assert.match(source, /真实性/, "dashboard renders authenticity labels");
  assert.match(source, /AuthenticityChecked|authenticitychecked/, "event timeline knows authenticity check events");
  assert.match(source, /AuthenticityWarning|authenticitywarning/, "event timeline knows authenticity warning events");
  assert.match(source, /AuthenticityBlocked|authenticityblocked/, "event timeline knows authenticity blocked events");
  assert.match(source, /authenticitySuggestion/, "task cards explain authenticity decisions");
  assert.match(source, /eventFilter/, "event timeline supports filtering");
  assert.match(
    source,
    /CorrectiveActionSuggested|correctiveactionsuggested/,
    "event timeline knows corrective action events"
  );
  assert.match(source, /建议动作/, "task cards render corrective action panel");
  assert.match(source, /ActionRanked|actionranked/, "event timeline knows action ranking events");
  assert.match(source, /建议排序/, "task cards render action decision ranking panel");
  assert.match(source, /ActionLearningUpdated|actionlearningupdated/, "event timeline knows action learning events");
  assert.match(source, /行为经验/, "task cards render action learning panel");
  assert.match(source, /DecisionAttributed|decisionattributed/, "event timeline knows decision attribution events");
  assert.match(source, /决策来源/, "task cards render decision attribution panel");
  assert.match(source, /真实失败原因/, "task details render explicit failure reasons");
  assert.match(source, /taskFailureReasons/, "dashboard extracts task failure reasons");
  assert.match(source, /commonFailureTextLabel/, "dashboard localizes raw failure text before rendering");
  assert.match(source, /当前地区不支持调用这个模型 API/, "dashboard translates provider location errors");
  assert.match(source, /MarkdownOutput/, "final result is rendered as markdown-safe React output");
  assert.match(source, /function TaskWorkspacePanel/, "task queue and task graph share one task workspace page");
  assert.match(source, /TASK_PANEL_TABS/, "task workspace separates queue and graph with tabs");
  assert.match(source, /data-agent-section="tasks"/, "dashboard exposes one merged task section");
  assert.match(source, /Agent 总指挥/, "dashboard labels internal commander steps as agent tasks");
  assert.match(source, /function groupGraphNodesForDisplay/, "task graph has its own node grouping");
  assert.match(source, /graphNodeExecutionGroup\(node\)/, "task graph groups by node execution group");
  assert.match(
    source,
    /task-graph-node \$\{taskExecutionGroupClass\(graphNodeExecutionGroup\(node\)\)\}/,
    "task graph node class uses graph grouping"
  );
  assert.match(source, /graphReadinessMeta/, "task graph renders readiness as execution/dependency state");
  assert.doesNotMatch(source, /agent_ready/, "ready agent graph nodes should not be mislabeled as pending decision");
  assert.match(source, /createdByTaskId/, "task graph records which task created or invoked a task");
  assert.match(
    fs.readFileSync(path.join(__dirname, "agent", "orchestrator", "task-executor.js"), "utf8"),
    /source: task\.source/,
    "task event summaries preserve task creation source"
  );
  assert.match(source, /调用自/, "task graph details show the invoking task");
  assert.match(source, /调用了/, "task graph details show downstream invoked tasks");
  assert.match(
    source,
    /visualDependencies/,
    "task graph can position invocation links without changing real dependencies"
  );
  assert.match(source, /edge\.type === "invokes"/, "task graph renders explicit invocation edges");
  assert.match(source, /updatedAt: raw\.updatedAt/, "dashboard keeps task update timestamps");
  assert.doesNotMatch(
    source,
    /data\.status \|\| data\.task\?\.status \|\|/,
    "worker_done display status must not be overridden by stale task summary status"
  );
  assert.match(
    source,
    /const internalTasks = array\(next\.tasks\)\.filter\(isRouteInternalTask\)/,
    "plan updates preserve visible agent decision tasks"
  );
  assert.doesNotMatch(
    source,
    /if \(isRouteInternalTask\(\{ \.\.\.raw, id \}\)\) return goal/,
    "stream task updates must not drop internal agent decision steps"
  );
  assert.match(source, /if \(isDone\(next\.status\)\)/, "completed task updates clear stale failure fields");
  assert.match(source, /failureReason|failure_reason/, "dashboard consumes final stream failure summaries");
  assert.match(source, /未通过验证/, "dashboard labels unverified results as failed verification");
  assert.match(source, /uniqueDisplayList/, "dashboard deduplicates repeated detail reasons");
  assert.match(source, /needsHumanAttention/, "dashboard counts approval tasks as attention items");
  assert.match(source, /canApproveTask/, "dashboard allows approval for pending human-approval tasks");
  assert.match(source, /startNewTaskDraft/, "control center exposes a new task draft action");
  assert.match(source, /创建新任务/, "control center renders a create-new-task button");
  assert.match(source, /data-open-providers/, "control center links to the restored provider dashboard route");
  assert.match(source, /\/dashboard\/providers/, "provider settings open the provider dashboard route");
  const providerPage = fs.readFileSync(
    path.join(__dirname, "..", "app", "dashboard", "providers", "provider-console.js"),
    "utf8"
  );
  assert.match(providerPage, /OAuth Providers/, "provider dashboard renders OAuth provider catalog");
  assert.match(providerPage, /Custom Providers/, "provider dashboard renders custom provider node management");
  assert.match(providerPage, /\/api\/providers/, "provider dashboard uses the provider API backend");
  assert.match(providerPage, /\/api\/provider-nodes/, "provider dashboard uses the provider node API backend");
  assert.match(
    fs.readFileSync(path.join(__dirname, "agent", "orchestrator", "action-api.js"), "utf8"),
    /authenticity_status/,
    "action API exposes authenticity status"
  );
  assert.match(
    fs.readFileSync(path.join(__dirname, "agent", "orchestrator", "action-api.js"), "utf8"),
    /corrective_status/,
    "action API exposes corrective status"
  );
  assert.match(
    fs.readFileSync(path.join(__dirname, "agent", "orchestrator", "action-api.js"), "utf8"),
    /action_decision_status/,
    "action API exposes action decision status"
  );
  assert.match(
    fs.readFileSync(path.join(__dirname, "agent", "orchestrator", "action-api.js"), "utf8"),
    /action_learning_status/,
    "action API exposes action learning status"
  );
  assert.match(
    fs.readFileSync(path.join(__dirname, "agent", "orchestrator", "action-api.js"), "utf8"),
    /decision_attribution_status/,
    "action API exposes decision attribution status"
  );
  assert.match(
    fs.readFileSync(path.join(__dirname, "agent", "orchestrator", "action-api.js"), "utf8"),
    /provider_status/,
    "action API exposes provider status"
  );
  assert.match(
    fs.readFileSync(path.join(__dirname, "agent", "orchestrator", "action-api.js"), "utf8"),
    /save_provider_node/,
    "action API exposes custom provider node management"
  );
  assert.match(
    fs.readFileSync(path.join(__dirname, "agent", "orchestrator", "runtime.js"), "utf8"),
    /blockedWhenNoSuccessfulWorkerEvidence/,
    "agent route must not produce a final answer without successful worker evidence"
  );
}

function testEventStreamSummarizesFailureReason() {
  const summary = eventStream.summarizeEvent("pause", {
    status: "blocked",
    message: "Worker returned error text: Google News RSS produced no usable output.",
    task: {
      id: "collect_market_news",
      title: "Collect market data",
      status: "blocked",
      error: "Google News RSS produced no usable output."
    }
  });
  assert.equal(summary.status, "blocked");
  assert.match(summary.failureReason, /Google News RSS/);
  assert.equal(summary.task.id, "collect_market_news");
}

function testEventStreamDoesNotMarkFailedFinalAsCompleted() {
  const summary = eventStream.summarizeEvent("final", {
    status: "failed",
    content: "Commander could not create a plan: upstream credits exhausted.",
    source_model: "openrouter/test"
  });
  assert.equal(summary.status, "failed");
  assert.match(summary.failureReason, /credits exhausted/);
}

function testTaskCreationMetadataRecordsInvoker() {
  taskRuntime.resetRuntime();
  taskRuntime.registerGoalTasks(
    "dashboard-graph-origin-goal",
    [{ id: "collect", title: "Collect evidence", type: "web_search" }],
    { replace: true, source: "commander" }
  );
  taskRuntime.registerGoalTasks(
    "dashboard-graph-origin-goal",
    [{ id: "analyze", title: "Analyze evidence", type: "analysis", dependsOn: ["collect"] }],
    {
      source: "review",
      createdByTaskId: "goal-review-1",
      createdByTaskTitle: "Review progress and decide next step"
    }
  );
  const tasks = taskRuntime.listTasks("dashboard-graph-origin-goal");
  const collect = tasks.find((task) => task.id === "collect");
  const analyze = tasks.find((task) => task.id === "analyze");
  assert.equal(collect.source, "commander");
  assert.equal(collect.createdByTaskId, "plan");
  assert.equal(analyze.source, "review");
  assert.equal(analyze.createdByTaskId, "goal-review-1");
}

async function testRecoveryActionsStillReturnStructuredSummary() {
  taskRuntime.resetRuntime();
  recovery.resetRecoveryRuntime();
  observability.setStorageFile(process.env.AGENT_ROUTE_OBSERVABILITY);
  observability.resetRuntime();
  taskRuntime.registerGoalTasks(
    "dashboard-recovery-goal",
    [{ id: "run", title: "Running task", status: taskRuntime.TASK_STATUS.RUNNING, modelPool: "codex-cli" }],
    { replace: true, source: "dashboard-test" }
  );

  const runResponse = await actionApi.handleAgentRouteAction({
    action: "run_recovery",
    goal_id: "dashboard-recovery-goal"
  });
  const runJson = await runResponse.json();
  assert.equal(runJson.ok, true);
  assert.equal(typeof runJson.recovery.at, "string");
  assert.ok(Number(runJson.recovery.scannedTasks) >= 1);
  assert.ok(Number(runJson.recovery.interruptedTasks) >= 1);

  const statusResponse = await actionApi.handleAgentRouteAction({ action: "recovery_status" });
  const statusJson = await statusResponse.json();
  assert.equal(statusJson.ok, true);
  assert.equal(statusJson.recovery.at, runJson.recovery.at);
}

async function main() {
  testDashboardRecoverySourceWiring();
  testEventStreamSummarizesFailureReason();
  testEventStreamDoesNotMarkFailedFinalAsCompleted();
  testTaskCreationMetadataRecordsInvoker();
  await testRecoveryActionsStillReturnStructuredSummary();
  console.log("agent route dashboard tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
