"use strict";

const { jsonParseDiagnostics, safeJsonParse } = require("./content-utils");

const PROTOCOL_VERSION = 1;
const STRUCTURED_OUTPUT_SCHEMA_NAME = "AgentRoute Structured Output Schema v1";

const KIND = {
  PLAN: "plan",
  WORKER_RESULT: "worker_result",
  VERIFICATION_RESULT: "verification_result",
  GOAL_REVIEW: "goal_review",
  FINAL_ANSWER: "final_answer"
};

const ROLE_SCHEMAS = {
  [KIND.PLAN]:
    '{"kind":"plan","schemaVersion":1,"tasks":[{"id":"short","title":"short","description":"what to do","type":"analysis|web_search|web_read|api_read|local_read|document_generate|verification|browser|local_execution","modelPool":"free|strong|coding|codex-cli","toolWorker":"web|files|document|browser|none","dependsOn":[],"successCriteria":[],"prompt":"specific worker instruction","input":"short query/url/local-path/input","riskLevel":"low|medium|high|critical","riskReasons":[],"routingReason":"short reason","maxAttempts":2}]}',
  [KIND.WORKER_RESULT]:
    '{"kind":"worker_result","schemaVersion":1,"status":"success|failure|retry|blocked|awaiting_confirmation","actions":[],"output":"result","error":"","nextStep":"","artifacts":[],"evidence":{"summary":"what was observed","claims":[],"browser":{"beforeUrl":"","afterUrl":"","domChanged":false,"successMessage":"","errorMessage":"","screenshot":"","snapshot":""},"shell":{"command":"","exitCode":0,"stderr":"","stdout":"","outputDirs":[]},"files":[{"path":"","exists":true,"size":-1,"beforeSize":-1,"afterSize":-1,"role":"read|artifact|output|modified","expectedContent":"","expectedContentRequired":false}],"apiResponses":[{"url":"","status":200,"body":"","writeConfirmed":false}],"semantic":{"outputSummary":"","addressesCriteria":true,"criteriaCoverage":1,"qualityScore":1,"qualityIssues":[]}},"memoryCandidates":[],"riskLevel":"low|medium|high|critical","riskReasons":[]}',
  [KIND.VERIFICATION_RESULT]:
    '{"kind":"verification_result","schemaVersion":1,"verified":false,"verificationStatus":"verified|partially_verified|unverified","confidence":0.0,"reasons":[],"detectedIssues":[{"issue":"","severity":"low|medium|high|critical","retryable":true}],"reasonCode":"short","missingEvidence":[],"rejectedEvidence":[],"suggestedNextState":"completed|retrying|needs_evidence|failed|blocked|waiting_human","retryable":true}',
  [KIND.GOAL_REVIEW]:
    '{"kind":"goal_review","schemaVersion":1,"status":"done|continue","progress_summary":"short","final_answer":"markdown if done","strategy_revision_reason":"","next_tasks":[{"id":"short","title":"short","description":"what to do","type":"analysis|coding|browser|web_search|web_read|api_read|local_read|document_generate|verification|decision|local_execution|general","modelPool":"free|coding|strong|commander|codex-cli","toolWorker":"web|files|document|browser|none","difficulty":"low|medium|high|critical","riskLevel":"low|medium|high|critical","riskReasons":["short reason"],"successCriteria":["specific pass condition"],"dependsOn":["prior_task_id"],"produces":["artifact_id"],"consumes":["artifact_id"],"priority":0,"retryPolicy":{"scope":"self|downstream","maxRetries":1},"maxAttempts":2,"requiresHumanApproval":false,"requiresHumanConfirmation":false,"strategyId":"","strategicObjective":"","strategicPhase":"","strategicRationale":"","routingReason":"","prompt":"specific worker instruction","input":"task input"}],"memory_candidates":[{"type":"knowledge|episodic|procedure|working","importance":1,"title":"short","summary":"durable non-sensitive lesson","tags":["short"]}]}',
  [KIND.FINAL_ANSWER]:
    '{"kind":"final_answer","schemaVersion":1,"status":"completed|partial|failed|blocked|waiting_human","answerMarkdown":"final user-facing markdown answer","artifacts":[{"path":"","format":"","size":0,"hash":"","createdAt":"","verificationSummary":""}],"evidenceSummary":[],"uncertainties":[],"nextSteps":[]}'
};

