"use strict";

const os = require("os");
const path = require("path");

function agentRouteHome() {
  return process.env.AGENT_ROUTE_HOME || process.env.DATA_DIR || path.join(os.homedir(), ".agent-route-studio");
}

function agentRoutePath(...parts) {
  return path.join(agentRouteHome(), ...parts);
}

module.exports = {
  agentRouteHome,
  agentRoutePath
};
