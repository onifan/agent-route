"use strict";

const {
  browserEvidenceToLegacy,
  normalizeBrowserEvidence: normalizeCanonicalBrowserEvidence
} = require("../evidence/browser-evidence-normalizer");
const { extractBrowserEvidenceCandidates } = require("../evidence/worker-evidence-normalizer");
const { redactSensitiveText } = require("../evidence/evidence-sanitizer");

const EVIDENCE_VERSION = 1;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function collapseText(value) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
}

function redactSensitive(value) {
  return redactSensitiveText(value);
}

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

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function toBoolean(value) {
  if (value === true || value === false) return value;
  if (value == null || value === "") return undefined;
  const text = String(value).toLowerCase();
  if (["true", "yes", "1"].includes(text)) return true;
  if (["false", "no", "0"].includes(text)) return false;
  return undefined;
}

function safeString(value, limit = 2000) {
  const source =
    value && typeof value === "object"
      ? (() => {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })()
      : value;
  const text = redactSensitive(collapseText(source));
  return text ? text.slice(0, limit) : "";
}

function normalizeExpectedContent(value) {
  if (value == null || value === "") return {};
  if (typeof value === "object") {
    return {
      expectedContent: safeString(value, 1200),
      expectedContentObject: clone(value)
    };
  }
  return {
    expectedContent: safeString(value, 1200)
  };
}

function normalizeAction(action) {
  if (action == null) return null;
  if (typeof action === "string") return { type: "action", description: safeString(action, 500) };
  if (!isObject(action)) return { type: "action", description: safeString(action, 500) };
  return prune({
    type: safeString(action.type || action.kind || "action", 80),
    action: safeString(action.action || action.name || "", 120),
    label: safeString(action.label || action.text || "", 180),
    target: safeString(action.target || action.selector || action.path || action.url || "", 300),
    description: safeString(action.description || action.summary || "", 500)
  });
}

function normalizeClaim(claim) {
  if (claim == null) return "";
  if (typeof claim === "string") return safeString(claim, 500);
  if (isObject(claim)) return safeString(claim.claim || claim.text || claim.summary || JSON.stringify(claim), 500);
  return safeString(claim, 500);
}

function normalizeBrowserEvidence(raw = {}) {
  if (!isObject(raw)) return {};
  const canonical = normalizeCanonicalBrowserEvidence(raw, {
    evidenceSource: raw.evidenceSource || raw.evidence_source || "worker"
  });
  const legacy = canonical ? browserEvidenceToLegacy(canonical) : {};
  return prune({
    ...legacy,
    domChanged:
      toBoolean(firstDefined(raw.domChanged, raw.dom_changed)) ??
      (toNumber(raw.domChangeCount || raw.dom_change_count) > 0 ? true : undefined),
    domChangeCount: toNumber(firstDefined(raw.domChangeCount, raw.dom_change_count)),
    successMessage: safeString(firstDefined(raw.successMessage, raw.success_message, raw.message), 700),
    submitButtonDisabled: toBoolean(
      firstDefined(raw.submitButtonDisabled, raw.submit_button_disabled, raw.buttonDisabled, raw.button_disabled)
    ),
    submitButtonDisappeared: toBoolean(firstDefined(raw.submitButtonDisappeared, raw.submit_button_disappeared)),
    formDisappeared: toBoolean(firstDefined(raw.formDisappeared, raw.form_disappeared)),
    loginPage: toBoolean(firstDefined(raw.loginPage, raw.login_page)),
    captcha: toBoolean(raw.captcha)
  });
}

function normalizeShellEvidence(raw = {}) {
  if (!isObject(raw)) return {};
  return prune({
    command: safeString(raw.command, 1200),
    exitCode: toNumber(firstDefined(raw.exitCode, raw.exit_code, raw.code)),
    code: toNumber(firstDefined(raw.code, raw.exitCode, raw.exit_code)),
    signal: safeString(raw.signal, 80),
    timedOut: toBoolean(firstDefined(raw.timedOut, raw.timed_out)),
    stdout: safeString(raw.stdout, 6000),
    stderr: safeString(raw.stderr, 6000),
    outputDirs: asArray(raw.outputDirs || raw.output_dirs)
      .map((item) => safeString(item, 500))
      .filter(Boolean),
    processStarted: toBoolean(firstDefined(raw.processStarted, raw.process_started)),
    pid: toNumber(raw.pid)
  });
}

