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
  return jsonResponse(request, {
    nodes: providerSettings.listProviderNodes()
  });
}

export async function POST(request) {
  try {
    const status = providerSettings.upsertProviderNode(await readJsonBody(request));
    return jsonResponse(
      request,
      {
        nodes: status.providerNodes,
        providerSettings: status
      },
      201
    );
  } catch (err) {
    return errorResponse(request, err, 422);
  }
}
