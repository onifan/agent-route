"use strict";

const { BROWSER_ACTION_TYPE, EVIDENCE_SOURCE } = require("./evidence-types");
const { redactSensitiveText, sanitizeEvidence, sanitizePathForDisplay, sanitizeUrl } = require("./evidence-sanitizer");

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item != null);
  if (value == null || value === "") return [];
  return [value];
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === true || value === false) return value;
  if (value == null || value === "") return fallback;
  const text = String(value).trim().toLowerCase();
  if (["true", "yes", "1", "changed"].includes(text)) return true;
  if (["false", "no", "0", "unchanged"].includes(text)) return false;
  return fallback;
}

function collapseText(value, max = 4000) {
  const text = redactSensitiveText(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function visibleTextHints(text) {
  return collapseText(text, 1200)
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((item) => collapseText(item, 220))
    .filter(Boolean)
    .slice(0, 6);
}

function detectBrowserActionType(...values) {
  const text = values
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value || "")))
    .join(" ")
    .toLowerCase();
  if (/\b(pay|payment|checkout|billing|purchase|付款|支付|购买|结账)\b/.test(text))
    return BROWSER_ACTION_TYPE.PAYMENT_LIKE_CLICK;
  if (/\b(delete|remove|destroy|cancel subscription|删除|移除|取消订阅)\b/.test(text))
    return BROWSER_ACTION_TYPE.DELETE_LIKE_CLICK;
  if (/\b(login|sign in|signin|authenticate|password|2fa|otp|登录|登陆|认证|验证码)\b/.test(text))
    return BROWSER_ACTION_TYPE.LOGIN_LIKE_ACTION;
  if (/\b(upload|attach|上传|附件)\b/.test(text)) return BROWSER_ACTION_TYPE.UPLOAD;
  if (/\b(download|save file|下载)\b/.test(text)) return BROWSER_ACTION_TYPE.DOWNLOAD;
  if (/\b(submit|send|apply|publish|proposal|message|email|comment|提交|发送|投递|申请|发布|留言|评论)\b/.test(text))
    return BROWSER_ACTION_TYPE.SUBMIT_LIKE_CLICK;
  if (/\b(fill|type|input|textarea|form|填写|输入)\b/.test(text)) return BROWSER_ACTION_TYPE.FILL_INPUT;
  if (/\b(screenshot|capture|截图)\b/.test(text)) return BROWSER_ACTION_TYPE.SCREENSHOT;
  if (/\b(snapshot|page snapshot|快照)\b/.test(text)) return BROWSER_ACTION_TYPE.SNAPSHOT;
  if (/\b(scroll|滚动)\b/.test(text)) return BROWSER_ACTION_TYPE.SCROLL;
  if (/\b(navigate|open|goto|go to|url|打开|访问|跳转)\b/.test(text)) return BROWSER_ACTION_TYPE.NAVIGATE;
  if (/\b(click|press|tap|button|点击|按钮)\b/.test(text)) return BROWSER_ACTION_TYPE.CLICK;
  if (/\b(read|extract|scrape|observe|page|browser|读取|提取|页面|浏览器)\b/.test(text))
    return BROWSER_ACTION_TYPE.READ_PAGE;
  return BROWSER_ACTION_TYPE.UNKNOWN;
}

function actionFromType(type) {
  if (type === BROWSER_ACTION_TYPE.FILL_INPUT) return "fill";
  if (type === BROWSER_ACTION_TYPE.SCROLL) return "scroll";
  if (type === BROWSER_ACTION_TYPE.SCREENSHOT) return "screenshot";
  if (type === BROWSER_ACTION_TYPE.SNAPSHOT) return "page_snapshot";
  if (type === BROWSER_ACTION_TYPE.NAVIGATE || type === BROWSER_ACTION_TYPE.READ_PAGE) return "open_page";
  if (type === BROWSER_ACTION_TYPE.UNKNOWN) return "browser_action";
  return "click";
}

function normalizeResourceUsage(raw = {}) {
  const source = isObject(raw.resourceUsage || raw.resource_usage) ? raw.resourceUsage || raw.resource_usage : raw;
  return {
    durationMs: Math.max(
      0,
      toNumber(firstDefined(source.durationMs, source.duration_ms, raw.durationMs, raw.duration_ms), 0)
    ),
    actionCount: Math.max(0, toNumber(firstDefined(source.actionCount, source.action_count), 1)),
    screenshotCount: Math.max(
      0,
      toNumber(
        firstDefined(
          source.screenshotCount,
          source.screenshot_count,
          raw.screenshotPath || raw.screenshot_path ? 1 : 0
        ),
        0
      )
    ),
    snapshotSize: Math.max(0, toNumber(firstDefined(source.snapshotSize, source.snapshot_size), 0)),
    bytesWritten: Math.max(0, toNumber(firstDefined(source.bytesWritten, source.bytes_written), 0))
  };
}

