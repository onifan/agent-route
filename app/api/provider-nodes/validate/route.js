import { jsonResponse, preflightResponse, providerSettings, readJsonBody } from "../../provider-route-helpers.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request) {
  return preflightResponse(request);
}

export async function POST(request) {
  const result = providerSettings.validateProviderNode(await readJsonBody(request));
  return jsonResponse(request, result, result.valid ? 200 : 422);
}
