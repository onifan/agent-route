"use strict";

const { DEFAULT_PROMPT_SETTINGS, normalizePromptSettings } = require("../../config/loader");
const { messagesToText } = require("./content-utils");
const protocol = require("./protocol");

function tierPromptForTask(promptSettings, task) {
  const pool = task && task.modelPool ? task.modelPool : "free";
  const prompts =
    promptSettings && promptSettings.tierPrompts ? promptSettings.tierPrompts : DEFAULT_PROMPT_SETTINGS.tierPrompts;
  return prompts[pool] || prompts.free || "";
}

function makeCodexCliPrompt(messages, config, memoryText = "") {
  const prompts = normalizePromptSettings(config && config.promptSettings);
  return [
    prompts.codexCliSystem,
    prompts.tierPrompts["codex-cli"],
    memoryText,
    "这个请求需要真实的本地电脑、浏览器或终端动作，不能只返回文本拒绝或说明。",
    "使用本机和可用 shell 命令完成用户任务。",
    "安全门：只读动作可以执行；high 或 critical 副作用必须停止并请求人工确认。",
    "high/critical 副作用包括 submit、delete、login、upload、payment、publish、deploy、发送真实消息、sudo、rm、rm -rf、数据库写入和生产变更。",
    "验证门：没有观察到证据时不要声称成功。返回标准化 evidence，包括 exit code、stderr、生成文件路径、浏览器 URL/DOM/success message、API status 和语义质量信号。",
    protocol.baseContract(protocol.KIND.WORKER_RESULT, { transport: "payload" }),
    '如果用户要求在 macOS 打开 URL，可运行适当命令，例如 `open <url>` 或 `open -a "Google Chrome" <url>`。',
    "如果用户要求操作网页，先打开页面，再尽可能使用本地自动化或 shell 工具。",
    "如果存在本地命令或工具路径，不要说你无法控制浏览器。",
    "完成后简要说明做了什么以及重要结果。",
    "",
    "原始对话：",
    messagesToText(messages)
  ]
    .filter(Boolean)
    .join("\n");
}

function makeCodexCliTaskPrompt(originalMessages, task, previousResults = [], config, memoryText = "") {
  const prompts = normalizePromptSettings(config && config.promptSettings);
  return [
    prompts.codexCliSystem,
    tierPromptForTask(prompts, task),
    memoryText,
    "你正在执行总指挥规划中的一个具体步骤。",
    protocol.baseContract(protocol.KIND.WORKER_RESULT, { transport: "payload" }),
    "安全门：防止不安全副作用比完成目标更重要。除非 approvalStatus 为 approved，否则在 high 或 critical 动作前停止。",
    "验证门：worker success 不足以完成任务。先填写 evidence object；历史上下文只能作为参考材料，不能替代当前 evidence。",
    '如果需要在 macOS 打开 URL，使用适当本地命令，例如 `open <url>` 或 `open -a "Google Chrome" <url>`。',
    "如果任务是只读网页研究，使用受控公开访问方式，如 curl、node fetch 或浏览器读取，并在 evidence 中写入真实 URL/status。不要编造网页结果。",
    "公开搜索任务优先使用无需登录的公开页面或 API；如果来源需要登录、验证码、付款或提交表单，应停止并报告限制。",
    "如果任务要求生成文档文件，必须返回真实 artifact path、format、size、hash 和 files evidence；普通文本说明不能替代本地文件产物。",
    "",
    `分配任务 ID: ${task.id}`,
    `分配任务标题: ${task.title}`,
    `复杂度: ${task.complexity || "medium"}`,
    `风险等级: ${task.riskLevel || "low"}`,
    `确认状态: ${task.approvalStatus || "not_required"}`,
    task.approvalReason ? `确认原因: ${task.approvalReason}` : "",
    Array.isArray(task.riskReasons) && task.riskReasons.length ? `风险原因: ${task.riskReasons.join("; ")}` : "",
    task.routingReason ? `路由原因: ${task.routingReason}` : "",
    `任务 prompt: ${task.prompt}`,
    "",
    `原始用户目标：\n${messagesToText(originalMessages)}`,
    "",
    "历史 worker 结果：",
    previousResults.length
      ? previousResults
          .map((result) =>
            [
              `任务: ${result.task.id}`,
              `状态: ${result.ok ? "ok" : "failed"}`,
              result.content || result.error || ""
            ].join("\n")
          )
          .join("\n\n")
      : "暂无。"
  ]
    .filter(Boolean)
    .join("\n");
}

module.exports = {
  makeCodexCliPrompt,
  makeCodexCliTaskPrompt,
  tierPromptForTask
};
