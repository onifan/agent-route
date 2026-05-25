"use strict";

const { DECISION_SOURCE, normalizeAttributionRecord } = require("./attribution-normalizer");

function attributeDecision(input = {}) {
  return normalizeAttributionRecord(input);
}

function sourceLabel(source = "") {
  return (
    {
      [DECISION_SOURCE.SYSTEM_RECOMMENDATION]: "system recommendation",
      [DECISION_SOURCE.USER_OVERRIDE]: "user override",
      [DECISION_SOURCE.MANUAL_ACTION]: "manual action",
      [DECISION_SOURCE.HUMAN_REVIEW]: "human review",
      [DECISION_SOURCE.RECOVERY]: "recovery"
    }[source] || "unknown"
  );
}

module.exports = {
  DECISION_SOURCE,
  attributeDecision,
  sourceLabel
};
