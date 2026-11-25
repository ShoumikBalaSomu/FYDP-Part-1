---
name: soil-physics-validator
description: Enforces physical soil bounds, unit conversions, EC-by-moisture disturbance flagging, and C:N ratio plausibility checks. Use when validating soil sensor inputs, harmonizing lab CSV datasets, or inspecting SOM, SOC, and POXC predictions.
---

# Soil Physics Validator

## When to use
Whenever ingesting soil laboratory CSVs, calibrating `%SOC`/`%OM`/`POXC` models, or validating live IoT soil sensor readings before running ML inference.

## Protocol
1. **Normalize units before any calculation:**
   - Soil Organic Carbon (`SOC`) and Organic Matter (`SOM`): store strictly in `%` (percent by dry soil mass). If input is `g/kg` or `mg/g` (for example, USDA KSSL `Table.S1` `SOC` values like `28.0` alongside `Ratio_poxc-soc = 0.042`), divide by `10` to convert `g/kg` to `%`.
   - Active Carbon (`POXC`): report strictly in `mg C/kg dry soil`. Never convert `POXC` to `"active SOM %"` and never compute passive carbon as `Total SOC - POXC` unless full fractionation data are supplied.
   - Exchangeable Potassium (`K`): convert `cmol(+)/kg` (used in SRDI Bangladesh lab reports) to `mg/kg` via `K_mg_kg = K_cmol_kg * 391.0` (`1 cmol(+)/kg K = 39.1 mg/100g = 391 mg/kg`).
   - Electrical Conductivity (`EC`): normalize to `dS/m` (`1 dS/m = 1 mS/cm = 1000 uS/cm`). Flag missing unit metadata so `uS/cm` values (e.g., `620`) are never mixed silently with `dS/m` (`0.62`).
   - Nitrogen (`N`): available mineral N (`mg/kg`) vs Kjeldahl Total Nitrogen (`TN %`, where `1% = 10000 mg/kg`). On SRDI Kushtia (`Supplementary_Data_S10.csv`), `TN_pct` was derived from `OM_pct` (`TN = 0.0492 * OM - 0.0065, r = 0.978`) and MUST be excluded as an independent predictor.

2. **Enforce hardware and physics fault gates (block silent predictions):**
   - `pH < 3.0` or `pH > 10.0` (e.g., `pH = 0.12` on `ESRC Device - 1` or `0.90` / `11.15` in uncleaned Kaggle rows): emit `SENSOR_FAULT_CRITICAL`. Explain probable causes (disconnected electrode, RS485 decimal shift, missing calibration).
   - Negative `N`, `P`, `K`, `EC`, `Salinity`, or `Moisture`, or `Moisture > 100%`, or `Temperature < -10°C` / `> 60°C`: emit `SENSOR_FAULT_CRITICAL`.
   - Non-finite values (`NaN`, `Infinity`, `-Infinity`): reject at boundary.

3. **Flag environmental disturbance and cross-talk:**
   - `Humidity / Moisture >= 98%` (e.g., `100%` saturated soil): emit `SATURATION_DISTURBANCE_WARNING` because apparent bulk `EC` rises sharply with water content (`EC * Moisture` interaction).
   - High `EC` (`> 2.0 dS/m`) combined with high moisture (`>= 70%`) or recent rain/fertilizer (< 3 days): flag `TRANSIENT_ION_DISTURBANCE`.
   - Temporal stability filter: check multi-reading windows for single-day apparent `%OM` jumps (`> 0.35` percentage points within 24h) caused by wetting or fertilizer application.

4. **Check agronomic C:N and Van Bemmelen plausibility:**
   - Default Van Bemmelen conversion: `SOM (%) = k * max(0, SOC (%))` with `k = 1.724` (configurable when local Walkley-Black vs dry-combustion calibration is measured).
   - When independent Total N (`TN %`) is available alongside `SOC (%)`, compute `C:N = SOC / TN`. Flag ratios `< 5` or `> 35` in arable mineral soils as `CN_PLAUSIBILITY_WARNING` (possible N unit mismatch or organic/peat horizon).

## Rules
- Never emit negative `%OM`, `%SOC`, or `POXC`.
- Never extrapolate silently outside training bounds; trigger `"Outside Calibration Range"` when Mahalanobis or feature-range OOD checks fail.
