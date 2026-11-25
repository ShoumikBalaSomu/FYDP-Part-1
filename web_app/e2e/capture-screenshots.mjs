import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WEB_ROOT = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(WEB_ROOT, "..");
const SCREENSHOT_DIR = path.join(REPO_ROOT, "docs", "screenshots");

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Server warming up
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Preview server failed to respond within ${timeoutMs}ms`);
}

async function settleAnimations(page) {
  await page.waitForTimeout(600);
}

async function main() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const server = spawn("npm", ["run", "preview", "--", "--host", "127.0.0.1", "--port", "4179"], {
    cwd: WEB_ROOT,
    stdio: "ignore",
  });

  const baseUrl = "http://127.0.0.1:4179/";
  try {
    await waitForServer(baseUrl);
    const browser = await chromium.launch({ headless: true });

    try {
      // 1. Desktop Light — Healthy Kushtia Plot + SHAP Drivers Accordion
      {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        await page.goto(baseUrl);
        await page.getByText("Offline Engine Ready").waitFor();
        await page.getByRole("button", { name: /Load Healthy Kushtia Plot/i }).click();
        await page.getByTestId("estimated-som-readout").waitFor();
        await page.getByRole("button", { name: /Feature Drivers \(SHAP and Coefficients\)/i }).click();
        await page.locator("#acc-drivers-panel svg.recharts-surface").waitFor();
        await settleAnimations(page);
        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, "desktop-light-predict-healthy.png"),
          fullPage: true,
        });
        await context.close();
      }

      // 2. Desktop Dark — Cumilla 2 Fault + Saturation Warning
      {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        await page.goto(baseUrl);
        await page.getByText("Offline Engine Ready").waitFor();
        await page.getByRole("button", { name: /Lab Dark/i }).click();
        await page.getByRole("button", { name: /Load cumilla 2 Fault/i }).click();
        await page.getByText("SENSOR_FAULT_CRITICAL").waitFor();
        await settleAnimations(page);
        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, "desktop-dark-predict-fault.png"),
          fullPage: true,
        });
        await context.close();
      }

      // 3. Desktop Light — Calibrate Lab Data (AEZ-19 & TN_pct Leak Demo)
      {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        await page.goto(baseUrl);
        await page.getByText("Offline Engine Ready").waitFor();
        await page.getByRole("tab", { name: /Calibrate Lab Data/i }).click();
        await page.getByRole("button", { name: /Run AEZ-19 & TN_pct Leak Demo/i }).click();
        await page.getByText(/Circular TN_pct Column Detected and Excluded/).waitFor();
        await settleAnimations(page);
        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, "desktop-light-calibrate.png"),
          fullPage: true,
        });
        await context.close();
      }

      // 4. Desktop Dark — Science & POXC (USDA Sample 64511 + Charts)
      {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        await page.goto(baseUrl);
        await page.getByText("Offline Engine Ready").waitFor();
        await page.getByRole("tab", { name: /Science & POXC/i }).click();
        await page.getByRole("button", { name: /Load USDA Sample 64511/i }).click();
        await page.getByTestId("poxc-readout").waitFor();
        await page.locator("#panel-science_poxc svg.recharts-surface").first().waitFor();
        await page.getByRole("button", { name: /Lab Dark/i }).click();
        await settleAnimations(page);
        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, "desktop-dark-science-poxc.png"),
          fullPage: true,
        });
        await context.close();
      }

      // 5. Mobile Light — Healthy Kushtia Plot
      {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const page = await context.newPage();
        await page.goto(baseUrl);
        await page.getByText("Offline Engine Ready").waitFor();
        await page.getByRole("button", { name: /Load Healthy Kushtia Plot/i }).click();
        await page.getByTestId("estimated-som-readout").waitFor();
        await settleAnimations(page);
        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, "mobile-light-predict-healthy.png"),
          fullPage: true,
        });
        await context.close();
      }

      // 6. Mobile Dark — Cumilla 2 Fault
      {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const page = await context.newPage();
        await page.goto(baseUrl);
        await page.getByText("Offline Engine Ready").waitFor();
        await page.getByRole("button", { name: /Lab Dark/i }).click();
        await page.getByRole("button", { name: /Load cumilla 2 Fault/i }).click();
        await page.getByText("SENSOR_FAULT_CRITICAL").waitFor();
        await settleAnimations(page);
        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, "mobile-dark-predict-fault.png"),
          fullPage: true,
        });
        await context.close();
      }

      console.log("Captured all 6 screenshots successfully in", SCREENSHOT_DIR);
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
