import { FEATURE_DISPLAY_LABELS } from "../copy/uiCopy";
import { canonicalJsonFromValue, sha256HexUtf8 } from "./registryLoader";
import { classifyBarcSom, DEFAULT_VAN_BEMMELEN_K, somToSoc, validateSoilReading } from "./soilPhysics";
import type {
  CalibrationDomainStatus,
  FeatureDriverContribution,
  HardwarePhysicsGuardrails,
  InferencePredictionResult,
  ModelEntry,
  OODAssessment,
  POXCInferenceResult,
  SerializedTree,
  SoilReadingInput,
} from "./types";

function evalSerializedTree(tree: SerializedTree, features: readonly number[]): number {
  let idx = 0;
  let steps = 0;
  const { children_left, children_right, feature, threshold, value, missing_go_to_left } = tree;
  const maxSteps = children_left.length;

  while (idx >= 0 && idx < children_left.length && children_left[idx] !== -1) {
    if (steps >= maxSteps) {
      throw new Error("Invalid tree structure: cycle or excessive depth detected.");
    }
    steps++;
    const fIdx = feature[idx] ?? 0;
    const val = features[fIdx] ?? Number.NaN;
    const thresh = threshold[idx] ?? 0.0;
    let goLeft: boolean;
    if (Number.isNaN(val)) {
      goLeft = missing_go_to_left?.[idx] ?? true;
    } else {
      goLeft = val <= thresh;
    }
    idx = goLeft ? (children_left[idx] ?? -1) : (children_right[idx] ?? -1);
  }
  if (idx < 0 || idx >= value.length) {
    throw new Error("Invalid tree structure: leaf index out of bounds.");
  }
  return value[idx] ?? 0.0;
}

export function extractRawFeatureMap(reading: SoilReadingInput): Record<string, number | null> {
  return {
    nitrogen_mg_kg: reading.nitrogen_mg_kg,
    phosphorus_mg_kg: reading.phosphorus_mg_kg,
    potassium_mg_kg: reading.potassium_mg_kg,
    ph: reading.ph,
    ec_ds_m: reading.ec_ds_m,
    temperature_c: reading.temperature_c,
    moisture_pct: reading.moisture_pct,
    depth_mid_cm: reading.depth_mid_cm,
    sand_pct: reading.sand_pct,
    silt_pct: reading.silt_pct,
    clay_pct: reading.clay_pct,
  };
}

export function buildModelFeatureVectors(
  entry: ModelEntry,
  rawSample: Record<string, number | null | undefined>
): {
  rawVec: number[];
  modelVec: number[];
  zMap: Record<string, number>;
} {
  const { raw_features, interaction_terms, feature_means, feature_stds } = entry.preprocessing;
  const rawVec: number[] = [];
  const rawMap: Record<string, number> = {};
  const zMap: Record<string, number> = {};

  for (const feat of raw_features) {
    const mean = feature_means[feat] ?? 0.0;
    const std = feature_stds[feat] ?? 1.0;
    const rawVal = rawSample[feat];
    const imputed =
      rawVal === null || rawVal === undefined || !Number.isFinite(rawVal) ? mean : rawVal;
    rawVec.push(imputed);
    rawMap[feat] = imputed;
    zMap[feat] = (imputed - mean) / std;
  }

  const modelVec: number[] = raw_features.map((feat) => zMap[feat] ?? 0.0);

  for (const term of interaction_terms) {
    let prod: number;
    if (term.op === "z_product") {
      prod = (zMap[term.left] ?? 0.0) * (zMap[term.right] ?? 0.0);
    } else {
      prod = (rawMap[term.left] ?? 0.0) * (rawMap[term.right] ?? 0.0);
    }
    if (term.restandardize) {
      const postMean = term.post_mean ?? 0.0;
      const postStd = term.post_std ?? 1.0;
      prod = (prod - postMean) / postStd;
    }
    modelVec.push(prod);
    zMap[term.name] = prod;
  }

  return { rawVec, modelVec, zMap };
}

