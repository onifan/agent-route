import { jsonResponse, preflightResponse } from "../../provider-route-helpers.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request) {
  return preflightResponse(request);
}

export async function GET(request) {
  return jsonResponse(request, {
    models: [],
    unavailableCount: 0
  });
}

export async function POST(request) {
  return jsonResponse(request, { ok: true, models: [], unavailableCount: 0 });
}