function confidenceFor(evidence) {
  if (Number.isFinite(Number(evidence.confidence))) return Math.max(0, Math.min(1, Number(evidence.confidence)));
  let confidence = 0.18;
  if (evidence.ok) confidence += 0.08;
  if (evidence.url) confidence += 0.12;
  if (evidence.title) confidence += 0.08;
  if (evidence.textPreview) confidence += 0.18;
  if (evidence.urlChanged || evidence.titleChanged) confidence += 0.12;
  if (evidence.screenshotPath || evidence.snapshotPath) confidence += 0.1;
  if (evidence.error) confidence -= 0.18;
  return Math.max(0, Math.min(1, Number(confidence.toFixed(2))));
}

function normalizeBrowserEvidence(rawInput = {}, options = {}) {
  const raw = isObject(rawInput) ? rawInput : {};
  const nested = isObject(raw.evidence) && isObject(raw.evidence.browser) ? raw.evidence.browser : {};
  const source = { ...raw, ...nested };
  const previousUrl = sanitizeUrl(
    firstDefined(source.previousUrl, source.previous_url, source.beforeUrl, source.before_url)
  );
  const nextUrl = sanitizeUrl(
    firstDefined(
      source.nextUrl,
      source.next_url,
      source.afterUrl,
      source.after_url,
      source.currentUrl,
      source.current_url,
      source.url
    )
  );
  const url = nextUrl || previousUrl;
  const previousTitle = collapseText(
    firstDefined(source.previousTitle, source.previous_title, source.beforeTitle, source.before_title),
    300
  );
  const title = collapseText(
    firstDefined(source.title, source.nextTitle, source.next_title, source.afterTitle, source.after_title),
    300
  );
  const textPreview = collapseText(
    firstDefined(
      source.textPreview,
      source.text_preview,
      source.pageText,
      source.page_text,
      source.visibleText,
      source.visible_text,
      source.resultText,
      source.result_text
    ),
    4000
  );
  const actionText = [
    source.action,
    source.name,
    source.kind,
    source.detectedActionType,
    source.detected_action_type,
    source.label,
    source.selector,
    source.target,
    textPreview
  ]
    .filter(Boolean)
    .join(" ");
  const detectedActionType = String(
    firstDefined(source.detectedActionType, source.detected_action_type) || detectBrowserActionType(actionText)
  ).trim();
  const timestamp = String(firstDefined(source.timestamp, source.at, options.timestamp) || new Date().toISOString());
  const error = collapseText(firstDefined(source.error, source.errorMessage, source.error_message), 1200);
  const evidence = {
    type: "browser",
    evidenceSource: String(
      firstDefined(
        source.evidenceSource,
        source.evidence_source,
        options.evidenceSource,
        source.adapter,
        source.source,
        EVIDENCE_SOURCE.WORKER
      )
    ),
    action: String(firstDefined(source.action, options.action, actionFromType(detectedActionType))),
    detectedActionType,
    sessionId: collapseText(firstDefined(source.sessionId, source.session_id), 200),
    url,
    previousUrl,
    nextUrl,
    urlChanged: toBoolean(
      firstDefined(source.urlChanged, source.url_changed, source.navigated, source.navigation),
      Boolean(previousUrl && nextUrl && previousUrl !== nextUrl)
    ),
    title,
    previousTitle,
    titleChanged: toBoolean(
      firstDefined(source.titleChanged, source.title_changed),
      Boolean(previousTitle && title && previousTitle !== title)
    ),
    textPreview,
    visibleTextHints: asArray(source.visibleTextHints || source.visible_text_hints)
      .map((item) => collapseText(item, 240))
      .filter(Boolean)
      .slice(0, 8),
    screenshotPath: collapseText(
      sanitizePathForDisplay(firstDefined(source.screenshotPath, source.screenshot_path)),
      800
    ),
    snapshotPath: collapseText(sanitizePathForDisplay(firstDefined(source.snapshotPath, source.snapshot_path)), 800),
    durationMs: Math.max(0, toNumber(firstDefined(source.durationMs, source.duration_ms), 0)),
    timestamp,
    ok: source.ok == null ? !error : source.ok !== false,
    error,
    confidence: toNumber(source.confidence, NaN),
    metadata: sanitizeEvidence(isObject(source.metadata) ? source.metadata : {}),
    resourceUsage: normalizeResourceUsage(source)
  };
  if (!evidence.visibleTextHints.length && textPreview) evidence.visibleTextHints = visibleTextHints(textPreview);
  evidence.confidence = confidenceFor(evidence);

  if (
    !evidence.url &&
    !evidence.title &&
    !evidence.textPreview &&
    !evidence.screenshotPath &&
    !evidence.snapshotPath &&
    !actionText &&
    !options.allowEmpty
  ) {
    return null;
  }

  return {
    ...evidence,
    beforeUrl: evidence.previousUrl,
    afterUrl: evidence.nextUrl,
    currentUrl: evidence.nextUrl || evidence.previousUrl,
    pageText: evidence.textPreview,
    navigated: evidence.urlChanged
  };
}