function stringSchema() {
  return { type: "string" };
}

function numberSchema() {
  return { type: "number" };
}

function integerSchema() {
  return { type: "integer" };
}

function booleanSchema() {
  return { type: "boolean" };
}

function stringArraySchema() {
  return {
    type: "array",
    items: stringSchema()
  };
}

function arraySchema(items, options = {}) {
  return {
    type: "array",
    items,
    ...options
  };
}

function strictObject(properties) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: Object.keys(properties)
  };
}

function retryPolicySchema() {
  return strictObject({
    scope: stringSchema(),
    maxRetries: integerSchema()
  });
}

function taskSchema() {
  return strictObject({
    id: stringSchema(),
    title: stringSchema(),
    description: stringSchema(),
    type: stringSchema(),
    modelPool: stringSchema(),
    toolWorker: stringSchema(),
    difficulty: stringSchema(),
    riskLevel: stringSchema(),
    riskReasons: stringArraySchema(),
    successCriteria: stringArraySchema(),
    dependsOn: stringArraySchema(),
    produces: stringArraySchema(),
    consumes: stringArraySchema(),
    priority: integerSchema(),
    retryPolicy: retryPolicySchema(),
    maxAttempts: integerSchema(),
    requiresHumanApproval: booleanSchema(),
    requiresHumanConfirmation: booleanSchema(),
    strategyId: stringSchema(),
    strategicObjective: stringSchema(),
    strategicPhase: stringSchema(),
    strategicRationale: stringSchema(),
    routingReason: stringSchema(),
    prompt: stringSchema(),
    input: stringSchema()
  });
}

function memoryCandidateSchema() {
  return strictObject({
    type: stringSchema(),
    importance: integerSchema(),
    title: stringSchema(),
    summary: stringSchema(),
    tags: stringArraySchema()
  });
}

function actionSchema() {
  return strictObject({
    type: stringSchema(),
    action: stringSchema(),
    description: stringSchema()
  });
}

function browserEvidenceSchema() {
  return strictObject({
    beforeUrl: stringSchema(),
    afterUrl: stringSchema(),
    domChanged: booleanSchema(),
    successMessage: stringSchema(),
    errorMessage: stringSchema(),
    screenshot: stringSchema(),
    snapshot: stringSchema()
  });
}

function shellEvidenceSchema() {
  return strictObject({
    command: stringSchema(),
    exitCode: integerSchema(),
    stderr: stringSchema(),
    stdout: stringSchema(),
    outputDirs: stringArraySchema()
  });
}

function fileEvidenceSchema() {
  return strictObject({
    path: stringSchema(),
    exists: booleanSchema(),
    size: integerSchema(),
    beforeSize: integerSchema(),
    afterSize: integerSchema(),
    role: stringSchema(),
    expectedContent: stringSchema(),
    expectedContentRequired: booleanSchema()
  });
}

function apiResponseEvidenceSchema() {
  return strictObject({
    url: stringSchema(),
    status: integerSchema(),
    body: stringSchema(),
    writeConfirmed: booleanSchema()
  });
}

function semanticEvidenceSchema() {
  return strictObject({
    outputSummary: stringSchema(),
    addressesCriteria: booleanSchema(),
    criteriaCoverage: numberSchema(),
    qualityScore: numberSchema(),
    qualityIssues: stringArraySchema()
  });
}

function workerEvidenceSchema() {
  return strictObject({
    summary: stringSchema(),
    claims: stringArraySchema(),
    actions: {
      type: "array",
      items: actionSchema()
    },
    browser: browserEvidenceSchema(),
    shell: shellEvidenceSchema(),
    files: {
      type: "array",
      items: fileEvidenceSchema()
    },
    apiResponses: {
      type: "array",
      items: apiResponseEvidenceSchema()
    },
    semantic: semanticEvidenceSchema()
  });
}

