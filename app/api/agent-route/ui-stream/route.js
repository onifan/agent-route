import { createRequire } from "module";

const require = createRequire(import.meta.url);
const agentRoute = require("../../../../src/agent-route.js");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fallback(request) {
  return agentRoute.handleInternalModelRequest(request, { endpointMode: "chat" });
}

export async function OPTIONS(request) {
  return agentRoute.handleAgentRouteUiStream(request, fallback);
}

export async function POST(request) {
  return agentRoute.handleAgentRouteUiStream(request, fallback);
}
