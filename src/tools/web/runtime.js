"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const { gateToolAction } = require("../../security/tool-risk-gate");

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BODY_CHARS = 120000;
const DEFAULT_TEXT_LIMIT = 6000;
const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_RESULT_SCAN_LIMIT = 8;
const SEARCH_ENDPOINT = "https://www.bing.com/search";
const TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search";
const DEFAULT_ACCEPT_HEADER = "text/html,application/json,text/plain;q=0.9,*/*;q=0.5";
const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; AgentRoute-Studio-WebTool/1.0; +https://localhost/agent-route)";
const SENSITIVE_QUERY_KEYS =
  /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|passwd|pwd|cookie|secret|key|authorization)$/i;
const SEARCH_RELEVANCE_STOPWORDS = new Set([
  "the",
  "and",
  "or",
  "for",
  "from",
  "with",
  "without",
  "into",
  "onto",
  "this",
  "that",
  "these",
  "those",
  "please",
  "must",
  "should",
  "need",
  "needs",
  "using",
  "use",
  "used",
  "real",
  "public",
  "web",
  "online",
  "internet",
  "search",
  "find",
  "lookup",
  "read",
  "fetch",
  "collect",
  "gather",
  "retrieve",
  "query",
  "result",
  "results",
  "source",
  "sources",
  "evidence",
  "url",
  "http",
  "https",
  "status",
  "title",
  "text",
  "body",
  "page",
  "site",
  "api",
  "latest",
  "current",
  "today",
  "now",
  "近期",
  "最新",
  "当前",
  "今天",
  "查询",
  "搜索",
  "检索",
  "读取",
  "获取",
  "收集",
  "公开",
  "网页",
  "网站",
  "来源",
  "证据",
  "标题",
  "正文",
  "状态"
]);
const DICTIONARY_RESULT_PATTERN =
  /\b(dictionary|translate|translation|definition|meaning|pronunciation|thesaurus|vocabulary)\b|词典|字典|翻译|释义|意思|读音|发音/i;
const DICTIONARY_LOOKUP_QUERY_PATTERN =
  /\b(define|definition|meaning|translate|translation|pronounce|pronunciation|synonym|thesaurus|dictionary)\b|什么意思|是什么含义|翻译|释义|读音|发音|同义词/i;
const NON_ENTITY_IDENTIFIERS = new Set(["API", "CSV", "HTML", "HTTP", "HTTPS", "JSON", "PDF", "URL"]);

function collapseText(value, max = DEFAULT_TEXT_LIMIT) {
  const text = String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function evidencePreviewText(value = "", max = 900) {
  const text = String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  const limit = Math.max(200, Number(max || 900));
  if (text.length <= limit) return text;
  if (/\[truncated: keeping latest rows from response tail\]|observation_date,[A-Z0-9_]+/i.test(text)) {
    const head = Math.max(120, Math.floor(limit * 0.35));
    const tail = Math.max(120, limit - head - 40);
    return `${text.slice(0, head)} ...[latest rows preserved]... ${text.slice(-tail)}`;
  }
  return `${text.slice(0, limit)}...`;
}

function redactSensitiveText(value) {
  let text = String(value == null ? "" : value);
  const patterns = [
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|token|password|passwd|pwd|cookie|secret)\b\s*[:=]\s*['"]?[^'"\s]{6,}/gi
  ];
  for (const pattern of patterns) text = text.replace(pattern, "[REDACTED_SECRET]");
  return text;
}

function redactUrl(value = "") {
  const raw = String(value || "");
  try {
    const parsed = new URL(raw);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.test(key)) parsed.searchParams.set(key, "[REDACTED]");
    }
    return parsed.toString();
  } catch {
    return redactSensitiveText(raw);
  }
}

function decodeHtmlEntities(value = "") {
  const named = {
    amp: "&",
    gt: ">",
    lt: "<",
    quot: '"',
    apos: "'",
    nbsp: " "
  };
  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(named, lower)) return named[lower];
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

function stripHtml(value = "") {
  return collapseText(
    decodeHtmlEntities(
      String(value || "")
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<[^>]+>/g, " ")
    )
  );
}

function searchRelevanceTokens(value = "") {
  const prepared = stripHtml(String(value || ""))
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_/\\|:+-]/g, " ")
    .toLowerCase();
  const tokens = [];
  for (const match of prepared.matchAll(/[a-z0-9\u4e00-\u9fa5]+/gi)) {
    const token = match[0];
    if (!token || SEARCH_RELEVANCE_STOPWORDS.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    if (/^[a-z]+$/.test(token) && token.length < 3) continue;
    if (/^[\u4e00-\u9fa5]+$/.test(token) && token.length >= 4) {
      for (let index = 0; index <= token.length - 2; index += 1) {
        const bigram = token.slice(index, index + 2);
        if (!SEARCH_RELEVANCE_STOPWORDS.has(bigram)) tokens.push(bigram);
      }
      continue;
    }
    if (token.length >= 2) tokens.push(token);
  }
  return [...new Set(tokens)].slice(0, 20);
}