function detectedIssueSchema() {
  return strictObject({
    issue: stringSchema(),
    severity: stringSchema(),
    retryable: booleanSchema()
  });
}

function artifactSchema() {
  return strictObject({
    path: stringSchema(),
    format: stringSchema(),
    size: integerSchema(),
    hash: stringSchema(),
    createdAt: stringSchema(),
    verificationSummary: stringSchema()
  });
}

const FUNCTION_ARGUMENT_SCHEMAS = {
  [KIND.PLAN]: strictObject({
    kind: { type: "string", enum: [KIND.PLAN] },
    schemaVersion: { type: "integer", enum: [PROTOCOL_VERSION] },
    tasks: {
      type: "array",
      items: taskSchema()
    },
    memory_candidates: {
      type: "array",
      items: memoryCandidateSchema()
    }
  }),
  [KIND.WORKER_RESULT]: strictObject({
    kind: { type: "string", enum: [KIND.WORKER_RESULT] },
    schemaVersion: { type: "integer", enum: [PROTOCOL_VERSION] },
    status: stringSchema(),
    actions: stringArraySchema(),
    output: stringSchema(),
    error: stringSchema(),
    nextStep: stringSchema(),
    artifacts: {
      type: "array",
      items: artifactSchema()
    },
    evidence: workerEvidenceSchema(),
    memoryCandidates: {
      type: "array",
      items: memoryCandidateSchema()
    },
    riskLevel: stringSchema(),
    riskReasons: stringArraySchema()
  }),
  [KIND.VERIFICATION_RESULT]: strictObject({
    kind: { type: "string", enum: [KIND.VERIFICATION_RESULT] },
    schemaVersion: { type: "integer", enum: [PROTOCOL_VERSION] },
    verified: booleanSchema(),
    verificationStatus: stringSchema(),
    confidence: numberSchema(),
    reasons: stringArraySchema(),
    detectedIssues: {
      type: "array",
      items: detectedIssueSchema()
    },
    reasonCode: stringSchema(),
    missingEvidence: stringArraySchema(),
    rejectedEvidence: stringArraySchema(),
    suggestedNextState: stringSchema(),
    retryable: booleanSchema()
  }),
  [KIND.GOAL_REVIEW]: strictObject({
    kind: { type: "string", enum: [KIND.GOAL_REVIEW] },
    schemaVersion: { type: "integer", enum: [PROTOCOL_VERSION] },
    status: stringSchema(),
    progress_summary: stringSchema(),
    final_answer: stringSchema(),
    strategy_revision_reason: stringSchema(),
    next_tasks: arraySchema(taskSchema(), { maxItems: 3 }),
    memory_candidates: arraySchema(memoryCandidateSchema(), { maxItems: 8 })
  }),
  [KIND.FINAL_ANSWER]: strictObject({
    kind: { type: "string", enum: [KIND.FINAL_ANSWER] },
    schemaVersion: { type: "integer", enum: [PROTOCOL_VERSION] },
    status: stringSchema(),
    answerMarkdown: stringSchema(),
    artifacts: {
      type: "array",
      items: artifactSchema()
    },
    evidenceSummary: stringArraySchema(),
    uncertainties: stringArraySchema(),
    nextSteps: stringArraySchema()
  })
};

const ROLE_INSTRUCTIONS = {
  [KIND.PLAN]: {
    role: "planner / commander",
    task: "把用户目标拆成下一批安全、可验证、可执行的任务图。",
    reasoning: "先在内部逐步检查目标、约束、风险、依赖、证据缺口和预算，再提交计划参数。"
  },
  [KIND.WORKER_RESULT]: {
    role: "worker",
    task: "只汇报本次 worker 实际完成的动作、输出、错误和证据。",
    reasoning: "先在内部逐步核对任务要求、已执行动作、证据是否真实、是否需要阻塞或重试，再提交结果参数。"
  },
  [KIND.VERIFICATION_RESULT]: {
    role: "verification",
    task: "基于 worker result 和 evidence 判断任务是否真的满足成功标准。",
    reasoning: "先在内部逐步核对证据、成功标准、风险、缺口和可重试性，再提交验证参数。"
  },
  [KIND.GOAL_REVIEW]: {
    role: "reviewer / commander",
    task: "复盘当前执行图，决定目标是否完成，或规划下一批必要任务。",
    reasoning: "先在内部逐步核对已完成任务、失败任务、验证状态、依赖、预算和剩余缺口，再提交复盘参数。"
  },
  [KIND.FINAL_ANSWER]: {
    role: "finalizer / commander",
    task: "基于已验证 worker evidence 生成最终用户可见答案。",
    reasoning: "先在内部逐步区分证据、推断、不确定性和失败缺口，再提交最终答案参数。"
  }
};

