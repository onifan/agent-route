"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const AGENT_ROUTE_UI_STREAM_API = "/api/agent-route/ui-stream";

const AGENT_EVENT_BY_PART = {
  "data-agent-run": "start",
  "data-agent-plan": "plan",
  "data-agent-graph": "graph",
  "data-agent-strategy": "strategy",
  "data-agent-budget": "budget",
  "data-agent-risk": "risk",
  "data-agent-verification": "verification",
  "data-agent-task": "worker_log",
  "data-agent-pause": "pause",
  "data-agent-final": "final",
  "data-agent-error": "error",
  "data-agent-done": "done",
  "data-agent-memory": "memory",
  "data-agent-action": "action",
  "data-agent-event": "message"
};

const STATUS_LABEL = {
  active: "进行中",
  blocked: "已阻塞",
  completed: "已完成",
  done: "已完成",
  error: "出错",
  failed: "失败",
  info: "信息",
  pending: "等待中",
  queued: "排队中",
  running: "执行中",
  stopped: "已停止",
  submitted: "已提交",
  streaming: "生成中",
  success: "成功",
  warn: "注意",
  waiting_human: "等待人工"
};

const INTERNAL_EVENT_TYPES = new Set([
  "action",
  "actionlearningupdated",
  "actionranked",
  "authenticityblocked",
  "authenticitychecked",
  "authenticitywarning",
  "budget",
  "correctiveactionsuggested",
  "decisionattributed",
  "graph",
  "memory",
  "message",
  "model_attempt",
  "model_failure",
  "model_failover",
  "model_retry",
  "model_success",
  "model_timeout",
  "plan",
  "risk",
  "start",
  "strategy",
  "tool_retry",
  "verification",
  "worker_done",
  "worker_log",
  "worker_start"
]);

