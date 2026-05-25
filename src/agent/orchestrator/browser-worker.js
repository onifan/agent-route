"use strict";

const browserTool = require("../../tools/browser");
const protocol = require("./protocol");

function taskText(task = {}) {
  return [task.input, task.prompt, task.description, task.title].filter(Boolean).join("\n");
}

function extractUrl(task = {}) {
  const text = taskText(task);
  const dataMatch = text.match(/\bdata:text\/html[^)\]}\s"'<>]*/i);
  if (dataMatch) return dataMatch[0];
  const urlMatch = text.match(/\bhttps?:\/\/[^)\]}\s"'<>]+/i);
  return urlMatch ? urlMatch[0] : "";
}

function browserEvidence(...results) {
  const browserEvidenceItems = [];
  for (const result of results) {
    if (result && result.evidence && result.evidence.browser) browserEvidenceItems.push(result.evidence.browser);
    if (result && result.evidence && Array.isArray(result.evidence.browserEvidence)) {
      browserEvidenceItems.push(...result.evidence.browserEvidence);
    }
  }
  return {
    browser: browserEvidenceItems[0] || {},
    browserEvidence: browserEvidenceItems,
    normalizedEvidence: {
      browser: browserEvidenceItems
    }
  };
}

function workerContent({
  status,
  actions = [],
  output = "",
  error = "",
  nextStep = "",
  artifacts = [],
  evidence = {},
  riskLevel = "low",
  riskReasons = []
}) {
  return JSON.stringify({
    kind: protocol.KIND.WORKER_RESULT,
    schemaVersion: protocol.PROTOCOL_VERSION,
    status,
    actions,
    output,
    error,
    nextStep,
    artifacts,
    evidence,
    memoryCandidates: [],
    riskLevel,
    riskReasons
  });
}

async function runBrowserWorker(task = {}, config = {}) {
  const startedAt = Date.now();
  const url = extractUrl(task);
  if (!url) {
    const evidence = {
      summary: "Browser task did not include a URL to open.",
      semantic: {
        outputSummary: "Browser worker could not run because no URL was supplied.",
        addressesCriteria: false,
        criteriaCoverage: 0,
        qualityScore: 0
      }
    };
    return {
      task,
      ok: false,
      model: "browser-tool",
      content: workerContent({
        status: "failure",
        actions: ["browser:missing_url"],
        error: "Browser task did not include a URL to open.",
        nextStep: "Provide a concrete URL for the browser worker or reroute to a non-browser worker.",
        evidence
      }),
      error: "Browser task did not include a URL to open.",
      elapsedMs: Date.now() - startedAt,
      actions: ["browser:missing_url"],
      evidence
    };
  }

  const browserOptions = {
    ...(config.tools && config.tools.browser ? config.tools.browser : {}),
    adapter: "playwright",
    allowMockFallback: false,
    headless: true,
    approved: task.approvalStatus === "approved" || task.approved === true || task.humanApproved === true
  };
  let sessionId = "";
  try {
    const opened = await browserTool.openBrowserPage("", url, browserOptions);
    sessionId =
      opened.sessionId || (opened.evidence && opened.evidence.browser && opened.evidence.browser.sessionId) || "";
    if (!opened.ok) {
      const evidence = browserEvidence(opened);
      return {
        task,
        ok: false,
        model: "browser-tool",
        content: workerContent({
          status: "failure",
          actions: ["browser:open_page"],
          error: opened.error || "Browser page open failed.",
          nextStep: "Review the browser error and retry only if the URL/action is still necessary and safe.",
          evidence
        }),
        error: opened.error || "Browser page open failed.",
        elapsedMs: Date.now() - startedAt,
        actions: ["browser:open_page"],
        evidence
      };
    }
    const snapshot = sessionId
      ? await browserTool.captureBrowserSnapshot(sessionId, browserOptions)
      : { ok: false, error: "Browser session was not created.", evidence: {} };
    const evidence = browserEvidence(opened, snapshot);
    const text = opened.textPreview || opened.pageText || snapshot.textPreview || snapshot.pageText || "";
    const title = opened.title || snapshot.title || "";
    const artifacts = [opened.screenshotPath, opened.snapshotPath, snapshot.snapshotPath]
      .filter(Boolean)
      .map((item) => ({
        type: "browser_evidence",
        path: item
      }));
    const output = [`URL: ${opened.url || url}`, title ? `Title: ${title}` : "", text ? `Text: ${text}` : ""]
      .filter(Boolean)
      .join("\n");
    const ok = Boolean(text || title);
    return {
      task,
      ok,
      model: "browser-tool",
      content: workerContent({
        status: ok ? "success" : "failure",
        actions: ["browser:open_page", "browser:page_snapshot"],
        output,
        error: ok ? "" : "Browser opened the URL but returned no readable text.",
        nextStep: ok ? "" : "Use a more specific URL or a different safe evidence path.",
        artifacts,
        evidence
      }),
      error: ok ? "" : "Browser opened the URL but returned no readable text.",
      elapsedMs: Date.now() - startedAt,
      actions: ["browser:open_page", "browser:page_snapshot"],
      artifacts,
      evidence
    };
  } catch (err) {
    const error = err && err.message ? err.message : String(err);
    const evidence = {
      summary: error,
      semantic: {
        outputSummary: "Browser worker failed before producing usable evidence.",
        addressesCriteria: false,
        criteriaCoverage: 0,
        qualityScore: 0
      }
    };
    return {
      task,
      ok: false,
      model: "browser-tool",
      content: workerContent({
        status: "failure",
        actions: ["browser:error"],
        error,
        nextStep: "Inspect the browser runtime error and retry only with a safe, concrete action.",
        evidence
      }),
      error,
      elapsedMs: Date.now() - startedAt,
      actions: ["browser:error"],
      evidence
    };
  } finally {
    if (sessionId) await browserTool.closeBrowserSession(sessionId).catch(() => {});
  }
}

function shouldUseBrowserWorker(task = {}) {
  const type = String(task.type || "").toLowerCase();
  if (String(task.modelPool || "").toLowerCase() === "codex-cli") return false;
  if (/^(web_search|web_read|web_fetch|api_read|http_fetch|public_web_read|public_api_read)$/.test(type)) return false;
  if (type === "browser" || type === "browser_read" || type === "page_read") return true;
  if (
    /^(planning|plan|strategy|review|verification|final|summary|analysis)$/i.test(type) ||
    /^(commander|planner|review)$/i.test(String(task.modelPool || ""))
  ) {
    return false;
  }
  const text = taskText(task);
  const hasReadIntent =
    /\b(open|read|extract|navigate|summarize)\b/i.test(text) || /打开|读取|提取|浏览|总结|摘要/i.test(text);
  return Boolean(extractUrl(task) && hasReadIntent && /browser|page|web|url|网页|浏览器|页面/i.test(text));
}

module.exports = {
  extractUrl,
  runBrowserWorker,
  shouldUseBrowserWorker
};
