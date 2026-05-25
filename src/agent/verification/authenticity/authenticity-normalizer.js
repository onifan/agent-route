"use strict";

function collapseText(value) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
}

function list(value) {
  if (Array.isArray(value)) return value.filter((item) => item != null);
  if (value == null || value === "") return [];
  return [value];
}

function normalizeForCompare(value) {
  return collapseText(value)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function workerText(workerResult = {}) {
  const evidence = workerResult.evidence || {};
  return [
    workerResult.output,
    workerResult.error,
    workerResult.nextStep,
    evidence.summary,
    Array.isArray(evidence.claims) ? evidence.claims.join("\n") : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function taskText(task = {}) {
  return [
    task.title,
    task.description,
    task.type,
    task.prompt,
    Array.isArray(task.successCriteria) ? task.successCriteria.join(" ") : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function extractListItems(text = "") {
  const lines = String(text || "")
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const items = [];
  for (const line of lines) {
    const match = line.match(/^(?:[-*•]|\d+[.)、])\s*(.+)$/);
    if (match) {
      items.push(match[1].trim());
      continue;
    }
    if (/https?:\/\/|(?:\$|USD|RMB|¥|预算|budget)|\s[·|-]\s/.test(line) && line.length >= 8) {
      items.push(line);
    }
  }
  return items.slice(0, 80);
}

function expectedCount(text = "") {
  const source = String(text || "");
  const numeric = source.match(
    /(?:find|search|list|整理|搜索|列出|找到)\s*(\d{1,2})|(\d{1,2})\s*(?:projects|jobs|items|results|个|条)/i
  );
  if (!numeric) return 0;
  const value = Number(numeric[1] || numeric[2]);
  return Number.isFinite(value) && value > 0 && value <= 50 ? value : 0;
}

function itemFields(item = "") {
  const text = collapseText(item);
  const link = text.match(/https?:\/\/[^\s)）]+/i)?.[0] || "";
  const hasBudget = /(?:\$|USD|RMB|¥|预算|budget|\d+\s*(?:\/hr|hour|fixed|美元|元))/i.test(text);
  const title = text
    .replace(/https?:\/\/[^\s)）]+/gi, "")
    .replace(/(?:\$|USD|RMB|¥|预算|budget)\s*[:：]?\s*[\w./-]+/gi, "")
    .split(/[·|-]/)[0]
    .trim();
  return {
    title,
    link,
    hasTitle: title.length >= 3,
    hasLink: Boolean(link),
    hasBudget
  };
}

function normalizedBrowserEvidence(workerResult = {}, context = {}) {
  const evidence = workerResult.evidence || {};
  const browserItems = [
    ...(Array.isArray(evidence.browserEvidence) ? evidence.browserEvidence : []),
    ...(evidence.normalizedEvidence && Array.isArray(evidence.normalizedEvidence.browser)
      ? evidence.normalizedEvidence.browser
      : []),
    evidence.browser,
    workerResult.context && workerResult.context.browser,
    context.browser
  ].filter((item) => item && typeof item === "object");
  if (!browserItems.length) {
    return {
      ...((workerResult.context && workerResult.context.browser) || {}),
      ...(context.browser || {}),
      ...(evidence.browser || {})
    };
  }
  const scoreBrowserEvidence = (item = {}) => {
    const textLength = collapseText(item.pageText || item.textPreview || item.visibleText || "").length;
    return (
      (item.url || item.currentUrl || item.afterUrl ? 2 : 0) +
      (collapseText(item.title || item.currentTitle).length >= 3 ? 2 : 0) +
      (textLength >= 80 ? 3 : textLength >= 20 ? 1 : 0) -
      (item.error || item.errorMessage ? 3 : 0)
    );
  };
  const primary = browserItems.reduce(
    (best, item) => (scoreBrowserEvidence(item) > scoreBrowserEvidence(best) ? item : best),
    {}
  );
  return primary;
}

function outputSentences(text = "") {
  return String(text || "")
    .split(/[\n。.!?！？]+/)
    .map((item) => collapseText(item))
    .filter((item) => item.length >= 8)
    .slice(0, 80);
}

module.exports = {
  collapseText,
  expectedCount,
  extractListItems,
  itemFields,
  list,
  normalizeForCompare,
  normalizedBrowserEvidence,
  outputSentences,
  taskText,
  workerText
};
