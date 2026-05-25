"use strict";

const fs = require("fs");
const path = require("path");
const { gateToolAction } = require("../../security/tool-risk-gate");
const { hashFile } = require("./hashing");
const tempFiles = require("./temp-files");

function blockedFileResult(action, filePath, gate, startedAt) {
  return {
    ok: false,
    action,
    path: filePath,
    exists: false,
    isFile: false,
    isDirectory: false,
    size: -1,
    content: "",
    hash: "",
    bytesWritten: 0,
    durationMs: Date.now() - startedAt,
    error: gate.error || "File action blocked by risk gate.",
    blocked: true,
    riskLevel: gate.riskLevel,
    reasons: gate.reasons || [],
    requiredApproval: gate.requiredApproval === true,
    actionSummary: gate.actionSummary || action
  };
}

function pathInfo(filePath, { includeHash = false } = {}) {
  const startedAt = Date.now();
  const gate = gateToolAction({
    tool: "files",
    action: "path_info",
    path: filePath,
    actionSummary: `Inspect file path ${filePath}`
  });
  if (!gate.allowed) return blockedFileResult("path_info", filePath, gate, startedAt);
  try {
    const stat = fs.statSync(filePath);
    const info = {
      ok: true,
      action: "path_info",
      path: filePath,
      exists: true,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      durationMs: Date.now() - startedAt,
      error: ""
    };
    if (includeHash && stat.isFile()) info.hash = hashFile(filePath).hash;
    return info;
  } catch (err) {
    return {
      ok: false,
      action: "path_info",
      path: filePath,
      exists: false,
      isFile: false,
      isDirectory: false,
      size: -1,
      durationMs: Date.now() - startedAt,
      error: err && err.message ? err.message : String(err)
    };
  }
}

function fileExists(filePath) {
  return pathInfo(filePath).exists;
}

function fileSize(filePath) {
  return pathInfo(filePath).size;
}

function readTextFile(filePath, { maxBytes = 200000, encoding = "utf8" } = {}) {
  const startedAt = Date.now();
  const gate = gateToolAction({
    tool: "files",
    action: "read_text_file",
    path: filePath,
    actionSummary: `Read file ${filePath}`
  });
  if (!gate.allowed) return blockedFileResult("read_text_file", filePath, gate, startedAt);
  const info = pathInfo(filePath);
  if (!info.exists || !info.isFile) {
    return { ...info, action: "read_text_file", content: "" };
  }
  if (info.size > maxBytes) {
    return {
      ok: false,
      action: "read_text_file",
      path: filePath,
      exists: true,
      size: info.size,
      content: "",
      durationMs: Date.now() - startedAt,
      error: `File is larger than maxBytes: ${info.size}`
    };
  }
  try {
    return {
      ok: true,
      action: "read_text_file",
      path: filePath,
      exists: true,
      size: info.size,
      content: fs.readFileSync(filePath, encoding),
      durationMs: Date.now() - startedAt,
      error: ""
    };
  } catch (err) {
    return {
      ok: false,
      action: "read_text_file",
      path: filePath,
      exists: true,
      size: info.size,
      content: "",
      durationMs: Date.now() - startedAt,
      error: err && err.message ? err.message : String(err)
    };
  }
}

function writeTextFile(filePath, content, { encoding = "utf8", createParent = true } = {}) {
  const startedAt = Date.now();
  const gate = gateToolAction({
    tool: "files",
    action: "write_text_file",
    path: filePath,
    actionSummary: `Write file ${filePath}`
  });
  if (!gate.allowed) return blockedFileResult("write_text_file", filePath, gate, startedAt);
  try {
    if (createParent) fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, String(content == null ? "" : content), encoding);
    const info = pathInfo(filePath, { includeHash: true });
    return {
      ok: true,
      action: "write_text_file",
      path: filePath,
      size: info.size,
      hash: info.hash || "",
      bytesWritten: Buffer.byteLength(String(content == null ? "" : content), encoding),
      durationMs: Date.now() - startedAt,
      error: ""
    };
  } catch (err) {
    return {
      ok: false,
      action: "write_text_file",
      path: filePath,
      size: -1,
      hash: "",
      bytesWritten: 0,
      durationMs: Date.now() - startedAt,
      error: err && err.message ? err.message : String(err)
    };
  }
}

function writeBinaryFile(filePath, content, { createParent = true } = {}) {
  const startedAt = Date.now();
  const gate = gateToolAction({
    tool: "files",
    action: "write_binary_file",
    path: filePath,
    actionSummary: `Write binary file ${filePath}`
  });
  if (!gate.allowed) return blockedFileResult("write_binary_file", filePath, gate, startedAt);
  try {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content || []);
    if (createParent) fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);
    const info = pathInfo(filePath, { includeHash: true });
    return {
      ok: true,
      action: "write_binary_file",
      path: filePath,
      size: info.size,
      hash: info.hash || "",
      bytesWritten: buffer.length,
      durationMs: Date.now() - startedAt,
      error: ""
    };
  } catch (err) {
    return {
      ok: false,
      action: "write_binary_file",
      path: filePath,
      size: -1,
      hash: "",
      bytesWritten: 0,
      durationMs: Date.now() - startedAt,
      error: err && err.message ? err.message : String(err)
    };
  }
}

module.exports = {
  ...tempFiles,
  fileExists,
  fileSize,
  pathInfo,
  readTextFile,
  writeBinaryFile,
  writeTextFile
};
