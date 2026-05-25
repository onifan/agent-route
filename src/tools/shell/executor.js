"use strict";

const { spawn } = require("child_process");
const { gateToolAction } = require("../../security/tool-risk-gate");
const { normalizeCommandResult } = require("./command-result");

function executeCommand(command, args = [], options = {}) {
  const startedAt = Date.now();
  const cwd = options.cwd || process.cwd();
  const timeoutMs = Number(options.timeoutMs || 120000);
  const useShell = options.shell === true;
  const commandArgs = Array.isArray(args) ? args.map(String) : [];
  const gate = gateToolAction({
    tool: "shell",
    command,
    args: commandArgs,
    actionSummary: [command, ...commandArgs].join(" "),
    approvalStatus: options.approvalStatus || options.approval_status,
    approved: options.approved || options.humanApproved || options.human_approved
  });

  if (gate.blocked) {
    return Promise.resolve(
      normalizeCommandResult({
        ...gate,
        ok: false,
        command,
        args: commandArgs,
        cwd,
        exitCode: null,
        code: null,
        durationMs: Date.now() - startedAt
      })
    );
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(String(command), commandArgs, {
        cwd,
        env: { ...process.env, ...(options.env || {}) },
        shell: useShell,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (err) {
      resolve(
        normalizeCommandResult({
          ok: false,
          command,
          args: commandArgs,
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
      resolve(
        normalizeCommandResult({
          ok: false,
          command,
          args: commandArgs,
          cwd,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          error: err && err.message ? err.message : String(err)
        })
      );
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(
        normalizeCommandResult({
          ok: code === 0 && !timedOut,
          command,
          args: commandArgs,
          cwd,
          stdout,
          stderr,
          code,
          exitCode: code,
          signal,
          timedOut,
          durationMs: Date.now() - startedAt,
          error: timedOut ? "Command timed out." : ""
        })
      );
    });
  });
}

module.exports = {
  executeCommand
};
