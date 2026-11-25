import type { FertilityClassBARC, TabId } from "../engine/types";

export interface PresetScenario {
  id: string;
  button_label: string;
  badge: string;
  description: string;
  payload: {
    device_id: string;
    site_id: string;
    aez_zone: string;
    timestamp: string;
    nitrogen_mg_kg: number;
    phosphorus_mg_kg: number;
    potassium_mg_kg: number;
    ph: number;
    ec_value: number;
    ec_unit: "dS/m" | "uS/cm";
    salinity_mg_l: number;
    temperature_c: number;
    moisture_pct: number;
    depth_cm: string;
    texture_class: string;
  };
}

export interface BarcTierDefinition {
  id: string;
  label: FertilityClassBARC;
  range_label: string;
  min_som_pct: number;
  max_som_pct: number | null;
  reference: string;
  light_bg: string;
  light_fg: string;
  dark_bg: string;
  dark_fg: string;
}

export const BARC_SRDI_FERTILITY_SCALE: readonly BarcTierDefinition[] = [
  {
    id: "very_low",
    label: "Very Low",
    range_label: "< 1.0% SOM",
    min_som_pct: 0.0,
    max_som_pct: 1.0,
    reference: "BARC/SRDI Agronomic Reference",
    light_bg: "#FDECEC",
    light_fg: "#881313",
    dark_bg: "#311214",
    dark_fg: "#FCA5A5",
  },
  {
    id: "low",
    label: "Low",
    range_label: "1.0 - 1.7% SOM",
    min_som_pct: 1.0,
    max_som_pct: 1.7,
    reference: "BARC/SRDI Agronomic Reference",
    light_bg: "#FEF3D6",
    light_fg: "#7C3806",
    dark_bg: "#2D1E08",
    dark_fg: "#FCD34D",
  },
  {
    id: "medium",
    label: "Medium",
    range_label: "1.7 - 3.4% SOM",
    min_som_pct: 1.7,
    max_som_pct: 3.4,
    reference: "BARC/SRDI Agronomic Reference",
    light_bg: "#ECFDF5",
    light_fg: "#0E4D31",
    dark_bg: "#102B1F",
    dark_fg: "#6EE7B7",
  },
  {
    id: "high",
    label: "High",
    range_label: "3.4 - 5.5% SOM",
    min_som_pct: 3.4,
    max_som_pct: 5.5,
    reference: "BARC/SRDI Agronomic Reference",
    light_bg: "#DCFCE7",
    light_fg: "#114B2D",
    dark_bg: "#0F3826",
    dark_fg: "#86EFAC",
  },
  {
    id: "very_high",
    label: "Very High",
    range_label: "> 5.5% SOM",
    min_som_pct: 5.5,
    max_som_pct: null,
    reference: "BARC/SRDI Agronomic Reference",
    light_bg: "#D1FAE5",
    light_fg: "#064E3B",
    dark_bg: "#093D2E",
    dark_fg: "#A7F3D0",
  },
];

export const NAVIGATION_TABS: ReadonlyArray<{
  id: TabId;
  label: string;
  short_description: string;
}> = [
  {
    id: "predict_diagnose",
    label: "Predict & Diagnose",
    short_description: "Run local sensor physics checks and view calibrated SOM estimates.",
  },
  {
    id: "calibrate_lab",
    label: "Calibrate Lab Data",
    short_description: "Upload paired AEZ CSV sheets, normalize units, and refit local weights.",
  },
  {
    id: "science_poxc",
    label: "Science & POXC",
    short_description: "Inspect Dr. Fizar's calibration pathway, POXC modeling, and dataset audits.",
  },
];

