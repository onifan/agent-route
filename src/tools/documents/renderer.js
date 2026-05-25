"use strict";

const fs = require("fs");
const path = require("path");
const filesTool = require("../files");
const { agentRoutePath } = require("../../shared/utils/agent-home");

const TEXT_FORMATS = new Set(["md", "markdown", "txt", "text", "html"]);
const SUPPORTED_FORMATS = new Set([...TEXT_FORMATS, "docx", "pdf"]);

function nowIso() {
  return new Date().toISOString();
}

function collapseText(value = "", max = 12000) {
  const text = String(value == null ? "" : value)
    .replace(/\r\n/g, "\n")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function normalizeFormat(value = "md") {
  const text = String(value || "md")
    .trim()
    .toLowerCase()
    .replace(/^\./, "");
  if (text === "markdown") return "md";
  if (text === "text") return "txt";
  if (text === "word") return "docx";
  return SUPPORTED_FORMATS.has(text) ? text : "";
}

function documentOutputDir() {
  return filesTool.ensureDirectory(agentRoutePath("artifacts", "documents"));
}

function safeFileBase(value = "document") {
  const base = String(value || "document")
    .replace(/\.[A-Za-z0-9]+$/, "")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base || "document";
}

function uniquePath(dir, base, ext) {
  filesTool.ensureDirectory(dir);
  const suffix = ext.startsWith(".") ? ext : `.${ext}`;
  let candidate = path.join(dir, `${safeFileBase(base)}${suffix}`);
  if (!fs.existsSync(candidate)) return candidate;
  for (let index = 1; index < 1000; index += 1) {
    candidate = path.join(dir, `${safeFileBase(base)}-${index}${suffix}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${safeFileBase(base)}-${Date.now()}${suffix}`);
}

function escapeHtml(value = "") {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeXml(value = "") {
  return escapeHtml(value).replace(/'/g, "&apos;");
}

function normalizeTitle(title = "", body = "") {
  const explicit = collapseText(title, 160).replace(/\n/g, " ");
  if (explicit) return explicit;
  const heading = String(body || "")
    .split(/\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  return collapseText(heading || "AgentRoute Document", 160).replace(/\n/g, " ");
}

function markdownDocument({ title, body }) {
  const normalizedTitle = normalizeTitle(title, body);
  const content = collapseText(body, 500000);
  if (/^#\s+/m.test(content)) return `${content}\n`;
  return [`# ${normalizedTitle}`, "", content].filter((part) => part !== "").join("\n") + "\n";
}

function textDocument({ title, body }) {
  const normalizedTitle = normalizeTitle(title, body);
  const content = collapseText(body, 500000);
  return [`${normalizedTitle}`, "=".repeat(Math.min(80, normalizedTitle.length || 1)), "", content]
    .filter((part) => part !== "")
    .join("\n");
}

function simpleMarkdownToHtml(value = "") {
  const lines = String(value || "").split(/\n/);
  const out = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = Math.min(4, heading[1].length);
      out.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${escapeHtml(bullet[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${escapeHtml(trimmed)}</p>`);
  }
  closeList();
  return out.join("\n");
}

function htmlDocument({ title, body }) {
  const normalizedTitle = normalizeTitle(title, body);
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8" />',
    `<title>${escapeHtml(normalizedTitle)}</title>`,
    "<style>",
    "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.62;margin:40px auto;max-width:860px;padding:0 24px;color:#1f2937}",
    "h1,h2,h3,h4{line-height:1.25;color:#111827} pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
    "table{border-collapse:collapse;width:100%}td,th{border:1px solid #d1d5db;padding:6px 8px;text-align:left}",
    "</style>",
    "</head>",
    "<body>",
    simpleMarkdownToHtml(markdownDocument({ title: normalizedTitle, body })),
    "</body>",
    "</html>",
    ""
  ].join("\n");
}

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function zipStore(entries = []) {
  const fileRecords = [];
  const centralRecords = [];
  let offset = 0;
  const { dosTime, dosDate } = dosDateTime();

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data || ""), "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    fileRecords.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralRecords.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }

  const centralStart = offset;
  const central = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...fileRecords, central, end]);
}

function docxDocument({ title, body }) {
  const normalizedTitle = normalizeTitle(title, body);
  const paragraphs = markdownDocument({ title: normalizedTitle, body })
    .split(/\n{2,}|\n/)
    .map((line) =>
      line
        .replace(/^#+\s*/, "")
        .replace(/^[-*]\s+/, "• ")
        .trim()
    )
    .filter(Boolean);
  const paragraphXml = paragraphs
    .map((line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`)
    .join("");
  return zipStore([
    {
      name: "[Content_Types].xml",
      data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>'
    },
    {
      name: "_rels/.rels",
      data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>'
    },
    {
      name: "docProps/core.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><dc:title>${escapeXml(normalizedTitle)}</dc:title><dcterms:created>${nowIso()}</dcterms:created></cp:coreProperties>`
    },
    {
      name: "word/document.xml",
      data: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`
    }
  ]);
}

async function pdfDocument({ title, body }, outPath) {
  let playwright = null;
  try {
    playwright = require("playwright-core");
  } catch {
    throw new Error("PDF renderer requires playwright-core and an available Chromium/Chrome channel.");
  }
  const browser = await playwright.chromium.launch({
    headless: true,
    channel: process.env.AGENT_ROUTE_BROWSER_CHANNEL || "chrome",
    timeout: Number(process.env.AGENT_ROUTE_PDF_TIMEOUT_MS || 30000)
  });
  try {
    const page = await browser.newPage();
    await page.setContent(htmlDocument({ title, body }), { waitUntil: "domcontentloaded" });
    await page.pdf({ path: outPath, format: "A4", printBackground: true });
  } finally {
    await browser.close().catch(() => {});
  }
}

function renderContent({ format, title, body }) {
  if (format === "md") return markdownDocument({ title, body });
  if (format === "txt") return textDocument({ title, body });
  if (format === "html") return htmlDocument({ title, body });
  if (format === "docx") return docxDocument({ title, body });
  return null;
}

async function renderDocument({ title = "", body = "", format = "md", fileName = "", outputDir = "" } = {}) {
  const startedAt = Date.now();
  const normalizedFormat = normalizeFormat(format);
  const content = collapseText(body, 500000);
  if (!normalizedFormat) {
    return {
      ok: false,
      error: `Unsupported document format: ${format || "unknown"}`,
      elapsedMs: Date.now() - startedAt
    };
  }
  if (!content || content.length < 8) {
    return { ok: false, error: "Document renderer received no usable content.", elapsedMs: Date.now() - startedAt };
  }
  const dir = outputDir ? path.resolve(String(outputDir)) : documentOutputDir();
  const normalizedTitle = normalizeTitle(title, content);
  const outPath = uniquePath(dir, fileName || normalizedTitle || "document", normalizedFormat);
  const createdAt = nowIso();
  let written;
  try {
    if (normalizedFormat === "pdf") {
      await pdfDocument({ title: normalizedTitle, body: content }, outPath);
      written = filesTool.pathInfo(outPath, { includeHash: true });
    } else {
      const rendered = renderContent({ format: normalizedFormat, title: normalizedTitle, body: content });
      written = TEXT_FORMATS.has(normalizedFormat)
        ? filesTool.writeTextFile(outPath, rendered)
        : filesTool.writeBinaryFile(outPath, rendered);
    }
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err),
      path: outPath,
      format: normalizedFormat,
      elapsedMs: Date.now() - startedAt
    };
  }
  if (!written || !written.ok || !written.size) {
    return {
      ok: false,
      error: (written && written.error) || "Document file was not written.",
      path: outPath,
      format: normalizedFormat,
      elapsedMs: Date.now() - startedAt
    };
  }
  return {
    ok: true,
    format: normalizedFormat,
    title: normalizedTitle,
    path: outPath,
    size: written.size,
    hash: written.hash || "",
    createdAt,
    textPreview: content.slice(0, 1200),
    elapsedMs: Date.now() - startedAt
  };
}

module.exports = {
  documentOutputDir,
  htmlDocument,
  normalizeFormat,
  renderDocument,
  supportedFormats: () => [...SUPPORTED_FORMATS]
};
