import { jsonResponse, preflightResponse, readJsonBody } from "../../provider-route-helpers.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const disabledByProvider = new Map();

function providerKeyFromRequest(request) {
  const url = new URL(request.url);
  return String(url.searchParams.get("providerAlias") || "default");
}

export async function OPTIONS(request) {
  return preflightResponse(request);
}

export async function GET(request) {
  const key = providerKeyFromRequest(request);
  return jsonResponse(request, { ids: Array.from(disabledByProvider.get(key) || []) });
}

export async function POST(request) {
  const body = await readJsonBody(request);
  const key = String(body.providerAlias || "default");
  const set = disabledByProvider.get(key) || new Set();
  for (const id of body.ids || []) set.add(String(id));
  disabledByProvider.set(key, set);
  return jsonResponse(request, { ids: Array.from(set) });
}

export async function DELETE(request) {
  const url = new URL(request.url);
  const key = providerKeyFromRequest(request);
  const id = url.searchParams.get("id");
  if (!id) {
    disabledByProvider.delete(key);
    return jsonResponse(request, { ids: [] });
  }
  const set = disabledByProvider.get(key) || new Set();
  set.delete(id);
  disabledByProvider.set(key, set);
  return jsonResponse(request, { ids: Array.from(set) });
}
