"use strict";

const evidenceNormalizer = require("../evidence");
const codexCliTool = require("../../tools/codex-cli");

function normalizeCodexCliEvidence(result = {}) {
  return evidenceNormalizer.normalizeWorkerEvidence(
    {
      ...result,
      model: "codex-cli",
      output: result.output || result.content || "",
      content: result.content || "",
      actions: result.actions || [],
      context: {
        ...(result.context || {}),
        stdout: result.ok ? result.stdout || "" : "",
        stderr: result.ok ? result.stderr || "" : "",
        model: "codex-cli"
      }
    },
    {
      evidenceSource: evidenceNormalizer.EVIDENCE_SOURCE.CODEX_CLI
    }
  );
}

module.exports = {
  normalizeCodexCliEvidence,
  runCodexCli: codexCliTool.runCodexCli,
  shouldForwardCodexLog: codexCliTool.shouldForwardCodexLog
};
