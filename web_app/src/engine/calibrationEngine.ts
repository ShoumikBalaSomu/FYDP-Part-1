import { parseEsrcCsv, type ParsedEsrcRecord } from "./esrcAdapter";
import { signModelEntry } from "./inferenceEngine";
import { canonicalJsonFromValue, sha256HexUtf8 } from "./registryLoader";
import { DEFAULT_VAN_BEMMELEN_K, socGKgToPct } from "./soilPhysics";
import type {
  ECUnit,
  GlobalImportanceItem,
  InteractionTerm,
  KUnit,
  ModelEntry,
  ModelRegistry,
  SOCUnit,
  StratifiedErrorItem,
} from "./types";

const BASE_7_FEATURES = [
  "nitrogen_mg_kg",
  "phosphorus_mg_kg",
  "potassium_mg_kg",
  "ph",
  "ec_ds_m",
  "temperature_c",
  "moisture_pct",
] as const;

export interface CalibrationRowSummary {
  rowIndex: number;
  siteId: string;
  depthCm: string;
  labSocPct: number | null;
  predictedSocPct: number | null;
  residual: number | null;
  status: string;
  quarantined: boolean;
}

export interface CalibrationRunResult {
  modelEntry: ModelEntry;
  validRowCount: number;
  quarantinedRowCount: number;
  uniqueSiteCount: number;
  hasTnLeakColumn: boolean;
  tnOmCorrelation: number | null;
  cnWarningCount: number;
  rowSummaries: CalibrationRowSummary[];
  olsMetrics: { rmse: number; mae: number; r2: number };
  ridgeMetrics: { rmse: number; mae: number; r2: number };
  updatedRegistry: ModelRegistry | null;
}

export interface CalibrateCsvOptions {
  ecUnit: ECUnit;
  potassiumUnit: KUnit;
  socUnit: SOCUnit;
  modelLabel?: string;
  aezZone?: string;
  ridgeAlpha?: number;
  baseRegistry?: ModelRegistry | null;
}

/**
 * Solve min_x ||A x - b||_2 using Householder QR decomposition on an m x n matrix (m >= n).
 */
export function solveLeastSquaresQR(AInput: number[][], bInput: number[]): number[] {
  const m = AInput.length;
  const n = AInput[0]?.length ?? 0;
  if (m === 0 || n === 0 || bInput.length !== m) {
    throw new Error("Invalid matrix dimensions for QR solver.");
  }

  const R = AInput.map((row) => [...row]);
  const qty = [...bInput];

  for (let k = 0; k < n; k++) {
    let normSq = 0.0;
    for (let i = k; i < m; i++) {
      const val = R[i]?.[k] ?? 0.0;
      normSq += val * val;
    }
    const norm = Math.sqrt(normSq);
    if (norm < 1e-14) continue;

    const rkk = R[k]?.[k] ?? 0.0;
    const alpha = rkk >= 0 ? -norm : norm;
    const v0 = rkk - alpha;

    const v = new Array<number>(m - k).fill(0.0);
    v[0] = v0;
    let vNormSq = v0 * v0;
    for (let i = k + 1; i < m; i++) {
      const val = R[i]?.[k] ?? 0.0;
      v[i - k] = val;
      vNormSq += val * val;
    }
    if (vNormSq < 1e-28) continue;
    const beta = 2.0 / vNormSq;

    // Apply Householder reflection to columns j >= k
    for (let j = k; j < n; j++) {
      let dot = 0.0;
      for (let i = k; i < m; i++) {
        dot += (v[i - k] ?? 0.0) * (R[i]?.[j] ?? 0.0);
      }
      const scale = beta * dot;
      for (let i = k; i < m; i++) {
        const row = R[i];
        if (row) row[j] = (row[j] ?? 0.0) - scale * (v[i - k] ?? 0.0);
      }
    }

    // Apply Householder reflection to right-hand side qty
    let dotB = 0.0;
    for (let i = k; i < m; i++) {
      dotB += (v[i - k] ?? 0.0) * (qty[i] ?? 0.0);
    }
    const scaleB = beta * dotB;
    for (let i = k; i < m; i++) {
      qty[i] = (qty[i] ?? 0.0) - scaleB * (v[i - k] ?? 0.0);
    }
  }

  // Back-substitution on upper triangular n x n matrix R
  const x = new Array<number>(n).fill(0.0);
  for (let i = n - 1; i >= 0; i--) {
    let rhs = qty[i] ?? 0.0;
    for (let j = i + 1; j < n; j++) {
      rhs -= (R[i]?.[j] ?? 0.0) * (x[j] ?? 0.0);
    }
    const diag = R[i]?.[i] ?? 0.0;
    x[i] = Math.abs(diag) > 1e-12 ? rhs / diag : 0.0;
  }
  return x;
}

