"use strict";

const browserWorker = require("./browser-worker");
const { safeJsonParse } = require("./content-utils");
const documentWorker = require("./document-worker");
const localReadWorker = require("./local-read-worker");
const mcpClient = require("../mcp/client");
const protocol = require("./protocol");
const webToolWorker = require("./web-tool-worker");

function compactText(value = "", max = 240) {
  const text = String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, Math.max(1, max - 3))}...` : text;
}

function toolMaxAttempts(config = {}) {
  return Math.max(1, Math.min(Math.floor(Number(config.toolMaxAttempts || 3)), 10));
}

function toolRetryDelayMs(config = {}, attempt = 1) {
  const base = Math.max(0, Math.min(Number(config.toolRetryDelayMs || 500), 10000));
  return base * Math.max(1, Number(attempt || 1));
}

function sleep(ms) {
  const delay = Math.max(0, Number(ms || 0));
  return delay ? new Promise((resolve) => setTimeout(resolve, delay)) : Promise.resolve();
}

function clampMs(value, min, max) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return min;
  return Math.max(min, Math.min(number, max));
}

function workerMcpTimeoutMs(config = {}, runningTask = {}) {
  const taskBudgetMs = Number(config.budget?.task?.maxRuntimeMs || 0);
  const callTimeoutMs = Number(config.callTimeoutMs || 0);
  const codexTimeoutMs =
    runningTask.modelPool === "codex-cli" || runningTask.type === "local_execution"
      ? Number(config.codexCliTimeoutMs || 0)
      : 0;
  const explicitMs = Number(config.workerMcpTimeoutMs || config.mcpWorkerTimeoutMs || 0);
  const baseline = Math.max(explicitMs, taskBudgetMs, callTimeoutMs, codexTimeoutMs, 60000);
  return clampMs(baseline + 15000, 60000, 60 * 60 * 1000);
}

async function runMcpWorker({ toolName, args, handlers, config, runningTask }) {
  return mcpClient.callWorkerTool(toolName, args, handlers, {
    timeout: workerMcpTimeoutMs(config, runningTask)
  });
}

function parsedToolStatus(result = {}) {
  const parsed = safeJsonParse(result.content || "");
  return String((parsed && (parsed.status || parsed.state)) || result.status || "").toLowerCase();
}

function toolFailureText(result = {}) {
  const parsed = safeJsonParse(result.content || "");
  return [
    result.error,
    result.blockedReason,
    result.content,
    parsed && parsed.error,
    parsed && parsed.nextStep,
    parsed && parsed.output
  ]
    .filter(Boolean)
    .join("\n");
}

function isRetryableToolFailure(result = {}) {
  if (!result || result.ok) return false;
  const status = parsedToolStatus(result);
  if (["blocked", "awaiting_confirmation", "waiting_human"].includes(status)) return false;
  const text = toolFailureText(result);
  if (
    /risk gate|human approval|awaiting confirmation|requires approval|not approved|blocked by risk|敏感|人工确认/i.test(
      text
    )
  )
    return false;
  if (
    /did not include a public HTTP\(S\) URL|missing public URL|no upstream or explicit content|missing_content|缺少上游|没有上游/i.test(
      text
    )
  )
    return false;
  if (/\bHTTP\s+(408|409|425|429|5\d\d)\b/i.test(text)) return true;
  return /timeout|timed out|aborted|operation was aborted|fetch failed|network|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|temporarily unavailable|service unavailable|target closed|browser session.*lost|navigation timeout/i.test(
    text
  );
}

async function runToolWithRetry({ toolName, model, runningTask, config, trace, send, taskSummary, execute }) {
  const maxAttempts = toolMaxAttempts(config);
  const startedAt = Date.now();
  let lastResult = null;
  const retryErrors = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastResult = await execute();
    retryErrors.push(compactText(toolFailureText(lastResult), 500));
    trace.push({
      label: `worker:${runningTask.id}`,
      model,
      ok: Boolean(lastResult.ok),
      elapsedMs: lastResult.elapsedMs,
      error: lastResult.ok ? undefined : compactText(toolFailureText(lastResult), 240),
      toolWorker: toolName,
      toolAttempt: attempt,
      maxToolAttempts: maxAttempts
    });
    if (lastResult.ok || attempt >= maxAttempts || !isRetryableToolFailure(lastResult)) {
      return {
        ...lastResult,
        elapsedMs: Date.now() - startedAt,
        toolAttempts: attempt,
        retryErrors: retryErrors.filter(Boolean)
      };
    }
    const reason = compactText(toolFailureText(lastResult), 240);
    send("tool_retry", {
      task: taskSummary(runningTask),
      toolWorker: toolName,
      model,
      reason,
      attempt: attempt + 1,
      totalAttempts: maxAttempts,
      maxToolAttempts: maxAttempts
    });
    await sleep(toolRetryDelayMs(config, attempt));
  }
  return {
    ...lastResult,
    elapsedMs: Date.now() - startedAt,
    toolAttempts: maxAttempts,
    retryErrors: retryErrors.filter(Boolean)
  };
}

async function dispatchWorker({
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
}) {
  send("worker_start", {
    task: taskSummary(runningTask),
    modelPool: runningTask.modelPool,
    candidates: pool.slice(0, 8)
  });

  if (documentWorker.shouldUseDocumentWorker(runningTask)) {
    return runToolWithRetry({
      toolName: "document",
      model: "document-tool",
      runningTask,
      config,
      trace,
      send,
      taskSummary,
      execute: () =>
        runMcpWorker({
          toolName: mcpClient.WORKER_MCP_TOOLS.document,
          args: {
            task: runningTask,
            config,
            previousResults: workerResults
          },
          config,
          runningTask
        })
    });
  }

  if (localReadWorker.shouldUseLocalReadWorker(runningTask)) {
    return runToolWithRetry({
      toolName: "files",
      model: "files-tool",
      runningTask,
      config,
      trace,
      send,
      taskSummary,
      execute: () =>
        runMcpWorker({
          toolName: mcpClient.WORKER_MCP_TOOLS.files,
          args: {
            task: runningTask,
            config
          },
          config,
          runningTask
        })
    });
  }

  if (webToolWorker.shouldUseWebToolWorker(runningTask, messages)) {
    return runToolWithRetry({
      toolName: "web",
      model: "web-tool",
      runningTask,
      config,
      trace,
      send,
      taskSummary,
      execute: () =>
        runMcpWorker({
          toolName: mcpClient.WORKER_MCP_TOOLS.web,
          args: {
            task: runningTask,
            config,
            messages
          },
          config,
          runningTask
        })
    });
  }

  if (browserWorker.shouldUseBrowserWorker(runningTask)) {
    return runToolWithRetry({
      toolName: "browser",
      model: "browser-tool",
      runningTask,
      config,
      trace,
      send,
      taskSummary,
      execute: () =>
        runMcpWorker({
          toolName: mcpClient.WORKER_MCP_TOOLS.browser,
          args: {
            task: runningTask,
            config
          },
          config,
          runningTask
        })
    });
  }

  if (runningTask.modelPool === "codex-cli") {
    const onCodexLog = (log) => {
      if (typeof shouldForwardCodexLog === "function" && !shouldForwardCodexLog(log)) return;
      const text = String((log && log.text) || "").trim();
      if (!text) return;
      send("worker_log", {
        task: taskSummary(runningTask),
        model: "codex-cli",
        stream: log.stream || "stdout",
        text: text.slice(-1200)
      });
    };
    const result = await runMcpWorker({
      toolName: mcpClient.WORKER_MCP_TOOLS.codex,
      args: {
        messages,
        task: runningTask,
        config,
        previousResults: workerResults,
        workerMemory
      },
      handlers: {
        runCodexCliTask,
        onCodexLog
      },
      config,
      runningTask
    });
    trace.push({
      label: `worker:${runningTask.id}`,
      model: "codex-cli",
      ok: result.ok,
      elapsedMs: result.elapsedMs,
      error: result.ok ? undefined : String(result.error || "").slice(0, 240)
    });
    return result;
  }

  const attempt = await callRoutedModel({
    req,
    nextHandler,
    baseBody,
    models: pool,
    messages: makeWorkerMessages(messages, runningTask, config, workerMemory, workerResults),
    config,
    label: `worker:${runningTask.id}`,
    trace,
    endpointMode: "chat",
    budgetState: goalBudget,
    task: runningTask,
    onBudgetUpdate: persistGoalBudget,
    onModelEvent: (event, data) =>
      send(event, {
        ...data,
        task: taskSummary(runningTask)
      }),
    functionCallKind: protocol.KIND.WORKER_RESULT,
    validateContent: (content) =>
      protocol.validationForCall(content, protocol.KIND.WORKER_RESULT, (value) =>
        value.status ? { ok: true } : { ok: false, error: "Worker result must include status." }
      )
  });
  return {
    task: runningTask,
    ok: attempt.ok,
    model: attempt.model,
    content: attempt.content,
    error: attempt.error,
    elapsedMs: attempt.elapsedMs
  };
}

module.exports = {
  dispatchWorker,
  isRetryableToolFailure,
  runToolWithRetry,
  toolMaxAttempts
};
