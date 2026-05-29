"use strict";

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item) return "";
        if (typeof item === "string") return item;
        if (typeof item.text === "string") return item.text;
        if (typeof item.input_text === "string") return item.input_text;
        if (item.type) return `[${item.type}]`;
        try {
          return JSON.stringify(item);
        } catch {
          return String(item);
        }
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function messagesToText(messages) {
  if (!Array.isArray(messages)) return "";
  return messages
    .map((message) => {
      const role = message.role || "user";
      const content = normalizeContent(message.content);
      return `${role}: ${content}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function compactText(value = "", limit = 2000) {
  const text = normalizeContent(value).replace(/\s+/g, " ").trim();
  const max = Math.max(1, Number(limit) || 2000);
  return text.length > max ? `${text.slice(0, Math.max(1, max - 3))}...` : text;
}

function runtimeTemporalContext(now = new Date()) {
  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  let timezone = "UTC";
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || timezone;
  } catch {}
  let localTime = safeNow.toISOString();
  try {
    localTime = new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(safeNow);
  } catch {}
  return `运行时间上下文: now=${safeNow.toISOString()}; timezone=${timezone}; local=${localTime}. 用户说“今天/最新/近期/当前”时以此为准，不要使用训练记忆猜年份。`;
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if ((messages[index] && messages[index].role) === "user") {
      return normalizeContent(messages[index].content);
    }
  }
  return messagesToText(messages);
}

function responsesInputToMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [{ role: "user", content: normalizeContent(input) }];
  return input.map((item) => {
    if (typeof item === "string") return { role: "user", content: item };
    if (item.role) {
      const content = Array.isArray(item.content)
        ? item.content.map((part) => part.text || part.input_text || "").join("\n")
        : normalizeContent(item.content);
      return { role: item.role, content };
    }
    return { role: "user", content: normalizeContent(item) };
  });
}

function stableJsonStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function jsonStartAt(text, from = 0) {
  const objectAt = text.indexOf("{", from);
  const arrayAt = text.indexOf("[", from);
  if (objectAt < 0) return arrayAt;
  if (arrayAt < 0) return objectAt;
  return Math.min(objectAt, arrayAt);
}

function balancedJsonDocumentAt(text, startAt) {
  const start = Number(startAt);
  if (!text || !Number.isFinite(start) || start < 0 || start >= text.length) return null;
  const opener = text[start];
  if (opener !== "{" && opener !== "[") return null;
  const stack = [opener];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char !== "}" && char !== "]") continue;
    const expected = char === "}" ? "{" : "[";
    if (stack.pop() !== expected) return null;
    if (!stack.length) {
      const raw = text.slice(start, index + 1);
      try {
        return { value: JSON.parse(raw), raw, start, end: index + 1 };
      } catch {
        return null;
      }
    }
  }
  return null;
}

function inspectJsonDocumentSequence(text, options = {}) {
  const source = String(text || "").trim();
  const allowRepeatedIdentical = options.allowRepeatedIdentical !== false;
  const documents = [];
  let index = 0;
  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (index >= source.length) break;
    const document = balancedJsonDocumentAt(source, index);
    if (!document) {
      return {
        ok: false,
        value: null,
        documents,
        documentCount: documents.length,
        consumedAll: false,
        repeatedIdentical: false,
        error: documents.length ? "trailing_non_json_content" : "not_a_json_document_sequence"
      };
    }
    documents.push(document.value);
    index = document.end;
  }
  if (!documents.length) {
    return {
      ok: false,
      value: null,
      documents,
      documentCount: 0,
      consumedAll: false,
      repeatedIdentical: false,
      error: "empty_json_document_sequence"
    };
  }
  const firstStable = stableJsonStringify(documents[0]);
  const repeatedIdentical = documents.every((document) => stableJsonStringify(document) === firstStable);
  const ok = documents.length === 1 || (allowRepeatedIdentical && repeatedIdentical);
  const error = ok ? "" : repeatedIdentical ? "multiple_repeated_json_documents" : "multiple_different_json_documents";
  return {
    ok,
    value: ok ? documents[0] : null,
    documents,
    documentCount: documents.length,
    consumedAll: true,
    repeatedIdentical,
    error
  };
}

function embeddedJsonDocument(text) {
  const source = String(text || "");
  let start = jsonStartAt(source, 0);
  while (start >= 0) {
    const document = balancedJsonDocumentAt(source, start);
    if (document) return document.value;
    start = jsonStartAt(source, start + 1);
  }
  return null;
}

function jsonParseDiagnostics(text, options = {}) {
  const source = normalizeContent(text);
  const trimmed = source.trim();
  const sequence = inspectJsonDocumentSequence(trimmed, options);
  return {
    length: source.length,
    trimmedLength: trimmed.length,
    startsWithJson: /^[\[{]/.test(trimmed),
    hasFencedJson: /```(?:json)?/i.test(source),
    topLevelJsonDocuments: sequence.documentCount,
    consumedAll: sequence.consumedAll,
    repeatedIdenticalJsonDocuments: sequence.documentCount > 1 && sequence.repeatedIdentical,
    parseError: sequence.error || ""
  };
}

function safeJsonParse(text, options = {}) {
  if (!text) return null;
  const source = normalizeContent(text);
  const allowEmbedded = options.allowEmbedded !== false;
  const allowRepeatedIdentical = options.allowRepeatedIdentical !== false;
  try {
    return JSON.parse(source);
  } catch {}
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsedFence = safeJsonParse(fenced[1], { allowEmbedded: false, allowRepeatedIdentical });
    if (parsedFence) return parsedFence;
  }
  const sequence = inspectJsonDocumentSequence(source, { allowRepeatedIdentical });
  if (sequence.ok) return sequence.value;
  if (allowEmbedded) {
    const embedded = embeddedJsonDocument(source);
    if (embedded) return embedded;
  }
  return null;
}

function extractChatContent(data) {
  const message = data && data.choices && data.choices[0] && data.choices[0].message;
  if (!message) return "";
  const toolCall = Array.isArray(message.tool_calls) ? message.tool_calls[0] : null;
  const toolArguments =
    toolCall && toolCall.function && typeof toolCall.function.arguments === "string" ? toolCall.function.arguments : "";
  return (
    normalizeContent(toolArguments) ||
    normalizeContent(message.content) ||
    normalizeContent(message.reasoning_content) ||
    normalizeContent(message.reasoningContent) ||
    normalizeContent(message.text)
  );
}

function extractResponsesContent(data) {
  if (!data) return "";
  if (typeof data.output_text === "string") return data.output_text;
  if (!Array.isArray(data.output)) return "";
  return data.output
    .flatMap((item) => {
      if (!Array.isArray(item.content)) return [];
      return item.content.map((part) => part && (part.text || part.output_text || part.input_text || ""));
    })
    .filter(Boolean)
    .join("\n");
}

async function parseModelResponse(response) {
  const text = await response.text().catch(() => "");
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return {
    data,
    text,
    content: data ? extractChatContent(data) || extractResponsesContent(data) : ""
  };
}

module.exports = {
  extractChatContent,
  extractResponsesContent,
  compactText,
  jsonParseDiagnostics,
  lastUserText,
  messagesToText,
  normalizeContent,
  parseModelResponse,
  responsesInputToMessages,
  runtimeTemporalContext,
  safeJsonParse
};
