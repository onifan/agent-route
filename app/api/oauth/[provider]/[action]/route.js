import { createRequire } from "module";
import { jsonResponse, preflightResponse, readJsonBody } from "../../../provider-route-helpers.js";

const require = createRequire(import.meta.url);
const { handleOAuthRequest } = require("../../../../../src/core/providers/oauth-runtime");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function routeParams(context) {
  const params = await context.params;
  return {
    provider: String(params?.provider || ""),
    action: String(params?.action || "")
  };
}

async function dispatchOAuth(request, context, method) {
  const params = await routeParams(context);
  try {
    const url = new URL(request.url);
    const body = method === "POST" ? await readJsonBody(request) : {};
    const result = await handleOAuthRequest({
      method,
      provider: params.provider,
      action: params.action,
      body,
      searchParams: url.searchParams
    });
    return jsonResponse(request, result.body, result.status);
  } catch (err) {
    return jsonResponse(
      request,
      {
        valid: false,
        provider: params.provider,
        action: params.action,
        error: err && err.message ? err.message : String(err),
        code: err && err.code ? err.code : "oauth_route_error"
      },
      500
    );
  }
}

export async function OPTIONS(request) {
  return preflightResponse(request);
}

export async function GET(request, context) {
  return dispatchOAuth(request, context, "GET");
}

export async function POST(request, context) {
  return dispatchOAuth(request, context, "POST");
}
