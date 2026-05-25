"use strict";

const filesTool = require("../files");

function createCodexOutputPath() {
  return filesTool.tempFilePath({
    prefix: "agent-route-codex",
    suffix: ".txt"
  });
}

module.exports = {
  createCodexOutputPath
};