function fitLinearWithQR(
  Z: number[][],
  y: number[],
  ridgeAlpha: number
): { intercept: number; coefficients: number[] } {
  const p = Z[0]?.length ?? 0;

  if (ridgeAlpha <= 0.0) {
    const A = Z.map((row) => [1.0, ...row]);
    const sol = solveLeastSquaresQR(A, y);
    return {
      intercept: sol[0] ?? 0.0,
      coefficients: sol.slice(1),
    };
  }

  // Augmented matrix for Ridge keeping intercept unpenalized:
  // [1, Z; 0, sqrt(alpha) * I_p] * [b0; beta] ~= [y; 0]
  const sqrtAlpha = Math.sqrt(ridgeAlpha);
  const A: number[][] = Z.map((row) => [1.0, ...row]);
  const b: number[] = [...y];

  for (let j = 0; j < p; j++) {
    const augRow = new Array<number>(p + 1).fill(0.0);
    augRow[j + 1] = sqrtAlpha;
    A.push(augRow);
    b.push(0.0);
  }

  const sol = solveLeastSquaresQR(A, b);
  return {
    intercept: sol[0] ?? 0.0,
    coefficients: sol.slice(1),
  };
}

function invertSquareMatrix(mat: number[][]): number[][] {
  const n = mat.length;
  const aug = mat.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1.0 : 0.0)),
  ]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxAbs = Math.abs(aug[col]?.[col] ?? 0.0);
    for (let r = col + 1; r < n; r++) {
      const cand = Math.abs(aug[r]?.[col] ?? 0.0);
      if (cand > maxAbs) {
        maxAbs = cand;
        pivotRow = r;
      }
    }
    if (maxAbs < 1e-14) {
      throw new Error("Singular covariance matrix during Mahalanobis inversion.");
    }
    if (pivotRow !== col) {
      const tmp = aug[col]!;
      aug[col] = aug[pivotRow]!;
      aug[pivotRow] = tmp;
    }

    const pivotVal = aug[col]?.[col] ?? 1.0;
    for (let j = 0; j < 2 * n; j++) {
      aug[col]![j] = (aug[col]?.[j] ?? 0.0) / pivotVal;
    }

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = aug[r]?.[col] ?? 0.0;
      if (Math.abs(factor) < 1e-16) continue;
      for (let j = 0; j < 2 * n; j++) {
        aug[r]![j] = (aug[r]?.[j] ?? 0.0) - factor * (aug[col]?.[j] ?? 0.0);
      }
    }
  }

  return aug.map((row) => row.slice(n));
}

function quantileHigher(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0.0;
  const clampedQ = Math.min(1.0, Math.max(0.0, q));
  const idx = Math.min(sorted.length - 1, Math.ceil(clampedQ * (sorted.length - 1)));
  return sorted[idx] ?? 0.0;
}

function quantileLinear(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0.0;
  if (sorted.length === 1) return sorted[0] ?? 0.0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  return (sorted[lo] ?? 0.0) * (1.0 - frac) + (sorted[hi] ?? 0.0) * frac;
}

function computeConformalQuantile(residuals: number[], alpha = 0.05): number {
  const n = residuals.length;
  if (n < 1) return 0.0;
  const level = Math.min(1.0, Math.ceil((n + 1) * (1.0 - alpha)) / n);
  return Math.max(0.0, quantileHigher(residuals, level));
}

