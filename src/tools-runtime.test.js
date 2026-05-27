"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-tools-"));
process.env.AGENT_ROUTE_HOME = testRoot;
process.env.AGENT_ROUTE_WEB_TRANSPORT = "fetch";

const codexCliTool = require("./tools/codex-cli");
const browserTool = require("./tools/browser");
const filesTool = require("./tools/files");
const shellTool = require("./tools/shell");
const webTool = require("./tools/web");
const codexCliRunner = require("./agent/orchestrator/codex-cli-runner");
const riskEngine = require("./agent/risk");
const verificationEngine = require("./agent/verification");

function testCodexResultAndLogFilter() {
  const result = codexCliTool.normalizeCodexCliResult({
    ok: true,
    content: "done",
    stdout: "raw",
    stderr: "",
    code: 0,
    durationMs: 12
  });
  assert.equal(result.ok, true);
  assert.equal(result.content, "done");
  assert.equal(result.exitCode, 0);
  assert.equal(codexCliTool.shouldForwardCodexLog({ stream: "stdout", text: "visible" }), true);
  assert.equal(codexCliTool.shouldForwardCodexLog({ stream: "stderr", text: "debug noise" }), false);
  assert.equal(codexCliTool.shouldForwardCodexLog({ stream: "stderr", text: "STATUS: running" }), true);
  assert.equal(codexCliTool.shouldForwardCodexLog({ stream: "stderr", text: "ERROR: usage limit" }), true);
  assert.equal(codexCliRunner.runCodexCli, codexCliTool.runCodexCli);
}

