import type {
  ECUnit,
  FertilityClassBARC,
  HardwarePhysicsGuardrails,
  KUnit,
  PhysicsDiagnosticFlag,
  PhysicsValidationReport,
  SoilReadingInput,
} from "./types";

export const DEFAULT_VAN_BEMMELEN_K = 1.724;
export const K_CMOL_TO_MG_KG = 391.0;
export const USDA_SOC_G_KG_TO_PCT_DIVISOR = 10.0;

export const PH_CRITICAL_MIN = 3.0;
export const PH_CRITICAL_MAX = 10.0;
export const MOISTURE_MIN_PCT = 0.0;
export const MOISTURE_SATURATION_WARN_PCT = 98.0;
export const MOISTURE_MAX_PCT = 100.0;
export const TEMP_MIN_C = -10.0;
export const TEMP_MAX_C = 60.0;

export const EC_TRANSIENT_DS_M = 2.0;
export const EC_RECENT_EVENT_ELEVATED_DS_M = 1.5;
export const MOISTURE_TRANSIENT_PCT = 70.0;
export const RECENT_EVENT_DAYS = 3.0;
export const DAILY_SOM_JUMP_THRESHOLD_PCT = 0.35;

export const CN_RATIO_MIN = 5.0;
export const CN_RATIO_MAX = 35.0;

export const EC_SALINITY_RATIO_MIN = 0.25;
export const EC_SALINITY_RATIO_MAX = 1.2;
export const EC_SALINITY_MIN_US_CM = 10.0;

export function kCmolToMgKg(kCmolKg: number): number {
  if (!Number.isFinite(kCmolKg)) {
    throw new Error(`Potassium value must be finite, got ${String(kCmolKg)}`);
  }
  return kCmolKg * K_CMOL_TO_MG_KG;
}

