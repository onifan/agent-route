import {
  errorResponse,
  jsonResponse,
  preflightResponse,
  providerSettings,
  readJsonBody
} from "../../provider-route-helpers.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request) {
  return preflightResponse(request);
}

export async function POST(request) {
  try {
    return jsonResponse(request, providerSettings.testProviderBatch(await readJsonBody(request)));
  } catch (err) {
    return errorResponse(request, err);
  }
}
