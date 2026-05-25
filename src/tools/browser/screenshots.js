"use strict";

const filesTool = require("../files");
const browserRuntime = require("./runtime");

async function screenshot(page, options = {}) {
  const startedAt = Date.now();
  const screenshotPath =
    options.path ||
    filesTool.tempFilePath({
      prefix: "agent-route-screenshot",
      suffix: ".png"
    });
  try {
    await page.screenshot({ path: screenshotPath, ...(options.screenshotOptions || {}) });
    const info = filesTool.pathInfo(screenshotPath, { includeHash: true });
    return {
      ok: true,
      action: "screenshot",
      path: screenshotPath,
      screenshotPath,
      size: info.size,
      hash: info.hash || "",
      durationMs: Date.now() - startedAt,
      error: ""
    };
  } catch (err) {
    return {
      ok: false,
      action: "screenshot",
      path: screenshotPath,
      screenshotPath,
      size: -1,
      hash: "",
      durationMs: Date.now() - startedAt,
      error: err && err.message ? err.message : String(err)
    };
  }
}

module.exports = {
  captureBrowserScreenshot: browserRuntime.captureBrowserScreenshot,
  screenshot
};
