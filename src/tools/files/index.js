"use strict";

module.exports = {
  ...require("./file-store"),
  ...require("./hashing"),
  ...require("./temp-files")
};
