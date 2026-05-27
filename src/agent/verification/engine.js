"use strict";

const fs = require("fs");
const path = require("path");
const { DEFAULT_VERIFICATION_POLICY } = require("../../config/loader");
const filesTool = require("../../tools/files");
const riskEngine = require("../risk");
const authenticityEngine = require("./authenticity");
const workerEvidence = require("./evidence");
const fileIntent = require("./file-intent");

const VERIFICATION_STATUS = Object.freeze({
  VERIFIED: "verified",
  PARTIALLY_VERIFIED: "partially_verified",
  UNVERIFIED: "unverified"
});

const SUGGESTED_NEXT_STATE = Object.freeze({
  COMPLETED: "completed",
  RETRYING: "retrying",
  NEEDS_EVIDENCE: "needs_evidence",
  FAILED: "failed",
  BLOCKED: "blocked",
  WAITING_HUMAN: "waiting_human"
});

const SUCCESS_WORDS = [
  "success",
  "successful",
  "saved",
  "created",
  "updated",
  "completed",
  "done",
  "submitted",
  "sent",
  "published",
  "passed",
  "built",
  "generated",
  "成功",
  "已保存",
  "已创建",
  "已更新",
  "已完成",
  "已提交",
  "已发送",
  "通过",
  "生成"
];

const ERROR_WORDS = [
  "error",
  "failed",
  "failure",
  "exception",
  "traceback",
  "denied",
  "forbidden",
  "not found",
  "timeout",
  "oops, something went wrong",
  "something went wrong",
  "try again later",
  "will be right back",
  "temporarily unavailable",
  "service unavailable",
  "enable javascript",
  "captcha",
  "verify you are human",
  "login required",
  "sign in required",
  "authentication required",
  "错误",
  "失败",
  "异常",
  "拒绝",
  "禁止",
  "未找到",
  "超时",
  "验证码",
  "需要登录",
  "请登录"
];

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function collapseText(value) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeLoginGate(text = "", browser = {}) {
  if (browser.loginPage) return true;
  const collapsed = collapseText(text);
  if (!collapsed) return false;
  if (
    /\b(login required|sign in required|please sign in|please log in|authentication required|unauthorized|password required|2fa|otp)\b/i.test(
      collapsed
    )
  ) {
    return true;
  }
  if (/(需要|请|必须|先).{0,10}(登录|登陆|认证)|登录后|登陆后|验证码|密码/.test(collapsed)) return true;
  const hasLoginLabel = /\b(sign in|log in|login)\b/i.test(collapsed) || /登录|登陆/.test(collapsed);
  const hasCredentialField = /\b(password|username|email address|forgot password|remember me)\b/i.test(collapsed);
  return hasLoginLabel && hasCredentialField;
}

function redactSensitive(value) {
  let text = String(value == null ? "" : value);
  const patterns = [
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    /\b(ghp|github_pat|glpat|xox[baprs]|sk|rk|pk_live|pk_test)_[A-Za-z0-9_=-]{12,}/gi,
    /\b(sk|rk)-[A-Za-z0-9_-]{16,}/gi,
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|token|password|passwd|pwd|cookie|secret)\b\s*[:=]\s*['"]?[^'"\s]{8,}/gi
  ];
  for (const pattern of patterns) text = text.replace(pattern, "[REDACTED_SECRET]");
  return text;
}

function uniqueList(values, limit = 80) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = collapseText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeWorkerResult(result = {}) {
  const context = result.context && typeof result.context === "object" ? result.context : {};
  const evidence = workerEvidence.normalizeEvidence(result.evidence, {
    context,
    artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
    actions: Array.isArray(result.actions) ? result.actions : [],
    output: result.output || result.result || result.content || ""
  });
  const evidenceContext = workerEvidence.evidenceToContext(evidence);
  return {
    status: String(result.status || result.outcome || ""),
    actions: Array.isArray(result.actions) ? result.actions : [],
    output: result.output || result.result || result.content || "",
    error: result.error || "",
    nextStep: result.nextStep || result.next_step || "",
    artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
    evidence,
    blockedReason: result.blockedReason || result.blocked_reason || "",
    context: {
      ...context,
      ...evidenceContext
    }
  };
}

function actionText(action) {
  if (action == null) return "";
  if (typeof action === "string") return action;
  if (typeof action !== "object") return String(action);
  return [
    action.type,
    action.kind,
    action.action,
    action.name,
    action.label,
    action.text,
    action.selector,
    action.url,
    action.command,
    action.path,
    action.target
  ]
    .filter(Boolean)
    .join(" ");
}

function allText(task = {}, workerResult = {}) {
  return [
    task.title,
    task.description,
    task.type,
    task.prompt,
    Array.isArray(task.successCriteria) ? task.successCriteria.join(" ") : "",
    workerResult.output,
    workerResult.error,
    workerResult.nextStep,
    workerResult.evidence && workerResult.evidence.summary,
    workerResult.evidence && Array.isArray(workerResult.evidence.claims) ? workerResult.evidence.claims.join(" ") : "",
    workerResult.actions.map(actionText).join(" ")
  ]
    .filter(Boolean)
    .join(" ");
}

function hasAnyWord(text, words) {
  const value = String(text || "").toLowerCase();
  return words.some((word) => value.includes(word));
}

function normalizePath(value, cwd) {
  const raw = String(value || "").trim();
  if (!raw || raw.includes("[REDACTED")) return "";
  const withoutLine = raw.replace(/:\d+(?::\d+)?$/, "");
  if (!withoutLine || /^https?:\/\//i.test(withoutLine)) return "";
  return path.isAbsolute(withoutLine) ? withoutLine : path.resolve(cwd, withoutLine);
}

function recordFileIntent(state, raw, intent) {
  if (!state) return;
  state.fileIntentChecks = Array.isArray(state.fileIntentChecks) ? state.fileIntentChecks : [];
  state.fileIntentChecks.push({
    input: redactSensitive(raw).slice(0, 240),
    normalized: redactSensitive(intent.normalized || "").slice(0, 240),
    source: intent.source || "",
    isFile: Boolean(intent.isFile),
    confidence: intent.confidence,
    reason: intent.reason || ""
  });
  if (!intent.isFile && intent.confidence < 0.62) {
    state.falseFileDetectionCount = Number(state.falseFileDetectionCount || 0) + 1;
  }
}

function collectFileCandidates(task = {}, workerResult = {}, context = {}, state = null) {
  const cwd = context.cwd || workerResult.context.cwd || process.env.AGENT_ROUTE_CODEX_CWD || process.cwd();
  const candidates = [];
  const push = (raw, source, extra = {}) => {
    const intent = fileIntent.detectFileIntent(raw, { source });
    recordFileIntent(state, raw, intent);
    if (!intent.isFile) return;
    const filePath = normalizePath(raw, cwd);
    if (!filePath) return;
    candidates.push({
      path: filePath,
      source,
      fileIntentConfidence: intent.confidence,
      fileIntentReason: intent.reason,
      ...extra
    });
  };

  for (const file of workerResult.evidence && Array.isArray(workerResult.evidence.files)
    ? workerResult.evidence.files
    : []) {
    push(file.path || file.file || file.target, "evidence", file);
  }
  for (const artifact of workerResult.artifacts || []) {
    if (!artifact) continue;
    if (typeof artifact === "string") push(artifact, "artifact");
    else push(artifact.path || artifact.file || artifact.filename || artifact.target, "artifact", artifact);
  }
  const ctxFiles = [
    ...(Array.isArray(workerResult.context.files) ? workerResult.context.files : []),
    ...(Array.isArray(context.files) ? context.files : [])
  ];
  for (const file of ctxFiles) {
    if (typeof file === "string") push(file, "context");
    else push(file.path || file.file || file.target, "context", file);
  }

  if (!candidates.length) {
    const text = allText(task, workerResult);
    const pathPattern =
      /(?:^|\s)(\.{0,2}\/[A-Za-z0-9._/-]+|\/[A-Za-z0-9._/-]+|[A-Za-z0-9_-]+\.(?:js|ts|tsx|jsx|json|md|txt|html|css|csv|yaml|yml|toml|env|png|jpg|jpeg|webp|svg|pdf|docx|xlsx))(?:\s|$|[.,;])/g;
    let match;
    while ((match = pathPattern.exec(text))) push(match[1], "text");
  }

  const seen = new Set();
  return candidates
    .filter((item) => {
      if (seen.has(item.path)) return false;
      seen.add(item.path);
      return true;
    })
    .slice(0, 20);
}

function fileSize(filePath) {
  return filesTool.fileSize(filePath);
}

function safeReadSmall(filePath, max = 200000) {
  const result = filesTool.readTextFile(filePath, { maxBytes: max });
  return result.ok ? result.content : "";
}

function isDocumentOutputTask(task = {}, workerResult = {}) {
  const type = String(task.type || task.taskType || "").toLowerCase();
  const toolWorker = String(task.toolWorker || task.tool_worker || "").toLowerCase();
  if (
    /^(document|document_generate|document_render|doc_generate|file_generate|artifact_generate|markdown|md|html_document|docx|pdf|txt)$/i.test(
      type
    ) ||
    toolWorker === "document" ||
    toolWorker === "documents"
  )
    return true;
  const taskText = [task.title, task.description, task.prompt, task.input].filter(Boolean).join("\n").toLowerCase();
  return /(?:输出|生成|创建|保存|导出|渲染|write|generate|create|save|export|render)[^。.;\n]{0,80}(?:文档文件|报告文件|本地文件|文件产物|artifact|document file|pdf file|docx file|markdown file|html file|text file|\.pdf|\.docx|\.md|\.html?|\.txt)/i.test(
    taskText
  );
}

function explicitFileClaimText(task = {}, workerResult = {}) {
  return [
    task.type,
    task.title,
    task.description,
    task.prompt,
    task.input,
    workerResult.nextStep,
    workerResult.actions.map(actionText).join(" ")
  ]
    .filter(Boolean)
    .join("\n");
}

function hasExplicitFileOutputClaim(task = {}, workerResult = {}) {
  const text = explicitFileClaimText(task, workerResult);
  return (
    /(?:file path|saved to|written to|created file|generated file|updated file|artifact path|文件路径|保存到|写入到|创建文件|生成文件|更新文件|文件产物|报告文件|文档文件)/i.test(
      text
    ) ||
    /(?:write|generate|create|save|export|render|update|输出|生成|创建|保存|导出|渲染|写入|更新)[^。.;\n]{0,100}(?:file|artifact|document|\.pdf|\.docx|\.md|\.html?|\.txt|文件|产物|文档)/i.test(
      text
    )
  );
}

function requestedDocumentFormat(task = {}, workerResult = {}) {
  const artifacts = Array.isArray(workerResult.artifacts) ? workerResult.artifacts : [];
  const artifactFormat = artifacts
    .map((item) => (item && typeof item === "object" ? item.format || item.type : ""))
    .find(Boolean);
  const text =
    `${task.type || ""} ${task.title || ""} ${task.description || ""} ${task.prompt || ""} ${task.input || ""} ${artifactFormat || ""}`.toLowerCase();
  if (/\bdocx\b|\.docx\b|\bword\b|word 文档/.test(text)) return "docx";
  if (/\bpdf\b|\.pdf\b/.test(text)) return "pdf";
  if (/\bhtml?\b|\.html?\b/.test(text)) return "html";
  if (/\bmarkdown\b|\.md\b|\bmd\b/.test(text)) return "md";
  if (/\btxt\b|\.txt\b|纯文本|text file/.test(text)) return "txt";
  return "";
}

function fileFormatLooksValid(filePath = "", format = "") {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  const requested = String(format || ext).toLowerCase();
  if (requested && ext && requested !== "markdown" && requested !== "text" && requested !== ext) return false;
  if (requested === "pdf") {
    const header = fs.readFileSync(filePath, { encoding: "utf8", flag: "r" }).slice(0, 5);
    return header === "%PDF-";
  }
  if (requested === "docx") {
    const stat = fs.statSync(filePath);
    const buffer = fs.readFileSync(filePath);
    return (
      stat.size > 0 && buffer.slice(0, 2).toString("utf8") === "PK" && buffer.includes(Buffer.from("word/document.xml"))
    );
  }
  if (requested === "html" || requested === "htm") {
    const content = safeReadSmall(filePath, 20000).toLowerCase();
    return /<!doctype html|<html[\s>]/i.test(content);
  }
  if (requested === "md" || requested === "markdown" || requested === "txt" || requested === "text") {
    return safeReadSmall(filePath, 20000).trim().length > 0;
  }
  return true;
}

function parseJsonContent(content) {
  if (!content) return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(content) };
  } catch {
    return { ok: false, value: null };
  }
}

