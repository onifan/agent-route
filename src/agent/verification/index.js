"use strict";

const engine = require("./engine");

module.exports = {
  ...engine,
  authenticity: require("./authenticity"),
  evidence: require("./evidence"),
  fileIntent: require("./file-intent")
};
