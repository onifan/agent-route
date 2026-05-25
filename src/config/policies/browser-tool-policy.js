"use strict";

const DEFAULT_BROWSER_TOOL_POLICY = Object.freeze({
  adapter: "mock",
  allowRealBrowser: false,
  useMockAdapter: true,
  allowMockFallback: true,
  browserType: "chromium",
  headless: true,
  timeoutMs: 30000,
  sessionTtlMs: 10 * 60 * 1000,
  maxTextLength: 4000,
  maxSnapshotBytes: 24000,
  screenshotDir: "",
  snapshotDir: ""
});

module.exports = {
  DEFAULT_BROWSER_TOOL_POLICY
};
