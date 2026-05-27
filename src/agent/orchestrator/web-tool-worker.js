"use strict";

const webTool = require("../../tools/web");
const protocol = require("./protocol");
const { lastUserText, messagesToText } = require("./content-utils");

function collapseText(value, max = 4000) {
  const text = String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function taskText(task = {}, messages = []) {
  return [task.input, task.prompt, task.description, task.title, messagesToText(messages)].filter(Boolean).join("\n");
}

function cleanUrl(value = "") {
  return String(value || "").replace(/[)\]}'"。，、；;,.!?！？]+$/g, "");
}

function extractPublicHttpUrl(value = "") {
  return extractPublicHttpUrls(value, 1)[0] || "";
}

function extractPublicHttpUrls(value = "", limit = 5) {
  const seen = new Set();
  const urls = [];
  const matches = String(value || "").match(/\bhttps?:\/\/[^\s"'<>()[\]{}，。；、！？：]+/gi) || [];
  for (const match of matches) {
    const url = cleanUrl(match);
    const key = url.toLowerCase();
    if (!isPublicHttpUrl(url) || seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
    if (urls.length >= limit) break;
  }
  return urls;
}

function isPrivateHost(hostname = "") {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host.startsWith("127.")) return true;
  if (host.startsWith("10.") || host.startsWith("192.168.")) return true;
  const octets = host.split(".").map((part) => Number(part));
  return (
    octets.length === 4 &&
    octets.every((part) => Number.isInteger(part)) &&
    ((octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 169 && octets[1] === 254))
  );
}

function isPublicHttpUrl(value = "") {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol) && !isPrivateHost(parsed.hostname);
  } catch {
    return false;
  }
}

