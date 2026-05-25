import {
  errorResponse,
  jsonResponse,
  preflightResponse,
  providerSettings,
  readJsonBody
} from "../../provider-route-helpers.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function routeId(context) {
  const params = await context.params;
  return String(params?.id || "");
}

export async function OPTIONS(request) {
  return preflightResponse(request);
}

export async function GET(request, context) {
  const id = await routeId(context);
  const details = providerSettings.providerDetails(id);
  if (!details.connection && !details.provider && !details.providerNode) {
    return errorResponse(request, { message: "Provider not found", code: "provider_not_found" }, 404);
  }
  return jsonResponse(request, details);
}

export async function PUT(request, context) {
  try {
    const id = await routeId(context);
    const body = await readJsonBody(request);
    const status = providerSettings.updateProviderConnection(id, body);
    return jsonResponse(request, {
      connection: status.connections.find((item) => item.id === id) || null,
      connections: status.connections,
      providerSettings: status
    });
  } catch (err) {
    return errorResponse(request, err, err && err.code === "provider_connection_not_found" ? 404 : 400);
  }
}

export async function DELETE(request, context) {
  try {
    const id = await routeId(context);
    const status = providerSettings.deleteProviderConnection(id);
    return jsonResponse(request, {
      ok: true,
      connections: status.connections,
      providerSettings: status
    });
  } catch (err) {
    return errorResponse(request, err, err && err.code === "provider_connection_not_found" ? 404 : 400);
  }
}
