import { errorResponse, jsonResponse, preflightResponse, providerSettings } from "../../../provider-route-helpers.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function routeId(context) {
  const params = await context.params;
  return String(params?.id || "");
}

export async function OPTIONS(request) {
  return preflightResponse(request);
}

export async function POST(request, context) {
  try {
    const result = providerSettings.testProviderConnection(await routeId(context));
    return jsonResponse(request, result);
  } catch (err) {
    return errorResponse(request, err, err && err.code === "provider_connection_not_found" ? 404 : 400);
  }
}
