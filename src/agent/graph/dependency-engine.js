"use strict";

const GRAPH_EVENT = Object.freeze({
  CREATED: "graph_created",
  UPDATED: "graph_updated",
  INVALID: "graph_invalid",
  BLOCK_PROPAGATED: "graph_block_propagated",
  READY_CHANGED: "graph_ready_changed"
});

const READINESS_STATUS = Object.freeze({
  READY: "ready",
  WAITING: "waiting",
  BLOCKED: "blocked",
  NOT_WAITING: "not_waiting"
});

const TERMINAL_BAD_STATUSES = new Set(["failed", "blocked", "canceled"]);
const EVIDENCE_GAP_STATUSES = new Set(["needs_evidence"]);
const HUMAN_WAIT_STATUSES = new Set(["waiting_human", "awaiting_confirmation"]);
const RUNNABLE_STATUS = "waiting";
const COMPLETED_STATUS = "completed";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function list(value) {
  if (Array.isArray(value))
    return value
      .filter(Boolean)
      .map((item) => String(item).trim())
      .filter(Boolean);
  if (!value) return [];
  return [String(value).trim()].filter(Boolean);
}

function unique(values = []) {
  return [...new Set(list(values))];
}

function normalizeId(value) {
  return String(value || "").trim();
}

function slug(value) {
  return (
    normalizeId(value)
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "task"
  );
}

function normalizeDependencyIds(task = {}) {
  return unique([
    ...(Array.isArray(task.dependsOn || task.depends_on) ? task.dependsOn || task.depends_on : []),
    ...(Array.isArray(task.dependencies) ? task.dependencies : []),
    ...list(task.dependsOn || task.depends_on),
    ...list(Array.isArray(task.dependencies) ? [] : task.dependencies)
  ]);
}

function normalizeArtifactRef(ref, fallbackTaskId = "") {
  if (!ref) return null;
  if (typeof ref === "string") {
    const value = ref.trim();
    if (!value) return null;
    return { id: value, type: "", path: "", taskId: fallbackTaskId };
  }
  if (typeof ref !== "object") return null;
  const id = normalizeId(ref.id || ref.name || ref.key || ref.path || ref.url || ref.artifact || ref.target);
  if (!id) return null;
  return {
    id,
    type: normalizeId(ref.type || ref.kind),
    path: normalizeId(ref.path || ""),
    taskId: normalizeId(ref.taskId || ref.task_id || fallbackTaskId),
    verified: ref.verified == null ? undefined : Boolean(ref.verified),
    metadata: ref.metadata && typeof ref.metadata === "object" ? clone(ref.metadata) : {}
  };
}

function normalizeArtifacts(value, fallbackTaskId = "") {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeArtifactRef(item, fallbackTaskId)).filter(Boolean);
}

function normalizeTaskGraphFields(task = {}) {
  const dependencies = normalizeDependencyIds(task);
  const produces = normalizeArtifacts(task.produces || task.producedArtifacts || task.produced_artifacts, task.id);
  const consumes = normalizeArtifacts(task.consumes || task.requiredArtifacts || task.required_artifacts, "");
  const artifacts = normalizeArtifacts(task.artifacts, task.id);
  return {
    dependencies,
    dependsOn: dependencies,
    produces,
    consumes,
    artifacts,
    priority: Number.isFinite(Number(task.priority)) ? Number(task.priority) : 0,
    retryPolicy:
      task.retryPolicy && typeof task.retryPolicy === "object"
        ? clone(task.retryPolicy)
        : task.retry_policy && typeof task.retry_policy === "object"
          ? clone(task.retry_policy)
          : {}
  };
}

function verificationPassed(task = {}) {
  if (task.status !== COMPLETED_STATUS) return false;
  const status = normalizeId(task.verificationStatus || task.verification_status).toLowerCase();
  if (!status) return true;
  return Boolean(task.verified) || status === "verified" || status === "partially_verified";
}

function buildTaskMap(tasks = []) {
  const map = new Map();
  for (const task of tasks || []) {
    if (task && task.id) map.set(String(task.id), task);
  }
  return map;
}

