# SOMSense Security and Red-Team Audit Report

**Scope**: Full-stack security audit of SOMSense (`ml_core/`, `web_app/`, `scripts/`, and quad-platform CI/CD configs) following the Attack, Patch, Re-Attack protocol.
**Owner**: `@RedTeam_CISO`
**Status**: PASSED (0 surviving exploit vectors, 0 High/Critical CVEs)

## 1. Executive Verdict

Every attack vector tested against SOMSense now fails closed. During initial red-team testing on November 25, 2026, fifteen Python fuzz checks and five TypeScript adversarial test blocks broke through input boundaries, export sanitizers, and storage trust rules. Engineering fixes landed across `ml_core/` and `web_app/`. Subsequent re-attacks passed all 53 Python tests (including 31 security fuzz cases in [test_security_fuzz.py](../tests/test_security_fuzz.py)) and all 24 TypeScript tests (including 7 adversarial suites in [securityAdversarial.test.ts](../web_app/src/__tests__/securityAdversarial.test.ts)). Production builds stay offline-clean. Zero secrets, zero telemetry beacons, and zero High or Critical CVEs remain in the release tree.

## 2. Zero-Leak Secret, Privacy, and Bundle Scan

Automated and manual scans covered three layers: full Git commit history (`git log -p`), all current workspace text files, and the compiled production bundle under `web_app/dist/`.

| Inspection Target | Scope Checked | Result | Notes |
|---|---|---|---|
| Git history (`git log -p`) | All 3 commits (`a533b85`..`a909d48`) | 0 secrets | Zero `ghp_`, `github_pat_`, `glpat-`, `ATATT`, `AKIA`, PEM keys, or Kaggle secrets |
| Git history metadata and older snapshots | Author and prior path leaks | Remediated in `HEAD` | Commit `0871ba1` held local home-directory doc links and notebook paths. Commit `a909d48` and notebook cleanup scrubbed them all. |
| Built `web_app/dist/` JS/CSS/HTML | `index-BwrQH3Ed.js` (146,501 B) and vendor chunks | Clean | Zero home-directory strings, zero emails, zero `eval(` or `new Function`, and zero outbound telemetry URLs |
| Built `web_app/dist/models/registry.json` | File parity against `models/registry.json` | Exact match | Both files share SHA-256 `3db20ef2b594c95a8243768659c199a77b0c466213c7878ac26022b1ff21bb81` |
| Client-side privacy reset | Header Clear Local Storage button (`App.tsx`) | Verified | Clears `localStorage`, deletes IndexedDB `somsense_local_db`, and resets UI state generation |

Vendor bundle analysis inside `charts_vendor-DeY-Fruy.js` (531,909 B) shows W3C XML/SVG namespace URIs (`http://www.w3.org/2000/svg`, `http://www.w3.org/1999/xhtml`), static React error link strings (`https://reactjs.org/docs/error-decoder.html?invariant=`), and React DOM's internal `innerHTML`/`dangerouslySetInnerHTML` property handlers. Application code in `index-BwrQH3Ed.js` contains zero `eval`, zero `new Function`, zero `innerHTML`, and zero `dangerouslySetInnerHTML` calls. It stays local. The sole application `fetch` targets `./models/registry.json`.

## 3. Dependency CVE and CI/CD Supply-Chain Audit

Dependency scanners ran against the Python virtual environment and the production `web_app` lockfile. Zero CVEs surfaced.

1. **Python (`pip-audit`)**: `.venv/bin/pip-audit` scanned 108 installed Python packages and returned exit code `0` (`No known vulnerabilities found`).
2. **JavaScript (`npm audit --prefix web_app`)**: Initial execution failed with `ENOLOCK` because `web_app/package-lock.json` had been deleted after a `vitest` version change (`RT-01`). Once `@builder` regenerated `web_app/package-lock.json` (`vitest@^5.1.1`), `npm audit --prefix web_app` exited `0` with `0` vulnerabilities across 300 packages (`49` prod, `252` dev, `53` optional, `8` peer).
3. **CI/CD and Release Scripts**: Reviewed `.github/workflows/ci-release.yml`, `.github/dependabot.yml`, `.gitlab-ci.yml`, `bitbucket-pipelines.yml`, and [release-all.sh](../scripts/release-all.sh). All workflows pull credentials strictly from secret managers (`secrets.KAGGLE_KEY`, `secrets.GITHUB_TOKEN`, `$BITBUCKET_ACCESS_TOKEN`), enforce least-privilege workflow `contents: read` permissions by default, enable GitLab SAST and Secret Detection templates, and validate `models/registry.json` parity. Remote URLs with embedded `://user:pass@` credentials abort immediately in `release-all.sh`. A Python preflight also scans tracked and untracked files before push. Future releases can pin third-party GitHub Actions (such as `softprops/action-gh-release`) to full 40-character commit SHAs instead of major version tags (`@v3`/`@v4`).

