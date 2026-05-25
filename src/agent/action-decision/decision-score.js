"use strict";

const { PRIORITY } = require("../corrective/corrective-actions");
const { clamp, historicalSuccessRate } = require("./decision-normalizer");
const { RISK_RANK } = require("./decision-rules");

const PRIORITY_RANK = Object.freeze({
  [PRIORITY.LOW]: 0,
  [PRIORITY.MEDIUM]: 1,
  [PRIORITY.HIGH]: 2,
  [PRIORITY.CRITICAL]: 3
});

function priorityBoost(priority = "medium") {
  return (PRIORITY_RANK[priority] || 0) * 0.025;
}

function riskPenalty(riskLevel = "low") {
  return (RISK_RANK[riskLevel] || 0) * 0.06;
}

function formatReason(action = {}, profile = {}, state = {}, score = 0) {
  const parts = [];
  if (action.reason) parts.push(action.reason);
  if (profile.reason) parts.push(profile.reason);
  if (profile.historyRuns)
    parts.push(`历史样本 ${profile.historyRuns} 次，历史成功率 ${Math.round(profile.historicalSuccessRate * 100)}%。`);
  if (state.budgetPressure >= 0.7) parts.push("预算压力较高，低成本和人工决策动作被优先考虑。");
  if ((RISK_RANK[state.riskLevel] || 0) >= RISK_RANK.high) parts.push("风险等级较高，避免自动继续。");
  parts.push(`综合分 ${Math.round(score * 100)}。`);
  return [...new Set(parts.filter(Boolean))].join(" ");
}

function actionHistoryStats(actionType, history = {}) {
  const stats = (history.actionStats && history.actionStats[actionType]) || {};
  const runs = Number(stats.runs || stats.total || 0);
  return {
    runs: Number.isFinite(runs) ? Math.max(0, runs) : 0,
    successRate: historicalSuccessRate(actionType, history),
    systemSuccessRate: Number.isFinite(Number(stats.systemSuccessRate || stats.system_success_rate))
      ? clamp(stats.systemSuccessRate || stats.system_success_rate)
      : null,
    overrideSuccessRate: Number.isFinite(Number(stats.overrideSuccessRate || stats.override_success_rate))
      ? clamp(stats.overrideSuccessRate || stats.override_success_rate)
      : null,
    humanSuccessRate: Number.isFinite(Number(stats.humanSuccessRate || stats.human_success_rate))
      ? clamp(stats.humanSuccessRate || stats.human_success_rate)
      : null,
    avgCost: Number.isFinite(Number(stats.avgCost || stats.avg_cost)) ? clamp(stats.avgCost || stats.avg_cost) : 0.5,
    avgDuration: Number.isFinite(Number(stats.avgDuration || stats.avg_duration))
      ? Math.max(0, Number(stats.avgDuration || stats.avg_duration))
      : 0
  };
}

function durationScore(durationMs = 0) {
  if (!durationMs) return 0.5;
  if (durationMs <= 30 * 1000) return 0.9;
  if (durationMs <= 2 * 60 * 1000) return 0.7;
  if (durationMs <= 5 * 60 * 1000) return 0.45;
  return 0.2;
}

function scoreAction(action = {}, profile = {}, state = {}) {
  const historical = actionHistoryStats(action.type, state.history);
  const hasHistory = historical.runs > 0;
  const success = hasHistory
    ? clamp(profile.estimatedSuccess * 0.7 + historical.successRate * 0.3)
    : clamp(profile.estimatedSuccess);
  const estimatedCost = hasHistory
    ? clamp(profile.estimatedCost * 0.7 + historical.avgCost * 0.3)
    : clamp(profile.estimatedCost);
  const costPenalty = estimatedCost * (0.14 + Number(state.budgetPressure || 0) * 0.22);
  const humanPenalty =
    profile.requiresHuman && (RISK_RANK[state.riskLevel] || 0) < RISK_RANK.high && state.budgetPressure < 0.8
      ? 0.04
      : 0;
  const ruleScore = clamp(
    success * 0.58 +
      (1 - estimatedCost) * 0.2 +
      (1 - (RISK_RANK[profile.riskLevel] || 0) / 3) * 0.14 +
      priorityBoost(action.priority) -
      riskPenalty(profile.riskLevel) -
      costPenalty -
      humanPenalty
  );
  const historyScore = clamp(
    historical.successRate * 0.62 + (1 - historical.avgCost) * 0.2 + durationScore(historical.avgDuration) * 0.18
  );
  const score = hasHistory ? clamp(ruleScore * 0.7 + historyScore * 0.3) : ruleScore;
  profile.historyRuns = historical.runs;
  profile.historicalSuccessRate = historical.successRate;
  return {
    score: Number(score.toFixed(3)),
    ruleScore: Number(ruleScore.toFixed(3)),
    historyScore: hasHistory ? Number(historyScore.toFixed(3)) : null,
    estimatedSuccess: Number(success.toFixed(3)),
    estimatedCost: Number(estimatedCost.toFixed(3)),
    historicalSuccessRate: hasHistory ? Number(historical.successRate.toFixed(3)) : null,
    systemSuccessRate:
      hasHistory && historical.systemSuccessRate != null ? Number(historical.systemSuccessRate.toFixed(3)) : null,
    overrideSuccessRate:
      hasHistory && historical.overrideSuccessRate != null ? Number(historical.overrideSuccessRate.toFixed(3)) : null,
    humanSuccessRate:
      hasHistory && historical.humanSuccessRate != null ? Number(historical.humanSuccessRate.toFixed(3)) : null,
    historicalCost: hasHistory ? Number(historical.avgCost.toFixed(3)) : null,
    historicalDuration: hasHistory ? Number(historical.avgDuration.toFixed(3)) : null,
    historyRuns: historical.runs,
    riskLevel: profile.riskLevel,
    requiresHuman: Boolean(profile.requiresHuman),
    reason: formatReason(action, profile, state, score)
  };
}

module.exports = {
  PRIORITY_RANK,
  scoreAction
};
