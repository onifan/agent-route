"use strict";

const taskRuntime = require("../tasks");
const memoryRuntime = require("../memory");
const dependencyEngine = require("../graph");
const strategyEngine = require("../strategies");

function makeTaskId(base, existing) {
  const root =
    String(base || "task")
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "task";
  if (!existing.has(root)) {
    existing.add(root);
    return root;
  }
  for (let index = 2; index < 100; index += 1) {
    const id = `${root}-${index}`;
    if (!existing.has(id)) {
      existing.add(id);
      return id;
    }
  }
  const id = `${root}-${Date.now()}`;
  existing.add(id);
  return id;
}

function pruneDanglingDependencyTasks(tasks = [], existingTasks = []) {
  const existingIds = new Set((existingTasks || []).map((task) => String(task && task.id)).filter(Boolean));
  let kept = (tasks || []).slice();
  const pruned = [];
  for (;;) {
    const validIds = new Set([...existingIds, ...kept.map((task) => String(task && task.id)).filter(Boolean)]);
    const next = [];
    let changed = false;
    for (const task of kept) {
      const dependencies = dependencyEngine.normalizeDependencyIds(task);
      const missing = dependencies.filter((id) => !validIds.has(String(id)));
      if (missing.length) {
        changed = true;
        pruned.push({
          task,
          missingDependencies: missing
        });
      } else {
        next.push(task);
      }
    }
    kept = next;
    if (!changed) break;
  }
  return {
    tasks: kept,
    pruned
  };
}

function artifactIds(value = []) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[\s,]+/);
  const ids = [];
  const seen = new Set();
  for (const item of raw || []) {
    const id =
      typeof item === "string"
        ? item
        : item && typeof item === "object"
          ? item.id || item.type || item.path || item.name || ""
          : "";
    const text = String(id || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    ids.push(text);
  }
  return ids;
}

function taskEvidenceCategories(task = {}) {
  return artifactIds(task.produces || task.outputs || [])
    .map((item) => (typeof item === "string" ? item : item && (item.id || item.type || item.path)))
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((item) => item !== "web_evidence");
}

function isVerifiedTerminalTask(task = {}) {
  return (
    task.status === taskRuntime.TASK_STATUS.COMPLETED &&
    ["verified", "partially_verified"].includes(String(task.verificationStatus || ""))
  );
}

function filterRedundantVerifiedTasks(tasks = [], existingTasks = []) {
  const completedCategories = new Set(
    (existingTasks || []).filter(isVerifiedTerminalTask).flatMap(taskEvidenceCategories).filter(Boolean)
  );
  const categoryCovered = (category) => {
    if (completedCategories.has(category)) return true;
    return false;
  };
  const kept = [];
  const pruned = [];
  for (const task of tasks || []) {
    const categories = taskEvidenceCategories(task);
    const type = String(task.type || task.taskType || "").toLowerCase();
    const evidenceTask = /^(web_search|web_read|api_read|web_fetch|http_fetch)$/.test(type);
    if (categories.length && evidenceTask && categories.every(categoryCovered)) {
      pruned.push({ task, category: categories.join("+") });
      continue;
    }
    kept.push(task);
  }
  return { tasks: kept, pruned };
}

function pruneOrphanApprovalTasks(tasks = []) {
  const dependencyIds = new Set();
  for (const task of tasks || []) {
    for (const id of dependencyEngine.normalizeDependencyIds(task)) dependencyIds.add(String(id));
  }
  const kept = [];
  const pruned = [];
  for (const task of tasks || []) {
    const type = String(task.type || task.taskType || "").toLowerCase();
    if (type === "human_approval" && !dependencyIds.has(String(task.id || ""))) {
      pruned.push({ task });
      continue;
    }
    kept.push(task);
  }
  return { tasks: kept, pruned };
}

function taskText(task = {}) {
  return [task.type, task.title, task.description, task.prompt, task.input, task.routingReason, task.strategicRationale]
    .map((item) => (typeof item === "string" ? item : JSON.stringify(item || "")))
    .join("\n");
}

