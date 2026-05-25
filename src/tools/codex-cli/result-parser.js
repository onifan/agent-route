"use strict";

function compactText(value, maxLength = 1000) {
  const text = String(value || "").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function salientCodexError(raw = {}) {
  const text = compactText([raw.stderr, raw.stdout, raw.content].filter(Boolean).join("\n"), 4000);
  const patterns = [
    /You've hit your usage limit[^\n]*/i,
    /usage limit[^\n]*/i,
    /purchase more credits[^\n]*/i,
    /failed to connect[^\n]*/i,
    /tls handshake[^\n]*/i,
    /Reconnecting\.\.\. \d+\/\d+/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return compactText(match[0], 360);
  }
  return "";
}

function summarizeCodexFailure(raw = {}) {
  const code = raw.code == null ? raw.exitCode : raw.code;
  const timedOut = Boolean(raw.timedOut);
  const seconds = Math.max(0, Math.round(Number(raw.durationMs || 0) / 1000));
  if (raw.error) return compactText(raw.error, 900);
  if (raw.blocked) {
    const reasons = Array.isArray(raw.reasons) ? raw.reasons.join("; ") : "";
    return compactText(reasons || raw.content || "Codex CLI execution was blocked by the risk gate.", 900);
  }
  const salient = salientCodexError(raw);
  if (timedOut) {
    return salient
      ? `Codex CLI timed out after ${seconds || "the configured timeout"} seconds; latest error: ${salient}`
      : `Codex CLI execution timed out after ${seconds || "the configured timeout"} seconds.`;
  }
  if (Number.isFinite(Number(code)) && Number(code) !== 0) {
    const stderr = salient || compactText(raw.stderr || raw.stdout || "", 360);
    return `Codex CLI exited with code ${code}${stderr ? `: ${stderr}` : "."}`;
  }
  if (raw.signal) return `Codex CLI stopped with signal ${raw.signal}.`;
  return "";
}

function normalizeCodexCliResult(raw = {}) {
  const code = raw.code == null ? raw.exitCode : raw.code;
  const timedOut = Boolean(raw.timedOut);
  const stdout = String(raw.stdout || "");
  const stderr = String(raw.stderr || "");
  const failed =
    timedOut || raw.error || raw.blocked || raw.signal || (Number.isFinite(Number(code)) && Number(code) !== 0);
  const content = String(raw.content || (!failed ? [stdout.trim(), stderr.trim()].filter(Boolean)[0] : "") || "");
  const error = summarizeCodexFailure(raw);
  return {
    ok: Boolean(raw.ok) || (Number(code) === 0 && !timedOut && !raw.error),
    action: "codex_cli_exec",
    content:
      content ||
      (timedOut
        ? "Codex CLI timed out before finishing."
        : Number.isFinite(Number(code))
          ? `Codex CLI exited with code ${code}.`
          : ""),
    stdout,
    stderr,
    code: Number.isFinite(Number(code)) ? Number(code) : null,
    exitCode: Number.isFinite(Number(code)) ? Number(code) : null,
    signal: raw.signal || null,
    timedOut,
    durationMs: Math.max(0, Number(raw.durationMs || 0)),
    outputPath: raw.outputPath || "",
    cwd: raw.cwd || "",
    error,
    blocked: Boolean(raw.blocked),
    riskLevel: raw.riskLevel || "",
    reasons: Array.isArray(raw.reasons) ? raw.reasons.map(String) : [],
    requiredApproval: Boolean(raw.requiredApproval),
    actionSummary: raw.actionSummary || ""
  };
}

module.exports = {
  normalizeCodexCliResult,
  summarizeCodexFailure
};
