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

function uiDataPartTypeForEvent(event = "") {
  const key = String(event || "").toLowerCase();
  if (key === "start") return "data-agent-run";
  if (key === "plan") return "data-agent-plan";
  if (key === "graph") return "data-agent-graph";
  if (key === "strategy") return "data-agent-strategy";
  if (key === "memory") return "data-agent-memory";
  if (key === "budget") return "data-agent-budget";
  if (key === "risk") return "data-agent-risk";
  if (key === "verification" || key.startsWith("authenticity")) return "data-agent-verification";
  if (key === "worker_start" || key === "worker_log" || key === "worker_done") return "data-agent-task";
  if (
    key === "correctiveactionsuggested" ||
    key === "actionranked" ||
    key === "actionlearningupdated" ||
    key === "decisionattributed"
  ) {
    return "data-agent-action";
  }
  if (key === "pause") return "data-agent-pause";
  if (key === "final") return "data-agent-final";
  if (key === "error") return "data-agent-error";
  if (key === "done") return "data-agent-done";
  return "data-agent-event";
}

function uiDataPartIdForEvent(event = "", data = {}, sequence = 0) {
  const goalId = data.goal_id || data.goalId || "goal";
  const taskId = data.task_id || data.taskId || (data.task && data.task.id) || "";
  const key = String(event || "").toLowerCase();
  if (taskId) {
    if (key === "worker_start" || key === "worker_done") return `${goalId}:task:${taskId}:worker`;
    if (key === "worker_log") return `${goalId}:task:${taskId}:worker_log:${sequence}`;
    if (
      key === "model_attempt" ||
      key === "model_success" ||
      key === "model_failure" ||
      key === "model_timeout" ||
      key === "model_retry" ||
      key === "model_failover"
    ) {
      return `${goalId}:task:${taskId}:model`;
    }
    return `${goalId}:task:${taskId}:${key || "event"}`;
  }
  if (key === "graph") return `${goalId}:graph`;
  if (key === "strategy") return `${goalId}:strategy`;
  if (key === "budget") return `${goalId}:budget`;
  if (key === "final") return `${goalId}:final`;
  if (key === "pause") return `${goalId}:pause`;
  if (key === "done") return `${goalId}:done`;
  return `${goalId}:${key || "event"}:${sequence}`;
}

function uiDataPartForEvent(event, data, sequence) {
  const key = String(event || "").toLowerCase();
  return {
    type: uiDataPartTypeForEvent(event),
    id: uiDataPartIdForEvent(event, data, sequence),
    data: {
      event,
      payload: data
    },
    transient: key === "worker_log"
  };
}

function finalTextChunks(content = "", maxLength = 24) {
  const text = String(content || "");
  const chunks = [];
  let buffer = "";
  for (const char of text) {
    buffer += char;
    if (buffer.length >= maxLength || /[。！？.!?\n]/.test(char)) {
      chunks.push(buffer);
      buffer = "";
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeFinalTextPart(writer, data = {}) {
  const content = String(data.content || data.answerMarkdown || "").trim();
  if (!content) return;
  const goalId = data.goal_id || data.goalId || "goal";
  const id = `${goalId}:final-text`;
  writer.write({ type: "text-start", id });
  for (const delta of finalTextChunks(content)) {
    writer.write({ type: "text-delta", id, delta });
    await wait(content.length > 3000 ? 4 : 12);
  }
  writer.write({ type: "text-end", id });
}

async function streamAgentRouteUiMessages(run, { observabilityRuntime, request } = {}) {
  const { createUIMessageStream, createUIMessageStreamResponse } = await import("ai");
  const stream = createUIMessageStream({
    async execute({ writer }) {
      let currentGoalId = "";
      let finalSummary = null;
      let sequence = 0;
      let heartbeat = null;
      const pendingTextWrites = [];
      const send = (event, data = {}) => {
        const internalOnly = String(event || "").toLowerCase() === "langgraph";
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
              source: "agent-route-ui-message",
              goalId: currentGoalId
            });
          }
        } catch (err) {
          console.warn("[agent-route] failed to record observability event:", err.message);
        }
        if (!internalOnly) {
          writer.write(uiDataPartForEvent(event, streamData, sequence));
          sequence += 1;
          if (event === "final") pendingTextWrites.push(writeFinalTextPart(writer, streamData));
        }
      };
      heartbeat = setInterval(() => {
        writer.write({
          type: "data-agent-heartbeat",
          id: `${currentGoalId || "goal"}:heartbeat:${Date.now()}`,
          data: { at: new Date().toISOString() },
          transient: true
        });
      }, 4000);

      try {
        await run(send);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        send("error", { message });
        writer.write({ type: "error", errorText: message });
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        await Promise.all(pendingTextWrites);
        send("done", {
          at: new Date().toISOString(),
          ...(finalSummary || {})
        });
      }
    },
    onError: (error) => (error && error.message ? error.message : String(error))
  });

  return createUIMessageStreamResponse({
    stream,
    headers: corsHeaders(request, {
      "Cache-Control": "no-cache",
      "x-agent-route": "agent-auto",
      "x-agent-route-stream": "ui-message"
    })
  });
}

module.exports = {
  streamAgentRouteUiMessages,
  summarizeEvent,
  uiDataPartIdForEvent
};
