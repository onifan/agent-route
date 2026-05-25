"use strict";

const strategyEngine = require("../strategies");
const { compactText, messagesToText, runtimeTemporalContext } = require("./content-utils");
const protocol = require("./protocol");

function isWebEvidenceTask(task = {}) {
  return (
    String(task.toolWorker || task.tool_worker || "").toLowerCase() === "web" ||
    /^(web_search|web_read|web_fetch|api_read|http_fetch|public_web_read|public_api_read)$/i.test(
      String(task.type || "")
    )
  );
}

function compactList(values = [], limit = 8) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = compactText(value, 180);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function urlHost(value = "") {
  try {
    return new URL(String(value || "")).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function extractUrls(value = "") {
  return compactList(
    Array.from(String(value || "").matchAll(/\bhttps?:\/\/[^\s"'<>()[\]{}]+/gi)).map((match) =>
      match[0].replace(/[)\]}'"。，、；;,.!?！？]+$/g, "")
    ),
    16
  );
}

function sourceFailureReason(text = "", url = "") {
  const haystack = `${text || ""} ${url || ""}`.toLowerCase();
  if (/http[: ]+401|\b401\b|unauthorized|please enable js|disable any ad blocker/i.test(haystack))
    return "HTTP 401/auth-or-js-block";
  if (
    /http[: ]+403|\b403\b|cloudflare|blocked|forbidden|access denied|captcha|verify you are human|验证码|人机验证/i.test(
      haystack
    )
  )
    return "HTTP 403/access-blocked";
  if (/http[: ]+404|\b404\b|not found|page not found|页面不存在|找不到/i.test(haystack)) return "HTTP 404/not-found";
  if (/timeout|timed out|operation timed out|network error|fetch failed|connection/i.test(haystack))
    return "network-timeout";
  if (/unrelated|task query|dictionary|百科|词典|导航页|navigation page/i.test(haystack)) return "unrelated-result";
  if (/@charset|\.modal-|please enable js|disable any ad blocker/i.test(haystack)) return "not-readable";
  return "";
}

function webSourceDiagnostics(results = []) {
  const failedSources = [];
  const avoidedQueries = [];
  const readableSources = [];
  for (const result of results || []) {
    const task = result && result.task ? result.task : {};
    if (!isWebEvidenceTask(task)) continue;
    const resultText = [result.content, result.error, task.output, task.result, task.error, task.blockedReason]
      .filter(Boolean)
      .join("\n");
    const issueText = [
      ...(Array.isArray(task.detectedIssues) ? task.detectedIssues.map((issue) => issue.issue || issue) : []),
      ...(Array.isArray(task.verificationReasons) ? task.verificationReasons : [])
    ].join("\n");
    const combinedText = [resultText, issueText].join("\n");
    const urls = extractUrls([task.input, task.prompt, resultText].filter(Boolean).join("\n"));
    const taskFailed =
      result.ok === false ||
      /failed|blocked|unverified|partial/i.test(
        `${result.status || ""} ${task.status || ""} ${task.verificationStatus || ""}`
      );
    for (const url of urls) {
      const host = urlHost(url);
      const reason = sourceFailureReason(combinedText, url);
      if (taskFailed || reason) {
        failedSources.push(`${host || url} (${reason || "failed-or-unverified"})`);
      } else if (/http[: ]+2\d\d|\bstatus["': ]+2\d\d|verified/i.test(combinedText)) {
        readableSources.push(`${host || url} (${url})`);
      }
    }
    if (taskFailed) {
      const query = compactText(
        task.input || task.query || task.searchQuery || task.search_query || task.prompt || "",
        220
      );
      if (query) avoidedQueries.push(query);
    }
  }
  const failed = compactList(failedSources, 10);
  const queries = compactList(avoidedQueries, 8);
  const readable = compactList(readableSources, 6);
  if (!failed.length && !queries.length && !readable.length) return "";
  return [
    "联网取证诊断:",
    failed.length ? `失败/不可读来源，下一步不要重复同一 URL/域名，除非明确改变方法: ${failed.join("; ")}` : "",
    queries.length ? `失败/无关查询，下一步必须改变查询条件: ${queries.join(" | ")}` : "",
    readable.length ? `已可读来源，可继续用于分析但不要外推未出现的数据: ${readable.join("; ")}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function compactWorkerEvidence(content = "", limit = 1800) {
  const text = String(content || "");
  const structuredLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^- .+\b(?:source=|HTTP \d{3}|timestamp=)/i.test(line));
  if (!structuredLines.length) return compactText(text, limit);
  const seen = new Set();
  const uniqueStructured = structuredLines.filter((line) => {
    if (seen.has(line)) return false;
    seen.add(line);
    return true;
  });
  const head = uniqueStructured.slice(0, 4);
  const tail = uniqueStructured.slice(-4);
  const balancedStructured = [...head, ...tail].filter((line, index, all) => all.indexOf(line) === index);
  const structuredText = balancedStructured.map((line) => compactText(line, 180)).join("\n");
  const remaining = text
    .split(/\r?\n/)
    .filter((line) => !seen.has(line.trim()))
    .join("\n");
  return compactText([structuredText, remaining ? `补充摘录: ${remaining}` : ""].filter(Boolean).join("\n"), limit);
}

function compactWorkerResult(result, limit = 1800) {
  const task = result.task || {};
  return [
    `任务: ${task.id} (${task.modelPool || "free"})`,
    `标题: ${compactText(task.title || "", 160)}`,
    `类型: ${task.type || "general"} / toolWorker: ${task.toolWorker || "none"}`,
    `难度: ${task.difficulty || task.complexity || "medium"}`,
    task.verificationStatus
      ? `验证: ${task.verificationStatus} (${Math.round(Number(task.verificationConfidence || 0) * 100)}%)`
      : "",
    task.verificationSuggestedNextState ? `验证建议: ${task.verificationSuggestedNextState}` : "",
    task.verificationReasonCode ? `验证原因码: ${task.verificationReasonCode}` : "",
    Array.isArray(task.missingEvidence) && task.missingEvidence.length
      ? `证据缺口: ${task.missingEvidence
          .slice(0, 4)
          .map((item) => item.description || item.reason || item.kind || item.id)
          .filter(Boolean)
          .join("; ")}`
      : "",
    task.budgetStatus ? `预算: ${task.budgetStatus} / ${task.degradationLevel || "none"}` : "",
    `模型: ${result.model || "none"}`,
    `状态: ${result.status || (result.ok ? "completed" : "failed")}`,
    result.error ? `错误: ${compactText(result.error, 300)}` : "",
    `证据摘录: ${compactWorkerEvidence(result.content || "", limit)}`
  ]
    .filter(Boolean)
    .join("\n");
}

function isVerifiedTask(task = {}) {
  const status = String(task.status || "").toLowerCase();
  const verification = String(task.verificationStatus || task.verification_status || "").toLowerCase();
  return (
    status === "completed" &&
    (verification === "verified" || verification === "partially_verified" || task.verified === true)
  );
}

function isRouteInternalTask(task = {}) {
  if (!task || typeof task !== "object") return true;
  if (task.internal || task.routeInternal || task.route_internal) return true;
  return /^(?:plan|final|goal-review(?:-\d+)?)$/.test(String(task.id || ""));
}

function listValues(value = []) {
  if (Array.isArray(value)) return value.map((item) => String(item || "")).filter(Boolean);
  return String(value || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function taskAttemptsExhausted(task = {}) {
  return Number(task.attempts || 0) >= Math.max(1, Number(task.maxAttempts || 1));
}

function taskHasWorkerObservation(task = {}) {
  return Boolean(
    Number(task.attempts || 0) > 0 ||
    task.startedAt ||
    task.started_at ||
    task.finishedAt ||
    task.finished_at ||
    task.result ||
    task.output ||
    task.error ||
    task.verificationStatus ||
    task.verification_status
  );
}

function isExhaustedEvidenceGapTask(task = {}) {
  const status = String(task.status || "waiting").toLowerCase();
  return (
    ["needs_evidence", "retry_ready"].includes(status) && taskAttemptsExhausted(task) && taskHasWorkerObservation(task)
  );
}

function isActionableUnresolvedTask(task = {}) {
  const status = String(task.status || "waiting").toLowerCase();
  if (["completed", "failed", "canceled"].includes(status)) return false;
  return !isExhaustedEvidenceGapTask(task);
}

function taskInventoryLine(task = {}) {
  const dependsOn = listValues(task.dependsOn || task.depends_on || task.dependencies || []);
  const consumes = listValues(task.consumes || task.requiredArtifacts || task.required_artifacts || []);
  const missing = listValues(task.missingArtifacts || task.missing_artifacts || []);
  return [
    `- ${task.id}: ${compactText(task.title || "", 120)}`,
    `status=${task.status || "waiting"}`,
    `attempts=${Number(task.attempts || 0)}/${Math.max(1, Number(task.maxAttempts || 1))}`,
    `type=${task.type || "general"}`,
    task.toolWorker ? `toolWorker=${task.toolWorker}` : "",
    dependsOn.length ? `dependsOn=${dependsOn.join(",")}` : "",
    consumes.length ? `consumes=${consumes.join(",")}` : "",
    missing.length ? `missing=${missing.join(",")}` : "",
    task.blockedReason ? `blockedReason=${compactText(task.blockedReason, 180)}` : "",
    task.error ? `error=${compactText(task.error, 180)}` : "",
    task.verificationReasonCode ? `verificationReason=${task.verificationReasonCode}` : ""
  ]
    .filter(Boolean)
    .join(" | ");
}

function unresolvedTaskInventory(planTasks = [], limit = 12) {
  const realTasks = (planTasks || []).filter((task) => !isRouteInternalTask(task));
  const actionable = realTasks.filter((task) => isActionableUnresolvedTask(task)).slice(0, limit);
  const exhaustedEvidence = realTasks.filter((task) => isExhaustedEvidenceGapTask(task)).slice(0, limit);
  if (!actionable.length && !exhaustedEvidence.length) return "未完成真实任务清单: 无。";
  return [
    actionable.length ? "仍可行动/未执行真实任务清单:" : "仍可行动/未执行真实任务清单: 无。",
    ...actionable.map(taskInventoryLine),
    exhaustedEvidence.length ? "已执行但证据不足或尝试耗尽的任务:" : "",
    ...exhaustedEvidence.map(taskInventoryLine),
    "只要仍可行动/未执行清单还有任务，就不得返回 done/final_answer。已执行但证据不足的任务不能当作成功证据；必须规划恢复/替代证据，或在证据确实不可获得时诚实说明缺口。"
  ]
    .filter(Boolean)
    .join("\n");
}

function mergedTaskEvidence(planTasks = [], results = []) {
  const byId = new Map();
  for (const task of planTasks || []) {
    if (!task || !task.id) continue;
    byId.set(String(task.id), {
      task,
      content: task.result || task.output || "",
      error: task.error || ""
    });
  }
  for (const result of results || []) {
    const task = (result && result.task) || {};
    if (!task.id) continue;
    const key = String(task.id);
    const existing = byId.get(key) || {};
    byId.set(key, {
      task: { ...(existing.task || {}), ...task },
      content: result.content || task.result || task.output || existing.content || "",
      error: result.error || task.error || existing.error || ""
    });
  }
  return Array.from(byId.values());
}

function verifiedEvidenceInventory(planTasks = [], results = [], limit = 10) {
  const entries = mergedTaskEvidence(planTasks, results)
    .filter((entry) => isVerifiedTask(entry.task))
    .slice(-limit);
  if (!entries.length) return "已验证证据清单: 无。";
  const lines = entries.map((entry) => {
    const task = entry.task || {};
    const content = [entry.content, task.result, task.output].filter(Boolean).join("\n");
    const urls = extractUrls([task.input, task.prompt, content].filter(Boolean).join("\n")).slice(0, 3);
    const evidence = compactWorkerEvidence(content, 650);
    return [
      `- ${task.id}: ${compactText(task.title || "", 120)}`,
      `type=${task.type || "general"}`,
      task.toolWorker ? `toolWorker=${task.toolWorker}` : "",
      task.verificationStatus ? `verification=${task.verificationStatus}` : "",
      urls.length ? `urls=${urls.join(", ")}` : "",
      evidence ? `evidence=${compactText(evidence, 520)}` : ""
    ]
      .filter(Boolean)
      .join(" | ");
  });
  return [
    "已验证证据清单:",
    ...lines,
    "review 判断是否已足够时，应先使用这些已验证证据；早期失败任务只表示对应路径失败，不会自动否定后续已验证替代证据。"
  ].join("\n");
}

function makeProgressMessages(
  originalMessages,
  plan,
  results,
  iteration,
  config,
  memoryText = "",
  strategy = null,
  options = {}
) {
  const normalizePromptSettings = options.normalizePromptSettings || ((value) => value || {});
  const prompts = normalizePromptSettings(config && config.promptSettings);
  const strategyText = strategy ? strategyEngine.strategyForPrompt(strategy) : "";
  return [
    {
      role: "system",
      content: [
        prompts.commanderSystem,
        prompts.reviewSystem,
        runtimeTemporalContext(),
        protocol.baseContract(protocol.KIND.GOAL_REVIEW),
        "next_tasks 最多 3 个；字段保持短句，避免长段落导致结构化输出被截断。",
        strategyText,
        memoryText,
        "modelPool 只能从 commander、strong、coding、free、codex-cli 中选择。",
        "每个 next task 都要自行判断 difficulty：low、medium、high 或 critical。",
        "每个 next task 都要自行判断 riskLevel：low、medium、high 或 critical。",
        "codex-cli 只用于需要真实浏览器自动化或本地电脑自动化的 worker 任务；公开联网取证用 web tool，文档渲染用 document tool，普通分析用模型 worker。",
        "如果下一步需要真实联网、公开网页搜索、公开 API 抓取或外部页面读取，只读取证任务必须使用 type web_search/web_read/api_read、toolWorker web、modelPool free，并要求 URL/status/title/text/API evidence。",
        "工具层只执行你指定的通用查询或 URL，不会替你选择业务来源。若 web_search 证据与任务查询无关或验证失败，下一步应改写更精确查询，或由你选择可信公开 URL/API 后规划 web_read/api_read。",
        "重试公开搜索时必须改变查询条件：使用更精确实体、代码、别名、引号或另一种语言；不要重复已失败的查询，也不要继续偏向已返回登录、验证码、付费或无关页面的来源。",
        "遇到失败来源时，要先看用户消息里的“联网取证诊断”：不要重复同一失败 URL、域名或查询；可以由你规划新的 source-discovery web_search 来寻找公开、无需登录、可读取的候选来源，再用 web_read/api_read 读取你选择的新 URL。",
        "同一取证任务可在 input 中用分号/换行列出 2-4 个 agent 自己选择的候选查询；这些查询必须服务于同一事实缺口，优先包含精确实体、标准英文/代码/缩写、关键口径或另一种语言，不能让工具层替你做业务判断。",
        "恢复查询应查事实、实体、代码、指标和口径本身，避免默认把来源名、站点名或域名作为搜索词；只有用户指定来源，或 evidence 已证明某个公开 URL/API 可读时，才规划 web_read/api_read 读取它。",
        "模型只分析 web tool 返回的证据；需要点击、填写、截图、登录、本地网页、data URL、shell、文件或应用操作时才使用 codex-cli 或 browser-capable worker。",
        "普通公开网页取证不使用 browser 自动化；需要详细证据时，先让 web_search 发现公开来源，再由 web_read/api_read 读取你选择的 URL/API。只有确实需要交互、截图、视觉检查、JS 渲染、本地页面或 data URL 时，才规划 browser，并必须给出具体 URL 和原因。",
        "只有目标明确要求 PDF、DOCX、Markdown、HTML、文本文件、保存、导出或 artifact 时才规划 document_generate；普通“写报告/最终报告”由 final_answer 收口。如果目标要求只读或不要修改文件，不得规划文件生成任务。",
        "如果目标要求输出文档、PDF、DOCX、Markdown、HTML 或文本文件，必须检查是否已有真实 document artifact。普通 analysis worker 只能准备正文，不能声称已经创建本地文件。",
        "缺少文档产物时，下一步应规划 type document_generate、toolWorker document、modelPool free 的通用渲染任务，并要求 artifact path、format、size、hash、createdAt 和 file evidence。文档工具只渲染上游内容，不替你补事实。",
        "文档任务完成前必须确认文件存在、非空、格式匹配、可基本读取或解析，且内容基于上游 evidence；缺一项就 continue、blocked 或 failed，不要返回 done。",
        "review 输出描述的是下一批待执行任务，不是已完成动作。不要把未来的浏览器、shell、API 或文件步骤写成完成证据。",
        "硬性完成条件：只要当前计划中仍有真实 worker 任务处于 waiting、running、blocked、waiting_human、awaiting_confirmation，或 retry_ready/needs_evidence 且仍有可用尝试次数，就不得返回 status done 或 final_answer；必须让任务继续执行、规划恢复/补证据任务，或让运行时明确阻塞。",
        "planning、strategy、review、verification、decision、final、summary 是元任务；它们应检查证据并决策，不能声称工具执行已经发生。",
        "不要为了写最终报告、最终答案或总结再创建普通 analysis worker；如果证据已经足够，应直接返回 status done 和 final_answer。",
        "尊重 waiting_human、approvalStatus、blockedReason 和 riskReasons；不要创建绕过风险或人工确认的 workaround 任务。",
        "尊重 verificationStatus 和 detectedIssues。验证失败的任务不会因为 worker 说 success 就完成。",
        "尊重 budgetStatus、budgetWarnings 和 degradationLevel。不要无限重试；继续执行浪费时应降级模型、减少可选验证或停止。",
        "尊重 strategyId、strategicObjective、strategicPhase 和 strategicRationale。如果下一步无法遵守，应请求 strategy revision。",
        "尊重执行图依赖。依赖先前输出的 next tasks 必须声明 dependsOn、produces、consumes、priority 和 retryPolicy。",
        "如果依赖或产物验证失败，添加恢复任务或修订执行图，而不是继续运行下游任务。",
        "如果任务状态是 needs_evidence，表示该路径没有足够证据，不表示目标已失败；你必须基于 missingEvidence/rejectedEvidence 自主规划新的通用取证任务，或在证据确实不可获得时诚实结束为证据不足。",
        "补证据任务必须服务于证据缺口本身，使用通用工具和真实 evidence；不要硬编码领域来源、关键词规则、固定报告模板或专用兜底。",
        "如果已有另一个已验证任务满足同一 consumes/produces 证据需求，可以让后续任务依赖该已验证产物继续执行；不要把早期失败路径当成全局失败。",
        "出现可复用经验时，包含 memory_candidates，字段为 type、importance、title、summary 和 tags。"
      ]
        .filter(Boolean)
        .join("\n")
    },
    {
      role: "user",
      content: [
        `迭代次数: ${iteration}`,
        "",
        "原始对话:",
        messagesToText(originalMessages),
        "",
        "当前计划:",
        JSON.stringify(plan),
        strategy ? ["", "当前 strategy:", JSON.stringify(strategy)].join("\n") : "",
        "",
        unresolvedTaskInventory((plan && plan.tasks) || []),
        "",
        verifiedEvidenceInventory((plan && plan.tasks) || [], results),
        "",
        "Worker 结果:",
        results.map((result) => compactWorkerResult(result)).join("\n\n"),
        webSourceDiagnostics(results)
      ].join("\n")
    }
  ];
}

function normalizeGoalReview(review, config, messages = [], strategy = null, options = {}) {
  const normalizePlan = options.normalizePlan || (() => ({ tasks: [] }));
  const status = String((review && review.status) || "").toLowerCase() === "done" ? "done" : "continue";
  const rawNextTasks = Array.isArray(review && review.next_tasks)
    ? review.next_tasks
    : Array.isArray(review && review.nextTasks)
      ? review.nextTasks
      : [];
  const nextPlan = rawNextTasks.length
    ? normalizePlan({ tasks: rawNextTasks }, config, messages, strategy)
    : { tasks: [] };
  return {
    status,
    progressSummary: String((review && (review.progress_summary || review.summary)) || ""),
    finalAnswer: String((review && (review.final_answer || review.final || "")) || ""),
    strategyRevisionReason: String(
      (review && (review.strategy_revision_reason || review.strategyRevisionReason)) || ""
    ),
    nextTasks: nextPlan.tasks
  };
}

module.exports = {
  compactWorkerEvidence,
  compactWorkerResult,
  makeProgressMessages,
  normalizeGoalReview,
  unresolvedTaskInventory,
  verifiedEvidenceInventory,
  webSourceDiagnostics
};
