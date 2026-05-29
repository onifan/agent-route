"use strict";

const taskRuntime = require("../tasks");
const memoryRuntime = require("../memory");
const budgetGovernor = require("../budget");
const dependencyEngine = require("../graph");
const strategyEngine = require("../strategies");
const verificationEngine = require("../verification");
const observabilityRuntime = require("../observability");
const actionApi = require("./action-api");
const codexCliRunner = require("./codex-cli-runner");
const contentUtils = require("./content-utils");
const eventStream = require("./event-stream");
const finalizer = require("./finalizer");
const goalSetup = require("./goal-setup");
const initialPlanning = require("./initial-planning");
const langGraphRunner = require("./langgraph-runner");
const loopController = require("./loop-controller");
const modelRoutingService = require("./model-routing-service");
const planner = require("./planner");
const promptService = require("./prompt-service");
const protocol = require("./protocol");
const reviewRunner = require("./review-runner");
const taskAppender = require("./task-appender");
const taskContext = require("./task-context");
const taskExecutor = require("./task-executor");
const taskGates = require("./task-gates");
const taskStateUpdater = require("./task-state-updater");
const taskVerificationStep = require("./task-verification-step");
const workerDispatcher = require("./worker-dispatcher");
const workerResultProcessor = require("./worker-result-processor");
const workerRunner = require("./worker-runner");
const configLoader = require("../../config/loader");
const { corsHeaders, preflightResponse } = require("../../security/cors");
const { checkRequestAuth } = require("../../security/request-auth");

const { TASK_STATUS } = taskRuntime;
const { handleAgentRouteAction, normalizeAgentRouteAction } = actionApi;

const AGENT_MODEL_IDS = new Set(["agent-auto", "agent-router", "auto-agent", "goal-agent"]);

const {
  COMMANDER_MODEL_OPTIONS,
  DEFAULT_COMMANDER_MODELS,
  DEFAULT_CONFIG,
  DEFAULT_MODEL_POOLS,
  DEFAULT_PROMPT_SETTINGS,
  applyRequestConfig,
  normalizePromptSettings
} = configLoader;

function loadConfig() {
  return modelRoutingService.loadConfig();
}

function freeModelScore(model) {
  return modelRoutingService.freeModelScore(model);
}

async function resolveConfig() {
  return modelRoutingService.resolveConfig();
}

function isAgentModel(model) {
  return AGENT_MODEL_IDS.has(String(model || "").trim());
}

function isCommanderModel(model) {
  return DEFAULT_COMMANDER_MODELS.includes(String(model || "").trim());
}

function requestPathname(req) {
  try {
    return new URL(req.url).pathname;
  } catch {
    return "";
  }
}

function normalizeAgentDashboardBody(req, body) {
  if (!body || typeof body !== "object") return body;
  if (isAgentModel(body.model)) return body;
  const isDashboardChat = requestPathname(req) === "/api/dashboard/chat/completions";
  if (!isDashboardChat || !isCommanderModel(body.model)) return body;
  return {
    ...body,
    model: "agent-auto",
    agent_route: {
      ...(body.agent_route || {}),
      commander_model: String(body.model).trim()
    }
  };
}

function jsonResponse(body, status = 200, extraHeaders = {}, requestOrOrigin = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(requestOrOrigin, {
      "Content-Type": "application/json",
      ...extraHeaders
    })
  });
}

function cloneHeaders(headers) {
  const nextHeaders = new Headers(headers || {});
  nextHeaders.set("Content-Type", "application/json");
  nextHeaders.delete("content-length");
  return nextHeaders;
}