## 4. CSP and Service Worker Audit

Inspecting [index.html](../web_app/index.html) and compiled `web_app/dist/index.html` confirms strict client-side isolation:

```text
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self';
```

All three typography families (`IBM Plex Sans`, `IBM Plex Mono`, `Noto Sans Bengali`) ship inside `web_app/dist/assets/`, leaving zero external font or CDN origins. Inline scripts are blocked. No `unsafe-eval` token exists anywhere in CSP headers. `style-src` permits `'unsafe-inline'` strictly for React gauge position styles and Recharts SVG attributes. Because GitHub Pages and static `<meta>` CSP tags cannot enforce HTTP `frame-ancestors`, clickjacking protection can be strengthened at Cloudflare Pages or custom proxy response headers (`frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`). In [sw.js](../web_app/public/sw.js), line 36 (`url.origin !== self.location.origin`) rejects cross-origin caching so offline storage holds only same-origin `GET` assets. Cross-origin traffic stays uncached.

## 5. Attack, Patch, and Re-Attack Findings Log

All findings below were reproduced directly against running code, dispatched to `@ml_scientist` (`seq #17`) or `@builder` (`seq #18`), patched (`seq #19`, `seq #20`), and verified via automated adversarial suites.

### RT-01 (High): Missing `web_app/package-lock.json` Breaking Lockfile Audit and `npm ci`
- **Location**: `web_app/package.json` vs missing `web_app/package-lock.json`.
- **Exploit / Failure**: Running `npm audit --prefix web_app` exited with `ENOLOCK`, blocking CVE checks and breaking `npm ci` across GitHub Actions, GitLab CI, and Bitbucket Pipelines.
- **Fix Applied**: `@builder` finalized `vitest@^5.1.1` and committed regenerated `web_app/package-lock.json`.
- **Re-Attack Verdict**: `npm audit --prefix web_app` and `npm ci` pass cleanly (`0` vulnerabilities across 300 packages). Lockfile parity holds.

