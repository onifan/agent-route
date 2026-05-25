"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

const taskRuntime = require("./agent/tasks");
const memoryRuntime = require("./agent/memory");
const observabilityRuntime = require("./agent/observability");
const { createAgentRouteMcpServer } = require("./agent/mcp/server");

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-mcp-"));
  taskRuntime.setStorageFile(path.join(tmp, "tasks.json"));
  memoryRuntime.setStorageFile(path.join(tmp, "memory.json"));
  observabilityRuntime.setStorageFile(path.join(tmp, "events.json"));
  process.env.AGENT_ROUTE_ARTIFACTS = path.join(tmp, "artifacts.json");

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createAgentRouteMcpServer();
  const client = new Client({ name: "agent-route-mcp-test", version: "1.0.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("agentroute.create_goal"));
  assert.ok(toolNames.includes("agentroute.get_graph"));
  assert.ok(toolNames.includes("agentroute.search_memories"));

  const createResult = await client.callTool({
    name: "agentroute.create_goal",
    arguments: {
      goalId: "mcp-test-goal",
      goal: "Check MCP server",
      tasks: [
        {
          id: "mcp-task",
          title: "MCP task",
          description: "Verify MCP tool/resource wiring",
          successCriteria: ["MCP client can read this task"]
        }
      ]
    }
  });
  assert.equal(createResult.structuredContent.goal_id, "mcp-test-goal");
  assert.equal(createResult.structuredContent.tasks.length, 1);

  const graphResult = await client.callTool({
    name: "agentroute.get_graph",
    arguments: { goalId: "mcp-test-goal" }
  });
  assert.equal(graphResult.structuredContent.goal_id, "mcp-test-goal");
  assert.ok(graphResult.structuredContent.graph);

  const templates = await client.listResourceTemplates();
  const templateUris = templates.resourceTemplates.map((template) => template.uriTemplate);
  assert.ok(templateUris.includes("agentroute://goals/{goalId}"));
  assert.ok(templateUris.includes("agentroute://tasks/{goalId}/{taskId}"));

  const taskResource = await client.readResource({
    uri: "agentroute://tasks/mcp-test-goal/mcp-task"
  });
  assert.match(taskResource.contents[0].text, /MCP task/);

  const prompt = await client.getPrompt({
    name: "agentroute.planner",
    arguments: {
      goalId: "mcp-test-goal",
      goal: "Plan a safe MCP verification task"
    }
  });
  assert.equal(prompt.messages.length, 1);
  assert.match(prompt.messages[0].content.text, /AgentRoute Structured Output Schema/);

  await client.close();
  await server.close();
  console.log("agent mcp server tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