function computeMetrics(yTrue: number[], yPred: number[]): { rmse: number; mae: number; r2: number } {
  const n = yTrue.length;
  if (n === 0) return { rmse: 0, mae: 0, r2: 0 };
  let sqErr = 0.0;
  let absErr = 0.0;
  let sumY = 0.0;
  for (let i = 0; i < n; i++) {
    const yt = yTrue[i] ?? 0.0;
    const yp = yPred[i] ?? 0.0;
    const err = yt - yp;
    sqErr += err * err;
    absErr += Math.abs(err);
    sumY += yt;
  }
  const meanY = sumY / n;
  let totSs = 0.0;
  for (let i = 0; i < n; i++) {
    const diff = (yTrue[i] ?? 0.0) - meanY;
    totSs += diff * diff;
  }
  const rmse = Math.sqrt(sqErr / n);
  const mae = absErr / n;
  const r2 = totSs > 1e-12 ? 1.0 - sqErr / totSs : 0.0;
  return { rmse, mae, r2 };
}

function computeGroupKFoldIndices(groups: string[], requestedSplits: number): number[][] {
  const uniqueGroups = Array.from(new Set(groups));
  const k = Math.min(requestedSplits, uniqueGroups.length);
  if (k < 2) {
    throw new Error("GroupKFold requires at least 2 unique site_id groups.");
  }

  const groupCounts = new Map<string, number[]>();
  groups.forEach((g, idx) => {
    const arr = groupCounts.get(g) ?? [];
    arr.push(idx);
    groupCounts.set(g, arr);
  });

  // Sort groups by descending count (greedy balanced partition matching sklearn GroupKFold)
  const orderedGroups = Array.from(groupCounts.entries()).sort((a, b) => b[1].length - a[1].length);
  const foldBuckets: number[][] = Array.from({ length: k }, () => []);

  for (const [, indices] of orderedGroups) {
    let minFoldIdx = 0;
    let minCount = foldBuckets[0]?.length ?? 0;
    for (let f = 1; f < k; f++) {
      const len = foldBuckets[f]?.length ?? 0;
      if (len < minCount) {
        minCount = len;
        minFoldIdx = f;
      }
    }
    foldBuckets[minFoldIdx]?.push(...indices);
  }
  return foldBuckets;
}

function fitPreprocessorAndTransform(
  rawMatrix: Array<Array<number | null>>,
  featureNames: string[],
  trainIndices: number[]
): {
  means: number[];
  stds: number[];
  mins: number[];
  maxs: number[];
  q01: number[];
  q99: number[];
  interactions: InteractionTerm[];
  outputFeatureOrder: string[];
  transformRows: (indices: number[]) => number[][];
} {
  const p = featureNames.length;
  const means = new Array<number>(p).fill(0.0);

  for (let j = 0; j < p; j++) {
    let sum = 0.0;
    let cnt = 0;
    for (const idx of trainIndices) {
      const v = rawMatrix[idx]?.[j];
      if (v !== null && v !== undefined && Number.isFinite(v)) {
        sum += v;
        cnt++;
      }
    }
    means[j] = cnt > 0 ? sum / cnt : 0.0;
  }

  const stds = new Array<number>(p).fill(1.0);
  const mins = new Array<number>(p).fill(0.0);
  const maxs = new Array<number>(p).fill(0.0);
  const q01 = new Array<number>(p).fill(0.0);
  const q99 = new Array<number>(p).fill(0.0);

  for (let j = 0; j < p; j++) {
    const mean = means[j] ?? 0.0;
    const colVals = trainIndices.map((idx) => {
      const v = rawMatrix[idx]?.[j];
      return v !== null && v !== undefined && Number.isFinite(v) ? v : mean;
    });
    let varSum = 0.0;
    for (const val of colVals) {
      varSum += (val - mean) * (val - mean);
    }
    const std = Math.sqrt(varSum / Math.max(1, colVals.length));
    stds[j] = std > 1e-12 ? std : 1.0;
    mins[j] = Math.min(...colVals);
    maxs[j] = Math.max(...colVals);
    q01[j] = quantileLinear(colVals, 0.01);
    q99[j] = quantileLinear(colVals, 0.99);
  }

  const interactions: InteractionTerm[] = [];
  const nameSet = new Set(featureNames);
  if (nameSet.has("temperature_c") && nameSet.has("moisture_pct")) {
    interactions.push({
      name: "z_temperature_c_x_z_moisture_pct",
      op: "z_product",
      left: "temperature_c",
      right: "moisture_pct",
      restandardize: false,
      post_mean: 0.0,
      post_std: 1.0,
    });
  }
  if (nameSet.has("ec_ds_m") && nameSet.has("moisture_pct")) {
    interactions.push({
      name: "z_ec_ds_m_x_z_moisture_pct",
      op: "z_product",
      left: "ec_ds_m",
      right: "moisture_pct",
      restandardize: false,
      post_mean: 0.0,
      post_std: 1.0,
    });
  }

  const colMap = new Map<string, number>(featureNames.map((f, i) => [f, i]));
  const transformRows = (indices: number[]): number[][] =>
    indices.map((idx) => {
      const zRow = featureNames.map((_, j) => {
        const rawVal = rawMatrix[idx]?.[j];
        const mean = means[j] ?? 0.0;
        const std = stds[j] ?? 1.0;
        const imputed = rawVal !== null && rawVal !== undefined && Number.isFinite(rawVal) ? rawVal : mean;
        return (imputed - mean) / std;
      });
      for (const term of interactions) {
        const lIdx = colMap.get(term.left) ?? 0;
        const rIdx = colMap.get(term.right) ?? 0;
        zRow.push((zRow[lIdx] ?? 0.0) * (zRow[rIdx] ?? 0.0));
      }
      return zRow;
    });

  return {
    means,
    stds,
    mins,
    maxs,
    q01,
    q99,
    interactions,
    outputFeatureOrder: [...featureNames, ...interactions.map((t) => t.name)],
    transformRows,
  };
}

