"use strict";

module.exports = {
  ...require("./authenticity-engine"),
  normalizer: require("./authenticity-normalizer"),
  rules: require("./authenticity-rules"),
  score: require("./authenticity-score")
};
