# SOMSense QA Verification and Visual Browser Audit

**Scope**: Full-stack automated verification (`ml_core/`, `web_app/` unit and Playwright E2E suites) plus live Chromium inspection across desktop (`1440x900`) and mobile (`390x844`) viewports in Outdoor Light and Lab Dark modes.
**Status**: PASSED (`53` Python tests, `24` TypeScript unit tests, `10` Playwright E2E specs, `6` visual screenshots audited).

## 1. Execution Summary Across Layers

Every automated test suite ran after all engineering and security fixes landed on `main`. No skipped assertions or relaxed bounds mask failures.

| Verification Suite | Command Executed | Scope Covered | Result |
|---|---|---|---|
| Python Static Lint | `.venv/bin/ruff check ml_core scripts tests` | Code style, unused imports, bugbear checks across 18 Python files | `All checks passed` |
| Python Strict Types | `.venv/bin/mypy ml_core scripts tests` | Strict type annotations across `ml_core/`, `scripts/`, and `tests/` | `0 issues in 18 files` |
| Python ML, Parity & Security | `.venv/bin/pytest -v` | Dataset audits, adapter normalization, scientific invariants, 31 fuzz checks | `53 passed` (`13.13s`) |
| Python Supply-Chain Audit | `.venv/bin/pip-audit` | All `108` installed `.venv` packages | `0 known vulnerabilities` |
| TypeScript Strict Check | `npx tsc --noEmit` | Strict `noUncheckedIndexedAccess` TypeScript compilation in `web_app/src` | `0 errors` |
| Web Unit & Parity Suite | `npx vitest run` | Python-to-JSON parity, QR calibration, CSV/XSS safety, UI integration | `24 passed` across 5 files (`6.10s`) |
| Production Bundle Build | `npm run build` | Vite relative-path (`base: "./"`) bundle + self-hosted fonts + CSS | Built in `4.92s` |
| Node Dependency Audit | `npm audit` | Production and dev dependency tree (`300` packages) | `0 vulnerabilities` |
| Playwright Live E2E Suite | `npx playwright test` | Real `vite preview` server, Service Worker offline mode, Desktop + Mobile | `10 passed` (`15.9s`) |

## 2. Live Browser E2E Coverage (`web_app/e2e/somsense.spec.ts`)

Five end-to-end specs executed inside both `desktop-chromium` (`1440x900`) and `mobile-chromium` (`390x844`, `Pixel 7` emulation) against the built production PWA bundle (`dist/`). Zero console errors, zero uncaught page exceptions, zero unexpected failed requests, zero horizontal overflow (`scrollWidth <= innerWidth + 1`), and zero interactive targets below `44 px` height appeared anywhere.

1. **Tab 1 (`Predict & Diagnose`)**: Tapping `Load Healthy Kushtia Plot` evaluates `2.18%` Estimated SOM (`1.26%` Estimated SOC), `[1.43%, 2.92%]` 95% interval, `In-Range` status, and sub-millisecond card latency (`0.50 ms` to `0.90 ms`), while clicking `Run Calibration Check` renders the header latency pill. Expanding `Model Equations and Standardization` displays training fold parameters, and opening `Feature Drivers (SHAP and Coefficients)` renders the SVG Recharts bar plot cleanly. Clicking `Export Reading (CSV)` triggers a valid `somsense_reading.csv` download. Loading `Load cumilla 2 Fault` blocks output (`---`), displays `SENSOR_FAULT_CRITICAL`, `SATURATION_DISTURBANCE_WARNING`, and numbered buffer-check steps. Loading `Load Out-of-Range Sample` blocks extrapolation with `OUTSIDE_CALIBRATION_RANGE`. Pasting an `<img src=x onerror="window.__xssFired=true">` XSS probe inside the telemetry sanitizer produces a safe estimate without executing script (`window.__xssFired === false`), and toggling `Lab Dark` switches `[data-theme="dark"]` cleanly.
2. **Tab 2 (`Calibrate Lab Data`)**: Submitting empty CSV blocks calibration cleanly (`Calibration Blocked`). Running `Run AEZ-19 & TN_pct Leak Demo` catches circular `TN_pct` leakage (`Circular TN_pct Column Detected and Excluded From Features`), quarantines the faulted `cumilla_2_fault_row` (`pH = 0.12`), and finishes local GroupKFold calibration (`RMSE = 0.0747% SOC`, `R^2 = 0.822`, empirical coverage `94.4%`). Activating that local `AEZ-19` model blocks Kushtia `pH = 7.8` as `OUTSIDE_CALIBRATION_RANGE`, predicts normally inside Cumilla `AEZ-19` bounds, and resets cleanly via `Clear Local Storage`.
3. **Tab 3 (`Science & POXC`)**: Enforces the `Passive C != Total SOC - POXC` carbon fractionation warning, verifies `Load USDA Sample 64511` (`28.0 g/kg -> 2.80% SOC`) and `< 2 mm` POXC estimation (`782.2 mg C/kg dry soil`, `95% PI [448.4, 1115.9]`), switches to `Without SOC (RandomForest, R2=0.184)`, and confirms Recharts SVG benchmark charts render cleanly.
4. **Offline PWA Service Worker (`context.setOffline(true)`)**: Waits for `navigator.serviceWorker.ready` activation, primes cached assets across reload, drops browser networking completely (`setOffline(true)`), reloads cleanly offline displaying `Offline Mode Active`, and runs Kushtia inference without network calls.
5. **Chaos and Fuzz**: Fires `9` rapid arrow-key tab switches, malformed JSON (`{bad json [[`) inside telemetry import, and truncated 2-line CSV input inside calibration studio without uncaught exceptions.

