"use strict";

const { agentRoutePath } = require("../../shared/utils/agent-home");
const { memoryRepository } = require("../../storage/repositories");

const MEMORY_TYPE = Object.freeze({
  WORKING: "working",
  EPISODIC: "episodic",
  KNOWLEDGE: "knowledge",
  PROCEDURE: "procedure"
});

const MEMORY_STATUS = Object.freeze({
  ACTIVE: "active",
  STALE: "stale",
  DISABLED: "disabled",
  DELETED: "deleted"
});

const memories = new Map();
let storeLoaded = false;
let storageFile = process.env.AGENT_ROUTE_MEMORY || agentRoutePath("agent-route-memory.json");

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "task",
  "goal",
  "agent",
  "model",
  "pool",
  "result",
  "output",
  "user",
  "should",
  "would",
  "could",
  "一个",
  "这个",
  "那个",
  "任务",
  "目标",
  "模型",
  "用户",
  "结果",
  "执行"
]);

function nowIso() {
  return new Date().toISOString();
}

function uid(prefix = "mem") {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function memoryError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function collapseText(value) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value, max = 800) {
  const text = collapseText(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function sensitivePatterns() {
  return [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    /\b(ghp|github_pat|glpat|xox[baprs]|sk|rk|pk_live|pk_test)_[A-Za-z0-9_=-]{12,}/gi,
    /\b(sk|rk)-[A-Za-z0-9_-]{16,}/gi,
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|token|password|passwd|pwd|cookie|secret)\b\s*[:=]\s*['"]?[^'"\s]{8,}/gi
  ];
}

function containsSensitive(value) {
  const text = String(value == null ? "" : value);
  return sensitivePatterns().some((pattern) => pattern.test(text));
}

function redactSensitive(value) {
  let text = String(value == null ? "" : value);
  for (const pattern of sensitivePatterns()) {
    text = text.replace(pattern, (match) => {
      const key = match.match(/^[A-Za-z_-]+(?=\s*[:=])/)?.[0];
      return key ? `${key}: [REDACTED_SECRET]` : "[REDACTED_SECRET]";
    });
  }
  return text;
}

function lowValueText(value) {
  const text = collapseText(value);
  if (text.length < 18) return true;
  if (/^(click|move|scroll|mousemove|hover|typed?)\b/i.test(text)) return true;
  const htmlTags = (text.match(/<\/?[a-z][^>]*>/gi) || []).length;
  if (htmlTags > 12) return true;
  if (text.length > 1800 && /(stack trace|webpack|node_modules|html|doctype|console\.log)/i.test(text)) return true;
  return false;
}

function normalizeType(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  return Object.values(MEMORY_TYPE).includes(raw) ? raw : MEMORY_TYPE.EPISODIC;
}

function normalizeStatus(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  return Object.values(MEMORY_STATUS).includes(raw) ? raw : MEMORY_STATUS.ACTIVE;
}

function normalizeImportance(value, fallback = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(Math.round(number), 5));
}

function normalizeList(value) {
  if (Array.isArray(value))
    return value
      .filter(Boolean)
      .map((item) => String(item).trim())
      .filter(Boolean);
  if (!value) return [];
  return String(value)
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueList(values, limit = 40) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function extractKeywords(...values) {
  const text = values.map((value) => collapseText(value).toLowerCase()).join(" ");
  const parts = text.split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean);
  const keywords = [];
  for (const part of parts) {
    if (part.length < 2 || STOP_WORDS.has(part)) continue;
    if (!keywords.includes(part)) keywords.push(part);
    if (keywords.length >= 30) break;
  }
  return keywords;
}

function normalizeSourceRef(raw = {}) {
  return {
    goalId: String(raw.goalId || raw.goal_id || ""),
    taskId: String(raw.taskId || raw.task_id || ""),
    event: String(raw.event || raw.sourceEvent || raw.source_event || "")
  };
}

function uniqueSourceRefs(refs, limit = 20) {
  const seen = new Set();
  const out = [];
  for (const ref of refs || []) {
    const normalized = normalizeSourceRef(ref);
    if (!normalized.goalId && !normalized.taskId && !normalized.event) continue;
    const key = `${normalized.goalId}|${normalized.taskId}|${normalized.event}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function storagePath() {
  return storageFile;
}

function setStorageFile(file) {
  storageFile = file ? String(file) : "";
  memories.clear();
  storeLoaded = false;
}

function serializeMemory(memory) {
  return clone(memory);
}

function normalizeMemory(raw = {}) {
  const at = raw.createdAt || raw.created_at || nowIso();
  const summary = truncate(redactSensitive(raw.summary || raw.content || raw.text || raw.title || ""), 900);
  const title = truncate(redactSensitive(raw.title || summary || "Memory"), 120);
  const sourceSummary = truncate(redactSensitive(raw.sourceSummary || raw.source_summary || raw.source || ""), 260);
  const type = normalizeType(raw.type || raw.memoryType || raw.memory_type);
  const sourceRef = normalizeSourceRef({
    goalId: raw.goalId || raw.goal_id || (raw.sourceRef && raw.sourceRef.goalId),
    taskId: raw.taskId || raw.task_id || (raw.sourceRef && raw.sourceRef.taskId),
    event: raw.event || raw.sourceEvent || raw.source_event || (raw.sourceRef && raw.sourceRef.event)
  });
  const sourceRefs = uniqueSourceRefs([
    sourceRef,
    ...(Array.isArray(raw.sourceRefs || raw.source_refs) ? raw.sourceRefs || raw.source_refs : [])
  ]);
  const relatedGoalIds = uniqueList([
    raw.goalId || raw.goal_id || "",
    ...normalizeList(raw.relatedGoalIds || raw.related_goal_ids)
  ]);
  const relatedTaskIds = uniqueList([
    raw.taskId || raw.task_id || "",
    ...normalizeList(raw.relatedTaskIds || raw.related_task_ids)
  ]);
  const keywords = normalizeList(raw.keywords || raw.tags).length
    ? normalizeList(raw.keywords || raw.tags)
    : extractKeywords(title, summary, sourceSummary, raw.goalId, raw.taskId);
  return {
    id: String(raw.id || uid("mem")),
    goalId: String(raw.goalId || raw.goal_id || ""),
    taskId: String(raw.taskId || raw.task_id || ""),
    source: String(raw.source || raw.sourceWorker || raw.source_worker || "system"),
    type,
    status: normalizeStatus(raw.status),
    importance: normalizeImportance(
      raw.importance,
      type === MEMORY_TYPE.KNOWLEDGE || type === MEMORY_TYPE.PROCEDURE ? 3 : 2
    ),
    title,
    summary,
    tags: normalizeList(raw.tags),
    keywords,
    createdAt: at,
    updatedAt: raw.updatedAt || raw.updated_at || at,
    lastSeenAt: raw.lastSeenAt || raw.last_seen_at || raw.updatedAt || raw.updated_at || at,
    seenCount: Math.max(1, Number(raw.seenCount || raw.seen_count || 1)),
    expiresAt: raw.expiresAt || raw.expires_at || "",
    staleReason: String(raw.staleReason || raw.stale_reason || ""),
    sourceSummary,
    sourceRef,
    sourceRefs,
    relatedGoalIds,
    relatedTaskIds
  };
}

function loadStore() {
  if (storeLoaded) return;
  storeLoaded = true;
  if (!storageFile) return;
  try {
    const list = memoryRepository.listMemories({}, { file: storageFile });
    memories.clear();
    for (const rawMemory of list) {
      const memory = normalizeMemory(rawMemory);
      memories.set(memory.id, memory);
    }
  } catch (err) {
    console.warn("[agent-route-memory-runtime] failed to load store:", err.message);
  }
}

function saveStore() {
  if (!storageFile) return;
  try {
    memoryRepository.saveMemories([...memories.values()].map(serializeMemory), {
      file: storageFile,
      updatedAt: nowIso()
    });
  } catch (err) {
    console.warn("[agent-route-memory-runtime] failed to save store:", err.message);
  }
}

function reloadRuntime() {
  memories.clear();
  storeLoaded = false;
  loadStore();
}

function publicMemory(memory) {
  return clone(memory);
}

function isExpired(memory, at = Date.now()) {
  if (!memory.expiresAt) return false;
  const time = Date.parse(memory.expiresAt);
  return Number.isFinite(time) && time <= at;
}

function shouldSaveMemory(raw) {
  const text = [raw.title, raw.summary, raw.content, raw.sourceSummary].filter(Boolean).join(" ");
  if (containsSensitive(text)) return false;
  if (lowValueText(text)) return false;
  return true;
}

function memoryTokens(memory) {
  return new Set(extractKeywords(memory.title, memory.summary, memory.sourceSummary, (memory.tags || []).join(" ")));
}

function normalizedComparableText(value) {
  return collapseText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function overlapRatio(left, right) {
  const leftSet = left instanceof Set ? left : new Set(left || []);
  const rightSet = right instanceof Set ? right : new Set(right || []);
  if (!leftSet.size || !rightSet.size) return 0;
  let overlap = 0;
  for (const item of leftSet) {
    if (rightSet.has(item)) overlap += 1;
  }
  return overlap / Math.min(leftSet.size, rightSet.size);
}

function canMergeMemories(existing, incoming) {
  if (!existing || !incoming) return false;
  if (existing.status === MEMORY_STATUS.DELETED || incoming.status === MEMORY_STATUS.DELETED) return false;
  if (existing.type !== incoming.type) return false;
  if (existing.goalId && incoming.goalId && existing.goalId !== incoming.goalId) return false;
  if (existing.taskId && incoming.taskId && existing.taskId !== incoming.taskId) return false;
  if (
    existing.sourceRef &&
    incoming.sourceRef &&
    existing.sourceRef.event &&
    incoming.sourceRef.event &&
    existing.sourceRef.event === incoming.sourceRef.event &&
    existing.sourceRef.taskId &&
    incoming.sourceRef.taskId &&
    existing.sourceRef.taskId === incoming.sourceRef.taskId
  ) {
    return true;
  }
  const existingTitle = normalizedComparableText(existing.title);
  const incomingTitle = normalizedComparableText(incoming.title);
  const existingSummary = normalizedComparableText(existing.summary);
  const incomingSummary = normalizedComparableText(incoming.summary);
  if (
    existingTitle &&
    existingTitle === incomingTitle &&
    overlapRatio(memoryTokens(existing), memoryTokens(incoming)) >= 0.45
  )
    return true;
  if (existingSummary && incomingSummary && existingSummary === incomingSummary) return true;
  return overlapRatio(memoryTokens(existing), memoryTokens(incoming)) >= 0.72;
}

function findMergeTarget(incoming) {
  for (const existing of memories.values()) {
    if (canMergeMemories(existing, incoming)) return existing;
  }
  return null;
}

function appendInsight(existingSummary, incomingSummary) {
  const existing = collapseText(existingSummary);
  const incoming = collapseText(incomingSummary);
  if (!incoming || existing.includes(incoming)) return truncate(existing, 900);
  if (!existing) return truncate(incoming, 900);
  if (incoming.includes(existing)) return truncate(incoming, 900);
  return truncate(`${existing} Updated insight: ${incoming}`, 900);
}

function mergeMemory(existing, incoming) {
  const timestamp = nowIso();
  const merged = {
    ...existing,
    importance: Math.max(existing.importance || 1, incoming.importance || 1),
    title: incoming.importance > existing.importance ? incoming.title : existing.title,
    summary: appendInsight(existing.summary, incoming.summary),
    tags: uniqueList([...(existing.tags || []), ...(incoming.tags || [])]),
    keywords: uniqueList([
      ...(existing.keywords || []),
      ...(incoming.keywords || []),
      ...extractKeywords(incoming.title, incoming.summary, incoming.sourceSummary)
    ]),
    updatedAt: timestamp,
    lastSeenAt: timestamp,
    seenCount: Math.max(1, Number(existing.seenCount || 1)) + 1,
    staleReason:
      existing.status === MEMORY_STATUS.STALE && incoming.status === MEMORY_STATUS.ACTIVE ? "" : existing.staleReason,
    status: existing.status === MEMORY_STATUS.DISABLED ? existing.status : incoming.status || existing.status,
    relatedGoalIds: uniqueList([
      ...(existing.relatedGoalIds || []),
      ...(incoming.relatedGoalIds || []),
      incoming.goalId
    ]),
    relatedTaskIds: uniqueList([
      ...(existing.relatedTaskIds || []),
      ...(incoming.relatedTaskIds || []),
      incoming.taskId
    ]),
    sourceRefs: uniqueSourceRefs([
      ...(existing.sourceRefs || []),
      existing.sourceRef,
      incoming.sourceRef,
      ...(incoming.sourceRefs || [])
    ]),
    sourceSummary: truncate([existing.sourceSummary, incoming.sourceSummary].filter(Boolean).join(" | "), 260)
  };
  memories.set(existing.id, normalizeMemory(merged));
  saveStore();
  return publicMemory(memories.get(existing.id));
}

function createMemory(raw = {}, options = {}) {
  loadStore();
  if (!options.force && !shouldSaveMemory(raw)) return null;
  const memory = normalizeMemory(raw);
  if (containsSensitive(`${memory.title} ${memory.summary} ${memory.sourceSummary}`)) return null;
  if (options.dedupe !== false) {
    const existing = findMergeTarget(memory);
    if (existing) return mergeMemory(existing, memory);
  }
  memories.set(memory.id, memory);
  saveStore();
  return publicMemory(memory);
}

function listMemories(filters = {}) {
  return searchMemories({ ...filters, query: filters.query || "" });
}

function memoryMatchesFilters(memory, filters = {}) {
  const statuses = uniqueList([...normalizeList(filters.status), ...normalizeList(filters.statuses)]).map(
    normalizeStatus
  );
  if (statuses.length) {
    if (!statuses.includes(memory.status)) return false;
  } else {
    if (memory.status === MEMORY_STATUS.DELETED) return false;
    if (!filters.includeInactive && memory.status !== MEMORY_STATUS.ACTIVE) return false;
  }
  if (!filters.includeExpired && isExpired(memory)) return false;
  if (filters.onlyGlobal && memory.goalId) return false;
  if (filters.goalId && filters.exactGoal && memory.goalId !== String(filters.goalId)) return false;
  if (filters.goalId && !filters.exactGoal && memory.goalId && memory.goalId !== String(filters.goalId)) return false;
  if (filters.taskId && memory.taskId !== String(filters.taskId)) return false;
  if (filters.type && normalizeType(filters.type) !== memory.type) return false;
  if (filters.types && Array.isArray(filters.types) && filters.types.length) {
    const allowed = new Set(filters.types.map(normalizeType));
    if (!allowed.has(memory.type)) return false;
  }
  if (filters.minImportance && memory.importance < Number(filters.minImportance)) return false;
  return true;
}

function scoreMemory(memory, query, filters = {}) {
  let score = Number(memory.importance || 1) * 2;
  const goalId = String(filters.goalId || "");
  const taskId = String(filters.taskId || "");
  if (goalId && memory.goalId === goalId) score += 5;
  if (taskId && memory.taskId === taskId) score += 8;
  if (!memory.goalId) score += 1;
  const queryKeywords = extractKeywords(query, filters.extraQuery || "");
  if (!queryKeywords.length) return score;
  const memoryKeywords = new Set(memory.keywords || []);
  const haystack = `${memory.title} ${memory.summary} ${(memory.tags || []).join(" ")}`.toLowerCase();
  let overlap = 0;
  for (const keyword of queryKeywords) {
    if (memoryKeywords.has(keyword) || haystack.includes(keyword)) overlap += 1;
  }
  if (overlap === 0) return 0;
  return score + overlap * 6;
}

function searchMemories(filters = {}) {
  loadStore();
  const query = collapseText(filters.query || "");
  const limit = Math.max(1, Math.min(Number(filters.limit || 20), 100));
  return [...memories.values()]
    .filter((memory) => memoryMatchesFilters(memory, filters))
    .map((memory) => ({ memory, score: scoreMemory(memory, query, filters) }))
    .filter((entry) => !query || entry.score > 0)
    .sort((a, b) => b.score - a.score || String(b.memory.updatedAt).localeCompare(String(a.memory.updatedAt)))
    .slice(0, limit)
    .map((entry) => publicMemory(entry.memory));
}

function getMemory(memoryId) {
  loadStore();
  const memory = memories.get(String(memoryId || ""));
  return memory && memory.status !== MEMORY_STATUS.DELETED ? publicMemory(memory) : null;
}

function updateMemory(memoryId, patch = {}) {
  loadStore();
  const id = String(memoryId || "");
  const existing = memories.get(id);
  if (!existing || existing.status === MEMORY_STATUS.DELETED) {
    throw memoryError(`Memory not found: ${id}`, "memory_not_found", { memoryId: id });
  }
  const cleanedPatch = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (value !== undefined) cleanedPatch[key] = value;
  }
  const next = normalizeMemory({
    ...existing,
    ...cleanedPatch,
    id,
    updatedAt: nowIso()
  });
  if (containsSensitive(`${next.title} ${next.summary} ${next.sourceSummary}`)) {
    throw memoryError("Memory contains sensitive material and cannot be saved", "sensitive_memory_rejected", {
      memoryId: id
    });
  }
  memories.set(id, next);
  saveStore();
  return publicMemory(next);
}

function disableMemory(memoryId, reason = "disabled", status = MEMORY_STATUS.DISABLED) {
  return updateMemory(memoryId, {
    status,
    staleReason: reason
  });
}

function deleteMemory(memoryId) {
  return disableMemory(memoryId, "deleted", MEMORY_STATUS.DELETED);
}

function markImportant(memoryId, important = true) {
  const existing = getMemory(memoryId);
  if (!existing) throw memoryError(`Memory not found: ${memoryId}`, "memory_not_found", { memoryId });
  return updateMemory(memoryId, {
    importance: important ? Math.max(existing.importance || 1, 4) : Math.min(existing.importance || 3, 2)
  });
}

function taskText(task = {}) {
  return [
    task.title,
    task.description,
    task.type,
    task.modelPool,
    task.prompt,
    Array.isArray(task.successCriteria) ? task.successCriteria.join(" ") : "",
    task.routingReason
  ]
    .filter(Boolean)
    .join(" ");
}

function captureTaskMemory({ goalId, task = {}, workerResult = {}, source = "worker" } = {}) {
  const created = [];
  const status = String(task.status || workerResult.status || "");
  const normalizedResult = {
    status: String(workerResult.status || ""),
    output: workerResult.output || workerResult.result || workerResult.content || task.result || "",
    error: workerResult.error || task.error || "",
    nextStep: workerResult.nextStep || workerResult.next_step || "",
    actions: Array.isArray(workerResult.actions) ? workerResult.actions : [],
    artifacts: Array.isArray(workerResult.artifacts) ? workerResult.artifacts : [],
    blockedReason: workerResult.blockedReason || task.blockedReason || ""
  };

  const latestVerification =
    Array.isArray(task.verificationHistory) && task.verificationHistory.length
      ? task.verificationHistory[task.verificationHistory.length - 1]
      : null;
  const latestBudget =
    Array.isArray(task.budgetHistory) && task.budgetHistory.length
      ? task.budgetHistory[task.budgetHistory.length - 1]
      : null;
  const candidates = [
    ...(workerResult.memoryCandidates || workerResult.memory_candidates || []),
    ...(latestVerification && Array.isArray(latestVerification.generatedMemoryCandidates)
      ? latestVerification.generatedMemoryCandidates
      : [])
  ];
  created.push(
    ...createMemoriesFromCandidates(candidates, {
      goalId,
      taskId: task.id,
      source,
      sourceSummary: truncate(taskText(task), 260)
    })
  );

  let raw = null;
  if (status === "completed") {
    raw = {
      goalId,
      taskId: task.id,
      source,
      type: MEMORY_TYPE.EPISODIC,
      importance: task.riskLevel === "critical" || task.riskLevel === "high" || task.difficulty === "high" ? 4 : 3,
      title: `Successful task: ${task.title || task.id}`,
      summary: [
        `Task "${task.title || task.id}" completed successfully.`,
        task.verificationStatus
          ? `Verification: ${task.verificationStatus} (${Math.round(Number(task.verificationConfidence || 0) * 100)}%).`
          : "",
        Array.isArray(task.verificationReasons) && task.verificationReasons.length
          ? `Verified by: ${task.verificationReasons.slice(0, 3).join("; ")}.`
          : "",
        normalizedResult.actions.length ? `Useful actions: ${normalizedResult.actions.slice(0, 5).join(", ")}.` : "",
        normalizedResult.nextStep ? `Next step insight: ${normalizedResult.nextStep}.` : "",
        normalizedResult.output ? `Reusable result summary: ${truncate(normalizedResult.output, 360)}` : ""
      ]
        .filter(Boolean)
        .join(" "),
      tags: ["task-success", task.type || "", task.modelPool || ""],
      sourceSummary: truncate(taskText(task), 260),
      event: "task_completed"
    };
  } else if (status === "failed") {
    raw = {
      goalId,
      taskId: task.id,
      source,
      type: MEMORY_TYPE.EPISODIC,
      importance: 4,
      title: `Failed task: ${task.title || task.id}`,
      summary: [
        `Task "${task.title || task.id}" failed.`,
        task.verificationStatus
          ? `Verification: ${task.verificationStatus} (${Math.round(Number(task.verificationConfidence || 0) * 100)}%).`
          : "",
        Array.isArray(task.detectedIssues) && task.detectedIssues.length
          ? `Verification issues: ${truncate(task.detectedIssues.map((item) => item.issue || item).join("; "), 360)}`
          : "",
        normalizedResult.error ? `Reusable failure reason: ${truncate(normalizedResult.error, 360)}` : "",
        normalizedResult.nextStep
          ? `Avoidance or recovery: ${normalizedResult.nextStep}`
          : "Avoid repeating this path without changing model, input, or external conditions."
      ]
        .filter(Boolean)
        .join(" "),
      tags: [
        "task-failure",
        task.verificationStatus ? `verification-${task.verificationStatus}` : "",
        task.type || "",
        task.modelPool || ""
      ],
      sourceSummary: truncate(taskText(task), 260),
      event: "task_failed"
    };
  } else if (status === "retry_ready") {
    raw = {
      goalId,
      taskId: task.id,
      source,
      type: MEMORY_TYPE.EPISODIC,
      importance: 3,
      title: `Retry lesson: ${task.title || task.id}`,
      summary: [
        `Task "${task.title || task.id}" needed retry.`,
        task.verificationStatus
          ? `Verification: ${task.verificationStatus} (${Math.round(Number(task.verificationConfidence || 0) * 100)}%).`
          : "",
        Array.isArray(task.detectedIssues) && task.detectedIssues.length
          ? `Verification issues: ${truncate(task.detectedIssues.map((item) => item.issue || item).join("; "), 420)}`
          : "",
        latestBudget && latestBudget.warnings && latestBudget.warnings.length
          ? `Budget warnings: ${truncate(latestBudget.warnings.join("; "), 360)}`
          : "",
        `Reason: ${truncate(normalizedResult.error || normalizedResult.nextStep || "worker requested retry", 420)}`
      ]
        .filter(Boolean)
        .join(" "),
      tags: [
        "task-retry",
        task.verificationStatus ? `verification-${task.verificationStatus}` : "",
        task.type || "",
        task.modelPool || ""
      ],
      sourceSummary: truncate(taskText(task), 260),
      event: "task_retry"
    };
  } else if (status === "blocked") {
    raw = {
      goalId,
      taskId: task.id,
      source,
      type: MEMORY_TYPE.WORKING,
      importance: 4,
      title: `Blocked task: ${task.title || task.id}`,
      summary: [
        `Task is blocked. Risk or external reason: ${truncate(normalizedResult.blockedReason || task.blockedReason || normalizedResult.error || "unknown blocker", 420)}`,
        task.verificationStatus ? `Verification: ${task.verificationStatus}.` : "",
        Array.isArray(task.detectedIssues) && task.detectedIssues.length
          ? `Verification issues: ${truncate(task.detectedIssues.map((item) => item.issue || item).join("; "), 360)}`
          : "",
        latestBudget && latestBudget.blockedReason
          ? `Budget blocked: ${truncate(latestBudget.blockedReason, 360)}`
          : "",
        latestBudget && latestBudget.warnings && latestBudget.warnings.length
          ? `Budget warnings: ${truncate(latestBudget.warnings.join("; "), 360)}`
          : "",
        Array.isArray(task.riskReasons) && task.riskReasons.length
          ? `Risk signals: ${truncate(task.riskReasons.join("; "), 360)}`
          : ""
      ]
        .filter(Boolean)
        .join(" "),
      tags: ["task-blocked", task.riskLevel ? `risk-${task.riskLevel}` : "", task.type || "", task.modelPool || ""],
      sourceSummary: truncate(taskText(task), 260),
      event: "task_blocked"
    };
  } else if (status === "waiting_human") {
    raw = {
      goalId,
      taskId: task.id,
      source,
      type: MEMORY_TYPE.WORKING,
      importance: task.riskLevel === "critical" ? 5 : 4,
      title: `Risk approval needed: ${task.title || task.id}`,
      summary: [
        `Task is waiting for human approval because risk engine classified it as ${task.riskLevel || "high"} risk.`,
        task.approvalReason ? `Approval reason: ${truncate(task.approvalReason, 360)}` : "",
        Array.isArray(task.riskReasons) && task.riskReasons.length
          ? `Risk signals: ${truncate(task.riskReasons.join("; "), 420)}`
          : "",
        task.escalationReason ? `Escalation: ${truncate(task.escalationReason, 260)}` : ""
      ]
        .filter(Boolean)
        .join(" "),
      tags: ["risk-approval", task.riskLevel ? `risk-${task.riskLevel}` : "", task.type || "", task.modelPool || ""],
      sourceSummary: truncate(taskText(task), 260),
      event: "task_waiting_human"
    };
  } else if (status === "awaiting_confirmation") {
    raw = {
      goalId,
      taskId: task.id,
      source,
      type: MEMORY_TYPE.WORKING,
      importance: 3,
      title: `Human confirmation needed: ${task.title || task.id}`,
      summary: `Task is waiting for human confirmation. Reason: ${truncate(task.approvalReason || normalizedResult.output || normalizedResult.nextStep || "worker requested human confirmation", 420)}`,
      tags: [
        "human-confirmation",
        task.riskLevel ? `risk-${task.riskLevel}` : "",
        task.type || "",
        task.modelPool || ""
      ],
      sourceSummary: truncate(taskText(task), 260),
      event: "task_awaiting_confirmation"
    };
  }
  if (raw) {
    const memory = createMemory(raw);
    if (memory) created.push(memory);
  }
  if (
    latestBudget &&
    (latestBudget.blockedReason || (latestBudget.degradationLevel && latestBudget.degradationLevel !== "none"))
  ) {
    const memory = createMemory({
      goalId,
      taskId: task.id,
      source: "budget-governor",
      type: MEMORY_TYPE.PROCEDURE,
      importance: latestBudget.blockedReason ? 4 : 3,
      title: `Budget lesson: ${task.title || task.id}`,
      summary: [
        `Budget governor reported ${latestBudget.status || "budget pressure"} for task "${task.title || task.id}".`,
        latestBudget.blockedReason ? `Blocked reason: ${truncate(latestBudget.blockedReason, 360)}` : "",
        latestBudget.warnings && latestBudget.warnings.length
          ? `Warnings: ${truncate(latestBudget.warnings.join("; "), 420)}`
          : "",
        "Use memory to avoid repeating expensive retries, browser loops, or unnecessary verification."
      ]
        .filter(Boolean)
        .join(" "),
      tags: ["budget", latestBudget.status || "", task.type || "", task.modelPool || ""],
      sourceSummary: truncate(taskText(task), 260),
      event: "task_budget"
    });
    if (memory) created.push(memory);
  }
  return created;
}

function createMemoriesFromCandidates(candidates, defaults = {}) {
  if (!Array.isArray(candidates)) return [];
  const created = [];
  for (const candidate of candidates.slice(0, 5)) {
    if (!candidate || typeof candidate !== "object") continue;
    const memory = createMemory({
      ...defaults,
      ...candidate,
      type: candidate.type || defaults.type || MEMORY_TYPE.EPISODIC,
      source: candidate.source || defaults.source || "worker",
      sourceSummary: candidate.sourceSummary || candidate.source_summary || defaults.sourceSummary || ""
    });
    if (memory) created.push(memory);
  }
  return created;
}

function captureExplicitUserMemories(messages = [], context = {}) {
  const lastUser = [...messages].reverse().find((message) => message && message.role === "user");
  const text = collapseText(lastUser && lastUser.content);
  if (!text) return [];
  if (!/(请记住|记住|以后|偏好|我希望|我不希望|不要|限制|常用|remember|always|never|prefer)/i.test(text)) return [];
  const memory = createMemory({
    goalId: context.goalId || "",
    source: "user",
    type: MEMORY_TYPE.KNOWLEDGE,
    importance: 4,
    title: "User preference or constraint",
    summary: truncate(text, 520),
    tags: ["user-preference"],
    sourceSummary: "Explicit user instruction",
    event: "user_explicit_memory"
  });
  return memory ? [memory] : [];
}

function captureReviewMemory({ goalId, review = {}, source = "commander" } = {}) {
  const summary = collapseText(
    review.progressSummary || review.progress_summary || review.finalAnswer || review.final_answer || ""
  );
  if (!summary || !/(有效|无效|失败|成功|策略|流程|avoid|works|worked|failed|retry|strategy|process)/i.test(summary))
    return [];
  const type = /(流程|步骤|process|workflow)/i.test(summary) ? MEMORY_TYPE.PROCEDURE : MEMORY_TYPE.EPISODIC;
  const memory = createMemory({
    goalId,
    source,
    type,
    importance: review.status === "done" ? 4 : 3,
    title: review.status === "done" ? "Goal completion lesson" : "Commander review lesson",
    summary: truncate(summary, 650),
    tags: ["commander-review"],
    sourceSummary: "Commander review",
    event: "commander_review"
  });
  return memory ? [memory] : [];
}

function relevantMemoriesForPrompt({ goalId, task = null, query = "", types = [], limit = 6, maxChars = 1600 } = {}) {
  const taskQuery = task ? taskText(task) : "";
  const memoriesForPrompt = searchMemories({
    goalId,
    taskId: task && task.id,
    query: [query, taskQuery].filter(Boolean).join(" "),
    types,
    limit
  });
  return {
    memories: memoriesForPrompt,
    text: formatMemoriesForPrompt(memoriesForPrompt, maxChars)
  };
}

function formatMemoriesForPrompt(memoryList = [], maxChars = 1600) {
  const lines = [];
  let used = 0;
  for (const memory of memoryList) {
    if (!memory || memory.status !== MEMORY_STATUS.ACTIVE) continue;
    const seen = memory.seenCount > 1 ? `, seen ${memory.seenCount}x` : "";
    const line = `- [${memory.type}; importance ${memory.importance}${seen}] ${memory.summary} (source: ${memory.source || "system"}${memory.taskId ? `, task ${memory.taskId}` : ""})`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  if (!lines.length) return "";
  return [
    "Relevant long-term memory:",
    ...lines,
    "Use these memories as guidance only. Do not reveal sensitive data, and ignore stale or unreliable memories."
  ].join("\n");
}

function resetRuntime() {
  loadStore();
  memories.clear();
  saveStore();
}

module.exports = {
  MEMORY_STATUS,
  MEMORY_TYPE,
  captureExplicitUserMemories,
  captureReviewMemory,
  captureTaskMemory,
  containsSensitive,
  createMemoriesFromCandidates,
  createMemory,
  deleteMemory,
  disableMemory,
  formatMemoriesForPrompt,
  getMemory,
  listMemories,
  markImportant,
  publicMemory,
  redactSensitive,
  reloadRuntime,
  relevantMemoriesForPrompt,
  resetRuntime,
  searchMemories,
  setStorageFile,
  storagePath,
  updateMemory
};
