"use strict";

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const z = require("zod/v4");

const browserWorker = require("../orchestrator/browser-worker");
const documentWorker = require("../orchestrator/document-worker");
const webToolWorker = require("../orchestrator/web-tool-worker");

const WORKER_MCP_TOOLS = Object.freeze({
  document: "agentroute.worker.document",
  web: "agentroute.worker.web",
  browser: "agentroute.worker.browser",
  codex: "agentroute.worker.codex"
});

function serverVersion() {
  try {
    return require("../../../package.json").version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function compactText(value = "", max = 2000) {
  const text = String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, Math.max(1, max - 3))}...` : text;
}

function compactJson(value, maxLength = 20000) {
  const text = JSON.stringify(value, null, 2);
  return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 3))}...` : text;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function resultText(toolName, result = {}) {
  const status = result.ok ? "ok" : "error";
  const elapsed = result.elapsedMs == null ? "" : ` in ${result.elapsedMs}ms`;
  const error = result.ok ? "" : `: ${compactText(result.error || result.content || "Worker tool failed", 400)}`;
  return `${toolName} ${status}${elapsed}${error}`;
}

function workerToolResult(toolName, result = {}) {
  const normalized = asObject(result);
  return {
    structuredContent: {
      ok: normalized.ok !== false,
      tool: toolName,
      result: normalized,
      error: normalized.ok === false ? String(normalized.error || "") : ""
    },
    content: [
      {
        type: "text",
        text: resultText(toolName, normalized)
      }
    ],
    isError: normalized.ok === false
  };
}

function failedWorkerResult(toolName, err, startedAt = Date.now()) {
  const error = err && err.message ? err.message : String(err);
  return workerToolResult(toolName, {
    ok: false,
    model: "mcp-worker",
    content: JSON.stringify({
      status: "failure",
      error
    }),
    error,
    elapsedMs: Date.now() - startedAt,
    actions: [`${toolName}:error`]
  });
}

async function executeWorkerTool(toolName, execute) {
  const startedAt = Date.now();
  try {
    return workerToolResult(toolName, await execute());
  } catch (err) {
    return failedWorkerResult(toolName, err, startedAt);
  }
}

const objectSchema = z.record(z.string(), z.unknown());
const workerInputSchema = {
  task: objectSchema.optional().default({}),
  config: objectSchema.optional().default({}),
  messages: z.array(objectSchema).optional().default([]),
  previousResults: z.array(objectSchema).optional().default([]),
  workerMemory: z.string().optional().default("")
};

function registerWorkerTools(server, handlers = {}) {
  server.registerTool(
    WORKER_MCP_TOOLS.document,
    {
      title: "Run AgentRoute Document Worker",
      description: "Render a document worker task through the internal AgentRoute worker boundary.",
      inputSchema: {
        task: workerInputSchema.task,
        config: workerInputSchema.config,
        previousResults: workerInputSchema.previousResults
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ task = {}, config = {}, previousResults = [] }) =>
      executeWorkerTool(WORKER_MCP_TOOLS.document, () =>
        documentWorker.runDocumentWorker(asObject(task), asObject(config), asArray(previousResults))
      )
  );

  server.registerTool(
    WORKER_MCP_TOOLS.web,
    {
      title: "Run AgentRoute Web Worker",
      description: "Run a read-only public web worker task through the internal AgentRoute worker boundary.",
      inputSchema: {
        task: workerInputSchema.task,
        config: workerInputSchema.config,
        messages: workerInputSchema.messages
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ task = {}, config = {}, messages = [] }) =>
      executeWorkerTool(WORKER_MCP_TOOLS.web, () =>
        webToolWorker.runWebToolWorker(asObject(task), asObject(config), asArray(messages))
      )
  );

  server.registerTool(
    WORKER_MCP_TOOLS.browser,
    {
      title: "Run AgentRoute Browser Worker",
      description: "Open and snapshot a browser worker task through the internal AgentRoute worker boundary.",
      inputSchema: {
        task: workerInputSchema.task,
        config: workerInputSchema.config
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ task = {}, config = {} }) =>
      executeWorkerTool(WORKER_MCP_TOOLS.browser, () =>
        browserWorker.runBrowserWorker(asObject(task), asObject(config))
      )
  );

  server.registerTool(
    WORKER_MCP_TOOLS.codex,
    {
      title: "Run AgentRoute Codex Worker",
      description:
        "Run a codex-cli worker task through the internal AgentRoute worker boundary. External MCP clients never receive this tool.",
      inputSchema: workerInputSchema,
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ messages = [], task = {}, config = {}, previousResults = [], workerMemory = "" }) =>
      executeWorkerTool(WORKER_MCP_TOOLS.codex, async () => {
        if (typeof handlers.runCodexCliTask !== "function") {
          return {
            task,
            ok: false,
            model: "codex-cli",
            content: JSON.stringify({
              status: "failure",
              error: "Codex worker handler is not configured."
            }),
            error: "Codex worker handler is not configured.",
            elapsedMs: 0,
            actions: ["codex:mcp_handler_missing"]
          };
        }
        return handlers.runCodexCliTask(
          asArray(messages),
          asObject(task),
          asObject(config),
          asArray(previousResults),
          handlers.onCodexLog,
          String(workerMemory || "")
        );
      })
  );
}

