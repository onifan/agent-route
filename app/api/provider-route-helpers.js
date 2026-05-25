import { createRequire } from "module";

const require = createRequire(import.meta.url);
const providerSettings = require("../../src/core/providers");
const { corsHeaders, preflightResponse } = require("../../src/security/cors");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function jsonResponse(request, body, status = 200) {
  return Response.json(body, {
    status,
    headers: corsHeaders(request)
  });
}

export function errorResponse(request, err, status = 400) {
  return jsonResponse(
    request,
    {
      error: {
        message: err && err.message ? err.message : String(err),
        code: err && err.code ? err.code : "provider_error",
        type: "invalid_request_error"
      }
    },
    status
  );
}

export async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export { preflightResponse, providerSettings };
