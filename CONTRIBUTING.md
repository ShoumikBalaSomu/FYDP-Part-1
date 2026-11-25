# Contributing to SOMSense

Contributions to `ml_core/`, `web_app/`, documentation, and CI tooling follow strict scientific, security, and parity rules so field predictions never drift from laboratory calibration truth.

## Local Development Setup

### Python Core (`>= 3.11`, CI runs `3.12+`)

Create a virtual environment, install development tools, and verify public benchmark hashes:

```bash
python -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -e ".[dev]"
python scripts/fetch_datasets.py --skip-kaggle
```

If you have local Kaggle credentials in `.kaggle/kaggle.json` or `KAGGLE_USERNAME`/`KAGGLE_KEY` environment variables, omit `--skip-kaggle` to fetch and verify `data/raw/kaggle_soil_fertility/dataset1.csv`.

Run all Python quality and invariant gates before committing:

```bash
ruff check ml_core scripts tests
mypy ml_core scripts tests
pytest -v
pip-audit
```

### Offline Browser PWA (`Node 22`)

Install packages, verify TypeScript strict compilation, run Vitest parity tests, and confirm the production bundle:

```bash
cd web_app
npm ci
npx tsc --noEmit
npx vitest run
npm run build
```

## Non-Negotiable Scientific and Parity Invariants

Every pull request must preserve these rules enforced across `tests/test_invariants.py`, `tests/test_esrc_adapter.py`, and browser Vitest specs.

1. **Direct sensor `%OM` stays blocked** unless paired with a conformal `95% Prediction Interval` clipped at zero, `Model Version`, `Calibration Domain Status` (`In-Range`, `Caution`, or `Outside Calibration Range`), and configurable Van Bemmelen `k` (`1.724` default).
2. **Circular `TN_pct` leakage stays out** of every model on SRDI Kushtia (`r = 0.9776` with `OM_pct`), and multi-depth or multi-replicate splits group strictly via `GroupKFold` on `Sample_ID`, `Pedon_ID`, or `site_id`. Groups never split across folds.
3. **`POXC` stays isolated from `%SOC`** by reporting active carbon strictly in `mg C/kg dry soil` and blocking any calculation claiming `Passive C = Total SOC - POXC`.
4. **Hardware and physics guardrails** enforce `SENSOR_FAULT_CRITICAL` (`pH < 3.0` or `> 10.0`, negative channels, `Moisture > 100%`, `Temp_C` outside `[-10, 60]`) and `SATURATION_DISTURBANCE_WARNING` (`Moisture >= 98%`) identically in Python and TypeScript.
5. **Registry synchronization and `< 1e-6` parity** require re-running `python scripts/train_and_export.py`, copying `models/registry.json` to `web_app/public/models/registry.json`, checking matching SHA-256 digests, and verifying Python-to-TypeScript prediction parity when changing `ml_core/` training or export code. Hashes must match.
6. **Zero hardcoded credentials and formula-safe exports** mean never committing `.env`, `kaggle.json`, tokens, or passwords, neutralizing leading `=`, `+`, `-`, `@`, `\t`, and `\r` spreadsheet cells, and rejecting `__proto__`, `constructor`, or `prototype` JSON keys.

## Documentation and Release Conventions

Keep Markdown prose direct, specific, and grounded in measured workspace artifacts. Write cleanly. Use straight quotes (`"`, `'`), drop filler transitions, avoid em dashes and semicolons in prose, and anchor every architectural or metric claim to concrete files or test logs.

Release tags follow `vX.Y.Z` (`v1.0.0`). Test first. Before pushing a release tag across configured mirrors (`github`, `gitlab`, `bitbucket`, `sourceforge`), confirm a clean working tree and run:

```bash
./scripts/release-all.sh --dry-run
```