function requestWithBody(req, body, timeoutMs) {
  const controller = new AbortController();
  const abortFromRequest = () => controller.abort(req.signal && req.signal.reason);
  if (req.signal) {
    if (req.signal.aborted) controller.abort(req.signal.reason);
    else req.signal.addEventListener("abort", abortFromRequest, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const request = new Request(req.url, {
    method: "POST",
    headers: cloneHeaders(req.headers),
    body: JSON.stringify(body),
    signal: controller.signal
  });
  return {
    request,
    timer,
    cleanup: () => {
      if (req.signal) req.signal.removeEventListener("abort", abortFromRequest);
    }
  };
}

function detachedRequestFromClientAbort(req) {
  return new Request(req.url, {
    method: req.method || "POST",
    headers: new Headers(req.headers || {})
  });
}

function messagesToText(messages) {
  return contentUtils.messagesToText(messages);
}

function lastUserText(messages) {
  return contentUtils.lastUserText(messages);
}

function shouldUseCodexCliWorker(messages) {
  return planner.shouldUseCodexCliWorker(messages);
}

function tierPromptForTask(promptSettings, task) {
  return promptService.tierPromptForTask(promptSettings, task);
}

function makeCodexCliPrompt(messages, config, memoryText = "") {
  return promptService.makeCodexCliPrompt(messages, config, memoryText);
}

function makeCodexCliTaskPrompt(originalMessages, task, previousResults = [], config, memoryText = "") {
  return promptService.makeCodexCliTaskPrompt(originalMessages, task, previousResults, config, memoryText);
}

function normalizeContent(content) {
  return contentUtils.normalizeContent(content);
}

function extractChatContent(data) {
  return contentUtils.extractChatContent(data);
}

function extractResponsesContent(data) {
  return contentUtils.extractResponsesContent(data);
}

async function parseModelResponse(response) {
  return contentUtils.parseModelResponse(response);
}

function normalizeComplexity(value, defaultValue = "medium") {
  return planner.normalizeComplexity(value, defaultValue);
}

function normalizeRiskLevel(value, defaultValue = "low") {
  return planner.normalizeRiskLevel(value, defaultValue);
}

function normalizeStringList(value) {
  return planner.normalizeStringList(value);
}

function normalizeBoolean(value) {
  return planner.normalizeBoolean(value);
}

function defaultComplexityForPool(poolName) {
  return planner.defaultComplexityForPool(poolName);
}

function estimateGoalComplexity(messages = []) {
  const text = lastUserText(messages) || messagesToText(messages);
  const lower = text.toLowerCase();
  if (shouldUseCodexCliWorker(messages)) {
    if (/代码|项目|修复|实现|localhost|浏览器|网页|click|screenshot|test|build|deploy/.test(lower)) return "high";
    return "medium";
  }
  if (
    /架构|设计|重构|复杂|多步|实现|代码|debug|调试|review|安全|合规|研究|报告|数据|critical|architecture|refactor/.test(
      lower
    )
  )
    return "high";
  if (text.length > 500 || /分析|方案|比较|计划|reason|strategy/.test(lower)) return "medium";
  return "low";
}

function makeWorkerMessages(originalMessages, task, config, memoryText = "", previousResults = []) {
  return workerRunner.makeWorkerMessages(originalMessages, task, config, memoryText, {
    normalizePromptSettings,
    tierPromptForTask,
    previousResults
  });
}

function makeVerifierMessages(originalMessages, task, workerRuntimeResult, ruleVerification, strategy = null) {
  return workerRunner.makeVerifierMessages(originalMessages, task, workerRuntimeResult, ruleVerification, strategy);
}

async function verifyTaskResultWithOptionalModel({
  req,
  nextHandler,
  baseBody,
  config,
  commanderRoute,
  messages,
  task,
  workerRuntimeResult,
  trace,
  endpointMode,
  modelLabel = "verifier",
  budgetState = null,
  onBudgetUpdate = null,
  strategy = null
}) {
  const ruleVerification = verificationEngine.verifyTaskResult(task, workerRuntimeResult, {
    phase: "after_worker",
    strategy,
    verificationPolicy: config.verificationPolicy
  });
  let verification = verificationEngine.compactVerification(ruleVerification);
  const verifierEnabled = config.verifierModelEnabled !== false;
  if (!verifierEnabled || !verificationEngine.shouldUseVerifierModel(task, workerRuntimeResult, verification)) {
    return verification;
  }

  const verifierModels = [
    ...new Set(
      [
        ...(config.modelPools && Array.isArray(config.modelPools.strong) ? config.modelPools.strong : []),
        ...(commanderRoute && Array.isArray(commanderRoute.models) ? commanderRoute.models : []),
        commanderRoute && commanderRoute.selected
      ].filter(Boolean)
    )
  ];
  if (!verifierModels.length) return verification;

  const attempt = await callRoutedModel({
    req,
    nextHandler,
    baseBody,
    models: verifierModels,
    messages: makeVerifierMessages(messages, task, workerRuntimeResult, verification, strategy),
    config,
    label: `${modelLabel}:${task.id || "task"}`,
    trace,
    endpointMode,
    timeoutMsOverride: Number(config.verifierTimeoutMs || DEFAULT_CONFIG.verifierTimeoutMs),
    budgetState,
    task,
    onBudgetUpdate,
    functionCallKind: protocol.KIND.VERIFICATION_RESULT,
    validateContent: (content) =>
      protocol.validationForCall(content, protocol.KIND.VERIFICATION_RESULT, (value) =>
        value.verificationStatus || typeof value.verified === "boolean"
          ? { ok: true }
          : { ok: false, error: "Verification result must include verificationStatus or verified." }
      )
  });
  if (!attempt.ok) {
    if (trace) {
      trace.push({
        label: `${modelLabel}:${task.id || "task"}:rule_only`,
        model: "verification-engine",
        ok: false,
        error: String(attempt.error || "verifier model unavailable").slice(0, 240)
      });
    }
    return verification;
  }
  const parsed = protocol.parseProtocolContent(attempt.content, protocol.KIND.VERIFICATION_RESULT, (value) =>
    value.verificationStatus || typeof value.verified === "boolean"
      ? { ok: true }
      : { ok: false, error: "Verification result must include verificationStatus or verified." }
  );
  if (!parsed.ok) {
    if (trace) {
      trace.push({
        label: `${modelLabel}:${task.id || "task"}:parse`,
        model: attempt.model || "verifier",
        ok: false,
        error: parsed.error || "Verifier model returned invalid protocol JSON.",
        diagnostics: parsed.diagnostics
      });
    }
    return verification;
  }
  verification = verificationEngine.mergeModelVerification(verification, parsed.value, config.verificationPolicy);
  return verificationEngine.compactVerification(verification);
}

function taskRequiresHumanAttention(task = {}) {
  const status = String(task.status || "").toLowerCase();
  const type = String(task.type || task.taskType || "").toLowerCase();
  const approvalStatus = String(task.approvalStatus || task.approval_status || "").toLowerCase();
  return (
    status === TASK_STATUS.WAITING_HUMAN ||
    status === TASK_STATUS.AWAITING_CONFIRMATION ||
    type === "human_approval" ||
    Boolean(task.requiresHumanApproval || task.requiresHumanConfirmation) ||
    approvalStatus === "pending"
  );
}

function nonInternalPlannedTasks(tasks = []) {
  return (tasks || []).filter(
    (task) =>
      task &&
      !task.internal &&
      !task.routeInternal &&
      !task.route_internal &&
      !/^(?:plan|final|goal-review(?:-\d+)?)$/.test(String(task.id || ""))
  );
}

function unresolvedPlannedTasks(tasks = []) {
  return nonInternalPlannedTasks(tasks).filter((task) => isActionableUnresolvedTask(task, tasks));
}

function taskAttemptsExhausted(task = {}) {
  return Number(task.attempts || 0) >= Math.max(1, Number(task.maxAttempts || 1));
}

function taskHasWorkerObservation(task = {}) {
  return Boolean(
    Number(task.attempts || 0) > 0 ||
    task.startedAt ||
    task.started_at ||
    task.finishedAt ||
    task.finished_at ||
    task.result ||
    task.output ||
    task.error ||
    task.verificationStatus ||
    task.verification_status
  );
}

function isExhaustedEvidenceGapTask(task = {}) {
  const status = String(task.status || TASK_STATUS.WAITING).toLowerCase();
  if (![TASK_STATUS.NEEDS_EVIDENCE, TASK_STATUS.RETRY_READY].includes(status)) return false;
  return taskAttemptsExhausted(task) && taskHasWorkerObservation(task);
}

function isEvidenceGapCoveredByAlternativeVerifiedArtifact(task = {}, tasks = []) {
  const status = String(task.status || TASK_STATUS.WAITING).toLowerCase();
  if (![TASK_STATUS.NEEDS_EVIDENCE, TASK_STATUS.RETRY_READY].includes(status)) return false;
  if (!taskHasWorkerObservation(task)) return false;
  const produced = dependencyEngine.normalizeArtifacts(
    task.produces || task.producedArtifacts || task.produced_artifacts || task.artifacts,
    task.id || ""
  );
  if (!produced.length) return false;
  const artifacts = dependencyEngine.buildArtifactRegistry(tasks);
  return produced.some((ref) => {
    const provider = artifacts.get(ref.id) || (ref.path ? artifacts.get(ref.path) : null);
    return provider && provider.taskId && provider.taskId !== task.id;
  });
}

function isActionableUnresolvedTask(task = {}, tasks = []) {
  const status = String(task.status || TASK_STATUS.WAITING).toLowerCase();
  if (isTerminalTaskStatus(status)) return false;
  if (isEvidenceGapCoveredByAlternativeVerifiedArtifact(task, tasks)) return false;
  if (isExhaustedEvidenceGapTask({ ...task, status })) return false;
  return true;
}

function compactTaskListForMessage(tasks = [], limit = 5) {
  return tasks
    .slice(0, limit)
    .map(
      (task) => `${task.id || "unknown"}(${task.status || TASK_STATUS.WAITING}: ${task.title || task.type || "task"})`
    )
    .join(", ");
}

function finalBlockedByUnresolvedPlannedTasks(tasks = []) {
  const unresolvedTasks = unresolvedPlannedTasks(tasks);
  if (!unresolvedTasks.length) {
    return { blocked: false, status: "", task: null, message: "", tasks: [] };
  }
  const attentionTask = unresolvedTasks.find((task) => taskRequiresHumanAttention(task));
  const first = attentionTask || unresolvedTasks[0];
  const waitingForHuman = Boolean(attentionTask);
  const visible = compactTaskListForMessage(unresolvedTasks);
  return {
    blocked: true,
    status: waitingForHuman ? TASK_STATUS.WAITING_HUMAN : TASK_STATUS.BLOCKED,
    task: first,
    tasks: unresolvedTasks,
    message: waitingForHuman
      ? first.approvalReason ||
        first.blockedReason ||
        `AgentRoute 还有 ${unresolvedTasks.length} 个已规划任务等待人工确认，不能生成最终答案：${visible}`
      : `AgentRoute 还有 ${unresolvedTasks.length} 个已规划任务未进入终态，不能生成最终答案：${visible}`,
    failureReasons: ["planned_tasks_unresolved_before_final"]
  };
}

function blockedWhenNoSuccessfulWorkerEvidence(tasks = []) {
  const plannedTasks = nonInternalPlannedTasks(tasks);
  if (!plannedTasks.length) {
    return {
      status: TASK_STATUS.FAILED,
      task: null,
      message: "AgentRoute 没有产生成功的 worker evidence，因此不能生成最终答案。",
      failureReasons: ["no_successful_worker_evidence"]
    };
  }
  const attentionTasks = plannedTasks.filter(
    (task) => !isTerminalTaskStatus(task.status) && taskRequiresHumanAttention(task)
  );
  if (attentionTasks.length) {
    const first = attentionTasks[0];
    return {
      status: TASK_STATUS.WAITING_HUMAN,
      task: first,
      message:
        first.approvalReason ||
        first.blockedReason ||
        `任务 ${first.title || first.id || "approval"} 正在等待人工批准，worker 暂不能继续执行。`,
      failureReasons: ["planned_tasks_waiting_for_human_approval"]
    };
  }
  const unresolvedTasks = plannedTasks.filter((task) => !isTerminalTaskStatus(task.status));
  if (unresolvedTasks.length) {
    const first = unresolvedTasks[0];
    return {
      status: TASK_STATUS.BLOCKED,
      task: first,
      message:
        first.blockedReason ||
        first.error ||
        `AgentRoute 已规划 ${plannedTasks.length} 个任务，但还没有 worker 产出通过验证的 evidence。`,
      failureReasons: ["planned_tasks_without_worker_evidence"]
    };
  }
  return {
    status: TASK_STATUS.FAILED,
    task: plannedTasks[0] || null,
    message: "AgentRoute 已规划任务，但没有 worker 产出成功且通过验证的 evidence。",
    failureReasons: ["no_successful_worker_evidence"]
  };
}

function modelsForPool(config, poolName) {
  return modelRoutingService.modelsForPool(config, poolName);
}

function modelsForTask(config, task, commanderRoute, budgetState = null) {
  return modelRoutingService.modelsForTask(config, task, commanderRoute, budgetState);
}

function messagesToResponsesPayload(messages) {
  const system = [];
  const input = [];
  for (const message of messages || []) {
    const role = message.role || "user";
    const content = normalizeContent(message.content);
    if (!content) continue;
    if (role === "system" || role === "developer") {
      system.push(content);
    } else {
      input.push(`${role}: ${content}`);
    }
  }
  return {
    instructions: system.join("\n\n"),
    input: input.join("\n\n") || messagesToText(messages)
  };
}

function isLowCostModel(model) {
  return modelRoutingService.isLowCostModel(model);
}

function modelRequestBody(baseBody, model, messages, endpointMode) {
  const body = {
    ...baseBody,
    model,
    stream: false
  };
  delete body.agent_debug;
  delete body.agent_route;
  delete body.agentRoute;
  delete body.goal;
  delete body.goal_id;
  delete body.goalId;
  delete body.resume_goal;
  delete body.resumeGoal;
  delete body.action;
  delete body.agent_route_action;
  delete body.agentRouteAction;
  delete body.commander_model;
  delete body.commanderModel;
  delete body.max_tasks;
  delete body.maxTasks;
  delete body.max_goal_iterations;
  delete body.maxGoalIterations;
  delete body.model_pools;
  delete body.modelPools;
  delete body.prompt_settings;
  delete body.promptSettings;
  delete body.budget;
  delete body.budget_policy;
  delete body.budgetPolicy;
  delete body.priority;
  if (endpointMode === "responses") {
    const payload = messagesToResponsesPayload(messages);
    body.input = payload.input;
    if (payload.instructions) body.instructions = payload.instructions;
    delete body.messages;
    delete body.max_tokens;
    delete body.max_completion_tokens;
  } else {
    body.messages = messages;
    delete body.input;
    delete body.instructions;
    delete body.max_output_tokens;
  }
  return body;
}

function getRequestedCommanderModel(body, config) {
  return modelRoutingService.getRequestedCommanderModel(body, config);
}

function resolveCommanderRoute(body, config) {
  return modelRoutingService.resolveCommanderRoute(body, config);
}

function responseMaxTokenLimit(body = {}, endpointMode = "chat") {
  const value =
    endpointMode === "responses"
      ? body.max_output_tokens || body.max_tokens || body.max_completion_tokens
      : body.max_tokens || body.max_completion_tokens || body.max_output_tokens;
  const limit = Number(value);
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
}

function providerAffordableMaxTokens(errorText = "") {
  const text = String(errorText || "");
  if (!/(more credits|fewer max_tokens|can only afford|insufficient credits|not enough credits)/i.test(text)) {
    return 0;
  }
  const match =
    text.match(/can only afford\s+([0-9][0-9,]*)/i) ||
    text.match(/afford(?:\s+up to)?\s+([0-9][0-9,]*)/i) ||
    text.match(/remaining(?:\s+output)?\s+tokens?[:\s]+([0-9][0-9,]*)/i);
  if (!match) return 0;
  const value = Number(String(match[1]).replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function retryMaxTokenLimitForProviderError(errorText, body = {}, endpointMode = "chat") {
  const affordable = providerAffordableMaxTokens(errorText);
  if (!affordable) return 0;
  const requested = responseMaxTokenLimit(body, endpointMode) || affordable + 1;
  if (requested <= affordable) return 0;
  const margin = affordable > 128 ? 32 : 8;
  const capped = Math.min(512, requested - 1, affordable - margin);
  return Math.max(64, Math.floor(capped));
}

function withResponseMaxTokenLimit(body = {}, endpointMode = "chat", limit = 0) {
  const next = { ...body };
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 0));
  if (endpointMode === "responses") {
    next.max_output_tokens = safeLimit;
    delete next.max_tokens;
    delete next.max_completion_tokens;
  } else {
    next.max_tokens = safeLimit;
    delete next.max_output_tokens;
  }
  return next;
}

function tokenRetryMessages(messages = [], limit = 0, label = "") {
  const guidance = [
    `Retry constraint: upstream quota only permits about ${limit} output tokens.`,
    "Return the shortest valid answer for this phase. Do not add explanations.",
    String(label || "").startsWith("plan")
      ? "For planning, submit compact function arguments with no more than 3 tasks."
      : "",
    String(label || "").startsWith("goal-review")
      ? "For review, submit compact function arguments; prefer a finalAnswer when evidence is sufficient."
      : ""
  ]
    .filter(Boolean)
    .join(" ");
  if (!Array.isArray(messages) || !messages.length) return [{ role: "system", content: guidance }];
  const [first, ...rest] = messages;
  if (first && first.role === "system") {
    return [{ ...first, content: [first.content, guidance].filter(Boolean).join("\n\n") }, ...rest];
  }
  return [{ role: "system", content: guidance }, ...messages];
}

function compactModelTask(task = null) {
  if (!task || typeof task !== "object") return null;
  return {
    id: task.id || "",
    title: task.title || "",
    type: task.type || "",
    modelPool: task.modelPool || task.model_pool || "",
    riskLevel: task.riskLevel || task.risk_level || "",
    internal: Boolean(task.internal),
    routeInternal: Boolean(task.routeInternal || task.route_internal)
  };
}

function safeModelError(error, limit = 500) {
  return String(error || "").slice(0, limit);
}

function diagnosticsSummary(diagnostics = {}) {
  if (!diagnostics || typeof diagnostics !== "object") return "";
  const parts = [];
  if (diagnostics.parseError) parts.push(`parseError=${diagnostics.parseError}`);
  if (diagnostics.topLevelJsonDocuments) parts.push(`topLevelJsonDocuments=${diagnostics.topLevelJsonDocuments}`);
  if (diagnostics.repeatedIdenticalJsonDocuments) parts.push("repeatedIdenticalJsonDocuments=true");
  if (diagnostics.hasFencedJson) parts.push("hasFencedJson=true");
  if (diagnostics.startsWithJson === false) parts.push("startsWithJson=false");
  if (diagnostics.hasValidTaskGraph === false) parts.push("hasValidTaskGraph=false");
  if (diagnostics.taskCount != null) parts.push(`taskCount=${diagnostics.taskCount}`);
  return parts.join("; ");
}

function errorWithDiagnostics(error, diagnostics = {}) {
  const summary = diagnosticsSummary(diagnostics);
  return summary ? `${String(error || "Model returned invalid content.")} 诊断：${summary}.` : error;
}

function modelMaxAttempts(config) {
  return Math.max(1, Math.min(10, Math.floor(Number((config && config.modelMaxAttempts) || 3))));
}

function isModelTimeoutError(errorText = "") {
  return /timeout|timed out|model_proxy_timeout/i.test(String(errorText || ""));
}

function shouldRetryModelAttempt(attempt) {
  if (!attempt || attempt.ok) return false;
  if (attempt.requestAborted) return false;
  const errorText = String(attempt.error || "");
  if (/aborted|operation was aborted|request_aborted/i.test(errorText)) return false;
  if (isModelTimeoutError(errorText)) return true;
  if (
    /internal model request failed|upstream model request failed|fetch failed|econnrefused|enotfound|couldn'?t connect|connection refused/i.test(
      errorText
    )
  )
    return false;
  const status = Number(attempt.status || 0);
  if (!status) return false;
  if ([408, 409, 425, 429].includes(status)) return true;
  if (status >= 500) return true;
  return false;
}

function retryMessagesForModelAttempt(messages, error, attemptNumber, maxAttempts, label) {
  return [
    ...messages,
    {
      role: "user",
      content: [
        "[重试上下文]",
        `Previous ${label || "model"} attempt failed: ${safeModelError(error, 900)}`,
        `Retry attempt ${attemptNumber} of ${maxAttempts}.`,
        "[任务]",
        "Use the original task and constraints.",
        "[约束]",
        "Do not invent missing evidence or claim completion without support.",
        "If the previous error mentions function arguments, call only the required function and put multiple items inside one arguments object's array fields.",
        "[内部逐步推理]",
        "Reason step by step internally about the previous format error and the original task, but do not output chain-of-thought.",
        "[结构化输出]",
        "Call exactly the required function with arguments matching the schema for this phase."
      ].join("\n")
    }
  ];
}

async function callRoutedModel({
  req,
  nextHandler,
  baseBody,
  models,
  messages,
  config,
  label,
  trace,
  endpointMode,
  timeoutMsOverride,
  budgetState = null,
  task = null,
  onBudgetUpdate = null,
  onModelEvent = null,
  validateContent = null,
  functionCallKind = ""
}) {
  const routedModels = budgetGovernor.routeModels([...new Set((models || []).filter(Boolean))], { budgetState, task });
  const maxPromptTokens = budgetGovernor.maxPromptTokensForState(config && config.budget, budgetState);
  const scopedMessages = budgetGovernor.compactMessages(messages, { maxTokens: maxPromptTokens });
  const emitModelEvent = (event, payload = {}) => {
    if (typeof onModelEvent !== "function") return;
    try {
      onModelEvent(event, {
        label: payload.label || label || "model",
        phase: payload.phase || label || "model",
        task: compactModelTask(task),
        ...payload
      });
    } catch {
      // Model progress events are observability only; execution should keep the real model result.
    }
  };
  if (budgetState) {
    const preBudget = budgetGovernor.evaluateGoalBudget(budgetState, { phase: `before:${label || "model"}` });
    if (preBudget.blockedReason) {
      const compact = budgetGovernor.compactEvaluation(preBudget);
      trace.push({
        label,
        model: "budget-governor",
        ok: false,
        error: compact.blockedReason,
        budget: compact
      });
      return { ok: false, error: compact.blockedReason, budgetEvaluation: compact };
    }
  }
  let lastError = null;
  let lastModel = "";
  const maxModelAttempts = modelMaxAttempts(config);
  for (let modelIndex = 0; modelIndex < routedModels.length; modelIndex += 1) {
    const model = routedModels[modelIndex];
    lastModel = model;
    const timeoutMs = timeoutMsOverride
      ? Number(timeoutMsOverride)
      : isLowCostModel(model)
        ? Number(config.freeCallTimeoutMs || config.callTimeoutMs || DEFAULT_CONFIG.freeCallTimeoutMs)
        : Number(config.callTimeoutMs || DEFAULT_CONFIG.callTimeoutMs);

    const executeRequest = async (body, messagesForUsage, traceOptions = {}) => {
      const { request, timer, cleanup } = requestWithBody(req, body, timeoutMs);
      const started = Date.now();
      const eventLabel = traceOptions.label || label || "model";
      const maxTokens = responseMaxTokenLimit(body, endpointMode) || undefined;
      let hardTimer = null;
      emitModelEvent("model_attempt", {
        model,
        attempt: traceOptions.modelAttempt || modelIndex + 1,
        totalAttempts: traceOptions.maxModelAttempts || routedModels.length,
        modelAttempt: traceOptions.modelAttempt || 1,
        maxModelAttempts: traceOptions.maxModelAttempts || 1,
        timeoutMs,
        maxTokens,
        retry: traceOptions.retry,
        label: eventLabel
      });
      try {
        const response = await Promise.race([
          nextHandler(request),
          new Promise((_, reject) => {
            hardTimer = setTimeout(() => {
              reject(Object.assign(new Error("timeout"), { name: "AbortError" }));
            }, timeoutMs);
          })
        ]);
        const parsed = await parseModelResponse(response.clone ? response.clone() : response);
        const elapsedMs = Date.now() - started;
        const functionCallResult = functionCallKind
          ? protocol.functionArgumentsFromResponse(parsed.data, functionCallKind)
          : { ok: true, content: parsed.content || "", error: "" };
        const modelContent = functionCallResult.content || "";
        const modelUsage = budgetGovernor.estimateModelCallUsage({
          model,
          messages: messagesForUsage,
          content: modelContent || parsed.text || "",
          elapsedMs,
          label: traceOptions.label || label
        });
        const budgetEvaluation = budgetState
          ? budgetGovernor.recordGoalUsage(budgetState, modelUsage, {
              phase: `model:${traceOptions.label || label || "call"}`,
              model,
              taskId: task && task.id
            })
          : null;
        if (budgetEvaluation && typeof onBudgetUpdate === "function") onBudgetUpdate(budgetEvaluation);
        if (response.ok && !functionCallResult.ok) {
          const validationError = functionCallResult.error;
          trace.push({
            label: traceOptions.label || label,
            model,
            ok: false,
            status: response.status,
            error: String(validationError).slice(0, 240),
            elapsedMs,
            retry: traceOptions.retry,
            maxTokens,
            budget: budgetEvaluation ? budgetGovernor.compactEvaluation(budgetEvaluation) : undefined
          });
          emitModelEvent("model_failure", {
            model,
            status: response.status,
            error: safeModelError(validationError),
            elapsedMs,
            retry: traceOptions.retry,
            maxTokens,
            label: eventLabel
          });
          return {
            ok: false,
            error: validationError,
            status: response.status,
            elapsedMs,
            budgetEvaluation
          };
        }
        if (response.ok && modelContent) {
          const validation =
            typeof validateContent === "function" ? validateContent(modelContent, { model, label }) : null;
          if (validation && validation.ok === false) {
            const validationDiagnostics =
              validation.diagnostics && typeof validation.diagnostics === "object" ? validation.diagnostics : null;
            const validationError = errorWithDiagnostics(
              validation.error || "Model returned invalid content.",
              validationDiagnostics
            );
            trace.push({
              label: traceOptions.label || label,
              model,
              ok: false,
              status: response.status,
              error: String(validationError).slice(0, 240),
              diagnostics: validationDiagnostics || undefined,
              elapsedMs,
              retry: traceOptions.retry,
              maxTokens,
              budget: budgetEvaluation ? budgetGovernor.compactEvaluation(budgetEvaluation) : undefined
            });
            emitModelEvent("model_failure", {
              model,
              status: response.status,
              error: safeModelError(validationError),
              diagnostics: validationDiagnostics || undefined,
              elapsedMs,
              retry: traceOptions.retry,
              maxTokens,
              label: eventLabel
            });
            return {
              ok: false,
              error: validationError,
              status: response.status,
              elapsedMs,
              diagnostics: validationDiagnostics || undefined,
              budgetEvaluation
            };
          }
          trace.push({
            label: traceOptions.label || label,
            model,
            ok: true,
            elapsedMs,
            retry: traceOptions.retry,
            maxTokens,
            budget: budgetEvaluation ? budgetGovernor.compactEvaluation(budgetEvaluation) : undefined
          });
          emitModelEvent("model_success", {
            model,
            status: response.status,
            elapsedMs,
            retry: traceOptions.retry,
            maxTokens,
            label: eventLabel
          });
          return { ok: true, model, content: modelContent, data: parsed.data, elapsedMs, budgetEvaluation };
        }
        const error =
          parsed.data && parsed.data.error
            ? parsed.data.error.message || JSON.stringify(parsed.data.error)
            : parsed.text || `HTTP ${response.status}`;
        trace.push({
          label: traceOptions.label || label,
          model,
          ok: false,
          status: response.status,
          error: String(error).slice(0, 240),
          elapsedMs,
          retry: traceOptions.retry,
          maxTokens,
          budget: budgetEvaluation ? budgetGovernor.compactEvaluation(budgetEvaluation) : undefined
        });
        emitModelEvent(isModelTimeoutError(error) ? "model_timeout" : "model_failure", {
          model,
          status: response.status,
          error: safeModelError(error),
          elapsedMs,
          timeoutMs: isModelTimeoutError(error) ? timeoutMs : undefined,
          retry: traceOptions.retry,
          maxTokens,
          label: eventLabel
        });
        return { ok: false, error, status: response.status, elapsedMs, budgetEvaluation };
      } catch (err) {
        const requestAborted = Boolean(req && req.signal && req.signal.aborted);
        const error = requestAborted
          ? "request_aborted"
          : err && err.name === "AbortError"
            ? "timeout"
            : (err && err.message) || String(err);
        const elapsedMs = Date.now() - started;
        const budgetEvaluation = budgetState
          ? budgetGovernor.recordGoalUsage(
              budgetState,
              budgetGovernor.estimateModelCallUsage({
                model,
                messages: messagesForUsage,
                content: "",
                elapsedMs,
                label: traceOptions.label || label
              }),
              { phase: `model:${traceOptions.label || label || "call"}:failed`, model, taskId: task && task.id }
            )
          : null;
        if (budgetEvaluation && typeof onBudgetUpdate === "function") onBudgetUpdate(budgetEvaluation);
        trace.push({
          label: traceOptions.label || label,
          model,
          ok: false,
          error: String(error).slice(0, 240),
          elapsedMs,
          retry: traceOptions.retry,
          maxTokens,
          budget: budgetEvaluation ? budgetGovernor.compactEvaluation(budgetEvaluation) : undefined
        });
        emitModelEvent(error === "timeout" ? "model_timeout" : "model_failure", {
          model,
          error: safeModelError(error),
          elapsedMs,
          timeoutMs,
          retry: traceOptions.retry,
          maxTokens,
          label: eventLabel
        });
        return { ok: false, error, elapsedMs, budgetEvaluation, requestAborted };
      } finally {
        clearTimeout(hardTimer);
        clearTimeout(timer);
        cleanup();
      }
    };

    let currentMessages = scopedMessages;
    let callsUsed = 0;
    while (callsUsed < maxModelAttempts) {
      callsUsed += 1;
      const modelAttempt = callsUsed;
      const requestBaseBody = functionCallKind
        ? protocol.functionCallingRequestBody(baseBody, endpointMode, functionCallKind)
        : baseBody;
      const body = modelRequestBody(requestBaseBody, model, currentMessages, endpointMode);
      const attempt = await executeRequest(body, currentMessages, {
        modelAttempt,
        maxModelAttempts,
        retry: modelAttempt > 1 ? `attempt_${modelAttempt}` : undefined
      });
      if (attempt.ok) return attempt;
      lastError = attempt.error;
      const retryLimit = retryMaxTokenLimitForProviderError(lastError, body, endpointMode);
      if (retryLimit && callsUsed < maxModelAttempts) {
        callsUsed += 1;
        emitModelEvent("model_retry", {
          model,
          reason: safeModelError(lastError),
          retry: "max_tokens",
          attempt: callsUsed,
          totalAttempts: maxModelAttempts,
          modelAttempt: callsUsed,
          maxModelAttempts,
          label: label || "model"
        });
        const retryMessages = tokenRetryMessages(scopedMessages, retryLimit, label);
        const retryBaseBody = withResponseMaxTokenLimit(baseBody, endpointMode, retryLimit);
        const retryBody = modelRequestBody(
          functionCallKind
            ? protocol.functionCallingRequestBody(retryBaseBody, endpointMode, functionCallKind)
            : retryBaseBody,
          model,
          retryMessages,
          endpointMode
        );
        const retryAttempt = await executeRequest(retryBody, retryMessages, {
          label: `${label || "model"}:max_tokens_retry`,
          retry: "max_tokens",
          modelAttempt: callsUsed,
          maxModelAttempts
        });
        if (retryAttempt.ok) return retryAttempt;
        lastError = retryAttempt.error;
      }
      if (budgetState) {
        const retryBudget = budgetGovernor.evaluateGoalBudget(budgetState, {
          phase: `after:${label || "model"}:attempt_${callsUsed}`
        });
        if (retryBudget.blockedReason) {
          lastError = retryBudget.blockedReason;
          break;
        }
      }
      if (callsUsed >= maxModelAttempts || !shouldRetryModelAttempt({ ...attempt, error: lastError })) break;
      emitModelEvent("model_retry", {
        model,
        reason: safeModelError(lastError),
        attempt: callsUsed + 1,
        totalAttempts: maxModelAttempts,
        modelAttempt: callsUsed + 1,
        maxModelAttempts,
        label: label || "model"
      });
      currentMessages = retryMessagesForModelAttempt(
        currentMessages,
        lastError,
        callsUsed + 1,
        maxModelAttempts,
        label
      );
    }
    const nextModel = routedModels[modelIndex + 1];
    if (nextModel) {
      emitModelEvent("model_failover", {
        fromModel: model,
        toModel: nextModel,
        reason: safeModelError(lastError),
        attempt: modelIndex + 2,
        totalAttempts: routedModels.length,
        label: label || "model"
      });
    }
    if (budgetState) {
      const postBudget = budgetGovernor.evaluateGoalBudget(budgetState, { phase: `after:${label || "model"}` });
      if (postBudget.blockedReason) {
        lastError = postBudget.blockedReason;
        break;
      }
    }
  }
  return { ok: false, error: lastError || "All models failed", model: lastModel };
}

function makeBaseBody(body, endpointMode) {
  const limit = Math.min(Number(body.max_tokens || body.max_completion_tokens || body.max_output_tokens || 2048), 4096);
  const baseBody = {
    ...body,
    temperature: body.temperature ?? 0.2
  };
  if (endpointMode === "responses") {
    baseBody.max_output_tokens = limit;
    delete baseBody.max_tokens;
    delete baseBody.max_completion_tokens;
  } else {
    baseBody.max_tokens = limit;
    delete baseBody.max_output_tokens;
  }
  return baseBody;
}

function runCodexCli(prompt, config, options = {}) {
  return codexCliRunner.runCodexCli(
    prompt,
    {
      codexCliTimeoutMs: Number(config.codexCliTimeoutMs || DEFAULT_CONFIG.codexCliTimeoutMs)
    },
    options
  );
}

async function runCodexCliWorker(messages, config, memoryText = "") {
  const started = Date.now();
  const result = await runCodexCli(makeCodexCliPrompt(messages, config, memoryText), config, {
    riskGateInput: messagesToText(messages),
    actionSummary: "codex-cli worker response"
  });
  return {
    content: result.content,
    model: "codex-cli",
    commanderModel: "codex-cli",
    trace: [
      {
        label: "worker:codex-cli",
        model: "codex-cli",
        ok: result.ok,
        elapsedMs: Date.now() - started,
        error: result.ok
          ? undefined
          : String(result.error || result.content || result.stderr || "Codex CLI failed").slice(0, 240)
      }
    ]
  };
}

async function runCodexCliTask(originalMessages, task, config, previousResults, onLog, memoryText = "") {
  const started = Date.now();
  const result = await runCodexCli(
    makeCodexCliTaskPrompt(originalMessages, task, previousResults, config, memoryText),
    config,
    {
      onLog,
      riskGateInput: [
        task && task.title,
        task && task.description,
        task && task.prompt,
        task && task.input,
        task && task.type,
        task && task.worker
      ]
        .filter(Boolean)
        .join("\n"),
      actionSummary: `codex-cli task ${(task && (task.title || task.id)) || ""}`.trim(),
      approvalStatus: task && (task.approvalStatus || task.approval_status),
      approved: Boolean(task && (task.approved || task.humanApproved || task.human_approved))
    }
  );
  const evidence = codexCliRunner.normalizeCodexCliEvidence(result);
  return {
    task,
    ok: result.ok,
    model: "codex-cli",
    content: result.content,
    evidence,
    error: result.ok ? "" : String(result.error || result.content || result.stderr || "Codex CLI failed"),
    elapsedMs: Date.now() - started,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    code: result.code,
    signal: result.signal,
    timedOut: Boolean(result.timedOut)
  };
}

function shouldForwardCodexLog(log) {
  return codexCliRunner.shouldForwardCodexLog(log);
}

function streamAgentRouteUiMessages(run, requestOrOrigin = null) {
  return eventStream.streamAgentRouteUiMessages(run, { observabilityRuntime, request: requestOrOrigin });
}

const { taskSummary, isPausedTaskStatus, isTerminalTaskStatus } = taskExecutor;

function finalGoalStatusFromTasks(content = "", tasks = []) {
  const text = String(content || "");
  if (!text.trim()) {
    return { status: TASK_STATUS.FAILED, blockedReason: "Final synthesis produced no content." };
  }
  const finalBlock = finalBlockedByUnresolvedPlannedTasks(tasks);
  if (finalBlock.blocked) {
    return {
      status: finalBlock.status,
      blockedReason: finalBlock.message
    };
  }
  return { status: TASK_STATUS.COMPLETED, blockedReason: "" };
}

async function createAgentRouteRuntimeSession(req, body, nextHandler, send) {
  const config = modelRoutingService.applyActiveProviderModels(applyRequestConfig(await resolveConfig(), body));
  const trace = [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const startedAt = Date.now();
  const {
    baseBody,
    commanderRoute,
    goalId,
    needsLocalExecution,
    resumeGoal,
    maxGoalIterations,
    allTasks,
    executedTaskIds,
    knownTaskIds,
    workerResults,
    goalMemoryQuery
  } = goalSetup.createRunState({
    body,
    config,
    messages,
    startedAt,
    defaultConfig: DEFAULT_CONFIG,
    makeBaseBody,
    resolveCommanderRoute,
    shouldUseCodexCliWorker
  });
  const { explicitMemories, plannerMemory } = goalSetup.loadGoalMemories({
    goalId,
    messages,
    goalMemoryQuery
  });
  if (explicitMemories.length) {
    send("memory", {
      goal_id: goalId,
      source: "user",
      count: explicitMemories.length,
      memories: explicitMemories
    });
  }
  let { goalBudget, goalStrategy } = goalSetup.prepareGoalState({
    goalId,
    resumeGoal,
    config,
    startedAt,
    goalMemoryQuery,
    plannerMemory
  });

  const persistGoalBudget = () => {
    taskRuntime.setGoalBudgetState(goalId, goalBudget, { policy: config.budget, startedAt });
  };

  const emitBudget = (phase, evaluation = null, task = null) => {
    const current = budgetGovernor.compactEvaluation(
      evaluation || budgetGovernor.evaluateGoalBudget(goalBudget, { phase })
    );
    persistGoalBudget();
    send("budget", {
      goal_id: goalId,
      phase,
      evaluation: current,
      task: task ? taskSummary(task) : undefined,
      usage: current.usage,
      remainingBudget: current.remainingBudget,
      degradationLevel: current.degradationLevel,
      warnings: current.warnings,
      history: goalBudget.history.slice(-10)
    });
    return current;
  };

  const emitStrategy = (event, extra = {}) => {
    send("strategy", {
      goal_id: goalId,
      event,
      strategy: goalStrategy,
      history: taskRuntime.getGoalStrategyHistory(goalId),
      ...extra
    });
  };

  const emitCheckpoint = (phase = "checkpoint", extra = {}) => {
    const goal = taskRuntime.publicGoal(taskRuntime.getGoal(goalId));
    if (!goal) return null;
    const graph = taskRuntime.getExecutionGraph(goalId);
    const payload = {
      goal_id: goalId,
      phase,
      at: new Date().toISOString(),
      goal,
      tasks: goal.tasks || [],
      graph,
      ready_tasks: graph.readyTaskIds || [],
      parallel_groups: graph.parallelGroups || [],
      blocked_chains: graph.blockedChains || [],
      ...extra
    };
    send("checkpoint", payload);
    return payload;
  };

  const emitGraph = (event = dependencyEngine.GRAPH_EVENT.UPDATED, extra = {}) => {
    const graph = taskRuntime.getExecutionGraph(goalId);
    send("graph", {
      goal_id: goalId,
      event,
      graph,
      ready_tasks: graph.readyTaskIds || [],
      parallel_groups: graph.parallelGroups || [],
      blocked_chains: graph.blockedChains || [],
      ...extra
    });
    emitCheckpoint(`graph:${event}`, { graph_event: event });
    return graph;
  };

  send("start", {
    mode: "goal-route",
    goal_id: goalId,
    resume: resumeGoal,
    commander_model: commanderRoute.selected,
    max_tasks: config.maxTasks,
    max_goal_iterations: maxGoalIterations,
    local_execution: needsLocalExecution,
    budget: config.budget,
    strategy: goalStrategy
  });
  emitStrategy(resumeGoal ? "strategy_resumed" : strategyEngine.STRATEGY_EVENT.CREATED);
  if (!resumeGoal) {
    const strategyMemories = memoryRuntime.createMemoriesFromCandidates(
      [strategyEngine.memoryCandidateForStrategy(goalStrategy)],
      {
        goalId,
        source: "strategic-layer",
        sourceSummary: "Initial strategy"
      }
    );
    if (strategyMemories.length) {
      send("memory", {
        goal_id: goalId,
        source: "strategy",
        count: strategyMemories.length,
        memories: strategyMemories
      });
    }
  }
  emitBudget("start");
  emitGraph(resumeGoal ? dependencyEngine.GRAPH_EVENT.UPDATED : dependencyEngine.GRAPH_EVENT.CREATED);

  const appendTasks = taskAppender.createTaskAppender({
    goalId,
    allTasks,
    knownTaskIds,
    getGoalStrategy: () => goalStrategy,
    goalMemoryQuery,
    plannerMemory,
    trace,
    send,
    emitStrategy,
    emitGraph,
    taskSummary
  });
  const syncRuntimeTasks = () => {
    const latest = taskRuntime.listTasks(goalId);
    const byId = new Map(allTasks.map((task) => [task.id, task]));
    for (const task of latest) {
      const index = allTasks.findIndex((item) => item.id === task.id);
      if (index >= 0) allTasks[index] = { ...(byId.get(task.id) || {}), ...task };
      else allTasks.push(task);
    }
    return latest;
  };

  const runWorkerTask = async (task) => {
    const runningTask = taskContext.startWorkerTask({
      goalId,
      task,
      goalMemoryQuery,
      startedAt,
      config,
      userInitiated: true
    });

    const gate = taskGates.handleStartGate({
      goalId,
      runningTask,
      allTasks,
      workerResults,
      executedTaskIds,
      send,
      emitBudget,
      taskSummary
    });
    if (gate) return gate.recordedResult;

    const { pool, workerMemory } = taskContext.prepareWorkerExecutionContext({
      goalId,
      runningTask,
      messages,
      config,
      commanderRoute,
      goalBudget,
      modelsForTask
    });

    const result = await workerDispatcher.dispatchWorker({
      req,
      nextHandler,
      baseBody,
      messages,
      config,
      runningTask,
      workerResults,
      workerMemory,
      pool,
      trace,
      goalBudget,
      persistGoalBudget,
      send,
      taskSummary,
      callRoutedModel,
      makeWorkerMessages,
      runCodexCliTask,
      shouldForwardCodexLog
    });

    const { workerResult } = workerResultProcessor.normalizeAndRecordWorkerResult({
      result,
      runningTask,
      goalBudget,
      emitBudget
    });
    const workerResultForRuntime = await taskVerificationStep.verifyWorkerResultIfNeeded({
      workerResult,
      runningTask,
      verifyTaskResult: (runtimeResult, verificationTask) =>
        verifyTaskResultWithOptionalModel({
          req,
          nextHandler,
          baseBody,
          config,
          commanderRoute,
          messages,
          task: verificationTask,
          workerRuntimeResult: runtimeResult,
          trace,
          endpointMode: "chat",
          modelLabel: "verifier",
          budgetState: goalBudget,
          onBudgetUpdate: persistGoalBudget,
          strategy: goalStrategy
        })
    });

    return taskStateUpdater.applyWorkerResultAndPublish({
      goalId,
      runningTask,
      result,
      workerResultForRuntime,
      config,
      allTasks,
      workerResults,
      executedTaskIds,
      send,
      emitBudget,
      taskSummary
    });
  };

  let finalFromReview = "";
  let pausedTask = null;
  let iteration = 0;
  let selectedTask = null;
  let drainedTasks = 0;
  let maxReadyDrains = 0;

  const complete = (reason = "complete", extra = {}) => ({
    done: true,
    next: "complete",
    reason,
    goalId,
    iteration,
    ...extra
  });

  const continueTo = (next = "iteration", reason = "", extra = {}) => ({
    done: false,
    next,
    reason,
    goalId,
    iteration,
    ...extra
  });

  return {
    goalId,
    startedAt,
    trace,
    async plan() {
      if (resumeGoal) {
        const existingTasks = taskRuntime.listTasks(goalId);
        for (const task of existingTasks) {
          knownTaskIds.add(task.id);
          allTasks.push(task);
          if (isTerminalTaskStatus(task.status)) executedTaskIds.add(task.id);
        }
        send("plan", {
          tasks: allTasks.map(taskSummary),
          raw: "",
          source: "resume"
        });
        emitCheckpoint("resume_loaded");
        return continueTo("begin_iteration", "resume_loaded");
      }

      const planningResult = await initialPlanning.runInitialPlanning({
        req,
        nextHandler,
        baseBody,
        messages,
        config,
        defaultConfig: DEFAULT_CONFIG,
        commanderRoute,
        goalId,
        plannerMemory,
        goalStrategy,
        goalBudget,
        trace,
        send,
        emitBudget,
        appendTasks,
        taskSummary,
        startedAt,
        callRoutedModel,
        persistGoalBudget,
        normalizePromptSettings
      });
      if (planningResult.handled) {
        emitCheckpoint(planningResult.reason || "planning_handled");
        return complete(planningResult.reason || "planning_handled");
      }
      send("plan", {
        tasks: allTasks.map(taskSummary),
        raw: (planningResult.planAttempt && planningResult.planAttempt.content) || "",
        source: "commander"
      });
      emitCheckpoint("plan_ready");
      return continueTo("begin_iteration", "plan_ready");
    },
    async beginIteration() {
      if (iteration >= maxGoalIterations) return continueTo("finalize", "max_iterations_reached");
      iteration += 1;
      selectedTask = null;
      drainedTasks = 0;
      maxReadyDrains = Math.max(1, Math.min(60, Number(config.maxTasks || DEFAULT_CONFIG.maxTasks) * 6));
      const { iterationBudget, budgetBlocked, strategyStop } = loopController.evaluateIterationGuards({
        iteration,
        goalBudget,
        goalStrategy,
        allTasks
      });
      if (
        iterationBudget.warnings.length ||
        iterationBudget.degradationLevel !== budgetGovernor.DEGRADATION_LEVEL.NONE
      ) {
        emitBudget("iteration:" + iteration, iterationBudget);
      }
      if (budgetBlocked) {
        const compactBudget = budgetGovernor.compactEvaluation(iterationBudget);
        taskRuntime.setGoalStatus(goalId, TASK_STATUS.BLOCKED, {
          blockedReason: compactBudget.blockedReason || "Goal budget exhausted.",
          output: compactBudget.blockedReason || "Goal budget exhausted."
        });
        send("pause", {
          goal_id: goalId,
          status: TASK_STATUS.BLOCKED,
          message: compactBudget.blockedReason || "Goal budget exhausted.",
          budget: compactBudget,
          elapsedMs: Date.now() - startedAt,
          trace
        });
        emitCheckpoint("goal_budget_blocked");
        return complete("goal_budget_blocked");
      }
      if (strategyStop.shouldStop) {
        taskRuntime.setGoalStatus(goalId, TASK_STATUS.BLOCKED, {
          blockedReason: strategyStop.reasons.join(" ") || "Strategy stop condition triggered.",
          output: strategyStop.reasons.join(" ") || "Strategy stop condition triggered."
        });
        emitStrategy(strategyEngine.STRATEGY_EVENT.STOP_TRIGGERED, {
          stop: strategyStop,
          phase: "iteration:" + iteration
        });
        send("pause", {
          goal_id: goalId,
          status: TASK_STATUS.BLOCKED,
          message: strategyStop.reasons.join(" ") || "Strategy stop condition triggered.",
          strategy: goalStrategy,
          elapsedMs: Date.now() - startedAt,
          trace
        });
        emitCheckpoint("strategy_stop");
        return complete("strategy_stop");
      }
      pausedTask =
        allTasks.find((task) => isPausedTaskStatus(task)) ||
        allTasks.find((task) => !isTerminalTaskStatus(task.status) && taskRequiresHumanAttention(task)) ||
        null;
      if (pausedTask) return continueTo("finalize", "paused_task");

      return continueTo("select_task", "iteration_started", {
        drainedTasks,
        maxReadyDrains
      });
    },
    async selectReadyTask() {
      const graphBeforeRun = emitGraph(dependencyEngine.GRAPH_EVENT.READY_CHANGED, {
        phase: `iteration:${iteration}`,
        drained_tasks: drainedTasks
      });
      syncRuntimeTasks();
      const pendingTasks = taskRuntime.readyTasks(goalId).filter((task) => !executedTaskIds.has(task.id));
      if (!pendingTasks.length) {
        selectedTask = null;
        if (!drainedTasks && graphBeforeRun.blockedChains && graphBeforeRun.blockedChains.length) {
          trace.push({
            label: `graph:blocked:${iteration}`,
            model: "dependency-engine",
            ok: false,
            blockedChains: graphBeforeRun.blockedChains.slice(0, 8)
          });
        }
        return continueTo("review", "no_ready_tasks", {
          drainedTasks,
          readyCount: 0
        });
      }
      selectedTask = pendingTasks[0];
      return continueTo("run_task", "ready_task_selected", {
        taskId: selectedTask.id,
        readyCount: pendingTasks.length,
        drainedTasks
      });
    },
    async runReadyTask() {
      if (!selectedTask) {
        return continueTo("select_task", "no_selected_task", {
          drainedTasks,
          maxReadyDrains
        });
      }
      const task = selectedTask;
      selectedTask = null;
      const result = await runWorkerTask(task);
      drainedTasks += 1;
      syncRuntimeTasks();
      emitGraph(dependencyEngine.GRAPH_EVENT.UPDATED, { task_id: task.id, status: result.status });
      const propagatedPausedTask = allTasks.find((item) => isPausedTaskStatus(item));
      if (propagatedPausedTask) {
        pausedTask = propagatedPausedTask;
        return continueTo("finalize", "propagated_paused_task", {
          taskId: propagatedPausedTask.id || task.id,
          drainedTasks
        });
      }
      if (isPausedTaskStatus(result.task || { status: result.status, blockedReason: result.blockedReason })) {
        pausedTask = result.task || task;
        return continueTo("finalize", "worker_paused", {
          taskId: task.id,
          drainedTasks
        });
      }
      if (drainedTasks >= maxReadyDrains) {
        trace.push({
          label: `graph:drain-limit:${iteration}`,
          model: "dependency-engine",
          ok: false,
          drainedTasks,
          maxReadyDrains
        });
        return continueTo("review", "drain_limit_reached", {
          taskId: task.id,
          drainedTasks,
          maxReadyDrains
        });
      }
      return continueTo("select_task", "ready_task_completed", {
        taskId: task.id,
        drainedTasks,
        maxReadyDrains
      });
    },
    async reviewIteration() {
      const reviewResult = await reviewRunner.runReviewIteration({
        req,
        nextHandler,
        baseBody,
        messages,
        config,
        defaultConfig: DEFAULT_CONFIG,
        needsLocalExecution,
        commanderRoute,
        iteration,
        maxGoalIterations,
        goalId,
        goalMemoryQuery,
        allTasks,
        workerResults,
        goalBudget,
        goalStrategy,
        trace,
        send,
        emitBudget,
        emitStrategy,
        persistGoalBudget,
        taskSummary,
        callRoutedModel,
        normalizePromptSettings
      });
      goalStrategy = reviewResult.goalStrategy;

      if (reviewResult.failed) {
        const message = `Commander review failed: ${reviewResult.error || reviewResult.reviewAttempt.error || "unknown error"}`;
        taskRuntime.setGoalStatus(goalId, TASK_STATUS.FAILED, { blockedReason: message, output: message });
        send("error", {
          message,
          phase: "review",
          model: reviewResult.reviewAttempt.model || commanderRoute.selected,
          task: reviewResult.reviewTask ? taskSummary(reviewResult.reviewTask) : undefined,
          elapsedMs: Date.now() - startedAt,
          trace
        });
        emitCheckpoint("review_failed");
        return complete("review_failed");
      }

      if (reviewResult.finalAnswer) {
        const finalBlock = finalBlockedByUnresolvedPlannedTasks(allTasks);
        if (finalBlock.blocked) {
          const readyUnresolvedTaskIds = new Set(
            taskRuntime
              .readyTasks(goalId)
              .filter((task) => !executedTaskIds.has(task.id))
              .map((task) => task.id)
          );
          const canContinueDraining =
            iteration < maxGoalIterations && finalBlock.tasks.some((task) => readyUnresolvedTaskIds.has(task.id));
          trace.push({
            label: `goal-review:${iteration}:final-blocked`,
            model: "dependency-engine",
            ok: false,
            error: finalBlock.message,
            unresolvedTasks: finalBlock.tasks.slice(0, 8).map(taskSummary)
          });
          send("goal_check", {
            iteration,
            ok: false,
            status: "continue",
            progress_summary: finalBlock.message,
            next_count: reviewResult.review.nextTasks.length,
            commander_model: reviewResult.reviewAttempt.model || commanderRoute.selected,
            failure_reason: "planned_tasks_unresolved_before_final"
          });
          if (reviewResult.review.nextTasks.length) {
            appendTasks(reviewResult.review.nextTasks, {
              source: "review",
              createdByTaskId: `goal-review-${iteration}`,
              createdByTaskTitle: "Review progress and decide next step"
            });
            send("plan", {
              tasks: allTasks.map(taskSummary),
              raw: reviewResult.reviewAttempt.content || ""
            });
            emitCheckpoint("review_appended_tasks");
            return continueTo("begin_iteration", "review_appended_tasks");
          }
          if (canContinueDraining) return continueTo("begin_iteration", "final_block_has_ready_tasks");
          pausedTask = {
            ...finalBlock.task,
            status: finalBlock.status,
            blockedReason: finalBlock.message
          };
          return continueTo("finalize", "final_blocked");
        }
        finalFromReview = reviewResult.finalAnswer;
        return continueTo("finalize", "final_from_review");
      }

      if (reviewResult.review.nextTasks.length && reviewResult.shouldContinue) {
        appendTasks(reviewResult.review.nextTasks, {
          source: "review",
          createdByTaskId: `goal-review-${iteration}`,
          createdByTaskTitle: "Review progress and decide next step"
        });
        send("plan", {
          tasks: allTasks.map(taskSummary),
          raw: reviewResult.reviewAttempt.content || ""
        });
        emitCheckpoint("review_appended_tasks");
        return continueTo("begin_iteration", "review_appended_tasks");
      }

      if (!reviewResult.review.nextTasks.length && reviewResult.shouldContinue) {
        emitCheckpoint("review_continue");
        return continueTo("begin_iteration", "review_continue");
      }

      return continueTo("finalize", "review_complete");
    },
    async finalize() {
      if (pausedTask) {
        const waitingForHuman = taskRequiresHumanAttention(pausedTask);
        const pauseStatus = waitingForHuman ? TASK_STATUS.WAITING_HUMAN : pausedTask.status;
        send("pause", {
          goal_id: goalId,
          status: pauseStatus,
          task: taskSummary(pausedTask),
          message: waitingForHuman
            ? pausedTask.approvalReason || "Task is waiting for human approval."
            : pausedTask.blockedReason || pausedTask.error || "Task is blocked by an external issue.",
          elapsedMs: Date.now() - startedAt,
          trace
        });
        taskRuntime.setGoalStatus(goalId, pauseStatus, {
          blockedReason: waitingForHuman
            ? pausedTask.approvalReason || "Task is waiting for human approval."
            : pausedTask.blockedReason || pausedTask.error || "Task is blocked by an external issue.",
          output: waitingForHuman
            ? pausedTask.approvalReason || "Task is waiting for human approval."
            : pausedTask.blockedReason || pausedTask.error || "Task is blocked by an external issue."
        });
        emitCheckpoint("paused");
        return complete("paused");
      }

      const routeSuccessfulWorkers = workerResults.filter((result) => result.ok);
      if (finalFromReview) {
        const finalStatus = finalGoalStatusFromTasks(finalFromReview, allTasks);
        send("final", {
          content: finalFromReview,
          status: finalStatus.status,
          finalStatus: finalStatus.status,
          final_status: finalStatus.status,
          blockedReason: finalStatus.blockedReason,
          failureReason: finalStatus.blockedReason,
          source_model: commanderRoute.selected,
          commander_model: commanderRoute.selected,
          elapsedMs: Date.now() - startedAt,
          trace
        });
        taskRuntime.setGoalStatus(goalId, finalStatus.status, {
          blockedReason: finalStatus.blockedReason,
          output: finalFromReview
        });
        emitCheckpoint("final_from_review");
        return complete("final_from_review");
      }

      if (routeSuccessfulWorkers.length === 0) {
        const blocked = blockedWhenNoSuccessfulWorkerEvidence(allTasks);
        taskRuntime.setGoalStatus(goalId, blocked.status, { blockedReason: blocked.message, output: blocked.message });
        send("pause", {
          goal_id: goalId,
          status: blocked.status,
          task: blocked.task ? taskSummary(blocked.task) : undefined,
          message: blocked.message,
          elapsedMs: Date.now() - startedAt,
          trace
        });
        emitCheckpoint("no_successful_worker_evidence");
        return complete("no_successful_worker_evidence");
      }

      const finalBlock = finalBlockedByUnresolvedPlannedTasks(allTasks);
      if (finalBlock.blocked) {
        taskRuntime.setGoalStatus(goalId, finalBlock.status, {
          blockedReason: finalBlock.message,
          output: finalBlock.message
        });
        send("pause", {
          goal_id: goalId,
          status: finalBlock.status,
          task: finalBlock.task ? taskSummary(finalBlock.task) : undefined,
          message: finalBlock.message,
          elapsedMs: Date.now() - startedAt,
          trace
        });
        emitCheckpoint("final_blocked");
        return complete("final_blocked");
      }

      const finalResult = await finalizer.runFinalSynthesis({
        req,
        nextHandler,
        baseBody,
        messages,
        allTasks,
        workerResults,
        config,
        defaultConfig: DEFAULT_CONFIG,
        needsLocalExecution,
        commanderRoute,
        goalId,
        goalMemoryQuery,
        goalBudget,
        goalStrategy,
        trace,
        send,
        emitBudget,
        persistGoalBudget,
        taskSummary,
        callRoutedModel,
        startedAt,
        classifyFinalStatus: finalGoalStatusFromTasks,
        normalizePromptSettings
      });
      const finalStatus = finalGoalStatusFromTasks(finalResult.content, allTasks);
      taskRuntime.setGoalStatus(goalId, finalStatus.status, {
        blockedReason: finalStatus.blockedReason,
        output: finalResult.content || finalStatus.blockedReason
      });
      emitCheckpoint("final");
      return complete("final");
    }
  };
}

async function parseAgentRouteRequestBody(req) {
  try {
    return { body: await req.clone().json() };
  } catch (err) {
    return {
      response: jsonResponse(
        {
          error: {
            message: "Expected JSON body",
            type: "invalid_request_error",
            code: "invalid_json"
          }
        },
        400,
        {},
        req
      )
    };
  }
}

function prepareAgentRouteChatBody(body, req) {
  const goal = String(body.goal || body.prompt || body.input || "").trim();
  const messages = Array.isArray(body.messages) ? body.messages : [{ role: "user", content: goal }];
  const hasUserContent = messages.some((message) => normalizeContent(message && message.content).trim());
  if (!hasUserContent) {
    return {
      response: jsonResponse(
        {
          error: {
            message: "Missing task goal",
            type: "invalid_request_error",
            code: "missing_goal"
          }
        },
        400,
        {},
        req
      )
    };
  }

  return {
    chatBody: {
      ...body,
      model: "agent-auto",
      messages,
      stream: false,
      agent_route: {
        ...(body.agent_route || {}),
        goal_id:
          body.goal_id || body.goalId || (body.agent_route && (body.agent_route.goal_id || body.agent_route.goalId)),
        commander_model:
          body.commander_model || body.commanderModel || (body.agent_route && body.agent_route.commander_model)
      }
    }
  };
}

async function handleAgentRouteRun(req, nextHandler) {
  if (req.method === "OPTIONS") {
    return preflightResponse(req);
  }

  const authDenied = checkRequestAuth(req);
  if (authDenied) return authDenied;

  const parsed = await parseAgentRouteRequestBody(req);
  if (parsed.response) return parsed.response;
  const body = parsed.body;

  if (normalizeAgentRouteAction(body)) {
    return handleAgentRouteAction(body, req);
  }

  return jsonResponse(
    {
      error: {
        message: "The legacy /api/agent-route/run SSE goal stream is disabled. Use /api/agent-route/ui-stream.",
        type: "gone",
        code: "agent_route_legacy_sse_disabled"
      }
    },
    410,
    {},
    req
  );
}

async function handleAgentRouteUiStream(req, nextHandler) {
  if (req.method === "OPTIONS") {
    return preflightResponse(req);
  }

  const authDenied = checkRequestAuth(req);
  if (authDenied) return authDenied;

  const parsed = await parseAgentRouteRequestBody(req);
  if (parsed.response) return parsed.response;
  const body = parsed.body;

  if (normalizeAgentRouteAction(body)) {
    return handleAgentRouteAction(body, req);
  }

  const prepared = prepareAgentRouteChatBody(body, req);
  if (prepared.response) return prepared.response;
  const runReq = detachedRequestFromClientAbort(req);

  return streamAgentRouteUiMessages(
    (send) =>
      langGraphRunner.runAgentRouteLangGraph({
        req: runReq,
        body: prepared.chatBody,
        nextHandler,
        send,
        createRuntimeSession: createAgentRouteRuntimeSession
      }),
    req
  );
}

module.exports = {
  AGENT_MODEL_IDS,
  COMMANDER_MODEL_OPTIONS,
  DEFAULT_COMMANDER_MODELS,
  DEFAULT_CONFIG,
  DEFAULT_MODEL_POOLS,
  DEFAULT_PROMPT_SETTINGS,
  callRoutedModel,
  handleAgentRouteRun,
  handleAgentRouteUiStream,
  finalBlockedByUnresolvedPlannedTasks,
  finalGoalStatusFromTasks,
  retryMaxTokenLimitForProviderError
};
