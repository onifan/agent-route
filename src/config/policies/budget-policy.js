"use strict";

const DEFAULT_BUDGET_POLICY = Object.freeze({
  unlimited: false,
  mode: "limited",
  goal: {
    maxTokens: 180000,
    maxCostUsd: 1.5,
    maxRuntimeMs: 30 * 60 * 1000,
    maxSteps: 120,
    maxBrowserActions: 80,
    maxRetries: 8,
    maxConcurrentWorkers: 1
  },
  task: {
    maxRetries: 4,
    maxRuntimeMs: 3 * 60 * 1000,
    maxTokens: 50000,
    maxBrowserActions: 20,
    maxShellActions: 30,
    maxVerificationRetries: 1
  },
  worker: {
    maxTokens: 32000,
    maxCostUsd: 0.5,
    maxPromptTokens: 22000
  },
  browser: {
    maxActions: 20,
    maxReloads: 4,
    maxNavigations: 10,
    maxTabs: 3,
    maxSubmitAttempts: 1,
    maxScreenshots: 5
  },
  verification: {
    maxModelCalls: 2,
    maxRetries: 1,
    timeoutMs: 45000
  },
  thresholds: {
    warning: 0.7,
    degraded: 0.85,
    emergency: 0.97
  }
});

module.exports = {
  DEFAULT_BUDGET_POLICY
};
