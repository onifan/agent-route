import { jsonResponse, preflightResponse, providerSettings } from "../../../provider-route-helpers.js";

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
  return jsonResponse(request, providerSettings.providerModels(await routeId(context)));
}
