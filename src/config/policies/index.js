"use strict";

module.exports = {
  ...require("./browser-tool-policy"),
  ...require("./budget-policy"),
  ...require("./human-approval-policy"),
  ...require("./risk-policy"),
  ...require("./recovery-policy"),
  ...require("./runtime-policy"),
  ...require("./unattended-policy"),
  ...require("./verification-policy")
};
