import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { handleMcpRequest } = require("../../../src/agent/mcp/server.js");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function OPTIONS(request) {
  return handleMcpRequest(request);
}

export async function GET(request) {
  return handleMcpRequest(request);
}

export async function POST(request) {
  return handleMcpRequest(request);
}

export async function DELETE(request) {
  return handleMcpRequest(request);
}
