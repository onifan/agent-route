"use strict";

const { FILE_EXTENSIONS, KNOWN_FILENAMES, TECH_STACK_TERMS } = require("./file-patterns");
const {
  hasPathSeparator,
  isNaturalLanguage,
  isUrlLike,
  isVersionLike,
  normalizeCandidate
} = require("./intent-normalizer");

function compactReason(reasons = []) {
  return reasons.filter(Boolean).join("; ") || "No strong file intent signal.";
}

function confidence(value) {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function isKnownTechTerm(candidate) {
  if (TECH_STACK_TERMS.has(candidate.lower) || TECH_STACK_TERMS.has(candidate.lowerBase)) return true;
  if (candidate.extension && TECH_STACK_TERMS.has(candidate.stem) && candidate.lowerBase.split(".").length === 2)
    return true;
  return false;
}

function sourceBoost(source = "") {
  const text = String(source || "").toLowerCase();
  if (text === "artifact" || text === "evidence" || text === "context") return 0.18;
  return 0;
}

function detectFileIntent(value, context = {}) {
  const candidate = normalizeCandidate(value);
  const reasons = [];
  let score = 0;

  if (!candidate.cleaned) {
    return {
      input: String(value == null ? "" : value),
      normalized: "",
      isFile: false,
      confidence: 0,
      reason: "Empty value is not a file path.",
      source: context.source || ""
    };
  }

  if (isUrlLike(candidate.cleaned)) {
    return {
      input: candidate.raw,
      normalized: candidate.cleaned,
      isFile: false,
      confidence: 0.04,
      reason: "URL-like value should be verified by URL/API/browser checks, not local file checks.",
      source: context.source || ""
    };
  }

  if (isKnownTechTerm(candidate)) {
    return {
      input: candidate.raw,
      normalized: candidate.cleaned,
      isFile: false,
      confidence: 0.08,
      reason: "Known technology keyword, not a concrete file path.",
      source: context.source || ""
    };
  }

  if (isVersionLike(candidate.cleaned)) {
    return {
      input: candidate.raw,
      normalized: candidate.cleaned,
      isFile: false,
      confidence: 0.1,
      reason: "Version-like value is not a file path.",
      source: context.source || ""
    };
  }

  if (isNaturalLanguage(candidate.cleaned)) {
    score -= 0.35;
    reasons.push("Looks like natural language rather than a file path.");
  }

  if (hasPathSeparator(candidate.cleaned)) {
    score +=
      candidate.cleaned.startsWith("/") || candidate.cleaned.startsWith("./") || candidate.cleaned.startsWith("../")
        ? 0.55
        : 0.42;
    reasons.push("Contains path structure.");
  }

  if (candidate.extension && FILE_EXTENSIONS.has(candidate.extension)) {
    score += 0.32;
    reasons.push(`Has recognized file extension .${candidate.extension}.`);
  } else if (candidate.extension) {
    score += 0.08;
    reasons.push(`Has uncommon extension .${candidate.extension}.`);
  }

  if (KNOWN_FILENAMES.has(candidate.lowerBase)) {
    score += 0.48;
    reasons.push("Matches a known project filename.");
  }

  if (/^[A-Z][A-Za-z0-9_-]*\.[a-z0-9]{1,8}$/.test(candidate.basename) && !hasPathSeparator(candidate.cleaned)) {
    score -= 0.18;
    reasons.push("Single capitalized token with extension is often a technology name.");
  }

  if (/^[A-Za-z0-9_-]+\.[a-z0-9]{1,8}$/.test(candidate.basename) && !hasPathSeparator(candidate.cleaned)) {
    score += 0.14;
    reasons.push("Single filename-like token.");
  }

  if (/^[A-Za-z0-9._/-]+$/.test(candidate.cleaned)) {
    score += 0.08;
    reasons.push("Contains only path-safe characters.");
  }

  score += sourceBoost(context.source);
  if (context.source && sourceBoost(context.source))
    reasons.push(`Source ${context.source} is explicit file evidence.`);

  const fileConfidence = confidence(score);
  const threshold = context.source === "text" || !context.source ? 0.52 : 0.58;
  return {
    input: candidate.raw,
    normalized: candidate.cleaned,
    basename: candidate.basename,
    extension: candidate.extension,
    isFile: fileConfidence >= threshold,
    confidence: fileConfidence,
    reason: compactReason(reasons),
    source: context.source || ""
  };
}

module.exports = {
  detectFileIntent
};
