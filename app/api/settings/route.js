import { jsonResponse, preflightResponse, readJsonBody } from "../provider-route-helpers.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let runtimeSettings = {
  providerStrategies: {},
  providerThinking: {}
};

export async function OPTIONS(request) {
  return preflightResponse(request);
}

export async function GET(request) {
  return jsonResponse(request, runtimeSettings);
}

export async function PATCH(request) {
  const body = await readJsonBody(request);
  runtimeSettings = {
    ...runtimeSettings,
    ...body,
    providerStrategies: {
      ...runtimeSettings.providerStrategies,
      ...(body.providerStrategies || {})
    },
    providerThinking: {
      ...runtimeSettings.providerThinking,
      ...(body.providerThinking || {})
    }
  };
  return jsonResponse(request, runtimeSettings);
}