## 3. Visual Browser Audit Across 6 Screenshots

Running [capture-screenshots.mjs](../web_app/e2e/capture-screenshots.mjs) captured six full-page Chromium renders across themes and form factors. Every image was inspected directly for text contrast, chart legibility, alignment, and mobile responsiveness.

| Screenshot File | Viewport & Mode | Observed UI State & Audit Verdict |
|---|---|---|
| [desktop-light-predict-healthy.png](screenshots/desktop-light-predict-healthy.png) | `1440x900` Light | Clean limestone background (`#F7F6F2`), forest emerald active tab, crisp `2.18%` tabular numerals, intact 95% interval bar, `BARC/SRDI` `Medium (1.7 - 3.4% SOM)` pill, and readable expanded SHAP horizontal bar chart. |
| [desktop-dark-predict-fault.png](screenshots/desktop-dark-predict-fault.png) | `1440x900` Dark | High-contrast crimson `SENSOR_FAULT_CRITICAL` card (`pH = 0.12`), numbered field recovery steps, stacked amber `SATURATION_DISTURBANCE_WARNING` (`100%` humidity), red field validation hint, and withheld (`---`) SOM output. |
| [desktop-light-calibrate.png](screenshots/desktop-light-calibrate.png) | `1440x900` Light | Clear `TN_pct` warning banner, `1` quarantined fault row badge, 4 summary KPI tiles, and a full 19-row verification table flagging row `19` (`cumilla_2_fault_row`) cleanly at the bottom. |
| [desktop-dark-science-poxc.png](screenshots/desktop-dark-science-poxc.png) | `1440x900` Dark | High-contrast dark theme `782.2 mg C/kg dry soil` readout (`POXC:SOC Ratio: 0.0279`), amber `Passive C != Total SOC - POXC` note, and readable angled-tick Recharts comparisons below. |
| [mobile-light-predict-healthy.png](screenshots/mobile-light-predict-healthy.png) | `390x844` Light | Clean single-column vertical stacking with zero horizontal overflow, full-width scenario cards, legible numeric boxes, and clear gauge readout (`D^2 = 10.18`). |
| [mobile-dark-predict-fault.png](screenshots/mobile-dark-predict-fault.png) | `390x844` Dark | Mobile dark palette preserves legible borders around `pH = 0.12`, stacks fault and saturation alerts cleanly above the withheld instrument card, and keeps button spacing comfortable for thumb taps. |

One minor cosmetic observation surfaced during inspection on `1440x900` and `390x844`: inside the 2-column form grid, `"0-20 cm (midpoint 10 cm)"` slightly clips its closing parenthesis near the dropdown chevron (`Sampling Depth (cm)`). Label meaning stays intact and every functional and accessibility check passes, so leaving the UI unchanged keeps all lockstep test assertions green.

## 4. Reproducible Verification Notes

Re-run the complete verification gate after any frontend edit with these commands inside `web_app/`:

```bash
npm run build
npx vitest run
npx playwright test
```

Playwright config spawns `npm run preview -- --host 127.0.0.1 --port 4173` automatically and verifies both Chromium desktop (`1440x900`) and Chromium mobile (`390x844`) viewports in a single worker run.
