"use strict";

const {
  collapseText,
  expectedCount,
  extractListItems,
  itemFields,
  normalizeForCompare,
  normalizedBrowserEvidence,
  outputSentences,
  taskText,
  workerText
} = require("./authenticity-normalizer");
const { createScore, finalizeScore, penalize, reward } = require("./authenticity-score");

const PLACEHOLDER_RE =
  /\b(lorem ipsum|placeholder|dummy|sample only|tbd|todo|n\/a|xxx|待补充|占位|示例标题|空标题|假数据)\b/i;
const TEMPLATE_RE =
  /\b(dear client|i am excited to apply|as an ai language model|insert project|your project caught my eye|模板|套话|复制粘贴|这里填写)\b/i;

function evaluateOutputPresenceAuthenticity(state, task = {}, workerResult = {}) {
  const output = collapseText(workerText(workerResult));
  const claimedSuccess = /\b(success|successful|completed|done|ok|成功|完成|已完成)\b/i.test(
    String(workerResult.status || workerResult.outcome || "")
  );
  if (output) return null;
  const result = createScore(claimedSuccess ? 0.18 : 0.32);
  penalize(
    result,
    claimedSuccess ? 0.06 : 0.02,
    claimedSuccess ? "Worker claimed success but produced no result content." : "Worker produced no result content."
  );
  state.authenticitySignals.push({ kind: "output", empty: true, claimedSuccess });
  return finalizeScore(result);
}

function outputLooksLikeList(task = {}, output = "") {
  const text = `${taskText(task)} ${output}`;
  const items = extractListItems(output);
  if (expectedCount(text) > 0) return true;
  if (items.length >= 3) return true;
  return /\b(list|items|results)\b|列表|结果/i.test(text) && items.length > 0;
}

function evaluateListAuthenticity(state, task = {}, workerResult = {}) {
  const output = workerText(workerResult);
  if (
    /\b(browser|browser_read|web_read|web_search|web_fetch|api_read|http_fetch|local_read|file_read|filesystem_read|page_read|navigate|网页|浏览器)\b/i.test(
      String(task.type || "")
    )
  )
    return null;
  if (!outputLooksLikeList(task, workerResult.output || "")) return null;
  const items = extractListItems(output);
  const expected = expectedCount(taskText(task));
  const result = createScore(0.82);

  if (expected && items.length < expected)
    penalize(
      result,
      Math.min(0.35, (expected - items.length) * 0.08),
      `List has ${items.length} items but expected ${expected}.`
    );
  else if (expected && items.length >= expected)
    reward(result, 0.06, `List count satisfies expected ${expected} items.`);
  if (!items.length) penalize(result, 0.32, "List-like task produced no parseable list items.");

  const normalized = items.map(normalizeForCompare).filter(Boolean);
  const duplicates = normalized.length - new Set(normalized).size;
  if (duplicates > 0)
    penalize(result, Math.min(0.48, duplicates * 0.15), `List contains ${duplicates} duplicate-looking item(s).`);

  const fields = items.map(itemFields);
  if (fields.length) {
    const titleRate = fields.filter((item) => item.hasTitle).length / fields.length;
    const linkRate = fields.filter((item) => item.hasLink).length / fields.length;
    const budgetRate = fields.filter((item) => item.hasBudget).length / fields.length;
    if (titleRate < 0.8) penalize(result, 0.3, "List has empty or weak titles.");
    else reward(result, 0.04, "List titles are mostly present.");
    if (/(?:\b(?:link|url)\b|链接)/i.test(taskText(task)) && linkRate < 0.8)
      penalize(result, 0.34, "List is missing expected links.");
    else if (linkRate >= 0.8) reward(result, 0.04, "List links are mostly present.");
    if (/(?:\b(?:budget|price|rate)\b|预算|报价|金额)/i.test(taskText(task)) && budgetRate < 0.7)
      penalize(result, 0.28, "List is missing expected budget/rate fields.");
    else if (budgetRate >= 0.7) reward(result, 0.04, "List budget/rate fields are mostly present.");
  }

  const shortItems = items.filter((item) => collapseText(item).length < 8).length;
  if (shortItems)
    penalize(result, Math.min(0.18, shortItems * 0.06), "Some list items are too short to be meaningful.");
  if (PLACEHOLDER_RE.test(output)) penalize(result, 0.2, "Output contains placeholder-like text.");
  state.authenticitySignals.push({ kind: "list", items: items.length, expected, duplicates });
  return finalizeScore(result);
}

