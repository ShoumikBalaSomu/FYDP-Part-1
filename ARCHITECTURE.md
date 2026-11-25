# SOMSense Architecture Guide

SOMSense splits offline model calibration from browser inference so Bangladesh field teams can inspect soil readings with zero cloud servers or monthly hosting fees.

Read [docs/03_ARCHITECTURE_AND_INNOVATION.md](docs/03_ARCHITECTURE_AND_INNOVATION.md) for the full system diagram, mathematical specification, and JSON/CSV data contracts.

## Two-Tier Offline Design

Field tablets lose cellular coverage between rural plots. Python scripts in `ml_core/` and `scripts/` validate benchmark datasets, train models inside location-grouped cross-validation folds (`GroupKFold`), calibrate conformal 95% intervals, fit Mahalanobis out-of-domain bounds, and export static parameters to `models/registry.json`. That registry file travels directly inside `web_app/public/models/registry.json`. Browser inference stays fast. Once the client loads the static bundle, TypeScript checks the `SHA-256` payload digest via WebCrypto and evaluates linear equations or flat decision-tree arrays locally in under `50 ms`.

Zero servers sit in the middle.

## Six Deterministic Runtime Gates

Every manual input, `ESRC Device - 1` JSON packet, and paired AEZ CSV passes through six checks before `%SOM` appears on screen.

1. **Boundary sanitization** strips `__proto__`, `constructor`, and `prototype` keys, rejects `NaN` or `Infinity` literals, enforces `10 MB` and `10,000`-row caps, and prepends a leading apostrophe to exported cells starting with `=`, `+`, `-`, `@`, `\t`, or `\r`.
2. **Explicit unit conversion** multiplies SRDI exchangeable potassium by `391.0` (`cmol(+)/kg` to `mg/kg`), converts electrical conductivity from `uS/cm` to `dS/m` when declared, and divides USDA KSSL `SOC` (`g C/kg`) by `10.0`.
3. **Hardware fault blocking** prints `SENSOR_FAULT_CRITICAL` if `pH < 3.0` or `pH > 10.0` (matching the `cumilla 2` `pH = 0.12` probe fault), if any nutrient or moisture value is negative, if `Moisture > 100%`, or if `Temp_C` leaves `[-10, 60]`. Bad probes stop output.
4. **Disturbance flags** raise `SATURATION_DISTURBANCE_WARNING` at `Moisture >= 98%`, catch transient ion interference when high `EC` meets wet soil or recent rain/fertilizer (`< 3` days), and trap `24 h` `%OM` jumps above `0.35`.
5. **Domain safety** blocks silent extrapolation with `Outside Calibration Range` when inputs leave training `[min, max]` bounds or pass the 99th-percentile Mahalanobis $D^2$ cutoff.
6. **Calibrated output** scales clipped `%SOC` predictions by configurable Van Bemmelen `k` (default `1.724`), attaches the conformal `95% Prediction Interval`, and displays the `BARC/SRDI` fertility class alongside `Model Version`.

POXC runs apart. Active carbon (`POXC` in `mg C/kg dry soil`) stays on an isolated model track that forbids computing `Passive C = Total SOC - POXC`.

## Repository Map

| Directory or File | Role | Reference Link |
|---|---|---|
| `ml_core/` | Python physics guardrails, datasets, GroupKFold CV, conformal intervals, OOD, POXC, and JSON export | [docs/03_ARCHITECTURE_AND_INNOVATION.md](docs/03_ARCHITECTURE_AND_INNOVATION.md) |
| `web_app/` | Offline-first React + TypeScript PWA, Sensor Health Doctor, CSV Calibration Studio, and POXC panel | [docs/06_UX_PSYCHOLOGY_SPEC.md](docs/06_UX_PSYCHOLOGY_SPEC.md) |
| `models/` | Verified `registry.json` (`5` exported benchmark tracks, `< 1e-6` parity) and `artifacts_manifest.json` | [docs/contracts/model_registry_schema.json](docs/contracts/model_registry_schema.json) |
| `data/` | Dataset SHA-256 manifest, `22`-column AEZ CSV template, CI schema fixture, and USDA public domain CSVs | [DATA_PROVENANCE.md](DATA_PROVENANCE.md) |
| `docs/` | Background study, product state machine, architecture, UX ergonomics, JSON schemas, and audit log | [docs/02_PRODUCT_MENTAL_MODEL.md](docs/02_PRODUCT_MENTAL_MODEL.md) |
| `scripts/` | Dataset fetcher (`fetch_datasets.py`), training/export runner (`train_and_export.py`), release helper (`release-all.sh`) | [FIELD_SAMPLING_PROTOCOL.md](FIELD_SAMPLING_PROTOCOL.md) |

All five v1.0.0 models verify against Python within `4.55e-13` max absolute difference in `models/artifacts_manifest.json`.