function stripNegatedHighRiskText(value = "") {
  return String(value || "")
    .replace(
      /(?:不要|不允许|禁止|不得|请勿|do not|don't|never)[^。.;\n]*(?:提交|发送|付款|支付|登录|上传|删除|发布|修改|写入|submit|send|pay|login|upload|delete|publish|modify|write)[^。.;\n]*/gi,
      " "
    )
    .replace(
      /(?:涉及|如需|如果|when|if)[^。.;\n]{0,100}(?:提交|发送|付款|支付|登录|上传|submit|send|pay|login|upload)[^。.;\n]{0,100}(?:人工确认|human approval|human confirmation|manual approval|manual review)/gi,
      " "
    );
}

function hasHighRiskWebAction(value = "") {
  const text = stripBenignPublishMetadata(stripNegatedHighRiskText(value).toLowerCase());
  return /(submit|send|pay|payment|login|upload|delete|publish|checkout|purchase|提交|发送|付款|支付|登录|上传|删除|发布(?!时间|日期|于|在|源|者|物)|购买)/i.test(
    text
  );
}

function stripBenignPublishMetadata(value = "") {
  return String(value || "")
    .replace(
      /发布(?:时间|日期|于|在)|发布时间戳|发布日期|更新(?:时间|日期)|publish(?:ed|ing)?\s+(?:time|date|timestamp)|publication\s+date/gi,
      " "
    )
    .replace(/publish\/update\s+(?:time|date|timestamp)/gi, " ");
}

function hasExternalReadIntent(value = "") {
  const text = String(value || "").toLowerCase();
  if (hasHighRiskWebAction(text)) return false;
  return (
    /联网[^。.;\n]{0,80}(研究|查询|检索|搜索|报告|分析|新闻|数据|资料|信息)/i.test(text) ||
    /查询[^。.;\n]{0,100}(最新|新闻|来源|数据|资料|信息|公开|网页|网络|网站|页面)/i.test(text) ||
    /(搜索|检索|查找|获取)[^。.;\n]{0,100}(最新|实时|当前|今日|今天|新闻|来源|数据|资料|信息|公开|网页|网络|网站|页面)/i.test(
      text
    ) ||
    /联网(?:搜索|检索|查询|读取|研究)/i.test(text) ||
    /真实(?:搜索|检索|查询|读取)(?:公开|网页|网站|网络)?/i.test(text) ||
    /搜索(?:公开|网页|网站|网络|资料|信息|项目)/i.test(text) ||
    /检索(?:公开|网页|网站|网络|资料|信息|项目)/i.test(text) ||
    /查找(?:公开|网页|网站|网络|资料|信息|项目)/i.test(text) ||
    /公开\s*(?:api|接口|网页|网站|页面)/i.test(text) ||
    /\b(public\s+)?(web|internet|online)\s+(search|research|lookup|fetch|read)\b/i.test(text) ||
    /\b(search|find|lookup|fetch|read|extract)\b[^.\n]{0,80}\b(public|web|internet|online|url|link|source|api|page|site|job|project|freelance)\b/i.test(
      text
    )
  );
}

function isWebToolType(type = "") {
  return /^(web_search|web_read|web_fetch|api_read|http_fetch|public_web_read|public_api_read)$/i.test(
    String(type || "")
  );
}

function shouldUseWebToolWorker(task = {}, messages = []) {
  const type = String(task.type || "").toLowerCase();
  const text = taskText(task, messages);
  if (String(task.toolWorker || task.tool_worker || "").toLowerCase() === "web") return true;
  if (isWebToolType(type)) return true;
  if (extractPublicHttpUrl(text) && /api|http|url|网页|页面|读取|抓取|fetch|read|extract|summari[sz]e/i.test(text)) {
    return !hasHighRiskWebAction(text);
  }
  return hasExternalReadIntent([lastUserText(messages), text].filter(Boolean).join("\n"));
}

function webActionForTask(task = {}, text = "") {
  const type = String(task.type || "").toLowerCase();
  if (/search|research|lookup|搜索|检索|查找|研究/i.test(`${type}\n${text}`) && !extractPublicHttpUrl(text)) {
    return "search";
  }
  return "fetch";
}

function searchQuery(task = {}, messages = []) {
  const explicit = task.query || task.searchQuery || task.search_query;
  if (explicit) return cleanSearchQueryText(explicit, 500);
  const text =
    [task.prompt, task.title, task.description]
      .map((item) => collapseText(item, 220))
      .find((item) => item.length >= 4) ||
    collapseText(task.input, 220) ||
    lastUserText(messages);
  return cleanSearchQueryText(text.replace(/\bhttps?:\/\/[^\s"'<>()[\]{}]+/gi, " "), 180);
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = collapseText(value, 180);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function explicitQueryList(task = {}) {
  const raw = task.queries || task.searchQueries || task.search_queries;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") return raw.split(/\n|;|；/);
  return [];
}

function quotedQueryList(value = "") {
  const text = String(value || "");
  const queries = [];
  for (const match of text.matchAll(/["“”']([^"“”']{4,180})["“”']/g)) {
    queries.push(match[1]);
  }
  return queries;
}

function queryClauses(value = "") {
  const text = stripNegatedHighRiskText(value)
    .replace(/\bhttps?:\/\/[^\s"'<>()[\]{}]+/gi, " ")
    .replace(/(?:不得|不要|禁止|请勿|do not)[^。.;\n]*/gi, " ");
  return text
    .split(/\n|;|；|,|，|、/i)
    .map((item) => cleanSearchQueryText(item.replace(/^[\s:：,，、-]+|[\s:：,，、-]+$/g, ""), 180))
    .filter((item) => item.length >= 4 && item.length <= 160)
    .filter(
      (item) =>
        !/^(返回|包含|说明|记录|不得|不要|最终|success|criteria|url|http status|title|text evidence)/i.test(item)
    );
}

function cleanSearchQueryText(value = "", max = 180) {
  let text = collapseText(value, max)
    .replace(/\bhttps?:\/\/[^\s"'<>()[\]{}]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (let index = 0; index < 4; index += 1) {
    const previous = text;
    text = text
      .replace(
        /^(?:请|请帮我|帮我|麻烦|please|执行|进行|做|完成|一次|真实|只读|联网|在线|网络|公开|精确|准确|重新|继续|now|please)\s*/i,
        ""
      )
      .replace(
        /^(?:查询|搜索|检索|查找|获取|读取|收集|采集|研究|分析|search(?:\s+for)?|look\s+up|lookup|find|fetch|read|collect|gather|retrieve|research|analy[sz]e)\s*(?:一下|关于|有关|for|about|:|：)?\s*/i,
        ""
      )
      .replace(/^[\s:：,，、-]+|[\s:：,，、-]+$/g, "")
      .trim();
    if (text === previous) break;
  }
  return collapseText(text, max);
}

function searchQueries(task = {}, messages = []) {
  const explicit = uniqueStrings(explicitQueryList(task));
  const normalizeQuery = (query) =>
    cleanSearchQueryText(query, 180)
      .replace(/\s*\/\s*/g, "/")
      .replace(/\s+/g, " ")
      .trim();
  if (explicit.length) return uniqueStrings(explicit.map(normalizeQuery)).slice(0, 5);

  const inputClauses = uniqueStrings(queryClauses(task.input || "").map(normalizeQuery));
  if (inputClauses.length) return inputClauses.slice(0, 5);

  const quotedPromptClauses = uniqueStrings(quotedQueryList(task.prompt || task.description || "").map(normalizeQuery));
  if (quotedPromptClauses.length) return quotedPromptClauses.slice(0, 5);

  const primary = searchQuery(task, messages);
  return uniqueStrings([primary, ...inputClauses].map(normalizeQuery)).slice(0, 5);
}

function combineSearchResults(results = [], queries = []) {
  if (results.length <= 1) return results[0];
  const okResults = results.filter((item) => item && item.ok);
  const allResults = results.flatMap((item, index) =>
    (item && Array.isArray(item.results) ? item.results : []).map((result) => ({
      ...result,
      query: queries[index] || item.query || ""
    }))
  );
  const evidenceItems = results.map((item) => (item && item.evidence ? item.evidence : {}));
  const apiResponses = evidenceItems.flatMap((item) => (Array.isArray(item.apiResponses) ? item.apiResponses : []));
  const browserEvidence = evidenceItems.flatMap((item) =>
    Array.isArray(item.browserEvidence) ? item.browserEvidence : []
  );
  const textPreview = results
    .map((item, index) =>
      [
        `Query: ${queries[index] || (item && item.query) || ""}`,
        item && item.textPreview ? item.textPreview : item && item.error ? `Error: ${item.error}` : ""
      ]
        .filter(Boolean)
        .join("\n")
    )
    .filter(Boolean)
    .join("\n\n");
  const failedQueries = results
    .map((item, index) =>
      !item || !item.ok ? `${queries[index] || "query"}: ${(item && item.error) || "failed"}` : ""
    )
    .filter(Boolean);
  return {
    ok: okResults.length > 0,
    action: "web_search",
    query: queries.join(" | "),
    url: okResults[0]?.url || results[0]?.url || "",
    status: okResults[0]?.status || results[0]?.status || 0,
    title: "Public web search results",
    results: allResults,
    textPreview,
    bodyPreview: results
      .map((item) => item && item.bodyPreview)
      .filter(Boolean)
      .join("\n\n"),
    elapsedMs: Math.max(...results.map((item) => Number((item && item.elapsedMs) || 0))),
    evidence: {
      summary: collapseText(textPreview || failedQueries.join("; "), 1200),
      claims: allResults
        .map((item) => `${item.query ? `[${item.query}] ` : ""}${item.title} - ${item.url}`)
        .slice(0, 20),
      actions: queries.map((query) => ({
        type: "web",
        action: "web_search",
        target: query,
        description: "Search public web."
      })),
      browserEvidence,
      normalizedEvidence: { browser: browserEvidence },
      apiResponses,
      semantic: {
        outputSummary: collapseText(textPreview || failedQueries.join("; "), 2000),
        addressesCriteria: okResults.length > 0,
        criteriaCoverage: queries.length ? Number((okResults.length / queries.length).toFixed(2)) : 0,
        qualityScore: okResults.length ? Math.max(0.35, Number((okResults.length / queries.length).toFixed(2))) : 0.2,
        qualityNotes: failedQueries.length ? [`Failed queries: ${failedQueries.join("; ")}`] : [],
        qualityIssues: okResults.length ? [] : failedQueries
      }
    },
    error: okResults.length ? "" : failedQueries.join("; ") || "Web search returned no parseable results."
  };
}

function combineFetchResults(results = [], urls = []) {
  if (results.length <= 1) return results[0];
  const okResults = results.filter((item) => item && item.ok);
  const evidenceItems = results.map((item) => (item && item.evidence ? item.evidence : {}));
  const apiResponses = evidenceItems.flatMap((item) => (Array.isArray(item.apiResponses) ? item.apiResponses : []));
  const browserEvidence = evidenceItems.flatMap((item) =>
    Array.isArray(item.browserEvidence) ? item.browserEvidence : []
  );
  const textPreview = results
    .map((item, index) =>
      [
        `URL: ${urls[index] || (item && item.url) || ""}`,
        item && item.status ? `HTTP: ${item.status}` : "",
        item && item.title ? `Title: ${item.title}` : "",
        item && item.textPreview ? `Text: ${item.textPreview}` : item && item.error ? `Error: ${item.error}` : ""
      ]
        .filter(Boolean)
        .join("\n")
    )
    .filter(Boolean)
    .join("\n\n");
  const failedUrls = results
    .map((item, index) => (!item || !item.ok ? `${urls[index] || "url"}: ${(item && item.error) || "failed"}` : ""))
    .filter(Boolean);
  return {
    ok: okResults.length > 0,
    action: "web_fetch",
    url: okResults[0]?.url || results[0]?.url || "",
    status: okResults[0]?.status || results[0]?.status || 0,
    title: okResults[0]?.title || "Public web fetch results",
    textPreview,
    bodyPreview: results
      .map((item) => item && item.bodyPreview)
      .filter(Boolean)
      .join("\n\n"),
    elapsedMs: Math.max(...results.map((item) => Number((item && item.elapsedMs) || 0))),
    evidence: {
      summary: collapseText(textPreview || failedUrls.join("; "), 1200),
      claims: apiResponses
        .map((item) => `${item.status ? `HTTP ${item.status}` : "HTTP"} ${item.url || ""}`.trim())
        .slice(0, 20),
      actions: urls.map((url) => ({
        type: "web",
        action: "web_fetch",
        target: url,
        description: "Read public web content."
      })),
      browserEvidence,
      normalizedEvidence: { browser: browserEvidence },
      apiResponses,
      semantic: {
        outputSummary: collapseText(textPreview || failedUrls.join("; "), 2000),
        addressesCriteria: okResults.length > 0,
        criteriaCoverage: urls.length ? Number((okResults.length / urls.length).toFixed(2)) : 0,
        qualityScore: okResults.length ? Math.max(0.35, Number((okResults.length / urls.length).toFixed(2))) : 0.2,
        qualityNotes: failedUrls.length ? [`Failed URLs: ${failedUrls.join("; ")}`] : [],
        qualityIssues: okResults.length ? [] : failedUrls
      }
    },
    error: okResults.length ? "" : failedUrls.join("; ") || "Web fetch returned no readable public URL."
  };
}

function searchOptionsForQueryCount(options = {}, queryCount = 1) {
  const nextOptions = { ...options };
  if (queryCount > 1 && nextOptions.resultFetchLimit == null) nextOptions.resultFetchLimit = 1;
  return nextOptions;
}

function contentForResult(status, output, webResult, action) {
  const evidence = webResult.evidence && typeof webResult.evidence === "object" ? webResult.evidence : {};
  const apiResponses = Array.isArray(evidence.apiResponses) ? evidence.apiResponses : [];
  const browserEvidence = Array.isArray(evidence.browserEvidence) ? evidence.browserEvidence : [];
  return JSON.stringify({
    kind: protocol.KIND.WORKER_RESULT,
    schemaVersion: protocol.PROTOCOL_VERSION,
    status,
    actions: [`web:${action}`],
    output: collapseText(output, 8000),
    error: webResult.error || "",
    nextStep: status === "success" ? "" : "Review the web tool error or retry with a narrower public source.",
    artifacts: [],
    evidence,
    memoryCandidates: [],
    evidenceSummary: collapseText(evidence.summary || "", 1200),
    evidenceCounts: {
      apiResponses: apiResponses.length,
      browserEvidence: browserEvidence.length,
      claims: Array.isArray(evidence.claims) ? evidence.claims.length : 0
    },
    riskLevel: webResult.riskLevel || "low",
    riskReasons: webResult.reasons || ["Read-only public web tool execution."],
    context: {
      model: "web-tool",
      url: webResult.url || "",
      status: webResult.status || 0,
      elapsedMs: webResult.elapsedMs || 0
    }
  });
}

async function runWebToolWorker(task = {}, config = {}, messages = []) {
  const startedAt = Date.now();
  const text = taskText(task, messages);
  const action = webActionForTask(task, text);
  const webConfig = (config.tools && config.tools.web) || {};
  const options = {
    ...webConfig,
    approvalStatus: task.approvalStatus || task.approval_status,
    approved: task.approved === true || task.humanApproved === true
  };
  let webResult;
  if (action === "search") {
    const queries = searchQueries(task, messages);
    const searchOptions = searchOptionsForQueryCount(options, queries.length);
    const results = [];
    for (const query of queries) {
      results.push(await webTool.searchWeb(query, searchOptions));
    }
    webResult = combineSearchResults(results, queries);
  } else {
    const urls = extractPublicHttpUrls(text, 4);
    if (!urls.length) {
      webResult = {
        ok: false,
        action: "web_fetch",
        url: "",
        status: 0,
        error: "Web read task did not include a public HTTP(S) URL.",
        elapsedMs: Date.now() - startedAt,
        evidence: {
          summary: "Missing public URL for web read task.",
          semantic: {
            outputSummary: "Missing public URL for web read task.",
            addressesCriteria: false,
            criteriaCoverage: 0,
            qualityScore: 0.1,
            qualityIssues: ["No public URL was provided."]
          }
        }
      };
    } else {
      const results = [];
      for (const url of urls) {
        results.push(await webTool.fetchWebUrl(url, options));
      }
      webResult = combineFetchResults(results, urls);
    }
  }

  const output =
    action === "search"
      ? webResult.textPreview || ""
      : [
          `URL: ${webResult.url || ""}`,
          webResult.status ? `HTTP: ${webResult.status}` : "",
          webResult.title ? `Title: ${webResult.title}` : "",
          webResult.textPreview ? `Text: ${webResult.textPreview}` : ""
        ]
          .filter(Boolean)
          .join("\n");
  const blocked = webResult.blocked === true;
  const status = blocked ? "blocked" : webResult.ok ? "success" : "failure";
  return {
    task,
    ok: webResult.ok === true,
    model: "web-tool",
    content: contentForResult(status, output, webResult, action === "search" ? "search" : "fetch"),
    error: webResult.ok ? "" : webResult.error || "Web tool failed.",
    elapsedMs: Date.now() - startedAt,
    actions: [`web:${action === "search" ? "search" : "fetch"}`],
    evidence: webResult.evidence || {}
  };
}

module.exports = {
  cleanSearchQueryText,
  extractPublicHttpUrl,
  extractPublicHttpUrls,
  hasExternalReadIntent,
  isPublicHttpUrl,
  runWebToolWorker,
  searchQuery,
  searchOptionsForQueryCount,
  searchQueries,
  quotedQueryList,
  shouldUseWebToolWorker
};
