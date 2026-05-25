"use strict";

const MODEL_TIERS = Object.freeze({
  COMMANDER: "commander",
  STRONG: "strong",
  CODING: "coding",
  FREE: "free",
  CODEX_CLI: "codex-cli"
});

const MODEL_TIER_RANK = Object.freeze({
  [MODEL_TIERS.FREE]: 0,
  [MODEL_TIERS.CODING]: 1,
  [MODEL_TIERS.STRONG]: 2,
  [MODEL_TIERS.COMMANDER]: 3,
  [MODEL_TIERS.CODEX_CLI]: 3
});

const MODEL_TIER_LABELS = Object.freeze({
  [MODEL_TIERS.FREE]: "L0",
  [MODEL_TIERS.CODING]: "L1",
  [MODEL_TIERS.STRONG]: "L2",
  [MODEL_TIERS.COMMANDER]: "L3",
  [MODEL_TIERS.CODEX_CLI]: "local"
});

module.exports = {
  MODEL_TIERS,
  MODEL_TIER_LABELS,
  MODEL_TIER_RANK
};
