"use client";

import { DefaultChatTransport } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import * as promptDefaults from "../../src/config/prompts/default-prompt-settings";
import AgentRouteChatPanel from "./chat/agent-chat";
import ProviderDetailPage from "../dashboard/providers/[id]/page";
import ProvidersDashboard from "../dashboard/providers/provider-console";

const AGENT_ROUTE_UI_STREAM_API = "/api/agent-route/ui-stream";
const STORAGE_KEY = "agent-route.dashboard.v3";
const FALLBACK_STORAGE_KEY = "agent-route.studio.state.v1";
const GOAL_DRAFT_KEY = "agent-route.goal-draft.v1";
const COMMANDER_KEY = "agent-route.commander";
const MODEL_SETTINGS_KEY = "agent-route.model-settings.v1";
const MODEL_SETTINGS_VERSION = 2;
const PROMPT_SETTINGS_KEY = "agent-route.prompt-settings.v1";
const BUDGET_SETTINGS_KEY = "agent-route.budget-settings.v1";
const THEME_KEY = "agent-route.theme";

function normalizeCommanderModelId(value) {
  const model = String(value || "").trim();
  if (/^(?:cx|codex)\/gpt-?5\.5$/i.test(model) || /^gpt-?5\.5$/i.test(model)) return "gpt5.5";
  return model;
}

function splitModelList(value) {
  return [
    ...new Set(
      String(value || "")
        .split(/[\n,]+/)
        .map(normalizeCommanderModelId)
        .filter(Boolean)
    )
  ];
}

const EXPLICIT_COMMANDER_MODELS = splitModelList(
  process.env.NEXT_PUBLIC_AGENT_ROUTE_COMMANDER_MODELS || process.env.NEXT_PUBLIC_AGENT_ROUTE_COMMANDER_MODEL || ""
).filter((model) => model.toLowerCase() === "gpt5.5");

const COMMANDERS = EXPLICIT_COMMANDER_MODELS.length
  ? EXPLICIT_COMMANDER_MODELS.map((id) => ({
      id,
      name: id,
      tier: "L3",
      note: "指定总指挥 API"
    }))
  : [{ id: "gpt5.5", name: "gpt5.5", tier: "L3", note: "本地 API 总指挥" }];

const MODEL_TIERS = [
  {
    key: "l3",
    pool: "commander",
    label: "L3",
    title: "总指挥模型（高成本 / 最强能力）",
    desc: "复杂规划、决策、代码、多模态、高风险操作"
  },
  {
    key: "l2",
    pool: "strong",
    label: "L2",
    title: "强能力模型（中等成本 / 较强能力）",
    desc: "代码生成、复杂分析、多步骤推理"
  },
  {
    key: "l1",
    pool: "coding",
    label: "L1",
    title: "基础模型（低成本 / 基础能力）",
    desc: "写作、总结、分类、常规编码"
  },
  {
    key: "l0",
    pool: "free",
    label: "L0",
    title: "免费模型（零成本 / 基础能力）",
    desc: "提取、OCR、简单判断、格式转换"
  }
];

const DEFAULT_MODEL_POOLS = {
  commander: COMMANDERS.map((item) => item.id),
  strong: [
    "openrouter/anthropic/claude-sonnet-4.5",
    "openrouter/google/gemini-2.5-pro",
    "openrouter/deepseek/deepseek-r1-0528",
    "openrouter/qwen/qwen3-235b-a22b",
    "openrouter/moonshotai/kimi-k2"
  ],
  coding: [
    "openrouter/qwen/qwen3-coder:free",
    "openrouter/deepseek/deepseek-r1-0528:free",
    "openrouter/deepseek/deepseek-chat-v3.1:free",
    "openrouter/qwen/qwen3-32b:free",
    "openrouter/mistralai/mistral-small-3.2-24b-instruct:free"
  ],
  free: [
    "gc/gemini-3-flash-preview",
    "gemini/gemini-3-flash-preview",
    "gemini/gemini-3.1-flash-lite-preview",
    "gemini/gemma-4-31b-it",
    "gemini/gemini-2.5-flash",
    "gemini/gemini-2.5-flash-lite",
    "openrouter/z-ai/glm-4.5-air:free",
    "openrouter/openai/gpt-oss-120b:free",
    "openrouter/qwen/qwen3-next-80b-a3b-instruct:free",
    "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
    "openrouter/deepseek/deepseek-v4-flash:free",
    "openrouter/minimax/minimax-m2.5:free",
    "openrouter/meta-llama/llama-3.3-70b-instruct:free",
    "openrouter/openai/gpt-oss-20b:free",
    "openrouter/google/gemma-4-26b-a4b-it:free"
  ]
};

const DEFAULT_BUDGET_SETTINGS = {
  version: 1,
  unlimited: false,
  mode: "limited",
  goal: {
    maxTokens: 180000,
    maxCostUsd: 1.5,
    maxRuntimeMs: 30 * 60 * 1000,
    maxSteps: 120,
    maxBrowserActions: 80,
    maxRetries: 8,
    maxConcurrentWorkers: 1
  },
  task: {
    maxRetries: 4,
    maxRuntimeMs: 3 * 60 * 1000,
    maxTokens: 50000,
    maxBrowserActions: 20,
    maxShellActions: 30,
    maxVerificationRetries: 1
  },
  browser: {
    maxActions: 20,
    maxReloads: 4,
    maxNavigations: 10,
    maxTabs: 3,
    maxSubmitAttempts: 1,
    maxScreenshots: 5
  },
  verification: {
    maxModelCalls: 2,
    maxRetries: 1,
    timeoutMs: 45000
  }
};

const DEFAULT_PROMPT_SETTINGS =
  promptDefaults.DEFAULT_PROMPT_SETTINGS || promptDefaults.default?.DEFAULT_PROMPT_SETTINGS || promptDefaults.default;

const NAV_ITEMS = [
  ["control", "控制中心", "home", "创建和推进目标"],
  ["chat", "聊天", "forum", "消息流和内部过程"],
  ["monitor", "监控中心", "monitoring", "运行状态和事件流"],
  ["tasks", "任务视图", "list_alt", "任务队列、依赖图和人工处理"],
  ["models", "模型管理", "robot_2", "模型等级和预算"],
  ["providers", "供应商设置", "key", "供应商、API Key 和自定义模型端点"],
  ["memory", "记忆", "database", "长期经验"],
  ["logs", "执行日志", "terminal", "最近执行记录"]
];

const HOME_DETAIL_LINKS = [
  ["tasks", "任务队列", "list", "阻塞、失败和人工确认", "queue"],
  ["tasks", "任务图", "account_tree", "依赖关系、产物和可执行任务", "graph"],
  ["monitor", "监控", "monitoring", "事件、恢复、预算和风险"],
  ["models", "模型", "robot_2", "模型等级、路由和预算"],
  ["providers", "供应商", "key", "API Key 和自定义端点"]
];

const PROMPT_PREVIEW_APPENDICES = {
  planner: [
    "[运行时] 系统会追加当前 strategy、相关 memory、预算策略和执行上下文。",
    "[运行时] planner 必须判断风险和难度，表达依赖关系，并返回任务图 JSON schema。",
    "[运行时] 公开网页/API 只读取证必须路由到 web tool worker；模型只分析工具返回的 URL/status/title/text/API evidence。浏览器交互、shell、文件和本地应用任务才路由到 codex-cli/具备浏览器能力的 worker。"
  ],
  worker: [
    "[运行时] 系统会追加分配任务的标题、描述、风险状态、确认状态、成功标准、依赖、产物和原始对话。",
    "[运行时] worker 输出会被规范化并进入验证流程；没有结构化 evidence object 的 success 不足以完成任务。",
    "[运行时] worker 可以建议持久、非敏感的 memoryCandidates，但不会被自动信任。"
  ],
  codexCli: [
    "[运行时] 系统会追加任务 prompt、确认状态、历史 worker 结果、原始对话和结构化 JSON evidence schema。",
    "[运行时] 本地 shell、浏览器、文件和 API 动作仍受风险门和人工确认约束。",
    "[运行时] 实际命令、URL、exit code、文件、浏览器状态和 API 状态必须作为 evidence 报告。"
  ],
  verifier: [
    "[运行时] 语义验证器 prompt 由系统控制，不在这里编辑。",
    "[运行时] 规则验证先运行；语义验证不能覆盖缺失的 shell、browser、file、API、approval 或 risk 证据。",
    '[运行时] 验证器期望 JSON: {"verified":boolean,"verificationStatus":"verified|partially_verified|unverified","confidence":0.0,"reasons":[],"detectedIssues":[],"reasonCode":"short","missingEvidence":[],"rejectedEvidence":[],"suggestedNextState":"completed|retrying|needs_evidence|failed|blocked|waiting_human","retryable":true}.'
  ],
  final: [
    "[运行时] 系统会追加原始对话、完整任务计划、strategy、memory 和 worker 结果。",
    "[运行时] 对于部分完成、失败、阻塞或未验证的工作，必须诚实说明，不能包装成完成。"
  ]
};

const FALLBACK_SUPPORTED_PROVIDERS = [
  { id: "claude", label: "Claude Code", alias: "cc", authType: "oauth", category: "oauth", modelPrefixes: ["cc"] },
  { id: "codex", label: "OpenAI Codex", alias: "cx", authType: "oauth", category: "oauth", modelPrefixes: ["cx"] },
  { id: "gemini-cli", label: "Gemini CLI", alias: "gc", authType: "oauth", category: "oauth", modelPrefixes: ["gc"] },
  { id: "github", label: "GitHub Copilot", alias: "gh", authType: "oauth", category: "oauth", modelPrefixes: ["gh"] },
  { id: "antigravity", label: "Antigravity", alias: "ag", authType: "oauth", category: "oauth", modelPrefixes: ["ag"] },
  { id: "iflow", label: "iFlow AI", alias: "if", authType: "oauth", category: "oauth", modelPrefixes: ["if"] },
  { id: "qwen", label: "Qwen Code", alias: "qw", authType: "oauth", category: "oauth", modelPrefixes: ["qw"] },
  { id: "kiro", label: "Kiro AI", alias: "kr", authType: "oauth", category: "oauth", modelPrefixes: ["kr"] },
  { id: "openrouter", label: "OpenRouter", authType: "apikey", category: "apikey", modelPrefixes: ["openrouter/"] },
  { id: "openai", label: "OpenAI", authType: "apikey", category: "apikey", modelPrefixes: ["openai/"] },
  { id: "gemini", label: "Gemini", authType: "apikey", category: "apikey", modelPrefixes: ["gemini/", "gc/"] },
  { id: "deepseek", label: "DeepSeek", authType: "apikey", category: "apikey", modelPrefixes: ["deepseek/"] },
  { id: "kimi", label: "Kimi Coding", authType: "apikey", category: "apikey", modelPrefixes: ["kimi/", "moonshot/"] },
  { id: "glm", label: "GLM Coding", authType: "apikey", category: "apikey", modelPrefixes: ["glm/", "zhipu/"] },
  { id: "minimax", label: "Minimax Coding", authType: "apikey", category: "apikey", modelPrefixes: ["minimax/"] },
  { id: "anthropic", label: "Anthropic", authType: "apikey", category: "apikey", modelPrefixes: ["anthropic/"] }
];

const INTERNAL_ROUTE_TASK_IDS = new Set(["plan", "final"]);
const NEW_TASK_DRAFT_ID = "__new_task_draft__";
const TASK_PANEL_TABS = [
  ["queue", "任务队列", "list_alt", "任务状态和人工处理"],
  ["graph", "任务图", "account_tree", "依赖、阻塞和产物流"]
];

function normalizeSectionTarget(section) {
  const raw = String(section || "control")
    .replace(/^#/, "")
    .trim();
  if (raw === "graph" || raw === "queue") return { section: "tasks", taskTab: raw };
  return { section: raw || "control", taskTab: "" };
}

function initialActiveSection() {
  if (typeof window === "undefined") return "control";
  const target = normalizeSectionTarget(window.location.hash);
  return NAV_ITEMS.some(([id]) => id === target.section) ? target.section : "control";
}

function isRouteInternalTask(task) {
  const source = typeof task === "string" ? { id: task } : task || {};
  const id = String(source.id || source.taskId || source.task_id || "").trim();
  const title = String(source.title || "")
    .trim()
    .toLowerCase();
  if (source.internal || source.routeInternal || source.route_internal) return true;
  if (INTERNAL_ROUTE_TASK_IDS.has(id)) {
    return !title || title === "create execution plan" || title === "synthesize final answer";
  }
  return /^goal-review-\d+$/.test(id) && (!title || title === "review progress and decide next step");
}

function isDisplayTask(task) {
  return Boolean(task && (task.id || task.title));
}

function isUserVisibleTask(task) {
  return isDisplayTask(task) && !isRouteInternalTask(task);
}

function isGraphVisibleTask(task) {
  return isUserVisibleTask(task) && String(task?.status || "").toLowerCase() !== "canceled";
}

const STATUS_LABEL = {
  idle: "待命",
  waiting: "等待执行",
  pending: "等待中",
  queued: "排队中",
  running: "执行中",
  completed: "已完成",
  done: "已完成",
  failed: "失败",
  retry_ready: "准备重试",
  needs_evidence: "等待补充证据",
  blocked: "被阻塞",
  waiting_human: "等待人工批准",
  awaiting_confirmation: "等待人工确认",
  canceled: "已取消",
  stopped: "已暂停"
};

const SIMPLE_VALUE_LABEL = {
  active: "活跃",
  blocked: "阻塞",
  coding: "代码模型",
  commander: "总指挥模型",
  "codex-cli": "Codex 命令行",
  critical: "关键",
  degraded: "已降级",
  done: "完成",
  episodic: "经验",
  emergency: "紧急降级",
  event: "事件",
  failed: "失败",
  needs_evidence: "等待补证据",
  free: "免费模型",
  graph_created: "执行图已创建",
  graph_updated: "执行图已更新",
  high: "高",
  info: "信息",
  knowledge: "知识",
  low: "低",
  medium: "中",
  none: "无",
  normal: "普通",
  ok: "正常",
  api: "API 触发",
  browser_session_lost: "浏览器会话已失效",
  cancel_task: "取消任务",
  decision_attribution: "决策归因",
  human_review: "人工复核",
  manual_action: "手动操作",
  process_restarted_or_worker_lost: "进程重启或执行器丢失",
  recovery_blocked_task_preserved: "恢复时保留阻塞状态",
  recovery_retry_budget_exhausted: "恢复时重试预算已耗尽",
  retry_budget_exhausted: "重试预算已耗尽",
  startup: "启动恢复",
  startup_cached: "启动恢复缓存",
  system_recommendation: "系统建议",
  pending: "等待",
  procedure: "流程",
  ready: "可执行",
  running: "运行中",
  strategy_created: "战略已创建",
  strategy_revised: "战略已修订",
  strong: "强能力模型",
  success: "成功",
  unverified: "未验证",
  verified: "已验证",
  wait: "等待",
  warn: "警告",
  warning: "预警",
  worker_process_lost: "执行器进程丢失",
  working: "工作记忆"
};

const EVENT_TYPE_LABEL = {
  budget: "预算",
  done: "结束",
  error: "错误",
  final: "最终结果",
  goal_check: "目标检查",
  graph: "执行图",
  human_approved: "人工批准",
  human_rejected: "人工拒绝",
  memory: "记忆",
  model_attempt: "模型尝试",
  model_success: "模型成功",
  model_failure: "模型失败",
  model_timeout: "模型超时",
  model_retry: "模型重试",
  model_failover: "模型切换",
  tool_retry: "工具重试",
  pause: "暂停",
  plan: "规划",
  risk: "风险",
  AuthenticityBlocked: "真实性阻断",
  AuthenticityChecked: "真实性检查",
  AuthenticityWarning: "真实性警告",
  CorrectiveActionSuggested: "纠正建议",
  ActionRanked: "动作排序",
  ActionLearningUpdated: "行为经验",
  DecisionAttributed: "决策归因",
  authenticityblocked: "真实性阻断",
  authenticitychecked: "真实性检查",
  authenticitywarning: "真实性警告",
  correctiveactionsuggested: "纠正建议",
  actionranked: "动作排序",
  actionlearningupdated: "行为经验",
  decisionattributed: "决策归因",
  browser_session_marked_stale: "浏览器会话失效",
  browsersessionmarkedstale: "浏览器会话失效",
  goalrecovered: "目标恢复",
  recoverycompleted: "恢复完成",
  recoverystarted: "恢复开始",
  recoverywarning: "恢复警告",
  taskrecovered: "任务恢复",
  workerlostdetected: "执行器丢失",
  start: "启动",
  strategy: "战略",
  task_canceled: "任务取消",
  task_deleted: "任务删除",
  tasks_registered: "任务注册",
  verification: "验证",
  worker_done: "执行器完成",
  worker_log: "执行器日志",
  worker_start: "执行器启动"
};

const LOG_LEVEL_LABEL = {
  error: "错误",
  info: "信息",
  success: "成功",
  warn: "警告"
};

const ROOT_CAUSE_LABEL = {
  budget_exceeded: "预算超限",
  dependency_blocked: "依赖阻塞",
  risk_blocked: "风险阻塞",
  verification_failed: "验证失败",
  needs_evidence: "证据不足"
};

const FILTERS = [
  ["all", "全部"],
  ["running", "进行中"],
  ["queued", "等待中"],
  ["blocked", "已阻塞"],
  ["completed", "已完成"],
  ["failed", "失败"]
];

function nowTime() {
  return new Date().toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function uid(prefix) {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function shortText(value, length = 72) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > length ? `${text.slice(0, length).trimEnd()}...` : text;
}

function redactDisplayText(value) {
  const source =
    value && typeof value === "object"
      ? value.issue ||
        value.reason ||
        value.message ||
        value.summary ||
        value.title ||
        (() => {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })()
      : value;
  return String(source || "")
    .replace(
      /([?&][^=&#]*(?:token|key|cookie|password|secret|authorization|code|session)[^=&#]*=)[^&#\s]+/gi,
      "$1[已隐藏]"
    )
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|passwd|pwd|cookie|secret|authorization|oauth[_-]?code)\b\s*[:=]\s*['"]?[^'"\s&]{4,}/gi,
      "$1=[已隐藏]"
    )
    .replace(/\/Users\/[^/\s]+/g, "/Users/[已隐藏]");
}

function safeDisplayText(value, length = 120) {
  return shortText(redactDisplayText(value), length);
}

function formatDateTime(value) {
  if (!value) return "未运行";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return safeDisplayText(value, 60);
  return date.toLocaleString("zh-CN", {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function array(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function readLines(value, fallback = []) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[\n,]+/);
  const seen = new Set();
  const output = [];
  for (const item of raw) {
    const text = String(item || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }
  return output.length ? output : fallback.slice();
}

function safeLoad(key, fallback) {
  if (typeof window === "undefined") return fallback;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "null");
    return parsed && typeof parsed === "object" ? { ...fallback, ...parsed } : fallback;
  } catch {
    return fallback;
  }
}

function compactTaskForStorage(task = {}) {
  return {
    ...task,
    input: safeDisplayText(task.input || "", 500),
    prompt: safeDisplayText(task.prompt || "", 500),
    description: safeDisplayText(task.description || "", 500),
    result: safeDisplayText(task.result || "", 1200),
    content: safeDisplayText(task.content || "", 1200),
    error: safeDisplayText(task.error || "", 800),
    verificationHistory: array(task.verificationHistory).slice(-3),
    riskHistory: array(task.riskHistory).slice(-3),
    budgetHistory: array(task.budgetHistory).slice(-3),
    correctiveHistory: array(task.correctiveHistory).slice(-3),
    actionDecisionHistory: array(task.actionDecisionHistory).slice(-3),
    actionLearningHistory: array(task.actionLearningHistory).slice(-3),
    decisionAttributionHistory: array(task.decisionAttributionHistory).slice(-3),
    authenticitySignals: array(task.authenticitySignals).slice(-6),
    artifacts: array(task.artifacts).slice(-8)
  };
}

function compactStateForStorage(value) {
  if (!value || typeof value !== "object") return value;
  return {
    ...value,
    goals: array(value.goals)
      .slice(0, 12)
      .map((goal) => ({
        ...goal,
        goal: safeDisplayText(goal.goal || "", 1200),
        output: safeDisplayText(goal.output || "", 1600),
        logs: array(goal.logs)
          .slice(-40)
          .map((item) => safeDisplayText(item, 500)),
        tasks: array(goal.tasks).slice(0, 80).map(compactTaskForStorage),
        strategyHistory: array(goal.strategyHistory).slice(-3),
        graph: goal.graph
          ? {
              ...goal.graph,
              nodes: array(goal.graph.nodes).slice(0, 120),
              edges: array(goal.graph.edges).slice(0, 160),
              blockedChains: array(goal.graph.blockedChains).slice(0, 30)
            }
          : null
      })),
    logs: array(value.logs)
      .slice(-120)
      .map((item) => safeDisplayText(item, 800)),
    memories: array(value.memories).slice(-80),
    observability: value.observability
      ? {
          ...value.observability,
          eventTimeline: array(value.observability.eventTimeline).slice(-80),
          trace: value.observability.trace
            ? {
                ...value.observability.trace,
                events: array(value.observability.trace.events).slice(-80),
                chain: array(value.observability.trace.chain).slice(-80)
              }
            : value.observability.trace
        }
      : value.observability
  };
}

function save(key, value) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    if (!/quota|storage/i.test(String(err && err.message ? err.message : err))) throw err;
    try {
      window.localStorage.setItem(key, JSON.stringify(compactStateForStorage(value)));
    } catch {
      window.localStorage.setItem(
        key,
        JSON.stringify({
          ...(value && typeof value === "object" ? value : {}),
          goals: array(value?.goals)
            .slice(0, 3)
            .map((goal) => ({
              ...goal,
              tasks: array(goal.tasks).slice(0, 20).map(compactTaskForStorage),
              graph: null,
              strategyHistory: []
            })),
          logs: [],
          observability: null
        })
      );
    }
  }
}

function uniqueModelIds(values) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const model = normalizeCommanderModelId(value);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    output.push(model);
  }
  return output;
}

function readModelLines(value, fallback) {
  const input = Array.isArray(value) ? value : String(value || "").split(/[\n,]+/);
  const models = uniqueModelIds(input);
  return models.length ? models : uniqueModelIds(fallback || []);
}

function cloneDefaultPools() {
  return {
    commander: DEFAULT_MODEL_POOLS.commander.slice(),
    strong: DEFAULT_MODEL_POOLS.strong.slice(),
    coding: DEFAULT_MODEL_POOLS.coding.slice(),
    free: DEFAULT_MODEL_POOLS.free.slice()
  };
}

function isCommanderGradeModel(model) {
  const id = normalizeCommanderModelId(model).toLowerCase();
  return id === "gpt5.5" || /^(cx|codex)\/gpt-[a-z0-9_.-]+$/.test(id);
}

function isSupportedCommanderModel(model) {
  const id = normalizeCommanderModelId(model).toLowerCase();
  if (EXPLICIT_COMMANDER_MODELS.length) {
    return EXPLICIT_COMMANDER_MODELS.map((item) => normalizeCommanderModelId(item).toLowerCase()).includes(id);
  }
  return id === "gpt5.5";
}

function cleanPoolsForTier(pools) {
  const next = { ...pools };
  next.commander = EXPLICIT_COMMANDER_MODELS.length
    ? EXPLICIT_COMMANDER_MODELS.slice()
    : uniqueModelIds(next.commander).filter(isSupportedCommanderModel);
  if (!next.commander.length) next.commander = DEFAULT_MODEL_POOLS.commander.slice();
  next.coding = uniqueModelIds(next.coding).filter((model) => !isCommanderGradeModel(model));
  if (!next.coding.length) next.coding = DEFAULT_MODEL_POOLS.coding.slice();
  return next;
}

function dedupePoolsByTier(pools) {
  const output = {};
  for (const pool of ["commander", "strong", "coding", "free"]) {
    output[pool] = uniqueModelIds(pools?.[pool]);
  }
  return output;
}

function normalizeModelSettings(raw) {
  const defaults = cloneDefaultPools();
  const source = raw && typeof raw === "object" ? raw : {};
  const legacySettings = source.version !== MODEL_SETTINGS_VERSION;
  let pools = {
    commander: readModelLines(source.pools?.commander, defaults.commander),
    strong: readModelLines(source.pools?.strong, defaults.strong),
    coding: readModelLines(source.pools?.coding, defaults.coding),
    free: readModelLines(source.pools?.free, defaults.free)
  };
  if (legacySettings) {
    pools = {
      commander: uniqueModelIds([...pools.commander, ...defaults.commander]),
      strong: uniqueModelIds([...pools.strong, ...defaults.strong]),
      coding: uniqueModelIds([...pools.coding, ...defaults.coding]),
      free: uniqueModelIds([...pools.free, ...defaults.free])
    };
  }
  const requestedCommanderRaw = normalizeCommanderModelId(source.defaultCommander || source.commander);
  const requestedCommander = isSupportedCommanderModel(requestedCommanderRaw) ? requestedCommanderRaw : "";
  if (requestedCommander && !pools.commander.includes(requestedCommander)) pools.commander.unshift(requestedCommander);
  pools = cleanPoolsForTier(pools);
  pools = dedupePoolsByTier(pools);
  const defaultCommander =
    requestedCommander && pools.commander.includes(requestedCommander)
      ? requestedCommander
      : pools.commander[0] || defaults.commander[0];
  return { version: MODEL_SETTINGS_VERSION, defaultCommander, pools };
}

function loadModelSettings() {
  if (typeof window === "undefined") return normalizeModelSettings({});
  try {
    const parsed = JSON.parse(window.localStorage.getItem(MODEL_SETTINGS_KEY) || "null") || {};
    const savedCommander = normalizeCommanderModelId(window.localStorage.getItem(COMMANDER_KEY));
    return normalizeModelSettings({
      ...parsed,
      defaultCommander: parsed.defaultCommander || parsed.commander || savedCommander
    });
  } catch {
    return normalizeModelSettings({});
  }
}

function saveModelSettings(settings) {
  const normalized = normalizeModelSettings(settings);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(MODEL_SETTINGS_KEY, JSON.stringify(normalized));
    window.localStorage.setItem(COMMANDER_KEY, normalized.defaultCommander);
  }
  return normalized;
}

function cloneDefaultBudgetSettings() {
  return JSON.parse(JSON.stringify(DEFAULT_BUDGET_SETTINGS));
}

function budgetNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeBudgetSection(defaults, raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const output = { ...defaults };
  for (const key of Object.keys(output)) {
    const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    output[key] = budgetNumber(source[key] ?? source[snake], output[key]);
  }
  return output;
}

function normalizeBudgetSettings(raw) {
  const defaults = cloneDefaultBudgetSettings();
  const source = raw && typeof raw === "object" ? raw : {};
  const unlimited = Boolean(
    source.unlimited ||
    source.disabled ||
    source.enabled === false ||
    String(source.mode || source.budgetMode || source.budget_mode || "").toLowerCase() === "unlimited"
  );
  return {
    version: defaults.version,
    unlimited,
    mode: unlimited ? "unlimited" : "limited",
    goal: normalizeBudgetSection(defaults.goal, source.goal || source.goalBudget || source.goal_budget),
    task: normalizeBudgetSection(defaults.task, source.task || source.taskBudget || source.task_budget),
    browser: normalizeBudgetSection(defaults.browser, source.browser || source.browserBudget || source.browser_budget),
    verification: normalizeBudgetSection(
      defaults.verification,
      source.verification || source.verificationBudget || source.verification_budget
    )
  };
}

function loadBudgetSettings() {
  if (typeof window === "undefined") return normalizeBudgetSettings({});
  try {
    return normalizeBudgetSettings(JSON.parse(window.localStorage.getItem(BUDGET_SETTINGS_KEY) || "null") || {});
  } catch {
    return normalizeBudgetSettings({});
  }
}

