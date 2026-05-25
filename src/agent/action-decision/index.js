"use strict";

module.exports = {
  ...require("./decision-engine"),
  normalizer: require("./decision-normalizer"),
  rules: require("./decision-rules"),
  score: require("./decision-score")
};
