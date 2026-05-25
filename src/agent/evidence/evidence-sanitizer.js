"use strict";

const os = require("os");
const path = require("path");
const { agentRouteHome } = require("../../shared/utils/agent-home");

const SENSITIVE_KEY_PATTERN =
  /(authorization|api[_-]?key|token|cookie|password|passwd|pwd|secret|credential|session|bearer|private[_-]?key|oauth|code)/i;
const SENSITIVE_TEXT_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(ghp|github_pat|glpat|xox[baprs]|sk|rk|pk_live|pk_test)_[A-Za-z0-9_=-]{12,}/gi,
  /\b(sk|rk)-[A-Za-z0-9_-]{16,}/gi,
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|token|password|passwd|pwd|cookie|secret|authorization|oauth[_-]?code)\b\s*[:=]\s*['"]?[^'"\s&]{6,}/gi
];

function redactSensitiveText(value) {
  let text = String(value == null ? "" : value);
  text = text.replace(SENSITIVE_TEXT_PATTERNS[0], "Bearer [REDACTED]");
  text = text.replace(SENSITIVE_TEXT_PATTERNS[1], "[REDACTED_SECRET]");
  text = text.replace(SENSITIVE_TEXT_PATTERNS[2], "$1-[REDACTED]");
  text = text.replace(SENSITIVE_TEXT_PATTERNS[3], "$1=[REDACTED]");
  return text;
}

function sanitizeUrl(value) {
  const raw = redactSensitiveText(value);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_KEY_PATTERN.test(key)) parsed.searchParams.set(key, "[REDACTED]");
    }
    if (parsed.hash && SENSITIVE_KEY_PATTERN.test(parsed.hash)) parsed.hash = "#[REDACTED]";
    return parsed.toString();
  } catch {
    return raw.replace(
      /([?&][^=&#]*(?:token|key|cookie|password|secret|authorization|code|session)[^=&#]*=)[^&#\s]+/gi,
      "$1[REDACTED]"
    );
  }
}

function sanitizePathForDisplay(value) {
  const raw = redactSensitiveText(value);
  if (!raw) return "";
  const normalized = path.normalize(raw);
  const routeHome = path.normalize(agentRouteHome());
  const userHome = path.normalize(os.homedir());
  if (normalized === routeHome) return "$AGENT_ROUTE_HOME";
  if (normalized.startsWith(`${routeHome}${path.sep}`)) return `$AGENT_ROUTE_HOME${normalized.slice(routeHome.length)}`;
  if (normalized === userHome) return "~";
  if (normalized.startsWith(`${userHome}${path.sep}`)) return `~${normalized.slice(userHome.length)}`;
  return raw;
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sanitizeEvidence(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return redactSensitiveText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 20) return "[truncated]";
  if (Array.isArray(value)) return value.map((item) => sanitizeEvidence(item, depth + 1));
  if (!isObject(value)) return redactSensitiveText(value);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = item ? "[REDACTED]" : item;
      continue;
    }
    if (/url$/i.test(key) || key === "url" || /Url$/.test(key)) {
      output[key] = sanitizeUrl(item);
      continue;
    }
    if (/path$/i.test(key) || key === "path") {
      output[key] = sanitizePathForDisplay(item);
      continue;
    }
    output[key] = sanitizeEvidence(item, depth + 1);
  }
  return output;
}

module.exports = {
  SENSITIVE_KEY_PATTERN,
  redactSensitiveText,
  sanitizeEvidence,
  sanitizePathForDisplay,
  sanitizeUrl
};
