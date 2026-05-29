"use strict";

const taskRuntime = require("../tasks");
const memoryRuntime = require("../memory");
const strategyEngine = require("../strategies");
const planner = require("./planner");
const protocol = require("./protocol");
const reviewIteration = require("./review-iteration");
const reviewLoop = require("./review-loop");
const tokenBudget = require("./token-budget");

async function runReviewIteration({
  req,
  nextHandler,
  baseBody,
  messages,
  config,
  defaultConfig,
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
}) {
  const reviewModels = needsLocalExecution ? commanderRoute.models.slice(0, 1) : commanderRoute.models;
  const reviewTask = reviewIteration.createReviewTask(iteration);
  send("worker_start", {
    task: taskSummary(reviewTask),
    modelPool: reviewTask.modelPool,
    candidates: reviewModels.slice(0, 5)
  });
  const reviewMemory = memoryRuntime.relevantMemoriesForPrompt({
    goalId,
    query: `${goalMemoryQuery} ${workerResults.map((result) => `${result.task.title} ${result.status || ""} ${result.error || ""}`).join(" ")}`,
    types: ["knowledge", "procedure", "episodic", "working"],
    limit: 8
  }).text;
  const reviewAttempt = await callRoutedModel({
    req,
    nextHandler,
    baseBody: {
      ...baseBody,
      max_tokens: tokenBudget.reviewMaxTokens(config, defaultConfig)
    },
    models: reviewModels,
    messages: reviewLoop.makeProgressMessages(
      messages,
      { tasks: allTasks },
      workerResults,
      iteration,
      config,
      reviewMemory,
      goalStrategy,
      { normalizePromptSettings }
    ),
    config,
    label: `goal-review:${iteration}`,
    trace,
    endpointMode: "chat",
    timeoutMsOverride: Number(config.commanderTimeoutMs || defaultConfig.commanderTimeoutMs),
    budgetState: goalBudget,
    task: reviewTask,
    onBudgetUpdate: persistGoalBudget,
    onModelEvent: (event, data) =>
      send(event, {
        ...data,
        task: taskSummary(reviewTask)
      }),
    functionCallKind: protocol.KIND.GOAL_REVIEW,
    validateContent: (content) =>
      protocol.validationForCall(content, protocol.KIND.GOAL_REVIEW, (value) =>
        value.status === "done" || value.status === "continue"
          ? { ok: true }
          : { ok: false, error: "Goal review must include status done or continue." }
      )
  });
  send("worker_done", {
    task: taskSummary(reviewTask),
    status: reviewAttempt.ok ? taskRuntime.TASK_STATUS.COMPLETED : taskRuntime.TASK_STATUS.FAILED,
    ok: reviewAttempt.ok,
    model: reviewAttempt.model,
    content: reviewAttempt.content || "",
    error: reviewAttempt.error || "",
    elapsedMs: reviewAttempt.elapsedMs
  });
  emitBudget(`after_review:${iteration}`, reviewAttempt.budgetEvaluation || null, reviewTask);

  if (!reviewAttempt.ok) {
    const review = {
      status: "failed",
      progressSummary: reviewAttempt.error || "Commander review failed.",
      finalAnswer: "",
      strategyRevisionReason: "",
      nextTasks: []
    };
    send("goal_check", {
      iteration,
      ok: false,
      status: review.status,
      progress_summary: review.progressSummary,
      next_count: 0,
      commander_model: reviewAttempt.model || commanderRoute.selected
    });
    return {
      explicitRevisionReason: "",
      finalAnswer: "",
      goalStrategy,
      review,
      reviewAttempt,
      reviewTask,
      shouldContinue: false,
      strategyChanged: false,
      strategyRevision: { shouldRevise: false, reasons: [], revisionReason: "" },
      failed: true,
      error: review.progressSummary
    };
  }

  const parsedReviewResult = reviewAttempt.ok
    ? protocol.parseProtocolContent(reviewAttempt.content, protocol.KIND.GOAL_REVIEW, (value) =>
        value.status === "done" || value.status === "continue"
          ? { ok: true }
          : { ok: false, error: "Goal review must include status done or continue." }
      )
    : null;
  const parsedReview = parsedReviewResult && parsedReviewResult.ok ? parsedReviewResult.value : null;
  const review = reviewLoop.normalizeGoalReview(parsedReview, config, messages, goalStrategy, {
    normalizePlan: planner.normalizePlan
  });
  const strategyRevision = strategyEngine.shouldReviseStrategy(goalStrategy, {
    budgetEvaluation: reviewAttempt.budgetEvaluation,
    tasks: allTasks,
    review
  });
  const explicitRevisionReason = review.strategyRevisionReason;
  let nextGoalStrategy = goalStrategy;
  if (explicitRevisionReason || strategyRevision.shouldRevise) {
    const revisionReason = explicitRevisionReason || strategyRevision.revisionReason;
    nextGoalStrategy = strategyEngine.reviseStrategy(goalStrategy, {
      reason: revisionReason,
      budgetEvaluation: reviewAttempt.budgetEvaluation,
      review
    });
    nextGoalStrategy = taskRuntime.setGoalStrategy(goalId, nextGoalStrategy, {
      source: reviewAttempt.model || commanderRoute.selected,
      reason: revisionReason
    });
    emitStrategy(strategyEngine.STRATEGY_EVENT.REVISED, {
      reasons: strategyRevision.reasons,
      review_reason: explicitRevisionReason
    });
    const revisedStrategyMemories = memoryRuntime.createMemoriesFromCandidates(
      [strategyEngine.memoryCandidateForStrategy(nextGoalStrategy, strategyEngine.STRATEGY_EVENT.REVISED)],
      {
        goalId,
        source: "strategic-layer",
        sourceSummary: "Strategy revision"
      }
    );
    if (revisedStrategyMemories.length) {
      send("memory", {
        goal_id: goalId,
        source: "strategy",
        count: revisedStrategyMemories.length,
        memories: revisedStrategyMemories
      });
    }
  }
  const reviewMemories = [
    ...memoryRuntime.captureReviewMemory({ goalId, review, source: reviewAttempt.model || commanderRoute.selected }),
    ...memoryRuntime.createMemoriesFromCandidates(
      parsedReview && (parsedReview.memory_candidates || parsedReview.memoryCandidates),
      {
        goalId,
        source: reviewAttempt.model || commanderRoute.selected,
        sourceSummary: "Commander review"
      }
    )
  ];
  if (reviewMemories.length) {
    send("memory", {
      goal_id: goalId,
      source: "review",
      count: reviewMemories.length,
      memories: reviewMemories
    });
  }
  send("goal_check", {
    iteration,
    ok: reviewAttempt.ok,
    status: review.status,
    progress_summary: review.progressSummary || reviewAttempt.content || reviewAttempt.error || "",
    next_count: review.nextTasks.length,
    commander_model: reviewAttempt.model || commanderRoute.selected
  });

  const strategyChanged = Boolean(explicitRevisionReason || strategyRevision.shouldRevise);
  return {
    explicitRevisionReason,
    finalAnswer: review.status === "done" && review.finalAnswer ? review.finalAnswer : "",
    goalStrategy: nextGoalStrategy,
    review,
    reviewAttempt,
    shouldContinue: reviewIteration.shouldContinueAfterReview({
      review,
      iteration,
      maxGoalIterations,
      strategyChanged
    }),
    strategyChanged,
    strategyRevision
  };
}

module.exports = {
  runReviewIteration
};
