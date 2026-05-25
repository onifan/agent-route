"use strict";

function list(value) {
  if (Array.isArray(value)) return value.filter((item) => item != null && item !== "");
  if (value == null || value === "") return [];
  return [value];
}

function text(value) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function warningCode(value) {
  const raw = lower(value);
  if (/duplicate|重复/.test(raw)) return "duplicate_items";
  if (/missing expected links|missing links|empty links|empty link|link is empty|缺少链接|空链接/.test(raw))
    return "empty_link";
  if (/empty or weak titles|empty titles|empty title|missing titles|missing title|弱标题|空标题|缺少标题/.test(raw))
    return "empty_title";
  if (/placeholder|tbd|todo|dummy|template-like|template|模板|占位|待补充|假数据/.test(raw))
    return "placeholder_content";
  if (/no result content|empty output|produced no result|没有结果|空输出/.test(raw)) return "empty_output";
  return raw ? "authenticity_warning" : "";
}

function normalizeInput(input = {}) {
  const task = input.task || {};
  const verification = input.verification || {};
  const risk = input.risk || input.riskEvaluation || {};
  const authenticityScore = Number(
    input.authenticityScore ??
      verification.authenticityScore ??
      verification.authenticity_score ??
      task.authenticityScore ??
      task.authenticity_score ??
      0
  );
  const warnings = list(
    input.authenticityWarnings ||
      verification.authenticityWarnings ||
      verification.authenticity_warnings ||
      task.authenticityWarnings ||
      task.authenticity_warnings
  )
    .map(text)
    .filter(Boolean);
  const reasons = list(
    input.authenticityReasons ||
      verification.authenticityReasons ||
      verification.authenticity_reasons ||
      task.authenticityReasons ||
      task.authenticity_reasons
  )
    .map(text)
    .filter(Boolean);
  const riskLevel = lower(risk.riskLevel || risk.risk_level || task.riskLevel || task.risk_level || "low") || "low";
  const riskReasons = list(risk.riskReasons || risk.risk_reasons || task.riskReasons || task.risk_reasons)
    .map(text)
    .filter(Boolean);
  return {
    task,
    verification,
    risk,
    authenticityScore: Math.max(0, Math.min(1, Number.isFinite(authenticityScore) ? authenticityScore : 0)),
    warnings,
    warningCodes: [...new Set(warnings.map(warningCode).filter(Boolean))],
    reasons,
    verificationStatus: lower(verification.verificationStatus || task.verificationStatus || ""),
    suggestedNextState: lower(verification.suggestedNextState || task.verificationSuggestedNextState || ""),
    retryable: verification.retryable !== false && task.verificationRetryable !== false,
    riskLevel,
    riskReasons,
    requiresHumanApproval: Boolean(
      risk.requiresHumanApproval || task.requiresHumanApproval || task.requiresHumanConfirmation
    ),
    blockedReason: text(risk.blockedReason || task.blockedReason || ""),
    taskType: lower(task.type || task.taskType || ""),
    modelPool: lower(task.modelPool || task.model_pool || "")
  };
}

module.exports = {
  list,
  normalizeInput,
  text,
  warningCode
};
