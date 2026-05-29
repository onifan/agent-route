"use strict";

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampInteger(value, min, max) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return null;
  return Math.max(min, Math.min(max, number));
}

function outputTokenLimit(config = {}, defaultConfig = {}, keys = [], defaultValue = 1600, min = 512, max = 5000) {
  for (const key of keys) {
    const value = finiteNumber(config[key]);
    if (value != null) return clampInteger(value, min, max);
  }
  for (const key of keys) {
    const value = finiteNumber(defaultConfig[key]);
    if (value != null) return clampInteger(value, min, max);
  }
  return clampInteger(defaultValue, min, max);
}

function planMaxTokens(config = {}, defaultConfig = {}) {
  return outputTokenLimit(
    config,
    defaultConfig,
    ["planMaxTokens", "commanderPlanMaxTokens", "maxPlanTokens"],
    1600,
    800,
    5000
  );
}

function reviewMaxTokens(config = {}, defaultConfig = {}) {
  return outputTokenLimit(
    config,
    defaultConfig,
    ["reviewMaxTokens", "commanderReviewMaxTokens", "maxReviewTokens"],
    2600,
    1200,
    5000
  );
}

module.exports = {
  outputTokenLimit,
  planMaxTokens,
  reviewMaxTokens
};