function searchResultRelevanceScore(query = "", result = {}) {
  const queryTokens = searchRelevanceTokens(query).slice(0, 12);
  if (!queryTokens.length) return 0;
  const haystack = stripHtml([result.title, result.snippet, result.url].filter(Boolean).join(" ")).toLowerCase();
  if (!haystack) return 0;
  return queryTokens.filter((token) => haystack.includes(token)).length;
}

function minimumSearchRelevanceScore(query = "") {
  const tokens = searchRelevanceTokens(query).slice(0, 12);
  if (tokens.length <= 2) return 1;
  if (tokens.length <= 5) return 2;
  return 3;
}

function isDictionaryLikeSearchResult(query = "", result = {}) {
  if (DICTIONARY_LOOKUP_QUERY_PATTERN.test(String(query || ""))) return false;
  return DICTIONARY_RESULT_PATTERN.test([result.title, result.snippet, result.url].filter(Boolean).join(" "));
}

function isLowRelevanceSearchResult(query = "", result = {}) {
  const tokens = searchRelevanceTokens(query).slice(0, 12);
  if (tokens.length < 2) return false;
  return searchResultRelevanceScore(query, result) < minimumSearchRelevanceScore(query);
}

function missingQueryIdentifiers(query = "", result = {}) {
  const required = [
    ...new Set(
      Array.from(String(query || "").matchAll(/\b[A-Z][A-Z0-9]{1,11}\b/g), (match) => match[0]).filter(
        (token) => !NON_ENTITY_IDENTIFIERS.has(token)
      )
    )
  ];
  if (!required.length) return false;
  const haystack = [result.title, result.snippet, result.url].filter(Boolean).join(" ").toUpperCase();
  return required.some((token) => !haystack.includes(token));
}

function isRejectedSearchResult(query = "", result = {}) {
  return (
    isDictionaryLikeSearchResult(query, result) ||
    isLowRelevanceSearchResult(query, result) ||
    missingQueryIdentifiers(query, result)
  );
}

function prioritizedSearchResults(results = [], query = "", limit = DEFAULT_RESULT_SCAN_LIMIT) {
  return (results || [])
    .filter((result) => !isRejectedSearchResult(query, result))
    .map((result, index) => ({
      result,
      index,
      score: searchResultRelevanceScore(query, result)
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, Math.min(Number(limit || DEFAULT_RESULT_SCAN_LIMIT), results.length)))
    .map((item) => item.result);
}

function looksLikeUnreadableWebPage(value = "") {
  const text = collapseText(value, 2000).toLowerCase();
  if (!text) return false;
  return (
    /\b(access denied|request denied|forbidden|unauthorized|not authorized|rate limit exceeded|captcha required)\b/i.test(
      text
    ) ||
    /\b(oops,?\s+something went wrong|something went wrong|try again later|will be right back|temporarily unavailable|service unavailable|enable javascript|please enable js|disable any ad blocker)\b/i.test(
      text
    ) ||
    /confirm this search was made by a human|select all squares|验证码|人机验证/i.test(text)
  );
}

function limitResponseBody(value = "", max = DEFAULT_MAX_BODY_CHARS, contentType = "") {
  const text = String(value || "");
  const limit = Math.max(1000, Number(max || DEFAULT_MAX_BODY_CHARS));
  if (text.length <= limit) return text;
  if (!/csv|json|text\/plain|application\/xml|text\/xml/i.test(String(contentType || ""))) {
    return text.slice(0, limit);
  }
  const headLimit = Math.min(2000, Math.max(300, Math.floor(limit * 0.2)));
  const tailLimit = Math.max(300, limit - headLimit - 80);
  return `${text.slice(0, headLimit)}\n...[truncated: keeping latest rows from response tail]...\n${text.slice(-tailLimit)}`;
}

function extractTitle(value = "") {
  const match = String(value || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? collapseText(decodeHtmlEntities(match[1]), 240) : "";
}

function responseHeaders(response) {
  const headers = {};
  if (!response || !response.headers || typeof response.headers.forEach !== "function") return headers;
  response.headers.forEach((value, key) => {
    headers[String(key).toLowerCase()] = String(value);
  });
  return headers;
}

function abortController(timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs || DEFAULT_TIMEOUT_MS)));
  return { controller, timeout };
}

function requestHeaders() {
  return {
    Accept: DEFAULT_ACCEPT_HEADER,
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": DEFAULT_USER_AGENT
  };
}

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return String(value).trim();
  }
  return "";
}

function tavilyApiKey(options = {}) {
  return String(
    options.tavilyApiKey ||
      options.tavily_api_key ||
      options.apiKey ||
      options.api_key ||
      envValue("TAVILY_API_KEY", "AGENT_ROUTE_TAVILY_API_KEY")
  ).trim();
}

function normalizeSearchProvider(value = "") {
  const provider = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (["tavily", "tavily-api"].includes(provider)) return "tavily";
  if (["bing", "bing-html", "html"].includes(provider)) return "bing-html";
  return "";
}

