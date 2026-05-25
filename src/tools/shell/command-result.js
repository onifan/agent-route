"use strict";

function normalizeCommandResult(raw = {}) {
  const exitCode = raw.exitCode == null ? raw.code : raw.exitCode;
  const code = exitCode == null ? raw.code : exitCode;
  return {
    ok: Boolean(raw.ok) || (Number(code) === 0 && !raw.timedOut && !raw.error),
    action: raw.action || "shell_command",
    command: String(raw.command || ""),
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    cwd: String(raw.cwd || ""),
    stdout: String(raw.stdout || ""),
    stderr: String(raw.stderr || ""),
    exitCode: Number.isFinite(Number(code)) ? Number(code) : null,
    code: Number.isFinite(Number(code)) ? Number(code) : null,
    signal: raw.signal || null,
    timedOut: Boolean(raw.timedOut),
    durationMs: Math.max(0, Number(raw.durationMs || 0)),
    outputSize: Buffer.byteLength(`${raw.stdout || ""}${raw.stderr || ""}`),
    error: raw.error ? String(raw.error) : "",
    blocked: Boolean(raw.blocked),
    riskLevel: raw.riskLevel || "",
    reasons: Array.isArray(raw.reasons) ? raw.reasons.map(String) : [],
    requiredApproval: Boolean(raw.requiredApproval),
    actionSummary: raw.actionSummary || ""
  };
}

module.exports = {
  normalizeCommandResult
};
