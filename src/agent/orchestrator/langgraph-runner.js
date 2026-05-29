"use strict";

const { Annotation, END, START, StateGraph } = require("@langchain/langgraph");

const AGENT_ROUTE_GRAPH_NAME = "agent-route-goal-runtime";
const AGENT_ROUTE_GRAPH_NODES = Object.freeze([
  "validate_request",
  "initialize_runtime",
  "plan_or_resume",
  "begin_iteration",
  "select_ready_task",
  "run_ready_task",
  "review_iteration",
  "finalize_goal",
  "complete_run"
]);

const AgentRouteGraphState = Annotation.Root({
  req: Annotation(),
  body: Annotation(),
  nextHandler: Annotation(),
  send: Annotation(),
  phase: Annotation(),
  graphRun: Annotation(),
  runtime: Annotation(),
  next: Annotation(),
  done: Annotation(),
  iteration: Annotation(),
  steps: Annotation({
    reducer: (left = [], right = []) => left.concat(Array.isArray(right) ? right : [right]),
    default: () => []
  }),
  result: Annotation()
});

function assertFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`LangGraph agent runtime expected ${name} to be a function.`);
  }
  return value;
}

function assertObject(value, name) {
  if (!value || typeof value !== "object") {
    throw new TypeError(`LangGraph agent runtime expected ${name} to be an object.`);
  }
  return value;
}

function goalIdFromBody(body = {}) {
  return String(
    body.goal_id || body.goalId || (body.agent_route && (body.agent_route.goal_id || body.agent_route.goalId)) || ""
  );
}

function graphRunMetadata(body = {}) {
  return {
    name: AGENT_ROUTE_GRAPH_NAME,
    goal_id: goalIdFromBody(body),
    nodes: AGENT_ROUTE_GRAPH_NODES.slice(),
    startedAt: new Date().toISOString()
  };
}

function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

function nodeEvent(state, node, status, extra = {}) {
  const send = assertFunction(state.send, "send");
  const graphRun = state.graphRun || graphRunMetadata(state.body);
  send("langgraph", {
    goal_id: graphRun.goal_id,
    graph: graphRun,
    node,
    status,
    ...extra
  });
}

async function runInstrumentedNode(state, node, execute) {
  const startedAt = Date.now();
  nodeEvent(state, node, "started", {
    phase: state.phase || "",
    iteration: state.iteration || 0
  });
  try {
    const result = await execute();
    nodeEvent(
      {
        ...state,
        ...result
      },
      node,
      "completed",
      {
        elapsedMs: Date.now() - startedAt,
        phase: result.phase || state.phase || "",
        next: result.next || state.next || "",
        done: Boolean(result.done),
        iteration: result.iteration || state.iteration || 0
      }
    );
    return result;
  } catch (err) {
    nodeEvent(state, node, "failed", {
      elapsedMs: Date.now() - startedAt,
      error: errorMessage(err),
      phase: state.phase || "",
      iteration: state.iteration || 0
    });
    throw err;
  }
}

function routeAfterPlan(state = {}) {
  if (state.done) return "complete_run";
  if (state.next === "finalize") return "finalize_goal";
  if (state.next === "review") return "review_iteration";
  if (state.next === "select_task") return "select_ready_task";
  if (state.next === "run_task") return "run_ready_task";
  return "begin_iteration";
}

function routeAfterRuntimeStep(state = {}) {
  if (state.done) return "complete_run";
  if (state.next === "finalize") return "finalize_goal";
  if (state.next === "review") return "review_iteration";
  if (state.next === "select_task") return "select_ready_task";
  if (state.next === "run_task") return "run_ready_task";
  return "begin_iteration";
}

