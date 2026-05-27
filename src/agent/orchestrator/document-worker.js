"use strict";

const documentTool = require("../../tools/documents");
const { safeJsonParse } = require("./content-utils");
const protocol = require("./protocol");

function collapseText(value = "", max = 12000) {
  const text = String(value == null ? "" : value)
    .replace(/\r\n/g, "\n")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isDocumentType(type = "") {
  return /^(document|document_generate|document_render|doc_generate|file_generate|artifact_generate|markdown|md|html_document|docx|pdf|txt)$/i.test(
    String(type || "")
  );
}

function hasDocumentOutputIntent(value = "") {
  const text = String(value || "").toLowerCase();
  const outputVerb = /生成|创建|输出|保存|导出|写成|制作|渲染|create|generate|write|save|export|render|produce/.test(
    text
  );
  const documentNoun =
    /文档|报告文件|文档文件|产物/.test(text) ||
    /\b(?:artifact|document|pdf|docx|word|markdown|html|txt|text)\b/.test(text);
  return outputVerb && documentNoun;
}

function shouldUseDocumentWorker(task = {}) {
  const toolWorker = String(task.toolWorker || task.tool_worker || "").toLowerCase();
  if (toolWorker === "document" || toolWorker === "documents") return true;
  if (isDocumentType(task.type)) return true;
  return false;
}

function formatFromText(value = "") {
  const text = String(value || "").toLowerCase();
  if (/\bdocx\b|\.docx\b|\bword\b|word 文档/.test(text)) return "docx";
  if (/\bpdf\b|\.pdf\b/.test(text)) return "pdf";
  if (/\bhtml?\b|\.html?\b/.test(text)) return "html";
  if (/\bmarkdown\b|\.md\b|\bmd\b/.test(text)) return "md";
  if (/\btxt\b|\.txt\b|纯文本|text file/.test(text)) return "txt";
  return "md";
}

function documentFormat(task = {}) {
  const input = task.input && typeof task.input === "object" && !Array.isArray(task.input) ? task.input : {};
  const direct =
    task.format ||
    task.outputFormat ||
    task.output_format ||
    task.documentFormat ||
    task.document_format ||
    input.format ||
    input.outputFormat ||
    input.output_format ||
    input.documentFormat ||
    input.document_format;
  const normalized = direct ? documentTool.normalizeFormat(direct) : "";
  if (normalized) return normalized;
  return formatFromText([task.type, task.title, task.description, task.prompt, task.input].filter(Boolean).join("\n"));
}

function documentFileName(task = {}) {
  const input = task.input && typeof task.input === "object" && !Array.isArray(task.input) ? task.input : {};
  return String(
    task.fileName ||
      task.file_name ||
      task.outputFile ||
      task.output_file ||
      input.fileName ||
      input.file_name ||
      input.outputFile ||
      input.output_file ||
      task.title ||
      "agent-route-document"
  );
}

function parseWorkerContent(value = "") {
  const parsed = safeJsonParse(value);
  if (!parsed || typeof parsed !== "object") return null;
  return parsed;
}

function workerOutputText(result = {}) {
  const parsed = parseWorkerContent(result.content || result.output || "");
  const output = parsed
    ? parsed.output || parsed.result || parsed.content || parsed.finalAnswer || parsed.final_answer || ""
    : "";
  return collapseText(output || result.output || result.content || result.error || "", 500000);
}

function dependencyIds(task = {}) {
  return new Set(
    []
      .concat(task.dependsOn || task.depends_on || task.dependencies || [])
      .concat(task.consumes || task.requiredArtifacts || task.required_artifacts || [])
      .map((item) => (item && typeof item === "object" ? item.id || item.taskId || item.task_id || item.path : item))
      .filter(Boolean)
      .map(String)
  );
}

function relevantPreviousResults(task = {}, previousResults = []) {
  const ids = dependencyIds(task);
  const successful = previousResults.filter((result) => result && result.ok !== false);
  if (!ids.size) return successful.slice(-4);
  const byTaskOrArtifact = successful.filter((result) => {
    const taskId = String((result.task && result.task.id) || result.taskId || "");
    if (ids.has(taskId)) return true;
    const artifacts = []
      .concat((result.task && result.task.produces) || [])
      .concat(result.artifacts || [])
      .map((item) =>
        item && typeof item === "object" ? item.id || item.name || item.path || item.artifact || item.target : item
      )
      .filter(Boolean)
      .map(String);
    return artifacts.some((id) => ids.has(id));
  });
  return byTaskOrArtifact.length ? byTaskOrArtifact : successful.slice(-4);
}

function explicitContentFromTask(task = {}) {
  const input = task.input;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return collapseText(input.body || input.content || input.markdown || input.text || input.document || "", 500000);
  }
  const parsed = typeof input === "string" ? safeJsonParse(input) : null;
  if (parsed && typeof parsed === "object") {
    return collapseText(
      parsed.body || parsed.content || parsed.markdown || parsed.text || parsed.document || "",
      500000
    );
  }
  return "";
}