const FEW_SHOTS = {
  [KIND.PLAN]: [
    {
      input: "用户目标: 查询一个公开网页并总结，不登录、不提交。",
      output: {
        kind: "plan",
        schemaVersion: 1,
        tasks: [
          {
            id: "read-public-page",
            title: "读取公开网页证据",
            description: "读取 agent 选择的公开 URL 或搜索结果候选，返回 URL/status/title/text evidence。",
            type: "web_search",
            modelPool: "free",
            toolWorker: "web",
            dependsOn: [],
            successCriteria: ["返回至少一个公开 URL", "包含 HTTP status、title、text evidence"],
            prompt: "执行只读公开搜索，返回真实 URL/status/title/text evidence。",
            input: "public source for the requested topic",
            riskLevel: "low",
            riskReasons: [],
            routingReason: "公开联网取证应由 web tool 执行。",
            maxAttempts: 2
          }
        ]
      }
    },
    {
      input: "用户目标: 只读分析本机项目目录，不修改文件。",
      output: {
        kind: "plan",
        schemaVersion: 1,
        tasks: [
          {
            id: "read-local-project",
            title: "读取本机项目证据",
            description: "只读读取本机项目目录，返回路径、目录清单和关键文本文件摘录。",
            type: "local_read",
            modelPool: "free",
            toolWorker: "files",
            dependsOn: [],
            successCriteria: ["返回 path/exists/size evidence", "包含目录 inventory 和文本摘录"],
            prompt: "只读读取指定本地目录，不修改、不安装、不运行命令。",
            input: "/path/to/project",
            riskLevel: "low",
            riskReasons: [],
            routingReason: "本地文件取证应由 files MCP worker 执行。",
            maxAttempts: 2
          }
        ]
      }
    },
    {
      input: "用户目标: 基于已验证内容生成 Markdown 文件。",
      output: {
        kind: "plan",
        schemaVersion: 1,
        tasks: [
          {
            id: "render-markdown",
            title: "生成 Markdown 文档产物",
            description: "把上游已验证内容渲染成真实 Markdown 文件并返回文件证据。",
            type: "document_generate",
            modelPool: "free",
            toolWorker: "document",
            dependsOn: ["prepare-content"],
            successCriteria: ["返回 artifact path", "包含 format、size、hash、createdAt"],
            prompt: "将上游内容渲染为 Markdown 文件，返回标准化 file evidence。",
            input: "format=md",
            riskLevel: "low",
            riskReasons: [],
            routingReason: "真实文件产物必须由 document worker 生成。",
            maxAttempts: 2
          }
        ]
      }
    }
  ],
  [KIND.WORKER_RESULT]: [
    {
      input: "任务: 总结已提供的两条证据，不调用工具。",
      output: {
        kind: "worker_result",
        schemaVersion: 1,
        status: "success",
        actions: ["model:analyze_provided_evidence"],
        output: "基于已提供证据的简短总结。",
        error: "",
        nextStep: "",
        artifacts: [],
        evidence: {
          summary: "Worker used only provided upstream evidence.",
          claims: ["结论来自上游已验证证据。"],
          semantic: {
            outputSummary: "完成证据总结。",
            addressesCriteria: true,
            criteriaCoverage: 1,
            qualityScore: 0.9,
            qualityIssues: []
          }
        },
        memoryCandidates: [],
        riskLevel: "low",
        riskReasons: []
      }
    },
    {
      input: "任务: 读取网页，但没有给出 URL。",
      output: {
        kind: "worker_result",
        schemaVersion: 1,
        status: "failure",
        actions: [],
        output: "",
        error: "No public URL or query was provided for this worker run.",
        nextStep: "Ask planner to provide a concrete query or public URL.",
        artifacts: [],
        evidence: {
          summary: "No tool action was executed.",
          claims: [],
          semantic: {
            outputSummary: "Task could not start due to missing input.",
            addressesCriteria: false,
            criteriaCoverage: 0,
            qualityScore: 0,
            qualityIssues: ["missing_input"]
          }
        },
        memoryCandidates: [],
        riskLevel: "low",
        riskReasons: []
      }
    }
  ],
  [KIND.VERIFICATION_RESULT]: [
    {
      input: "Worker 返回文件 path、size、hash，成功标准要求真实文件证据。",
      output: {
        kind: "verification_result",
        schemaVersion: 1,
        verified: true,
        verificationStatus: "verified",
        confidence: 0.92,
        reasons: ["Artifact path、size、hash 均存在。"],
        detectedIssues: [],
        reasonCode: "file_evidence_present",
        missingEvidence: [],
        rejectedEvidence: [],
        suggestedNextState: "completed",
        retryable: false
      }
    },
    {
      input: "Worker 声称联网成功，但没有 URL/status/text evidence。",
      output: {
        kind: "verification_result",
        schemaVersion: 1,
        verified: false,
        verificationStatus: "unverified",
        confidence: 0.2,
        reasons: ["缺少公开来源 URL、HTTP status 和页面文本证据。"],
        detectedIssues: [{ issue: "missing_web_evidence", severity: "high", retryable: true }],
        reasonCode: "missing_evidence",
        missingEvidence: ["url", "http_status", "text"],
        rejectedEvidence: [],
        suggestedNextState: "needs_evidence",
        retryable: true
      }
    }
  ],
  [KIND.GOAL_REVIEW]: [
    {
      input: "所有必要任务 verified，证据足够回答。",
      output: {
        kind: "goal_review",
        schemaVersion: 1,
        status: "done",
        progress_summary: "必要证据已完成并通过验证。",
        final_answer: "基于已验证证据的最终答案。",
        strategy_revision_reason: "",
        next_tasks: [],
        memory_candidates: []
      }
    },
    {
      input: "网页取证失败，缺少可读公开来源。",
      output: {
        kind: "goal_review",
        schemaVersion: 1,
        status: "continue",
        progress_summary: "当前证据不足，需要重新发现公开可读来源。",
        final_answer: "",
        strategy_revision_reason: "",
        next_tasks: [
          {
            id: "discover-readable-source",
            title: "发现公开可读来源",
            description: "重新搜索公开、无需登录、可读取的来源候选。",
            type: "web_search",
            modelPool: "free",
            toolWorker: "web",
            difficulty: "low",
            riskLevel: "low",
            riskReasons: [],
            successCriteria: ["返回 URL/status/title/text evidence"],
            dependsOn: [],
            produces: ["public_source_candidates"],
            consumes: [],
            priority: 1,
            retryPolicy: { scope: "self", maxRetries: 1 },
            maxAttempts: 2,
            requiresHumanApproval: false,
            requiresHumanConfirmation: false,
            strategyId: "",
            strategicObjective: "",
            strategicPhase: "",
            strategicRationale: "",
            routingReason: "缺少公开可读来源证据。",
            prompt: "搜索公开可读来源候选并返回证据。",
            input: "public readable source for missing evidence"
          }
        ],
        memory_candidates: []
      }
    }
  ],
  [KIND.FINAL_ANSWER]: [
    {
      input: "目标完成，已有 verified evidence。",
      output: {
        kind: "final_answer",
        schemaVersion: 1,
        status: "completed",
        answerMarkdown: "## 结论\n\n任务已完成，以下结论基于已验证证据。",
        artifacts: [],
        evidenceSummary: ["使用了已验证 worker evidence。"],
        uncertainties: [],
        nextSteps: []
      }
    },
    {
      input: "部分证据失败，仍需诚实说明缺口。",
      output: {
        kind: "final_answer",
        schemaVersion: 1,
        status: "partial",
        answerMarkdown: "## 部分完成\n\n已完成可验证部分；缺失项未取得可靠证据。",
        artifacts: [],
        evidenceSummary: ["成功证据来自已验证任务。"],
        uncertainties: ["缺失项没有可验证来源。"],
        nextSteps: ["重新规划取证任务。"]
      }
    }
  ]
};

