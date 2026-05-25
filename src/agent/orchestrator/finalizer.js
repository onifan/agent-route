"use strict";

const memoryRuntime = require("../memory");
const { compactText, messagesToText, runtimeTemporalContext } = require("./content-utils");
const protocol = require("./protocol");
const reviewLoop = require("./review-loop");

function makeFinalMessages(originalMessages, plan, results, config, memoryText = "", strategy = null, options = {}) {
  const normalizePromptSettings = options.normalizePromptSettings || ((value) => value || {});
  const prompts = normalizePromptSettings(config && config.promptSettings);
  return [
    {
      role: "system",
      content: [
        prompts.finalSystem,
        runtimeTemporalContext(),
        protocol.baseContract(protocol.KIND.FINAL_ANSWER),
        memoryText
      ]
        .filter(Boolean)
        .join("\n")
    },
    {
      role: "user",
      content: [
        "原始对话:",
        messagesToText(originalMessages),
        "",
        "任务计划:",
        compactText(JSON.stringify(plan), 1800),
        strategy ? ["", "Strategy:", JSON.stringify(strategy)].join("\n") : "",
        "",
        "Worker 结果:",
        results.map((result) => reviewLoop.compactWorkerResult(result, 2600)).join("\n\n")
      ].join("\n")
    }
  ];
}

async function runFinalSynthesis({
  req,
  nextHandler,
  baseBody,
  messages,
  allTasks,
  workerResults,
  config,
  defaultConfig,
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
  callWithFallback,
  startedAt,
  normalizePromptSettings
}) {
  const finalModels = needsLocalExecution ? commanderRoute.models.slice(0, 1) : commanderRoute.models;
  const finalTask = {
    id: "final",
    title: "汇总最终答案",
    internal: true,
    routeInternal: true,
    modelPool: "commander",
    prompt: "使用 worker 结果回答原始用户。"
  };
  send("worker_start", {
    task: taskSummary(finalTask),
    candidates: finalModels.slice(0, 8)
  });
  const finalAttempt = await callWithFallback({
    req,
    nextHandler,
    baseBody,
    models: finalModels,
    messages: makeFinalMessages(
      messages,
      { tasks: allTasks },
      workerResults,
      config,
      memoryRuntime.relevantMemoriesForPrompt({
        goalId,
        query: `${goalMemoryQuery} ${workerResults.map((result) => `${result.task.title} ${result.content || ""} ${result.error || ""}`).join(" ")}`,
        types: ["knowledge", "procedure", "episodic"],
        limit: 8
      }).text,
      goalStrategy,
      { normalizePromptSettings }
    ),
    config,
    label: "final",
    trace,
    endpointMode: "chat",
    timeoutMsOverride: needsLocalExecution
      ? Number(config.commanderTimeoutMs || defaultConfig.commanderTimeoutMs)
      : undefined,
    budgetState: goalBudget,
    task: finalTask,
    onBudgetUpdate: persistGoalBudget,
    onModelEvent: (event, data) =>
      send(event, {
        ...data,
        task: taskSummary(finalTask)
      }),
    responseFormatKind: protocol.KIND.FINAL_ANSWER,
    validateContent: (content) =>
      protocol.validationForCall(content, protocol.KIND.FINAL_ANSWER, (value) =>
        typeof value.answerMarkdown === "string" && value.answerMarkdown.trim()
          ? { ok: true }
          : { ok: false, error: "Final answer must include non-empty answerMarkdown." }
      )
  });

  const parsedFinal = finalAttempt.ok
    ? protocol.parseProtocolContent(finalAttempt.content, protocol.KIND.FINAL_ANSWER, (value) =>
        typeof value.answerMarkdown === "string" && value.answerMarkdown.trim()
          ? { ok: true }
          : { ok: false, error: "Final answer must include non-empty answerMarkdown." }
      )
    : null;
  const content = parsedFinal && parsedFinal.ok ? parsedFinal.value.answerMarkdown : "";
  const sourceModel = finalAttempt.ok ? finalAttempt.model : finalAttempt.model || commanderRoute.selected;

  send("worker_done", {
    task: taskSummary(finalTask),
    status: finalAttempt.ok ? "completed" : "failed",
    ok: finalAttempt.ok,
    model: finalAttempt.model,
    content: finalAttempt.content || "",
    error: finalAttempt.error || "",
    elapsedMs: finalAttempt.elapsedMs
  });
  emitBudget("after_final", finalAttempt.budgetEvaluation || null, finalTask);
  if (!finalAttempt.ok) {
    send("error", {
      message: `Final synthesis failed: ${finalAttempt.error || "unknown error"}`,
      phase: "final",
      model: finalAttempt.model || commanderRoute.selected,
      trace
    });
    return {
      content,
      finalAttempt,
      sourceModel
    };
  }
  send("final", {
    content,
    source_model: sourceModel,
    commander_model: commanderRoute.selected,
    elapsedMs: Date.now() - startedAt,
    trace
  });
  return {
    content,
    finalAttempt,
    sourceModel
  };
}

module.exports = {
  makeFinalMessages,
  runFinalSynthesis
};
