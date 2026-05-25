"use strict";

const fs = require("fs");
const { fileURLToPath } = require("url");

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ax8R0sAAAAASUVORK5CYII=",
  "base64"
);

function decodeEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function htmlTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return decodeEntities(match ? match[1].replace(/<[^>]+>/g, "") : "");
}

function htmlText(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function htmlFromDataUrl(url) {
  const match = String(url || "").match(/^data:text\/html(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i);
  if (!match) return "";
  const body = match[2] || "";
  if (match[1]) return Buffer.from(body, "base64").toString("utf8");
  return decodeURIComponent(body);
}

function htmlFromUrl(url) {
  const value = String(url || "");
  if (value.startsWith("data:text/html")) return htmlFromDataUrl(value);
  if (value.startsWith("file:")) {
    try {
      return fs.readFileSync(fileURLToPath(value), "utf8");
    } catch {
      return "";
    }
  }
  return `<html><head><title>${value}</title></head><body>${value}</body></html>`;
}

async function createSession(options = {}) {
  const state = {
    url: "about:blank",
    title: "",
    html: "",
    text: "",
    fields: {},
    scrollX: 0,
    scrollY: 0,
    options
  };
  return {
    adapter: "mock",
    browserType: "mock",
    headless: true,
    async openUrl(url) {
      state.url = String(url || "about:blank");
      state.html = htmlFromUrl(state.url);
      state.title = htmlTitle(state.html) || state.url;
      state.text = htmlText(state.html);
      return { currentUrl: state.url, title: state.title, pageText: state.text };
    },
    async currentUrl() {
      return state.url;
    },
    async title() {
      return state.title;
    },
    async pageText() {
      return state.text;
    },
    async screenshot(filePath) {
      fs.mkdirSync(require("path").dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, PNG_1X1);
      return filePath;
    },
    async click(selector) {
      return { selector, currentUrl: state.url, title: state.title, pageText: state.text, domChanged: false };
    },
    async fill(selector, text) {
      state.fields[String(selector || "")] = { length: String(text || "").length };
      return { selector, currentUrl: state.url, title: state.title, pageText: state.text, domChanged: true };
    },
    async scroll({ x = 0, y = 600 } = {}) {
      state.scrollX += Number(x || 0);
      state.scrollY += Number(y || 0);
      return {
        currentUrl: state.url,
        title: state.title,
        pageText: state.text,
        scrollX: state.scrollX,
        scrollY: state.scrollY
      };
    },
    async waitForSelector(selector) {
      const found = String(state.html || "").includes(String(selector || "").replace(/^#|\./, ""));
      return { selector, found, currentUrl: state.url, title: state.title, pageText: state.text };
    },
    async close() {
      return true;
    }
  };
}

module.exports = {
  createSession
};
