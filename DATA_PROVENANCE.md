# Dataset Provenance, Citations, and Quality Audits

SOMSense builds every benchmark model from three verifiable public datasets documented in [data/manifest.json](data/manifest.json). Two sources carry third-party redistribution rules (`Mendeley Data` and `Kaggle`), so automated fetching replaces raw binary tracking for those tables while `U.S. Public Domain` USDA files remain checked into Git directly.

Run the checksum gate before training or evaluating any model. Hashes verify automatically.

```bash
python scripts/fetch_datasets.py --verify-only
```

Credential-free CI pipelines skip Kaggle authentication by running `python scripts/fetch_datasets.py --skip-kaggle`. That flag downloads the Mendeley CSV and checks local USDA hashes without credentials.

## Dataset Citations and Licenses

| Dataset ID | Citation & Source | License / Access | Git Tracking & Fetch Rule |
|---|---|---|---|
| `srdi_kushtia_2024` | Rahman, Md Mushiur (2026). *Soil nutrient status at three depths across 57 grid points, Kushtia, Bangladesh (2024)*. Mendeley Data, V1. DOI `10.17632/frkzb57y7p.1`. [Mendeley Record](https://data.mendeley.com/datasets/frkzb57y7p) | `CC BY 4.0` (`auth_required: false`) | Ignored in `.gitignore`. Downloaded on demand via `scripts/fetch_datasets.py`. |
| `usda_kssl_poxc` | Wills, Skye A. (2020). *Kellogg Soil Survey Laboratory (KSSL) POX-C dataset*. USDA National Agricultural Library Ag Data Commons. DOI `10.15482/USDA.ADC/1518679`. [USDA Record](https://agdatacommons.nal.usda.gov/articles/dataset/Kellogg_Soil_Survey_Laboratory_KSSL_POX-C_dataset/24665565) | `U.S. Public Domain` (`auth_required: false`) | Tracked directly inside `data/raw/usda_kssl_poxc/` and verified via SHA-256. |
| `kaggle_soil_fertility` | Jaiswal, Rahul. *Soil Fertility Dataset*. Kaggle slug `rahuljaiswalonkaggle/soil-fertility-dataset`. [Kaggle Record](https://www.kaggle.com/datasets/rahuljaiswalonkaggle/soil-fertility-dataset) | Kaggle Platform Terms (`auth_required: true`) | Ignored in `.gitignore`. Fetched via `kagglehub` with `KAGGLE_USERNAME` and `KAGGLE_KEY`, or skipped via `--skip-kaggle`. |

Two helper CSVs live inside `data/`. One is `data/templates/esrc_aez_calibration_template.csv`, which defines the `22`-column schema and example `AEZ-19` rows (`example_cumilla_2_plot_a` and `example_cumilla_2_plot_b`) for paired Bangladesh lab calibration. The other is `data/fixtures/schema_validation_fixture.csv`, holding `6` synthetic rows tagged `is_synthetic_or_fixture = true` exclusively for automated CI schema checks so placeholder numbers never enter scientific tables.

## Verified SHA-256 File Checksums

Every raw file listed in [data/manifest.json](data/manifest.json) matches its recorded `SHA-256` digest byte for byte:

| Local Relative Path | Source Endpoint | Exact SHA-256 Digest |
|---|---|---|
| `data/raw/srdi_kushtia/Supplementary_Data_S10.csv` | `https://data.mendeley.com/public-files/datasets/frkzb57y7p/files/18433563-d93a-484c-b180-c43315d64db7/file_downloaded` | `9a695af3c8f7eedffd45c3f7da642ef595efc22ad4863c0ddcacd5efdd4ed692` |
| `data/raw/usda_kssl_poxc/POXC_DataDictionary.csv` | `https://ndownloader.figshare.com/files/44528096` | `e40cb3100f06126d9c52c516c800bc24734ecee4d6e3701c062e8eab204e1f5f` |
| `data/raw/usda_kssl_poxc/POX_Data_replicates.csv` | `https://ndownloader.figshare.com/files/44528099` | `5b7c2f7bc0c3efb90990c71608ce42f0ef1c5597e456d4c049b5dbaecb96f32c` |
| `data/raw/usda_kssl_poxc/Table.S1.KSSL_SelectedSamples.csv` | `https://ndownloader.figshare.com/files/44528102` | `57bf3e66be66ffed680d465d69e76ee5c8871e1bd4f5097f444d3882f601c818` |
| `data/raw/usda_kssl_poxc/Table.S2.SampleData.csv` | `https://ndownloader.figshare.com/files/44528195` | `bd6696cf8b8ef02b63dbf6279cddf997167b446eec4e56478536508067a9541f` |
| `data/raw/kaggle_soil_fertility/dataset1.csv` | `kagglehub` (`rahuljaiswalonkaggle/soil-fertility-dataset`) | `930e0731ce747590aba71ca6d6ffd2f6e77202f812e01fa3e9c19a5b9e5fe5a4` |

## Explicit Data Quality and Leakage Findings

Raw agricultural datasets break naive ML pipelines when unit errors, circular variables, and impossible measurements pass silently into training folds. Auditing all three repositories caught four severe defects enforced programmatically in `ml_core/datasets.py` and `ml_core/soil_physics.py`.

### 1. SRDI Kushtia Circular `TN_pct` Leak and Depth Grouping

`Supplementary_Data_S10.csv` measures `171` soil profiles across `57` GPS grid coordinates (`Sample_ID` `1` to `57`) and three depth strata (`0-20`, `20-40`, and `40-60 cm`), with Walkley-Black `OM_pct` spanning `1.2%` to `2.7%` and `pH` running `6.9` to `8.0`. Exchangeable potassium arrives as `K_cmol_kg` (`0.07` to `0.46 cmol(+)/kg`), requiring `k_cmol_to_mg_kg(x) = x * 391.0` to match `mg/kg` field readings.

One column creates massive circular leakage. Total nitrogen (`TN_pct`) in that table was calculated arithmetically from `OM_pct` using `TN = 0.0492 * OM - 0.0065` (`r = 0.9776`). Keeping `TN_pct` as an input inflates OLS cross-validation `R2` to `0.9532` (random splits) and `0.9521` (`GroupKFold` by `Sample_ID`, `RMSE = 0.0796%`). Drop `TN_pct` to match what an RS485 sensor actually observes, and OLS `GroupKFold` drops to `R2 = 0.0742` (`RMSE = 0.3500%`) while random splitting collapses to `0.0066`. Every production model in `models/registry.json` excludes `TN_pct` strictly and groups splits by `Sample_ID` so multi-depth cores from one coordinate never leak across folds.

### 2. USDA-NRCS KSSL `SOC` `10x` Unit Error and Method Lock

`POXC_DataDictionary.csv` documents `SOC` inside `Table.S1.KSSL_SelectedSamples.csv` as `% ESTIMATED ORGANIC CARBON`. Check sample `64511`, an Ultisol from Cabo Rojo, Puerto Rico. Its `< 0.18 mm / 2.5 g` mean permanganate-oxidizable carbon is `1182.763 mg/kg` with `Ratio_poxc-soc = 0.042`, while `Table.S1` prints `SOC = 28`. Dividing `1182.763 mg/kg` by `28,000 mg/kg` (`2.80% SOC`) produces `0.04224`, confirming that `SOC` is recorded in `g C/kg` rather than percent. Units matter. Dividing `Table.S1` `SOC` by `10.0` removes a tenfold carbon inflation across all `42` samples (`38` pedons).

Grinding mesh and soil mass shift `POXC` across all `420` rows in `Table.S2.SampleData.csv`. On sample `64511` at `2.5 g`, `< 0.18 mm Grind` yields `1182.763 mg/kg` compared with `813.035 mg/kg` under `< 2 mm Grind`. Mesh rules stay locked. SOMSense isolates training to the standard `< 2 mm Grind` and `2.5 g` subset (`42` rows across `38` pedons), excluding `4` `NaN` rows where reagent exhausted or stayed below detection (`134599` Entisol, `146821` Alfisol, `231915` Mollisol at `97.3 g/kg SOC`, and `233952` Histosol at `288.4 g/kg SOC`). That leaves `38` quantified samples across `35` pedons grouped by `Pedon_ID`, enforcing `Passive C != Total SOC - POXC` everywhere.

### 3. Kaggle Soil Fertility Seven Corrupt Outliers and Mineral Limit

Across `880` rows in `dataset1.csv`, seven entries fail basic soil physics checks and distort linear scalers and variance estimates. Seven rows fail.

- **Rows `519` and `521`** record `pH = 0.90` below the `3.0` mineral soil floor.
- **Rows `531`, `532`, and `533`** climb from `pH = 10.05` through `10.60` up to `11.15`, breaking the `10.0` alkaline fault ceiling.
- **Row `659`** logs `Zn = 42.0 mg/kg` and `Fe = 44.0 mg/kg` far past `10.0` and `20.0 mg/kg`.
- **Row `667`** logs `OC = 24.0%` paired with `Zn = 38.0 mg/kg` and `Fe = 34.0 mg/kg` where clean rows stay below `5.0%` `OC`.

Seven rows get cut. Removing them leaves `873` clean records (`kaggle_mineral_oc_benchmark`). Evaluating `5` mineral features (`N`, `P`, `K`, `pH`, `EC`) against `OC (%)` under 5-fold cross-validation yields `R2 = -0.0042` on Ridge (`RMSE = 0.2975%`) and `-0.0044` on OLS (`-0.0803` on unshuffled Ridge). Mineral probes fall short. Five mineral channels miss solid-phase carbon. Dr. Fizar Ahmed's calibration pathway (29 Sep 2026) relies on temperature, soil moisture, and paired AEZ site calibration for that exact reason. Local pairing wins.
