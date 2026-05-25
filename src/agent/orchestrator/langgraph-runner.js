"use strict";

const { Annotation, END, START, StateGraph } = require("@langchain/langgraph");

const AgentRouteGraphState = Annotation.Root({
  req: Annotation(),
  body: Annotation(),
  nextHandler: Annotation(),
  send: Annotation(),
  phase: Annotation(),
  graphRun: Annotation(),
  steps: Annotation({
    reducer: (left = [], right = []) => left.concat(Array.isArray(right) ? right : [right]),
    default: () => []
  }),
  result: Annotation()
});

const AGENT_ROUTE_GRAPH_NAME = "agent-route-goal-runtime";
const AGENT_ROUTE_GRAPH_NODES = Object.freeze(["validate_request", "prepare_run", "execute_goal", "complete_run"]);

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
  nodeEvent(state, node, "started");
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
        elapsedMs: Date.now() - startedAt
      }
    );
    return result;
  } catch (err) {
    nodeEvent(state, node, "failed", {
      elapsedMs: Date.now() - startedAt,
      error: errorMessage(err)
    });
    throw err;
  }
}

function createAgentRouteLangGraph({ runAgentRouteEvents }) {
  const executeGoal = assertFunction(runAgentRouteEvents, "runAgentRouteEvents");
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
        steps: ["validate_request"]
      }));
    })
    .addNode("prepare_run", async (state) =>
      runInstrumentedNode(state, "prepare_run", async () => ({
        phase: "prepared",
        graphRun: state.graphRun || graphRunMetadata(state.body),
        steps: ["prepare_run"]
      }))
    )
    .addNode("execute_goal", async (state) =>
      runInstrumentedNode(state, "execute_goal", async () => {
        await executeGoal(state.req, state.body, state.nextHandler, state.send);
        return {
          phase: "executed",
          steps: ["execute_goal"]
        };
      })
    )
    .addNode("complete_run", async (state) =>
      runInstrumentedNode(state, "complete_run", async () => ({
        phase: "completed",
        steps: ["complete_run"],
        result: {
          ok: true,
          goal_id: goalIdFromBody(state.body),
          graph: state.graphRun
        }
      }))
    )
    .addEdge(START, "validate_request")
    .addEdge("validate_request", "prepare_run")
    .addEdge("prepare_run", "execute_goal")
    .addEdge("execute_goal", "complete_run")
    .addEdge("complete_run", END)
    .compile({ name: AGENT_ROUTE_GRAPH_NAME });
}

async function runAgentRouteLangGraph({ req, body, nextHandler, send, runAgentRouteEvents }) {
  const graph = createAgentRouteLangGraph({ runAgentRouteEvents });
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
