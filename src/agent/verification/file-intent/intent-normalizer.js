"use strict";

function collapseText(value) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
}

function stripQuotes(value) {
  return collapseText(value).replace(/^["'`([{<]+|["'`)\]}>.,;:]+$/g, "");
}

function normalizeCandidate(value) {
  const raw = collapseText(value);
  const cleaned = stripQuotes(raw.replace(/:\d+(?::\d+)?$/, ""));
  const basename = cleaned.split(/[\\/]/).filter(Boolean).pop() || cleaned;
  const lower = cleaned.toLowerCase();
  const lowerBase = basename.toLowerCase();
  const extMatch = lowerBase.match(/\.([a-z0-9]{1,12})$/i);
  const extension = extMatch ? extMatch[1].toLowerCase() : "";
  const stem = extension ? lowerBase.slice(0, -(extension.length + 1)) : lowerBase;
  return {
    raw,
    cleaned,
    basename,
    lower,
    lowerBase,
    extension,
    stem
  };
}

function hasPathSeparator(value) {
  return /(^\.{1,2}\/|^\/|[\\/])/.test(String(value || ""));
}

function isUrlLike(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(value || "")) || /^(mailto|tel|data):/i.test(String(value || ""));
}

function isNaturalLanguage(value) {
  const text = collapseText(value);
  return /\s/.test(text) && text.length > 28;
}

function isVersionLike(value) {
  return /^v?\d+(?:\.\d+){1,3}(?:[-+][a-z0-9.-]+)?$/i.test(String(value || "").trim());
}

module.exports = {
  collapseText,
  hasPathSeparator,
  isNaturalLanguage,
  isUrlLike,
  isVersionLike,
  normalizeCandidate
};
