"use strict";

const path = require("path");
const filesTool = require("../../tools/files");
const protocol = require("./protocol");

const LOCAL_READ_TYPES = new Set([
  "local_read",
  "file_read",
  "files_read",
  "filesystem_read",
  "directory_read",
  "project_read",
  "repo_read",
  "repository_read"
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".csv",
  ".env.example",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".sql",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);

const IMPORTANT_BASENAMES = new Set([
  "readme.md",
  "package.json",
  "next.config.mjs",
  "next.config.js",
  "jsconfig.json",
  "tsconfig.json",
  "postcss.config.mjs",
  "tailwind.config.js",
  "docs/api.md",
  "docs/architecture.md",
  "docs/configuration.md",
  "docs/development.md",
  "docs/security.md"
]);

function compactText(value = "", max = 2000) {
  const text = String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, Math.max(1, max - 3))}...` : text;
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item != null);
  if (value == null || value === "") return [];
  return [value];
}

function taskText(task = {}) {
  return [
    task.path,
    task.filePath,
    task.file_path,
    task.directory,
    task.dir,
    task.input,
    task.prompt,
    task.description,
    task.title
  ]
    .filter(Boolean)
    .join("\n");
}

function configuredNumber(config = {}, names = [], defaultValue, min, max) {
  const filesConfig = (config.tools && config.tools.files) || {};
  for (const name of names) {
    const value = filesConfig[name] ?? config[name];
    const number = Number(value);
    if (Number.isFinite(number)) return Math.max(min, Math.min(Math.floor(number), max));
  }
  return defaultValue;
}

function normalizeCandidatePath(value = "") {
  return String(value || "")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’。；;，,]+$/g, "")
    .replace(/\s+(?:项目|目录|文件|仓库|里面|里的|下的).+$/i, "")
    .replace(/(?:写|生成|输出|创建|保存|导出|制作|渲染|并写|然后写|然后生成).+$/i, "")
    .trim();
}

function candidatePathsFromText(value = "") {
  const text = String(value || "");
  const candidates = [];
  const push = (candidate) => {
    const normalized = normalizeCandidatePath(candidate);
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };
  for (const line of text.split(/\n+/)) {
    const trimmed = normalizeCandidatePath(line);
    if (/^(?:~|\.{1,2}|\/)/.test(trimmed)) push(trimmed);
  }
  const pathMatches = text.match(/(?:~|\.{1,2}|\/)[^\n"'“”‘’<>|{}]+(?:\/|\\)?[^\n"'“”‘’<>|{}]*/g) || [];
  for (const match of pathMatches) push(match);
  return candidates;
}

function resolveExistingPathFromCandidates(candidates = [], cwd = process.cwd()) {
  for (const candidate of candidates) {
    const raw = normalizeCandidatePath(candidate);
    const expanded = raw.replace(/^~(?=\/|$)/, require("os").homedir());
    const variants = [expanded];
    if (!path.isAbsolute(expanded)) variants.push(path.resolve(cwd, expanded));
    for (const variant of variants) {
      const info = filesTool.pathInfo(variant);
      if (info.exists) return { path: variant, info };
      const segments = variant.split(path.sep);
      for (let end = segments.length - 1; end > 1; end -= 1) {
        const prefix = segments.slice(0, end).join(path.sep) || path.sep;
        const prefixInfo = filesTool.pathInfo(prefix);
        if (prefixInfo.exists) return { path: prefix, info: prefixInfo };
      }
    }
  }
  const candidatePath = candidates[0] ? normalizeCandidatePath(candidates[0]) : "";
  return candidatePath ? { path: candidatePath, info: filesTool.pathInfo(candidatePath) } : null;
}

function readTargetForTask(task = {}, config = {}) {
  const direct = task.path || task.filePath || task.file_path || task.directory || task.dir || "";
  const candidates = candidatePathsFromText(direct || taskText(task));
  return resolveExistingPathFromCandidates(candidates, config.cwd || config.workspace || process.cwd());
}

function shouldUseLocalReadWorker(task = {}) {
  const type = String(task.type || task.taskType || task.task_type || "").toLowerCase();
  const toolWorker = String(task.toolWorker || task.tool_worker || "").toLowerCase();
  if (LOCAL_READ_TYPES.has(type) || ["files", "file", "local_read", "filesystem"].includes(toolWorker)) return true;
  return false;
}

function isTextCandidate(file = {}) {
  const ext = String(file.extension || path.extname(file.path || "") || "").toLowerCase();
  const base = path.basename(file.path || "").toLowerCase();
  if (TEXT_EXTENSIONS.has(ext) || IMPORTANT_BASENAMES.has(base)) return true;
  if (/^(dockerfile|makefile|license|notice|readme)$/i.test(base)) return true;
  return !ext && Number(file.size || 0) <= 50000;
}

function filePriority(file = {}) {
  const relative = String(file.relativePath || file.path || "").replace(/\\/g, "/");
  const lower = relative.toLowerCase();
  const base = path.basename(lower);
  let score = 0;
  if (IMPORTANT_BASENAMES.has(lower) || IMPORTANT_BASENAMES.has(base)) score += 1000;
  if (/^(app|src|docs|scripts)\//.test(lower)) score += 80;
  if (/src\/agent\/(orchestrator|mcp|verification|tasks)\//.test(lower)) score += 160;
  if (/src\/tools\/(files|shell|web|documents|browser)\//.test(lower)) score += 120;
  if (/app\/api\/agent-route|app\/agent-route/.test(lower)) score += 120;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(lower)) score -= 40;
  if (/package-lock\.json$/.test(lower)) score -= 200;
  if (Number(file.size || 0) > 120000) score -= 120;
  return score;
}

function selectedFilesForRead(files = [], config = {}) {
  const maxReadFiles = configuredNumber(config, ["maxReadFiles", "localReadMaxFiles"], 36, 1, 200);
  return files
    .filter(isTextCandidate)
    .sort(
      (left, right) => filePriority(right) - filePriority(left) || left.relativePath.localeCompare(right.relativePath)
    )
    .slice(0, maxReadFiles);
}

function fileEvidence(file = {}, role = "read") {
  return {
    path: file.path || "",
    exists: file.exists !== false,
    size: Number.isFinite(Number(file.size)) ? Number(file.size) : -1,
    beforeSize: -1,
    afterSize: Number.isFinite(Number(file.size)) ? Number(file.size) : -1,
    role,
    expectedContent: "",
    expectedContentRequired: false
  };
}

function workerContent({ status, output, error = "", nextStep = "", actions = [], files = [], claims = [] }) {
  return JSON.stringify({
    kind: protocol.KIND.WORKER_RESULT,
    schemaVersion: protocol.PROTOCOL_VERSION,
    status,
    actions,
    output,
    error,
    nextStep,
    artifacts: [],
    evidence: {
      summary: status === "success" ? "Local filesystem read evidence was collected." : "Local filesystem read failed.",
      claims,
      actions: actions.map((action) => ({
        type: "file",
        action,
        description: action
      })),
      browser: {
        beforeUrl: "",
        afterUrl: "",
        domChanged: false,
        successMessage: "",
        errorMessage: "",
        screenshot: "",
        snapshot: ""
      },
      shell: {
        command: "",
        exitCode: 0,
        stderr: "",
        stdout: "",
        outputDirs: []
      },
      files,
      apiResponses: [],
      semantic: {
        outputSummary: compactText(output || error, 1800),
        addressesCriteria: status === "success",
        criteriaCoverage: status === "success" ? 1 : 0,
        qualityScore: status === "success" ? 0.9 : 0,
        qualityIssues: status === "success" ? [] : ["local_read_failed"]
      }
    },
    memoryCandidates: [],
    riskLevel: "low",
    riskReasons: []
  });
}

function failureResult(task, error, startedAt, targetPath = "") {
  return {
    task,
    ok: false,
    model: "files-tool",
    content: workerContent({
      status: "failure",
      output: "",
      error,
      nextStep: targetPath ? "Provide an existing readable local file or directory path." : "Provide a local path.",
      actions: ["files:local_read_failed"],
      files: targetPath ? [fileEvidence({ path: targetPath, exists: false, size: -1 }, "read")] : []
    }),
    error,
    elapsedMs: Date.now() - startedAt,
    actions: ["files:local_read_failed"]
  };
}

function readSelectedFiles(selected = [], config = {}) {
  const maxFileBytes = configuredNumber(config, ["maxReadFileBytes", "localReadMaxFileBytes"], 80000, 1024, 1000000);
  const maxTotalBytes = configuredNumber(
    config,
    ["maxReadTotalBytes", "localReadMaxTotalBytes"],
    500000,
    4096,
    4000000
  );
  const reads = [];
  let totalBytes = 0;
  for (const file of selected) {
    if (totalBytes >= maxTotalBytes) break;
    const allowedBytes = Math.max(1, Math.min(maxFileBytes, maxTotalBytes - totalBytes));
    const read = filesTool.readTextFile(file.path, { maxBytes: allowedBytes });
    if (!read.ok) {
      reads.push({
        path: file.path,
        relativePath: file.relativePath || path.basename(file.path),
        ok: false,
        size: file.size,
        error: read.error || "Read failed.",
        content: ""
      });
      continue;
    }
    const content = String(read.content || "");
    totalBytes += Buffer.byteLength(content, "utf8");
    reads.push({
      path: file.path,
      relativePath: file.relativePath || path.basename(file.path),
      ok: true,
      size: read.size,
      content
    });
  }
  return reads;
}

function outputForDirectory(targetPath, listing, fileSearch, reads) {
  const inventory = (fileSearch.files || []).map((file) => ({
    path: file.relativePath,
    size: file.size
  }));
  const fileBodies = reads.map((read) => ({
    path: read.relativePath || read.path,
    size: read.size,
    ok: read.ok,
    error: read.error || "",
    content: read.ok ? read.content : ""
  }));
  return [
    `Local directory: ${targetPath}`,
    `Top-level entries: ${(listing.entries || []).map((entry) => entry.name).join(", ")}`,
    `Discovered files: ${fileSearch.count || inventory.length}${fileSearch.truncated ? " (truncated)" : ""}`,
    "File inventory:",
    JSON.stringify(inventory.slice(0, 400), null, 2),
    "Read file contents:",
    JSON.stringify(fileBodies, null, 2)
  ].join("\n");
}

async function runLocalReadWorker(task = {}, config = {}) {
  const startedAt = Date.now();
  const target = readTargetForTask(task, config);
  if (!target || !target.path) return failureResult(task, "Local read task did not include a local path.", startedAt);
  if (!target.info || !target.info.exists) {
    return failureResult(task, target.info?.error || "Local path does not exist.", startedAt, target.path);
  }
  const actions = [`files:path_info:${target.path}`];
  const evidenceFiles = [fileEvidence({ path: target.path, exists: true, size: target.info.size }, "read")];

  if (target.info.isFile) {
    const maxFileBytes = configuredNumber(config, ["maxReadFileBytes", "localReadMaxFileBytes"], 80000, 1024, 1000000);
    const read = filesTool.readTextFile(target.path, { maxBytes: maxFileBytes });
    actions.push(`files:read_text_file:${target.path}`);
    if (!read.ok) return failureResult(task, read.error || "Local file read failed.", startedAt, target.path);
    const output = [`Local file: ${target.path}`, `Size: ${read.size}`, "Content:", String(read.content || "")].join(
      "\n"
    );
    evidenceFiles[0] = fileEvidence({ path: target.path, exists: true, size: read.size }, "read");
    return {
      task,
      ok: true,
      model: "files-tool",
      content: workerContent({
        status: "success",
        output,
        actions,
        files: evidenceFiles,
        claims: [`Read local file ${target.path}.`]
      }),
      evidence: { files: evidenceFiles },
      error: "",
      elapsedMs: Date.now() - startedAt,
      actions
    };
  }

  if (!target.info.isDirectory) {
    return failureResult(task, "Local path is neither a file nor a directory.", startedAt, target.path);
  }

  const maxInventoryFiles = configuredNumber(
    config,
    ["maxInventoryFiles", "localReadMaxInventoryFiles"],
    600,
    10,
    5000
  );
  const maxDepth = configuredNumber(config, ["maxReadDepth", "localReadMaxDepth"], 8, 1, 30);
  const listing = filesTool.listDirectory(target.path, { maxEntries: 500 });
  actions.push(`files:list_directory:${target.path}`);
  if (!listing.ok)
    return failureResult(task, listing.error || "Local directory listing failed.", startedAt, target.path);
  const fileSearch = filesTool.findFiles(target.path, { maxFiles: maxInventoryFiles, maxDepth });
  actions.push(`files:find_files:${target.path}`);
  if (!fileSearch.ok)
    return failureResult(task, fileSearch.error || "Local file inventory failed.", startedAt, target.path);
  const selected = selectedFilesForRead(fileSearch.files || [], config);
  const reads = readSelectedFiles(selected, config);
  for (const read of reads) {
    actions.push(`files:read_text_file:${read.path}`);
    evidenceFiles.push(fileEvidence({ path: read.path, exists: read.ok, size: read.size }, "read"));
  }
  const output = outputForDirectory(target.path, listing, fileSearch, reads);
  return {
    task,
    ok: true,
    model: "files-tool",
    content: workerContent({
      status: "success",
      output,
      actions,
      files: evidenceFiles,
      claims: [
        `Inspected local directory ${target.path}.`,
        `Discovered ${fileSearch.count || 0} files and read ${reads.filter((item) => item.ok).length} text files.`
      ]
    }),
    evidence: { files: evidenceFiles },
    error: "",
    elapsedMs: Date.now() - startedAt,
    actions
  };
}

module.exports = {
  LOCAL_READ_TYPES,
  readTargetForTask,
  runLocalReadWorker,
  shouldUseLocalReadWorker
};