export const PRESET_SCENARIOS: readonly PresetScenario[] = [
  {
    id: "cumilla_2_fault",
    button_label: "Load cumilla 2 Fault",
    badge: "Hardware + Saturation Case",
    description: "Real ESRC Device - 1 field log from cumilla 2 showing pH 0.12 and Humidity 100%.",
    payload: {
      device_id: "ESRC Device - 1",
      site_id: "cumilla 2",
      aez_zone: "AEZ-19",
      timestamp: "2026-09-29T10:15:00+06:00",
      nitrogen_mg_kg: 185,
      phosphorus_mg_kg: 18.0,
      potassium_mg_kg: 175,
      ph: 0.12,
      ec_value: 1.48,
      ec_unit: "dS/m",
      salinity_mg_l: 947,
      temperature_c: 29.4,
      moisture_pct: 100.0,
      depth_cm: "0-15",
      texture_class: "Clay Loam",
    },
  },
  {
    id: "healthy_kushtia_plot",
    button_label: "Load Healthy Kushtia Plot",
    badge: "SRDI Grid Benchmark",
    description:
      "SRDI Kushtia Sample_ID 1 (Katdaha Char, 0-20 cm) with K converted from 0.23 cmol(+)/kg to 89.93 mg/kg alongside AEZ-11 field climate values.",
    payload: {
      device_id: "SRDI-Kushtia-Grid",
      site_id: "Katdaha Char (Sample_ID 1)",
      aez_zone: "AEZ-11",
      timestamp: "2026-10-02T09:30:00+06:00",
      nitrogen_mg_kg: 210,
      phosphorus_mg_kg: 22.5,
      potassium_mg_kg: 89.93,
      ph: 7.8,
      ec_value: 0.54,
      ec_unit: "dS/m",
      salinity_mg_l: 346,
      temperature_c: 26.8,
      moisture_pct: 36.0,
      depth_cm: "0-20",
      texture_class: "Clay",
    },
  },
  {
    id: "wet_paddy_caution",
    button_label: "Load Wet Paddy Caution",
    badge: "Saturation Flag",
    description: "Saturated Aman plot at 99% moisture and 2.35 dS/m EC that triggers a disturbance warning.",
    payload: {
      device_id: "ESRC Device - 1",
      site_id: "cumilla 2 wet plot",
      aez_zone: "AEZ-19",
      timestamp: "2026-10-04T08:10:00+06:00",
      nitrogen_mg_kg: 205,
      phosphorus_mg_kg: 21.0,
      potassium_mg_kg: 190,
      ph: 6.4,
      ec_value: 2.35,
      ec_unit: "dS/m",
      salinity_mg_l: 1504,
      temperature_c: 28.2,
      moisture_pct: 99.0,
      depth_cm: "0-15",
      texture_class: "Silty Clay",
    },
  },
  {
    id: "ood_extreme_sample",
    button_label: "Load Out-of-Range Sample",
    badge: "OOD Rejection",
    description: "High-salinity coastal sample (EC 5.4 dS/m, pH 9.3, K 680 mg/kg) beyond the calibrated feature domain.",
    payload: {
      device_id: "ESRC Device - 1",
      site_id: "coastal-test-04",
      aez_zone: "AEZ-13",
      timestamp: "2026-10-05T11:20:00+06:00",
      nitrogen_mg_kg: 620,
      phosphorus_mg_kg: 88.0,
      potassium_mg_kg: 680,
      ph: 9.3,
      ec_value: 5.4,
      ec_unit: "dS/m",
      salinity_mg_l: 3456,
      temperature_c: 34.5,
      moisture_pct: 48.0,
      depth_cm: "0-15",
      texture_class: "Clay",
    },
  },
];

