"use strict";

const workerEvidence = require("../verification/evidence");
const { messagesToText } = require("./content-utils");
const protocol = require("./protocol");

function compactText(value, limit = 1800) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function compactPreviousResult(result = {}) {
  const task = result.task || {};
  const evidence = result.evidence || result.workerResult?.evidence || {};
  return {
    taskId: task.id || result.taskId || "",
    title: task.title || "",
    type: task.type || "",
    status: result.status || (result.ok ? "completed" : "failed"),
    verified: task.verificationStatus || "",
    model: result.model || "",
    content: compactText(result.content || result.output || result.error || "", 2200),
    evidence: workerEvidence.compactEvidence(evidence)
  };
}

function makeWorkerMessages(originalMessages, task, config, memoryText = "", options = {}) {
  const normalizePromptSettings = options.normalizePromptSettings || ((value) => value || {});
  const tierPromptForTask = options.tierPromptForTask || (() => "");
  const previousResults = Array.isArray(options.previousResults) ? options.previousResults : [];
  const compactPreviousResults = previousResults
    .filter((result) => result && result.task && result.task.id !== task.id)
    .slice(-8)
    .map(compactPreviousResult);
  const prompts = normalizePromptSettings(config && config.promptSettings);
  return [
    {
      role: "system",
      content: [
        prompts.workerSystem,
        tierPromptForTask(prompts, task),
        memoryText,
        "执行前先判断相关记忆是否会改变方法。执行后只为持久、非敏感的经验建议 memoryCandidates。"
      ]
        .filter(Boolean)
        .join("\n")
    },
    {
      role: "user",
      content: [
        `分配任务: ${task.title}`,
        `描述: ${task.description || ""}`,
        `类型: ${task.type || "general"}`,
        `难度: ${task.difficulty || task.complexity || "medium"}`,
        `风险: ${task.riskLevel || "low"}`,
        `确认状态: ${task.approvalStatus || "not_required"}`,
        task.approvalReason ? `确认原因: ${task.approvalReason}` : "",
        Array.isArray(task.riskReasons) && task.riskReasons.length ? `风险原因: ${task.riskReasons.join("; ")}` : "",
        task.verificationStatus
          ? `历史验证: ${task.verificationStatus} (${Math.round(Number(task.verificationConfidence || 0) * 100)}%)`
          : "",
        Array.isArray(task.detectedIssues) && task.detectedIssues.length
          ? `历史验证问题: ${task.detectedIssues.map((item) => item.issue || item).join("; ")}`
          : "",
        task.budgetStatus ? `预算状态: ${task.budgetStatus} / degradation ${task.degradationLevel || "none"}` : "",
        Array.isArray(task.budgetWarnings) && task.budgetWarnings.length
          ? `预算警告: ${task.budgetWarnings.join("; ")}`
          : "",
        Array.isArray(task.dependencies) && task.dependencies.length ? `依赖任务: ${task.dependencies.join("; ")}` : "",
        Array.isArray(task.consumes) && task.consumes.length
          ? `消耗产物: ${task.consumes.map((item) => item.id || item).join("; ")}`
          : "",
        Array.isArray(task.produces) && task.produces.length
          ? `产生产物: ${task.produces.map((item) => item.id || item).join("; ")}`
          : "",
        task.strategyId ? `Strategy: ${task.strategyId}` : "",
        task.strategicObjective ? `战略目标: ${task.strategicObjective}` : "",
        task.strategicPhase ? `战略阶段: ${task.strategicPhase}` : "",
        task.strategicRationale ? `战略理由: ${task.strategicRationale}` : "",
        `推荐模型池: ${task.modelPool || "free"}`,
        task.routingReason ? `路由原因: ${task.routingReason}` : "",
        task.successCriteria && task.successCriteria.length ? `成功标准: ${task.successCriteria.join("; ")}` : "",
        task.input ? `任务输入: ${typeof task.input === "string" ? task.input : JSON.stringify(task.input)}` : "",
        task.prompt,
        compactPreviousResults.length
          ? [
              "",
              "可用上游 worker 结果与证据:",
              JSON.stringify(compactPreviousResults),
              "如果本任务是分析、报告或总结，只能基于这些已返回证据进行综合；不要编造缺失数据。"
            ].join("\n")
          : "",
        "",
        "输出协议:",
        protocol.baseContract(protocol.KIND.WORKER_RESULT),
        "如果本任务是分析、报告正文、总结、提案、复盘或语义判断，evidence 至少包含 summary、claims 和 semantic；semantic 必须包含 outputSummary、addressesCriteria、criteriaCoverage、qualityScore、qualityIssues。",
        "如果没有足够上游证据支撑 output，返回 failure/retry/blocked 并说明缺口，不要用 success 包装。",
        "普通模型不能声称创建了文件；只有真实 document/file worker 返回 artifact path、size、hash、format 后才算文件产物。",
        "",
        "原始对话:",
        messagesToText(originalMessages)
      ].join("\n")
    }
  ];
}

