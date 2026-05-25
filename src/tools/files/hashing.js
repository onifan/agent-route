"use strict";

const fs = require("fs");
const crypto = require("crypto");

function hashFile(filePath, { algorithm = "sha256" } = {}) {
  const startedAt = Date.now();
  try {
    const hash = crypto.createHash(algorithm);
    hash.update(fs.readFileSync(filePath));
    return {
      ok: true,
      action: "hash_file",
      path: filePath,
      algorithm,
      hash: hash.digest("hex"),
      durationMs: Date.now() - startedAt,
      error: ""
    };
  } catch (err) {
    return {
      ok: false,
      action: "hash_file",
      path: filePath,
      algorithm,
      hash: "",
      durationMs: Date.now() - startedAt,
      error: err && err.message ? err.message : String(err)
    };
  }
}

module.exports = {
  hashFile
};
