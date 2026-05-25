"use strict";

const taskRuntime = require("../tasks");
const memoryRuntime = require("../memory");
const budgetGovernor = require("../budget");
const dependencyEngine = require("../graph");
const riskEngine = require("../risk");
const strategyEngine = require("../strategies");
const verificationEngine = require("../verification");
const correctiveEngine = require("../corrective");
const actionDecisionEngine = require("../action-decision");
const actionLearning = require("../action-learning");
const decisionAttribution = require("../decision-attribution");
const observabilityRuntime = require("../observability");
const recoveryRuntime = require("../recovery");
const configLoader = require("../../config/loader");
const providerSettings = require("../../core/providers");
const { corsHeaders } = require("../../security/cors");
const { messagesToText } = require("./content-utils");
const modelRoutingService = require("./model-routing-service");
const { taskSummary } = require("./task-executor");

function jsonResponse(body, status = 200, headers = {}, requestOrOrigin = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(requestOrOrigin, {
      "Content-Type": "application/json",
      ...headers
    })
  });
}

function normalizeAgentRouteAction(body) {
  return String(body.action || body.agent_route_action || body.agentRouteAction || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
}

function taskActionGoalId(body) {
  return String(
    body.goal_id || body.goalId || (body.goal && typeof body.goal === "string" ? body.goal : "") || "default-goal"
  ).trim();
}

function taskActionTaskId(body) {
  return String(body.task_id || body.taskId || body.id || "").trim();
}

function isInternalRouteTaskId(taskId) {
  const id = String(taskId || "").trim();
  return id === "plan" || id === "final" || /^goal-review-\d+$/.test(id);
}

function taskActionMemoryId(body) {
  return String(body.memory_id || body.memoryId || body.id || "").trim();
}

function taskActionErrorResponse(err, requestOrOrigin = null) {
  const code = err && err.code ? err.code : "agent_route_task_error";
  const status =
    code === "task_not_found" || code === "memory_not_found"
      ? 404
      : code === "illegal_task_transition" || code === "task_running"
        ? 409
        : 400;
  return jsonResponse(
    {
      error: {
        message: err && err.message ? err.message : String(err),
        type: "invalid_request_error",
        code,
        details: (err && err.details) || {}
      }
    },
    status,
    {},
    requestOrOrigin
  );
}

function summarizeTaskBudgets(tasks = [], goalBudgetState = null) {
  let usage = budgetGovernor.emptyUsage();
  const taskBudgets = [];
  for (const task of tasks || []) {
    const normalizedUsage = budgetGovernor.normalizeUsage(task && (task.budgetUsage || task.budget_usage));
    usage = budgetGovernor.addUsage(usage, normalizedUsage);
    taskBudgets.push({
      task_id: task.id,
      title: task.title || "",
      status: task.status || "",
      budgetStatus: task.budgetStatus || "ok",
      degradationLevel: task.degradationLevel || "none",
      budgetUsage: normalizedUsage,
      budgetWarnings: task.budgetWarnings || [],
      budgetBlockedReason: task.budgetBlockedReason || task.blockedReason || "",
      budgetHistory: task.budgetHistory || []
    });
  }
  const topTasks = taskBudgets
    .slice()
    .sort((a, b) => {
      const aCost = Number(a.budgetUsage.estimatedCostUsd || 0) + Number(a.budgetUsage.actualCostUsd || 0);
      const bCost = Number(b.budgetUsage.estimatedCostUsd || 0) + Number(b.budgetUsage.actualCostUsd || 0);
      return bCost - aCost;
    })
    .slice(0, 8);
  return {
    goalBudgetState,
    usage,
    taskBudgets,
    topTasks,
    workerUsage: usage.modelCalls || {},
    warnings: taskBudgets.flatMap((task) => task.budgetWarnings || []).slice(-20)
  };
}

function countTasksByStatus(tasks = []) {
  return tasks.reduce((counts, task) => {
    const status = task.status || "unknown";
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
}

function derivedGoalStatus(goal = {}, tasks = []) {
  const stored = goal.status || "";
  if (!tasks.length) return stored;
  const statuses = tasks.map((task) => String(task.status || "").toLowerCase());
  if (statuses.some((status) => status === "running")) return "running";
  if (statuses.some((status) => status === "waiting_human" || status === "awaiting_confirmation"))
    return "waiting_human";
  if (statuses.some((status) => status === "blocked")) return "blocked";
  if (statuses.every((status) => status === "completed" || status === "done")) return "completed";
  if (statuses.every((status) => ["failed", "canceled", "cancelled"].includes(status))) return "failed";
  if (
    stored === "running" &&
    statuses.every((status) => ["completed", "done", "failed", "blocked", "canceled", "cancelled"].includes(status))
  ) {
    return statuses.some((status) => status === "failed") ? "failed" : "blocked";
  }
  return stored || "waiting";
}

function derivedGoalBlockedReason(goal = {}, tasks = [], status = "") {
  if (goal.blockedReason || goal.blocked_reason) return goal.blockedReason || goal.blocked_reason;
  if (
    status === "failed" &&
    tasks.length &&
    tasks.every((task) => String(task.status || "").toLowerCase() === "failed")
  ) {
    return "所有任务都失败，目标没有可继续执行的任务。";
  }
  if (status === "blocked") {
    const task = tasks.find((item) => item.blockedReason || item.error);
    return task ? task.blockedReason || task.error : "目标存在阻塞任务。";
  }
  return "";
}

function compactGoalForActionApi(goal = {}, options = {}) {
  const tasks = Array.isArray(goal.tasks) ? goal.tasks : [];
  const summarizedTasks = options.includeTasks === false ? [] : tasks.map(taskSummary);
  const status = derivedGoalStatus(goal, tasks);
  return {
    goalId: goal.goalId || goal.goal_id || "",
    status,
    blockedReason: derivedGoalBlockedReason(goal, tasks, status),
    recoverySummary: goal.recoverySummary || goal.recovery_summary || null,
    createdAt: goal.createdAt || goal.created_at || "",
    updatedAt: goal.updatedAt || goal.updated_at || "",
    taskCounts: countTasksByStatus(tasks),
    activeTaskIds: tasks
      .filter((task) =>
        ["running", "waiting_human", "awaiting_confirmation", "blocked", "retry_ready"].includes(task.status)
      )
      .map((task) => task.id),
    strategy: goal.strategyState
      ? {
          id: goal.strategyState.id || "",
          version: goal.strategyState.version || 0,
          status: goal.strategyState.status || "",
          objective: goal.strategyState.objective || "",
          revisionReason: goal.strategyState.revisionReason || goal.strategyState.revision_reason || ""
        }
      : null,
    budget: goal.budgetState
      ? {
          status: goal.budgetState.status || "",
          degradationLevel: goal.budgetState.degradationLevel || goal.budgetState.degradation_level || "",
          warnings: Array.isArray(goal.budgetState.warnings) ? goal.budgetState.warnings.slice(-10) : [],
          usage: budgetGovernor.normalizeUsage(goal.budgetState.usage || {})
        }
      : null,
    tasks: summarizedTasks
  };
}

async function handleAgentRouteAction(body, requestOrOrigin = null) {
  const response = (payload, status = 200, headers = {}) => jsonResponse(payload, status, headers, requestOrOrigin);
  const action = normalizeAgentRouteAction(body);
  const goalId = taskActionGoalId(body);
  const taskId = taskActionTaskId(body);
  const memoryId = taskActionMemoryId(body);
  try {
    if (action === "config_status" || action === "runtime_config" || action === "get_config") {
      const config = modelRoutingService.applyActiveProviderModels(configLoader.loadSanitizedRuntimeConfig());
      return response({
        config,
        sources: config.configSources || {},
        warnings: config.configWarnings || []
      });
    }
    if (action === "provider_status" || action === "providers" || action === "list_providers") {
      const status = providerSettings.providerStatus();
      return response({
        ok: status.ok,
        providerSettings: status,
        providers: status.connections,
        supportedProviders: status.supportedProviders
      });
    }
    if (action === "save_provider" || action === "upsert_provider") {
      const status = providerSettings.upsertProviderConnection(
        body.providerConnection && typeof body.providerConnection === "object" ? body.providerConnection : body
      );
      return response({
        ok: true,
        providerSettings: status,
        providers: status.connections,
        supportedProviders: status.supportedProviders
      });
    }
    if (action === "delete_provider" || action === "remove_provider") {
      const status = providerSettings.deleteProviderConnection(body.provider_id || body.providerId || body.id);
      return response({
        ok: true,
        providerSettings: status,
        providers: status.connections,
        supportedProviders: status.supportedProviders
      });
    }
    if (action === "test_provider" || action === "test_provider_connection") {
      const result = providerSettings.testProviderConnection(body.provider_id || body.providerId || body.id);
      return response({
        ok: true,
        ...result,
        providerSettings: result.providerSettings,
        providers: result.providerSettings.connections,
        supportedProviders: result.providerSettings.supportedProviders
      });
    }
    if (action === "save_provider_node" || action === "upsert_provider_node") {
      const status = providerSettings.upsertProviderNode(
        body.providerNode && typeof body.providerNode === "object" ? body.providerNode : body
      );
      return response({
        ok: true,
        providerSettings: status,
        providerNodes: status.providerNodes,
        supportedProviders: status.supportedProviders
      });
    }
    if (action === "delete_provider_node" || action === "remove_provider_node") {
      const status = providerSettings.deleteProviderNode(body.provider_node_id || body.providerNodeId || body.id);
      return response({
        ok: true,
        providerSettings: status,
        providerNodes: status.providerNodes,
        supportedProviders: status.supportedProviders
      });
    }
    if (action === "recovery_status" || action === "runtime_recovery_status") {
      return response({
        ok: true,
        recovery: recoveryRuntime.recoveryStatus()
      });
    }
    if (action === "run_recovery" || action === "runtime_recovery" || action === "recover_runtime") {
      const recovery = recoveryRuntime.runRuntimeRecovery({
        trigger: "api",
        force: body.force !== false
      });
      return response({
        ok: !recovery.errors.length,
        recovery
      });
    }
    if (action === "list_goals" || action === "goals") {
      const includeDetails = body.include_details === true || body.includeDetails === true || body.full === true;
      const goals = taskRuntime.listGoals();
      return response({
        goals: includeDetails ? goals : goals.map((goal) => compactGoalForActionApi(goal))
      });
    }
    if (action === "list_tasks" || action === "tasks") {
      const includeDetails = body.include_details === true || body.includeDetails === true || body.full === true;
      const tasks = taskRuntime.listTasks(goalId);
      return response({
        goal_id: goalId,
        tasks: includeDetails ? tasks : tasks.map(taskSummary)
      });
    }
    if (action === "observability_stream" || action === "monitor_stream" || action === "event_stream") {
      return observabilityRuntime.streamEvents({
        goalId,
        taskId,
        replay: body.replay || body.limit || 50
      });
    }
    if (
      action === "clear_logs" ||
      action === "clear_events" ||
      action === "clear_observability" ||
      action === "reset_monitor" ||
      action === "reset_monitoring"
    ) {
      const clearAll =
        body.scope === "all" || body.all === true || (!body.goal_id && !body.goalId && !body.task_id && !body.taskId);
      const cleared = observabilityRuntime.clearEvents(clearAll ? {} : { goalId, taskId });
      return response({
        ok: true,
        cleared,
        observability: observabilityRuntime.snapshot({
          goalId: clearAll ? "" : goalId,
          taskId,
          limit: body.limit || 200
        })
      });
    }
    if (
      action === "observability_status" ||
      action === "monitoring_status" ||
      action === "monitoring" ||
      action === "goal_dashboard" ||
      action === "task_timeline" ||
      action === "event_timeline" ||
      action === "risk_monitor" ||
      action === "budget_monitor" ||
      action === "verification_monitor" ||
      action === "worker_health" ||
      action === "strategy_analytics" ||
      action === "dependency_monitor" ||
      action === "diagnostics" ||
      action === "trace"
    ) {
      const observability = observabilityRuntime.snapshot({
        goalId,
        taskId,
        limit: body.limit || 200
      });
      const memories =
        body.persist_memory || body.persistMemory
          ? memoryRuntime.createMemoriesFromCandidates(observability.generatedMemoryCandidates, {
              goalId,
              taskId,
              source: "observability",
              sourceSummary: "Monitoring insight"
            })
          : [];
      return response({
        ok: true,
        goal_id: goalId,
        task_id: taskId,
        observability,
        dashboard: observability.goals,
        events: observability.eventTimeline,
        metrics: observability.metrics,
        diagnostics: observability.diagnostics,
        memories
      });
    }
    if (action === "list_memories" || action === "memories" || action === "search_memories") {
      const statusFilter = body.status || body.memory_status || body.memoryStatus || "";
      const memories = memoryRuntime.searchMemories({
        goalId: body.goal_id || body.goalId ? goalId : "",
        taskId,
        query: body.query || body.q || "",
        type: body.type || body.memory_type || body.memoryType || "",
        types: Array.isArray(body.types) ? body.types : [],
        status: statusFilter,
        statuses: Array.isArray(body.statuses) ? body.statuses : [],
        includeInactive: Boolean(body.include_inactive || body.includeInactive || statusFilter),
        onlyGlobal: Boolean(body.only_global || body.onlyGlobal),
        exactGoal: Boolean(body.exact_goal || body.exactGoal),
        minImportance: body.min_importance || body.minImportance,
        limit: body.limit || 30
      });
      return response({
        goal_id: goalId,
        task_id: taskId,
        memories
      });
    }
    if (action === "get_memory") {
      const memory = memoryRuntime.getMemory(memoryId);
      if (!memory)
        throw Object.assign(new Error(`Memory not found: ${memoryId}`), {
          code: "memory_not_found",
          details: { memoryId }
        });
      return response({ memory });
    }
    if (action === "add_memory" || action === "create_memory") {
      const memory = memoryRuntime.createMemory(
        {
          goalId,
          taskId,
          source: body.source || "manual",
          type: body.type || body.memory_type || body.memoryType || "knowledge",
          importance: body.importance || 3,
          title: body.title || "",
          summary: body.summary || body.content || body.text || "",
          tags: body.tags || [],
          sourceSummary: body.source_summary || body.sourceSummary || "Manual memory"
        },
        { force: Boolean(body.force), dedupe: body.dedupe !== false }
      );
      if (!memory) {
        return response(
          {
            error: {
              message: "Memory was not saved because it looked low-value or sensitive.",
              type: "invalid_request_error",
              code: "memory_rejected"
            }
          },
          400
        );
      }
      return response({ memory });
    }
    if (action === "update_memory") {
      const memory = memoryRuntime.updateMemory(memoryId, {
        type: body.type || body.memory_type || body.memoryType,
        importance: body.importance,
        title: body.title,
        summary: body.summary || body.content,
        tags: body.tags,
        status: body.status,
        expiresAt: body.expires_at || body.expiresAt,
        staleReason: body.stale_reason || body.staleReason
      });
      return response({ memory });
    }
    if (action === "disable_memory" || action === "stale_memory") {
      const memory = memoryRuntime.disableMemory(
        memoryId,
        body.reason || body.stale_reason || "disabled",
        action === "stale_memory" ? "stale" : "disabled"
      );
      return response({ memory });
    }
    if (action === "delete_memory") {
      const memory = memoryRuntime.deleteMemory(memoryId);
      return response({ memory });
    }
    if (action === "mark_memory_important") {
      const memory = memoryRuntime.markImportant(memoryId, body.important !== false);
      return response({ memory });
    }
    if (action === "get_task" || action === "task_status") {
      const task = taskRuntime.getTask(goalId, taskId);
      if (!task)
        throw Object.assign(new Error(`Task not found: ${taskId}`), {
          code: "task_not_found",
          details: { goalId, taskId }
        });
      return response({ goal_id: goalId, task });
    }
    if (action === "task_history" || action === "get_task_history") {
      const task = taskRuntime.getTask(goalId, taskId);
      if (!task)
        throw Object.assign(new Error(`Task not found: ${taskId}`), {
          code: "task_not_found",
          details: { goalId, taskId }
        });
      return response({
        goal_id: goalId,
        task_id: taskId,
        history: taskRuntime.getTaskHistory(goalId, taskId)
      });
    }
    if (action === "risk_history" || action === "list_risk" || action === "risks") {
      const tasks = taskId ? [taskRuntime.getTask(goalId, taskId)].filter(Boolean) : taskRuntime.listTasks(goalId);
      if (taskId && !tasks.length)
        throw Object.assign(new Error(`Task not found: ${taskId}`), {
          code: "task_not_found",
          details: { goalId, taskId }
        });
      return response({
        goal_id: goalId,
        task_id: taskId,
        risks: tasks.map((task) => ({
          task_id: task.id,
          riskLevel: task.riskLevel || "low",
          riskReasons: task.riskReasons || [],
          requiresHumanApproval: Boolean(task.requiresHumanApproval),
          approvalReason: task.approvalReason || "",
          approvalStatus: task.approvalStatus || "",
          escalationReason: task.escalationReason || "",
          suggestedAction: task.suggestedAction || "",
          blockedReason: task.blockedReason || "",
          riskHistory: task.riskHistory || []
        }))
      });
    }
    if (action === "verification_history" || action === "list_verification" || action === "verifications") {
      const tasks = taskId ? [taskRuntime.getTask(goalId, taskId)].filter(Boolean) : taskRuntime.listTasks(goalId);
      if (taskId && !tasks.length)
        throw Object.assign(new Error(`Task not found: ${taskId}`), {
          code: "task_not_found",
          details: { goalId, taskId }
        });
      return response({
        goal_id: goalId,
        task_id: taskId,
        verifications: tasks.map((task) => ({
          task_id: task.id,
          verified: Boolean(task.verified),
          verificationStatus: task.verificationStatus || "",
          verificationConfidence: Number(task.verificationConfidence || 0),
          verificationReasons: task.verificationReasons || [],
          detectedIssues: task.detectedIssues || [],
          verificationSuggestedNextState: task.verificationSuggestedNextState || "",
          verificationRetryable: task.verificationRetryable !== false,
          verificationHistory: task.verificationHistory || []
        }))
      });
    }
    if (action === "authenticity_status" || action === "authenticity" || action === "false_success_status") {
      const tasks = taskId ? [taskRuntime.getTask(goalId, taskId)].filter(Boolean) : taskRuntime.listTasks(goalId);
      if (taskId && !tasks.length)
        throw Object.assign(new Error(`Task not found: ${taskId}`), {
          code: "task_not_found",
          details: { goalId, taskId }
        });
      const items = tasks.map((task) => {
        const score = Number(task.authenticityScore || 0);
        const history = Array.isArray(task.verificationHistory) ? task.verificationHistory : [];
        const latest =
          history
            .slice()
            .reverse()
            .find((entry) => entry.authenticityScore != null) || {};
        return {
          task_id: task.id,
          title: task.title || "",
          status: task.status || "",
          score,
          authenticityScore: score,
          warnings: task.authenticityWarnings || latest.authenticityWarnings || [],
          reasons: task.authenticityReasons || latest.authenticityReasons || [],
          signals: task.authenticitySignals || latest.authenticitySignals || [],
          decisionSource: task.decisionSource || latest.decisionSource || "",
          suggestedNextState: task.verificationSuggestedNextState || latest.suggestedNextState || "",
          blockedReason: task.blockedReason || ""
        };
      });
      return response({
        ok: true,
        goal_id: goalId,
        task_id: taskId,
        authenticity: taskId ? items[0] || null : items,
        items
      });
    }
    if (action === "corrective_status" || action === "corrective_actions" || action === "recommended_actions") {
      const tasks = taskId ? [taskRuntime.getTask(goalId, taskId)].filter(Boolean) : taskRuntime.listTasks(goalId);
      if (taskId && !tasks.length)
        throw Object.assign(new Error(`Task not found: ${taskId}`), {
          code: "task_not_found",
          details: { goalId, taskId }
        });
      const items = tasks.map((task) => {
        const history = Array.isArray(task.verificationHistory) ? task.verificationHistory : [];
        const latestVerification = history[history.length - 1] || {};
        const computed = correctiveEngine.suggestCorrectiveActions({
          task,
          verification: latestVerification,
          risk:
            Array.isArray(task.riskHistory) && task.riskHistory.length
              ? task.riskHistory[task.riskHistory.length - 1]
              : task
        });
        return {
          task_id: task.id,
          title: task.title || "",
          status: task.status || "",
          recommendedActions:
            Array.isArray(task.recommendedActions) && task.recommendedActions.length
              ? task.recommendedActions
              : computed.recommendedActions,
          summary: task.correctiveSummary || computed.summary,
          sourceSignals: computed.sourceSignals
        };
      });
      return response({
        ok: true,
        goal_id: goalId,
        task_id: taskId,
        corrective: taskId ? items[0] || null : items,
        items
      });
    }
    if (action === "action_decision_status" || action === "ranked_actions" || action === "action_ranking") {
      const tasks = taskId ? [taskRuntime.getTask(goalId, taskId)].filter(Boolean) : taskRuntime.listTasks(goalId);
      if (taskId && !tasks.length)
        throw Object.assign(new Error(`Task not found: ${taskId}`), {
          code: "task_not_found",
          details: { goalId, taskId }
        });
      const items = tasks.map((task) => {
        const history = Array.isArray(task.verificationHistory) ? task.verificationHistory : [];
        const latestVerification = history[history.length - 1] || {};
        const computedCorrective = correctiveEngine.suggestCorrectiveActions({
          task,
          verification: latestVerification,
          risk:
            Array.isArray(task.riskHistory) && task.riskHistory.length
              ? task.riskHistory[task.riskHistory.length - 1]
              : task
        });
        const actions =
          Array.isArray(task.recommendedActions) && task.recommendedActions.length
            ? task.recommendedActions
            : computedCorrective.recommendedActions;
        const computedDecision = actionDecisionEngine.rankActions({
          task,
          recommendedActions: actions,
          verification: latestVerification,
          risk:
            Array.isArray(task.riskHistory) && task.riskHistory.length
              ? task.riskHistory[task.riskHistory.length - 1]
              : task,
          budget: {
            status: task.budgetStatus,
            degradationLevel: task.degradationLevel,
            warnings: task.budgetWarnings,
            blockedReason: task.budgetBlockedReason,
            usage: task.budgetUsage
          },
          history: {
            correctiveHistory: task.correctiveHistory,
            actionDecisionHistory: task.actionDecisionHistory,
            retryCount: task.attempts
          }
        });
        return {
          task_id: task.id,
          title: task.title || "",
          status: task.status || "",
          rankedActions:
            Array.isArray(task.rankedActions) && task.rankedActions.length
              ? task.rankedActions
              : computedDecision.rankedActions,
          recommendedAction: task.recommendedAction || computedDecision.recommendedAction,
          summary: task.actionDecisionSummary || computedDecision.summary,
          sourceSignals: computedDecision.sourceSignals
        };
      });
      return response({
        ok: true,
        goal_id: goalId,
        task_id: taskId,
        actionDecision: taskId ? items[0] || null : items,
        action_decision: taskId ? items[0] || null : items,
        items
      });
    }
    if (action === "action_learning_status" || action === "action_learning" || action === "learning_status") {
      const status = actionLearning.getActionLearningStatus({
        goalId,
        taskId,
        limit: body.limit || 200
      });
      return response({
        ok: true,
        goal_id: goalId,
        task_id: taskId,
        actionLearning: status,
        action_learning: status
      });
    }
    if (
      action === "decision_attribution_status" ||
      action === "decision_attribution" ||
      action === "attribution_status"
    ) {
      const status = decisionAttribution.getDecisionAttributionStatus({
        goalId,
        taskId,
        limit: body.limit || 200
      });
      return response({
        ok: true,
        goal_id: goalId,
        task_id: taskId,
        decisionAttribution: status,
        decision_attribution: status
      });
    }
    if (action === "budget_status" || action === "budget_history" || action === "list_budget" || action === "budgets") {
      const tasks = taskId ? [taskRuntime.getTask(goalId, taskId)].filter(Boolean) : taskRuntime.listTasks(goalId);
      if (taskId && !tasks.length)
        throw Object.assign(new Error(`Task not found: ${taskId}`), {
          code: "task_not_found",
          details: { goalId, taskId }
        });
      const summary = summarizeTaskBudgets(tasks, taskRuntime.getGoalBudgetState(goalId));
      return response({
        goal_id: goalId,
        task_id: taskId,
        budget: summary,
        tasks: summary.taskBudgets
      });
    }
    if (
      action === "dependency_graph" ||
      action === "graph_status" ||
      action === "task_graph" ||
      action === "ready_tasks" ||
      action === "retry_scope"
    ) {
      const graph = taskRuntime.getExecutionGraph(goalId);
      const scope = action === "retry_scope" && taskId ? taskRuntime.retryImpactScope(goalId, taskId) : null;
      return response({
        goal_id: goalId,
        task_id: taskId,
        graph,
        readyTasks: taskRuntime.readyTasks(goalId),
        nextReadyTask: taskRuntime.nextWaitingTask(goalId),
        parallelGroups: graph.parallelGroups || [],
        blockedChains: graph.blockedChains || [],
        artifactFlow: graph.edges.filter((edge) => edge.type === "artifact"),
        retryScope: scope
      });
    }
    if (
      action === "strategy_status" ||
      action === "strategy_history" ||
      action === "get_strategy" ||
      action === "strategies"
    ) {
      return response({
        goal_id: goalId,
        strategy: taskRuntime.getGoalStrategy(goalId),
        history: taskRuntime.getGoalStrategyHistory(goalId),
        tasks: taskRuntime.listTasks(goalId).map((task) => ({
          task_id: task.id,
          title: task.title,
          status: task.status,
          strategyId: task.strategyId || "",
          strategicObjective: task.strategicObjective || "",
          strategicPhase: task.strategicPhase || "",
          strategicRationale: task.strategicRationale || ""
        }))
      });
    }
    if (action === "generate_strategy" || action === "create_strategy") {
      const goalText = String(
        body.goal || body.goalText || body.goal_text || messagesToText(body.messages || []) || goalId
      );
      const memoryText = memoryRuntime.relevantMemoriesForPrompt({
        goalId,
        query: goalText,
        types: ["knowledge", "procedure", "episodic"],
        limit: 8
      }).text;
      const strategy = strategyEngine.generateStrategy({
        goalId,
        goalText,
        memoryText,
        budgetPolicy: body.budget || body.budgetPolicy || body.budget_policy || budgetGovernor.DEFAULT_BUDGET_POLICY,
        revisionReason: body.reason || body.revisionReason || "manual strategy generation"
      });
      const saved = taskRuntime.setGoalStrategy(goalId, strategy, {
        source: "api",
        reason: strategy.revisionReason
      });
      const memories = memoryRuntime.createMemoriesFromCandidates([strategyEngine.memoryCandidateForStrategy(saved)], {
        goalId,
        source: "strategic-layer",
        sourceSummary: "Manual strategy generation"
      });
      return response({
        goal_id: goalId,
        strategy: saved,
        history: taskRuntime.getGoalStrategyHistory(goalId),
        memories
      });
    }
    if (action === "revise_strategy" || action === "replan_strategy" || action === "invalidate_strategy") {
      const current =
        taskRuntime.getGoalStrategy(goalId) ||
        strategyEngine.generateStrategy({
          goalId,
          goalText: String(body.goal || body.goalText || body.goal_text || goalId),
          memoryText: memoryRuntime.relevantMemoriesForPrompt({
            goalId,
            query: String(body.goal || body.goalText || body.goal_text || goalId),
            types: ["knowledge", "procedure", "episodic"],
            limit: 8
          }).text,
          budgetPolicy: body.budget || body.budgetPolicy || body.budget_policy || budgetGovernor.DEFAULT_BUDGET_POLICY,
          revisionReason: "strategy created before revision"
        });
      const reason = String(
        body.reason ||
          body.revisionReason ||
          body.revision_reason ||
          (action === "invalidate_strategy" ? "strategy invalidated by user" : "manual strategy revision")
      );
      const next =
        action === "invalidate_strategy"
          ? strategyEngine.normalizeStrategy(
              {
                ...current,
                status: strategyEngine.STRATEGY_STATUS.INVALIDATED,
                revisionReason: reason,
                updatedAt: new Date().toISOString()
              },
              { goalId, revisionReason: reason }
            )
          : strategyEngine.reviseStrategy(current, {
              reason,
              budgetEvaluation: body.budgetEvaluation || body.budget_evaluation || {},
              review: body.review || {}
            });
      const saved = taskRuntime.setGoalStrategy(goalId, next, {
        source: "api",
        reason
      });
      const memories = memoryRuntime.createMemoriesFromCandidates(
        [strategyEngine.memoryCandidateForStrategy(saved, strategyEngine.STRATEGY_EVENT.REVISED)],
        {
          goalId,
          source: "strategic-layer",
          sourceSummary: "Manual strategy revision"
        }
      );
      return response({
        goal_id: goalId,
        strategy: saved,
        history: taskRuntime.getGoalStrategyHistory(goalId),
        requiresReplan: action === "replan_strategy",
        memories
      });
    }
    if (action === "evaluate_strategy" || action === "constrain_plan") {
      const strategy = body.strategy
        ? strategyEngine.normalizeStrategy(body.strategy, { goalId })
        : taskRuntime.getGoalStrategy(goalId) ||
          strategyEngine.generateStrategy({
            goalId,
            goalText: String(body.goal || body.goalText || body.goal_text || goalId),
            memoryText: memoryRuntime.relevantMemoriesForPrompt({
              goalId,
              query: String(body.goal || body.goalText || body.goal_text || goalId),
              types: ["knowledge", "procedure", "episodic"],
              limit: 8
            }).text,
            budgetPolicy: body.budget || body.budgetPolicy || body.budget_policy || budgetGovernor.DEFAULT_BUDGET_POLICY
          });
      const rawTasks = Array.isArray(body.tasks)
        ? body.tasks
        : body.task
          ? [body.task]
          : taskId
            ? [taskRuntime.getTask(goalId, taskId)].filter(Boolean)
            : [];
      const planEvaluation = rawTasks.length
        ? strategyEngine.constrainPlan({ tasks: rawTasks }, strategy)
        : { tasks: [], blockedTasks: [], revisedTasks: [], violations: [], changed: false };
      const stop = strategyEngine.evaluateStopConditions(strategy, {
        budgetEvaluation: body.budgetEvaluation || body.budget_evaluation || {},
        riskEvaluation: body.riskEvaluation || body.risk_evaluation || {},
        tasks: taskRuntime.listTasks(goalId),
        violations: planEvaluation.violations
      });
      return response({
        goal_id: goalId,
        strategy,
        evaluation: rawTasks.length === 1 ? strategyEngine.evaluateTaskAgainstStrategy(rawTasks[0], strategy) : null,
        plan: planEvaluation,
        stop
      });
    }
    if (action === "evaluate_budget") {
      const existingTask = taskId ? taskRuntime.getTask(goalId, taskId) : null;
      if (taskId && !existingTask)
        throw Object.assign(new Error(`Task not found: ${taskId}`), {
          code: "task_not_found",
          details: { goalId, taskId }
        });
      const task = existingTask || body.task || {};
      const usage = body.usage || body.budgetUsage || body.budget_usage || {};
      const taskForEvaluation = {
        ...task,
        budgetUsage: budgetGovernor.addUsage(task.budgetUsage || task.budget_usage || {}, usage)
      };
      const evaluation = budgetGovernor.evaluateTaskBudget(taskForEvaluation, {
        phase: body.phase || "manual",
        budgetPolicy: body.budget || body.budgetPolicy || body.budget_policy || budgetGovernor.DEFAULT_BUDGET_POLICY,
        nextAttempt: body.nextAttempt || body.next_attempt
      });
      return response({
        goal_id: goalId,
        task_id: taskId,
        evaluation
      });
    }
    if (action === "evaluate_verification" || action === "verify_result") {
      const existingTask = taskId ? taskRuntime.getTask(goalId, taskId) : null;
      const task = existingTask || body.task || {};
      if (taskId && !existingTask)
        throw Object.assign(new Error(`Task not found: ${taskId}`), {
          code: "task_not_found",
          details: { goalId, taskId }
        });
      const rawWorkerResult = body.worker_result || body.workerResult || {};
      if (body.evidence && rawWorkerResult && typeof rawWorkerResult === "object" && !rawWorkerResult.evidence) {
        rawWorkerResult.evidence = body.evidence;
      }
      const verification = verificationEngine.verifyTaskResult(task, rawWorkerResult, {
        phase: body.phase || "manual",
        cwd: body.cwd,
        browser: body.browser,
        shell: body.shell,
        apiResponses: body.apiResponses || body.api_responses,
        fileChanges: body.fileChanges || body.file_changes,
        outputDirs: body.outputDirs || body.output_dirs,
        expectedContent: body.expectedContent || body.expected_content
      });
      return response({
        goal_id: goalId,
        task_id: taskId,
        verification
      });
    }
    if (action === "evaluate_risk") {
      const existingTask = taskId ? taskRuntime.getTask(goalId, taskId) : null;
      const task = existingTask || body.task || {};
      if (taskId && !existingTask)
        throw Object.assign(new Error(`Task not found: ${taskId}`), {
          code: "task_not_found",
          details: { goalId, taskId }
        });
      const evaluation = riskEngine.evaluateTaskRisk(task, {
        phase: body.phase || "manual",
        goal: body.goal || body.goalText || "",
        workerResult: body.worker_result || body.workerResult || {},
        actions: body.actions || []
      });
      return response({
        goal_id: goalId,
        task_id: taskId,
        evaluation
      });
    }
    if (action === "register_tasks" || action === "add_tasks") {
      const rawTasks = Array.isArray(body.tasks) ? body.tasks : body.task ? [body.task] : [];
      const strategy = body.strategy
        ? taskRuntime.setGoalStrategy(goalId, body.strategy, {
            source: "api",
            reason: body.strategyReason || body.strategy_reason || "strategy provided with API tasks"
          })
        : taskRuntime.getGoalStrategy(goalId);
      const expanded = strategy
        ? dependencyEngine.expandStrategyApprovalTasks(rawTasks, strategy, {
            existingTasks: taskRuntime.listTasks(goalId)
          })
        : { tasks: rawTasks, inserted: [] };
      const constrained = strategy
        ? strategyEngine.constrainPlan({ tasks: expanded.tasks }, strategy)
        : { tasks: rawTasks, changed: false, violations: [], blockedTasks: [], revisedTasks: [] };
      const tasks = taskRuntime.registerGoalTasks(goalId, constrained.tasks, {
        replace: Boolean(body.replace),
        source: "api"
      });
      observabilityRuntime.recordEvent(
        "tasks_registered",
        {
          goal_id: goalId,
          tasks,
          insertedApprovalTasks: expanded.inserted,
          strategyViolations: constrained.violations
        },
        { source: "api", goalId }
      );
      return response({
        goal_id: goalId,
        tasks,
        strategy,
        strategyViolations: constrained.violations,
        blockedTasks: constrained.blockedTasks.map((item) => item.task),
        insertedApprovalTasks: expanded.inserted
      });
    }
    if (action === "confirm_task" || action === "continue_task" || action === "approve_task") {
      const task = taskRuntime.confirmTask(goalId, taskId, {
        source: "api",
        decisionSource: "human_review",
        actualAction: "request_human_review",
        userConfirmed: true,
        context: body.context || {}
      });
      observabilityRuntime.recordEvent(
        "human_approved",
        {
          goal_id: goalId,
          task
        },
        { source: "api", goalId, taskId: task.id, severity: "info" }
      );
      return response({ goal_id: goalId, task });
    }
    if (action === "reject_task" || action === "deny_task") {
      const task = taskRuntime.rejectTask(goalId, taskId, {
        source: "api",
        decisionSource: "human_review",
        actualAction: "cancel_task",
        reason: body.reason || "rejected by user",
        context: body.context || {}
      });
      observabilityRuntime.recordEvent(
        "human_rejected",
        {
          goal_id: goalId,
          task,
          reason: body.reason || "rejected by user"
        },
        { source: "api", goalId, taskId: task.id, severity: "warn" }
      );
      return response({ goal_id: goalId, task });
    }
    if (action === "cancel_task") {
      const existingTask = taskRuntime.getTask(goalId, taskId);
      if (!existingTask && isInternalRouteTaskId(taskId)) {
        return response({
          ok: true,
          goal_id: goalId,
          task_id: taskId,
          skipped: true,
          message: "内部路由步骤不是可取消的真实任务，已忽略。"
        });
      }
      const task = taskRuntime.cancelTask(goalId, taskId, {
        source: "api",
        decisionSource: "manual_action",
        actualAction: "cancel_task",
        context: body.context || {}
      });
      observabilityRuntime.recordEvent(
        "task_canceled",
        {
          goal_id: goalId,
          task
        },
        { source: "api", goalId, taskId: task.id, severity: "warn" }
      );
      return response({ goal_id: goalId, task });
    }
    if (action === "delete_task" || action === "remove_task") {
      const existingTask = taskRuntime.getTask(goalId, taskId);
      if (!existingTask && isInternalRouteTaskId(taskId)) {
        return response({
          ok: true,
          goal_id: goalId,
          task_id: taskId,
          skipped: true,
          message: "内部路由步骤不是可删除的真实任务，已忽略。"
        });
      }
      const deletion = taskRuntime.deleteTask(goalId, taskId, {
        source: "api",
        force: body.force === true,
        context: body.context || {}
      });
      observabilityRuntime.recordEvent(
        "task_deleted",
        {
          goal_id: goalId,
          task: deletion.task,
          task_id: deletion.taskId
        },
        { source: "api", goalId, taskId: deletion.taskId, severity: "warn" }
      );
      return response({
        ok: true,
        goal_id: goalId,
        task_id: deletion.taskId,
        task: deletion.task,
        deletedTask: deletion.task,
        tasks: deletion.tasks,
        graph: deletion.graph
      });
    }
    if (action === "execute_next_task" || action === "execute_next") {
      const suppliedResult = body.worker_result || body.workerResult || null;
      if (!suppliedResult || typeof suppliedResult !== "object" || Array.isArray(suppliedResult)) {
        return response(
          {
            error: {
              message: "execute_next_task requires worker_result; placeholder task execution is disabled.",
              type: "invalid_request_error",
              code: "worker_result_required"
            }
          },
          400
        );
      }
      const result = await taskRuntime.executeNextTask(goalId, async () => suppliedResult, {
        source: "api",
        context: body.context || {}
      });
      const generatedMemories = result.task
        ? memoryRuntime.captureTaskMemory({
            goalId,
            task: result.task,
            workerResult: result.result || suppliedResult || {},
            source: "api"
          })
        : [];
      observabilityRuntime.recordEvent(
        "execute_next_task",
        {
          goal_id: goalId,
          task: result.task,
          result,
          memories: generatedMemories
        },
        { source: "api", goalId, taskId: result.task && result.task.id, severity: result.ok ? "info" : "warn" }
      );
      return response({ goal_id: goalId, ...result, memories: generatedMemories });
    }
    return response(
      {
        error: {
          message: `Unknown Agent Route task action: ${action || "(empty)"}`,
          type: "invalid_request_error",
          code: "unknown_agent_route_action"
        }
      },
      400
    );
  } catch (err) {
    return taskActionErrorResponse(err, requestOrOrigin);
  }
}

module.exports = {
  handleAgentRouteAction,
  normalizeAgentRouteAction,
  summarizeTaskBudgets
};
