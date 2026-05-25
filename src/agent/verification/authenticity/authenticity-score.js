"use strict";

function clamp(value) {
  return Math.max(0, Math.min(1, Number(value || 0)));
}

function createScore(base = 0.72) {
  return {
    score: clamp(base),
    reasons: [],
    warnings: []
  };
}

function reward(state, amount, reason) {
  state.score = clamp(state.score + Number(amount || 0));
  if (reason) state.reasons.push(reason);
}

function penalize(state, amount, warning) {
  state.score = clamp(state.score - Number(amount || 0));
  if (warning) state.warnings.push(warning);
}

function finalizeScore(state) {
  return {
    authenticityScore: Number(clamp(state.score).toFixed(2)),
    authenticityReasons: [...new Set(state.reasons)].slice(0, 20),
    authenticityWarnings: [...new Set(state.warnings)].slice(0, 20)
  };
}

module.exports = {
  createScore,
  finalizeScore,
  penalize,
  reward
};
