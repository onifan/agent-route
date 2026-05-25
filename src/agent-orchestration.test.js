"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-orchestration-"));
process.env.AGENT_ROUTE_HOME = testRoot;
process.env.AGENT_ROUTE_TASKS = path.join(testRoot, "tasks.json");
process.env.AGENT_ROUTE_OBSERVABILITY = path.join(testRoot, "observability.json");
process.env.AGENT_ROUTE_BUDGET_RECORDS = path.join(testRoot, "budget-records.json");
process.env.AGENT_ROUTE_WEB_TRANSPORT = "fetch";

const contentUtils = require("./agent/orchestrator/content-utils");
const browserWorker = require("./agent/orchestrator/browser-worker");
const dependencyEngine = require("./agent/graph");
const initialPlanning = require("./agent/orchestrator/initial-planning");
const finalizer = require("./agent/orchestrator/finalizer");
const planner = require("./agent/orchestrator/planner");
const protocol = require("./agent/orchestrator/protocol");
const resultNormalizer = require("./agent/orchestrator/result-normalizer");
const reviewLoop = require("./agent/orchestrator/review-loop");
const reviewRunner = require("./agent/orchestrator/review-runner");
const taskAppender = require("./agent/orchestrator/task-appender");
const tokenBudget = require("./agent/orchestrator/token-budget");
const orchestratorRuntime = require("./agent/orchestrator");
const webToolWorker = require("./agent/orchestrator/web-tool-worker");
const workerDispatcher = require("./agent/orchestrator/worker-dispatcher");
const workerRunner = require("./agent/orchestrator/worker-runner");
const observability = require("./agent/observability");
const recovery = require("./agent/recovery");
const riskEngine = require("./agent/risk");
const taskRuntime = require("./agent/tasks");
const verificationEngine = require("./agent/verification/engine");
const { DEFAULT_PROMPT_SETTINGS } = require("./config/prompts");
const { DEFAULT_CONFIG, normalizePromptSettings } = require("./config/loader");

function reset() {
  taskRuntime.resetRuntime();
  recovery.resetRecoveryRuntime();
  observability.setStorageFile(process.env.AGENT_ROUTE_OBSERVABILITY);
  observability.resetRuntime();
}

function studioSource() {
  return fs.readFileSync(path.join(__dirname, "..", "app", "agent-route", "studio.js"), "utf8");
}

function testInternetResearchIsRoutedToAgentToolWorker() {
  assert.equal(
    planner.shouldUseCodexCliWorker([
      {
        role: "user",
        content: "真实联网搜索5个公开自由职业项目，整理标题、预算和链接。不要登录，不要提交。"
      }
    ]),
    false
  );
  assert.equal(
    planner.shouldUseWebToolWorker([
      {
        role: "user",
        content: "真实联网搜索5个公开自由职业项目，整理标题、预算和链接。不要登录，不要提交。"
      }
    ]),
    true
  );
  assert.equal(
    planner.shouldUseWebToolWorker([
      {
        role: "user",
        content: "搜索最新公开数据并写一份风险报告。不要登录，不要提交。"
      }
    ]),
    true,
    "generic latest/current data search should receive web-tool planning constraints"
  );
  assert.equal(
    webToolWorker.shouldUseWebToolWorker({
      type: "local_execution",
      modelPool: "codex-cli",
      prompt: "真实联网搜索公开项目，可以访问 https://remotive.com/api/remote-jobs?search=python%20automation"
    }),
    true,
    "read-only public web research should reach the web tool worker instead of model or codex-cli execution"
  );
  assert.equal(
    browserWorker.shouldUseBrowserWorker({
      type: "browser",
      modelPool: "codex-cli",
      prompt: "查询公开市场数据；不要登录，不要提交表单。"
    }),
    false,
    "codex-cli browser research tasks should not be intercepted by the simple URL-only browser worker"
  );
  assert.equal(
    browserWorker.shouldUseBrowserWorker({
      type: "web_read",
      toolWorker: "web",
      input: "https://example.com/public-research-page"
    }),
    false,
    "web_read tasks belong to the web tool, not the browser automation worker"
  );
  const normalizedPlan = planner.normalizePlan(
    {
      tasks: [
        {
          id: "search-projects",
          title: "搜索公开项目",
          type: "research",
          modelPool: "free",
          description: "真实联网搜索5个公开自由职业项目，整理标题、预算、链接和来源。"
        },
        {
          id: "extract-job-fields",
          title: "提取项目字段",
          type: "extraction",
          modelPool: "free",
          dependsOn: ["search-projects"]
        }
      ]
    },
    { maxTasks: 5 },
    [
      {
        role: "user",
        content: "真实联网搜索5个公开自由职业项目，整理标题、预算和链接。不要登录，不要提交。"
      }
    ],
    null
  );
  const searchTask = normalizedPlan.tasks.find((task) => task.id === "search-projects");
  assert.equal(searchTask.modelPool, "free", "web evidence collection should use the cheap pool plus tool worker");
  assert.equal(searchTask.toolWorker, "web", "real public web research must be routed to the web tool worker");
  assert.equal(searchTask.type, "web_search");
  const browserLabeledRead = planner.normalizePlan(
    {
      tasks: [
        {
          id: "read-detailed-public-evidence",
          title: "读取公开工具对比页面获取详细证据",
          type: "browser",
          modelPool: "codex-cli",
          description: "搜索公开页面并提取来源证据。不要点击、不要截图、不要登录、不要提交。"
        }
      ]
    },
    { maxTasks: 5 },
    [
      {
        role: "user",
        content: "真实联网研究公开资料并给出可验证来源。不要登录，不要提交。"
      }
    ],
    null
  );
  assert.equal(browserLabeledRead.tasks[0].toolWorker, "web");
  assert.equal(browserLabeledRead.tasks[0].type, "web_search");
  assert.equal(browserLabeledRead.tasks[0].modelPool, "free");
  assert.equal(
    webToolWorker.searchQuery(
      {
        prompt: "Search latest USD/JPY exchange rate",
        title: "Search latest USD/JPY exchange rate",
        input: "查询日元汇率、国债收益率，并结合近期国际新闻写报告。"
      },
      []
    ),
    "latest USD/JPY exchange rate",
    "specific task prompt should beat the broad original goal and remove generic search commands"
  );
}

function testFinanceResearchPlanKeepsPlannerTasksAsWebEvidence() {
  const messages = [
    {
      role: "user",
      content:
        "请执行一次真实只读联网金融风险研究任务。查询最新日元汇率、国债收益率，并结合近期国际新闻，写一篇中文金融风险报告。优先覆盖美元/日元、日美10年期收益率或关键利差信号、至少3条国际新闻。"
    }
  ];
  const normalizedPlan = planner.normalizePlan(
    {
      tasks: [
        { id: "t1", title: "搜索最新日元兑美元汇率", type: "web_search", modelPool: "codex-cli" },
        { id: "t2", title: "搜索美国10年期国债收益率", type: "web_search", modelPool: "free" },
        { id: "t3", title: "搜索日本10年期国债收益率", type: "web_search", modelPool: "free" }
      ]
    },
    { maxTasks: 3 },
    messages,
    null
  );
  assert.deepEqual(
    normalizedPlan.tasks.map((task) => task.id),
    ["t1", "t2", "t3"]
  );
  assert.ok(normalizedPlan.tasks.every((task) => task.toolWorker === "web"));
  assert.ok(normalizedPlan.tasks.every((task) => task.modelPool === "free"));
  assert.ok(normalizedPlan.tasks.every((task) => task.produces.includes("web_evidence")));
  assert.ok(normalizedPlan.tasks.every((task) => task.maxAttempts >= 2));
  assert.ok(
    normalizedPlan.tasks.every((task) => !task.input || !task.input.includes("请执行一次真实只读联网金融风险研究任务")),
    "missing web task input must not fall back to the whole user goal"
  );
  assert.equal(
    webToolWorker.searchQueries(normalizedPlan.tasks[0], messages)[0],
    "最新日元兑美元汇率",
    "web worker should use the agent-authored task title when no explicit query input exists"
  );
}

function testWebToolWorkerSplitsMultiMetricInputIntoQueries() {
  const queries = webToolWorker.searchQueries(
    {
      id: "market-data",
      title: "获取汇率与收益率数据",
      type: "web_search",
      input: "latest USD/JPY exchange rate; US 10Y Treasury yield; Japan 10Y JGB yield or US-Japan 10Y spread signal",
      prompt: "查询公开只读数据源，记录URL、HTTP状态、标题和关键文本。不得登录、提交表单、付款、发送消息或修改文件。"
    },
    []
  );
  assert.deepEqual(queries.slice(0, 3), [
    "latest USD/JPY exchange rate",
    "US 10Y Treasury yield",
    "Japan 10Y JGB yield or US-Japan 10Y spread signal"
  ]);
  assert.ok(queries.every((query) => !/登录|提交|付款|修改|do not/i.test(query)));
}

function testWebToolWorkerPreservesBooleanSearchSyntax() {
  const queries = webToolWorker.searchQueries(
    {
      id: "selected-source-search",
      title: "Search selected public source candidates",
      type: "web_search",
      input: '"alpha beta" release notes site:example.test OR site:docs.example.test; "gamma delta" changelog'
    },
    []
  );
  assert.equal(queries[0], '"alpha beta" release notes site:example.test OR site:docs.example.test');
  assert.equal(queries[1], '"gamma delta" changelog');
}

function testWebToolWorkerLimitsMultiQueryResultReads() {
  assert.deepEqual(webToolWorker.searchOptionsForQueryCount({}, 1), {});
  assert.equal(webToolWorker.searchOptionsForQueryCount({}, 3).resultFetchLimit, 1);
  assert.equal(
    webToolWorker.searchOptionsForQueryCount({ resultFetchLimit: 0 }, 4).resultFetchLimit,
    0,
    "explicit caller limits must be respected"
  );
}

function testWebToolWorkerRemovesGenericSearchCommandPrefixes() {
  const queries = webToolWorker.searchQueries(
    {
      id: "public-data",
      title: "收集公开数据",
      type: "web_search",
      input: "精确查询城市2026年度空气质量报告；搜索 example release notes",
      prompt: "只读取证，记录URL、HTTP状态、标题和关键文本。"
    },
    []
  );
  assert.deepEqual(queries.slice(0, 2), ["城市2026年度空气质量报告", "example release notes"]);
  assert.equal(
    webToolWorker.cleanSearchQueryText("please search for alpha beta release notes"),
    "alpha beta release notes"
  );
}

function testWebToolWorkerUsesQuotedPromptQueriesWhenInputMissing() {
  const queries = webToolWorker.searchQueries(
    {
      id: "precise-retry",
      title: "Retry public evidence search",
      type: "web_search",
      input: "",
      prompt:
        'Use these candidate public search queries: "alpha beta release notes" ; "alpha beta changelog" ; "alpha beta status page". Return URL/status/title/text evidence.'
    },
    []
  );
  assert.deepEqual(queries.slice(0, 3), ["alpha beta release notes", "alpha beta changelog", "alpha beta status page"]);
  assert.ok(queries.every((query) => !/candidate public search queries|return URL/i.test(query)));
}

function testReadOnlyNewsMetadataDoesNotForceCodexCli() {
  const normalizedPlan = planner.normalizePlan(
    {
      tasks: [
        {
          id: "intl_news_evidence",
          title: "获取近期国际新闻与日元风险相关证据",
          type: "web_search",
          modelPool: "codex-cli",
          input:
            "recent international news impacting JPY, USD/JPY, US-Japan yield spread, BOJ/Fed policy, global risk sentiment",
          prompt:
            "执行只读联网搜索和读取，收集至少3条近期国际新闻；记录发布时间、URL、HTTP状态、标题和关键文本证据。不得登录、提交表单、付款、发送消息或修改文件。"
        }
      ]
    },
    { maxTasks: 3 },
    [
      {
        role: "user",
        content: "请执行真实只读联网金融风险研究任务，查询日元汇率、国债收益率和国际新闻。"
      }
    ],
    null
  );
  assert.equal(normalizedPlan.tasks[0].type, "web_search");
  assert.equal(normalizedPlan.tasks[0].modelPool, "free");
  assert.equal(normalizedPlan.tasks[0].toolWorker, "web");
}

function testReadOnlyPublicUrlBrowserTaskIsRoutedToWebTool() {
  const normalizedPlan = planner.normalizePlan(
    {
      tasks: [
        {
          id: "public-api-read",
          title: "读取公开 JSON API",
          type: "browser",
          modelPool: "codex-cli",
          prompt:
            "读取 https://example.test/public.json 这个公开 URL，记录 URL、HTTP status 和正文证据。不要点击、登录或提交。"
        }
      ]
    },
    { maxTasks: 3 },
    [{ role: "user", content: "读取公开 URL 并基于 evidence 分析。" }],
    null
  );
  assert.equal(normalizedPlan.tasks[0].modelPool, "free");
  assert.equal(normalizedPlan.tasks[0].toolWorker, "web");
  assert.equal(normalizedPlan.tasks[0].type, "api_read");
}

function testReadOnlyUrlWithTypeQueryParamDoesNotForceBrowserWorker() {
  const normalizedPlan = planner.normalizePlan(
    {
      tasks: [
        {
          id: "public-page-read",
          title: "Read public status page",
          type: "browser",
          modelPool: "codex-cli",
          prompt:
            "Read https://example.test/status?type=daily_report and return URL, HTTP status, title and text evidence."
        }
      ]
    },
    { maxTasks: 3 },
    [{ role: "user", content: "读取公开页面并基于 evidence 分析。" }],
    null
  );
  assert.equal(normalizedPlan.tasks[0].modelPool, "free");
  assert.equal(normalizedPlan.tasks[0].toolWorker, "web");
  assert.equal(normalizedPlan.tasks[0].type, "web_read");
}

function testNewsSearchUsesPlannerInputClauses() {
  const queries = webToolWorker.searchQueries(
    {
      id: "intl_news_evidence",
      title: "获取近期国际新闻与日元风险相关证据",
      type: "web_search",
      input:
        "recent international news impacting JPY, USD/JPY, US-Japan yield spread, BOJ/Fed policy, global risk sentiment",
      prompt:
        "执行只读联网搜索和读取，收集至少3条近期国际新闻；记录发布时间、URL、HTTP状态、标题和关键文本证据。不得登录、提交表单、付款、发送消息或修改文件。"
    },
    []
  );
  assert.deepEqual(queries.slice(0, 3), [
    "recent international news impacting JPY",
    "USD/JPY",
    "US-Japan yield spread"
  ]);
  assert.ok(queries.every((query) => !/执行只读联网搜索/.test(query)));
}

