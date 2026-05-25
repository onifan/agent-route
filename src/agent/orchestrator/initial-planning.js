"use strict";

const taskRuntime = require("../tasks");
const planner = require("./planner");
const protocol = require("./protocol");
const tokenBudget = require("./token-budget");

const { TASK_STATUS } = taskRuntime;

async function runInitialPlanning({
  req,
  nextHandler,
  baseBody,
  messages,
  config,
  defaultConfig,
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
  callWithFallback,
  persistGoalBudget,
  normalizePromptSettings
}) {
  const planTask = {
    id: "plan",
    title: "Create execution plan",
    internal: true,
    routeInternal: true,
    modelPool: "commander",
    prompt: "Split the user goal into executable worker tasks."
  };
  send("worker_start", {
    task: taskSummary(planTask),
    model: commanderRoute.models[0],
    candidates: commanderRoute.models.slice(0, 5)
  });

  const planAttempt = await callWithFallback({
    req,
    nextHandler,
    baseBody: {
      ...baseBody,
      max_tokens: tokenBudget.planMaxTokens(config, defaultConfig)
    },
    models: commanderRoute.models,
    messages: planner.makePlanPrompt(messages, config, plannerMemory, goalStrategy, { normalizePromptSettings }),
    config,
    label: "plan",
    trace,
    endpointMode: "chat",
    timeoutMsOverride: Number(config.commanderTimeoutMs || defaultConfig.commanderTimeoutMs),
    budgetState: goalBudget,
    task: planTask,
    onBudgetUpdate: persistGoalBudget,
    onModelEvent: (event, data) =>
      send(event, {
        ...data,
        task: taskSummary(planTask)
      }),
    responseFormatKind: protocol.KIND.PLAN,
    validateContent: (content) => {
      const parsed = planner.parsePlannerContent(content);
      return parsed
        ? { ok: true }
        : {
            ok: false,
            error: "Planner response did not contain a valid AgentRoute plan protocol object.",
            diagnostics: planner.plannerContentDiagnostics(content)
          };
    }
  });

  const parsedPlan = planAttempt.ok ? planner.parsePlannerContent(planAttempt.content) : null;
  const planDiagnostics =
    !parsedPlan && (planAttempt.diagnostics || planAttempt.content)
      ? planAttempt.diagnostics || planner.plannerContentDiagnostics(planAttempt.content || "")
      : null;
  if (!planAttempt.ok || !parsedPlan) {
    planner.recoverPlannerAttempt(
      planAttempt,
      messages,
      config,
      trace,
      planAttempt.error || planAttempt.content || "planner returned no structured tasks"
    );
  }

  send("worker_done", {
    task: taskSummary(planTask),
    status: planAttempt.ok && parsedPlan ? TASK_STATUS.COMPLETED : TASK_STATUS.FAILED,
    ok: Boolean(planAttempt.ok && parsedPlan),
    model: planAttempt.model,
    content: planAttempt.content || "",
    error: planAttempt.error || (!parsedPlan ? "Commander returned an invalid or empty plan." : ""),
    diagnostics: planDiagnostics || undefined,
    elapsedMs: planAttempt.elapsedMs
  });
  emitBudget("after_plan", planAttempt.budgetEvaluation || null, planTask);

  if (!planAttempt.ok) {
    const message = `Commander could not create a plan: ${planAttempt.error || "unknown error"}`;
    taskRuntime.setGoalStatus(goalId, TASK_STATUS.FAILED, { blockedReason: message });
    send("error", {
      message,
      phase: "plan",
      model: planAttempt.model || commanderRoute.selected,
      diagnostics: planDiagnostics || undefined,
      trace
    });
    return { handled: true, reason: "plan_failed" };
  }

  if (!parsedPlan) {
    const message = "Commander returned an invalid or empty plan.";
    taskRuntime.setGoalStatus(goalId, TASK_STATUS.FAILED, { blockedReason: message });
    send("error", {
      message,
      phase: "plan",
      model: planAttempt.model,
      raw: planAttempt.content || "",
      diagnostics: planDiagnostics || undefined,
      trace
    });
    return { handled: true, reason: "plan_invalid" };
  }

  const plan = planner.normalizePlan(parsedPlan, config, messages, goalStrategy);
  const registeredPlanTasks = appendTasks(plan.tasks, "commander");
  if (!registeredPlanTasks.length) {
    const message = "Strategic layer blocked the planner output because no strategy-compliant task remained.";
    taskRuntime.setGoalStatus(goalId, TASK_STATUS.BLOCKED, { blockedReason: message });
    send("pause", {
      goal_id: goalId,
      status: TASK_STATUS.BLOCKED,
      message,
      strategy: goalStrategy,
      elapsedMs: Date.now() - startedAt,
      trace
    });
    return { handled: true, reason: "plan_blocked_by_strategy" };
  }
  return {
    handled: false,
    plan,
    planAttempt,
    recoveredPlanAttempt: planAttempt,
    registeredPlanTasks
  };
}

module.exports = {
  runInitialPlanning
};
