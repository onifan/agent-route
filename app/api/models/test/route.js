import { jsonResponse, preflightResponse, readJsonBody } from "../../provider-route-helpers.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request) {
  return preflightResponse(request);
}

export async function POST(request) {
  const body = await readJsonBody(request);
  return jsonResponse(request, {
    ok: true,
    status: "skipped",
    model: body.model || body.fullModel || "",
    message: "Model test endpoint is available; upstream calls are handled by the agent internal model service."
  });
}