function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0.0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0.0) / n;
  let num = 0.0;
  let denX = 0.0;
  let denY = 0.0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0.0) - meanX;
    const dy = (ys[i] ?? 0.0) - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den > 1e-12 ? num / den : null;
}

function extractBaseFeatureVal(rec: ParsedEsrcRecord, feature: string): number | null {
  const r = rec.reading;
  switch (feature) {
    case "nitrogen_mg_kg":
      return r.nitrogen_mg_kg;
    case "phosphorus_mg_kg":
      return r.phosphorus_mg_kg;
    case "potassium_mg_kg":
      return r.potassium_mg_kg;
    case "ph":
      return r.ph;
    case "ec_ds_m":
      return r.ec_ds_m;
    case "temperature_c":
      return r.temperature_c;
    case "moisture_pct":
      return r.moisture_pct;
    default:
      return null;
  }
}

export async function runInBrowserCalibration(
  csvText: string,
  options: CalibrateCsvOptions
): Promise<CalibrationRunResult> {
  const parsed = parseEsrcCsv(csvText, {
    ecUnit: options.ecUnit,
    potassiumUnit: options.potassiumUnit,
    requireExplicitEcUnit: options.ecUnit === "unknown",
  });

  const ridgeAlpha = options.ridgeAlpha ?? 10.0;
  const allRows = parsed.records;

  // Compute TN correlation if TN_pct exists (purely for circular leak reporting; never included in X!)
  const tnPairsX: number[] = [];
  const tnPairsY: number[] = [];

  const validRecords: Array<{ origIndex: number; rec: ParsedEsrcRecord; socPct: number; siteId: string }> = [];
  const rowSummaries: CalibrationRowSummary[] = [];

  allRows.forEach((rec, idx) => {
    const siteId = rec.reading.site_id ?? rec.reading.raw_site_id ?? `row_${idx + 1}`;
    const depthCm = rec.reading.depth_cm ?? (rec.reading.depth_mid_cm !== null ? `${rec.reading.depth_mid_cm}` : "-");
    const rawSoc = rec.labSocPct;
    const socPct =
      rawSoc !== null ? (options.socUnit === "g/kg" ? socGKgToPct(rawSoc) : rawSoc) : null;

    if (
      socPct !== null &&
      rec.reading.total_nitrogen_pct !== null &&
      Number.isFinite(rec.reading.total_nitrogen_pct)
    ) {
      tnPairsX.push(socPct * DEFAULT_VAN_BEMMELEN_K);
      tnPairsY.push(rec.reading.total_nitrogen_pct);
    }

    if (!rec.report.passed_hard_gates) {
      const faultCodes = rec.report.flags
        .filter((f) => f.severity === "CRITICAL")
        .map((f) => `${f.field}: ${f.code}`)
        .join(", ");
      rowSummaries.push({
        rowIndex: idx + 1,
        siteId,
        depthCm,
        labSocPct: socPct,
        predictedSocPct: null,
        residual: null,
        status: `Quarantined (${faultCodes})`,
        quarantined: true,
      });
      return;
    }

    if (socPct === null || !Number.isFinite(socPct) || socPct < 0 || socPct > 40) {
      rowSummaries.push({
        rowIndex: idx + 1,
        siteId,
        depthCm,
        labSocPct: socPct,
        predictedSocPct: null,
        residual: null,
        status: "Quarantined (Missing or invalid lab_soc_pct)",
        quarantined: true,
      });
      return;
    }

    validRecords.push({ origIndex: idx, rec, socPct, siteId });
    rowSummaries.push({
      rowIndex: idx + 1,
      siteId,
      depthCm,
      labSocPct: socPct,
      predictedSocPct: null,
      residual: null,
      status: rec.report.has_warnings
        ? `Warning (${rec.report.flags.map((f) => f.code).join(", ")})`
        : "Valid",
      quarantined: false,
    });
  });

  if (validRecords.length < 6) {
    throw new Error(
      `Need at least 6 physics-valid paired rows to calibrate; found ${validRecords.length}.`
    );
  }

  const groups = validRecords.map((item) => item.siteId);
  const uniqueSites = Array.from(new Set(groups));
  if (uniqueSites.length < 2) {
    throw new Error(
      "GroupKFold calibration requires at least 2 distinct site_id plots."
    );
  }

  // Select available base features from the canonical 7-feature ESRC set (excluding TN_pct!)
  const activeFeatures = BASE_7_FEATURES.filter((feat) => {
    let validCnt = 0;
    for (const item of validRecords) {
      const val = extractBaseFeatureVal(item.rec, feat);
      if (val !== null && Number.isFinite(val)) validCnt++;
    }
    return validCnt >= 2;
  });

  if (activeFeatures.length < 2) {
    throw new Error("At least 2 numeric sensor features are required for calibration.");
  }

  const rawMatrix = validRecords.map((item) =>
    activeFeatures.map((feat) => extractBaseFeatureVal(item.rec, feat))
  );
  const y = validRecords.map((item) => item.socPct);

  const foldBuckets = computeGroupKFoldIndices(groups, 5);
  const nValid = validRecords.length;
  const olsOof = new Array<number>(nValid).fill(0.0);
  const ridgeOof = new Array<number>(nValid).fill(0.0);
  const foldIds = new Array<number>(nValid).fill(0);

  for (let f = 0; f < foldBuckets.length; f++) {
    const valIdx = foldBuckets[f] ?? [];
    const valSet = new Set(valIdx);
    const trainIdx: number[] = [];
    for (let i = 0; i < nValid; i++) {
      if (!valSet.has(i)) trainIdx.push(i);
    }

    const prep = fitPreprocessorAndTransform(rawMatrix, [...activeFeatures], trainIdx);
    const ZTrain = prep.transformRows(trainIdx);
    const yTrain = trainIdx.map((i) => y[i] ?? 0.0);
    const ZVal = prep.transformRows(valIdx);

    const olsFit = fitLinearWithQR(ZTrain, yTrain, 0.0);
    const ridgeFit = fitLinearWithQR(ZTrain, yTrain, ridgeAlpha);

    valIdx.forEach((rowI, pos) => {
      const zRow = ZVal[pos] ?? [];
      let yHatOls = olsFit.intercept;
      let yHatRidge = ridgeFit.intercept;
      for (let j = 0; j < zRow.length; j++) {
        yHatOls += (olsFit.coefficients[j] ?? 0.0) * (zRow[j] ?? 0.0);
        yHatRidge += (ridgeFit.coefficients[j] ?? 0.0) * (zRow[j] ?? 0.0);
      }
      olsOof[rowI] = Math.max(0.0, yHatOls);
      ridgeOof[rowI] = Math.max(0.0, yHatRidge);
      foldIds[rowI] = f;
    });
  }

  const olsMetrics = computeMetrics(y, olsOof);
  const ridgeMetrics = computeMetrics(y, ridgeOof);
  const ridgeBeatsOls = ridgeMetrics.rmse < olsMetrics.rmse - 1e-9 && ridgeMetrics.r2 > olsMetrics.r2 + 1e-9;

  const winnerFamily = ridgeBeatsOls ? "ridge" : "standardized_linear_interaction";
  const winnerOof = ridgeBeatsOls ? ridgeOof : olsOof;
  const winnerMetrics = ridgeBeatsOls ? ridgeMetrics : olsMetrics;
  const winnerAlpha = ridgeBeatsOls ? ridgeAlpha : 0.0;

  // Cross-conformal quantile q_095 + empirical coverage
  const residuals = y.map((yt, i) => Math.abs(yt - (winnerOof[i] ?? 0.0)));
  const coveredFlags: number[] = [];
  const widths: number[] = [];
  for (let f = 0; f < foldBuckets.length; f++) {
    const calRes = residuals.filter((_, idx) => foldIds[idx] !== f);
    const qF = computeConformalQuantile(calRes.length > 0 ? calRes : residuals, 0.05);
    for (let i = 0; i < nValid; i++) {
      if (foldIds[i] !== f) continue;
      const yp = winnerOof[i] ?? 0.0;
      const lo = Math.max(0.0, yp - qF);
      const hi = Math.max(0.0, yp + qF);
      const yt = y[i] ?? 0.0;
      coveredFlags.push(yt >= lo && yt <= hi ? 1 : 0);
      widths.push(hi - lo);
    }
  }
  const q095 = computeConformalQuantile(residuals, 0.05);
  const empiricalCoverage =
    coveredFlags.reduce((a, b) => a + b, 0) / Math.max(1, coveredFlags.length);
  const meanIntervalWidth = widths.reduce((a, b) => a + b, 0.0) / Math.max(1, widths.length);

  // Refit winner on all valid rows
  const allIndices = Array.from({ length: nValid }, (_, i) => i);
  const fullPrep = fitPreprocessorAndTransform(rawMatrix, [...activeFeatures], allIndices);
  const ZFull = fullPrep.transformRows(allIndices);
  const fullFit = fitLinearWithQR(ZFull, y, winnerAlpha);

  // Regularized Mahalanobis D^2 builder on raw base features
  const p = activeFeatures.length;
  const imputedRaw = allIndices.map((idx) =>
    activeFeatures.map((_, j) => {
      const v = rawMatrix[idx]?.[j];
      const m = fullPrep.means[j] ?? 0.0;
      return v !== null && v !== undefined && Number.isFinite(v) ? v : m;
    })
  );
  const zBase = imputedRaw.map((row) =>
    row.map((v, j) => (v - (fullPrep.means[j] ?? 0.0)) / (fullPrep.stds[j] ?? 1.0))
  );
  const regEps = 1e-3;
  const regCovZ: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0.0));
  const denom = Math.max(1, nValid - 1);
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      let s = 0.0;
      for (let r = 0; r < nValid; r++) {
        s += (zBase[r]?.[i] ?? 0.0) * (zBase[r]?.[j] ?? 0.0);
      }
      regCovZ[i]![j] = s / denom + (i === j ? regEps : 0.0);
    }
  }
  const invCovZ = invertSquareMatrix(regCovZ);
  const invCovRaw: number[][] = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => {
      const si = fullPrep.stds[i] ?? 1.0;
      const sj = fullPrep.stds[j] ?? 1.0;
      return (invCovZ[i]?.[j] ?? 0.0) / (si * sj);
    })
  );

  const d2Train = imputedRaw.map((row) => {
    const diff = row.map((v, j) => v - (fullPrep.means[j] ?? 0.0));
    let sum = 0.0;
    for (let i = 0; i < p; i++) {
      let rowSum = 0.0;
      for (let j = 0; j < p; j++) {
        rowSum += (invCovRaw[i]?.[j] ?? 0.0) * (diff[j] ?? 0.0);
      }
      sum += (diff[i] ?? 0.0) * rowSum;
    }
    return sum;
  });

  const d2Caution = quantileLinear(d2Train, 0.95);
  let d2Ood = quantileLinear(d2Train, 0.99);
  if (d2Ood <= d2Caution) {
    d2Ood = d2Caution * 1.05 + 1e-6;
  }

  // Fill residual table predictions
  validRecords.forEach((item, validIdx) => {
    const summary = rowSummaries[item.origIndex];
    const predSoc = winnerOof[validIdx] ?? 0.0;
    if (summary) {
      summary.predictedSocPct = predSoc;
      summary.residual = item.socPct - predSoc;
    }
  });

  const globalImportance: GlobalImportanceItem[] = fullPrep.outputFeatureOrder
    .map((feat, idx) => ({
      feature: feat,
      importance: Math.abs(fullFit.coefficients[idx] ?? 0.0),
      signed_effect: fullFit.coefficients[idx] ?? 0.0,
      rank: 0,
    }))
    .sort((a, b) => b.importance - a.importance)
    .map((item, rankIdx) => ({
      ...item,
      importance: Number(item.importance.toFixed(8)),
      signed_effect: item.signed_effect !== null ? Number(item.signed_effect.toFixed(8)) : null,
      rank: rankIdx + 1,
    }));

  const stratifiedErrors: StratifiedErrorItem[] = [];
  const depthMap = new Map<string, { yt: number[]; yp: number[] }>();
  validRecords.forEach((item, validIdx) => {
    const d = item.rec.reading.depth_cm ?? "Unknown";
    const bucket = depthMap.get(d) ?? { yt: [], yp: [] };
    bucket.yt.push(item.socPct);
    bucket.yp.push(winnerOof[validIdx] ?? 0.0);
    depthMap.set(d, bucket);
  });
  for (const [val, bucket] of Array.from(depthMap.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    const m = computeMetrics(bucket.yt, bucket.yp);
    stratifiedErrors.push({
      stratum_column: "depth_cm",
      stratum_value: val,
      n: bucket.yt.length,
      rmse: Number(m.rmse.toFixed(6)),
      mae: Number(m.mae.toFixed(6)),
      r2: bucket.yt.length >= 2 ? Number(m.r2.toFixed(6)) : null,
    });
  }

  const aezSlug = (options.aezZone ?? "local_aez").toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const modelId = `local_${aezSlug}_soc_calibrated`.replace(/^_+|_+$/g, "");

  const namedCoefficients: Record<string, number> = {};
  fullPrep.outputFeatureOrder.forEach((f, idx) => {
    namedCoefficients[f] = fullFit.coefficients[idx] ?? 0.0;
  });

  const toRecord = (vals: number[]): Record<string, number> => {
    const out: Record<string, number> = {};
    activeFeatures.forEach((f, i) => {
      out[f] = vals[i] ?? 0.0;
    });
    return out;
  };

  const entryWithoutHash: Omit<ModelEntry, "artifact_sha256"> = {
    model_id: modelId,
    model_version: `local-${new Date().toISOString().slice(0, 10)}`,
    dataset_id: `${aezSlug}_paired_lab`,
    target_name: "SOC_pct",
    target_unit: "%",
    van_bemmelen_k: DEFAULT_VAN_BEMMELEN_K,
    selection_status: "selected_champion",
    selected_model_family: winnerFamily,
    beats_ols_baseline: ridgeBeatsOls,
    provenance: {
      source_title: options.modelLabel?.trim() || `Local ESRC AEZ Paired Calibration (${options.aezZone ?? "Field Upload"})`,
      doi_or_slug: "local-browser-calibration",
      is_synthetic_or_fixture: false,
    },
    preprocessing: {
      raw_features: [...activeFeatures],
      interaction_terms: fullPrep.interactions,
      model_feature_order: fullPrep.outputFeatureOrder,
      feature_means: toRecord(fullPrep.means),
      feature_stds: toRecord(fullPrep.stds),
      feature_mins: toRecord(fullPrep.mins),
      feature_maxs: toRecord(fullPrep.maxs),
      feature_q01: toRecord(fullPrep.q01),
      feature_q99: toRecord(fullPrep.q99),
    },
    predictor: {
      type: "linear",
      input_space: "standardized",
      intercept: fullFit.intercept,
      coefficients: fullFit.coefficients,
      named_coefficients: namedCoefficients,
      clip_non_negative: true,
    },
    uncertainty: {
      method: "oof_conformal",
      alpha: 0.05,
      q_095: Number(q095.toFixed(8)),
      empirical_coverage: Number(empiricalCoverage.toFixed(6)),
      mean_interval_width: Number(meanIntervalWidth.toFixed(6)),
      clip_lower_at_zero: true,
      apply_van_bemmelen_to_interval: true,
    },
    ood: {
      feature_order: [...activeFeatures],
      feature_mins: fullPrep.mins,
      feature_maxs: fullPrep.maxs,
      feature_q01: fullPrep.q01,
      feature_q99: fullPrep.q99,
      mahalanobis_mean: fullPrep.means,
      mahalanobis_inv_cov: invCovRaw,
      regularization_eps: regEps,
      d2_caution_threshold: d2Caution,
      d2_ood_threshold: d2Ood,
      domain_status_labels: ["In-Range", "Caution", "Outside Calibration Range"],
    },
    explainability: {
      method: "standardized_coefficients",
      global_importance: globalImportance,
      stratified_errors: stratifiedErrors,
    },
    metrics: {
      cv_strategy: `GroupKFold(${foldBuckets.length}, groups=site_id)`,
      n_samples: nValid,
      n_groups: uniqueSites.length,
      rmse: Number(winnerMetrics.rmse.toFixed(6)),
      mae: Number(winnerMetrics.mae.toFixed(6)),
      r2: Number(winnerMetrics.r2.toFixed(6)),
      baseline_ols_rmse: Number(olsMetrics.rmse.toFixed(6)),
      baseline_ols_mae: Number(olsMetrics.mae.toFixed(6)),
      baseline_ols_r2: Number(olsMetrics.r2.toFixed(6)),
      model_comparison: [
        {
          model_name: "ols_interaction",
          rmse: Number(olsMetrics.rmse.toFixed(6)),
          mae: Number(olsMetrics.mae.toFixed(6)),
          r2: Number(olsMetrics.r2.toFixed(6)),
          beats_ols_baseline: false,
          retained: true,
        },
        {
          model_name: "ridge",
          rmse: Number(ridgeMetrics.rmse.toFixed(6)),
          mae: Number(ridgeMetrics.mae.toFixed(6)),
          r2: Number(ridgeMetrics.r2.toFixed(6)),
          beats_ols_baseline: ridgeBeatsOls,
          retained: ridgeBeatsOls,
        },
      ],
    },
    notes: `Locally calibrated in browser via Householder QR solver on ${nValid} valid paired rows across ${uniqueSites.length} sites (TN_pct excluded).`,
  };

  const modelEntry = await signModelEntry(entryWithoutHash);

  let updatedRegistry: ModelRegistry | null = null;
  if (options.baseRegistry) {
    const withoutIntegrity: Omit<ModelRegistry, "integrity"> = {
      schema_version: options.baseRegistry.schema_version,
      generated_at_utc: new Date().toISOString(),
      platform: options.baseRegistry.platform,
      authority_protocol: options.baseRegistry.authority_protocol,
      hardware_physics_guardrails: options.baseRegistry.hardware_physics_guardrails,
      models: {
        ...options.baseRegistry.models,
        [modelEntry.model_id]: modelEntry,
      },
      leakage_and_quality_audits: options.baseRegistry.leakage_and_quality_audits,
    };
    const rootHash = await sha256HexUtf8(canonicalJsonFromValue(withoutIntegrity));
    updatedRegistry = {
      ...withoutIntegrity,
      integrity: {
        hash_algorithm: "SHA-256",
        canonicalization: "canonicalJsonFromValue(payload)",
        canonical_payload_sha256: rootHash,
      },
    };
  }

  return {
    modelEntry,
    validRowCount: nValid,
    quarantinedRowCount: rowSummaries.filter((r) => r.quarantined).length,
    uniqueSiteCount: uniqueSites.length,
    hasTnLeakColumn: parsed.hasTnLeakColumn,
    tnOmCorrelation: pearsonCorrelation(tnPairsX, tnPairsY),
    cnWarningCount: validRecords.filter((v) =>
      v.rec.report.flags.some((f) => f.code === "CN_PLAUSIBILITY_WARNING")
    ).length,
    rowSummaries,
    olsMetrics,
    ridgeMetrics,
    updatedRegistry,
  };
}
