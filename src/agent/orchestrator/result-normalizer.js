"use strict";

const taskRuntime = require("../tasks");
const budgetGovernor = require("../budget");
const riskEngine = require("../risk");
const verificationEngine = require("../verification");
const workerEvidence = require("../verification/evidence");
const { safeJsonParse } = require("./content-utils");
const protocol = require("./protocol");

const { TASK_STATUS, WORKER_OUTCOME } = taskRuntime;

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasEntries(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

function hasIndependentEvidence(rawEvidence = {}) {
  if (!isObject(rawEvidence)) return false;
  return [
    rawEvidence.browser,
    rawEvidence.shell,
    rawEvidence.files,
    rawEvidence.file,
    rawEvidence.apiResponses,
    rawEvidence.api_responses,
    rawEvidence.api,
    rawEvidence.sideEffects,
    rawEvidence.side_effects,
    rawEvidence.fileChanges,
    rawEvidence.file_changes
  ].some(hasEntries);
}

function isSemanticModelTask(task = {}) {
  const type = String(task.type || task.taskType || "").toLowerCase();
  const pool = String(task.modelPool || task.model_pool || "").toLowerCase();
  const toolWorker = String(task.toolWorker || task.tool_worker || "").toLowerCase();
  if (toolWorker || pool === "codex-cli") return false;
  if (
    /^(web_search|web_read|web_fetch|api_read|http_fetch|local_read|file_read|files_read|filesystem_read|directory_read|project_read|repo_read|repository_read|browser|shell|terminal|command|local_execution|document|document_generate|document_render|file_generate|artifact_generate|planning|plan|strategy|review|verification|final)$/i.test(
      type
    )
  ) {
    return false;
  }
  return (
    !type ||
    /^(analysis|summary|summarize|proposal|writing|draft|report|research|content|extraction|classification|decision|general|answer|synthesis)$/i.test(
      type
    )
  );
}

function hasCompleteSemanticEvidence(rawEvidence = {}) {
  if (!isObject(rawEvidence)) return false;
  const semantic = isObject(rawEvidence.semantic) ? rawEvidence.semantic : {};
  const summary = String(
    semantic.outputSummary || semantic.output_summary || semantic.summary || rawEvidence.summary || ""
  ).trim();
  const coverage = Number(semantic.criteriaCoverage ?? semantic.criteria_coverage);
  const quality = Number(semantic.qualityScore ?? semantic.quality_score);
  const addressesCriteria = semantic.addressesCriteria === true || semantic.addresses_criteria === true;
  return Boolean(
    summary && addressesCriteria && Number.isFinite(coverage) && coverage > 0 && Number.isFinite(quality) && quality > 0
  );
}

function evidenceClaims(rawEvidence = {}) {
  if (!isObject(rawEvidence)) return [];
  return []
    .concat(rawEvidence.claims || rawEvidence.claim || [])
    .map((item) =>
      typeof item === "string" ? item : item && typeof item === "object" ? item.summary || item.claim || item.text : ""
    )
    .filter(Boolean);
}

function modelClaimEvidence(output, resultType = "model_output", claims = []) {
  const summary = String(output || "").trim();
  return {
    provided: false,
    claims: claims.length ? claims : summary ? [summary.slice(0, 500)] : [],
    semantic: {
      outputSummary: summary.slice(0, 2000),
      resultType,
      hallucinationRisk: "high: model claim without standardized evidence"
    }
  };
}

function evidenceInput(rawEvidence, output, resultType = "model_output", task = {}) {
  const summary = String(output || "").trim();
  if (
    rawEvidence &&
    typeof rawEvidence === "object" &&
    !Array.isArray(rawEvidence) &&
    Object.keys(rawEvidence).length
  ) {
    if (hasIndependentEvidence(rawEvidence)) return rawEvidence;
    if (isSemanticModelTask(task) && hasCompleteSemanticEvidence(rawEvidence)) return rawEvidence;
    const semantic = rawEvidence.semantic && typeof rawEvidence.semantic === "object" ? rawEvidence.semantic : {};
    return modelClaimEvidence(
      semantic.outputSummary ||
        semantic.output_summary ||
        rawEvidence.summary ||
        rawEvidence.evidenceSummary ||
        summary,
      resultType,
      evidenceClaims(rawEvidence)
    );
  }
  if (Array.isArray(rawEvidence) && rawEvidence.length) {
    const claims = rawEvidence
      .map((item) =>
        typeof item === "string"
          ? item
          : item && typeof item === "object"
            ? item.summary || item.claim || item.text
            : ""
      )
      .filter(Boolean);
    return modelClaimEvidence(claims.join("; ") || summary, resultType, claims);
  }
  if (!summary) return rawEvidence;
  return modelClaimEvidence(summary, resultType);
}

function makeWorkerRuntimeResult(result, runningTask) {
  const parsed = result && result.content ? safeJsonParse(result.content) : null;
  const isCodexCliResult =
    String(result && result.model ? result.model : runningTask && runningTask.modelPool).toLowerCase() === "codex-cli";
  if (
    parsed &&
    typeof parsed === "object" &&
    (parsed.status || parsed.outcome || parsed.kind || typeof parsed.ok === "boolean")
  ) {
    const output = parsed.output || parsed.result || parsed.content || result.content || "";
    const rawEvidence = hasIndependentEvidence(parsed.evidence)
      ? parsed.evidence
      : hasIndependentEvidence(result && result.evidence)
        ? result.evidence
        : parsed.evidence || (result && result.evidence);
    const evidence = workerEvidence.normalizeEvidence(
      evidenceInput(rawEvidence, output, "structured_worker_output", runningTask),
      {
        context: parsed.context || {},
        artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
        actions: Array.isArray(parsed.actions) ? parsed.actions : [],
        output
      }
    );
    const evidenceContext = workerEvidence.evidenceToContext(evidence);
    return {
      ...parsed,
      kind: parsed.kind || protocol.KIND.WORKER_RESULT,
      schemaVersion: Number(parsed.schemaVersion || protocol.PROTOCOL_VERSION),
      actions: Array.isArray(parsed.actions) ? parsed.actions : [`called:${result.model || runningTask.modelPool}`],
      output,
      error: parsed.error || result.error || "",
      nextStep: parsed.nextStep || parsed.next_step || parsed.next || "",
      artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
      evidence,
      blockedReason: parsed.blockedReason || parsed.blocked_reason || "",
      memoryCandidates: Array.isArray(parsed.memoryCandidates || parsed.memory_candidates)
        ? parsed.memoryCandidates || parsed.memory_candidates
        : [],
      verification: parsed.verification || null,
      context: {
        ...(parsed.context || {}),
        ...evidenceContext,
        model: result.model || "",
        elapsedMs: result.elapsedMs || 0,
        exitCode: parsed.context && parsed.context.exitCode != null ? parsed.context.exitCode : result.code,
        code: parsed.context && parsed.context.code != null ? parsed.context.code : result.code,
        signal: result.signal,
        timedOut: Boolean(result.timedOut),
        stdout: isCodexCliResult
          ? parsed.context && parsed.context.stdout
            ? parsed.context.stdout
            : ""
          : result.stdout || "",
        stderr: isCodexCliResult
          ? parsed.context && parsed.context.stderr
            ? parsed.context.stderr
            : ""
          : result.stderr || ""
      }
    };
  }
  const normalizedOutput = !result.ok && isCodexCliResult && result.error ? result.error : result.content || "";
  const normalizedEvidence = workerEvidence.normalizeEvidence(
    evidenceInput(result.evidence, normalizedOutput, "model_output", runningTask),
    {
      context: {
        exitCode: result.code,
        code: result.code,
        signal: result.signal,
        timedOut: Boolean(result.timedOut),
        stdout: isCodexCliResult ? "" : result.stdout || "",
        stderr: isCodexCliResult ? "" : result.stderr || ""
      },
      artifacts: result.artifacts || [],
      actions: [`called:${result.model || runningTask.modelPool}`],
      output: normalizedOutput
    }
  );
  const normalizedEvidenceContext = workerEvidence.evidenceToContext(normalizedEvidence);
  return {
    kind: protocol.KIND.WORKER_RESULT,
    schemaVersion: protocol.PROTOCOL_VERSION,
    status: result.ok ? WORKER_OUTCOME.SUCCESS : WORKER_OUTCOME.FAILURE,
    actions: [`called:${result.model || runningTask.modelPool}`],
    output: normalizedOutput,
    error: result.error || "",
    nextStep: result.ok ? "" : "Retry with the next available model pool candidate or escalate to the commander.",
    artifacts: result.artifacts || [],
    evidence: normalizedEvidence,
    memoryCandidates: [],
    verification: null,
    context: {
      ...normalizedEvidenceContext,
      model: result.model || "",
      elapsedMs: result.elapsedMs || 0,
      exitCode: result.code,
      code: result.code,
      signal: result.signal,
      timedOut: Boolean(result.timedOut),
      stdout: isCodexCliResult ? "" : result.stdout || "",
      stderr: isCodexCliResult ? "" : result.stderr || ""
    }
  };
}

function applyRiskEvaluationToTaskSummary(task, evaluation) {
  const compact = riskEngine.compactEvaluation(evaluation);
  return {
    ...task,
    riskLevel: compact.riskLevel,
    riskReasons: compact.riskReasons,
    riskSignals: compact.riskSignals,
    requiresHumanApproval: compact.requiresHumanApproval,
    requiresHumanConfirmation: compact.requiresHumanApproval || Boolean(task.requiresHumanConfirmation),
    approvalReason: compact.approvalReason || task.approvalReason || "",
    approvalStatus: compact.approvalStatus,
    escalationReason: compact.escalationReason || "",
    suggestedAction: compact.suggestedAction || "",
    blockedReason: compact.blockedReason || task.blockedReason || "",
    riskHistory: [...(Array.isArray(task.riskHistory) ? task.riskHistory : []), compact].slice(-50)
  };
}

function riskGateWorkerResult(task, evaluation) {
  const blocked = Boolean(evaluation && evaluation.blockedReason);
  const status = blocked ? TASK_STATUS.BLOCKED : TASK_STATUS.WAITING_HUMAN;
  const reason = blocked
    ? evaluation.blockedReason
    : evaluation.approvalReason || "Risk engine requires human approval before execution.";
  return {
    task: { ...task, status },
    ok: false,
    model: "risk-engine",
    content: reason,
    error: blocked ? reason : "",
    status,
    elapsedMs: 0
  };
}

function shouldGateRisk(evaluation, task = {}) {
  if (!evaluation) return false;
  if (evaluation.blockedReason) return true;
  return Boolean(evaluation.requiresHumanApproval && task.approvalStatus !== riskEngine.APPROVAL_STATUS.APPROVED);
}

function applyVerificationToTaskSummary(task, verification) {
  const compact = verificationEngine.compactVerification(verification);
  return {
    ...task,
    verified: compact.verified,
    verificationStatus: compact.verificationStatus,
    verificationConfidence: compact.confidence,
    verificationReasons: compact.reasons,
    detectedIssues: compact.detectedIssues,
    verificationReasonCode: compact.reasonCode,
    missingEvidence: compact.missingEvidence,
    rejectedEvidence: compact.rejectedEvidence,
    verificationSuggestedNextState: compact.suggestedNextState,
    verificationRetryable: compact.retryable,
    verificationHistory: [...(Array.isArray(task.verificationHistory) ? task.verificationHistory : []), compact].slice(
      -50
    )
  };
}

function applyBudgetEvaluationToTaskSummary(task, evaluation) {
  const compact = budgetGovernor.compactEvaluation(evaluation);
  return {
    ...task,
    budgetUsage: compact.usage,
    budgetStatus: compact.status,
    degradationLevel: compact.degradationLevel,
    budgetWarnings: compact.warnings,
    budgetBlockedReason: compact.blockedReason,
    blockedReason: compact.blockedReason || task.blockedReason || "",
    budgetHistory: [...(Array.isArray(task.budgetHistory) ? task.budgetHistory : []), compact].slice(-50)
  };
}

function shouldGateBudget(evaluation) {
  if (!evaluation) return false;
  return Boolean(
    evaluation.blockedReason ||
    evaluation.status === budgetGovernor.BUDGET_STATUS.BLOCKED ||
    evaluation.status === budgetGovernor.BUDGET_STATUS.EXHAUSTED
  );
}

function budgetGateWorkerResult(task, evaluation) {
  const compact = budgetGovernor.compactEvaluation(evaluation);
  const reason = compact.blockedReason || compact.warnings[0] || "Budget governor paused execution.";
  return {
    task: { ...task, status: TASK_STATUS.BLOCKED },
    ok: false,
    model: "budget-governor",
    content: reason,
    error: reason,
    status: TASK_STATUS.BLOCKED,
    elapsedMs: 0,
    budgetEvaluation: compact
  };
}

function verificationGateWorkerResult(task, verification) {
  const compact = verificationEngine.compactVerification(verification);
  const blocked = compact.suggestedNextState === verificationEngine.SUGGESTED_NEXT_STATE.BLOCKED;
  const failed = compact.suggestedNextState === verificationEngine.SUGGESTED_NEXT_STATE.FAILED;
  const needsEvidence = compact.suggestedNextState === verificationEngine.SUGGESTED_NEXT_STATE.NEEDS_EVIDENCE;
  const status = blocked
    ? TASK_STATUS.BLOCKED
    : failed
      ? TASK_STATUS.FAILED
      : needsEvidence
        ? TASK_STATUS.NEEDS_EVIDENCE
        : TASK_STATUS.RETRY_READY;
  const reason =
    compact.detectedIssues.map((item) => item.issue || item).join("; ") ||
    compact.reasons.join("; ") ||
    "Verification did not confirm worker success.";
  return {
    task: { ...task, status },
    ok: false,
    model: "verification-engine",
    content: reason,
    error: reason,
    status,
    elapsedMs: 0
  };
}

module.exports = {
  applyBudgetEvaluationToTaskSummary,
  applyRiskEvaluationToTaskSummary,
  applyVerificationToTaskSummary,
  budgetGateWorkerResult,
  makeWorkerRuntimeResult,
  riskGateWorkerResult,
  shouldGateBudget,
  shouldGateRisk,
  verificationGateWorkerResult
};
