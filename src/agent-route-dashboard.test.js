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

function chatSource() {
  return fs.readFileSync(path.join(__dirname, "..", "app", "agent-route", "chat", "agent-chat.js"), "utf8");
}

function markdownSource() {
  return fs.readFileSync(path.join(__dirname, "..", "app", "agent-route", "markdown-output.js"), "utf8");
}

function stylesheetSource() {
  return fs.readFileSync(path.join(__dirname, "..", "app", "globals.css"), "utf8");
}

function testDashboardRecoverySourceWiring() {
  const source = studioSource();
  const chat = chatSource();
  const markdown = markdownSource();
  const styles = stylesheetSource();
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
  assert.match(chat, /MarkdownOutput/, "chat final answers use markdown-safe React output");
  assert.match(markdown, /function renderMarkdownBlocks/, "markdown output uses block-level rendering");
  assert.match(
    markdown,
    /function normalizeMarkdownContent/,
    "markdown output unwraps structured final answer payloads"
  );
  assert.match(markdown, /answerMarkdown/, "markdown output can display answerMarkdown payload text directly");
  assert.match(markdown, /markdown-task-list/, "markdown output renders task lists");
  assert.match(markdown, /isHorizontalRule/, "markdown output renders separators");
  assert.match(styles, /\.markdown-output h2/, "markdown output has report-grade heading styles");
  assert.match(styles, /\.markdown-output pre\[data-language\]::before/, "markdown code blocks show language labels");
  assert.match(chat, /storedRound/, "chat reconstructs stored rounds after reload");
  assert.match(chat, /historyGoals/, "chat receives persisted goal history");
  assert.match(
    chat,
    /function isRoundAwaitingProcess[\s\S]*String\(round\.answer \|\| ""\)\.trim\(\)\) return false/,
    "chat does not show a pending-process placeholder beside restored results"
  );
  assert.match(chat, /existingEventIndex/, "chat updates an in-flight process event when completion arrives");
  assert.match(chat, /真实性检查/, "chat labels authenticity process events instead of repeating task titles");
  assert.match(chat, /建议动作已生成/, "chat labels corrective process events instead of repeating task titles");
  assert.doesNotMatch(
    chat,
    /partId && round\.events\.some\(\(item\) => item\.partId === partId\)\) return current/,
    "chat must not discard completion updates for a running process event"
  );
  assert.match(source, /function TaskWorkspacePanel/, "task queue and task graph share one task workspace page");
  assert.match(source, /TASK_PANEL_TABS/, "task workspace separates queue and graph with tabs");
  assert.match(source, /agent-chat-attention-panel/, "chat view surfaces tasks needing attention");
  assert.doesNotMatch(source, /data-agent-section="tasks"/, "chat view is the single task workspace host");
  assert.match(
    styles,
    /\.agent-chat-task-pane \.task-queue-main\s*{\s*grid-template-columns: minmax\(248px, 1fr\) minmax\(268px, 0\.92fr\);/,
    "chat task queue keeps its list and detail inspector side by side on desktop"
  );
  assert.match(
    styles,
    /\.agent-chat-task-pane \.task-graph-main\s*{\s*grid-template-columns: minmax\(306px, 1\.06fr\) minmax\(262px, 0\.84fr\);/,
    "chat task graph keeps its canvas and detail inspector side by side on desktop"
  );
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
  assert.doesNotMatch(source, /data-agent-section="control"/, "control center has been removed from the frontend");
  assert.doesNotMatch(source, /\["control",\s*"控制中心"/, "navigation no longer exposes the control center");
  assert.doesNotMatch(source, /暂停所有任务/, "sidebar must not expose the legacy pause-all control");
  assert.match(source, /创建新任务/, "sidebar exposes chat-first new task creation");
  assert.match(chat, /id="agentChatInput"/, "chat composer exposes a stable focus target for new tasks");
  assert.match(
    chat,
    /event\.currentTarget\.form\?\.requestSubmit\(\)/,
    "chat composer sends with Enter through the form submit path"
  );
  assert.match(source, /data-open-providers/, "sidebar links to the provider dashboard route");
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
  assert.match(
    fs.readFileSync(path.join(__dirname, "agent", "orchestrator", "runtime.js"), "utf8"),
    /finalBlockedByUnresolvedPlannedTasks/,
    "agent route must not produce a final answer while planned tasks are unresolved"
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

function testEventStreamUsesLifecycleSpecificPartIds() {
  const taskPayload = {
    goal_id: "goal-event-id",
    task: {
      id: "review",
      title: "Review progress and decide next step",
      modelPool: "commander"
    }
  };
  const workerStartId = eventStream.uiDataPartIdForEvent("worker_start", taskPayload, 1);
  const workerDoneId = eventStream.uiDataPartIdForEvent("worker_done", taskPayload, 2);
  const budgetId = eventStream.uiDataPartIdForEvent("budget", taskPayload, 3);
  const modelAttemptId = eventStream.uiDataPartIdForEvent("model_attempt", taskPayload, 4);
  const modelSuccessId = eventStream.uiDataPartIdForEvent("model_success", taskPayload, 5);
  assert.equal(workerStartId, workerDoneId, "worker completion should replace the running worker row");
  assert.equal(modelAttemptId, modelSuccessId, "model completion should replace the running model row");
  assert.notEqual(budgetId, workerDoneId, "budget updates must not overwrite the completed worker row");
  assert.notEqual(modelSuccessId, workerDoneId, "model updates must not overwrite the worker lifecycle row");
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
  testEventStreamUsesLifecycleSpecificPartIds();
  testTaskCreationMetadataRecordsInvoker();
  await testRecoveryActionsStillReturnStructuredSummary();
  console.log("agent route dashboard tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
