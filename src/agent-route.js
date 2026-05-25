"use strict";

const router = require("./core/router");
const orchestrator = require("./agent/orchestrator");

module.exports = {
  AGENT_MODEL_IDS: orchestrator.AGENT_MODEL_IDS,
  COMMANDER_MODEL_OPTIONS: orchestrator.COMMANDER_MODEL_OPTIONS,
  DEFAULT_COMMANDER_MODELS: orchestrator.DEFAULT_COMMANDER_MODELS,
  DEFAULT_CONFIG: orchestrator.DEFAULT_CONFIG,
  DEFAULT_MODEL_POOLS: orchestrator.DEFAULT_MODEL_POOLS,
  DEFAULT_PROMPT_SETTINGS: orchestrator.DEFAULT_PROMPT_SETTINGS,
  handleAgentRouteRun: orchestrator.handleAgentRouteRun,
  handleInternalModelRequest: router.handleInternalModelRequest,
  withLocalApiKey: router.withLocalApiKey
};
