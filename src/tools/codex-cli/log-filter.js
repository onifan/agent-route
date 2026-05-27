"use strict";

function shouldForwardCodexLog(log) {
  const value = String((log && log.text) || "").trim();
  if (!value) return false;
  if ((log && log.stream) === "stdout") return true;
  return /(^|\n)(exec\n|codex\n|STATUS:|RESULT:|ERROR:)| succeeded in | failed in |usage limit|failed to connect|timed out|timeout/i.test(
    value
  );
}

module.exports = {
  shouldForwardCodexLog
};