function documentBody(task = {}, previousResults = []) {
  const explicit = explicitContentFromTask(task);
  if (explicit) return explicit;
  const inputs = relevantPreviousResults(task, previousResults)
    .map(workerOutputText)
    .filter((item) => item && item.length >= 8);
  return collapseText(inputs.join("\n\n"), 500000);
}

function documentTitle(task = {}, body = "") {
  const input = task.input && typeof task.input === "object" && !Array.isArray(task.input) ? task.input : {};
  return collapseText(input.title || task.documentTitle || task.document_title || task.title || "", 160) || body;
}

function expectedContentPreview(body = "") {
  return (
    String(body || "")
      .split(/\n/)
      .map((line) =>
        line
          .replace(/^#+\s*/, "")
          .replace(/^[-*]\s+/, "")
          .trim()
      )
      .find((line) => line.length >= 4) || ""
  );
}

async function runDocumentWorker(task = {}, config = {}, previousResults = []) {
  const startedAt = Date.now();
  const body = documentBody(task, previousResults);
  const format = documentFormat(task);
  const title = documentTitle(task, body);
  if (!body) {
    const evidence = {
      summary: "Document task has no upstream or explicit content to render.",
      semantic: {
        outputSummary: "Document renderer could not run because no renderable content was supplied.",
        addressesCriteria: false,
        criteriaCoverage: 0,
        qualityScore: 0
      }
    };
    const payload = {
      kind: protocol.KIND.WORKER_RESULT,
      schemaVersion: protocol.PROTOCOL_VERSION,
      status: "failure",
      actions: ["document:missing_content"],
      output: "",
      error: "Document task has no upstream or explicit content to render.",
      nextStep: "Provide upstream content evidence or explicit document body, then retry document generation.",
      artifacts: [],
      evidence,
      memoryCandidates: [],
      riskLevel: "low",
      riskReasons: []
    };
    return {
      task,
      ok: false,
      model: "document-tool",
      content: JSON.stringify(payload),
      error: payload.error,
      elapsedMs: Date.now() - startedAt,
      actions: payload.actions,
      evidence
    };
  }
  const result = await documentTool.renderDocument({
    title,
    body,
    format,
    fileName: documentFileName(task),
    outputDir: config?.tools?.documents?.outputDir || ""
  });
  if (!result.ok) {
    const evidence = {
      summary: result.error || "Document renderer failed.",
      semantic: {
        outputSummary: "Document renderer failed before producing a verified artifact.",
        addressesCriteria: false,
        criteriaCoverage: 0,
        qualityScore: 0
      }
    };
    const payload = {
      kind: protocol.KIND.WORKER_RESULT,
      schemaVersion: protocol.PROTOCOL_VERSION,
      status: "failure",
      actions: ["document:render_failed"],
      output: "",
      error: result.error || "Document renderer failed.",
      nextStep: "Fix the renderer error or choose a supported document format, then retry.",
      artifacts: [],
      evidence,
      memoryCandidates: [],
      riskLevel: "low",
      riskReasons: []
    };
    return {
      task,
      ok: false,
      model: "document-tool",
      content: JSON.stringify(payload),
      error: payload.error,
      elapsedMs: Date.now() - startedAt,
      actions: payload.actions,
      evidence
    };
  }
  const artifact = {
    id: result.path,
    type: "document",
    format: result.format,
    path: result.path,
    size: result.size,
    hash: result.hash,
    status: "created",
    verificationSummary: `Generated ${result.format} document artifact and verified file metadata.`,
    createdAt: result.createdAt
  };
  const payload = {
    kind: protocol.KIND.WORKER_RESULT,
    schemaVersion: protocol.PROTOCOL_VERSION,
    status: "success",
    actions: [`document:render:${result.format}`],
    output: `Generated ${result.format} document artifact: ${result.path}`,
    error: "",
    nextStep: "Verify the artifact path, size, hash, format, and content coverage before finalizing.",
    artifacts: [artifact],
    evidence: {
      summary: `Document artifact created at ${result.path} (${result.format}, ${result.size} bytes, createdAt ${result.createdAt}).`,
      files: [
        {
          path: result.path,
          exists: true,
          afterSize: result.size,
          afterHash: result.hash,
          expectedContent: ["md", "txt", "html"].includes(result.format)
            ? expectedContentPreview(result.textPreview)
            : ""
        }
      ],
      semantic: {
        outputSummary: `Rendered supplied content as ${result.format}.`,
        addressesCriteria: true,
        criteriaCoverage: 1,
        qualityScore: 1
      }
    },
    memoryCandidates: [],
    riskLevel: "low",
    riskReasons: []
  };
  return {
    task,
    ok: true,
    model: "document-tool",
    content: JSON.stringify(payload),
    artifacts: [artifact],
    evidence: payload.evidence,
    elapsedMs: Date.now() - startedAt,
    actions: payload.actions
  };
}

module.exports = {
  documentBody,
  documentFormat,
  hasDocumentOutputIntent,
  runDocumentWorker,
  shouldUseDocumentWorker
};
