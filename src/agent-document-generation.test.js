"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-documents-"));
process.env.AGENT_ROUTE_HOME = testRoot;

const documentWorker = require("./agent/orchestrator/document-worker");
const planner = require("./agent/orchestrator/planner");
const resultNormalizer = require("./agent/orchestrator/result-normalizer");
const reviewLoop = require("./agent/orchestrator/review-loop");
const verificationEngine = require("./agent/verification/engine");
const documentTool = require("./tools/documents");
const { artifactRepository } = require("./storage/repositories");
const { DEFAULT_PROMPT_SETTINGS } = require("./config/prompts");

async function testDocumentRendererWritesGenericDocxArtifact() {
  const result = await documentTool.renderDocument({
    title: "Generic Evidence Report",
    body: "# Generic Evidence Report\n\nThis document is rendered from supplied agent content.",
    format: "docx",
    fileName: "generic-evidence-report"
  });
  assert.equal(result.ok, true);
  assert.equal(result.format, "docx");
  assert.match(result.path, /\.docx$/);
  assert.ok(result.size > 200);
  const buffer = fs.readFileSync(result.path);
  assert.equal(buffer.slice(0, 2).toString("utf8"), "PK");
  assert.ok(buffer.includes(Buffer.from("word/document.xml")));
}

async function testDocumentWorkerUsesUpstreamContentAndVerifiesFileEvidence() {
  const task = {
    id: "render-document",
    title: "Render generic document artifact",
    type: "document_generate",
    toolWorker: "document",
    modelPool: "free",
    input: { format: "html", fileName: "generic-agent-output", title: "Generic Agent Output" },
    dependencies: ["prepare-content"],
    consumes: ["document_content"],
    successCriteria: ["Real artifact path, size, hash, and HTML format evidence are returned."]
  };
  const previousResults = [
    {
      ok: true,
      task: { id: "prepare-content", produces: ["document_content"], verificationStatus: "verified" },
      content: JSON.stringify({
        status: "success",
        output:
          "# Generic Agent Output\n\nThis file body comes from upstream content evidence, not a built-in template."
      })
    }
  ];
  const result = await documentWorker.runDocumentWorker(task, {}, previousResults);
  assert.equal(result.ok, true);
  assert.equal(result.model, "document-tool");
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.artifacts[0].format, "html");
  assert.equal(artifactRepository.normalizeArtifact(parsed.artifacts[0]).format, "html");
  assert.ok(fs.existsSync(parsed.artifacts[0].path));
  assert.ok(parsed.evidence.files[0].afterSize > 0);
  assert.ok(parsed.evidence.files[0].afterHash);

  const runtimeResult = resultNormalizer.makeWorkerRuntimeResult(result, task);
  const verification = verificationEngine.verifyTaskResult(task, runtimeResult, {
    phase: "after_worker",
    maxAttempts: 1
  });
  assert.equal(verification.suggestedNextState, verificationEngine.SUGGESTED_NEXT_STATE.COMPLETED);
  assert.match(verification.reasons.join("\n"), /Verified document format html/);
}

async function testDocumentWorkerFailsWithoutContent() {
  const result = await documentWorker.runDocumentWorker(
    {
      id: "render-empty",
      title: "Render empty document",
      type: "document_generate",
      toolWorker: "document",
      input: { format: "md", fileName: "empty" }
    },
    {},
    []
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /no upstream or explicit content/i);
}

