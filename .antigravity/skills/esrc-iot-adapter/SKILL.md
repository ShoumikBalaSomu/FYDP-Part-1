---
name: esrc-iot-adapter
description: Parses, normalizes, and validates iot.websoftbd.net and ESRC Device soil telemetry payloads (Temperature, Humidity, EC, Salinity, PH, Nitrogen, Phosphorus, Potassium, timestamp, site label). Use when importing, pasting, or testing ESRC IoT JSON or CSV sensor data.
---

# ESRC IoT Telemetry Adapter

## When to use
When parsing single readings, batch logs, or pasted telemetry from `iot.websoftbd.net`, `ESRC Device - 1`, or paired Bangladesh AEZ field spreadsheets.

## Protocol
1. **Canonical field mapping (case-insensitive, alias-aware):**
   - `Temperature` / `Temp_C` / `temp` -> `temperature_c` (`°C`)
   - `Humidity` / `Moisture` / `Moisture_pct` -> `moisture_pct` (`%` volumetric/relative soil moisture)
   - `EC` / `ec_us_cm` / `ec_ds_m` -> `ec_us_cm` or `ec_ds_m` (require explicit unit or infer only with declared device profile; `ESRC Device - 1` commonly reports `uS/cm` or `dS/m` depending on firmware)
   - `Salinity` / `salinity_mg_l` -> `salinity` (optional cross-check against `EC`)
   - `PH` / `pH` / `ph` -> `ph`
   - `Nitrogen` / `N` -> `nitrogen_mg_kg` (`mg/kg`)
   - `Phosphorus` / `P` -> `phosphorus_mg_kg` (`mg/kg`)
   - `Potassium` / `K` -> `potassium_mg_kg` (`mg/kg`)
   - `device_id` / `Device` (e.g., `"ESRC Device - 1"`), `site_id` / `site` / `location` (e.g., `"cumilla 2"`), `timestamp` / `created_at` (ISO-8601).

2. **Hardware bug diagnostics (based on real `cumilla 2` field observations):**
   - Detect `pH = 0.12` (or `< 3.0`): report `SENSOR_FAULT_CRITICAL` and check whether `pH * 100` (`12.0` -> still high) or `pH * 10` (`1.2`) vs uncalibrated/disconnected probe (`0.00-0.25`) explains the Modbus register read.
   - Detect `Humidity = 100` (`>= 98%`): emit `SATURATION_DISTURBANCE_WARNING` and record disturbance flag on the observation.
   - Detect `EC` vs `Salinity` mismatch: if both exist and `EC_uS_cm > 0`, check whether `Salinity` tracks `~0.5-0.7 * EC_uS_cm`; warn on register swap if wildly inconsistent.
   - Require explicit unit manifest before calibration or prediction; block silent unit ambiguity.

3. **Security and boundary sanitization:**
   - Strip and neutralize spreadsheet formula prefixes (`=`, `+`, `-`, `@`, `\t`, `\r`) in any exported string field (`site_id`, `device_id`, `crop`, `notes`).
   - Reject prototype-pollution keys (`__proto__`, `constructor`, `prototype`) and non-plain objects during JSON ingestion.
   - Enforce strict upload limits (max file size, max row count) and reject `NaN` / `Infinity` / malformed timestamps without crashing.

## Rules
- Keep all parsed telemetry local in browser memory/storage unless the user explicitly exports a file.
- Preserve raw hardware labels (`cumilla 2`, `ESRC Device - 1`) in diagnostics alongside normalized fields so field technicians recognize their device immediately.
