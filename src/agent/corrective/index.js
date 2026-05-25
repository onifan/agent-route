"use strict";

module.exports = {
  ...require("./corrective-actions"),
  ...require("./corrective-engine"),
  normalizer: require("./corrective-normalizer"),
  rules: require("./corrective-rules")
};
