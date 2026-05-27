"use client";

const SAFE_LINK_PATTERN = /^(https?:\/\/|mailto:)/i;

function array(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function safeHref(value = "") {
  const href = String(value || "").trim();
  return SAFE_LINK_PATTERN.test(href) ? href : "";
}

function decodeEscapedText(value = "") {
  const text = String(value || "");
  if (!/\\[nrt"]/.test(text) || text.includes("\n")) return text;
  try {
    return JSON.parse(`"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  } catch {
    return text.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"');
  }
}

function jsonCandidate(value = "") {
  const text = String(value || "").trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
  return fenced ? fenced[1].trim() : text;
}

function markdownFieldFromObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return (
    value.answerMarkdown ||
    value.answer_markdown ||
    value.final_answer ||
    value.finalAnswer ||
    value.content ||
    value.output ||
    value.text ||
    value.message ||
    ""
  );
}

function normalizeMarkdownContent(content = "") {
  let text = decodeEscapedText(content).trim();
  for (let index = 0; index < 2; index += 1) {
    const candidate = jsonCandidate(text);
    if (!/^\{[\s\S]*\}$/.test(candidate)) break;
    try {
      const parsed = JSON.parse(candidate);
      const markdown = markdownFieldFromObject(parsed);
      if (typeof markdown !== "string" || !markdown.trim()) break;
      text = decodeEscapedText(markdown).trim();
    } catch {
      break;
    }
  }
  return text;
}

function stripTrailingPunctuation(url = "") {
  const match = String(url || "").match(/^(.+?)([.,;:!?，。；：！？)]*)$/);
  return match ? [match[1], match[2] || ""] : [url, ""];
}

function renderMarkdownInline(text, keyPrefix = "inline") {
  const source = String(text || "");
  const parts = [];
  const pattern =
    /(`[^`\n]+`|\*\*[^*\n]+?\*\*|__[^_\n]+?__|~~[^~\n]+?~~|\*[^*\n]+?\*|_[^_\n]+?_|!\[[^\]\n]*?\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[[^\]\n]+?\]\(([^)\s]+)(?:\s+"[^"]*")?\)|https?:\/\/[^\s<]+)/g;
  let lastIndex = 0;
  let match = null;
  while ((match = pattern.exec(source))) {
    if (match.index > lastIndex) parts.push(source.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${parts.length}-${match.index}`;
    if (token.startsWith("`")) {
      parts.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      parts.push(<strong key={key}>{renderMarkdownInline(token.slice(2, -2), `${key}-strong`)}</strong>);
    } else if (token.startsWith("~~")) {
      parts.push(<del key={key}>{renderMarkdownInline(token.slice(2, -2), `${key}-del`)}</del>);
    } else if (token.startsWith("*") || token.startsWith("_")) {
      parts.push(<em key={key}>{renderMarkdownInline(token.slice(1, -1), `${key}-em`)}</em>);
    } else if (token.startsWith("![")) {
      const imageMatch = token.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/);
      const href = safeHref(imageMatch?.[2] || "");
      parts.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noreferrer">
            {imageMatch?.[1] || href}
          </a>
        ) : (
          token
        )
      );
    } else if (token.startsWith("[")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/);
      const href = safeHref(linkMatch?.[2] || "");
      parts.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noreferrer">
            {renderMarkdownInline(linkMatch?.[1] || href, `${key}-link`)}
          </a>
        ) : (
          token
        )
      );
    } else {
      const [href, punctuation] = stripTrailingPunctuation(token);
      parts.push(
        <a key={key} href={href} target="_blank" rel="noreferrer">
          {href}
        </a>
      );
      if (punctuation) parts.push(punctuation);
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < source.length) parts.push(source.slice(lastIndex));
  return parts.length ? parts : source;
}

function renderInlineLines(lines = [], keyPrefix = "line") {
  return array(lines).flatMap((line, index) => {
    const rendered = renderMarkdownInline(line, `${keyPrefix}-${index}`);
    return index === 0 ? [rendered] : [<br key={`${keyPrefix}-br-${index}`} />, rendered];
  });
}

function isMarkdownTableSeparator(line = "") {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(String(line || ""));
}

