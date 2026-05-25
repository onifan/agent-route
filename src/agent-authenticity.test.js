"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-authenticity-"));
process.env.AGENT_ROUTE_HOME = testRoot;
process.env.AGENT_ROUTE_TASKS = path.join(testRoot, "tasks.json");
process.env.AGENT_ROUTE_OBSERVABILITY = path.join(testRoot, "observability.json");
process.env.AGENT_ROUTE_BUDGET_RECORDS = path.join(testRoot, "budget-records.json");

const verification = require("./agent/verification");
const taskRuntime = require("./agent/tasks");
const actionApi = require("./agent/orchestrator/action-api");

function listTask() {
  return {
    id: "project-list",
    title: "搜索5个自由职业项目并整理结果",
    type: "research",
    modelPool: "free",
    successCriteria: ["5 个项目", "标题", "预算", "链接"],
    attempts: 0,
    maxAttempts: 2
  };
}

function workerResult(output) {
  return {
    status: "success",
    output,
    actions: ["search projects"],
    evidence: {
      provided: true,
      summary: "Structured project list.",
      semantic: {
        outputSummary: output,
        addressesCriteria: true,
        criteriaCoverage: 1,
        qualityScore: 0.95
      }
    }
  };
}

function verifyList(output) {
  return verification.verifyTaskResult(listTask(), workerResult(output), { cwd: testRoot });
}

function testNormalListLooksAuthentic() {
  const result = verifyList(
    [
      "1. Python 自动化报表脚本 · $120 fixed · https://jobs.test/python-reporting",
      "2. API 数据同步工具 · $25/hr · https://jobs.test/api-sync",
      "3. 浏览器数据提取流程 · $200 fixed · https://jobs.test/browser-extract",
      "4. CSV 清洗与仪表盘 · $150 fixed · https://jobs.test/csv-dashboard",
      "5. 定时邮件摘要机器人 · $30/hr · https://jobs.test/email-summary"
    ].join("\n")
  );
  assert.ok(result.authenticityScore >= 0.85);
  assert.deepEqual(result.authenticityWarnings, []);
  assert.equal(result.suggestedNextState, verification.SUGGESTED_NEXT_STATE.COMPLETED);
  assert.equal(result.decisionSource, "verification");
}

function testDuplicateProjectsAreSuspicious() {
  const result = verifyList(
    [
      "1. Python 自动化报表脚本 · $120 fixed · https://jobs.test/python-reporting",
      "2. Python 自动化报表脚本 · $120 fixed · https://jobs.test/python-reporting",
      "3. Python 自动化报表脚本 · $120 fixed · https://jobs.test/python-reporting",
      "4. Python 自动化报表脚本 · $120 fixed · https://jobs.test/python-reporting",
      "5. Python 自动化报表脚本 · $120 fixed · https://jobs.test/python-reporting"
    ].join("\n")
  );
  assert.ok(result.authenticityScore < 0.7);
  assert.ok(result.authenticityWarnings.some((warning) => /duplicate/i.test(warning)));
  assert.notEqual(result.suggestedNextState, verification.SUGGESTED_NEXT_STATE.COMPLETED);
  assert.equal(result.decisionSource, "authenticity");
}

function testEmptyLinksAreSuspicious() {
  const result = verifyList(
    [
      "1. Python 自动化报表脚本 · $120 fixed",
      "2. API 数据同步工具 · $25/hr",
      "3. 浏览器数据提取流程 · $200 fixed",
      "4. CSV 清洗与仪表盘 · $150 fixed",
      "5. 定时邮件摘要机器人 · $30/hr"
    ].join("\n")
  );
  assert.ok(result.authenticityScore < 0.7);
  assert.ok(result.authenticityWarnings.some((warning) => /links/i.test(warning)));
  assert.notEqual(result.suggestedNextState, verification.SUGGESTED_NEXT_STATE.COMPLETED);
}

function testEmptyTitlesAreSuspicious() {
  const result = verifyList(
    [
      "1.  · $120 fixed · https://jobs.test/1",
      "2.  · $25/hr · https://jobs.test/2",
      "3.  · $200 fixed · https://jobs.test/3",
      "4.  · $150 fixed · https://jobs.test/4",
      "5.  · $30/hr · https://jobs.test/5"
    ].join("\n")
  );
  assert.ok(result.authenticityScore < 0.7);
  assert.ok(result.authenticityWarnings.some((warning) => /titles/i.test(warning)));
  assert.notEqual(result.suggestedNextState, verification.SUGGESTED_NEXT_STATE.COMPLETED);
}

