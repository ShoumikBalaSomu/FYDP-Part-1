export type ThemeMode = "light" | "dark";
export type TabId = "predict_diagnose" | "calibrate_lab" | "science_poxc";

export type ECUnit = "dS/m" | "uS/cm" | "mS/cm" | "unknown";
export type KUnit = "mg/kg" | "cmol(+)/kg";
export type SOCUnit = "%" | "g/kg";

export type SeverityLevel = "OK" | "WARNING" | "CRITICAL";
export type CalibrationDomainStatus = "In-Range" | "Caution" | "Outside Calibration Range";
export type FertilityClassBARC = "Very Low" | "Low" | "Medium" | "High" | "Very High";

export type PhysicsFlagCode =
  | "SENSOR_FAULT_CRITICAL"
  | "SATURATION_DISTURBANCE_WARNING"
  | "TRANSIENT_ION_DISTURBANCE"
  | "TEMPORAL_JUMP_WARNING"
  | "TEMPORAL_STABILITY_WARNING"
  | "CN_PLAUSIBILITY_WARNING"
  | "EC_UNIT_AMBIGUITY_WARNING"
  | "EC_SALINITY_MISMATCH"
  | "EC_SALINITY_MISMATCH_WARNING"
  | "EXTREME_OUTLIER_EXCLUDED"
  | "PASSIVE_CARBON_GUARDRAIL_VIOLATION";

export interface SoilReadingInput {
  site_id: string | null;
  device_id: string | null;
  raw_site_id: string | null;
  raw_device_id: string | null;
  timestamp: string | null;
  aez_zone: string | null;
  lat: number | null;
  lon: number | null;
  depth_cm: string | null;
  depth_mid_cm: number | null;
  nitrogen_mg_kg: number | null;
  phosphorus_mg_kg: number | null;
  potassium_mg_kg: number | null;
  ph: number | null;
  ec_ds_m: number | null;
  ec_raw: number | null;
  ec_unit: ECUnit;
  salinity_mg_l: number | null;
  temperature_c: number | null;
  moisture_pct: number | null;
  days_since_rain: number | null;
  days_since_fertilizer: number | null;
  total_nitrogen_pct: number | null;
  sand_pct: number | null;
  silt_pct: number | null;
  clay_pct: number | null;
  texture_class: string | null;
  crop: string | null;
}

export interface PhysicsDiagnosticFlag {
  code: PhysicsFlagCode;
  severity: SeverityLevel;
  field: string;
  value: number | string | null;
  message: string;
  probable_causes: string[];
  remediation: string;
}

export interface PhysicsValidationReport {
  passed_hard_gates: boolean;
  has_warnings: boolean;
  flags: PhysicsDiagnosticFlag[];
  cn_ratio: number | null;
}

export interface InteractionTerm {
  name: string;
  op: "z_product" | "raw_product";
  left: string;
  right: string;
  restandardize?: boolean;
  post_mean?: number;
  post_std?: number;
}

export interface LinearPredictor {
  type: "linear";
  input_space: "standardized" | "raw";
  intercept: number;
  coefficients: number[];
  named_coefficients?: Record<string, number>;
  clip_non_negative: true;
}

export interface SerializedTree {
  children_left: number[];
  children_right: number[];
  feature: number[];
  threshold: number[];
  value: number[];
  missing_go_to_left?: boolean[];
}

export interface TreeEnsemblePredictor {
  type: "tree_ensemble";
  input_space: "standardized" | "raw";
  feature_cast: "float32" | "float64";
  base_score: number;
  aggregation: "mean" | "sum";
  learning_rate: number;
  clip_non_negative: true;
  trees: SerializedTree[];
}

export type RegistryPredictor = LinearPredictor | TreeEnsemblePredictor;

export interface ModelPreprocessing {
  raw_features: string[];
  interaction_terms: InteractionTerm[];
  model_feature_order: string[];
  feature_means: Record<string, number>;
  feature_stds: Record<string, number>;
  feature_mins: Record<string, number>;
  feature_maxs: Record<string, number>;
  feature_q01?: Record<string, number>;
  feature_q99?: Record<string, number>;
  categorical_encodings?: Record<string, string[]>;
}

export interface ModelUncertainty {
  method: "split_conformal" | "oof_conformal";
  alpha: number;
  q_095: number;
  empirical_coverage: number;
  mean_interval_width: number;
  clip_lower_at_zero: true;
  apply_van_bemmelen_to_interval: boolean;
}

export interface ModelOODConfig {
  feature_order: string[];
  feature_mins: number[];
  feature_maxs: number[];
  feature_q01?: number[];
  feature_q99?: number[];
  mahalanobis_mean: number[];
  mahalanobis_inv_cov: number[][];
  regularization_eps: number;
  d2_caution_threshold: number;
  d2_ood_threshold: number;
  isolation_forest_summary?: {
    n_estimators: number;
    contamination: number;
    train_ood_rate: number;
    offset?: number;
  };
  domain_status_labels: [
    "In-Range",
    "Caution",
    "Outside Calibration Range"
  ];
}

export interface GlobalImportanceItem {
  feature: string;
  importance: number;
  signed_effect: number | null;
  rank: number;
}

export interface StratifiedErrorItem {
  stratum_column: string;
  stratum_value: string;
  n: number;
  rmse: number;
  mae: number;
  r2: number | null;
}

export interface ModelComparisonRow {
  model_name: string;
  rmse: number;
  mae: number;
  r2: number;
  beats_ols_baseline: boolean;
  retained: boolean;
}

