"use strict";

module.exports = {
  ...require("./file-intent-detector"),
  patterns: require("./file-patterns"),
  normalizer: require("./intent-normalizer")
};