function valuesMatch(actual, expected) {
  if (expected == null) return true;
  if (actual == null) return false;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    return expected.every((expectedItem) => actual.some((actualItem) => valuesMatch(actualItem, expectedItem)));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([key, value]) => valuesMatch(actual[key], value));
  }
  return String(actual) === String(expected);
}

function compactExpectedContent(value) {
  if (value == null || value === "") return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  const text = collapseText(value);
  return text === "[object Object]" ? "" : text;
}

function addReason(state, reason, confidence = 0.08) {
  const text = collapseText(reason);
  if (!text) return;
  state.reasons.push(text);
  state.confidence += confidence;
}

function addIssue(state, issue, severity = "medium", retryable = true, confidencePenalty = 0.14) {
  const text = collapseText(issue);
  if (!text) return;
  state.detectedIssues.push({ issue: text, severity, retryable });
  state.confidence -= confidencePenalty;
}

function addRiskFinding(state, riskLevel, reason, details = {}, blockedReason = "") {
  const normalized = riskEngine.normalizeRiskLevel(riskLevel || "medium");
  const finding = {
    riskLevel: normalized,
    reason: collapseText(reason),
    details: sanitizeDetails(details),
    blockedReason: blockedReason || ""
  };
  state.riskFindings.push(finding);
  if (normalized === "critical" || blockedReason) addIssue(state, reason, "critical", false, 0.35);
}

function reasonCodeForIssue(issue = {}) {
  const text = collapseText(issue.issue || issue).toLowerCase();
  if (/risk|approval|captcha|human challenge|unexpected file deletion|删除/.test(text)) return "risk_blocked";
  if (/authenticity|false success|hallucination/.test(text)) return "authenticity_untrusted";
  if (/web search|result-page|task query|unrelated/.test(text)) return "web_evidence_rejected";
  if (/api response|status|body/.test(text)) return "api_evidence_missing";
  if (/browser|dom|url|confirmation|login/.test(text)) return "browser_evidence_missing";
  if (/file|artifact|document|directory/.test(text)) return "file_evidence_missing";
  if (/shell|exit code|stderr|command/.test(text)) return "shell_evidence_missing";
  if (/standardized evidence|empty output|too thin|success criteria|semantic/.test(text))
    return "semantic_evidence_missing";
  return "evidence_insufficient";
}

function reasonCodeForVerification(state = {}, verificationStatus = VERIFICATION_STATUS.UNVERIFIED) {
  if (verificationStatus === VERIFICATION_STATUS.VERIFIED) return "verified";
  if (verificationStatus === VERIFICATION_STATUS.PARTIALLY_VERIFIED) return "partially_verified";
  const issues = Array.isArray(state.detectedIssues) ? state.detectedIssues : [];
  if (!issues.length) return "evidence_insufficient";
  const critical = issues.find((issue) => String(issue.severity || "").toLowerCase() === "critical");
  return reasonCodeForIssue(critical || issues[0]);
}

function evidenceRequirementKind(task = {}, workerResult = {}) {
  const type = String(task.type || "").toLowerCase();
  const toolWorker = String(task.toolWorker || task.tool_worker || "").toLowerCase();
  const model = String(workerResult.model || workerResult.context?.model || "").toLowerCase();
  if (/shell|terminal|local_execution/.test(type) || String(task.modelPool || "").toLowerCase() === "codex-cli")
    return "shell_execution";
  if (
    toolWorker === "web" ||
    model === "web-tool" ||
    /^(web_search|web_read|api_read|web_fetch|http_fetch)$/.test(type)
  )
    return type === "web_search" ? "web_search_result" : type === "api_read" ? "api_response" : "web_page";
  if (toolWorker === "document" || /document|docx|pdf|markdown|html_document|artifact/.test(type))
    return "file_artifact";
  if (/browser/.test(type) || toolWorker === "browser") return "browser_observation";
  return "semantic_evidence";
}

function evidenceRequirementFields(kind = "") {
  if (kind === "web_search_result" || kind === "web_page") return ["url", "status", "title", "text", "timestamp"];
  if (kind === "api_response") return ["url", "status", "body", "timestamp"];
  if (kind === "file_artifact") return ["path", "fileType", "size", "hash", "createdAt"];
  if (kind === "browser_observation") return ["url", "title", "visibleText", "timestamp"];
  if (kind === "shell_execution") return ["command", "exitCode", "stdout", "stderr", "timestamp"];
  return ["summary", "claims", "criteriaCoverage"];
}

function buildMissingEvidence(state = {}, task = {}, workerResult = {}, context = {}, verificationStatus = "") {
  if (verificationStatus === VERIFICATION_STATUS.VERIFIED) return [];
  const issues = Array.isArray(state.detectedIssues) ? state.detectedIssues : [];
  const kind = evidenceRequirementKind(task, workerResult);
  const descriptions = issues.length
    ? issues.slice(0, 6).map((issue) => collapseText(issue.issue || issue))
    : ["Verification did not receive enough independent evidence to confirm task completion."];
  return uniqueList(descriptions, 6).map((description, index) => ({
    id: `${task.id || "task"}:missing_evidence:${index + 1}`,
    taskId: String(task.id || ""),
    kind,
    reasonCode: reasonCodeForIssue(issues[index] || {}),
    description,
    requiredFields: evidenceRequirementFields(kind),
    retryable: issues[index] ? issues[index].retryable !== false : true,
    sourcePhase: String(context.phase || "after_worker")
  }));
}

function buildRejectedEvidence(state = {}, task = {}) {
  const issues = Array.isArray(state.detectedIssues) ? state.detectedIssues : [];
  return issues.slice(0, 12).map((issue, index) => ({
    id: `${task.id || "task"}:rejected_evidence:${index + 1}`,
    taskId: String(task.id || ""),
    reasonCode: reasonCodeForIssue(issue),
    reason: collapseText(issue.issue || issue),
    severity: String(issue.severity || "medium"),
    retryable: issue.retryable !== false
  }));
}

function sanitizeDetails(details = {}) {
  const out = {};
  for (const [key, value] of Object.entries(details || {})) {
    if (value == null) continue;
    if (typeof value === "string") out[key] = redactSensitive(value).slice(0, 400);
    else if (Array.isArray(value))
      out[key] = value
        .slice(0, 12)
        .map((item) => (typeof item === "string" ? redactSensitive(item).slice(0, 220) : item));
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else out[key] = redactSensitive(JSON.stringify(value)).slice(0, 400);
  }
  return out;
}