function evaluatePredictorOnly(
  entry: ModelEntry,
  rawVec: readonly number[],
  modelVec: readonly number[]
): number {
  const pred = entry.predictor;
  let yHat: number;
  if (pred.type === "linear") {
    const input = pred.input_space === "standardized" ? modelVec : rawVec;
    let sum = pred.intercept;
    for (let i = 0; i < pred.coefficients.length; i++) {
      sum += (pred.coefficients[i] ?? 0.0) * (input[i] ?? 0.0);
    }
    yHat = sum;
  } else {
    const evalVec =
      pred.feature_cast === "float32" ? modelVec.map((v) => Math.fround(v)) : [...modelVec];
    let total = 0.0;
    for (const tree of pred.trees) {
      total += evalSerializedTree(tree, evalVec);
    }
    const agg = pred.aggregation === "mean" ? total / pred.trees.length : total;
    yHat = pred.base_score + pred.learning_rate * agg;
  }
  return Math.max(0.0, yHat);
}

export function assessOod(
  entry: ModelEntry,
  rawSample: Record<string, number | null | undefined>
): OODAssessment {
  const ood = entry.ood;
  const feats = ood.feature_order;
  const mins = ood.feature_mins;
  const maxs = ood.feature_maxs;
  const q01 = ood.feature_q01 ?? mins;
  const q99 = ood.feature_q99 ?? maxs;
  const mahaMean = ood.mahalanobis_mean;
  const invCov = ood.mahalanobis_inv_cov;

  const oodVec: number[] = [];
  const missingFeatures: string[] = [];
  const outOfBoundsFeatures: string[] = [];
  const tailCautionFeatures: string[] = [];

  for (let i = 0; i < feats.length; i++) {
    const feat = feats[i] ?? "";
    const val = rawSample[feat];
    if (val === null || val === undefined || !Number.isFinite(val)) {
      missingFeatures.push(feat);
      oodVec.push(mahaMean[i] ?? 0.0);
    } else {
      oodVec.push(val);
      const minVal = mins[i] ?? Number.NEGATIVE_INFINITY;
      const maxVal = maxs[i] ?? Number.POSITIVE_INFINITY;
      const q01Val = q01[i] ?? minVal;
      const q99Val = q99[i] ?? maxVal;
      if (val < minVal || val > maxVal) {
        outOfBoundsFeatures.push(feat);
      } else if (val < q01Val || val > q99Val) {
        tailCautionFeatures.push(feat);
      }
    }
  }

  const diff = oodVec.map((v, i) => v - (mahaMean[i] ?? 0.0));
  let d2 = 0.0;
  for (let i = 0; i < diff.length; i++) {
    const row = invCov[i];
    const di = diff[i] ?? 0.0;
    if (!row) continue;
    let rowSum = 0.0;
    for (let j = 0; j < diff.length; j++) {
      rowSum += (row[j] ?? 0.0) * (diff[j] ?? 0.0);
    }
    d2 += di * rowSum;
  }
  if (!Number.isFinite(d2)) {
    d2 = Number.MAX_VALUE;
  }

  let status: CalibrationDomainStatus;
  const reasons: string[] = [];
  if (outOfBoundsFeatures.length > 0 || d2 > ood.d2_ood_threshold) {
    status = "Outside Calibration Range";
    if (outOfBoundsFeatures.length > 0) {
      reasons.push(`outside min/max bounds on ${outOfBoundsFeatures.join(", ")}`);
    }
    if (d2 > ood.d2_ood_threshold) {
      reasons.push(`Mahalanobis D^2=${d2.toFixed(2)} > ${ood.d2_ood_threshold.toFixed(2)} (99th pct)`);
    }
  } else if (
    missingFeatures.length > 0 ||
    tailCautionFeatures.length > 0 ||
    d2 > ood.d2_caution_threshold
  ) {
    status = "Caution";
    if (missingFeatures.length > 0) {
      reasons.push(`mean-imputed missing feature(s): ${missingFeatures.join(", ")}`);
    }
    if (tailCautionFeatures.length > 0) {
      reasons.push(`near distribution tails (q01-q99) on ${tailCautionFeatures.join(", ")}`);
    }
    if (d2 > ood.d2_caution_threshold) {
      reasons.push(
        `Mahalanobis D^2=${d2.toFixed(2)} > ${ood.d2_caution_threshold.toFixed(2)} (95th pct)`
      );
    }
  } else {
    status = "In-Range";
    reasons.push(
      `Within training feature bounds and Mahalanobis D^2=${d2.toFixed(
        2
      )} <= ${ood.d2_caution_threshold.toFixed(2)}.`
    );
  }

  return {
    status,
    mahalanobisD2: d2,
    outOfBoundsFeatures,
    tailCautionFeatures,
    missingFeatures,
    reason: reasons.join("; "),
  };
}

