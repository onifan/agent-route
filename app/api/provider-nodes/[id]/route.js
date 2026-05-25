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
  const node = providerSettings.getProviderNode(await routeId(context));
  if (!node)
    return errorResponse(request, { message: "Provider node not found", code: "provider_node_not_found" }, 404);
  return jsonResponse(request, { node });
}

export async function PUT(request, context) {
  try {
    const id = await routeId(context);
    const status = providerSettings.upsertProviderNode({ ...(await readJsonBody(request)), id, prefix: id });
    return jsonResponse(request, {
      node: status.providerNodes.find((item) => item.id === id) || null,
      nodes: status.providerNodes,
      providerSettings: status
    });
  } catch (err) {
    return errorResponse(request, err, 422);
  }
}

export async function DELETE(request, context) {
  try {
    const status = providerSettings.deleteProviderNode(await routeId(context));
    return jsonResponse(request, {
      ok: true,
      nodes: status.providerNodes,
      providerSettings: status
    });
  } catch (err) {
    return errorResponse(request, err);
  }
}
