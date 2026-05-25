#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const standaloneServer = path.join(root, ".next-cli-build", "standalone", "server.js");

if (!fs.existsSync(standaloneServer)) {
  console.error("Standalone build is missing.\nRun `npm run build` before starting production.");
  process.exit(1);
}

// Default to binding the loopback interface so the unauthenticated-by-default
// control plane and model proxy are not exposed on the local network. Set
// HOSTNAME=0.0.0.0 (and configure a local API key) to intentionally expose it.
const env = { ...process.env };
if (!env.HOSTNAME && !env.HOST) {
  env.HOSTNAME = "127.0.0.1";
}
if (env.HOSTNAME && env.HOSTNAME !== "127.0.0.1" && env.HOSTNAME !== "::1" && env.HOSTNAME !== "localhost") {
  console.warn(
    `[start-production] Binding to ${env.HOSTNAME}: the server will be reachable beyond localhost. ` +
      "Ensure a local API key is configured so external callers must authenticate."
  );
}

const child = spawn(process.execPath, [standaloneServer], {
  cwd: root,
  env,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code == null ? 1 : code);
});
