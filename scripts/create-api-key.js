#!/usr/bin/env node

"use strict";

// Create a local API key for AgentRoute Studio.
//
// The agent endpoint (/api/agent-route/run) accepts non-UI requests when they
// carry one of the active keys stored in the `apiKeys` table (see
// src/security/request-auth.js). This script generates such a key and stores it
// in the same database the running app reads from.
//
// Usage:
//   node scripts/create-api-key.js                # create a key named "default"
//   node scripts/create-api-key.js --name "my-ide"
//   node scripts/create-api-key.js --list         # list existing active keys
//   AGENT_ROUTE_DB=/path/to/data.sqlite node scripts/create-api-key.js
//
// The DB location is resolved the same way the app resolves it:
//   AGENT_ROUTE_DB, else $AGENT_ROUTE_HOME|$DATA_DIR/db/data.sqlite,
//   else ~/.agent-route-studio/db/data.sqlite

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

function dataDbPath() {
  if (process.env.AGENT_ROUTE_DB) return process.env.AGENT_ROUTE_DB;
  const home = process.env.AGENT_ROUTE_HOME || process.env.DATA_DIR || path.join(os.homedir(), ".agent-route-studio");
  return path.join(home, "db", "data.sqlite");
}

function parseArgs(argv) {
  const args = { name: "default", list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") args.list = true;
    else if (arg === "--name" || arg === "-n") args.name = String(argv[++i] || "default");
    else if (arg.startsWith("--name=")) args.name = arg.slice("--name=".length);
  }
  return args;
}

// Open the SQLite database read-write. Prefer better-sqlite3 (what the app uses),
// fall back to the built-in node:sqlite (Node >= 22.5) so the script still works
// on machines where the native module did not build.
function openDatabase(dbPath) {
  try {
    const Database = require("better-sqlite3");
    const db = new Database(dbPath);
    return {
      kind: "better-sqlite3",
      exec: (sql) => db.exec(sql),
      run: (sql, params = []) => db.prepare(sql).run(...params),
      all: (sql, params = []) => db.prepare(sql).all(...params),
      close: () => db.close()
    };
  } catch (betterErr) {
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(dbPath);
      return {
        kind: "node:sqlite",
        exec: (sql) => db.exec(sql),
        run: (sql, params = []) => db.prepare(sql).run(...params),
        all: (sql, params = []) => db.prepare(sql).all(...params),
        close: () => db.close()
      };
    } catch (nodeErr) {
      const detail = [betterErr && betterErr.message, nodeErr && nodeErr.message].filter(Boolean).join(" | ");
      throw new Error(`Could not open SQLite (${detail}). Run this with the same Node the app uses.`);
    }
  }
}

function ensureApiKeysTable(db) {
  // Matches the schema written by the app's migrations.
  db.exec(
    "CREATE TABLE IF NOT EXISTS apiKeys (id TEXT PRIMARY KEY, key TEXT, name TEXT, machineId TEXT, isActive INTEGER, createdAt TEXT)"
  );
}

function generateKey() {
  return `sk-${crypto.randomBytes(24).toString("hex")}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = dataDbPath();

  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found at: ${dbPath}`);
    console.error(
      "Start the app once (npm run dev) so it creates the database, or set AGENT_ROUTE_DB to the correct path."
    );
    process.exit(1);
  }

  const db = openDatabase(dbPath);
  try {
    ensureApiKeysTable(db);

    if (args.list) {
      const rows = db.all("SELECT id, name, key, isActive, createdAt FROM apiKeys ORDER BY createdAt ASC");
      if (!rows.length) {
        console.log("No API keys found. Run without --list to create one.");
        return;
      }
      console.log(`API keys in ${dbPath}:`);
      for (const row of rows) {
        const active = Number(row.isActive) === 1 ? "active" : "inactive";
        console.log(`  [${active}] ${row.name || "(unnamed)"}  ${row.key}`);
      }
      return;
    }

    const key = generateKey();
    const id = crypto.randomUUID();
    db.run("INSERT INTO apiKeys (id, key, name, machineId, isActive, createdAt) VALUES (?, ?, ?, ?, ?, ?)", [
      id,
      key,
      args.name,
      null,
      1,
      new Date().toISOString()
    ]);

    console.log("Created a new active API key.");
    console.log("");
    console.log(`  ${key}`);
    console.log("");
    console.log(`Stored in: ${dbPath}  (via ${db.kind})`);
    console.log("Use it from non-local clients, e.g.:");
    console.log(`  curl -X POST http://localhost:20128/api/agent-route/run \\`);
    console.log(`    -H "Authorization: Bearer ${key}" \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"action":"config_status"}'`);
    console.log("");
    console.log(
      "(The local web console is exempt — it is same-origin. Restart the app to pick up the key immediately.)"
    );
  } finally {
    db.close();
  }
}

main();
