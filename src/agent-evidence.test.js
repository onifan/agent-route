"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-evidence-"));
process.env.AGENT_ROUTE_HOME = testRoot;
process.env.AGENT_ROUTE_TASKS = path.join(testRoot, "tasks.json");
process.env.AGENT_ROUTE_MEMORY = path.join(testRoot, "memory.json");
process.env.AGENT_ROUTE_OBSERVABILITY = path.join(testRoot, "observability.json");

const evidence = require("./agent/evidence");
const observability = require("./agent/observability");
const riskEngine = require("./agent/risk");
const verificationEngine = require("./agent/verification");
const workerEvidence = require("./agent/verification/evidence");
const browserTool = require("./tools/browser");

async function testToolsBrowserResultIsAccepted() {
  const session = await browserTool.createBrowserSession({ browser: { adapter: "mock" } });
  const html = encodeURIComponent(
    [
      "<html>",
      "<head><title>Evidence Page</title></head>",
      '<body><button id="submit">Submit</button><p>Application submitted</p></body>',
      "</html>"
    ].join("")
  );
  const opened = await browserTool.openBrowserPage(session.sessionId, `data:text/html,${html}`);
  const normalized = evidence.normalizeBrowserEvidence(opened);
  assert.equal(normalized.type, "browser");
  assert.equal(normalized.evidenceSource, "mock");
  assert.equal(normalized.title, "Evidence Page");
  assert.match(normalized.textPreview, /Application submitted/);
  assert.ok(Array.isArray(opened.evidence.browserEvidence));
  await browserTool.closeBrowserSession(session.sessionId);
}

function testCodexTextExtractionDoesNotInventMissingFields() {
  const text = [
    "STATUS: success",
    "ACTIONS:",
    "- opened the page",
    "- clicked submit button",
    "RESULT:",
    'The page showed "Application submitted"',
    "NEXT: done"
  ].join("\n");
  const items = evidence.extractCodexBrowserEvidence(text, { evidenceSource: "codex-cli" });
  assert.equal(items.length, 1);
  assert.equal(items[0].evidenceSource, "codex-cli");
  assert.equal(items[0].detectedActionType, "submit_like_click");
  assert.equal(items[0].url, "");
  assert.match(items[0].textPreview, /Application submitted/);
}

function testPlainWorkerTextDoesNotBecomeBrowserEvidence() {
  const normalized = evidence.normalizeWorkerEvidence({
    model: "deepseek/deepseek-chat",
    output:
      "执行要求：不要登录账号、不要提交表单。目标是读取 data:text/html,<html><body>ok</body></html> 页面并生成摘要。"
  });
  assert.deepEqual(normalized.browserEvidence, []);
  assert.deepEqual(normalized.normalizedEvidence.browser, []);
}

function testStructuredCodexEvidenceDoesNotExtractLogsAsBrowserEvidence() {
  const normalized = evidence.normalizeWorkerEvidence(
    {
      model: "codex-cli",
      output: "已采集 USDJPY=159.1045，并记录了公开 API 状态。",
      actions: ["curl Stooq USDJPY CSV quote"],
      context: {
        stdout: "OpenAI Codex v0.130.0\nprompt mentions browser error handling",
        stderr: "WARN plugin sync failed with Cloudflare challenge"
      },
      evidence: {
        summary: "只读公开 API 数据采集完成。",
        shell: {
          command: "curl public market data",
          exitCode: 0,
          stdout: "HTTP_STATUS:200",
          stderr: ""
        },
        apiResponses: [{ status: 200, body: "USDJPY 159.1045" }],
        semantic: {
          outputSummary: "采集了 USDJPY 数据。",
          addressesCriteria: true,
          criteriaCoverage: 0.9,
          qualityScore: 0.9
        }
      }
    },
    { evidenceSource: evidence.EVIDENCE_SOURCE.CODEX_CLI }
  );
  assert.deepEqual(normalized.browserEvidence, []);
  assert.deepEqual(normalized.normalizedEvidence.browser, []);
}

function testLegacyEvidenceCompatibilityAndSanitization() {
  const shotPath = path.join(testRoot, "browser", "screenshots", "shot.png");
  const normalized = workerEvidence.normalizeEvidence(
    {
      browser: {
        currentUrl: "https://example.com/app?token=abc123456&ok=1",
        pageText: "Saved successfully",
        screenshotPath: shotPath
      }
    },
    {}
  );
  assert.equal(normalized.provided, true);
  assert.match(normalized.browser.currentUrl, /token=%5BREDACTED%5D|token=\[REDACTED\]/);
  assert.equal(normalized.browserEvidence[0].type, "browser");
  assert.match(normalized.browserEvidence[0].screenshotPath, /\$AGENT_ROUTE_HOME/);
}

