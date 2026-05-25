"use strict";

const { clone, nowIso } = require("./json-file-store");
const { appendRecord, clearRecords, listRecords, recordStorePath } = require("./record-store");

function defaultArtifactStorePath() {
  return recordStorePath("artifacts", "AGENT_ROUTE_ARTIFACTS");
}

function normalizeArtifact(raw = {}, context = {}) {
  return {
    id: String(raw.id || raw.name || raw.path || `artifact_${Date.now()}_${Math.random().toString(16).slice(2)}`),
    goalId: String(raw.goalId || raw.goal_id || context.goalId || ""),
    taskId: String(raw.taskId || raw.task_id || context.taskId || ""),
    type: String(raw.type || raw.kind || "artifact"),
    format: String(raw.format || raw.fileType || raw.file_type || raw.extension || ""),
    mimeType: String(raw.mimeType || raw.mime_type || raw.contentType || raw.content_type || ""),
    path: String(raw.path || raw.filePath || raw.file_path || ""),
    size: Number.isFinite(Number(raw.size || raw.bytes)) ? Number(raw.size || raw.bytes) : 0,
    hash: String(raw.hash || raw.sha256 || ""),
    status: String(raw.status || "created"),
    verificationSummary: String(raw.verificationSummary || raw.verification_summary || ""),
    sensitive: Boolean(raw.sensitive || raw.isSensitive || raw.is_sensitive),
    createdAt: raw.createdAt || raw.created_at || nowIso(),
    updatedAt: raw.updatedAt || raw.updated_at || nowIso()
  };
}

function registerArtifact(artifact = {}, options = {}) {
  return appendRecord(normalizeArtifact(artifact, options), {
    file: options.file || defaultArtifactStorePath(),
    collection: "artifacts",
    maxRecords: options.maxRecords || 1000
  });
}

function registerArtifacts(artifacts = [], options = {}) {
  return (Array.isArray(artifacts) ? artifacts : []).map((artifact) => registerArtifact(artifact, options));
}

function listArtifacts(filter = {}, options = {}) {
  return listRecords(filter, {
    file: options.file || defaultArtifactStorePath(),
    collection: "artifacts",
    maxRecords: options.maxRecords || 1000
  }).map(clone);
}

function clearArtifacts(filter = {}, options = {}) {
  return clearRecords(filter, {
    file: options.file || defaultArtifactStorePath(),
    collection: "artifacts",
    maxRecords: options.maxRecords || 1000
  });
}

module.exports = {
  clearArtifacts,
  defaultArtifactStorePath,
  listArtifacts,
  normalizeArtifact,
  registerArtifact,
  registerArtifacts
};
