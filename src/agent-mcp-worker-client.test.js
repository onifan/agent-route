"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const workerMcpClient = require("./agent/mcp/client");

async function main() {
  const tools = await workerMcpClient.listWorkerTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes(workerMcpClient.WORKER_MCP_TOOLS.document));
  assert.ok(toolNames.includes(workerMcpClient.WORKER_MCP_TOOLS.web));
  assert.ok(toolNames.includes(workerMcpClient.WORKER_MCP_TOOLS.browser));
  assert.ok(toolNames.includes(workerMcpClient.WORKER_MCP_TOOLS.files));
  assert.ok(toolNames.includes(workerMcpClient.WORKER_MCP_TOOLS.codex));

  const resource = await workerMcpClient.readWorkerResource();
  assert.match(resource.contents[0].text, /externalExposure/);
  assert.match(resource.contents[0].text, /agentroute\.worker\.codex/);

  const documentResult = await workerMcpClient.callWorkerTool(workerMcpClient.WORKER_MCP_TOOLS.document, {
    task: {
      id: "doc-missing-body",
      type: "document_generate",
      title: "Render a document without content"
    },
    config: {},
    previousResults: []
  });
  assert.equal(documentResult.ok, false);
  assert.equal(documentResult.model, "document-tool");
  assert.match(documentResult.error, /no upstream or explicit content/i);

  const localProject = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-local-read-"));
  fs.writeFileSync(path.join(localProject, "README.md"), "# Local Read Test\n\nhello files worker");
  fs.mkdirSync(path.join(localProject, "src"));
  fs.writeFileSync(path.join(localProject, "src", "index.js"), "console.log('local read');\n");
  const localReadResult = await workerMcpClient.callWorkerTool(workerMcpClient.WORKER_MCP_TOOLS.files, {
    task: {
      id: "local-read",
      type: "local_read",
      toolWorker: "files",
      input: localProject
    },
    config: {}
  });
  assert.equal(localReadResult.ok, true);
  assert.equal(localReadResult.model, "files-tool");
  assert.match(localReadResult.content, /Local directory/);
  assert.match(localReadResult.content, /README\.md/);

  const forwardedLogs = [];
  const codexResult = await workerMcpClient.callWorkerTool(
    workerMcpClient.WORKER_MCP_TOOLS.codex,
    {
      messages: [{ role: "user", content: "Run a fake codex worker" }],
      task: { id: "codex-task", modelPool: "codex-cli" },
      config: {},
      previousResults: [],
      workerMemory: "remember this"
    },
    {
      onCodexLog: (log) => forwardedLogs.push(log),
      runCodexCliTask: async (messages, task, config, previousResults, onLog, workerMemory) => {
        assert.equal(messages[0].role, "user");
        assert.equal(task.id, "codex-task");
        assert.deepEqual(previousResults, []);
        assert.equal(workerMemory, "remember this");
        onLog({ stream: "stdout", text: "fake codex log" });
        return {
          task,
          ok: true,
          model: "codex-cli",
          content: JSON.stringify({ status: "success", output: "done" }),
          error: "",
          elapsedMs: 2
        };
      }
    }
  );
  assert.equal(codexResult.ok, true);
  assert.equal(codexResult.model, "codex-cli");
  assert.equal(forwardedLogs.length, 1);
  assert.equal(forwardedLogs[0].text, "fake codex log");

  const delayedCodexResult = await workerMcpClient.callWorkerTool(
    workerMcpClient.WORKER_MCP_TOOLS.codex,
    {
      task: { id: "delayed-codex-task", modelPool: "codex-cli" }
    },
    {
      runCodexCliTask: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return {
          ok: true,
          model: "codex-cli",
          content: JSON.stringify({ status: "success", output: "delayed" }),
          error: "",
          elapsedMs: 80
        };
      }
    },
    { timeout: 1000 }
  );
  assert.equal(delayedCodexResult.ok, true);
  assert.equal(delayedCodexResult.model, "codex-cli");

  const missingCodexHandler = await workerMcpClient.callWorkerTool(workerMcpClient.WORKER_MCP_TOOLS.codex, {
    task: { id: "missing-codex-handler", modelPool: "codex-cli" }
  });
  assert.equal(missingCodexHandler.ok, false);
  assert.match(missingCodexHandler.error, /handler is not configured/i);

  console.log("agent mcp worker client tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