function normalizeFileEvidence(raw) {
  if (raw == null) return null;
  const item = typeof raw === "string" ? { path: raw } : isObject(raw) ? raw : {};
  const expected = normalizeExpectedContent(firstDefined(item.expectedContent, item.expected_content));
  const normalized = prune({
    path: safeString(firstDefined(item.path, item.file, item.filename, item.target), 800),
    exists: toBoolean(item.exists),
    size: toNumber(item.size),
    beforeSize: toNumber(firstDefined(item.beforeSize, item.before_size)),
    afterSize: toNumber(firstDefined(item.afterSize, item.after_size, item.size)),
    beforeHash: safeString(firstDefined(item.beforeHash, item.before_hash), 160),
    afterHash: safeString(firstDefined(item.afterHash, item.after_hash, item.hash), 160),
    ...expected,
    evidenceRole: safeString(firstDefined(item.evidenceRole, item.evidence_role, item.role, item.kind), 80),
    expectedContentRequired: toBoolean(
      firstDefined(
        item.expectedContentRequired,
        item.expected_content_required,
        item.verifyContent,
        item.verify_content
      )
    ),
    verifyContent: toBoolean(firstDefined(item.verifyContent, item.verify_content)),
    changeType: safeString(firstDefined(item.changeType, item.change_type, item.operation), 80),
    deleted: toBoolean(item.deleted),
    expected: item.expected === undefined ? undefined : toBoolean(item.expected),
    broad: toBoolean(item.broad)
  });
  return normalized.path || normalized.changeType || normalized.deleted != null ? normalized : null;
}

function normalizeApiEvidence(raw) {
  if (raw == null) return null;
  const item = isObject(raw) ? raw : {};
  const body = firstDefined(item.body, item.responseBody, item.response_body);
  const normalized = prune({
    method: safeString(item.method, 20),
    url: safeString(item.url, 800),
    status: toNumber(firstDefined(item.status, item.statusCode, item.status_code, item.code)),
    body:
      typeof body === "string"
        ? safeString(body, 4000)
        : body == null
          ? undefined
          : safeString(JSON.stringify(body), 4000),
    writeConfirmed: toBoolean(firstDefined(item.writeConfirmed, item.write_confirmed, item.persisted)),
    persisted: toBoolean(item.persisted),
    createdId: safeString(firstDefined(item.createdId, item.created_id), 300),
    updatedId: safeString(firstDefined(item.updatedId, item.updated_id), 300),
    error: safeString(item.error, 1000),
    query: safeString(firstDefined(item.query, item.searchQuery, item.search_query, item.requestQuery), 300),
    evidenceRole: safeString(firstDefined(item.evidenceRole, item.evidence_role, item.role), 80)
  });
  return normalized.url || normalized.status != null || normalized.body || normalized.error ? normalized : null;
}

function normalizeSemanticEvidence(raw = {}, legacy = {}) {
  const source = isObject(raw) ? raw : {};
  return prune({
    outputSummary: safeString(
      firstDefined(source.outputSummary, source.output_summary, source.summary, legacy.output),
      2500
    ),
    resultType: safeString(firstDefined(source.resultType, source.result_type), 120),
    addressesCriteria: toBoolean(firstDefined(source.addressesCriteria, source.addresses_criteria)),
    criteriaCoverage: toNumber(firstDefined(source.criteriaCoverage, source.criteria_coverage)),
    qualityScore: toNumber(firstDefined(source.qualityScore, source.quality_score)),
    qualitySignals: asArray(source.qualitySignals || source.quality_signals)
      .map((item) => safeString(item, 500))
      .filter(Boolean),
    qualityIssues: asArray(source.qualityIssues || source.quality_issues)
      .map((item) => safeString(item, 500))
      .filter(Boolean),
    hallucinationRisk: safeString(firstDefined(source.hallucinationRisk, source.hallucination_risk), 120)
  });
}

function normalizeSideEffect(raw) {
  if (raw == null) return null;
  const item = typeof raw === "string" ? { description: raw } : isObject(raw) ? raw : {};
  return prune({
    type: safeString(item.type || item.kind || item.operation, 120),
    target: safeString(item.target || item.path || item.url, 800),
    description: safeString(item.description || item.summary || item.reason, 800),
    expected: item.expected === undefined ? undefined : toBoolean(item.expected),
    deleted: toBoolean(item.deleted),
    broad: toBoolean(item.broad),
    riskLevel: safeString(firstDefined(item.riskLevel, item.risk_level), 40)
  });
}

function prune(value) {
  const out = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item == null || item === "") continue;
    if (Array.isArray(item) && !item.length) continue;
    out[key] = item;
  }
  return out;
}

