"use strict";

/**
 * @typedef {Object} AgentTask
 * @property {string} id
 * @property {string} goalId
 * @property {string} title
 * @property {string} status
 * @property {string} [type]
 * @property {string} [modelPool]
 * @property {string} [riskLevel]
 * @property {string[]} [dependsOn]
 * @property {string[]} [produces]
 * @property {string[]} [consumes]
 */

/**
 * @typedef {Object} RiskResult
 * @property {"low"|"medium"|"high"|"critical"} riskLevel
 * @property {string[]} reasons
 * @property {boolean} requiresHumanApproval
 * @property {string} [blockedReason]
 * @property {string} [approvalReason]
 */

/**
 * @typedef {Object} ToolAction
 * @property {"web"|"shell"|"files"|"browser"|"codex-cli"} tool
 * @property {string} action
 * @property {string} [command]
 * @property {string[]} [args]
 * @property {string} [path]
 * @property {string} [url]
 * @property {string} [actionSummary]
 * @property {string} [approvalStatus]
 */

/**
 * @typedef {Object} ToolResult
 * @property {boolean} ok
 * @property {string} action
 * @property {boolean} [blocked]
 * @property {string} [riskLevel]
 * @property {string[]} [reasons]
 * @property {boolean} [requiredApproval]
 * @property {string} [actionSummary]
 * @property {string} [error]
 * @property {number} [durationMs]
 */

/**
 * @typedef {Object} BudgetState
 * @property {string} goalId
 * @property {Object} usage
 * @property {Object} policy
 * @property {string[]} warnings
 * @property {string} [status]
 * @property {string} [degradationLevel]
 */

/**
 * @typedef {Object} VerificationResult
 * @property {boolean} verified
 * @property {"verified"|"partially_verified"|"unverified"} verificationStatus
 * @property {number} confidence
 * @property {string[]} reasons
 * @property {Array<Object|string>} detectedIssues
 * @property {string} [reasonCode]
 * @property {Array<Object>} [missingEvidence]
 * @property {Array<Object>} [rejectedEvidence]
 * @property {string} suggestedNextState
 * @property {boolean} retryable
 */

module.exports = {};
