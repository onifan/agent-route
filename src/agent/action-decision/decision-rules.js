"use strict";

const { CORRECTIVE_ACTION } = require("../corrective/corrective-actions");
const { clamp } = require("./decision-normalizer");

const ACTION_PROFILE = Object.freeze({
  [CORRECTIVE_ACTION.RETRY_TASK]: {
    estimatedSuccess: 0.55,
    estimatedCost: 0.22,
    riskLevel: "medium",
    requiresHuman: false,
    reason: "重试当前任务成本较低，但可能重复遇到同类问题。"
  },
  [CORRECTIVE_ACTION.RETRY_WITH_DIFFERENT_MODEL]: {
    estimatedSuccess: 0.65,
    estimatedCost: 0.48,
    riskLevel: "medium",
    requiresHuman: false,
    reason: "换模型重试通常能提升质量，但会增加模型成本。"
  },
  [CORRECTIVE_ACTION.RERUN_BROWSER]: {
    estimatedSuccess: 0.72,
    estimatedCost: 0.52,
    riskLevel: "medium",
    requiresHuman: false,
    reason: "重新读取浏览器证据能修复缺链接或页面证据不足，但会消耗浏览器预算。"
  },
  [CORRECTIVE_ACTION.REQUEST_HUMAN_REVIEW]: {
    estimatedSuccess: 0.86,
    estimatedCost: 0.72,
    riskLevel: "low",
    requiresHuman: true,
    reason: "人工复核最稳妥，适合高风险或语义质量不确定的结果。"
  },
  [CORRECTIVE_ACTION.REQUEST_MORE_DATA]: {
    estimatedSuccess: 0.62,
    estimatedCost: 0.36,
    riskLevel: "low",
    requiresHuman: true,
    reason: "补充数据能减少误判，但需要用户或上游任务提供更多输入。"
  },
  [CORRECTIVE_ACTION.MARK_AS_BLOCKED]: {
    estimatedSuccess: 0.82,
    estimatedCost: 0.08,
    riskLevel: "low",
    requiresHuman: true,
    reason: "保持阻塞可以避免把可疑结果继续传给下游任务。"
  },
  [CORRECTIVE_ACTION.CONTINUE]: {
    estimatedSuccess: 0.8,
    estimatedCost: 0.05,
    riskLevel: "low",
    requiresHuman: false,
    reason: "当前没有明显纠正需求，继续流程成本最低。"
  }
});

const RISK_RANK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });

function profileForAction(action = {}) {
  return {
    ...(ACTION_PROFILE[action.type] || ACTION_PROFILE[CORRECTIVE_ACTION.REQUEST_HUMAN_REVIEW])
  };
}

function applyTriggerAdjustments(profile, action = {}, state = {}) {
  const trigger = String(action.trigger || "").toLowerCase();
  if (action.type === CORRECTIVE_ACTION.RETRY_TASK && trigger.includes("duplicate")) {
    profile.estimatedSuccess += 0.08;
    profile.reason = "重复结果通常可通过重跑和去重约束修复。";
  }
  if (action.type === CORRECTIVE_ACTION.RERUN_BROWSER && /empty_link|missing_link|browser/.test(trigger)) {
    profile.estimatedSuccess += 0.1;
    profile.reason = "链接缺失更适合重新读取页面证据，而不是只改文本。";
  }
  if (action.type === CORRECTIVE_ACTION.REQUEST_HUMAN_REVIEW && /placeholder|high_risk/.test(trigger)) {
    profile.estimatedSuccess += 0.05;
  }
  if (action.type === CORRECTIVE_ACTION.CONTINUE && state.authenticityScore >= 0.85 && state.riskLevel === "low") {
    profile.estimatedSuccess += 0.08;
  }
}

function applyAuthenticityAdjustments(profile, action = {}, state = {}) {
  const score = Number(state.authenticityScore || 0);
  if (score > 0 && score < 0.35) {
    if (action.type === CORRECTIVE_ACTION.MARK_AS_BLOCKED) profile.estimatedSuccess += 0.14;
    if (action.type === CORRECTIVE_ACTION.REQUEST_HUMAN_REVIEW) profile.estimatedSuccess += 0.08;
    if (action.type === CORRECTIVE_ACTION.CONTINUE) profile.estimatedSuccess -= 0.55;
    if (action.type === CORRECTIVE_ACTION.RETRY_TASK || action.type === CORRECTIVE_ACTION.RERUN_BROWSER)
      profile.estimatedSuccess -= 0.08;
  } else if (score > 0 && score < 0.55) {
    if (action.type === CORRECTIVE_ACTION.RETRY_TASK || action.type === CORRECTIVE_ACTION.RERUN_BROWSER)
      profile.estimatedSuccess += 0.07;
    if (action.type === CORRECTIVE_ACTION.CONTINUE) profile.estimatedSuccess -= 0.32;
  }
}

function applyRiskAdjustments(profile, action = {}, state = {}) {
  const systemRisk = RISK_RANK[state.riskLevel] || 0;
  if (systemRisk >= RISK_RANK.high && !profile.requiresHuman) {
    profile.estimatedSuccess -= systemRisk === RISK_RANK.critical ? 0.26 : 0.16;
    profile.riskLevel = systemRisk === RISK_RANK.critical ? "critical" : "high";
    profile.reason = "当前任务风险较高，非人工动作需要降权。";
  }
  if (systemRisk >= RISK_RANK.high && profile.requiresHuman) {
    profile.estimatedSuccess += 0.1;
    profile.reason = "高风险上下文中，人工复核或阻塞优先级更高。";
  }
}

function applyBudgetAdjustments(profile, action = {}, state = {}) {
  const pressure = Number(state.budgetPressure || 0);
  if (pressure >= 0.9) {
    if (profile.estimatedCost >= 0.35) profile.estimatedSuccess -= 0.22;
    if (action.type === CORRECTIVE_ACTION.MARK_AS_BLOCKED || action.type === CORRECTIVE_ACTION.REQUEST_HUMAN_REVIEW) {
      profile.estimatedSuccess += 0.08;
    }
  } else if (pressure >= 0.7 && profile.estimatedCost >= 0.5) {
    profile.estimatedSuccess -= 0.1;
  }
}

function applyHistoryAdjustments(profile, action = {}, state = {}) {
  const retryCount = Number((state.history && state.history.retryCount) || 0);
  const recoveryCount = Number((state.history && state.history.recoveryCount) || 0);
  if (
    retryCount >= 3 &&
    (action.type === CORRECTIVE_ACTION.RETRY_TASK || action.type === CORRECTIVE_ACTION.RERUN_BROWSER)
  ) {
    profile.estimatedSuccess -= 0.12;
    profile.reason = "当前任务已多次尝试，继续自动重试的收益下降。";
  }
  if (recoveryCount > 0 && !profile.requiresHuman && action.type !== CORRECTIVE_ACTION.CONTINUE) {
    profile.estimatedSuccess -= Math.min(0.12, recoveryCount * 0.04);
  }
}

function estimateActionProfile(action = {}, state = {}) {
  const profile = profileForAction(action);
  applyTriggerAdjustments(profile, action, state);
  applyAuthenticityAdjustments(profile, action, state);
  applyRiskAdjustments(profile, action, state);
  applyBudgetAdjustments(profile, action, state);
  applyHistoryAdjustments(profile, action, state);
  profile.estimatedSuccess = clamp(profile.estimatedSuccess);
  profile.estimatedCost = clamp(profile.estimatedCost);
  return profile;
}

module.exports = {
  ACTION_PROFILE,
  RISK_RANK,
  estimateActionProfile
};