function registerWorkerResources(server) {
  server.registerResource(
    "agentroute-worker-tools",
    "agentroute-worker://tools",
    {
      title: "AgentRoute Internal Worker MCP Tools",
      description: "Internal-only MCP tools available to the AgentRoute worker dispatcher.",
      mimeType: "application/json"
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: compactJson({
            tools: Object.values(WORKER_MCP_TOOLS),
            externalExposure: false,
            riskBoundary:
              "Worker tools are only available in-process after AgentRoute budget, risk and approval gates have run."
          })
        }
      ]
    })
  );
}

function createAgentRouteWorkerMcpServer(handlers = {}) {
  const server = new McpServer({
    name: "agent-route-worker-internal",
    version: serverVersion()
  });
  registerWorkerTools(server, handlers);
  registerWorkerResources(server);
  return server;
}

function extractWorkerResult(callResult = {}) {
  const structured = callResult.structuredContent || {};
  if (structured && structured.result && typeof structured.result === "object") return structured.result;
  const firstText =
    callResult.content &&
    callResult.content.find &&
    callResult.content.find((item) => item && item.type === "text" && item.text);
  if (firstText) {
    return {
      ok: !callResult.isError,
      model: "mcp-worker",
      content: firstText.text,
      error: callResult.isError ? firstText.text : ""
    };
  }
  return {
    ok: !callResult.isError,
    model: "mcp-worker",
    content: "",
    error: callResult.isError ? "MCP worker returned an error without content." : ""
  };
}

async function withInternalWorkerMcpClient(handlers, callback) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createAgentRouteWorkerMcpServer(handlers);
  const client = new Client({
    name: "agent-route-worker-client",
    version: serverVersion()
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await callback(client);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

async function listWorkerTools(handlers = {}) {
  return withInternalWorkerMcpClient(handlers, async (client) => client.listTools());
}

async function readWorkerResource(uri = "agentroute-worker://tools", handlers = {}) {
  return withInternalWorkerMcpClient(handlers, async (client) => client.readResource({ uri }));
}

async function callWorkerTool(toolName, args = {}, handlers = {}, requestOptions = {}) {
  return withInternalWorkerMcpClient(handlers, async (client) => {
    const result = await client.callTool(
      {
        name: toolName,
        arguments: args
      },
      undefined,
      requestOptions
    );
    return extractWorkerResult(result);
  });
}

module.exports = {
  WORKER_MCP_TOOLS,
  callWorkerTool,
  createAgentRouteWorkerMcpServer,
  listWorkerTools,
  readWorkerResource
};