function testPlaceholderTextCanBlockFalseSuccess() {
  const result = verifyList(
    [
      "1. TBD · $0 · https://jobs.test/placeholder",
      "2. TBD · $0 · https://jobs.test/placeholder",
      "3. TBD · $0 · https://jobs.test/placeholder",
      "4. TBD · $0 · https://jobs.test/placeholder",
      "5. TBD · $0 · https://jobs.test/placeholder"
    ].join("\n")
  );
  assert.ok(result.authenticityScore < 0.35);
  assert.equal(result.suggestedNextState, verification.SUGGESTED_NEXT_STATE.BLOCKED);
  assert.equal(result.decisionSource, "authenticity");
  assert.ok(result.detectedIssues.some((issue) => /Authenticity check/i.test(issue.issue)));
}

function testEmptyResultIsHighlySuspicious() {
  const result = verification.verifyTaskResult(
    {
      id: "empty-result",
      title: "总结网页内容",
      type: "analysis",
      successCriteria: ["摘要不能为空"],
      attempts: 0,
      maxAttempts: 1
    },
    {
      status: "success",
      output: "",
      evidence: { provided: true, summary: "" }
    },
    { cwd: testRoot }
  );
  assert.ok(result.authenticityScore < 0.35);
  assert.equal(result.decisionSource, "authenticity");
  assert.equal(result.suggestedNextState, verification.SUGGESTED_NEXT_STATE.BLOCKED);
}

function testProposalAuthenticity() {
  const generic = verification.verifyTaskResult(
    {
      id: "proposal",
      title: "生成 proposal 草稿",
      type: "content_draft",
      successCriteria: ["草稿文本", "项目理解", "实施方案"],
      attempts: 0,
      maxAttempts: 1
    },
    workerResult("Dear client, I am excited to apply. I can do this project. Please contact me."),
    { cwd: testRoot }
  );
  assert.ok(generic.authenticityScore < 0.7);
  assert.notEqual(generic.suggestedNextState, verification.SUGGESTED_NEXT_STATE.COMPLETED);

  const specific = verification.verifyTaskResult(
    {
      id: "proposal",
      title: "生成 proposal 草稿",
      type: "content_draft",
      successCriteria: ["草稿文本", "项目理解", "实施方案"],
      attempts: 0,
      maxAttempts: 1
    },
    workerResult(
      "你好，我看了你的 CSV 自动化需求。我可以用 Python 实现读取 CSV、清洗异常行、生成 Markdown 每日摘要的流程，并附带运行说明。我会先确认样例数据、异常规则和摘要格式，再交付一个小版本验证。请人工检查后再决定是否发送。"
    ),
    { cwd: testRoot }
  );
  assert.ok(specific.authenticityScore >= 0.7);
}

function testWebEvidenceDoesNotUseProposalAuthenticity() {
  const result = verification.verifyTaskResult(
    {
      id: "news-read",
      title: "读取公开新闻页面",
      type: "web_read",
      successCriteria: ["新闻标题", "URL", "摘要"],
      attempts: 0,
      maxAttempts: 1
    },
    {
      status: "success",
      output:
        "URL: https://news.example.test/markets HTTP 200 Title: Markets News Text: Japan bond yields rose. Federal Reserve officials discussed inflation. Sign In Free Sign Up.",
      actions: ["web:fetch"],
      evidence: {
        provided: true,
        browser: {
          currentUrl: "https://news.example.test/markets",
          pageText:
            "Markets News. Japan bond yields rose. Federal Reserve officials discussed inflation. Sign In Free Sign Up."
        },
        apiResponses: [{ url: "https://news.example.test/markets", status: 200, body: "Markets News" }],
        semantic: {
          outputSummary: "Public news page text was read.",
          addressesCriteria: true,
          criteriaCoverage: 0.9,
          qualityScore: 0.9
        }
      }
    },
    { cwd: testRoot }
  );
  assert.equal(
    result.authenticityWarnings.some((warning) => /Proposal lacks project-specific information/i.test(warning)),
    false
  );
  assert.equal(
    result.detectedIssues.some((issue) => /Proposal lacks project-specific information/i.test(issue.issue)),
    false
  );
}