/**
 * Compute exact Python-equivalent raw prediction (point, ciLow, ciHigh, domainStatus, d2)
 * strictly from a ModelEntry and raw feature map (pre-physics gate).
 */
export function predictRawFromRegistryEntry(
  entry: ModelEntry,
  rawSample: Record<string, number | null | undefined>
): {
  point: number;
  ciLow: number;
  ciHigh: number;
  domainStatus: CalibrationDomainStatus;
  d2: number;
  oodAssessment: OODAssessment;
  rawVec: number[];
  modelVec: number[];
  zMap: Record<string, number>;
} {
  const { rawVec, modelVec, zMap } = buildModelFeatureVectors(entry, rawSample);
  const point = evaluatePredictorOnly(entry, rawVec, modelVec);
  const q095 = entry.uncertainty.q_095;
  const ciLow = Math.max(0.0, point - q095);
  const ciHigh = Math.max(0.0, point + q095);
  const oodAssessment = assessOod(entry, rawSample);
  return {
    point,
    ciLow,
    ciHigh,
    domainStatus: oodAssessment.status,
    d2: oodAssessment.mahalanobisD2,
    oodAssessment,
    rawVec,
    modelVec,
    zMap,
  };
}

function factorial(n: number): number {
  let acc = 1;
  for (let i = 2; i <= n; i++) acc *= i;
  return acc;
}

function computeLocalFeatureDrivers(
  entry: ModelEntry,
  rawSample: Record<string, number | null | undefined>,
  rawVec: readonly number[],
  modelVec: readonly number[],
  zMap: Record<string, number>,
  scaleToSom: number
): FeatureDriverContribution[] {
  const featureOrder = entry.preprocessing.model_feature_order;
  const pred = entry.predictor;

  if (pred.type === "linear") {
    return featureOrder.map((feat, idx) => {
      const coef = pred.coefficients[idx] ?? 0.0;
      const val = pred.input_space === "standardized" ? (modelVec[idx] ?? 0.0) : (rawVec[idx] ?? 0.0);
      return {
        feature: feat,
        label: FEATURE_DISPLAY_LABELS[feat] ?? feat,
        contribution: coef * val * scaleToSom,
        standardizedValue: zMap[feat] ?? null,
        rawValue: rawSample[feat] ?? null,
      };
    });
  }

  // Exact coalition Shapley attribution around z=0 training-mean baseline for <= 7 features
  const n = modelVec.length;
  const rawContribs = new Array<number>(n).fill(0.0);

  if (n <= 7) {
    const totalSubsets = 1 << n;
    const subsetValues = new Float64Array(totalSubsets);
    const workVec = new Array<number>(n).fill(0.0);

    for (let mask = 0; mask < totalSubsets; mask++) {
      for (let i = 0; i < n; i++) {
        workVec[i] = (mask & (1 << i)) !== 0 ? (modelVec[i] ?? 0.0) : 0.0;
      }
      subsetValues[mask] = evaluatePredictorOnly(entry, rawVec, workVec);
    }

    const nFact = factorial(n);
    for (let i = 0; i < n; i++) {
      let phi = 0.0;
      const bit = 1 << i;
      for (let mask = 0; mask < totalSubsets; mask++) {
        if ((mask & bit) !== 0) continue;
        let sSize = 0;
        let tmp = mask;
        while (tmp !== 0) {
          sSize += tmp & 1;
          tmp >>= 1;
        }
        const weight = (factorial(sSize) * factorial(n - sSize - 1)) / nFact;
        const withI = subsetValues[mask | bit] ?? 0.0;
        const withoutI = subsetValues[mask] ?? 0.0;
        phi += weight * (withI - withoutI);
      }
      rawContribs[i] = phi;
    }
  } else {
    const baselinePred = evaluatePredictorOnly(entry, rawVec, new Array<number>(n).fill(0.0));
    const fullPred = evaluatePredictorOnly(entry, rawVec, modelVec);
    for (let i = 0; i < n; i++) {
      const perturbed = [...modelVec];
      perturbed[i] = 0.0;
      rawContribs[i] = fullPred - evaluatePredictorOnly(entry, rawVec, perturbed);
    }
    const sumDelta = rawContribs.reduce((a, b) => a + b, 0.0);
    if (Math.abs(sumDelta) > 1e-9) {
      const targetDelta = fullPred - baselinePred;
      const factor = targetDelta / sumDelta;
      for (let i = 0; i < n; i++) {
        rawContribs[i] = (rawContribs[i] ?? 0.0) * factor;
      }
    }
  }

  return featureOrder.map((feat, idx) => ({
    feature: feat,
    label: FEATURE_DISPLAY_LABELS[feat] ?? feat,
    contribution: (rawContribs[idx] ?? 0.0) * scaleToSom,
    standardizedValue: zMap[feat] ?? null,
    rawValue: rawSample[feat] ?? null,
  }));
}