async function testWebEvidenceReviewAndFinalStayOnCommanderModels() {
  const commanderRoute = {
    selected: "gpt5.5",
    models: ["gpt5.5"]
  };
  const config = {
    ...DEFAULT_CONFIG,
    modelPools: {
      ...DEFAULT_CONFIG.modelPools,
      commander: commanderRoute.models,
      strong: ["openrouter/deepseek/deepseek-r1-0528"],
      free: ["gc/gemini-3-flash-preview", "openrouter/z-ai/glm-4.5-air:free"]
    }
  };
  const workerResults = [
    {
      ok: true,
      task: { id: "fx", title: "公开汇率证据", type: "web_search", status: "completed" },
      content: "verified web evidence"
    }
  ];
  const bodies = [];
  const events = [];
  const req = new Request("http://localhost/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  const nextHandler = async (request) => {
    const body = await request.json();
    bodies.push(body);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                kind: "final_answer",
                schemaVersion: 1,
                status: "completed",
                answerMarkdown: "final answer",
                artifacts: [],
                evidenceSummary: ["verified web evidence"],
                uncertainties: [],
                nextSteps: []
              })
            }
          }
        ]
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  };

  await finalizer.runFinalSynthesis({
    req,
    nextHandler,
    baseBody: { max_tokens: 256, temperature: 0.2 },
    messages: [{ role: "user", content: "基于公开证据给出结论。" }],
    allTasks: workerResults.map((result) => result.task),
    workerResults,
    config,
    defaultConfig: DEFAULT_CONFIG,
    needsLocalExecution: false,
    commanderRoute,
    goalId: "goal-commander-final",
    goalMemoryQuery: "",
    goalBudget: null,
    goalStrategy: null,
    trace: [],
    send: (event, data) => events.push({ event, data }),
    emitBudget: () => {},
    persistGoalBudget: () => {},
    taskSummary: (task) => task,
    callWithFallback: orchestratorRuntime.callWithFallback,
    startedAt: Date.now(),
    normalizePromptSettings: (value) => value || DEFAULT_PROMPT_SETTINGS
  });

  assert.deepEqual(
    bodies.map((body) => body.model),
    ["gpt5.5"]
  );
  assert.ok(!bodies.some((body) => /glm|gemini|deepseek/i.test(body.model)));
  const start = events.find((item) => item.event === "worker_start");
  assert.deepEqual(start.data.candidates, commanderRoute.models);
  assert.equal(start.data.task.modelPool, "commander");
}

async function testWebEvidenceProgressReviewStaysOnCommanderModels() {
  const commanderRoute = {
    selected: "gpt5.5",
    models: ["gpt5.5"]
  };
  const config = {
    ...DEFAULT_CONFIG,
    modelPools: {
      ...DEFAULT_CONFIG.modelPools,
      commander: commanderRoute.models,
      strong: ["openrouter/deepseek/deepseek-r1-0528"],
      free: ["gc/gemini-3-flash-preview", "openrouter/z-ai/glm-4.5-air:free"]
    }
  };
  const allTasks = [{ id: "evidence", title: "公开证据", type: "web_search", status: "completed" }];
  const workerResults = [{ ok: true, task: allTasks[0], content: "verified web evidence" }];
  const modelLists = [];
  const events = [];

  await reviewRunner.runReviewIteration({
    req: new Request("http://localhost/api/v1/chat/completions", { method: "POST" }),
    nextHandler: async () => {
      throw new Error("test callWithFallback should intercept model calls");
    },
    baseBody: { max_tokens: 256, temperature: 0.2 },
    messages: [{ role: "user", content: "基于公开证据判断是否完成。" }],
    config,
    defaultConfig: DEFAULT_CONFIG,
    needsLocalExecution: false,
    commanderRoute,
    iteration: 1,
    maxGoalIterations: 4,
    goalId: "goal-commander-review",
    goalMemoryQuery: "",
    allTasks,
    workerResults,
    goalBudget: null,
    goalStrategy: null,
    trace: [],
    send: (event, data) => events.push({ event, data }),
    emitBudget: () => {},
    emitStrategy: () => {},
    persistGoalBudget: () => {},
    taskSummary: (task) => task,
    callWithFallback: async ({ models }) => {
      modelLists.push(models);
      return {
        ok: true,
        model: models[0],
        content: JSON.stringify({
          kind: "goal_review",
          schemaVersion: 1,
          status: "done",
          progress_summary: "证据已覆盖目标。",
          final_answer: "完成。",
          next_tasks: [],
          memory_candidates: []
        }),
        elapsedMs: 1
      };
    },
    normalizePromptSettings: (value) => value || DEFAULT_PROMPT_SETTINGS
  });

  assert.deepEqual(modelLists, [commanderRoute.models]);
  assert.ok(!modelLists.flat().some((model) => /glm|gemini|deepseek/i.test(model)));
  const start = events.find((item) => item.event === "worker_start");
  assert.deepEqual(start.data.candidates, commanderRoute.models);
  assert.equal(start.data.task.modelPool, "commander");
}

function testWorkerEvidenceCompactionPreservesStructuredRows() {
  const content = [
    "Query: collect public evidence",
    "- First source: alpha observation | timestamp=2026-05-21T00:00:00Z | source=https://example.test/alpha | HTTP 200",
    ...Array.from(
      { length: 20 },
      (_, index) =>
        `- Middle source ${index}: long filler | timestamp=2026-05-21T00:${String(index).padStart(2, "0")}:00Z | source=https://example.test/${index} | HTTP 200 | summary=${"evidence ".repeat(30)}`
    ),
    "Query: collect later public evidence",
    "- Last source: omega observation | timestamp=2026-05-21T01:00:00Z | source=https://example.test/omega | HTTP 200"
  ].join("\n");
  const compacted = reviewLoop.compactWorkerResult(
    {
      task: { id: "evidence", title: "收集公开证据", type: "web_search", toolWorker: "web" },
      model: "web-tool",
      status: "success",
      content
    },
    2600
  );
  assert.match(compacted, /First source: alpha observation/);
  assert.match(compacted, /Last source: omega observation/);
}

function testReviewSourceDiagnosticsGuideGenericDiscovery() {
  const results = [
    {
      ok: false,
      status: "failed",
      error: "HTTP 403 Forbidden: verify you are human",
      task: {
        id: "blocked-source",
        title: "Read public source candidate",
        type: "web_read",
        toolWorker: "web",
        input: "https://blocked.example.test/report",
        prompt: "读取这个公开页面并返回 URL、status、title、text evidence。",
        status: "failed",
        verificationStatus: "unverified"
      }
    },
    {
      ok: false,
      status: "failed",
      content: "Search returned an unrelated dictionary/navigation page.",
      task: {
        id: "broad-search",
        title: "Search public evidence",
        type: "web_search",
        toolWorker: "web",
        input: "generic public data report",
        status: "failed",
        verificationStatus: "unverified"
      }
    },
    {
      ok: true,
      status: "success",
      content: "Readable source https://open.example.test/data HTTP 200 title=Open Dataset text=Verified facts.",
      task: {
        id: "readable-source",
        title: "Read public source",
        type: "web_read",
        toolWorker: "web",
        input: "https://open.example.test/data",
        status: "completed",
        verificationStatus: "verified"
      }
    }
  ];
  const diagnostics = reviewLoop.webSourceDiagnostics(results);
  assert.match(diagnostics, /联网取证诊断/);
  assert.match(diagnostics, /blocked\.example\.test/);
  assert.match(diagnostics, /HTTP 403\/access-blocked/);
  assert.match(diagnostics, /失败\/无关查询/);
  assert.match(diagnostics, /generic public data report/);
  assert.match(diagnostics, /已可读来源/);
  assert.match(diagnostics, /open\.example\.test/);
  assert.doesNotMatch(diagnostics, /USD\/JPY|日元|国债|MarketWatch|Reuters|TradingEconomics/i);

  const reviewMessages = reviewLoop.makeProgressMessages(
    [{ role: "user", content: "查找公开资料并基于证据完成报告。" }],
    { tasks: [] },
    results,
    2,
    { promptSettings: DEFAULT_PROMPT_SETTINGS },
    "",
    null,
    { normalizePromptSettings: (value) => value }
  );
  const promptText = reviewMessages.map((message) => message.content).join("\n");
  assert.match(promptText, /source-discovery web_search/);
  assert.match(promptText, /不要重复同一失败 URL/);
  assert.match(promptText, /blocked\.example\.test/);
  assert.doesNotMatch(promptText, /MarketWatch|TradingEconomics/i);
}

function testReviewPromptIncludesVerifiedEvidenceInventoryFromPlan() {
  const reviewMessages = reviewLoop.makeProgressMessages(
    [{ role: "user", content: "查找公开资料并基于证据完成报告。" }],
    {
      tasks: [
        {
          id: "early-search",
          title: "Search broad public data",
          type: "web_search",
          toolWorker: "web",
          status: "failed",
          verificationStatus: "unverified",
          input: "broad public data",
          result: "Returned unrelated dictionary pages."
        },
        {
          id: "verified-read",
          title: "Read selected public source",
          type: "web_read",
          toolWorker: "web",
          status: "completed",
          verificationStatus: "verified",
          input: "https://open.example.test/data",
          result:
            "URL: https://open.example.test/data\nHTTP: 200\nTitle: Open Dataset\nText: Verified public evidence row."
        },
        {
          id: "waiting-read",
          title: "Read second selected public source",
          type: "web_read",
          toolWorker: "web",
          status: "waiting",
          dependsOn: ["verified-read"]
        }
      ]
    },
    [],
    3,
    { promptSettings: DEFAULT_PROMPT_SETTINGS },
    "",
    null,
    { normalizePromptSettings: (value) => value }
  );
  const promptText = reviewMessages.map((message) => message.content).join("\n");
  assert.match(promptText, /仍可行动\/未执行真实任务清单/);
  assert.match(promptText, /waiting-read/);
  assert.match(promptText, /不得返回 done\/final_answer/);
  assert.match(promptText, /已验证证据清单/);
  assert.match(promptText, /verified-read/);
  assert.match(promptText, /open\.example\.test\/data/);
  assert.match(promptText, /早期失败任务只表示对应路径失败/);
  assert.doesNotMatch(promptText, /USD\/JPY|日元|国债|MarketWatch|Reuters|TradingEconomics/i);
}

function testAgentPromptsCarryRuntimeTemporalContext() {
  const fixedContext = contentUtils.runtimeTemporalContext(new Date("2026-05-22T10:00:00.000Z"));
  assert.match(fixedContext, /2026-05-22T10:00:00\.000Z/);
  assert.match(fixedContext, /今天\/最新\/近期\/当前/);
  assert.match(fixedContext, /不要使用训练记忆猜年份/);

  const planMessages = planner.makePlanPrompt(
    [{ role: "user", content: "查询最新公开资料并总结。" }],
    { promptSettings: DEFAULT_PROMPT_SETTINGS, maxTasks: 3 },
    "",
    null,
    { normalizePromptSettings: (value) => value }
  );
  const reviewMessages = reviewLoop.makeProgressMessages(
    [{ role: "user", content: "查询最新公开资料并总结。" }],
    { tasks: [] },
    [],
    1,
    { promptSettings: DEFAULT_PROMPT_SETTINGS },
    "",
    null,
    { normalizePromptSettings: (value) => value }
  );
  const finalMessages = finalizer.makeFinalMessages(
    [{ role: "user", content: "查询最新公开资料并总结。" }],
    { tasks: [] },
    [],
    { promptSettings: DEFAULT_PROMPT_SETTINGS },
    "",
    null,
    { normalizePromptSettings: (value) => value }
  );
  for (const promptText of [planMessages, reviewMessages, finalMessages].map((messages) =>
    messages.map((message) => message.content).join("\n")
  )) {
    assert.match(promptText, /运行时间上下文/);
    assert.match(promptText, /now=\d{4}-\d{2}-\d{2}T/);
    assert.match(promptText, /最新\/近期\/当前/);
  }
}

function testPlannerRejectsRepeatedIdenticalJsonDocuments() {
  const plan = {
    kind: "plan",
    schemaVersion: 1,
    tasks: [
      {
        id: "collect-evidence",
        title: "Collect generic evidence",
        type: "analysis",
        modelPool: "strong",
        successCriteria: ["Evidence is collected and summarized."]
      }
    ]
  };
  const content = `${JSON.stringify(plan)}\n${JSON.stringify(plan)}`;
  const parsed = planner.parsePlannerContent(content);
  assert.equal(parsed, null);
  const diagnostics = planner.plannerContentDiagnostics(content);
  assert.equal(diagnostics.topLevelJsonDocuments, 2);
  assert.equal(diagnostics.repeatedIdenticalJsonDocuments, true);
  assert.equal(diagnostics.hasValidTaskGraph, false);
  assert.equal(diagnostics.parseError, "multiple_repeated_json_documents");
}

function testPlannerRejectsDifferentConcatenatedJsonDocuments() {
  const first = {
    kind: "plan",
    schemaVersion: 1,
    tasks: [
      {
        id: "first",
        title: "First task",
        type: "analysis",
        modelPool: "strong",
        successCriteria: ["First task is valid."]
      }
    ]
  };
  const second = {
    kind: "plan",
    schemaVersion: 1,
    tasks: [
      {
        id: "second",
        title: "Second task",
        type: "analysis",
        modelPool: "strong",
        successCriteria: ["Second task is valid."]
      }
    ]
  };
  const content = `${JSON.stringify(first)}${JSON.stringify(second)}`;
  assert.equal(planner.parsePlannerContent(content), null);
  const diagnostics = planner.plannerContentDiagnostics(content);
  assert.equal(diagnostics.topLevelJsonDocuments, 2);
  assert.equal(diagnostics.repeatedIdenticalJsonDocuments, false);
  assert.equal(diagnostics.hasValidTaskGraph, false);
  assert.equal(diagnostics.parseError, "multiple_different_json_documents");
}

