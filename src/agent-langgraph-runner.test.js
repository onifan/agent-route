"use strict";

const assert = require("node:assert/strict");

const langGraphRunner = require("./agent/orchestrator/langgraph-runner");

async function main() {
  const events = [];
  let iterations = 0;
  let workersRun = 0;
  const result = await langGraphRunner.runAgentRouteLangGraph({
    req: { method: "POST" },
    body: { goal_id: "langgraph-test-goal", goal: "verify langgraph runner" },
    nextHandler: async () => new Response("{}"),
    send: (event, data) => events.push({ event, data }),
    createRuntimeSession: async (req, body, nextHandler, send) => {
      assert.equal(req.method, "POST");
      assert.equal(body.goal_id, "langgraph-test-goal");
      assert.equal(typeof nextHandler, "function");
      return {
        async plan() {
          return { done: false, next: "begin_iteration", iteration: 0 };
        },
        async beginIteration() {
          iterations += 1;
          workersRun = 0;
          return {
            done: false,
            next: "select_task",
            iteration: iterations
          };
        },
        async selectReadyTask() {
          return {
            done: false,
            next: workersRun >= 2 ? "review" : "run_task",
            iteration: iterations
          };
        },
        async runReadyTask() {
          workersRun += 1;
          return {
            done: false,
            next: "select_task",
            iteration: iterations
          };
        },
        async reviewIteration() {
          return { done: false, next: "finalize", iteration: iterations };
        },
        async finalize() {
          send("final", {
            goal_id: body.goal_id,
            content: "done"
          });
          return { done: true, next: "complete", reason: "final", iteration: iterations };
        }
      };
    }
  });

  assert.equal(result.phase, "completed");
  assert.equal(result.result.ok, true);
  assert.equal(result.result.goal_id, "langgraph-test-goal");
  assert.deepEqual(result.steps, [
    "validate_request",
    "initialize_runtime",
    "plan_or_resume",
    "begin_iteration",
    "select_ready_task",
    "run_ready_task",
    "select_ready_task",
    "run_ready_task",
    "select_ready_task",
    "review_iteration",
    "finalize_goal",
    "complete_run"
  ]);
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
      "initialize_runtime:started",
      "initialize_runtime:completed",
      "plan_or_resume:started",
      "plan_or_resume:completed",
      "begin_iteration:started",
      "begin_iteration:completed",
      "select_ready_task:started",
      "select_ready_task:completed",
      "run_ready_task:started",
      "run_ready_task:completed",
      "select_ready_task:started",
      "select_ready_task:completed",
      "run_ready_task:started",
      "run_ready_task:completed",
      "select_ready_task:started",
      "select_ready_task:completed",
      "review_iteration:started",
      "review_iteration:completed",
      "finalize_goal:started",
      "finalize_goal:completed",
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
        createRuntimeSession: async () => ({
          async plan() {
            return { done: false, next: "begin_iteration" };
          },
          async beginIteration() {
            return { done: false, next: "run_task" };
          },
          async runReadyTask() {
            throw new Error("langgraph worker failure");
          },
          async selectReadyTask() {
            return { done: false, next: "run_task" };
          },
          async reviewIteration() {
            return { done: false, next: "finalize" };
          },
          async finalize() {
            return { done: true, next: "complete" };
          }
        })
      }),
    /langgraph worker failure/
  );
  assert.ok(
    errorEvents.some(
      (event) =>
        event.event === "langgraph" &&
        event.data.node === "run_ready_task" &&
        event.data.status === "failed" &&
        /langgraph worker failure/.test(event.data.error)
    )
  );

  await assert.rejects(
    () =>
      langGraphRunner.runAgentRouteLangGraph({
        req: { method: "POST" },
        body: { goal_id: "langgraph-invalid-goal" },
        nextHandler: null,
        send: () => {},
        createRuntimeSession: async () => ({})
      }),
    /nextHandler/
  );

  console.log("agent langgraph runner tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
