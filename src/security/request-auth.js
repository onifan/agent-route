"use strict";

// Incoming request authentication for the always-on HTTP surface.
//
// Threat model: /api/agent-route/run can drive tool execution and internal
// model calls can use configured model API keys. The hard boundary is the
// default loopback binding (see scripts/start-production.js); this guard adds a
// second layer so that, once a local API key exists, cross-origin / non-UI
// callers must present it.
//
// Design (matches the chosen policy: loopback bind + key check, local UI exempt):
//   - If local auth is explicitly disabled -> allow.
//   - If no active local API key is configured -> allow (rely on loopback bind;
//     never lock the user out of a fresh install).
//   - Otherwise allow only same-origin requests (the local web console) or a
//     request carrying a valid active local API key.

const fs = require("fs");
const { agentRoutePath } = require("../shared/utils/agent-home");

let keyCache = { expiresAt: 0, keys: null, dbPath: "" };

function dataDbPath() {
  // Mirror the path resolution used by the core router (getLocalApiKey).
  return process.env.AGENT_ROUTE_DB || agentRoutePath("db", "data.sqlite");
}

function localAuthDisabled() {
  return String(process.env.AGENT_ROUTE_DISABLE_LOCAL_AUTH || "").trim() === "1";
}

function activeApiKeys() {
  const now = Date.now();
  const dbPath = dataDbPath();
  if (keyCache.expiresAt > now && keyCache.keys && keyCache.dbPath === dbPath) return keyCache.keys;

  const keys = new Set();
  try {
    if (fs.existsSync(dbPath)) {
      const Database = require("better-sqlite3");
      const db = new Database(dbPath, { readonly: true });
      try {
        const rows = db.prepare("SELECT key FROM apiKeys WHERE isActive = 1").all();
        for (const row of rows) {
          if (row && row.key) keys.add(String(row.key));
        }
      } catch {}
      db.close();
    }
  } catch (err) {
    // If the key store cannot be read (e.g. better-sqlite3 is unavailable on this
    // platform), fail open and rely on the default loopback binding instead of
    // locking the user out of their own console.
    console.warn("[request-auth] failed to read local API keys:", err.message);
  }
  keyCache = { expiresAt: now + 30 * 1000, keys, dbPath };
  return keys;
}

function clearAuthCache() {
  keyCache = { expiresAt: 0, keys: null, dbPath: "" };
}

function headerValue(req, name) {
  try {
    if (req && req.headers && typeof req.headers.get === "function") {
      return req.headers.get(name) || "";
    }
  } catch {}
  return "";
}

function presentedKey(req) {
  const auth = String(headerValue(req, "authorization") || "");
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  return String(headerValue(req, "x-api-key") || "").trim();
}

function isSameOriginRequest(req) {
  const origin = String(headerValue(req, "origin") || "").trim();
  if (!origin) return false;
  const host = String(headerValue(req, "host") || "").trim();
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function unauthorizedResponse(req) {
  const { corsHeaders } = require("./cors");
  return new Response(
    JSON.stringify({
      error: {
        message:
          "Unauthorized. Provide a valid local API key via 'Authorization: Bearer <key>' or the 'X-API-Key' header.",
        type: "authentication_error",
        code: "missing_or_invalid_api_key"
      }
    }),
    {
      status: 401,
      headers: corsHeaders(req, {
        "Content-Type": "application/json",
        "WWW-Authenticate": "Bearer"
      })
    }
  );
}

// Returns null when the request is authorized, otherwise a 401 Response.
function checkRequestAuth(req) {
  if (localAuthDisabled()) return null;
  const keys = activeApiKeys();
  if (!keys || keys.size === 0) return null;
  if (isSameOriginRequest(req)) return null;
  const key = presentedKey(req);
  if (key && keys.has(key)) return null;
  return unauthorizedResponse(req);
}

module.exports = {
  checkRequestAuth,
  clearAuthCache
};
