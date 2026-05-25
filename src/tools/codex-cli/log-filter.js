"use strict";

function shouldForwardCodexLog(log) {
  const value = String((log && log.text) || "").trim();
  if (!value) return false;
  if ((log && log.stream) === "stdout") return true;
  return /(^|\n)(exec\n|codex\n|STATUS:|RESULT:)| succeeded in | failed in /i.test(value);
}

module.exports = {
  shouldForwardCodexLog
};
