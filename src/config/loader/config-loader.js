"use strict";

const fs = require("fs");
const { mergeRuntimeConfig } = require("./config-merge");
const { sanitizeConfig } = require("./config-sanitizer");
const { validateRuntimeConfig } = require("./config-validator");
const { createDefaultRuntimeConfig, runtimePaths } = require("./runtime-config");

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasNegativeNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) && value < 0;
  if (Array.isArray(value)) return value.some(hasNegativeNumber);
  if (isObject(value)) return Object.values(value).some(hasNegativeNumber);
  return false;
}

function readUserConfig(configFile) {
  if (!configFile || !fs.existsSync(configFile)) {
    return { config: {}, source: "", warnings: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, "utf8"));
    if (!isObject(parsed)) {
      return {
        config: {},
        source: configFile,
        warnings: [`Config file ${configFile} did not contain an object; defaults were used.`]
      };
    }
    return { config: parsed, source: configFile, warnings: [] };
  } catch (err) {
    return { config: {}, source: configFile, warnings: [`Failed to read config file ${configFile}: ${err.message}`] };
  }
}

function loadRuntimeConfig(options = {}) {
  const defaults = options.defaults || createDefaultRuntimeConfig();
  const paths = runtimePaths();
  const configFile = options.configFile || process.env.AGENT_ROUTE_CONFIG || paths.configFile;
  const user = options.userConfig
    ? { config: options.userConfig, source: options.configFile || "inline", warnings: [] }
    : readUserConfig(configFile);
  const preflightWarnings = hasNegativeNumber(user.config && user.config.budget)
    ? ["budget policy contained negative values; defaults were used for those fields."]
    : [];
  const merged = mergeRuntimeConfig(defaults, user.config);
  const validated = validateRuntimeConfig(merged, defaults, { strict: options.strict === true });
  const warnings = [...user.warnings, ...preflightWarnings, ...validated.warnings];
  for (const warning of warnings) {
    if (typeof options.onWarning === "function") options.onWarning(warning);
  }
  return {
    ...validated.config,
    configSources: {
      defaults: true,
      user: user.source || "",
      env: {
        AGENT_ROUTE_HOME: process.env.AGENT_ROUTE_HOME || "",
        AGENT_ROUTE_CONFIG: process.env.AGENT_ROUTE_CONFIG || ""
      }
    },
    configWarnings: warnings
  };
}

function loadSanitizedRuntimeConfig(options = {}) {
  return sanitizeConfig(loadRuntimeConfig(options));
}

module.exports = {
  loadRuntimeConfig,
  loadSanitizedRuntimeConfig,
  readUserConfig
};