function examplesFor(kind) {
  const examples = FEW_SHOTS[kind] || [];
  if (!examples.length) return "";
  return examples
    .map((example, index) =>
      [
        `示例 ${index + 1} 输入: ${example.input}`,
        `示例 ${index + 1} function arguments: ${JSON.stringify(example.output)}`
      ].join("\n")
    )
    .join("\n");
}

function functionNameForKind(kind = "") {
  return `agent_route_${String(kind || "structured_output").replace(/[^A-Za-z0-9_]+/g, "_")}`;
}

function baseContract(kind, options = {}) {
  const expected = String(kind || "");
  const payloadOnly = options.transport === "payload";
  const instruction = ROLE_INSTRUCTIONS[expected] || {
    role: "agent",
    task: "完成当前阶段任务。",
    reasoning: "先在内部逐步推理，再提交结构化参数。"
  };
  return [
    "[结构化指令]",
    "[角色]",
    instruction.role,
    "[任务]",
    instruction.task,
    "[约束]",
    payloadOnly
      ? "本工具结果 payload 必须是一个 JSON 对象；第一个字符必须是 {，最后一个字符必须是 }。"
      : `必须调用指定 function "${functionNameForKind(expected)}" 恰好一次，并把唯一结构化对象放入 arguments。`,
    payloadOnly
      ? "不得输出 Markdown、代码围栏、解释文字、多个 JSON、候选方案、草稿或重复对象。"
      : "不要在 assistant content 中输出 JSON、Markdown、解释文字、候选方案或草稿；结构化结果只允许出现在 function arguments 中。",
    "如果需要表达多个任务、动作、文件、证据或下一步，必须放进同一个顶层对象的数组字段里；严禁为每个条目输出一个新的顶层 JSON 对象。",
    payloadOnly
      ? "如果底层服务请求多个候选、样本或 continuation，只选择第一个候选并输出一次；完成最后一个 } 后立即停止，不得再输出第二个 { 或任何非空白字符。"
      : "不得调用多个 function，也不得使用旧 function_call 或文本 JSON 响应代替指定 tool call。",
    "不得使用 fallback、mock、预置答案、模板兜底或任务专用硬编码伪造成成功。",
    "[内部逐步推理]",
    `${instruction.reasoning} 不要输出完整 chain-of-thought/思维链；只把简短、可审计的依据写入 schema 中的 reasons、riskReasons、progress_summary、evidence、uncertainties 或 nextStep 等字段。`,
    "[结构化输出]",
    `${STRUCTURED_OUTPUT_SCHEMA_NAME}.`,
    `顶层字段 kind 必须精确等于 "${expected}"，schemaVersion 必须等于 ${PROTOCOL_VERSION}。`,
    "所有必填字段都必须出现；没有内容时用空字符串、空数组或 false，不要省略字段。",
    "字段名必须使用 schema 中的 camelCase/snake_case 原名；不要改名、翻译字段名或增加外层 payload。",
    `${payloadOnly ? "Payload" : "Function arguments"} Schema: ${ROLE_SCHEMAS[expected] || "{}"}`,
    "[Few-shot 示例]",
    examplesFor(expected),
    "Few-shot 示例只说明格式，不是本次调用参数；不要复制示例对象，也不要先提交示例再提交答案。"
  ].join("\n");
}