function searchProvider(options = {}) {
  const explicit = normalizeSearchProvider(
    options.searchProvider ||
      options.search_provider ||
      options.provider ||
      envValue("AGENT_ROUTE_WEB_SEARCH_PROVIDER", "WEB_SEARCH_PROVIDER")
  );
  if (explicit) return explicit;
  return tavilyApiKey(options) ? "tavily" : "bing-html";
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(Math.floor(number), max));
}

function enumOption(value, allowed = [], fallback = "") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function shouldUseFetchTransport(options = {}) {
  const explicitTransport = enumOption(
    options.transport || process.env.AGENT_ROUTE_WEB_TRANSPORT,
    ["fetch", "curl"],
    ""
  );
  if (explicitTransport) return explicitTransport === "fetch";
  if (typeof options.fetchImpl === "function") return true;
  return false;
}

function parseCurlHeaderBlock(rawHeaders = "") {
  const blocks = String(rawHeaders || "")
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const block = blocks[blocks.length - 1] || "";
  const lines = block.split(/\r?\n/).filter(Boolean);
  const statusLine = lines.find((line) => /^HTTP\//i.test(line)) || "";
  const statusMatch = statusLine.match(/^HTTP\/\S+\s+(\d{3})\s*(.*)$/i);
  const headers = {};
  for (const line of lines) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return {
    status: statusMatch ? Number(statusMatch[1]) : 0,
    statusText: statusMatch ? statusMatch[2] || "" : "",
    headers
  };
}

async function readUrlWithFetch(url, options = {}) {
  const { controller, timeout } = abortController(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== "function") throw new Error("fetch transport is unavailable");
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: requestHeaders()
    });
    return {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response),
      body: await response.text()
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function postJsonWithFetch(url, payload, headers = {}, options = {}) {
  const { controller, timeout } = abortController(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== "function") throw new Error("fetch transport is unavailable");
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": DEFAULT_USER_AGENT,
        ...headers
      },
      body: JSON.stringify(payload)
    });
    return {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response),
      body: await response.text()
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readUrlWithCurl(url, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const connectTimeoutSeconds = Math.max(1, Math.min(10, timeoutSeconds));
  const headerDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-route-web-"));
  const headerPath = path.join(headerDir, "headers.txt");
  const maxBuffer = Math.max(
    1024 * 1024,
    Number(options.maxBufferBytes || 0),
    Number(options.maxBodyChars || DEFAULT_MAX_BODY_CHARS) + 512 * 1024
  );
  try {
    const runCurl = options.curlImpl || execFileAsync;
    const { stdout, stderr } = await runCurl(
      "curl",
      [
        "--location",
        "--silent",
        "--show-error",
        "--max-time",
        String(timeoutSeconds),
        "--connect-timeout",
        String(connectTimeoutSeconds),
        "--compressed",
        "--user-agent",
        DEFAULT_USER_AGENT,
        "--header",
        `Accept: ${DEFAULT_ACCEPT_HEADER}`,
        "--header",
        "Accept-Language: en-US,en;q=0.9",
        "--dump-header",
        headerPath,
        "--output",
        "-",
        url
      ],
      { timeout: timeoutMs + 1000, maxBuffer }
    );
    const parsed = parseCurlHeaderBlock(fs.existsSync(headerPath) ? fs.readFileSync(headerPath, "utf8") : "");
    if (!parsed.status) throw new Error(stderr || "curl did not return HTTP response headers");
    return {
      status: parsed.status,
      statusText: parsed.statusText,
      headers: parsed.headers,
      body: stdout
    };
  } catch (err) {
    const message = err && err.stderr ? err.stderr : err && err.message ? err.message : String(err);
    throw new Error(redactSensitiveText(String(message).trim() || "curl transport failed"));
  } finally {
    try {
      if (fs.existsSync(headerPath)) fs.unlinkSync(headerPath);
      fs.rmdirSync(headerDir);
    } catch {
      // Best-effort cleanup of temporary response header file.
    }
  }
}

async function readPublicUrl(url, options = {}) {
  const useFetch = shouldUseFetchTransport(options);
  const transport = useFetch ? "fetch" : "curl";
  const readUrl = useFetch ? readUrlWithFetch : readUrlWithCurl;
  try {
    return await readUrl(url, options);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    throw new Error(redactSensitiveText(`${transport} transport failed: ${message}`));
  }
}

