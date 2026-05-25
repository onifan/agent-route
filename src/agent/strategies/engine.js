"use strict";

const crypto = require("crypto");
const budgetGovernor = require("../budget");
const riskEngine = require("../risk");

const STRATEGY_STATUS = Object.freeze({
  ACTIVE: "active",
  REVISION_NEEDED: "revision_needed",
  INVALIDATED: "invalidated",
  BLOCKED: "blocked"
});

const STRATEGY_EVENT = Object.freeze({
  CREATED: "strategy_created",
  REVISED: "strategy_revised",
  INVALIDATED: "strategy_invalidated",
  STOP_TRIGGERED: "strategy_stop_triggered",
  PLAN_CONSTRAINED: "strategy_plan_constrained"
});

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function uid(prefix = "strategy") {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function list(value) {
  if (Array.isArray(value))
    return value
      .filter(Boolean)
      .map((item) => String(item))
      .map((item) => item.trim())
      .filter(Boolean);
  if (!value) return [];
  return [String(value).trim()].filter(Boolean);
}

function compactText(value, max = 220) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function textOf(...values) {
  return values
    .map((value) => {
      if (value == null) return "";
      if (typeof value === "string") return value;
      return JSON.stringify(value);
    })
    .join(" ")
    .toLowerCase();
}

function includesAny(text, patterns = []) {
  const value = String(text || "").toLowerCase();
  return patterns.some((pattern) =>
    pattern.test ? pattern.test(value) : value.includes(String(pattern).toLowerCase())
  );
}

function inferHorizon(goalText = "") {
  const text = String(goalText || "").toLowerCase();
  if (/\b(90\s*days?|quarter|季度|三个月|90天)\b/.test(text)) return "long";
  if (/\b(30\s*days?|month|月|一个月|30天)\b/.test(text)) return "medium";
  if (/\b(week|7\s*days?|一周|本周)\b/.test(text)) return "short";
  return "single";
}

function inferDomain(goalText = "", memoryText = "") {
  const text = textOf(goalText, memoryText);
  if (/(freelancer|upwork|proposal|bid|接单|报价|客户|client)/i.test(text)) return "freelance";
  if (/(code|repo|测试|build|lint|开发|实现|bug|修复|frontend|backend)/i.test(text)) return "software";
  if (/(browser|网页|网站|表单|登录|submit|page)/i.test(text)) return "browser";
  return "general";
}

function budgetSummary(policy = {}) {
  const normalized = budgetGovernor.normalizeBudgetPolicy(policy);
  return {
    maxGoalTokens: normalized.goal.maxTokens,
    maxGoalCostUsd: normalized.goal.maxCostUsd,
    maxGoalRuntimeMs: normalized.goal.maxRuntimeMs,
    maxGoalSteps: normalized.goal.maxSteps,
    maxBrowserActions: normalized.goal.maxBrowserActions,
    maxRetries: normalized.goal.maxRetries,
    maxVerificationRetries: normalized.task.maxVerificationRetries,
    maxVerifierModelCalls: normalized.verification.maxModelCalls
  };
}

function defaultRiskPolicy(domain = "general") {
  const mustApprove = [
    "submit external forms or proposals",
    "send real messages",
    "login or use real accounts",
    "upload files",
    "publish or deploy",
    "payment or purchase",
    "delete files or data",
    "run dangerous shell commands"
  ];
  return {
    prohibitedActions: [
      "payment without explicit user instruction",
      "credential disclosure",
      "destructive system changes"
    ],
    requiresHumanApproval:
      domain === "freelance"
        ? ["proposal submission", "client messages", "off-platform contact", ...mustApprove]
        : mustApprove,
    allowedLowRiskActions: [
      "read pages",
      "extract information",
      "summarize",
      "draft content",
      "inspect files",
      "run safe read-only shell commands"
    ],
    escalationTriggers: [
      "budget exhaustion",
      "repeated verification failures",
      "risk engine high or critical finding",
      "captcha or account lock",
      "strategy constraint violation"
    ]
  };
}

function defaultAvoidRules(domain = "general") {
  const rules = [
    "Do not bypass risk, budget, verification, or human approval gates.",
    "Do not continue autonomous retries after stop conditions trigger.",
    "Do not claim completion without evidence and verification.",
    "Do not reveal or store secrets, cookies, tokens, passwords, or sensitive account data."
  ];
  if (domain === "freelance") {
    rules.push(
      "Do not automatically submit proposals.",
      "Do not send real client messages without human approval.",
      "Do not pursue off-platform contact requests.",
      "Do not mass-apply or favor quantity over fit.",
      "Avoid low-value work below the configured minimum value unless the user explicitly overrides it."
    );
  }
  return rules;
}

function defaultQualityStandards(domain = "general") {
  const standards = [
    "Every completed task must have standardized evidence.",
    "Verification must confirm the real result before completion.",
    "Semantic outputs must be non-empty, specific, and aligned with success criteria.",
    "Prefer fewer high-quality steps over noisy activity."
  ];
  if (domain === "freelance") {
    standards.push(
      "Proposal drafts must mention relevant skills, project understanding, implementation approach, questions or assumptions, and pricing guidance.",
      "Shortlist decisions must consider client credibility, budget fit, skill fit, and risk signals.",
      "Submission remains a human-approved action."
    );
  }
  if (domain === "software") {
    standards.push("Code work should pass relevant lint/test/build checks or clearly report why it cannot.");
  }
  return standards;
}

function defaultPhasePlan(domain, horizon) {
  if (domain === "freelance" && horizon !== "single") {
    return [
      {
        id: "stage_1",
        name: "Positioning and targeting",
        objective: "Clarify user strengths, target niches, and opportunity filters.",
        successCriteria: ["Target filters are explicit", "Unsafe or low-value opportunities are excluded"]
      },
      {
        id: "stage_2",
        name: "High-fit opportunity selection",
        objective: "Find and evaluate high-fit opportunities before drafting.",
        successCriteria: ["Shortlist is evidence-backed", "Risk and budget filters are applied"]
      },
      {
        id: "stage_3",
        name: "Quality proposal drafting",
        objective: "Draft tailored proposals that match user skills and project needs.",
        successCriteria: ["Drafts pass quality standards", "No automatic submission occurs"]
      },
      {
        id: "stage_4",
        name: "Review and improve",
        objective: "Use results and memory to update targeting and proposal strategy.",
        successCriteria: ["Lessons are saved", "Strategy is revised when results are weak"]
      }
    ];
  }
  if (horizon === "long") {
    return [
      {
        id: "stage_1",
        name: "Foundation",
        objective: "Establish baseline, constraints, and success metrics.",
        successCriteria: ["Baseline is known", "Risks and budget are bounded"]
      },
      {
        id: "stage_2",
        name: "Execution",
        objective: "Run focused work that directly advances the objective.",
        successCriteria: ["Each task maps to the strategy", "Progress is verified"]
      },
      {
        id: "stage_3",
        name: "Scale carefully",
        objective: "Increase impact only after evidence supports the direction.",
        successCriteria: ["Quality remains high", "Budget and risk stay controlled"]
      },
      {
        id: "stage_4",
        name: "Review and adapt",
        objective: "Revise strategy based on outcomes and constraints.",
        successCriteria: ["Failed paths are not repeated", "Memory captures durable lessons"]
      }
    ];
  }
  return [
    {
      id: "stage_1",
      name: "Clarify",
      objective: "Confirm the objective, constraints, and success criteria.",
      successCriteria: ["Strategy is explicit"]
    },
    {
      id: "stage_2",
      name: "Execute",
      objective: "Perform only tasks that directly advance the objective.",
      successCriteria: ["Task outputs are verified"]
    },
    {
      id: "stage_3",
      name: "Validate",
      objective: "Check quality, risk, and budget before declaring success.",
      successCriteria: ["Final answer is evidence-backed"]
    }
  ];
}

function memoryInfluences(memoryText = "", memories = []) {
  const text = textOf(
    memoryText,
    memories.map((memory) => `${memory.title || ""} ${memory.summary || ""} ${(memory.tags || []).join(" ")}`).join(" ")
  );
  const influences = [];
  if (/python|automation|自动化/.test(text))
    influences.push("Prefer Python automation opportunities or implementation paths when relevant.");
  if (/proposal|freelancer|upwork|接单|报价/.test(text))
    influences.push("Use prior proposal/freelance lessons to filter opportunities and improve drafts.");
  if (/avoid|不要|failed|失败|risk|风控/.test(text))
    influences.push("Avoid repeating known failed or risky paths from memory.");
  if (/verification|verify|验证/.test(text)) influences.push("Use memory to reduce repeated verification mistakes.");
  return influences.slice(0, 8);
}

function normalizeStrategy(raw = {}, context = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const at = source.createdAt || source.created_at || nowIso();
  const phasePlan = Array.isArray(source.phasePlan || source.phase_plan)
    ? (source.phasePlan || source.phase_plan).map((phase, index) => ({
        id: String(phase.id || `stage_${index + 1}`),
        name: String(phase.name || phase.title || `Stage ${index + 1}`),
        objective: String(phase.objective || phase.goal || ""),
        successCriteria: list(phase.successCriteria || phase.success_criteria)
      }))
    : [];
  return {
    id: String(source.id || context.id || uid("strategy")),
    goalId: String(source.goalId || source.goal_id || context.goalId || context.goal_id || ""),
    version: Math.max(1, Number(source.version || context.version || 1)),
    status: Object.values(STRATEGY_STATUS).includes(source.status) ? source.status : STRATEGY_STATUS.ACTIVE,
    objective: String(source.objective || context.objective || ""),
    successCriteria: list(source.successCriteria || source.success_criteria),
    priorities: list(source.priorities),
    constraints: list(source.constraints),
    avoidRules: list(source.avoidRules || source.avoid_rules),
    riskPolicy: source.riskPolicy || source.risk_policy || defaultRiskPolicy(),
    budgetPolicy: source.budgetPolicy || source.budget_policy || {},
    executionStyle: String(source.executionStyle || source.execution_style || "quality_first_evidence_driven"),
    stopConditions: list(source.stopConditions || source.stop_conditions),
    qualityStandards: list(source.qualityStandards || source.quality_standards),
    routingPreferences: source.routingPreferences || source.routing_preferences || {},
    phasePlan,
    revisionReason: String(
      source.revisionReason || source.revision_reason || context.revisionReason || "initial strategy"
    ),
    memoryInfluences: list(source.memoryInfluences || source.memory_influences),
    createdAt: at,
    updatedAt: source.updatedAt || source.updated_at || at
  };
}

function generateStrategy({
  goalId = "",
  goalText = "",
  memoryText = "",
  memories = [],
  budgetPolicy = {},
  revisionReason = "initial strategy"
} = {}) {
  const domain = inferDomain(goalText, memoryText);
  const horizon = inferHorizon(goalText);
  const influences = memoryInfluences(memoryText, memories);
  const phases = defaultPhasePlan(domain, horizon);
  const priorities = [
    "Advance the final objective instead of maximizing task count.",
    "Quality and verification are more important than activity volume.",
    "Safety, human approval, and budget limits outrank local task completion.",
    ...influences
  ];
  const constraints = [
    "Every task must map to a strategic objective and phase.",
    "Planner must not create tasks that violate avoid rules or risk policy.",
    "Use existing memory before repeating analysis, browser actions, or retries.",
    "Stay within budget governor limits and degrade before exhausting budget."
  ];
  if (domain === "freelance") {
    constraints.push("Only shortlist opportunities with clear fit, credible client signals, and acceptable budget.");
  }
  const strategy = normalizeStrategy(
    {
      goalId,
      objective: compactText(goalText, 500) || "Complete the user goal with verified, safe, budget-aware progress.",
      successCriteria: [
        "The final outcome satisfies the user's stated goal.",
        "All completed tasks are verified with concrete evidence.",
        "No avoid rule, approval boundary, budget limit, or risk policy is violated.",
        "The final answer reports any uncertainty, blocked work, or required human decision."
      ],
      priorities,
      constraints,
      avoidRules: defaultAvoidRules(domain),
      riskPolicy: defaultRiskPolicy(domain),
      budgetPolicy: budgetSummary(budgetPolicy),
      executionStyle:
        domain === "freelance" ? "quality_first_selective_freelance_workflow" : "quality_first_evidence_driven",
      stopConditions: [
        "Stop if goal budget is exhausted or task budget blocks progress.",
        "Stop if a high or critical side effect needs human approval.",
        "Stop if verification repeatedly fails for the same objective.",
        "Stop if planner cannot produce any strategy-compliant task.",
        "Stop and revise strategy if repeated failures show the current direction is ineffective."
      ],
      qualityStandards: defaultQualityStandards(domain),
      routingPreferences: {
        lowValue: "free_or_cheap_models",
        planning: "commander_or_strong_models",
        coding: "coding_pool_first",
        verification: "rule_based_first_semantic_model_only_when_budget_allows",
        highRisk: "commander_review_and_human_approval"
      },
      phasePlan: phases,
      revisionReason,
      memoryInfluences: influences
    },
    { goalId, revisionReason }
  );
  return strategy;
}

function strategyForPrompt(strategy = {}) {
  const compact = normalizeStrategy(strategy);
  return [
    "Strategic guidance for this goal:",
    `Objective: ${compact.objective}`,
    compact.successCriteria.length ? `Success criteria: ${compact.successCriteria.join("; ")}` : "",
    compact.priorities.length ? `Priorities: ${compact.priorities.slice(0, 6).join("; ")}` : "",
    compact.constraints.length ? `Constraints: ${compact.constraints.slice(0, 8).join("; ")}` : "",
    compact.avoidRules.length ? `Avoid rules: ${compact.avoidRules.slice(0, 8).join("; ")}` : "",
    compact.stopConditions.length ? `Stop conditions: ${compact.stopConditions.slice(0, 6).join("; ")}` : "",
    compact.qualityStandards.length ? `Quality standards: ${compact.qualityStandards.slice(0, 8).join("; ")}` : "",
    compact.phasePlan.length
      ? `Phases: ${compact.phasePlan.map((phase) => `${phase.id}:${phase.name}`).join("; ")}`
      : "",
    "Tasks must not violate this strategy. If the strategy is wrong or stale, request strategy revision before continuing."
  ]
    .filter(Boolean)
    .join("\n");
}

function taskText(task = {}) {
  return textOf(
    task.title,
    task.description,
    task.type,
    task.prompt,
    task.input,
    task.routingReason,
    task.successCriteria
  );
}

function evaluateTaskAgainstStrategy(task = {}, strategy = {}) {
  const compact = normalizeStrategy(strategy);
  const text = taskText(task);
  const violations = [];
  const graphApprovalBoundary = textOf(task.dependencies, task.dependsOn, task.depends_on, task.consumes).includes(
    "approval"
  );
  const requiresApproval = Boolean(
    task.requiresHumanApproval ||
    task.requiresHumanConfirmation ||
    task.approvalStatus === "approved" ||
    graphApprovalBoundary
  );
  const riskLevel = riskEngine.normalizeRiskLevel(task.riskLevel || "low");

  if (
    includesAny(text, [/off-platform|outside platform|telegram|whatsapp|站外|站外联系/]) &&
    compact.avoidRules.some((rule) => /off-platform|站外/i.test(rule))
  ) {
    violations.push({
      code: "off_platform_forbidden",
      severity: "high",
      message: "Strategy forbids off-platform contact."
    });
  }
  if (
    includesAny(text, [/\$\s?([1-4]?\d)\b|低于\s*50|below\s*\$?50/]) &&
    compact.constraints.some((rule) => /budget|low-value|acceptable budget|低价/i.test(rule))
  ) {
    violations.push({
      code: "low_value_forbidden",
      severity: "medium",
      message: "Task appears to pursue low-value work that conflicts with strategy filters."
    });
  }
  if (riskEngine.isRiskAtLeast(riskLevel, "high") && !requiresApproval) {
    violations.push({
      code: "high_risk_without_approval",
      severity: "high",
      message: "High-risk task must include explicit human approval boundary."
    });
  }
  if (!list(task.successCriteria || task.success_criteria).length) {
    violations.push({
      code: "missing_success_criteria",
      severity: "medium",
      message: "Task lacks concrete success criteria for verification."
    });
  }

  const phase = selectPhaseForTask(task, compact);
  return {
    allowed: !violations.some((item) => item.severity === "high" || item.severity === "critical"),
    action: violations.some((item) => item.severity === "high" || item.severity === "critical")
      ? "block"
      : violations.length
        ? "revise"
        : "allow",
    violations,
    strategyId: compact.id,
    strategicObjective: phase.objective || compact.objective,
    strategicPhase: phase.id || "",
    strategicRationale: violations.length
      ? `Task needs revision to satisfy strategy: ${violations.map((item) => item.code).join(", ")}`
      : `Task supports ${phase.name || "the current strategic phase"}.`
  };
}

function selectPhaseForTask(task = {}, strategy = {}) {
  const phases = Array.isArray(strategy.phasePlan) ? strategy.phasePlan : [];
  if (!phases.length) return {};
  const text = taskText(task);
  const matched = phases.find((phase) => {
    const hay = textOf(phase.name, phase.objective, phase.successCriteria);
    return hay
      .split(/\W+/)
      .filter((token) => token.length > 4)
      .some((token) => text.includes(token));
  });
  return matched || phases[0];
}

function enrichTaskWithStrategy(task = {}, strategy = {}, evaluation = null) {
  const compact = normalizeStrategy(strategy);
  const result = evaluation || evaluateTaskAgainstStrategy(task, compact);
  return {
    ...task,
    strategyId: task.strategyId || task.strategy_id || compact.id,
    strategicObjective:
      task.strategicObjective || task.strategic_objective || result.strategicObjective || compact.objective,
    strategicPhase:
      task.strategicPhase ||
      task.strategic_phase ||
      result.strategicPhase ||
      (compact.phasePlan[0] && compact.phasePlan[0].id) ||
      "",
    strategicRationale: task.strategicRationale || task.strategic_rationale || result.strategicRationale || ""
  };
}

function constrainPlan(plan = {}, strategy = {}) {
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const allowedTasks = [];
  const blockedTasks = [];
  const revisedTasks = [];
  for (const task of tasks) {
    const evaluation = evaluateTaskAgainstStrategy(task, strategy);
    const enriched = enrichTaskWithStrategy(task, strategy, evaluation);
    if (evaluation.action === "block") {
      blockedTasks.push({ task: enriched, evaluation });
      continue;
    }
    if (evaluation.action === "revise") revisedTasks.push({ task: enriched, evaluation });
    allowedTasks.push(enriched);
  }
  return {
    tasks: allowedTasks,
    blockedTasks,
    revisedTasks,
    violations: [...blockedTasks, ...revisedTasks].flatMap((item) =>
      item.evaluation.violations.map((violation) => ({
        ...violation,
        taskId: item.task.id,
        taskTitle: item.task.title
      }))
    ),
    changed: blockedTasks.length > 0 || revisedTasks.length > 0
  };
}

function shouldReviseStrategy(strategy = {}, context = {}) {
  const reasons = [];
  const budget = context.budgetEvaluation || context.budget || {};
  if (budget.blockedReason) reasons.push(`Budget blocked progress: ${budget.blockedReason}`);
  if (budget.degradationLevel && !["none", "light"].includes(budget.degradationLevel))
    reasons.push(`Budget pressure is ${budget.degradationLevel}.`);
  const tasks = Array.isArray(context.tasks) ? context.tasks : [];
  const failed = tasks.filter((task) => ["failed", "blocked", "retry_ready"].includes(task.status)).length;
  if (tasks.length >= 3 && failed / tasks.length >= 0.5)
    reasons.push("At least half of recent tasks failed, blocked, or needed retry.");
  const violations = Array.isArray(context.violations) ? context.violations : [];
  if (violations.length) reasons.push("Planner produced tasks that conflict with strategy.");
  const review = context.review || {};
  if (review.status === "continue" && (!Array.isArray(review.nextTasks) || review.nextTasks.length === 0)) {
    reasons.push("Commander review could not find a next compliant task.");
  }
  return {
    shouldRevise: reasons.length > 0,
    reasons,
    revisionReason: reasons[0] || ""
  };
}

function reviseStrategy(strategy = {}, context = {}) {
  const previous = normalizeStrategy(strategy);
  const reason = context.revisionReason || context.reason || "Strategy revised after new evidence.";
  const next = normalizeStrategy({
    ...previous,
    version: previous.version + 1,
    status: STRATEGY_STATUS.ACTIVE,
    revisionReason: reason,
    priorities: ["Revise direction based on new evidence before doing more work.", ...previous.priorities],
    constraints: [
      reason,
      "Do not repeat the blocked or failed path without a changed condition.",
      ...previous.constraints
    ],
    stopConditions: ["Stop if the revised strategy still cannot produce compliant tasks.", ...previous.stopConditions],
    updatedAt: nowIso()
  });
  if (/budget/i.test(reason)) {
    next.executionStyle = "lightweight_budget_preserving";
    next.routingPreferences = {
      ...next.routingPreferences,
      planning: "use_commander_only_for_direction_changes",
      lowValue: "free_models_only",
      verification: "rule_based_first_skip_optional_semantic_checks"
    };
  }
  if (/risk|approval|submit|delete|payment|danger/i.test(reason)) {
    next.riskPolicy = {
      ...next.riskPolicy,
      requiresHumanApproval: [
        ...new Set([
          ...(next.riskPolicy.requiresHumanApproval || []),
          "all external side effects until user approves revised strategy"
        ])
      ]
    };
  }
  return next;
}

function evaluateStopConditions(strategy = {}, context = {}) {
  const reasons = [];
  const budget = context.budgetEvaluation || context.budget || {};
  if (budget.blockedReason || budget.status === "exhausted" || budget.status === "blocked")
    reasons.push(budget.blockedReason || "Budget stop condition triggered.");
  const risk = context.riskEvaluation || context.risk || {};
  if (risk.blockedReason) reasons.push(risk.blockedReason);
  if (risk.requiresHumanApproval) reasons.push(risk.approvalReason || "Human approval is required.");
  const tasks = Array.isArray(context.tasks) ? context.tasks : [];
  const recent = tasks.slice(-5);
  if (recent.length >= 3 && recent.every((task) => ["failed", "blocked", "retry_ready"].includes(task.status))) {
    reasons.push("Recent tasks show no verified progress.");
  }
  if (
    Array.isArray(context.violations) &&
    context.violations.some((violation) => violation.severity === "high" || violation.severity === "critical")
  ) {
    reasons.push("Strategy constraint violation blocks planner output.");
  }
  return {
    shouldStop: reasons.length > 0,
    reasons,
    suggestedAction: reasons.length ? "stop_or_revise_strategy" : "continue"
  };
}

function memoryCandidateForStrategy(strategy = {}, event = STRATEGY_EVENT.CREATED) {
  const compact = normalizeStrategy(strategy);
  return {
    type: "procedure",
    importance: 4,
    title: event === STRATEGY_EVENT.REVISED ? "Revised goal strategy" : "Goal strategy",
    summary: compactText(
      [
        `Objective: ${compact.objective}`,
        compact.priorities.length ? `Priorities: ${compact.priorities.slice(0, 3).join("; ")}` : "",
        compact.avoidRules.length ? `Avoid: ${compact.avoidRules.slice(0, 3).join("; ")}` : "",
        compact.revisionReason ? `Reason: ${compact.revisionReason}` : ""
      ]
        .filter(Boolean)
        .join(" "),
      650
    ),
    tags: ["strategy", compact.status, `strategy-v${compact.version}`],
    event
  };
}

module.exports = {
  STRATEGY_EVENT,
  STRATEGY_STATUS,
  constrainPlan,
  defaultAvoidRules,
  defaultPhasePlan,
  evaluateStopConditions,
  evaluateTaskAgainstStrategy,
  generateStrategy,
  inferDomain,
  inferHorizon,
  memoryCandidateForStrategy,
  normalizeStrategy,
  reviseStrategy,
  shouldReviseStrategy,
  strategyForPrompt
};
