"use strict";

const EVIDENCE_SOURCE = Object.freeze({
  BROWSER_TOOL: "browser-tool",
  CODEX_CLI: "codex-cli",
  WORKER: "worker",
  PLAYWRIGHT: "playwright",
  MOCK: "mock"
});

const BROWSER_ACTION_TYPE = Object.freeze({
  READ_PAGE: "read_page",
  NAVIGATE: "navigate",
  CLICK: "click",
  FILL_INPUT: "fill_input",
  SCROLL: "scroll",
  SCREENSHOT: "screenshot",
  SNAPSHOT: "snapshot",
  SUBMIT_LIKE_CLICK: "submit_like_click",
  DELETE_LIKE_CLICK: "delete_like_click",
  PAYMENT_LIKE_CLICK: "payment_like_click",
  LOGIN_LIKE_ACTION: "login_like_action",
  DOWNLOAD: "download",
  UPLOAD: "upload",
  UNKNOWN: "unknown"
});

module.exports = {
  BROWSER_ACTION_TYPE,
  EVIDENCE_SOURCE
};