function normalizeEvidence(rawEvidence = undefined, legacy = {}) {
  const raw = isObject(rawEvidence) ? rawEvidence : {};
  const provided = typeof raw.provided === "boolean" ? raw.provided : Object.keys(raw).length > 0;
  const context = isObject(legacy.context) ? legacy.context : {};
  const rawShell = {
    ...(isObject(context.shell) ? context.shell : {}),
    exitCode: firstDefined(context.exitCode, context.code, context.shell && context.shell.exitCode),
    code: firstDefined(context.code, context.exitCode, context.shell && context.shell.code),
    signal: context.signal,
    timedOut: context.timedOut,
    stdout: context.stdout,
    stderr: context.stderr,
    outputDirs: context.outputDirs,
    ...(isObject(raw.shell) ? raw.shell : {})
  };
  const files = [...asArray(raw.files || raw.file), ...asArray(legacy.artifacts), ...asArray(context.files)]
    .map(normalizeFileEvidence)
    .filter(Boolean);
  const apiResponses = [
    ...asArray(raw.apiResponses || raw.api_responses || raw.api),
    ...asArray(context.apiResponses || context.api_responses)
  ]
    .map(normalizeApiEvidence)
    .filter(Boolean);
  const sideEffects = [
    ...asArray(raw.sideEffects || raw.side_effects),
    ...asArray(raw.fileChanges || raw.file_changes),
    ...asArray(context.fileChanges || context.file_changes)
  ]
    .map(normalizeSideEffect)
    .filter(Boolean);
  const rawBrowser = {
    ...(isObject(context.browser) ? context.browser : {}),
    ...(isObject(raw.browser) ? raw.browser : {})
  };
  const browserEvidence = extractBrowserEvidenceCandidates(raw, {
    context,
    artifacts: legacy.artifacts,
    actions: [...asArray(raw.actions), ...asArray(legacy.actions)],
    output: legacy.output,
    content: legacy.content,
    model: firstDefined(context.model, legacy.model),
    source: legacy.source,
    evidenceSource: legacy.evidenceSource
  });
  const browser = prune({
    ...normalizeBrowserEvidence(rawBrowser),
    ...browserEvidenceToLegacy(browserEvidence[0])
  });
  const shell = normalizeShellEvidence(rawShell);
  const semantic = normalizeSemanticEvidence(raw.semantic, legacy);
  const claims = asArray(raw.claims || raw.claim)
    .map(normalizeClaim)
    .filter(Boolean);
  const actions = [...asArray(raw.actions), ...asArray(legacy.actions)].map(normalizeAction).filter(Boolean);

  return {
    version: EVIDENCE_VERSION,
    provided,
    summary: safeString(raw.summary || raw.evidenceSummary || raw.evidence_summary || "", 1200),
    claims,
    actions,
    browser,
    browserEvidence,
    normalizedEvidence: {
      browser: browserEvidence
    },
    shell,
    files,
    apiResponses,
    semantic,
    sideEffects
  };
}

function evidenceToContext(evidence = {}) {
  const shell = evidence.shell || {};
  return prune({
    evidenceVersion: evidence.version || EVIDENCE_VERSION,
    evidenceProvided: Boolean(evidence.provided),
    browser: evidence.browser || {},
    browserEvidence: evidence.browserEvidence || [],
    normalizedEvidence: evidence.normalizedEvidence || {},
    shell,
    files: evidence.files || [],
    apiResponses: evidence.apiResponses || [],
    fileChanges: evidence.sideEffects || [],
    outputDirs: shell.outputDirs || [],
    exitCode: shell.exitCode,
    code: shell.code,
    signal: shell.signal,
    timedOut: shell.timedOut,
    stdout: shell.stdout,
    stderr: shell.stderr
  });
}

function compactEvidence(evidence = {}) {
  const normalized = normalizeEvidence(evidence, {});
  const compactBrowserEvidence = (normalized.browserEvidence || []).slice(0, 20).map((item) =>
    prune({
      ...item,
      textPreview: item.textPreview ? item.textPreview.slice(0, 1200) : undefined,
      pageText: item.pageText ? item.pageText.slice(0, 1200) : undefined
    })
  );
  return {
    ...normalized,
    claims: (normalized.claims || []).slice(0, 20),
    actions: (normalized.actions || []).slice(0, 20),
    browser: prune({
      ...normalized.browser,
      pageText:
        normalized.browser && normalized.browser.pageText ? normalized.browser.pageText.slice(0, 1200) : undefined
    }),
    browserEvidence: compactBrowserEvidence,
    normalizedEvidence: {
      ...(normalized.normalizedEvidence || {}),
      browser: compactBrowserEvidence
    },
    files: (normalized.files || []).slice(0, 20),
    apiResponses: (normalized.apiResponses || []).slice(0, 20).map((item) =>
      prune({
        ...item,
        body: item.body ? safeString(item.body, 1200) : undefined,
        error: item.error ? safeString(item.error, 800) : undefined
      })
    ),
    sideEffects: (normalized.sideEffects || []).slice(0, 20),
    shell: prune({
      ...normalized.shell,
      stdout: normalized.shell && normalized.shell.stdout ? normalized.shell.stdout.slice(0, 1200) : undefined,
      stderr: normalized.shell && normalized.shell.stderr ? normalized.shell.stderr.slice(0, 1200) : undefined
    })
  };
}

module.exports = {
  EVIDENCE_VERSION,
  compactEvidence,
  evidenceToContext,
  normalizeEvidence,
  redactSensitive
};