export const UI_COPY = {
  app_shell: {
    brand_title: "SOMSense",
    brand_subtitle: "ESRC Soil Organic Matter Intelligence",
    skip_to_main: "Skip to workspace",
    offline_badge_ready: "Offline Engine Ready",
    offline_badge_syncing: "Loading Local Model",
    offline_badge_browser_offline: "Offline Mode Active",
    theme_toggle_light: "Outdoor Light",
    theme_toggle_dark: "Lab Dark",
    clear_storage_label: "Clear Local Storage",
    latency_readout_template: "Local inference completed in {ms} ms",
    footer_provenance:
      "Calibrated workflow for Bangladesh ESRC probe telemetry and SRDI laboratory benchmarks. Predictions stay in browser memory unless you export them.",
  },
  calibration_domain_pills: {
    "In-Range": {
      label: "In-Range",
      description:
        "All sensor values sit inside training bounds and Mahalanobis D^2 stays below the 99th percentile.",
    },
    Caution: {
      label: "Caution",
      description:
        "Sensor reading sits near the edge of training bounds or carries a moisture/ion disturbance flag.",
    },
    "Outside Calibration Range": {
      label: "Outside Calibration Range",
      description:
        "Input lies beyond the calibrated domain. Pair this site with a lab sample before using numeric SOM estimates.",
    },
  },
  tab_predict_diagnose: {
    section_inputs_heading: "Field Sensor and Plot Inputs",
    section_presets_heading: "Quick Field Scenarios",
    section_output_heading: "Calibrated SOM Instrument Output",
    section_details_heading: "Model Evidence and Raw Telemetry",
    calculate_button: "Run Calibration Check",
    reset_button: "Clear Inputs",
    trust_gauge: {
      metric_title: "Estimated SOM (%)",
      soc_secondary_label: "Estimated SOC (%)",
      disclosure:
        "Calibrated estimate from sensor inputs and site covariates. Display alongside its 95% interval and model tag.",
      interval_label: "95% Prediction Interval",
      model_version_label: "Model Version",
      domain_status_label: "Calibration Domain Status",
      barc_badge_label: "BARC/SRDI Agronomic Reference",
      barc_disclaimer:
        "Reference scale from Bangladesh BARC/SRDI fertility guidelines for field context.",
      empty_prompt:
        "Enter field readings on the left or tap a preset above to run a local calibration check.",
    },
    banners: {
      hardware_fault: {
        code: "SENSOR_FAULT_CRITICAL",
        title: "Hardware Sensor Fault (Prediction Blocked)",
        checklist_heading: "Field Check Steps",
        steps: [
          "1. Unplug and reseat the RS485 probe connector, then wipe mud and salt film off the electrode tip.",
          "2. Place the pH probe in 7.00 and 4.01 calibration buffers to confirm electrode voltage responds.",
          "3. Inspect Modbus register scaling for decimal shifts (a raw reading of 0.12 can reflect a disconnected probe or a x10/x100 register mismatch).",
        ],
      },
      saturation_disturbance: {
        code: "SATURATION_DISTURBANCE_WARNING",
        title: "Water Saturation Caution (Moisture >= 98%)",
        summary:
          "Standing water fills soil pores and raises bulk electrical conductivity independently of organic matter. Treat the EC * Moisture contribution as disturbed.",
        action:
          "Log this reading with a wet-field tag. Wait 48 hours after drainage before comparing week-over-week SOM trends.",
      },
      transient_ion_disturbance: {
        code: "TRANSIENT_ION_DISTURBANCE",
        title: "Transient Ion Spike Flagged",
        summary:
          "High EC (> 2.0 dS/m) combined with high moisture or recent rain/fertilizer (< 3 days) inflates apparent conductivity.",
        action: "Retest after irrigation water settles or soluble fertilizer salts diffuse.",
      },
      temporal_jump: {
        code: "TEMPORAL_JUMP_WARNING",
        title: "Rapid 24-Hour Shift (> 0.35% SOM)",
        summary:
          "Real soil organic matter changes slowly across seasons. A jump above 0.35 percentage points within 24 hours points to probe drift, wetting, or fertilizer application.",
        action:
          "Verify electrode seating and record soil moisture before saving this point to a plot log.",
      },
      ood_rejected: {
        code: "OUTSIDE_CALIBRATION_RANGE",
        title: "Outside Calibration Range (Estimate Withheld)",
        summary:
          "One or more inputs fall outside the calibrated training bounds or exceed the Mahalanobis D^2 99th percentile threshold. SOMSense withholds numeric extrapolation here.",
        action:
          "Collect a paired soil core from this plot and upload the lab result in Calibrate Lab Data to extend the local domain.",
      },
    },
    accordions: {
      equations: {
        title: "Model Equations and Standardization",
        subtitle: "Inspect the 9-term standardized linear equation and Van Bemmelen conversion",
        note: "Training fold means (mu_j) and standard deviations (s_j) standardize each term before computing z_T * z_M and z_EC * z_M.",
        formula_heading: "Standardized SOC and SOM Formula",
      },
      shap_drivers: {
        title: "Feature Drivers (SHAP and Coefficients)",
        subtitle: "See how each input nudged Estimated SOM (%) away from the training baseline",
        positive_legend: "Increases estimated SOM (%)",
        negative_legend: "Decreases estimated SOM (%)",
        blocked_note:
          "Driver bars pause when a hardware fault or out-of-range reading blocks estimation.",
      },
      raw_telemetry: {
        title: "Raw Telemetry JSON Import and Sanitizer",
        subtitle: "Paste ESRC IoT or websoftbd JSON payloads for instant local normalization",
        paste_label: "Raw Sensor JSON Payload",
        paste_placeholder:
          '{"Device": "ESRC Device - 1", "site": "cumilla 2", "PH": 0.12, "Humidity": 100, "EC": 1.48, "Temperature": 29.4}',
        parse_button: "Parse and Validate JSON",
        security_note:
          "Prototype-pollution keys (__proto__, constructor, prototype) and spreadsheet formula prefixes (=, +, -, @) are stripped locally.",
      },
    },
    exports: {
      heading: "Offline Plot Exports",
      export_csv: "Export Reading (CSV)",
      export_json: "Export Bundle (JSON)",
      export_md: "Export Brief (MD)",
      print_card: "Print Field Card",
      formula_safe_note:
        "Exported CSV cells neutralize leading formula characters for safe opening in Excel.",
    },
  },
  tab_calibrate_lab: {
    heading: "Paired Field and Lab Calibration Studio",
    intro:
      "Upload paired sensor and laboratory rows for your AEZ plot to inspect unit conversions, leakage guardrails, and local Ridge recalibration.",
    download_template_button: "Download AEZ CSV Template",
    upload_dropzone_label: "Choose or drop paired calibration CSV",
    upload_limits_note:
      "Browser parser accepts files up to 10 MB and 10,000 rows. Data stays on your device.",
    unit_harmonization_heading: "Automatic Unit Normalization Rules",
    unit_rules: [
      "Exchangeable K in cmol(+)/kg multiplies by 391.0 to yield mg/kg.",
      "EC in uS/cm divides by 1000.0 to yield dS/m.",
      "USDA-style SOC in g/kg divides by 10.0 to yield %SOC.",
    ],
    leak_guardrail_title: "Circular Nitrogen Leak Guardrail Active",
    leak_guardrail_body:
      "Any TN_pct column is excluded from SOM predictors. On the SRDI Kushtia benchmark, TN_pct was computed from OM_pct (r = 0.978), which creates false near-perfect accuracy.",
    cn_warning_title: "C:N Ratio Plausibility Warning",
    cn_warning_body:
      "Independent Total N paired with SOC yielded C:N outside 5 to 35. Verify whether N is recorded in % or mg/kg, or tag organic soil horizons.",
    refit_button: "Run Local GroupKFold Recalibration",
    download_registry_button: "Download Updated Registry JSON",
    status_idle: "Ready for paired CSV upload.",
    empty_state:
      "Download the AEZ CSV template or upload at least 15 paired rows across multiple plots to run local calibration.",
  },
  tab_science_poxc: {
    heading: "Scientific Basis and POXC Active Carbon",
    fizar_pathway_title: "ESRC Calibration Protocol (29 Sep 2026)",
    fizar_pathway_body:
      "Soil probes read electrical conductivity, moisture, temperature, pH, and NPK proxies. SOMSense translates those raw signals into calibrated %SOC and %SOM with conformal uncertainty bounds.",
    mineral_only_proof_title: "Why Mineral Probes Alone Fail",
    mineral_only_proof_body:
      "Across 873 cleaned Kaggle mineral rows containing only N, P, K, pH, and EC, cross-validated Ridge R^2 drops below zero. Soil temperature, moisture, and local site metadata are essential for calibration.",
    poxc_section_title: "Active Carbon (POXC) Pathway",
    poxc_section_body:
      "Permanganate Oxidizable Carbon (POXC) tracks labile organic matter sensitive to tillage and residue management. SOMSense reports POXC strictly in mg C/kg dry soil using a separate USDA KSSL-grounded model.",
    poxc_estimator: {
      heading: "POXC Quick Estimator",
      output_label: "Estimated POXC (mg C/kg dry soil)",
      interval_label: "95% POXC Prediction Interval",
      ratio_note: "Arable mineral soil POXC to SOC ratios normally sit between 0.02 and 0.06.",
    },
    passive_c_guardrail_title: "Carbon Fractionation Guardrail",
    passive_c_guardrail_body:
      "Total SOC minus POXC blends mineral-associated and particulate pools of different turnover rates. Report POXC and Total SOC side by side without subtracting them to estimate passive carbon.",
    datasets_heading: "Verified Benchmark Datasets and Audit Fixes",
    dataset_cards: [
      {
        name: "SRDI Kushtia Benchmark (171 rows, 57 GPS grid points)",
        detail:
          "Three depths (0-20, 20-40, 40-60 cm) grouped by Sample_ID. Converted K from cmol(+)/kg to mg/kg (x391) and excluded circular TN_pct.",
      },
      {
        name: "Kaggle Soil Fertility (880 raw rows, 873 cleaned)",
        detail:
          "Removed 7 extreme rows (pH 0.90 to 11.15 and OC 24.0%) via physics filters to demonstrate mineral-only generalization limits.",
      },
      {
        name: "USDA-NRCS KSSL POX-C (42 samples, 38 pedons)",
        detail:
          "Filtered to <2 mm sieve and 2.5 g assay trials. Fixed the data dictionary unit bug by dividing g/kg SOC values by 10.",
      },
    ],
  },
  error_states: {
    registry_checksum_failed:
      "Model artifact SHA-256 verification failed. Local calculations are paused until a verified registry.json loads.",
    json_malformed: "Clipboard text is not valid JSON. Check brackets and quotes around field names.",
  },
} as const;

