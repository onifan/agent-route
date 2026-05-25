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

export async function POST(request, context) {
  const models = providerSettings.providerModels(await routeId(context)).models || [];
  return jsonResponse(request, {
    ok: true,
    results: models.map((model) => ({
      model: model.id || model,
      ok: true,
      status: "skipped"
    }))
  });
}
