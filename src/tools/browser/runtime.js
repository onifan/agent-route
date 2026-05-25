"use strict";

const fs = require("fs");
const path = require("path");
const { gateToolAction } = require("../../security/tool-risk-gate");
const { agentRoutePath } = require("../../shared/utils/agent-home");
const filesTool = require("../files");
const {
  closeBrowserSession,
  createBrowserSession,
  getBrowserSession,
  getBrowserSessionStatus,
  listBrowserSessions,
  touchSession
} = require("./session-manager");
const { actionTypeFromText, collapseText, errorBrowserResult, normalizeBrowserResult } = require("./result-normalizer");

function blockedBrowserResult(action, gate, fields = {}) {
  return normalizeBrowserResult(action, {
    ...fields,
    ok: false,
    blocked: true,
    riskLevel: gate.riskLevel,
    reasons: gate.reasons || [],
    requiredApproval: gate.requiredApproval === true,
    actionSummary: gate.actionSummary || action,
    error: gate.error || "Browser action blocked by risk gate."
  });
}

function gateBrowserAction(action, fields = {}, options = {}) {
  return gateToolAction({
    tool: "browser",
    action,
    detectedActionType: fields.detectedActionType,
    selector: fields.selector,
    label: fields.label,
    text: fields.text,
    url: fields.url,
    title: fields.title,
    actionSummary: fields.actionSummary || `${action} ${fields.selector || fields.url || fields.label || ""}`.trim(),
    approvalStatus: options.approvalStatus || options.approval_status,
    approved: options.approved === true || options.humanApproved === true
  });
}

