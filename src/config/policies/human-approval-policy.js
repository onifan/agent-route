"use strict";

const HUMAN_APPROVAL_POLICY = Object.freeze({
  requireApprovalAtRiskLevel: "high",
  actions: [
    "submit",
    "delete",
    "login",
    "upload",
    "payment",
    "publish",
    "deploy",
    "send_real_message",
    "sudo",
    "rm",
    "rm -rf",
    "database_write",
    "production_change"
  ],
  blockedWithoutApproval: [
    "payment",
    "publish",
    "deploy_production",
    "delete_database",
    "rm -rf_system",
    "send_external_message"
  ]
});

module.exports = {
  HUMAN_APPROVAL_POLICY
};