function evaluateBrowserVerification(state, task = {}, workerResult = {}, context = {}) {
  const evidence = workerResult.evidence || {};
  const normalizedBrowserEvidence = [
    ...(Array.isArray(evidence.browserEvidence) ? evidence.browserEvidence : []),
    ...(evidence.normalizedEvidence && Array.isArray(evidence.normalizedEvidence.browser)
      ? evidence.normalizedEvidence.browser
      : [])
  ];
  const primaryBrowserEvidence = normalizedBrowserEvidence[0] || {};
  const browser = {
    ...primaryBrowserEvidence,
    ...(workerResult.context.browser || {}),
    ...(context.browser || {}),
    ...((workerResult.evidence && workerResult.evidence.browser) || {})
  };
  const actions = workerResult.actions.map(actionText);
  const explicitBrowserTask = /\b(browser|browser_read|web_read|page_read|navigate|网页|浏览器)\b/i.test(
    `${task.type || ""} ${task.modelPool || ""}`
  );
  const explicitBrowserAction = actions.some((action) =>
    /\b(open page|navigate|click|scroll|fill|browser|screenshot|snapshot|打开网页|浏览器|点击|滚动|截图)\b/i.test(
      action
    )
  );
  const hasBrowserAction = explicitBrowserTask || explicitBrowserAction;
  if (!hasBrowserAction) return;

  const beforeUrl = browser.beforeUrl || browser.previousUrl || "";
  const afterUrl = browser.afterUrl || browser.currentUrl || browser.url || "";
  if (beforeUrl && afterUrl && beforeUrl !== afterUrl) addReason(state, "Browser URL changed after the action.", 0.18);
  else if (afterUrl) addReason(state, "Browser current URL was captured.", 0.08);
  const browserPageText = browser.pageText || browser.textPreview || browser.visibleText || "";
  if (collapseText(browserPageText).length >= 20) addReason(state, "Browser page text evidence was captured.", 0.17);
  if (browser.screenshotPath) addReason(state, "Browser screenshot evidence was captured.", 0.08);
  if (browser.snapshotPath) addReason(state, "Browser page snapshot evidence was captured.", 0.08);
  if (browser.navigated || browser.navigation === true) addReason(state, "Browser navigation was observed.", 0.14);
  if (browser.domChanged || browser.dom_changed || Number(browser.domChangeCount || 0) > 0)
    addReason(state, "DOM change was observed.", 0.14);
  if (
    browser.successMessage ||
    browser.success_message ||
    hasAnyWord(browser.message || browserPageText || "", SUCCESS_WORDS)
  ) {
    addReason(state, "Success message was observed on the page.", 0.24);
  }
  if (
    browser.buttonDisabled ||
    browser.submitButtonDisabled ||
    browser.submitButtonDisappeared ||
    browser.formDisappeared
  ) {
    addReason(state, "Submit controls changed state after the action.", 0.14);
  }
  if (browser.errorMessage || hasAnyWord(browser.errorText || browserPageText || "", ERROR_WORDS)) {
    addIssue(
      state,
      `Browser reported an error: ${redactSensitive(browser.errorMessage || browser.errorText || "error text found")}`,
      "high",
      true,
      0.24
    );
  }
  if (looksLikeLoginGate(browserPageText, browser)) {
    addIssue(state, "Browser still appears to be on a login page.", "high", true, 0.24);
  }
  if (browser.captcha || /\b(captcha|verify you are human|验证码)\b/i.test(browserPageText)) {
    addIssue(state, "Browser verification found a captcha or human challenge.", "high", false, 0.2);
    addRiskFinding(state, "high", "Browser action hit a captcha or human challenge.", { afterUrl });
  }

  const submitLike =
    actions.some((action) =>
      /\b(submit|send|apply|publish|pay|delete|提交|发送|申请|发布|支付|删除)\b/i.test(action)
    ) || /submit|delete|payment|publish|login|upload/i.test(String(browser.detectedActionType || ""));
  if (
    submitLike &&
    !(beforeUrl && afterUrl && beforeUrl !== afterUrl) &&
    !browser.successMessage &&
    !browser.submitButtonDisabled &&
    !browser.submitButtonDisappeared &&
    !browser.formDisappeared
  ) {
    addIssue(state, "Browser submit-like action has no independent confirmation.", "high", true, 0.3);
  }
}

function fileRole(file = {}) {
  return String(
    file.evidenceRole ||
      file.evidence_role ||
      file.role ||
      file.kind ||
      file.changeType ||
      file.change_type ||
      file.operation ||
      ""
  ).toLowerCase();
}

function fileRoleIndicatesMutation(file = {}) {
  return /write|create|created|generated|render|rendered|save|saved|export|output|artifact|document|modified|updated|写入|创建|生成|保存|导出|渲染|产物|文档|修改|更新/.test(
    fileRole(file)
  );
}

function fileRoleIndicatesReadOnly(file = {}) {
  return /read|readonly|read_only|inspect|inspection|stat|metadata|inventory|source|reference|observe|observation|读取|只读|查看|检查|盘点|元数据|清单|来源|参考|观察/.test(
    fileRole(file)
  );
}

function fileHasObservedSizeChange(file = {}) {
  const beforeSize = Number(file.beforeSize ?? file.before_size ?? NaN);
  const afterSize = Number(file.afterSize ?? file.after_size ?? NaN);
  if (!Number.isFinite(beforeSize) || !Number.isFinite(afterSize) || beforeSize === afterSize) return false;
  if (fileRoleIndicatesMutation(file)) return true;
  if (fileRoleIndicatesReadOnly(file)) return false;
  if (beforeSize <= 0 && !file.beforeHash && !file.before_hash) return false;
  return true;
}

function fileHasObservedWrite(file = {}) {
  const beforeHash = String(file.beforeHash || file.before_hash || "");
  const afterHash = String(file.afterHash || file.after_hash || "");
  if (beforeHash && afterHash && beforeHash !== afterHash) return true;
  if (fileHasObservedSizeChange(file)) return true;
  return fileRoleIndicatesMutation(file);
}

function shouldVerifyExpectedFileContent(file = {}, { documentOutput = false, expectsFile = false } = {}) {
  const source = String(file.source || "").toLowerCase();
  if (source === "artifact") return true;
  if (documentOutput) return true;
  if (file.expectedContentRequired || file.expected_content_required || file.verifyContent || file.verify_content)
    return true;
  if (fileRoleIndicatesReadOnly(file)) return false;
  if (/artifact|output|generated|created|written|document|产物|输出|生成|创建|写入|文档/.test(fileRole(file)))
    return true;
  return Boolean(expectsFile && fileHasObservedWrite(file));
}

function evaluateFileVerification(state, task = {}, workerResult = {}, context = {}) {
  if (isReadOnlyWebToolResult(task, workerResult)) return;
  const documentOutput = isDocumentOutputTask(task, workerResult);
  const expectsFile = documentOutput || hasExplicitFileOutputClaim(task, workerResult);
  const files = collectFileCandidates(task, workerResult, context, state);
  const changes = [
    ...(Array.isArray(workerResult.context.fileChanges) ? workerResult.context.fileChanges : []),
    ...(Array.isArray(context.fileChanges) ? context.fileChanges : []),
    ...(workerResult.evidence && Array.isArray(workerResult.evidence.sideEffects)
      ? workerResult.evidence.sideEffects
      : [])
  ];
  if (!expectsFile && !files.length && !changes.length) return;
  if (!files.length) {
    if (!changes.length)
      addIssue(
        state,
        "Worker claimed file output but did not provide a verifiable file path or artifact.",
        "high",
        true,
        0.28
      );
  } else {
    const requestedFormat = documentOutput ? requestedDocumentFormat(task, workerResult) : "";
    for (const file of files) {
      if (file.fileIntentConfidence != null) {
        addReason(state, `File intent accepted: ${file.path} (${file.fileIntentConfidence})`, 0.02);
      }
      const exists = filesTool.fileExists(file.path);
      if (!exists) {
        addIssue(state, `Expected file does not exist: ${file.path}`, "high", true, 0.24);
        continue;
      }
      const size = fileSize(file.path);
      if (size <= 0) {
        addIssue(state, `Verified file is empty: ${file.path}`, "medium", true, 0.16);
      } else {
        addReason(state, `Verified file exists: ${file.path}`, 0.18);
      }
      if (size > 50 * 1024 * 1024) {
        addIssue(state, `Verified file is unusually large: ${file.path}`, "medium", false, 0.1);
      }
      if (documentOutput && requestedFormat) {
        try {
          if (fileFormatLooksValid(file.path, requestedFormat)) {
            addReason(state, `Verified document format ${requestedFormat}: ${file.path}`, 0.16);
          } else {
            addIssue(
              state,
              `Document artifact does not match requested format ${requestedFormat}: ${file.path}`,
              "high",
              true,
              0.24
            );
          }
        } catch (err) {
          addIssue(
            state,
            `Document artifact could not be parsed as ${requestedFormat}: ${err && err.message ? err.message : String(err)}`,
            "high",
            true,
            0.22
          );
        }
      }
      if (fileHasObservedSizeChange(file)) {
        addReason(state, `Verified file size changed: ${file.path}`, 0.14);
      }
      const expectedContentObject =
        file.expectedContentObject ||
        file.expected_content_object ||
        context.expectedContentObject ||
        context.expected_content_object ||
        workerResult.context.expectedContentObject ||
        workerResult.context.expected_content_object ||
        null;
      if (expectedContentObject && typeof expectedContentObject === "object") {
        if (shouldVerifyExpectedFileContent(file, { documentOutput, expectsFile })) {
          const content = safeReadSmall(file.path);
          const parsed = parseJsonContent(content);
          if (parsed.ok && valuesMatch(parsed.value, expectedContentObject)) {
            addReason(state, `Verified expected JSON fields in file: ${file.path}`, 0.2);
          } else {
            addIssue(state, `Expected JSON fields were not confirmed in file: ${file.path}`, "medium", true, 0.12);
          }
        } else {
          addReason(state, `Read-only file evidence recorded without output-content verification: ${file.path}`, 0.04);
        }
      } else {
        const expectedContent = compactExpectedContent(
          file.expectedContent || context.expectedContent || workerResult.context.expectedContent || ""
        );
        if (expectedContent) {
          if (shouldVerifyExpectedFileContent(file, { documentOutput, expectsFile })) {
            const content = safeReadSmall(file.path);
            if (content && content.includes(expectedContent))
              addReason(state, `Verified expected content in file: ${file.path}`, 0.2);
            else addIssue(state, `Expected content was not found in file: ${file.path}`, "high", true, 0.22);
          } else {
            addReason(
              state,
              `Read-only file evidence recorded without output-content verification: ${file.path}`,
              0.04
            );
          }
        }
      }
    }
  }

  for (const change of changes) {
    if (!change || typeof change !== "object") continue;
    if (change.deleted && change.expected === false) {
      const reason = `Verification found unexpected file deletion: ${change.path || change.target || "unknown path"}`;
      addRiskFinding(state, change.broad ? "critical" : "high", reason, change, reason);
    }
  }
}

