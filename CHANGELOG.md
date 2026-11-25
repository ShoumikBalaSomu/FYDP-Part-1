# Changelog

All versioned releases of SOMSense (ESRC Soil Organic Matter Intelligence) appear in this file. Format follows Keep a Changelog, and tags follow Semantic Versioning.

## [1.0.0] - 2026-11-25

Initial public release grounding ESRC Soil Organic Matter (`%SOM`), Soil Organic Carbon (`%SOC`), and active carbon (`POXC`) estimation in Dr. Fizar Ahmed's calibration pathway (29 Sep 2026).

### Added

- **Python Scientific Core (`ml_core/` and `scripts/train_and_export.py`)** implements standardized nine-term linear plus interaction calibration models (`N`, `P`, `K`, `pH`, `EC`, `T`, `M`, `z_T * z_M`, `z_EC * z_M`), Ridge/ElasticNet/RandomForest/HistGradientBoosting model ladders, spatial `GroupKFold` splitting, out-of-fold conformal 95% intervals clipped at zero, Mahalanobis $D^2$ plus `[min, max]` out-of-domain bounds, global/stratified explainability, and deterministic JSON export.
- **Verified Model Registry (`models/registry.json` and `models/artifacts_manifest.json`)** exports `5` models totaling `389,139` bytes with canonical payload SHA-256 `8c08a860135a0bc3625acd1e11bd01a85df2db3833d357cc2270f15c264c97d5` and maximum Python-to-JSON prediction differences at or below `4.55e-13`.
  - `srdi_kushtia_om_champion` (`hist_gradient_boosting`, GroupKFold `R2 = 0.1734`, `RMSE = 0.3307%`, `q_095 = 0.7476%`, empirical coverage `0.965`).
  - `srdi_kushtia_om_baseline_ols` (`standardized_linear_interaction`, `R2 = 0.0742`, `RMSE = 0.3500%`, `q_095 = 0.7552%`).
  - `kaggle_mineral_oc_benchmark` (`standardized_linear_interaction`, `R2 = -0.0044`, `RMSE = 0.2976%`, confirming five mineral features fail without temperature, moisture, and local AEZ calibration).
  - `usda_kssl_poxc_with_soc` (`elastic_net`, `R2 = 0.7487`, `RMSE = 149.47 mg C/kg`, `q_095 = 333.75`).
  - `usda_kssl_poxc_without_soc` (`random_forest`, `R2 = 0.1844`, `RMSE = 269.30 mg C/kg`, `q_095 = 715.82`).
- **Offline-First Browser PWA (`web_app/`)** ships a three-tab React + TypeScript interface (`Predict & Diagnose`, `Calibrate Lab Data`, `Science & POXC`) with sub-`50 ms` local inference, Sensor Health Doctor diagnostics, QR-based in-browser AEZ CSV calibration, BARC/SRDI fertility badges, isolated POXC estimation, self-hosted fonts, strict CSP, and Service Worker caching. Zero cloud calls occur.
- **Documentation and Field Protocols** cover [DATA_PROVENANCE.md](DATA_PROVENANCE.md), [FIELD_SAMPLING_PROTOCOL.md](FIELD_SAMPLING_PROTOCOL.md), [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), [LICENSE](LICENSE), and specification files inside `docs/`.
- **Reproducible Research Notebook and Tests** execute `notebooks/SOMSense_ESRC_Research_Pipeline.ipynb` (`6/6` cells passing) alongside `20` unit and invariant checks across `tests/`. All 20 pass.
- **Quad-Platform CI/CD and Release Tooling** wire up GitHub Actions with Pages and checksummed releases (`.github/workflows/ci-release.yml`), Dependabot (`.github/dependabot.yml`), GitLab CI with free SAST, Secret Detection, and Pages (`.gitlab-ci.yml`), Bitbucket Pipelines (`bitbucket-pipelines.yml`), and multi-remote push automation (`scripts/release-all.sh`).

### Scientific Audits and Guardrails

- Blocked `ESRC Device - 1` (`cumilla 2`) hardware faults (`pH = 0.12`, `< 3.0` or `> 10.0`) with `SENSOR_FAULT_CRITICAL` and flagged `Humidity = 100%` (`>= 98%`) with `SATURATION_DISTURBANCE_WARNING`. Bad probes stop output.
- Excluded circular `TN_pct` leakage (`TN = 0.0492 * OM - 0.0065`, `r = 0.9776`) from SRDI Kushtia models (`171` rows, `57` `Sample_ID`s, `K_cmol_kg * 391.0`).
- Flagged `7` physically corrupt rows in Kaggle Soil Fertility (`880 -> 873` clean rows) and fixed the `10x` unit bug (`g C/kg` divided by `10.0`) on USDA KSSL `Table.S1` `SOC` (`< 2 mm Grind`, `2.5 g`, `38` quantified + `4` unquantified rows).
- Enforced `forbid_direct_sensor_om: true`, `forbid_passive_c_subtraction: true` (`Passive C != Total SOC - POXC`), and configurable Van Bemmelen `k = 1.724` default. Guardrails stay locked.
