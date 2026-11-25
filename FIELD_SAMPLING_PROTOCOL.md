# Bangladesh AEZ Paired Field Sampling Protocol

Standard multi-parameter RS485 soil probes measure electrical conductivity, dielectric moisture, temperature, pH, and derived mineral ion indexes rather than solid-phase Soil Organic Matter (`%OM`). Dr. Fizar Ahmed's ESRC calibration pathway (29 Sep 2026) requires paired sensor telemetry and laboratory reference measurements across `150` to `300` field plots before deploying a regional `%SOM` calibration model in Bangladesh.

Every row collected under this protocol conforms directly to the `22`-column schema in [data/templates/esrc_aez_calibration_template.csv](data/templates/esrc_aez_calibration_template.csv). Match headers exactly.

## 1. Site Stratification Target (150 to 300 Paired Plots)

Target `150` to `300` geo-referenced locations stratified across the target Agro-Ecological Zones (`AEZ`), land types (`High`, `Medium High`, `Medium Low`, `Low`), soil textures (`Sandy Loam`, `Loam`, `Clay Loam`, `Silty Clay`, `Clay`), and dominant cropping systems (`Aman Rice`, `Boro Rice`, `Aus Rice`, `Wheat`, `Jute`, `Potato`, pulses). Collect multi-depth cores at consistent intervals (`0-15 cm` tillage layer, or `0-20`, `20-40`, and `40-60 cm` matching SRDI Kushtia depth strata) and assign one invariant `site_id` per GPS location across depths so `GroupKFold` never splits vertically stacked horizons between train and test folds. Stack depths safely.

Assign one permanent ASCII `site_id` before stepping onto the plot. Keep labels plain. Never start `site_id`, `crop`, or `sensor_model` strings with `=`, `+`, `-`, `@`, tab, or carriage return characters.

## 2. Pre-Insertion Probe Cleaning and Calibration Gate

Real field logs on `ESRC Device - 1` at `cumilla 2` captured `pH = 0.12`, triggering `SENSOR_FAULT_CRITICAL` (`pH < 3.0` or `> 10.0`). Dirty junctions, dry glass bulbs, loose RS485 pins, and Modbus decimal shifts ruin standardized calibration vectors silently unless caught before sampling. Clean probes first. Run this hardware check at the start of every morning shift and after moving between soil textures:

1. Rinse stainless prongs and the pH glass/ISFET junction gently with distilled or deionized water, then blot dry with a clean lint-free cloth without rubbing the glass membrane.
2. Inspect RS485/Modbus cable pins for mud, moisture bridges, and loose threads (`pH = 0.00-0.25` indicates an open circuit or `x10`/`x100` register scaling mismatch).
3. Perform a two-point pH buffer check using fresh `pH 4.01` and `pH 7.00` solutions (`7.00` and `10.01` for calcareous Ganges floodplain sites like Kushtia where native `pH` runs `6.9-8.0`).
4. Verify the firmware unit profile for `EC` (`dS/m` vs `uS/cm`) and confirm `Salinity (mg/L)` stays near `0.5-0.7 * EC_uS_cm`.
5. Reject and log any reading where `pH < 3.0` or `> 10.0`, any nutrient or moisture value is negative, `Moisture > 100%`, or `Temp_C` leaves `-10` to `60 C`.

## 3. Post-Rain and Post-Fertilizer Waiting Window

Standing paddy water and fresh soluble salts distort probe conductivity badly. At `cumilla 2`, `ESRC Device - 1` logged `Humidity = 100%`, inflating bulk pore-water electrical conductivity and skewing `EC * Moisture` interaction terms (`SATURATION_DISTURBANCE_WARNING` at `Moisture >= 98%`). Fresh urea, triple superphosphate, or muriate of potash top-dressing creates sharp ionic spikes (`TRANSIENT_ION_DISTURBANCE` when `EC > 2.0 dS/m` with `Moisture >= 70%`, or `EC > 1.5 dS/m` within `3` days of rain or fertilization) and produces >`0.35%` apparent `%OM` swings within `24` hours.

Wait before sampling disturbed plots. Follow these clearance windows:

- **Rainfall or irrigation** requires waiting at least `3` full days (`72` hours) after heavy rain or flood drainage until ponded surface water clears and soil drops below `98%` saturation (ideally `15%` to `70%` field moisture).
- **Fertilizer or manure application** requires waiting at least `3` days after surface broadcasting (and `14-21` days when recording baseline seasonal calibration pairs like `example_cumilla_2_plot_a` where `days_since_fertilizer = 21`).
- **Disturbance timestamps** belong in every row, so log integer `days_since_rain` and `days_since_fertilizer` in the calibration CSV instead of fitting models on transient salt spikes.

