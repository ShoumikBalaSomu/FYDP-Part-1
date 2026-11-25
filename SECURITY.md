# Security Policy

## Supported Versions

Security updates and dependency patches apply to the active release branch below.

| Version | Status | Notes |
|---|---|---|
| `1.0.x` | Supported | Active Python core, PWA client, and release automation |
| `< 1.0.0` | Unsupported | Pre-release development snapshots |

## Reporting a Vulnerability

Do not open public issues for suspected security defects, leaked credentials, or parsing bypasses. Report privately fast. Send vulnerability details through the repository's GitHub Security Advisory workflow (`Security -> Advisories -> Report a vulnerability`) or contact the maintainer listed in commit metadata directly.

Include these four items in your report:

- Affected file path, module, or workflow configuration
- Minimal reproduction input or payload
- Observed failure mode (`Error`, unhandled exception, XSS vector, or supply-chain CVE)
- Potential impact on offline browser users or CI pipelines

Maintainers acknowledge private reports within `72` hours and issue a fix or mitigation note once verified.

## Security Architecture and Boundaries

SOMSense runs without a backend server or database. Plot data stays local. Zero sensor logs, plot GPS coordinates, or laboratory CSV rows leave the user's device during field inference or in-browser calibration.

### Browser Client Controls

1. **Strict Content Security Policy** inside `web_app/index.html` enforces `default-src 'self'`, blocks inline scripts and `unsafe-eval`, disables embedded plugins (`object-src 'none'`), and bundles `IBM Plex Sans`, `IBM Plex Mono`, and `Noto Sans Bengali` locally so offline PWA sessions make zero third-party network requests.
2. **Cryptographic Model Verification** validates `models/registry.json` on startup via browser WebCrypto (`crypto.subtle.digest`) against `canonical_payload_sha256` and rejects unverified artifacts immediately. Tampered files fail fast.
3. **Hostile Input Rejection** blocks `__proto__`, `constructor`, and `prototype` keys across JSON and CSV parsers, aborts on `NaN` or `Infinity` tokens, caps uploads at `10 MB` and `10,000` rows, and rejects malformed timestamps before numeric coercion.
4. **Spreadsheet Formula Neutralization** prepends a single quote (`'`) to every exported CSV cell starting with `=`, `+`, `-`, `@`, `\t`, or `\r` so Excel and LibreOffice Calc never evaluate formulas inside `site_id`, `device_id`, `crop`, or `notes`.
5. **Local Privacy Reset** wipes saved AEZ calibrations and cached readings in one click from the workspace header.

### Supply Chain and Credential Hygiene

CI workflows across GitHub Actions, GitLab CI, and Bitbucket Pipelines enforce `pip-audit`, GitLab SAST, GitLab Secret Detection, and weekly Dependabot updates for `pip`, `npm`, and `github-actions`. Secrets stay outside Git. Never store Kaggle API keys, GitHub tokens, GitLab tokens, or SSH passphrases inside repository files or `scripts/release-all.sh`. Local runs pull credentials strictly from ignored files (`.env`, `.kaggle/kaggle.json`) or environment variables configured outside Git.
