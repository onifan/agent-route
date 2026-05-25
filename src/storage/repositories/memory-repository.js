"use strict";

const { agentRoutePath } = require("../../shared/utils/agent-home");
const { clone, normalizeArray, nowIso, readJsonFile, writeJsonFile } = require("./json-file-store");

function defaultMemoryStorePath() {
  return process.env.AGENT_ROUTE_MEMORY || agentRoutePath("agent-route-memory.json");
}

function loadMemoryStore(options = {}) {
  const file = options.file || defaultMemoryStorePath();
  const raw = readJsonFile(file, { version: 1, updatedAt: "", memories: [] });
  return {
    version: Number(raw.version || 1),
    updatedAt: raw.updatedAt || raw.updated_at || "",
    memories: normalizeArray(raw.memories)
  };
}

function saveMemoryStore(store = {}, options = {}) {
  const file = options.file || defaultMemoryStorePath();
  writeJsonFile(file, {
    version: Number(store.version || 1),
    updatedAt: options.updatedAt || store.updatedAt || nowIso(),
    memories: normalizeArray(store.memories)
  });
}

function listMemories(filter = {}, options = {}) {
  const goalId = String(filter.goalId || filter.goal_id || "");
  const taskId = String(filter.taskId || filter.task_id || "");
  const type = String(filter.type || "");
  const status = String(filter.status || "");
  return loadMemoryStore(options)
    .memories.filter((memory) => !goalId || memory.goalId === goalId || (memory.relatedGoalIds || []).includes(goalId))
    .filter((memory) => !taskId || memory.taskId === taskId || (memory.relatedTaskIds || []).includes(taskId))
    .filter((memory) => !type || memory.type === type)
    .filter((memory) => !status || memory.status === status)
    .map(clone);
}

function saveMemories(memories = [], options = {}) {
  saveMemoryStore({ version: 1, updatedAt: nowIso(), memories }, options);
  return normalizeArray(memories);
}

function getMemory(id, options = {}) {
  const key = String(id || "");
  return listMemories({}, options).find((memory) => String(memory.id || "") === key) || null;
}

function upsertMemory(memory = {}, options = {}) {
  const id = String(memory.id || options.id || "");
  if (!id) throw new Error("memory id is required");
  const store = loadMemoryStore(options);
  const index = store.memories.findIndex((item) => String(item.id || "") === id);
  const next = {
    ...(index >= 0 ? store.memories[index] : {}),
    ...clone(memory),
    id,
    updatedAt: memory.updatedAt || memory.updated_at || nowIso()
  };
  if (!next.createdAt) next.createdAt = nowIso();
  if (index >= 0) store.memories[index] = next;
  else store.memories.push(next);
  saveMemoryStore(store, options);
  return clone(next);
}

function deleteMemory(id, options = {}) {
  const key = String(id || "");
  const store = loadMemoryStore(options);
  const before = store.memories.length;
  store.memories = store.memories.filter((memory) => String(memory.id || "") !== key);
  saveMemoryStore(store, options);
  return { id: key, deleted: before - store.memories.length };
}

module.exports = {
  defaultMemoryStorePath,
  deleteMemory,
  getMemory,
  listMemories,
  loadMemoryStore,
  saveMemories,
  saveMemoryStore,
  upsertMemory
};
