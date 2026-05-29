"use strict";

const fs = require("fs");
const path = require("path");
const { gateToolAction } = require("../../security/tool-risk-gate");
const { hashFile } = require("./hashing");
const tempFiles = require("./temp-files");

const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".next-cli-build",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".turbo",
  ".vercel"
]);

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

function clampPositiveInteger(value, fallback, max) {
  const number = Math.floor(Number(value || fallback));
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.min(number, max));
}

function directoryEntryInfo(parentPath, entry, includeHash = false) {
  const entryPath = path.join(parentPath, entry.name);
  const stat = fs.statSync(entryPath);
  const info = {
    name: entry.name,
    path: entryPath,
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    isSymbolicLink: entry.isSymbolicLink(),
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
  if (includeHash && stat.isFile()) info.hash = hashFile(entryPath).hash;
  return info;
}

function listDirectory(directoryPath, { maxEntries = 500, includeHash = false } = {}) {
  const startedAt = Date.now();
  const gate = gateToolAction({
    tool: "files",
    action: "list_directory",
    path: directoryPath,
    actionSummary: `List directory ${directoryPath}`
  });
  if (!gate.allowed) return blockedFileResult("list_directory", directoryPath, gate, startedAt);
  const limit = clampPositiveInteger(maxEntries, 500, 10000);
  const info = pathInfo(directoryPath);
  if (!info.exists || !info.isDirectory) {
    return { ...info, action: "list_directory", entries: [], count: 0, truncated: false };
  }
  try {
    const rawEntries = fs
      .readdirSync(directoryPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    const entries = rawEntries.slice(0, limit).map((entry) => directoryEntryInfo(directoryPath, entry, includeHash));
    return {
      ok: true,
      action: "list_directory",
      path: directoryPath,
      exists: true,
      isDirectory: true,
      entries,
      count: rawEntries.length,
      truncated: rawEntries.length > entries.length,
      durationMs: Date.now() - startedAt,
      error: ""
    };
  } catch (err) {
    return {
      ok: false,
      action: "list_directory",
      path: directoryPath,
      exists: true,
      isDirectory: true,
      entries: [],
      count: 0,
      truncated: false,
      durationMs: Date.now() - startedAt,
      error: err && err.message ? err.message : String(err)
    };
  }
}

function shouldExcludeDirectory(name, excludeDirectories) {
  const lower = String(name || "").toLowerCase();
  return excludeDirectories.has(lower) || DEFAULT_EXCLUDED_DIRECTORIES.has(lower);
}

function findFiles(rootPath, { maxFiles = 500, maxDepth = 8, excludeDirectories = [], includeHash = false } = {}) {
  const startedAt = Date.now();
  const gate = gateToolAction({
    tool: "files",
    action: "find_files",
    path: rootPath,
    actionSummary: `Find files under ${rootPath}`
  });
  if (!gate.allowed) return blockedFileResult("find_files", rootPath, gate, startedAt);
  const limit = clampPositiveInteger(maxFiles, 500, 20000);
  const depthLimit = Math.max(0, Math.min(Math.floor(Number(maxDepth || 8)), 50));
  const excluded = new Set(
    (Array.isArray(excludeDirectories) ? excludeDirectories : String(excludeDirectories || "").split(","))
      .map((item) =>
        String(item || "")
          .trim()
          .toLowerCase()
      )
      .filter(Boolean)
  );
  try {
    const rootStat = fs.statSync(rootPath);
    if (rootStat.isFile()) {
      const info = {
        path: rootPath,
        relativePath: path.basename(rootPath),
        size: rootStat.size,
        mtimeMs: rootStat.mtimeMs,
        extension: path.extname(rootPath)
      };
      if (includeHash) info.hash = hashFile(rootPath).hash;
      return {
        ok: true,
        action: "find_files",
        path: rootPath,
        root: path.dirname(rootPath),
        files: [info],
        count: 1,
        truncated: false,
        durationMs: Date.now() - startedAt,
        error: ""
      };
    }
    if (!rootStat.isDirectory()) {
      return {
        ok: false,
        action: "find_files",
        path: rootPath,
        root: rootPath,
        files: [],
        count: 0,
        truncated: false,
        durationMs: Date.now() - startedAt,
        error: "Path is neither a file nor a directory."
      };
    }

    const files = [];
    let truncated = false;
    const stack = [{ dir: rootPath, depth: 0 }];
    while (stack.length && files.length < limit) {
      const { dir, depth } = stack.pop();
      let entries = [];
      try {
        entries = fs
          .readdirSync(dir, { withFileTypes: true })
          .sort((left, right) => right.name.localeCompare(left.name));
      } catch {
        continue;
      }
      for (const entry of entries) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < depthLimit && !shouldExcludeDirectory(entry.name, excluded)) {
            stack.push({ dir: entryPath, depth: depth + 1 });
          }
          continue;
        }
        if (!entry.isFile()) continue;
        const stat = fs.statSync(entryPath);
        const item = {
          path: entryPath,
          relativePath: path.relative(rootPath, entryPath),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          extension: path.extname(entryPath)
        };
        if (includeHash) item.hash = hashFile(entryPath).hash;
        files.push(item);
        if (files.length >= limit) {
          truncated = true;
          break;
        }
      }
    }
    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return {
      ok: true,
      action: "find_files",
      path: rootPath,
      root: rootPath,
      files,
      count: files.length,
      truncated,
      durationMs: Date.now() - startedAt,
      error: ""
    };
  } catch (err) {
    return {
      ok: false,
      action: "find_files",
      path: rootPath,
      root: rootPath,
      files: [],
      count: 0,
      truncated: false,
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
  findFiles,
  listDirectory,
  pathInfo,
  readTextFile,
  writeBinaryFile,
  writeTextFile
};