function webEvidence({ action, url, status, title, textPreview, bodyPreview, contentType, ok, error = "" }) {
  const safeUrl = redactUrl(url);
  const timestamp = new Date().toISOString();
  const browser = {
    type: "browser",
    evidenceSource: "web-tool",
    action,
    detectedActionType: "read_page",
    url: safeUrl,
    currentUrl: safeUrl,
    afterUrl: safeUrl,
    title,
    pageText: textPreview,
    textPreview,
    ok: Boolean(ok),
    errorMessage: error,
    timestamp,
    confidence: textPreview || title ? 0.75 : 0.45,
    metadata: {
      status,
      contentType,
      readOnly: true,
      tool: "web"
    }
  };
  return {
    summary: collapseText([title, textPreview].filter(Boolean).join(" - "), 1200),
    claims: [safeUrl, status ? `HTTP ${status}` : "", title ? `Title: ${title}` : ""].filter(Boolean),
    actions: [{ type: "web", action, target: safeUrl, description: "Read public web content." }],
    browser,
    browserEvidence: [browser],
    normalizedEvidence: { browser: [browser] },
    apiResponses: [
      {
        method: "GET",
        url: safeUrl,
        status,
        ok: Boolean(ok),
        body: bodyPreview || textPreview,
        error
      }
    ],
    semantic: {
      outputSummary: collapseText(textPreview || bodyPreview || error, 2000),
      addressesCriteria: Boolean(ok && (textPreview || bodyPreview)),
      criteriaCoverage: ok && (textPreview || bodyPreview) ? 0.8 : 0.2,
      qualityScore: ok && (textPreview || bodyPreview) ? 0.75 : 0.25,
      qualityIssues: ok ? [] : [error || "Web tool did not receive readable content."]
    }
  };
}

async function fetchWebUrl(url, options = {}) {
  const startedAt = Date.now();
  const safeUrl = redactUrl(url);
  const gate = gateToolAction({
    tool: "web",
    action: "web_fetch",
    url,
    actionSummary: `Read public URL ${safeUrl}`,
    approvalStatus: options.approvalStatus || options.approval_status,
    approved: options.approved === true || options.humanApproved === true
  });
  if (!gate.allowed) {
    return {
      ok: false,
      blocked: true,
      action: "web_fetch",
      url: safeUrl,
      status: 0,
      title: "",
      textPreview: "",
      bodyPreview: "",
      error: gate.error || "Web fetch blocked by risk gate.",
      riskLevel: gate.riskLevel,
      reasons: gate.reasons || [],
      requiredApproval: gate.requiredApproval === true,
      elapsedMs: Date.now() - startedAt,
      evidence: webEvidence({
        action: "web_fetch",
        url: safeUrl,
        status: 0,
        title: "",
        textPreview: "",
        bodyPreview: "",
        contentType: "",
        ok: false,
        error: gate.error || "Web fetch blocked by risk gate."
      })
    };
  }
  try {
    const response = await readPublicUrl(url, options);
    const responseOk = response.status >= 200 && response.status < 300;
    const headers = response.headers || {};
    const contentType = headers["content-type"] || "";
    const rawBody = response.body || "";
    const limitedBody = limitResponseBody(rawBody, Number(options.maxBodyChars || DEFAULT_MAX_BODY_CHARS), contentType);
    const redactedBody = redactSensitiveText(limitedBody);
    const title = /html/i.test(contentType) || /<html|<title/i.test(redactedBody) ? extractTitle(redactedBody) : "";
    const readableText =
      /html/i.test(contentType) || /<html|<title/i.test(redactedBody) ? stripHtml(redactedBody) : redactedBody;
    const previewLimit = Number(options.textLimit || DEFAULT_TEXT_LIMIT);
    const bodyLimit = Number(options.bodyLimit || DEFAULT_TEXT_LIMIT);
    const textPreview = /csv|json|text\/plain|application\/xml|text\/xml/i.test(contentType)
      ? limitResponseBody(readableText, previewLimit, contentType)
      : collapseText(readableText, previewLimit);
    const bodyPreview = /csv|json|text\/plain|application\/xml|text\/xml/i.test(contentType)
      ? limitResponseBody(redactedBody, bodyLimit, contentType)
      : collapseText(redactedBody, bodyLimit);
    const unreadable = responseOk && looksLikeUnreadableWebPage([title, textPreview].filter(Boolean).join(" "));
    return {
      ok: Boolean(responseOk && (textPreview || bodyPreview) && !unreadable),
      action: "web_fetch",
      url: safeUrl,
      status: response.status,
      statusText: response.statusText,
      title,
      contentType,
      textPreview,
      bodyPreview,
      elapsedMs: Date.now() - startedAt,
      evidence: webEvidence({
        action: "web_fetch",
        url: safeUrl,
        status: response.status,
        title,
        textPreview,
        bodyPreview,
        contentType,
        ok: responseOk && !unreadable,
        error: unreadable ? "Readable content check failed." : responseOk ? "" : `HTTP ${response.status}`
      }),
      error: unreadable
        ? "Readable content check failed."
        : responseOk
          ? ""
          : `HTTP ${response.status} ${response.statusText || ""}`.trim()
    };
  } catch (err) {
    const message =
      err && err.name === "AbortError" ? "Web fetch timed out." : err && err.message ? err.message : String(err);
    return {
      ok: false,
      action: "web_fetch",
      url: safeUrl,
      status: 0,
      title: "",
      textPreview: "",
      bodyPreview: "",
      error: redactSensitiveText(message),
      elapsedMs: Date.now() - startedAt,
      evidence: webEvidence({
        action: "web_fetch",
        url: safeUrl,
        status: 0,
        title: "",
        textPreview: "",
        bodyPreview: "",
        contentType: "",
        ok: false,
        error: redactSensitiveText(message)
      })
    };
  }
}