function splitMarkdownTableRow(line = "") {
  return String(line || "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function tableAlignments(separator = "") {
  return splitMarkdownTableRow(separator).map((cell) => {
    const text = String(cell || "").trim();
    if (/^:-+:$/.test(text)) return "center";
    if (/-+:$/.test(text)) return "right";
    return "left";
  });
}

function listMarker(line = "") {
  const match = String(line || "").match(/^(\s{0,12})([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.+)$/);
  if (!match) return null;
  return {
    indent: match[1].replace(/\t/g, "    ").length,
    ordered: /^\d/.test(match[2]),
    checked: match[3] ? /x/i.test(match[3]) : null,
    text: match[4]
  };
}

function isHorizontalRule(line = "") {
  return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(String(line || ""));
}

function isMarkdownBlockStart(line = "", nextLine = "") {
  const text = String(line || "");
  if (!text.trim()) return true;
  if (/^\s*```/.test(text)) return true;
  if (/^\s{0,3}#{1,6}\s+/.test(text)) return true;
  if (isHorizontalRule(text)) return true;
  if (/^\s{0,3}>\s?/.test(text)) return true;
  if (listMarker(text)) return true;
  return text.includes("|") && isMarkdownTableSeparator(nextLine);
}

function parseList(lines, startIndex, keyPrefix) {
  const first = listMarker(lines[startIndex]);
  const ordered = Boolean(first?.ordered);
  const baseIndent = first?.indent || 0;
  const items = [];
  let index = startIndex;

  while (index < lines.length) {
    const marker = listMarker(lines[index]);
    if (!marker || marker.indent < baseIndent || marker.ordered !== ordered) break;
    if (marker.indent > baseIndent) break;

    const item = {
      checked: marker.checked,
      lines: [marker.text],
      children: []
    };
    index += 1;

    while (index < lines.length) {
      const line = lines[index];
      const nextMarker = listMarker(line);
      if (!line.trim()) {
        index += 1;
        if (index >= lines.length || isMarkdownBlockStart(lines[index], lines[index + 1] || "")) break;
        continue;
      }
      if (nextMarker) {
        if (nextMarker.indent > baseIndent) {
          const nested = parseList(lines, index, `${keyPrefix}-nested-${items.length}-${item.children.length}`);
          item.children.push(nested.element);
          index = nested.nextIndex;
          continue;
        }
        break;
      }
      if (/^\s{2,}/.test(line) && !isMarkdownBlockStart(line.trim(), lines[index + 1] || "")) {
        item.lines.push(line.trim());
        index += 1;
        continue;
      }
      break;
    }
    items.push(item);
  }

  const ListTag = ordered ? "ol" : "ul";
  const taskList = items.some((item) => item.checked !== null);
  return {
    nextIndex: index,
    element: (
      <ListTag className={taskList ? "markdown-task-list" : undefined} key={`${keyPrefix}-list-${startIndex}`}>
        {items.map((item, itemIndex) => (
          <li
            className={item.checked !== null ? "markdown-task-item" : undefined}
            key={`${keyPrefix}-item-${itemIndex}`}
          >
            {item.checked !== null ? (
              <input aria-label="任务项状态" checked={item.checked} readOnly type="checkbox" />
            ) : null}
            <span>{renderInlineLines(item.lines, `${keyPrefix}-item-${itemIndex}`)}</span>
            {item.children}
          </li>
        ))}
      </ListTag>
    )
  };
}

function renderMarkdownBlocks(content, keyPrefix = "markdown") {
  const lines = String(content || "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^\s*```/.test(line)) {
      const language = trimmed.replace(/^```/, "").trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      blocks.push(
        <pre key={`${keyPrefix}-code-${blocks.length}`} data-language={language || undefined}>
          <code>{codeLines.join("\n")}</code>
        </pre>
      );
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const HeadingTag = `h${Math.min(6, Math.max(2, level))}`;
      blocks.push(
        <HeadingTag key={`${keyPrefix}-heading-${blocks.length}`}>
          {renderMarkdownInline(heading[2].replace(/\s+#+\s*$/, ""), `${keyPrefix}-heading-${blocks.length}`)}
        </HeadingTag>
      );
      continue;
    }

    if (isHorizontalRule(line)) {
      blocks.push(<hr key={`${keyPrefix}-hr-${blocks.length}`} />);
      continue;
    }

    if (/^\s{0,3}>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s{0,3}>\s?/, ""));
        index += 1;
      }
      index -= 1;
      blocks.push(
        <blockquote key={`${keyPrefix}-quote-${blocks.length}`}>
          {renderMarkdownBlocks(quoteLines.join("\n"), `${keyPrefix}-quote-${blocks.length}`)}
        </blockquote>
      );
      continue;
    }

    if (line.includes("|") && isMarkdownTableSeparator(lines[index + 1])) {
      const header = splitMarkdownTableRow(line);
      const alignments = tableAlignments(lines[index + 1]);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitMarkdownTableRow(lines[index]));
        index += 1;
      }
      index -= 1;
      blocks.push(
        <div className="markdown-table-wrap" key={`${keyPrefix}-table-${blocks.length}`}>
          <table>
            <thead>
              <tr>
                {header.map((cell, cellIndex) => (
                  <th key={`h-${cellIndex}`} style={{ textAlign: alignments[cellIndex] || "left" }}>
                    {renderMarkdownInline(cell, `${keyPrefix}-table-${blocks.length}-h-${cellIndex}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`r-${rowIndex}`}>
                  {header.map((_, cellIndex) => (
                    <td key={`c-${cellIndex}`} style={{ textAlign: alignments[cellIndex] || "left" }}>
                      {renderMarkdownInline(
                        row[cellIndex] || "",
                        `${keyPrefix}-table-${blocks.length}-${rowIndex}-${cellIndex}`
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (listMarker(line)) {
      const parsed = parseList(lines, index, `${keyPrefix}-list-${blocks.length}`);
      blocks.push(parsed.element);
      index = parsed.nextIndex - 1;
      continue;
    }

    const paragraphLines = [trimmed];
    while (index + 1 < lines.length && !isMarkdownBlockStart(lines[index + 1], lines[index + 2] || "")) {
      index += 1;
      paragraphLines.push(lines[index].trim());
    }
    blocks.push(
      <p key={`${keyPrefix}-paragraph-${blocks.length}`}>
        {renderInlineLines(paragraphLines, `${keyPrefix}-paragraph-${blocks.length}`)}
      </p>
    );
  }
  return blocks;
}

export default function MarkdownOutput({ content, className = "final-output markdown-output" }) {
  const normalized = normalizeMarkdownContent(content);
  const blocks = renderMarkdownBlocks(normalized);
  return <div className={className}>{blocks.length ? blocks : <p>{normalized}</p>}</div>;
}