function functionToolForKind(kind = "") {
  const schema = FUNCTION_ARGUMENT_SCHEMAS[kind];
  if (!schema) throw new Error(`No function argument schema registered for ${String(kind || "unknown kind")}.`);
  return {
    type: "function",
    function: {
      name: functionNameForKind(kind),
      description: `Submit the AgentRoute ${kind} structured result.`,
      strict: true,
      parameters: schema
    }
  };
}

function functionCallingRequestBody(body = {}, endpointMode = "chat", kind = "") {
  if (endpointMode !== "chat") {
    throw new Error("AgentRoute structured model stages require the chat/completions function-calling transport.");
  }
  const functionName = functionNameForKind(kind);
  const next = {
    ...body,
    tools: [functionToolForKind(kind)],
    tool_choice: { type: "function", function: { name: functionName } },
    parallel_tool_calls: false
  };
  delete next.response_format;
  delete next.functions;
  delete next.function_call;
  return next;
}

function functionArgumentsFromResponse(data, expectedKind) {
  const message = data && data.choices && data.choices[0] && data.choices[0].message;
  const calls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (calls.length !== 1) {
    return {
      ok: false,
      content: "",
      error: `Structured model response must call ${functionNameForKind(expectedKind)} exactly once.`
    };
  }
  if (calls[0].type !== "function") {
    return {
      ok: false,
      content: "",
      error: `Structured model response must use a function tool call for ${functionNameForKind(expectedKind)}.`
    };
  }
  const calledFunction = calls[0] && calls[0].function;
  const actualName = String((calledFunction && calledFunction.name) || "");
  const expectedName = functionNameForKind(expectedKind);
  if (actualName !== expectedName) {
    return {
      ok: false,
      content: "",
      error: `Structured model response called ${actualName || "an unnamed function"}; expected ${expectedName}.`
    };
  }
  if (!calledFunction || typeof calledFunction.arguments !== "string" || !calledFunction.arguments.trim()) {
    return {
      ok: false,
      content: "",
      error: `Function ${expectedName} returned empty arguments.`
    };
  }
  return { ok: true, content: calledFunction.arguments, error: "" };
}