export interface RunInferenceOptions {
  vanBemmelenK?: number;
  guardrails?: Partial<HardwarePhysicsGuardrails>;
  previousObservation?: { timestampIso: string; somPct: number } | null;
}

export function runSomPrediction(
  entry: ModelEntry,
  reading: SoilReadingInput,
  options: RunInferenceOptions = {}
): InferencePredictionResult {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const k = options.vanBemmelenK ?? entry.van_bemmelen_k ?? DEFAULT_VAN_BEMMELEN_K;
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error(`Invalid Van Bemmelen factor k=${String(k)}`);
  }

  const rawSample = extractRawFeatureMap(reading);
  const rawPredict = predictRawFromRegistryEntry(entry, rawSample);

  const scaleToSom = entry.target_name === "OM_pct" ? 1.0 : k;
  const candidateSom = rawPredict.point * scaleToSom;

  const physicsReport = validateSoilReading(reading, {
    socPct: candidateSom / k,
    previousObservation: options.previousObservation,
    currentSomPct: candidateSom,
    guardrails: options.guardrails,
  });

  if (!physicsReport.passed_hard_gates) {
    const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
    return {
      blocked: true,
      blockReason: "SENSOR_FAULT_CRITICAL",
      rawTargetEstimate: null,
      estimatedSocPct: null,
      estimatedSomPct: null,
      somCi95Lower: null,
      somCi95Upper: null,
      vanBemmelenK: k,
      fertilityClassBarc: null,
      calibrationDomainStatus: "Outside Calibration Range",
      oodAssessment: rawPredict.oodAssessment,
      physicsReport,
      modelId: entry.model_id,
      modelVersion: entry.model_version,
      inferenceMs: Math.max(0.01, t1 - t0),
      standardizedVector: rawPredict.zMap,
      featureDrivers: [],
    };
  }

  if (rawPredict.domainStatus === "Outside Calibration Range") {
    const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
    return {
      blocked: true,
      blockReason: "OUTSIDE_CALIBRATION_RANGE",
      rawTargetEstimate: null,
      estimatedSocPct: null,
      estimatedSomPct: null,
      somCi95Lower: null,
      somCi95Upper: null,
      vanBemmelenK: k,
      fertilityClassBarc: null,
      calibrationDomainStatus: "Outside Calibration Range",
      oodAssessment: rawPredict.oodAssessment,
      physicsReport,
      modelId: entry.model_id,
      modelVersion: entry.model_version,
      inferenceMs: Math.max(0.01, t1 - t0),
      standardizedVector: rawPredict.zMap,
      featureDrivers: [],
    };
  }

  const estimatedSomPct =
    entry.target_name === "OM_pct" ? rawPredict.point : rawPredict.point * k;
  const estimatedSocPct =
    entry.target_name === "OM_pct" ? somToSoc(rawPredict.point, k) : rawPredict.point;

  const intervalScale =
    entry.target_name !== "OM_pct" && entry.uncertainty.apply_van_bemmelen_to_interval ? k : 1.0;

  const somCi95Lower = rawPredict.ciLow * intervalScale;
  const somCi95Upper = rawPredict.ciHigh * intervalScale;
  const domainStatus: CalibrationDomainStatus =
    physicsReport.has_warnings && rawPredict.domainStatus === "In-Range"
      ? "Caution"
      : rawPredict.domainStatus;

  const featureDrivers = computeLocalFeatureDrivers(
    entry,
    rawSample,
    rawPredict.rawVec,
    rawPredict.modelVec,
    rawPredict.zMap,
    scaleToSom
  ).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();

  return {
    blocked: false,
    blockReason: null,
    rawTargetEstimate: rawPredict.point,
    estimatedSocPct,
    estimatedSomPct,
    somCi95Lower,
    somCi95Upper,
    vanBemmelenK: k,
    fertilityClassBarc: classifyBarcSom(estimatedSomPct),
    calibrationDomainStatus: domainStatus,
    oodAssessment: rawPredict.oodAssessment,
    physicsReport,
    modelId: entry.model_id,
    modelVersion: entry.model_version,
    inferenceMs: Math.max(0.01, t1 - t0),
    standardizedVector: rawPredict.zMap,
    featureDrivers,
  };
}