function testPlannerRoutesDocumentGenerationToDocumentWorker() {
  const plan = planner.normalizePlan(
    {
      tasks: [
        {
          id: "render",
          title: "输出 Markdown 文档文件",
          description: "把上游内容渲染为 Markdown 文档文件，返回 artifact path、format、size 和 hash。",
          type: "analysis",
          modelPool: "strong",
          dependsOn: ["prepare"],
          consumes: ["document_content"]
        }
      ]
    },
    { maxTasks: 3 },
    [{ role: "user", content: "请把分析结果输出为 Markdown 文档文件。" }],
    null
  );
  assert.equal(plan.tasks[0].type, "document_generate");
  assert.equal(plan.tasks[0].toolWorker, "document");
  assert.equal(plan.tasks[0].modelPool, "free");
  assert.ok(plan.tasks[0].produces.includes("document_artifact"));

  const codeFilePlan = planner.normalizePlan(
    {
      tasks: [
        {
          id: "write-config",
          title: "Write config file",
          description: "Write a JSON config file for the app.",
          type: "coding",
          modelPool: "coding"
        }
      ]
    },
    { maxTasks: 3 },
    [{ role: "user", content: "Write a JSON config file for the app." }],
    null
  );
  assert.notEqual(codeFilePlan.tasks[0].toolWorker, "document");
  assert.equal(
    documentWorker.documentFormat({
      title: "输出 DOCX 文档",
      type: "document_generate",
      prompt: "把上游内容渲染为 DOCX 文档。"
    }),
    "docx"
  );

  const readOnlyReportPlan = planner.normalizePlan(
    {
      tasks: [
        {
          id: "report",
          title: "生成中文金融风险报告",
          type: "document_generate",
          toolWorker: "document",
          modelPool: "free",
          input: "基于已验证证据生成最终报告。"
        }
      ]
    },
    { maxTasks: 3 },
    [{ role: "user", content: "请只读查询公开信息并写一篇最终报告。不要修改任何文件。" }],
    null
  );
  assert.equal(readOnlyReportPlan.tasks.length, 0);

  const ordinaryFinalReportWorker = planner.normalizePlan(
    {
      tasks: [
        {
          id: "compose-report",
          title: "生成中文风险报告",
          type: "analysis",
          toolWorker: "none",
          modelPool: "strong",
          input: "基于已验证证据生成最终报告。",
          successCriteria: ["生成中文风险报告"]
        }
      ]
    },
    { maxTasks: 3 },
    [{ role: "user", content: "请只读查询公开信息并写一篇最终报告。不要修改任何文件。" }],
    null
  );
  assert.equal(ordinaryFinalReportWorker.tasks.length, 0);
}

function testDocumentWorkerRequiresExplicitDocumentTask() {
  assert.equal(
    documentWorker.shouldUseDocumentWorker({
      id: "repo-analysis",
      title: "分析仓库并生成多个报告文件",
      type: "local_execution",
      modelPool: "codex-cli",
      input: "读取仓库、准备内容，并在允许的 artifact 目录生成报告文件。"
    }),
    false
  );
  assert.equal(
    documentWorker.shouldUseDocumentWorker({
      id: "render-document",
      title: "渲染文档产物",
      type: "document_generate",
      toolWorker: "document"
    }),
    true
  );
}

function testPromptsRequireRealDocumentArtifacts() {
  assert.match(DEFAULT_PROMPT_SETTINGS.plannerInstructions, /document_generate/);
  assert.match(DEFAULT_PROMPT_SETTINGS.plannerInstructions, /artifact path、format、size、hash、createdAt/);
  assert.match(DEFAULT_PROMPT_SETTINGS.reviewSystem, /真实 artifact 和 file evidence/);
  assert.match(DEFAULT_PROMPT_SETTINGS.workerSystem, /不要声称文件已经创建/);
  assert.match(DEFAULT_PROMPT_SETTINGS.workerSystem, /semantic\.outputSummary/);

  const planMessages = planner.makePlanPrompt(
    [{ role: "user", content: "请把总结输出为 DOCX 文档。" }],
    { promptSettings: DEFAULT_PROMPT_SETTINGS, maxTasks: 3 },
    "",
    null,
    { normalizePromptSettings: (value) => value }
  );
  assert.match(planMessages.map((message) => message.content).join("\n"), /toolWorker document/);

  const reviewMessages = reviewLoop.makeProgressMessages(
    [{ role: "user", content: "请把总结输出为 DOCX 文档。" }],
    { tasks: [] },
    [],
    1,
    { promptSettings: DEFAULT_PROMPT_SETTINGS },
    "",
    null,
    { normalizePromptSettings: (value) => value }
  );
  assert.match(reviewMessages.map((message) => message.content).join("\n"), /document_generate/);
}

async function main() {
  await testDocumentRendererWritesGenericDocxArtifact();
  await testDocumentWorkerUsesUpstreamContentAndVerifiesFileEvidence();
  await testDocumentWorkerFailsWithoutContent();
  testPlannerRoutesDocumentGenerationToDocumentWorker();
  testDocumentWorkerRequiresExplicitDocumentTask();
  testPromptsRequireRealDocumentArtifacts();
  console.log("agent document generation tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