function testCodexTimeoutKeepsErrorReadable() {
  const noisy = "OpenAI Codex v0.130.0\n" + "very noisy log ".repeat(2000);
  const result = codexCliTool.normalizeCodexCliResult({
    ok: false,
    stdout: noisy,
    stderr: noisy,
    code: null,
    timedOut: true,
    durationMs: 180025
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out after 180 seconds/i);
  assert.ok(result.error.length < 120);
  assert.match(result.content, /timed out/i);
}

function testCodexUsageLimitIsSurfacedFromStderr() {
  const result = codexCliTool.normalizeCodexCliResult({
    ok: false,
    stdout: "OpenAI Codex v0.130.0",
    stderr: "ERROR: Reconnecting... 5/5\nERROR: You've hit your usage limit. Upgrade to Pro or purchase more credits.",
    code: 1,
    durationMs: 18025
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /usage limit/i);
  assert.match(result.content, /usage limit/i);
  assert.doesNotMatch(result.error, /<html>/i);
}

function testCodexCliArgsStaySandboxed() {
  const args = codexCliTool.buildCodexExecArgs({
    cwd: testRoot,
    outputPath: path.join(testRoot, "codex-output.txt")
  });
  const sandboxIndex = args.indexOf("--sandbox");
  assert.notEqual(sandboxIndex, -1);
  assert.equal(args[sandboxIndex + 1], "workspace-write");
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.equal(args.includes("danger-full-access"), false);
  assert.equal(codexCliTool.resolveCodexSandboxMode({ sandbox: "read-only" }).sandboxMode, "read-only");
  const unsafe = codexCliTool.resolveCodexSandboxMode({ sandbox: "danger-full-access" });
  assert.equal(unsafe.ok, false);
  assert.match(unsafe.error, /not allowed/i);
}

async function testShellTool() {
  const result = await shellTool.executeCommand(
    process.execPath,
    ["-e", "console.log('hello'); console.error('warn')"],
    {
      cwd: testRoot,
      timeoutMs: 10000
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello/);
  assert.match(result.stderr, /warn/);
  assert.ok(result.durationMs >= 0);
}

function testFilesTool() {
  const tempPath = filesTool.tempFilePath({ prefix: "tool-test", suffix: ".txt" });
  assert.ok(tempPath.startsWith(path.join(testRoot, "tmp")));
  const written = filesTool.writeTextFile(tempPath, "abc");
  assert.equal(written.ok, true);
  assert.equal(written.size, 3);
  assert.equal(filesTool.fileExists(tempPath), true);
  assert.equal(filesTool.fileSize(tempPath), 3);
  const hash = filesTool.hashFile(tempPath);
  assert.equal(hash.ok, true);
  assert.equal(hash.hash.length, 64);
  const read = filesTool.readTextFile(tempPath);
  assert.equal(read.content, "abc");
}

async function testBrowserMockToolReturnsEvidence() {
  const session = await browserTool.createBrowserSession({ browser: { adapter: "mock" } });
  assert.equal(session.ok, true);
  assert.equal(session.adapter, "mock");
  assert.equal(browserTool.getBrowserSessionStatus(session.sessionId).status, "active");

  const html = encodeURIComponent(
    [
      "<html>",
      "<head><title>Browser Tool Test</title></head>",
      '<body><h1>Hello Browser</h1><input id="name"><button id="submit">Submit</button></body>',
      "</html>"
    ].join("")
  );
  const opened = await browserTool.openBrowserPage(session.sessionId, `data:text/html,${html}`);
  assert.equal(opened.ok, true);
  assert.equal(opened.action, "open_page");
  assert.equal(opened.title, "Browser Tool Test");
  assert.match(opened.textPreview, /Hello Browser/);
  assert.equal(opened.evidence.browser.title, "Browser Tool Test");

  const filled = await browserTool.fillBrowserSelector(session.sessionId, "#name", "super-secret-input");
  assert.equal(filled.ok, true);
  assert.equal(filled.metadata.textLength, 18);
  assert.doesNotMatch(JSON.stringify(filled), /super-secret-input/);

  const clicked = await browserTool.clickBrowserSelector(session.sessionId, "#submit", {
    label: "Submit",
    approvalStatus: "approved"
  });
  assert.equal(clicked.ok, true);
  assert.equal(clicked.metadata.detectedActionType, "submit_like_click");

  const scrolled = await browserTool.scrollBrowserPage(session.sessionId, { y: 120 });
  assert.equal(scrolled.ok, true);
  assert.equal(scrolled.metadata.y, 120);

  const waited = await browserTool.waitForBrowserSelector(session.sessionId, "#submit");
  assert.equal(waited.ok, true);
  assert.equal(waited.metadata.found, true);

  const snapshot = await browserTool.captureBrowserSnapshot(session.sessionId, { maxSnapshotBytes: 1200 });
  assert.equal(snapshot.ok, true);
  assert.ok(snapshot.snapshotPath.startsWith(path.join(testRoot, "browser", "snapshots")));
  assert.ok(fs.existsSync(snapshot.snapshotPath));
  assert.ok(fs.statSync(snapshot.snapshotPath).size <= 1200);
  assert.doesNotMatch(fs.readFileSync(snapshot.snapshotPath, "utf8"), /<html>/i);

  const screenshot = await browserTool.captureBrowserScreenshot(session.sessionId);
  assert.equal(screenshot.ok, true);
  assert.ok(screenshot.screenshotPath.startsWith(path.join(testRoot, "browser", "screenshots")));
  assert.ok(fs.existsSync(screenshot.screenshotPath));
  assert.ok(fs.statSync(screenshot.screenshotPath).size > 0);
  assert.equal(screenshot.resourceUsage.screenshotCount, 1);

  const verification = verificationEngine.verifyTaskResult(
    {
      id: "browser-read",
      type: "browser",
      title: "Read a browser page",
      successCriteria: ["Page text captured"]
    },
    {
      status: "success",
      output: "Observed the browser page.",
      actions: [{ type: "browser", action: "read_page" }],
      evidence: opened.evidence
    }
  );
  assert.ok(verification.reasons.some((reason) => /Browser page text evidence/i.test(reason)));

  const risk = riskEngine.evaluateTaskRisk(
    {
      id: "browser-submit",
      type: "browser",
      title: "Click submit"
    },
    {
      workerResult: { actions: [{ type: "browser", action: "click", label: "Submit proposal" }] }
    }
  );
  assert.equal(risk.requiresHumanApproval, true);

  const closed = await browserTool.closeBrowserSession(session.sessionId);
  assert.equal(closed.ok, true);
  assert.equal(browserTool.getBrowserSessionStatus(session.sessionId), null);
}

async function testWebToolReturnsEvidenceAndBlocksPrivateTargets() {
  const previousFetch = global.fetch;
  global.fetch = async (url) => {
    assert.match(String(url), /example\.test\/public/);
    return new Response(
      "<html><head><title>Public Evidence</title></head><body>Readable web evidence body for verification.</body></html>",
      { status: 200, headers: { "Content-Type": "text/html" } }
    );
  };
  try {
    const fetched = await webTool.fetchWebUrl("https://example.test/public?api_key=secret-value");
    assert.equal(fetched.ok, true);
    assert.equal(fetched.status, 200);
    assert.match(fetched.title, /Public Evidence/);
    assert.match(fetched.textPreview, /Readable web evidence/);
    assert.doesNotMatch(fetched.url, /secret-value/);
    assert.equal(fetched.evidence.apiResponses[0].status, 200);
    assert.equal(fetched.evidence.browser.evidenceSource, "web-tool");
  } finally {
    global.fetch = previousFetch;
  }

  const blocked = await webTool.fetchWebUrl("http://127.0.0.1:20128/agent-route");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.requiredApproval, true);
}

async function testWebToolDefaultsToSingleCurlTransport() {
  const previousTransport = process.env.AGENT_ROUTE_WEB_TRANSPORT;
  const previousFetch = global.fetch;
  delete process.env.AGENT_ROUTE_WEB_TRANSPORT;
  let fetchCalled = false;
  let curlCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error("default transport should not use fetch");
  };
  try {
    const fetched = await webTool.fetchWebUrl("https://example.test/default-transport", {
      curlImpl: async (command, args) => {
        curlCalled = true;
        assert.equal(command, "curl");
        assert.ok(args.includes("https://example.test/default-transport"));
        const headerPath = args[args.indexOf("--dump-header") + 1];
        fs.writeFileSync(headerPath, "HTTP/2 200 OK\r\ncontent-type: text/html\r\n\r\n");
        return {
          stdout: "<html><head><title>Default Curl</title></head><body>Readable default transport.</body></html>",
          stderr: ""
        };
      }
    });
    assert.equal(curlCalled, true);
    assert.equal(fetchCalled, false);
    assert.equal(fetched.ok, true);
    assert.match(fetched.title, /Default Curl/);
  } finally {
    global.fetch = previousFetch;
    if (previousTransport == null) delete process.env.AGENT_ROUTE_WEB_TRANSPORT;
    else process.env.AGENT_ROUTE_WEB_TRANSPORT = previousTransport;
  }
}

async function testWebToolSurfacesFetchNetworkFailureWithoutTransportFallback() {
  let curlCalled = false;
  const fetched = await webTool.fetchWebUrl("https://example.test/failover", {
    transport: "fetch",
    fetchImpl: async () => {
      throw new Error("synthetic fetch network failure");
    },
    curlImpl: async () => {
      curlCalled = true;
      throw new Error("curl should not be reached");
    }
  });
  assert.equal(fetched.ok, false);
  assert.equal(fetched.status, 0);
  assert.equal(curlCalled, false);
  assert.match(fetched.error, /fetch transport failed: synthetic fetch network failure/);
}

async function testWebSearchFetchesResultPagesForEvidence() {
  const previousFetch = global.fetch;
  global.fetch = async (url) => {
    const target = String(url);
    if (target.includes("bing.com/search")) {
      assert.match(decodeURIComponent(target), /example public evidence/);
      return new Response(
        '<html><body><li class="b_algo"><h2><a href="https://example.test/market">Market Data</a></h2></li></body></html>',
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
    if (target === "https://example.test/market") {
      return new Response(
        "<html><head><title>Public Data Report</title></head><body>Alpha value 156.20 at 2026-05-21 06:00 UTC. Beta value 1.48%.</body></html>",
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
    throw new Error(`unexpected fetch ${target}`);
  };
  try {
    const searched = await webTool.searchWeb("example public evidence", {
      resultFetchLimit: 1,
      searchProvider: "bing-html"
    });
    assert.equal(searched.ok, true);
    assert.ok(searched.results.length >= 1);
    assert.match(searched.textPreview, /Alpha value 156\.20/);
    assert.equal(
      searched.results.some((result) => result.fetched?.status === 200),
      true
    );
    assert.equal(searched.evidence.apiResponses.length, 1);
    assert.equal(searched.evidence.apiResponses[0].url, "https://example.test/market");
    assert.equal(searched.evidence.browserEvidence.length, 1);
  } finally {
    global.fetch = previousFetch;
  }
}

async function testWebSearchParsesResultsBeyondInitialSearchPageChunk() {
  const previousFetch = global.fetch;
  global.fetch = async (url) => {
    const target = String(url);
    if (target.includes("bing.com/search")) {
      assert.match(decodeURIComponent(target), /late generic evidence/);
      return new Response(
        `<html><body>${"navigation filler ".repeat(900)}<li class="b_algo"><h2><a href="https://example.test/late">Late Generic Evidence</a></h2></li></body></html>`,
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
    if (target === "https://example.test/late") {
      return new Response(
        "<html><head><title>Late Evidence Page</title></head><body>Readable generic evidence after a long search page prefix.</body></html>",
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
    throw new Error(`unexpected fetch ${target}`);
  };
  try {
    const searched = await webTool.searchWeb("late generic evidence", {
      resultFetchLimit: 1,
      searchProvider: "bing-html"
    });
    assert.equal(searched.ok, true);
    assert.equal(searched.results[0].url, "https://example.test/late");
    assert.match(searched.textPreview, /Readable generic evidence/);
  } finally {
    global.fetch = previousFetch;
  }
}

async function testWebSearchReadsRelevantLowerRankedResult() {
  const previousFetch = global.fetch;
  global.fetch = async (url) => {
    const target = String(url);
    if (target.includes("bing.com/search")) {
      assert.match(decodeURIComponent(target), /public evidence query/);
      return new Response(
        [
          "<html><body>",
          '<li class="b_algo"><h2><a href="https://example.test/unrelated">Unrelated Navigation Page</a></h2><p>Generic portal landing page.</p></li>',
          '<li class="b_algo"><h2><a href="https://example.test/relevant">Public Evidence Query Result</a></h2><p>Readable evidence for the requested public query.</p></li>',
          "</body></html>"
        ].join(""),
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
    if (target === "https://example.test/relevant") {
      return new Response(
        "<html><head><title>Relevant Evidence</title></head><body>Public evidence query result with readable source text.</body></html>",
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
    if (target === "https://example.test/unrelated") {
      throw new Error("unrelated result should not be fetched before the more relevant candidate");
    }
    throw new Error(`unexpected fetch ${target}`);
  };
  try {
    const searched = await webTool.searchWeb("public evidence query", {
      resultFetchLimit: 1,
      searchProvider: "bing-html"
    });
    assert.equal(searched.ok, true);
    assert.match(searched.textPreview, /Relevant Evidence/);
    assert.equal(searched.results.find((result) => result.url === "https://example.test/relevant").fetched.status, 200);
  } finally {
    global.fetch = previousFetch;
  }
}

async function testWebSearchFailsWhenOnlyUnreadableResultPagesExist() {
  const previousFetch = global.fetch;
  global.fetch = async (url) => {
    const target = String(url);
    if (target.includes("bing.com/search")) {
      return new Response(
        '<html><body><li class="b_algo"><h2><a href="https://example.test/unreadable">Unreadable Evidence</a></h2></li></body></html>',
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
    if (target === "https://example.test/unreadable") {
      return new Response(
        "<html><head><title>Unreadable</title></head><body>Oops, something went wrong. Please enable JavaScript and try again later.</body></html>",
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
    throw new Error(`unexpected fetch ${target}`);
  };
  try {
    const searched = await webTool.searchWeb("unreadable evidence", {
      resultFetchLimit: 1,
      searchProvider: "bing-html"
    });
    assert.equal(searched.ok, false);
    assert.match(searched.error, /no readable result page evidence/i);
    assert.deepEqual(searched.evidence.semantic.qualityIssues, [
      "Search result links were found, but no readable result page evidence was captured."
    ]);
  } finally {
    global.fetch = previousFetch;
  }
}

function testWebSearchParsesBingRedirectResultLinks() {
  const target = "https://example.test/market?pair=USDJPY";
  const encoded = Buffer.from(target).toString("base64url");
  const results = webTool.parseSearchResults(
    `<html><body><li class="b_algo"><div><a class="tilk" href="https://www.bing.com/ck/a?u=a1${encoded}&ntb=1">example.test</a></div><h2><a href="https://www.bing.com/ck/a?u=a1${encoded}&ntb=1">Generic Market Evidence</a></h2><div class="b_caption"><p>Readable public evidence snippet.</p></div></li></body></html>`,
    3
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].url, target);
  assert.equal(results[0].title, "Generic Market Evidence");
  assert.match(results[0].snippet, /Readable public evidence/);
}

async function testWebSearchSkipsDictionaryResultsForNonDictionaryQueries() {
  const previousFetch = global.fetch;
  let dictionaryFetched = false;
  let lowRelevanceFetched = false;
  let partialRelevanceFetched = false;
  let mismatchedIdentifierFetched = false;
  global.fetch = async (url) => {
    const target = String(url);
    if (target.includes("bing.com/search")) {
      return new Response(
        [
          "<html><body>",
          '<li class="b_algo"><h2><a href="https://dictionary.example/latest">latest 是什么意思</a></h2><p>translation and pronunciation page.</p></li>',
          '<li class="b_algo"><h2><a href="https://baike.example/item/latest">latest _百科</a></h2><p>generic encyclopedia page about the word latest.</p></li>',
          '<li class="b_algo"><h2><a href="https://travel.example/japan">About Japan</a></h2><p>Tourism and geography guide.</p></li>',
          '<li class="b_algo"><h2><a href="https://finance.example/usd-cny">USD to CNY exchange rate</a></h2><p>Public quote for the wrong pair.</p></li>',
          '<li class="b_algo"><h2><a href="https://finance.example/usd-jpy">USD JPY exchange rate</a></h2><p>Public market quote evidence.</p></li>',
          "</body></html>"
        ].join(""),
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
    if (target.includes("dictionary.example")) {
      dictionaryFetched = true;
      return new Response("<html><title>Dictionary</title><body>translation page</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
    }
    if (target.includes("baike.example")) {
      lowRelevanceFetched = true;
      return new Response("<html><title>latest</title><body>generic encyclopedia page</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
    }
    if (target.includes("travel.example")) {
      partialRelevanceFetched = true;
      return new Response("<html><title>About Japan</title><body>tourism guide</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
    }
    if (target.includes("finance.example/usd-cny")) {
      mismatchedIdentifierFetched = true;
      return new Response("<html><title>USD CNY</title><body>wrong currency pair</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
    }
    if (target.includes("finance.example/usd-jpy")) {
      return new Response(
        "<html><head><title>USD JPY exchange rate</title></head><body>USD/JPY exchange rate public quote evidence.</body></html>",
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
    throw new Error(`unexpected fetch ${target}`);
  };
  try {
    const searched = await webTool.searchWeb("USD JPY exchange rate", {
      limit: 5,
      resultFetchLimit: 1,
      searchProvider: "bing-html"
    });
    assert.equal(searched.ok, true);
    assert.equal(dictionaryFetched, false);
    assert.equal(lowRelevanceFetched, false);
    assert.equal(partialRelevanceFetched, false);
    assert.equal(mismatchedIdentifierFetched, false);
    assert.equal(searched.results[0].url, "https://finance.example/usd-jpy");
    assert.match(searched.textPreview, /USD JPY exchange rate/);
  } finally {
    global.fetch = previousFetch;
  }
}

async function testWebSearchRejectsSingleTokenCountryMatchesForSpecificQueries() {
  const previousFetch = global.fetch;
  let travelFetched = false;
  global.fetch = async (url) => {
    const target = String(url);
    if (target.includes("bing.com/search")) {
      return new Response(
        [
          "<html><body>",
          '<li class="b_algo"><h2><a href="https://travel.example/japan">About Japan</a></h2><p>Travel and geography guide.</p></li>',
          '<li class="b_algo"><h2><a href="https://market.example/japan-bond-yield">Japan government bond yield</a></h2><p>Public bond yield market evidence.</p></li>',
          "</body></html>"
        ].join(""),
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
    if (target.includes("travel.example")) {
      travelFetched = true;
      return new Response("<html><title>About Japan</title><body>travel guide</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
    }
    if (target.includes("market.example/japan-bond-yield")) {
      return new Response(
        "<html><head><title>Japan government bond yield</title></head><body>Japan 10 year government bond yield public quote evidence.</body></html>",
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
    throw new Error(`unexpected fetch ${target}`);
  };
  try {
    const searched = await webTool.searchWeb("Japan government bond yield", {
      limit: 2,
      resultFetchLimit: 1,
      searchProvider: "bing-html"
    });
    assert.equal(searched.ok, true);
    assert.equal(travelFetched, false);
    assert.equal(searched.results[0].url, "https://market.example/japan-bond-yield");
  } finally {
    global.fetch = previousFetch;
  }
}

async function testWebSearchReturnsLowConfidenceParsedResultsForVerifier() {
  const previousFetch = global.fetch;
  let candidateFetched = false;
  global.fetch = async (url) => {
    const target = String(url);
    if (target.includes("bing.com/search")) {
      return new Response(
        [
          "<html><body>",
          '<li class="b_algo"><h2><a href="https://finance.example/dollar-yen">Dollar Yen spot rate</a></h2><p>Exchange rate quote for the Japanese yen.</p></li>',
          "</body></html>"
        ].join(""),
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
    if (target === "https://finance.example/dollar-yen") {
      candidateFetched = true;
      return new Response(
        "<html><head><title>Dollar Yen spot rate</title></head><body>Dollar to yen exchange rate quote 156.20 from public market data.</body></html>",
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    }
    throw new Error(`unexpected fetch ${target}`);
  };
  try {
    const searched = await webTool.searchWeb("USD/JPY exchange rate 2026-05-26", {
      limit: 1,
      resultFetchLimit: 1,
      searchProvider: "bing-html"
    });
    assert.equal(searched.ok, true);
    assert.equal(candidateFetched, true);
    assert.match(searched.textPreview, /Dollar to yen exchange rate quote/);
    assert.match(searched.evidence.semantic.qualityNotes[0], /low-confidence/i);
  } finally {
    global.fetch = previousFetch;
  }
}

async function testWebSearchReportsChallengeWithoutFallback() {
  const previousFetch = global.fetch;
  global.fetch = async (url) => {
    const target = String(url);
    if (target.includes("bing.com/search")) {
      return new Response("<html><body>Search returned a bot challenge without parseable result links.</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
    }
    throw new Error(`unexpected fetch ${target}`);
  };
  try {
    const searched = await webTool.searchWeb("example public evidence query", {
      limit: 2,
      resultFetchLimit: 2,
      searchProvider: "bing-html"
    });
    assert.equal(searched.ok, false);
    assert.equal(searched.results.length, 0);
    assert.match(searched.error, /no parseable results/i);
    assert.deepEqual(searched.evidence.semantic.qualityNotes, []);
    assert.deepEqual(searched.evidence.semantic.qualityIssues, ["Search returned no parseable result links."]);
  } finally {
    global.fetch = previousFetch;
  }
}

async function testWebSearchUsesTavilyProviderEvidence() {
  const previousFetch = global.fetch;
  const previousProvider = process.env.AGENT_ROUTE_WEB_SEARCH_PROVIDER;
  delete process.env.AGENT_ROUTE_WEB_SEARCH_PROVIDER;
  let calls = 0;
  global.fetch = async (url, init = {}) => {
    calls += 1;
    assert.equal(String(url), "https://api.tavily.com/search");
    assert.equal(init.method, "POST");
    assert.match(init.headers.Authorization, /^Bearer test-tavily-key$/);
    const payload = JSON.parse(init.body);
    assert.equal(payload.query, "generic public evidence");
    assert.equal(payload.max_results, 2);
    assert.equal(payload.search_depth, "basic");
    assert.equal(payload.include_answer, false);
    assert.equal(payload.include_raw_content, false);
    return new Response(
      JSON.stringify({
        query: "generic public evidence",
        request_id: "req-test-1",
        results: [
          {
            title: "Generic Public Evidence",
            url: "https://example.test/evidence",
            content: "Generic public evidence text with alpha beta details.",
            score: 0.92
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  try {
    const searched = await webTool.searchWeb("generic public evidence", {
      searchProvider: "tavily",
      tavilyApiKey: "test-tavily-key",
      maxResults: 2
    });
    assert.equal(calls, 1);
    assert.equal(searched.ok, true);
    assert.equal(searched.provider, "tavily");
    assert.equal(searched.url, "https://api.tavily.com/search");
    assert.match(searched.textPreview, /Generic Public Evidence/);
    assert.equal(searched.results[0].url, "https://example.test/evidence");
    assert.equal(searched.evidence.browserEvidence[0].metadata.provider, "tavily");
    assert.equal(
      searched.evidence.apiResponses.some(
        (response) => response.provider === "tavily" && response.evidenceRole === "search_result_page"
      ),
      true
    );
  } finally {
    global.fetch = previousFetch;
    if (previousProvider == null) delete process.env.AGENT_ROUTE_WEB_SEARCH_PROVIDER;
    else process.env.AGENT_ROUTE_WEB_SEARCH_PROVIDER = previousProvider;
  }
}

async function testWebSearchTavilyFailureDoesNotFallbackToBing() {
  const previousFetch = global.fetch;
  let calls = 0;
  global.fetch = async (url) => {
    calls += 1;
    assert.equal(String(url), "https://api.tavily.com/search");
    return new Response(JSON.stringify({ error: "quota exhausted" }), {
      status: 429,
      statusText: "Too Many Requests",
      headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const searched = await webTool.searchWeb("generic public evidence", {
      searchProvider: "tavily",
      tavilyApiKey: "test-tavily-key"
    });
    assert.equal(calls, 1);
    assert.equal(searched.ok, false);
    assert.equal(searched.provider, "tavily");
    assert.equal(searched.results.length, 0);
    assert.match(searched.error, /HTTP 429/i);
    assert.equal(
      searched.evidence.semantic.qualityIssues.some((issue) => /Tavily search failed with HTTP 429/i.test(issue)),
      true
    );
  } finally {
    global.fetch = previousFetch;
  }
}

async function testWebSearchTavilyRequiresConfiguredKey() {
  const previousFetch = global.fetch;
  const previousKey = process.env.TAVILY_API_KEY;
  const previousAltKey = process.env.AGENT_ROUTE_TAVILY_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.AGENT_ROUTE_TAVILY_API_KEY;
  global.fetch = async () => {
    throw new Error("Tavily search should fail before network without a key");
  };
  try {
    const searched = await webTool.searchWeb("generic public evidence", {
      searchProvider: "tavily"
    });
    assert.equal(searched.ok, false);
    assert.equal(searched.provider, "tavily");
    assert.match(searched.error, /TAVILY_API_KEY is not configured/i);
  } finally {
    global.fetch = previousFetch;
    if (previousKey == null) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = previousKey;
    if (previousAltKey == null) delete process.env.AGENT_ROUTE_TAVILY_API_KEY;
    else process.env.AGENT_ROUTE_TAVILY_API_KEY = previousAltKey;
  }
}

function testLargeCsvEvidenceKeepsLatestRows() {
  const rows = Array.from(
    { length: 300 },
    (_, index) => `2026-01-${String((index % 28) + 1).padStart(2, "0")},${index}`
  );
  rows.push("2026-05-19,4.67");
  const limited = webTool.limitResponseBody(`observation_date,DGS10\n${rows.join("\n")}`, 1200, "text/csv");
  assert.match(limited, /observation_date,DGS10/);
  assert.match(limited, /2026-05-19,4\.67/);
}

function testEvidencePreviewKeepsCsvTail() {
  const preview = webTool.evidencePreviewText(
    [
      "observation_date,DGS10",
      "1962-01-02,4.06",
      "...[truncated: keeping latest rows from response tail]...",
      "2026-05-18,4.61",
      "2026-05-19,4.67"
    ].join(" ".repeat(500)),
    500
  );
  assert.match(preview, /observation_date,DGS10/);
  assert.match(preview, /2026-05-19,4\.67/);
}

async function testCsvFetchPreviewKeepsLatestRows() {
  const previousFetch = global.fetch;
  global.fetch = async () => {
    const rows = Array.from(
      { length: 500 },
      (_, index) => `2025-01-${String((index % 28) + 1).padStart(2, "0")},${index}`
    );
    rows.push("2026-05-19,4.67");
    return new Response(`observation_date,DGS10\n${rows.join("\n")}`, {
      status: 200,
      headers: { "Content-Type": "text/csv" }
    });
  };
  try {
    const fetched = await webTool.fetchWebUrl("https://example.test/dgs10.csv", {
      textLimit: 1200,
      bodyLimit: 1200
    });
    assert.match(fetched.textPreview, /observation_date,DGS10/);
    assert.match(fetched.textPreview, /2026-05-19,4\.67/);
    assert.match(fetched.bodyPreview, /2026-05-19,4\.67/);
  } finally {
    global.fetch = previousFetch;
  }
}

function testToolsDoNotDependOnAgentBusinessModules() {
  const toolsRoot = path.join(__dirname, "tools");
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    }
  }
  walk(toolsRoot);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    assert.equal(/require\(["']\.\.\/\.\.\/agent\//.test(text), false, `${file} should not depend on agent modules`);
    assert.equal(
      /require\(["']\.\.\/\.\.\/agent\/orchestrator/.test(text),
      false,
      `${file} should not depend on orchestrator`
    );
  }
}

async function main() {
  testCodexResultAndLogFilter();
  testCodexTimeoutKeepsErrorReadable();
  testCodexUsageLimitIsSurfacedFromStderr();
  testCodexCliArgsStaySandboxed();
  await testShellTool();
  testFilesTool();
  await testBrowserMockToolReturnsEvidence();
  await testWebToolReturnsEvidenceAndBlocksPrivateTargets();
  await testWebToolDefaultsToSingleCurlTransport();
  await testWebToolSurfacesFetchNetworkFailureWithoutTransportFallback();
  await testWebSearchFetchesResultPagesForEvidence();
  await testWebSearchParsesResultsBeyondInitialSearchPageChunk();
  await testWebSearchReadsRelevantLowerRankedResult();
  await testWebSearchFailsWhenOnlyUnreadableResultPagesExist();
  testWebSearchParsesBingRedirectResultLinks();
  await testWebSearchSkipsDictionaryResultsForNonDictionaryQueries();
  await testWebSearchRejectsSingleTokenCountryMatchesForSpecificQueries();
  await testWebSearchReturnsLowConfidenceParsedResultsForVerifier();
  await testWebSearchReportsChallengeWithoutFallback();
  await testWebSearchUsesTavilyProviderEvidence();
  await testWebSearchTavilyFailureDoesNotFallbackToBing();
  await testWebSearchTavilyRequiresConfiguredKey();
  testLargeCsvEvidenceKeepsLatestRows();
  testEvidencePreviewKeepsCsvTail();
  await testCsvFetchPreviewKeepsLatestRows();
  testToolsDoNotDependOnAgentBusinessModules();
  console.log("tools runtime tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