function decodeResultUrl(value = "") {
  const href = decodeHtmlEntities(String(value || "").trim());
  if (!href) return "";
  try {
    const parsed = new URL(href, SEARCH_ENDPOINT);
    const duckTarget = parsed.searchParams.get("uddg");
    if (duckTarget) return redactUrl(decodeURIComponent(duckTarget));
    const bingTarget = decodeBingRedirectTarget(parsed.searchParams.get("u"));
    if (bingTarget) return redactUrl(bingTarget);
    return redactUrl(parsed.href);
  } catch {
    return redactUrl(href);
  }
}

function decodeBingRedirectTarget(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const candidates = [raw];
  if (/^a\d/i.test(raw)) candidates.push(raw.slice(2));
  for (const candidate of candidates) {
    try {
      const normalized = candidate.replace(/-/g, "+").replace(/_/g, "/");
      const padded = `${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`;
      const decoded = Buffer.from(padded, "base64").toString("utf8").trim();
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch {
      // Continue with the next generic redirect decoding strategy.
    }
  }
  return "";
}

function addSearchResult(results, result, limit) {
  if (!result || results.length >= limit) return;
  const title = collapseText(result.title, 240);
  const url = decodeResultUrl(result.url);
  if (!url || !title || /(?:^https?:\/\/(?:www\.)?(?:bing|duckduckgo)\.com(?:\/|$))/i.test(url)) return;
  if (results.some((item) => item.url === url)) return;
  results.push({
    title,
    url,
    snippet: collapseText(result.snippet || "", 500)
  });
}

function parseSearchResults(html = "", limit = DEFAULT_SEARCH_LIMIT) {
  const results = [];
  const bingBlockPattern = /<li\b[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  while ((match = bingBlockPattern.exec(html)) && results.length < limit) {
    const block = match[1] || "";
    const titleAnchor =
      block.match(/<h2\b[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i) ||
      block.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!titleAnchor) continue;
    const snippet = (block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || "";
    addSearchResult(
      results,
      {
        url: titleAnchor[1],
        title: stripHtml(titleAnchor[2]),
        snippet: stripHtml(snippet)
      },
      limit
    );
  }
  if (results.length) return results;
  const anchorPattern =
    /<a\b[^>]*class=["'][^"']*(?:result__a|result-link)[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = anchorPattern.exec(html)) && results.length < limit) {
    addSearchResult(results, { url: match[1], title: stripHtml(match[2]) }, limit);
  }
  if (results.length) return results;
  const genericAnchorPattern = /<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = genericAnchorPattern.exec(html)) && results.length < limit) {
    addSearchResult(results, { url: match[1], title: stripHtml(match[2]) }, limit);
  }
  return results;
}

function tavilyRawContentOption(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "includeRawContent")) return options.includeRawContent;
  if (Object.prototype.hasOwnProperty.call(options, "include_raw_content")) return options.include_raw_content;
  return false;
}

function tavilyPayload(query = "", options = {}) {
  const payload = {
    query,
    max_results: clampInteger(options.maxResults ?? options.max_results ?? options.limit, DEFAULT_SEARCH_LIMIT, 1, 20),
    search_depth: enumOption(options.searchDepth || options.search_depth, ["basic", "advanced"], "basic"),
    include_answer: false,
    include_images: false,
    include_raw_content: tavilyRawContentOption(options)
  };
  const topic = enumOption(options.topic || options.searchTopic || options.search_topic, [
    "general",
    "news",
    "finance"
  ]);
  if (topic) payload.topic = topic;
  const timeRange = enumOption(options.timeRange || options.time_range, [
    "day",
    "week",
    "month",
    "year",
    "d",
    "w",
    "m",
    "y"
  ]);
  if (timeRange) payload.time_range = timeRange;
  const days = clampInteger(options.days, 0, 1, 365);
  if (days > 0) payload.days = days;
  if (Array.isArray(options.includeDomains || options.include_domains)) {
    payload.include_domains = (options.includeDomains || options.include_domains)
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 20);
  }
  if (Array.isArray(options.excludeDomains || options.exclude_domains)) {
    payload.exclude_domains = (options.excludeDomains || options.exclude_domains)
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 20);
  }
  return payload;
}

function tavilyResultText(result = {}) {
  return collapseText(
    [
      result.content,
      result.raw_content,
      result.rawContent,
      result.snippet,
      Array.isArray(result.chunks) ? result.chunks.join(" ") : ""
    ]
      .filter(Boolean)
      .join(" "),
    DEFAULT_TEXT_LIMIT
  );
}

