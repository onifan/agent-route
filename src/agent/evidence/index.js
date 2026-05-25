"use strict";

module.exports = {
  ...require("./browser-evidence-normalizer"),
  ...require("./evidence-sanitizer"),
  ...require("./evidence-types"),
  ...require("./worker-evidence-normalizer")
};