export const AEZ_CALIBRATION_TEMPLATE_CSV = [
  "site_id,aez_zone,lat,lon,depth_cm,timestamp,N,P,K,pH,EC,Salinity,Temp_C,Moisture_pct,texture_class,crop,days_since_rain,days_since_fertilizer,lab_soc_pct,lab_method,lab_poxc_mg_kg,sensor_model",
  "example_cumilla_2_plot_a,AEZ-19,23.4607,91.1809,0-15,2026-10-02T09:30:00+06:00,190,19.5,185,6.5,0.52,333,27.8,34.0,Loam,Aman Rice,5,21,1.18,EXAMPLE_TEMPLATE_Walkley-Black,495,ESRC Device - 1 (Template Example)",
  "example_cumilla_2_plot_b,AEZ-19,23.4614,91.1821,0-15,2026-10-02T09:50:00+06:00,215,22.0,204,6.7,0.61,390,27.4,38.5,Clay Loam,Aman Rice,5,21,1.36,EXAMPLE_TEMPLATE_Walkley-Black,570,ESRC Device - 1 (Template Example)",
].join("\n") + "\n";

export const MODEL_DISPLAY_LABELS: Record<string, string> = {
  srdi_kushtia_om_champion: "SRDI Kushtia Champion (HistGradientBoosting)",
  srdi_kushtia_om_baseline_ols: "SRDI Kushtia Baseline (Standardized Linear OLS)",
  kaggle_mineral_oc_benchmark: "Kaggle Mineral Benchmark (Negative R2 Proof)",
  usda_kssl_poxc_with_soc: "USDA KSSL POXC (With Lab SOC, ElasticNet)",
  usda_kssl_poxc_without_soc: "USDA KSSL POXC (Without SOC, RandomForest)",
};

export const FEATURE_DISPLAY_LABELS: Record<string, string> = {
  nitrogen_mg_kg: "Nitrogen (N, mg/kg)",
  phosphorus_mg_kg: "Phosphorus (P, mg/kg)",
  potassium_mg_kg: "Potassium (K, mg/kg)",
  ph: "Soil pH",
  ec_ds_m: "EC (dS/m)",
  temperature_c: "Temperature (deg C)",
  moisture_pct: "Moisture (%)",
  depth_mid_cm: "Depth Midpoint (cm)",
  soc_pct: "Laboratory SOC (%)",
  sand_pct: "Sand (%)",
  silt_pct: "Silt (%)",
  clay_pct: "Clay (%)",
  z_temperature_c_x_z_moisture_pct: "z_Temp * z_Moisture",
  z_ec_ds_m_x_z_moisture_pct: "z_EC * z_Moisture",
};