### RT-02 (High): Missing Python Fail-Closed Registry Verifier (`registryLoader` Parity)
- **Location**: `ml_core/export_artifacts.py` (lacked `verify_registry_document` / `load_and_verify_registry`).
- **Exploit**: Python callers consuming `models/registry.json` had no library function rejecting mutated weights, tree leaf values, or forged SHA-256 hashes before inference. Meanwhile, TypeScript `parseAndVerifyRegistryText` already enforced WebCrypto SHA-256 checks.
- **Fix Applied**: `@ml_scientist` added `verify_registry_document` and `load_and_verify_registry` in [export_artifacts.py](../ml_core/export_artifacts.py#L361-L416), checking `platform`, `authority_protocol` flags, `canonical_payload_sha256`, and every model's `artifact_sha256`.
- **Re-Attack Verdict**: Mutating 1 OLS intercept (`+0.0001`), 1 HGB tree leaf (`+0.05`), 1 hex char in `canonical_payload_sha256`, or 1 hex char in `artifact_sha256` raises `ValueError` in Python (`test_python_registry_loader_rejects_tampered_weight_or_hash`) and rejects in TypeScript (`securityAdversarial.test.ts`), blocking UI startup (`Integrity Check Failed`).

### RT-03 (High): `1e308` Numerical Poison Overflow Bypassing OOD and Critical Gates
- **Location**: `ml_core/soil_physics.py:51-53`, `ml_core/export_artifacts.py:243-358`, `web_app/src/engine/soilPhysics.ts:36-41`, `web_app/src/engine/inferenceEngine.ts:144-172`.
- **Exploit**: Passing `K = 1e308` with `cmol(+)/kg` caused `k_cmol_to_mg_kg(1e308)` and `kCmolToMgKg(1e308)` to overflow silently to `Infinity`. In TypeScript `assessOod`, `!Number.isFinite(Infinity)` treated the poisoned potassium reading as a missing feature and mean-imputed it, returning `"Caution"` instead of blocking. Passing `N = 1e308` on `srdi_kushtia_om_champion` (which excludes `N` from OOD bounds) passed as `"In-Range"` (`2.18%` SOM), while `predict_from_registry_entry` on Kaggle triggered a numpy `matmul` overflow returning `d2 = inf`.
- **Fix Applied**: Both Python and TypeScript now check `isfinite` after `391.0` conversion, enforce upper physical sanity gates (`1e6` mg/kg N/P/K/Salinity, `1000` dS/m EC, `1000` cm depth, `100%` texture/TN) as `SENSOR_FAULT_CRITICAL`, reject `abs(val) > 1e12` or non-finite `d2` in Python `predict_from_registry_entry`, and cap non-finite `mahalanobisD2` safely in TypeScript.
- **Re-Attack Verdict**: All `1e308`, `1e309`, `NaN`, `Infinity`, and `-Infinity` vectors fail closed or block prediction across both runtimes. No silent overflow survives.

### RT-04 (High): Deep JSON Nesting Stack Exhaustion and Tree-Cycle DoS
- **Location**: `ml_core/esrc_adapter.py:166,250-266`, `web_app/src/engine/esrcAdapter.ts:125-148`, `web_app/src/engine/registryLoader.ts:18-149`, `web_app/src/engine/inferenceEngine.ts:16-33`.
- **Exploit**: Depth-40 JSON (`{"a": ...}`) passed without rejection, while depth-1500 crashed Python with `RecursionError` and depth-12000 crashed TypeScript `parseRawJsonAst` with `RangeError: Maximum call stack size exceeded`. A tampered local tree with `children_left[0] = 0` caused an infinite `while` loop hang inside `evalSerializedTree`.
- **Fix Applied**: Both Python and TypeScript JSON parsers now run an iterative `O(N)` pre-scan enforcing `MAX_JSON_DEPTH = 32`, `reject_prototype_pollution` in Python runs iteratively without recursion, and both `evalSerializedTree` (TS) and `_eval_serialized_tree` (Python) halt with an error if traversal steps reach `children_left.length`.
- **Re-Attack Verdict**: Depth 40, depth 1500, depth 12000, and self-looping trees abort cleanly in milliseconds.

### RT-05 (Medium): CSV Formula Injection Gaps Across Imports, Headers, and Exports
- **Location**: `ml_core/esrc_adapter.py:80-84,216,219,241,325,334-343`, `web_app/src/engine/esrcAdapter.ts:76-81`, `web_app/src/engine/reportExporter.ts:97-102,127-173`.
- **Exploit**: Leading newline or leading space payloads (`"\n=1+1"`, `" =CMD|'/C calc'!A0"`) bypassed `startswith` checks. Metadata fields (`aez_zone`, `depth_cm`, `texture_class`, `lab_method`), DataFrame column headers in `export_safe_csv`, `raw_site_id` inside `exportReadingToJsonBundle`, and Markdown headers in `exportReadingToMarkdownBrief` retained raw formula prefixes.
- **Fix Applied**: Sanitizers now neutralize `\n`, `\r`, `\t`, and `lstrip()`/`trimStart()` formula prefixes (`=`, `+`, `-`, `@`), normalize multi-line `\r`/`\n` inside cells, sanitize all string metadata fields, sanitize DataFrame headers in `export_safe_csv`, sanitize `raw_site_id`/`raw_device_id` inside JSON bundles, and parse multiline RFC-4180 CSVs in TypeScript.
- **Re-Attack Verdict**: All 8 formula vectors pass across CSV import, safe CSV export, JSON bundle export, and Markdown brief export in both languages.

### RT-06 (Medium): Unescaped HTML/XSS Payloads in Markdown Exports
- **Location**: `web_app/src/engine/reportExporter.ts:127-173`, `web_app/src/components/CalibrateLabTab.tsx:133-149`.
- **Exploit**: Supplying `<script>alert(1)</script>` or `<svg onload=alert(1)>` as `site_id`, `device_id`, or `modelLabel` wrote raw executable HTML tags directly into downloaded `.md` briefs and calibration certificates (while React DOM rendering remained safe).
- **Fix Applied**: `sanitizeMarkdownText` escapes angle brackets into HTML entities alongside formula neutralization across `exportReadingToMarkdownBrief` and `buildCertificateMarkdown`.
- **Re-Attack Verdict**: Exported Markdown contains zero raw `<script>` or `<svg>` elements, and React UI DOM checks confirm zero injected script or event-handler nodes. Stored XSS fails.

### RT-07 (Medium): Untrusted `localStorage` Model Shadowing and Prototype Keys
- **Location**: `web_app/src/engine/registryLoader.ts:292-302`, `web_app/src/App.tsx:69-74`.
- **Exploit**: `loadLocalCalibratedModels` parsed `localStorage` via bare `JSON.parse` without key filtering or SHA-256 checks, and `App.tsx` merged `...localModels` after `...registry.models`, letting tampered `localStorage` entries overwrite verified `srdi_kushtia_om_champion`.
- **Fix Applied**: `loadLocalCalibratedModels` strips `__proto__`, `constructor`, and `prototype`, enforces `^local_[a-z0-9_]+$` keys, validates non-zero 64-hex `artifact_sha256` and `TN_pct` exclusion, and `App.tsx` merges `{ ...localModels, ...(registry?.models ?? {}) }` so verified built-in models always win.
- **Re-Attack Verdict**: Poisoned `localStorage` entries leave `Object.prototype` clean and never replace verified registry models.

### RT-08 (Medium): Python `esrc_adapter.py` Upload, BOM, and Overflow Edge Cases
- **Location**: `ml_core/esrc_adapter.py:20,142-157,291-313`.
- **Exploit**: `MAX_UPLOAD_ROWS` sat at `50_000` instead of the documented `10_000` cap, `parse_aez_csv` probed `Path(source).exists()` before enforcing `max_bytes`, `\ufeff__proto__` bypassed CSV header checks, and `_parse_depth_midpoint("0-" + "1"*50_000)` returned `float('inf')` causing a Pydantic `ValidationError`.
- **Fix Applied**: `@ml_scientist` aligned `MAX_UPLOAD_ROWS = 10_000`, enforced `max_bytes` before `Path` checks, required `>= 2` non-comment CSV lines, stripped `\ufeff` from CSV headers before prototype checks, and added finite plus 64-char caps to `_parse_depth_midpoint` and `_validate_iso_timestamp`.
- **Re-Attack Verdict**: Single-line >10 MB CSVs, 10,001-row batches, BOM-prefixed `__proto__` headers, and 50,000-char pathological depth/timestamp inputs fail fast within `< 200 ms`.

## 6. Post-Patch Verification Evidence

All verification commands ran after the final patches landed across `ml_core/`, `web_app/`, and test suites:

- `.venv/bin/pytest -v`: **53 passed in 12.45s** (`test_security_fuzz.py`: `31/31`, `test_ml_core.py`: `10/10`, `test_esrc_adapter.py`: `6/6`, `test_invariants.py`: `6/6`).
- `.venv/bin/ruff check .`: **All checks passed**.
- `.venv/bin/mypy ml_core scripts tests`: **Success: no issues found in 18 source files**.
- `.venv/bin/pip-audit`: **No known vulnerabilities found** across 108 packages.
- `npx tsc --noEmit` (inside `web_app/`): **0 errors**.
- `npm test` (`vitest run` inside `web_app/`): **5 files, 24 passed** (`securityAdversarial.test.ts`: `7/7`, `appUi.test.tsx`: `5/5`, `parity.test.ts`: `5/5`, `physicsAndAdapter.test.ts`: `5/5`, `calibrationAndExport.test.ts`: `2/2`).
- `npm run build` (inside `web_app/`): **Built cleanly in 5.93s**, producing offline bundle `dist/` with matching `models/registry.json` SHA-256.
- `npm audit --prefix web_app`: **found 0 vulnerabilities** across 300 packages. Zero vectors survive.
