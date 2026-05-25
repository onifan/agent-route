"use strict";

const fs = require("fs");
const path = require("path");

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function readJsonFile(file, fallback = {}) {
  if (!file) return clone(fallback);
  try {
    if (!fs.existsSync(file)) return clone(fallback);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw && typeof raw === "object" ? raw : clone(fallback);
  } catch (err) {
    console.warn(`[agent-route-repository] failed to read ${file}:`, err.message);
    return clone(fallback);
  }
}

function writeJsonFile(file, value) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(value, null, 2));
    fs.renameSync(tempFile, file);
  } catch (err) {
    console.warn(`[agent-route-repository] failed to write ${file}:`, err.message);
  }
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") return Object.values(value).map(clone);
  return [];
}

module.exports = {
  clone,
  normalizeArray,
  nowIso,
  readJsonFile,
  writeJsonFile
};