export function runPoxcPrediction(
  entry: ModelEntry,
  reading: SoilReadingInput,
  labSocPct: number | null,
  guardrails?: Partial<HardwarePhysicsGuardrails>
): POXCInferenceResult {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const physicsReport = validateSoilReading(reading, { socPct: labSocPct, guardrails });

  if (!physicsReport.passed_hard_gates) {
    const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
    return {
      blocked: true,
      blockReason: "SENSOR_FAULT_CRITICAL",
      estimatedPoxcMgKg: null,
      poxcCi95Lower: null,
      poxcCi95Upper: null,
      unit: "mg C/kg dry soil",
      poxcToSocRatio: null,
      calibrationDomainStatus: "Outside Calibration Range",
      oodAssessment: assessOod(entry, { ...extractRawFeatureMap(reading), soc_pct: labSocPct }),
      physicsReport,
      modelId: entry.model_id,
      modelVersion: entry.model_version,
      inferenceMs: Math.max(0.01, t1 - t0),
    };
  }

  const requiresSoc = entry.preprocessing.raw_features.includes("soc_pct");
  if (requiresSoc && (labSocPct === null || !Number.isFinite(labSocPct) || labSocPct < 0)) {
    const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
    return {
      blocked: true,
      blockReason: "MISSING_SOC",
      estimatedPoxcMgKg: null,
      poxcCi95Lower: null,
      poxcCi95Upper: null,
      unit: "mg C/kg dry soil",
      poxcToSocRatio: null,
      calibrationDomainStatus: "Outside Calibration Range",
      oodAssessment: assessOod(entry, { ...extractRawFeatureMap(reading), soc_pct: labSocPct }),
      physicsReport,
      modelId: entry.model_id,
      modelVersion: entry.model_version,
      inferenceMs: Math.max(0.01, t1 - t0),
    };
  }

  const rawSample: Record<string, number | null | undefined> = {
    ...extractRawFeatureMap(reading),
    soc_pct: labSocPct,
  };
  const rawPred = predictRawFromRegistryEntry(entry, rawSample);

  if (rawPred.domainStatus === "Outside Calibration Range") {
    const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
    return {
      blocked: true,
      blockReason: "OUTSIDE_CALIBRATION_RANGE",
      estimatedPoxcMgKg: null,
      poxcCi95Lower: null,
      poxcCi95Upper: null,
      unit: "mg C/kg dry soil",
      poxcToSocRatio: null,
      calibrationDomainStatus: "Outside Calibration Range",
      oodAssessment: rawPred.oodAssessment,
      physicsReport,
      modelId: entry.model_id,
      modelVersion: entry.model_version,
      inferenceMs: Math.max(0.01, t1 - t0),
    };
  }

  const poxcToSocRatio =
    labSocPct !== null && labSocPct > 0 ? rawPred.point / (labSocPct * 10000.0) : null;
  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();

  return {
    blocked: false,
    blockReason: null,
    estimatedPoxcMgKg: rawPred.point,
    poxcCi95Lower: rawPred.ciLow,
    poxcCi95Upper: rawPred.ciHigh,
    unit: "mg C/kg dry soil",
    poxcToSocRatio,
    calibrationDomainStatus:
      physicsReport.has_warnings && rawPred.domainStatus === "In-Range"
        ? "Caution"
        : rawPred.domainStatus,
    oodAssessment: rawPred.oodAssessment,
    physicsReport,
    modelId: entry.model_id,
    modelVersion: entry.model_version,
    inferenceMs: Math.max(0.01, t1 - t0),
  };
}

export async function signModelEntry(entryWithoutHash: Omit<ModelEntry, "artifact_sha256">): Promise<ModelEntry> {
  const canonical = canonicalJsonFromValue(entryWithoutHash);
  const hash = await sha256HexUtf8(canonical);
  return {
    ...entryWithoutHash,
    artifact_sha256: hash,
  };
}