function evaluateShellVerification(state, task = {}, workerResult = {}, context = {}) {
  const shell = {
    ...(workerResult.context.shell || {}),
    ...(context.shell || {}),
    ...((workerResult.evidence && workerResult.evidence.shell) || {})
  };
  const text = allText(task, workerResult);
  const actionTexts = workerResult.actions.map(actionText);
  const taskType = String(task.type || "").toLowerCase();
  const taskPool = String(task.modelPool || "").toLowerCase();
  const shellCapableTask = /^(shell|terminal|command|local_execution)$/i.test(taskType) || taskPool === "codex-cli";
  const hasExplicitShellEvidence =
    Boolean(shell.command) ||
    Number.isFinite(
      firstNumber(shell.exitCode, shell.code, workerResult.context.exitCode, workerResult.context.code)
    ) ||
    Boolean(shell.stderr) ||
    Boolean(shell.timedOut || workerResult.context.timedOut || context.timedOut) ||
    Boolean(shell.processStarted || shell.pid) ||
    Array.isArray(shell.outputDirs);
  const hasShellContext =
    hasExplicitShellEvidence ||
    Number.isFinite(
      firstNumber(workerResult.context.exitCode, workerResult.context.code, context.exitCode, context.code)
    );
  const hasShell =
    hasShellContext ||
    (shellCapableTask && /\b(shell|terminal|command|exec|npm|pnpm|yarn|bun|bash|zsh|命令|终端|构建)\b/i.test(text)) ||
    (shellCapableTask && /\b(?:run|execute|执行)\s+(?:build|test|lint)\b/i.test(text)) ||
    actionTexts.some(
      (action) =>
        /\b(shell|terminal|command|exec|npm|pnpm|yarn|bun|bash|zsh)\b/i.test(action) ||
        /\b(?:run|execute)\s+(?:build|test|lint)\b/i.test(action)
    );
  if (!hasShell) return;

  const exitCode = firstNumber(
    shell.exitCode,
    shell.code,
    workerResult.context.exitCode,
    workerResult.context.code,
    context.exitCode,
    context.code
  );
  const stderr = collapseText(
    shell.stderr || workerResult.context.stderr || context.stderr || workerResult.error || ""
  );
  const stdout = collapseText(
    shell.stdout || workerResult.context.stdout || context.stdout || workerResult.output || ""
  );
  const timedOut = Boolean(shell.timedOut || workerResult.context.timedOut || context.timedOut);

  if (Number.isFinite(exitCode)) {
    if (exitCode === 0) addReason(state, "Shell exit code is 0.", 0.2);
    else addIssue(state, `Shell exit code is ${exitCode}.`, "high", true, 0.28);
  } else {
    addIssue(state, "Shell command success has no exit code evidence.", "medium", true, 0.14);
  }
  if (timedOut) addIssue(state, "Shell command timed out.", "high", true, 0.28);
  if (stderr && /(?:error|failed|exception|traceback|denied|not found|ELIFECYCLE|ERR!)/i.test(stderr)) {
    addIssue(state, `Shell stderr contains failure text: ${stderr.slice(0, 180)}`, "high", true, 0.22);
  }
  if (stdout && hasAnyWord(stdout, SUCCESS_WORDS)) addReason(state, "Shell output contains success text.", 0.08);

  const buildLike = /\b(build|npm run build|pnpm build|yarn build|next build|构建)\b/i.test(text);
  if (buildLike) {
    const cwd = context.cwd || workerResult.context.cwd || process.env.AGENT_ROUTE_CODEX_CWD || process.cwd();
    const outputDirs = uniqueList([
      ...(Array.isArray(workerResult.context.outputDirs) ? workerResult.context.outputDirs : []),
      ...(Array.isArray(context.outputDirs) ? context.outputDirs : []),
      "dist",
      "build",
      ".next",
      ".next-cli-build"
    ]);
    const found = outputDirs
      .map((dir) => normalizePath(dir, cwd))
      .filter((dir) => {
        if (!dir) return false;
        const info = filesTool.pathInfo(dir);
        return info.exists && info.isDirectory;
      });
    if (found.length) addReason(state, `Build output directory exists: ${found[0]}`, 0.18);
    else addIssue(state, "Build-like task has no verified output directory.", "medium", true, 0.12);
  }
}

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return NaN;
}

function isReadOnlyWebToolResult(task = {}, workerResult = {}) {
  const type = String(task.type || "").toLowerCase();
  const toolWorker = String(task.toolWorker || task.tool_worker || "").toLowerCase();
  const model = String(workerResult.model || workerResult.context?.model || "").toLowerCase();
  return (
    toolWorker === "web" ||
    model === "web-tool" ||
    /^(web_search|web_read|web_fetch|api_read|http_fetch|public_web_read|public_api_read)$/.test(type)
  );
}

const WEB_RELEVANCE_STOPWORDS = new Set([
  "the",
  "and",
  "or",
  "for",
  "from",
  "with",
  "without",
  "into",
  "onto",
  "this",
  "that",
  "these",
  "those",
  "please",
  "must",
  "should",
  "need",
  "needs",
  "using",
  "use",
  "used",
  "real",
  "public",
  "web",
  "online",
  "internet",
  "search",
  "find",
  "lookup",
  "read",
  "fetch",
  "collect",
  "gather",
  "retrieve",
  "query",
  "result",
  "results",
  "source",
  "sources",
  "evidence",
  "url",
  "http",
  "https",
  "status",
  "title",
  "text",
  "body",
  "page",
  "site",
  "api",
  "latest",
  "current",
  "today",
  "now",
  "近期",
  "最新",
  "当前",
  "今天",
  "查询",
  "搜索",
  "检索",
  "读取",
  "获取",
  "收集",
  "公开",
  "网页",
  "网站",
  "来源",
  "证据",
  "标题",
  "正文",
  "状态",
  "不要",
  "不得",
  "禁止",
  "请勿"
]);

