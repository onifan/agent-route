"use strict";

const os = require("os");
const path = require("path");

const RISK_ORDER = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });
const SENSITIVE_HOME_DIRS = [".ssh", ".aws", ".config", ".gnupg", ".kube"];

function text(value) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
}

function removeNegatedRiskClauses(value = "") {
  return String(value == null ? "" : value)
    .replace(
      /(?:不要|不允许|禁止|不得|请勿|do not|don't|never)[^。.;\n]{0,80}(?:提交|发送|付款|支付|登录|上传|删除|发布|submit|send|pay|login|upload|delete|publish)[^。.;\n]{0,30}/gi,
      " "
    )
    .replace(
      /(?:涉及|如需|如果|when|if)[^。.;\n]{0,100}(?:提交|发送|付款|支付|登录|上传|submit|send|pay|login|upload)[^。.;\n]{0,100}(?:人工确认|human approval|human confirmation|manual approval|manual review)/gi,
      " "
    )
    .split(/[\n；;。.!！？?]+|(?=\s*[-•*]\s*)/)
    .map(text)
    .filter((part) => {
      if (!part) return false;
      return !/^(?:-|•|\*)?\s*(?:do\s+not|don't|never|no\s+|禁止|不要|不允许|不得|请勿|不能|不要自动|不自动)/i.test(
        part
      );
    })
    .join(" ");
}

function normalizeRiskLevel(value = "low") {
  const risk = text(value).toLowerCase();
  return Object.prototype.hasOwnProperty.call(RISK_ORDER, risk) ? risk : "low";
}

function maxRisk(left, right) {
  return RISK_ORDER[normalizeRiskLevel(left)] >= RISK_ORDER[normalizeRiskLevel(right)]
    ? normalizeRiskLevel(left)
    : normalizeRiskLevel(right);
}

function isApproved(input = {}) {
  const status = text(
    input.approvalStatus || input.approval_status || input.riskApproval || input.risk_approval
  ).toLowerCase();
  return (
    input.approved === true || input.humanApproved === true || input.human_approved === true || status === "approved"
  );
}

function safeDetails(details = {}) {
  const out = {};
  for (const [key, value] of Object.entries(details || {})) {
    if (/token|cookie|password|secret|authorization|key/i.test(key)) out[key] = "[REDACTED]";
    else out[key] = typeof value === "string" ? value.slice(0, 500) : value;
  }
  return out;
}

function tokenize(command = "") {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|`([^`]*)`|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(command || "")))) {
    tokens.push(match[1] || match[2] || match[3] || match[4] || "");
  }
  return tokens.filter(Boolean);
}

function shellText(input = {}) {
  const command = text(input.command);
  const args = Array.isArray(input.args) ? input.args.map(String).join(" ") : text(input.args);
  return [command, args].filter(Boolean).join(" ");
}

function homeSensitivePath(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const home = os.homedir();
  const expanded = raw.replace(/^~(?=\/|$)/, home);
  const normalized = path.normalize(expanded);
  for (const dir of SENSITIVE_HOME_DIRS) {
    const target = path.join(home, dir);
    if (normalized === target || normalized.startsWith(`${target}${path.sep}`)) return target;
  }
  return "";
}

function looksLikeDbWrite(value = "") {
  return /\b(drop\s+database|drop\s+table|truncate\s+table|delete\s+from|update\s+\w+\s+set|insert\s+into|alter\s+table|create\s+table)\b/i.test(
    value
  );
}

function pushFinding(state, riskLevel, reason, details = {}) {
  state.riskLevel = maxRisk(state.riskLevel, riskLevel);
  state.reasons.push(reason);
  state.findings.push({ riskLevel: normalizeRiskLevel(riskLevel), reason, details: safeDetails(details) });
}

function evaluateShell(input = {}) {
  const state = { riskLevel: "low", reasons: [], findings: [] };
  const command = shellText(input);
  const tokens = tokenize(command).map((item) => item.toLowerCase());
  const lower = command.toLowerCase();

  if (/\brm\s+-[^\n;|&]*r[^\n;|&]*f\b|\brm\s+-[^\n;|&]*f[^\n;|&]*r\b/.test(lower)) {
    pushFinding(state, "critical", "Shell command uses rm -rf style forced recursive deletion.", { command });
  } else if (tokens[0] === "rm") {
    pushFinding(state, "high", "Shell command deletes local files.", { command });
  }
  if (tokens.includes("sudo") || tokens[0] === "sudo") {
    pushFinding(state, "high", "Shell command uses sudo and can change privileged system state.", { command });
  }
  if (/\b(curl|wget)\b[^\n|;&]*\|\s*(?:sh|bash|zsh)\b/.test(lower)) {
    pushFinding(state, "critical", "Shell command pipes downloaded code into a shell.", { command });
  }
  if (/\b(?:npm|pnpm|yarn|bun)\s+publish\b/.test(lower)) {
    pushFinding(state, "critical", "Package publish command has external side effects.", { command });
  }
  if (/\bgit\s+push\b/.test(lower)) {
    pushFinding(state, "high", "git push publishes code or branch state externally.", { command });
  }
  if (/\bdocker\s+compose\s+down\b/.test(lower)) {
    pushFinding(state, "high", "docker compose down can stop local or shared services.", { command });
  }
  if (/\bkubectl\s+(delete|apply)\b/.test(lower)) {
    pushFinding(state, "critical", "kubectl delete/apply can mutate cluster or production resources.", { command });
  }
  if (looksLikeDbWrite(command)) {
    pushFinding(state, "critical", "Command appears to write or delete database data.", { command });
  }
  if (/\b(prod|production|live)\b.*\b(apply|deploy|delete|write|migrate|restart|down)\b/.test(lower)) {
    pushFinding(state, "critical", "Command appears to change production resources.", { command });
  }
  for (const token of tokenize(command)) {
    const sensitive = homeSensitivePath(token);
    if (sensitive) {
      pushFinding(state, "high", "Command reads or touches a sensitive local credential directory.", {
        path: sensitive
      });
    }
  }
  return state;
}

function evaluateFile(input = {}) {
  const state = { riskLevel: "low", reasons: [], findings: [] };
  const action = text(input.action || input.operation || "file");
  const filePath = text(input.path || input.filePath || input.file_path);
  const sensitive = homeSensitivePath(filePath);
  if (sensitive) {
    pushFinding(state, "high", "File operation targets a sensitive local credential directory.", {
      action,
      path: sensitive
    });
  }
  if (/write|delete|remove|unlink|rmdir/i.test(action) && /\.(sqlite|sqlite3|db|duckdb)$/i.test(filePath)) {
    pushFinding(state, "critical", "File operation may mutate or delete a database file.", { action, path: filePath });
  }
  return state;
}

function evaluateBrowser(input = {}) {
  const state = { riskLevel: "low", reasons: [], findings: [] };
  const summary = removeNegatedRiskClauses(
    [input.action, input.detectedActionType, input.selector, input.label, input.text, input.url, input.title]
      .map(text)
      .join(" ")
  ).toLowerCase();
  if (/\b(pay|payment|checkout|billing|purchase|付款|支付|购买)\b/.test(summary)) {
    pushFinding(state, "critical", "Browser action may create a payment or purchase.", { action: input.action });
  }
  if (/\b(delete|destroy|remove account|删除|销毁)\b/.test(summary)) {
    pushFinding(state, "critical", "Browser action may delete real data.", { action: input.action });
  }
  if (/\b(login|sign in|signin|password|2fa|otp|登录|验证码)\b/.test(summary)) {
    pushFinding(state, "high", "Browser action involves login or authentication.", { action: input.action });
  }
  if (/\b(submit|send|message|email|proposal|apply|publish|提交|发送|投递|申请|发布)\b/.test(summary)) {
    pushFinding(state, "high", "Browser action may submit data or send a real message.", { action: input.action });
  }
  if (/\b(upload|attach|上传|附件)\b/.test(summary)) {
    pushFinding(state, "high", "Browser action may upload local data.", { action: input.action });
  }
  return state;
}

function privateHostReason(hostname = "") {
  const host = text(hostname)
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!host) return "";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return "Web tool target is a local or private host.";
  }
  if (host === "::1" || host.startsWith("127.")) return "Web tool target is a loopback address.";
  if (host.startsWith("10.")) return "Web tool target is a private network address.";
  if (host.startsWith("192.168.")) return "Web tool target is a private network address.";
  const octets = host.split(".").map((part) => Number(part));
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part))) {
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
      return "Web tool target is a private network address.";
    }
    if (octets[0] === 169 && octets[1] === 254) {
      return "Web tool target is a link-local network address.";
    }
  }
  return "";
}

function evaluateWeb(input = {}) {
  const state = { riskLevel: "low", reasons: [], findings: [] };
  const summary = removeNegatedRiskClauses(
    [input.action, input.query, input.url, input.text, input.title, input.actionSummary].map(text).join(" ")
  ).toLowerCase();
  if (/\b(pay|payment|checkout|billing|purchase|付款|支付|购买)\b/.test(summary)) {
    pushFinding(state, "critical", "Web action may create a payment or purchase.", { action: input.action });
  }
  if (/\b(delete|destroy|remove account|删除|销毁)\b/.test(summary)) {
    pushFinding(state, "critical", "Web action may delete real data.", { action: input.action });
  }
  if (/\b(login|sign in|signin|password|2fa|otp|登录|验证码)\b/.test(summary)) {
    pushFinding(state, "high", "Web action involves login or authentication.", { action: input.action });
  }
  if (/\b(submit|send|message|email|proposal|apply|publish|post|put|patch|提交|发送|投递|申请|发布)\b/.test(summary)) {
    pushFinding(state, "high", "Web action may submit data or send a real message.", { action: input.action });
  }
  if (/\b(upload|attach|上传|附件)\b/.test(summary)) {
    pushFinding(state, "high", "Web action may upload local data.", { action: input.action });
  }
  const url = text(input.url);
  if (!url) return state;
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    pushFinding(state, "high", "Web tool target URL is invalid.", { url });
    return state;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    pushFinding(state, "high", "Web tool only supports HTTP(S) public reads.", { url: parsed.protocol });
  }
  const privateReason = privateHostReason(parsed.hostname);
  if (privateReason) pushFinding(state, "high", privateReason, { host: parsed.hostname });
  return state;
}

function evaluateCodex(input = {}) {
  const state = { riskLevel: "low", reasons: [], findings: [] };
  const content = text(input.prompt || input.instruction || input.text || input.actionSummary);
  const actionableContent = removeNegatedRiskClauses(content);
  for (const finding of evaluateShell({ command: actionableContent }).findings) {
    pushFinding(state, finding.riskLevel, finding.reason, finding.details);
  }
  for (const finding of evaluateBrowser({ action: actionableContent }).findings) {
    pushFinding(state, finding.riskLevel, finding.reason, finding.details);
  }
  if (/\b(ignore|bypass|disable)\b.{0,80}\b(safety|risk|approval|guard|安全|风控|审批)\b/i.test(content)) {
    pushFinding(state, "high", "Instruction attempts to bypass safety or approval rules.", {});
  }
  return state;
}

function evaluateToolRisk(input = {}) {
  const tool = text(input.tool).toLowerCase();
  if (tool === "shell") return evaluateShell(input);
  if (tool === "files" || tool === "file") return evaluateFile(input);
  if (tool === "browser") return evaluateBrowser(input);
  if (tool === "web") return evaluateWeb(input);
  if (tool === "codex-cli" || tool === "codex") return evaluateCodex(input);
  return { riskLevel: "low", reasons: [], findings: [] };
}

function blockedToolResult(input = {}, risk = evaluateToolRisk(input)) {
  return {
    ok: false,
    blocked: true,
    riskLevel: normalizeRiskLevel(risk.riskLevel),
    reasons: [...new Set(risk.reasons.filter(Boolean))],
    requiredApproval: true,
    actionSummary: text(
      input.actionSummary || input.command || input.action || input.path || input.url || input.prompt || "tool action"
    ),
    riskFindings: risk.findings || [],
    error: "Tool action blocked by deterministic risk gate."
  };
}

function gateToolAction(input = {}) {
  const risk = evaluateToolRisk(input);
  const riskLevel = normalizeRiskLevel(risk.riskLevel);
  const requiredApproval = RISK_ORDER[riskLevel] >= RISK_ORDER.high;
  if (requiredApproval && !isApproved(input)) {
    return {
      allowed: false,
      blocked: true,
      requiredApproval,
      ...blockedToolResult(input, risk)
    };
  }
  return {
    allowed: true,
    blocked: false,
    requiredApproval,
    riskLevel,
    reasons: [...new Set(risk.reasons.filter(Boolean))],
    actionSummary: text(
      input.actionSummary || input.command || input.action || input.path || input.url || input.prompt || "tool action"
    ),
    riskFindings: risk.findings || []
  };
}

module.exports = {
  blockedToolResult,
  evaluateToolRisk,
  gateToolAction,
  homeSensitivePath,
  isApproved,
  normalizeRiskLevel
};