function createAgentRouteLangGraph({ createRuntimeSession }) {
  const makeRuntime = assertFunction(createRuntimeSession, "createRuntimeSession");
  return new StateGraph(AgentRouteGraphState)
    .addNode("validate_request", async (state) => {
      assertObject(state.req, "req");
      assertObject(state.body, "body");
      assertFunction(state.nextHandler, "nextHandler");
      assertFunction(state.send, "send");
      const graphRun = graphRunMetadata(state.body);
      return runInstrumentedNode({ ...state, graphRun }, "validate_request", async () => ({
        phase: "validated",
        graphRun,
        done: false,
        next: "initialize",
        iteration: 0,
        steps: ["validate_request"]
      }));
    })
    .addNode("initialize_runtime", async (state) =>
      runInstrumentedNode(state, "initialize_runtime", async () => {
        const runtime = await makeRuntime(state.req, state.body, state.nextHandler, state.send);
        return {
          phase: "initialized",
          runtime,
          next: "plan",
          done: false,
          iteration: 0,
          steps: ["initialize_runtime"]
        };
      })
    )
    .addNode("plan_or_resume", async (state) =>
      runInstrumentedNode(state, "plan_or_resume", async () => {
        const runtime = assertObject(state.runtime, "runtime");
        const result = await assertFunction(runtime.plan, "runtime.plan").call(runtime);
        return {
          ...result,
          phase: result.done ? "completed" : result.next === "finalize" ? "finalizing" : "iterating",
          runtime,
          steps: ["plan_or_resume"]
        };
      })
    )
    .addNode("begin_iteration", async (state) =>
      runInstrumentedNode(state, "begin_iteration", async () => {
        const runtime = assertObject(state.runtime, "runtime");
        const result = await assertFunction(runtime.beginIteration, "runtime.beginIteration").call(runtime);
        return {
          ...result,
          phase: result.done ? "completed" : result.next === "finalize" ? "finalizing" : "iterating",
          runtime,
          steps: ["begin_iteration"]
        };
      })
    )
    .addNode("select_ready_task", async (state) =>
      runInstrumentedNode(state, "select_ready_task", async () => {
        const runtime = assertObject(state.runtime, "runtime");
        const result = await assertFunction(runtime.selectReadyTask, "runtime.selectReadyTask").call(runtime);
        return {
          ...result,
          phase: result.done ? "completed" : result.next === "finalize" ? "finalizing" : "draining",
          runtime,
          steps: ["select_ready_task"]
        };
      })
    )
    .addNode("run_ready_task", async (state) =>
      runInstrumentedNode(state, "run_ready_task", async () => {
        const runtime = assertObject(state.runtime, "runtime");
        const result = await assertFunction(runtime.runReadyTask, "runtime.runReadyTask").call(runtime);
        return {
          ...result,
          phase: result.done ? "completed" : result.next === "finalize" ? "finalizing" : "draining",
          runtime,
          steps: ["run_ready_task"]
        };
      })
    )
    .addNode("review_iteration", async (state) =>
      runInstrumentedNode(state, "review_iteration", async () => {
        const runtime = assertObject(state.runtime, "runtime");
        const result = await assertFunction(runtime.reviewIteration, "runtime.reviewIteration").call(runtime);
        return {
          ...result,
          phase: result.done ? "completed" : result.next === "finalize" ? "finalizing" : "reviewing",
          runtime,
          steps: ["review_iteration"]
        };
      })
    )
    .addNode("finalize_goal", async (state) =>
      runInstrumentedNode(state, "finalize_goal", async () => {
        const runtime = assertObject(state.runtime, "runtime");
        const result = await assertFunction(runtime.finalize, "runtime.finalize").call(runtime);
        return {
          ...result,
          phase: "finalized",
          runtime,
          done: true,
          next: "complete",
          steps: ["finalize_goal"]
        };
      })
    )
    .addNode("complete_run", async (state) =>
      runInstrumentedNode(state, "complete_run", async () => ({
        phase: "completed",
        done: true,
        next: "end",
        steps: ["complete_run"],
        result: {
          ok: true,
          goal_id: goalIdFromBody(state.body),
          graph: state.graphRun,
          runtimeResult: state.result || null
        }
      }))
    )
    .addEdge(START, "validate_request")
    .addEdge("validate_request", "initialize_runtime")
    .addEdge("initialize_runtime", "plan_or_resume")
    .addConditionalEdges("plan_or_resume", routeAfterPlan, {
      begin_iteration: "begin_iteration",
      select_ready_task: "select_ready_task",
      run_ready_task: "run_ready_task",
      review_iteration: "review_iteration",
      finalize_goal: "finalize_goal",
      complete_run: "complete_run"
    })
    .addConditionalEdges("begin_iteration", routeAfterRuntimeStep, {
      begin_iteration: "begin_iteration",
      select_ready_task: "select_ready_task",
      run_ready_task: "run_ready_task",
      review_iteration: "review_iteration",
      finalize_goal: "finalize_goal",
      complete_run: "complete_run"
    })
    .addConditionalEdges("select_ready_task", routeAfterRuntimeStep, {
      begin_iteration: "begin_iteration",
      select_ready_task: "select_ready_task",
      run_ready_task: "run_ready_task",
      review_iteration: "review_iteration",
      finalize_goal: "finalize_goal",
      complete_run: "complete_run"
    })
    .addConditionalEdges("run_ready_task", routeAfterRuntimeStep, {
      begin_iteration: "begin_iteration",
      select_ready_task: "select_ready_task",
      run_ready_task: "run_ready_task",
      review_iteration: "review_iteration",
      finalize_goal: "finalize_goal",
      complete_run: "complete_run"
    })
    .addConditionalEdges("review_iteration", routeAfterRuntimeStep, {
      begin_iteration: "begin_iteration",
      select_ready_task: "select_ready_task",
      run_ready_task: "run_ready_task",
      review_iteration: "review_iteration",
      finalize_goal: "finalize_goal",
      complete_run: "complete_run"
    })
    .addEdge("finalize_goal", "complete_run")
    .addEdge("complete_run", END)
    .compile({ name: AGENT_ROUTE_GRAPH_NAME });
}

async function runAgentRouteLangGraph({ req, body, nextHandler, send, createRuntimeSession }) {
  const graph = createAgentRouteLangGraph({ createRuntimeSession });
  return graph.invoke({
    req,
    body,
    nextHandler,
    send
  });
}

module.exports = {
  AGENT_ROUTE_GRAPH_NAME,
  AGENT_ROUTE_GRAPH_NODES,
  createAgentRouteLangGraph,
  runAgentRouteLangGraph
};