function evaluateBrowserAuthenticity(state, task = {}, workerResult = {}, context = {}) {
  const actions = Array.isArray(workerResult.actions) ? workerResult.actions.join(" ") : "";
  const taskType = String(task.type || "").toLowerCase();
  if (/^(planning|plan|strategy|review|verification|decision|final|summary)$/i.test(taskType)) return null;
  const explicitBrowserTask = /\b(browser|browser_read|web_read|page_read|navigate|网页|浏览器)\b/i.test(
    `${taskType} ${task.modelPool || ""}`
  );
  const explicitBrowserAction =
    /\b(open page|navigate|click|scroll|fill|browser|screenshot|snapshot|打开网页|浏览器|点击|滚动|截图)\b/i.test(
      actions
    );
  const browser = normalizedBrowserEvidence(workerResult, context);
  const hasBrowserEvidence = Boolean(
    browser.url ||
    browser.currentUrl ||
    browser.afterUrl ||
    browser.nextUrl ||
    browser.title ||
    browser.currentTitle ||
    browser.pageText ||
    browser.textPreview ||
    browser.visibleText ||
    browser.screenshotPath ||
    browser.snapshotPath ||
    browser.error ||
    browser.errorMessage
  );
  const actualBrowserCapableWorker = /^(browser-tool|web-tool|codex-cli)$/i.test(
    String(workerResult.model || task.modelPool || "")
  );
  if (!explicitBrowserTask && !hasBrowserEvidence && !(explicitBrowserAction && actualBrowserCapableWorker))
    return null;
  const result = createScore(0.74);
  const url = browser.url || browser.currentUrl || browser.afterUrl || browser.nextUrl || "";
  const title = browser.title || browser.currentTitle || "";
  const pageText = browser.pageText || browser.textPreview || browser.visibleText || "";
  const confirmedAction = Boolean(
    browser.successMessage ||
    browser.success_message ||
    browser.formDisappeared ||
    browser.form_disappeared ||
    browser.submitButtonDisabled ||
    browser.submitButtonDisappeared ||
    browser.urlChanged ||
    browser.navigated ||
    browser.navigation === true
  );

  if (url) reward(result, 0.08, "Browser URL evidence is present.");
  else penalize(result, 0.18, "Browser result has no URL evidence.");
  if (browser.urlChanged || browser.navigated || browser.navigation === true)
    reward(result, 0.06, "Browser navigation/change evidence is present.");
  if (confirmedAction) reward(result, 0.12, "Browser action has independent confirmation evidence.");
  if (title && collapseText(title).length >= 3) reward(result, 0.06, "Browser title evidence is present.");
  else if (!confirmedAction) penalize(result, 0.12, "Browser title is empty.");
  if (collapseText(pageText).length >= 80) reward(result, 0.1, "Browser page text is substantial.");
  else if (collapseText(pageText).length >= 20) reward(result, 0.04, "Browser page text is present.");
  else if (!confirmedAction) penalize(result, 0.22, "Browser page text is empty or too short.");
  if (browser.screenshotPath || browser.snapshotPath)
    reward(result, 0.05, "Browser screenshot or snapshot evidence is present.");
  if (browser.error || browser.errorMessage) penalize(result, 0.2, "Browser evidence includes an error.");
  state.authenticitySignals.push({ kind: "browser", hasUrl: Boolean(url), textLength: collapseText(pageText).length });
  return finalizeScore(result);
}

function evaluateProposalAuthenticity(state, task = {}, workerResult = {}) {
  const output = workerText(workerResult);
  const text = `${taskText(task)} ${output}`;
  if (
    /\b(browser|browser_read|web_read|web_search|web_fetch|api_read|http_fetch|submit|payment|delete|login|网页|浏览器|提交|支付|删除|登录)\b/i.test(
      task.type || ""
    )
  )
    return null;
  if (!/\b(proposal|cover letter|bid|draft|application|提案|草稿|回复|申请)\b/i.test(text)) return null;
  const result = createScore(0.78);
  const words = output.split(/\s+/).filter(Boolean).length;
  const chars = collapseText(output).length;
  const sentences = outputSentences(output);
  const uniqueSentences = new Set(sentences.map(normalizeForCompare)).size;

  if (chars < 90 && words < 50) penalize(result, 0.24, "Proposal draft is too short.");
  else reward(result, 0.08, "Proposal draft has enough substance.");
  if (/\b(requirement|csv|api|browser|automation|python|需求|交付|实现|确认|样例数据|异常规则)\b/i.test(output))
    reward(result, 0.08, "Proposal references project-specific information.");
  else penalize(result, 0.2, "Proposal lacks project-specific information.");
  if (TEMPLATE_RE.test(output)) penalize(result, 0.22, "Proposal contains template-like text.");
  if (sentences.length >= 3 && uniqueSentences / sentences.length < 0.7)
    penalize(result, 0.18, "Proposal contains repeated sentences.");
  state.authenticitySignals.push({ kind: "proposal", chars, sentences: sentences.length });
  return finalizeScore(result);
}

function mergeAuthenticityResults(results = []) {
  const valid = results.filter(Boolean);
  if (!valid.length)
    return {
      authenticityScore: 0.82,
      authenticityWarnings: [],
      authenticityReasons: ["No specialized authenticity rule was needed for this result."]
    };
  const score = Math.min(...valid.map((item) => Number(item.authenticityScore || 0)));
  return {
    authenticityScore: Number(score.toFixed(2)),
    authenticityWarnings: [...new Set(valid.flatMap((item) => item.authenticityWarnings || []))].slice(0, 20),
    authenticityReasons: [...new Set(valid.flatMap((item) => item.authenticityReasons || []))].slice(0, 20)
  };
}

module.exports = {
  evaluateOutputPresenceAuthenticity,
  evaluateBrowserAuthenticity,
  evaluateListAuthenticity,
  evaluateProposalAuthenticity,
  mergeAuthenticityResults
};
