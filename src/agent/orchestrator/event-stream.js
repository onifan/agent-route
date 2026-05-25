"use strict";

const { corsHeaders } = require("../../security/cors");

function redactStreamText(value, maxLength = 1200) {
  const text = String(value || "")
    .replace(
      /([?&][^=&#]*(?:token|key|cookie|password|secret|authorization|code|session)[^=&#]*=)[^&#\s]+/gi,
      "$1[REDACTED]"
    )
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|passwd|pwd|cookie|secret|authorization|oauth[_-]?code)\b\s*[:=]\s*['"]?[^'"\s&]{4,}/gi,
      "$1=[REDACTED]"
    )
    .replace(/\/Users\/[^/\s]+/g, "/Users/[REDACTED]");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function compactStreamValue(value, key = "", depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") {
    const limit = /^(content|output|result)$/i.test(key) ? 50000 : 4000;
    return redactStreamText(value, limit);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 5) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 60).map((item) => compactStreamValue(item, key, depth + 1));
  if (typeof value !== "object") return redactStreamText(value, 1200);
  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    output[childKey] = compactStreamValue(childValue, childKey, depth + 1);
  }
  return output;
}

function summarizeTask(task = {}) {
  if (!task || typeof task !== "object") return null;
  return {
    id: task.id || "",
    title: task.title || task.description || "",
    status: task.status || "",
    error: redactStreamText(task.error || "", 900),
    blockedReason: redactStreamText(task.blockedReason || "", 900),
    result: redactStreamText(task.result || task.content || "", 900)
  };
}

function summarizeEvent(event, data = {}) {
  if (!data || typeof data !== "object") return null;
  const task = data.task && typeof data.task === "object" ? data.task : null;
  const status =
    data.status ||
    data.finalStatus ||
    data.final_status ||
    (event === "error" ? "failed" : "") ||
    (task && task.status) ||
    "";
  const failedStatus = /failed|blocked|waiting/i.test(String(status || ""));
  const message = firstText(
    data.failureReason,
    data.failure_reason,
    data.message,
    data.error,
    data.reason,
    data.blockedReason,
    task && task.blockedReason,
    task && task.error,
    failedStatus ? data.content : ""
  );
  const shouldKeep =
    event === "final" ||
    event === "error" ||
    event === "pause" ||
    (event === "worker_done" && (message || /failed|blocked|waiting/i.test(String(status || "")))) ||
    (event === "verification" && (message || /failed|blocked|waiting/i.test(String(status || ""))));
  if (!shouldKeep) return null;
  const normalizedStatus =
    event === "final" ? (failedStatus ? status : "completed") : status || (message ? "blocked" : "");
  return {
    status: normalizedStatus,
    message: redactStreamText(message, 1000),
    failureReason: /failed|blocked|waiting/i.test(String(normalizedStatus || ""))
      ? redactStreamText(message, 1000)
      : "",
    lastEvent: event,
    task: summarizeTask(task)
  };
}

function streamAgentRouteEvents(run, { observabilityRuntime, request } = {}) {
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat = null;
  function stopHeartbeat() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  }
  return new Response(
    new ReadableStream({
      async start(controller) {
        let currentGoalId = "";
        let finalSummary = null;
        const write = (text) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            closed = true;
            stopHeartbeat();
          }
        };
        const send = (event, data = {}) => {
          if (data && (data.goal_id || data.goalId)) currentGoalId = String(data.goal_id || data.goalId);
          const enrichedData =
            currentGoalId && data && !data.goal_id && !data.goalId ? { goal_id: currentGoalId, ...data } : data;
          const streamData = compactStreamValue(enrichedData);
          if (event !== "done") {
            const summary = summarizeEvent(event, streamData);
            if (summary) finalSummary = summary;
          }
          try {
            if (observabilityRuntime && typeof observabilityRuntime.recordEvent === "function") {
              observabilityRuntime.recordEvent(event, streamData, {
                source: "agent-route-sse",
                goalId: currentGoalId
              });
            }
          } catch (err) {
            console.warn("[agent-route] failed to record observability event:", err.message);
          }
          write(`event: ${event}\ndata: ${JSON.stringify(streamData)}\n\n`);
        };
        heartbeat = setInterval(() => write(": agent-route working\n\n"), 4000);

        try {
          await run(send);
        } catch (err) {
          send("error", {
            message: err && err.message ? err.message : String(err)
          });
        } finally {
          stopHeartbeat();
          send("done", {
            at: new Date().toISOString(),
            ...(finalSummary || {})
          });
          closed = true;
          try {
            controller.close();
          } catch {
            // The browser may have already closed the SSE connection.
          }
        }
      },
      cancel() {
        closed = true;
        stopHeartbeat();
      }
    }),
    {
      headers: corsHeaders(request, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "x-agent-route": "agent-auto"
      })
    }
  );
}

module.exports = {
  streamAgentRouteEvents,
  summarizeEvent
};