function testActionTypeDetection() {
  assert.equal(evidence.detectBrowserActionType("click submit proposal"), "submit_like_click");
  assert.equal(evidence.detectBrowserActionType("delete account"), "delete_like_click");
  assert.equal(evidence.detectBrowserActionType("pay invoice"), "payment_like_click");
  assert.equal(evidence.detectBrowserActionType("login with password"), "login_like_action");
}

function testVerificationConsumesNormalizedBrowserEvidence() {
  const browser = evidence.normalizeBrowserEvidence({
    evidenceSource: "worker",
    detectedActionType: "read_page",
    url: "https://example.com/done",
    title: "Done",
    textPreview: "Saved successfully on page",
    ok: true
  });
  const result = verificationEngine.verifyTaskResult(
    {
      type: "browser",
      title: "Read page",
      successCriteria: ["Saved successfully"]
    },
    {
      status: "success",
      output: "Observed saved page",
      actions: [],
      evidence: { browserEvidence: [browser] }
    }
  );
  assert.ok(result.reasons.some((reason) => /Browser page text evidence/i.test(reason)));
}

function testVerificationDoesNotTreatOutputErrorPolicyAsBrowserFailure() {
  const result = verificationEngine.verifyTaskResult(
    {
      type: "browser",
      title: "采集公开市场数据",
      successCriteria: ["HTTP 200"]
    },
    {
      status: "success",
      output: "已采集公开 API；提示：不要把 prompt 里的 error handling 文本当作页面错误。",
      actions: ["curl public API"],
      evidence: {
        shell: { command: "curl", exitCode: 0, stderr: "", stdout: "HTTP_STATUS:200" },
        apiResponses: [{ status: 200, body: "ok" }],
        semantic: {
          outputSummary: "HTTP 200 observed",
          addressesCriteria: true,
          criteriaCoverage: 1,
          qualityScore: 0.9
        }
      }
    }
  );
  assert.equal(
    result.detectedIssues.some((issue) => /Browser reported an error/i.test(issue.issue)),
    false
  );
}

function testVerificationDoesNotTreatSignInNavigationAsLoginGate() {
  const browser = evidence.normalizeBrowserEvidence({
    evidenceSource: "web-tool",
    detectedActionType: "read_page",
    url: "https://example.test/markets/usd-jpy",
    title: "USD JPY live rate",
    textPreview:
      "USD JPY live rate 156.42. Last updated 2026-05-22 10:00 UTC. Open in App. Sign In Free Sign Up. Markets Currencies Rates.",
    ok: true
  });
  const result = verificationEngine.verifyTaskResult(
    {
      type: "web_read",
      title: "Read public market page",
      successCriteria: ["USD JPY live rate", "timestamp"]
    },
    {
      status: "success",
      output: "URL https://example.test/markets/usd-jpy HTTP 200 USD JPY live rate 156.42 timestamp 2026-05-22.",
      actions: ["web:fetch"],
      evidence: {
        browserEvidence: [browser],
        apiResponses: [{ url: "https://example.test/markets/usd-jpy", status: 200, body: "USD JPY live rate 156.42" }],
        semantic: {
          outputSummary: "Public market page was readable and included USD JPY data.",
          addressesCriteria: true,
          criteriaCoverage: 0.9,
          qualityScore: 0.9
        }
      }
    }
  );
  assert.equal(
    result.detectedIssues.some((issue) => /login page/i.test(issue.issue)),
    false
  );
}

function testVerificationStillFlagsRealLoginGate() {
  const browser = evidence.normalizeBrowserEvidence({
    evidenceSource: "web-tool",
    detectedActionType: "read_page",
    url: "https://example.test/account",
    title: "Sign in required",
    textPreview: "Please sign in to continue. Email address Password Forgot password.",
    ok: true
  });
  const result = verificationEngine.verifyTaskResult(
    {
      type: "web_read",
      title: "Read protected page",
      successCriteria: ["public data"]
    },
    {
      status: "success",
      output: "HTTP 200 but page asks user to sign in.",
      actions: ["web:fetch"],
      evidence: {
        browserEvidence: [browser],
        semantic: {
          outputSummary: "The page requires sign in.",
          addressesCriteria: false,
          criteriaCoverage: 0.1,
          qualityScore: 0.1
        }
      }
    }
  );
  assert.ok(result.detectedIssues.some((issue) => /login page/i.test(issue.issue)));
}