function browserOutputDir(config = {}, kind = "screenshots") {
  const key = kind === "snapshots" ? "snapshotDir" : "screenshotDir";
  const configured = config[key];
  const dir = configured || agentRoutePath("browser", kind);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function filePathFor(config = {}, kind = "screenshots", suffix = ".json") {
  return filesTool.tempFilePath({
    prefix: `browser-${kind.slice(0, -1) || kind}`,
    suffix,
    dir: browserOutputDir(config, kind)
  });
}

async function ensureSession(sessionId, options = {}) {
  if (sessionId) {
    const existing = getBrowserSession(sessionId);
    if (existing) return { ok: true, session: existing };
    return { ok: false, error: "Browser session not found." };
  }
  const created = await createBrowserSession(options);
  if (!created.ok) return { ok: false, error: created.error || "Unable to create browser session." };
  return { ok: true, session: getBrowserSession(created.sessionId), created };
}

async function openBrowserPage(sessionId, url, options = {}) {
  const startedAt = Date.now();
  const gate = gateBrowserAction("open_page", { url, actionSummary: `Open browser page ${url}` }, options);
  if (!gate.allowed)
    return blockedBrowserResult("open_page", gate, { url, afterUrl: url, durationMs: Date.now() - startedAt });
  const sessionResult = await ensureSession(sessionId, options);
  if (!sessionResult.ok) return errorBrowserResult("open_page", sessionResult.error, { sessionId });
  const session = sessionResult.session;
  const beforeUrl = session.currentUrl || (await session.adapter.currentUrl().catch(() => ""));
  const beforeTitle = await session.adapter.title().catch(() => "");
  try {
    const opened = await session.adapter.openUrl(url, options.gotoOptions || {});
    touchSession(session, opened.currentUrl);
    return normalizeBrowserResult("open_page", {
      sessionId: session.sessionId,
      adapter: session.adapterName,
      beforeUrl,
      beforeTitle,
      afterUrl: opened.currentUrl,
      title: opened.title,
      pageText: opened.pageText,
      navigated: true,
      durationMs: Date.now() - startedAt,
      maxTextLength: session.config.maxTextLength,
      metadata: {
        browserType: session.browserType,
        detectedActionType: "read_page",
        createdSession: sessionResult.created ? true : undefined
      }
    });
  } catch (err) {
    return errorBrowserResult("open_page", err, {
      sessionId: session.sessionId,
      adapter: session.adapterName,
      beforeUrl,
      durationMs: Date.now() - startedAt
    });
  }
}

async function getBrowserState(sessionId) {
  const startedAt = Date.now();
  const session = getBrowserSession(sessionId);
  if (!session) return errorBrowserResult("browser_state", "Browser session not found.", { sessionId });
  try {
    const currentUrl = await session.adapter.currentUrl();
    const title = await session.adapter.title();
    const pageText = await session.adapter.pageText();
    touchSession(session, currentUrl);
    return normalizeBrowserResult("browser_state", {
      sessionId: session.sessionId,
      adapter: session.adapterName,
      afterUrl: currentUrl,
      title,
      pageText,
      durationMs: Date.now() - startedAt,
      maxTextLength: session.config.maxTextLength,
      metadata: { detectedActionType: "read_page" }
    });
  } catch (err) {
    return errorBrowserResult("browser_state", err, { sessionId, durationMs: Date.now() - startedAt });
  }
}

async function getBrowserText(sessionId) {
  return getBrowserState(sessionId);
}

async function captureBrowserScreenshot(sessionId, options = {}) {
  const startedAt = Date.now();
  const session = getBrowserSession(sessionId);
  if (!session) return errorBrowserResult("screenshot", "Browser session not found.", { sessionId });
  const screenshotPath = options.path || filePathFor(session.config, "screenshots", ".png");
  try {
    await session.adapter.screenshot(screenshotPath, options.screenshotOptions || {});
    const info = filesTool.pathInfo(screenshotPath, { includeHash: true });
    const currentUrl = await session.adapter.currentUrl().catch(() => session.currentUrl || "");
    const title = await session.adapter.title().catch(() => "");
    touchSession(session, currentUrl);
    return normalizeBrowserResult("screenshot", {
      sessionId,
      adapter: session.adapterName,
      afterUrl: currentUrl,
      title,
      screenshotPath,
      durationMs: Date.now() - startedAt,
      bytesWritten: info.size > 0 ? info.size : 0,
      metadata: { size: info.size, hash: info.hash || "", detectedActionType: "read_page" }
    });
  } catch (err) {
    return errorBrowserResult("screenshot", err, { sessionId, screenshotPath, durationMs: Date.now() - startedAt });
  }
}

function fitSnapshot(snapshot, maxBytes) {
  let output = { ...snapshot };
  let json = JSON.stringify(output, null, 2);
  if (Buffer.byteLength(json, "utf8") <= maxBytes) return { output, json };
  const allowedText = Math.max(
    200,
    maxBytes - Buffer.byteLength(JSON.stringify({ ...output, textPreview: "" }), "utf8") - 100
  );
  output = {
    ...output,
    textPreview: collapseText(output.textPreview || "", allowedText),
    truncated: true
  };
  json = JSON.stringify(output, null, 2);
  return { output, json };
}

async function captureBrowserSnapshot(sessionId, options = {}) {
  const startedAt = Date.now();
  const session = getBrowserSession(sessionId);
  if (!session) return errorBrowserResult("page_snapshot", "Browser session not found.", { sessionId });
  const snapshotPath = options.path || filePathFor(session.config, "snapshots", ".json");
  try {
    const currentUrl = await session.adapter.currentUrl();
    const title = await session.adapter.title();
    const pageText = await session.adapter.pageText();
    const snapshot = {
      url: currentUrl,
      title,
      textPreview: collapseText(pageText, Number(options.maxTextLength || session.config.maxTextLength || 4000)),
      timestamp: new Date().toISOString(),
      metadata: { adapter: session.adapterName, browserType: session.browserType }
    };
    const fitted = fitSnapshot(snapshot, Number(options.maxSnapshotBytes || session.config.maxSnapshotBytes || 24000));
    const written = filesTool.writeTextFile(snapshotPath, fitted.json);
    touchSession(session, currentUrl);
    return normalizeBrowserResult("page_snapshot", {
      sessionId,
      adapter: session.adapterName,
      afterUrl: currentUrl,
      title,
      pageText: fitted.output.textPreview,
      snapshotPath,
      snapshotSize: written.size,
      bytesWritten: written.bytesWritten,
      durationMs: Date.now() - startedAt,
      metadata: { detectedActionType: "read_page", truncated: fitted.output.truncated || false }
    });
  } catch (err) {
    return errorBrowserResult("page_snapshot", err, { sessionId, snapshotPath, durationMs: Date.now() - startedAt });
  }
}

async function clickBrowserSelector(sessionId, selector, options = {}) {
  const startedAt = Date.now();
  const label = options.label || options.text || "";
  const detectedActionType = actionTypeFromText(`${selector || ""} ${label}`);
  const gate = gateBrowserAction("click", { selector, label, detectedActionType }, options);
  if (!gate.allowed) {
    return blockedBrowserResult("click", gate, {
      sessionId,
      durationMs: Date.now() - startedAt,
      metadata: { selector, label, detectedActionType }
    });
  }
  const session = getBrowserSession(sessionId);
  if (!session) return errorBrowserResult("click", "Browser session not found.", { sessionId });
  const beforeUrl = await session.adapter.currentUrl().catch(() => session.currentUrl || "");
  const beforeTitle = await session.adapter.title().catch(() => "");
  try {
    const clicked = await session.adapter.click(selector, options.clickOptions || {});
    const afterUrl = clicked.currentUrl || (await session.adapter.currentUrl().catch(() => beforeUrl));
    const title = clicked.title || (await session.adapter.title().catch(() => beforeTitle));
    touchSession(session, afterUrl);
    return normalizeBrowserResult("click", {
      sessionId,
      adapter: session.adapterName,
      beforeUrl,
      beforeTitle,
      afterUrl,
      title,
      pageText: clicked.pageText,
      navigated: beforeUrl && afterUrl && beforeUrl !== afterUrl,
      domChanged: clicked.domChanged,
      durationMs: Date.now() - startedAt,
      maxTextLength: session.config.maxTextLength,
      metadata: { selector, detectedActionType, label: options.label || "" }
    });
  } catch (err) {
    return errorBrowserResult("click", err, {
      sessionId,
      beforeUrl,
      beforeTitle,
      durationMs: Date.now() - startedAt,
      metadata: { selector }
    });
  }
}

async function fillBrowserSelector(sessionId, selector, text, options = {}) {
  const startedAt = Date.now();
  const detectedActionType = actionTypeFromText(`${selector || ""} ${options.label || ""} fill input`);
  const gate = gateBrowserAction("fill", { selector, label: options.label || "", text, detectedActionType }, options);
  if (!gate.allowed) {
    return blockedBrowserResult("fill", gate, {
      sessionId,
      durationMs: Date.now() - startedAt,
      metadata: { selector, detectedActionType, textLength: String(text == null ? "" : text).length }
    });
  }
  const session = getBrowserSession(sessionId);
  if (!session) return errorBrowserResult("fill", "Browser session not found.", { sessionId });
  const beforeUrl = await session.adapter.currentUrl().catch(() => session.currentUrl || "");
  const beforeTitle = await session.adapter.title().catch(() => "");
  try {
    const filled = await session.adapter.fill(selector, text, options.fillOptions || {});
    const afterUrl = filled.currentUrl || (await session.adapter.currentUrl().catch(() => beforeUrl));
    const title = filled.title || (await session.adapter.title().catch(() => beforeTitle));
    touchSession(session, afterUrl);
    return normalizeBrowserResult("fill", {
      sessionId,
      adapter: session.adapterName,
      beforeUrl,
      beforeTitle,
      afterUrl,
      title,
      pageText: filled.pageText,
      domChanged: true,
      durationMs: Date.now() - startedAt,
      maxTextLength: session.config.maxTextLength,
      metadata: { selector, textLength: String(text == null ? "" : text).length, detectedActionType: "fill_input" }
    });
  } catch (err) {
    return errorBrowserResult("fill", err, {
      sessionId,
      beforeUrl,
      beforeTitle,
      durationMs: Date.now() - startedAt,
      metadata: { selector }
    });
  }
}

async function scrollBrowserPage(sessionId, options = {}) {
  const startedAt = Date.now();
  const session = getBrowserSession(sessionId);
  if (!session) return errorBrowserResult("scroll", "Browser session not found.", { sessionId });
  try {
    const scrolled = await session.adapter.scroll({ x: options.x || 0, y: options.y || 600 });
    const afterUrl = scrolled.currentUrl || (await session.adapter.currentUrl().catch(() => session.currentUrl || ""));
    touchSession(session, afterUrl);
    return normalizeBrowserResult("scroll", {
      sessionId,
      adapter: session.adapterName,
      afterUrl,
      title: scrolled.title,
      pageText: scrolled.pageText,
      durationMs: Date.now() - startedAt,
      maxTextLength: session.config.maxTextLength,
      metadata: { x: Number(options.x || 0), y: Number(options.y || 600), detectedActionType: "scroll" }
    });
  } catch (err) {
    return errorBrowserResult("scroll", err, { sessionId, durationMs: Date.now() - startedAt });
  }
}

async function waitForBrowserSelector(sessionId, selector, options = {}) {
  const startedAt = Date.now();
  const session = getBrowserSession(sessionId);
  if (!session) return errorBrowserResult("wait_for_selector", "Browser session not found.", { sessionId });
  try {
    const waited = await session.adapter.waitForSelector(selector, options.waitOptions || {});
    const afterUrl = waited.currentUrl || (await session.adapter.currentUrl().catch(() => session.currentUrl || ""));
    touchSession(session, afterUrl);
    return normalizeBrowserResult("wait_for_selector", {
      ok: waited.found !== false,
      sessionId,
      adapter: session.adapterName,
      afterUrl,
      title: waited.title,
      pageText: waited.pageText,
      durationMs: Date.now() - startedAt,
      metadata: { selector, found: waited.found !== false, detectedActionType: "read_page" }
    });
  } catch (err) {
    return errorBrowserResult("wait_for_selector", err, {
      sessionId,
      durationMs: Date.now() - startedAt,
      metadata: { selector }
    });
  }
}

module.exports = {
  captureBrowserScreenshot,
  captureBrowserSnapshot,
  clickBrowserSelector,
  closeBrowserSession,
  createBrowserSession,
  getBrowserState,
  getBrowserText,
  getBrowserSessionStatus,
  listBrowserSessions,
  openBrowserPage,
  scrollBrowserPage,
  waitForBrowserSelector,
  fillBrowserSelector
};
