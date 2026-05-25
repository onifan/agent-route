"use strict";

const { gateToolAction } = require("../../security/tool-risk-gate");
const browserRuntime = require("./runtime");
const { actionTypeFromText } = require("./result-normalizer");

function browserResult(action, fields = {}) {
  return {
    ok: fields.ok !== false,
    action,
    url: fields.url || fields.currentUrl || "",
    title: fields.title || "",
    pageText: fields.pageText || "",
    screenshotPath: fields.screenshotPath || "",
    durationMs: Math.max(0, Number(fields.durationMs || 0)),
    metadata: fields.metadata || {},
    error: fields.error || "",
    blocked: Boolean(fields.blocked),
    riskLevel: fields.riskLevel || "",
    reasons: Array.isArray(fields.reasons) ? fields.reasons : [],
    requiredApproval: fields.requiredApproval === true,
    actionSummary: fields.actionSummary || ""
  };
}

function blockedBrowserAction(action, gate, startedAt, fields = {}) {
  return browserResult(action, {
    ...fields,
    ok: false,
    blocked: true,
    riskLevel: gate.riskLevel,
    reasons: gate.reasons || [],
    requiredApproval: gate.requiredApproval === true,
    actionSummary: gate.actionSummary || action,
    durationMs: Date.now() - startedAt,
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

async function openPage(page, url, options = {}) {
  const startedAt = Date.now();
  const gate = gateBrowserAction("open_page", { url, actionSummary: `Open browser page ${url}` }, options);
  if (!gate.allowed) return blockedBrowserAction("open_page", gate, startedAt, { url });
  try {
    await page.goto(url, options.gotoOptions || {});
    return browserResult("open_page", {
      url: typeof page.url === "function" ? page.url() : url,
      title: typeof page.title === "function" ? await page.title() : "",
      durationMs: Date.now() - startedAt
    });
  } catch (err) {
    return browserResult("open_page", {
      ok: false,
      url,
      durationMs: Date.now() - startedAt,
      error: err && err.message ? err.message : String(err)
    });
  }
}

async function click(page, selector, options = {}) {
  const startedAt = Date.now();
  const label = options.label || "";
  const detectedActionType = actionTypeFromText(`${selector || ""} ${label}`);
  const gate = gateBrowserAction("click", { selector, label, detectedActionType }, options);
  if (!gate.allowed)
    return blockedBrowserAction("click", gate, startedAt, { metadata: { selector, label, detectedActionType } });
  try {
    await page.click(selector, options.clickOptions || {});
    return browserResult("click", {
      url: typeof page.url === "function" ? page.url() : "",
      durationMs: Date.now() - startedAt,
      metadata: { selector }
    });
  } catch (err) {
    return browserResult("click", {
      ok: false,
      durationMs: Date.now() - startedAt,
      metadata: { selector },
      error: err && err.message ? err.message : String(err)
    });
  }
}

async function fill(page, selector, text, options = {}) {
  const startedAt = Date.now();
  const detectedActionType = actionTypeFromText(`${selector || ""} ${options.label || ""} fill input`);
  const gate = gateBrowserAction("fill", { selector, label: options.label || "", text, detectedActionType }, options);
  if (!gate.allowed) {
    return blockedBrowserAction("fill", gate, startedAt, {
      metadata: { selector, detectedActionType, textLength: String(text || "").length }
    });
  }
  try {
    await page.fill(selector, text, options.fillOptions || {});
    return browserResult("fill", {
      url: typeof page.url === "function" ? page.url() : "",
      durationMs: Date.now() - startedAt,
      metadata: { selector, textLength: String(text || "").length }
    });
  } catch (err) {
    return browserResult("fill", {
      ok: false,
      durationMs: Date.now() - startedAt,
      metadata: { selector },
      error: err && err.message ? err.message : String(err)
    });
  }
}

async function scroll(page, options = {}) {
  const startedAt = Date.now();
  try {
    const x = Number(options.x || 0);
    const y = Number(options.y || 600);
    await page.evaluate(({ scrollX, scrollY }) => window.scrollBy(scrollX, scrollY), { scrollX: x, scrollY: y });
    return browserResult("scroll", {
      url: typeof page.url === "function" ? page.url() : "",
      durationMs: Date.now() - startedAt,
      metadata: { x, y }
    });
  } catch (err) {
    return browserResult("scroll", {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: err && err.message ? err.message : String(err)
    });
  }
}

module.exports = {
  browserClick: browserRuntime.clickBrowserSelector,
  browserFill: browserRuntime.fillBrowserSelector,
  browserOpenPage: browserRuntime.openBrowserPage,
  browserScroll: browserRuntime.scrollBrowserPage,
  browserWaitForSelector: browserRuntime.waitForBrowserSelector,
  browserResult,
  click,
  fill,
  openPage,
  scroll
};