function testFileExpectedContentObjectUsesJsonSubsetVerification() {
  const filePath = path.join(testRoot, "fetch_market_data_2026-05-20.json");
  const payload = {
    date: "2026-05-20",
    usdJpy: 159.03,
    sources: {
      fx: "Stooq",
      jgb: "World Government Bonds"
    }
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  const size = fs.statSync(filePath).size;
  const result = verificationEngine.verifyTaskResult(
    {
      id: "market-file",
      type: "file",
      modelPool: "codex-cli",
      title: "Save market data artifact",
      successCriteria: ["market data JSON artifact"]
    },
    {
      status: "success",
      output: "Saved market data JSON artifact.",
      actions: ["write market data json"],
      evidence: {
        provided: true,
        files: [
          {
            path: filePath,
            beforeSize: 0,
            afterSize: size,
            expectedContent: {
              date: "2026-05-20",
              sources: { fx: "Stooq" }
            }
          }
        ],
        shell: { command: "node write-market-data.js", exitCode: 0, stderr: "", stdout: "ok" },
        semantic: {
          outputSummary: "Market data JSON artifact was saved.",
          addressesCriteria: true,
          criteriaCoverage: 1,
          qualityScore: 0.95
        }
      }
    },
    { cwd: testRoot }
  );
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /\[object Object\]/);
  assert.ok(result.reasons.some((reason) => /Verified expected JSON fields/i.test(reason)));
  assert.equal(
    result.detectedIssues.some((issue) => /Expected content was not found/i.test(issue.issue)),
    false
  );
  assert.equal(result.verificationStatus, verificationEngine.VERIFICATION_STATUS.VERIFIED);
}

function testReadOnlyFileEvidenceDoesNotRequireOutputContentMatch() {
  const filePath = path.join(testRoot, "source.js");
  fs.writeFileSync(filePath, "export const value = 42;\n");
  const result = verificationEngine.verifyTaskResult(
    {
      id: "repo-read",
      type: "local_execution",
      modelPool: "codex-cli",
      title: "Read repository evidence",
      successCriteria: ["source files were inspected"]
    },
    {
      status: "success",
      output: "Read source files and summarized the implementation.",
      actions: ["read source.js"],
      evidence: {
        provided: true,
        files: [
          {
            path: filePath,
            beforeSize: fs.statSync(filePath).size,
            afterSize: fs.statSync(filePath).size,
            expectedContent: "summary text that is not meant to be written into the source file"
          }
        ],
        shell: { command: "rg implementation source.js", exitCode: 0, stderr: "", stdout: "source.js:1: value" },
        semantic: {
          outputSummary: "The source file was read and summarized.",
          addressesCriteria: true,
          criteriaCoverage: 1,
          qualityScore: 0.92
        }
      }
    },
    { cwd: testRoot }
  );
  assert.equal(
    result.detectedIssues.some((issue) => /Expected content was not found/i.test(issue.issue)),
    false
  );
  assert.ok(result.reasons.some((reason) => /Read-only file evidence recorded/i.test(reason)));
}

function testRiskReadsDetectedActionTypeWithoutStateMutation() {
  const browser = evidence.normalizeBrowserEvidence({
    detectedActionType: "submit_like_click",
    textPreview: "Submit proposal",
    ok: true
  });
  const evaluation = riskEngine.evaluateTaskRisk(
    {
      type: "browser",
      title: "Review page"
    },
    {
      workerResult: {
        actions: [],
        evidence: { browserEvidence: [browser] }
      }
    }
  );
  assert.equal(evaluation.requiresHumanApproval, true);
  assert.equal(browser.status, undefined);
}

function testObservabilityExposesSanitizedEvidence() {
  observability.setStorageFile(path.join(testRoot, "observability-test.json"));
  observability.resetRuntime();
  const browser = evidence.normalizeBrowserEvidence({
    url: "https://example.com/app?token=abc123456&ok=1",
    screenshotPath: path.join(testRoot, "browser", "screenshots", "secret.png"),
    textPreview: "ok"
  });
  const event = observability.recordEvent(
    "EvidenceObserved",
    {
      evidence: { browserEvidence: [browser] }
    },
    { goalId: "goal", taskId: "task" }
  );
  const json = JSON.stringify(event);
  assert.doesNotMatch(json, /abc123456/);
  assert.doesNotMatch(json, new RegExp(testRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(json, /\$AGENT_ROUTE_HOME/);
}

async function main() {
  await testToolsBrowserResultIsAccepted();
  testCodexTextExtractionDoesNotInventMissingFields();
  testPlainWorkerTextDoesNotBecomeBrowserEvidence();
  testStructuredCodexEvidenceDoesNotExtractLogsAsBrowserEvidence();
  testLegacyEvidenceCompatibilityAndSanitization();
  testActionTypeDetection();
  testVerificationConsumesNormalizedBrowserEvidence();
  testVerificationDoesNotTreatOutputErrorPolicyAsBrowserFailure();
  testVerificationDoesNotTreatSignInNavigationAsLoginGate();
  testVerificationStillFlagsRealLoginGate();
  testFileExpectedContentObjectUsesJsonSubsetVerification();
  testReadOnlyFileEvidenceDoesNotRequireOutputContentMatch();
  testRiskReadsDetectedActionTypeWithoutStateMutation();
  testObservabilityExposesSanitizedEvidence();
  console.log("agent evidence tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
