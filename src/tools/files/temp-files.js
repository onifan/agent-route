"use strict";

const fs = require("fs");
const path = require("path");
const { agentRoutePath } = require("../../shared/utils/agent-home");
const { gateToolAction } = require("../../security/tool-risk-gate");

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function defaultTempRoot() {
  return ensureDirectory(process.env.AGENT_ROUTE_TMP || agentRoutePath("tmp"));
}

function randomSuffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function tempFilePath({ prefix = "agent-route", suffix = ".tmp", dir = defaultTempRoot() } = {}) {
  ensureDirectory(dir);
  return path.join(dir, `${prefix}-${randomSuffix()}${suffix || ""}`);
}

function createTempDir({ prefix = "agent-route", dir = defaultTempRoot() } = {}) {
  ensureDirectory(dir);
  return fs.mkdtempSync(path.join(dir, `${prefix}-`));
}

function removePath(targetPath) {
  const gate = gateToolAction({
    tool: "files",
    action: "remove_path",
    path: targetPath,
    actionSummary: `Remove path ${targetPath}`
  });
  if (!gate.allowed) {
    return {
      ok: false,
      action: "remove_path",
      path: targetPath,
      error: gate.error || "File action blocked by risk gate.",
      blocked: true,
      riskLevel: gate.riskLevel,
      reasons: gate.reasons || [],
      requiredApproval: gate.requiredApproval === true,
      actionSummary: gate.actionSummary || "remove_path"
    };
  }
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return { ok: true, action: "remove_path", path: targetPath, error: "" };
  } catch (err) {
    return {
      ok: false,
      action: "remove_path",
      path: targetPath,
      error: err && err.message ? err.message : String(err)
    };
  }
}

module.exports = {
  createTempDir,
  defaultTempRoot,
  ensureDirectory,
  removePath,
  tempFilePath
};