async function testWebToolWorkerCollectsEvidenceWithoutModel() {
  const previousFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    assert.equal(options.method, "GET");
    assert.match(String(url), /example\.test\/report/);
    return new Response(
      "<html><head><title>Example Report</title></head><body><main>Verified public market evidence with source URL.</main></body></html>",
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  };
  try {
    const task = {
      id: "read-public-report",
      title: "Read public report",
      type: "web_read",
      modelPool: "free",
      toolWorker: "web",
      prompt: "读取 https://example.test/report 这个公开页面，提取标题和正文证据。"
    };
    const result = await webToolWorker.runWebToolWorker(task, {}, []);
    assert.equal(result.model, "web-tool");
    assert.equal(result.ok, true);
    const parsed = JSON.parse(result.content);
    assert.equal(parsed.kind, "worker_result");
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.status, "success");
    assert.equal(parsed.evidenceCounts.apiResponses, 1);
    assert.equal(parsed.evidenceCounts.browserEvidence, 1);
    assert.equal(parsed.evidence.apiResponses[0].status, 200);
    assert.equal(result.evidence.apiResponses[0].status, 200);
    assert.match(result.evidence.browser.pageText, /Verified public market evidence/);

    const runtimeResult = resultNormalizer.makeWorkerRuntimeResult(result, task);
    assert.equal(runtimeResult.context.model, "web-tool");
    assert.equal(runtimeResult.evidence.apiResponses[0].status, 200);
    assert.match(runtimeResult.evidence.browser.pageText, /Verified public market evidence/);
    const verification = verificationEngine.verifyTaskResult(
      { ...task, successCriteria: ["URL/status/title/text evidence exists."] },
      runtimeResult,
      { phase: "after_worker", maxAttempts: 2 }
    );
    assert.notEqual(verification.verificationStatus, verificationEngine.VERIFICATION_STATUS.UNVERIFIED);
  } finally {
    global.fetch = previousFetch;
  }
}

async function testWebToolWorkerReadsMultipleAgentProvidedUrls() {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    const suffix = String(url).endsWith("/one") ? "one" : "two";
    return new Response(
      `<html><head><title>Source ${suffix}</title></head><body>Readable source ${suffix} evidence.</body></html>`,
      { status: 200, headers: { "Content-Type": "text/html" } }
    );
  };
  const result = await webToolWorker.runWebToolWorker(
    {
      id: "read-two-sources",
      title: "Read selected public sources",
      type: "web_read",
      toolWorker: "web",
      prompt: "Read https://example.test/one and https://example.test/two. Return URL/status/title/text evidence."
    },
    { tools: { web: { fetchImpl } } },
    []
  );
  assert.equal(result.ok, true);
  assert.deepEqual(seen, ["https://example.test/one", "https://example.test/two"]);
  assert.match(result.content, /Source one/);
  assert.match(result.content, /Source two/);
}

async function testPlanningFailureDoesNotEmitSuccessfulFinal() {
  reset();
  const goalId = "plan-failure-goal";
  taskRuntime.registerGoalTasks(goalId, [], { replace: true, source: "test" });
  const events = [];
  const result = await initialPlanning.runInitialPlanning({
    req: {},
    nextHandler: async () => {
      throw new Error("should not call nextHandler directly");
    },
    baseBody: {},
    messages: [{ role: "user", content: "只读分析 worker 调用链路" }],
    config: { ...DEFAULT_CONFIG, modelMaxAttempts: 1 },
    defaultConfig: DEFAULT_CONFIG,
    commanderRoute: { selected: "openrouter/test", models: ["openrouter/test"] },
    goalId,
    plannerMemory: "",
    goalStrategy: null,
    goalBudget: null,
    trace: [],
    send: (event, data) => events.push({ event, data }),
    emitBudget: () => {},
    appendTasks: () => [],
    taskSummary: (task) => task,
    startedAt: Date.now(),
    callWithFallback: async () => ({
      ok: false,
      model: "openrouter/test",
      error: "upstream credits exhausted",
      elapsedMs: 10
    }),
    persistGoalBudget: () => {},
    normalizePromptSettings
  });
  const goal = taskRuntime.listGoals().find((item) => item.goalId === goalId);
  assert.equal(result.handled, true);
  assert.equal(result.reason, "plan_failed");
  assert.equal(goal.status, taskRuntime.TASK_STATUS.FAILED);
  assert.match(goal.blockedReason, /credits exhausted/);
  assert.ok(
    events.some((item) => item.event === "error"),
    "planning failure should emit an error"
  );
  assert.equal(
    events.some((item) => item.event === "final"),
    false,
    "planning failure must not emit successful final"
  );
}

async function testInvalidWebPlanFailsWithoutRulePlanner() {
  reset();
  const goalId = "invalid-web-plan-goal";
  const events = [];
  const result = await initialPlanning.runInitialPlanning({
    req: {},
    nextHandler: async () => {
      throw new Error("should not call nextHandler directly");
    },
    baseBody: {},
    messages: [
      {
        role: "user",
        content:
          "请执行一次真实只读联网金融风险研究任务。查询最新日元汇率、国债收益率，并结合近期国际新闻，写一篇中文金融风险报告。"
      }
    ],
    config: { ...DEFAULT_CONFIG, modelMaxAttempts: 1 },
    defaultConfig: DEFAULT_CONFIG,
    commanderRoute: { selected: "openrouter/test", models: ["openrouter/test"] },
    goalId,
    plannerMemory: "",
    goalStrategy: null,
    goalBudget: null,
    trace: [],
    send: (event, data) => events.push({ event, data }),
    emitBudget: () => {},
    appendTasks: (tasks) => tasks,
    taskSummary: (task) => task,
    startedAt: Date.now(),
    callWithFallback: async () => ({
      ok: true,
      model: "openrouter/test",
      content: "not json",
      elapsedMs: 10
    }),
    persistGoalBudget: () => {},
    normalizePromptSettings
  });
  const goal = taskRuntime.listGoals().find((item) => item.goalId === goalId);
  assert.equal(result.handled, true);
  assert.equal(result.reason, "plan_invalid");
  assert.equal(goal.status, taskRuntime.TASK_STATUS.FAILED);
  assert.ok(events.some((item) => item.event === "error"));
  assert.equal(
    events.some((item) => item.event === "worker_done" && item.data.model === "rule-planner"),
    false,
    "invalid planner output must not be replaced by rule planner output"
  );
}

async function testProviderCreditLimitRetriesWithLowerMaxTokens() {
  const trace = [];
  const requestBodies = [];
  const result = await orchestratorRuntime.callWithFallback({
    req: new Request("http://localhost/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    }),
    nextHandler: async (request) => {
      const body = await request.json();
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message:
                "This request requires more credits, or fewer max_tokens. You requested up to 1600 tokens, but can only afford 306."
            }
          }),
          { status: 402, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  kind: "plan",
                  schemaVersion: 1,
                  tasks: [
                    {
                      id: "web",
                      title: "Search public data",
                      type: "web_search",
                      modelPool: "free",
                      toolWorker: "web"
                    }
                  ]
                })
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
    baseBody: { max_tokens: 1600, temperature: 0.2 },
    models: ["openrouter/test-model"],
    messages: [{ role: "user", content: "Create a compact plan." }],
    config: DEFAULT_CONFIG,
    label: "plan",
    trace,
    endpointMode: "chat"
  });

  assert.equal(result.ok, true);
  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[0].max_tokens, 1600);
  assert.ok(requestBodies[1].max_tokens < 1600);
  assert.ok(requestBodies[1].max_tokens <= 306);
  assert.match(requestBodies[1].messages[0].content, /Retry constraint/);
  assert.ok(trace.some((item) => item.label === "plan:max_tokens_retry" && item.ok === true));
}

