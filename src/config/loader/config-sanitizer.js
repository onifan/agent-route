"use strict";

const SENSITIVE_KEY_PATTERN =
  /(authorization|api[_-]?key|token|cookie|password|secret|credential|session|bearer|private[_-]?key|oauth)/i;

function sanitizeConfig(value, depth = 0) {
  if (depth > 20) return "[MaxDepth]";
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeConfig(item, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = entry ? "[REDACTED]" : entry;
      continue;
    }
    output[key] = sanitizeConfig(entry, depth + 1);
  }
  return output;
}

module.exports = {
  SENSITIVE_KEY_PATTERN,
  sanitizeConfig
};
