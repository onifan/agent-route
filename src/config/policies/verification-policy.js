"use strict";

const DEFAULT_VERIFICATION_POLICY = Object.freeze({
  depth: "rule_based",
  confidence: {
    verified: 0.7,
    partialTechnical: 0.55,
    partialSemantic: 0.3,
    modelVerified: 0.7,
    modelPartial: 0.45,
    defaultCompact: 0.18
  },
  failureHandling: {
    retryOnUnverified: true,
    blockOnCriticalRisk: true
  },
  semantic: {
    minCriteriaCoverage: 0.75,
    minQualityScore: 0.75
  }
});

module.exports = {
  DEFAULT_VERIFICATION_POLICY
};
