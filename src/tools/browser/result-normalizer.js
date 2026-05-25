"use strict";

function collapseText(value, max = 4000) {
  const text = String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function redactSensitive(value) {
  let text = String(value == null ? "" : value);
  const patterns = [
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|token|password|passwd|pwd|cookie|secret)\b\s*[:=]\s*['"]?[^'"\s]{6,}/gi
  ];
  for (const pattern of patterns) text = text.replace(pattern, "[REDACTED_SECRET]");
  return text;
}

function safeMetadata(metadata = {}) {
  const output = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    if (/password|token|cookie|secret|authorization/i.test(key)) {
      output[key] = "[REDACTED]";
    } else if (typeof value === "string") {
      output[key] = redactSensitive(value).slice(0, 500);
    } else if (typeof value === "number" || typeof value === "boolean") {
      output[key] = value;
    } else if (value == null) {
      output[key] = value;
    } else {
      output[key] = redactSensitive(JSON.stringify(value)).slice(0, 500);
    }
  }
  return output;
}

function normalizeBrowserResult(action, fields = {}) {
  const textPreview = collapseText(
    fields.textPreview || fields.pageText || fields.visibleText || "",
    fields.maxTextLength || 4000
  );
  const beforeUrl = String(fields.beforeUrl || fields.previousUrl || "");
  const afterUrl = String(fields.afterUrl || fields.currentUrl || fields.url || "");
  const beforeTitle = String(fields.beforeTitle || fields.previousTitle || "");
  const title = String(fields.title || fields.afterTitle || "");
  const screenshotPath = String(fields.screenshotPath || "");
  const snapshotPath = String(fields.snapshotPath || "");
  const metadata = safeMetadata(fields.metadata || {});
  const detectedActionType = String(
    fields.detectedActionType || metadata.detectedActionType || actionTypeFromText(`${action} ${textPreview}`)
  );
  const urlChanged = Boolean(
    fields.navigated || fields.urlChanged || (beforeUrl && afterUrl && beforeUrl !== afterUrl)
  );
  const result = {
    type: "browser",
    ok: fields.ok !== false,
    evidenceSource: String(
      fields.evidenceSource ||
        fields.evidence_source ||
        (fields.adapter === "mock" ? "mock" : fields.adapter === "playwright" ? "playwright" : "browser-tool")
    ),
    action,
    detectedActionType,
    sessionId: String(fields.sessionId || ""),
    adapter: String(fields.adapter || ""),
    url: afterUrl,
    previousUrl: beforeUrl,
    nextUrl: afterUrl,
    currentUrl: afterUrl,
    beforeUrl,
    afterUrl,
    urlChanged,
    title,
    previousTitle: beforeTitle,
    beforeTitle,
    afterTitle: title,
    titleChanged: Boolean(fields.titleChanged || (beforeTitle && title && beforeTitle !== title)),
    textPreview,
    visibleTextHints: textPreview
      ? textPreview
          .split(/(?<=[.!?。！？])\s+|\n+/)
          .map((item) => collapseText(item, 220))
          .filter(Boolean)
          .slice(0, 6)
      : [],
    pageText: textPreview,
    screenshotPath,
    snapshotPath,
    durationMs: Math.max(0, Number(fields.durationMs || 0)),
    timestamp: String(fields.timestamp || new Date().toISOString()),
    error: fields.error ? redactSensitive(fields.error) : "",
    blocked: Boolean(fields.blocked),
    riskLevel: fields.riskLevel || "",
    reasons: Array.isArray(fields.reasons) ? fields.reasons.map(String) : [],
    requiredApproval: Boolean(fields.requiredApproval),
    actionSummary: fields.actionSummary || "",
    confidence: Math.max(
      0,
      Math.min(1, Number(fields.confidence || (textPreview || afterUrl || screenshotPath || snapshotPath ? 0.7 : 0.35)))
    ),
    metadata,
    resourceUsage: {
      durationMs: Math.max(0, Number(fields.durationMs || 0)),
      actionCount: Number(fields.actionCount || 1),
      screenshotCount: screenshotPath ? 1 : 0,
      snapshotSize: Math.max(0, Number(fields.snapshotSize || 0)),
      bytesWritten: Math.max(0, Number(fields.bytesWritten || 0))
    }
  };
  result.evidence = {
    browser: {
      type: "browser",
      evidenceSource: result.evidenceSource,
      action: result.action,
      detectedActionType: result.detectedActionType,
      sessionId: result.sessionId,
      url: result.url,
      previousUrl: result.previousUrl,
      nextUrl: result.nextUrl,
      urlChanged: result.urlChanged,
      beforeUrl: result.beforeUrl,
      afterUrl: result.afterUrl,
      currentUrl: result.currentUrl,
      title: result.title,
      previousTitle: result.previousTitle,
      titleChanged: result.titleChanged,
      pageText: result.pageText,
      textPreview: result.textPreview,
      visibleTextHints: result.visibleTextHints,
      navigated: Boolean(fields.navigated || fields.urlChanged || (beforeUrl && afterUrl && beforeUrl !== afterUrl)),
      domChanged: fields.domChanged,
      domChangeCount: fields.domChangeCount,
      screenshotPath: result.screenshotPath,
      snapshotPath: result.snapshotPath,
      errorMessage: result.error,
      durationMs: result.durationMs,
      timestamp: result.timestamp,
      ok: result.ok,
      confidence: result.confidence,
      metadata: result.metadata,
      resourceUsage: result.resourceUsage
    }
  };
  result.evidence.browserEvidence = [result.evidence.browser];
  result.evidence.normalizedEvidence = { browser: result.evidence.browserEvidence };
  return result;
}

function errorBrowserResult(action, err, fields = {}) {
  return normalizeBrowserResult(action, {
    ...fields,
    ok: false,
    error: err && err.message ? err.message : String(err)
  });
}

function actionTypeFromText(value = "") {
  const text = String(value || "").toLowerCase();
  if (/\b(pay|payment|checkout|付款|支付)\b/.test(text)) return "payment_like_click";
  if (/\b(delete|remove|destroy|删除)\b/.test(text)) return "delete_like_click";
  if (/\b(submit|send|apply|publish|提交|发送|申请|发布)\b/.test(text)) return "submit_like_click";
  if (/\b(login|sign in|登录)\b/.test(text)) return "login_like_action";
  if (/\b(upload|上传)\b/.test(text)) return "upload";
  if (/\b(download|下载)\b/.test(text)) return "download";
  if (/\b(fill|type|input|填写|输入)\b/.test(text)) return "fill_input";
  if (/\b(click|button|点击|按钮)\b/.test(text)) return "click";
  if (/\b(scroll|滚动)\b/.test(text)) return "scroll";
  return "read_page";
}

module.exports = {
  actionTypeFromText,
  collapseText,
  errorBrowserResult,
  normalizeBrowserResult,
  redactSensitive
};