function normalizeTavilyResults(results = []) {
  const seen = new Set();
  const normalized = [];
  for (const result of Array.isArray(results) ? results : []) {
    const url = redactUrl(result && result.url);
    const key = url.toLowerCase();
    if (!url || seen.has(key)) continue;
    seen.add(key);
    const text = tavilyResultText(result);
    normalized.push({
      title: collapseText((result && result.title) || url, 240),
      url,
      snippet: collapseText((result && result.content) || text, 500),
      score: Number.isFinite(Number(result && result.score)) ? Number(result.score) : null,
      fetched: {
        ok: Boolean(text),
        status: 200,
        title: collapseText((result && result.title) || url, 240),
        textPreview: collapseText(text, 2200),
        error: text ? "" : "Tavily result did not include readable content."
      }
    });
  }
  return normalized;
}

function tavilyEvidence({
  query,
  status,
  statusText = "",
  results = [],
  payload = {},
  bodyPreview = "",
  error = "",
  requestId = ""
}) {
  const timestamp = new Date().toISOString();
  const browserEvidence = results.map((result) => ({
    type: "browser",
    evidenceSource: "web-tool",
    action: "web_search",
    detectedActionType: "read_page",
    url: result.url,
    currentUrl: result.url,
    afterUrl: result.url,
    title: result.title,
    pageText: result.fetched.textPreview,
    textPreview: result.fetched.textPreview,
    ok: result.fetched.ok,
    errorMessage: result.fetched.error,
    timestamp,
    confidence: result.score == null ? 0.72 : Math.max(0.3, Math.min(0.95, result.score)),
    query,
    evidenceRole: "search_result_page",
    metadata: {
      provider: "tavily",
      providerStatus: status,
      requestId,
      score: result.score,
      readOnly: true,
      tool: "web"
    }
  }));
  const apiResponses = [
    {
      method: "POST",
      url: TAVILY_SEARCH_ENDPOINT,
      status,
      ok: status >= 200 && status < 300,
      body: bodyPreview,
      error,
      query,
      evidenceRole: "search_api",
      provider: "tavily"
    },
    ...results.map((result) => ({
      method: "SEARCH_RESULT",
      url: result.url,
      status,
      ok: result.fetched.ok,
      body: result.fetched.textPreview,
      error: result.fetched.error,
      query,
      evidenceRole: "search_result_page",
      provider: "tavily",
      providerStatus: status,
      sourceStatus: null
    }))
  ];
  const output = results
    .map((result, index) =>
      [
        `${index + 1}. ${result.title}`,
        result.url,
        result.score == null ? "" : `Score: ${result.score}`,
        result.fetched.textPreview ? `Evidence: ${evidencePreviewText(result.fetched.textPreview, 900)}` : ""
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");
  const ok = status >= 200 && status < 300 && results.some((result) => result.fetched.ok);
  return {
    summary: collapseText(output || error || bodyPreview, 1200),
    claims: results.map((result) => `${result.title} - ${result.url}`).slice(0, 20),
    actions: [
      {
        type: "web",
        action: "web_search",
        target: query,
        description: "Search public web through configured Tavily provider."
      }
    ],
    browserEvidence,
    normalizedEvidence: { browser: browserEvidence },
    apiResponses,
    semantic: {
      outputSummary: collapseText(output || bodyPreview || error, 2000),
      addressesCriteria: ok,
      criteriaCoverage: ok ? 0.8 : 0.2,
      qualityScore: ok ? 0.78 : 0.25,
      qualityNotes: [],
      qualityIssues: ok ? [] : [error || "Tavily search returned no readable result evidence."]
    },
    metadata: {
      provider: "tavily",
      providerStatus: status,
      statusText,
      requestId,
      request: {
        max_results: payload.max_results,
        search_depth: payload.search_depth,
        topic: payload.topic || "",
        time_range: payload.time_range || ""
      }
    }
  };
}

async function searchWebWithTavily(normalizedQuery, options = {}, startedAt = Date.now()) {
  const apiKey = tavilyApiKey(options);
  if (!apiKey) {
    const error = "Tavily web search provider is selected but TAVILY_API_KEY is not configured.";
    const evidence = tavilyEvidence({
      query: normalizedQuery,
      status: 0,
      results: [],
      payload: {},
      error
    });
    return {
      ok: false,
      action: "web_search",
      provider: "tavily",
      query: normalizedQuery,
      url: TAVILY_SEARCH_ENDPOINT,
      status: 0,
      title: "Tavily public web search results",
      results: [],
      textPreview: "",
      bodyPreview: "",
      elapsedMs: Date.now() - startedAt,
      evidence,
      error
    };
  }
  const payload = tavilyPayload(normalizedQuery, options);
  try {
    const response = await postJsonWithFetch(
      TAVILY_SEARCH_ENDPOINT,
      payload,
      { Authorization: `Bearer ${apiKey}` },
      { ...options, timeoutMs: Number(options.timeoutMs || 10000) }
    );
    const responseOk = response.status >= 200 && response.status < 300;
    const bodyText = redactSensitiveText(response.body || "");
    let body = {};
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      body = {};
    }
    const results = responseOk ? normalizeTavilyResults(body.results || []) : [];
    const bodyPreview = collapseText(
      JSON.stringify({
        query: body.query || normalizedQuery,
        request_id: body.request_id || body.requestId || "",
        results: results.map((result) => ({
          title: result.title,
          url: result.url,
          score: result.score,
          textPreview: result.fetched.textPreview
        })),
        error: responseOk ? "" : body.error || body.detail || body.message || bodyText
      }),
      8000
    );
    const error = responseOk
      ? results.some((result) => result.fetched.ok)
        ? ""
        : "Tavily search returned no readable result evidence."
      : `Tavily search failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`;
    const evidence = tavilyEvidence({
      query: normalizedQuery,
      status: response.status,
      statusText: response.statusText,
      results,
      payload,
      bodyPreview,
      error,
      requestId: body.request_id || body.requestId || ""
    });
    return {
      ok: responseOk && results.some((result) => result.fetched.ok),
      action: "web_search",
      provider: "tavily",
      query: normalizedQuery,
      url: TAVILY_SEARCH_ENDPOINT,
      status: response.status,
      title: "Tavily public web search results",
      results,
      textPreview: evidence.summary,
      bodyPreview,
      elapsedMs: Date.now() - startedAt,
      evidence,
      error
    };
  } catch (err) {
    const error = redactSensitiveText(err && err.message ? err.message : String(err));
    const evidence = tavilyEvidence({
      query: normalizedQuery,
      status: 0,
      results: [],
      payload,
      error
    });
    return {
      ok: false,
      action: "web_search",
      provider: "tavily",
      query: normalizedQuery,
      url: TAVILY_SEARCH_ENDPOINT,
      status: 0,
      title: "Tavily public web search results",
      results: [],
      textPreview: "",
      bodyPreview: "",
      elapsedMs: Date.now() - startedAt,
      evidence,
      error
    };
  }
}

async function searchWebWithBingHtml(normalizedQuery, options = {}, startedAt = Date.now()) {
  const searchUrl = `${SEARCH_ENDPOINT}?q=${encodeURIComponent(normalizedQuery)}&cc=us&mkt=en-US&setlang=en-US&ensearch=1`;
  const fetched = await fetchWebUrl(searchUrl, {
    ...options,
    textLimit: Math.max(Number(options.textLimit || DEFAULT_TEXT_LIMIT), 12000),
    bodyLimit: Math.max(Number(options.bodyLimit || DEFAULT_TEXT_LIMIT), 120000)
  });
  const parsedResults = fetched.ok
    ? parseSearchResults(fetched.bodyPreview || fetched.textPreview, options.limit || DEFAULT_SEARCH_LIMIT)
    : [];
  const relevantResults = parsedResults.filter((result) => !isRejectedSearchResult(normalizedQuery, result));
  const relevanceRelaxed = parsedResults.length > 0 && relevantResults.length === 0;
  const results = relevanceRelaxed ? parsedResults : relevantResults;
  const resultFetchLimit = Math.max(0, Math.min(Number(options.resultFetchLimit ?? 3), results.length, 5));
  const resultScanLimit = Math.max(
    resultFetchLimit,
    Math.min(Number(options.resultScanLimit ?? DEFAULT_RESULT_SCAN_LIMIT), results.length)
  );
  const fetchedPages = [];
  const scanCandidates = relevanceRelaxed
    ? results.slice(0, resultScanLimit)
    : prioritizedSearchResults(results, normalizedQuery, resultScanLimit);
  for (const item of scanCandidates) {
    if (resultFetchLimit > 0 && fetchedPages.filter((page) => page.ok).length >= resultFetchLimit) break;
    const page = await fetchWebUrl(item.url, {
      ...options,
      timeoutMs: Math.min(Number(options.timeoutMs || DEFAULT_TIMEOUT_MS), 8000),
      textLimit: Math.min(Number(options.textLimit || DEFAULT_TEXT_LIMIT), 2200),
      bodyLimit: Math.min(Number(options.bodyLimit || DEFAULT_TEXT_LIMIT), 2200)
    });
    fetchedPages.push({
      url: item.url,
      ok: page.ok,
      status: page.status || 0,
      title: page.title || item.title || "",
      textPreview: page.textPreview || "",
      error: page.error || "",
      evidence: page.evidence || {}
    });
  }
  const noReadableResultPages = resultFetchLimit > 0 && results.length > 0 && !fetchedPages.some((page) => page.ok);
  const enrichedResults = results.map((item) => {
    const page = fetchedPages.find((candidate) => candidate.url === item.url);
    return page
      ? {
          ...item,
          fetched: {
            ok: page.ok,
            status: page.status,
            title: page.title,
            textPreview: page.textPreview,
            error: page.error
          }
        }
      : item;
  });
  const searchOutput = enrichedResults
    .map((item, index) =>
      [
        `${index + 1}. ${item.title}`,
        item.url,
        item.fetched && item.fetched.status ? `HTTP ${item.fetched.status}` : "",
        item.fetched && item.fetched.title && item.fetched.title !== item.title
          ? `Page title: ${item.fetched.title}`
          : "",
        item.fetched && item.fetched.textPreview
          ? `Evidence: ${evidencePreviewText(item.fetched.textPreview, 900)}`
          : ""
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");
  const output = searchOutput;
  const fetchedApiResponses = fetchedPages.flatMap((item) =>
    item.evidence && Array.isArray(item.evidence.apiResponses)
      ? item.evidence.apiResponses.map((response) => ({
          ...response,
          query: normalizedQuery,
          evidenceRole: "search_result_page"
        }))
      : []
  );
  const fetchedBrowserEvidence = fetchedPages.flatMap((item) =>
    item.evidence && Array.isArray(item.evidence.browserEvidence)
      ? item.evidence.browserEvidence.map((evidenceItem) => ({
          ...evidenceItem,
          query: normalizedQuery,
          evidenceRole: "search_result_page"
        }))
      : []
  );
  const includeSearchPageEvidence = false;
  const searchApiResponses =
    includeSearchPageEvidence && Array.isArray(fetched.evidence.apiResponses)
      ? fetched.evidence.apiResponses.map((response) => ({
          ...response,
          query: normalizedQuery,
          evidenceRole: "search_page"
        }))
      : [];
  const searchBrowserEvidence =
    includeSearchPageEvidence && Array.isArray(fetched.evidence.browserEvidence)
      ? fetched.evidence.browserEvidence.map((evidenceItem) => ({
          ...evidenceItem,
          query: normalizedQuery,
          evidenceRole: "search_page"
        }))
      : [];
  const evidence = {
    ...(fetched.evidence || {}),
    summary: collapseText(output || fetched.error || fetched.textPreview, 1200),
    claims: enrichedResults.map((item) => `${item.title} - ${item.url}`).slice(0, 20),
    actions: [
      {
        type: "web",
        action: "web_search",
        target: redactUrl(searchUrl),
        description: "Search public web."
      }
    ],
    browserEvidence: [...searchBrowserEvidence, ...fetchedBrowserEvidence],
    normalizedEvidence: {
      browser: [...searchBrowserEvidence, ...fetchedBrowserEvidence]
    },
    apiResponses: [...searchApiResponses, ...fetchedApiResponses],
    semantic: {
      outputSummary: collapseText(output || fetched.textPreview || fetched.error, 2000),
      addressesCriteria: results.length > 0 && !noReadableResultPages,
      criteriaCoverage: results.length > 0 && !noReadableResultPages ? 0.8 : 0.2,
      qualityScore: results.length > 0 && !noReadableResultPages ? 0.78 : 0.25,
      qualityNotes: relevanceRelaxed
        ? ["Parsed result links were all low-confidence for the query; returned candidates for verifier judgment."]
        : [],
      qualityIssues: !parsedResults.length
        ? ["Search returned no parseable result links."]
        : noReadableResultPages
          ? ["Search result links were found, but no readable result page evidence was captured."]
          : []
    }
  };
  return {
    ok: results.length > 0 && !noReadableResultPages,
    action: "web_search",
    query: normalizedQuery,
    url: redactUrl(searchUrl),
    status: fetched.status || 0,
    title: "Public web search results",
    results: enrichedResults,
    textPreview: output || fetched.textPreview || "",
    bodyPreview: fetched.bodyPreview || "",
    elapsedMs: Date.now() - startedAt,
    evidence,
    error: !parsedResults.length
      ? fetched.error || "Web search returned no parseable results."
      : noReadableResultPages
        ? "Search returned result links, but no readable result page evidence was captured."
        : ""
  };
}

async function searchWeb(query, options = {}) {
  const startedAt = Date.now();
  const normalizedQuery = collapseText(query, 500);
  const gate = gateToolAction({
    tool: "web",
    action: "web_search",
    query: normalizedQuery,
    actionSummary: `Search public web for ${normalizedQuery}`,
    approvalStatus: options.approvalStatus || options.approval_status,
    approved: options.approved === true || options.humanApproved === true
  });
  if (!gate.allowed) {
    return {
      ok: false,
      blocked: true,
      action: "web_search",
      query: normalizedQuery,
      results: [],
      error: gate.error || "Web search blocked by risk gate.",
      riskLevel: gate.riskLevel,
      reasons: gate.reasons || [],
      requiredApproval: gate.requiredApproval === true,
      elapsedMs: Date.now() - startedAt,
      evidence: {
        summary: gate.error || "Web search blocked by risk gate.",
        actions: [{ type: "web", action: "web_search", description: "Search was blocked by risk gate." }],
        apiResponses: []
      }
    };
  }
  const provider = searchProvider(options);
  if (provider === "tavily") return searchWebWithTavily(normalizedQuery, options, startedAt);
  return searchWebWithBingHtml(normalizedQuery, options, startedAt);
}

module.exports = {
  collapseText,
  decodeHtmlEntities,
  evidencePreviewText,
  fetchWebUrl,
  limitResponseBody,
  looksLikeUnreadableWebPage,
  normalizeSearchProvider,
  parseSearchResults,
  prioritizedSearchResults,
  redactSensitiveText,
  redactUrl,
  searchRelevanceTokens,
  searchResultRelevanceScore,
  searchProvider,
  searchWeb,
  searchWebWithTavily,
  stripHtml
};