function stripWebTaskInstructions(value = "") {
  return String(value || "")
    .replace(/\bhttps?:\/\/[^\s"'<>()[\]{}]+/gi, " ")
    .replace(
      /(?:不要|不允许|禁止|不得|请勿|do not|don't|never)[^。.;\n]*(?:提交|发送|付款|支付|登录|上传|删除|发布|修改|写入|submit|send|pay|login|upload|delete|publish|modify|write)[^。.;\n]*/gi,
      " "
    )
    .replace(/[`"'“”‘’()[\]{}<>]/g, " ");
}

function relevanceTokens(value = "") {
  const prepared = stripWebTaskInstructions(value)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_/\\|:+-]/g, " ")
    .toLowerCase();
  const tokens = [];
  for (const match of prepared.matchAll(/[a-z0-9\u4e00-\u9fa5]+/gi)) {
    const token = match[0];
    if (!token || WEB_RELEVANCE_STOPWORDS.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    if (/^[a-z]+$/.test(token) && token.length < 3) continue;
    if (/[\u4e00-\u9fa5]/.test(token)) {
      const segments = token.match(/[a-z]+|\d+|[\u4e00-\u9fa5]+/gi) || [];
      for (const segment of segments) {
        if (!segment || WEB_RELEVANCE_STOPWORDS.has(segment) || /^\d+$/.test(segment)) continue;
        if (/^[a-z]+$/.test(segment) && segment.length < 3) continue;
        if (/^[\u4e00-\u9fa5]+$/.test(segment) && segment.length >= 4) {
          for (let index = 0; index <= segment.length - 2; index += 1) {
            const bigram = segment.slice(index, index + 2);
            if (!WEB_RELEVANCE_STOPWORDS.has(bigram)) tokens.push(bigram);
          }
        } else if (segment.length >= 2) {
          tokens.push(segment);
        }
      }
      continue;
    }
    if (token.length >= 2) tokens.push(token);
  }
  return uniqueList(tokens, 20);
}

function webSearchTaskQueryText(task = {}) {
  const explicit = task.query || task.searchQuery || task.search_query;
  const parts = explicit ? [explicit] : task.input ? [task.input] : [task.title, task.description, task.prompt];
  const text = parts.filter(Boolean).join(" ");
  return collapseText(text, 1200);
}

function webSearchQueryClauses(task = {}) {
  const text = webSearchTaskQueryText(task);
  return uniqueList(
    String(text || "")
      .split(/\n|;|；/)
      .map((item) =>
        collapseText(
          stripWebTaskInstructions(item)
            .replace(/^[\s:：,，、-]+|[\s:：,，、-]+$/g, "")
            .replace(/\s+/g, " "),
          240
        )
      )
      .filter((item) => item.length >= 4),
    12
  );
}

function requiresEveryWebSearchQueryClause(task = {}) {
  const text = [
    task.title,
    task.description,
    task.prompt,
    ...(Array.isArray(task.successCriteria) ? task.successCriteria : []),
    ...(Array.isArray(task.success_criteria) ? task.success_criteria : [])
  ]
    .filter(Boolean)
    .join(" ");
  if (/\b(each|every|all)\s+(?:query|search|clause)\b|每个(?:查询|搜索|子查询)|所有(?:查询|搜索|子查询)/i.test(text)) {
    return true;
  }
  if (
    /\b(each|every|all|both|multiple|distinct|separate)\s+(?:fact|facts|datum|data|metric|metrics|point|points|source|sources)\b|两个|多个|多项|分别|各自|各个|所有(?:事实|数据|指标|来源|缺口)/i.test(
      text
    )
  ) {
    return true;
  }
  if (webSearchQueryClauses(task).length <= 1) return false;
  return !treatsWebSearchClausesAsAlternatives(task);
}

function treatsWebSearchClausesAsAlternatives(task = {}) {
  const text = [
    task.title,
    task.description,
    task.prompt,
    task.input,
    ...(Array.isArray(task.successCriteria) ? task.successCriteria : []),
    ...(Array.isArray(task.success_criteria) ? task.success_criteria : [])
  ]
    .filter(Boolean)
    .join(" ");
  if (
    /\b(alternative|alternatives|candidate|candidates|fallback|same\s+(?:fact|datum|data|metric|source))\b|候选|备选|任选|任一|同一(?:事实|数据|指标|来源)/i.test(
      text
    )
  ) {
    return true;
  }
  if (/\b(each|every|all|both|multiple|distinct|separate)\b|两个|多个|多项|分别|各自|各个|所有/i.test(text)) {
    return false;
  }
  return webSearchQueryClauses(task).length > 1;
}

function responseText(response = {}) {
  return collapseText(
    [
      response.url,
      response.title,
      typeof response.body === "string" ? response.body : JSON.stringify(response.body || ""),
      response.textPreview,
      response.error
    ]
      .filter(Boolean)
      .join(" "),
    5000
  );
}

function responseQueryKey(response = {}) {
  return collapseText(
    response.query || response.searchQuery || response.search_query || response.requestQuery || "",
    300
  )
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function queryKey(value = "") {
  return collapseText(value, 300).toLowerCase().replace(/\s+/g, " ");
}

function collectWebEvidenceResponses(task = {}, workerResult = {}, context = {}) {
  const evidence = workerResult.evidence || {};
  const normalizedEvidence = evidence.normalizedEvidence || context.normalizedEvidence || {};
  const browserEvidence = [
    ...(Array.isArray(evidence.browserEvidence) ? evidence.browserEvidence : []),
    ...(normalizedEvidence && Array.isArray(normalizedEvidence.browser) ? normalizedEvidence.browser : []),
    ...(Array.isArray(context.browserEvidence) ? context.browserEvidence : []),
    ...(context.browser ? [context.browser] : []),
    ...(evidence.browser ? [evidence.browser] : [])
  ].map((item) => ({
    method: "GET",
    url: item.url || item.currentUrl || item.afterUrl || "",
    status: item.status || (item.metadata && item.metadata.status) || (item.ok === true ? 200 : 0),
    title: item.title || "",
    body: item.pageText || item.textPreview || item.visibleText || "",
    textPreview: item.textPreview || item.pageText || "",
    error: item.error || item.errorMessage || "",
    query: item.query || item.searchQuery || item.search_query || "",
    evidenceRole: item.evidenceRole || item.evidence_role || ""
  }));
  return [
    ...(workerResult.evidence && Array.isArray(workerResult.evidence.apiResponses)
      ? workerResult.evidence.apiResponses
      : []),
    ...(Array.isArray(workerResult.context.apiResponses) ? workerResult.context.apiResponses : []),
    ...(Array.isArray(context.apiResponses) ? context.apiResponses : []),
    ...browserEvidence
  ].filter(Boolean);
}

function isSearchResultPageResponse(response = {}, workerResult = {}) {
  const status = Number(response.status || response.statusCode || response.code);
  if (!Number.isFinite(status) || status < 200 || status >= 300) return false;
  if (response.ok === false) return false;
  const url = String(response.url || "");
  const searchUrl = String(workerResult.context?.url || "");
  const body = responseText(response);
  if (!body || body.length < 40) return false;
  if (responseBodyLooksLikeFailure(body, true)) return false;
  if (searchUrl && url && url === searchUrl) return false;
  return true;
}

function evaluateWebSearchRelevanceVerification(state, task = {}, workerResult = {}, context = {}) {
  const type = String(task.type || "").toLowerCase();
  if (!isReadOnlyWebToolResult(task, workerResult) || type !== "web_search") return;

  const responses = collectWebEvidenceResponses(task, workerResult, context);
  const resultPageResponses = responses.filter((response) => isSearchResultPageResponse(response, workerResult));
  if (!resultPageResponses.length) {
    addIssue(state, "Web search has no successful readable result-page evidence.", "high", true, 0.24);
    return;
  }
  addReason(state, "Web search captured successful readable result-page evidence.", 0.1);

  const clauseQueries = webSearchQueryClauses(task);
  const hasResponseQuery = resultPageResponses.some((response) => responseQueryKey(response));
  if (clauseQueries.length > 1 && hasResponseQuery) {
    let missingOrUnrelated = false;
    let bestMatched = [];
    let matchedClauseResponse = false;
    const requireEveryClause = requiresEveryWebSearchQueryClause(task);
    for (const clause of clauseQueries) {
      const clauseKey = queryKey(clause);
      const clauseResponses = resultPageResponses.filter((response) => responseQueryKey(response) === clauseKey);
      if (!clauseResponses.length) {
        if (requireEveryClause) {
          missingOrUnrelated = true;
          addIssue(state, `Web search has no readable result-page evidence for query: ${clause}.`, "high", true, 0.2);
        }
        continue;
      }
      matchedClauseResponse = true;
      const clauseTokens = relevanceTokens(clause).slice(0, 10);
      if (!clauseTokens.length) continue;
      const clauseEvidenceText = collapseText(clauseResponses.map(responseText).join(" "), 8000).toLowerCase();
      const clauseMatched = clauseTokens.filter((token) => clauseEvidenceText.includes(token));
      if (clauseMatched.length > bestMatched.length) bestMatched = clauseMatched;
      const clauseRequired =
        clauseTokens.length <= 4
          ? clauseTokens.length
          : clauseTokens.length <= 5
            ? Math.max(3, Math.ceil(clauseTokens.length * 0.6))
            : Math.max(3, Math.ceil(clauseTokens.length * 0.35));
      if (clauseMatched.length < clauseRequired) {
        if (requireEveryClause) {
          missingOrUnrelated = true;
          addIssue(
            state,
            `Web search evidence appears unrelated to query "${clause}". Matched ${clauseMatched.length}/${clauseTokens.length} key tokens (${clauseMatched.slice(0, 6).join(", ") || "none"}).`,
            "high",
            true,
            0.24
          );
        }
      } else if (!requireEveryClause) {
        addReason(
          state,
          `Web evidence overlaps an alternative search query: ${clauseMatched.slice(0, 6).join(", ")}.`,
          0.12
        );
        return;
      }
    }
    if (!requireEveryClause) {
      if (matchedClauseResponse && bestMatched.length) {
        addIssue(
          state,
          `Web search evidence does not sufficiently match any alternative query. Best matched tokens: ${bestMatched.slice(0, 6).join(", ")}.`,
          "high",
          true,
          0.22
        );
        return;
      }
      if (matchedClauseResponse) {
        addIssue(state, "Web search evidence does not match any alternative query.", "high", true, 0.24);
        return;
      }
      // The worker used a query string that does not correspond to any declared clause.
      // Fall through to the broader task-query relevance check instead of granting success.
    }
    if (missingOrUnrelated) return;
    if (requireEveryClause) {
      addReason(state, "Web evidence overlaps each search query clause.", 0.12);
      return;
    }
  }

  const requiredTokens = relevanceTokens(webSearchTaskQueryText(task)).slice(0, 10);
  if (!requiredTokens.length) return;
  const evidenceText = collapseText(resultPageResponses.map(responseText).join(" "), 12000).toLowerCase();
  const matchedTokens = requiredTokens.filter((token) => evidenceText.includes(token));
  const requiredCount =
    requiredTokens.length <= 4
      ? requiredTokens.length
      : requiredTokens.length <= 5
        ? Math.max(3, Math.ceil(requiredTokens.length * 0.6))
        : Math.max(3, Math.ceil(requiredTokens.length * 0.35));
  if (matchedTokens.length >= requiredCount) {
    addReason(state, `Web evidence overlaps task query tokens: ${matchedTokens.slice(0, 6).join(", ")}.`, 0.12);
    return;
  }
  addIssue(
    state,
    `Web search evidence appears unrelated to the task query. Matched ${matchedTokens.length}/${requiredTokens.length} key tokens (${matchedTokens.slice(0, 6).join(", ") || "none"}).`,
    "high",
    true,
    0.28
  );
}

function responseBodyLooksLikeFailure(body = "", readOnlyWebTool = false) {
  const text = collapseText(body, 1200);
  if (!text) return false;
  if (!readOnlyWebTool) return /"error"\s*:|error|failed|denied/i.test(text);
  return (
    /^\s*[{[]\s*"error"\s*:/i.test(text) ||
    /\b(access denied|request denied|forbidden|unauthorized|not authorized|rate limit exceeded|captcha required)\b/i.test(
      text
    ) ||
    /\b(oops,?\s+something went wrong|something went wrong|try again later|will be right back|temporarily unavailable|service unavailable|enable javascript)\b/i.test(
      text
    ) ||
    /confirm this search was made by a human|select all squares|验证码|人机验证/i.test(text)
  );
}

function evaluateApiVerification(state, task = {}, workerResult = {}, context = {}) {
  const responses = [
    ...(workerResult.evidence && Array.isArray(workerResult.evidence.apiResponses)
      ? workerResult.evidence.apiResponses
      : []),
    ...(Array.isArray(workerResult.context.apiResponses) ? workerResult.context.apiResponses : []),
    ...(Array.isArray(context.apiResponses) ? context.apiResponses : [])
  ];
  const text = allText(task, workerResult);
  const hasApi =
    responses.length ||
    /\b(api|http|fetch)\b/i.test(task.type || "") ||
    /\b(api response|api request|http request|status code|fetch\(|调用\s*api|接口请求|请求响应)\b/i.test(text);
  if (!hasApi) return;

  if (!responses.length) {
    addIssue(state, "API task has no response status/body evidence.", "medium", true, 0.16);
    return;
  }

  const readOnlyWebTool = isReadOnlyWebToolResult(task, workerResult);
  const successfulResponses = responses.filter((response) => {
    const status = Number(response.status || response.statusCode || response.code);
    const body = collapseText(typeof response.body === "string" ? response.body : JSON.stringify(response.body || ""));
    return (
      response.ok !== false &&
      Number.isFinite(status) &&
      status >= 200 &&
      status < 300 &&
      !(readOnlyWebTool && responseBodyLooksLikeFailure(body, true))
    );
  });
  for (const response of responses) {
    const status = Number(response.status || response.statusCode || response.code);
    const body = collapseText(typeof response.body === "string" ? response.body : JSON.stringify(response.body || ""));
    const failedWebResponse =
      readOnlyWebTool && (response.ok === false || responseBodyLooksLikeFailure(body, readOnlyWebTool));
    if (failedWebResponse && successfulResponses.length > 0) {
      addReason(state, "Ignored failed non-critical web source response.", 0);
      continue;
    }
    if (Number.isFinite(status) && status >= 200 && status < 300) addReason(state, `API response was ${status}.`, 0.18);
    else if (readOnlyWebTool && successfulResponses.length > 0) {
      addReason(
        state,
        `Ignored failed non-critical web source status ${Number.isFinite(status) ? status : "unknown"}.`,
        0
      );
      continue;
    } else {
      addIssue(state, `API response status was ${Number.isFinite(status) ? status : "unknown"}.`, "high", true, 0.24);
    }
    if (responseBodyLooksLikeFailure(body, readOnlyWebTool))
      addIssue(state, "API response body contains failure text.", "high", true, 0.2);
    if (response.writeConfirmed || response.persisted || response.createdId || response.updatedId)
      addReason(state, "API write was confirmed by response metadata.", 0.18);
  }
}

function evaluateSemanticVerification(state, task = {}, workerResult = {}) {
  const evidence = workerResult.evidence || {};
  const semantic = evidence.semantic || {};
  if (evidence.provided) addReason(state, "Worker returned standardized evidence.", 0.08);
  else addIssue(state, "Worker did not return the standardized evidence field.", "high", true, 0.18);

  const output = collapseText(workerResult.output);
  const error = collapseText(workerResult.error || workerResult.blockedReason);
  const readOnlyWebTool = isReadOnlyWebToolResult(task, workerResult);
  const hasSuccessfulWebResponse =
    readOnlyWebTool &&
    (workerResult.evidence?.apiResponses || workerResult.context?.apiResponses || []).some((response) => {
      const status = Number(response.status || response.statusCode || response.code);
      const body = collapseText(
        typeof response.body === "string" ? response.body : JSON.stringify(response.body || "")
      );
      return (
        response.ok !== false &&
        Number.isFinite(status) &&
        status >= 200 &&
        status < 300 &&
        !responseBodyLooksLikeFailure(body, true)
      );
    });
  if (error) addIssue(state, `Worker returned error text: ${error.slice(0, 180)}`, "high", true, 0.24);
  if (!output) {
    addIssue(state, "Worker success has empty output.", "high", true, 0.28);
    return;
  }
  if (/^(done|success|completed|ok|已完成|成功)$/i.test(output) && output.length < 16) {
    addIssue(state, "Worker output is too thin to verify semantically.", "medium", true, 0.16);
  } else {
    addReason(state, "Worker output is non-empty and inspectable.", 0.12);
  }
  if (hasAnyWord(output, ERROR_WORDS) && !hasSuccessfulWebResponse)
    addIssue(state, "Worker output contains error-like text.", "medium", true, 0.14);
  if (semantic.outputSummary && semantic.outputSummary.length >= 20)
    addReason(state, "Evidence includes semantic result summary.", 0.1);
  if (semantic.addressesCriteria === true)
    addReason(state, "Evidence says the result addresses success criteria.", 0.1);
  if (
    Number.isFinite(Number(semantic.criteriaCoverage)) &&
    Number(semantic.criteriaCoverage) >= DEFAULT_VERIFICATION_POLICY.semantic.minCriteriaCoverage
  )
    addReason(state, "Evidence reports high success-criteria coverage.", 0.08);
  if (
    Number.isFinite(Number(semantic.qualityScore)) &&
    Number(semantic.qualityScore) >= DEFAULT_VERIFICATION_POLICY.semantic.minQualityScore
  )
    addReason(state, "Evidence reports acceptable semantic quality.", 0.08);
  for (const issue of semantic.qualityIssues || [])
    addIssue(state, `Semantic evidence issue: ${issue}`, "medium", true, 0.12);
  if (semantic.hallucinationRisk && /high|critical|likely|高|严重/i.test(semantic.hallucinationRisk)) {
    addIssue(state, `Semantic evidence reports hallucination risk: ${semantic.hallucinationRisk}`, "high", true, 0.22);
  }

  const criteria = Array.isArray(task.successCriteria) ? task.successCriteria : [];
  const outputLower = output.toLowerCase();
  let matched = 0;
  for (const criterion of criteria.slice(0, 6)) {
    const criterionText = collapseText(criterion).toLowerCase();
    if (/^(done|complete|completed|task finishes|task output satisfies|完成|已完成)$/.test(criterionText)) continue;
    const keywords = criterionText
      .split(/[^a-z0-9\u4e00-\u9fa5]+/)
      .filter((item) => item.length >= 3)
      .slice(0, 4);
    if (keywords.length && keywords.some((keyword) => outputLower.includes(keyword))) matched += 1;
  }
  if (criteria.length && matched > 0) addReason(state, "Output overlaps with task success criteria.", 0.1);
  if (criteria.length >= 2 && matched === 0 && !hasTechnicalEvidence(state)) {
    addIssue(state, "Output does not address success criteria with verifiable evidence.", "medium", true, 0.14);
  }
}

function evaluateAuthenticityVerification(state, task = {}, workerResult = {}, context = {}) {
  const authenticity = authenticityEngine.evaluateAuthenticity(task, workerResult, context);
  state.authenticity = authenticity;
  if (authenticity.authenticityScore >= 0.7) {
    addReason(state, `Authenticity check passed (${authenticity.authenticityScore}).`, 0.14);
    return;
  }
  if (authenticity.authenticityScore >= 0.55) {
    addIssue(
      state,
      `Authenticity check is weak (${authenticity.authenticityScore}): ${authenticity.authenticityWarnings[0] || "result needs review"}`,
      "medium",
      true,
      0.12
    );
    return;
  }
  if (authenticity.authenticityScore >= 0.35) {
    addIssue(
      state,
      `Authenticity check is suspicious (${authenticity.authenticityScore}): ${authenticity.authenticityWarnings[0] || "result may be false success"}`,
      "high",
      true,
      0.22
    );
    return;
  }
  addIssue(
    state,
    `Authenticity check is highly suspicious (${authenticity.authenticityScore}): ${authenticity.authenticityWarnings[0] || "result likely false success"}`,
    "critical",
    false,
    0.32
  );
}

function hasTechnicalEvidence(state) {
  return state.reasons.some((reason) => /Browser|file|Shell|API|URL|DOM|exit code|output directory/i.test(reason));
}

function isReadOnlyBrowserTask(task = {}, workerResult = {}) {
  const text = `${task.type || ""} ${allText(task, workerResult)}`.toLowerCase();
  if (!/\b(browser|page|url|dom|scroll|read|extract|navigate|网页|浏览器|页面|读取|提取|滚动)\b/i.test(text))
    return false;
  return !/\b(submit|send|apply|publish|pay|payment|delete|login|upload|fill|type|input|提交|发送|申请|发布|支付|删除|登录|上传|填写|输入)\b/i.test(
    text
  );
}

function stripNegatedMutationText(value = "") {
  return String(value || "").replace(
    /(?:不要|不允许|禁止|不得|请勿|do not|don't|never|without|no)[^。.;\n]*(?:写入|创建|保存|导出|删除|安装|修改|更新|write|create|save|export|delete|install|modify|update)[^。.;\n]*/gi,
    " "
  );
}

function isReadOnlyLocalEvidenceTask(task = {}, workerResult = {}) {
  const type = String(task.type || task.taskType || "").toLowerCase();
  const modelPool = String(task.modelPool || task.model_pool || workerResult.context?.model || "").toLowerCase();
  if (!(/^(local_execution|shell|terminal|command)$/.test(type) || modelPool === "codex-cli")) return false;
  const text = [
    task.title,
    task.description,
    task.prompt,
    task.input,
    workerResult.output,
    ...(Array.isArray(task.successCriteria) ? task.successCriteria : [])
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  if (!/(read[-\s]?only|inspect|list|cat|sed|head|grep|pwd|ls|find|wc|只读|读取|查看|检查|摘录|证据)/i.test(text))
    return false;
  const withoutNegatedMutations = stripNegatedMutationText(text);
  return !/(write|create|save|export|delete|install|modify|update|run dev|start server|npm install|pnpm install|yarn install|写入|创建|保存|导出|删除|安装|修改|更新|启动服务)/i.test(
    withoutNegatedMutations
  );
}

function isReadOnlyEvidenceTask(task = {}, workerResult = {}) {
  return isReadOnlyBrowserTask(task, workerResult) || isReadOnlyLocalEvidenceTask(task, workerResult);
}

function finalizeVerification(state, task = {}, workerResult = {}, context = {}) {
  const issueSeverity = maxIssueSeverity(state.detectedIssues);
  const confidence = Math.max(0, Math.min(1, Number(state.confidence.toFixed(2))));
  const fileIntentChecks = Array.isArray(state.fileIntentChecks) ? state.fileIntentChecks.slice(0, 30) : [];
  const strongestFileIntent =
    fileIntentChecks.slice().sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))[0] || null;
  const authenticity = state.authenticity || {
    authenticityScore: 0.82,
    authenticityWarnings: [],
    authenticityReasons: [],
    authenticitySignals: []
  };
  const technicalTask =
    /\b(browser|shell|terminal|local_execution|file|api|tool|codex-cli)\b/i.test(
      `${task.type || ""} ${task.modelPool || ""}`
    ) || hasTechnicalEvidence(state);
  const seriousIssue = issueSeverity === "high" || issueSeverity === "critical";
  const riskBlocked = state.riskFindings.some((finding) => finding.blockedReason || finding.riskLevel === "critical");

  let verificationStatus = VERIFICATION_STATUS.UNVERIFIED;
  if (!state.detectedIssues.length && confidence >= DEFAULT_VERIFICATION_POLICY.confidence.verified)
    verificationStatus = VERIFICATION_STATUS.VERIFIED;
  else if (
    !seriousIssue &&
    confidence >=
      (technicalTask
        ? DEFAULT_VERIFICATION_POLICY.confidence.partialTechnical
        : DEFAULT_VERIFICATION_POLICY.confidence.partialSemantic)
  )
    verificationStatus = VERIFICATION_STATUS.PARTIALLY_VERIFIED;

  let suggestedNextState = SUGGESTED_NEXT_STATE.RETRYING;
  let retryable = true;
  let decisionSource = "verification";
  if (riskBlocked) {
    suggestedNextState = SUGGESTED_NEXT_STATE.BLOCKED;
    retryable = false;
    decisionSource = "risk";
  } else if (Number(authenticity.authenticityScore || 0) < 0.35) {
    suggestedNextState = SUGGESTED_NEXT_STATE.BLOCKED;
    retryable = false;
    decisionSource = "authenticity";
  } else if (Number(authenticity.authenticityScore || 0) < 0.7) {
    suggestedNextState = SUGGESTED_NEXT_STATE.RETRYING;
    retryable = true;
    decisionSource = "authenticity";
  } else if (verificationStatus === VERIFICATION_STATUS.VERIFIED) {
    suggestedNextState = SUGGESTED_NEXT_STATE.COMPLETED;
    retryable = false;
  } else if (verificationStatus === VERIFICATION_STATUS.PARTIALLY_VERIFIED && !technicalTask) {
    suggestedNextState = SUGGESTED_NEXT_STATE.COMPLETED;
    retryable = false;
  } else if (
    verificationStatus === VERIFICATION_STATUS.PARTIALLY_VERIFIED &&
    isReadOnlyEvidenceTask(task, workerResult) &&
    !seriousIssue
  ) {
    suggestedNextState = SUGGESTED_NEXT_STATE.COMPLETED;
    retryable = false;
  } else if (state.detectedIssues.some((issue) => issue.severity === "critical" && !issue.retryable)) {
    suggestedNextState = SUGGESTED_NEXT_STATE.BLOCKED;
    retryable = false;
  } else if (context.attempts >= context.maxAttempts) {
    suggestedNextState = SUGGESTED_NEXT_STATE.NEEDS_EVIDENCE;
    retryable = false;
  }
  const reasonCode = reasonCodeForVerification(state, verificationStatus);
  const missingEvidence = buildMissingEvidence(state, task, workerResult, context, verificationStatus);
  const rejectedEvidence = buildRejectedEvidence(state, task);

  const generatedMemoryCandidates = [];
  if (verificationStatus === VERIFICATION_STATUS.UNVERIFIED || state.detectedIssues.length) {
    generatedMemoryCandidates.push({
      type: "episodic",
      importance: seriousIssue ? 4 : 3,
      title: `Verification issue: ${task.title || task.id || "task"}`,
      summary: [
        `Verification status: ${verificationStatus}.`,
        state.detectedIssues.length
          ? `Issues: ${state.detectedIssues
              .map((item) => item.issue)
              .slice(0, 4)
              .join("; ")}`
          : "",
        workerResult.context && workerResult.context.model ? `Worker: ${workerResult.context.model}.` : ""
      ]
        .filter(Boolean)
        .join(" "),
      tags: ["verification", verificationStatus, reasonCode, task.type || "", task.modelPool || ""]
    });
  }
  if (state.riskFindings.length) {
    generatedMemoryCandidates.push({
      type: "working",
      importance: 4,
      title: `Verification risk finding: ${task.title || task.id || "task"}`,
      summary: state.riskFindings.map((finding) => finding.reason).join("; "),
      tags: ["verification-risk", task.type || "", task.modelPool || ""]
    });
  }

  return {
    at: nowIso(),
    phase: String(context.phase || "after_worker"),
    verified: verificationStatus === VERIFICATION_STATUS.VERIFIED,
    verificationStatus,
    confidence,
    reasons: uniqueList(state.reasons),
    detectedIssues: state.detectedIssues.map((issue) => ({ ...issue })),
    authenticityScore: Number(authenticity.authenticityScore || 0),
    authenticityWarnings: Array.isArray(authenticity.authenticityWarnings)
      ? authenticity.authenticityWarnings.slice(0, 20)
      : [],
    authenticityReasons: Array.isArray(authenticity.authenticityReasons)
      ? authenticity.authenticityReasons.slice(0, 20)
      : [],
    authenticitySignals: Array.isArray(authenticity.authenticitySignals)
      ? clone(authenticity.authenticitySignals).slice(0, 20)
      : [],
    decisionSource,
    reasonCode,
    fileIntentConfidence: strongestFileIntent ? strongestFileIntent.confidence : 0,
    fileIntentReason: strongestFileIntent ? strongestFileIntent.reason : "",
    falseFileDetectionCount: Number(state.falseFileDetectionCount || 0),
    fileIntentChecks,
    suggestedNextState,
    retryable,
    missingEvidence,
    rejectedEvidence,
    riskFindings: state.riskFindings.map(clone),
    generatedMemoryCandidates
  };
}

function hasHardTechnicalIssue(verification = {}) {
  return (verification.detectedIssues || []).some((issue) => {
    const severity = String(issue.severity || "medium").toLowerCase();
    const text = String(issue.issue || issue).toLowerCase();
    return (
      (severity === "high" || severity === "critical") &&
      /(standardized evidence|authenticity|false success|browser|submit|confirmation|captcha|login|shell|exit code|stderr|file|directory|api|response|web search|result-page|task query|exists|deletion)/i.test(
        text
      )
    );
  });
}

function statusRank(status) {
  const order = {
    [VERIFICATION_STATUS.UNVERIFIED]: 0,
    [VERIFICATION_STATUS.PARTIALLY_VERIFIED]: 1,
    [VERIFICATION_STATUS.VERIFIED]: 2
  };
  return order[status] == null ? 0 : order[status];
}

function normalizeModelReview(review = {}) {
  const status = String(
    review.verificationStatus ||
      review.verification_status ||
      (review.verified ? VERIFICATION_STATUS.VERIFIED : "") ||
      ""
  ).toLowerCase();
  const confidence = Math.max(0, Math.min(1, Number(review.confidence || 0)));
  const next = String(review.suggestedNextState || review.suggested_next_state || "").toLowerCase();
  return {
    verified: Boolean(review.verified),
    verificationStatus: Object.values(VERIFICATION_STATUS).includes(status)
      ? status
      : confidence >= DEFAULT_VERIFICATION_POLICY.confidence.modelVerified
        ? VERIFICATION_STATUS.VERIFIED
        : confidence >= DEFAULT_VERIFICATION_POLICY.confidence.modelPartial
          ? VERIFICATION_STATUS.PARTIALLY_VERIFIED
          : VERIFICATION_STATUS.UNVERIFIED,
    confidence,
    reasons: uniqueList(review.reasons || review.verificationReasons || review.verification_reasons || []),
    detectedIssues: Array.isArray(review.detectedIssues || review.detected_issues)
      ? clone(review.detectedIssues || review.detected_issues)
      : [],
    reasonCode: collapseText(review.reasonCode || review.reason_code || ""),
    missingEvidence: Array.isArray(review.missingEvidence || review.missing_evidence)
      ? clone(review.missingEvidence || review.missing_evidence).slice(0, 20)
      : [],
    rejectedEvidence: Array.isArray(review.rejectedEvidence || review.rejected_evidence)
      ? clone(review.rejectedEvidence || review.rejected_evidence).slice(0, 20)
      : [],
    suggestedNextState: Object.values(SUGGESTED_NEXT_STATE).includes(next) ? next : "",
    retryable: review.retryable !== false,
    riskFindings: Array.isArray(review.riskFindings || review.risk_findings)
      ? clone(review.riskFindings || review.risk_findings)
      : []
  };
}

function mergeModelVerification(baseVerification = {}, modelReview = {}) {
  const base = compactVerification(baseVerification);
  const model = normalizeModelReview(modelReview);
  const hardTechnicalIssue = hasHardTechnicalIssue(base);
  const modelReasons = model.reasons.map((reason) => `Verifier model: ${reason}`);
  const modelIssues = model.detectedIssues.map((issue) => ({
    issue: `Verifier model: ${collapseText(issue.issue || issue)}`,
    severity: issue.severity || "medium",
    retryable: issue.retryable !== false
  }));
  const canUpgrade = !hardTechnicalIssue && !base.riskFindings.length;
  const chosenStatus =
    canUpgrade && statusRank(model.verificationStatus) > statusRank(base.verificationStatus)
      ? model.verificationStatus
      : statusRank(model.verificationStatus) < statusRank(base.verificationStatus)
        ? model.verificationStatus
        : base.verificationStatus;
  const chosenConfidence = canUpgrade
    ? Math.max(base.confidence, model.confidence || 0)
    : Math.min(base.confidence, model.confidence || base.confidence);
  const modelNext = model.suggestedNextState;
  const suggestedNextState =
    canUpgrade && modelNext
      ? modelNext
      : !canUpgrade &&
          [
            SUGGESTED_NEXT_STATE.BLOCKED,
            SUGGESTED_NEXT_STATE.FAILED,
            SUGGESTED_NEXT_STATE.NEEDS_EVIDENCE,
            SUGGESTED_NEXT_STATE.RETRYING
          ].includes(modelNext)
        ? modelNext
        : base.suggestedNextState;

  return {
    ...base,
    at: nowIso(),
    phase: `${base.phase || "after_worker"}+verifier_model`,
    verified: chosenStatus === VERIFICATION_STATUS.VERIFIED,
    verificationStatus: chosenStatus,
    confidence: Math.max(0, Math.min(1, Number(chosenConfidence.toFixed(2)))),
    reasons: uniqueList([...base.reasons, ...modelReasons]),
    detectedIssues: [...base.detectedIssues, ...modelIssues].slice(0, 40),
    reasonCode: model.reasonCode || base.reasonCode,
    missingEvidence: [...base.missingEvidence, ...model.missingEvidence].slice(0, 30),
    rejectedEvidence: [...base.rejectedEvidence, ...model.rejectedEvidence].slice(0, 30),
    suggestedNextState,
    retryable: model.retryable !== false && base.retryable !== false,
    riskFindings: [...base.riskFindings, ...model.riskFindings].slice(0, 20),
    generatedMemoryCandidates: base.generatedMemoryCandidates
  };
}

function shouldUseVerifierModel(task = {}, rawWorkerResult = {}, verification = {}) {
  const workerResult = normalizeWorkerResult(rawWorkerResult);
  const compact = compactVerification(verification);
  const taskType = String(task.type || "").toLowerCase();
  if (/^(planning|plan|strategy|decision|review)$/i.test(taskType)) return false;
  if (compact.suggestedNextState === SUGGESTED_NEXT_STATE.BLOCKED || compact.riskFindings.length) return false;
  if (hasHardTechnicalIssue(compact)) return false;
  const text = `${task.type || ""} ${task.title || ""} ${task.description || ""} ${task.prompt || ""}`.toLowerCase();
  const semanticTask =
    /\b(proposal|writing|analysis|summary|decision|research|content|semantic|answer|draft|plan|review|提案|分析|总结|内容|文案|方案|复盘)\b/i.test(
      text
    );
  const semanticEvidence = (workerResult.evidence && workerResult.evidence.semantic) || {};
  return Boolean(
    semanticTask ||
    compact.verificationStatus !== VERIFICATION_STATUS.VERIFIED ||
    (semanticEvidence.qualityIssues && semanticEvidence.qualityIssues.length) ||
    semanticEvidence.hallucinationRisk
  );
}

function maxIssueSeverity(issues = []) {
  const order = { low: 0, medium: 1, high: 2, critical: 3 };
  let max = "low";
  for (const issue of issues) {
    const severity = String(issue.severity || "medium").toLowerCase();
    if ((order[severity] || 1) > (order[max] || 0)) max = severity;
  }
  return max;
}

function verifyTaskResult(task = {}, rawWorkerResult = {}, context = {}) {
  const workerResult = normalizeWorkerResult(rawWorkerResult);
  const state = {
    confidence: DEFAULT_VERIFICATION_POLICY.confidence.defaultCompact,
    reasons: [],
    detectedIssues: [],
    riskFindings: [],
    fileIntentChecks: [],
    falseFileDetectionCount: 0
  };

  evaluateBrowserVerification(state, task, workerResult, context);
  evaluateFileVerification(state, task, workerResult, context);
  evaluateShellVerification(state, task, workerResult, context);
  evaluateApiVerification(state, task, workerResult, context);
  evaluateWebSearchRelevanceVerification(state, task, workerResult, context);
  evaluateSemanticVerification(state, task, workerResult, context);
  evaluateAuthenticityVerification(state, task, workerResult, context);

  return finalizeVerification(state, task, workerResult, {
    ...context,
    attempts: Number(context.attempts || task.attempts || 0),
    maxAttempts: Number(context.maxAttempts || task.maxAttempts || 1)
  });
}

function compactVerification(verification = {}) {
  const status = String(
    verification.verificationStatus ||
      (verification.verified ? VERIFICATION_STATUS.VERIFIED : VERIFICATION_STATUS.UNVERIFIED)
  );
  const confidence = Math.max(0, Math.min(1, Number(verification.confidence || 0)));
  return {
    at: verification.at || nowIso(),
    phase: verification.phase || "manual",
    verified: status === VERIFICATION_STATUS.VERIFIED || Boolean(verification.verified),
    verificationStatus: Object.values(VERIFICATION_STATUS).includes(status) ? status : VERIFICATION_STATUS.UNVERIFIED,
    confidence,
    reasons: uniqueList(verification.reasons || verification.verificationReasons || []),
    detectedIssues: Array.isArray(verification.detectedIssues) ? clone(verification.detectedIssues).slice(0, 30) : [],
    authenticityScore:
      verification.authenticityScore == null && verification.authenticity_score == null
        ? 0.82
        : Math.max(0, Math.min(1, Number(verification.authenticityScore || verification.authenticity_score || 0))),
    authenticityWarnings: uniqueList(verification.authenticityWarnings || verification.authenticity_warnings || []),
    authenticityReasons: uniqueList(verification.authenticityReasons || verification.authenticity_reasons || []),
    authenticitySignals: Array.isArray(verification.authenticitySignals || verification.authenticity_signals)
      ? clone(verification.authenticitySignals || verification.authenticity_signals).slice(0, 20)
      : [],
    decisionSource: collapseText(verification.decisionSource || verification.decision_source || ""),
    reasonCode: collapseText(verification.reasonCode || verification.reason_code || ""),
    fileIntentConfidence: Math.max(
      0,
      Math.min(1, Number(verification.fileIntentConfidence || verification.file_intent_confidence || 0))
    ),
    fileIntentReason: collapseText(verification.fileIntentReason || verification.file_intent_reason || ""),
    falseFileDetectionCount: Number(
      verification.falseFileDetectionCount || verification.false_file_detection_count || 0
    ),
    fileIntentChecks: Array.isArray(verification.fileIntentChecks || verification.file_intent_checks)
      ? clone(verification.fileIntentChecks || verification.file_intent_checks).slice(0, 30)
      : [],
    suggestedNextState: Object.values(SUGGESTED_NEXT_STATE).includes(verification.suggestedNextState)
      ? verification.suggestedNextState
      : SUGGESTED_NEXT_STATE.RETRYING,
    retryable: verification.retryable !== false,
    missingEvidence: Array.isArray(verification.missingEvidence || verification.missing_evidence)
      ? clone(verification.missingEvidence || verification.missing_evidence).slice(0, 30)
      : [],
    rejectedEvidence: Array.isArray(verification.rejectedEvidence || verification.rejected_evidence)
      ? clone(verification.rejectedEvidence || verification.rejected_evidence).slice(0, 30)
      : [],
    riskFindings: Array.isArray(verification.riskFindings) ? clone(verification.riskFindings).slice(0, 20) : [],
    generatedMemoryCandidates: Array.isArray(verification.generatedMemoryCandidates)
      ? clone(verification.generatedMemoryCandidates).slice(0, 8)
      : []
  };
}

module.exports = {
  SUGGESTED_NEXT_STATE,
  VERIFICATION_STATUS,
  compactVerification,
  mergeModelVerification,
  shouldUseVerifierModel,
  verifyTaskResult
};
