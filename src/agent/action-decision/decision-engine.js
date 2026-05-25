"use strict";

const { normalizeAction } = require("../corrective/corrective-actions");
const { estimateActionProfile } = require("./decision-rules");
const { normalizeDecisionInput } = require("./decision-normalizer");
const { PRIORITY_RANK, scoreAction } = require("./decision-score");

function rankedAction(action = {}, state = {}, index = 0) {
  const normalized = normalizeAction(action);
  const profile = estimateActionProfile(normalized, state);
  const score = scoreAction(normalized, profile, state);
  return {
    ...normalized,
    score: score.score,
    reason: score.reason,
    decisionReason: score.reason,
    ruleScore: score.ruleScore,
    historyScore: score.historyScore,
    estimatedSuccess: score.estimatedSuccess,
    estimatedCost: score.estimatedCost,
    historicalSuccessRate: score.historicalSuccessRate,
    systemSuccessRate: score.systemSuccessRate,
    overrideSuccessRate: score.overrideSuccessRate,
    humanSuccessRate: score.humanSuccessRate,
    historicalCost: score.historicalCost,
    historicalDuration: score.historicalDuration,
    historyRuns: score.historyRuns,
    riskLevel: score.riskLevel,
    requiresHuman: score.requiresHuman,
    rankSource: "action-decision",
    originalIndex: index
  };
}

function summarizeRankedActions(rankedActions = [], state = {}) {
  const top = rankedActions[0] || null;
  return {
    recommendedAction: top ? top.type : "",
    topScore: top ? top.score : 0,
    count: rankedActions.length,
    budgetPressure: Number(Number(state.budgetPressure || 0).toFixed(3)),
    riskLevel: state.riskLevel || "low",
    authenticityScore: Number(Number(state.authenticityScore || 0).toFixed(3)),
    requiresHuman: Boolean(top && top.requiresHuman)
  };
}

function rankActions(input = {}) {
  const state = normalizeDecisionInput(input);
  const rankedActions = state.actions
    .map((action, index) => rankedAction(action, state, index))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const priorityDiff = (PRIORITY_RANK[right.priority] || 0) - (PRIORITY_RANK[left.priority] || 0);
      if (priorityDiff) return priorityDiff;
      return left.originalIndex - right.originalIndex;
    })
    .slice(0, 8)
    .map((item, index) => ({
      ...item,
      rank: index + 1
    }));
  return {
    at: new Date().toISOString(),
    taskId: state.taskId,
    rankedActions,
    recommendedAction: rankedActions[0] || null,
    summary: summarizeRankedActions(rankedActions, state),
    sourceSignals: {
      authenticityScore: state.authenticityScore,
      authenticityWarnings: state.authenticityWarnings,
      riskLevel: state.riskLevel,
      requiresHumanApproval: state.requiresHumanApproval,
      budgetStatus: state.budget.status,
      degradationLevel: state.budget.degradationLevel,
      budgetPressure: state.budgetPressure,
      retryCount: state.history.retryCount,
      recoveryCount: state.history.recoveryCount
    }
  };
}

module.exports = {
  rankActions,
  rankedAction,
  summarizeRankedActions
};
