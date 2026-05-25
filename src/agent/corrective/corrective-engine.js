"use strict";

const { normalizeAction, PRIORITY } = require("./corrective-actions");
const { normalizeInput } = require("./corrective-normalizer");
const {
  applyAuthenticityRules,
  applyContinueRule,
  applyRiskRules,
  applyVerificationRules
} = require("./corrective-rules");

const PRIORITY_RANK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });

function dedupeActions(actions = []) {
  const seen = new Map();
  for (const raw of actions) {
    const item = normalizeAction(raw);
    const key = `${item.type}:${item.trigger}`;
    const existing = seen.get(key);
    if (!existing || PRIORITY_RANK[item.priority] > PRIORITY_RANK[existing.priority]) {
      seen.set(key, item);
    }
  }
  return [...seen.values()]
    .sort((a, b) => (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0))
    .slice(0, 8);
}

function summarizeRecommendedActions(actions = []) {
  const primary = actions[0] || null;
  return {
    primaryAction: primary ? primary.type : "",
    highestPriority: primary ? primary.priority : PRIORITY.LOW,
    count: actions.length,
    requiresHumanReview: actions.some((item) => item.type === "request_human_review"),
    shouldBlock: actions.some((item) => item.type === "mark_as_blocked")
  };
}

function suggestCorrectiveActions(input = {}) {
  const state = normalizeInput(input);
  const actions = [];
  applyAuthenticityRules(state, actions);
  applyRiskRules(state, actions);
  applyVerificationRules(state, actions);
  applyContinueRule(state, actions);
  const recommendedActions = dedupeActions(actions);
  return {
    at: new Date().toISOString(),
    taskId: state.task.id || "",
    recommendedActions,
    summary: summarizeRecommendedActions(recommendedActions),
    sourceSignals: {
      authenticityScore: state.authenticityScore,
      authenticityWarnings: state.warnings,
      warningCodes: state.warningCodes,
      verificationStatus: state.verificationStatus,
      suggestedNextState: state.suggestedNextState,
      riskLevel: state.riskLevel,
      requiresHumanApproval: state.requiresHumanApproval
    }
  };
}

module.exports = {
  dedupeActions,
  suggestCorrectiveActions,
  summarizeRecommendedActions
};
