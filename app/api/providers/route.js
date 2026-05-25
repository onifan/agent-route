import {
  errorResponse,
  jsonResponse,
  preflightResponse,
  providerSettings,
  readJsonBody
} from "../provider-route-helpers.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request) {
  return preflightResponse(request);
}

export async function GET(request) {
  const status = providerSettings.providerStatus();
  return jsonResponse(request, {
    connections: status.connections,
    providers: status.supportedProviders,
    supportedProviders: status.supportedProviders,
    providerGroups: status.providerGroups,
    providerNodes: status.providerNodes
  });
}

export async function POST(request) {
  try {
    const body = await readJsonBody(request);
    const status = providerSettings.createProviderConnection(body);
    const created = status.connections.find((item) => item.id === body.id) || status.connections[0] || null;
    return jsonResponse(
      request,
      {
        connection: created,
        connections: status.connections,
        providerSettings: status
      },
      201
    );
  } catch (err) {
    return errorResponse(request, err, err && err.code === "provider_api_key_required" ? 422 : 400);
  }
}