export interface ModelEntry {
  model_id: string;
  model_version: string;
  dataset_id: string;
  target_name: "OM_pct" | "SOC_pct" | "OC_pct" | "POXC_mg_kg";
  target_unit: "%" | "mg C/kg dry soil";
  van_bemmelen_k: number | null;
  selection_status:
    | "selected_champion"
    | "baseline_ols"
    | "benchmark_reference"
    | "rejected_under_baseline";
  selected_model_family:
    | "standardized_linear_interaction"
    | "ridge"
    | "elastic_net"
    | "huber"
    | "random_forest"
    | "hist_gradient_boosting"
    | "lightgbm";
  beats_ols_baseline: boolean;
  provenance: {
    source_title: string;
    doi_or_slug: string;
    is_synthetic_or_fixture: boolean;
  };
  preprocessing: ModelPreprocessing;
  predictor: RegistryPredictor;
  uncertainty: ModelUncertainty;
  ood: ModelOODConfig;
  explainability: {
    method: string;
    global_importance: GlobalImportanceItem[];
    stratified_errors: StratifiedErrorItem[];
  };
  metrics: {
    cv_strategy: string;
    n_samples: number;
    n_groups: number | null;
    rmse: number;
    mae: number;
    r2: number;
    baseline_ols_rmse: number;
    baseline_ols_mae: number;
    baseline_ols_r2: number;
    model_comparison: ModelComparisonRow[];
  };
  artifact_sha256: string;
  notes?: string;
}

export interface HardwarePhysicsGuardrails {
  ph_critical_min: number;
  ph_critical_max: number;
  moisture_saturation_warning_min: number;
  moisture_max_pct: number;
  temperature_min_c: number;
  temperature_max_c: number;
  ec_transient_disturbance_ds_m: number;
  moisture_transient_disturbance_pct: number;
  daily_som_jump_threshold_pct: number;
  cn_ratio_min: number;
  cn_ratio_max: number;
  k_cmol_to_mg_kg: number;
  usda_soc_g_kg_to_pct_divisor: number;
}

export interface LeakageAndQualityAudits {
  srdi_tn_leakage: {
    with_tn_random_r2: number;
    with_tn_group_r2: number;
    without_tn_random_r2: number;
    without_tn_group_r2: number;
    with_tn_group_rmse: number;
    without_tn_group_rmse: number;
    tn_om_correlation: number;
    tn_om_formula: string;
  };
  kaggle_mineral_only: {
    raw_rows: number;
    flagged_outlier_rows: number;
    clean_rows: number;
    ridge_5feat_r2: number;
    ridge_5feat_rmse: number;
    outlier_criteria: string;
  };
  usda_poxc_unit_audit: {
    raw_samples: number;
    raw_pedons: number;
    standard_subset_prep: string;
    standard_subset_mass_g: number;
    standard_rows_total: number;
    valid_quantified_rows: number;
    reagent_exhausted_or_unquantified_rows: number;
    unit_bug_factor: number;
  };
}

export interface ModelRegistry {
  schema_version: string;
  generated_at_utc: string;
  platform: "SOMSense-ESRC";
  authority_protocol: {
    source: string;
    default_van_bemmelen_k: number;
    forbid_direct_sensor_om: true;
    forbid_passive_c_subtraction: true;
    required_report_fields: string[];
  };
  hardware_physics_guardrails: HardwarePhysicsGuardrails;
  models: Record<string, ModelEntry>;
  leakage_and_quality_audits: LeakageAndQualityAudits;
  integrity: {
    hash_algorithm: "SHA-256";
    canonicalization: string;
    canonical_payload_sha256: string;
  };
}

export interface OODAssessment {
  status: CalibrationDomainStatus;
  mahalanobisD2: number;
  outOfBoundsFeatures: string[];
  tailCautionFeatures: string[];
  missingFeatures: string[];
  reason: string;
}

export interface FeatureDriverContribution {
  feature: string;
  label: string;
  contribution: number;
  standardizedValue: number | null;
  rawValue: number | null;
}

export interface InferencePredictionResult {
  blocked: boolean;
  blockReason: "SENSOR_FAULT_CRITICAL" | "OUTSIDE_CALIBRATION_RANGE" | "MODEL_ERROR" | null;
  rawTargetEstimate: number | null;
  estimatedSocPct: number | null;
  estimatedSomPct: number | null;
  somCi95Lower: number | null;
  somCi95Upper: number | null;
  vanBemmelenK: number;
  fertilityClassBarc: FertilityClassBARC | null;
  calibrationDomainStatus: CalibrationDomainStatus;
  oodAssessment: OODAssessment;
  physicsReport: PhysicsValidationReport;
  modelId: string;
  modelVersion: string;
  inferenceMs: number;
  standardizedVector: Record<string, number>;
  featureDrivers: FeatureDriverContribution[];
}

export interface POXCInferenceResult {
  blocked: boolean;
  blockReason: "SENSOR_FAULT_CRITICAL" | "OUTSIDE_CALIBRATION_RANGE" | "MISSING_SOC" | null;
  estimatedPoxcMgKg: number | null;
  poxcCi95Lower: number | null;
  poxcCi95Upper: number | null;
  unit: "mg C/kg dry soil";
  poxcToSocRatio: number | null;
  calibrationDomainStatus: CalibrationDomainStatus;
  oodAssessment: OODAssessment;
  physicsReport: PhysicsValidationReport;
  modelId: string;
  modelVersion: string;
  inferenceMs: number;
}
