import { createRequire } from "module";
import { corsHeaders, preflightResponse } from "../../../src/security/cors";

const require = createRequire(import.meta.url);
const modelApiSettings = require("../../../src/core/model-api-settings");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonResponse(request, body, status = 200) {
  return Response.json(body, {
    status,
    headers: corsHeaders(request)
  });
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function errorResponse(request, err, status = 400) {
  return jsonResponse(
    request,
    {
      error: {
        message: err && err.message ? err.message : String(err),
        code: err && err.code ? err.code : "model_api_settings_error",
        type: "invalid_request_error"
      }
    },
    status
  );
}

export async function OPTIONS(request) {
  return preflightResponse(request);
}

export async function GET(request) {
  return jsonResponse(request, modelApiSettings.modelApiStatus());
}

export async function POST(request) {
  try {
    const body = await readJsonBody(request);
    if (body.action === "test" || body.test === true) {
      return jsonResponse(request, await modelApiSettings.testModelApiSetting(body));
    }
    return jsonResponse(request, modelApiSettings.saveModelApiSetting(body));
  } catch (err) {
    return errorResponse(
      request,
      err,
      err && err.code === "invalid_model_api_provider" ? 404 : err && err.statusCode ? err.statusCode : 400
    );
  }
}