function validateKind(value, expectedKind) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Function arguments must be a JSON object." };
  }
  if (value.kind !== expectedKind) {
    return {
      ok: false,
      error: `Function arguments kind must be ${expectedKind}.`
    };
  }
  if (Number(value.schemaVersion) !== PROTOCOL_VERSION) {
    return {
      ok: false,
      error: `Function arguments schemaVersion must be ${PROTOCOL_VERSION}.`
    };
  }
  return { ok: true };
}

function parseProtocolContent(content, expectedKind, validatePayload) {
  const diagnostics = jsonParseDiagnostics(content, { allowEmbedded: false, allowRepeatedIdentical: false });
  const parsed = safeJsonParse(content, { allowEmbedded: false, allowRepeatedIdentical: false });
  if (!parsed) {
    return {
      ok: false,
      value: null,
      diagnostics,
      error: "Function arguments must contain exactly one valid JSON object."
    };
  }
  const kindValidation = validateKind(parsed, expectedKind);
  if (!kindValidation.ok) {
    return { ...kindValidation, value: null, diagnostics };
  }
  if (typeof validatePayload === "function") {
    const payloadValidation = validatePayload(parsed);
    if (payloadValidation && payloadValidation.ok === false) {
      return {
        ok: false,
        value: null,
        diagnostics,
        error: payloadValidation.error || "Function arguments payload is invalid."
      };
    }
  }
  return { ok: true, value: parsed, diagnostics, error: "" };
}

function validationForCall(content, expectedKind, validatePayload) {
  const parsed = parseProtocolContent(content, expectedKind, validatePayload);
  return parsed.ok
    ? { ok: true }
    : {
        ok: false,
        error: parsed.error,
        diagnostics: parsed.diagnostics
      };
}

module.exports = {
  KIND,
  PROTOCOL_VERSION,
  FUNCTION_ARGUMENT_SCHEMAS,
  ROLE_SCHEMAS,
  STRUCTURED_OUTPUT_SCHEMA_NAME,
  baseContract,
  functionArgumentsFromResponse,
  functionCallingRequestBody,
  functionNameForKind,
  functionToolForKind,
  parseProtocolContent,
  validationForCall,
  validateKind
};
