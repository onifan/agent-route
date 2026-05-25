"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-file-intent-"));
process.env.AGENT_ROUTE_HOME = testRoot;
process.env.AGENT_ROUTE_TASKS = path.join(testRoot, "tasks.json");
process.env.AGENT_ROUTE_OBSERVABILITY = path.join(testRoot, "observability.json");
process.env.AGENT_ROUTE_BUDGET_RECORDS = path.join(testRoot, "budget-records.json");

const verification = require("./agent/verification");
const { detectFileIntent } = require("./agent/verification/file-intent");

function assertNotFile(value) {
  const intent = detectFileIntent(value, { source: "text" });
  assert.equal(intent.isFile, false, `${value} should not be treated as file`);
}

function assertFile(value) {
  const intent = detectFileIntent(value, { source: "text" });
  assert.equal(intent.isFile, true, `${value} should be treated as file`);
  assert.ok(intent.confidence >= 0.5, `${value} should have useful confidence`);
}

function testTechnologyTermsAreNotFiles() {
  for (const term of ["Node.js", "React", "Next.js", "Python", "Docker", "AWS", "Java", "TypeScript"]) {
    assertNotFile(term);
  }
  assertNotFile("https://example.com");
}

function testRealFileShapesAreFiles() {
  for (const value of ["index.js", "src/app.ts", "README.md", "/tmp/a.png", "./config.json"]) {
    assertFile(value);
  }
}

function testVerificationDoesNotCheckTechKeywordsAsFiles() {
  const result = verification.verifyTaskResult(
    {
      id: "tech-keywords",
      title: "Summarize technical skills",
      type: "summary",
      modelPool: "free",
      successCriteria: ["Node.js", "React", "Next.js", "Python", "Docker", "AWS"],
      attempts: 0,
      maxAttempts: 1
    },
    {
      status: "success",
      output: "The candidate has Node.js, React, Next.js, Python, Docker and AWS experience.",
      actions: ["summarize profile"],
      evidence: {
        provided: true,
        summary: "The summary covers all requested technical terms.",
        claims: ["Node.js", "React", "Next.js", "Python", "Docker", "AWS"],
        semantic: {
          outputSummary: "Technical skills summary includes Node.js, React, Next.js, Python, Docker and AWS.",
          addressesCriteria: true,
          criteriaCoverage: 1,
          qualityScore: 0.95
        }
      }
    },
    { cwd: testRoot }
  );

  assert.equal(
    result.detectedIssues.some((issue) => /Expected file does not exist/i.test(issue.issue)),
    false
  );
  assert.ok(result.falseFileDetectionCount >= 2);
  assert.ok(result.fileIntentChecks.some((item) => item.input === "Node.js" && item.isFile === false));
  assert.ok(result.fileIntentChecks.some((item) => item.input === "Next.js" && item.isFile === false));
  assert.notEqual(result.suggestedNextState, verification.SUGGESTED_NEXT_STATE.FAILED);
}

function testPlainReportTextDoesNotRequireFileArtifact() {
  const result = verification.verifyTaskResult(
    {
      id: "plain-report",
      title: "生成中文风险报告",
      type: "analysis",
      modelPool: "strong",
      successCriteria: ["输出中文风险报告"],
      attempts: 0,
      maxAttempts: 1
    },
    {
      status: "success",
      output: "# 中文风险报告\n\n这是普通最终回答正文，不是本地文件产物。",
      actions: ["generate_report"],
      evidence: {
        provided: true,
        summary: "报告正文已经生成。",
        claims: ["报告正文已经生成。"],
        semantic: {
          outputSummary: "生成了中文风险报告正文。",
          addressesCriteria: true,
          criteriaCoverage: 1,
          qualityScore: 0.9
        }
      }
    },
    { cwd: testRoot }
  );

  assert.equal(
    result.detectedIssues.some((issue) => /file path|artifact|Expected file/i.test(issue.issue)),
    false
  );
  assert.notEqual(result.suggestedNextState, verification.SUGGESTED_NEXT_STATE.FAILED);
}

function testVerificationStillChecksRealFiles() {
  const result = verification.verifyTaskResult(
    {
      id: "real-file",
      title: "Generate index.js",
      type: "file",
      modelPool: "codex-cli",
      successCriteria: ["index.js"],
      attempts: 0,
      maxAttempts: 1
    },
    {
      status: "success",
      output: "Generated index.js",
      actions: ["write index.js"],
      evidence: {
        provided: true,
        files: [{ path: "index.js" }],
        semantic: {
          outputSummary: "Generated index.js",
          addressesCriteria: true,
          criteriaCoverage: 1,
          qualityScore: 0.9
        }
      }
    },
    { cwd: testRoot }
  );

  assert.ok(result.fileIntentChecks.some((item) => item.input === "index.js" && item.isFile === true));
  assert.ok(result.detectedIssues.some((issue) => /Expected file does not exist/i.test(issue.issue)));
}

function main() {
  testTechnologyTermsAreNotFiles();
  testRealFileShapesAreFiles();
  testVerificationDoesNotCheckTechKeywordsAsFiles();
  testPlainReportTextDoesNotRequireFileArtifact();
  testVerificationStillChecksRealFiles();
  console.log("agent verification file intent tests passed");
}

main();