function buildArtifactRegistry(tasks = []) {
  const artifacts = new Map();
  for (const task of tasks || []) {
    if (!task || !task.id || !verificationPassed(task)) continue;
    const refs = [
      ...normalizeArtifacts(task.produces || task.producedArtifacts || task.produced_artifacts, task.id),
      ...normalizeArtifacts(task.artifacts, task.id)
    ];
    for (const ref of refs) {
      artifacts.set(ref.id, {
        ...ref,
        taskId: task.id,
        status: "available",
        verificationStatus: task.verificationStatus || "",
        verified: verificationPassed(task)
      });
      if (ref.path) {
        artifacts.set(ref.path, {
          ...ref,
          id: ref.path,
          taskId: task.id,
          status: "available",
          verificationStatus: task.verificationStatus || "",
          verified: verificationPassed(task)
        });
      }
    }
  }
  return artifacts;
}

function artifactKey(ref = {}) {
  if (!ref) return "";
  if (typeof ref === "string") return ref;
  return ref.id || ref.path || "";
}

function taskArtifactRefs(task = {}, fieldNames = []) {
  const refs = [];
  for (const fieldName of fieldNames) {
    refs.push(...normalizeArtifacts(task[fieldName], task.id || ""));
  }
  return refs;
}

function consumedArtifactsSatisfied(task = {}, artifacts = new Map()) {
  const consumes = normalizeArtifacts(task.consumes || task.requiredArtifacts || task.required_artifacts, "");
  if (!consumes.length) return false;
  return consumes.every((ref) => artifacts.has(ref.id) || (ref.path && artifacts.has(ref.path)));
}

function dependencyProducesConsumedArtifact(dependency = {}, task = {}) {
  const produced = taskArtifactRefs(dependency, ["produces", "producedArtifacts", "produced_artifacts", "artifacts"])
    .map(artifactKey)
    .filter(Boolean);
  if (!produced.length) return false;
  const producedSet = new Set(produced);
  const consumed = normalizeArtifacts(task.consumes || task.requiredArtifacts || task.required_artifacts, "")
    .map(artifactKey)
    .filter(Boolean);
  return consumed.some((item) => producedSet.has(item));
}

function dependencySatisfiedByAlternativeEvidence(dependency = {}, task = {}, artifacts = new Map()) {
  if (!EVIDENCE_GAP_STATUSES.has(String(dependency.status || ""))) return false;
  return dependencyProducesConsumedArtifact(dependency, task) && consumedArtifactsSatisfied(task, artifacts);
}

