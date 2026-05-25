"use strict";

const dependencyEngine = require("../graph");
const { jsonParseDiagnostics, lastUserText, messagesToText, runtimeTemporalContext } = require("./content-utils");
const protocol = require("./protocol");

function normalizeComplexity(value, fallback = "medium") {
  const raw = String(value || fallback || "medium")
    .trim()
    .toLowerCase();
  if (["trivial", "simple", "easy", "low"].includes(raw)) return "low";
  if (["medium", "normal", "moderate", "standard"].includes(raw)) return "medium";
  if (["high", "hard", "complex", "advanced"].includes(raw)) return "high";
  if (["critical", "expert", "very_high", "very-high", "max"].includes(raw)) return "critical";
  return fallback;
}

function normalizeRiskLevel(value, fallback = "low") {
  const raw = String(value || fallback || "low")
    .trim()
    .toLowerCase();
  if (["none", "safe", "low", "l0"].includes(raw)) return "low";
  if (["medium", "moderate", "normal", "l1"].includes(raw)) return "medium";
  if (["high", "risky", "l2"].includes(raw)) return "high";
  if (["critical", "danger", "severe", "l3"].includes(raw)) return "critical";
  return fallback;
}

function normalizeStringList(value) {
  if (Array.isArray(value))
    return value
      .filter(Boolean)
      .map((item) => String(item).trim())
      .filter(Boolean);
  if (!value) return [];
  return String(value)
    .split(/\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasDistinctWebQueryClauseIntent(value = "") {
  return /\b(each|every|all|both|multiple|distinct|separate)\s+(?:fact|facts|datum|data|metric|metrics|point|points|source|sources|gap|gaps)\b|两个|多个|多项|分别|各自|各个|所有(?:事实|数据|指标|来源|缺口)/i.test(
    String(value || "")
  );
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function compactPromptBlock(value = "", limit = 900) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, Math.max(1, limit - 3))}...` : text;
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  return ["true", "yes", "1", "required", "manual"].includes(raw);
}

function defaultComplexityForPool(poolName) {
  if (poolName === "commander" || poolName === "strong") return "high";
  if (poolName === "coding" || poolName === "codex-cli") return "medium";
  return "low";
}

function normalizeExecutionModelPool(task = {}, modelPool = "free") {
  const type = String(task.type || task.taskType || task.task_type || "").toLowerCase();
  if (
    /^(planning|plan|strategy|review|verification|decision|final|summary)$/i.test(type) &&
    modelPool === "codex-cli"
  ) {
    return "free";
  }
  return modelPool;
}

function isPrivateHost(hostname = "") {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host.startsWith("127.")) return true;
  if (host.startsWith("10.") || host.startsWith("192.168.")) return true;
  const octets = host.split(".").map((part) => Number(part));
  return (
    octets.length === 4 &&
    octets.every((part) => Number.isInteger(part)) &&
    ((octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 169 && octets[1] === 254))
  );
}

function hasPublicHttpUrl(value = "") {
  const matches = String(value || "").match(/\bhttps?:\/\/[^\s"'<>()[\]{}]+/gi) || [];
  return matches.some(isPublicHttpUrl);
}

function isPublicHttpUrl(value = "") {
  try {
    const parsed = new URL(String(value || "").replace(/[)\]}'"。，、；;,.!?！？]+$/g, ""));
    return ["http:", "https:"].includes(parsed.protocol) && !isPrivateHost(parsed.hostname);
  } catch {
    return false;
  }
}

function stripHttpUrls(value = "") {
  return String(value || "").replace(/\bhttps?:\/\/[^\s"'<>()[\]{}]+/gi, (match) =>
    isPublicHttpUrl(match) ? " " : match
  );
}

function hasBrowserOrLocalOperationRequiringCodex(value = "") {
  const text = stripBenignPublishMetadata(stripNegatedHighRiskText(stripHttpUrls(String(value || "").toLowerCase())));
  return (
    /点击|填写|输入|截图|滚动|下载|上传|登录|提交|发送|支付|付款|发布(?!时间|日期|于|在|源|者|物)|删除|操作电脑|控制电脑|控制浏览器|启动|运行命令|执行命令/i.test(
      text
    ) ||
    /\b(click|fill|type|screenshot|scroll|download|upload|login|submit|send|pay|publish|delete|run (a )?command|shell|terminal)\b/i.test(
      text
    ) ||
    /localhost:\d+|127\.0\.0\.1:\d+|data:text\/html|data url/i.test(text)
  );
}

function shouldUseCodexCliWorker(messages) {
  const text = lastUserText(messages).toLowerCase();
  if (!text) return false;
  if (shouldUseWebToolWorker(messages) && !hasBrowserOrLocalOperationRequiringCodex(text)) return false;
  const hasUrl = /https?:\/\/|www\.|localhost:\d+|127\.0\.0\.1:\d+|data:text\/html|data url/.test(text);
  const operationPatterns = [
    /打开(?:页面|网页|网站|链接|url|data url|浏览器|http|https|localhost|127\.0\.0\.1)/,
    /访问(?:页面|网页|网站|链接|url|data url|http|https|localhost|127\.0\.0\.1)/,
    /读取(?:页面|网页|网站|链接|url|data url|http|https|localhost|127\.0\.0\.1)/,
    /点击/,
    /填写/,
    /输入/,
    /截图/,
    /操作电脑/,
    /控制电脑/,
    /控制浏览器/,
    /启动/,
    /运行命令/,
    /执行命令/,
    /\bopen\b/,
    /\bclick\b/,
    /\btype\b/,
    /\bfill\b/,
    /\bscreenshot\b/,
    /\brun (a )?command\b/
  ];
  return (
    operationPatterns.some((pattern) => pattern.test(text)) || (hasUrl && /打开|访问|\bopen\b|浏览|读取/.test(text))
  );
}

function baselinePlanInput(messages = []) {
  const text = (lastUserText(messages) || messagesToText(messages)).trim();
  return text.length > 4000 ? `${text.slice(0, 4000)}...` : text;
}

function isReadOnlyBrowserText(value = "") {
  const text = String(value || "").toLowerCase();
  if (!/(https?:\/\/|localhost:\d+|127\.0\.0\.1:\d+|data:text\/html|data url|网页|页面|浏览器)/i.test(text))
    return false;
  if (!/(open|read|extract|summari[sz]e|打开|读取|提取|总结|摘要|浏览)/i.test(text)) return false;
  const negationSafe = stripNegatedHighRiskText(text);
  return !/(submit|send|pay|payment|login|upload|delete|publish|提交|发送|付款|支付|登录|上传|删除|发布)/i.test(
    negationSafe
  );
}

function stripNegatedHighRiskText(value = "") {
  return String(value || "")
    .replace(
      /(?:不要|不允许|禁止|不得|请勿|do not|don't|never)[^。.;\n]*(?:提交|发送|付款|支付|登录|上传|删除|发布|修改|写入|submit|send|pay|login|upload|delete|publish|modify|write)[^。.;\n]*/gi,
      " "
    )
    .replace(
      /(?:涉及|如需|如果|when|if)[^。.;\n]{0,100}(?:提交|发送|付款|支付|登录|上传|submit|send|pay|login|upload)[^。.;\n]{0,100}(?:人工确认|human approval|human confirmation|manual approval|manual review)/gi,
      " "
    );
}

function hasExplicitHighRiskBrowserAction(value = "") {
  const text = stripBenignPublishMetadata(stripNegatedHighRiskText(String(value || "").toLowerCase()));
  return /(submit|send|pay|payment|login|upload|delete|publish|提交|发送|付款|支付|登录|上传|删除|发布(?!时间|日期|于|在|源|者|物))/i.test(
    text
  );
}

function stripBenignPublishMetadata(value = "") {
  return String(value || "")
    .replace(
      /发布(?:时间|日期|于|在)|发布时间戳|发布日期|更新(?:时间|日期)|publish(?:ed|ing)?\s+(?:time|date|timestamp)|publication\s+date/gi,
      " "
    )
    .replace(/publish\/update\s+(?:time|date|timestamp)/gi, " ");
}

function isNonExecutablePlanningType(type = "") {
  return /^(planning|plan|strategy|review|verification|decision|final|summary)$/i.test(String(type || ""));
}

function isWebToolType(type = "") {
  return /^(web_search|web_read|web_fetch|api_read|http_fetch|public_web_read|public_api_read)$/i.test(
    String(type || "")
  );
}

function isDocumentGenerationType(type = "") {
  return /^(document|document_generate|document_render|doc_generate|file_generate|artifact_generate|markdown|md|html_document|docx|pdf|txt)$/i.test(
    String(type || "")
  );
}

function hasDocumentFileOutputIntent(value = "") {
  const text = String(value || "").toLowerCase();
  if (hasFileWriteProhibition(text)) return false;
  const hasOutputVerb = /生成|创建|输出|保存|导出|写成|制作|渲染|create|generate|write|save|export|render|produce/.test(
    text
  );
  const hasDocumentTarget = /文档|报告文件|文档文件|产物|artifact|document|pdf|docx|word|markdown|html|txt|text/.test(
    text
  );
  return hasOutputVerb && hasDocumentTarget;
}

function hasFileWriteProhibition(value = "") {
  const text = String(value || "").toLowerCase();
  return (
    /(?:不要|不得|禁止|避免|不应|不能|请勿|不允许)[^。.;\n]{0,120}(?:修改|改动|写入|创建|生成|保存|导出|删除)[^。.;\n]{0,80}(?:文件|本地|目录|工作区|仓库)/i.test(
      text
    ) ||
    /(?:do not|don't|never|no|without)[^.\n;]{0,120}(?:modify|write|create|save|export|delete)[^.\n;]{0,80}(?:file|files|local|workspace|repo|repository)/i.test(
      text
    )
  );
}

function isBlockedDocumentGenerationTask(task = {}, goalText = "") {
  const text = [goalText, task.type, task.title, task.description, task.prompt, task.input].filter(Boolean).join("\n");
  const type = String(task.type || task.taskType || "").toLowerCase();
  const toolWorker = String(task.toolWorker || task.tool_worker || "").toLowerCase();
  if (!isDocumentGenerationType(type) && toolWorker !== "document" && toolWorker !== "documents") return false;
  if (hasFileWriteProhibition(text)) return true;
  return !hasDocumentFileOutputIntent(text);
}

function isNonExecutableSynthesisTask(task = {}) {
  const text = [task.type, task.title, task.description, task.prompt, task.input].filter(Boolean).join("\n");
  if (hasDocumentFileOutputIntent(text)) return false;
  if (hasPublicHttpUrl(text)) return false;
  const finalSynthesis =
    /最终(?:报告|答案|回复|总结)|报告生成|总结生成|汇总(?:最终)?答案|final (?:answer|report|response|summary)|synthesi[sz]e final/i.test(
      text
    );
  const ordinarySynthesis =
    /(?:生成|撰写|输出|形成|汇总|综合|编写|写作|synthesi[sz]e|write|generate|produce)[^。.;\n]{0,80}(?:报告|答案|总结|结论|回复|response|answer|report|summary)/i.test(
      text
    );
  return finalSynthesis || ordinarySynthesis;
}

function shouldUseDocumentWorker(messages) {
  const text = lastUserText(messages);
  return !hasFileWriteProhibition(text) && hasDocumentFileOutputIntent(text);
}

function isReadOnlyExternalResearchText(value = "") {
  const text = String(value || "").toLowerCase();
  if (hasExplicitHighRiskBrowserAction(text)) return false;
  const hasExternalReadIntent =
    /联网[^。.;\n]{0,80}(研究|查询|检索|搜索|报告|分析|新闻|数据|资料|信息)/i.test(text) ||
    /查询[^。.;\n]{0,100}(最新|新闻|来源|数据|资料|信息|公开|网页|网络|网站|页面)/i.test(text) ||
    /(搜索|检索|查找|获取)[^。.;\n]{0,100}(最新|实时|当前|今日|今天|新闻|来源|数据|资料|信息|公开|网页|网络|网站|页面)/i.test(
      text
    ) ||
    /联网(?:搜索|检索|查询|读取|研究)/i.test(text) ||
    /真实(?:搜索|检索|查询|读取)(?:公开|网页|网站|网络)?/i.test(text) ||
    /搜索(?:公开|网页|网站|网络|资料|信息|项目)/i.test(text) ||
    /检索(?:公开|网页|网站|网络|资料|信息|项目)/i.test(text) ||
    /查找(?:公开|网页|网站|网络|资料|信息|项目)/i.test(text) ||
    /\b(public\s+)?(web|internet|online)\s+(search|research|lookup|fetch|read)\b/i.test(text) ||
    /\b(search|find|lookup|fetch|read|extract)\b[^.\n]{0,80}\b(public|web|internet|online|url|link|source|api|page|site|job|project|freelance)\b/i.test(
      text
    );
  const needsEvidence = /\b(url|link|source|http|api|page|site)\b|链接|来源|网页|公开页面|公开 API/i.test(text);
  return (
    hasExternalReadIntent || (needsEvidence && /查询|搜索|检索|查找|读取|提取|research|search|find|fetch/i.test(text))
  );
}

function shouldUseWebToolWorker(messages) {
  const text = lastUserText(messages).toLowerCase();
  if (!text) return false;
  if (hasBrowserOrLocalOperationRequiringCodex(text)) return false;
  if (isReadOnlyExternalResearchText(text)) return true;
  return Boolean(
    hasPublicHttpUrl(text) &&
    /\b(read|fetch|extract|summari[sz]e|lookup|research)\b|打开|访问|读取|提取|总结|摘要|查询|检索|搜索/i.test(text)
  );
}

function webToolTaskTypeForText(value = "") {
  const text = String(value || "").toLowerCase();
  if (/\bapi\b|公开\s*api|接口/.test(text)) return "api_read";
  if (/搜索|检索|查找|research|search|find|lookup/.test(text) && !hasPublicHttpUrl(text)) return "web_search";
  return "web_read";
}

function normalizedWebToolTaskType(rawType = "", value = "") {
  const type = String(rawType || "").toLowerCase();
  if (type === "web_search" || type === "public_web_read") return type === "public_web_read" ? "web_read" : type;
  if (
    (type === "api_read" || type === "http_fetch" || type === "web_fetch" || type === "web_read") &&
    !hasPublicHttpUrl(value)
  ) {
    if (/查询|搜索|检索|查找|获取|采集|research|search|find|lookup/i.test(value)) return "web_search";
  }
  if (isWebToolType(type)) return type === "http_fetch" || type === "public_api_read" ? "api_read" : type;
  return webToolTaskTypeForText(value);
}

function isReadOnlyBrowserGoal(messages = []) {
  return isReadOnlyBrowserText(lastUserText(messages));
}

function baselinePlan(messages = []) {
  const input = baselinePlanInput(messages);
  if (shouldUseDocumentWorker(messages)) {
    return {
      tasks: [
        {
          id: "prepare-document-content",
          title: "Prepare document content",
          description: "Prepare the document body from the user goal and any available evidence.",
          type: "analysis",
          modelPool: "free",
          difficulty: "low",
          complexity: "low",
          riskLevel: "low",
          routingReason: "Models may draft document content, but cannot claim a local file has been created.",
          input,
          successCriteria: ["Document body is explicit and grounded in available context."],
          dependencies: [],
          produces: ["document_content"],
          maxAttempts: 1,
          requiresHumanConfirmation: false,
          prompt: "Prepare the document body only. Do not claim any file, PDF, DOCX, or artifact has been created."
        },
        {
          id: "render-document-artifact",
          title: "Render document artifact",
          description: "Render the prepared content into the requested document file format.",
          type: "document_generate",
          modelPool: "free",
          toolWorker: "document",
          difficulty: "low",
          complexity: "low",
          riskLevel: "low",
          routingReason: "Document artifacts must be created by the generic document tool with file evidence.",
          input,
          successCriteria: ["A real artifact path, file size, hash, and format evidence are returned."],
          dependencies: ["prepare-document-content"],
          consumes: ["document_content"],
          produces: ["document_artifact"],
          maxAttempts: 1,
          requiresHumanConfirmation: false,
          prompt: "Render the upstream document content into a real file artifact. Do not invent document content."
        },
        {
          id: "verify-document-artifact",
          title: "Verify document artifact",
          description: "Verify the document artifact exists, is non-empty, and matches the requested format.",
          type: "verification",
          modelPool: "free",
          difficulty: "low",
          complexity: "low",
          riskLevel: "low",
          routingReason: "Rule verification should confirm file evidence before final answer.",
          input,
          successCriteria: ["File exists, is non-empty, and has artifact metadata."],
          dependencies: ["render-document-artifact"],
          consumes: ["document_artifact"],
          maxAttempts: 1,
          requiresHumanConfirmation: false,
          prompt: "Verify the generated document artifact path, size, hash, format, and content coverage."
        }
      ]
    };
  }
  if (shouldUseWebToolWorker(messages)) {
    const type = webToolTaskTypeForText(input);
    return {
      tasks: [
        {
          id: "web-evidence",
          title: type === "web_search" ? "Collect public web search evidence" : "Read the public web source",
          description:
            type === "web_search"
              ? "Use the read-only web tool to search public web results and collect URLs, titles, snippets, and response evidence."
              : "Use the read-only web tool to fetch the public URL/API and collect URL, status, title/text, and response evidence.",
          type,
          modelPool: "free",
          toolWorker: "web",
          difficulty: "low",
          complexity: "low",
          riskLevel: "low",
          riskReasons: [
            "Read-only public web/API evidence collection; no login, submit, upload, payment, or mutation."
          ],
          routingReason: "Network access should be performed by the web tool; models only analyze collected evidence.",
          input,
          successCriteria: ["Real URL/status/title/text or API response evidence is captured."],
          dependencies: [],
          produces: ["web_evidence"],
          maxAttempts: 2,
          requiresHumanConfirmation: false,
          prompt:
            "Collect real read-only public web/API evidence for the user goal. Do not submit, log in, upload, or mutate anything."
        },
        {
          id: "analyze-web-evidence",
          title: "Analyze collected web evidence",
          description: "Analyze the web tool output and answer the user goal using only collected evidence.",
          type: "analysis",
          modelPool: "free",
          difficulty: "low",
          complexity: "low",
          riskLevel: "low",
          routingReason: "Cheap models can summarize and structure evidence after the web tool has collected it.",
          input,
          successCriteria: ["The answer is grounded in the collected URLs/status/body/title/text evidence."],
          dependencies: ["web-evidence"],
          consumes: ["web_evidence"],
          maxAttempts: 1,
          requiresHumanConfirmation: false,
          prompt: "Analyze the prior web evidence and produce a concise grounded answer. Do not claim any new browsing."
        },
        {
          id: "verify",
          title: "Verify evidence-grounded answer",
          description: "Check that the answer cites or relies on real web/API evidence rather than model claims.",
          type: "verification",
          modelPool: "free",
          difficulty: "low",
          complexity: "low",
          riskLevel: "low",
          routingReason: "Rule verification is enough to check evidence presence before final answer.",
          input,
          successCriteria: ["URL/status/title/text or API evidence exists and the answer does not invent sources."],
          dependencies: ["analyze-web-evidence"],
          maxAttempts: 1,
          requiresHumanConfirmation: false,
          prompt: "Verify that the web answer is grounded in collected tool evidence."
        }
      ]
    };
  }
  if (shouldUseCodexCliWorker(messages)) {
    const readOnlyBrowser = isReadOnlyBrowserGoal(messages);
    return {
      tasks: [
        {
          id: "goal-map",
          title: "Map the goal and success criteria",
          description: "Identify the concrete local/browser/terminal outcome required and the acceptance criteria.",
          type: "planning",
          modelPool: "free",
          difficulty: "medium",
          complexity: "medium",
          riskLevel: "low",
          routingReason: "Lightweight planning should be handled by a model before local execution.",
          input,
          successCriteria: ["The execution target and verification checklist are clear."],
          dependencies: [],
          maxAttempts: 2,
          requiresHumanConfirmation: false,
          prompt:
            "Read the user goal, identify the concrete local/browser/terminal outcome required, and prepare an execution checklist."
        },
        {
          id: "execute",
          title: readOnlyBrowser ? "Read the browser page" : "Execute the local task",
          description: readOnlyBrowser
            ? "Open the requested page and collect readable browser evidence."
            : "Perform the requested local/browser/terminal operation.",
          type: readOnlyBrowser ? "browser" : "local_execution",
          modelPool: "codex-cli",
          difficulty: readOnlyBrowser ? "medium" : "high",
          complexity: readOnlyBrowser ? "medium" : "high",
          riskLevel: readOnlyBrowser ? "low" : "high",
          routingReason: readOnlyBrowser
            ? "Requires a real browser read with structured evidence."
            : "Requires actual local computer or terminal action.",
          input,
          successCriteria: [
            readOnlyBrowser
              ? "The page URL/title/text evidence is captured."
              : "The requested operation has been attempted with local tools.",
            "Actions and output are reported."
          ],
          dependencies: ["goal-map"],
          maxAttempts: 2,
          requiresHumanConfirmation: false,
          prompt:
            "Use Codex CLI tools to actually complete the requested local/browser/terminal operation. Do not answer with instructions only."
        },
        {
          id: "verify",
          title: "Verify completion",
          description: "Check the result and report whether the goal is complete.",
          type: "verification",
          modelPool: "free",
          difficulty: "medium",
          complexity: "medium",
          riskLevel: "medium",
          routingReason:
            "Rule verification and lightweight semantic review are enough after execution evidence exists.",
          input,
          successCriteria: ["The final state is checked and reported."],
          dependencies: ["execute"],
          maxAttempts: 1,
          requiresHumanConfirmation: false,
          prompt: "Check the result of the previous step and report whether the user goal is actually complete."
        }
      ]
    };
  }
  return {
    tasks: [
      {
        id: "analyze",
        title: "Analyze the user goal and constraints",
        description: "Extract constraints, hidden requirements, and acceptance criteria.",
        type: "analysis",
        modelPool: "free",
        difficulty: "low",
        complexity: "low",
        riskLevel: "low",
        routingReason: "Low-risk analysis can use the strongest free workers first.",
        input,
        successCriteria: ["Important requirements and constraints are identified."],
        dependencies: [],
        maxAttempts: 2,
        requiresHumanConfirmation: false,
        prompt:
          "Analyze the user goal, constraints, likely hidden requirements, and what must be true for a complete answer."
      },
      {
        id: "solve",
        title: "Produce a complete solution",
        description: "Produce the main answer or implementation plan.",
        type: "solution",
        modelPool: "strong",
        difficulty: "high",
        complexity: "high",
        riskLevel: "medium",
        routingReason: "The main solution needs stronger reasoning.",
        input,
        successCriteria: ["The original user goal is answered completely and practically."],
        dependencies: ["analyze"],
        maxAttempts: 2,
        requiresHumanConfirmation: false,
        prompt: "Produce the best complete answer or implementation strategy. Be specific and avoid hand-waving."
      }
    ]
  };
}

function parsePlannerContent(content) {
  const parsed = protocol.parseProtocolContent(content, protocol.KIND.PLAN, (value) =>
    Array.isArray(value.tasks) && value.tasks.length > 0
      ? { ok: true }
      : { ok: false, error: "Planner response must include a non-empty tasks array." }
  );
  return parsed.ok ? parsed.value : null;
}

function plannerContentDiagnostics(content) {
  const parsed = parsePlannerContent(content);
  return {
    ...jsonParseDiagnostics(content, { allowEmbedded: false, allowRepeatedIdentical: false }),
    hasValidTaskGraph: Boolean(parsed),
    taskCount: parsed && Array.isArray(parsed.tasks) ? parsed.tasks.length : 0
  };
}

function normalizePlan(plan, config, messages = [], strategy = null) {
  const rawTasks = Array.isArray(plan && plan.tasks) ? plan.tasks : [];
  const conversationInput = messagesToText(messages);
  const tasks = rawTasks.slice(0, config.maxTasks).map((task, index) => {
    const rawPool = task.modelPool || task.model_pool || task.recommendedModelPool || task.recommended_model_pool;
    const requestedPoolFromPlan = ["commander", "strong", "coding", "free", "codex-cli"].includes(rawPool)
      ? rawPool
      : "free";
    const explicitInput = firstNonEmptyString(
      task.input,
      task.query,
      task.searchQuery,
      task.search_query,
      task.url,
      task.href,
      task.link
    );
    const input = explicitInput;
    const rawType = String(task.type || task.taskType || task.task_type || requestedPoolFromPlan);
    const description = String(
      task.description || task.taskDescription || task.task_description || task.prompt || task.title || task.goal || ""
    );
    const taskActionText = [rawType, task.title, description, task.prompt, task.routingReason || task.routing_reason]
      .filter(Boolean)
      .join("\n");
    const taskAndInput = [taskActionText, input].join("\n");
    const explicitWebTool = String(task.toolWorker || task.tool_worker || "").toLowerCase() === "web";
    const explicitDocumentTool = ["document", "documents"].includes(
      String(task.toolWorker || task.tool_worker || "").toLowerCase()
    );
    const explicitBrowserTool =
      String(task.toolWorker || task.tool_worker || "").toLowerCase() === "browser" ||
      /^(browser|browser_read|page_read)$/i.test(rawType);
    const explicitWebType = isWebToolType(rawType);
    const explicitDocumentType = isDocumentGenerationType(rawType);
    const taskSpecificRequiresCodex = hasBrowserOrLocalOperationRequiringCodex(taskActionText);
    const broaderInputRequiresCodex =
      !explicitWebType && hasBrowserOrLocalOperationRequiringCodex(explicitInput || conversationInput);
    const taskActionTextWithoutUrls = stripHttpUrls(taskActionText);
    const readOnlyPublicUrlTask =
      hasPublicHttpUrl(taskAndInput) &&
      !taskSpecificRequiresCodex &&
      !/\b(click|fill|type|screenshot|scroll|submit|send|pay|login|upload|delete|publish|点击|填写|输入|截图|滚动|提交|发送|付款|支付|登录|上传|删除|发布)\b/i.test(
        taskActionTextWithoutUrls
      ) &&
      /\b(read|fetch|extract|summari[sz]e|lookup|research|api|url|source|evidence)\b|读取|获取|提取|总结|查询|检索|公开|来源|证据/i.test(
        taskAndInput
      );
    const browserPublicReadWithoutUrl =
      explicitBrowserTool &&
      !hasPublicHttpUrl(taskAndInput) &&
      !/localhost:\d+|127\.0\.0\.1:\d+|data:text\/html|data url/i.test(taskAndInput) &&
      isReadOnlyExternalResearchText(taskAndInput);
    const shouldRouteExternalReadToWeb =
      !isNonExecutablePlanningType(rawType) &&
      !explicitDocumentTool &&
      !explicitDocumentType &&
      !taskSpecificRequiresCodex &&
      !broaderInputRequiresCodex &&
      (explicitWebTool ||
        explicitWebType ||
        browserPublicReadWithoutUrl ||
        readOnlyPublicUrlTask ||
        isReadOnlyExternalResearchText(taskActionText) ||
        (index === 0 && isReadOnlyExternalResearchText(input)));
    const shouldRouteDocumentGeneration =
      !hasFileWriteProhibition([conversationInput, taskActionText, input].join("\n")) &&
      !shouldRouteExternalReadToWeb &&
      !isNonExecutablePlanningType(rawType) &&
      (explicitDocumentTool || explicitDocumentType || hasDocumentFileOutputIntent(taskActionText));
    const shouldRouteLocalToCodex =
      !shouldRouteExternalReadToWeb &&
      !shouldRouteDocumentGeneration &&
      !isNonExecutablePlanningType(rawType) &&
      hasBrowserOrLocalOperationRequiringCodex([taskActionText, explicitInput || conversationInput].join("\n"));
    const requestedPool = shouldRouteExternalReadToWeb
      ? "free"
      : shouldRouteDocumentGeneration
        ? "free"
        : shouldRouteLocalToCodex
          ? "codex-cli"
          : requestedPoolFromPlan;
    const readOnlyBrowserTask =
      requestedPool === "codex-cli" &&
      (isReadOnlyBrowserText([taskActionText, input].filter(Boolean).join("\n")) ||
        (isReadOnlyBrowserGoal(messages) && !hasExplicitHighRiskBrowserAction(taskActionText)));
    const modelPool = normalizeExecutionModelPool(task, requestedPool);
    const difficulty = readOnlyBrowserTask
      ? "medium"
      : normalizeComplexity(task.difficulty || task.complexity, defaultComplexityForPool(modelPool));
    const successCriteria = normalizeStringList(
      task.successCriteria || task.success_criteria || task.acceptanceCriteria || task.acceptance_criteria
    );
    const distinctWebQueryClauseIntent = hasDistinctWebQueryClauseIntent(
      [taskActionText, input, successCriteria.join(" ")].filter(Boolean).join(" ")
    );
    const webAlternativeQueryCriterion =
      shouldRouteExternalReadToWeb &&
      typeof input === "string" &&
      /[\n;；]/.test(input) &&
      !distinctWebQueryClauseIntent
        ? "Semicolon-separated web_search clauses are candidate alternative queries for one evidence gap."
        : "";
    const normalizedSuccessCriteria = successCriteria.length
      ? successCriteria
      : ["Task output satisfies the assigned instruction."];
    const finalSuccessCriteria =
      webAlternativeQueryCriterion &&
      !normalizedSuccessCriteria.some((criterion) => /alternative queries|候选|备选/i.test(criterion))
        ? [...normalizedSuccessCriteria, webAlternativeQueryCriterion]
        : normalizedSuccessCriteria;
    const dependencies = dependencyEngine.normalizeDependencyIds(task);
    const produces = dependencyEngine.normalizeArtifacts(
      task.produces || task.producedArtifacts || task.produced_artifacts,
      task.id || `task_${index + 1}`
    );
    const consumes = dependencyEngine.normalizeArtifacts(
      task.consumes || task.requiredArtifacts || task.required_artifacts,
      ""
    );
    const requiresHumanApproval = normalizeBoolean(
      task.requiresHumanApproval ||
        task.requires_human_approval ||
        task.requiresHumanConfirmation ||
        task.requires_human_confirmation
    );
    const rawMaxAttempts = Number(task.maxAttempts || task.max_attempts || 2);
    const minToolAttempts =
      shouldRouteExternalReadToWeb || shouldRouteDocumentGeneration || readOnlyBrowserTask ? 2 : 1;
    const maxAttempts = Math.max(minToolAttempts, Math.min(Number.isFinite(rawMaxAttempts) ? rawMaxAttempts : 2, 5));
    return {
      id: String(task.id || `task_${index + 1}`),
      title: String(task.title || task.goal || `Task ${index + 1}`),
      description,
      type: shouldRouteExternalReadToWeb
        ? normalizedWebToolTaskType(rawType, taskAndInput)
        : shouldRouteDocumentGeneration
          ? "document_generate"
          : readOnlyBrowserTask
            ? "browser"
            : rawType,
      modelPool,
      toolWorker: shouldRouteExternalReadToWeb
        ? "web"
        : shouldRouteDocumentGeneration
          ? "document"
          : String(task.toolWorker || task.tool_worker || "").toLowerCase() || undefined,
      difficulty,
      complexity: difficulty,
      riskLevel: shouldRouteExternalReadToWeb
        ? "low"
        : readOnlyBrowserTask
          ? "low"
          : normalizeRiskLevel(task.riskLevel || task.risk_level || task.risk || "low"),
      riskReasons: normalizeStringList(task.riskReasons || task.risk_reasons),
      input: shouldRouteExternalReadToWeb ? input : input || conversationInput,
      successCriteria: finalSuccessCriteria,
      dependencies,
      dependsOn: dependencies,
      produces:
        shouldRouteExternalReadToWeb && !produces.length
          ? ["web_evidence"]
          : shouldRouteDocumentGeneration && !produces.length
            ? ["document_artifact"]
            : produces,
      consumes,
      priority: Number.isFinite(Number(task.priority)) ? Number(task.priority) : 0,
      retryPolicy:
        task.retryPolicy && typeof task.retryPolicy === "object"
          ? task.retryPolicy
          : task.retry_policy && typeof task.retry_policy === "object"
            ? task.retry_policy
            : {},
      strategyId: String(task.strategyId || task.strategy_id || (strategy && strategy.id) || ""),
      strategicObjective: String(
        task.strategicObjective || task.strategic_objective || (strategy && strategy.objective) || ""
      ),
      strategicPhase: String(
        task.strategicPhase ||
          task.strategic_phase ||
          (strategy && strategy.phasePlan && strategy.phasePlan[0] && strategy.phasePlan[0].id) ||
          ""
      ),
      strategicRationale: String(
        task.strategicRationale || task.strategic_rationale || task.routingReason || task.routing_reason || ""
      ),
      maxAttempts,
      requiresHumanApproval,
      requiresHumanConfirmation: requiresHumanApproval,
      routingReason: shouldRouteExternalReadToWeb
        ? String(
            task.routingReason ||
              task.routing_reason ||
              task.reason ||
              "Read-only networking is handled by the web tool; models analyze collected evidence."
          )
        : shouldRouteDocumentGeneration
          ? String(
              task.routingReason ||
                task.routing_reason ||
                task.reason ||
                "Document files are rendered by the generic document tool with file evidence and artifacts."
            )
          : String(task.routingReason || task.routing_reason || task.reason || ""),
      prompt: shouldRouteExternalReadToWeb
        ? String(
            task.prompt ||
              task.title ||
              task.goal ||
              "Use the read-only web tool to collect real URL/status/title/text/API evidence."
          )
        : shouldRouteDocumentGeneration
          ? String(
              task.prompt ||
                task.title ||
                task.goal ||
                "Render upstream document content into a real file artifact with path, size, hash, and format evidence."
            )
          : String(task.prompt || task.title || task.goal || "Work on the user goal.")
    };
  });
  return {
    tasks: tasks.filter(
      (task) => !isNonExecutableSynthesisTask(task) && !isBlockedDocumentGenerationTask(task, conversationInput)
    )
  };
}

function recoverPlannerAttempt(attempt, messages, config, trace, reason = "") {
  if (trace && reason) {
    trace.push({
      label: "plan:recovery-disabled",
      model: (attempt && attempt.model) || "commander",
      ok: false,
      reason: String(reason || "planner model unavailable or returned an invalid plan").slice(0, 240)
    });
  }
  return attempt;
}

function makePlanPrompt(messages, config, memoryText = "", strategy = null) {
  const needsLocalExecution = shouldUseCodexCliWorker(messages);
  const needsWebTool = shouldUseWebToolWorker(messages);
  const needsDocumentTool = shouldUseDocumentWorker(messages);
  const maxTasks = Math.max(1, Math.min(Number((config && config.maxTasks) || 3), 3));
  return [
    {
      role: "system",
      content: [
        "[角色]\nAgentRoute planner。",
        "[任务]\n根据用户目标规划下一批可执行任务，计划不是执行结果。",
        protocol.baseContract(protocol.KIND.PLAN),
        runtimeTemporalContext(),
        `planner 输出描述的是待执行任务，不是已完成动作；最多 ${maxTasks} 个任务，字段短，input 用短查询/URL，不写整段需求。`,
        needsWebTool
          ? "只读联网取证: type web_search/web_read/api_read，toolWorker 为 web，modelPool 为 free，要求 URL/status/title/text/API evidence。"
          : "",
        needsWebTool
          ? "web_search input 必须是你选择的精准查询；可用分号列 2-4 个候选，覆盖标准英文/代码/缩写/口径。工具层只执行你的查询或 URL，不替你选来源。"
          : "",
        needsWebTool
          ? "不同事实/数据点拆成不同 web task；分号只用于同一事实的候选查询，不要把汇率、收益率、新闻等独立缺口塞进一个任务。"
          : "",
        needsWebTool
          ? "不确定公开 URL/API 时先 source-discovery web_search；已有公开可读 URL/API 才 web_read/api_read。不要默认把某个来源名、站点名或域名塞进查询。"
          : "",
        needsWebTool
          ? "普通公开网页取证不使用 browser。只有确实需要点击、填写、滚动、截图、视觉检查、JS 渲染、本地页面、data URL，或已有 web evidence 明确证明 HTTP 读取无法取得内容时，才规划 type browser/toolWorker browser，并必须给出具体 URL 和原因。"
          : "",
        needsDocumentTool
          ? "文档输出要拆内容准备和真实文件生成；文件生成用 type document_generate、toolWorker document、modelPool free，要求 path/format/size/hash/createdAt evidence。"
          : "",
        needsDocumentTool ? "文档工具只渲染上游内容，不补事实、不伪造成果；缺内容或文件验证失败就继续或失败。" : "",
        needsLocalExecution
          ? "只有真实浏览器自动化或本地电脑自动化 worker 才用 codex-cli；公开联网取证用 web tool，文档渲染用 document tool。"
          : "如果不需要真实本地执行，避免使用 codex-cli。",
        "submit/login/upload/send/pay/delete/publish/deploy 标 high/critical 并要求人工确认。",
        "不要为“最终报告、最终答案、总结汇总”单独创建普通 worker；先规划取证任务，证据足够后由 review/final 收口。"
      ]
        .filter(Boolean)
        .join("\n")
    },
    {
      role: "user",
      content: compactPromptBlock(messagesToText(messages), 520)
    }
  ];
}

module.exports = {
  baselinePlan,
  baselinePlanInput,
  defaultComplexityForPool,
  parsePlannerContent,
  plannerContentDiagnostics,
  recoverPlannerAttempt,
  makePlanPrompt,
  normalizeBoolean,
  normalizeComplexity,
  normalizePlan,
  normalizeRiskLevel,
  normalizeStringList,
  shouldUseCodexCliWorker,
  shouldUseDocumentWorker,
  shouldUseWebToolWorker,
  hasFileWriteProhibition,
  webToolTaskTypeForText
};
