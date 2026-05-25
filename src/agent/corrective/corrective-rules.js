"use strict";

const { CORRECTIVE_ACTION, PRIORITY, action } = require("./corrective-actions");

const RISK_RANK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });

function hasCode(state, code) {
  return state.warningCodes.includes(code);
}

function add(actions, next) {
  actions.push(next);
}

function applyAuthenticityRules(state, actions) {
  if (state.authenticityScore > 0 && state.authenticityScore < 0.35) {
    add(
      actions,
      action(
        CORRECTIVE_ACTION.MARK_AS_BLOCKED,
        PRIORITY.CRITICAL,
        "真实性评分低于 0.35，当前结果高度可疑，不能继续当作完成结果。",
        "authenticity_below_0_35",
        "authenticity",
        { authenticityScore: state.authenticityScore }
      )
    );
  }
  if (hasCode(state, "duplicate_items")) {
    add(
      actions,
      action(
        CORRECTIVE_ACTION.RETRY_TASK,
        PRIORITY.HIGH,
        "结果包含重复项目，建议重跑当前任务并要求去重。",
        "duplicate_items",
        "authenticity"
      )
    );
  }
  if (hasCode(state, "empty_link")) {
    add(
      actions,
      action(
        CORRECTIVE_ACTION.RERUN_BROWSER,
        PRIORITY.HIGH,
        "结果缺少链接，建议重新读取来源页面或重新提取浏览器证据。",
        "empty_link",
        "authenticity"
      )
    );
  }
  if (hasCode(state, "empty_title")) {
    add(
      actions,
      action(
        CORRECTIVE_ACTION.REQUEST_MORE_DATA,
        PRIORITY.MEDIUM,
        "结果存在空标题或弱标题，建议补充来源数据后再验证。",
        "empty_title",
        "authenticity"
      )
    );
  }
  if (hasCode(state, "placeholder_content")) {
    add(
      actions,
      action(
        CORRECTIVE_ACTION.REQUEST_HUMAN_REVIEW,
        PRIORITY.HIGH,
        "结果包含占位或模板内容，建议人工检查后决定是否重试。",
        "placeholder_content",
        "authenticity"
      )
    );
  }
  if (hasCode(state, "empty_output")) {
    add(
      actions,
      action(
        CORRECTIVE_ACTION.REQUEST_MORE_DATA,
        PRIORITY.HIGH,
        "执行器没有返回可用结果，建议补充输入或重跑任务。",
        "empty_output",
        "authenticity"
      )
    );
  }
}

function applyRiskRules(state, actions) {
  const rank = RISK_RANK[state.riskLevel] || 0;
  if (rank >= RISK_RANK.high || state.requiresHumanApproval) {
    add(
      actions,
      action(
        CORRECTIVE_ACTION.REQUEST_HUMAN_REVIEW,
        rank >= RISK_RANK.critical ? PRIORITY.CRITICAL : PRIORITY.HIGH,
        state.riskReasons[0] || state.blockedReason || "任务风险较高，继续前需要人工复核。",
        "high_risk",
        "risk",
        { riskLevel: state.riskLevel }
      )
    );
  }
}

function applyVerificationRules(state, actions) {
  if (
    state.suggestedNextState === "blocked" &&
    !actions.some((item) => item.type === CORRECTIVE_ACTION.MARK_AS_BLOCKED)
  ) {
    add(
      actions,
      action(
        CORRECTIVE_ACTION.MARK_AS_BLOCKED,
        PRIORITY.HIGH,
        "验证层建议阻断当前任务，等待人工检查或重新规划。",
        "verification_blocked",
        "verification"
      )
    );
  }
  if (state.verificationStatus === "unverified" && state.retryable && !actions.length) {
    add(
      actions,
      action(
        CORRECTIVE_ACTION.RETRY_TASK,
        PRIORITY.MEDIUM,
        "验证未通过但仍可重试，建议改变方法后重跑当前任务。",
        "verification_unverified",
        "verification"
      )
    );
  }
  if (state.verificationStatus === "unverified" && state.retryable && state.modelPool === "free") {
    add(
      actions,
      action(
        CORRECTIVE_ACTION.RETRY_WITH_DIFFERENT_MODEL,
        PRIORITY.MEDIUM,
        "免费模型结果未通过验证，建议换一个更稳定的模型重试。",
        "free_model_unverified",
        "verification"
      )
    );
  }
}

function applyContinueRule(state, actions) {
  if (actions.length) return;
  add(
    actions,
    action(
      CORRECTIVE_ACTION.CONTINUE,
      PRIORITY.LOW,
      "未发现需要纠正的问题，可以继续后续流程。",
      "no_correction_needed",
      "corrective"
    )
  );
}

module.exports = {
  applyAuthenticityRules,
  applyContinueRule,
  applyRiskRules,
  applyVerificationRules
};
