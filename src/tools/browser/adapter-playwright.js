"use strict";

function loadPlaywright() {
  try {
    return require("playwright-core");
  } catch {
    return null;
  }
}

async function createSession(options = {}) {
  const playwright = loadPlaywright();
  if (!playwright) {
    throw new Error(
      "Playwright is not installed. Configure tools.browser.adapter=mock or add Playwright as a project dependency."
    );
  }
  const browserType = String(options.browserType || "chromium");
  const launcher = playwright[browserType] || playwright.chromium;
  let browser;
  let context;
  let page;
  if (options.cdpEndpoint) {
    browser = await playwright.chromium.connectOverCDP(options.cdpEndpoint, {
      timeout: Number(options.timeoutMs || 30000)
    });
    context = browser.contexts()[0] || (await browser.newContext());
    page = context.pages()[0] || (await context.newPage());
  } else {
    const channel = options.channel || process.env.AGENT_ROUTE_BROWSER_CHANNEL || "chrome";
    browser = await launcher.launch({
      headless: options.headless !== false,
      channel,
      timeout: Number(options.timeoutMs || 30000)
    });
    context = await browser.newContext();
    page = await context.newPage();
  }

  return {
    adapter: "playwright",
    browserType,
    headless: options.headless !== false,
    async openUrl(url, gotoOptions = {}) {
      await page.goto(url, {
        waitUntil: gotoOptions.waitUntil || "domcontentloaded",
        timeout: Number(gotoOptions.timeoutMs || options.timeoutMs || 30000)
      });
      return {
        currentUrl: page.url(),
        title: await page.title(),
        pageText: await page.textContent("body").catch(() => "")
      };
    },
    async currentUrl() {
      return page.url();
    },
    async title() {
      return page.title();
    },
    async pageText() {
      return page.textContent("body").catch(() => "");
    },
    async screenshot(filePath, screenshotOptions = {}) {
      await page.screenshot({ path: filePath, ...(screenshotOptions || {}) });
      return filePath;
    },
    async click(selector, clickOptions = {}) {
      const { timeoutMs, ...rest } = clickOptions || {};
      await page.click(selector, {
        timeout: Number(timeoutMs || options.timeoutMs || 30000),
        ...rest
      });
      return {
        selector,
        currentUrl: page.url(),
        title: await page.title(),
        pageText: await page.textContent("body").catch(() => "")
      };
    },
    async fill(selector, text, fillOptions = {}) {
      const { timeoutMs, ...rest } = fillOptions || {};
      await page.fill(selector, String(text == null ? "" : text), {
        timeout: Number(timeoutMs || options.timeoutMs || 30000),
        ...rest
      });
      return {
        selector,
        currentUrl: page.url(),
        title: await page.title(),
        pageText: await page.textContent("body").catch(() => ""),
        domChanged: true
      };
    },
    async scroll({ x = 0, y = 600 } = {}) {
      await page.evaluate(({ scrollX, scrollY }) => window.scrollBy(scrollX, scrollY), {
        scrollX: Number(x || 0),
        scrollY: Number(y || 0)
      });
      return {
        currentUrl: page.url(),
        title: await page.title(),
        pageText: await page.textContent("body").catch(() => "")
      };
    },
    async waitForSelector(selector, waitOptions = {}) {
      const { timeoutMs, ...rest } = waitOptions || {};
      await page.waitForSelector(selector, {
        timeout: Number(timeoutMs || options.timeoutMs || 30000),
        ...rest
      });
      return {
        selector,
        found: true,
        currentUrl: page.url(),
        title: await page.title(),
        pageText: await page.textContent("body").catch(() => "")
      };
    },
    async close() {
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
      return true;
    }
  };
}

module.exports = {
  createSession,
  isPlaywrightAvailable: () => Boolean(loadPlaywright())
};
