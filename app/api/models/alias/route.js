import { jsonResponse, preflightResponse, providerSettings, readJsonBody } from "../../provider-route-helpers.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let aliases = {};

function readAliases() {
  try {
    aliases = providerSettings.readModelAliases();
  } catch {
    // Keep the endpoint usable in environments where the optional SQLite binding is unavailable.
  }
  return aliases;
}

export async function OPTIONS(request) {
  return preflightResponse(request);
}

export async function GET(request) {
  return jsonResponse(request, { aliases: readAliases() });
}

function upsertAlias(body = {}) {
  const alias = String(body.alias || "").trim();
  const target = String(body.target || body.model || body.fullModel || "").trim();
  if (!alias || !target) {
    return {
      ok: false,
      error: "缺少 alias 或目标模型。"
    };
  }
  try {
    aliases = providerSettings.upsertModelAlias(alias, target);
  } catch {
    aliases = { ...aliases, [alias]: target };
  }
  return { ok: true, aliases };
}

export async function POST(request) {
  const body = await readJsonBody(request);
  const result = upsertAlias(body);
  return jsonResponse(request, result, result.ok ? 200 : 400);
}

export async function PUT(request) {
  const body = await readJsonBody(request);
  const result = upsertAlias(body);
  return jsonResponse(request, result, result.ok ? 200 : 400);
}

export async function DELETE(request) {
  const url = new URL(request.url);
  const alias = url.searchParams.get("alias");
  if (alias) {
    try {
      aliases = providerSettings.deleteModelAlias(alias);
    } catch {
      const next = { ...aliases };
      delete next[alias];
      aliases = next;
    }
  }
  return jsonResponse(request, { aliases: readAliases() });
}