export function normalizePotassiumToMgKg(value: number, unit: KUnit): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Potassium value must be finite, got ${String(value)}`);
  }
  return unit === "cmol(+)/kg" ? kCmolToMgKg(value) : value;
}

export function socGKgToPct(socGKg: number): number {
  if (!Number.isFinite(socGKg)) {
    throw new Error(`SOC value must be finite, got ${String(socGKg)}`);
  }
  return socGKg / USDA_SOC_G_KG_TO_PCT_DIVISOR;
}

export function normalizeEcToDsM(
  value: number,
  unit: ECUnit
): { ecDsM: number | null; flag: PhysicsDiagnosticFlag | null } {
  if (!Number.isFinite(value)) {
    throw new Error(`EC value must be finite, got ${String(value)}`);
  }
  if (unit === "dS/m" || unit === "mS/cm") {
    return { ecDsM: value, flag: null };
  }
  if (unit === "uS/cm") {
    return { ecDsM: value / 1000.0, flag: null };
  }
  return {
    ecDsM: null,
    flag: {
      code: "EC_UNIT_AMBIGUITY_WARNING",
      severity: "WARNING",
      field: "ec_raw",
      value,
      message:
        "EC unit is missing ('unknown'); cannot mix uS/cm (e.g. 620) with dS/m (e.g. 0.62).",
      probable_causes: [
        "ESRC firmware or CSV header omitted explicit dS/m vs uS/cm unit declaration.",
      ],
      remediation: "Declare explicit EC unit ('dS/m' or 'uS/cm') before running calibration.",
    },
  };
}

export function socToSom(socPct: number, k = DEFAULT_VAN_BEMMELEN_K): number {
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error(`Van Bemmelen factor k must be positive and finite, got ${String(k)}`);
  }
  if (!Number.isFinite(socPct)) {
    throw new Error(`SOC (%) must be finite, got ${String(socPct)}`);
  }
  return k * Math.max(0.0, socPct);
}

export function somToSoc(somPct: number, k = DEFAULT_VAN_BEMMELEN_K): number {
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error(`Van Bemmelen factor k must be positive and finite, got ${String(k)}`);
  }
  if (!Number.isFinite(somPct)) {
    throw new Error(`SOM (%) must be finite, got ${String(somPct)}`);
  }
  return Math.max(0.0, somPct) / k;
}

export function classifyBarcSom(somPct: number): FertilityClassBARC {
  const val = Math.max(0.0, somPct);
  if (val < 1.0) return "Very Low";
  if (val < 1.7) return "Low";
  if (val < 3.4) return "Medium";
  if (val < 5.5) return "High";
  return "Very High";
}

export function computePassiveCarbonGuarded(
  totalSocPct: number,
  _poxcMgKg: number,
  mineralAssociatedOcPct: number | null = null
): number {
  if (mineralAssociatedOcPct === null) {
    throw new Error(
      "PASSIVE_CARBON_GUARDRAIL_VIOLATION: Passive carbon cannot be computed as Total SOC - POXC without full physical fractionation (MAOC/POM) data."
    );
  }
  if (
    !Number.isFinite(mineralAssociatedOcPct) ||
    mineralAssociatedOcPct < 0 ||
    mineralAssociatedOcPct > totalSocPct
  ) {
    throw new Error("Fractionated mineral-associated OC (%) must lie within [0, totalSocPct].");
  }
  return mineralAssociatedOcPct;
}

function diagnosePhFault(
  ph: number,
  deviceLabel: string,
  siteLabel: string,
  phMin: number,
  phMax: number
): PhysicsDiagnosticFlag {
  const causes = [
    "Disconnected, dry, or uncalibrated glass/ISFET pH probe.",
    "RS485/Modbus decimal shift or register scaling mismatch.",
  ];
  if (ph >= 0.0 && ph <= 0.3) {
    causes.push(
      `Observed pH=${ph.toFixed(2)} (matching ESRC cumilla 2 failure mode): x10=${(ph * 10).toFixed(
        2
      )} and x100=${(ph * 100).toFixed(1)} remain non-viable, indicating open-circuit or uncalibrated electrode.`
    );
  }
  return {
    code: "SENSOR_FAULT_CRITICAL",
    severity: "CRITICAL",
    field: "ph",
    value: ph,
    message: `Critical pH sensor fault on ${deviceLabel} (${siteLabel}): pH=${ph.toFixed(
      2
    )} is outside physical arable soil bounds [${phMin}, ${phMax}].`,
    probable_causes: causes,
    remediation:
      "Inspect pH probe connector, verify Modbus register scale factor, and recalibrate with pH 4.0/7.0 buffer solutions before predicting.",
  };
}

export interface ValidateReadingOptions {
  socPct?: number | null;
  previousObservation?: {
    timestampIso: string;
    somPct: number;
  } | null;
  currentSomPct?: number | null;
  guardrails?: Partial<HardwarePhysicsGuardrails>;
}

export function validateSoilReading(
  reading: SoilReadingInput,
  options: ValidateReadingOptions = {}
): PhysicsValidationReport {
  const g = options.guardrails ?? {};
  const phMin = g.ph_critical_min ?? PH_CRITICAL_MIN;
  const phMax = g.ph_critical_max ?? PH_CRITICAL_MAX;
  const moistureSatWarn = g.moisture_saturation_warning_min ?? MOISTURE_SATURATION_WARN_PCT;
  const moistureMax = g.moisture_max_pct ?? MOISTURE_MAX_PCT;
  const tempMin = g.temperature_min_c ?? TEMP_MIN_C;
  const tempMax = g.temperature_max_c ?? TEMP_MAX_C;
  const ecTransient = g.ec_transient_disturbance_ds_m ?? EC_TRANSIENT_DS_M;
  const moistureTransient = g.moisture_transient_disturbance_pct ?? MOISTURE_TRANSIENT_PCT;
  const dailyJumpThreshold = g.daily_som_jump_threshold_pct ?? DAILY_SOM_JUMP_THRESHOLD_PCT;
  const cnMin = g.cn_ratio_min ?? CN_RATIO_MIN;
  const cnMax = g.cn_ratio_max ?? CN_RATIO_MAX;

  const flags: PhysicsDiagnosticFlag[] = [];
  const deviceLabel = reading.raw_device_id ?? reading.device_id ?? "ESRC Sensor";
  const siteLabel = reading.raw_site_id ?? reading.site_id ?? "unspecified site";

  // 1. Hard gate: pH bounds
  if (reading.ph !== null && (reading.ph < phMin || reading.ph > phMax)) {
    flags.push(diagnosePhFault(reading.ph, deviceLabel, siteLabel, phMin, phMax));
  }

  // 2. Hard gate: non-negative chemical & moisture fields
  const nonNegativeFields: ReadonlyArray<[string, number | null]> = [
    ["nitrogen_mg_kg", reading.nitrogen_mg_kg],
    ["phosphorus_mg_kg", reading.phosphorus_mg_kg],
    ["potassium_mg_kg", reading.potassium_mg_kg],
    ["ec_ds_m", reading.ec_ds_m],
    ["salinity_mg_l", reading.salinity_mg_l],
    ["moisture_pct", reading.moisture_pct],
  ];
  for (const [fieldName, val] of nonNegativeFields) {
    if (val !== null && val < 0.0) {
      flags.push({
        code: "SENSOR_FAULT_CRITICAL",
        severity: "CRITICAL",
        field: fieldName,
        value: val,
        message: `Negative physical reading for ${fieldName}: ${val}.`,
        probable_causes: ["Signed integer underflow or corrupted sensor payload."],
        remediation: "Check sensor register signedness and re-acquire measurement.",
      });
    }
  }

  // 3. Hard gate: moisture > 100% and temperature bounds
  if (reading.moisture_pct !== null && reading.moisture_pct > moistureMax) {
    flags.push({
      code: "SENSOR_FAULT_CRITICAL",
      severity: "CRITICAL",
      field: "moisture_pct",
      value: reading.moisture_pct,
      message: `Moisture ${reading.moisture_pct.toFixed(1)}% exceeds physical 100% ceiling on ${deviceLabel} (${siteLabel}).`,
      probable_causes: ["Uncalibrated dielectric probe or scaling overflow."],
      remediation: "Recalibrate volumetric moisture probe and verify firmware scaling.",
    });
  }

  if (reading.temperature_c !== null && (reading.temperature_c < tempMin || reading.temperature_c > tempMax)) {
    flags.push({
      code: "SENSOR_FAULT_CRITICAL",
      severity: "CRITICAL",
      field: "temperature_c",
      value: reading.temperature_c,
      message: `Soil temperature ${reading.temperature_c.toFixed(2)} C outside physical bounds [${tempMin}, ${tempMax}] C.`,
      probable_causes: ["Open/shorted thermistor or NTC lookup error."],
      remediation: "Inspect temperature thermistor wiring and replace faulty probe.",
    });
  }

  // 4. Warning: EC unit ambiguity
  if (reading.ec_raw !== null && reading.ec_unit === "unknown") {
    const { flag } = normalizeEcToDsM(reading.ec_raw, "unknown");
    if (flag !== null) {
      flags.push(flag);
    }
  }

  // 5. Warning: Saturation disturbance (Moisture >= 98%)
  if (reading.moisture_pct !== null && reading.moisture_pct >= moistureSatWarn && reading.moisture_pct <= moistureMax) {
    flags.push({
      code: "SATURATION_DISTURBANCE_WARNING",
      severity: "WARNING",
      field: "moisture_pct",
      value: reading.moisture_pct,
      message: `Soil moisture/humidity is ${reading.moisture_pct.toFixed(
        1
      )}% (>= 98%) on ${deviceLabel} (${siteLabel}); standing water or post-rain saturation inflates apparent bulk EC via EC*Moisture cross-talk.`,
      probable_causes: [
        "Waterlogged paddy/field condition or condensation on probe.",
        "Recent heavy rainfall increasing pore-water ionic mobility.",
      ],
      remediation: "Treat EC-driven predictions as provisional and resample after surface drainage (24-48 hours).",
    });
  }

  // 6. Warning: Transient ionic disturbance
  const recentRain = reading.days_since_rain !== null && reading.days_since_rain < RECENT_EVENT_DAYS;
  const recentFert = reading.days_since_fertilizer !== null && reading.days_since_fertilizer < RECENT_EVENT_DAYS;
  const highMoisture = reading.moisture_pct !== null && reading.moisture_pct >= moistureTransient;
  if (
    reading.ec_ds_m !== null &&
    ((reading.ec_ds_m > ecTransient && (highMoisture || recentRain || recentFert)) ||
      (reading.ec_ds_m >= EC_RECENT_EVENT_ELEVATED_DS_M && (recentRain || recentFert)))
  ) {
    flags.push({
      code: "TRANSIENT_ION_DISTURBANCE",
      severity: "WARNING",
      field: "ec_ds_m",
      value: reading.ec_ds_m,
      message: `Elevated EC (${reading.ec_ds_m.toFixed(
        2
      )} dS/m) paired with wet soil or recent rain/fertilizer (<3 days) indicates transient ionic spike.`,
      probable_causes: ["Recent NPK fertilizer dissolution or irrigation/rain flush."],
      remediation: "Flag reading as disturbed and wait >= 72h after fertilization.",
    });
  }

  // 7. Warning: EC vs Salinity consistency check
  if (reading.ec_ds_m !== null && reading.ec_ds_m > 0.0 && reading.salinity_mg_l !== null && reading.salinity_mg_l >= 0.0) {
    const ecUsCm = reading.ec_ds_m * 1000.0;
    if (ecUsCm > EC_SALINITY_MIN_US_CM) {
      const ratio = reading.salinity_mg_l / ecUsCm;
      if (ratio < EC_SALINITY_RATIO_MIN || ratio > EC_SALINITY_RATIO_MAX) {
        flags.push({
          code: "EC_SALINITY_MISMATCH",
          severity: "WARNING",
          field: "salinity_mg_l",
          value: reading.salinity_mg_l,
          message: `Salinity (${reading.salinity_mg_l.toFixed(1)} mg/L) vs EC (${ecUsCm.toFixed(
            1
          )} uS/cm) ratio=${ratio.toFixed(3)} falls outside expected 0.5-0.7 TDS-to-EC range.`,
          probable_causes: ["Possible uS/cm vs dS/m unit mismatch or Modbus register swap."],
          remediation: "Verify EC unit manifest and Salinity register offset.",
        });
      }
    }
  }

  // 8. Warning: C:N plausibility when independent Total N (%) and SOC (%) are supplied
  let cnRatio: number | null = null;
  if (
    options.socPct !== undefined &&
    options.socPct !== null &&
    options.socPct >= 0.0 &&
    reading.total_nitrogen_pct !== null &&
    reading.total_nitrogen_pct > 0.0
  ) {
    cnRatio = options.socPct / reading.total_nitrogen_pct;
    if (cnRatio < cnMin || cnRatio > cnMax) {
      flags.push({
        code: "CN_PLAUSIBILITY_WARNING",
        severity: "WARNING",
        field: "total_nitrogen_pct",
        value: Number(cnRatio.toFixed(3)),
        message: `Soil C:N ratio (${cnRatio.toFixed(2)}) falls outside plausible arable mineral range [${cnMin}, ${cnMax}].`,
        probable_causes: [
          "Nitrogen unit confusion (mg/kg vs %).",
          "Peat/organic horizon or miscalibrated Kjeldahl/SOC analysis.",
        ],
        remediation: "Verify TN (%) vs mineral N (mg/kg) units before agronomic use.",
      });
    }
  }

  // 9. Warning: 24-hour temporal jump check
  if (
    options.previousObservation &&
    options.currentSomPct !== undefined &&
    options.currentSomPct !== null &&
    reading.timestamp
  ) {
    const prevMs = Date.parse(options.previousObservation.timestampIso);
    const currMs = Date.parse(reading.timestamp);
    if (Number.isFinite(prevMs) && Number.isFinite(currMs)) {
      const dtHours = (currMs - prevMs) / 3_600_000;
      const jump = Math.abs(options.currentSomPct - options.previousObservation.somPct);
      if (dtHours >= 0.0 && dtHours <= 24.0 && jump > dailyJumpThreshold) {
        flags.push({
          code: "TEMPORAL_JUMP_WARNING",
          severity: "WARNING",
          field: "estimated_som_pct",
          value: Number(jump.toFixed(4)),
          message: `Apparent %SOM shifted by ${jump.toFixed(3)} percentage points in ${dtHours.toFixed(
            1
          )}h at ${siteLabel} (threshold ${dailyJumpThreshold.toFixed(2)}%/24h).`,
          probable_causes: [
            "Soil organic matter does not change >0.35% within 24 hours; shift reflects moisture/fertilizer ionic interference.",
          ],
          remediation: "Hold steady-state SOM baseline and discard transient spike.",
        });
      }
    }
  }

  const passedHardGates = !flags.some((f) => f.severity === "CRITICAL");
  const hasWarnings = flags.some((f) => f.severity === "WARNING");

  return {
    passed_hard_gates: passedHardGates,
    has_warnings: hasWarnings,
    flags,
    cn_ratio: cnRatio,
  };
}

export function checkTemporalStability(
  observations: ReadonlyArray<{ timestampIso: string; somPct: number }>,
  siteId?: string,
  maxJumpPct = DAILY_SOM_JUMP_THRESHOLD_PCT
): PhysicsDiagnosticFlag[] {
  if (observations.length < 2) return [];
  const ordered = [...observations]
    .map((obs) => ({ ms: Date.parse(obs.timestampIso), somPct: obs.somPct }))
    .filter((obs) => Number.isFinite(obs.ms))
    .sort((a, b) => a.ms - b.ms);

  const flags: PhysicsDiagnosticFlag[] = [];
  const label = siteId ?? "site";
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const curr = ordered[i];
    if (!prev || !curr) continue;
    const dtHours = (curr.ms - prev.ms) / 3_600_000;
    const jump = Math.abs(curr.somPct - prev.somPct);
    if (dtHours >= 0.0 && dtHours <= 24.0 && jump > maxJumpPct) {
      flags.push({
        code: "TEMPORAL_JUMP_WARNING",
        severity: "WARNING",
        field: "estimated_som_pct",
        value: Number(jump.toFixed(4)),
        message: `Apparent %SOM shifted by ${jump.toFixed(3)} percentage points in ${dtHours.toFixed(
          1
        )}h at ${label} (threshold ${maxJumpPct.toFixed(2)}%/24h).`,
        probable_causes: [
          "Soil organic matter does not change >0.35% within 24 hours; shift reflects moisture/fertilizer ionic interference.",
        ],
        remediation: "Hold steady-state SOM baseline and discard transient spike.",
      });
    }
  }
  return flags;
}
