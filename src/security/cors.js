"use strict";

const DEFAULT_METHODS = "GET, POST, OPTIONS";
const DEFAULT_HEADERS = "Content-Type, Authorization, X-API-Key";

function splitOrigins(value = "") {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function originFromRequest(requestOrOrigin) {
  if (!requestOrOrigin) return "";
  if (typeof requestOrOrigin === "string") return requestOrOrigin;
  if (requestOrOrigin.headers && typeof requestOrOrigin.headers.get === "function") {
    return requestOrOrigin.headers.get("origin") || "";
  }
  return "";
}

function isLocalDevOrigin(origin) {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function isLanDevOrigin(origin) {
  if (!origin || process.env.AGENT_ROUTE_ALLOW_LAN_DEV !== "1" || process.env.NODE_ENV === "production") return false;
  try {
    const { hostname } = new URL(origin);
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
    const match = hostname.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
    return !!match && Number(match[1]) >= 16 && Number(match[1]) <= 31;
  } catch {
    return false;
  }
}

function allowedOrigins() {
  return splitOrigins(process.env.AGENT_ROUTE_ALLOWED_ORIGINS);
}

function isAllowedOrigin(origin) {
  const value = String(origin || "").trim();
  if (!value) return false;
  const configured = allowedOrigins();
  if (configured.includes(value)) return true;
  if (process.env.NODE_ENV !== "production" && isLocalDevOrigin(value)) return true;
  if (isLanDevOrigin(value)) return true;
  return false;
}

function corsHeaders(requestOrOrigin, extra = {}) {
  const headers = {
    Vary: "Origin",
    ...extra
  };
  const origin = originFromRequest(requestOrOrigin);
  if (isAllowedOrigin(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function preflightResponse(request, extra = {}) {
  return new Response(null, {
    status: isAllowedOrigin(originFromRequest(request)) ? 204 : 403,
    headers: corsHeaders(request, {
      "Access-Control-Allow-Methods": DEFAULT_METHODS,
      "Access-Control-Allow-Headers": DEFAULT_HEADERS,
      "Access-Control-Max-Age": "600",
      ...extra
    })
  });
}

function applyCorsHeaders(headers, requestOrOrigin) {
  const output = new Headers(headers || {});
  for (const [key, value] of Object.entries(corsHeaders(requestOrOrigin))) {
    output.set(key, value);
  }
  return output;
}

module.exports = {
  applyCorsHeaders,
  corsHeaders,
  isAllowedOrigin,
  preflightResponse
};
