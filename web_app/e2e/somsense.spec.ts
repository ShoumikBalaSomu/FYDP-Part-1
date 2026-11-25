import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";

interface PageErrorMonitor {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
}

function attachErrorListeners(page: Page): PageErrorMonitor {
  const monitor: PageErrorMonitor = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
  };
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") {
      monitor.consoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", (err: Error) => {
    monitor.pageErrors.push(err.message);
  });
  page.on("requestfailed", (req) => {
    // Expected failures during intentional offline testing are ignored outside online flows
    monitor.failedRequests.push(`${req.method()} ${req.url()} (${req.failure()?.errorText ?? "failed"})`);
  });
  return monitor;
}

async function waitForEngineReady(page: Page): Promise<void> {
  await expect(page.getByText("Offline Engine Ready")).toBeVisible();
  await expect(page.getByText(/Registry SHA-256:/)).toBeVisible();
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 1);
}

async function assertTouchTargetsAtLeast44Px(page: Page): Promise<void> {
  const undersized = await page.evaluate(() => {
    const els = Array.from(
      document.querySelectorAll<HTMLElement>(
        "header button, main button, main [role='tab'], main select, main input:not([type='file']):not(.sr-only)"
      )
    );
    const bad: string[] = [];
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.height < 43.5) {
        bad.push(`${el.tagName}#${el.id || "?"}(${el.innerText.slice(0, 24)}): h=${rect.height.toFixed(1)}`);
      }
    }
    return bad;
  });
  expect(undersized).toEqual([]);
}