function saveBudgetSettings(settings) {
  const normalized = normalizeBudgetSettings(settings);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(BUDGET_SETTINGS_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

function cloneDefaultPromptSettings() {
  return {
    version: DEFAULT_PROMPT_SETTINGS.version,
    commanderSystem: DEFAULT_PROMPT_SETTINGS.commanderSystem,
    plannerInstructions: DEFAULT_PROMPT_SETTINGS.plannerInstructions,
    reviewSystem: DEFAULT_PROMPT_SETTINGS.reviewSystem,
    finalSystem: DEFAULT_PROMPT_SETTINGS.finalSystem,
    workerSystem: DEFAULT_PROMPT_SETTINGS.workerSystem,
    codexCliSystem: DEFAULT_PROMPT_SETTINGS.codexCliSystem,
    tierPrompts: {
      commander: DEFAULT_PROMPT_SETTINGS.tierPrompts.commander,
      strong: DEFAULT_PROMPT_SETTINGS.tierPrompts.strong,
      coding: DEFAULT_PROMPT_SETTINGS.tierPrompts.coding,
      free: DEFAULT_PROMPT_SETTINGS.tierPrompts.free,
      "codex-cli": DEFAULT_PROMPT_SETTINGS.tierPrompts["codex-cli"]
    }
  };
}

function promptValue(value, fallback) {
  const text = String(value == null ? "" : value).trim();
  return text || fallback || "";
}

function hasLegacyPromptSettings(source = {}) {
  const tierSource = source.tierPrompts && typeof source.tierPrompts === "object" ? source.tierPrompts : {};
  const text = [
    source.commanderSystem,
    source.plannerInstructions,
    source.reviewSystem,
    source.finalSystem,
    source.workerSystem,
    source.codexCliSystem,
    tierSource.commander,
    tierSource.strong,
    tierSource.coding,
    tierSource.free,
    tierSource["codex-cli"],
    tierSource.codexCli
  ]
    .filter(Boolean)
    .join("\n");
  return (
    /\b(you are|return compact|worker model|commander|goal-driven|synthesize|assigned subtask|codex cli)\b/i.test(
      text
    ) || /目标驱动 Agent 路由|只返回紧凑 JSON|优先返回紧凑 JSON|不要假装|evidence"\s*:\s*\[\]/i.test(text)
  );
}

function normalizePromptSettings(raw) {
  const defaults = cloneDefaultPromptSettings();
  const source = raw && typeof raw === "object" ? raw : {};
  if (Number(source.version || 0) < DEFAULT_PROMPT_SETTINGS.version && hasLegacyPromptSettings(source)) {
    return defaults;
  }
  const tierSource = source.tierPrompts && typeof source.tierPrompts === "object" ? source.tierPrompts : {};
  return {
    version: DEFAULT_PROMPT_SETTINGS.version,
    commanderSystem: promptValue(source.commanderSystem, defaults.commanderSystem),
    plannerInstructions: promptValue(source.plannerInstructions, defaults.plannerInstructions),
    reviewSystem: promptValue(source.reviewSystem, defaults.reviewSystem),
    finalSystem: promptValue(source.finalSystem, defaults.finalSystem),
    workerSystem: promptValue(source.workerSystem, defaults.workerSystem),
    codexCliSystem: promptValue(source.codexCliSystem, defaults.codexCliSystem),
    tierPrompts: {
      commander: promptValue(tierSource.commander, defaults.tierPrompts.commander),
      strong: promptValue(tierSource.strong, defaults.tierPrompts.strong),
      coding: promptValue(tierSource.coding, defaults.tierPrompts.coding),
      free: promptValue(tierSource.free, defaults.tierPrompts.free),
      "codex-cli": promptValue(tierSource["codex-cli"] || tierSource.codexCli, defaults.tierPrompts["codex-cli"])
    }
  };
}

function loadPromptSettings() {
  if (typeof window === "undefined") return normalizePromptSettings({});
  try {
    return normalizePromptSettings(JSON.parse(window.localStorage.getItem(PROMPT_SETTINGS_KEY) || "null") || {});
  } catch {
    return normalizePromptSettings({});
  }
}

function savePromptSettings(settings) {
  const normalized = normalizePromptSettings(settings);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(PROMPT_SETTINGS_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

function exportedPromptPayload(settings = loadPromptSettings()) {
  return {
    type: "agent-route-prompt-settings",
    version: 1,
    exportedAt: new Date().toISOString(),
    promptSettings: normalizePromptSettings(settings)
  };
}

function promptSettingsFromImport(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.promptSettings && typeof parsed.promptSettings === "object") return parsed.promptSettings;
  if (parsed.prompt_settings && typeof parsed.prompt_settings === "object") return parsed.prompt_settings;
  if (parsed.type === "agent-route-prompt-settings" && parsed.settings && typeof parsed.settings === "object")
    return parsed.settings;
  return parsed;
}

function promptPreviewSections(settings) {
  const prompts = normalizePromptSettings(settings);
  return [
    {
      id: "planner",
      title: "Planner / Task Graph",
      summary: "规划、路由、风险、预算和任务图 schema",
      content: [
        prompts.commanderSystem,
        prompts.plannerInstructions,
        prompts.tierPrompts?.commander,
        ...PROMPT_PREVIEW_APPENDICES.planner
      ]
    },
    {
      id: "worker",
      title: "Plain Worker",
      summary: "普通模型执行器、证据对象和记忆候选",
      content: [prompts.workerSystem, prompts.tierPrompts?.free, ...PROMPT_PREVIEW_APPENDICES.worker]
    },
    {
      id: "codex-cli",
      title: "Codex CLI Worker",
      summary: "本地 shell/browser/file/API 执行器",
      content: [prompts.codexCliSystem, prompts.tierPrompts?.["codex-cli"], ...PROMPT_PREVIEW_APPENDICES.codexCli]
    },
    {
      id: "review",
      title: "Review Loop",
      summary: "循环复盘、下一批任务和停止判断",
      content: [
        prompts.commanderSystem,
        prompts.reviewSystem,
        "[runtime] Active strategy, memory, worker results, verification state, risk state, and budget state are appended at runtime.",
        "[runtime] Review must return compact JSON with status, progress_summary, final_answer, next_tasks, and memory_candidates."
      ]
    },
    {
      id: "verifier",
      title: "Semantic Verifier",
      summary: "只读系统规则，不在可编辑 prompt 中",
      content: PROMPT_PREVIEW_APPENDICES.verifier
    },
    {
      id: "final",
      title: "Final Synthesis",
      summary: "最终面向用户答案",
      content: [prompts.finalSystem, ...PROMPT_PREVIEW_APPENDICES.final]
    }
  ].map((section) => ({
    ...section,
    content: section.content.filter(Boolean).join("\n\n")
  }));
}

function modelLabel(id) {
  const known = COMMANDERS.find((item) => item.id === id);
  return known ? `${known.name} (${id})` : id;
}

function commanderName(id) {
  return (COMMANDERS.find((item) => item.id === id) || { name: id || COMMANDERS[0].name }).name;
}

function normalizeStoredState(raw) {
  const fallback = {
    goals: [],
    activeGoalId: "",
    logs: [],
    memories: [],
    observability: null,
    recovery: null,
    filter: "all",
    calls: 0,
    spend: 0
  };
  const merged = { ...fallback, ...(raw || {}) };
  return {
    ...merged,
    goals: array(merged.goals).map(normalizeGoalForState),
    logs: array(merged.logs),
    memories: array(merged.memories),
    observability: merged.observability && typeof merged.observability === "object" ? merged.observability : null,
    recovery: merged.recovery && typeof merged.recovery === "object" ? merged.recovery : null
  };
}

function statusClass(status) {
  const value = String(status || "");
  if (value === "running") return "run";
  if (["failed", "blocked", "canceled"].includes(value)) return "fail";
  if (["completed", "done"].includes(value)) return "done";
  return "wait";
}

function isDone(status) {
  return ["completed", "done"].includes(String(status || ""));
}

function isFailed(status) {
  return ["failed", "blocked", "canceled"].includes(String(status || ""));
}

function isFailedStreamStatus(data = {}) {
  const status = String(data.status || data.finalStatus || data.final_status || "").toLowerCase();
  return ["failed", "blocked", "waiting_human", "awaiting_confirmation"].includes(status);
}

function isQueueFailedStatus(status) {
  return ["failed", "error", "canceled", "cancelled"].includes(String(status || "").toLowerCase());
}

function needsHumanAttention(task = {}) {
  const status = String(task.status || "").toLowerCase();
  const type = String(task.type || task.taskType || "").toLowerCase();
  const approvalStatus = String(task.approvalStatus || task.approval_status || "").toLowerCase();
  return (
    status === "blocked" ||
    status === "waiting_human" ||
    status === "awaiting_confirmation" ||
    type === "human_approval" ||
    approvalStatus === "pending" ||
    Boolean(task.requiresHumanApproval || task.requiresHumanConfirmation) ||
    isQueueFailedStatus(status)
  );
}

function canApproveTask(task = {}) {
  const status = String(task.status || "").toLowerCase();
  const type = String(task.type || task.taskType || "").toLowerCase();
  const approvalStatus = String(task.approvalStatus || task.approval_status || "").toLowerCase();
  return (
    status === "awaiting_confirmation" ||
    status === "waiting_human" ||
    type === "human_approval" ||
    approvalStatus === "pending" ||
    Boolean(task.requiresHumanApproval || task.requiresHumanConfirmation)
  );
}

function isWaiting(status) {
  return [
    "queued",
    "pending",
    "waiting",
    "retry_ready",
    "needs_evidence",
    "waiting_human",
    "awaiting_confirmation",
    "blocked"
  ].includes(String(status || ""));
}

function isRunnableTaskStatus(status) {
  return ["waiting", "queued", "pending", "retry_ready"].includes(String(status || ""));
}

function taskDerivedGoalStatus(goal, tasks = []) {
  const current = String(goal?.status || "").toLowerCase();
  const visibleTasks = array(tasks).filter(isUserVisibleTask);
  if (!visibleTasks.length) {
    if (["failed", "error"].includes(current)) return "failed";
    if (["blocked", "waiting_human", "awaiting_confirmation", "running"].includes(current)) return current;
    return current || "queued";
  }
  if (visibleTasks.some((task) => task.status === "running")) return "running";
  if (visibleTasks.some((task) => canApproveTask(task))) return "waiting_human";
  if (visibleTasks.some((task) => task.status === "blocked")) return "blocked";
  if (visibleTasks.every((task) => task.status === "canceled")) return "stopped";
  if (visibleTasks.every((task) => isDone(task.status))) return "completed";
  if (
    ["blocked", "waiting_human", "awaiting_confirmation"].includes(current) &&
    visibleTasks.some((task) => isRunnableTaskStatus(task.status))
  )
    return "queued";
  if (visibleTasks.some((task) => isRunnableTaskStatus(task.status)))
    return current === "running" ? "running" : "queued";
  if (visibleTasks.every((task) => isDone(task.status) || isFailed(task.status))) return "failed";
  return current || "queued";
}

function shouldShowGoalInControl(goal, tasks = [], derivedStatus = "", streamRunning = false) {
  if (!goal) return false;
  if (array(tasks).filter(isUserVisibleTask).length) return true;
  if (streamRunning) return true;
  return ["queued", "pending", "waiting", "completed", "done", "failed", "blocked"].includes(
    String(derivedStatus || "").toLowerCase()
  );
}

function riskLabel(level) {
  return (
    { low: "低风险", medium: "中风险", high: "高风险", critical: "关键风险" }[String(level || "low").toLowerCase()] ||
    level ||
    "低风险"
  );
}

function budgetLabel(status, degradation) {
  const map = { ok: "预算正常", warning: "预算预警", degraded: "已降级", exhausted: "预算耗尽", blocked: "预算阻断" };
  const base = map[String(status || "ok").toLowerCase()] || status || "预算正常";
  return degradation && degradation !== "none" ? `${base} · ${valueLabel(degradation)}` : base;
}

function verificationLabel(status, confidence) {
  const key = String(status || "").toLowerCase();
  if (!key) return "待验证";
  if (key === "unverified") return "未通过验证";
  const map = { verified: "已验证", partially_verified: "部分验证" };
  const value = map[key] || "待验证";
  const percent = Number(confidence || 0) ? ` ${Math.round(Number(confidence) * 100)}%` : "";
  return `${value}${percent}`;
}

function authenticityLevel(score) {
  const value = Number(score || 0);
  if (!value) return { key: "unknown", label: "待检查" };
  if (value >= 0.85) return { key: "high", label: "高度可信" };
  if (value >= 0.7) return { key: "trusted", label: "可信" };
  if (value >= 0.55) return { key: "weak", label: "弱可信" };
  if (value >= 0.35) return { key: "suspicious", label: "可疑" };
  return { key: "critical", label: "高度可疑" };
}

function authenticityLabel(score) {
  const level = authenticityLevel(score);
  return Number(score || 0) ? `${level.label} ${Math.round(Number(score) * 100)}%` : level.label;
}

function authenticitySuggestion(score, warnings = []) {
  const value = Number(score || 0);
  if (!value) return "等待验证生成真实性结果";
  if (value < 0.35) return "阻断当前结果，人工检查证据后再决定是否重试";
  if (value < 0.55) return "人工检查后重试，优先补齐缺失链接、标题或来源证据";
  if (value < 0.7) return "补充证据或减少重复内容后再确认完成";
  if (array(warnings).length) return "结果基本可信，但建议复核提示的问题";
  return "真实性通过，可继续后续流程";
}

function authenticityWarningLabel(value) {
  const text = String(value || "");
  const lower = text.toLowerCase();
  if (/^list contains (\d+) duplicate-looking item/i.test(text))
    return text.replace(/^List contains (\d+) duplicate-looking item\(s\)\.?$/i, "发现 $1 个疑似重复项目");
  if (/^list is missing expected links\.?$/i.test(text)) return "缺少预期链接";
  if (/^list has empty or weak titles\.?$/i.test(text)) return "存在空标题或弱标题";
  if (/^output contains placeholder-like text\.?$/i.test(text)) return "发现占位内容";
  if (/^worker claimed success but produced no result content\.?$/i.test(text)) return "执行器声称成功但没有结果内容";
  if (/duplicate|重复/.test(lower)) return text.replace(/duplicate items?/i, "发现重复项目");
  if (/empty.*link|missing.*link|空链接/.test(lower))
    return text.replace(/empty links?/i, "存在空链接").replace(/missing links?/i, "缺少链接");
  if (/empty.*title|missing.*title|空标题/.test(lower))
    return text.replace(/empty titles?/i, "存在空标题").replace(/missing titles?/i, "缺少标题");
  if (/placeholder|tbd|lorem|模板|占位/.test(lower)) return "发现占位或模板内容";
  if (/generic|template/.test(lower)) return "内容过于模板化";
  if (/field|complete|字段|完整/.test(lower)) return "字段完整率不足";
  if (/short|length|too little|过短/.test(lower)) return "内容长度不足";
  return safeDisplayText(text, 120);
}

function decisionSourceLabel(value) {
  const key = String(value || "").toLowerCase();
  const map = {
    verification: "验证层",
    authenticity: "真实性检查",
    risk: "风险系统",
    human: "人工确认",
    budget: "预算系统",
    system_recommendation: "系统建议",
    user_override: "用户覆盖",
    manual_action: "手动操作",
    human_review: "人工复核",
    recovery: "运行恢复"
  };
  return map[key] || valueLabel(key) || "未记录";
}

function correctiveActionLabel(value) {
  const key = String(value || "").toLowerCase();
  const map = {
    retry_task: "重试任务",
    retry_with_different_model: "换模型重试",
    rerun_browser: "重新读取浏览器",
    request_human_review: "请求人工复核",
    request_more_data: "请求补充数据",
    mark_as_blocked: "保持阻塞",
    continue: "继续",
    cancel_task: "取消任务"
  };
  return map[key] || valueLabel(key) || "建议动作";
}

function correctivePriorityLabel(value) {
  const key = String(value || "").toLowerCase();
  return (
    { low: "低优先级", medium: "中优先级", high: "高优先级", critical: "关键优先级" }[key] ||
    valueLabel(key) ||
    "中优先级"
  );
}

function decisionPercentLabel(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0%";
  return `${Math.round(Math.max(0, Math.min(1, number)) * 100)}%`;
}

function estimatedCostLabel(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "成本未知";
  if (number >= 0.7) return "高成本";
  if (number >= 0.4) return "中成本";
  return "低成本";
}

function artifactId(ref) {
  if (!ref) return "";
  if (typeof ref === "string") return ref;
  return String(ref.id || ref.name || ref.key || ref.path || ref.url || ref.artifact || ref.target || "").trim();
}

function valueLabel(value) {
  const key = String(value || "")
    .trim()
    .toLowerCase();
  return SIMPLE_VALUE_LABEL[key] || value || "";
}

function displayStatus(value, fallback = "待命") {
  return STATUS_LABEL[value] || valueLabel(value) || fallback;
}

function hasHttpUrl(value = "") {
  return /\bhttps?:\/\/[^\s"'<>()[\]{}]+/i.test(String(value || ""));
}

function timelineRenderKey(item = {}, index = 0) {
  const base = [item.id, item.time, item.label, item.level, item.message]
    .filter(Boolean)
    .map((value) => String(value).slice(0, 80))
    .join("|");
  return `timeline-${base || "item"}-${index}`;
}

function logRenderKey(line = {}, index = 0) {
  const base = [line.id, line.time, line.level, line.message]
    .filter(Boolean)
    .map((value) => String(value).slice(0, 80))
    .join("|");
  return `log-${base || "item"}-${index}`;
}

function taskExecutionGroup(task = {}, node = {}) {
  const type = String(task.type || node.type || "").toLowerCase();
  const toolWorker = String(
    task.toolWorker || task.tool_worker || node.toolWorker || node.tool_worker || ""
  ).toLowerCase();
  const modelPool = String(task.modelPool || task.model_pool || node.modelPool || node.model_pool || "").toLowerCase();
  const model = String(task.model || node.model || "").toLowerCase();
  const taskInput = [task.input, node.input, task.prompt, node.prompt, task.description, node.description]
    .filter(Boolean)
    .join("\n");
  if (isRouteInternalTask(task) || isRouteInternalTask(node.task || node)) return "agent";
  if (type === "human_approval" || toolWorker === "human") return "human";
  if (["web", "document", "documents", "browser"].includes(toolWorker)) return "tool";
  if (model === "web-tool" || model === "document-tool" || model === "browser-tool") return "tool";
  if (["web_search", "api_read", "document_generate", "browser", "browser_read", "page_read"].includes(type))
    return "tool";
  if (
    ["web_read", "web_fetch", "http_fetch", "public_web_read", "public_api_read"].includes(type) &&
    hasHttpUrl(taskInput)
  )
    return "tool";
  return "agent";
}

function taskExecutionGroupClass(group) {
  if (group === "tool") return "tool";
  if (group === "human") return "human";
  return "agent";
}

function taskExecutionGroupLabel(group) {
  const map = {
    agent: "Agent 任务",
    tool: "Tool 调用",
    human: "人工确认"
  };
  return map[group] || "任务";
}

function taskExecutionGroupIcon(group) {
  const map = {
    agent: "psychology",
    tool: "construction",
    human: "person_alert"
  };
  return map[group] || "adjust";
}

function taskWorkerLabel(task = {}) {
  const group = taskExecutionGroup(task);
  if (group === "human") return "人工确认";
  if (group === "tool") {
    const toolWorker = String(task.toolWorker || task.tool_worker || "").toLowerCase();
    if (toolWorker === "web") return "web 工具";
    if (toolWorker === "document" || toolWorker === "documents") return "文档工具";
    if (toolWorker === "browser") return "浏览器工具";
    if (String(task.modelPool || "").toLowerCase() === "codex-cli") return "Codex CLI";
    return task.model || valueLabel(task.type) || "工具调用";
  }
  if (isRouteInternalTask(task)) return "Agent 总指挥";
  if (String(task.modelPool || "").toLowerCase() === "codex-cli") return "Codex CLI Agent";
  return task.model || valueLabel(task.modelPool) || task.modelPool || "Agent 模型";
}

function eventTypeLabel(type) {
  const key = String(type || "")
    .trim()
    .toLowerCase();
  return EVENT_TYPE_LABEL[key] || valueLabel(key) || "事件";
}

function rootCauseLabel(code) {
  const key = String(code || "")
    .trim()
    .toLowerCase();
  return ROOT_CAUSE_LABEL[key] || valueLabel(key) || code || "原因";
}

function commonFailureTextLabel(value) {
  let text = safeDisplayText(value, 1200).trim();
  if (!text) return "";
  const jsonMessage = text.match(/"message"\s*:\s*"([^"]+)"/i);
  if (jsonMessage) text = jsonMessage[1];
  if (/Codex CLI chat proxy exited with code\s+\d+/i.test(text)) {
    const code = text.match(/Codex CLI chat proxy exited with code\s+(\d+)/i)?.[1] || "";
    if (/usage limit|purchase more credits|requires more credits|insufficient credits|credit/i.test(text)) {
      return "Codex CLI 账号额度已用尽或供应商额度不足，当前模型无法继续。";
    }
    return `Codex CLI 模型代理调用失败${code ? `（退出代码 ${code}）` : ""}，原始日志包含本地 CLI 警告；需要检查 Codex CLI 账号额度或本地 CLI 状态。`;
  }
  if (
    /This request requires more credits|Prompt tokens limit exceeded|can only afford|purchase more credits/i.test(text)
  ) {
    return "供应商额度不足，当前模型请求无法继续。";
  }
  if (/You've hit your usage limit|usage limit|upgrade to pro/i.test(text)) {
    return "模型账号已达到使用额度限制，当前请求无法继续。";
  }
  if (/^Worker returned error text:\s*/i.test(text)) {
    return `执行器返回错误：${commonFailureTextLabel(text.replace(/^Worker returned error text:\s*/i, ""))}`;
  }
  if (/^Final synthesis failed:\s*/i.test(text)) {
    return `最终汇总失败：${commonFailureTextLabel(text.replace(/^Final synthesis failed:\s*/i, ""))}`;
  }
  const translated = text
    .replace(/^verification_failed$/i, "验证失败。")
    .replace(/^timeout$/i, "调用超时。")
    .replace(/^fetch failed$/i, "网络请求失败。")
    .replace(/^network error\.?$/i, "网络请求失败。")
    .replace(/^All models failed\.?$/i, "所有候选模型都调用失败。")
    .replace(/^Model returned invalid content\.?$/i, "模型返回内容格式无效。")
    .replace(/^Planner response did not contain a valid task graph\.?/i, "规划器没有返回有效任务图。")
    .replace(
      /^Planner response did not contain a valid structured plan object\.?/i,
      "规划器没有返回有效的结构化计划对象。"
    )
    .replace(/^Commander returned an invalid or empty plan\.?$/i, "总指挥返回的计划为空或格式无效。")
    .replace(/^Commander could not create a plan:\s*/i, "总指挥无法创建执行计划：")
    .replace(/^Codex CLI chat proxy exited with code\s+(\d+)\./i, "Codex CLI 模型代理退出（代码 $1）。")
    .replace(/You've hit your usage limit[^。]*$/i, "Codex CLI 账号额度已用尽或达到使用上限。")
    .replace(/This request requires more credits[^。]*$/i, "供应商额度不足，当前请求无法继续。")
    .replace(/Prompt tokens limit exceeded[^。]*$/i, "供应商当前额度不足以承载本次提示词。")
    .replace(/Diagnostics:\s*/gi, "诊断：")
    .replace(/parseError=multiple_different_json_documents/gi, "解析错误=模型输出了多个不同 JSON 对象")
    .replace(/parseError=multiple_repeated_json_documents/gi, "解析错误=模型重复输出了多个 JSON 对象")
    .replace(/topLevelJsonDocuments=(\d+)/gi, "顶层 JSON 对象数=$1")
    .replace(/hasValidTaskGraph=false/gi, "任务图 schema 未通过")
    .replace(/taskCount=(\d+)/gi, "任务数=$1")
    .replace(/purchase more credits|upgrade to a paid account|upgrade to pro/i, "需要补充额度或切换可用账号")
    .replace(/can only afford\s+\d+/i, "当前可用额度不足")
    .replace(/usage limit/i, "使用额度限制")
    .replace(
      /^AgentRoute produced no successful worker evidence, so it cannot create a final answer\.?$/i,
      "AgentRoute 没有取得成功的执行器证据，因此不能生成最终答案。"
    )
    .replace(
      /^AgentRoute planned tasks, but no worker produced successful verified evidence\.?$/i,
      "AgentRoute 已规划任务，但没有 worker 产出成功且通过验证的 evidence。"
    )
    .replace(
      /^Document task has no upstream or explicit content to render\.?$/i,
      "文档任务没有可渲染的上游内容或显式正文。"
    )
    .replace(/^Expected content was not found in file:\s*(.+)$/i, "文件中没有找到预期内容：$1")
    .replace(/^Expected JSON fields were not confirmed in file:\s*(.+)$/i, "文件中没有确认到预期 JSON 字段：$1")
    .replace(/^Expected file does not exist:\s*(.+)$/i, "预期文件不存在：$1")
    .replace(/^Verified file is empty:\s*(.+)$/i, "文件存在但为空：$1")
    .replace(/^Worker output contains error-like text\.?$/i, "执行器输出里包含疑似错误文本。")
    .replace(/^Semantic evidence issue:\s*/i, "语义证据问题：")
    .replace(/^Authenticity check is weak\s*\((.+?)\):\s*(.+)$/i, "真实性检查偏弱（$1）：$2")
    .replace(/^List has\s+(\d+)\s+items but expected\s+(\d+)\.?$/i, "列表只有 $1 项，但期望 $2 项。")
    .replace(/^User location is not supported for the API use\.?$/i, "当前地区不支持调用这个模型 API。")
    .replace(
      /credits exhausted|credit balance is too low|insufficient credits|requires more credits/i,
      "模型或供应商额度已耗尽"
    )
    .replace(/quota exceeded|insufficient_quota|rate limit exceeded/i, "模型或供应商额度/频率限制已触发")
    .replace(
      /^HTTP\s+(\d+)(.*)$/i,
      (_, status, rest) => `上游服务返回 HTTP ${status}${rest ? `：${rest.trim()}` : "。"}`
    )
    .replace(/^(.+?) produced no usable output\.?$/i, (_, source) => `${source} 没有返回可用内容。`)
    .replace(/^(.+?) returned no usable output\.?$/i, (_, source) => `${source} 没有返回可用内容。`)
    .replace(/^(.+?) did not provide usable output\.?$/i, (_, source) => `${source} 没有提供可用内容。`)
    .replace(/^No usable output from\s+(.+?)\.?$/i, (_, source) => `${source} 没有返回可用内容。`)
    .replace(/^Model call failed\.?$/i, "模型调用失败。")
    .replace(/^Provider request failed\.?$/i, "供应商请求失败。")
    .replace(/^Upstream request failed\.?$/i, "上游请求失败。");
  return valueLabel(translated) || translated;
}

function dependencyReasonLabel(reason) {
  const text = safeDisplayText(reason, 1200);
  const cleanStatus = (status) => {
    const key = String(status || "")
      .trim()
      .replace(/[.。]+$/, "")
      .toLowerCase();
    return displayStatus(key, valueLabel(key) || key);
  };
  const dependencyStatusText = (dep, status) => {
    const key = String(status || "")
      .trim()
      .replace(/[.。]+$/, "")
      .toLowerCase();
    if (key === "failed") return `上游任务 ${dep} 已失败，当前任务不能继续`;
    if (key === "blocked") return `上游任务 ${dep} 已被阻塞，当前任务不能继续`;
    if (key === "canceled") return `上游任务 ${dep} 已取消，当前任务不能继续`;
    return `依赖 ${dep} 状态为 ${cleanStatus(status)}`;
  };
  return text
    .replace(/^Strategy requires human approval before this task can execute\.?$/i, "策略要求执行前先获得人工批准。")
    .replace(/^Task is waiting for human approval\.?$/i, "任务正在等待人工批准。")
    .replace(/^Missing dependency:\s*/i, "缺少依赖：")
    .replace(/^Dependency\s+(.+?)\s+is not completed$/i, "依赖 $1 尚未完成")
    .replace(/^Dependency\s+(.+?)\s+is waiting for human approval\.?$/i, "依赖 $1 正在等待人工批准")
    .replace(/^Dependency\s+(.+?)\s+did not pass verification\.?$/i, "依赖 $1 未通过验证")
    .replace(/^Dependency\s+(.+?)\s+is\s+(.+?)\.?$/i, (_, dep, status) => dependencyStatusText(dep, status))
    .replace(/^Required artifact is not available:\s*/i, "缺少必要产物：")
    .replace(/^Dependency is awaiting retry and downstream work must wait\.?$/i, "上游任务等待重试，下游任务必须先等待")
    .replace(/^Dependency graph blocked this task\.?$/i, "依赖图阻止了当前任务执行")
    .replace(
      /^No upstream model proxy is configured for\s+(.+?)\.\s*Configure.+$/i,
      "模型 $1 没有可用的内部模型连接或 provider key"
    )
    .replace(
      /^No upstream model route is configured for\s+(.+?)\.\s*Configure.+$/i,
      "模型 $1 没有可用的内部模型连接或 provider key"
    )
    .replace(
      /^No internal model route is configured for\s+(.+?)\.\s*Configure.+$/i,
      "模型 $1 没有可用的内部模型连接或 provider key"
    )
    .replace(/^Missing artifact:\s*/i, "缺少产物：")
    .replace(/^Task status is\s+(.+?), not waiting\.$/i, (_, status) => {
      const key = String(status || "")
        .trim()
        .toLowerCase();
      if (key === "failed") return "任务已失败，当前不能调度执行";
      if (key === "canceled") return "任务已取消，当前不再参与调度";
      if (key === "blocked") return "任务已被阻塞，当前不能调度执行";
      return `任务状态是 ${valueLabel(status) || status}，当前不能调度执行`;
    });
}

function failureReasonLabel(reason) {
  const text = dependencyReasonLabel(reason);
  const translated = text
    .replace(/^Browser task did not include a URL to open\.?$/i, "浏览器任务没有提供可打开的 URL。")
    .replace(/^Browser page open failed\.?$/i, "浏览器打开页面失败。")
    .replace(/^Browser opened the URL but returned no readable text\.?$/i, "浏览器打开了页面，但没有读取到可用文本。")
    .replace(/^Browser session not found\.?$/i, "浏览器会话不存在或已失效。")
    .replace(
      /^Web search has no successful readable result-page evidence\.?$/i,
      "联网搜索没有拿到可读取的网页证据。请检查任务是否真的走了 web 工具、搜索服务是否可用、目标页面是否可公开读取。"
    )
    .replace(/^Worker returned standardized evidence\.?$/i, "执行器返回了标准证据结构，但这本身不代表任务完成。")
    .replace(/^Worker output is non-empty and inspectable\.?$/i, "执行器有输出，但输出还没有证明任务满足要求。")
    .replace(/^Evidence includes semantic result summary\.?$/i, "证据里包含语义摘要。")
    .replace(/^Evidence says the result addresses success criteria\.?$/i, "执行器声称满足成功标准，但仍需证据验证。")
    .replace(/^Shell exit code is 0\.?$/i, "本地命令退出码为 0。")
    .replace(
      /^Task budget is emergency; avoid retries and optional work\.?$/i,
      "任务预算已进入紧急状态，系统不会继续做可选重试。"
    )
    .replace(
      /^Final answer reports incomplete required evidence\.?$/i,
      "最终回答承认关键证据不完整，所以目标不能标记为完成。"
    )
    .replace(/^Final synthesis produced no content\.?$/i, "最终汇总没有生成任何内容。")
    .replace(/^Budget governor blocked this task\.?$/i, "预算控制器阻止了这个任务继续执行。")
    .replace(/^risk engine blocked this action$/i, "风险控制器阻止了这个动作。");
  return commonFailureTextLabel(translated);
}

function verificationReasonLabel(reason) {
  const text = failureReasonLabel(reason);
  return text
    .replace(
      /^Ignored failed non-critical web source response\.?$/i,
      "已忽略一个非关键网页来源读取失败，不影响当前验证。"
    )
    .replace(
      /^Ignored failed non-critical web source status\s+(.+?)\.?$/i,
      (_, status) => `已忽略一个非关键网页来源读取失败（状态 ${valueLabel(status) || status}），不影响当前验证。`
    )
    .replace(/^API response was\s+(\d+)\.?$/i, "API/网页响应状态为 $1。")
    .replace(
      /^Web search captured successful readable result-page evidence\.?$/i,
      "联网搜索拿到了可读取的结果页面证据。"
    )
    .replace(/^Web evidence overlaps an alternative search query:\s*(.+?)\.?$/i, "网页证据匹配候选查询：$1。")
    .replace(/^Output overlaps with task success criteria\.?$/i, "输出与任务成功标准有重合。")
    .replace(/^Authenticity check passed\s*\((.+?)\)\.?$/i, "真实性检查通过（$1）。")
    .replace(/^Browser URL evidence is present\.?$/i, "浏览器证据包含 URL。")
    .replace(/^Browser title evidence is present\.?$/i, "浏览器证据包含页面标题。")
    .replace(/^Browser page text is substantial\.?$/i, "浏览器证据包含足够的页面文本。");
}

function isSupportiveVerificationReason(reason) {
  const text = String(redactDisplayText(reason) || "").trim();
  return /^(Shell exit code is 0|Worker returned standardized evidence|Worker output is non-empty|Evidence includes semantic result summary|Evidence says the result addresses success criteria|Authenticity check passed)/i.test(
    text
  );
}

function taskFailureReasons(task = {}) {
  const status = String(task.status || "").toLowerCase();
  if (isDone(status)) return [];
  const failureLike = ["blocked", "failed", "error", "canceled", "cancelled"].includes(status);
  if (!failureLike) return [];
  const primary = [
    task.error,
    task.blockedReason,
    task.budgetBlockedReason,
    task.approvalReason,
    ...array(task.detectedIssues)
  ];
  const primaryHasReason = primary.some((item) => String(redactDisplayText(item) || "").trim());
  const candidates = primaryHasReason
    ? primary
    : [...primary, ...array(task.verificationReasons).filter((item) => !isSupportiveVerificationReason(item))];
  const seen = new Set();
  return candidates
    .map((item) => failureReasonLabel(item))
    .map((item) => String(item || "").trim())
    .filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    })
    .slice(0, 6);
}

function renderMarkdownInline(text, keyPrefix = "inline") {
  const source = String(text || "");
  const parts = [];
  const pattern = /(`[^`]+`|\*\*[^*]+?\*\*|\*[^*\n]+?\*|\[[^\]\n]+?\]\(https?:\/\/[^)\s]+?\))/g;
  let lastIndex = 0;
  let match = null;
  while ((match = pattern.exec(source))) {
    if (match.index > lastIndex) parts.push(source.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${parts.length}-${match.index}`;
    if (token.startsWith("`")) {
      parts.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      parts.push(<strong key={key}>{renderMarkdownInline(token.slice(2, -2), `${key}-strong`)}</strong>);
    } else if (token.startsWith("*")) {
      parts.push(<em key={key}>{renderMarkdownInline(token.slice(1, -1), `${key}-em`)}</em>);
    } else {
      const linkMatch = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/i);
      if (linkMatch) {
        parts.push(
          <a key={key} href={linkMatch[2]} target="_blank" rel="noreferrer">
            {linkMatch[1]}
          </a>
        );
      } else {
        parts.push(token);
      }
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < source.length) parts.push(source.slice(lastIndex));
  return parts.length ? parts : source;
}

function isMarkdownTableSeparator(line = "") {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(String(line || ""));
}

function splitMarkdownTableRow(line = "") {
  return String(line || "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownBlockStart(line = "", nextLine = "") {
  const text = String(line || "");
  if (!text.trim()) return true;
  if (/^\s*```/.test(text)) return true;
  if (/^\s{0,3}#{1,6}\s+/.test(text)) return true;
  if (/^\s{0,3}>\s?/.test(text)) return true;
  if (/^\s{0,3}([-*+])\s+/.test(text)) return true;
  if (/^\s{0,3}\d+[.)]\s+/.test(text)) return true;
  return text.includes("|") && isMarkdownTableSeparator(nextLine);
}

function MarkdownOutput({ content }) {
  const lines = String(content || "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^\s*```/.test(line)) {
      const language = trimmed.replace(/^```/, "").trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      blocks.push(
        <pre key={`code-${blocks.length}`} data-language={language || undefined}>
          <code>{codeLines.join("\n")}</code>
        </pre>
      );
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const HeadingTag = `h${Math.min(4, Math.max(2, level + 1))}`;
      blocks.push(
        <HeadingTag key={`heading-${blocks.length}`}>
          {renderMarkdownInline(heading[2].replace(/\s+#+\s*$/, ""), `heading-${blocks.length}`)}
        </HeadingTag>
      );
      continue;
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s{0,3}>\s?/, ""));
        index += 1;
      }
      index -= 1;
      blocks.push(
        <blockquote key={`quote-${blocks.length}`}>
          {renderMarkdownInline(quoteLines.join(" "), `quote-${blocks.length}`)}
        </blockquote>
      );
      continue;
    }

    if (line.includes("|") && isMarkdownTableSeparator(lines[index + 1])) {
      const header = splitMarkdownTableRow(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitMarkdownTableRow(lines[index]));
        index += 1;
      }
      index -= 1;
      blocks.push(
        <div className="markdown-table-wrap" key={`table-${blocks.length}`}>
          <table>
            <thead>
              <tr>
                {header.map((cell, cellIndex) => (
                  <th key={`h-${cellIndex}`}>{renderMarkdownInline(cell, `table-${blocks.length}-h-${cellIndex}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`r-${rowIndex}`}>
                  {header.map((_, cellIndex) => (
                    <td key={`c-${cellIndex}`}>
                      {renderMarkdownInline(row[cellIndex] || "", `table-${blocks.length}-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    const unordered = line.match(/^\s{0,3}([-*+])\s+(.+)$/);
    const ordered = line.match(/^\s{0,3}\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const orderedList = Boolean(ordered);
      const items = [];
      while (index < lines.length) {
        const itemMatch = orderedList
          ? lines[index].match(/^\s{0,3}\d+[.)]\s+(.+)$/)
          : lines[index].match(/^\s{0,3}[-*+]\s+(.+)$/);
        if (!itemMatch) break;
        items.push(itemMatch[1]);
        index += 1;
      }
      index -= 1;
      const ListTag = orderedList ? "ol" : "ul";
      blocks.push(
        <ListTag key={`list-${blocks.length}`}>
          {items.map((item, itemIndex) => (
            <li key={`item-${itemIndex}`}>{renderMarkdownInline(item, `list-${blocks.length}-${itemIndex}`)}</li>
          ))}
        </ListTag>
      );
      continue;
    }

    const paragraphLines = [trimmed];
    while (index + 1 < lines.length && !isMarkdownBlockStart(lines[index + 1], lines[index + 2] || "")) {
      index += 1;
      paragraphLines.push(lines[index].trim());
    }
    blocks.push(
      <p key={`paragraph-${blocks.length}`}>
        {renderMarkdownInline(paragraphLines.join(" "), `paragraph-${blocks.length}`)}
      </p>
    );
  }

  return <div className="final-output markdown-output">{blocks.length ? blocks : <p>{content}</p>}</div>;
}

function uniqueDisplayList(values = []) {
  const seen = new Set();
  return array(values)
    .map((item) => safeDisplayText(item, 1200))
    .map((item) => item.trim())
    .filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function recoveryReasonLabel(reason) {
  const text = String(reason || "").trim();
  if (!text) return "恢复原因未记录";
  const translated = text
    .replace(
      /^Browser session was lost during process restart; task needs review before retry\.?$/i,
      "浏览器会话在进程重启期间失效，重试前需要人工检查"
    )
    .replace(
      /^Worker process was lost during process restart; task needs review before retry\.?$/i,
      "执行器进程在系统重启期间丢失，重试前需要人工检查"
    )
    .replace(/^Retry budget exhausted during recovery\.?$/i, "恢复时重试预算已耗尽");
  return valueLabel(translated) || dependencyReasonLabel(translated) || safeDisplayText(translated, 80);
}

function hasRecoverySummary(summary) {
  if (!summary || typeof summary !== "object") return false;
  if (summary.trigger && summary.trigger !== "none") return true;
  return (
    [
      "scannedGoals",
      "scannedTasks",
      "recoveredTasks",
      "recoveredGoals",
      "interruptedTasks",
      "staleBrowserSessions",
      "workerLost"
    ].some((key) => Number(summary[key] || 0) > 0) ||
    array(summary.warnings).length ||
    array(summary.errors).length
  );
}

function recoveryStatusText(summary) {
  if (!hasRecoverySummary(summary)) return "未运行恢复扫描";
  if (array(summary.errors).length) return "需要处理";
  if (
    array(summary.warnings).length ||
    Number(summary.interruptedTasks || 0) ||
    Number(summary.workerLost || 0) ||
    Number(summary.staleBrowserSessions || 0)
  )
    return "有警告";
  return "正常";
}

function recoveryStatusClass(summary) {
  if (!hasRecoverySummary(summary)) return "wait";
  if (array(summary.errors).length) return "fail";
  if (
    array(summary.warnings).length ||
    Number(summary.interruptedTasks || 0) ||
    Number(summary.workerLost || 0) ||
    Number(summary.staleBrowserSessions || 0)
  )
    return "wait";
  return "done";
}

function taskRecoveryInfo(task = {}) {
  const state = task.recoveryState && typeof task.recoveryState === "object" ? task.recoveryState : {};
  const reason =
    task.recoveryReason ||
    state.reason ||
    (/restart|worker|browser session/i.test(String(task.blockedReason || "")) ? task.blockedReason : "");
  const recoveredAt = state.recoveredAt || state.at || task.recoveredAt || "";
  const staleBrowserSessions = array(state.staleBrowserSessions || state.stale_browser_sessions);
  if (!reason && !recoveredAt && !state.targetStatus && !state.workerLost && !staleBrowserSessions.length) return null;
  return {
    reason,
    recoveredAt,
    from: state.from || "",
    to: state.to || state.targetStatus || task.status || "",
    workerLost: Boolean(state.workerLost || /worker/i.test(String(reason || task.blockedReason || ""))),
    staleBrowserSessions
  };
}

function normalizeTask(raw = {}, index = 0) {
  const id = raw.id || uid("task");
  const dependencies = array(raw.dependsOn).length ? array(raw.dependsOn) : array(raw.dependencies);
  const internal = isRouteInternalTask({ ...raw, id });
  const normalized = {
    id,
    internal,
    title: raw.title || id,
    description: raw.description || "",
    type: raw.type || "",
    modelPool: raw.modelPool || "free",
    toolWorker: raw.toolWorker || raw.tool_worker || "",
    input: raw.input || "",
    source: raw.source || raw.createdBy || raw.created_by || raw.creationSource || raw.creation_source || "",
    createdByTaskId:
      raw.createdByTaskId || raw.created_by_task_id || raw.invokedByTaskId || raw.invoked_by_task_id || "",
    createdByTaskTitle:
      raw.createdByTaskTitle || raw.created_by_task_title || raw.invokedByTaskTitle || raw.invoked_by_task_title || "",
    model: raw.model || "",
    candidates: array(raw.candidates),
    difficulty: raw.difficulty || raw.complexity || "low",
    complexity: raw.complexity || raw.difficulty || "low",
    riskLevel: raw.riskLevel || "low",
    riskReasons: array(raw.riskReasons),
    verificationStatus: raw.verificationStatus || "",
    verificationConfidence: Number(raw.verificationConfidence || 0),
    verificationReasons: array(raw.verificationReasons),
    detectedIssues: array(raw.detectedIssues),
    authenticityScore: Number(raw.authenticityScore || raw.authenticity_score || 0),
    authenticityWarnings: array(raw.authenticityWarnings || raw.authenticity_warnings),
    authenticityReasons: array(raw.authenticityReasons || raw.authenticity_reasons),
    authenticitySignals: array(raw.authenticitySignals || raw.authenticity_signals),
    decisionSource: raw.decisionSource || raw.decision_source || "",
    verificationSuggestedNextState: raw.verificationSuggestedNextState || raw.verification_suggested_next_state || "",
    recommendedActions: array(raw.recommendedActions || raw.recommended_actions),
    correctiveSummary: raw.correctiveSummary || raw.corrective_summary || null,
    correctiveHistory: array(raw.correctiveHistory || raw.corrective_history),
    rankedActions: array(raw.rankedActions || raw.ranked_actions),
    recommendedAction: raw.recommendedAction || raw.recommended_action || null,
    actionDecisionSummary: raw.actionDecisionSummary || raw.action_decision_summary || null,
    actionDecisionHistory: array(raw.actionDecisionHistory || raw.action_decision_history),
    actionLearningSummary: raw.actionLearningSummary || raw.action_learning_summary || null,
    actionLearningHistory: array(raw.actionLearningHistory || raw.action_learning_history),
    decisionAttributionSummary: raw.decisionAttributionSummary || raw.decision_attribution_summary || null,
    decisionAttributionHistory: array(raw.decisionAttributionHistory || raw.decision_attribution_history),
    budgetStatus: raw.budgetStatus || "ok",
    degradationLevel: raw.degradationLevel || "none",
    budgetWarnings: array(raw.budgetWarnings),
    budgetBlockedReason: raw.budgetBlockedReason || "",
    dependsOn: dependencies,
    dependencies,
    produces: array(raw.produces),
    consumes: array(raw.consumes),
    priority: Number(raw.priority || 0),
    graphDepth: Number(raw.graphDepth || 0),
    dependencyStatus: raw.dependencyStatus || "",
    dependencyReasons: array(raw.dependencyReasons),
    blockedBy: array(raw.blockedBy),
    missingArtifacts: array(raw.missingArtifacts),
    strategicPhase: raw.strategicPhase || "",
    strategicObjective: raw.strategicObjective || "",
    strategicRationale: raw.strategicRationale || "",
    attempts: Number(raw.attempts || 0),
    maxAttempts: Number(raw.maxAttempts || 1),
    requiresHumanApproval: Boolean(raw.requiresHumanApproval),
    requiresHumanConfirmation: Boolean(raw.requiresHumanConfirmation),
    approvalReason: raw.approvalReason || "",
    approvalStatus: raw.approvalStatus || "",
    blockedReason: raw.blockedReason || "",
    recoveryState: raw.recoveryState && typeof raw.recoveryState === "object" ? raw.recoveryState : null,
    recoveryReason: raw.recoveryReason || raw.recovery_reason || "",
    routingReason: raw.routingReason || "",
    successCriteria: array(raw.successCriteria),
    status: raw.status || "waiting",
    result: raw.result || "",
    content: raw.content || "",
    error: raw.error || "",
    elapsedMs: raw.elapsedMs || 0,
    progress: Number.isFinite(Number(raw.progress)) ? Number(raw.progress) : 0,
    createdAt: raw.createdAt || nowTime(),
    startedAt: raw.startedAt || raw.started_at || "",
    finishedAt: raw.finishedAt || raw.finished_at || "",
    updatedAt: raw.updatedAt || raw.updated_at || raw.at || raw.createdAt || raw.created_at || "",
    history: array(raw.history),
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : index
  };
  if (isDone(normalized.status)) {
    normalized.error = "";
    normalized.blockedReason = "";
    normalized.budgetBlockedReason = "";
    normalized.approvalReason = "";
    normalized.detectedIssues = [];
  }
  return normalized;
}

function displayTask(taskOrTitle, fallback = "任务") {
  if (typeof taskOrTitle === "string") return displayTaskTitle(taskOrTitle, fallback);
  const task = taskOrTitle || {};
  return displayTaskTitle(task.title || task.id, fallback);
}

function normalizeGoalForState(raw = {}) {
  const tasks = array(raw.tasks).length ? array(raw.tasks) : array(raw.subtasks);
  const id = raw.id || raw.goalId || raw.goal_id || uid("goal");
  return {
    ...raw,
    id,
    goalId: raw.goalId || raw.goal_id || id,
    title: raw.title || shortText(raw.goal || "新目标", 76),
    status: raw.status || "queued",
    flow: raw.flow || {},
    tasks: tasks.map((task, index) => normalizeTask(task, index)).filter(isDisplayTask),
    strategyHistory: array(raw.strategyHistory),
    graph: raw.graph || null,
    recoverySummary: raw.recoverySummary || raw.recovery_summary || null,
    output: raw.output || ""
  };
}

function readyIdList(graph) {
  const raw = array(graph?.readyTaskIds).length ? array(graph.readyTaskIds) : array(graph?.readyTasks);
  return raw
    .map((item) => {
      if (typeof item === "string") return item;
      return String(item?.id || item?.taskId || item?.task?.id || "").trim();
    })
    .filter(Boolean);
}

const AI_SDK_AGENT_EVENT_BY_PART = {
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
  "data-agent-action": "actionRanked",
  "data-agent-event": "message"
};

const agentRouteUiTransport = new DefaultChatTransport({
  api: AGENT_ROUTE_UI_STREAM_API,
  prepareSendMessagesRequest({ body }) {
    return { body: body || {} };
  }
});

function agentEventFromUiMessageChunk(chunk) {
  if (!chunk || typeof chunk !== "object") return null;
  if (chunk.type === "error") {
    return { type: "error", data: { message: chunk.errorText || "AgentRoute stream error" } };
  }
  if (!String(chunk.type || "").startsWith("data-agent-")) return null;
  const data = chunk.data && typeof chunk.data === "object" ? chunk.data : {};
  const type = data.event || data.type || AI_SDK_AGENT_EVENT_BY_PART[chunk.type] || "";
  if (String(type || "").toLowerCase() === "langgraph") return null;
  if (!type || chunk.type === "data-agent-heartbeat") return null;
  const payload = data.payload && typeof data.payload === "object" ? data.payload : data.payload == null ? data : data;
  return { type, data: payload };
}

async function consumeAgentRouteUiMessageStream(payload, { signal, onEvent }) {
  const stream = await agentRouteUiTransport.sendMessages({
    chatId: String(payload.goal_id || payload.goalId || uid("goal")),
    trigger: "submit-message",
    messageId: undefined,
    messages: [],
    body: payload,
    abortSignal: signal
  });
  const reader = stream.getReader();
  let sawAgentError = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const event = agentEventFromUiMessageChunk(value);
      if (!event) continue;
      if (event.type === "error") {
        if (sawAgentError) continue;
        sawAgentError = true;
      }
      if (value?.type === "data-agent-error") sawAgentError = true;
      onEvent(event.type, event.data);
    }
  } finally {
    reader.releaseLock();
  }
}

function localGraph(goal) {
  const tasks = array(goal?.tasks).filter(isGraphVisibleTask);
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const availableArtifacts = new Map();
  for (const task of tasks) {
    if (!isDone(task.status)) continue;
    const verification = String(task.verificationStatus || "").toLowerCase();
    if (verification && verification !== "verified" && verification !== "partially_verified") continue;
    for (const ref of array(task.produces)) {
      const id = artifactId(ref);
      if (id) availableArtifacts.set(id, { id, taskId: task.id });
    }
  }
  const depthMemo = new Map();
  const depthFor = (taskId, seen = new Set()) => {
    if (depthMemo.has(taskId)) return depthMemo.get(taskId);
    if (seen.has(taskId)) return 0;
    const task = taskMap.get(taskId);
    if (!task) return 0;
    const deps = array(task.dependsOn).filter((id) => taskMap.has(id));
    const depth = deps.length ? 1 + Math.max(...deps.map((id) => depthFor(id, new Set([...seen, taskId])))) : 0;
    depthMemo.set(taskId, depth);
    return depth;
  };
  const nodes = tasks.map((task) => {
    const blockedBy = array(task.blockedBy);
    const waitingFor = [];
    const reasons = array(task.dependencyReasons);
    for (const depId of array(task.dependsOn)) {
      const dep = taskMap.get(depId);
      if (!dep) {
        blockedBy.push(depId);
        reasons.push(`缺少依赖：${depId}`);
      } else if (isFailed(dep.status)) {
        blockedBy.push(depId);
        reasons.push(`依赖 ${depId} 状态为 ${STATUS_LABEL[dep.status] || valueLabel(dep.status) || dep.status}`);
      } else if (!isDone(dep.status)) {
        waitingFor.push(depId);
        reasons.push(`依赖 ${depId} 尚未完成`);
      }
    }
    const missingArtifacts = array(task.missingArtifacts).length
      ? array(task.missingArtifacts)
      : array(task.consumes)
          .map(artifactId)
          .filter((id) => id && !availableArtifacts.has(id));
    if (missingArtifacts.length) reasons.push(`缺少产物：${missingArtifacts.join(", ")}`);
    const waitingStatus = ["waiting", "queued", "pending", "retry_ready"].includes(task.status);
    const readiness =
      task.dependencyStatus ||
      (blockedBy.length || isFailed(task.status)
        ? "blocked"
        : !waitingStatus
          ? "not_waiting"
          : waitingFor.length || missingArtifacts.length
            ? "waiting"
            : "ready");
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      dependencies: array(task.dependsOn),
      consumes: array(task.consumes),
      produces: array(task.produces),
      depth: depthFor(task.id),
      readiness: {
        ready: readiness === "ready",
        status: readiness,
        reasons,
        blockedBy: [...new Set(blockedBy)],
        waitingFor: [...new Set(waitingFor)],
        missingArtifacts
      }
    };
  });
  const readyTaskIds = nodes.filter((node) => node.readiness.ready).map((node) => node.id);
  const parallelMap = new Map();
  for (const node of nodes.filter((item) => item.readiness.ready)) {
    const key = String(node.depth || 0);
    if (!parallelMap.has(key)) parallelMap.set(key, []);
    parallelMap.get(key).push(node.id);
  }
  return {
    valid: true,
    nodes,
    edges: nodes.flatMap((node) => node.dependencies.map((dep) => ({ from: dep, to: node.id, type: "depends_on" }))),
    artifacts: [...availableArtifacts.values()],
    readyTaskIds,
    parallelGroups: [...parallelMap.entries()].map(([depth, taskIds]) => ({ depth: Number(depth), taskIds })),
    blockedChains: nodes
      .filter((node) => node.readiness.status === "blocked")
      .map((node) => ({ taskId: node.id, blockedBy: node.readiness.blockedBy, reasons: node.readiness.reasons }))
  };
}

function filterGraphSnapshotForTasks(graph, tasks = []) {
  if (!graph?.nodes) return null;
  const allowedTaskIds = new Set(
    array(tasks)
      .filter(isGraphVisibleTask)
      .map((task) => task.id)
  );
  if (!allowedTaskIds.size) return null;
  const nodes = array(graph.nodes).filter((node) => allowedTaskIds.has(String(node.id || "")));
  const nodeIds = new Set(nodes.map((node) => String(node.id || "")));
  if (!nodeIds.size) return null;
  const readyTaskIds = readyIdList(graph).filter((id) => nodeIds.has(id));
  return {
    ...graph,
    nodes,
    edges: array(graph.edges).filter(
      (edge) => nodeIds.has(String(edge.from || "")) && nodeIds.has(String(edge.to || ""))
    ),
    artifacts: array(graph.artifacts).filter((artifact) => !artifact.taskId || nodeIds.has(String(artifact.taskId))),
    readyTaskIds,
    readyTasks: readyTaskIds,
    parallelGroups: array(graph.parallelGroups)
      .map((group) => ({
        ...group,
        taskIds: array(group.taskIds).filter((id) => nodeIds.has(String(id)))
      }))
      .filter((group) => group.taskIds.length),
    blockedChains: array(graph.blockedChains).filter((chain) => nodeIds.has(String(chain.taskId || "")))
  };
}

function graphForGoal(goal) {
  const local = localGraph(goal);
  const snapshot = filterGraphSnapshotForTasks(goal?.graph, goal?.tasks);
  if (!snapshot) return local;
  const remoteById = new Map(array(snapshot.nodes).map((node) => [String(node.id || ""), node]));
  const nodes = local.nodes.map((node) => {
    const remote = remoteById.get(String(node.id || "")) || {};
    return {
      ...remote,
      ...node,
      readiness: node.readiness || remote.readiness || {}
    };
  });
  return {
    ...snapshot,
    ...local,
    valid: typeof snapshot.valid === "boolean" ? snapshot.valid : local.valid,
    cycles: array(snapshot.cycles),
    unknownDependencies: array(snapshot.unknownDependencies),
    nodes
  };
}

function eventSeverity(type, data = {}) {
  const rawType = String(type || "").toLowerCase();
  const risk = String(data.evaluation?.riskLevel || data.task?.riskLevel || "").toLowerCase();
  const authenticityScore = Number(data.authenticity?.score || data.task?.authenticityScore || 0);
  if (rawType === "model_timeout" || rawType === "model_failure") return "error";
  if (rawType === "model_failover" || rawType === "model_retry" || rawType === "tool_retry") return "warn";
  if (rawType === "model_success") return "success";
  if (rawType === "model_attempt") return "info";
  if (risk === "critical") return "critical";
  if (rawType === "authenticityblocked") return "warn";
  if (rawType === "authenticitywarning" || (authenticityScore && authenticityScore < 0.7)) return "warn";
  if (rawType === "correctiveactionsuggested" && data.correctiveSummary?.shouldBlock) return "warn";
  if (
    rawType === "actionranked" &&
    ["high", "critical"].includes(
      String(data.actionDecisionSummary?.riskLevel || data.recommendedAction?.riskLevel || "").toLowerCase()
    )
  )
    return "warn";
  if (rawType === "actionlearningupdated") return "info";
  if (rawType === "decisionattributed") return "info";
  if (rawType.includes("error") || rawType.includes("failed")) return "error";
  if (rawType.includes("recoverycompleted") && array(data.summary?.errors).length) return "error";
  if (
    rawType.includes("recoverywarning") ||
    rawType.includes("workerlost") ||
    rawType.includes("browsersessionmarkedstale")
  )
    return "warn";
  if (rawType.includes("recoverycompleted") && array(data.summary?.warnings).length) return "warn";
  if (
    rawType.includes("pause") ||
    rawType.includes("blocked") ||
    rawType.includes("risk") ||
    rawType.includes("budget")
  )
    return "warn";
  return "info";
}

function isModelEventType(type) {
  return ["model_attempt", "model_success", "model_failure", "model_timeout", "model_retry", "model_failover"].includes(
    String(type || "").toLowerCase()
  );
}

function modelProgressMessage(type, data = {}) {
  const rawType = String(type || "").toLowerCase();
  const task = data.task || {};
  const title = displayTaskTitle(task.title || data.phase || data.label || "模型调用");
  const model = data.model || data.fromModel || "未知模型";
  const elapsed = data.elapsedMs ? ` · ${formatMs(data.elapsedMs)}` : "";
  const timeout = data.timeoutMs && !data.elapsedMs ? ` · 超时阈值 ${formatMs(data.timeoutMs)}` : "";
  const retry = data.retry ? ` · ${valueLabel(data.retry) || data.retry}` : "";
  const reason = safeDisplayText(commonFailureTextLabel(data.reason || data.error || ""), 180);
  if (rawType === "model_attempt") return `模型尝试：${model} · ${title}${timeout}${retry}`;
  if (rawType === "model_success") return `模型成功：${model} · ${title}${elapsed}${retry}`;
  if (rawType === "model_timeout") return `模型超时：${model} · ${title}${elapsed || timeout}${retry}`;
  if (rawType === "model_failure")
    return `模型失败：${model} · ${title}${elapsed}${reason ? ` · ${reason}` : ""}${retry}`;
  if (rawType === "model_retry") {
    const attempt = data.modelAttempt || data.attempt || "";
    const total = data.maxModelAttempts || data.totalAttempts || "";
    const count = attempt && total ? ` · 第 ${attempt}/${total} 次` : "";
    return `模型重试：${model} · ${title}${count}${reason ? ` · ${reason}` : ""}${retry}`;
  }
  if (rawType === "model_failover") {
    const fromModel = data.fromModel || model;
    const toModel = data.toModel || model;
    const action = fromModel === toModel ? "模型重试" : "模型切换";
    return `${action}：${fromModel}${fromModel === toModel ? "" : ` → ${toModel}`}${reason ? ` · ${reason}` : ""}${retry}`;
  }
  return eventTypeLabel(type);
}

function eventMessage(type, data = {}) {
  const task = data.task || {};
  const rawType = String(type || "").toLowerCase();
  if (isModelEventType(rawType)) return modelProgressMessage(rawType, data);
  if (rawType === "tool_retry") {
    const attempt = data.attempt && data.maxToolAttempts ? ` · 第 ${data.attempt}/${data.maxToolAttempts} 次` : "";
    const tool = data.toolWorker || data.model || "tool";
    const reason = safeDisplayText(commonFailureTextLabel(data.reason || data.error || ""), 160);
    return `工具重试：${tool} · ${displayTaskTitle(task.title || task.id || "任务")}${attempt}${reason ? ` · ${reason}` : ""}`;
  }
  if (rawType === "recoverystarted") return `恢复扫描开始：${valueLabel(data.trigger) || data.trigger || "手动触发"}`;
  if (rawType === "taskrecovered")
    return `任务恢复：${data.task_id || data.taskId || task.id || "任务"} · ${recoveryReasonLabel(data.reason)}`;
  if (rawType === "goalrecovered") return `目标恢复：${displayStatus(data.from)} → ${displayStatus(data.to)}`;
  if (rawType === "workerlostdetected")
    return `执行器丢失：${data.task_id || data.taskId || task.id || "任务"} 已安全阻塞`;
  if (rawType === "browsersessionmarkedstale")
    return `浏览器会话失效：${data.task_id || data.taskId || task.id || "任务"}`;
  if (rawType === "recoverywarning")
    return `恢复警告：${safeDisplayText(data.warning || data.reason || "需要检查恢复结果", 120)}`;
  if (rawType === "recoverycompleted") {
    const summary = data.summary || {};
    return `恢复完成：扫描 ${Number(summary.scannedTasks || 0)} 个任务，恢复 ${Number(summary.recoveredTasks || 0)} 个`;
  }
  if (rawType === "authenticitychecked")
    return `真实性检查：${authenticityLabel(data.authenticity?.score || task.authenticityScore)}`;
  if (rawType === "authenticitywarning")
    return `真实性警告：${authenticityWarningLabel(array(data.authenticity?.warnings || task.authenticityWarnings)[0] || "需要人工复核")}`;
  if (rawType === "authenticityblocked")
    return `真实性阻断：${authenticityLabel(data.authenticity?.score || task.authenticityScore)}`;
  if (rawType === "correctiveactionsuggested")
    return `纠正建议：${correctiveActionLabel(data.correctiveSummary?.primaryAction || array(data.recommendedActions)[0]?.type)}`;
  if (rawType === "actionranked")
    return `动作排序：推荐 ${correctiveActionLabel(data.actionDecisionSummary?.recommendedAction || data.recommendedAction?.type || array(data.rankedActions)[0]?.type)}`;
  if (rawType === "actionlearningupdated")
    return `行为经验：${correctiveActionLabel(data.actionLearning?.actionType)} · ${data.actionLearning?.success ? "成功" : "失败"}`;
  if (rawType === "decisionattributed")
    return `决策归因：${decisionSourceLabel(data.decisionAttribution?.decisionSource)} · ${correctiveActionLabel(data.decisionAttribution?.actualAction)}`;
  if (data.message) return commonFailureTextLabel(data.message);
  if (type === "start") return `目标启动：${data.commander_model || "自动路由"}`;
  if (type === "plan") return `生成任务图：${array(data.tasks).length} 个节点`;
  if (type === "worker_start") return `执行器启动：${displayTaskTitle(task.title || data.model)}`;
  if (type === "worker_done")
    return `执行器结束：${displayTaskTitle(task.title || displayStatus(data.status, "任务"))}`;
  if (type === "verification")
    return `验证：${verificationLabel(data.verification?.verificationStatus || task.verificationStatus, data.verification?.confidence || task.verificationConfidence)}`;
  if (type === "risk") return `风险：${riskLabel(data.evaluation?.riskLevel || task.riskLevel)}`;
  if (type === "budget") return `预算：${budgetLabel(data.evaluation?.status, data.evaluation?.degradationLevel)}`;
  if (type === "strategy") return `战略：${valueLabel(data.event) || data.event || "已更新"}`;
  if (type === "graph") return `执行图：${valueLabel(data.event) || data.event || "已更新"}`;
  if (type === "final") return "最终结果已生成";
  if (type === "done") return "事件流已关闭";
  return eventTypeLabel(type);
}

function displayTaskTitle(value, fallback = "任务") {
  const text = String(value || "").trim();
  const approvalMatch = text.match(/^Human approval for\s+(.+)$/i);
  if (approvalMatch) return `人工确认：${approvalMatch[1]}`;
  const normalized = text.toLowerCase();
  const map = {
    "analyze the user goal and constraints": "分析用户目标和约束",
    "produce a complete solution": "生成完整方案",
    "check completion evidence": "检查完成证据",
    "review progress and decide next step": "复盘进展并决定下一步",
    "create execution plan": "创建执行计划",
    "synthesize final answer": "汇总最终答案"
  };
  return map[normalized] || text || fallback;
}

function displayEventMessage(event = {}) {
  const type = String(event.type || "");
  const data = event.data || {};
  const task = data.task || {};
  const rawType = type.toLowerCase();
  if (isModelEventType(rawType)) return modelProgressMessage(rawType, data);
  if (rawType === "recoverystarted") return `恢复扫描开始：${valueLabel(data.trigger) || data.trigger || "手动触发"}`;
  if (rawType === "taskrecovered")
    return `任务恢复：${data.task_id || data.taskId || task.id || "任务"} · ${recoveryReasonLabel(data.reason)}`;
  if (rawType === "goalrecovered")
    return `目标恢复：${displayStatus(data.from)} → ${displayStatus(data.to)}${data.blockedReason ? ` · ${recoveryReasonLabel(data.blockedReason)}` : ""}`;
  if (rawType === "workerlostdetected")
    return `执行器丢失：${data.task_id || data.taskId || task.id || "任务"} 已安全阻塞`;
  if (rawType === "browsersessionmarkedstale")
    return `浏览器会话失效：${data.task_id || data.taskId || task.id || "任务"}`;
  if (rawType === "recoverywarning")
    return `恢复警告：${safeDisplayText(data.message || data.warning || data.reason || "需要检查恢复结果", 120)}`;
  if (rawType === "recoverycompleted") {
    const summary = data.summary || {};
    return `恢复完成：扫描 ${Number(summary.scannedTasks || 0)} 个任务，恢复 ${Number(summary.recoveredTasks || 0)} 个，警告 ${array(summary.warnings).length} 条`;
  }
  if (rawType === "authenticitychecked")
    return `真实性检查：${authenticityLabel(data.authenticity?.score || task.authenticityScore)}`;
  if (rawType === "authenticitywarning")
    return `真实性警告：${authenticityWarningLabel(array(data.authenticity?.warnings || task.authenticityWarnings)[0] || "需要人工复核")}`;
  if (rawType === "authenticityblocked")
    return `真实性阻断：${authenticityLabel(data.authenticity?.score || task.authenticityScore)}`;
  if (rawType === "correctiveactionsuggested")
    return `纠正建议：${correctiveActionLabel(data.correctiveSummary?.primaryAction || array(data.recommendedActions)[0]?.type)}`;
  if (rawType === "actionranked")
    return `动作排序：推荐 ${correctiveActionLabel(data.actionDecisionSummary?.recommendedAction || data.recommendedAction?.type || array(data.rankedActions)[0]?.type)}`;
  if (rawType === "actionlearningupdated")
    return `行为经验：${correctiveActionLabel(data.actionLearning?.actionType)} · ${data.actionLearning?.success ? "成功" : "失败"}`;
  if (rawType === "decisionattributed")
    return `决策归因：${decisionSourceLabel(data.decisionAttribution?.decisionSource)} · ${correctiveActionLabel(data.decisionAttribution?.actualAction)}`;
  if (type === "worker_start") return `执行器启动：${displayTaskTitle(task.title || data.model)}`;
  if (type === "worker_done") return `执行器结束：${displayTaskTitle(task.title || task.id || data.model)}`;
  if (type === "start") return `目标启动：${data.commander_model || "自动路由"}`;
  if (type === "plan") return `生成任务图：${array(data.tasks).length} 个节点`;
  if (type === "verification")
    return `验证：${verificationLabel(data.verification?.verificationStatus || task.verificationStatus, data.verification?.confidence || task.verificationConfidence)}`;
  if (type === "risk") return `风险：${riskLabel(data.evaluation?.riskLevel || task.riskLevel)}`;
  if (type === "budget") return `预算：${budgetLabel(data.evaluation?.status, data.evaluation?.degradationLevel)}`;
  if (type === "strategy") return `战略：${valueLabel(data.event) || data.event || "已更新"}`;
  if (type === "graph") return `执行图：${valueLabel(data.event) || data.event || "已更新"}`;
  if (type === "pause")
    return data.message === "Goal step budget exceeded."
      ? "目标步骤预算已超限，可在预算设置中调整。"
      : commonFailureTextLabel(data.message || "目标已暂停");
  if (type === "final") return "最终结果已生成";
  if (type === "done") return "事件流已关闭";
  const message = String(event.message || eventMessage(type, data) || "");
  const translatedMessage = message
    .replace(/^Goal started with\s+/i, "目标启动：")
    .replace(/^Plan produced\s+(\d+)\s+tasks$/i, "生成任务图：$1 个节点")
    .replace(/^Worker started\s+(.+)$/i, (_, title) => `执行器启动：${displayTaskTitle(title)}`)
    .replace(/^Worker finished\s+(.+)$/i, (_, title) => `执行器结束：${displayTaskTitle(title)}`)
    .replace(/^Budget exhausted\s*\/\s*emergency$/i, "预算：预算耗尽 · 紧急降级")
    .replace(/^Budget\s+(.+)$/i, (_, status) => `预算：${valueLabel(status) || status}`)
    .replace(/^Verification\s+(.+)$/i, (_, status) => `验证：${valueLabel(status) || status}`)
    .replace(/^Risk\s+(.+)$/i, (_, level) => `风险：${riskLabel(level)}`)
    .replace(/^Strategy\s+(.+)$/i, (_, eventName) => `战略：${valueLabel(eventName) || eventName}`)
    .replace(/^Graph\s+(.+)$/i, (_, eventName) => `执行图：${valueLabel(eventName) || eventName}`)
    .replace(/^Final answer emitted$/i, "最终结果已生成")
    .replace(/^Event stream closed$/i, "事件流已关闭")
    .replace(/^Goal step budget exceeded\.$/i, "目标步骤预算已超限，可在预算设置中调整。");
  return commonFailureTextLabel(translatedMessage);
}

function isDisplayMonitorEvent(event = {}) {
  const type = String(event.type || "").toLowerCase();
  const task = event.data?.task || event.task || {};
  if (["worker_start", "worker_done", "worker_log"].includes(type) && isRouteInternalTask(task)) return false;
  return true;
}

function isRecoveryEventType(type) {
  return [
    "recoverystarted",
    "taskrecovered",
    "goalrecovered",
    "workerlostdetected",
    "browsersessionmarkedstale",
    "recoverycompleted",
    "recoverywarning"
  ].includes(String(type || "").toLowerCase());
}

function makeMonitorEvent(goalId, type, data = {}) {
  return {
    id: uid("evt"),
    at: new Date().toISOString(),
    time: nowTime(),
    type,
    severity: eventSeverity(type, data),
    goalId,
    taskId: data.task?.id || data.task_id || "",
    message: eventMessage(type, data),
    data
  };
}

function updateLocalObservability(current, event) {
  const base = current && typeof current === "object" ? current : {};
  const eventTimeline = [event, ...array(base.eventTimeline)].slice(0, 220);
  return {
    ...base,
    monitorReset: false,
    generatedAt: event.at,
    eventTimeline
  };
}

function usageTokens(usage = {}) {
  return Number(usage.tokenUsage?.total || usage.token_usage?.total || 0);
}

function usageCost(usage = {}) {
  return (
    Number(usage.estimatedCostUsd || usage.estimated_cost_usd || 0) +
    Number(usage.actualCostUsd || usage.actual_cost_usd || 0)
  );
}

function money(value) {
  return `$${Number(value || 0).toFixed(4)}`;
}

function percent(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function formatMs(value) {
  const ms = Number(value || 0);
  if (!ms) return "--";
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function localVerificationHealth(tasks = []) {
  const checked = tasks.filter((task) => task.verificationStatus).length;
  const verified = tasks.filter((task) => task.verificationStatus === "verified").length;
  const partial = tasks.filter((task) => task.verificationStatus === "partially_verified").length;
  const unverified = tasks.filter((task) => task.verificationStatus === "unverified").length;
  const confidenceValues = tasks.map((task) => Number(task.verificationConfidence || 0)).filter(Boolean);
  const authenticityValues = tasks.map((task) => Number(task.authenticityScore || 0)).filter(Boolean);
  const authenticityWarnings = tasks.flatMap((task) =>
    array(task.authenticityWarnings).map((warning) => ({
      taskId: task.id,
      title: task.title,
      score: Number(task.authenticityScore || 0),
      warning
    }))
  );
  return {
    checked,
    verified,
    partial,
    unverified,
    passRate: checked ? (verified + partial * 0.5) / checked : 0,
    averageConfidence: confidenceValues.length
      ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
      : 0,
    averageAuthenticityScore: authenticityValues.length
      ? authenticityValues.reduce((sum, value) => sum + value, 0) / authenticityValues.length
      : 0,
    suspiciousAuthenticity: tasks.filter(
      (task) => Number(task.authenticityScore || 0) > 0 && Number(task.authenticityScore || 0) < 0.7
    ).length,
    authenticityWarnings: authenticityWarnings.slice(-8),
    latestIssues: tasks
      .flatMap((task) =>
        array(task.detectedIssues).map((issue) => ({
          taskId: task.id,
          issue: issue.issue || String(issue),
          severity: issue.severity || "medium"
        }))
      )
      .concat(
        authenticityWarnings.map((item) => ({
          taskId: item.taskId,
          issue: item.warning,
          severity: item.score < 0.35 ? "critical" : "high"
        }))
      )
      .slice(-8)
  };
}

function localDiagnostics(goal, graph) {
  const tasks = array(goal?.tasks);
  const rootCauses = [];
  const needsEvidence = tasks.filter((task) => task.status === "needs_evidence");
  const verificationFailed = tasks.filter(
    (task) => task.verificationStatus === "unverified" && task.status !== "needs_evidence"
  );
  const budgetBlocked = tasks.filter(
    (task) => task.budgetBlockedReason || task.budgetStatus === "blocked" || task.budgetStatus === "exhausted"
  );
  const riskBlocked = tasks.filter((task) => task.blockedReason || task.requiresHumanApproval);
  if (verificationFailed.length)
    rootCauses.push({
      code: "verification_failed",
      message: `${verificationFailed.length} 个任务验证失败`,
      taskIds: verificationFailed.map((task) => task.id)
    });
  if (needsEvidence.length)
    rootCauses.push({
      code: "needs_evidence",
      message: `${needsEvidence.length} 个任务证据不足，等待 agent 补充取证`,
      taskIds: needsEvidence.map((task) => task.id)
    });
  if (budgetBlocked.length)
    rootCauses.push({
      code: "budget_exceeded",
      message: `${budgetBlocked.length} 个任务被预算阻断`,
      taskIds: budgetBlocked.map((task) => task.id)
    });
  if (riskBlocked.length)
    rootCauses.push({
      code: "risk_blocked",
      message: `${riskBlocked.length} 个任务处于风险/人工确认状态`,
      taskIds: riskBlocked.map((task) => task.id)
    });
  if (array(graph?.blockedChains).length)
    rootCauses.push({ code: "dependency_blocked", message: `${array(graph.blockedChains).length} 条依赖链阻塞` });
  return {
    rootCauses,
    summary: rootCauses.length ? `发现 ${rootCauses.length} 类可观测阻塞` : "未发现明显故障",
    suggestedNextAction:
      rootCauses[0]?.code === "verification_failed"
        ? "检查证据，再改变方法后重试"
        : rootCauses[0]?.code === "risk_blocked"
          ? "等待人工确认或修改任务规避风险"
          : rootCauses[0]?.code === "dependency_blocked"
            ? "优先修复上游依赖任务"
            : "继续观察可执行任务"
  };
}

function buildClientMonitor(goal, graph, observability) {
  const tasks = array(goal?.tasks).filter(isUserVisibleTask);
  const derivedStatus = goal ? taskDerivedGoalStatus(goal, tasks) : "";
  const hasVisibleGoal = shouldShowGoalInControl(goal, tasks, derivedStatus, false);
  if (!goal || !hasVisibleGoal) {
    const monitorReset = Boolean(observability?.monitorReset);
    const events = monitorReset
      ? []
      : array(observability?.eventTimeline)
          .filter((event) => isRecoveryEventType(event.type) && isDisplayMonitorEvent(event))
          .slice(0, 80);
    return {
      status: "idle",
      phase: "",
      progress: 0,
      riskLevel: "low",
      verificationHealth: localVerificationHealth([]),
      budget: {
        usage: {},
        cost: 0,
        tokens: 0,
        degradationLevel: "none",
        warnings: [],
        topTasks: []
      },
      blockedTasks: 0,
      retryCount: 0,
      runtimeMs: 0,
      events,
      diagnostics: { rootCauses: [], summary: "暂无运行中的目标", suggestedNextAction: "创建目标后这里会显示实时事件" },
      workerHealth: [],
      strategyAnalytics: [],
      metrics: {}
    };
  }
  const monitorReset = Boolean(observability?.monitorReset);
  const backendGoal =
    array(observability?.goals).find((item) => item.goalId === goal?.id || item.goalId === goal?.goalId) || null;
  const backendDiagnostics =
    array(observability?.diagnostics).find((item) => item.goalId === goal?.id || item.goalId === goal?.goalId) || null;
  const verificationHealth = monitorReset
    ? localVerificationHealth([])
    : backendGoal?.verificationHealth || observability?.verificationMonitor || localVerificationHealth(tasks);
  const budget = monitorReset ? {} : backendGoal?.budget || observability?.budgetMonitor || {};
  const usage = budget.usage || {};
  const events = monitorReset
    ? []
    : array(observability?.eventTimeline)
        .filter(
          (event) =>
            (event.goalId === goal.id ||
              event.goalId === goal.goalId ||
              (isRecoveryEventType(event.type) && !event.goalId)) &&
            isDisplayMonitorEvent(event)
        )
        .slice(0, 80);
  const diagnostics = monitorReset
    ? { rootCauses: [], summary: "监控已重置，等待新的运行事件", suggestedNextAction: "继续观察新的任务事件" }
    : backendDiagnostics || localDiagnostics(goal, graph);
  const workerHealth = monitorReset ? [] : array(observability?.workerHealth);
  return {
    status: backendGoal?.status || derivedStatus || goal?.status || "idle",
    phase:
      backendGoal?.currentPhase || Object.entries(goal?.flow || {}).find(([, value]) => value === "active")?.[0] || "",
    progress: backendGoal?.progress ?? 0,
    riskLevel:
      backendGoal?.riskLevel ||
      tasks.find((task) => ["critical", "high"].includes(String(task.riskLevel).toLowerCase()))?.riskLevel ||
      "low",
    verificationHealth,
    budget: {
      usage,
      cost: usageCost(usage),
      tokens: usageTokens(usage),
      degradationLevel: budget.degradationLevel || "none",
      warnings: array(budget.warnings),
      topTasks: array(budget.topTasks)
    },
    blockedTasks:
      backendGoal?.blockedTasks ??
      tasks.filter((task) => ["blocked", "waiting_human", "awaiting_confirmation"].includes(task.status)).length,
    retryCount:
      backendGoal?.retryCount ?? tasks.reduce((sum, task) => sum + Math.max(0, Number(task.attempts || 0) - 1), 0),
    runtimeMs: backendGoal?.runtimeMs || 0,
    events,
    diagnostics,
    workerHealth,
    strategyAnalytics: monitorReset ? [] : array(observability?.strategyAnalytics),
    metrics: monitorReset ? {} : observability?.metrics || {}
  };
}

function resetObservabilitySnapshot(current) {
  if (!current)
    return {
      eventTimeline: [],
      goals: [],
      diagnostics: [],
      workerHealth: [],
      strategyAnalytics: [],
      metrics: {},
      verificationMonitor: null,
      budgetMonitor: null,
      trace: { events: [], timelines: [], chain: [] }
    };
  return {
    ...current,
    monitorReset: true,
    generatedAt: new Date().toISOString(),
    eventTimeline: [],
    goals: [],
    diagnostics: [],
    workerHealth: [],
    strategyAnalytics: [],
    metrics: {},
    verificationMonitor: null,
    budgetMonitor: null,
    trace: current.trace
      ? { ...current.trace, events: [], timelines: [], chain: [] }
      : { events: [], timelines: [], chain: [] }
  };
}

function clearObservabilityEventsSnapshot(current) {
  if (!current) return current;
  return {
    ...current,
    eventTimeline: [],
    trace: current.trace ? { ...current.trace, events: [], chain: [] } : current.trace
  };
}

function initialState() {
  return normalizeStoredState({
    goals: [],
    activeGoalId: "",
    logs: [],
    memories: [],
    filter: "all",
    calls: 0,
    spend: 0
  });
}

function loadStoredState() {
  const fallback = initialState();
  const primary = safeLoad(STORAGE_KEY, null);
  if (primary) return normalizeStoredState({ ...fallback, ...primary });
  return normalizeStoredState(safeLoad(FALLBACK_STORAGE_KEY, fallback));
}

function initialTheme() {
  if (typeof window === "undefined") return "dark";
  return window.localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
}

function initialGoalDraft() {
  return { goalText: "", priority: "normal" };
}

function loadGoalDraft() {
  if (typeof window === "undefined") return { goalText: "", priority: "normal" };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(GOAL_DRAFT_KEY) || "null");
    if (!parsed || typeof parsed !== "object") return { goalText: "", priority: "normal" };
    const nextPriority = ["normal", "high", "urgent", "critical"].includes(parsed.priority)
      ? parsed.priority
      : "normal";
    return {
      goalText: String(parsed.goalText || ""),
      priority: nextPriority
    };
  } catch {
    return { goalText: "", priority: "normal" };
  }
}

export default function AgentRouteStudio() {
  const [state, setState] = useState(initialState);
  const [modelSettings, setModelSettings] = useState(() => normalizeModelSettings({}));
  const [promptSettings, setPromptSettings] = useState(() => normalizePromptSettings({}));
  const [budgetSettings, setBudgetSettings] = useState(() => normalizeBudgetSettings({}));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState("models");
  const [theme, setTheme] = useState("dark");
  const initialDraft = useMemo(initialGoalDraft, []);
  const [goalText, setGoalText] = useState(initialDraft.goalText);
  const [priority, setPriority] = useState(initialDraft.priority);
  const [storageReady, setStorageReady] = useState(false);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [manualMemory, setManualMemory] = useState("");
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const [activeSection, setActiveSection] = useState("control");
  const [selectedGraphTaskId, setSelectedGraphTaskId] = useState("");
  const [selectedQueueTaskId, setSelectedQueueTaskId] = useState("");
  const [graphViewMode, setGraphViewMode] = useState("graph");
  const [taskPanelTab, setTaskPanelTab] = useState("queue");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const abortRef = useRef(null);

  useEffect(() => {
    document.documentElement.dataset.agentRouteHydrated = "true";
    const draft = loadGoalDraft();
    const liveGoalText = document.getElementById("goalText")?.value || "";
    const loadedModelSettings = loadModelSettings();
    setState(loadStoredState());
    setModelSettings(loadedModelSettings);
    saveModelSettings(loadedModelSettings);
    setPromptSettings(loadPromptSettings());
    setBudgetSettings(loadBudgetSettings());
    setTheme(initialTheme());
    setGoalText((current) => current || liveGoalText || draft.goalText);
    setPriority((current) => current || draft.priority);
    setActiveSection(initialActiveSection());
    const initialTarget = normalizeSectionTarget(window.location.hash);
    if (initialTarget.taskTab) setTaskPanelTab(initialTarget.taskTab);
    setStorageReady(true);
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    save(STORAGE_KEY, state);
  }, [state, storageReady]);
  useEffect(() => {
    if (!storageReady) return;
    save(GOAL_DRAFT_KEY, { goalText, priority, updatedAt: new Date().toISOString() });
  }, [goalText, priority, storageReady]);
  useEffect(() => {
    if (!storageReady) return;
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_KEY, theme);
  }, [theme, storageReady]);

  const activeGoal = useMemo(
    () =>
      state.activeGoalId === NEW_TASK_DRAFT_ID
        ? null
        : state.goals.find((goal) => goal.id === state.activeGoalId) || state.goals[0] || null,
    [state.goals, state.activeGoalId]
  );
  const graph = useMemo(() => {
    return graphForGoal(activeGoal);
  }, [activeGoal]);
  useEffect(() => {
    setSelectedGraphTaskId("");
  }, [activeGoal?.id]);
  const monitor = useMemo(
    () => buildClientMonitor(activeGoal, graph, state.observability),
    [activeGoal, graph, state.observability]
  );

  useEffect(() => {
    if (!storageReady || !activeGoal?.id) return;
    refreshObservability().catch(() => {});
  }, [storageReady, activeGoal?.id]);

  useEffect(() => {
    if (!storageReady) return;
    refreshRecoveryStatus({ silent: true }).catch(() => {});
  }, [storageReady]);

  useEffect(() => {
    const knownSections = new Set(NAV_ITEMS.map(([id]) => id));
    function applySection(section) {
      const target = normalizeSectionTarget(section);
      if (!knownSections.has(target.section)) return;
      if (target.taskTab) setTaskPanelTab(target.taskTab);
      setActiveSection(target.section);
      setSidebarOpen(false);
    }
    function handleSectionEvent(event) {
      applySection(event?.detail?.section);
    }
    function handleHashChange() {
      applySection(window.location.hash);
    }
    window.addEventListener("agent-route-section-change", handleSectionEvent);
    window.addEventListener("hashchange", handleHashChange);
    handleHashChange();
    return () => {
      window.removeEventListener("agent-route-section-change", handleSectionEvent);
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, []);

  const visibleTasks = useMemo(() => {
    let tasks = array(activeGoal?.tasks).filter(isUserVisibleTask);
    if (state.filter !== "all") {
      tasks = tasks.filter((task) => {
        if (state.filter === "queued") return isWaiting(task.status);
        if (state.filter === "completed") return isDone(task.status);
        if (state.filter === "failed") return isQueueFailedStatus(task.status);
        if (state.filter === "blocked")
          return task.status === "blocked" || String(task.dependencyStatus || "").toLowerCase() === "blocked";
        return task.status === state.filter;
      });
    }
    return tasks.slice().sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  }, [activeGoal, state.filter]);
  useEffect(() => {
    if (!visibleTasks.length) {
      setSelectedQueueTaskId("");
      return;
    }
    if (!visibleTasks.some((task) => task.id === selectedQueueTaskId)) {
      setSelectedQueueTaskId(visibleTasks[0].id);
    }
  }, [selectedQueueTaskId, visibleTasks]);

  const summary = useMemo(() => {
    const tasks = array(activeGoal?.tasks).filter(isUserVisibleTask);
    const total = tasks.length;
    const done = tasks.filter((task) => isDone(task.status)).length;
    const failed = tasks.filter((task) => isFailed(task.status)).length;
    const running = tasks.filter((task) => task.status === "running").length;
    const progress = total
      ? Math.round(((done + failed) / total) * 100)
      : activeGoal?.status === "completed"
        ? 100
        : activeGoal?.status === "running"
          ? 12
          : 0;
    return {
      total,
      done,
      failed,
      running,
      waiting: tasks.filter((task) => isWaiting(task.status)).length,
      progress,
      eta:
        activeGoal?.status === "completed"
          ? "0 分"
          : total
            ? `${Math.max(1, (total - done - failed) * 8 + running * 3)} 分`
            : "--"
    };
  }, [activeGoal]);

  function addLog(message, level = "info") {
    setState((current) => ({
      ...current,
      logs: [...array(current.logs), { id: uid("log"), time: nowTime(), level, message: String(message || "") }].slice(
        -180
      )
    }));
  }

  function patchGoal(goalId, updater) {
    setState((current) => ({
      ...current,
      goals: current.goals.map((goal) => (goal.id === goalId ? updater(goal) : goal))
    }));
  }

  function setFlow(goal, key, status) {
    return { ...goal, flow: { ...(goal.flow || {}), [key]: status } };
  }

  function upsertTask(goal, data, status) {
    const raw = data.task || {};
    const id = raw.id || data.model || uid("task");
    const index = array(goal.tasks).findIndex((task) => task.id === id);
    const base = index >= 0 ? goal.tasks[index] : {};
    const next = normalizeTask({ ...base, ...raw, id }, index >= 0 ? index : array(goal.tasks).length);
    next.status = status || raw.status || next.status;
    next.model = data.model || next.model;
    next.candidates = array(data.candidates).length ? array(data.candidates) : next.candidates;
    next.content = data.content || next.content;
    next.error = isDone(next.status) ? "" : data.error || next.error;
    next.elapsedMs = data.elapsedMs || next.elapsedMs;
    const eventTime = data.at || data.timestamp || nowTime();
    next.createdAt = next.createdAt || raw.createdAt || raw.created_at || eventTime;
    next.updatedAt = raw.updatedAt || raw.updated_at || data.updatedAt || data.updated_at || eventTime;
    if (next.status === "running" && !next.startedAt) {
      next.startedAt = raw.startedAt || raw.started_at || eventTime;
    }
    if (isDone(next.status) || isFailed(next.status)) {
      next.finishedAt =
        raw.finishedAt || raw.finished_at || data.finishedAt || data.finished_at || next.finishedAt || eventTime;
    }
    if (isDone(next.status)) {
      next.blockedReason = "";
      next.budgetBlockedReason = "";
      next.approvalReason = "";
      next.detectedIssues = [];
    }
    next.progress =
      isDone(next.status) || isFailed(next.status)
        ? 100
        : next.status === "running"
          ? Math.max(next.progress || 0, 60)
          : next.progress || 0;
    const tasks = array(goal.tasks).slice();
    if (index >= 0) tasks[index] = next;
    else tasks.push(next);
    return { ...goal, tasks };
  }

  function syncGraph(goal, incomingGraph) {
    if (!incomingGraph?.nodes) return goal;
    const tasks = array(goal.tasks).map((task) => {
      const node = incomingGraph.nodes.find((item) => item.id === task.id);
      if (!node) return task;
      return {
        ...task,
        graphDepth: node.depth || 0,
        dependencyStatus: node.readiness?.status || task.dependencyStatus || "",
        dependencyReasons: node.readiness?.reasons || task.dependencyReasons || [],
        blockedBy: node.readiness?.blockedBy || task.blockedBy || [],
        missingArtifacts: node.readiness?.missingArtifacts || task.missingArtifacts || []
      };
    });
    return { ...goal, tasks, graph: filterGraphSnapshotForTasks(incomingGraph, tasks) };
  }

  function deleteTaskFromGoal(goal, taskId, incomingGraph) {
    const tasks = array(goal.tasks).filter((task) => task.id !== taskId);
    return {
      ...goal,
      status: taskDerivedGoalStatus(goal, tasks),
      tasks,
      graph: filterGraphSnapshotForTasks(incomingGraph || goal.graph, tasks)
    };
  }

  function handleStreamEvent(goalId, type, data) {
    if (String(type || "").toLowerCase() === "langgraph") return;
    const monitorEvent = makeMonitorEvent(goalId, type, data);
    setState((current) => {
      let nextCalls = current.calls;
      const goals = current.goals.map((goal) => {
        if (goal.id !== goalId) return goal;
        let next = { ...goal, updatedAt: nowTime() };
        if (type === "start") {
          next = setFlow(
            { ...next, status: "running", strategy: data.strategy || next.strategy || null },
            "commander",
            "active"
          );
          if (next.strategy) next = setFlow(next, "strategy", "done");
        } else if (type === "plan") {
          const known = new Map(array(next.tasks).map((task) => [task.id, task]));
          const internalTasks = array(next.tasks).filter(isRouteInternalTask);
          const plannedTasks = array(data.tasks)
            .filter((task) => isDisplayTask(task) && !isRouteInternalTask(task))
            .map((task, index) =>
              normalizeTask({ ...(known.get(task.id) || {}), ...task }, internalTasks.length + index)
            );
          next = {
            ...next,
            tasks: [...internalTasks, ...plannedTasks]
          };
          next = setFlow(setFlow(setFlow(next, "commander", "done"), "plan", "done"), "graph", "active");
        } else if (type === "worker_start") {
          nextCalls += 1;
          next = upsertTask(next, data, "running");
          next = setFlow(setFlow(next, "route", "done"), "worker", "active");
        } else if (type === "worker_log") {
          next = upsertTask(next, data, "running");
        } else if (type === "worker_done") {
          const status = data.status || (data.ok === false ? "failed" : "completed");
          next = upsertTask(next, data, status);
          next = setFlow(next, "worker", isDone(status) ? "done" : "active");
        } else if (
          type === "risk" ||
          type === "verification" ||
          type === "budget" ||
          String(type).toLowerCase().startsWith("authenticity") ||
          String(type).toLowerCase() === "correctiveactionsuggested" ||
          String(type).toLowerCase() === "actionranked" ||
          String(type).toLowerCase() === "actionlearningupdated" ||
          String(type).toLowerCase() === "decisionattributed"
        ) {
          if (data.task) next = upsertTask(next, data, data.task.status || "running");
        } else if (type === "strategy") {
          next = { ...next, strategy: data.strategy || next.strategy || null, strategyHistory: array(data.history) };
          next = setFlow(next, "strategy", data.violations?.length ? "active" : "done");
        } else if (type === "graph") {
          next = syncGraph(next, data.graph || next.graph);
          next = setFlow(next, "graph", data.graph?.valid === false ? "failed" : "done");
        } else if (type === "pause") {
          next = { ...next, status: data.status || "awaiting_confirmation", output: data.message || next.output || "" };
          if (data.task) next = upsertTask(next, data, next.status);
        } else if (type === "final") {
          const content = String(data.content || "");
          const finalStatus = String(data.status || data.finalStatus || data.final_status || "").toLowerCase();
          const failedFinal = isFailedStreamStatus(data);
          const withOutput = {
            ...next,
            output: content,
            status: failedFinal ? finalStatus : content ? "completed" : "failed",
            finalModel: data.source_model || data.commander_model || next.commander
          };
          next = setFlow(
            {
              ...withOutput,
              status: failedFinal
                ? finalStatus
                : content
                  ? taskDerivedGoalStatus(withOutput, withOutput.tasks)
                  : "failed"
            },
            "done",
            failedFinal || !content ? "failed" : "done"
          );
        } else if (type === "error") {
          next = { ...next, output: data.message || "AgentRoute 执行失败", status: "failed" };
        } else if (type === "done" && next.status === "running") {
          const finalStatus = data.status || data.finalStatus || data.final_status || "";
          const finalMessage = data.failureReason || data.failure_reason || data.message || "";
          next = {
            ...next,
            output: finalMessage || next.output,
            status: finalStatus || (next.output || finalMessage ? "completed" : "failed")
          };
        } else if (type === "done") {
          const finalStatus = data.status || data.finalStatus || data.final_status || "";
          const finalMessage = data.failureReason || data.failure_reason || data.message || "";
          if (finalMessage || ["blocked", "failed", "waiting_human"].includes(String(finalStatus).toLowerCase())) {
            next = {
              ...next,
              output: next.output || finalMessage,
              status:
                ["blocked", "failed", "waiting_human"].includes(String(finalStatus).toLowerCase()) &&
                !isDone(next.status)
                  ? finalStatus
                  : next.status
            };
          }
        }
        return next;
      });
      return {
        ...current,
        goals,
        calls: nextCalls,
        observability: updateLocalObservability(current.observability, monitorEvent)
      };
    });
    const label = eventLabel(type, data);
    if (label) {
      addLog(
        label,
        type === "error" || (type === "final" && isFailedStreamStatus(data))
          ? "error"
          : type === "final"
            ? "success"
            : "info"
      );
    }
  }

  function eventLabel(type, data = {}) {
    const task = data.task || {};
    const rawType = String(type || "").toLowerCase();
    if (isModelEventType(rawType)) return modelProgressMessage(rawType, data);
    if (type === "start") return `总指挥启动：${data.commander_model || "自动路由"}`;
    if (type === "plan") return `任务图生成：${array(data.tasks).length} 个节点`;
    if (type === "worker_start") return `执行器启动：${displayTask(task.title || data.model || "任务")}`;
    if (type === "worker_done") return `执行器结束：${displayTask(task.title || displayStatus(data.status, "任务"))}`;
    if (type === "risk") return `风险评估：${riskLabel(data.evaluation?.riskLevel || task.riskLevel)}`;
    if (type === "verification")
      return `验证结果：${verificationLabel(data.verification?.verificationStatus, data.verification?.confidence)}`;
    if (String(type).toLowerCase() === "authenticitychecked")
      return `真实性检查：${authenticityLabel(data.authenticity?.score || task.authenticityScore)}`;
    if (String(type).toLowerCase() === "authenticitywarning")
      return `真实性警告：${authenticityWarningLabel(array(data.authenticity?.warnings || task.authenticityWarnings)[0] || "需要人工复核")}`;
    if (String(type).toLowerCase() === "authenticityblocked")
      return `真实性阻断：${authenticityLabel(data.authenticity?.score || task.authenticityScore)}`;
    if (String(type).toLowerCase() === "correctiveactionsuggested")
      return `纠正建议：${correctiveActionLabel(data.correctiveSummary?.primaryAction || array(data.recommendedActions)[0]?.type)}`;
    if (String(type).toLowerCase() === "actionranked")
      return `动作排序：推荐 ${correctiveActionLabel(data.actionDecisionSummary?.recommendedAction || data.recommendedAction?.type || array(data.rankedActions)[0]?.type)}`;
    if (String(type).toLowerCase() === "actionlearningupdated")
      return `行为经验：${correctiveActionLabel(data.actionLearning?.actionType)} · ${data.actionLearning?.success ? "成功" : "失败"}`;
    if (String(type).toLowerCase() === "decisionattributed")
      return `决策归因：${decisionSourceLabel(data.decisionAttribution?.decisionSource)} · ${correctiveActionLabel(data.decisionAttribution?.actualAction)}`;
    if (type === "budget")
      return `预算状态：${budgetLabel(data.evaluation?.status, data.evaluation?.degradationLevel)}`;
    if (type === "strategy") return `战略更新：${valueLabel(data.event) || "已更新"}`;
    if (type === "graph")
      return `执行图更新：可执行 ${array(data.ready_tasks).length}，阻塞 ${array(data.blocked_chains).length}`;
    if (type === "pause") return `目标暂停：${data.message || data.status || "等待处理"}`;
    if (type === "final") {
      if (isFailedStreamStatus(data)) {
        return `执行失败：${safeDisplayText(data.failureReason || data.failure_reason || data.message || data.content || "", 140)}`;
      }
      return "最终结果已生成";
    }
    if (type === "error") return data.message || "执行失败";
    if (type === "done") {
      const finalMessage = data.failureReason || data.failure_reason || data.message || "";
      if (finalMessage) {
        return `执行结束：${displayStatus(data.status || data.finalStatus || data.final_status || "blocked", "已结束")} · ${safeDisplayText(finalMessage, 140)}`;
      }
      return "事件流已关闭";
    }
    return "";
  }

  async function runGoal(goal, resume = false) {
    if (!goal || abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    patchGoal(goal.id, (item) => ({
      ...item,
      status: "running",
      output: resume ? item.output : "",
      flow: resume ? item.flow || {} : {},
      tasks: resume ? array(item.tasks) : [],
      graph: resume ? item.graph || null : null
    }));
    addLog(`开始执行目标：${goal.title}`, "success");
    try {
      const requestBody = {
        goal: goal.goal,
        goal_id: goal.id,
        resume_goal: resume,
        commander_model: goal.commander || modelSettings.defaultCommander,
        priority: goal.priority,
        model_pools: modelSettings.pools,
        prompt_settings: promptSettings,
        budget: budgetSettings
      };
      await consumeAgentRouteUiMessageStream(requestBody, {
        signal: controller.signal,
        onEvent: (type, data) => handleStreamEvent(goal.id, type, data)
      });
    } catch (err) {
      if (err?.name === "AbortError") {
        patchGoal(goal.id, (item) => ({ ...item, status: "stopped" }));
        addLog(`任务已暂停：${goal.title}`, "warn");
      } else {
        handleStreamEvent(goal.id, "error", { message: err.message || String(err) });
      }
    } finally {
      abortRef.current = null;
      patchGoal(goal.id, (item) =>
        item.status === "running" ? { ...item, status: item.output ? "completed" : "failed" } : item
      );
    }
  }

  function createGoal(runNow) {
    const text = goalText.trim();
    if (!text) return;
    const goal = {
      id: uid("goal"),
      title: shortText(text, 76) || "新目标",
      goal: text,
      commander: modelSettings.defaultCommander,
      priority,
      status: "queued",
      createdAt: nowTime(),
      updatedAt: nowTime(),
      flow: {},
      tasks: [],
      strategy: null,
      strategyHistory: [],
      graph: null,
      output: ""
    };
    setState((current) => ({
      ...current,
      goals: [goal, ...current.goals].slice(0, 40),
      activeGoalId: goal.id,
      filter: "all"
    }));
    setGoalText("");
    save(GOAL_DRAFT_KEY, { goalText: "", priority, updatedAt: new Date().toISOString() });
    addLog(`目标已创建：${goal.title}`, "success");
    if (runNow) setTimeout(() => runGoal(goal), 0);
  }

  function registerChatGoal({ id, text, commanderModel }) {
    const goalTextValue = String(text || "").trim();
    if (!id || !goalTextValue) return;
    const timestamp = nowTime();
    const goal = {
      id,
      title: shortText(goalTextValue, 76) || "聊天目标",
      goal: goalTextValue,
      commander: commanderModel || selectedCommander,
      priority: "normal",
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
      flow: { commander: "active" },
      tasks: [],
      strategy: null,
      strategyHistory: [],
      graph: null,
      output: ""
    };
    setSelectedGraphTaskId("");
    setSelectedQueueTaskId("");
    setTaskPanelTab("queue");
    setState((current) => {
      const exists = current.goals.some((item) => item.id === id);
      const goals = exists
        ? current.goals.map((item) => (item.id === id ? { ...item, ...goal, tasks: item.tasks || [] } : item))
        : [goal, ...current.goals].slice(0, 40);
      return { ...current, goals, activeGoalId: id, filter: "all" };
    });
    addLog(`聊天目标已启动：${goal.title}`, "success");
  }

  async function taskAction(task, action) {
    if (!activeGoal || !task) return;
    if (isRouteInternalTask(task)) {
      addLog("这是内部路由步骤，不是真实任务，已忽略。", "info");
      return;
    }
    if (
      action === "delete_task" &&
      !window.confirm(`确定要删除任务「${task.title || task.id}」吗？这会从任务队列和执行图中移除它。`)
    )
      return;
    const response = await fetch("/api/agent-route/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, goal_id: activeGoal.id, task_id: task.id, context: { source: "studio" } })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.message || `任务操作失败（${response.status}）`);
    if (action === "delete_task") {
      patchGoal(activeGoal.id, (goal) => deleteTaskFromGoal(goal, data.task_id || task.id, data.graph));
      addLog(
        data.skipped ? data.message || "内部路由步骤已忽略" : `已删除：${task.title}`,
        data.skipped ? "info" : "warn"
      );
      return;
    }
    patchGoal(activeGoal.id, (goal) => {
      const next = data.task ? upsertTask(goal, data, data.task.status) : goal;
      return action === "cancel_task" || action === "reject_task"
        ? { ...next, status: taskDerivedGoalStatus(next, next.tasks) }
        : next;
    });
    addLog(
      data.skipped
        ? data.message || "内部路由步骤已忽略"
        : `${action === "confirm_task" ? "已批准" : action === "reject_task" ? "已拒绝" : "已取消"}：${task.title}`,
      data.skipped ? "info" : action === "confirm_task" ? "success" : "warn"
    );
    if (action === "confirm_task" && ["waiting", "completed"].includes(String(data.task?.status || "").toLowerCase()))
      runGoal(activeGoal, true);
  }

  async function refreshGraph() {
    if (!activeGoal) return;
    const response = await fetch("/api/agent-route/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "graph_status", goal_id: activeGoal.id })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(data.error?.message || data.message || `执行图状态获取失败（${response.status}）`);
    patchGoal(activeGoal.id, (goal) => syncGraph(goal, data.graph || goal.graph));
    addLog(`执行图已刷新：可执行 ${array(data.readyTasks).length}，阻塞 ${array(data.blockedChains).length}`, "info");
  }

  async function refreshObservability() {
    if (!activeGoal) return;
    const response = await fetch("/api/agent-route/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "observability_status", goal_id: activeGoal.id, limit: 180 })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.message || `监控状态获取失败（${response.status}）`);
    setState((current) => ({ ...current, observability: data.observability || current.observability }));
    addLog("监控快照已刷新", "info");
  }

  function applyRecoverySummary(summary) {
    if (!summary || typeof summary !== "object") return;
    const taskRecoveries = array(summary.tasks);
    const goalRecoveries = array(summary.goals);
    if (!taskRecoveries.length && !goalRecoveries.length) return;
    setState((current) => ({
      ...current,
      goals: current.goals.map((goal) => {
        const goalId = goal.goalId || goal.id;
        const goalRecovery = goalRecoveries.find(
          (item) => String(item.goalId || item.goal_id || "") === String(goalId)
        );
        const taskRecoveryById = new Map(
          taskRecoveries
            .filter((item) => String(item.goalId || item.goal_id || "") === String(goalId))
            .map((item) => [String(item.taskId || item.task_id || ""), item])
        );
        if (!goalRecovery && !taskRecoveryById.size) return goal;
        const tasks = array(goal.tasks).map((task) => {
          const recovered = taskRecoveryById.get(String(task.id || ""));
          if (!recovered) return task;
          return normalizeTask(
            {
              ...task,
              status: recovered.to || task.status,
              blockedReason: recovered.blockedReason || task.blockedReason,
              recoveryReason: recovered.reason || task.recoveryReason,
              recoveryState: {
                ...(task.recoveryState || {}),
                recoveredAt: summary.at,
                trigger: summary.trigger,
                from: recovered.from || "",
                targetStatus: recovered.to || task.status,
                reason: recovered.reason || "",
                workerLost: Boolean(recovered.workerLost),
                staleBrowserSessions: array(recovered.staleBrowserSessions)
              }
            },
            task.order
          );
        });
        return {
          ...goal,
          status: goalRecovery?.to || taskDerivedGoalStatus(goal, tasks),
          blockedReason: goalRecovery?.blockedReason || goal.blockedReason || "",
          recoverySummary: {
            at: summary.at,
            trigger: summary.trigger,
            reason: goalRecovery?.reason || ""
          },
          tasks
        };
      }),
      recovery: summary
    }));
  }

  async function refreshRecoveryStatus(options = {}) {
    setRecoveryLoading(true);
    setRecoveryError("");
    try {
      const response = await fetch("/api/agent-route/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "recovery_status" })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(data.error?.message || data.message || `恢复状态获取失败（${response.status}）`);
      setState((current) => ({ ...current, recovery: data.recovery || current.recovery }));
      if (!options.silent) addLog("恢复状态已刷新", "info");
      return data.recovery;
    } catch (err) {
      setRecoveryError(err.message || String(err));
      if (!options.silent) addLog(`恢复状态获取失败：${err.message || String(err)}`, "error");
      throw err;
    } finally {
      setRecoveryLoading(false);
    }
  }

  async function runRecoveryScan() {
    setRecoveryLoading(true);
    setRecoveryError("");
    addLog("开始运行恢复扫描", "info");
    try {
      const response = await fetch("/api/agent-route/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run_recovery" })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || data.message || `恢复扫描失败（${response.status}）`);
      applyRecoverySummary(data.recovery);
      await refreshObservability().catch(() => {});
      const level = array(data.recovery?.errors).length
        ? "error"
        : array(data.recovery?.warnings).length
          ? "warn"
          : "success";
      addLog(
        `恢复扫描完成：扫描 ${Number(data.recovery?.scannedTasks || 0)} 个任务，恢复 ${Number(data.recovery?.recoveredTasks || 0)} 个`,
        level
      );
      return data.recovery;
    } catch (err) {
      setRecoveryError(err.message || String(err));
      addLog(`恢复扫描失败：${err.message || String(err)}`, "error");
      throw err;
    } finally {
      setRecoveryLoading(false);
    }
  }

  async function clearLogs() {
    setState((current) => ({
      ...current,
      logs: [],
      observability: clearObservabilityEventsSnapshot(current.observability)
    }));
    try {
      const response = await fetch("/api/agent-route/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear_logs", scope: "all" })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || data.message || `日志清空失败（${response.status}）`);
      setState((current) => ({
        ...current,
        logs: [],
        observability: data.observability
          ? clearObservabilityEventsSnapshot(data.observability)
          : clearObservabilityEventsSnapshot(current.observability)
      }));
    } catch (err) {
      addLog(`日志清空失败：${err.message || String(err)}`, "error");
    }
  }

  async function resetMonitoring() {
    setState((current) => ({
      ...current,
      observability: resetObservabilitySnapshot(current.observability)
    }));
    try {
      const response = await fetch("/api/agent-route/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset_monitor", scope: "all" })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || data.message || `监控重置失败（${response.status}）`);
      setState((current) => ({
        ...current,
        observability: data.observability
          ? resetObservabilitySnapshot(data.observability)
          : resetObservabilitySnapshot(current.observability)
      }));
      addLog("运行监控中心已重置", "info");
    } catch (err) {
      addLog(`监控重置失败：${err.message || String(err)}`, "error");
    }
  }

  async function loadMemories() {
    const response = await fetch("/api/agent-route/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "search_memories",
        goal_id: activeGoal?.id || "",
        query: memoryQuery,
        include_inactive: true,
        limit: 50
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.message || `记忆搜索失败（${response.status}）`);
    setState((current) => ({ ...current, memories: array(data.memories) }));
  }

  async function addManualMemory() {
    const summary = manualMemory.trim();
    if (!summary) return;
    const response = await fetch("/api/agent-route/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add_memory",
        goal_id: activeGoal?.id || "",
        title: "手动记忆",
        type: "knowledge",
        importance: 4,
        summary,
        source: "studio"
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.message || `记忆新增失败（${response.status}）`);
    setManualMemory("");
    addLog(`记忆已新增：${data.memory?.title || "手动记忆"}`, "success");
    await loadMemories();
  }

  function pauseAll() {
    abortRef.current?.abort();
    abortRef.current = null;
    setState((current) => ({
      ...current,
      goals: current.goals.map((goal) => (goal.status === "running" ? { ...goal, status: "stopped" } : goal))
    }));
    addLog("已请求暂停所有正在执行的目标", "warn");
  }

  function startNewTaskDraft() {
    setGoalText("");
    setPriority("normal");
    setSelectedGraphTaskId("");
    setSelectedQueueTaskId("");
    setState((current) => ({ ...current, activeGoalId: NEW_TASK_DRAFT_ID }));
    switchSection("control");
    save(GOAL_DRAFT_KEY, { goalText: "", priority: "normal", updatedAt: new Date().toISOString() });
    setTimeout(() => document.getElementById("goalText")?.focus(), 0);
    addLog("已打开新任务草稿，旧任务不会被删除。", "info");
  }

  function openSettings(tab = "models") {
    setSettingsTab(["models", "prompts", "budget"].includes(tab) ? tab : "models");
    setSettingsOpen(true);
    setSidebarOpen(false);
  }

  function openProviderSettings() {
    switchSection("providers");
  }

  function switchSection(section, options = {}) {
    const target = normalizeSectionTarget(section);
    const nextTab = options.taskTab || target.taskTab;
    if (nextTab) setTaskPanelTab(nextTab);
    setActiveSection(target.section);
    setSidebarOpen(false);
    if (typeof document !== "undefined") {
      try {
        window.history.replaceState(null, "", `#${target.section}`);
      } catch {}
      setTimeout(() => {
        document.querySelector(".main")?.scrollTo?.({ top: 0, behavior: "smooth" });
      }, 0);
    }
  }

  function updateCommander(value) {
    const next = saveModelSettings({ ...modelSettings, defaultCommander: value });
    setModelSettings(next);
  }

  const selectedCommander = storageReady ? modelSettings.defaultCommander : DEFAULT_MODEL_POOLS.commander[0];
  const commanderSelectOptions = readModelLines(
    storageReady ? modelSettings.pools.commander : DEFAULT_MODEL_POOLS.commander,
    DEFAULT_MODEL_POOLS.commander
  );
  const activeTasks = array(activeGoal?.tasks).filter(isUserVisibleTask);
  const controlStatus = activeGoal ? taskDerivedGoalStatus(activeGoal, activeTasks) : "";
  const activeGoalStatus = String(activeGoal?.status || "").toLowerCase();
  const activeGoalFailed =
    isFailed(activeGoalStatus) || ["waiting_human", "awaiting_confirmation"].includes(activeGoalStatus);
  const running = Boolean(abortRef.current);
  const showControlGoal = shouldShowGoalInControl(activeGoal, activeTasks, controlStatus, running);
  const controlDisplayStatus = showControlGoal
    ? running && activeGoal?.status === "running" && !activeTasks.length
      ? "running"
      : controlStatus
    : "";
  const controlGoalText = showControlGoal
    ? activeGoal?.goal
    : "输入一个长期目标，AgentRoute 会先制定战略，再生成感知依赖关系的执行图。";
  const graphNodes = array(graph.nodes);
  const readyIds = readyIdList(graph);
  const blockedChains = array(graph.blockedChains);
  const artifacts = array(graph.artifacts);
  const parallelGroups = array(graph.parallelGroups);
  const activeNav = NAV_ITEMS.find(([id]) => id === activeSection) || NAV_ITEMS[0];
  const attentionTaskCount = activeTasks.filter(needsHumanAttention).length;
  const activeVerifiedTaskCount = activeTasks.filter(
    (task) => String(task.verificationStatus || "").toLowerCase() === "verified"
  ).length;
  const verifiedTaskCount = activeTasks.length ? activeVerifiedTaskCount : (monitor.verificationHealth?.verified ?? 0);
  const attentionTasks = activeTasks.filter(needsHumanAttention).slice(0, 4);
  const recentLogs = array(state.logs).slice(-4).reverse();
  const latestEvents = array(monitor.events)
    .slice(0, 6)
    .map((event, index) => ({
      id: event.id || `${event.type || "event"}-${event.at || event.time || index}`,
      time: event.time || (event.at ? new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false }) : "--"),
      label: eventTypeLabel(event.type),
      level: event.severity || "info",
      message: displayEventMessage(event)
    }));
  const latestTimeline = latestEvents.length
    ? latestEvents
    : recentLogs.map((line) => ({
        id: line.id,
        time: line.time || "--",
        label: LOG_LEVEL_LABEL[line.level] || valueLabel(line.level) || line.level || "日志",
        level: line.level || "info",
        message: line.message
      }));

  function renderTaskWorkspacePanel() {
    return (
      <TaskWorkspacePanel
        goal={activeGoal}
        graph={graph}
        tasks={activeTasks}
        stats={{ nodes: graphNodes.length, ready: readyIds.length, blocked: blockedChains.length, artifacts }}
        visibleTasks={visibleTasks}
        filter={state.filter}
        activeTab={taskPanelTab}
        graphViewMode={graphViewMode}
        selectedGraphTaskId={selectedGraphTaskId}
        selectedQueueTaskId={selectedQueueTaskId}
        onTabChange={setTaskPanelTab}
        onGraphViewModeChange={setGraphViewMode}
        onFilterChange={(filter) => setState((current) => ({ ...current, filter }))}
        onSelectGraphTask={(taskId) => {
          setSelectedGraphTaskId(taskId);
          setSelectedQueueTaskId(taskId);
        }}
        onSelectQueueTask={(taskId) => {
          setSelectedQueueTaskId(taskId);
          setSelectedGraphTaskId(taskId);
        }}
        onRefreshGraph={() => refreshGraph().catch((err) => addLog(err.message, "error"))}
        onTaskAction={(task, action) => taskAction(task, action).catch((err) => addLog(err.message, "error"))}
      />
    );
  }

  return (
    <div className="studio-app app">
      {sidebarOpen ? (
        <button className="sidebar-backdrop" type="button" data-close-sidebar onClick={() => setSidebarOpen(false)} />
      ) : null}
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">
            <span className="material-symbols-outlined">schema</span>
          </div>
          <div>
            <h1>AgentRoute 控制台</h1>
            <p>AI 目标路由</p>
          </div>
        </div>
        <nav className="nav" aria-label="AgentRoute 导航">
          {NAV_ITEMS.map(([id, label, icon, desc]) => (
            <button
              key={id}
              type="button"
              data-scroll-target={id}
              className={activeSection === id ? "active" : ""}
              onClick={() => switchSection(id)}
            >
              <span className="material-symbols-outlined">{icon}</span>
              <span>
                <strong>{label}</strong>
                <small>{desc}</small>
              </span>
            </button>
          ))}
          <button type="button" data-open-settings="prompts" onClick={() => openSettings("prompts")}>
            <span className="material-symbols-outlined">settings</span>
            <span>设置</span>
          </button>
        </nav>
        <section className="side-panel">
          <h2>系统状态</h2>
          <div className="status-grid">
            <div className="status-row">
              <span>总指挥</span>
              <span className={`agent-status ${running ? "online" : ""}`}>{running ? "运行中" : "待命"}</span>
            </div>
            <div className="status-row">
              <span>活跃任务</span>
              <strong>{summary.running}</strong>
            </div>
            <div className="status-row">
              <span>等待任务</span>
              <strong>{summary.waiting}</strong>
            </div>
            <div className="status-row">
              <span>调用次数</span>
              <strong>{state.calls}</strong>
            </div>
          </div>
        </section>
        <section className="side-panel">
          <h2>快速操作</h2>
          <div className="quick">
            <button className="primary" type="button" data-focus-goal onClick={startNewTaskDraft}>
              <span className="material-symbols-outlined">add_task</span>创建新任务
            </button>
            <button type="button" onClick={pauseAll}>
              <span className="material-symbols-outlined">pause_circle</span>暂停所有任务
            </button>
            <button type="button" data-open-settings="models" onClick={() => openSettings("models")}>
              <span className="material-symbols-outlined">tune</span>模型路由
            </button>
            <button type="button" data-open-providers onClick={openProviderSettings}>
              <span className="material-symbols-outlined">key</span>供应商设置
            </button>
            <button type="button" data-open-settings="budget" onClick={() => openSettings("budget")}>
              <span className="material-symbols-outlined">speed</span>预算设置
            </button>
          </div>
        </section>
      </aside>

      <main className="main">
        <header className="topbar" id="control">
          <button
            className="icon-btn mobile-menu-btn"
            type="button"
            data-open-sidebar
            onClick={() => setSidebarOpen(true)}
            aria-label="打开导航"
          >
            <span className="material-symbols-outlined">menu</span>
          </button>
          <div className="title">
            <h1>{activeNav[1]}</h1>
            <p>{activeNav[3]}</p>
          </div>
          <div className="top-actions">
            <select
              className="top-model-select"
              value={selectedCommander}
              onChange={(event) => updateCommander(event.target.value)}
              aria-label="总指挥模型"
              suppressHydrationWarning
            >
              {commanderSelectOptions.map((id) => {
                const known = COMMANDERS.find((item) => item.id === id);
                return (
                  <option key={id} value={id} suppressHydrationWarning>
                    {known ? `${known.name} · ${known.note}` : id}
                  </option>
                );
              })}
            </select>
            <button className="btn" type="button" data-open-settings="models" onClick={() => openSettings("models")}>
              <span className="material-symbols-outlined">tune</span>设置
            </button>
            <button
              className="btn theme-toggle-btn"
              type="button"
              data-theme-toggle
              data-react-theme-toggle
              onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
              aria-pressed={theme === "light"}
              aria-label={theme === "light" ? "切换为深色主题" : "切换为浅色主题"}
              title={theme === "light" ? "切换为深色主题" : "切换为浅色主题"}
            >
              <span className="material-symbols-outlined">{theme === "light" ? "dark_mode" : "light_mode"}</span>
              <span>{theme === "light" ? "深色" : "浅色"}</span>
            </button>
          </div>
        </header>

        <div className={`workspace section-${activeSection}`}>
          <section className="center-col">
            <div className="app-section" data-agent-section="control" hidden={activeSection !== "control"}>
              <section className="panel">
                <div className="panel-head">
                  <h2>目标执行</h2>
                  <div className="panel-head-actions">
                    <button className="small-btn primary" type="button" onClick={startNewTaskDraft}>
                      <span className="material-symbols-outlined">add_task</span>
                      创建新任务
                    </button>
                    <span className={`pill ${controlDisplayStatus || ""}`}>
                      {showControlGoal ? displayStatus(controlDisplayStatus) : "待命"}
                    </span>
                  </div>
                </div>
                <div className="control-body">
                  <p className="goal-text">{controlGoalText}</p>
                  {activeGoal?.recoverySummary ? (
                    <div className="helper">
                      运行恢复：{formatDateTime(activeGoal.recoverySummary.at)} ·{" "}
                      {recoveryReasonLabel(activeGoal.recoverySummary.reason || activeGoal.recoverySummary.trigger)}
                      {activeGoal.blockedReason ? ` · ${recoveryReasonLabel(activeGoal.blockedReason)}` : ""}
                    </div>
                  ) : null}
                  <div className="metric-row home-metric-row">
                    <div className="metric">
                      <label>运行中</label>
                      <strong>{summary.running}</strong>
                    </div>
                    <div className="metric">
                      <label>需要处理</label>
                      <strong>{attentionTaskCount}</strong>
                    </div>
                    <div className="metric">
                      <label>已完成</label>
                      <strong>
                        {summary.done}/{summary.total}
                      </strong>
                    </div>
                    <div className="metric">
                      <label>验证通过</label>
                      <strong>{verifiedTaskCount}</strong>
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="goalText">新目标</label>
                    <textarea
                      id="goalText"
                      value={goalText}
                      onChange={(event) => setGoalText(event.target.value)}
                      placeholder="例如：30 天内提升高质量自动化项目接单率，但提案提交必须人工确认。"
                    />
                    <div className="helper">草稿会自动保存在本地，页面刷新后会恢复。</div>
                  </div>
                  <div className="top-actions">
                    <select value={priority} onChange={(event) => setPriority(event.target.value)} aria-label="优先级">
                      <option value="normal">普通优先级</option>
                      <option value="high">高优先级</option>
                      <option value="urgent">紧急</option>
                    </select>
                    <button className="btn" type="button" onClick={() => createGoal(false)}>
                      加入队列
                    </button>
                    <button className="btn primary" type="button" onClick={() => createGoal(true)}>
                      创建并执行
                    </button>
                    {showControlGoal && activeGoal.status !== "running" ? (
                      <button className="btn" type="button" onClick={() => runGoal(activeGoal, true)}>
                        继续当前目标
                      </button>
                    ) : null}
                  </div>
                </div>
              </section>

              <section className="panel home-timeline-panel">
                <div className="panel-head">
                  <h2>最新动态</h2>
                  <button className="link-btn" type="button" onClick={() => switchSection("logs")}>
                    查看日志
                  </button>
                </div>
                <div className="panel-body">
                  {latestTimeline.length ? (
                    <div className="home-timeline">
                      {latestTimeline.map((item, index) => (
                        <div className={`timeline-item ${item.level}`} key={timelineRenderKey(item, index)}>
                          <span>{item.time}</span>
                          <strong>{item.label}</strong>
                          <p>{safeDisplayText(item.message, 180)}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty compact">创建目标后，这里会显示最新事件和执行日志。</div>
                  )}
                </div>
              </section>

              {activeGoal && (activeGoal.output || activeGoal.status === "completed") ? (
                <section className="panel">
                  <div className="panel-head">
                    <h2>{activeGoalFailed ? "失败原因" : "最终结果"}</h2>
                    <span className={`tag ${activeGoalStatus || ""}`}>
                      {activeGoalFailed ? displayStatus(activeGoal.status) : activeGoal.finalModel || "总指挥"}
                    </span>
                  </div>
                  <div className="panel-body">
                    {activeGoal.output ? (
                      <MarkdownOutput content={activeGoal.output} />
                    ) : (
                      <div className="empty compact">
                        目标已结束，但没有收到最终结果内容。请查看执行日志或重新运行当前目标。
                      </div>
                    )}
                  </div>
                </section>
              ) : null}

              <section className="dashboard-grid">
                <article className="panel mini-panel">
                  <div className="panel-head">
                    <h2>需要处理</h2>
                    <button
                      className="link-btn"
                      type="button"
                      onClick={() => switchSection("tasks", { taskTab: "queue" })}
                    >
                      查看任务
                    </button>
                  </div>
                  <div className="panel-body">
                    {attentionTasks.length ? (
                      <div className="action-list">
                        {attentionTasks.map((task) => (
                          <button
                            className="attention-item"
                            key={task.id}
                            type="button"
                            onClick={() => switchSection("tasks", { taskTab: "queue" })}
                          >
                            <span className={`pill ${task.status}`}>{displayStatus(task.status, "任务")}</span>
                            <strong>{displayTask(task)}</strong>
                            <small>
                              {task.blockedReason
                                ? recoveryReasonLabel(task.blockedReason)
                                : verificationReasonLabel(array(task.verificationReasons)[0]) ||
                                  array(task.authenticityWarnings)[0] ||
                                  "等待处理"}
                            </small>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="empty compact">暂无需要人工处理的风险、失败或阻塞任务。</div>
                    )}
                  </div>
                </article>

                <article className="panel mini-panel">
                  <div className="panel-head">
                    <h2>详细视图</h2>
                    <span className="tag">按需查看</span>
                  </div>
                  <div className="panel-body">
                    <div className="home-detail-grid">
                      {HOME_DETAIL_LINKS.map(([id, label, icon, desc, taskTab]) => (
                        <button
                          className="detail-link-card"
                          key={`${id}-${taskTab || label}`}
                          type="button"
                          onClick={() => switchSection(id, { taskTab })}
                        >
                          <span className="material-symbols-outlined">{icon}</span>
                          <strong>{label}</strong>
                          <small>{desc}</small>
                        </button>
                      ))}
                    </div>
                  </div>
                </article>
              </section>
            </div>

            <div className="app-section agent-chat-section" data-agent-section="chat" hidden={activeSection !== "chat"}>
              <div className="agent-chat-console-grid">
                <AgentRouteChatPanel
                  commanderModel={selectedCommander}
                  modelPools={modelSettings.pools}
                  promptSettings={promptSettings}
                  budgetSettings={budgetSettings}
                  onRoundStart={registerChatGoal}
                  onAgentEvent={(goalId, type, data) => handleStreamEvent(goalId, type, data)}
                />
                <aside className="agent-chat-task-pane">
                  {activeSection === "chat" ? renderTaskWorkspacePanel() : null}
                </aside>
              </div>
            </div>

            <div className="app-section" data-agent-section="monitor" hidden={activeSection !== "monitor"}>
              <MonitorPanel
                monitor={monitor}
                recovery={state.recovery}
                recoveryLoading={recoveryLoading}
                recoveryError={recoveryError}
                onRefresh={() => refreshObservability().catch((err) => addLog(err.message, "error"))}
                onReset={() => resetMonitoring()}
                onRefreshRecovery={() => refreshRecoveryStatus().catch(() => {})}
                onRunRecovery={() => runRecoveryScan().catch(() => {})}
              />
            </div>

            <div className="app-section" data-agent-section="tasks" hidden={activeSection !== "tasks"}>
              {activeSection === "tasks" ? renderTaskWorkspacePanel() : null}
            </div>

            <div className="app-section" data-agent-section="providers" hidden={activeSection !== "providers"}>
              <section className="panel provider-workbench" id="providers">
                <div className="panel-head">
                  <div>
                    <h2>供应商设置</h2>
                    <p>这里内嵌原供应商管理页面，Agent 内部模型调用会使用这些连接和自定义 Provider 节点。</p>
                  </div>
                  <a className="link-btn" href="/dashboard/providers" target="_blank" rel="noreferrer">
                    新窗口打开
                  </a>
                </div>
                <div className="provider-frame-wrap">
                  {activeSection === "providers" && selectedProviderId ? (
                    <ProviderDetailPage
                      embedded
                      providerId={selectedProviderId}
                      onBack={() => setSelectedProviderId("")}
                    />
                  ) : null}
                  {activeSection === "providers" && !selectedProviderId ? (
                    <ProvidersDashboard embedded onOpenProvider={setSelectedProviderId} />
                  ) : null}
                </div>
              </section>
            </div>
          </section>

          <aside className="right-col app-section" data-agent-section="models" hidden={activeSection !== "models"}>
            <section className="panel" id="models">
              <div className="panel-head">
                <h2>模型等级体系</h2>
                <button
                  className="link-btn"
                  type="button"
                  data-open-settings="models"
                  onClick={() => openSettings("models")}
                >
                  管理模型
                </button>
              </div>
              <div className="tier-list">
                {MODEL_TIERS.map((tier) => {
                  const models = readModelLines(modelSettings.pools[tier.pool], DEFAULT_MODEL_POOLS[tier.pool]);
                  const preview = models.slice(0, 3).map(modelLabel).join(" / ");
                  return (
                    <div key={tier.key} className={`tier-card ${tier.key}`}>
                      <div className="tier-main">
                        <strong>
                          {tier.label}　{tier.title}
                        </strong>
                        <span>{models.length} 个模型</span>
                      </div>
                      <p>{preview || tier.desc}</p>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="panel" id="cost">
              <div className="panel-head">
                <h2>成本监控（今日）</h2>
              </div>
              <div className="panel-body">
                <div className="cost-summary">
                  <div>
                    <div className="big">${Number(state.spend || state.todaySpend || 0).toFixed(2)}</div>
                    <p>今日消耗</p>
                  </div>
                  <p>预算与降级由预算控制系统管理</p>
                </div>
                <div className="empty compact">
                  {budgetSettings.unlimited
                    ? "当前为无限预算测试模式：只记录消耗，不触发预算阻断或降级。"
                    : `当前目标默认最多 ${budgetSettings.goal.maxSteps} 个执行步骤，最多 ${budgetSettings.goal.maxRetries} 次重试。`}
                </div>
                <button
                  className="btn"
                  type="button"
                  data-open-settings="budget"
                  onClick={() => openSettings("budget")}
                >
                  调整预算设置
                </button>
              </div>
            </section>
          </aside>

          <aside
            className="right-col single app-section"
            data-agent-section="memory"
            hidden={activeSection !== "memory"}
          >
            <section className="panel" id="memory">
              <div className="panel-head">
                <h2>记忆</h2>
              </div>
              <div className="settings-body">
                <div className="field">
                  <label htmlFor="memorySearch">搜索长期记忆</label>
                  <input
                    id="memorySearch"
                    type="text"
                    value={memoryQuery}
                    onChange={(event) => setMemoryQuery(event.target.value)}
                    onKeyDown={(event) =>
                      event.key === "Enter" && loadMemories().catch((err) => addLog(err.message, "error"))
                    }
                    placeholder="偏好、风险、失败经验、执行图模式"
                  />
                </div>
                <button
                  className="btn primary"
                  type="button"
                  onClick={() => loadMemories().catch((err) => addLog(err.message, "error"))}
                >
                  搜索记忆
                </button>
                <div className="field">
                  <label htmlFor="manualMemory">新增非敏感记忆</label>
                  <textarea
                    id="manualMemory"
                    value={manualMemory}
                    onChange={(event) => setManualMemory(event.target.value)}
                    placeholder="只记录未来可复用的经验，不要写 token、cookie、密码。"
                  />
                </div>
                <button
                  className="btn"
                  type="button"
                  onClick={() => addManualMemory().catch((err) => addLog(err.message, "error"))}
                >
                  新增记忆
                </button>
              </div>
              <div className="memory-list">
                {array(state.memories).length ? (
                  array(state.memories).map((memory) => (
                    <article className="memory-item" key={memory.id || memory.title}>
                      <div className="memory-head">
                        <div className="memory-title">{memory.title || "记忆"}</div>
                        <span className="tag">重要度 {memory.importance || 1}</span>
                      </div>
                      <p className="memory-summary">{memory.summary || ""}</p>
                      <div className="memory-tags">
                        <span className="tag">{valueLabel(memory.type) || memory.type || "记忆"}</span>
                        <span className="tag">
                          {STATUS_LABEL[memory.status] || valueLabel(memory.status) || memory.status || "活跃"}
                        </span>
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="empty">暂无匹配记忆</div>
                )}
              </div>
            </section>
          </aside>

          <aside className="right-col single app-section" data-agent-section="logs" hidden={activeSection !== "logs"}>
            <section className="panel" id="logs">
              <div className="panel-head">
                <h2>执行日志</h2>
                <button className="link-btn" type="button" onClick={() => clearLogs()}>
                  清空日志
                </button>
              </div>
              <div className="log-list">
                {array(state.logs).length ? (
                  array(state.logs)
                    .slice(-80)
                    .reverse()
                    .map((line, index) => (
                      <div className={`log-line ${line.level}`} key={logRenderKey(line, index)}>
                        <span>[{line.time}]</span>
                        <span className="level">
                          [{LOG_LEVEL_LABEL[line.level] || valueLabel(line.level) || line.level}]
                        </span>
                        <span>{line.message}</span>
                      </div>
                    ))
                ) : (
                  <div className="empty">暂无执行日志</div>
                )}
              </div>
            </section>
          </aside>
        </div>
      </main>
      <SettingsDrawer
        open={settingsOpen}
        tab={settingsTab}
        onTabChange={setSettingsTab}
        onClose={() => setSettingsOpen(false)}
        modelSettings={modelSettings}
        promptSettings={promptSettings}
        budgetSettings={budgetSettings}
        onSaveModel={(next) => {
          const saved = saveModelSettings(next);
          setModelSettings(saved);
          addLog(`模型路由设置已保存：总指挥 ${saved.defaultCommander}`, "success");
        }}
        onResetModel={() => {
          const saved = saveModelSettings({
            defaultCommander: DEFAULT_MODEL_POOLS.commander[0],
            pools: cloneDefaultPools()
          });
          setModelSettings(saved);
          addLog("模型路由设置已恢复默认", "info");
        }}
        onSavePrompt={(next) => {
          const saved = savePromptSettings(next);
          setPromptSettings(saved);
          addLog("提示词设置已保存：总指挥、执行器与分级提示词将用于后续任务", "success");
        }}
        onResetPrompt={() => {
          const saved = savePromptSettings(cloneDefaultPromptSettings());
          setPromptSettings(saved);
          addLog("提示词设置已恢复默认", "info");
        }}
        onSaveBudget={(next) => {
          const saved = saveBudgetSettings(next);
          setBudgetSettings(saved);
          addLog(`预算设置已保存：目标最多 ${saved.goal.maxSteps} 个步骤`, "success");
        }}
        onResetBudget={() => {
          const saved = saveBudgetSettings(cloneDefaultBudgetSettings());
          setBudgetSettings(saved);
          addLog("预算设置已恢复默认", "info");
        }}
        addLog={addLog}
      />
    </div>
  );
}

function MonitorPanel({
  monitor,
  recovery,
  recoveryLoading,
  recoveryError,
  onRefresh,
  onReset,
  onRefreshRecovery,
  onRunRecovery
}) {
  const [eventFilter, setEventFilter] = useState("all");
  const diagnostics = monitor.diagnostics || {};
  const rootCauses = array(diagnostics.rootCauses);
  const events = array(monitor.events);
  const visibleEvents = events.filter((event) => {
    const type = String(event.type || "").toLowerCase();
    if (eventFilter === "all") return true;
    if (eventFilter === "authenticity") return type.startsWith("authenticity");
    if (eventFilter === "corrective") return type === "correctiveactionsuggested";
    if (eventFilter === "action_decision") return type === "actionranked";
    if (eventFilter === "action_learning") return type === "actionlearningupdated";
    if (eventFilter === "decision_attribution") return type === "decisionattributed";
    if (eventFilter === "recovery") return isRecoveryEventType(type);
    return type === eventFilter;
  });
  const workerHealth = array(monitor.workerHealth);
  const topTasks = array(monitor.budget.topTasks);
  const issues = array(monitor.verificationHealth.latestIssues);
  const authenticityWarnings = array(monitor.verificationHealth.authenticityWarnings);
  const authenticityScore = Number(monitor.verificationHealth.averageAuthenticityScore || 0);
  const authenticityState = authenticityLevel(authenticityScore);
  return (
    <section className="panel" id="monitor">
      <div className="panel-head">
        <h2>运行监控中心</h2>
        <div className="top-actions">
          <button className="link-btn" type="button" onClick={onRefresh}>
            刷新监控快照
          </button>
          <button className="link-btn" type="button" onClick={onReset}>
            重置监控
          </button>
        </div>
      </div>
      <div className="control-body">
        <div className="metric-row monitor-metrics">
          <div className="metric">
            <label>运行状态</label>
            <strong>{displayStatus(monitor.status)}</strong>
          </div>
          <div className="metric">
            <label>风险等级</label>
            <strong>{riskLabel(monitor.riskLevel)}</strong>
          </div>
          <div className="metric">
            <label>验证健康度</label>
            <strong>{percent(monitor.verificationHealth.passRate)}</strong>
          </div>
          <div className="metric">
            <label>预算消耗</label>
            <strong>{money(monitor.budget.cost)}</strong>
          </div>
        </div>
        <div className="monitor-grid">
          <section className="monitor-card">
            <div className="monitor-card-head">
              <span>故障诊断</span>
              <span className={`tag ${rootCauses.length ? "fail" : "done"}`}>{rootCauses.length || "正常"}</span>
            </div>
            <p>{diagnostics.summary || "暂无监控数据"}</p>
            <div className="monitor-stack">
              {rootCauses.length ? (
                rootCauses.slice(0, 4).map((reason) => (
                  <span className="graph-chip" key={reason.code}>
                    {rootCauseLabel(reason.code)}：{shortText(reason.message, 64)}
                  </span>
                ))
              ) : (
                <span className="graph-chip">无明显阻塞</span>
              )}
            </div>
            <p className="helper">{diagnostics.suggestedNextAction || "继续观察可执行任务"}</p>
          </section>

          <section className="monitor-card">
            <div className="monitor-card-head">
              <span>预算</span>
              <span className={`tag budget-${String(monitor.budget.degradationLevel === "none" ? "ok" : "degraded")}`}>
                {valueLabel(monitor.budget.degradationLevel) || "无"}
              </span>
            </div>
            <div className="monitor-kv">
              <span>Token</span>
              <strong>{monitor.budget.tokens}</strong>
            </div>
            <div className="monitor-kv">
              <span>运行时长</span>
              <strong>{formatMs(monitor.runtimeMs)}</strong>
            </div>
            <div className="monitor-stack">
              {topTasks.length ? (
                topTasks.slice(0, 4).map((task) => (
                  <span className="graph-chip" key={task.taskId || task.task_id}>
                    {shortText(displayTask(task.title || task.taskId || task.task_id), 42)} ·{" "}
                    {money(usageCost(task.usage || task.budgetUsage || {}))}
                  </span>
                ))
              ) : (
                <span className="graph-chip">暂无高成本任务</span>
              )}
            </div>
          </section>

          <section className="monitor-card">
            <div className="monitor-card-head">
              <span>验证</span>
              <span className={`tag verify-${monitor.verificationHealth.unverified ? "unverified" : "verified"}`}>
                {monitor.verificationHealth.checked || 0} 次检查
              </span>
            </div>
            <div className="monitor-kv">
              <span>平均置信度</span>
              <strong>{percent(monitor.verificationHealth.averageConfidence)}</strong>
            </div>
            <div className="monitor-kv">
              <span>失败数</span>
              <strong>{monitor.verificationHealth.failures || monitor.verificationHealth.unverified || 0}</strong>
            </div>
            <div className="monitor-stack">
              {issues.length ? (
                issues.slice(0, 4).map((issue, index) => (
                  <span className="graph-chip" key={`${issue.taskId}-${issue.issue}-${index}`}>
                    {issue.taskId}: {shortText(issue.issue, 54)}
                  </span>
                ))
              ) : (
                <span className="graph-chip">暂无验证问题</span>
              )}
            </div>
          </section>

          <section className="monitor-card authenticity-card">
            <div className="monitor-card-head">
              <span>真实性</span>
              <span className={`tag authenticity-${authenticityState.key}`}>{authenticityState.label}</span>
            </div>
            <div className="monitor-kv">
              <span>平均评分</span>
              <strong>{authenticityScore ? authenticityLabel(authenticityScore) : "待检查"}</strong>
            </div>
            <div className="monitor-kv">
              <span>可疑任务</span>
              <strong>{Number(monitor.verificationHealth.suspiciousAuthenticity || 0)}</strong>
            </div>
            <div className="monitor-stack">
              {authenticityWarnings.length ? (
                authenticityWarnings.slice(0, 4).map((item, index) => (
                  <span className="graph-chip" key={`${item.taskId}-${index}`}>
                    {item.taskId}: {authenticityWarningLabel(item.warning)}
                  </span>
                ))
              ) : (
                <span className="graph-chip">暂无真实性警告</span>
              )}
            </div>
          </section>

          <section className="monitor-card">
            <div className="monitor-card-head">
              <span>执行器健康</span>
              <span className="tag">{workerHealth.length || 0} 个模型</span>
            </div>
            <div className="monitor-stack">
              {workerHealth.length ? (
                workerHealth.slice(0, 5).map((worker) => (
                  <span className="graph-chip" key={worker.model}>
                    {shortText(worker.model, 36)} · 成功 {percent(worker.successRate)} · 验证{" "}
                    {percent(worker.verificationPassRate)}
                  </span>
                ))
              ) : (
                <span className="graph-chip">等待执行器事件</span>
              )}
            </div>
          </section>

          <RecoveryPanel
            recovery={recovery}
            loading={recoveryLoading}
            error={recoveryError}
            onRefresh={onRefreshRecovery}
            onRun={onRunRecovery}
          />
        </div>
        <div className="event-timeline">
          <div className="monitor-card-head">
            <span>实时事件时间线</span>
            <select
              className="compact-select"
              value={eventFilter}
              onChange={(event) => setEventFilter(event.target.value)}
              aria-label="事件筛选"
            >
              <option value="all">全部事件</option>
              <option value="authenticity">真实性事件</option>
              <option value="corrective">纠正建议</option>
              <option value="action_decision">动作排序</option>
              <option value="action_learning">行为经验</option>
              <option value="decision_attribution">决策归因</option>
              <option value="verification">验证事件</option>
              <option value="risk">风险事件</option>
              <option value="budget">预算事件</option>
              <option value="recovery">恢复事件</option>
            </select>
            <span className="tag">{visibleEvents.length}</span>
          </div>
          {visibleEvents.length ? (
            visibleEvents.slice(0, 12).map((event) => (
              <div className={`event-row ${event.severity || "info"}`} key={event.id || `${event.at}-${event.type}`}>
                <span>
                  {event.time || (event.at ? new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false }) : "--")}
                </span>
                <span className="event-type">{eventTypeLabel(event.type)}</span>
                <span>{displayEventMessage(event)}</span>
              </div>
            ))
          ) : (
            <div className="empty compact">暂无事件。运行目标后这里会实时更新。</div>
          )}
        </div>
      </div>
    </section>
  );
}

function RecoveryPanel({ recovery, loading, error, onRefresh, onRun }) {
  const summary = recovery && typeof recovery === "object" ? recovery : null;
  const warnings = array(summary?.warnings);
  const errors = array(summary?.errors);
  const recommended = array(summary?.actionsRecommended);
  const tasks = array(summary?.tasks);
  const statusText = recoveryStatusText(summary);
  return (
    <section className="monitor-card recovery-card">
      <div className="monitor-card-head">
        <span>运行恢复</span>
        <span className={`tag ${recoveryStatusClass(summary)}`}>{statusText}</span>
      </div>
      <div className="monitor-kv">
        <span>上次恢复时间</span>
        <strong>{formatDateTime(summary?.at)}</strong>
      </div>
      <div className="recovery-metrics">
        <span>目标 {Number(summary?.scannedGoals || 0)}</span>
        <span>任务 {Number(summary?.scannedTasks || 0)}</span>
        <span>恢复任务 {Number(summary?.recoveredTasks || 0)}</span>
        <span>恢复目标 {Number(summary?.recoveredGoals || 0)}</span>
        <span>中断 {Number(summary?.interruptedTasks || 0)}</span>
        <span>执行器丢失 {Number(summary?.workerLost || 0)}</span>
        <span>会话失效 {Number(summary?.staleBrowserSessions || 0)}</span>
        <span>警告 {warnings.length}</span>
        <span>错误 {errors.length}</span>
      </div>
      <div className="monitor-stack">
        {errors.length
          ? errors.slice(0, 2).map((item, index) => (
              <span className="graph-chip" key={`recovery-error-${index}`}>
                错误：{safeDisplayText(item, 72)}
              </span>
            ))
          : null}
        {warnings.length
          ? warnings.slice(0, 3).map((item, index) => (
              <span className="graph-chip" key={`recovery-warning-${index}`}>
                警告：{safeDisplayText(item, 72)}
              </span>
            ))
          : null}
        {!errors.length && !warnings.length ? (
          <span className="graph-chip">{hasRecoverySummary(summary) ? "暂无恢复警告" : "尚未运行恢复扫描"}</span>
        ) : null}
      </div>
      {tasks.length ? (
        <div className="recovery-list">
          {tasks.slice(0, 4).map((item) => (
            <span className="graph-chip" key={`${item.goalId || item.goal_id}-${item.taskId || item.task_id}`}>
              {item.taskId || item.task_id}：{displayStatus(item.from)} → {displayStatus(item.to)} ·{" "}
              {recoveryReasonLabel(item.reason)}
            </span>
          ))}
        </div>
      ) : null}
      <p className="helper">
        {recommended.length
          ? recommended
              .slice(0, 2)
              .map((item) => safeDisplayText(item, 90))
              .join("；")
          : "恢复机制只安全收束不可信运行态，不会自动继续高风险任务。"}
      </p>
      {error ? <p className="helper">恢复接口错误：{safeDisplayText(error, 120)}</p> : null}
      <div className="recovery-actions">
        <button className="link-btn" type="button" onClick={onRefresh} disabled={loading}>
          {loading ? "刷新中..." : "刷新恢复状态"}
        </button>
        <button className="link-btn" type="button" onClick={onRun} disabled={loading}>
          {loading ? "扫描中..." : "手动运行恢复扫描"}
        </button>
      </div>
    </section>
  );
}

function SettingsDrawer({
  open,
  tab,
  onTabChange,
  onClose,
  modelSettings,
  promptSettings,
  budgetSettings,
  onSaveModel,
  onResetModel,
  onSavePrompt,
  onResetPrompt,
  onSaveBudget,
  onResetBudget,
  addLog
}) {
  const [defaultCommander, setDefaultCommander] = useState(
    modelSettings.defaultCommander || DEFAULT_MODEL_POOLS.commander[0]
  );
  const [pools, setPools] = useState(modelSettings.pools || cloneDefaultPools());
  const [prompts, setPrompts] = useState(promptSettings);
  const [budgets, setBudgets] = useState(budgetSettings);
  const [providerStatus, setProviderStatus] = useState({
    supportedProviders: FALLBACK_SUPPORTED_PROVIDERS,
    connections: [],
    providerNodes: [],
    providerGroups: {}
  });
  const [providerForm, setProviderForm] = useState(() => emptyProviderForm());
  const [providerNodeForm, setProviderNodeForm] = useState(() => emptyProviderNodeForm());
  const [providerLoading, setProviderLoading] = useState(false);
  const [providerError, setProviderError] = useState("");
  const promptImportRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setDefaultCommander(modelSettings.defaultCommander || DEFAULT_MODEL_POOLS.commander[0]);
    setPools({
      commander: readModelLines(modelSettings.pools?.commander, DEFAULT_MODEL_POOLS.commander),
      strong: readModelLines(modelSettings.pools?.strong, DEFAULT_MODEL_POOLS.strong),
      coding: readModelLines(modelSettings.pools?.coding, DEFAULT_MODEL_POOLS.coding),
      free: readModelLines(modelSettings.pools?.free, DEFAULT_MODEL_POOLS.free)
    });
    setPrompts(normalizePromptSettings(promptSettings));
    setBudgets(normalizeBudgetSettings(budgetSettings));
  }, [open, modelSettings, promptSettings, budgetSettings]);

  useEffect(() => {
    if (!open || tab !== "providers") return;
    refreshProviders({ silent: true }).catch(() => {});
  }, [open, tab]);

  function emptyProviderForm(overrides = {}) {
    return {
      id: "",
      provider: "openrouter",
      name: "",
      apiKey: "",
      baseUrl: "",
      defaultModel: "",
      priority: 1,
      isActive: true,
      ...overrides
    };
  }

  function emptyProviderNodeForm(overrides = {}) {
    return {
      id: "",
      name: "",
      prefix: "",
      type: "openai-compatible",
      apiType: "chat",
      baseUrl: "",
      models: "",
      ...overrides
    };
  }

  function providerLabel(provider) {
    const match = array(providerStatus.supportedProviders).find((item) => item.id === provider);
    return match?.label || provider || "供应商";
  }

  function providerMeta(provider) {
    return array(providerStatus.supportedProviders).find((item) => item.id === provider) || {};
  }

  function providerCount(provider) {
    return array(providerStatus.connections).filter((connection) => connection.provider === provider).length;
  }

  function providerSampleModels(provider) {
    const meta = providerMeta(provider);
    return array(meta.sampleModels).length
      ? meta.sampleModels
      : array(meta.models)
          .slice(0, 4)
          .map((model) => `${meta.alias || provider}/${model.id || model}`);
  }

  function providerGroup(groupKey, fallback) {
    const grouped = providerStatus.providerGroups || {};
    const values = array(grouped[groupKey]);
    if (values.length) return values;
    return array(providerStatus.supportedProviders).filter((provider) => {
      if (fallback === "custom") return provider.custom || provider.category === "custom";
      if (fallback === "oauth") return provider.authType === "oauth" || provider.category === "oauth";
      return provider.authType === "apikey" && !provider.custom;
    });
  }

  async function refreshProviders(options = {}) {
    setProviderLoading(true);
    setProviderError("");
    try {
      const response = await fetch("/api/agent-route/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "provider_status" })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(data.error?.message || data.message || `供应商状态获取失败（${response.status}）`);
      const status = data.providerSettings || {
        supportedProviders: data.supportedProviders || FALLBACK_SUPPORTED_PROVIDERS,
        connections: data.providers || []
      };
      setProviderStatus({
        ...status,
        supportedProviders: array(status.supportedProviders).length
          ? status.supportedProviders
          : FALLBACK_SUPPORTED_PROVIDERS,
        connections: array(status.connections || data.providers),
        providerNodes: array(status.providerNodes),
        providerGroups: status.providerGroups || {}
      });
      if (!options.silent) addLog("供应商设置已刷新", "info");
      return status;
    } catch (err) {
      setProviderError(err.message || String(err));
      if (!options.silent) addLog(`供应商设置刷新失败：${err.message || String(err)}`, "error");
      throw err;
    } finally {
      setProviderLoading(false);
    }
  }

  function editProvider(connection) {
    if (!connection) {
      setProviderForm(emptyProviderForm());
      return;
    }
    setProviderForm(
      emptyProviderForm({
        id: connection.id || "",
        provider: connection.provider || "openrouter",
        name: connection.name || "",
        apiKey: "",
        baseUrl: connection.baseUrl || "",
        defaultModel: connection.defaultModel || "",
        priority: Number(connection.priority || 1),
        isActive: connection.isActive !== false
      })
    );
    setProviderError("");
  }

  function updateProviderForm(key, value) {
    setProviderForm((current) => ({ ...current, [key]: value }));
  }

  function editProviderNode(node) {
    if (!node) {
      setProviderNodeForm(emptyProviderNodeForm());
      return;
    }
    setProviderNodeForm(
      emptyProviderNodeForm({
        id: node.id || "",
        name: node.name || "",
        prefix: node.prefix || "",
        type: node.type || "openai-compatible",
        apiType: node.apiType || "chat",
        baseUrl: node.baseUrl || "",
        models: array(node.models)
          .map((model) => model.id || model)
          .join("\n")
      })
    );
  }

  function updateProviderNodeForm(key, value) {
    setProviderNodeForm((current) => ({ ...current, [key]: value }));
  }

  async function saveProvider() {
    const isNew = !providerForm.id;
    const meta = providerMeta(providerForm.provider);
    if (meta.authType === "oauth") {
      setProviderError("OAuth 连接需要走授权弹窗或 token 导入流程，请在右侧供应商管理页面打开对应供应商后点击授权。");
      return;
    }
    if (isNew && !String(providerForm.apiKey || "").trim()) {
      setProviderError("新建供应商连接需要填写 API Key。已有连接留空则保留旧 Key。");
      return;
    }
    setProviderLoading(true);
    setProviderError("");
    try {
      const response = await fetch("/api/agent-route/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_provider",
          id: providerForm.id,
          provider: providerForm.provider,
          name: providerForm.name,
          apiKey: providerForm.apiKey,
          baseUrl: providerForm.baseUrl,
          defaultModel: providerForm.defaultModel,
          priority: Number(providerForm.priority || 1),
          isActive: Boolean(providerForm.isActive)
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || data.message || `供应商保存失败（${response.status}）`);
      const status = data.providerSettings || {};
      setProviderStatus({
        ...status,
        supportedProviders: array(status.supportedProviders).length
          ? status.supportedProviders
          : FALLBACK_SUPPORTED_PROVIDERS,
        connections: array(status.connections || data.providers),
        providerNodes: array(status.providerNodes),
        providerGroups: status.providerGroups || {}
      });
      setProviderForm(emptyProviderForm({ provider: providerForm.provider }));
      addLog(`供应商设置已保存：${providerLabel(providerForm.provider)}`, "success");
    } catch (err) {
      setProviderError(err.message || String(err));
      addLog(`供应商设置保存失败：${err.message || String(err)}`, "error");
    } finally {
      setProviderLoading(false);
    }
  }

  async function deleteProvider(connection) {
    if (!connection?.id) return;
    if (!window.confirm(`确定删除供应商连接「${connection.name || providerLabel(connection.provider)}」吗？`)) return;
    setProviderLoading(true);
    setProviderError("");
    try {
      const response = await fetch("/api/agent-route/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete_provider", id: connection.id })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || data.message || `供应商删除失败（${response.status}）`);
      const status = data.providerSettings || {};
      setProviderStatus({
        ...status,
        supportedProviders: array(status.supportedProviders).length
          ? status.supportedProviders
          : FALLBACK_SUPPORTED_PROVIDERS,
        connections: array(status.connections || data.providers),
        providerNodes: array(status.providerNodes),
        providerGroups: status.providerGroups || {}
      });
      if (providerForm.id === connection.id) setProviderForm(emptyProviderForm());
      addLog(`供应商连接已删除：${connection.name || providerLabel(connection.provider)}`, "warn");
    } catch (err) {
      setProviderError(err.message || String(err));
      addLog(`供应商删除失败：${err.message || String(err)}`, "error");
    } finally {
      setProviderLoading(false);
    }
  }

  async function testProvider(connection) {
    if (!connection?.id) return;
    setProviderLoading(true);
    setProviderError("");
    try {
      const response = await fetch("/api/agent-route/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test_provider", id: connection.id })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || data.message || `供应商测试失败（${response.status}）`);
      const status = data.providerSettings || {};
      setProviderStatus({
        ...status,
        supportedProviders: array(status.supportedProviders).length
          ? status.supportedProviders
          : FALLBACK_SUPPORTED_PROVIDERS,
        connections: array(status.connections || data.providers),
        providerNodes: array(status.providerNodes),
        providerGroups: status.providerGroups || {}
      });
      addLog(data.message || "供应商连接测试已完成", data.valid ? "success" : "warn");
    } catch (err) {
      setProviderError(err.message || String(err));
      addLog(`供应商测试失败：${err.message || String(err)}`, "error");
    } finally {
      setProviderLoading(false);
    }
  }

  async function saveProviderNode() {
    if (!String(providerNodeForm.prefix || "").trim() || !String(providerNodeForm.baseUrl || "").trim()) {
      setProviderError("自定义 Provider 需要填写前缀和 Base URL。");
      return;
    }
    setProviderLoading(true);
    setProviderError("");
    try {
      const response = await fetch("/api/agent-route/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_provider_node",
          id: providerNodeForm.id || providerNodeForm.prefix,
          name: providerNodeForm.name,
          prefix: providerNodeForm.prefix,
          type: providerNodeForm.type,
          apiType: providerNodeForm.apiType,
          baseUrl: providerNodeForm.baseUrl,
          models: providerNodeForm.models
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(data.error?.message || data.message || `自定义 Provider 保存失败（${response.status}）`);
      const status = data.providerSettings || {};
      setProviderStatus({
        ...status,
        supportedProviders: array(status.supportedProviders).length
          ? status.supportedProviders
          : FALLBACK_SUPPORTED_PROVIDERS,
        connections: array(status.connections || data.providers),
        providerNodes: array(status.providerNodes),
        providerGroups: status.providerGroups || {}
      });
      setProviderNodeForm(emptyProviderNodeForm());
      addLog("自定义 Provider 已保存", "success");
    } catch (err) {
      setProviderError(err.message || String(err));
      addLog(`自定义 Provider 保存失败：${err.message || String(err)}`, "error");
    } finally {
      setProviderLoading(false);
    }
  }

  async function deleteProviderNode(node) {
    if (!node?.id) return;
    if (!window.confirm(`确定删除自定义 Provider「${node.name || node.id}」以及它的连接吗？`)) return;
    setProviderLoading(true);
    setProviderError("");
    try {
      const response = await fetch("/api/agent-route/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete_provider_node", id: node.id })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(data.error?.message || data.message || `自定义 Provider 删除失败（${response.status}）`);
      const status = data.providerSettings || {};
      setProviderStatus({
        ...status,
        supportedProviders: array(status.supportedProviders).length
          ? status.supportedProviders
          : FALLBACK_SUPPORTED_PROVIDERS,
        connections: array(status.connections || data.providers),
        providerNodes: array(status.providerNodes),
        providerGroups: status.providerGroups || {}
      });
      if (providerNodeForm.id === node.id) setProviderNodeForm(emptyProviderNodeForm());
      addLog("自定义 Provider 已删除", "warn");
    } catch (err) {
      setProviderError(err.message || String(err));
      addLog(`自定义 Provider 删除失败：${err.message || String(err)}`, "error");
    } finally {
      setProviderLoading(false);
    }
  }

  function updatePool(pool, value) {
    setPools((current) => ({ ...current, [pool]: readModelLines(value, DEFAULT_MODEL_POOLS[pool]) }));
  }

  function modelDraft() {
    let nextPools = {
      commander: readModelLines(pools.commander, DEFAULT_MODEL_POOLS.commander),
      strong: readModelLines(pools.strong, DEFAULT_MODEL_POOLS.strong),
      coding: readModelLines(pools.coding, DEFAULT_MODEL_POOLS.coding),
      free: readModelLines(pools.free, DEFAULT_MODEL_POOLS.free)
    };
    const requestedCommander = normalizeCommanderModelId(
      defaultCommander || nextPools.commander[0] || DEFAULT_MODEL_POOLS.commander[0]
    );
    if (requestedCommander && !nextPools.commander.includes(requestedCommander)) {
      nextPools.commander.unshift(requestedCommander);
    }
    nextPools = dedupePoolsByTier(cleanPoolsForTier(nextPools));
    const nextCommander =
      isSupportedCommanderModel(requestedCommander) && nextPools.commander.includes(requestedCommander)
        ? requestedCommander
        : nextPools.commander[0] || DEFAULT_MODEL_POOLS.commander[0];
    return { defaultCommander: nextCommander, pools: nextPools };
  }

  function promptDraft() {
    return normalizePromptSettings(prompts);
  }

  function updatePromptField(key, value) {
    setPrompts((current) => ({ ...current, [key]: value }));
  }

  function updateTierPrompt(key, value) {
    setPrompts((current) => ({
      ...current,
      tierPrompts: {
        ...(current.tierPrompts || {}),
        [key]: value
      }
    }));
  }

  function updateBudget(section, key, value) {
    const numeric = budgetNumber(value, 0);
    setBudgets((current) =>
      normalizeBudgetSettings({
        ...current,
        [section]: {
          ...(current?.[section] || {}),
          [key]: numeric
        }
      })
    );
  }

  function updateBudgetMode(unlimited) {
    setBudgets((current) =>
      normalizeBudgetSettings({
        ...current,
        unlimited: Boolean(unlimited),
        mode: unlimited ? "unlimited" : "limited"
      })
    );
  }

  function updateBudgetMinutes(section, key, value) {
    updateBudget(section, key, Math.round(budgetNumber(value, 0) * 60 * 1000));
  }

  function saveModels() {
    const next = normalizeModelSettings(modelDraft());
    setDefaultCommander(next.defaultCommander);
    setPools(next.pools);
    onSaveModel(next);
  }

  function savePrompts() {
    const next = promptDraft();
    setPrompts(next);
    onSavePrompt(next);
  }

  function saveBudgets() {
    const next = normalizeBudgetSettings(budgets);
    setBudgets(next);
    onSaveBudget(next);
  }

  function exportPrompts() {
    const next = promptDraft();
    const payload = exportedPromptPayload(next);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    link.href = url;
    link.download = `agent-route-prompts-${stamp}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    addLog("提示词配置已导出", "success");
  }

  function importPrompts(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || ""));
        const imported = promptSettingsFromImport(parsed);
        const next = normalizePromptSettings(imported);
        setPrompts(next);
        onSavePrompt(next);
        onTabChange("prompts");
        addLog("提示词配置已导入", "success");
      } catch (err) {
        addLog(`提示词配置导入失败：${err.message || String(err)}`, "error");
      }
    };
    reader.readAsText(file);
  }

  return (
    <aside className={`drawer model-drawer ${open ? "open" : ""}`} aria-hidden={!open}>
      <div className="drawer-head">
        <h2>AgentRoute 设置</h2>
        <button className="icon-btn" type="button" data-close-settings onClick={onClose} aria-label="关闭">
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>
      <div className="drawer-body model-settings">
        <div className="settings-tabs" role="tablist" aria-label="AgentRoute 设置">
          <button
            className={`settings-tab ${tab === "models" ? "active" : ""}`}
            type="button"
            data-settings-tab="models"
            onClick={() => onTabChange("models")}
            role="tab"
            aria-selected={tab === "models"}
          >
            模型路由
          </button>
          <button
            className={`settings-tab ${tab === "prompts" ? "active" : ""}`}
            type="button"
            data-settings-tab="prompts"
            onClick={() => onTabChange("prompts")}
            role="tab"
            aria-selected={tab === "prompts"}
          >
            提示词设置
          </button>
          <button
            className={`settings-tab ${tab === "budget" ? "active" : ""}`}
            type="button"
            data-settings-tab="budget"
            onClick={() => onTabChange("budget")}
            role="tab"
            aria-selected={tab === "budget"}
          >
            预算设置
          </button>
        </div>

        <div className="settings-tab-panel" data-settings-panel="models" hidden={tab !== "models"}>
          <section className="settings-card">
            <div className="field">
              <label htmlFor="defaultCommanderInput">默认总指挥模型</label>
              <input
                id="defaultCommanderInput"
                type="text"
                list="commanderOptions"
                value={defaultCommander}
                onChange={(event) => setDefaultCommander(event.target.value)}
                placeholder="gpt5.5"
                autoComplete="off"
              />
              <datalist id="commanderOptions">
                {readModelLines(pools.commander, DEFAULT_MODEL_POOLS.commander).map((id) => (
                  <option key={id} value={id}>
                    {modelLabel(id)}
                  </option>
                ))}
              </datalist>
            </div>
            <button className="btn primary" type="button" onClick={saveModels}>
              <span className="material-symbols-outlined">save</span>保存设置
            </button>
          </section>

          <div className="model-pool-grid">
            {MODEL_TIERS.map((tier) => {
              const models = readModelLines(pools[tier.pool], DEFAULT_MODEL_POOLS[tier.pool]);
              return (
                <section className={`model-pool-card ${tier.key}`} key={tier.pool}>
                  <div className="model-pool-head">
                    <div className="model-pool-title">
                      <strong>
                        {tier.title
                          .replace("（高成本 / 最强能力）", "")
                          .replace("（中等成本 / 较强能力）", "")
                          .replace("（低成本 / 基础能力）", "")
                          .replace("（零成本 / 基础能力）", "")}
                      </strong>
                      <span>{tier.desc}</span>
                    </div>
                    <span className="pool-count">{models.length}</span>
                  </div>
                  <textarea
                    value={models.join("\n")}
                    onChange={(event) => updatePool(tier.pool, event.target.value)}
                    spellCheck="false"
                  />
                  <div className="model-help">每行一个模型标识。</div>
                </section>
              );
            })}
          </div>

          <div className="model-actions">
            <button className="btn" type="button" onClick={onResetModel}>
              <span className="material-symbols-outlined">restart_alt</span>恢复默认
            </button>
            <button className="btn" type="button" data-close-settings onClick={onClose}>
              关闭
            </button>
          </div>
        </div>

        <div className="settings-tab-panel" data-settings-panel="providers" hidden={tab !== "providers"}>
          <section className="settings-card">
            <div className="field">
              <label>供应商管理</label>
              <div className="model-help">
                已按原供应商管理模型恢复 OAuth 供应商、API Key 供应商和自定义 Provider 节点。API Key
                只写入本地数据库，页面不会回显明文；OAuth 请在供应商详情页使用授权弹窗或手动导入完成连接。
              </div>
            </div>
            <div className="model-actions">
              <button className="btn" type="button" onClick={() => refreshProviders()} disabled={providerLoading}>
                <span className="material-symbols-outlined">refresh</span>刷新供应商
              </button>
              <button className="btn" type="button" onClick={() => editProvider(null)} disabled={providerLoading}>
                <span className="material-symbols-outlined">add_circle</span>新增连接
              </button>
            </div>
            {providerError ? <div className="error-box">{providerError}</div> : null}
          </section>

          <div className="provider-catalog-grid">
            {[
              ["oauthProviders", "oauth", "OAuth / 订阅供应商", "原供应商管理中的 CLI/OAuth 账号入口"],
              [
                "apiKeyProviders",
                "apikey",
                "API Key 供应商",
                "可保存本地 Key；OpenAI-compatible 会进入 Agent 内部模型调用"
              ],
              ["customProviders", "custom", "自定义 Provider", "用自己的 OpenAI-compatible 节点扩展模型前缀"]
            ].map(([groupKey, fallback, title, hint]) => (
              <section className="settings-card provider-catalog-section" key={groupKey}>
                <div className="provider-list-head">
                  <div>
                    <strong>{title}</strong>
                    <p>{hint}</p>
                  </div>
                  <span className="tag">{providerGroup(groupKey, fallback).length}</span>
                </div>
                <div className="provider-card-list">
                  {providerGroup(groupKey, fallback).length ? (
                    providerGroup(groupKey, fallback).map((provider) => {
                      const count = providerCount(provider.id);
                      const samples = providerSampleModels(provider.id);
                      return (
                        <button
                          className={`provider-card ${providerForm.provider === provider.id ? "selected" : ""}`}
                          key={provider.id}
                          type="button"
                          onClick={() => updateProviderForm("provider", provider.id)}
                        >
                          <span>
                            <strong>{provider.label || provider.name || provider.id}</strong>
                            <small>
                              {provider.alias ? `${provider.alias}/` : provider.id}
                              {provider.authType === "oauth"
                                ? " · OAuth"
                                : provider.custom
                                  ? " · Custom"
                                  : " · API Key"}
                            </small>
                          </span>
                          <span className="provider-card-meta">
                            <span>{count} 个连接</span>
                            <span>{samples.slice(0, 2).join("，") || "未配置模型示例"}</span>
                          </span>
                        </button>
                      );
                    })
                  ) : (
                    <div className="empty compact">暂无条目</div>
                  )}
                </div>
              </section>
            ))}
          </div>

          <div className="provider-settings-grid">
            <section className="settings-card">
              <div className="field">
                <label htmlFor="providerSelect">供应商</label>
                <select
                  id="providerSelect"
                  value={providerForm.provider}
                  onChange={(event) => updateProviderForm("provider", event.target.value)}
                >
                  {array(providerStatus.supportedProviders).map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label || provider.id}
                    </option>
                  ))}
                </select>
                {providerMeta(providerForm.provider).authType === "oauth" ? (
                  <div className="model-help warning">
                    这个 OAuth 供应商需要通过供应商详情页的授权弹窗或 token 导入完成连接；这里仅用于查看目录和已有连接。
                  </div>
                ) : null}
              </div>
              <div className="field">
                <label htmlFor="providerName">连接名称</label>
                <input
                  id="providerName"
                  type="text"
                  value={providerForm.name}
                  onChange={(event) => updateProviderForm("name", event.target.value)}
                  placeholder={`${providerLabel(providerForm.provider)} 主账号`}
                />
              </div>
              <div className="field">
                <label htmlFor="providerApiKey">API Key</label>
                <input
                  id="providerApiKey"
                  type="password"
                  disabled={providerMeta(providerForm.provider).authType === "oauth"}
                  value={providerForm.apiKey}
                  onChange={(event) => updateProviderForm("apiKey", event.target.value)}
                  placeholder={providerForm.id ? "留空则保留已保存 Key" : "粘贴供应商 API Key"}
                  autoComplete="off"
                />
                <div className="model-help">保存后只显示脱敏状态，不会把 Key 放进 localStorage 或页面日志。</div>
              </div>
              <div className="field">
                <label htmlFor="providerBaseUrl">自定义 Base URL（可选）</label>
                <input
                  id="providerBaseUrl"
                  type="url"
                  value={providerForm.baseUrl}
                  onChange={(event) => updateProviderForm("baseUrl", event.target.value)}
                  placeholder="留空使用内置 OpenAI-compatible endpoint"
                />
              </div>
              <div className="field">
                <label htmlFor="providerDefaultModel">默认模型（可选）</label>
                <input
                  id="providerDefaultModel"
                  type="text"
                  value={providerForm.defaultModel}
                  onChange={(event) => updateProviderForm("defaultModel", event.target.value)}
                  placeholder={providerSampleModels(providerForm.provider)[0] || "例如 openrouter/auto"}
                />
              </div>
              <div className="provider-inline-fields">
                <BudgetNumber
                  label="优先级"
                  value={providerForm.priority}
                  onChange={(value) => updateProviderForm("priority", value)}
                />
                <label className="toggle-row compact">
                  <input
                    type="checkbox"
                    checked={Boolean(providerForm.isActive)}
                    onChange={(event) => updateProviderForm("isActive", event.target.checked)}
                  />
                  <span>
                    <strong>启用连接</strong>
                    <small>关闭后不会被模型代理使用。</small>
                  </span>
                </label>
              </div>
              <div className="model-actions">
                <button className="btn primary" type="button" onClick={saveProvider} disabled={providerLoading}>
                  <span className="material-symbols-outlined">save</span>
                  {providerForm.id ? "保存连接" : "新增连接"}
                </button>
                <button className="btn" type="button" onClick={() => editProvider(null)} disabled={providerLoading}>
                  清空表单
                </button>
              </div>
            </section>

            <section className="settings-card">
              <div className="provider-list-head">
                <div>
                  <strong>已配置连接</strong>
                  <p>{array(providerStatus.connections).length} 个供应商连接</p>
                </div>
                {providerLoading ? <span className="tag">同步中</span> : null}
              </div>
              <div className="provider-list">
                {array(providerStatus.connections).length ? (
                  array(providerStatus.connections).map((connection) => (
                    <article className={`provider-item ${connection.isActive ? "active" : ""}`} key={connection.id}>
                      <div className="provider-item-main">
                        <div>
                          <strong>{connection.name || providerLabel(connection.provider)}</strong>
                          <p>
                            {providerLabel(connection.provider)} · 优先级 {connection.priority || 1}
                          </p>
                        </div>
                        <span className={`pill ${connection.isActive ? "completed" : "cancelled"}`}>
                          {connection.isActive ? "启用" : "停用"}
                        </span>
                      </div>
                      <div className="provider-meta">
                        <span>{connection.hasApiKey ? `Key ${connection.apiKeyMasked}` : "未保存 Key"}</span>
                        <span>{connection.baseUrl || "使用内置 endpoint"}</span>
                      </div>
                      <div className="model-actions">
                        <button className="btn" type="button" onClick={() => editProvider(connection)}>
                          编辑
                        </button>
                        <button className="btn" type="button" onClick={() => testProvider(connection)}>
                          测试
                        </button>
                        <button className="btn danger" type="button" onClick={() => deleteProvider(connection)}>
                          删除
                        </button>
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="empty compact">
                    暂无供应商连接。新增后，Agent 内部模型调用会按模型前缀自动选择供应商。
                  </div>
                )}
              </div>
            </section>
          </div>

          <section className="settings-card">
            <div className="provider-list-head">
              <div>
                <strong>自定义 Provider 节点</strong>
                <p>对应原供应商管理的 Custom Providers，用模型前缀接入自己的 OpenAI-compatible endpoint。</p>
              </div>
              <button className="btn" type="button" onClick={() => editProviderNode(null)} disabled={providerLoading}>
                清空节点表单
              </button>
            </div>
            <div className="provider-node-grid">
              <div className="provider-node-form">
                <div className="provider-inline-fields">
                  <div className="field">
                    <label htmlFor="providerNodeName">名称</label>
                    <input
                      id="providerNodeName"
                      type="text"
                      value={providerNodeForm.name}
                      onChange={(event) => updateProviderNodeForm("name", event.target.value)}
                      placeholder="我的模型节点"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="providerNodePrefix">模型前缀</label>
                    <input
                      id="providerNodePrefix"
                      type="text"
                      value={providerNodeForm.prefix}
                      onChange={(event) => updateProviderNodeForm("prefix", event.target.value)}
                      placeholder="myapi"
                    />
                  </div>
                </div>
                <div className="provider-inline-fields">
                  <div className="field">
                    <label htmlFor="providerNodeType">类型</label>
                    <select
                      id="providerNodeType"
                      value={providerNodeForm.type}
                      onChange={(event) => updateProviderNodeForm("type", event.target.value)}
                    >
                      <option value="openai-compatible">openai-compatible</option>
                      <option value="anthropic-compatible">anthropic-compatible</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="providerNodeApiType">API 类型</label>
                    <select
                      id="providerNodeApiType"
                      value={providerNodeForm.apiType}
                      onChange={(event) => updateProviderNodeForm("apiType", event.target.value)}
                    >
                      <option value="chat">chat</option>
                      <option value="responses">responses</option>
                    </select>
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="providerNodeBaseUrl">Base URL</label>
                  <input
                    id="providerNodeBaseUrl"
                    type="url"
                    value={providerNodeForm.baseUrl}
                    onChange={(event) => updateProviderNodeForm("baseUrl", event.target.value)}
                    placeholder="https://api.example.com/v1"
                  />
                </div>
                <div className="field">
                  <label htmlFor="providerNodeModels">模型列表（可选，一行一个）</label>
                  <textarea
                    id="providerNodeModels"
                    value={providerNodeForm.models}
                    onChange={(event) => updateProviderNodeForm("models", event.target.value)}
                    placeholder={"model-a\nmodel-b"}
                    rows={3}
                  />
                </div>
                <div className="model-actions">
                  <button className="btn primary" type="button" onClick={saveProviderNode} disabled={providerLoading}>
                    <span className="material-symbols-outlined">save</span>
                    {providerNodeForm.id ? "保存节点" : "新增节点"}
                  </button>
                </div>
              </div>
              <div className="provider-list">
                {array(providerStatus.providerNodes).length ? (
                  array(providerStatus.providerNodes).map((node) => (
                    <article className="provider-item active" key={node.id}>
                      <div className="provider-item-main">
                        <div>
                          <strong>{node.name || node.id}</strong>
                          <p>
                            {node.prefix || node.id}/ · {node.type}
                          </p>
                        </div>
                        <span className="pill completed">{node.apiType || "chat"}</span>
                      </div>
                      <div className="provider-meta">
                        <span>{node.baseUrl}</span>
                        <span>{array(node.models).length} 个模型</span>
                      </div>
                      <div className="model-actions">
                        <button className="btn" type="button" onClick={() => editProviderNode(node)}>
                          编辑节点
                        </button>
                        <button className="btn danger" type="button" onClick={() => deleteProviderNode(node)}>
                          删除节点
                        </button>
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="empty compact">暂无自定义 Provider。新增后可以在连接表单里选择它。</div>
                )}
              </div>
            </div>
          </section>
        </div>

        <div className="settings-tab-panel" data-settings-panel="prompts" hidden={tab !== "prompts"}>
          <section className="settings-card">
            <div className="field">
              <label>提示词配置说明</label>
              <div className="model-help">
                默认提示词来自后端共享配置；这里编辑的是角色和偏好层。运行时仍会追加不可绕过的风险、验证、证据 schema
                和工具边界。
              </div>
            </div>
            <div className="model-actions">
              <button className="btn primary" type="button" onClick={savePrompts}>
                <span className="material-symbols-outlined">save</span>保存提示词
              </button>
              <button className="btn" type="button" onClick={() => promptImportRef.current?.click()}>
                <span className="material-symbols-outlined">upload_file</span>导入配置
              </button>
              <button className="btn" type="button" onClick={exportPrompts}>
                <span className="material-symbols-outlined">download</span>导出配置
              </button>
            </div>
          </section>

          <PromptRuntimePreview prompts={prompts} />

          <div className="prompt-grid">
            <PromptEditor
              full
              label="总指挥系统提示词"
              value={prompts.commanderSystem}
              onChange={(value) => updatePromptField("commanderSystem", value)}
            />
            <PromptEditor
              label="任务拆解提示词"
              value={prompts.plannerInstructions}
              onChange={(value) => updatePromptField("plannerInstructions", value)}
            />
            <PromptEditor
              label="循环复盘提示词"
              value={prompts.reviewSystem}
              onChange={(value) => updatePromptField("reviewSystem", value)}
            />
            <PromptEditor
              label="最终汇总系统提示词"
              value={prompts.finalSystem}
              onChange={(value) => updatePromptField("finalSystem", value)}
            />
            <PromptEditor
              label="执行器系统提示词"
              value={prompts.workerSystem}
              onChange={(value) => updatePromptField("workerSystem", value)}
            />
            <PromptEditor
              label="L3 总指挥分级提示词"
              value={prompts.tierPrompts?.commander}
              onChange={(value) => updateTierPrompt("commander", value)}
            />
            <PromptEditor
              label="L2 强能力执行器提示词"
              value={prompts.tierPrompts?.strong}
              onChange={(value) => updateTierPrompt("strong", value)}
            />
            <PromptEditor
              label="L1 基础执行器提示词"
              value={prompts.tierPrompts?.coding}
              onChange={(value) => updateTierPrompt("coding", value)}
            />
            <PromptEditor
              label="L0 免费执行器提示词"
              value={prompts.tierPrompts?.free}
              onChange={(value) => updateTierPrompt("free", value)}
            />
            <PromptEditor
              label="Codex 命令行分级提示词"
              value={prompts.tierPrompts?.["codex-cli"]}
              onChange={(value) => updateTierPrompt("codex-cli", value)}
            />
            <PromptEditor
              full
              label="Codex 命令行执行器提示词"
              value={prompts.codexCliSystem}
              onChange={(value) => updatePromptField("codexCliSystem", value)}
            />
          </div>

          <div className="model-actions">
            <button className="btn" type="button" onClick={onResetPrompt}>
              <span className="material-symbols-outlined">restart_alt</span>恢复默认提示词
            </button>
            <button className="btn" type="button" data-close-settings onClick={onClose}>
              关闭
            </button>
          </div>
          <input
            ref={promptImportRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              importPrompts(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </div>

        <div className="settings-tab-panel" data-settings-panel="budget" hidden={tab !== "budget"}>
          <section className="settings-card">
            <div className="field">
              <label>预算设置说明</label>
              <div className="model-help">
                这些是 autonomous agent 的安全护栏。达到上限时会暂停或降级，避免无限 retry、无限模型调用和浏览器失控。
              </div>
            </div>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={Boolean(budgets.unlimited)}
                onChange={(event) => updateBudgetMode(event.target.checked)}
              />
              <span>
                <strong>无限预算测试模式</strong>
                <small>开启后预算系统只记录消耗，不阻断、不降级、不限制验证模型调用。</small>
              </span>
            </label>
            <div className="model-actions">
              <button className="btn primary" type="button" onClick={saveBudgets}>
                <span className="material-symbols-outlined">save</span>保存预算
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  const next = cloneDefaultBudgetSettings();
                  setBudgets(next);
                  onResetBudget();
                }}
              >
                <span className="material-symbols-outlined">restart_alt</span>恢复默认预算
              </button>
            </div>
          </section>

          <div className="model-pool-grid">
            <section className="model-pool-card">
              <div className="model-pool-head">
                <div className="model-pool-title">
                  <strong>Goal 预算</strong>
                  <span>控制整个目标的总消耗</span>
                </div>
              </div>
              <BudgetNumber
                label="最大步骤数"
                value={budgets.goal?.maxSteps}
                onChange={(value) => updateBudget("goal", "maxSteps", value)}
              />
              <BudgetNumber
                label="最大总 Token"
                value={budgets.goal?.maxTokens}
                onChange={(value) => updateBudget("goal", "maxTokens", value)}
              />
              <BudgetNumber
                label="最大费用（美元）"
                value={budgets.goal?.maxCostUsd}
                step="0.1"
                onChange={(value) => updateBudget("goal", "maxCostUsd", value)}
              />
              <BudgetNumber
                label="最大运行时长（分钟）"
                value={Math.round(Number(budgets.goal?.maxRuntimeMs || 0) / 60000)}
                onChange={(value) => updateBudgetMinutes("goal", "maxRuntimeMs", value)}
              />
              <BudgetNumber
                label="最大浏览器动作"
                value={budgets.goal?.maxBrowserActions}
                onChange={(value) => updateBudget("goal", "maxBrowserActions", value)}
              />
              <BudgetNumber
                label="最大重试次数"
                value={budgets.goal?.maxRetries}
                onChange={(value) => updateBudget("goal", "maxRetries", value)}
              />
            </section>

            <section className="model-pool-card">
              <div className="model-pool-head">
                <div className="model-pool-title">
                  <strong>Task 预算</strong>
                  <span>控制单个任务的 retry 和资源</span>
                </div>
              </div>
              <BudgetNumber
                label="单任务最大重试"
                value={budgets.task?.maxRetries}
                onChange={(value) => updateBudget("task", "maxRetries", value)}
              />
              <BudgetNumber
                label="单任务最大 Token"
                value={budgets.task?.maxTokens}
                onChange={(value) => updateBudget("task", "maxTokens", value)}
              />
              <BudgetNumber
                label="单任务运行时长（分钟）"
                value={Math.round(Number(budgets.task?.maxRuntimeMs || 0) / 60000)}
                onChange={(value) => updateBudgetMinutes("task", "maxRuntimeMs", value)}
              />
              <BudgetNumber
                label="单任务浏览器动作"
                value={budgets.task?.maxBrowserActions}
                onChange={(value) => updateBudget("task", "maxBrowserActions", value)}
              />
              <BudgetNumber
                label="单任务 shell 动作"
                value={budgets.task?.maxShellActions}
                onChange={(value) => updateBudget("task", "maxShellActions", value)}
              />
              <BudgetNumber
                label="验证重试次数"
                value={budgets.task?.maxVerificationRetries}
                onChange={(value) => updateBudget("task", "maxVerificationRetries", value)}
              />
            </section>

            <section className="model-pool-card">
              <div className="model-pool-head">
                <div className="model-pool-title">
                  <strong>Browser 预算</strong>
                  <span>防止重复点击、刷新、截图</span>
                </div>
              </div>
              <BudgetNumber
                label="最大动作数"
                value={budgets.browser?.maxActions}
                onChange={(value) => updateBudget("browser", "maxActions", value)}
              />
              <BudgetNumber
                label="最大刷新次数"
                value={budgets.browser?.maxReloads}
                onChange={(value) => updateBudget("browser", "maxReloads", value)}
              />
              <BudgetNumber
                label="最大导航深度"
                value={budgets.browser?.maxNavigations}
                onChange={(value) => updateBudget("browser", "maxNavigations", value)}
              />
              <BudgetNumber
                label="最大标签页数"
                value={budgets.browser?.maxTabs}
                onChange={(value) => updateBudget("browser", "maxTabs", value)}
              />
              <BudgetNumber
                label="最大提交次数"
                value={budgets.browser?.maxSubmitAttempts}
                onChange={(value) => updateBudget("browser", "maxSubmitAttempts", value)}
              />
              <BudgetNumber
                label="最大截图次数"
                value={budgets.browser?.maxScreenshots}
                onChange={(value) => updateBudget("browser", "maxScreenshots", value)}
              />
            </section>
          </div>

          <div className="model-actions">
            <button className="btn primary" type="button" onClick={saveBudgets}>
              <span className="material-symbols-outlined">save</span>保存预算
            </button>
            <button className="btn" type="button" data-close-settings onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

function BudgetNumber({ label, value, onChange, step = "1" }) {
  return (
    <div className="field compact-field">
      <label>{label}</label>
      <input
        type="number"
        min="0"
        step={step}
        value={Number(value || 0)}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function PromptRuntimePreview({ prompts }) {
  const sections = promptPreviewSections(prompts);
  return (
    <section className="settings-card prompt-runtime-card">
      <div className="provider-list-head">
        <div>
          <strong>有效 Prompt 预览</strong>
          <p>可编辑提示词会和运行时规则、任务上下文、策略、记忆、风险、预算和验证状态一起发送给模型。</p>
        </div>
        <span className="tag">{sections.length}</span>
      </div>
      <div className="model-help warning">
        安全门、风险门、证据 schema、验证规则和工具边界属于系统强制规则；这里展示用于调试，但不建议通过可编辑 prompt
        绕过。
      </div>
      <div className="prompt-preview-grid">
        {sections.map((section) => (
          <details className="prompt-preview-card" key={section.id}>
            <summary>
              <span>
                <strong>{section.title}</strong>
                <small>{section.summary}</small>
              </span>
              <span className="material-symbols-outlined">expand_more</span>
            </summary>
            <pre>{section.content}</pre>
          </details>
        ))}
      </div>
    </section>
  );
}

function PromptEditor({ label, value, onChange, full = false }) {
  return (
    <section className={`prompt-card ${full ? "full" : ""}`}>
      <label>{label}</label>
      <textarea value={value || ""} onChange={(event) => onChange(event.target.value)} spellCheck="false" />
    </section>
  );
}

function countFor(tasks, filter) {
  if (filter === "all") return tasks.length;
  if (filter === "queued") return tasks.filter((task) => isWaiting(task.status)).length;
  if (filter === "completed") return tasks.filter((task) => isDone(task.status)).length;
  if (filter === "failed") return tasks.filter((task) => isQueueFailedStatus(task.status)).length;
  if (filter === "blocked")
    return tasks.filter(
      (task) => task.status === "blocked" || String(task.dependencyStatus || "").toLowerCase() === "blocked"
    ).length;
  return tasks.filter((task) => task.status === filter).length;
}

function queueStatusKey(task = {}) {
  const status = String(task.status || "").toLowerCase();
  const dependencyStatus = String(task.dependencyStatus || "").toLowerCase();
  if (canApproveTask(task)) {
    return "waiting_human";
  }
  if (isDone(status)) return "completed";
  if (status === "running") return "running";
  if (status === "blocked" || dependencyStatus === "blocked") return "blocked";
  if (["canceled", "cancelled"].includes(status)) return "canceled";
  if (["failed", "error"].includes(status)) return "failed";
  if (dependencyStatus === "ready") return "ready";
  return "pending";
}

function queueTaskCode(task = {}, index = 0) {
  const raw = String(task.code || task.displayId || task.taskCode || "").trim();
  if (/^t\d+$/i.test(raw)) return raw.toUpperCase();
  const order = Number(task.order);
  if (Number.isFinite(order) && order > 0) return `T${order}`;
  return `T${index + 1}`;
}

function TaskWorkspacePanel({
  goal,
  graph,
  tasks,
  stats,
  visibleTasks,
  filter,
  activeTab,
  graphViewMode,
  selectedGraphTaskId,
  selectedQueueTaskId,
  onTabChange,
  onGraphViewModeChange,
  onFilterChange,
  onSelectGraphTask,
  onSelectQueueTask,
  onRefreshGraph,
  onTaskAction
}) {
  const tab = activeTab === "graph" ? "graph" : "queue";
  return (
    <section className="task-workspace-panel" id="tasks">
      <div className="task-workspace-tabs" role="tablist" aria-label="任务视图切换">
        {TASK_PANEL_TABS.map(([key, label, icon, desc]) => (
          <button
            className={tab === key ? "active" : ""}
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => onTabChange(key)}
          >
            <span className="material-symbols-outlined">{icon}</span>
            <strong>{label}</strong>
            <small>{desc}</small>
          </button>
        ))}
      </div>
      <div className="task-workspace-tab-panel" role="tabpanel" hidden={tab !== "queue"}>
        <TaskQueuePanel
          goal={goal}
          tasks={tasks}
          visibleTasks={visibleTasks}
          filter={filter}
          selectedTaskId={selectedQueueTaskId}
          onFilterChange={onFilterChange}
          onSelectTask={onSelectQueueTask}
          onOpenGraph={() => onTabChange("graph")}
          onTaskAction={onTaskAction}
        />
      </div>
      <div className="task-workspace-tab-panel" role="tabpanel" hidden={tab !== "graph"}>
        <TaskGraphPanel
          goal={goal}
          graph={graph}
          tasks={tasks}
          stats={stats}
          selectedTaskId={selectedGraphTaskId}
          viewMode={graphViewMode}
          onViewModeChange={onGraphViewModeChange}
          onSelectTask={onSelectGraphTask}
          onRefresh={onRefreshGraph}
        />
      </div>
    </section>
  );
}

function TaskQueuePanel({
  goal,
  tasks,
  visibleTasks,
  filter,
  selectedTaskId,
  onFilterChange,
  onSelectTask,
  onTaskAction,
  onOpenGraph
}) {
  const counts = statusCounts(tasks);
  const graphVisual = buildGraphVisual(goal?.graph || {}, tasks);
  const taskOrder = new Map(array(tasks).map((task, index) => [String(task.id || ""), index]));
  const codeForQueueTask = (task) => {
    const taskId = String(task?.id || "");
    return graphVisual.codeById.get(taskId) || queueTaskCode(task, taskOrder.get(taskId) ?? 0);
  };
  const waitingHuman = array(tasks).filter((task) => queueStatusKey(task) === "waiting_human").length;
  const selectedTask =
    array(visibleTasks).find((task) => task.id === selectedTaskId) ||
    array(visibleTasks).find((task) => ["blocked", "waiting_human", "running"].includes(queueStatusKey(task))) ||
    array(visibleTasks)[0] ||
    null;
  const selectedIndex = Math.max(
    0,
    array(tasks).findIndex((task) => task.id === selectedTask?.id)
  );
  const groupedVisibleTasks = groupTasksForDisplay(visibleTasks);
  return (
    <section className="task-graph-panel task-queue-panel" id="queue">
      <header className="task-graph-hero">
        <div className="task-graph-title">
          <span className="material-symbols-outlined">list_alt</span>
          <div>
            <h2>任务队列</h2>
            <p>查看任务状态、人工处理项和执行证据摘要</p>
          </div>
        </div>
        <button className="task-graph-refresh" type="button" onClick={onOpenGraph}>
          <span className="material-symbols-outlined">account_tree</span>
          查看任务图
        </button>
      </header>

      <div className="task-graph-stats">
        <article className="task-graph-goal-card">
          <span className="task-graph-goal-icon material-symbols-outlined">target</span>
          <div>
            <label>当前目标</label>
            <strong>{safeDisplayText(goal?.title || goal?.goal || "暂无目标", 48)}</strong>
            <small>{goal?.id || "尚未创建目标"}</small>
          </div>
        </article>
        <GraphStat label="任务总数" value={counts.total} />
        <GraphStat label="已完成" value={counts.completed} tone="done" />
        <GraphStat label="运行中" value={counts.running} tone="run" />
        <GraphStat label="已阻塞" value={counts.blocked} tone="blocked" />
        <GraphStat label="等待人工" value={waitingHuman} tone="human" />
        <GraphStat label="失败" value={counts.failed} tone="fail" />
      </div>

      <div className="task-queue-main">
        <section className="task-queue-list-card">
          <div className="task-graph-card-head task-queue-card-head">
            <h3>任务列表</h3>
            <div className="task-queue-filter-row">
              {FILTERS.map(([key, label]) => (
                <button
                  key={key}
                  className={`tab ${filter === key ? "active" : ""}`}
                  type="button"
                  onClick={() => onFilterChange(key)}
                >
                  {label}
                  <span>{countFor(tasks, key)}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="task-queue-list">
            {array(visibleTasks).length ? (
              groupedVisibleTasks.map((group) => (
                <div className={`task-queue-group ${taskExecutionGroupClass(group.key)}`} key={group.key}>
                  <div className={`task-queue-group-head ${taskExecutionGroupClass(group.key)}`}>
                    <span className="material-symbols-outlined">{taskExecutionGroupIcon(group.key)}</span>
                    <strong>{taskExecutionGroupLabel(group.key)}</strong>
                    <em>{group.tasks.length}</em>
                  </div>
                  {group.tasks.map((task) => (
                    <QueueTaskRow
                      key={task.id}
                      task={task}
                      code={codeForQueueTask(task)}
                      selected={selectedTask?.id === task.id}
                      onSelect={() => onSelectTask(task.id)}
                    />
                  ))}
                </div>
              ))
            ) : (
              <div className="task-graph-empty compact">
                {goal ? "当前筛选下暂无任务" : "创建目标后，任务会显示在这里"}
              </div>
            )}
          </div>
        </section>
        <QueueTaskDetails
          task={selectedTask}
          code={selectedTask ? codeForQueueTask(selectedTask) : ""}
          index={selectedIndex}
          onAction={(action) => selectedTask && onTaskAction(selectedTask, action)}
        />
      </div>
    </section>
  );
}

function groupTasksForDisplay(tasks = []) {
  const order = ["agent", "tool", "human"];
  const groups = new Map(order.map((key) => [key, []]));
  for (const task of array(tasks)) {
    const key = taskExecutionGroup(task);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  return [...groups.entries()].filter(([, items]) => items.length).map(([key, items]) => ({ key, tasks: items }));
}

function QueueTaskRow({ task, code, selected, onSelect }) {
  const statusKey = queueStatusKey(task);
  const tone = graphStatusTone(statusKey);
  const progress = taskProgressValue(task);
  const issue = [task.blockedReason, task.approvalReason, ...array(task.dependencyReasons)]
    .filter(Boolean)
    .map(dependencyReasonLabel)[0];
  return (
    <button className={`task-queue-row ${tone} ${selected ? "selected" : ""}`} type="button" onClick={onSelect}>
      <span className="task-queue-row-icon material-symbols-outlined">{graphStatusIcon(statusKey)}</span>
      <span className="task-queue-row-code">{code}</span>
      <strong>{safeDisplayText(displayTask(task), 48)}</strong>
      <span className={`task-graph-badge ${tone}`}>{graphStatusLabel(statusKey)}</span>
      <span className="task-queue-row-meta">
        {safeDisplayText(taskWorkerLabel(task), 24)}
        <i>·</i>
        {taskExecutionGroupLabel(taskExecutionGroup(task))}
        <i>·</i>
        {riskLabel(task.riskLevel)}
        <i>·</i>
        {verificationLabel(task.verificationStatus, task.verificationConfidence)}
      </span>
      <span className="task-queue-progress">
        <span style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
      </span>
      <small>{safeDisplayText(issue || task.routingReason || task.description || "等待调度信息", 82)}</small>
    </button>
  );
}

function taskProgressValue(task = {}) {
  const status = task.status || "waiting";
  if (Number.isFinite(Number(task.progress))) return Number(task.progress);
  if (isDone(status) || ["failed", "blocked", "canceled", "cancelled"].includes(String(status).toLowerCase()))
    return 100;
  if (status === "running") return 60;
  if (task.dependencyStatus === "ready") return 20;
  return 0;
}

function QueueTaskDetails({ task, code, index, onAction }) {
  if (!task) {
    return (
      <aside className="task-graph-details-card task-queue-details-card">
        <h3>任务详情</h3>
        <div className="task-graph-empty compact">选择一个任务后，这里会显示状态、证据、阻塞和人工操作。</div>
      </aside>
    );
  }
  const statusKey = queueStatusKey(task);
  const tone = graphStatusTone(statusKey);
  const deps = array(task.dependsOn).map(String);
  const consumes = array(task.consumes).map(artifactId);
  const produces = array(task.produces).map(artifactId);
  const issues = [task.blockedReason, task.approvalReason, ...array(task.dependencyReasons)]
    .filter(Boolean)
    .slice(0, 5)
    .map(dependencyReasonLabel);
  const outputSummary = [
    task.result ? `结果：${safeDisplayText(task.result, 120)}` : "",
    task.content ? `内容：${safeDisplayText(task.content, 120)}` : "",
    task.description ? `说明：${safeDisplayText(task.description, 120)}` : "",
    task.routingReason ? `路由：${safeDisplayText(task.routingReason, 120)}` : ""
  ].filter(Boolean);
  const authenticityWarnings = array(task.authenticityWarnings).map(authenticityWarningLabel);
  const corrective = array(task.recommendedActions).map(
    (item) => `${correctiveActionLabel(item.type)} · ${correctivePriorityLabel(item.priority)}`
  );
  const failureReasons = taskFailureReasons(task);
  const showFailureReasons = ["blocked", "failed"].includes(statusKey);
  return (
    <aside className="task-graph-details-card task-queue-details-card">
      <h3>任务详情</h3>
      <div className="task-graph-detail-title">
        <div>
          <strong>{code || `T${index + 1}`}</strong>
          <span className={`task-graph-badge ${tone}`}>{graphStatusLabel(statusKey)}</span>
        </div>
        <h4>{safeDisplayText(displayTask(task), 58)}</h4>
      </div>
      <div className="task-graph-detail-meta">
        <span>
          <span className="material-symbols-outlined">smart_toy</span>
          执行器：{safeDisplayText(taskWorkerLabel(task), 32)}
        </span>
        <span>
          <span className="material-symbols-outlined">shield</span>
          风险：{riskLabel(task.riskLevel)}
        </span>
        <span>
          <span className="material-symbols-outlined">verified</span>
          验证：{verificationLabel(task.verificationStatus, task.verificationConfidence)}
        </span>
        <span>
          <span className="material-symbols-outlined">fact_check</span>
          真实性：{authenticityLabel(task.authenticityScore)}
        </span>
      </div>
      <GraphDetailSection title="依赖于" items={deps.map((dep) => safeDisplayText(dep, 48))} empty="无前置任务" />
      <GraphDetailSection title="产出" items={produces} empty="暂无产物" />
      <GraphDetailSection title="消耗" items={consumes} empty="暂无输入产物" />
      <GraphDetailSection
        title="阻塞 / 等待原因"
        items={issues}
        empty={statusKey === "blocked" || statusKey === "waiting_human" ? "未记录原因" : "无阻塞"}
        warning={statusKey === "blocked" || statusKey === "waiting_human"}
      />
      {showFailureReasons ? (
        <GraphDetailSection
          title="真实失败原因"
          items={failureReasons}
          empty="执行器没有返回明确失败原因"
          warning
          limit={260}
        />
      ) : null}
      <GraphDetailSection
        title="验证与真实性"
        items={[
          task.verificationStatus ? verificationLabel(task.verificationStatus, task.verificationConfidence) : "",
          ...array(task.verificationReasons)
            .slice(0, 2)
            .map((item) => verificationReasonLabel(item)),
          ...authenticityWarnings.slice(0, 3)
        ].filter(Boolean)}
        empty="未开始验证"
      />
      <GraphDetailSection title="输出摘要" items={outputSummary} empty="暂无输出" />
      <GraphDetailSection title="建议动作" items={corrective.slice(0, 4)} empty="暂无纠正建议" />
      <div className="task-queue-detail-progress">
        <span>进度</span>
        <div className="bar">
          <span style={{ width: `${Math.max(0, Math.min(100, taskProgressValue(task)))}%` }} />
        </div>
        <strong>{Math.round(taskProgressValue(task))}%</strong>
      </div>
      <QueueTaskActions task={task} onAction={onAction} />
    </aside>
  );
}

function QueueTaskActions({ task, onAction }) {
  const status = task.status || "waiting";
  const canApprove = canApproveTask(task);
  const canCancel =
    !isRouteInternalTask(task) &&
    ["waiting", "retry_ready", "blocked", "awaiting_confirmation", "waiting_human"].includes(status);
  const canDelete = !isRouteInternalTask(task) && status !== "running";
  if (!canApprove && !canCancel && !canDelete) return null;
  return (
    <div className="task-queue-actions">
      {canApprove ? (
        <button className="small-btn primary" type="button" onClick={() => onAction("confirm_task")}>
          批准继续
        </button>
      ) : null}
      {canApprove ? (
        <button className="small-btn danger" type="button" onClick={() => onAction("reject_task")}>
          拒绝
        </button>
      ) : null}
      {canCancel && !canApprove ? (
        <button className="small-btn" type="button" onClick={() => onAction("cancel_task")}>
          取消
        </button>
      ) : null}
      {canDelete ? (
        <button className="small-btn danger" type="button" onClick={() => onAction("delete_task")}>
          删除
        </button>
      ) : null}
    </div>
  );
}

function PoolEditor({ label, value, onChange }) {
  return (
    <div className="field">
      <label>{label}</label>
      <textarea
        value={array(value).join("\n")}
        onChange={(event) => onChange(readLines(event.target.value, value))}
        spellCheck="false"
      />
    </div>
  );
}

function TaskCard({ task, index, onAction }) {
  const status = task.status || "waiting";
  const progress = Number.isFinite(Number(task.progress))
    ? Number(task.progress)
    : isDone(status) || isFailed(status)
      ? 100
      : status === "running"
        ? 60
        : 0;
  const canApprove = canApproveTask(task);
  const canCancel =
    !isRouteInternalTask(task) &&
    ["waiting", "retry_ready", "blocked", "awaiting_confirmation", "waiting_human"].includes(status);
  const canDelete = !isRouteInternalTask(task) && status !== "running";
  const recoveryInfo = taskRecoveryInfo(task);
  const failureReasons = taskFailureReasons(task);
  const authenticityState = authenticityLevel(task.authenticityScore);
  const authenticityWarnings = array(task.authenticityWarnings);
  const authenticityReasons = array(task.authenticityReasons);
  const authenticitySignals = array(task.authenticitySignals);
  const recommendedActions = array(task.recommendedActions);
  const rankedActions = array(task.rankedActions);
  const recommendedAction = task.recommendedAction || rankedActions[0] || null;
  const actionLearningHistory = array(task.actionLearningHistory);
  const actionLearningSummary = task.actionLearningSummary || {};
  const latestLearning =
    actionLearningSummary.latestAction || actionLearningHistory[actionLearningHistory.length - 1] || null;
  const learningStats =
    latestLearning?.stats || actionLearningSummary.actionStats?.[latestLearning?.actionType] || null;
  const attributionHistory = array(task.decisionAttributionHistory);
  const attributionSummary = task.decisionAttributionSummary || {};
  const latestAttribution =
    attributionSummary.latestAttribution || attributionHistory[attributionHistory.length - 1] || null;
  const attributionStats =
    latestAttribution?.stats || attributionSummary.actionStats?.[latestAttribution?.actualAction] || null;
  return (
    <article className={`task-card ${status}`}>
      <div className="task-head">
        <div className="task-title">
          <span className="task-index">{index + 1}</span>
          {displayTask(task)}
          {task.dependencyStatus === "ready" ? <span className="tag done">可执行</span> : null}
        </div>
        <span className={`tag ${statusClass(status)}`}>{displayStatus(status, "任务状态")}</span>
      </div>
      <div className="task-tags">
        <span className="tag">{taskWorkerLabel(task)}</span>
        <span className={`tag risk-${String(task.riskLevel || "low").toLowerCase()}`}>{riskLabel(task.riskLevel)}</span>
        <span className={`tag verify-${String(task.verificationStatus || "unverified").toLowerCase()}`}>
          {verificationLabel(task.verificationStatus, task.verificationConfidence)}
        </span>
        <span className={`tag authenticity-${authenticityState.key}`}>
          真实性 {authenticityLabel(task.authenticityScore)}
        </span>
        <span className={`tag budget-${String(task.budgetStatus || "ok").toLowerCase()}`}>
          {budgetLabel(task.budgetStatus, task.degradationLevel)}
        </span>
        {task.strategicPhase ? <span className="tag">{task.strategicPhase}</span> : null}
      </div>
      <div className="task-meta">
        {array(task.dependsOn).length ? `依赖：${task.dependsOn.join(", ")} · ` : ""}
        {array(task.consumes).length ? `输入：${task.consumes.map(artifactId).join(", ")} · ` : ""}
        {array(task.produces).length
          ? `输出：${task.produces.map(artifactId).join(", ")}`
          : task.routingReason || task.description}
      </div>
      {array(task.dependencyReasons).length || task.blockedReason || task.approvalReason ? (
        <div className="helper">
          {[task.blockedReason, task.approvalReason, ...array(task.dependencyReasons)]
            .filter(Boolean)
            .slice(0, 3)
            .map(dependencyReasonLabel)
            .join("；")}
        </div>
      ) : null}
      {failureReasons.length && ["blocked", "failed"].includes(String(status || "").toLowerCase()) ? (
        <div className="failure-panel">
          <div className="authenticity-head">
            <strong>真实失败原因</strong>
            <span>{displayStatus(status, "已停止")}</span>
          </div>
          <ul>
            {failureReasons.slice(0, 4).map((reason, reasonIndex) => (
              <li key={`failure-${reasonIndex}`}>{safeDisplayText(reason, 260)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {Number(task.authenticityScore || 0) ||
      authenticityWarnings.length ||
      authenticityReasons.length ||
      authenticitySignals.length ? (
        <div className={`authenticity-panel authenticity-${authenticityState.key}`}>
          <div className="authenticity-head">
            <strong>真实性：{authenticityLabel(task.authenticityScore)}</strong>
            <span>最终决策来源：{decisionSourceLabel(task.decisionSource)}</span>
          </div>
          <div className="monitor-stack">
            {authenticityWarnings.length ? (
              authenticityWarnings.slice(0, 5).map((warning, warningIndex) => (
                <span className="graph-chip" key={`warning-${warningIndex}`}>
                  {authenticityWarningLabel(warning)}
                </span>
              ))
            ) : (
              <span className="graph-chip">暂无真实性警告</span>
            )}
          </div>
          {authenticityReasons.length ? (
            <p className="helper">
              原因：
              {authenticityReasons
                .slice(0, 3)
                .map((item) => safeDisplayText(item, 96))
                .join("；")}
            </p>
          ) : null}
          {authenticitySignals.length ? (
            <p className="helper">
              信号：
              {authenticitySignals
                .slice(0, 3)
                .map((signal) =>
                  safeDisplayText(
                    `${signal.kind || "signal"} ${Object.entries(signal)
                      .filter(([key]) => key !== "kind")
                      .map(([key, value]) => `${key}:${value}`)
                      .join(" ")}`,
                    72
                  )
                )
                .join("；")}
            </p>
          ) : null}
          <p className="helper">建议：{authenticitySuggestion(task.authenticityScore, authenticityWarnings)}</p>
          {task.decisionSource === "authenticity" || /authenticity/i.test(String(task.blockedReason || "")) ? (
            <p className="helper">
              触发原因：authenticityScore {Number(task.authenticityScore || 0).toFixed(2)}，状态建议{" "}
              {displayStatus(task.verificationSuggestedNextState, "等待复核")}
            </p>
          ) : null}
        </div>
      ) : null}
      {recommendedActions.length ? (
        <div className="corrective-panel">
          <div className="authenticity-head">
            <strong>建议动作</strong>
            <span>
              {correctivePriorityLabel(task.correctiveSummary?.highestPriority || recommendedActions[0]?.priority)}
            </span>
          </div>
          <div className="monitor-stack">
            {recommendedActions.slice(0, 4).map((item, actionIndex) => (
              <span
                className={`graph-chip corrective-${String(item.priority || "medium").toLowerCase()}`}
                key={`${item.type}-${item.trigger}-${actionIndex}`}
              >
                {correctiveActionLabel(item.type)} · {correctivePriorityLabel(item.priority)}
              </span>
            ))}
          </div>
          <p className="helper">
            原因：
            {recommendedActions
              .slice(0, 3)
              .map((item) => safeDisplayText(item.reason, 96))
              .join("；")}
          </p>
        </div>
      ) : null}
      {rankedActions.length ? (
        <div className="action-decision-panel">
          <div className="authenticity-head">
            <strong>建议排序：{correctiveActionLabel(recommendedAction?.type)}</strong>
            <span>分数 {decisionPercentLabel(recommendedAction?.score || task.actionDecisionSummary?.topScore)}</span>
          </div>
          <div className="monitor-stack">
            {rankedActions.slice(0, 4).map((item, actionIndex) => (
              <span
                className={`graph-chip risk-${String(item.riskLevel || "low").toLowerCase()}`}
                key={`${item.type}-${item.rank}-${actionIndex}`}
              >
                {item.rank || actionIndex + 1}. {correctiveActionLabel(item.type)} · 成功{" "}
                {decisionPercentLabel(item.estimatedSuccess)} · {estimatedCostLabel(item.estimatedCost)} ·{" "}
                {riskLabel(item.riskLevel)}
              </span>
            ))}
          </div>
          <p className="helper">
            推荐原因：
            {safeDisplayText(
              recommendedAction?.decisionReason ||
                recommendedAction?.reason ||
                "系统根据成功率、成本、风险和历史信号完成排序。",
              180
            )}
          </p>
          {recommendedAction?.requiresHuman ? (
            <p className="helper">需要人工：该建议只请求复核，不会自动执行。</p>
          ) : null}
        </div>
      ) : null}
      {latestLearning ? (
        <div className="action-learning-panel">
          <div className="authenticity-head">
            <strong>行为经验：{correctiveActionLabel(latestLearning.actionType)}</strong>
            <span>{latestLearning.success ? "上次结果成功" : "上次结果失败"}</span>
          </div>
          <div className="monitor-stack">
            <span className="graph-chip">运行 {Number(learningStats?.runs || 1)} 次</span>
            <span className="graph-chip">
              成功率 {decisionPercentLabel(learningStats?.successRate ?? (latestLearning.success ? 1 : 0))}
            </span>
            <span className="graph-chip">平均成本 {money(learningStats?.avgCost ?? latestLearning.cost)}</span>
            <span className="graph-chip">
              平均耗时 {Math.round(Number(learningStats?.avgDuration ?? latestLearning.durationMs ?? 0) / 1000)} 秒
            </span>
          </div>
          <p className="helper">学习记录只用于下次排序参考，不会自动执行建议动作。</p>
        </div>
      ) : null}
      {latestAttribution ? (
        <div className="action-decision-panel">
          <div className="authenticity-head">
            <strong>决策来源：{decisionSourceLabel(latestAttribution.decisionSource)}</strong>
            <span>归因 {decisionPercentLabel(latestAttribution.attributionScore)}</span>
          </div>
          <div className="monitor-stack">
            <span className="graph-chip">系统建议：{correctiveActionLabel(latestAttribution.recommendedAction)}</span>
            <span className="graph-chip">实际动作：{correctiveActionLabel(latestAttribution.actualAction)}</span>
            <span className={`graph-chip ${latestAttribution.wasOverridden ? "risk-high" : "tag done"}`}>
              {latestAttribution.wasOverridden ? "已覆盖" : "已采纳"}
            </span>
            <span className="graph-chip">系统成功率 {decisionPercentLabel(attributionStats?.systemSuccessRate)}</span>
            <span className="graph-chip">覆盖成功率 {decisionPercentLabel(attributionStats?.overrideSuccessRate)}</span>
          </div>
          <p className="helper">归因只用于区分系统建议、用户覆盖和人工复核带来的结果，不会自动执行后续动作。</p>
        </div>
      ) : null}
      {recoveryInfo ? (
        <div className="helper recovery-note">
          运行恢复：{recoveryReasonLabel(recoveryInfo.reason)}
          {recoveryInfo.recoveredAt ? ` · ${formatDateTime(recoveryInfo.recoveredAt)}` : ""}
          {recoveryInfo.workerLost ? " · 执行器已丢失" : ""}
          {recoveryInfo.staleBrowserSessions.length ? " · 浏览器会话已失效" : ""}
        </div>
      ) : null}
      <div className="progress">
        <div className="bar">
          <span style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
        </div>
        <span>{progress}%</span>
      </div>
      <div className="card-actions">
        {canApprove ? (
          <button className="small-btn primary" type="button" onClick={() => onAction("confirm_task")}>
            批准继续
          </button>
        ) : null}
        {canApprove ? (
          <button className="small-btn danger" type="button" onClick={() => onAction("reject_task")}>
            拒绝
          </button>
        ) : null}
        {canCancel && !canApprove ? (
          <button className="small-btn" type="button" onClick={() => onAction("cancel_task")}>
            取消
          </button>
        ) : null}
        {canDelete ? (
          <button className="small-btn danger" type="button" onClick={() => onAction("delete_task")}>
            删除
          </button>
        ) : null}
      </div>
    </article>
  );
}

function graphTaskCode(node, index) {
  const raw = String(node.code || node.displayId || "").trim();
  if (/^t\d+$/i.test(raw)) return raw.toUpperCase();
  return `T${index + 1}`;
}

function graphStatusKey(task = {}, node = {}, readyIds = new Set()) {
  const status = String(task.status || node.status || "").toLowerCase();
  const dependencyStatus = String(node.readiness?.status || task.dependencyStatus || "").toLowerCase();
  if (canApproveTask(task) || status === "waiting_human") return "waiting_human";
  if (isDone(status)) return "completed";
  if (status === "running") return "running";
  if (status === "blocked") return "blocked";
  if (["canceled", "cancelled"].includes(status)) return "canceled";
  if (isFailed(status)) return "failed";
  if (dependencyStatus === "blocked") return "blocked";
  if (readyIds.has(String(node.id || task.id || "")) || node.readiness?.ready) return "ready";
  return "pending";
}

function graphStatusIcon(status) {
  if (status === "completed") return "check_circle";
  if (status === "running") return "progress_activity";
  if (status === "blocked") return "pause_circle";
  if (status === "failed") return "cancel";
  if (status === "canceled") return "block";
  if (status === "waiting_human") return "person_alert";
  if (status === "ready") return "play_circle";
  return "schedule";
}

function graphStatusLabel(status) {
  if (status === "ready") return "可执行";
  if (status === "pending") return "待处理";
  if (status === "waiting_human") return "等待人工";
  if (status === "canceled") return "已取消";
  return displayStatus(status, valueLabel(status) || "待处理");
}

function graphStatusTone(status) {
  if (status === "completed") return "done";
  if (status === "running" || status === "ready") return "run";
  if (status === "blocked") return "blocked";
  if (status === "failed") return "fail";
  if (status === "canceled") return "fail";
  if (status === "waiting_human") return "human";
  return "pending";
}

function graphNodeOrder(node = {}, fallback = 0) {
  const task = node.task || {};
  const value = Number(task.order ?? node.order ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

function graphNodeRealDependencies(node = {}) {
  return array(node.dependencies || node.dependsOn || node.task?.dependsOn || node.task?.dependencies).map(String);
}

function taskCreationSource(task = {}) {
  const historySource =
    array(task.history)
      .map((entry) => entry?.context?.source)
      .find(Boolean) || "";
  return String(task.source || task.createdBy || task.created_by || task.creationSource || historySource || "");
}

function taskCreatedByTaskId(task = {}) {
  const historyTaskId =
    array(task.history)
      .map((entry) => entry?.context?.createdByTaskId || entry?.context?.created_by_task_id)
      .find(Boolean) || "";
  return String(task.createdByTaskId || task.created_by_task_id || task.invokedByTaskId || historyTaskId || "");
}

function taskCreatedByTaskTitle(task = {}) {
  const historyTaskTitle =
    array(task.history)
      .map((entry) => entry?.context?.createdByTaskTitle || entry?.context?.created_by_task_title)
      .find(Boolean) || "";
  return String(
    task.createdByTaskTitle || task.created_by_task_title || task.invokedByTaskTitle || historyTaskTitle || ""
  );
}

function creationSourceLabel(value) {
  const key = String(value || "")
    .trim()
    .toLowerCase();
  const map = {
    commander: "总指挥规划",
    planner: "规划器",
    review: "复盘追加",
    studio: "手动创建",
    "runtime-recovery": "运行恢复"
  };
  return map[key] || valueLabel(value) || value || "未记录";
}

function buildGraphVisual(graph = {}, tasks = []) {
  const readyIds = new Set(readyIdList(graph));
  const taskList = array(tasks);
  const taskMap = new Map(taskList.map((task) => [String(task.id), task]));
  const sourceNodes = array(graph.nodes);
  const byId = new Map();
  for (const node of sourceNodes) {
    const id = String(node.id || "").trim();
    if (!id) continue;
    byId.set(id, { ...node, task: taskMap.get(id) || {} });
  }
  for (const [id, task] of taskMap.entries()) {
    if (!byId.has(id)) byId.set(id, { id, title: task.title, depth: task.graphDepth || 0, task });
  }
  const nodes = [...byId.values()].map((node, index) => {
    const task = node.task || taskMap.get(String(node.id)) || {};
    const deps = graphNodeRealDependencies({ ...node, task });
    return {
      ...node,
      task,
      id: String(node.id || task.id || `task-${index + 1}`),
      title: node.title || task.title || task.id || node.id,
      depth: Number.isFinite(Number(node.depth ?? task.graphDepth))
        ? Math.max(0, Number(node.depth ?? task.graphDepth))
        : 0,
      dependencies: deps,
      visualDependencies: [],
      statusKey: graphStatusKey(task, node, readyIds),
      executionGroup: taskExecutionGroup(task, node),
      order: graphNodeOrder({ ...node, task }, index),
      createdByTaskId: taskCreatedByTaskId(task) || taskCreatedByTaskId(node),
      createdByTaskTitle: taskCreatedByTaskTitle(task) || taskCreatedByTaskTitle(node),
      creationSource: taskCreationSource(task) || taskCreationSource(node),
      produces: array(node.produces || task.produces),
      consumes: array(node.consumes || task.consumes)
    };
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const depthById = new Map(nodes.map((node) => [node.id, node.depth]));
  for (const node of nodes) {
    const sourceId = String(node.createdByTaskId || "");
    if (sourceId && sourceId !== node.id && nodeById.has(sourceId) && !node.visualDependencies.includes(sourceId)) {
      node.visualDependencies.push(sourceId);
    }
  }
  let changed = true;
  for (let guard = 0; changed && guard < nodes.length + 2; guard += 1) {
    changed = false;
    for (const node of nodes) {
      const depDepth = [...array(node.dependencies), ...array(node.visualDependencies)]
        .map((dep) => depthById.get(String(dep)))
        .filter((value) => Number.isFinite(Number(value)));
      if (!depDepth.length) continue;
      const nextDepth = Math.max(...depDepth) + 1;
      if (nextDepth > node.depth) {
        node.depth = nextDepth;
        depthById.set(node.id, nextDepth);
        changed = true;
      }
    }
  }
  const groups = new Map();
  for (const node of nodes) {
    if (!groups.has(node.depth)) groups.set(node.depth, []);
    groups.get(node.depth).push(node);
  }
  const ordered = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([, group]) =>
      group.sort((a, b) => {
        const aOrder = Number(a.task.order ?? a.order ?? 0);
        const bOrder = Number(b.task.order ?? b.order ?? 0);
        return aOrder - bOrder || String(a.id).localeCompare(String(b.id));
      })
    );
  const codeById = new Map(ordered.map((node, index) => [node.id, graphTaskCode(node, index)]));
  const edges = [];
  for (const edge of array(graph.edges)) {
    const from = String(edge.from || edge.source || "");
    const to = String(edge.to || edge.target || "");
    if (from && to && byId.has(from) && byId.has(to))
      edges.push({ ...edge, from, to, type: edge.type || "depends_on" });
  }
  const existingEdgeKeys = new Set(edges.map((edge) => `${edge.from}->${edge.to}:${edge.type || "depends_on"}`));
  for (const node of ordered) {
    for (const dep of node.dependencies) {
      const from = String(dep);
      if (!byId.has(from)) continue;
      const key = `${from}->${node.id}:depends_on`;
      if (!existingEdgeKeys.has(key)) {
        edges.push({ from, to: node.id, type: "depends_on" });
        existingEdgeKeys.add(key);
      }
    }
  }
  for (const node of ordered) {
    const from = String(node.createdByTaskId || "");
    if (!from || from === node.id || !byId.has(from)) continue;
    const key = `${from}->${node.id}:invokes`;
    if (existingEdgeKeys.has(key)) continue;
    edges.push({ from, to: node.id, type: "invokes" });
    existingEdgeKeys.add(key);
  }
  return { nodes: ordered, edges, codeById };
}

function layoutGraphNodes(nodes = []) {
  const nodeWidth = 190;
  const nodeHeight = 138;
  const colGap = 34;
  const rowGap = 22;
  const laneGap = 34;
  const marginX = 106;
  const marginY = 28;
  const laneOrder = ["agent", "tool", "human"].filter((key) => nodes.some((node) => node.executionGroup === key));
  const positions = new Map();
  const maxDepth = Math.max(0, ...nodes.map((node) => node.depth));
  const lanes = [];
  let currentY = marginY;
  for (const laneKey of laneOrder.length ? laneOrder : ["agent"]) {
    const laneNodes = nodes.filter((node) => node.executionGroup === laneKey);
    const columns = new Map();
    for (const node of laneNodes) {
      if (!columns.has(node.depth)) columns.set(node.depth, []);
      columns.get(node.depth).push(node);
    }
    const maxRows = Math.max(1, ...[...columns.values()].map((group) => group.length));
    const laneHeight = maxRows * nodeHeight + Math.max(0, maxRows - 1) * rowGap + 28;
    lanes.push({
      key: laneKey,
      label: taskExecutionGroupLabel(laneKey),
      icon: taskExecutionGroupIcon(laneKey),
      count: laneNodes.length,
      y: currentY - 14,
      height: laneHeight
    });
    for (const [depth, group] of columns.entries()) {
      const columnHeight = group.length * nodeHeight + Math.max(0, group.length - 1) * rowGap;
      const offsetY = Math.max(0, (laneHeight - 28 - columnHeight) / 2);
      group.forEach((node, row) => {
        positions.set(node.id, {
          x: marginX + depth * (nodeWidth + colGap),
          y: currentY + offsetY + row * (nodeHeight + rowGap),
          width: nodeWidth,
          height: nodeHeight
        });
      });
    }
    currentY += laneHeight + laneGap;
  }
  return {
    positions,
    lanes,
    width: marginX * 2 + (maxDepth + 1) * nodeWidth + maxDepth * colGap,
    height: Math.max(450, currentY + marginY - laneGap)
  };
}

function graphNodeExecutionGroup(node = {}) {
  return node.executionGroup || taskExecutionGroup(node.task || {}, node);
}

function groupGraphNodesForDisplay(nodes = []) {
  const order = ["agent", "tool", "human"];
  const groups = new Map(order.map((key) => [key, []]));
  for (const node of array(nodes)) {
    const key = graphNodeExecutionGroup(node);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  return [...groups.entries()].filter(([, items]) => items.length).map(([key, items]) => ({ key, nodes: items }));
}

function statusCounts(tasks = []) {
  const list = array(tasks);
  return {
    total: list.length,
    completed: list.filter((task) => isDone(task.status)).length,
    running: list.filter((task) => String(task.status).toLowerCase() === "running").length,
    blocked: list.filter(
      (task) =>
        String(task.status).toLowerCase() === "blocked" ||
        String(task.dependencyStatus || "").toLowerCase() === "blocked"
    ).length,
    failed: list.filter((task) =>
      ["failed", "error", "canceled", "cancelled"].includes(String(task.status).toLowerCase())
    ).length,
    pending: list.filter(
      (task) =>
        ["pending", "queued", "waiting"].includes(String(task.status).toLowerCase()) &&
        String(task.dependencyStatus || "").toLowerCase() !== "blocked"
    ).length
  };
}

function TaskGraphPanel({
  goal,
  graph,
  tasks,
  stats,
  selectedTaskId,
  viewMode,
  onViewModeChange,
  onSelectTask,
  onRefresh
}) {
  const visual = buildGraphVisual(graph, tasks);
  const counts = statusCounts(tasks);
  const selectedNode =
    visual.nodes.find((node) => node.id === selectedTaskId) ||
    visual.nodes.find((node) => ["blocked", "waiting_human", "running", "ready"].includes(node.statusKey)) ||
    visual.nodes[0] ||
    null;
  const artifacts = array(stats?.artifacts);
  return (
    <section className="task-graph-panel" id="graph">
      <header className="task-graph-hero">
        <div className="task-graph-title">
          <span className="material-symbols-outlined">schema</span>
          <div>
            <h2>任务图</h2>
            <p>可视化任务依赖关系和执行状态</p>
          </div>
        </div>
        <button className="task-graph-refresh" type="button" onClick={onRefresh}>
          <span className="material-symbols-outlined">refresh</span>
          刷新任务图
        </button>
      </header>

      <div className="task-graph-stats">
        <article className="task-graph-goal-card">
          <span className="task-graph-goal-icon material-symbols-outlined">target</span>
          <div>
            <label>当前目标</label>
            <strong>{safeDisplayText(goal?.title || goal?.goal || "暂无目标", 48)}</strong>
            <small>{goal?.id || "尚未创建目标"}</small>
          </div>
        </article>
        <GraphStat label="任务总数" value={counts.total || stats?.nodes || 0} />
        <GraphStat label="已完成" value={counts.completed} tone="done" />
        <GraphStat label="运行中" value={counts.running} tone="run" />
        <GraphStat label="已阻塞" value={counts.blocked || stats?.blocked || 0} tone="blocked" />
        <GraphStat label="失败" value={counts.failed} tone="fail" />
        <GraphStat label="待处理" value={counts.pending} tone="pending" />
      </div>

      <div className="task-graph-main">
        <section className="task-graph-canvas-card">
          <div className="task-graph-card-head">
            <h3>任务依赖图</h3>
            <div className="task-graph-view-toggle" role="group" aria-label="任务图视图切换">
              <button
                className={viewMode === "graph" ? "active" : ""}
                type="button"
                onClick={() => onViewModeChange("graph")}
              >
                <span className="material-symbols-outlined">schema</span>
                图视图
              </button>
              <button
                className={viewMode === "list" ? "active" : ""}
                type="button"
                onClick={() => onViewModeChange("list")}
              >
                <span className="material-symbols-outlined">list</span>
                列表视图
              </button>
            </div>
          </div>
          {viewMode === "list" ? (
            <GraphListView
              nodes={visual.nodes}
              codeById={visual.codeById}
              onSelect={onSelectTask}
              selectedId={selectedNode?.id}
            />
          ) : (
            <GraphCanvas visual={visual} selectedId={selectedNode?.id} onSelect={onSelectTask} />
          )}
          <GraphLegend />
        </section>
        <GraphTaskDetails
          node={selectedNode}
          code={selectedNode ? visual.codeById.get(selectedNode.id) : ""}
          visual={visual}
          artifacts={artifacts}
        />
      </div>
    </section>
  );
}

function GraphStat({ label, value, tone = "" }) {
  return (
    <article className={`task-graph-stat ${tone}`}>
      <label>{label}</label>
      <strong>{Number(value || 0)}</strong>
    </article>
  );
}

function GraphCanvas({ visual, selectedId, onSelect }) {
  const nodes = visual.nodes;
  if (!nodes.length) {
    return (
      <div className="task-graph-empty">
        <span className="material-symbols-outlined">account_tree</span>
        当前目标暂无任务图
      </div>
    );
  }
  const layout = layoutGraphNodes(nodes);
  const scale = layout.width > 980 ? 0.82 : layout.width > 900 ? 0.9 : 1;
  const fitStyle = {
    width: Math.ceil(layout.width * scale),
    height: Math.ceil(layout.height * scale)
  };
  const canvasStyle = {
    width: layout.width,
    height: layout.height,
    transform: scale === 1 ? undefined : `scale(${scale})`,
    transformOrigin: "top left"
  };
  return (
    <div className="task-graph-scroll">
      <div className="task-graph-fit" style={fitStyle}>
        <div className="task-graph-canvas" style={canvasStyle}>
          {layout.lanes.map((lane) => (
            <div
              className={`task-graph-lane ${taskExecutionGroupClass(lane.key)}`}
              key={lane.key}
              style={{ top: lane.y, height: lane.height }}
            >
              <span className="material-symbols-outlined">{lane.icon}</span>
              <strong>{lane.label}</strong>
              <em>{lane.count}</em>
            </div>
          ))}
          <svg className="task-graph-edges" width={layout.width} height={layout.height} aria-hidden="true">
            <defs>
              <marker id="task-graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" />
              </marker>
            </defs>
            {visual.edges.map((edge, index) => {
              const from = layout.positions.get(edge.from);
              const to = layout.positions.get(edge.to);
              if (!from || !to) return null;
              const sx = from.x + from.width;
              const sy = from.y + from.height / 2;
              const ex = to.x;
              const ey = to.y + to.height / 2;
              const bend = Math.max(32, Math.min(78, (ex - sx) / 2));
              const edgeClass =
                edge.type === "artifact" ? "artifact" : edge.type === "invokes" ? "invokes" : "dependency";
              const edgeTitle = edge.type === "invokes" ? "调用关系" : edge.type === "artifact" ? "产物流" : "依赖关系";
              return (
                <path
                  className={edgeClass}
                  key={`${edge.from}-${edge.to}-${index}`}
                  d={`M${sx},${sy} C${sx + bend},${sy} ${ex - bend},${ey} ${ex},${ey}`}
                >
                  <title>{edgeTitle}</title>
                </path>
              );
            })}
          </svg>
          {nodes.map((node) => {
            const pos = layout.positions.get(node.id);
            const task = node.task || {};
            const selected = selectedId === node.id;
            const invokedByCode = node.createdByTaskId ? visual.codeById.get(String(node.createdByTaskId)) : "";
            if (!pos) return null;
            return (
              <button
                className={`task-graph-node ${taskExecutionGroupClass(graphNodeExecutionGroup(node))} ${graphStatusTone(node.statusKey)} ${selected ? "selected" : ""}`}
                type="button"
                key={node.id}
                style={{ left: pos.x, top: pos.y, width: pos.width, height: pos.height }}
                onClick={() => onSelect(node.id)}
              >
                <span className="task-graph-node-icon material-symbols-outlined">
                  {graphStatusIcon(node.statusKey)}
                </span>
                <span className="task-graph-node-code">{visual.codeById.get(node.id)}</span>
                <strong>{safeDisplayText(displayTask(task.title ? task : node.title || node.id), 52)}</strong>
                <small>
                  {taskExecutionGroupLabel(graphNodeExecutionGroup(node))} · 依赖 {array(node.dependencies).length} ·
                  调用自 {invokedByCode || creationSourceLabel(node.creationSource)}
                </small>
                <span className={`task-graph-badge ${graphStatusTone(node.statusKey)}`}>
                  {graphStatusLabel(node.statusKey)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function GraphListView({ nodes, codeById, selectedId, onSelect }) {
  if (!nodes.length)
    return (
      <div className="task-graph-empty">
        <span className="material-symbols-outlined">account_tree</span>
        当前目标暂无任务图
      </div>
    );
  const groupedNodes = groupGraphNodesForDisplay(nodes);
  return (
    <div className="task-graph-list">
      {groupedNodes.map((group) => (
        <div className={`task-graph-list-group ${taskExecutionGroupClass(group.key)}`} key={group.key}>
          <div className={`task-queue-group-head ${taskExecutionGroupClass(group.key)}`}>
            <span className="material-symbols-outlined">{taskExecutionGroupIcon(group.key)}</span>
            <strong>{taskExecutionGroupLabel(group.key)}</strong>
            <em>{group.nodes.length}</em>
          </div>
          {group.nodes.map((node) => (
            <button
              className={`task-graph-list-row ${selectedId === node.id ? "selected" : ""}`}
              type="button"
              key={node.id}
              onClick={() => onSelect(node.id)}
            >
              <span>{codeById.get(node.id)}</span>
              <strong>{safeDisplayText(displayTask(node.task?.title ? node.task : node.title || node.id), 52)}</strong>
              <em>{graphStatusLabel(node.statusKey)}</em>
              <small>
                {array(node.dependencies).length ? `依赖 ${array(node.dependencies).length}` : "无前置依赖"} · 调用自{" "}
                {(node.createdByTaskId && codeById.get(String(node.createdByTaskId))) ||
                  creationSourceLabel(node.creationSource)}
              </small>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function GraphLegend() {
  return (
    <div className="task-graph-legend">
      {[
        ["completed", "已完成"],
        ["running", "运行中"],
        ["blocked", "已阻塞"],
        ["failed", "失败"],
        ["ready", "可执行"],
        ["pending", "待处理"],
        ["waiting_human", "等待人工"]
      ].map(([key, label]) => (
        <span key={key}>
          <i className={graphStatusTone(key)} />
          {label}
        </span>
      ))}
      {[
        ["edge-dependency", "依赖"],
        ["edge-invokes", "调用"],
        ["edge-artifact", "产物"]
      ].map(([key, label]) => (
        <span key={key}>
          <i className={key} />
          {label}
        </span>
      ))}
    </div>
  );
}

function GraphTaskDetails({ node, code, visual, artifacts }) {
  if (!node) {
    return (
      <aside className="task-graph-details-card">
        <h3>任务详情</h3>
        <div className="task-graph-empty compact">选择一个任务节点后，这里会显示依赖、产物、阻塞和验证信息。</div>
      </aside>
    );
  }
  const task = node.task || {};
  const deps = array(node.dependencies || task.dependsOn || task.dependencies).map(String);
  const invokedBy = String(node.createdByTaskId || taskCreatedByTaskId(task) || "");
  const invokedByItems = invokedBy
    ? [dependencyDisplayForId(invokedBy, visual)]
    : node.creationSource || taskCreationSource(task)
      ? [creationSourceLabel(node.creationSource || taskCreationSource(task))]
      : [];
  const invokedTasks = array(visual?.edges)
    .filter((edge) => edge.type === "invokes" && String(edge.from) === String(node.id))
    .map((edge) => dependencyDisplayForId(edge.to, visual));
  const downstreamTasks = array(visual?.edges)
    .filter((edge) => edge.type === "depends_on" && String(edge.from) === String(node.id))
    .map((edge) => dependencyDisplayForId(edge.to, visual));
  const consumes = array(node.consumes || task.consumes).map(artifactId);
  const produces = array(node.produces || task.produces).map(artifactId);
  const dependencyIssues = [
    task.blockedReason,
    task.approvalReason,
    ...array(task.dependencyReasons),
    ...array(node.readiness?.reasons)
  ]
    .filter(Boolean)
    .map(dependencyReasonLabel);
  const failureReasons = taskFailureReasons(task);
  const showFailureReasons = ["blocked", "failed"].includes(String(node.statusKey || "").toLowerCase());
  const dependencyStatus = String(node.readiness?.status || task.dependencyStatus || "").toLowerCase();
  const readinessMeta = graphReadinessMeta({
    statusKey: node.statusKey,
    dependencyStatus,
    ready: Boolean(node.readiness?.ready)
  });
  return (
    <aside className="task-graph-details-card">
      <h3>任务详情</h3>
      <div className="task-graph-detail-title">
        <div>
          <strong>{code}</strong>
          <span className={`task-graph-badge ${graphStatusTone(node.statusKey)}`}>
            {graphStatusLabel(node.statusKey)}
          </span>
        </div>
        <h4>{safeDisplayText(displayTask(task.title ? task : node.title || node.id), 56)}</h4>
      </div>
      <div className="task-graph-detail-meta">
        <span>
          <span className="material-symbols-outlined">public</span>
          执行器：{safeDisplayText(taskWorkerLabel(task), 32)}
        </span>
        <span>
          <span className="material-symbols-outlined">shield</span>
          依赖任务：{deps.length}
        </span>
        <span className={readinessMeta.className}>{readinessMeta.label}</span>
      </div>
      <GraphDetailSection title="调用自" items={invokedByItems} empty="未记录调用来源" />
      <GraphDetailSection title="调用了" items={invokedTasks} empty="没有直接调用后续任务" />
      <GraphDetailSection
        title="依赖于"
        items={deps.map((dep) => dependencyDisplayForId(dep, visual))}
        empty="无前置任务"
      />
      <GraphDetailSection title="后续依赖任务" items={downstreamTasks} empty="暂无后续依赖任务" />
      <GraphDetailSection
        title="产出"
        items={produces.length ? produces : producesFromArtifacts(task.id, artifacts)}
        empty="暂无产物"
      />
      <GraphDetailSection title="消耗" items={consumes} empty="暂无输入产物" />
      <GraphDetailSection
        title="阻塞原因"
        items={dependencyIssues}
        empty={node.statusKey === "blocked" ? "未记录阻塞原因" : "无阻塞"}
        warning={node.statusKey === "blocked"}
      />
      {showFailureReasons ? (
        <GraphDetailSection
          title="真实失败原因"
          items={failureReasons}
          empty="执行器没有返回明确失败原因"
          warning
          limit={260}
        />
      ) : null}
      <GraphDetailSection
        title="验证摘要"
        items={[
          task.verificationStatus ? verificationLabel(task.verificationStatus, task.verificationConfidence) : "",
          ...array(task.verificationReasons)
            .slice(0, 2)
            .map((item) => verificationReasonLabel(item))
        ].filter(Boolean)}
        empty="未开始验证"
      />
      <div className="task-graph-time">
        <span>创建时间</span>
        <strong>{formatDateTime(task.createdAt || task.created_at || "")}</strong>
        <span>更新时间</span>
        <strong>
          {formatDateTime(
            task.updatedAt || task.updated_at || task.finishedAt || task.startedAt || task.createdAt || ""
          )}
        </strong>
      </div>
    </aside>
  );
}

function visualNodeForId(taskId, visual) {
  return array(visual?.nodes).find((item) => String(item.id) === String(taskId)) || null;
}

function codeForTaskId(taskId, visual) {
  return visual?.codeById?.get(String(taskId)) || String(taskId);
}

function taskTitleForId(taskId, visual) {
  const node = visualNodeForId(taskId, visual);
  return node ? safeDisplayText(node.task?.title || node.title || node.id, 28) : "";
}

function taskStatusForId(taskId, visual) {
  const node = visualNodeForId(taskId, visual);
  return node ? node.statusKey || graphStatusKey(node.task || {}, node, new Set()) : "";
}

function dependencyDisplayForId(taskId, visual) {
  const status = taskStatusForId(taskId, visual);
  const label = status ? ` · ${graphStatusLabel(status)}` : "";
  return `${codeForTaskId(taskId, visual)} ${taskTitleForId(taskId, visual)}${label}`.trim();
}

function graphReadinessMeta({ statusKey, dependencyStatus, ready }) {
  if (statusKey === "completed") return { className: "ready", label: "执行状态：已完成" };
  if (statusKey === "failed") return { className: "not-ready", label: "执行状态：失败" };
  if (statusKey === "blocked" || dependencyStatus === "blocked")
    return { className: "not-ready", label: "依赖状态：已阻塞" };
  if (statusKey === "waiting_human") return { className: "not-ready", label: "依赖状态：等待人工" };
  if (statusKey === "running") return { className: "ready", label: "执行状态：运行中" };
  if (ready || statusKey === "ready") return { className: "ready", label: "是否就绪：是" };
  if (dependencyStatus === "waiting") return { className: "not-ready", label: "是否就绪：等待依赖" };
  return { className: "not-ready", label: "是否就绪：否" };
}

function producesFromArtifacts(taskId, artifacts) {
  return array(artifacts)
    .filter((item) => String(item.taskId || item.task_id || "") === String(taskId))
    .map((item) => artifactId(item))
    .filter(Boolean);
}

function GraphDetailSection({ title, items, empty, done = false, warning = false, limit = 72 }) {
  const list = uniqueDisplayList(items);
  return (
    <section className={`task-graph-detail-section ${warning ? "warning" : ""}`}>
      <h5>{title}</h5>
      {list.length ? (
        <ul>
          {list.slice(0, 8).map((item, index) => (
            <li key={`${title}-${index}-${item}`}>
              <span>{safeDisplayText(item, limit)}</span>
              {done ? <em>已完成</em> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p>{empty}</p>
      )}
    </section>
  );
}