function makeVerifierMessages(originalMessages, task, workerRuntimeResult, ruleVerification, strategy = null) {
  const compactWorker = {
    status: workerRuntimeResult.status,
    actions: workerRuntimeResult.actions,
    output: workerRuntimeResult.output,
    error: workerRuntimeResult.error,
    evidence: workerEvidence.compactEvidence(workerRuntimeResult.evidence || {}),
    artifacts: workerRuntimeResult.artifacts
  };
  return [
    {
      role: "system",
      content: [
        "你是目标驱动自主 agent 的语义验证器。",
        "规则验证器已经先检查了技术证据。不要覆盖缺失的 file、shell、browser、API、risk 或 approval 证据。",
        "你的职责只是在证据存在的前提下判断语义质量：输出是否满足任务、是否非空、是否非重复、是否没有明显幻觉。",
        strategy ? "同时应用当前 strategy 的质量标准和停止条件。违反 strategy 的结果不算语义完成。" : "",
        "证据不足、来源不相关、搜索命中百科/导航页、缺少日期/摘录，或普通 strategy 质量不达标，属于可恢复取证缺口：使用 unverified + needs_evidence/retrying，不要使用 blocked。",
        "blocked 只用于安全风险、人工确认、预算/权限硬阻断、危险副作用、验证码/登录门槛或明确不可恢复的外部阻断。",
        protocol.baseContract(protocol.KIND.VERIFICATION_RESULT),
        "安全和真实性优先于目标完成。如果证据不足，必须判定为 unverified。"
      ]
        .filter(Boolean)
        .join("\n")
    },
    {
      role: "user",
      content: [
        "原始对话:",
        messagesToText(originalMessages),
        "",
        "任务:",
        JSON.stringify({
          id: task.id,
          title: task.title,
          description: task.description,
          type: task.type,
          successCriteria: task.successCriteria,
          riskLevel: task.riskLevel,
          strategyId: task.strategyId,
          strategicObjective: task.strategicObjective,
          strategicPhase: task.strategicPhase,
          strategicRationale: task.strategicRationale
        }),
        strategy
          ? [
              "",
              "当前 strategy:",
              JSON.stringify({
                id: strategy.id,
                version: strategy.version,
                objective: strategy.objective,
                successCriteria: strategy.successCriteria,
                constraints: strategy.constraints,
                avoidRules: strategy.avoidRules,
                stopConditions: strategy.stopConditions,
                qualityStandards: strategy.qualityStandards,
                phasePlan: strategy.phasePlan
              })
            ].join("\n")
          : "",
        "",
        "带标准化 evidence 的 worker 结果:",
        JSON.stringify(compactWorker),
        "",
        "规则验证:",
        JSON.stringify(ruleVerification)
      ].join("\n")
    }
  ];
}

module.exports = {
  makeVerifierMessages,
  makeWorkerMessages
};