function uid(prefix = "id") {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function array(value) {
  if (Array.isArray(value)) return value.filter((item) => item != null);
  if (value == null || value === "") return [];
  return [value];
}

function compactText(value = "", max = 360) {
  const text = String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}...` : text;
}

function partText(part = {}) {
  if (part.type === "text") return part.text || "";
  if (part.type === "file") return part.filename || part.url || "";
  return "";
}

function messageText(message = {}) {
  if (typeof message.content === "string") return message.content;
  return array(message.parts).map(partText).filter(Boolean).join("\n");
}

function toAgentMessages(messages = []) {
  return messages
    .map((message) => ({
      role: ["system", "assistant", "user"].includes(message.role) ? message.role : "user",
      content: messageText(message)
    }))
    .filter((message) => message.content.trim());
}

function latestUserText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      const text = messageText(messages[index]).trim();
      if (text) return text;
    }
  }
  return "";
}

function latestAssistantText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") {
      const text = messageText(messages[index]).trim();
      if (text) return text;
    }
  }
  return "";
}

function partToAgentEvent(part = {}) {
  if (!String(part.type || "").startsWith("data-agent-")) return null;
  if (part.type === "data-agent-heartbeat") return null;
  const data = part.data && typeof part.data === "object" ? part.data : {};
  const type = String(data.event || data.type || AGENT_EVENT_BY_PART[part.type] || "message");
  if (type.toLowerCase() === "langgraph") return null;
  const payload = data.payload && typeof data.payload === "object" ? data.payload : data.payload == null ? data : data;
  return {
    partId: part.id || "",
    type,
    payload: payload && typeof payload === "object" ? payload : { message: String(payload || "") }
  };
}

function eventTone(type = "", payload = {}) {
  const raw = String(type || "").toLowerCase();
  const status = String(payload.status || payload.finalStatus || payload.final_status || "").toLowerCase();
  if (raw.includes("error") || raw.includes("failure") || raw.includes("timeout") || status === "failed")
    return "error";
  if (raw === "pause" || raw === "risk" || raw === "budget" || raw === "tool_retry" || status === "blocked") {
    return "warn";
  }
  if (raw === "worker_done" || raw === "model_success" || status === "completed" || status === "done") return "success";
  if (raw === "worker_start" || raw === "worker_log" || raw === "model_attempt" || status === "started") {
    return "active";
  }
  return "info";
}

function taskTitle(task = {}, fallback = "任务") {
  const title = String(task.title || task.id || fallback).trim();
  const normalized = title.toLowerCase();
  const map = {
    "analyze the user goal and constraints": "分析用户目标和约束",
    "check completion evidence": "检查完成证据",
    "create execution plan": "创建执行计划",
    "review progress and decide next step": "复盘进展并决定下一步",
    "synthesize final answer": "汇总最终答案"
  };
  return map[normalized] || title || fallback;
}

function toolName(payload = {}) {
  const task = payload.task || {};
  return (
    payload.toolWorker ||
    task.toolWorker ||
    task.tool_worker ||
    payload.tool ||
    payload.model ||
    (task.modelPool === "codex-cli" ? "codex-cli" : "") ||
    task.modelPool ||
    "agent"
  );
}

function displayStatus(value = "") {
  const key = String(value || "").toLowerCase();
  return STATUS_LABEL[key] || value || "信息";
}

function eventLabel(type = "", payload = {}) {
  const raw = String(type || "").toLowerCase();
  const task = payload.task || {};
  const tool = toolName(payload);
  if (raw === "worker_start") return `正在调用 ${tool}...`;
  if (raw === "worker_log") return compactText(payload.text || payload.message || `${tool} 输出日志`, 220);
  if (raw === "worker_done") {
    const status = displayStatus(payload.status || (payload.ok === false ? "failed" : "completed"));
    return `${tool} 调用结束：${status}`;
  }
  if (raw === "tool_retry") return `重新调用 ${tool}：${compactText(payload.reason || payload.error || "", 180)}`;
  if (raw === "model_attempt") return `正在调用模型 ${payload.model || "unknown"}...`;
  if (raw === "model_success") return `模型 ${payload.model || "unknown"} 返回成功`;
  if (raw === "model_failure") return `模型 ${payload.model || "unknown"} 返回失败`;
  if (raw === "model_timeout") return `模型 ${payload.model || "unknown"} 超时`;
  if (raw === "model_retry" || raw === "model_failover") {
    return `模型重试：${payload.fromModel || payload.model || "unknown"}${payload.toModel ? ` -> ${payload.toModel}` : ""}`;
  }
  if (raw === "start") return `Agent 启动：${payload.commander_model || "自动路由"}`;
  if (raw === "plan") return `生成任务计划：${array(payload.tasks).length} 个任务`;
  if (raw === "graph") return `更新执行图${payload.phase ? `：${payload.phase}` : ""}`;
  if (raw === "strategy") return `更新策略${payload.event ? `：${payload.event}` : ""}`;
  if (raw === "risk") return `风险检查：${taskTitle(task)}`;
  if (raw === "budget") return `预算检查：${displayStatus(payload.evaluation?.status || payload.status)}`;
  if (raw === "verification")
    return `验证结果：${displayStatus(payload.verification?.verificationStatus || task.verificationStatus)}`;
  if (raw === "memory") return `写入记忆：${Number(payload.count || array(payload.memories).length || 0)} 条`;
  if (raw === "final") return "最终回答已生成";
  if (raw === "error") return compactText(payload.message || payload.error || "Agent 执行失败", 240);
  if (raw === "done") return "本轮事件流结束";
  return compactText(payload.message || taskTitle(task, type || "事件"), 220);
}

function eventIteration(type = "", payload = {}) {
  const candidates = [
    payload.iteration,
    payload.round,
    payload.phase,
    payload.task?.iteration,
    payload.task?.phase,
    payload.task?.id,
    payload.task?.createdByTaskId,
    payload.task?.created_by_task_id
  ];
  for (const candidate of candidates) {
    const text = String(candidate || "");
    const match = text.match(/(?:iteration|goal-review)[:_-]?(\d+)/i);
    if (match) return Math.max(1, Number(match[1]));
    if (/^\d+$/.test(text)) return Math.max(1, Number(text));
  }
  if (String(type || "").toLowerCase() === "plan") return 0;
  return 1;
}

function referenceKey(item = {}) {
  return [item.kind, item.url, item.path, item.title, item.snippet].filter(Boolean).join("|").toLowerCase();
}

function browserReferences(evidence = {}, task = {}) {
  const browserItems = [
    ...array(evidence.browserEvidence),
    ...array(evidence.normalizedEvidence?.browser),
    ...(evidence.browser ? [evidence.browser] : [])
  ];
  return browserItems
    .map((item) => {
      const url = item.url || item.currentUrl || item.afterUrl || item.beforeUrl || "";
      const title = item.title || item.pageTitle || item.documentTitle || url || taskTitle(task, "网页片段");
      const snippet = item.textPreview || item.pageText || item.visibleTextHints || item.successMessage || "";
      if (!url && !snippet) return null;
      return {
        kind: "web",
        title: compactText(title, 120),
        url,
        snippet: compactText(snippet, 900),
        meta: [item.evidenceSource || item.evidence_source || "web", item.status ? `HTTP ${item.status}` : ""]
          .filter(Boolean)
          .join(" · ")
      };
    })
    .filter(Boolean);
}

function apiReferences(evidence = {}) {
  return array(evidence.apiResponses)
    .map((item) => {
      const url = item.url || "";
      const title = [item.method, url || item.query || "API 响应"].filter(Boolean).join(" ");
      const snippet = item.body || item.error || item.query || "";
      if (!url && !snippet) return null;
      return {
        kind: "api",
        title: compactText(title, 120),
        url,
        snippet: compactText(snippet, 900),
        meta: item.status ? `HTTP ${item.status}` : "API"
      };
    })
    .filter(Boolean);
}

function fileReferences(evidence = {}) {
  return array(evidence.files)
    .map((item) => {
      const path = item.path || item.file || "";
      const snippet = item.expectedContent || item.changeType || "";
      if (!path && !snippet) return null;
      return {
        kind: "file",
        title: compactText(path ? path.split("/").pop() : "文件片段", 120),
        path,
        snippet: compactText(snippet, 900),
        meta: item.exists === false ? "文件未确认存在" : "文件"
      };
    })
    .filter(Boolean);
}

function artifactReferences(workerResult = {}) {
  return array(workerResult.artifacts)
    .map((item) => {
      if (typeof item === "string") return { kind: "artifact", title: item, path: item, snippet: "", meta: "产物" };
      const path = item.path || item.file || item.target || "";
      const url = item.url || "";
      const title = item.title || item.name || item.id || path || url || "产物";
      const snippet = item.summary || item.description || item.textPreview || "";
      return {
        kind: "artifact",
        title: compactText(title, 120),
        path,
        url,
        snippet: compactText(snippet, 900),
        meta: item.format || item.type || "产物"
      };
    })
    .filter((item) => item.path || item.url || item.snippet || item.title);
}

function referencesFromEvent(type = "", payload = {}) {
  if (String(type || "").toLowerCase() !== "worker_done") return [];
  const task = payload.task || {};
  const workerResult = payload.worker_result || payload.workerResult || {};
  const evidence = workerResult.evidence || {};
  const refs = [
    ...browserReferences(evidence, task),
    ...apiReferences(evidence),
    ...fileReferences(evidence),
    ...artifactReferences(workerResult)
  ];
  if (!refs.length && /web|search|fetch|read|api|网页|搜索|检索/i.test(`${task.type || ""} ${task.toolWorker || ""}`)) {
    const snippet = payload.content || workerResult.output || "";
    if (snippet) {
      refs.push({
        kind: "worker",
        title: taskTitle(task, "工具输出"),
        snippet: compactText(snippet, 900),
        meta: toolName(payload)
      });
    }
  }
  return refs;
}

function mergeReferences(current = [], incoming = []) {
  const seen = new Set();
  const output = [];
  for (const item of [...current, ...incoming]) {
    const key = referenceKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
    if (output.length >= 16) break;
  }
  return output;
}

function groupedSteps(events = []) {
  const groups = new Map();
  for (const event of events.filter((item) => INTERNAL_EVENT_TYPES.has(String(item.type || "").toLowerCase()))) {
    const iteration = Number(event.iteration || 1);
    const key = iteration <= 0 ? "plan" : String(iteration);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: iteration <= 0 ? "规划阶段" : `第 ${iteration} 轮`,
        events: []
      });
    }
    groups.get(key).events.push(event);
  }
  return Array.from(groups.values());
}

function roundStatusFromEvent(type = "", payload = {}, currentStatus = "running") {
  const raw = String(type || "").toLowerCase();
  const status = String(payload.status || payload.finalStatus || payload.final_status || "").toLowerCase();
  if (raw === "error") return "failed";
  if (raw === "pause") return status || "blocked";
  if (raw === "final") return "completed";
  if (raw === "done" && status) return status;
  return currentStatus;
}

function createRound({ id, text }) {
  return {
    id,
    userText: text,
    answer: "",
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
    references: []
  };
}

function transportBody({ id, messages, body }) {
  const agentMessages = toAgentMessages(messages);
  const goal = latestUserText(messages) || body?.goal || body?.prompt || body?.input || "";
  return {
    ...(body || {}),
    goal,
    goal_id: body?.goal_id || body?.goalId || id,
    messages: agentMessages,
    source: "agent-route-ai-sdk-chat"
  };
}

function TimeLabel({ value }) {
  const text = value
    ? new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "";
  return <time>{text}</time>;
}

function Icon({ name }) {
  return (
    <span className="material-symbols-outlined" aria-hidden="true">
      {name}
    </span>
  );
}

function ProcessLine({ event }) {
  return (
    <li className={`agent-process-line ${event.tone}`}>
      <span className="agent-process-dot" />
      <div>
        <strong>{event.label}</strong>
        {event.detail ? <small>{event.detail}</small> : null}
      </div>
      <TimeLabel value={event.at} />
    </li>
  );
}

function References({ references }) {
  if (!references.length) return null;
  return (
    <details className="agent-reference-panel">
      <summary>
        <span>本回答参考了这几个文档片段</span>
        <em>{references.length}</em>
      </summary>
      <div className="agent-reference-list">
        {references.map((item, index) => (
          <article className="agent-reference-item" key={`${referenceKey(item)}-${index}`}>
            <div className="agent-reference-head">
              <strong>{item.title || `片段 ${index + 1}`}</strong>
              {item.meta ? <span>{item.meta}</span> : null}
            </div>
            {item.url ? (
              <a href={item.url} target="_blank" rel="noreferrer">
                {item.url}
              </a>
            ) : item.path ? (
              <code>{item.path}</code>
            ) : null}
            {item.snippet ? <p>{item.snippet}</p> : null}
          </article>
        ))}
      </div>
    </details>
  );
}

function IterationSteps({ events }) {
  const groups = groupedSteps(events);
  if (groups.length <= 1) return null;
  return (
    <div className="agent-iteration-list">
      {groups.map((group, index) => (
        <details className="agent-iteration" key={group.key} open={index === groups.length - 1}>
          <summary>
            <span>{group.label}</span>
            <em>{group.events.length} 步</em>
          </summary>
          <ol>
            {group.events.map((event) => (
              <ProcessLine event={event} key={event.id} />
            ))}
          </ol>
        </details>
      ))}
    </div>
  );
}

function RoundView({ round, active }) {
  const processEvents = round.events.filter((event) =>
    INTERNAL_EVENT_TYPES.has(String(event.type || "").toLowerCase())
  );
  const latestEvents = processEvents.slice(-8);
  const finalText = round.answer.trim();
  return (
    <article className={`agent-chat-round ${active ? "active" : ""}`}>
      <div className="agent-message-row user">
        <div className="agent-message-avatar">
          <Icon name="person" />
        </div>
        <div className="agent-chat-bubble user">
          <p>{round.userText}</p>
        </div>
      </div>
      <div className="agent-message-row assistant">
        <div className="agent-message-avatar assistant">
          <Icon name="smart_toy" />
        </div>
        <div className="agent-chat-bubble assistant">
          <div className="agent-answer-head">
            <span className={`agent-round-status ${round.status}`}>{displayStatus(round.status)}</span>
            <TimeLabel value={round.updatedAt || round.startedAt} />
          </div>
          {latestEvents.length ? (
            <ol className="agent-process-list">
              {latestEvents.map((event) => (
                <ProcessLine event={event} key={event.id} />
              ))}
            </ol>
          ) : (
            <p className="agent-empty-process">等待 Agent 返回内部过程...</p>
          )}
          {finalText ? <div className="agent-answer-text">{finalText}</div> : null}
          <References references={round.references} />
          <IterationSteps events={round.events} />
        </div>
      </div>
    </article>
  );
}

function EmptyState() {
  return (
    <div className="agent-chat-empty">
      <Icon name="forum" />
      <strong>AgentRoute Chat</strong>
    </div>
  );
}

export default function AgentRouteChatPanel({
  commanderModel = "",
  modelPools = null,
  promptSettings = null,
  budgetSettings = null,
  onRoundStart = null,
  onAgentEvent = null
}) {
  const [input, setInput] = useState("");
  const [rounds, setRounds] = useState([]);
  const inputRef = useRef(null);
  const currentRoundRef = useRef("");
  const streamRef = useRef(null);
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: AGENT_ROUTE_UI_STREAM_API,
        prepareSendMessagesRequest(options) {
          return { body: transportBody(options) };
        }
      }),
    []
  );

  const updateRoundFromEvent = useCallback((roundId, type, payload = {}) => {
    const event = {
      id: uid("event"),
      type,
      payload,
      label: eventLabel(type, payload),
      tone: eventTone(type, payload),
      detail: payload.task ? taskTitle(payload.task) : "",
      iteration: eventIteration(type, payload),
      at: new Date().toISOString()
    };
    setRounds((current) => {
      const index = current.findIndex((round) => round.id === roundId);
      const fallbackRound = createRound({ id: roundId, text: payload.goal || "AgentRoute 运行" });
      const round = index >= 0 ? current[index] : fallbackRound;
      const references = mergeReferences(round.references, referencesFromEvent(type, payload));
      const next = {
        ...round,
        references,
        status: roundStatusFromEvent(type, payload, round.status),
        updatedAt: event.at,
        events: [...round.events, event].slice(-300)
      };
      if (index < 0) return [...current, next];
      return current.map((item, itemIndex) => (itemIndex === index ? next : item));
    });
  }, []);

  const updateRoundAnswer = useCallback((roundId, answer) => {
    const text = String(answer || "").trim();
    if (!roundId || !text) return;
    setRounds((current) => {
      const index = current.findIndex((round) => round.id === roundId);
      if (index < 0 || current[index].answer === text) return current;
      const next = current.slice();
      next[index] = {
        ...current[index],
        answer: text,
        updatedAt: new Date().toISOString()
      };
      return next;
    });
  }, []);

  const chat = useChat({
    id: "agent-route-ai-sdk-chat",
    transport,
    experimental_throttle: 80,
    onData(part) {
      const event = partToAgentEvent(part);
      if (!event) return;
      const roundId = event.payload.goal_id || event.payload.goalId || currentRoundRef.current;
      if (!roundId) return;
      updateRoundFromEvent(roundId, event.type, event.payload);
      if (typeof onAgentEvent === "function") onAgentEvent(roundId, event.type, event.payload);
    },
    onError(error) {
      const roundId = currentRoundRef.current;
      if (!roundId) return;
      const payload = { message: error?.message || String(error) };
      updateRoundFromEvent(roundId, "error", payload);
      if (typeof onAgentEvent === "function") onAgentEvent(roundId, "error", payload);
    },
    onFinish() {}
  });

  const busy = chat.status === "submitted" || chat.status === "streaming";
  const latestAnswer = latestAssistantText(chat.messages);

  useEffect(() => {
    const node = streamRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [rounds, chat.messages.length]);

  useEffect(() => {
    updateRoundAnswer(currentRoundRef.current, latestAnswer);
  }, [latestAnswer, updateRoundAnswer]);

  async function submit(event) {
    event.preventDefault();
    const text = String(inputRef.current?.value || input || "").trim();
    if (!text || busy) return;
    const roundId = uid("goal");
    currentRoundRef.current = roundId;
    setRounds((current) => [...current, createRound({ id: roundId, text })]);
    if (typeof onRoundStart === "function") onRoundStart({ id: roundId, text, commanderModel });
    setInput("");
    try {
      await chat.sendMessage(
        { text },
        {
          body: {
            goal_id: roundId,
            commander_model: commanderModel,
            model_pools: modelPools,
            prompt_settings: promptSettings,
            budget: budgetSettings
          }
        }
      );
    } catch (err) {
      const payload = { message: err?.message || String(err) };
      updateRoundFromEvent(roundId, "error", payload);
      if (typeof onAgentEvent === "function") onAgentEvent(roundId, "error", payload);
    }
  }

  function clearChat() {
    if (busy) chat.stop();
    currentRoundRef.current = "";
    setRounds([]);
    chat.setMessages([]);
  }

  return (
    <section className="agent-chat-shell">
      <section className="agent-chat-stream" ref={streamRef} aria-live="polite">
        {rounds.length ? (
          rounds.map((round) => (
            <RoundView active={round.id === currentRoundRef.current && busy} key={round.id} round={round} />
          ))
        ) : (
          <EmptyState />
        )}
        {chat.error ? <div className="agent-chat-error">{chat.error.message}</div> : null}
      </section>

      <form className="agent-chat-composer" onSubmit={submit}>
        <button className="agent-chat-icon-button" type="button" onClick={clearChat} title="清空对话">
          <Icon name="delete_sweep" />
        </button>
        <textarea
          aria-label="输入目标"
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(event);
          }}
          placeholder="输入一个目标..."
          rows={1}
        />
        <button
          className="agent-chat-icon-button"
          type="button"
          onClick={() => chat.stop()}
          title="停止生成"
          disabled={!busy}
        >
          <Icon name="stop_circle" />
        </button>
        <button
          className="agent-chat-send"
          type="button"
          title={busy ? "正在生成" : input.trim() ? "发送" : "输入内容后发送"}
          aria-disabled={busy}
          onClick={submit}
        >
          <Icon name={busy ? "hourglass_top" : "send"} />
        </button>
      </form>
    </section>
  );
}