function normalizeBrowserEvidenceList(values = [], options = {}) {
  const out = [];
  const seen = new Set();
  for (const value of asArray(values)) {
    const normalized = normalizeBrowserEvidence(value, options);
    if (!normalized) continue;
    const key = [
      normalized.evidenceSource,
      normalized.action,
      normalized.detectedActionType,
      normalized.url,
      normalized.textPreview,
      normalized.screenshotPath,
      normalized.snapshotPath
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function browserEvidenceToLegacy(evidence = null) {
  if (!evidence) return {};
  return {
    beforeUrl: evidence.previousUrl || evidence.beforeUrl || "",
    afterUrl: evidence.nextUrl || evidence.afterUrl || evidence.currentUrl || "",
    currentUrl: evidence.currentUrl || evidence.nextUrl || evidence.url || "",
    url: evidence.url || evidence.currentUrl || evidence.nextUrl || "",
    navigated: Boolean(evidence.urlChanged || evidence.navigated),
    urlChanged: Boolean(evidence.urlChanged || evidence.navigated),
    title: evidence.title || "",
    previousTitle: evidence.previousTitle || "",
    titleChanged: Boolean(evidence.titleChanged),
    pageText: evidence.textPreview || evidence.pageText || "",
    textPreview: evidence.textPreview || evidence.pageText || "",
    visibleTextHints: evidence.visibleTextHints || [],
    screenshotPath: evidence.screenshotPath || "",
    snapshotPath: evidence.snapshotPath || "",
    errorMessage: evidence.error || evidence.errorMessage || "",
    detectedActionType: evidence.detectedActionType || "",
    evidenceSource: evidence.evidenceSource || "",
    confidence: evidence.confidence,
    ok: evidence.ok,
    durationMs: evidence.durationMs,
    resourceUsage: evidence.resourceUsage || {}
  };
}

function sectionAfter(text, heading) {
  const pattern = new RegExp(
    `${heading}\\s*[:：]?\\s*([\\s\\S]*?)(?=\\n[A-Z][A-Z _-]{2,}\\s*[:：]|\\n(?:NEXT|STATUS|ACTIONS|RESULT|OUTPUT|OBSERVATION)\\s*[:：]|$)`,
    "i"
  );
  const match = String(text || "").match(pattern);
  return match ? match[1].trim() : "";
}

function extractCodexBrowserEvidence(text, options = {}) {
  const sourceText = String(text || "");
  const hasBrowserSignal =
    /(browser|page|url|opened|clicked|screenshot|submit|login|captcha|页面|浏览器|点击|截图|提交|登录|验证码|https?:\/\/|file:\/\/|data:text\/html)/i.test(
      sourceText
    );
  if (!hasBrowserSignal) return [];
  const actionsText = sectionAfter(sourceText, "ACTIONS") || sectionAfter(sourceText, "操作");
  const resultText =
    sectionAfter(sourceText, "RESULT") ||
    sectionAfter(sourceText, "OUTPUT") ||
    sectionAfter(sourceText, "OBSERVATION") ||
    sourceText;
  const actionLines = actionsText
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 12);
  const urlMatch = sourceText.match(/\b(?:https?:\/\/|file:\/\/|data:text\/html)[^\s"'<>)]{4,}/i);
  const titleMatch = sourceText.match(/(?:title|page title|页面标题)\s*[:：]\s*([^\n]+)/i);
  const screenshotMatch = sourceText.match(
    /(?:screenshot|截图)[^\n:：]*[:：]?\s*([~/./A-Za-z0-9_\-\s]+?\.(?:png|jpg|jpeg|webp))/i
  );
  const combined = [actionsText, resultText].filter(Boolean).join("\n");
  const detectedActionType = detectBrowserActionType(combined);
  const evidence = normalizeBrowserEvidence(
    {
      evidenceSource: options.evidenceSource || EVIDENCE_SOURCE.CODEX_CLI,
      action: actionFromType(detectedActionType),
      detectedActionType,
      url: urlMatch ? urlMatch[0] : "",
      title: titleMatch ? titleMatch[1] : "",
      textPreview: resultText || combined,
      screenshotPath: screenshotMatch ? screenshotMatch[1].trim() : "",
      ok: !/\b(failed|error|exception|timeout|失败|错误|异常|超时)\b/i.test(sourceText),
      metadata: {
        actionHints: actionLines,
        source: options.source || "codex-output"
      },
      confidence: urlMatch ? 0.48 : 0.34
    },
    { evidenceSource: options.evidenceSource || EVIDENCE_SOURCE.CODEX_CLI }
  );
  return evidence ? [evidence] : [];
}

module.exports = {
  actionFromType,
  browserEvidenceToLegacy,
  detectBrowserActionType,
  extractCodexBrowserEvidence,
  normalizeBrowserEvidence,
  normalizeBrowserEvidenceList
};
