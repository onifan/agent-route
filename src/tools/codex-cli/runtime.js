"use strict";

const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { gateToolAction } = require("../../security/tool-risk-gate");
const filesTool = require("../files");
const { normalizeCodexCliResult } = require("./result-parser");
const { createCodexOutputPath } = require("./temp-workspace");

const SAFE_CODEX_SANDBOXES = new Set(["workspace-write", "read-only"]);
const DEFAULT_CODEX_SANDBOX = "workspace-write";

function codexPathEnv() {
  return [path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH || ""]
    .filter(Boolean)
    .join(":");
}

function sandboxSetting(config = {}, options = {}) {
  return String(
    options.sandboxMode ||
      options.sandbox ||
      config.sandboxMode ||
      config.sandbox ||
      config.codexSandbox ||
      process.env.AGENT_ROUTE_CODEX_SANDBOX ||
      DEFAULT_CODEX_SANDBOX
  ).trim();
}

function resolveCodexSandboxMode(config = {}, options = {}) {
  const sandboxMode = sandboxSetting(config, options) || DEFAULT_CODEX_SANDBOX;
  if (SAFE_CODEX_SANDBOXES.has(sandboxMode)) {
    return { ok: true, sandboxMode };
  }
  return {
    ok: false,
    sandboxMode: DEFAULT_CODEX_SANDBOX,
    error: `Codex CLI sandbox '${sandboxMode}' is not allowed. Use workspace-write or read-only.`
  };
}

function buildCodexExecArgs({ cwd, outputPath, sandboxMode = DEFAULT_CODEX_SANDBOX } = {}) {
  return [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    sandboxMode,
    "--cd",
    cwd,
    "--output-last-message",
    outputPath,
    "-"
  ];
}

function runCodexCli(prompt, config = {}, options = {}) {
  const startedAt = Date.now();
  const timeoutMs = Number(config.codexCliTimeoutMs || config.timeoutMs || 180000);
  const cwd = config.cwd || process.env.AGENT_ROUTE_CODEX_CWD || process.cwd();
  const outputPath = config.outputPath || createCodexOutputPath();
  const gate = gateToolAction({
    tool: "codex-cli",
    prompt: options.riskGateInput || config.riskGateInput || prompt,
    actionSummary: options.actionSummary || config.actionSummary || "codex-cli execution",
    approvalStatus: options.approvalStatus || config.approvalStatus,
    approved: options.approved || config.approved
  });
  if (gate.blocked) {
    return Promise.resolve(
      normalizeCodexCliResult({
        ...gate,
        ok: false,
        content: gate.error,
        outputPath,
        cwd,
        durationMs: Date.now() - startedAt
      })
    );
  }
  const sandbox = resolveCodexSandboxMode(config, options);
  if (!sandbox.ok) {
    return Promise.resolve(
      normalizeCodexCliResult({
        ok: false,
        blocked: true,
        riskLevel: "critical",
        requiredApproval: true,
        reasons: [sandbox.error],
        content: sandbox.error,
        outputPath,
        cwd,
        durationMs: Date.now() - startedAt
      })
    );
  }
  const args = buildCodexExecArgs({
    cwd,
    outputPath,
    sandboxMode: sandbox.sandboxMode
  });

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(config.bin || "codex", args, {
        cwd,
        env: {
          ...process.env,
          PATH: codexPathEnv(),
          ...(config.env || {})
        },
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (err) {
      resolve(
        normalizeCodexCliResult({
          ok: false,
          content: `Codex CLI failed to start: ${err.message}`,
          outputPath,
          cwd,
          durationMs: Date.now() - startedAt,
          error: err && err.message ? err.message : String(err)
        })
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!settled) {
        try {
          child.kill("SIGTERM");
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {}
          }, 3000).unref();
        } catch {}
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (typeof options.onLog === "function") options.onLog({ stream: "stdout", text });
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (typeof options.onLog === "function") options.onLog({ stream: "stderr", text });
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      filesTool.removePath(outputPath);
      resolve(
        normalizeCodexCliResult({
          ok: false,
          content: `Codex CLI failed to start: ${err.message}`,
          stdout,
          stderr,
          outputPath,
          cwd,
          durationMs: Date.now() - startedAt,
          error: err && err.message ? err.message : String(err)
        })
      );
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const read = filesTool.readTextFile(outputPath, { maxBytes: 800000 });
      filesTool.removePath(outputPath);
      const content = read.ok ? read.content.trim() : "";
      const failed = code !== 0 || timedOut || signal === "SIGTERM" || signal === "SIGKILL";
      const fallback = content || (!failed ? stdout.trim() : "") || "";
      resolve(
        normalizeCodexCliResult({
          ok: code === 0 && !timedOut,
          content: fallback,
          stdout,
          stderr,
          code,
          exitCode: code,
          signal,
          timedOut: timedOut || signal === "SIGTERM" || signal === "SIGKILL",
          outputPath,
          cwd,
          durationMs: Date.now() - startedAt
        })
      );
    });
    child.stdin.end(String(prompt || ""));
  });
}

module.exports = {
  buildCodexExecArgs,
  resolveCodexSandboxMode,
  runCodexCli
};
