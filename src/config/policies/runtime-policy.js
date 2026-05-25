"use strict";

const DEFAULT_AGENT_ROUTE_RUNTIME_POLICY = Object.freeze({
  maxTasks: 3,
  maxGoalIterations: 4,
  maxFreeCandidates: 40,
  callTimeoutMs: 120000,
  commanderTimeoutMs: 120000,
  modelMaxAttempts: 3,
  toolMaxAttempts: 3,
  toolRetryDelayMs: 500,
  planMaxTokens: 1600,
  reviewMaxTokens: 2600,
  freeCallTimeoutMs: 30000,
  codexCliTimeoutMs: 180000,
  verifierModelEnabled: true,
  verifierTimeoutMs: 45000,
  discoveryTimeoutMs: 2500,
  dynamicFreeModels: true,
  openRouterModelsEndpoint: "https://openrouter.ai/api/v1/models"
});

module.exports = {
  DEFAULT_AGENT_ROUTE_RUNTIME_POLICY
};