test.describe("SOMSense ESRC Platform E2E Verification", () => {
  test("Tab 1: Predict & Diagnose presets, Sensor Health Doctor, OOD guardrails, accordions, XSS sanitization & exports", async ({
    page,
  }) => {
    const monitor = attachErrorListeners(page);
    await page.goto("./");
    await waitForEngineReady(page);
    await assertNoHorizontalOverflow(page);
    await assertTouchTargetsAtLeast44Px(page);

    // 1. Healthy Kushtia Plot preset -> valid prediction + In-Range + latency pill + accordions
    await page.getByRole("button", { name: /Load Healthy Kushtia Plot/i }).click();
    const somReadout = page.getByTestId("estimated-som-readout");
    await expect(somReadout).toHaveText(/^\d+\.\d{2}%$/);
    await expect(page.getByTestId("domain-status-pill")).toContainText("In-Range");
    await expect(page.getByText(/Latency \d+\.\d{2} ms/)).toBeVisible();
    await page.getByRole("button", { name: /Run Calibration Check/i }).click();
    await expect(page.getByText(/Local inference completed in \d+\.\d{2} ms/)).toBeVisible();

    // Expand Equation accordion & check Table
    const eqButton = page.getByRole("button", { name: /Model Equations and Standardization/i });
    await expect(eqButton).toHaveAttribute("aria-expanded", "false");
    await eqButton.click();
    await expect(eqButton).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#acc-equations-panel table")).toBeVisible();

    // Expand Feature Drivers accordion & verify Recharts SVG renders
    const shapButton = page.getByRole("button", { name: /Feature Drivers \(SHAP and Coefficients\)/i });
    await shapButton.click();
    await expect(shapButton).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#acc-drivers-panel svg.recharts-surface")).toBeVisible();

    // Export CSV smoke check (download event)
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /Export Reading \(CSV\)/i }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("somsense_reading.csv");

    // 2. cumilla 2 Fault preset (pH=0.12, Moisture=100%) -> blocks prediction cleanly
    await page.getByRole("button", { name: /Load cumilla 2 Fault/i }).click();
    await expect(somReadout).toHaveText("---");
    await expect(page.getByText("SENSOR_FAULT_CRITICAL")).toBeVisible();
    await expect(page.getByText("SATURATION_DISTURBANCE_WARNING")).toBeVisible();
    await expect(page.getByText("Field Check Steps")).toBeVisible();

    // 3. Wet Paddy Caution preset -> saturation flag still shows Caution / prediction or warning
    await page.getByRole("button", { name: /Load Wet Paddy Caution/i }).click();
    await expect(page.getByText("SATURATION_DISTURBANCE_WARNING")).toBeVisible();

    // 4. Out-of-Range Sample preset -> blocks numeric extrapolation
    await page.getByRole("button", { name: /Load Out-of-Range Sample/i }).click();
    await expect(somReadout).toHaveText("---");
    await expect(page.getByText("OUTSIDE_CALIBRATION_RANGE")).toBeVisible();

    // 5. Raw Telemetry JSON import with XSS attempt in site name (using SRDI-in-domain pH=7.8)
    const rawButton = page.getByRole("button", { name: /Raw Telemetry JSON Import and Sanitizer/i });
    await rawButton.click();
    const xssPayload = JSON.stringify({
      Device: "ESRC Device - 1",
      site: '<img src=x onerror="window.__xssFired=true">',
      depth_cm: "0-20",
      PH: 7.8,
      Humidity: 36,
      EC: 0.54,
      EC_unit: "dS/m",
      Temperature: 26.8,
      Nitrogen: 210,
      Phosphorus: 22.5,
      Potassium: 89.93,
    });
    await page.locator("#acc-raw-panel textarea").fill(xssPayload);
    await page.getByRole("button", { name: /Parse and Validate JSON/i }).click();
    await expect(page.getByText(/Normalized 1 ESRC JSON record\(s\)/)).toBeVisible();
    await expect(somReadout).toHaveText(/^\d+\.\d{2}%$/);
    const xssFired = await page.evaluate(() => Boolean((window as unknown as Record<string, unknown>)["__xssFired"]));
    expect(xssFired).toBe(false);

    // 6. Theme toggle (Light <-> Dark)
    await page.getByRole("button", { name: /Lab Dark/i }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("button", { name: /Outdoor Light/i })).toBeVisible();

    // Verify background/text CSS tokens actually updated cleanly for Dark mode
    const colors = await page.evaluate(() => {
      const style = getComputedStyle(document.body);
      return { bg: style.backgroundColor, color: style.color };
    });
    expect(colors.bg).not.toBe(colors.color);

    await assertNoHorizontalOverflow(page);
    expect(monitor.consoleErrors).toEqual([]);
    expect(monitor.pageErrors).toEqual([]);
    expect(monitor.failedRequests).toEqual([]);
  });

  test("Tab 2: Calibrate Lab Data demo, TN_pct exclusion, fault quarantine, activation & reset", async ({
    page,
  }) => {
    const monitor = attachErrorListeners(page);
    await page.goto("./");
    await waitForEngineReady(page);

    // Navigate to Tab 2
    await page.getByRole("tab", { name: /Calibrate Lab Data/i }).click();
    await expect(page.locator("#panel-calibrate_lab")).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertTouchTargetsAtLeast44Px(page);

    // Empty run validation alert
    await page.getByRole("button", { name: /Run Local GroupKFold Recalibration/i }).click();
    await expect(page.getByText("Calibration Blocked")).toBeVisible();

    // Run AEZ-19 & TN_pct Leak Demo
    await page.getByRole("button", { name: /Run AEZ-19 & TN_pct Leak Demo/i }).click();
    await expect(
      page.getByText("Circular TN_pct Column Detected and Excluded From Features")
    ).toBeVisible();
    await expect(page.getByText("Quarantined 1 Faulted Calibration Row(s)")).toBeVisible();
    await expect(page.getByText(/Held-Out GroupKFold RMSE/)).toBeVisible();

    // Activate local model -> jumps to Tab 1 with local AEZ-19 model selected
    await page.getByRole("button", { name: /Activate Local AEZ Model/i }).click();
    await expect(page.locator("#panel-predict_diagnose")).toBeVisible();

    // Kushtia plot lies outside the AEZ-19 Cumilla local domain -> OOD safety triggers accurately
    await page.getByRole("button", { name: /Load Healthy Kushtia Plot/i }).click();
    await expect(page.getByTestId("estimated-som-readout")).toHaveText("---");
    await expect(page.getByText("OUTSIDE_CALIBRATION_RANGE")).toBeVisible();

    // Now enter an in-domain AEZ-19 Cumilla sample (matching buildAez19LeakDemoCsv bounds)
    await page.getByLabel("Soil pH (pH units)").fill("6.5");
    await page.getByLabel("Available Nitrogen N (mg/kg)").fill("190");
    await page.getByLabel("Phosphorus P (mg/kg)").fill("19.5");
    await page.getByLabel("Potassium K").fill("185");
    await page.getByLabel("Electrical Conductivity (EC)").fill("0.52");
    await page.getByLabel("Soil Temperature (deg C)").fill("27.8");
    await page.getByLabel("Soil Moisture / Humidity (%)").fill("34.0");
    await expect(page.getByTestId("estimated-som-readout")).toHaveText(/^\d+\.\d{2}%$/);

    // Clear Local Storage privacy reset button removes local calibrated model & resets to default champion
    await page.getByRole("button", { name: /Clear Local Storage/i }).click();
    await expect(
      page.getByText("Cleared all locally stored calibration models and browser state.")
    ).toBeAttached();
    await expect(page.getByLabel("Active Calibration Model")).toHaveValue("srdi_kushtia_om_champion");
    await page.getByRole("button", { name: /Clear Inputs/i }).click();
    await expect(page.getByText(/Enter field readings on the left/i)).toBeVisible();

    expect(monitor.consoleErrors).toEqual([]);
    expect(monitor.pageErrors).toEqual([]);
    expect(monitor.failedRequests).toEqual([]);
  });

  test("Tab 3: Science & POXC calculator, Passive C guardrail & Leakage Lab charts", async ({ page }) => {
    const monitor = attachErrorListeners(page);
    await page.goto("./");
    await waitForEngineReady(page);

    await page.getByRole("tab", { name: /Science & POXC/i }).click();
    await expect(page.locator("#panel-science_poxc")).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertTouchTargetsAtLeast44Px(page);

    // Verify Passive C != Total SOC - POXC guardrail
    await expect(page.getByText(/Passive C != Total SOC - POXC/)).toBeVisible();

    // Load USDA Sample 64511 (28.0 g/kg -> 2.80% SOC)
    await page.getByRole("button", { name: /Load USDA Sample 64511/i }).click();
    await expect(page.getByText("Converted to %SOC: 2.80%")).toBeVisible();
    await expect(page.getByTestId("poxc-readout")).toHaveText(/\d+\.\d mg C\/kg dry soil/);

    // Switch to Without SOC (RandomForest)
    await page.getByRole("button", { name: /Without SOC \(RandomForest/i }).click();
    await expect(page.getByTestId("poxc-readout")).toHaveText(/\d+\.\d mg C\/kg dry soil/);
    await expect(page.getByText("N/A (no SOC input)")).toBeVisible();

    // Recharts benchmark charts visible
    const chartCount = await page.locator("#panel-science_poxc svg.recharts-surface").count();
    expect(chartCount).toBeGreaterThanOrEqual(2);

    expect(monitor.consoleErrors).toEqual([]);
    expect(monitor.pageErrors).toEqual([]);
    expect(monitor.failedRequests).toEqual([]);
  });

  test("PWA Offline Mode: Service Worker caches app & registry and runs predictions offline", async ({
    page,
    context,
  }) => {
    await page.goto("./");
    await waitForEngineReady(page);

    // Ensure Service Worker is installed & controlling client
    const swActive = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return false;
      const reg = await navigator.serviceWorker.ready;
      return Boolean(reg.active);
    });
    expect(swActive).toBe(true);

    // Reload once online so SW intercepts and caches bundled assets & registry
    await page.reload({ waitUntil: "networkidle" });
    await waitForEngineReady(page);

    // Switch browser offline
    await context.setOffline(true);
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByText("Offline Mode Active")).toBeVisible();
      await page.getByRole("button", { name: /Load Healthy Kushtia Plot/i }).click();
      await expect(page.getByTestId("estimated-som-readout")).toHaveText(/^\d+\.\d{2}%$/);
    } finally {
      await context.setOffline(false);
    }
  });

  test("Chaos & Fuzz: rapid keyboard tab switching + malformed JSON + oversized/corrupt CSV", async ({
    page,
  }) => {
    const monitor = attachErrorListeners(page);
    await page.goto("./");
    await waitForEngineReady(page);

    // Rapid keyboard ArrowRight navigation across tabs
    const firstTab = page.getByRole("tab", { name: /Predict & Diagnose/i });
    await firstTab.focus();
    for (let i = 0; i < 9; i++) {
      await page.keyboard.press("ArrowRight");
    }
    await expect(page.locator("#panel-predict_diagnose")).toBeVisible();

    // Malformed JSON into raw telemetry accordion
    await page.getByRole("button", { name: /Raw Telemetry JSON Import and Sanitizer/i }).click();
    await page.locator("#acc-raw-panel textarea").fill("{bad json [[");
    await page.getByRole("button", { name: /Parse and Validate JSON/i }).click();
    await expect(page.locator("#acc-raw-panel [role='alert']")).toBeVisible();

    // Corrupt / insufficient CSV rows in Calibrate Lab Data
    await page.getByRole("tab", { name: /Calibrate Lab Data/i }).click();
    await page.locator("#panel-calibrate_lab textarea").fill("bad_header_only\n1,2,3");
    await page.getByRole("button", { name: /Run Local GroupKFold Recalibration/i }).click();
    await expect(page.getByText("Calibration Blocked")).toBeVisible();

    expect(monitor.consoleErrors).toEqual([]);
    expect(monitor.pageErrors).toEqual([]);
  });
});
