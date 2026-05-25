"use strict";

const promptConfig = require("../prompts");
const modelConfig = require("../models");
const policyConfig = require("../policies");
const { agentRouteHome, agentRoutePath } = require("../../shared/utils/agent-home");

const {
  COMMANDER_MODEL_OPTIONS,
  DEFAULT_COMMANDER_MODELS,
  DEFAULT_MODEL_POOLS,
  MODEL_TIERS,
  MODEL_TIER_LABELS,
  MODEL_TIER_RANK
} = modelConfig;
const { DEFAULT_PROMPT_SETTINGS } = promptConfig;
const {
  DEFAULT_AGENT_ROUTE_RUNTIME_POLICY,
  DEFAULT_BUDGET_POLICY,
  DEFAULT_RISK_POLICY,
  DEFAULT_VERIFICATION_POLICY,
  DEFAULT_BROWSER_TOOL_POLICY,
  DEFAULT_RECOVERY_POLICY,
  HUMAN_APPROVAL_POLICY,
  UNATTENDED_POLICY
} = policyConfig;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function runtimePaths() {
  return {
    home: agentRouteHome(),
    configFile: process.env.AGENT_ROUTE_CONFIG || agentRoutePath("agent-route.json"),
    tasksFile: process.env.AGENT_ROUTE_TASKS || agentRoutePath("tasks.json"),
    memoryFile: process.env.AGENT_ROUTE_MEMORY || agentRoutePath("memory.json"),
    databaseFile: process.env.AGENT_ROUTE_DB || agentRoutePath("db", "data.sqlite")
  };
}

function createDefaultRuntimeConfig() {
  return {
    ...clone(DEFAULT_AGENT_ROUTE_RUNTIME_POLICY),
    budget: clone(DEFAULT_BUDGET_POLICY),
    promptSettings: clone(DEFAULT_PROMPT_SETTINGS),
    modelPools: clone(DEFAULT_MODEL_POOLS),
    modelTiers: clone(MODEL_TIERS),
    modelTierLabels: clone(MODEL_TIER_LABELS),
    modelTierRank: clone(MODEL_TIER_RANK),
    riskPolicy: clone(DEFAULT_RISK_POLICY),
    verificationPolicy: clone(DEFAULT_VERIFICATION_POLICY),
    humanApprovalPolicy: clone(HUMAN_APPROVAL_POLICY),
    unattendedPolicy: clone(UNATTENDED_POLICY),
    recoveryPolicy: clone(DEFAULT_RECOVERY_POLICY),
    tools: {
      browser: clone(DEFAULT_BROWSER_TOOL_POLICY)
    },
    runtimePaths: runtimePaths(),
    featureFlags: {}
  };
}

const DEFAULT_CONFIG = createDefaultRuntimeConfig();

module.exports = {
  COMMANDER_MODEL_OPTIONS,
  DEFAULT_AGENT_ROUTE_RUNTIME_POLICY,
  DEFAULT_BUDGET_POLICY,
  DEFAULT_BROWSER_TOOL_POLICY,
  DEFAULT_COMMANDER_MODELS,
  DEFAULT_CONFIG,
  DEFAULT_MODEL_POOLS,
  DEFAULT_PROMPT_SETTINGS,
  DEFAULT_RECOVERY_POLICY,
  DEFAULT_RISK_POLICY,
  DEFAULT_VERIFICATION_POLICY,
  HUMAN_APPROVAL_POLICY,
  UNATTENDED_POLICY,
  createDefaultRuntimeConfig,
  runtimePaths
};