function detectCycles(tasks = []) {
  const taskMap = buildTaskMap(tasks);
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const cycles = [];

  function visit(id) {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      const cycle = start >= 0 ? stack.slice(start).concat(id) : [id, id];
      cycles.push(cycle);
      return;
    }
    if (visited.has(id)) return;
    const task = taskMap.get(id);
    if (!task) return;
    visiting.add(id);
    stack.push(id);
    for (const dep of normalizeDependencyIds(task)) {
      if (taskMap.has(dep)) visit(dep);
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  }

  for (const task of tasks || []) visit(String(task.id || ""));
  const seen = new Set();
  return cycles.filter((cycle) => {
    const key = cycle.join(">");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dependencyDepth(taskId, taskMap, memo = new Map(), seen = new Set()) {
  if (memo.has(taskId)) return memo.get(taskId);
  if (seen.has(taskId)) return 0;
  seen.add(taskId);
  const task = taskMap.get(taskId);
  if (!task) return 0;
  const deps = normalizeDependencyIds(task).filter((dep) => taskMap.has(dep));
  const depth = deps.length
    ? 1 + Math.max(...deps.map((dep) => dependencyDepth(dep, taskMap, memo, new Set(seen))))
    : 0;
  memo.set(taskId, depth);
  return depth;
}

function graphValidation(tasks = []) {
  const taskMap = buildTaskMap(tasks);
  const cycles = detectCycles(tasks);
  const cycleTaskIds = new Set(cycles.flat());
  const unknownDependencies = [];
  for (const task of tasks || []) {
    for (const dep of normalizeDependencyIds(task)) {
      if (!taskMap.has(dep)) {
        unknownDependencies.push({
          taskId: task.id,
          dependency: dep,
          reason: "missing_dependency"
        });
      }
    }
  }
  return {
    valid: cycles.length === 0 && unknownDependencies.length === 0,
    cycles,
    cycleTaskIds: [...cycleTaskIds],
    unknownDependencies,
    invalidTaskIds: [...new Set([...cycleTaskIds, ...unknownDependencies.map((item) => item.taskId)])]
  };
}

function evaluateReadiness(task = {}, tasks = [], context = {}) {
  const taskMap = context.taskMap || buildTaskMap(tasks);
  const artifacts = context.artifacts || buildArtifactRegistry(tasks);
  const dependencies = normalizeDependencyIds(task);
  const graph = context.graphValidation || graphValidation(tasks);
  const reasons = [];
  const blockedBy = [];
  const waitingFor = [];
  const missingArtifacts = [];

  if (task.status !== RUNNABLE_STATUS) {
    return {
      ready: false,
      status: READINESS_STATUS.NOT_WAITING,
      reasons: [`Task status is ${task.status || "unknown"}, not waiting.`],
      blockedBy,
      waitingFor,
      missingArtifacts,
      dependencies,
      depth: dependencyDepth(task.id, taskMap)
    };
  }

  if (graph.cycleTaskIds.includes(task.id)) {
    reasons.push("Task is part of a dependency cycle.");
    blockedBy.push("cycle");
  }
  const missingDeps = graph.unknownDependencies.filter((item) => item.taskId === task.id);
  for (const item of missingDeps) {
    reasons.push(`Missing dependency: ${item.dependency}`);
    blockedBy.push(item.dependency);
  }

  for (const depId of dependencies) {
    const dep = taskMap.get(depId);
    if (!dep) continue;
    if (dependencySatisfiedByAlternativeEvidence(dep, task, artifacts)) {
      reasons.push(`Dependency ${depId} evidence gap is satisfied by another verified artifact.`);
      continue;
    }
    if (EVIDENCE_GAP_STATUSES.has(dep.status)) {
      reasons.push(`Dependency ${depId} needs additional evidence.`);
      waitingFor.push(depId);
      continue;
    }
    if (TERMINAL_BAD_STATUSES.has(dep.status)) {
      reasons.push(`Dependency ${depId} is ${dep.status}.`);
      blockedBy.push(depId);
      continue;
    }
    if (HUMAN_WAIT_STATUSES.has(dep.status)) {
      reasons.push(`Dependency ${depId} is waiting for human approval.`);
      waitingFor.push(depId);
      continue;
    }
    if (dep.status !== COMPLETED_STATUS) {
      reasons.push(`Dependency ${depId} is not completed.`);
      waitingFor.push(depId);
      continue;
    }
    if (!verificationPassed(dep)) {
      reasons.push(`Dependency ${depId} did not pass verification.`);
      blockedBy.push(depId);
    }
  }

  for (const ref of normalizeArtifacts(task.consumes || task.requiredArtifacts || task.required_artifacts, "")) {
    if (!artifacts.has(ref.id) && !(ref.path && artifacts.has(ref.path))) {
      reasons.push(`Required artifact is not available: ${ref.id}`);
      missingArtifacts.push(ref.id);
    }
  }

  if (
    task.blockedReason ||
    task.budgetBlockedReason ||
    task.budgetStatus === "blocked" ||
    task.budgetStatus === "exhausted"
  ) {
    reasons.push(task.blockedReason || task.budgetBlockedReason || "Task is blocked by budget or prior state.");
    blockedBy.push(task.id);
  }
  if ((task.requiresHumanApproval || task.requiresHumanConfirmation) && task.approvalStatus !== "approved") {
    reasons.push(task.approvalReason || "Task requires human approval.");
    waitingFor.push("human_approval");
  }

  const blocked = blockedBy.length > 0 || graph.cycleTaskIds.includes(task.id) || missingDeps.length > 0;
  return {
    ready: !blocked && waitingFor.length === 0 && missingArtifacts.length === 0,
    status: blocked
      ? READINESS_STATUS.BLOCKED
      : waitingFor.length || missingArtifacts.length
        ? READINESS_STATUS.WAITING
        : READINESS_STATUS.READY,
    reasons,
    blockedBy: unique(blockedBy),
    waitingFor: unique(waitingFor),
    missingArtifacts,
    dependencies,
    depth: dependencyDepth(task.id, taskMap)
  };
}

function readyTasks(tasks = [], context = {}) {
  const taskMap = buildTaskMap(tasks);
  const artifacts = buildArtifactRegistry(tasks);
  const validation = graphValidation(tasks);
  return (tasks || [])
    .map((task) => ({
      task,
      readiness: evaluateReadiness(task, tasks, {
        ...context,
        taskMap,
        artifacts,
        graphValidation: validation
      })
    }))
    .filter((item) => item.readiness.ready)
    .sort((a, b) => {
      const priorityDelta = Number(b.task.priority || 0) - Number(a.task.priority || 0);
      if (priorityDelta) return priorityDelta;
      const depthDelta = Number(a.readiness.depth || 0) - Number(b.readiness.depth || 0);
      if (depthDelta) return depthDelta;
      return Number(a.task.order || 0) - Number(b.task.order || 0);
    });
}

function nextReadyTask(tasks = [], context = {}) {
  const [next] = readyTasks(tasks, context);
  return next || null;
}

function descendants(tasks = [], taskId = "") {
  const target = normalizeId(taskId);
  const byParent = new Map();
  for (const task of tasks || []) {
    for (const dep of normalizeDependencyIds(task)) {
      if (!byParent.has(dep)) byParent.set(dep, []);
      byParent.get(dep).push(task.id);
    }
  }
  const result = [];
  const seen = new Set();
  const queue = [...(byParent.get(target) || [])];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    queue.push(...(byParent.get(id) || []));
  }
  return result;
}

function retryImpactScope(tasks = [], taskId = "") {
  return {
    taskId: normalizeId(taskId),
    retryOnly: [normalizeId(taskId)].filter(Boolean),
    affectedDownstream: descendants(tasks, taskId)
  };
}

function propagationTargets(tasks = [], sourceTaskId = "") {
  const taskMap = buildTaskMap(tasks);
  const source = taskMap.get(normalizeId(sourceTaskId));
  if (!source) return [];
  if (!TERMINAL_BAD_STATUSES.has(source.status) && source.status !== "retry_ready") return [];
  const reason =
    source.status === "retry_ready"
      ? "Dependency is awaiting retry and downstream work must wait."
      : `Dependency ${source.id} is ${source.status}.`;
  return descendants(tasks, source.id).map((id) => ({
    taskId: id,
    sourceTaskId: source.id,
    reason,
    shouldBlock: TERMINAL_BAD_STATUSES.has(source.status)
  }));
}

function buildExecutionGraph(tasks = [], context = {}) {
  const normalized = (tasks || []).map((task) => ({
    ...task,
    ...normalizeTaskGraphFields(task)
  }));
  const taskMap = buildTaskMap(normalized);
  const artifacts = buildArtifactRegistry(normalized);
  const validation = graphValidation(normalized);
  const nodes = normalized.map((task) => {
    const readiness = evaluateReadiness(task, normalized, {
      ...context,
      taskMap,
      artifacts,
      graphValidation: validation
    });
    return {
      id: task.id,
      title: task.title || "",
      status: task.status || "",
      type: task.type || "",
      priority: Number(task.priority || 0),
      dependencies: readiness.dependencies,
      produces: normalizeArtifacts(task.produces || task.producedArtifacts || task.produced_artifacts, task.id),
      consumes: normalizeArtifacts(task.consumes || task.requiredArtifacts || task.required_artifacts, ""),
      depth: readiness.depth,
      readiness
    };
  });
  const edges = [];
  for (const task of normalized) {
    for (const dep of normalizeDependencyIds(task)) {
      edges.push({ from: dep, to: task.id, type: "depends_on" });
    }
    for (const ref of normalizeArtifacts(task.consumes || task.requiredArtifacts || task.required_artifacts, "")) {
      const provider = artifacts.get(ref.id) || (ref.path ? artifacts.get(ref.path) : null);
      if (provider) edges.push({ from: provider.taskId, to: task.id, type: "artifact", artifact: ref.id });
    }
  }
  const ready = nodes.filter((node) => node.readiness.ready).map((node) => node.id);
  const groupsByDepth = new Map();
  for (const node of nodes.filter((item) => item.readiness.ready)) {
    const key = String(node.depth || 0);
    if (!groupsByDepth.has(key)) groupsByDepth.set(key, []);
    groupsByDepth.get(key).push(node.id);
  }
  return {
    valid: validation.valid,
    nodes,
    edges,
    artifacts: [...artifacts.values()],
    cycles: validation.cycles,
    unknownDependencies: validation.unknownDependencies,
    readyTaskIds: ready,
    readyTasks: ready,
    parallelGroups: [...groupsByDepth.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([depth, taskIds]) => ({
        depth: Number(depth),
        taskIds
      })),
    blockedChains: nodes
      .filter((node) => node.readiness.status === READINESS_STATUS.BLOCKED)
      .map((node) => ({
        taskId: node.id,
        blockedBy: node.readiness.blockedBy,
        reasons: node.readiness.reasons
      }))
  };
}

function needsStrategyApprovalTask() {
  return false;
}

function expandStrategyApprovalTasks(tasks = [], strategy = {}, context = {}) {
  const existing = new Set(
    [...(context.existingTasks || []).map((task) => task.id), ...(tasks || []).map((task) => task.id)].filter(Boolean)
  );
  const expanded = [];
  const inserted = [];
  for (const rawTask of tasks || []) {
    const task = { ...rawTask };
    if (needsStrategyApprovalTask(task, strategy)) {
      const approvalIdBase = `approve-${slug(task.id || task.title)}`;
      let approvalId = approvalIdBase;
      for (let index = 2; existing.has(approvalId); index += 1) {
        approvalId = `${approvalIdBase}-${index}`;
      }
      existing.add(approvalId);
      const originalDeps = normalizeDependencyIds(task);
      const approvalArtifact = `approval:${task.id || approvalId}`;
      const approvalTask = {
        id: approvalId,
        title: `Human approval for ${task.title || task.id}`,
        description: `Confirm whether to proceed with the external side-effect task: ${task.title || task.id}.`,
        type: "human_approval",
        modelPool: "commander",
        difficulty: "low",
        complexity: "low",
        riskLevel: "high",
        riskReasons: ["Strategy requires human approval before this side effect."],
        successCriteria: ["Human approval is recorded before downstream execution."],
        dependencies: originalDeps,
        dependsOn: originalDeps,
        produces: [approvalArtifact],
        consumes: [],
        status: "waiting_human",
        maxAttempts: 1,
        requiresHumanApproval: true,
        requiresHumanConfirmation: true,
        approvalStatus: "pending",
        approvalReason: "Strategy requires human approval before this task can execute.",
        strategyId: task.strategyId || strategy.id || "",
        strategicObjective: task.strategicObjective || strategy.objective || "",
        strategicPhase: task.strategicPhase || "",
        strategicRationale: "Inserted by dependency engine to enforce strategy approval boundary.",
        prompt: "Wait for explicit human approval before allowing the downstream side-effect task."
      };
      task.dependencies = [approvalId];
      task.dependsOn = [approvalId];
      task.consumes = unique([
        ...normalizeArtifacts(task.consumes || task.requiredArtifacts || task.required_artifacts, "").map(
          (item) => item.id
        ),
        approvalArtifact
      ]);
      task.strategicRationale = task.strategicRationale || "Runs only after strategy-required human approval.";
      expanded.push(approvalTask);
      inserted.push(approvalTask);
    }
    expanded.push(task);
  }
  return { tasks: expanded, inserted };
}

function memoryCandidateForGraph(tasks = [], context = {}) {
  const graph = buildExecutionGraph(tasks);
  if (!tasks.length) return null;
  return {
    type: "procedure",
    importance: 3,
    title: "Execution graph pattern",
    summary: [
      `Goal graph has ${tasks.length} tasks, ${graph.edges.length} dependency edges, and ${graph.parallelGroups.length} ready-depth groups.`,
      context.goalType ? `Goal type: ${context.goalType}` : "",
      graph.parallelGroups.length
        ? `Parallel groups: ${graph.parallelGroups.map((group) => group.taskIds.join("+")).join("; ")}`
        : ""
    ]
      .filter(Boolean)
      .join(" "),
    tags: ["execution-graph", "dependency-pattern"]
  };
}

module.exports = {
  GRAPH_EVENT,
  READINESS_STATUS,
  buildArtifactRegistry,
  buildExecutionGraph,
  descendants,
  detectCycles,
  evaluateReadiness,
  expandStrategyApprovalTasks,
  graphValidation,
  memoryCandidateForGraph,
  nextReadyTask,
  normalizeArtifactRef,
  normalizeArtifacts,
  normalizeDependencyIds,
  normalizeTaskGraphFields,
  propagationTargets,
  readyTasks,
  retryImpactScope,
  verificationPassed
};