function hasPublicHttpUrl(value = "") {
  return /\bhttps?:\/\/[^\s"'<>()[\]{}]+/i.test(String(value || ""));
}

function isWebToolType(type = "") {
  return /^(web_search|web_read|web_fetch|api_read|http_fetch|public_web_read|public_api_read)$/i.test(
    String(type || "")
  );
}

function webToolTypeFamily(type = "") {
  const normalized = String(type || "").toLowerCase();
  if (/^(api_read|http_fetch|public_api_read)$/.test(normalized)) return "api_read";
  if (/^(web_read|web_fetch|public_web_read)$/.test(normalized)) return "web_read";
  if (normalized === "web_search") return "web_search";
  return normalized;
}

function isReadOnlyUrlTask(task = {}) {
  const type = webToolTypeFamily(task.type || task.taskType);
  return type === "web_read" || type === "api_read";
}

function extractPublicUrls(value = "") {
  const matches = String(value || "").match(/\bhttps?:\/\/[^\s"'<>()[\]{}]+/gi) || [];
  const urls = [];
  const seen = new Set();
  for (const match of matches) {
    const clean = match.replace(/[.,;，；。]+$/g, "");
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    urls.push(clean);
  }
  return urls;
}

function canonicalTaskInput(value = "") {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[/?#&]+$/g, "")
    .toLowerCase();
}

function readSourceKey(task = {}) {
  if (!isReadOnlyUrlTask(task)) return "";
  const urls = extractPublicUrls(task.input || task.url || task.prompt || "");
  const type = webToolTypeFamily(task.type || task.taskType);
  if (urls.length) return `${type}:${canonicalTaskInput(urls[0])}`;
  const input = canonicalTaskInput(task.input || "");
  return input ? `${type}:${input}` : "";
}

function splitMultiUrlReadTasks(tasks = []) {
  const expanded = [];
  const split = [];
  for (const task of tasks || []) {
    if (!isReadOnlyUrlTask(task)) {
      expanded.push(task);
      continue;
    }
    const urls = extractPublicUrls(task.input || task.url || "");
    if (urls.length <= 1) {
      expanded.push(task);
      continue;
    }
    split.push({ task, urls });
    urls.forEach((url, index) => {
      expanded.push({
        ...task,
        id: index === 0 ? task.id : `${task.id || task.title || "task"}-${index + 1}`,
        title: index === 0 ? task.title : `${task.title || task.id || "读取公开来源"} ${index + 1}`,
        input: url
      });
    });
  }
  return { tasks: expanded, split };
}

function filterDuplicateSourceTasks(tasks = [], existingTasks = []) {
  const seen = new Map();
  for (const task of existingTasks || []) {
    const key = readSourceKey(task);
    if (key && !seen.has(key)) seen.set(key, task);
  }
  const kept = [];
  const pruned = [];
  for (const task of tasks || []) {
    const key = readSourceKey(task);
    if (key && seen.has(key)) {
      pruned.push({ task, sourceKey: key, existingTask: seen.get(key) });
      continue;
    }
    if (key) seen.set(key, task);
    kept.push(task);
  }
  return { tasks: kept, pruned };
}

function normalizeLogicalTaskTitle(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[（(]\s*\d+\s*[）)]$/g, "")
    .replace(/\s+(?:#?\d+|[一二三四五六七八九十]+)$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function producedArtifactKey(task = {}) {
  return artifactIds(task.produces || task.outputs || task.producedArtifacts || task.produced_artifacts || [])
    .map((item) => item.toLowerCase())
    .sort()
    .join(",");
}

function logicalTaskKey(task = {}, options = {}) {
  const title = normalizeLogicalTaskTitle(task.title || task.description || "");
  if (title.length < 6) return "";
  const toolWorker = String(task.toolWorker || task.tool_worker || "").toLowerCase();
  const type = isWebToolTask(task)
    ? webToolTypeFamily(webTaskTypeFor(task))
    : String(task.type || task.taskType || "general").toLowerCase();
  const sourceKey = options.ignoreSourceKey ? "" : readSourceKey(task);
  return [toolWorker || "model", type || "general", title, producedArtifactKey(task), sourceKey].join("|");
}

function filterDuplicateLogicalTasks(tasks = [], existingTasks = [], options = {}) {
  const seen = new Map();
  for (const task of existingTasks || []) {
    const key = logicalTaskKey(task, options);
    if (key && !seen.has(key)) seen.set(key, task);
  }
  const kept = [];
  const pruned = [];
  for (const task of tasks || []) {
    const key = logicalTaskKey(task, options);
    if (key && seen.has(key)) {
      pruned.push({ task, duplicateKey: key, existingTask: seen.get(key) });
      continue;
    }
    if (key) seen.set(key, task);
    kept.push(task);
  }
  return { tasks: kept, pruned };
}

function isWebToolTask(task = {}) {
  const type = String(task.type || task.taskType || "").toLowerCase();
  const toolWorker = String(task.toolWorker || task.tool_worker || "").toLowerCase();
  return toolWorker === "web" || isWebToolType(type);
}

function isLocalReadTask(task = {}) {
  const type = String(task.type || task.taskType || "").toLowerCase();
  const toolWorker = String(task.toolWorker || task.tool_worker || "").toLowerCase();
  return (
    ["files", "file", "local_read", "filesystem"].includes(toolWorker) ||
    /^(local_read|file_read|files_read|filesystem_read|directory_read|project_read|repo_read|repository_read)$/.test(
      type
    )
  );
}

function isHighRiskTask(task = {}) {
  return /^(high|critical)$/i.test(String(task.riskLevel || task.risk_level || task.risk || ""));
}

function hasSearchIntent(value = "") {
  return /查询|搜索|检索|查找|获取|采集|研究|research|search|find|lookup/i.test(String(value || ""));
}

function webTaskTypeFor(task = {}) {
  const type = String(task.type || task.taskType || "").toLowerCase();
  const text = taskText(task);
  if (type === "public_web_read") return "web_read";
  if (type === "public_api_read" || type === "http_fetch") return "api_read";
  if ((type === "web_read" || type === "web_fetch" || type === "api_read") && !hasPublicHttpUrl(text)) {
    return hasSearchIntent(text) ? "web_search" : type;
  }
  if (isWebToolType(type)) return type === "web_fetch" ? "web_read" : type;
  return hasPublicHttpUrl(text) && /\bapi\b|公开\s*api|接口/i.test(text) ? "api_read" : "web_search";
}

function isDocumentGenerationType(type = "") {
  return /^(document|document_generate|document_render|doc_generate|file_generate|artifact_generate|markdown|md|html_document|docx|pdf|txt)$/i.test(
    String(type || "")
  );
}

function hasDocumentFileOutputIntent(value = "") {
  const text = String(value || "").toLowerCase();
  if (hasFileWriteProhibition(text) && !hasScopedArtifactWriteAllowance(text)) return false;
  const hasOutputVerb = /生成|创建|输出|保存|导出|写成|制作|渲染|create|generate|write|save|export|render|produce/.test(
    text
  );
  const hasDocumentTarget =
    /文档|报告文件|文档文件|产物/.test(text) ||
    /\b(?:artifact|document|pdf|docx|word|markdown|html|txt|text)\b/.test(text);
  return hasOutputVerb && hasDocumentTarget;
}

function hasScopedArtifactWriteAllowance(value = "") {
  const text = String(value || "").toLowerCase();
  const scopedDirectory =
    /\b(?:artifacts?|output|tmp|temp|temporary)\b/i.test(text) ||
    /(?:产物|输出|临时|允许的|项目允许的)[^。.;\n]{0,60}(?:目录|路径|文件夹)/i.test(text) ||
    /(?:目录|路径|文件夹)[^。.;\n]{0,60}(?:产物|输出|临时|artifacts?|output|tmp)/i.test(text);
  if (!scopedDirectory) return false;
  const allowsWrite =
    /允许|可以|可在|默认|新建|写入|生成|保存|导出|创建|create|write|save|export|generate|render|produce/i.test(text);
  const protectsExistingProjectFiles =
    /(?:不要|不得|禁止|避免|不应|不能|请勿|不允许)[^。.;\n]{0,160}(?:源码|配置|readme|docs?|文档源文件|测试|已有|existing|source|config|test)/i.test(
      text
    );
  return allowsWrite || protectsExistingProjectFiles;
}

function hasFileWriteProhibition(value = "") {
  const text = String(value || "").toLowerCase();
  return (
    /(?:不要|不得|禁止|避免|不应|不能|请勿|不允许)[^。.;\n]{0,120}(?:修改|改动|写入|创建|生成|保存|导出|删除)[^。.;\n]{0,80}(?:文件|本地|目录|工作区|仓库)/i.test(
      text
    ) ||
    /(?:do not|don't|never|no|without)[^.\n;]{0,120}(?:modify|write|create|save|export|delete)[^.\n;]{0,80}(?:file|files|local|workspace|repo|repository)/i.test(
      text
    )
  );
}

function isBlockedDocumentGenerationTask(task = {}, goalText = "") {
  const type = String(task.type || task.taskType || "").toLowerCase();
  const toolWorker = String(task.toolWorker || task.tool_worker || "").toLowerCase();
  if (!isDocumentGenerationType(type) && toolWorker !== "document" && toolWorker !== "documents") return false;
  const text = [goalText, taskText(task)].filter(Boolean).join("\n");
  if (hasFileWriteProhibition(text) && !hasScopedArtifactWriteAllowance(text)) return true;
  return !hasDocumentFileOutputIntent(text);
}

function isNonExecutableSynthesisTask(task = {}) {
  const type = String(task.type || task.taskType || "").toLowerCase();
  const text = taskText(task);
  if (isDocumentGenerationType(type) || hasDocumentFileOutputIntent(text) || hasPublicHttpUrl(text)) return false;
  const finalSynthesis =
    /最终(?:报告|答案|回复|总结)|报告生成|总结生成|汇总(?:最终)?答案|final (?:answer|report|response|summary)|synthesi[sz]e final/i.test(
      text
    );
  const invalidWebSynthesis =
    isWebToolTask(task) &&
    !hasPublicHttpUrl(text) &&
    /(?:生成|撰写|输出|形成|汇总|综合|synthesi[sz]e|write|generate|produce)[^。.;\n]{0,80}(?:报告|答案|总结|结论|response|answer|report|summary)/i.test(
      text
    );
  return finalSynthesis || invalidWebSynthesis;
}

function filterNonExecutableSynthesisTasks(tasks = [], context = {}) {
  const kept = [];
  const pruned = [];
  for (const task of tasks || []) {
    if (isBlockedDocumentGenerationTask(task, context.goalText || context.goal || "")) {
      pruned.push({ task, reason: "document_generation_without_allowed_artifact_request" });
      continue;
    }
    if (isNonExecutableSynthesisTask(task)) {
      pruned.push({ task, reason: "non_executable_synthesis" });
      continue;
    }
    kept.push(task);
  }
  return { tasks: kept, pruned };
}

function normalizeAppenderTask(task = {}) {
  const normalized = { ...task };
  if (isLocalReadTask(normalized) && !isHighRiskTask(normalized)) {
    normalized.type = "local_read";
    normalized.toolWorker = "files";
    normalized.modelPool = "free";
    if (!normalized.produces && !normalized.outputs) normalized.produces = ["local_file_evidence"];
  }
  if (isWebToolTask(normalized) && !isHighRiskTask(normalized)) {
    normalized.type = webTaskTypeFor(normalized);
    normalized.toolWorker = "web";
    normalized.modelPool = "free";
    if (!normalized.produces && !normalized.outputs) normalized.produces = ["web_evidence"];
  }
  return normalized;
}

function retargetProducedArtifacts(task = {}) {
  const rawProduces = task.produces || task.outputs || task.producedArtifacts || task.produced_artifacts;
  if (!Array.isArray(rawProduces) || !rawProduces.length || !task.id) return task;
  return {
    ...task,
    produces: dependencyEngine.normalizeArtifacts(rawProduces, task.id).map((artifact) => ({
      ...artifact,
      taskId: task.id
    }))
  };
}

function createTaskAppender({
  goalId,
  allTasks,
  knownTaskIds,
  getGoalStrategy,
  goalMemoryQuery,
  plannerMemory,
  trace,
  send,
  emitStrategy,
  emitGraph,
  taskSummary
}) {
  const emitDedupedTasks = (deduped, source) => {
    if (!deduped.pruned.length) return;
    trace.push({
      label: `dedupe:${source}`,
      model: "task-appender",
      ok: true,
      pruned: deduped.pruned.map((item) => ({
        taskId: item.task.id,
        category: item.category
      }))
    });
    emitStrategy(strategyEngine.STRATEGY_EVENT.PLAN_CONSTRAINED, {
      source,
      violations: deduped.pruned.map((item) => ({
        code: "redundant_verified_evidence_task",
        severity: "low",
        message: `Skipped redundant ${item.category} evidence task because a verified task already exists.`,
        taskId: item.task.id,
        taskTitle: item.task.title
      })),
      inserted_approval_tasks: [],
      blocked_tasks: []
    });
  };
  const emitPrunedSynthesisTasks = (filtered, source) => {
    if (!filtered.pruned.length) return;
    trace.push({
      label: `synthesis-prune:${source}`,
      model: "task-appender",
      ok: filtered.tasks.length > 0,
      pruned: filtered.pruned.map((item) => ({ taskId: item.task.id, taskType: item.task.type, reason: item.reason }))
    });
    emitStrategy(strategyEngine.STRATEGY_EVENT.PLAN_CONSTRAINED, {
      source,
      violations: filtered.pruned.map((item) => ({
        code:
          item.reason === "document_generation_without_allowed_artifact_request"
            ? "document_generation_without_allowed_artifact_request"
            : "non_executable_synthesis_task",
        severity: "medium",
        message:
          item.reason === "document_generation_without_allowed_artifact_request"
            ? "Skipped document generation because the goal did not allow a real file artifact, or explicitly forbade file modification."
            : "Skipped a non-executable synthesis task; final answers are produced by review/final after evidence collection, or by document_generate when a real file artifact is requested.",
        taskId: item.task.id,
        taskTitle: item.task.title
      })),
      inserted_approval_tasks: [],
      blocked_tasks: []
    });
  };
  const emitSplitReadTasks = (split, source) => {
    if (!split.length) return;
    trace.push({
      label: `split-read:${source}`,
      model: "task-appender",
      ok: true,
      split: split.map((item) => ({
        taskId: item.task.id,
        urls: item.urls
      }))
    });
  };
  const emitDuplicateSourceTasks = (filtered, source) => {
    if (!filtered.pruned.length) return;
    trace.push({
      label: `source-dedupe:${source}`,
      model: "task-appender",
      ok: true,
      pruned: filtered.pruned.map((item) => ({
        taskId: item.task.id,
        sourceKey: item.sourceKey,
        existingTaskId: item.existingTask && item.existingTask.id
      }))
    });
    emitStrategy(strategyEngine.STRATEGY_EVENT.PLAN_CONSTRAINED, {
      source,
      violations: filtered.pruned.map((item) => ({
        code: "duplicate_source_task",
        severity: "low",
        message: "Skipped duplicate read task because the same source is already present in the execution graph.",
        taskId: item.task.id,
        taskTitle: item.task.title
      })),
      inserted_approval_tasks: [],
      blocked_tasks: []
    });
  };
  const emitDuplicateLogicalTasks = (filtered, source) => {
    if (!filtered.pruned.length) return;
    trace.push({
      label: `logical-dedupe:${source}`,
      model: "task-appender",
      ok: true,
      pruned: filtered.pruned.map((item) => ({
        taskId: item.task.id,
        duplicateKey: item.duplicateKey,
        existingTaskId: item.existingTask && item.existingTask.id
      }))
    });
    emitStrategy(strategyEngine.STRATEGY_EVENT.PLAN_CONSTRAINED, {
      source,
      violations: filtered.pruned.map((item) => ({
        code: "duplicate_logical_task",
        severity: "low",
        message: "Skipped duplicate task because the same tool/type/title/output target is already in the graph.",
        taskId: item.task.id,
        taskTitle: item.task.title
      })),
      inserted_approval_tasks: [],
      blocked_tasks: []
    });
  };
  return function appendTasks(tasks, sourceOptions = "planner") {
    const appendOptions =
      sourceOptions && typeof sourceOptions === "object"
        ? { ...sourceOptions }
        : { source: sourceOptions || "planner" };
    const source = String(appendOptions.source || "planner");
    const currentTasks = taskRuntime.listTasks(goalId);
    const existingTasks = currentTasks.length ? currentTasks : allTasks;
    const shouldSplitReadTasks =
      appendOptions.splitMultiUrlReadTasks !== false && source !== "review" && source !== "commander";
    const splitReadTasks = shouldSplitReadTasks
      ? splitMultiUrlReadTasks(tasks || [])
      : { tasks: tasks || [], split: [] };
    emitSplitReadTasks(splitReadTasks.split, source);
    const prepared = [];
    for (const rawTask of splitReadTasks.tasks || []) {
      const task = retargetProducedArtifacts({
        ...normalizeAppenderTask(rawTask),
        id: makeTaskId(rawTask.id || rawTask.title, knownTaskIds)
      });
      prepared.push(task);
    }
    const executable = filterNonExecutableSynthesisTasks(prepared, { goalText: goalMemoryQuery });
    emitPrunedSynthesisTasks(executable, source);
    const sourceDeduped = filterDuplicateSourceTasks(executable.tasks, existingTasks);
    emitDuplicateSourceTasks(sourceDeduped, source);
    const logicalDeduped = filterDuplicateLogicalTasks(sourceDeduped.tasks, existingTasks, {
      ignoreSourceKey: appendOptions.ignoreLogicalSourceKey === true || source === "review" || source === "commander"
    });
    emitDuplicateLogicalTasks(logicalDeduped, source);
    const initiallyDeduped = filterRedundantVerifiedTasks(logicalDeduped.tasks, existingTasks);
    emitDedupedTasks(initiallyDeduped, source);
    const goalStrategy = typeof getGoalStrategy === "function" ? getGoalStrategy() : null;
    const graphExpanded = goalStrategy
      ? dependencyEngine.expandStrategyApprovalTasks(initiallyDeduped.tasks, goalStrategy, { existingTasks })
      : { tasks: initiallyDeduped.tasks, inserted: [] };
    const constrained = goalStrategy
      ? strategyEngine.constrainPlan({ tasks: graphExpanded.tasks }, goalStrategy)
      : { tasks: initiallyDeduped.tasks, changed: false, violations: [], blockedTasks: [], revisedTasks: [] };
    const dependencySafe = pruneDanglingDependencyTasks(constrained.tasks, existingTasks);
    if (constrained.changed) {
      trace.push({
        label: `strategy:${source}`,
        model: "strategy-engine",
        ok: constrained.tasks.length > 0,
        violations: constrained.violations.slice(0, 8)
      });
      emitStrategy(strategyEngine.STRATEGY_EVENT.PLAN_CONSTRAINED, {
        source,
        violations: constrained.violations,
        inserted_approval_tasks: graphExpanded.inserted.map((task) => task.id),
        blocked_tasks: constrained.blockedTasks.map((item) => taskSummary(item.task))
      });
    }
    if (dependencySafe.pruned.length) {
      trace.push({
        label: `dependency-prune:${source}`,
        model: "dependency-engine",
        ok: dependencySafe.tasks.length > 0,
        pruned: dependencySafe.pruned.map((item) => ({
          taskId: item.task.id,
          missingDependencies: item.missingDependencies
        }))
      });
      emitStrategy(strategyEngine.STRATEGY_EVENT.PLAN_CONSTRAINED, {
        source,
        violations: dependencySafe.pruned.map((item) => ({
          code: "dangling_dependency_after_constraints",
          severity: "high",
          message: `Task depends on a task that is not available: ${item.missingDependencies.join(", ")}`,
          taskId: item.task.id,
          taskTitle: item.task.title
        })),
        inserted_approval_tasks: graphExpanded.inserted.map((task) => task.id),
        blocked_tasks: dependencySafe.pruned.map((item) => taskSummary(item.task))
      });
    }
    const deduped = filterRedundantVerifiedTasks(dependencySafe.tasks, existingTasks);
    emitDedupedTasks(deduped, source);
    const approvalSafe = pruneOrphanApprovalTasks(deduped.tasks);
    if (approvalSafe.pruned.length) {
      trace.push({
        label: `approval-prune:${source}`,
        model: "task-appender",
        ok: approvalSafe.tasks.length > 0,
        pruned: approvalSafe.pruned.map((item) => ({ taskId: item.task.id }))
      });
    }
    const registered = taskRuntime.registerGoalTasks(goalId, approvalSafe.tasks, appendOptions);
    allTasks.push(...registered);
    const graph = emitGraph(dependencyEngine.GRAPH_EVENT.UPDATED, { source });
    if (registered.length && (source === "commander" || source === "review" || source === "planner")) {
      const graphMemory = dependencyEngine.memoryCandidateForGraph(taskRuntime.listTasks(goalId), {
        goalType: strategyEngine.inferDomain(goalMemoryQuery, plannerMemory)
      });
      const graphMemories = memoryRuntime.createMemoriesFromCandidates(graphMemory ? [graphMemory] : [], {
        goalId,
        source: "dependency-engine",
        sourceSummary: "Execution graph pattern"
      });
      if (graphMemories.length) {
        send("memory", {
          goal_id: goalId,
          source: "dependency-graph",
          count: graphMemories.length,
          memories: graphMemories,
          graph_ready_count: (graph.readyTaskIds || []).length
        });
      }
    }
    return registered;
  };
}

module.exports = {
  createTaskAppender,
  filterDuplicateSourceTasks,
  filterDuplicateLogicalTasks,
  filterNonExecutableSynthesisTasks,
  filterRedundantVerifiedTasks,
  hasFileWriteProhibition,
  hasScopedArtifactWriteAllowance,
  isBlockedDocumentGenerationTask,
  isNonExecutableSynthesisTask,
  makeTaskId,
  normalizeAppenderTask,
  pruneOrphanApprovalTasks,
  pruneDanglingDependencyTasks,
  splitMultiUrlReadTasks,
  taskEvidenceCategories
};
