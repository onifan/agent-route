"use strict";

const assert = require("node:assert/strict");

const langGraphRunner = require("./agent/orchestrator/langgraph-runner");

async function main() {
  const events = [];
  const result = await langGraphRunner.runAgentRouteLangGraph({
    req: { method: "POST" },
    body: { goal_id: "langgraph-test-goal", goal: "verify langgraph runner" },
    nextHandler: async () => new Response("{}"),
    send: (event, data) => events.push({ event, data }),
    runAgentRouteEvents: async (req, body, nextHandler, send) => {
      assert.equal(req.method, "POST");
      assert.equal(body.goal_id, "langgraph-test-goal");
      assert.equal(typeof nextHandler, "function");
      send("final", {
        goal_id: body.goal_id,
        content: "done"
      });
    }
  });

  assert.equal(result.phase, "completed");
  assert.equal(result.result.ok, true);
  assert.equal(result.result.goal_id, "langgraph-test-goal");
  assert.deepEqual(result.steps, langGraphRunner.AGENT_ROUTE_GRAPH_NODES);
  assert.equal(result.graphRun.name, langGraphRunner.AGENT_ROUTE_GRAPH_NAME);
  assert.equal(result.graphRun.goal_id, "langgraph-test-goal");
  assert.deepEqual(result.graphRun.nodes, langGraphRunner.AGENT_ROUTE_GRAPH_NODES);
  assert.equal(result.result.graph.name, langGraphRunner.AGENT_ROUTE_GRAPH_NAME);
  const graphEvents = events.filter((event) => event.event === "langgraph");
  assert.deepEqual(
    graphEvents.map((event) => `${event.data.node}:${event.data.status}`),
    [
      "validate_request:started",
      "validate_request:completed",
      "prepare_run:started",
      "prepare_run:completed",
      "execute_goal:started",
      "execute_goal:completed",
      "complete_run:started",
      "complete_run:completed"
    ]
  );
  assert.ok(events.some((event) => event.event === "final"));

  const errorEvents = [];
  await assert.rejects(
    () =>
      langGraphRunner.runAgentRouteLangGraph({
        req: { method: "POST" },
        body: { goal_id: "langgraph-error-goal" },
        nextHandler: async () => new Response("{}"),
        send: (event, data) => errorEvents.push({ event, data }),
        runAgentRouteEvents: async () => {
          throw new Error("langgraph direct failure");
        }
      }),
    /langgraph direct failure/
  );
  assert.ok(
    errorEvents.some(
      (event) =>
        event.event === "langgraph" &&
        event.data.node === "execute_goal" &&
        event.data.status === "failed" &&
        /langgraph direct failure/.test(event.data.error)
    )
  );

  await assert.rejects(
    () =>
      langGraphRunner.runAgentRouteLangGraph({
        req: { method: "POST" },
        body: { goal_id: "langgraph-invalid-goal" },
        nextHandler: null,
        send: () => {},
        runAgentRouteEvents: async () => {}
      }),
    /nextHandler/
  );

  console.log("agent langgraph runner tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