function testPlanningActionMentionsBrowserButDoesNotRequireBrowserEvidence() {
  const result = verification.verifyTaskResult(
    {
      id: "goal-map",
      title: "Map the goal and success criteria",
      type: "planning",
      modelPool: "free",
      successCriteria: ["目标和验收标准已经明确"],
      attempts: 0,
      maxAttempts: 1
    },
    {
      status: "success",
      output: "目标和验收标准已经明确：需要打开 data URL、读取页面正文并生成摘要。",
      actions: ["open browser page later", "prepare checklist"],
      evidence: {
        provided: true,
        summary: "Planning checklist was produced.",
        semantic: {
          outputSummary: "目标和验收标准已经明确。",
          addressesCriteria: true,
          criteriaCoverage: 1,
          qualityScore: 0.9
        }
      }
    },
    { cwd: testRoot }
  );
  assert.notEqual(result.decisionSource, "authenticity");
  assert.equal(
    result.detectedIssues.some((issue) => /Browser result has no URL evidence/i.test(issue.issue)),
    false
  );
  assert.notEqual(result.suggestedNextState, verification.SUGGESTED_NEXT_STATE.BLOCKED);
}

function testFileEvidenceDoesNotTriggerBrowserUrlRequirement() {
  const result = verification.verifyTaskResult(
    {
      id: "repo-structure",
      title: "获取仓库文件结构",
      type: "local_execution",
      modelPool: "codex-cli",
      successCriteria: ["返回 worker 调用链路文件证据"],
      attempts: 0,
      maxAttempts: 1
    },
    {
      status: "success",
      output: [
        "本地只读仓库扫描已完成，未修改任何文件。",
        "- worker dispatch: src/agent/orchestrator/worker-dispatcher.js:7",
        "- browser worker: src/agent/orchestrator/browser-worker.js:34",
        "- codex cli: src/tools/codex-cli/runtime.js:44",
        "- internal model service: src/core/router/runtime.js:10"
      ].join("\n"),
      actions: ["read:src/agent/orchestrator/worker-dispatcher.js"],
      evidence: {
        provided: true,
        summary: "Read whitelisted repository files.",
        shell: {
          command: "codex-cli:read-whitelisted-files",
          exitCode: 0,
          stdout: "worker dispatch evidence found",
          stderr: ""
        },
        files: [
          {
            path: path.join(process.cwd(), "src/agent/orchestrator/worker-dispatcher.js"),
            beforeSize: 100,
            afterSize: 100
          }
        ],
        semantic: {
          outputSummary: "The local worker found call-chain evidence in repository files.",
          addressesCriteria: true,
          criteriaCoverage: 1,
          qualityScore: 0.95
        }
      },
      context: {
        model: "codex-cli"
      }
    },
    { cwd: process.cwd() }
  );
  assert.equal(
    result.detectedIssues.some((issue) => /Browser result has no URL evidence/i.test(issue.issue)),
    false
  );
  assert.notEqual(result.decisionSource, "authenticity");
  assert.notEqual(result.suggestedNextState, verification.SUGGESTED_NEXT_STATE.BLOCKED);
}

async function testAuthenticityStatusAction() {
  taskRuntime.resetRuntime();
  taskRuntime.registerGoalTasks("authenticity-visual-goal", [listTask()], {
    replace: true,
    source: "authenticity-test"
  });
  const task = taskRuntime.nextWaitingTask("authenticity-visual-goal");
  taskRuntime.startTask("authenticity-visual-goal", task.id, { source: "authenticity-test" });
  taskRuntime.applyWorkerResult(
    "authenticity-visual-goal",
    task.id,
    workerResult(
      [
        "1. TBD · $0 · https://jobs.test/placeholder",
        "2. TBD · $0 · https://jobs.test/placeholder",
        "3. TBD · $0 · https://jobs.test/placeholder",
        "4. TBD · $0 · https://jobs.test/placeholder",
        "5. TBD · $0 · https://jobs.test/placeholder"
      ].join("\n")
    ),
    { source: "authenticity-test" }
  );

  const response = await actionApi.handleAgentRouteAction({
    action: "authenticity_status",
    goal_id: "authenticity-visual-goal",
    task_id: task.id
  });
  const json = await response.json();
  assert.equal(json.ok, true);
  assert.equal(json.authenticity.decisionSource, "authenticity");
  assert.ok(json.authenticity.score < 0.35);
  assert.ok(json.authenticity.warnings.length);
  assert.ok(Array.isArray(json.authenticity.signals));
}

async function main() {
  testNormalListLooksAuthentic();
  testDuplicateProjectsAreSuspicious();
  testEmptyLinksAreSuspicious();
  testEmptyTitlesAreSuspicious();
  testPlaceholderTextCanBlockFalseSuccess();
  testEmptyResultIsHighlySuspicious();
  testProposalAuthenticity();
  testWebEvidenceDoesNotUseProposalAuthenticity();
  testPlanningActionMentionsBrowserButDoesNotRequireBrowserEvidence();
  testFileEvidenceDoesNotTriggerBrowserUrlRequirement();
  await testAuthenticityStatusAction();
  console.log("agent authenticity tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
