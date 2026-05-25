export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function disabledResponse() {
  return Response.json(
    {
      error: {
        message: "The public OpenAI-compatible API is disabled. Use /api/agent-route/run for AgentRoute goals.",
        type: "not_found",
        code: "external_compatible_api_disabled"
      }
    },
    { status: 404 }
  );
}

export async function OPTIONS() {
  return disabledResponse();
}

export async function POST() {
  return disabledResponse();
}
