"use strict";

const browserRuntime = require("./runtime");

function collapseText(value, max = 4000) {
  const text = String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

async function pageSnapshot(page) {
  const startedAt = Date.now();
  try {
    const url = typeof page.url === "function" ? page.url() : "";
    const title = typeof page.title === "function" ? await page.title() : "";
    const pageText = typeof page.textContent === "function" ? collapseText(await page.textContent("body")) : "";
    return {
      ok: true,
      action: "page_snapshot",
      url,
      title,
      pageText,
      durationMs: Date.now() - startedAt,
      error: ""
    };
  } catch (err) {
    return {
      ok: false,
      action: "page_snapshot",
      url: "",
      title: "",
      pageText: "",
      durationMs: Date.now() - startedAt,
      error: err && err.message ? err.message : String(err)
    };
  }
}

module.exports = {
  captureBrowserSnapshot: browserRuntime.captureBrowserSnapshot,
  pageSnapshot
};