## 4. Field Measurement, GPS Logging, and Depth Augering

Clear surface rice stubble and litter gently without scraping topsoil away. Match probe depth to the core.

1. Insert the cleaned `ESRC Device - 1` probe firmly to full electrode contact inside undisturbed moist soil next to the auger point, avoiding air pockets around prongs.
2. Wait `30` to `60` seconds for `Temp_C`, `Moisture_pct`, `EC`, and `pH` readings to stabilize, then record `N`, `P`, `K`, `pH`, `EC`, `Salinity`, `Temp_C`, `Moisture_pct`, `sensor_model`, and full ISO-8601 `timestamp` (`+06:00` for Bangladesh Standard Time).
3. Capture WGS84 `lat` and `lon` in decimal degrees (`>= 4` decimal places, roughly `11 m` precision or finer) alongside `aez_zone`, `texture_class`, and `crop`.
4. Auger `3` to `5` sub-cores across a `2 m` radius around the probe insertion point for each target `depth_cm` interval (`0-15`, `0-20`, `20-40`, or `40-60`), mix thoroughly in a clean plastic bucket, discard stones and fresh roots, and seal `~500 g` composite soil in a labeled double-zip bag.

Cool bags travel better. Never leave sample bags in direct sun inside a closed vehicle trunk because elevated heat alters moisture equilibrium and labile carbon before air-drying.

## 5. Laboratory Prep: Walkley-Black vs POXC (`< 2 mm`, `2.5 g`)

Ship composite bags to the ESRC or SRDI analytical lab within `48` hours for uniform preparation. Keep sieving strict.

1. Spread samples on clean paper trays to air-dry in shaded ambient air (never oven-dry above `40 C` prior to carbon assays).
2. Gently crush dry aggregates with a wooden pestle and sieve the entire sub-sample strictly through a `< 2 mm` stainless sieve (`#10` mesh). Do not mix `< 0.18 mm` fine-ground results into `< 2 mm` datasets, because USDA KSSL trials on sample `64511` proved `< 0.18 mm` grinding inflates measured `POXC` by `45%` (`1182.76` vs `813.04 mg/kg`).
3. Measure `lab_soc_pct` via Walkley-Black titration (recording `lab_method = Walkley-Black`, noting whether a local correction factor or the `1.724` Van Bemmelen default converts `%SOC` to `%SOM`). Confirm units are `%` (`g / 100 g`), dividing `g C/kg` lab outputs by `10.0`.
4. Weigh exactly `2.5 g` of `< 2 mm` air-dry soil for optional `0.02 M KMnO4` active carbon (`lab_poxc_mg_kg` in `mg C/kg dry soil`), flag organic/peat soils that exhaust permanganate (`Conc_mM <= 0.01`) as unquantified `NaN`, and never report `Passive C = Total SOC - POXC`.
5. Declare exchangeable potassium units explicitly if returned in `cmol(+)/kg` (standard SRDI practice) so SOMSense multiplies by `391.0` to obtain `mg/kg`, and exclude Kjeldahl `TN_pct` computed from `OM_pct` from calibration predictors.

Match every column header below before uploading.

## 6. Printable 22-Column Field & Lab Checklist

| Column Group | Exact Template Headers (`esrc_aez_calibration_template.csv`) | Verification Rule |
|---|---|---|
| Identity & Space | `site_id`, `aez_zone`, `lat`, `lon`, `depth_cm`, `timestamp` | Unique `site_id` per GPS plot, WGS84 decimals, ISO-8601 `+06:00` |
| Mineral & Soil Physics | `N`, `P`, `K`, `pH`, `EC`, `Salinity`, `Temp_C`, `Moisture_pct` | `pH` in `[3.0, 10.0]`, explicit `EC` unit (`dS/m` vs `uS/cm`), `K` in `mg/kg` |
| Agronomy & Disturbance | `texture_class`, `crop`, `days_since_rain`, `days_since_fertilizer` | Wait `>= 3` days post-rain/fert, record `Moisture < 98%` |
| Lab Truth & Device | `lab_soc_pct`, `lab_method`, `lab_poxc_mg_kg`, `sensor_model` | `%SOC` (`<= 40%`), `< 2 mm` & `2.5 g` POXC (`mg C/kg`), exact device string |