async function testModelCallProgressEventsExposeAttemptsAndFailover() {
  const events = [];
  const trace = [];
  const result = await orchestratorRuntime.callWithFallback({
    req: new Request("http://localhost/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    }),
    nextHandler: async (request) => {
      const body = await request.json();
      if (body.model === "openrouter/first-model") {
        return new Response(JSON.stringify({ error: { message: "first model failed" } }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok from second model" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    },
    baseBody: { max_tokens: 256, temperature: 0.2 },
    models: ["openrouter/first-model", "openrouter/second-model"],
    messages: [{ role: "user", content: "Return a short answer." }],
    config: { ...DEFAULT_CONFIG, modelMaxAttempts: 1 },
    label: "plan",
    trace,
    endpointMode: "chat",
    onModelEvent: (event, data) => events.push({ event, data })
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    events.map((item) => item.event),
    ["model_attempt", "model_failure", "model_failover", "model_attempt", "model_success"]
  );
  assert.equal(events[0].data.model, "openrouter/first-model");
  assert.equal(events[2].data.fromModel, "openrouter/first-model");
  assert.equal(events[2].data.toModel, "openrouter/second-model");
  assert.equal(events[4].data.model, "openrouter/second-model");
}

async function testModelCallDoesNotRetryConnectionFailure() {
  const events = [];
  const trace = [];
  let calls = 0;
  const result = await orchestratorRuntime.callWithFallback({
    req: new Request("http://localhost/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    }),
    nextHandler: async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          error: {
            message: "Internal model request failed: fetch failed"
          }
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    },
    baseBody: { max_tokens: 256, temperature: 0.2 },
    models: ["gpt5.5"],
    messages: [{ role: "user", content: "Create a plan." }],
    config: { ...DEFAULT_CONFIG, modelMaxAttempts: 3 },
    label: "plan",
    trace,
    endpointMode: "chat",
    onModelEvent: (event, data) => events.push({ event, data })
  });

  assert.equal(result.ok, false);
  assert.equal(calls, 1);
  assert.deepEqual(
    events.map((item) => item.event),
    ["model_attempt", "model_failure"]
  );
  assert.equal(
    trace.some((item) => item.retry),
    false
  );
}

async function testModelCallDoesNotRetryInvalidStructuredOutput() {
  const events = [];
  const trace = [];
  let calls = 0;
  const result = await orchestratorRuntime.callWithFallback({
    req: new Request("http://localhost/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    }),
    nextHandler: async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    },
    baseBody: { max_tokens: 256, temperature: 0.2 },
    models: ["GPT-5.5"],
    messages: [{ role: "user", content: "Return a task graph JSON object." }],
    config: { ...DEFAULT_CONFIG, modelMaxAttempts: 3 },
    label: "plan",
    trace,
    endpointMode: "chat",
    validateContent: (content) => {
      const parsed = planner.parsePlannerContent(content);
      return parsed ? { ok: true } : { ok: false, error: "Planner response did not contain a valid plan schema." };
    },
    onModelEvent: (event, data) => events.push({ event, data })
  });

  assert.equal(result.ok, false);
  assert.equal(calls, 1);
  assert.deepEqual(
    events.map((item) => item.event),
    ["model_attempt", "model_failure"]
  );
  assert.equal(events[1].data.model, "GPT-5.5");
  assert.match(result.error, /valid plan schema/);
  assert.equal(
    trace.some((item) => item.retry),
    false
  );
}

async function testStructuredOutputErrorExplainsMultipleJsonDocuments() {
  const requestBodies = [];
  let calls = 0;
  const first = {
    kind: "plan",
    schemaVersion: 1,
    tasks: [{ id: "first", title: "First", type: "analysis", modelPool: "free", successCriteria: ["first"] }]
  };
  const second = {
    kind: "plan",
    schemaVersion: 1,
    tasks: [{ id: "second", title: "Second", type: "analysis", modelPool: "free", successCriteria: ["second"] }]
  };
  const result = await orchestratorRuntime.callWithFallback({
    req: new Request("http://localhost/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    }),
    nextHandler: async (request) => {
      calls += 1;
      const body = await request.json();
      requestBodies.push(body);
      const content = `${JSON.stringify(first)}${JSON.stringify(second)}`;
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    },
    baseBody: { max_tokens: 512, temperature: 0.2 },
    models: ["GPT-5.5"],
    messages: [{ role: "user", content: "Return one AgentRoute plan object." }],
    config: { ...DEFAULT_CONFIG, modelMaxAttempts: 2 },
    label: "plan",
    trace: [],
    endpointMode: "chat",
    responseFormatKind: protocol.KIND.PLAN,
    validateContent: (content) => {
      const parsed = planner.parsePlannerContent(content);
      return parsed
        ? { ok: true }
        : {
            ok: false,
            error: "Planner response did not contain a valid structured plan object.",
            diagnostics: planner.plannerContentDiagnostics(content)
          };
    }
  });

  assert.equal(result.ok, false);
  assert.equal(calls, 1);
  assert.equal(requestBodies.length, 1);
  assert.equal(requestBodies[0].response_format.type, "json_object");
  assert.match(result.error, /multiple_different_json_documents/);
  assert.match(result.error, /topLevelJsonDocuments=2/);
}

async function testToolWorkerRetriesTransientFailuresOnly() {
  const originalRunWebToolWorker = webToolWorker.runWebToolWorker;
  const events = [];
  const trace = [];
  let calls = 0;
  const task = {
    id: "tool-retry",
    title: "Read public evidence",
    type: "web_search",
    toolWorker: "web",
    modelPool: "free"
  };
  webToolWorker.runWebToolWorker = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        task,
        ok: false,
        model: "web-tool",
        content: "Query: public evidence\nError: fetch failed",
        error: "fetch failed",
        elapsedMs: 5
      };
    }
    return {
      task,
      ok: true,
      model: "web-tool",
      content: JSON.stringify({
        status: "success",
        output: "Readable public evidence captured.",
        evidence: {
          summary: "Readable public evidence captured.",
          apiResponses: [{ url: "https://example.test/public", status: 200 }],
          semantic: {
            outputSummary: "Readable public evidence captured.",
            addressesCriteria: true,
            criteriaCoverage: 1,
            qualityScore: 1
          }
        }
      }),
      error: "",
      elapsedMs: 5
    };
  };
  try {
    const result = await workerDispatcher.dispatchWorker({
      messages: [],
      config: { ...DEFAULT_CONFIG, toolMaxAttempts: 2, toolRetryDelayMs: 0 },
      runningTask: task,
      workerResults: [],
      pool: [],
      trace,
      send: (event, data) => events.push({ event, data }),
      taskSummary: (value) => ({ id: value.id, title: value.title, type: value.type, toolWorker: value.toolWorker })
    });
    assert.equal(result.ok, true);
    assert.equal(result.toolAttempts, 2);
    assert.equal(calls, 2);
    assert.equal(
      events.some((item) => item.event === "tool_retry"),
      true
    );
    assert.deepEqual(
      trace.map((item) => ({ ok: item.ok, toolAttempt: item.toolAttempt, maxToolAttempts: item.maxToolAttempts })),
      [
        { ok: false, toolAttempt: 1, maxToolAttempts: 2 },
        { ok: true, toolAttempt: 2, maxToolAttempts: 2 }
      ]
    );

    calls = 0;
    events.length = 0;
    trace.length = 0;
    webToolWorker.runWebToolWorker = async () => {
      calls += 1;
      return {
        task,
        ok: false,
        model: "web-tool",
        content: "",
        error: "Web read task did not include a public HTTP(S) URL.",
        elapsedMs: 5
      };
    };
    const deterministicFailure = await workerDispatcher.dispatchWorker({
      messages: [],
      config: { ...DEFAULT_CONFIG, toolMaxAttempts: 3, toolRetryDelayMs: 0 },
      runningTask: task,
      workerResults: [],
      pool: [],
      trace,
      send: (event, data) => events.push({ event, data }),
      taskSummary: (value) => ({ id: value.id, title: value.title, type: value.type, toolWorker: value.toolWorker })
    });
    assert.equal(deterministicFailure.ok, false);
    assert.equal(deterministicFailure.toolAttempts, 1);
    assert.equal(calls, 1);
    assert.equal(
      events.some((item) => item.event === "tool_retry"),
      false
    );
  } finally {
    webToolWorker.runWebToolWorker = originalRunWebToolWorker;
  }
}

async function testModelCallProgressEventsExposeTimeout() {
  const events = [];
  const result = await orchestratorRuntime.callWithFallback({
    req: new Request("http://localhost/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    }),
    nextHandler: async () => new Promise(() => {}),
    baseBody: { max_tokens: 256, temperature: 0.2 },
    models: ["openrouter/slow-model"],
    messages: [{ role: "user", content: "Return a short answer." }],
    config: DEFAULT_CONFIG,
    label: "plan",
    trace: [],
    endpointMode: "chat",
    timeoutMsOverride: 5,
    onModelEvent: (event, data) => events.push({ event, data })
  });

  assert.equal(result.ok, false);
  assert.equal(result.model, "openrouter/slow-model");
  assert.ok(events.some((item) => item.event === "model_timeout" && item.data.model === "openrouter/slow-model"));
}

function testAnalysisWorkerReceivesUpstreamEvidence() {
  const messages = workerRunner.makeWorkerMessages(
    [{ role: "user", content: "写中文金融风险报告。" }],
    {
      id: "report",
      title: "生成中文金融风险报告",
      type: "analysis",
      modelPool: "strong",
      prompt: "仅使用上游证据撰写报告。"
    },
    { promptSettings: DEFAULT_PROMPT_SETTINGS },
    "",
    {
      previousResults: [
        {
          ok: true,
          model: "web-tool",
          task: { id: "fx", title: "搜索最新日元兑美元汇率", verificationStatus: "verified", type: "web_search" },
          content:
            "Stooq USD/JPY CSV quote https://stooq.com/q/l/?s=usdjpy&f=sd2t2ohlcv&h&e=csv HTTP 200 Evidence: Symbol,Date,Time,Open,High,Low,Close,Volume USDJPY,2026-05-21,10:12:28,158.862,159.0875,158.8165,158.9515,",
          evidence: {
            apiResponses: [{ url: "https://stooq.com/q/l/?s=usdjpy&f=sd2t2ohlcv&h&e=csv", status: 200 }],
            semantic: { outputSummary: "USDJPY CSV evidence" }
          }
        }
      ]
    }
  );
  const promptText = messages.map((message) => message.content).join("\n");
  assert.match(promptText, /可用上游 worker 结果与证据/);
  assert.match(promptText, /Stooq USD\/JPY CSV quote/);
  assert.match(promptText, /只能基于这些已返回证据进行综合/);
}

function testCommanderPromptsSeparatePlanningFromExecution() {
  assert.equal(DEFAULT_PROMPT_SETTINGS.version, 9);
  assert.match(DEFAULT_PROMPT_SETTINGS.commanderSystem, /\[角色\]/);
  assert.match(DEFAULT_PROMPT_SETTINGS.commanderSystem, /\[任务\]/);
  assert.match(DEFAULT_PROMPT_SETTINGS.commanderSystem, /\[约束\]/);
  assert.match(DEFAULT_PROMPT_SETTINGS.commanderSystem, /\[内部逐步推理\]/);
  assert.match(DEFAULT_PROMPT_SETTINGS.commanderSystem, /规划不是执行/);
  assert.match(DEFAULT_PROMPT_SETTINGS.plannerInstructions, /普通聊天模型不能假装/);
  assert.match(DEFAULT_PROMPT_SETTINGS.plannerInstructions, /source-discovery web_search/);
  assert.match(DEFAULT_PROMPT_SETTINGS.plannerInstructions, /Structured Output Schema v1/);
  assert.match(DEFAULT_PROMPT_SETTINGS.plannerInstructions, /kind 必须是 "plan"/);
  assert.match(DEFAULT_PROMPT_SETTINGS.plannerInstructions, /\[Few-shot\]/);
  assert.match(DEFAULT_PROMPT_SETTINGS.plannerInstructions, /不得重复输出/);
  assert.match(DEFAULT_PROMPT_SETTINGS.plannerInstructions, /不得使用 Markdown/);
  assert.match(DEFAULT_PROMPT_SETTINGS.plannerInstructions, /标准英文\/代码\/缩写/);
  assert.match(DEFAULT_PROMPT_SETTINGS.plannerInstructions, /不要默认把某个来源名/);
  assert.match(DEFAULT_PROMPT_SETTINGS.reviewSystem, /失败来源诊断/);
  assert.match(DEFAULT_PROMPT_SETTINGS.reviewSystem, /kind 必须是 "goal_review"/);
  assert.match(DEFAULT_PROMPT_SETTINGS.reviewSystem, /不要使用 Markdown/);
  assert.match(DEFAULT_PROMPT_SETTINGS.reviewSystem, /标准英文\/代码\/缩写/);
  assert.match(DEFAULT_PROMPT_SETTINGS.reviewSystem, /避免默认把来源名/);
  assert.match(DEFAULT_PROMPT_SETTINGS.reviewSystem, /普通“写报告\/最终报告”应由 final_answer 收口/);
  assert.match(DEFAULT_PROMPT_SETTINGS.finalSystem, /kind 必须是 "final_answer"/);
  assert.match(DEFAULT_PROMPT_SETTINGS.workerSystem, /actions 数组只能列出本次 worker run 中真实执行过的动作/);
  assert.match(DEFAULT_PROMPT_SETTINGS.workerSystem, /结构化 evidence object/);
  assert.match(DEFAULT_PROMPT_SETTINGS.workerSystem, /"kind":"worker_result"/);
  assert.doesNotMatch(DEFAULT_PROMPT_SETTINGS.workerSystem, /"evidence"\s*:\s*\[\]/);

  const source = studioSource();
  assert.match(
    source,
    /src\/config\/prompts\/default-prompt-settings/,
    "dashboard imports the shared backend prompt defaults instead of carrying a second default copy"
  );
  assert.match(source, /有效 Prompt 预览/, "dashboard shows effective prompt preview");

  const planMessages = planner.makePlanPrompt(
    [{ role: "user", content: "真实联网搜索5个公开项目，整理标题、链接和来源。不要登录，不要提交。" }],
    { promptSettings: DEFAULT_PROMPT_SETTINGS, maxTasks: 3 },
    "",
    null,
    { normalizePromptSettings: (value) => value }
  );
  const promptText = planMessages.map((message) => message.content).join("\n");
  assert.match(promptText, /planner 输出描述的是待执行任务，不是已完成动作/);
  assert.match(promptText, /只返回一个 JSON 对象/);
  assert.match(promptText, /不得输出 Markdown、代码围栏、解释文字、多个 JSON/);
  assert.match(promptText, /toolWorker 为 web/);
  assert.match(promptText, /modelPool 为 free/);
  assert.match(promptText, /URL\/status\/title\/text\/API evidence/);
  assert.match(promptText, /source-discovery web_search/);
  assert.match(promptText, /标准英文\/代码\/缩写/);
  assert.match(promptText, /不要默认把某个来源名/);
  assert.match(promptText, /不同事实\/数据点拆成不同 web task/);
  assert.match(promptText, /不要为“最终报告、最终答案、总结汇总”单独创建普通 worker/);
  assert.match(promptText, /Schema: \{"kind":"plan","schemaVersion":1/);
  assert.match(promptText, /\[结构化指令\]/);
  assert.match(promptText, /\[内部逐步推理\]/);
  assert.match(promptText, /\[Few-shot 示例\]/);
  assert.match(promptText, /示例 1 输入/);
  assert.match(promptText, /示例 2 输出/);
  assert.match(promptText, /不要输出完整 chain-of-thought\/思维链/);
  assert.ok(promptText.length < 14000, "planner prompt must stay bounded while carrying protocol examples");

  const reviewMessages = reviewLoop.makeProgressMessages(
    [{ role: "user", content: "查询日元汇率和国际新闻，写金融风险报告。" }],
    { tasks: [] },
    [],
    1,
    { promptSettings: DEFAULT_PROMPT_SETTINGS },
    "",
    null,
    { normalizePromptSettings: (value) => value }
  );
  const reviewPromptText = reviewMessages.map((message) => message.content).join("\n");
  assert.match(reviewPromptText, /不要为了写最终报告/);
  assert.match(reviewPromptText, /Schema: \{"kind":"goal_review","schemaVersion":1/);
  assert.match(reviewPromptText, /\[Few-shot 示例\]/);
  assert.match(reviewPromptText, /不要使用 Markdown/);
  assert.match(reviewPromptText, /next_tasks 最多 3 个/);

  const workerPromptText = workerRunner
    .makeWorkerMessages(
      [{ role: "user", content: "基于已提供证据输出摘要。" }],
      {
        id: "summarize-evidence",
        title: "Summarize evidence",
        type: "analysis",
        modelPool: "free",
        successCriteria: ["输出基于证据的摘要"]
      },
      { promptSettings: DEFAULT_PROMPT_SETTINGS },
      "",
      { normalizePromptSettings: (value) => value }
    )
    .map((message) => message.content)
    .join("\n");
  assert.match(workerPromptText, /Schema: \{"kind":"worker_result","schemaVersion":1/);
  assert.match(workerPromptText, /\[Few-shot 示例\]/);

  const verifierPromptText = workerRunner
    .makeVerifierMessages(
      [{ role: "user", content: "基于已提供证据输出摘要。" }],
      { id: "summarize-evidence", title: "Summarize evidence", type: "analysis", successCriteria: ["输出摘要"] },
      {
        status: "success",
        output: "摘要",
        evidence: { summary: "provided evidence" },
        artifacts: []
      },
      { verificationStatus: "partially_verified", reasons: ["rule check"] },
      null
    )
    .map((message) => message.content)
    .join("\n");
  assert.match(verifierPromptText, /Schema: \{"kind":"verification_result","schemaVersion":1/);
  assert.match(verifierPromptText, /\[Few-shot 示例\]/);

  const finalPromptText = finalizer
    .makeFinalMessages(
      [{ role: "user", content: "输出最终答案。" }],
      { tasks: [] },
      [{ ok: true, task: { id: "summarize-evidence", title: "Summarize evidence" }, content: "摘要" }],
      { promptSettings: DEFAULT_PROMPT_SETTINGS },
      "",
      null,
      { normalizePromptSettings: (value) => value }
    )
    .map((message) => message.content)
    .join("\n");
  assert.match(finalPromptText, /Schema: \{"kind":"final_answer","schemaVersion":1/);
  assert.match(finalPromptText, /\[Few-shot 示例\]/);

  assert.doesNotMatch(
    source,
    /const DEFAULT_PROMPT_SETTINGS = \{\s*version/,
    "dashboard must not keep a second prompt default object"
  );
  assert.match(source, /PromptRuntimePreview/, "dashboard exposes runtime prompt preview component");
}

function testPlannerDropsNonExecutableFinalReportToolTasks() {
  const normalized = planner.normalizePlan(
    {
      tasks: [
        {
          id: "report",
          title: "报告生成",
          type: "web_read",
          modelPool: "free",
          toolWorker: "web",
          prompt: "基于上游证据生成最终报告，不要编造数据。",
          input: "",
          successCriteria: ["生成最终报告"]
        },
        {
          id: "evidence",
          title: "读取公开来源",
          type: "web_read",
          modelPool: "free",
          toolWorker: "web",
          input: "https://open.example.test/data",
          successCriteria: ["URL/status/title/text evidence"]
        }
      ]
    },
    { maxTasks: 3 },
    [{ role: "user", content: "查询公开资料并写最终报告。" }],
    null
  );
  assert.deepEqual(
    normalized.tasks.map((task) => task.id),
    ["evidence"]
  );
  assert.equal(normalized.tasks[0].toolWorker, "web");
}

function testTaskAppenderDropsNonExecutableReviewSynthesisTasks() {
  reset();
  const goalId = "review-synthesis-prune-goal";
  const trace = [];
  const strategyEvents = [];
  const appendTasks = taskAppender.createTaskAppender({
    goalId,
    allTasks: [],
    knownTaskIds: new Set(),
    getGoalStrategy: () => ({
      id: "strategy-1",
      objective: "基于公开证据完成分析",
      riskPolicy: { requiresHumanApproval: ["human approval before external side effect"] }
    }),
    goalMemoryQuery: "",
    plannerMemory: "",
    trace,
    send: () => {},
    emitStrategy: (event, payload) => strategyEvents.push({ event, payload }),
    emitGraph: () => ({ readyTaskIds: [] }),
    taskSummary: (task) => task
  });

  const registered = appendTasks(
    [
      {
        id: "news",
        title: "搜索近期公开新闻",
        type: "web_search",
        toolWorker: "web",
        modelPool: "codex-cli",
        riskLevel: "medium",
        input: "recent public international news; central bank policy updates",
        successCriteria: ["URL/status/title/text evidence"]
      },
      {
        id: "report",
        title: "生成中文分析报告",
        type: "web_read",
        toolWorker: "web",
        modelPool: "free",
        input: "基于 news 的证据生成最终报告。",
        dependsOn: ["news"],
        successCriteria: ["生成最终报告"]
      }
    ],
    "review"
  );

  assert.deepEqual(
    registered.map((task) => task.id),
    ["news"]
  );
  assert.equal(registered[0].type, "web_search");
  assert.equal(registered[0].toolWorker, "web");
  assert.equal(registered[0].modelPool, "free");
  assert.equal(
    taskRuntime.listTasks(goalId).some((task) => task.type === "human_approval"),
    false
  );
  assert.ok(trace.some((item) => item.label === "synthesis-prune:review"));
  assert.ok(
    strategyEvents.some((item) =>
      (item.payload.violations || []).some((violation) => violation.code === "non_executable_synthesis_task")
    )
  );
}

function testTaskAppenderDropsDocumentGenerationWhenGoalForbidsFileChanges() {
  reset();
  const goalId = "read-only-report-document-prune-goal";
  const trace = [];
  const strategyEvents = [];
  const appendTasks = taskAppender.createTaskAppender({
    goalId,
    allTasks: [],
    knownTaskIds: new Set(),
    getGoalStrategy: () => null,
    goalMemoryQuery: "请只读查询公开信息并写一篇最终报告。不要修改任何文件。",
    plannerMemory: "",
    trace,
    send: () => {},
    emitStrategy: (event, payload) => strategyEvents.push({ event, payload }),
    emitGraph: () => ({ readyTaskIds: [] }),
    taskSummary: (task) => task
  });

  const registered = appendTasks(
    [
      {
        id: "report-file",
        title: "生成中文风险报告",
        type: "document_generate",
        toolWorker: "document",
        modelPool: "free",
        input: "基于已验证证据生成最终报告。",
        successCriteria: ["生成最终报告"]
      }
    ],
    "review"
  );

  assert.equal(registered.length, 0);
  assert.equal(taskRuntime.listTasks(goalId).length, 0);
  assert.ok(trace.some((item) => item.label === "synthesis-prune:review"));
  assert.ok(
    strategyEvents.some((item) =>
      (item.payload.violations || []).some(
        (violation) => violation.code === "document_generation_without_allowed_artifact_request"
      )
    )
  );
}

function testTaskAppenderAllowsScopedArtifactDocumentGeneration() {
  reset();
  const goalId = "scoped-artifact-document-goal";
  const trace = [];
  const appendTasks = taskAppender.createTaskAppender({
    goalId,
    allTasks: [],
    knownTaskIds: new Set(),
    getGoalStrategy: () => null,
    goalMemoryQuery:
      "请生成多个真实报告文件。允许在项目允许的 artifacts、output 或 tmp 目录中新建文件；不要修改源码、配置、README、docs 或已有测试文件。",
    plannerMemory: "",
    trace,
    send: () => {},
    emitStrategy: () => {},
    emitGraph: () => ({ readyTaskIds: [] }),
    taskSummary: (task) => task
  });

  const registered = appendTasks(
    [
      {
        id: "report-file",
        title: "生成本地报告文件",
        type: "document_generate",
        toolWorker: "document",
        modelPool: "free",
        input: "基于已验证证据生成报告文件，写入 artifacts/output/tmp。",
        successCriteria: ["生成真实报告文件"]
      }
    ],
    "review"
  );

  assert.deepEqual(
    registered.map((task) => task.id),
    ["report-file"]
  );
  assert.equal(taskRuntime.listTasks(goalId).length, 1);
  assert.equal(
    trace.some((item) => item.label === "synthesis-prune:review"),
    false
  );
}

function testTaskAppenderSplitsMultiUrlReadTasks() {
  reset();
  const goalId = "split-multi-url-read-goal";
  const trace = [];
  const appendTasks = taskAppender.createTaskAppender({
    goalId,
    allTasks: [],
    knownTaskIds: new Set(),
    getGoalStrategy: () => null,
    goalMemoryQuery: "",
    plannerMemory: "",
    trace,
    send: () => {},
    emitStrategy: () => {},
    emitGraph: () => ({ readyTaskIds: [] }),
    taskSummary: (task) => task
  });

  const registered = appendTasks(
    [
      {
        id: "multi-api",
        title: "读取多个公开 API",
        type: "api_read",
        toolWorker: "web",
        input: "https://api.example.test/latest?from=USD&to=JPY,EUR\nhttps://api.example.test/latest?from=EUR&to=JPY",
        successCriteria: ["HTTP status and response body"]
      }
    ],
    "review"
  );

  assert.deepEqual(
    registered.map((task) => task.id),
    ["multi-api", "multi-api-2"]
  );
  assert.deepEqual(
    registered.map((task) => task.input),
    ["https://api.example.test/latest?from=USD&to=JPY,EUR", "https://api.example.test/latest?from=EUR&to=JPY"]
  );
  assert.ok(trace.some((item) => item.label === "split-read:review"));
}

function testTaskAppenderDropsDuplicateReadSourceTasks() {
  reset();
  const goalId = "dedupe-duplicate-read-source-goal";
  const trace = [];
  const strategyEvents = [];
  const appendTasks = taskAppender.createTaskAppender({
    goalId,
    allTasks: [],
    knownTaskIds: new Set(),
    getGoalStrategy: () => null,
    goalMemoryQuery: "",
    plannerMemory: "",
    trace,
    send: () => {},
    emitStrategy: (event, payload) => strategyEvents.push({ event, payload }),
    emitGraph: () => ({ readyTaskIds: [] }),
    taskSummary: (task) => task
  });

  const first = appendTasks(
    [
      {
        id: "fx-api",
        title: "读取汇率 API",
        type: "api_read",
        toolWorker: "web",
        input: "https://open.example.test/latest/USD",
        successCriteria: ["HTTP status and response body"]
      }
    ],
    "review"
  );
  const second = appendTasks(
    [
      {
        id: "fx-api-again",
        title: "再次读取汇率 API",
        type: "api_read",
        toolWorker: "web",
        input: "https://open.example.test/latest/USD",
        successCriteria: ["HTTP status and response body"]
      }
    ],
    "review"
  );

  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(taskRuntime.listTasks(goalId).length, 1);
  assert.ok(trace.some((item) => item.label === "source-dedupe:review"));
  assert.ok(
    strategyEvents.some((item) =>
      (item.payload.violations || []).some((violation) => violation.code === "duplicate_source_task")
    )
  );
}

function testPlannerGivesToolTasksVerificationRetryWindow() {
  const normalizedPlan = planner.normalizePlan(
    {
      tasks: [
        {
          id: "web-evidence",
          title: "Search public evidence",
          type: "web_search",
          toolWorker: "web",
          modelPool: "free",
          input: "public evidence query",
          maxAttempts: 1
        },
        {
          id: "document-artifact",
          title: "Generate document artifact",
          type: "document_generate",
          toolWorker: "document",
          modelPool: "free",
          dependsOn: ["web-evidence"],
          maxAttempts: 1
        },
        {
          id: "analysis",
          title: "Analyze evidence",
          type: "analysis",
          modelPool: "strong",
          dependsOn: ["web-evidence"],
          maxAttempts: 1
        }
      ]
    },
    { maxTasks: 5 },
    [{ role: "user", content: "Search public evidence and generate one document artifact." }],
    null
  );
  const webTask = normalizedPlan.tasks.find((task) => task.id === "web-evidence");
  const documentTask = normalizedPlan.tasks.find((task) => task.id === "document-artifact");
  const analysisTask = normalizedPlan.tasks.find((task) => task.id === "analysis");
  assert.equal(webTask.maxAttempts, 2);
  assert.equal(documentTask.maxAttempts, 2);
  assert.equal(analysisTask.maxAttempts, 1);
}

function testCommanderJsonTokenBudgetsAreConfigurable() {
  assert.equal(tokenBudget.planMaxTokens({}, DEFAULT_CONFIG), 1600);
  assert.equal(tokenBudget.reviewMaxTokens({}, DEFAULT_CONFIG), 2600);
  assert.equal(tokenBudget.reviewMaxTokens({ reviewMaxTokens: 3200 }, DEFAULT_CONFIG), 3200);
  assert.equal(tokenBudget.reviewMaxTokens({ reviewMaxTokens: 9000 }, DEFAULT_CONFIG), 5000);
}

function testBrowserAutomationKeywordDoesNotForceLocalExecution() {
  assert.equal(
    planner.shouldUseCodexCliWorker([
      {
        role: "user",
        content: "职位信息：AI Agent 工程师，需要 Node.js、浏览器自动化、任务编排和可观测性经验。"
      }
    ]),
    false
  );
  assert.equal(
    planner.shouldUseCodexCliWorker([{ role: "user", content: "请打开网页 http://127.0.0.1:20128 并读取内容。" }]),
    true
  );
  assert.equal(
    planner.shouldUseCodexCliWorker([{ role: "user", content: "请打开这个安全 data URL 页面并读取正文。" }]),
    true
  );
  assert.equal(
    planner.shouldUseCodexCliWorker([
      {
        role: "user",
        content: "请联网搜索公开资料并获取详细证据。不要登录，不要提交，不要截图。"
      }
    ]),
    false,
    "read-only internet evidence must not trigger codex-cli through legacy search keywords"
  );
  assert.equal(
    browserWorker.shouldUseBrowserWorker({
      type: "local_execution",
      prompt: "打开 data:text/html;charset=utf-8,%3Chtml%3E%3Cbody%3Eok%3C%2Fbody%3E%3C%2Fhtml%3E 页面并读取正文。"
    }),
    true
  );
  assert.equal(
    browserWorker.shouldUseBrowserWorker({
      type: "planning",
      modelPool: "codex-cli",
      title: "Map the goal and success criteria",
      prompt: "目标里提到了 data:text/html;charset=utf-8,%3Chtml%3E%3Cbody%3Eok%3C%2Fbody%3E%3C%2Fhtml%3E 页面。"
    }),
    false
  );
}

function testPlannerKeepsMetaTasksOutOfCodexCli() {
  const plan = planner.normalizePlan(
    {
      tasks: [
        { id: "goal-map", title: "Map goal", type: "planning", modelPool: "codex-cli" },
        { id: "execute", title: "Read page", type: "local_execution", modelPool: "codex-cli" },
        { id: "verify", title: "Verify", type: "verification", modelPool: "codex-cli" }
      ]
    },
    { maxTasks: 5 },
    [{ role: "user", content: "请打开 data URL 页面并读取内容。" }],
    null
  );
  const byId = Object.fromEntries(plan.tasks.map((task) => [task.id, task]));
  assert.equal(byId["goal-map"].modelPool, "free");
  assert.equal(byId.execute.modelPool, "codex-cli");
  assert.equal(byId.verify.modelPool, "free");
}

function testBaselineBrowserPlanUsesLowRiskBrowserTask() {
  const plan = planner.baselinePlan([
    {
      role: "user",
      content: "请打开这个安全 data:text/html,<html><body>ok</body></html> 页面并读取正文。不要登录账号、不要提交表单。"
    }
  ]);
  const execute = plan.tasks.find((task) => task.id === "execute");
  assert.equal(execute.type, "browser");
  assert.equal(execute.modelPool, "codex-cli");
  assert.equal(execute.riskLevel, "low");
}

function testDanglingDependenciesArePrunedAfterConstraints() {
  const result = taskAppender.pruneDanglingDependencyTasks([
    { id: "goal-map", dependencies: [] },
    { id: "verify", dependencies: ["execute"] },
    { id: "final", dependencies: ["verify"] }
  ]);
  assert.deepEqual(
    result.tasks.map((task) => task.id),
    ["goal-map"]
  );
  assert.deepEqual(
    result.pruned.map((item) => item.task.id),
    ["verify", "final"]
  );
}

function testRedundantVerifiedEvidenceTasksArePruned() {
  const result = taskAppender.filterRedundantVerifiedTasks(
    [
      {
        id: "evidence-2",
        title: "重复收集公开证据批次",
        type: "web_search",
        prompt: "重新读取同一批公开来源。",
        produces: ["public_evidence_batch"]
      },
      {
        id: "report",
        title: "生成分析报告",
        type: "analysis"
      }
    ],
    [
      {
        id: "evidence-1",
        title: "收集公开证据批次",
        type: "web_search",
        produces: ["public_evidence_batch"],
        status: taskRuntime.TASK_STATUS.COMPLETED,
        verificationStatus: "verified"
      }
    ]
  );
  assert.deepEqual(
    result.tasks.map((task) => task.id),
    ["report"]
  );
  assert.deepEqual(
    result.pruned.map((item) => item.task.id),
    ["evidence-2"]
  );
}

function testRedundantEvidenceTasksArePrunedBeforeApprovalInsertion() {
  reset();
  const goalId = "dedupe-before-approval-goal";
  const allTasks = [
    {
      id: "evidence-1",
      title: "收集公开证据批次",
      type: "web_search",
      produces: ["public_evidence_batch"],
      status: taskRuntime.TASK_STATUS.COMPLETED,
      verificationStatus: "verified"
    }
  ];
  const trace = [];
  const strategyEvents = [];
  const appendTasks = taskAppender.createTaskAppender({
    goalId,
    allTasks,
    knownTaskIds: new Set(["evidence-1"]),
    getGoalStrategy: () => ({
      id: "strategy-1",
      objective: "生成分析报告",
      riskPolicy: { requiresHumanApproval: ["human approval before external side effect"] }
    }),
    goalMemoryQuery: "",
    plannerMemory: "",
    trace,
    send: () => {},
    emitStrategy: (event, payload) => strategyEvents.push({ event, payload }),
    emitGraph: () => ({ readyTaskIds: [] }),
    taskSummary: (task) => task
  });

  const registered = appendTasks(
    [
      {
        id: "evidence-2",
        title: "重复收集公开证据批次",
        type: "web_search",
        prompt: "重新读取同一批公开来源。",
        produces: ["public_evidence_batch"],
        requiresHumanApproval: true,
        requiresHumanConfirmation: true
      }
    ],
    "review"
  );

  assert.equal(registered.length, 0);
  assert.equal(
    taskRuntime.listTasks(goalId).some((task) => task.type === "human_approval"),
    false
  );
  assert.ok(trace.some((item) => item.label === "dedupe:review"));
  assert.ok(
    strategyEvents.some((item) =>
      (item.payload.violations || []).some((violation) => violation.code === "redundant_verified_evidence_task")
    )
  );
}

function testRedundantEvidenceDedupUsesLiveTaskState() {
  reset();
  const goalId = "dedupe-live-state-goal";
  taskRuntime.registerGoalTasks(
    goalId,
    [
      {
        id: "alpha",
        title: "收集 Alpha 公开证据",
        type: "web_search",
        produces: ["alpha_evidence"],
        status: taskRuntime.TASK_STATUS.COMPLETED,
        verificationStatus: "verified"
      },
      {
        id: "beta",
        title: "收集 Beta 公开证据",
        type: "web_search",
        produces: ["beta_evidence"],
        status: taskRuntime.TASK_STATUS.COMPLETED,
        verificationStatus: "verified"
      }
    ],
    { replace: true, source: "test" }
  );
  const staleAllTasks = [
    {
      id: "alpha",
      title: "收集 Alpha 公开证据",
      type: "web_search",
      produces: ["alpha_evidence"],
      status: taskRuntime.TASK_STATUS.RUNNING,
      verificationStatus: ""
    }
  ];
  const trace = [];
  const appendTasks = taskAppender.createTaskAppender({
    goalId,
    allTasks: staleAllTasks,
    knownTaskIds: new Set(["alpha", "beta"]),
    getGoalStrategy: () => ({
      id: "strategy-1",
      objective: "生成分析报告",
      riskPolicy: { requiresHumanApproval: ["human approval before external side effect"] }
    }),
    goalMemoryQuery: "",
    plannerMemory: "",
    trace,
    send: () => {},
    emitStrategy: () => {},
    emitGraph: () => ({ readyTaskIds: [] }),
    taskSummary: (task) => task
  });

  const registered = appendTasks(
    [
      {
        id: "combined-evidence",
        title: "重复收集 Alpha 与 Beta 公开证据",
        type: "web_search",
        prompt: "重新读取 Alpha 与 Beta 两类公开来源。",
        produces: ["alpha_evidence", "beta_evidence"],
        requiresHumanApproval: true,
        requiresHumanConfirmation: true
      }
    ],
    "review"
  );

  assert.equal(registered.length, 0);
  assert.equal(
    taskRuntime.listTasks(goalId).some((task) => task.type === "human_approval"),
    false
  );
  assert.ok(trace.some((item) => item.label === "dedupe:review"));
}

function testNegatedSideEffectsDoNotRequireApproval() {
  const safe = riskEngine.evaluateTaskRisk(
    {
      id: "analyze-job",
      title: "Analyze job text",
      type: "analysis",
      riskLevel: "low",
      input: "只分析职位文本。不要登录账号、不要提交表单、不要付款、不要发送真实消息。"
    },
    { phase: "before" }
  );
  assert.equal(safe.requiresHumanApproval, false);
  assert.equal(safe.riskLevel, "low");

  const risky = riskEngine.evaluateTaskRisk(
    {
      id: "submit-proposal",
      title: "Submit proposal",
      type: "browser",
      riskLevel: "high",
      input: "Click submit proposal on a live client page."
    },
    { phase: "before" }
  );
  assert.equal(risky.requiresHumanApproval, true);
  assert.equal(risky.riskLevel, "high");

  const observedBrowserAction = riskEngine.evaluateTaskRisk(
    {
      id: "observed-submit",
      title: "Browser action result",
      type: "browser",
      riskLevel: "low"
    },
    {
      phase: "after",
      workerResult: {
        status: "success",
        actions: [{ type: "browser_action", action: "click", label: "Submit proposal" }]
      }
    }
  );
  assert.equal(observedBrowserAction.requiresHumanApproval, true);
  assert.ok(["high", "critical"].includes(observedBrowserAction.riskLevel));
}

function testStrategyApprovalTasksAreNotInsertedByKeywordRules() {
  const expanded = dependencyEngine.expandStrategyApprovalTasks(
    [
      {
        id: "submit-proposal",
        title: "Submit proposal",
        type: "browser",
        modelPool: "codex-cli",
        prompt: "Submit proposal on a live client page."
      }
    ],
    { id: "strategy-1", objective: "完成目标", riskPolicy: { humanApproval: "required for proposal submit" } }
  );
  const downstream = expanded.tasks.find((task) => task.id === "submit-proposal");
  assert.deepEqual(expanded.inserted, []);
  assert.equal(
    expanded.tasks.some((task) => task.type === "human_approval"),
    false
  );
  assert.deepEqual(downstream.dependsOn || [], []);
}

function testReadOnlyWebSearchDoesNotInheritStrategyApprovalGate() {
  const expanded = dependencyEngine.expandStrategyApprovalTasks(
    [
      {
        id: "news",
        title: "搜索近期公开新闻",
        type: "web_search",
        toolWorker: "web",
        modelPool: "free",
        riskLevel: "medium",
        input: "只读搜索公开网页。不要登录、不要提交表单、不要付款、不要发送消息。"
      }
    ],
    { id: "strategy-1", objective: "完成公开研究", riskPolicy: { humanApproval: "required for external side effect" } }
  );
  assert.equal(
    expanded.tasks.some((task) => task.type === "human_approval"),
    false
  );
  assert.deepEqual(expanded.inserted, []);

  const compactNegation = dependencyEngine.expandStrategyApprovalTasks(
    [
      {
        id: "agent-research",
        title: "AI 编程 Agent 取证",
        type: "web_search",
        toolWorker: "web",
        modelPool: "free",
        riskLevel: "low",
        prompt: "搜索公开文档、发布说明和评测资料并筛选证据；只读，不登录不提交。"
      }
    ],
    { id: "strategy-1", objective: "完成公开研究", riskPolicy: { humanApproval: "required for external side effect" } }
  );
  assert.deepEqual(compactNegation.inserted, []);
  assert.equal(
    compactNegation.tasks.some((task) => task.type === "human_approval"),
    false
  );
}

function testModelCallMarkerAndEmptyBrowserEvidenceDoNotTriggerBrowserRisk() {
  const result = riskEngine.evaluateTaskRisk(
    {
      id: "summarize",
      title: "Summarize job text",
      type: "analysis",
      riskLevel: "low",
      input: "Summarize the provided job description."
    },
    {
      phase: "after",
      workerResult: {
        status: "failed",
        actions: ["called:free"],
        evidence: { browser: {} },
        output: "Internal model request failed: fetch failed"
      }
    }
  );
  assert.equal(result.requiresHumanApproval, false);
  assert.equal(
    result.riskSignals.some((signal) => signal.source === "browser_action"),
    false
  );
}

function testWebToolReadEvidenceDoesNotTriggerSubmitRisk() {
  const result = riskEngine.evaluateTaskRisk(
    {
      id: "web-search",
      title: "搜索最新日元兑美元汇率",
      type: "web_search",
      modelPool: "free",
      riskLevel: "low",
      input: "不要登录、不要提交表单、不要付款、不要发送消息。"
    },
    {
      phase: "after",
      workerResult: {
        status: "failure",
        model: "web-tool",
        actions: ["web:search"],
        output: "USD/JPY (USDJPY=X) Live Rate, Chart & News - Yahoo Finance. If error persists, email ops@example.com",
        evidence: {
          browser: {
            type: "browser",
            evidenceSource: "web-tool",
            action: "web_search",
            detectedActionType: "read_page",
            url: "https://duckduckgo.com/html/?q=USD%20JPY%20exchange%20rate",
            title: "DuckDuckGo",
            pageText:
              "USD/JPY (USDJPY=X) Live Rate, Chart & News - Yahoo Finance. If error persists, email ops@example.com"
          }
        }
      }
    }
  );
  assert.equal(result.requiresHumanApproval, false);
  assert.equal(result.riskLevel, "low");
  assert.equal(
    result.riskSignals.some((signal) => /submit data|send a real message/i.test(signal.reason)),
    false
  );
  assert.equal(
    result.riskSignals.some((signal) => /production, live, customer, or database/i.test(signal.reason)),
    false
  );
}

function testReadOnlyWebSearchLiveMarketQueryDoesNotTriggerProductionRisk() {
  const result = riskEngine.evaluateTaskRisk({
    id: "web-search-live-market",
    title: "Public market data search",
    type: "web_search",
    toolWorker: "web",
    riskLevel: "low",
    input: "USD/JPY forex rate live"
  });
  assert.equal(result.requiresHumanApproval, false);
  assert.equal(result.riskLevel, "low");
  assert.equal(
    result.riskSignals.some((signal) => /production, live, customer, or database/i.test(signal.reason)),
    false
  );
}

function testReadOnlyWebSearchVerificationToleratesPartialSourceFailures() {
  const verification = verificationEngine.verifyTaskResult(
    {
      id: "usd-jpy-search",
      title: "搜索最新日元兑美元汇率",
      type: "web_search",
      modelPool: "free",
      toolWorker: "web",
      riskLevel: "low",
      successCriteria: ["URL、HTTP status、页面标题或正文证据存在。"]
    },
    {
      status: "success",
      model: "web-tool",
      output: [
        "1. USD/JPY (USDJPY=X) Live Rate, Chart & News - Yahoo Finance",
        "https://finance.yahoo.com/quote/USDJPY=X/",
        "HTTP 503",
        "Evidence: Yahoo Will be right back...",
        "",
        "2. 【外汇汇率】_主要货币外汇行情与走势图_英为财情Investing.com",
        "https://cn.investing.com/currencies/streaming-forex-rates-majors",
        "HTTP 200",
        "Evidence: 美元/日元 实时行情 登录 免费注册 USD/JPY 156.20"
      ].join("\n"),
      evidence: {
        summary: "USD/JPY public web search returned one failed source and one usable source.",
        browser: {
          type: "browser",
          evidenceSource: "web-tool",
          action: "web_search",
          detectedActionType: "read_page",
          url: "https://finance.yahoo.com/quote/USDJPY=X/",
          title: "",
          pageText: "",
          errorMessage: "HTTP 503"
        },
        apiResponses: [
          {},
          { method: "GET", url: "https://duckduckgo.com/html/?q=USD%20JPY", status: 200, body: "results" },
          {
            method: "GET",
            url: "https://finance.yahoo.com/quote/USDJPY=X/",
            status: 200,
            ok: false,
            body: "USD/JPY Oops, something went wrong. Try again later."
          },
          {
            method: "GET",
            url: "https://finance.yahoo.com/quote/USDJPY=X/",
            status: 503,
            body: "Yahoo Will be right back"
          },
          {
            method: "GET",
            url: "https://cn.investing.com/currencies/streaming-forex-rates-majors",
            status: 200,
            body: "美元/日元 实时汇率行情 登录 免费注册 USD/JPY 156.20. If error persists, contact support."
          }
        ],
        browserEvidence: [
          {
            type: "browser",
            evidenceSource: "web-tool",
            action: "web_search",
            detectedActionType: "read_page",
            url: "https://finance.yahoo.com/quote/USDJPY=X/",
            title: "",
            pageText: "",
            error: "HTTP 503"
          },
          {
            type: "browser",
            evidenceSource: "web-tool",
            action: "web_search",
            detectedActionType: "read_page",
            url: "https://cn.investing.com/currencies/streaming-forex-rates-majors",
            title: "外汇汇率",
            pageText: "美元/日元 实时行情 登录 免费注册 USD/JPY 156.20"
          }
        ],
        semantic: {
          outputSummary: "USD/JPY evidence includes a usable Investing.com page.",
          addressesCriteria: true,
          criteriaCoverage: 0.8,
          qualityScore: 0.75
        }
      }
    },
    { phase: "after_worker", maxAttempts: 2 }
  );

  assert.notEqual(verification.verificationStatus, verificationEngine.VERIFICATION_STATUS.UNVERIFIED);
  assert.notEqual(verification.suggestedNextState, verificationEngine.SUGGESTED_NEXT_STATE.BLOCKED);
  assert.equal(
    verification.detectedIssues.some((issue) => /API response status was 503/i.test(issue.issue)),
    false
  );
  assert.equal(
    verification.detectedIssues.some((issue) => /error-like text|authenticity/i.test(issue.issue)),
    false
  );
  assert.equal(
    verification.detectedIssues.some((issue) => /API response body contains failure text/i.test(issue.issue)),
    false
  );
  assert.equal(
    verification.detectedIssues.some((issue) => /Expected file does not exist/i.test(issue.issue || "")),
    false
  );
}

function testReadOnlyWebSearchVerificationRejectsUnrelatedEvidence() {
  const verification = verificationEngine.verifyTaskResult(
    {
      id: "public-topic-search",
      title: "search alpha beta release notes",
      type: "web_search",
      modelPool: "free",
      toolWorker: "web",
      riskLevel: "low",
      input: "alpha beta release notes",
      successCriteria: ["URL、HTTP status、页面标题或正文证据存在。"]
    },
    {
      status: "success",
      model: "web-tool",
      output: [
        "Query: alpha beta release notes",
        "1. Dictionary page",
        "https://example.test/dictionary",
        "HTTP 200",
        "Evidence: common word definition and grammar examples."
      ].join("\n"),
      evidence: {
        summary: "Search returned an unrelated dictionary page.",
        apiResponses: [
          { method: "GET", url: "https://www.bing.com/search?q=alpha%20beta", status: 200, body: "search page" },
          {
            method: "GET",
            url: "https://example.test/dictionary",
            status: 200,
            body: "A common word definition with grammar examples and no product release notes."
          }
        ],
        semantic: {
          outputSummary: "Search returned a readable public page.",
          addressesCriteria: true,
          criteriaCoverage: 1,
          qualityScore: 0.9
        }
      },
      context: {
        model: "web-tool",
        url: "https://www.bing.com/search?q=alpha%20beta"
      }
    },
    { phase: "after_worker", maxAttempts: 2 }
  );

  assert.equal(verification.verificationStatus, verificationEngine.VERIFICATION_STATUS.UNVERIFIED);
  assert.notEqual(verification.suggestedNextState, verificationEngine.SUGGESTED_NEXT_STATE.COMPLETED);
  assert.ok(verification.detectedIssues.some((issue) => /unrelated|task query/i.test(issue.issue)));
}

function testWebSearchVerificationUsesNormalizedResultPageText() {
  const verification = verificationEngine.verifyTaskResult(
    {
      id: "public-release-search",
      title: "search alpha beta release notes latest",
      type: "web_search",
      modelPool: "free",
      toolWorker: "web",
      riskLevel: "low",
      input: "alpha beta release notes latest",
      successCriteria: ["URL、HTTP status、页面标题或正文证据存在。"]
    },
    {
      status: "success",
      model: "web-tool",
      output:
        "1. Alpha Beta release notes\nhttps://example.test/release\nHTTP 200\nEvidence: Alpha beta release notes latest version 2.0.",
      evidence: {
        summary: "Collected a readable public release page.",
        apiResponses: [
          {
            method: "GET",
            url: "https://example.test/release",
            status: 200,
            query: "alpha beta release notes latest",
            evidenceRole: "search_result_page",
            body: "<html><head><meta name='app' content='shell'></head><body><script>window.__DATA__={}</script></body></html>"
          }
        ],
        browserEvidence: [
          {
            type: "browser",
            evidenceSource: "web-tool",
            detectedActionType: "read_page",
            url: "https://example.test/release",
            status: 200,
            query: "alpha beta release notes latest",
            evidenceRole: "search_result_page",
            title: "Alpha Beta Release Notes",
            pageText: "Alpha beta release notes latest version 2.0 with fixes and public changelog details."
          }
        ],
        semantic: {
          outputSummary: "Collected a readable public release page.",
          addressesCriteria: true,
          criteriaCoverage: 0.8,
          qualityScore: 0.8
        }
      },
      context: { model: "web-tool", url: "https://www.bing.com/search?q=alpha%20beta" }
    },
    { phase: "after_worker", maxAttempts: 2 }
  );

  assert.notEqual(verification.verificationStatus, verificationEngine.VERIFICATION_STATUS.UNVERIFIED);
  assert.equal(
    verification.detectedIssues.some((issue) => /unrelated|task query/i.test(issue.issue)),
    false
  );
}

function testAlternativeWebSearchQueriesDoNotRequireEveryClause() {
  const verification = verificationEngine.verifyTaskResult(
    {
      id: "alternative-query-search",
      title: "Search public release evidence",
      type: "web_search",
      modelPool: "free",
      toolWorker: "web",
      riskLevel: "low",
      input: "alpha beta release notes; alpha beta changelog alias",
      prompt: "Use these candidate alternative queries for the same fact.",
      successCriteria: ["URL、HTTP status、页面标题或正文证据存在。"]
    },
    {
      status: "success",
      model: "web-tool",
      output: "Combined public search results.",
      evidence: {
        summary: "Alternative query search.",
        apiResponses: [
          {
            method: "GET",
            url: "https://example.test/release",
            status: 200,
            query: "alpha beta release notes",
            evidenceRole: "search_result_page",
            body: "Alpha beta release notes version 2.0 with fixes."
          },
          {
            method: "GET",
            url: "https://example.test/dictionary",
            status: 200,
            query: "alpha beta changelog alias",
            evidenceRole: "search_result_page",
            body: "A dictionary page with unrelated grammar examples."
          }
        ],
        semantic: {
          outputSummary: "Search returned readable public pages.",
          addressesCriteria: true,
          criteriaCoverage: 0.5,
          qualityScore: 0.7
        }
      },
      context: { model: "web-tool", url: "https://www.bing.com/search?q=alpha" }
    },
    { phase: "after_worker", maxAttempts: 2 }
  );

  assert.notEqual(verification.verificationStatus, verificationEngine.VERIFICATION_STATUS.UNVERIFIED);
  assert.equal(
    verification.detectedIssues.some((issue) => /alpha beta changelog alias|unrelated to query/i.test(issue.issue)),
    false
  );
}

function testSemicolonWebSearchDefaultsToSameFactAlternatives() {
  const verification = verificationEngine.verifyTaskResult(
    {
      id: "same-fact-query-search",
      title: "Search public quote evidence",
      type: "web_search",
      modelPool: "free",
      toolWorker: "web",
      riskLevel: "low",
      input: "alpha beta release notes; alpha beta changelog alias",
      successCriteria: ["URL/status/title/text evidence exists for the public quote."]
    },
    {
      status: "success",
      model: "web-tool",
      output: "Collected one readable candidate result.",
      evidence: {
        summary: "Candidate query search.",
        apiResponses: [
          {
            method: "GET",
            url: "https://example.test/release",
            status: 200,
            query: "alpha beta release notes",
            evidenceRole: "search_result_page",
            body: "Alpha beta release notes version 2.0 with fixes."
          }
        ],
        semantic: {
          outputSummary: "Search returned a readable public page.",
          addressesCriteria: true,
          criteriaCoverage: 0.8,
          qualityScore: 0.8
        }
      },
      context: { model: "web-tool", url: "https://www.bing.com/search?q=alpha" }
    },
    { phase: "after_worker", maxAttempts: 2 }
  );

  assert.notEqual(verification.verificationStatus, verificationEngine.VERIFICATION_STATUS.UNVERIFIED);
  assert.equal(
    verification.detectedIssues.some((issue) =>
      /alpha beta changelog alias|no readable result-page evidence/i.test(issue.issue)
    ),
    false
  );
}

function testWebSearchVerificationRejectsMismatchedWorkerQueryForAlternatives() {
  const verification = verificationEngine.verifyTaskResult(
    {
      id: "alternative-query-search",
      title: "Search public release evidence",
      type: "web_search",
      modelPool: "free",
      toolWorker: "web",
      riskLevel: "low",
      input: "alpha beta release notes; gamma delta changelog",
      successCriteria: ["URL、HTTP status、页面标题或正文证据存在。"]
    },
    {
      status: "success",
      model: "web-tool",
      output: "Search returned readable pages unrelated to the declared alternatives.",
      evidence: {
        summary: "Search used a malformed broad prompt query.",
        apiResponses: [
          {
            method: "GET",
            url: "https://example.test/account-help",
            status: 200,
            query: "please search the following candidates and return evidence",
            evidenceRole: "search_result_page",
            body: "Verify your account, enable video uploads, and manage settings."
          }
        ],
        semantic: {
          outputSummary: "Search returned a readable public page.",
          addressesCriteria: true,
          criteriaCoverage: 1,
          qualityScore: 0.9
        }
      },
      context: { model: "web-tool", url: "https://www.bing.com/search?q=please%20search" }
    },
    { phase: "after_worker", maxAttempts: 2 }
  );

  assert.equal(verification.verificationStatus, verificationEngine.VERIFICATION_STATUS.UNVERIFIED);
  assert.ok(
    verification.detectedIssues.some((issue) =>
      /no readable result-page evidence|unrelated|task query/i.test(issue.issue)
    )
  );
}

function testDistinctMultiQueryWebSearchRequiresEveryClause() {
  const verification = verificationEngine.verifyTaskResult(
    {
      id: "distinct-data-search",
      title: "Search two independent public data points",
      type: "web_search",
      modelPool: "free",
      toolWorker: "web",
      riskLevel: "low",
      input: "alpha beta release notes; gamma delta changelog",
      successCriteria: ["Both public data points have URL/status/title/text evidence."]
    },
    {
      status: "success",
      model: "web-tool",
      output: "Only one data point was found.",
      evidence: {
        summary: "One query search.",
        apiResponses: [
          {
            method: "GET",
            url: "https://example.test/alpha",
            status: 200,
            query: "alpha beta release notes",
            evidenceRole: "search_result_page",
            body: "Alpha beta release notes version 2.0 with fixes."
          }
        ],
        semantic: {
          outputSummary: "Search returned one readable public page.",
          addressesCriteria: true,
          criteriaCoverage: 0.5,
          qualityScore: 0.7
        }
      },
      context: { model: "web-tool", url: "https://www.bing.com/search?q=alpha" }
    },
    { phase: "after_worker", maxAttempts: 2 }
  );

  assert.equal(verification.verificationStatus, verificationEngine.VERIFICATION_STATUS.UNVERIFIED);
  assert.ok(verification.detectedIssues.some((issue) => /gamma delta changelog|no readable/i.test(issue.issue)));
}

function testReadOnlyWebReadRejectsGenericErrorShell() {
  const verification = verificationEngine.verifyTaskResult(
    {
      id: "web-read-error-shell",
      title: "Read public data page",
      type: "web_read",
      modelPool: "free",
      toolWorker: "web",
      riskLevel: "low",
      input: "https://example.test/data",
      successCriteria: ["URL、HTTP status、页面标题或正文证据存在。"]
    },
    {
      status: "success",
      model: "web-tool",
      output:
        "URL: https://example.test/data\nHTTP: 200\nTitle: Public Data\nText: Public Data Oops, something went wrong. Try again later. Navigation links only.",
      evidence: {
        summary: "Public Data Oops, something went wrong. Try again later.",
        apiResponses: [
          {
            method: "GET",
            url: "https://example.test/data",
            status: 200,
            body: "Public Data Oops, something went wrong. Try again later. Navigation links only."
          }
        ],
        browserEvidence: [
          {
            type: "browser",
            evidenceSource: "web-tool",
            detectedActionType: "read_page",
            url: "https://example.test/data",
            status: 200,
            title: "Public Data",
            pageText: "Public Data Oops, something went wrong. Try again later. Navigation links only."
          }
        ],
        semantic: {
          outputSummary: "Public Data Oops, something went wrong. Try again later.",
          addressesCriteria: true,
          criteriaCoverage: 0.8,
          qualityScore: 0.75
        }
      },
      context: { model: "web-tool", url: "https://example.test/data" }
    },
    { phase: "after_worker", maxAttempts: 2 }
  );

  assert.equal(verification.verificationStatus, verificationEngine.VERIFICATION_STATUS.UNVERIFIED);
  assert.ok(verification.detectedIssues.some((issue) => /error|failure|something went wrong/i.test(issue.issue)));
}

function testReadOnlyWebReadRejectsPlaceholderMarketData() {
  const verification = verificationEngine.verifyTaskResult(
    {
      id: "jgb-yield-read",
      title: "读取日本10年期国债收益率页面",
      type: "web_read",
      modelPool: "free",
      toolWorker: "web",
      riskLevel: "low",
      input: "https://www.worldgovernmentbonds.com/country/japan/",
      successCriteria: ["返回可验证的日本10年期国债收益率数值、URL、HTTP status 和页面文本。"]
    },
    {
      status: "success",
      model: "web-tool",
      output:
        "URL: https://www.worldgovernmentbonds.com/country/japan/ HTTP: 200 Title: Japan Government Bonds - Yields Curve Text: Japan 10-Year Government Bond currently offers a yield of -.--- %. Central Bank Rate : ---- %",
      evidence: {
        summary: "Japan government bond page loaded with placeholder yield values.",
        apiResponses: [
          {
            method: "GET",
            url: "https://www.worldgovernmentbonds.com/country/japan/",
            status: 200,
            body: "Japan Government Bonds - Yields Curve Last Update: -- --- ----, --:-- GMT+0 10-Year Gov.Bond Yield : -.--- % Spread vs 2-Year Bond : ---.-- bp Central Bank Rate : ---- %"
          }
        ],
        semantic: {
          outputSummary: "Page loaded but market data fields are placeholders.",
          addressesCriteria: true,
          criteriaCoverage: 0.8,
          qualityScore: 0.75
        }
      },
      context: { model: "web-tool", url: "https://www.worldgovernmentbonds.com/country/japan/" }
    },
    { phase: "after_worker", maxAttempts: 2 }
  );

  assert.equal(verification.verificationStatus, verificationEngine.VERIFICATION_STATUS.UNVERIFIED);
  assert.ok(verification.detectedIssues.some((issue) => /placeholder market data/i.test(issue.issue)));
}

function testMultiQueryWebSearchVerificationRejectsUnrelatedClauseEvidence() {
  const verification = verificationEngine.verifyTaskResult(
    {
      id: "multi-query-search",
      title: "Search public release evidence",
      type: "web_search",
      modelPool: "free",
      toolWorker: "web",
      riskLevel: "low",
      input: "alpha beta release notes; gamma delta changelog",
      successCriteria: ["Each query has readable URL/status/title/text evidence."]
    },
    {
      status: "success",
      model: "web-tool",
      output: "Combined public search results.",
      evidence: {
        summary: "Two query search.",
        apiResponses: [
          {
            method: "GET",
            url: "https://example.test/alpha",
            status: 200,
            query: "alpha beta release notes",
            evidenceRole: "search_result_page",
            body: "Alpha beta release notes version 2.0 with fixes."
          },
          {
            method: "GET",
            url: "https://example.test/dictionary",
            status: 200,
            query: "gamma delta changelog",
            evidenceRole: "search_result_page",
            body: "A dictionary page with unrelated grammar examples."
          }
        ],
        semantic: {
          outputSummary: "Search returned readable public pages.",
          addressesCriteria: true,
          criteriaCoverage: 1,
          qualityScore: 0.9
        }
      },
      context: { model: "web-tool", url: "https://www.bing.com/search?q=alpha" }
    },
    { phase: "after_worker", maxAttempts: 2 }
  );

  assert.equal(verification.verificationStatus, verificationEngine.VERIFICATION_STATUS.UNVERIFIED);
  assert.ok(verification.detectedIssues.some((issue) => /gamma delta changelog|unrelated to query/i.test(issue.issue)));
}

function testReadOnlyWebSearchVerificationMatchesMixedCjkNumericEvidence() {
  const verification = verificationEngine.verifyTaskResult(
    {
      id: "public-report-search",
      title: "城市2026年度空气质量报告",
      type: "web_search",
      modelPool: "free",
      toolWorker: "web",
      riskLevel: "low",
      input: "城市2026年度空气质量报告",
      successCriteria: ["URL、HTTP status、页面标题或正文证据存在。"]
    },
    {
      status: "success",
      model: "web-tool",
      output:
        "1. 城市2026年度环境空气质量监测报告\nhttps://example.test/report\nHTTP 200\nEvidence: 城市2026年度环境空气质量监测报告正文。",
      evidence: {
        summary: "Collected a readable public report page.",
        apiResponses: [
          { method: "GET", url: "https://www.bing.com/search?q=city-report", status: 200, body: "search page" },
          {
            method: "GET",
            url: "https://example.test/report",
            status: 200,
            body: "城市2026年度环境空气质量监测报告正文，包含监测范围、发布时间和数据表。"
          }
        ],
        semantic: {
          outputSummary: "Collected a readable public report page.",
          addressesCriteria: true,
          criteriaCoverage: 0.8,
          qualityScore: 0.75
        }
      },
      context: {
        model: "web-tool",
        url: "https://www.bing.com/search?q=city-report"
      }
    },
    { phase: "after_worker", maxAttempts: 2 }
  );

  assert.notEqual(verification.verificationStatus, verificationEngine.VERIFICATION_STATUS.UNVERIFIED);
  assert.equal(
    verification.detectedIssues.some((issue) => /unrelated|task query/i.test(issue.issue)),
    false
  );
}

function testInteractiveRunsDoNotTriggerUnattendedNightEscalation() {
  const result = riskEngine.evaluateTaskRisk(
    {
      id: "medium-analysis",
      title: "Analyze public page evidence",
      type: "analysis",
      riskLevel: "medium",
      input: "Analyze public text."
    },
    {
      phase: "before",
      runElapsedMs: 60_000,
      localHour: 1,
      userInitiated: true
    }
  );
  assert.equal(result.riskLevel, "medium");
  assert.equal(result.riskReasons.includes("High-impact work is running during likely unattended hours."), false);
}

async function testDeepSeekReasoningContentIsParsedAsModelContent() {
  const response = new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: "",
            reasoning_content: '```json\n{"tasks":[{"id":"read","title":"Read page"}]}\n```'
          }
        }
      ]
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
  const parsed = await contentUtils.parseModelResponse(response);
  assert.match(parsed.content, /"tasks"/);
}

function testModelSummaryWithoutEvidenceStaysUnverified() {
  const workerResult = resultNormalizer.makeWorkerRuntimeResult(
    {
      ok: true,
      model: "deepseek/deepseek-chat",
      content: "这是一个包含 AgentRoute 验证层、风险控制和预算控制说明的页面摘要。"
    },
    { id: "generate-summary", type: "analysis", modelPool: "free" }
  );
  const verification = verificationEngine.verifyTaskResult(
    { id: "generate-summary", type: "analysis", title: "生成摘要", successCriteria: ["输出页面摘要"] },
    workerResult,
    { phase: "after_worker", maxAttempts: 2 }
  );
  assert.equal(
    verification.detectedIssues.some((issue) => /exit code/i.test(issue.issue)),
    false
  );
  assert.equal(
    verification.detectedIssues.some((issue) => /standardized evidence/i.test(issue.issue)),
    true
  );
  assert.equal(verification.verificationStatus, verificationEngine.VERIFICATION_STATUS.UNVERIFIED);
  assert.notEqual(verification.suggestedNextState, verificationEngine.SUGGESTED_NEXT_STATE.COMPLETED);
}

function testArrayEvidenceIsTreatedAsModelClaims() {
  const workerResult = resultNormalizer.makeWorkerRuntimeResult(
    {
      ok: true,
      model: "deepseek/deepseek-chat",
      content: JSON.stringify({
        status: "success",
        actions: ["analyze_user_goal"],
        output: "目标和验收标准已经明确：打开 data URL、读取页面正文、生成摘要，并用浏览器证据验证。",
        evidence: []
      })
    },
    { id: "goal-map", type: "planning", modelPool: "free" }
  );
  assert.equal(workerResult.evidence.provided, false);
  const verification = verificationEngine.verifyTaskResult(
    { id: "goal-map", type: "planning", title: "Map goal", successCriteria: ["目标和验收标准已经明确"] },
    workerResult,
    { phase: "after_worker", maxAttempts: 2 }
  );
  assert.equal(
    verification.detectedIssues.some((issue) => /standardized evidence/i.test(issue.issue)),
    true
  );
  assert.equal(verification.verificationStatus, verificationEngine.VERIFICATION_STATUS.UNVERIFIED);
}

function testSemanticOnlyEvidenceIsTreatedAsModelClaim() {
  const workerResult = resultNormalizer.makeWorkerRuntimeResult(
    {
      ok: true,
      model: "deepseek/deepseek-chat",
      content: JSON.stringify({
        status: "success",
        actions: ["summarize"],
        output: "已经完成摘要，覆盖了目标驱动、风险控制、验证和预算。",
        evidence: {
          summary: "摘要已经完成。",
          semantic: {
            outputSummary: "摘要已经完成。",
            addressesCriteria: true,
            criteriaCoverage: 1,
            qualityScore: 1
          }
        }
      })
    },
    { id: "semantic-only", type: "analysis", modelPool: "free" }
  );
  assert.equal(workerResult.evidence.provided, false);
  const verification = verificationEngine.verifyTaskResult(
    { id: "semantic-only", type: "analysis", title: "生成摘要", successCriteria: ["覆盖目标驱动和风险控制"] },
    workerResult,
    { phase: "after_worker", maxAttempts: 2 }
  );
  assert.equal(verification.verificationStatus, verificationEngine.VERIFICATION_STATUS.UNVERIFIED);
  assert.notEqual(verification.suggestedNextState, verificationEngine.SUGGESTED_NEXT_STATE.COMPLETED);
}

function testVerifierModelIsSkippedForPlanningMetaTasks() {
  assert.equal(
    verificationEngine.shouldUseVerifierModel(
      { id: "goal-map", type: "planning", title: "Map goal" },
      {
        status: "success",
        output: "目标和验收标准已经明确。",
        evidence: { provided: true, semantic: { outputSummary: "目标和验收标准已经明确。" } }
      },
      { verificationStatus: "partially_verified", confidence: 0.84, suggestedNextState: "completed" }
    ),
    false
  );
}

function testPartialFinalWithFailedEvidenceDoesNotMarkGoalCompleted() {
  const finalStatus = orchestratorRuntime.finalGoalStatusFromTasks("部分完成：关键数据缺失，未取得可验证来源。", [
    { id: "fx", type: "web_read", status: "completed", verificationStatus: "verified" },
    { id: "news", type: "web_search", status: "failed", verificationStatus: "unverified" }
  ]);
  assert.equal(finalStatus.status, "blocked");
  assert.match(finalStatus.blockedReason, /incomplete required evidence/i);
  assert.equal(
    orchestratorRuntime.finalGoalStatusFromTasks("All requested evidence was verified and the result is complete.", [
      { id: "fx", type: "web_read", status: "completed", verificationStatus: "verified" }
    ]).status,
    "completed"
  );
}

function testFinalIsBlockedUntilPlannedTasksReachTerminalState() {
  const blocked = orchestratorRuntime.finalBlockedByUnresolvedPlannedTasks([
    { id: "plan", internal: true, status: "waiting" },
    { id: "collect-weather", type: "web_search", toolWorker: "web", status: "completed" },
    { id: "collect-news", type: "web_search", toolWorker: "web", status: "waiting", title: "收集新闻证据" }
  ]);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.tasks.map((task) => task.id).join(","), "collect-news");
  assert.match(blocked.message, /未进入终态/);
  assert.equal(
    orchestratorRuntime.finalBlockedByUnresolvedPlannedTasks([
      { id: "collect-weather", type: "web_search", toolWorker: "web", status: "completed" },
      { id: "collect-news", type: "web_search", toolWorker: "web", status: "failed" }
    ]).blocked,
    false
  );
  assert.equal(
    orchestratorRuntime.finalBlockedByUnresolvedPlannedTasks([
      { id: "collect-weather", type: "web_search", toolWorker: "web", status: "completed" },
      {
        id: "broad-search",
        type: "web_search",
        toolWorker: "web",
        status: "needs_evidence",
        attempts: 2,
        maxAttempts: 2,
        result: "Returned unrelated pages.",
        verificationStatus: "unverified"
      }
    ]).blocked,
    false,
    "exhausted evidence-gap tasks have been observed and should not block final by themselves"
  );
  assert.equal(
    orchestratorRuntime.finalBlockedByUnresolvedPlannedTasks([
      {
        id: "retry-search",
        type: "web_search",
        toolWorker: "web",
        status: "needs_evidence",
        attempts: 1,
        maxAttempts: 2,
        result: "Missing required evidence.",
        verificationStatus: "unverified"
      }
    ]).blocked,
    true,
    "needs_evidence tasks with remaining attempts are still actionable"
  );
  assert.equal(
    orchestratorRuntime.finalGoalStatusFromTasks("部分完成：关键数据未取得，证据不足。", [
      {
        id: "broad-search",
        type: "web_search",
        status: "needs_evidence",
        attempts: 2,
        maxAttempts: 2,
        result: "Returned unrelated pages.",
        verificationStatus: "unverified"
      }
    ]).status,
    "blocked",
    "explicitly partial finals with exhausted evidence gaps should keep the goal blocked"
  );
}

async function main() {
  testInternetResearchIsRoutedToAgentToolWorker();
  testFinanceResearchPlanKeepsPlannerTasksAsWebEvidence();
  testWebToolWorkerSplitsMultiMetricInputIntoQueries();
  testWebToolWorkerPreservesBooleanSearchSyntax();
  testWebToolWorkerLimitsMultiQueryResultReads();
  testWebToolWorkerRemovesGenericSearchCommandPrefixes();
  testWebToolWorkerUsesQuotedPromptQueriesWhenInputMissing();
  testReadOnlyNewsMetadataDoesNotForceCodexCli();
  testReadOnlyPublicUrlBrowserTaskIsRoutedToWebTool();
  testReadOnlyUrlWithTypeQueryParamDoesNotForceBrowserWorker();
  testNewsSearchUsesPlannerInputClauses();
  await testWebEvidenceReviewAndFinalStayOnCommanderModels();
  await testWebEvidenceProgressReviewStaysOnCommanderModels();
  testWorkerEvidenceCompactionPreservesStructuredRows();
  testReviewSourceDiagnosticsGuideGenericDiscovery();
  testReviewPromptIncludesVerifiedEvidenceInventoryFromPlan();
  testAgentPromptsCarryRuntimeTemporalContext();
  testPlannerRejectsRepeatedIdenticalJsonDocuments();
  testPlannerRejectsDifferentConcatenatedJsonDocuments();
  await testWebToolWorkerCollectsEvidenceWithoutModel();
  await testWebToolWorkerReadsMultipleAgentProvidedUrls();
  await testPlanningFailureDoesNotEmitSuccessfulFinal();
  await testInvalidWebPlanFailsWithoutRulePlanner();
  await testProviderCreditLimitRetriesWithLowerMaxTokens();
  await testModelCallProgressEventsExposeAttemptsAndFailover();
  await testModelCallDoesNotRetryConnectionFailure();
  await testModelCallDoesNotRetryInvalidStructuredOutput();
  await testStructuredOutputErrorExplainsMultipleJsonDocuments();
  await testToolWorkerRetriesTransientFailuresOnly();
  await testModelCallProgressEventsExposeTimeout();
  testAnalysisWorkerReceivesUpstreamEvidence();
  testCommanderPromptsSeparatePlanningFromExecution();
  testPlannerDropsNonExecutableFinalReportToolTasks();
  testTaskAppenderDropsNonExecutableReviewSynthesisTasks();
  testTaskAppenderDropsDocumentGenerationWhenGoalForbidsFileChanges();
  testTaskAppenderAllowsScopedArtifactDocumentGeneration();
  testTaskAppenderSplitsMultiUrlReadTasks();
  testTaskAppenderDropsDuplicateReadSourceTasks();
  testPlannerGivesToolTasksVerificationRetryWindow();
  testCommanderJsonTokenBudgetsAreConfigurable();
  testBrowserAutomationKeywordDoesNotForceLocalExecution();
  testPlannerKeepsMetaTasksOutOfCodexCli();
  testBaselineBrowserPlanUsesLowRiskBrowserTask();
  testDanglingDependenciesArePrunedAfterConstraints();
  testRedundantVerifiedEvidenceTasksArePruned();
  testRedundantEvidenceTasksArePrunedBeforeApprovalInsertion();
  testRedundantEvidenceDedupUsesLiveTaskState();
  testNegatedSideEffectsDoNotRequireApproval();
  testStrategyApprovalTasksAreNotInsertedByKeywordRules();
  testReadOnlyWebSearchDoesNotInheritStrategyApprovalGate();
  testModelCallMarkerAndEmptyBrowserEvidenceDoNotTriggerBrowserRisk();
  testWebToolReadEvidenceDoesNotTriggerSubmitRisk();
  testReadOnlyWebSearchLiveMarketQueryDoesNotTriggerProductionRisk();
  testReadOnlyWebSearchVerificationToleratesPartialSourceFailures();
  testReadOnlyWebSearchVerificationRejectsUnrelatedEvidence();
  testWebSearchVerificationUsesNormalizedResultPageText();
  testAlternativeWebSearchQueriesDoNotRequireEveryClause();
  testSemicolonWebSearchDefaultsToSameFactAlternatives();
  testWebSearchVerificationRejectsMismatchedWorkerQueryForAlternatives();
  testDistinctMultiQueryWebSearchRequiresEveryClause();
  testReadOnlyWebReadRejectsGenericErrorShell();
  testReadOnlyWebReadRejectsPlaceholderMarketData();
  testMultiQueryWebSearchVerificationRejectsUnrelatedClauseEvidence();
  testReadOnlyWebSearchVerificationMatchesMixedCjkNumericEvidence();
  testInteractiveRunsDoNotTriggerUnattendedNightEscalation();
  await testDeepSeekReasoningContentIsParsedAsModelContent();
  testModelSummaryWithoutEvidenceStaysUnverified();
  testArrayEvidenceIsTreatedAsModelClaims();
  testSemanticOnlyEvidenceIsTreatedAsModelClaim();
  testVerifierModelIsSkippedForPlanningMetaTasks();
  testPartialFinalWithFailedEvidenceDoesNotMarkGoalCompleted();
  testFinalIsBlockedUntilPlannedTasksReachTerminalState();
  console.log("agent orchestration tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
