"use strict";

const { EVIDENCE_SOURCE } = require("./evidence-types");
const {
  browserEvidenceToLegacy,
  extractCodexBrowserEvidence,
  normalizeBrowserEvidence,
  normalizeBrowserEvidenceList
} = require("./browser-evidence-normalizer");

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item != null);
  if (value == null || value === "") return [];
  return [value];
}

function extractBrowserEvidenceCandidates(rawEvidence = {}, legacy = {}) {
  const raw = isObject(rawEvidence) ? rawEvidence : {};
  const hasStructuredEvidence = [
    raw.browser,
    raw.browserEvidence,
    raw.browser_evidence,
    raw.normalizedEvidence,
    raw.normalized_evidence,
    raw.shell,
    raw.apiResponses,
    raw.api_responses,
    raw.api,
    raw.semantic,
    raw.claims,
    raw.claim
  ].some((item) => item != null && item !== "" && (!Array.isArray(item) || item.length > 0));
  const context = isObject(legacy.context) ? legacy.context : {};
  const source =
    legacy.evidenceSource ||
    legacy.source ||
    (String(context.model || legacy.model || "").includes("codex-cli")
      ? EVIDENCE_SOURCE.CODEX_CLI
      : EVIDENCE_SOURCE.WORKER);
  const values = [];
  values.push(raw.browser, raw.browserEvidence, raw.browser_evidence);
  if (isObject(raw.normalizedEvidence || raw.normalized_evidence)) {
    values.push((raw.normalizedEvidence || raw.normalized_evidence).browser);
  }
  values.push(context.browser, context.browserEvidence, legacy.browser);
  if (isObject(legacy.toolResult) || isObject(legacy.browserResult))
    values.push(legacy.toolResult || legacy.browserResult);
  const normalized = normalizeBrowserEvidenceList(values.flatMap(asArray), { evidenceSource: source });
  const outputText = [
    raw.summary,
    legacy.output,
    legacy.content,
    hasStructuredEvidence ? "" : context.stdout,
    hasStructuredEvidence ? "" : context.stderr,
    source === EVIDENCE_SOURCE.CODEX_CLI && !hasStructuredEvidence && Array.isArray(legacy.actions)
      ? legacy.actions.map((action) => (typeof action === "string" ? action : JSON.stringify(action))).join("\n")
      : ""
  ]
    .filter(Boolean)
    .join("\n");
  const shouldExtractTextEvidence =
    !hasStructuredEvidence &&
    (source === EVIDENCE_SOURCE.CODEX_CLI ||
      /\b(?:STATUS|ACTIONS|RESULT|OBSERVATION|OUTPUT)\s*[:：]/i.test(outputText));
  const extracted = shouldExtractTextEvidence
    ? extractCodexBrowserEvidence(outputText, { evidenceSource: source })
    : [];
  return normalizeBrowserEvidenceList([...normalized, ...extracted], { evidenceSource: source }).slice(0, 12);
}

function normalizeWorkerEvidence(workerResult = {}, options = {}) {
  const rawEvidence = isObject(workerResult.evidence) ? workerResult.evidence : {};
  const browserEvidence = extractBrowserEvidenceCandidates(rawEvidence, {
    ...options,
    context: workerResult.context || options.context || {},
    actions: workerResult.actions || options.actions || [],
    output: workerResult.output || workerResult.result || workerResult.content || options.output || "",
    content: workerResult.content || options.content || "",
    model: workerResult.model || options.model || ""
  });
  const browser = browserEvidenceToLegacy(browserEvidence[0]);
  return {
    ...rawEvidence,
    browser: {
      ...(isObject(rawEvidence.browser) ? rawEvidence.browser : {}),
      ...browser
    },
    browserEvidence,
    normalizedEvidence: {
      ...(isObject(rawEvidence.normalizedEvidence) ? rawEvidence.normalizedEvidence : {}),
      browser: browserEvidence
    }
  };
}

module.exports = {
  extractBrowserEvidenceCandidates,
  normalizeWorkerEvidence
};
