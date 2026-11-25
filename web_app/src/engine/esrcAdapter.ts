import { kCmolToMgKg, normalizeEcToDsM, validateSoilReading } from "./soilPhysics";
import type { ECUnit, KUnit, PhysicsValidationReport, SoilReadingInput } from "./types";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_ROWS = 10_000;

const PROTO_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

const FIELD_ALIASES: Record<string, string> = {
  temperature: "temperature_c",
  temp_c: "temperature_c",
  temp: "temperature_c",
  temperature_c: "temperature_c",
  humidity: "moisture_pct",
  moisture: "moisture_pct",
  moisture_pct: "moisture_pct",
  ec: "ec_generic",
  ec_us_cm: "ec_us_cm",
  ec_ds_m: "ec_ds_m",
  ec_ms_cm: "ec_ms_cm",
  ec_unit: "ec_unit",
  salinity: "salinity_mg_l",
  salinity_mg_l: "salinity_mg_l",
  ph: "ph",
  nitrogen: "nitrogen_mg_kg",
  n: "nitrogen_mg_kg",
  nitrogen_mg_kg: "nitrogen_mg_kg",
  phosphorus: "phosphorus_mg_kg",
  p: "phosphorus_mg_kg",
  phosphorus_mg_kg: "phosphorus_mg_kg",
  potassium: "potassium_generic",
  k: "potassium_generic",
  potassium_mg_kg: "potassium_mg_kg",
  k_cmol_kg: "potassium_cmol_kg",
  potassium_cmol_kg: "potassium_cmol_kg",
  device_id: "device_id",
  device: "device_id",
  sensor_model: "device_id",
  site_id: "site_id",
  site: "site_id",
  location: "site_id",
  timestamp: "timestamp",
  created_at: "timestamp",
  aez_zone: "aez_zone",
  lat: "lat",
  latitude: "lat",
  lon: "lon",
  longitude: "lon",
  depth_cm: "depth_cm",
  depth_mid_cm: "depth_mid_cm",
  days_since_rain: "days_since_rain",
  days_since_fertilizer: "days_since_fertilizer",
  tn_pct: "total_nitrogen_pct",
  total_nitrogen_pct: "total_nitrogen_pct",
  sand: "sand_pct",
  sand_pct: "sand_pct",
  silt: "silt_pct",
  silt_pct: "silt_pct",
  clay: "clay_pct",
  clay_pct: "clay_pct",
  texture_class: "texture_class",
  crop: "crop",
};

export interface ParsedEsrcRecord {
  reading: SoilReadingInput;
  report: PhysicsValidationReport;
  strippedKeys: string[];
  labSocPct: number | null;
  labPoxcMgKg: number | null;
  labMethod: string | null;
  hasLeakedTnColumn: boolean;
}

export function sanitizeSpreadsheetCell(value: string): string {
  if (value.length > 0 && FORMULA_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return `'${value}`;
  }
  return value;
}

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  if (val === null || typeof val !== "object" || Array.isArray(val)) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

/**
 * Check raw JSON text for unquoted non-finite literals (NaN, Infinity, -Infinity) outside string literals.
 */
function assertNoUnquotedNonFiniteLiterals(rawJson: string): void {
  let inString = false;
  let escaped = false;
  let i = 0;
  while (i < rawJson.length) {
    const ch = rawJson[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      i++;
      continue;
    }
    if (rawJson.startsWith("NaN", i) || rawJson.startsWith("Infinity", i) || rawJson.startsWith("-Infinity", i)) {
      throw new Error("Rejected non-finite JSON token (NaN or Infinity).");
    }
    i++;
  }
}

/**
 * Parse JSON while stripping prototype-pollution keys (__proto__, constructor, prototype)
 * before any object property touches runtime lookup paths.
 */
export function parseSafeJsonPayload(
  rawJson: string,
  maxBytes = MAX_UPLOAD_BYTES
): { decoded: unknown; strippedKeys: string[] } {
  const byteLength = new TextEncoder().encode(rawJson).length;
  if (byteLength > maxBytes) {
    throw new Error(`JSON payload exceeds max allowed size of ${maxBytes} bytes.`);
  }
  assertNoUnquotedNonFiniteLiterals(rawJson);

  const strippedKeys: string[] = [];
  const decoded: unknown = JSON.parse(rawJson, (key, value: unknown) => {
    if (PROTO_POLLUTION_KEYS.has(key)) {
      strippedKeys.push(key);
      return undefined;
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`Rejected non-finite numeric value for '${key}'.`);
    }
    return value;
  });

  return { decoded, strippedKeys };
}

function toOptionalFloat(val: unknown, fieldName: string): number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === "boolean") {
    throw new Error(`Boolean is not valid for numeric field '${fieldName}'.`);
  }
  if (typeof val === "number") {
    if (!Number.isFinite(val)) {
      throw new Error(`Non-finite numeric value for '${fieldName}': ${String(val)}`);
    }
    return val;
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed === "") return null;
    const lowered = trimmed.toLowerCase();
    if (lowered === "na" || lowered === "null" || lowered === "none") return null;
    if (lowered === "nan" || lowered === "infinity" || lowered === "-infinity" || lowered === "+infinity") {
      throw new Error(`Non-finite numeric value for '${fieldName}': ${trimmed}`);
    }
    const num = Number(trimmed);
    if (!Number.isFinite(num)) {
      throw new Error(`Invalid numeric value for '${fieldName}': ${trimmed}`);
    }
    return num;
  }
  throw new Error(`Invalid value type for '${fieldName}': ${typeof val}`);
}

function toOptionalString(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const text = String(val).trim();
  return text.length > 0 ? text : null;
}

function validateIsoTimestamp(ts: string | null): string | null {
  if (ts === null) return null;
  // Require date structure and finite parse
  if (!/^\d{4}-\d{2}-\d{2}(T|\s)/.test(ts) && !/^\d{4}-\d{2}-\d{2}$/.test(ts)) {
    throw new Error(`Malformed ISO-8601 timestamp: '${ts}'`);
  }
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Malformed ISO-8601 timestamp: '${ts}'`);
  }
  return ts;
}

export function parseDepthMidpoint(depthCm: string | null): number | null {
  if (depthCm === null) return null;
  const dashIdx = depthCm.indexOf("-");
  if (dashIdx !== -1) {
    const top = Number(depthCm.slice(0, dashIdx).trim());
    const bottom = Number(depthCm.slice(dashIdx + 1).trim());
    if (Number.isFinite(top) && Number.isFinite(bottom) && top <= bottom) {
      return (top + bottom) / 2.0;
    }
    return null;
  }
  const single = Number(depthCm.trim());
  return Number.isFinite(single) ? single : null;
}

export interface NormalizeRecordOptions {
  ecUnit?: ECUnit;
  potassiumUnit?: KUnit;
  strippedKeys?: string[];
  requireExplicitEcUnit?: boolean;
}

export function normalizeEsrcRecord(
  rawRecord: Record<string, unknown>,
  options: NormalizeRecordOptions = {}
): ParsedEsrcRecord {
  const strippedKeys: string[] = [...(options.strippedKeys ?? [])];
  const mapped: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(rawRecord)) {
    if (PROTO_POLLUTION_KEYS.has(key)) {
      strippedKeys.push(key);
      continue;
    }
    const canon = FIELD_ALIASES[key.trim().toLowerCase()];
    if (canon !== undefined && !(canon in mapped)) {
      mapped[canon] = value;
    }
  }

  // EC unit resolution
  let resolvedEcUnit: ECUnit = options.ecUnit ?? "unknown";
  let ecRawVal: number | null = null;
  let ecDsMVal: number | null = null;

  if (mapped.ec_unit !== undefined && mapped.ec_unit !== null) {
    const u = String(mapped.ec_unit).trim();
    if (u === "dS/m" || u === "uS/cm" || u === "mS/cm" || u === "unknown") {
      resolvedEcUnit = u;
    }
  }

  const ecDsMExplicit = toOptionalFloat(mapped.ec_ds_m, "ec_ds_m");
  const ecMsCmExplicit = toOptionalFloat(mapped.ec_ms_cm, "ec_ms_cm");
  const ecUsCmExplicit = toOptionalFloat(mapped.ec_us_cm, "ec_us_cm");
  const ecGeneric = toOptionalFloat(mapped.ec_generic, "EC");

  if (ecDsMExplicit !== null) {
    ecRawVal = ecDsMExplicit;
    resolvedEcUnit = "dS/m";
  } else if (ecMsCmExplicit !== null) {
    ecRawVal = ecMsCmExplicit;
    resolvedEcUnit = "mS/cm";
  } else if (ecUsCmExplicit !== null) {
    ecRawVal = ecUsCmExplicit;
    resolvedEcUnit = "uS/cm";
  } else if (ecGeneric !== null) {
    ecRawVal = ecGeneric;
  }

  if (ecRawVal !== null) {
    if (options.requireExplicitEcUnit && resolvedEcUnit === "unknown") {
      throw new Error(
        "EC unit is ambiguous ('unknown'). Explicitly select 'dS/m' or 'uS/cm' before continuing."
      );
    }
    ecDsMVal = normalizeEcToDsM(ecRawVal, resolvedEcUnit).ecDsM;
  }

  // Potassium unit normalization (explicit K cmol(+)/kg * 391.0)
  const kUnit: KUnit = options.potassiumUnit ?? "mg/kg";
  let potassiumMgKg: number | null = null;
  const kMgExplicit = toOptionalFloat(mapped.potassium_mg_kg, "potassium_mg_kg");
  const kCmolExplicit = toOptionalFloat(mapped.potassium_cmol_kg, "k_cmol_kg");
  const kGeneric = toOptionalFloat(mapped.potassium_generic, "K");
  if (kMgExplicit !== null) {
    potassiumMgKg = kMgExplicit;
  } else if (kCmolExplicit !== null) {
    potassiumMgKg = kCmolToMgKg(kCmolExplicit);
  } else if (kGeneric !== null) {
    potassiumMgKg = kUnit === "cmol(+)/kg" ? kCmolToMgKg(kGeneric) : kGeneric;
  }

  const rawSite = toOptionalString(mapped.site_id);
  const rawDevice = toOptionalString(mapped.device_id);
  const cropRaw = toOptionalString(mapped.crop);
  const depthCm = toOptionalString(mapped.depth_cm);
  let depthMid = toOptionalFloat(mapped.depth_mid_cm, "depth_mid_cm");
  if (depthMid === null) {
    depthMid = parseDepthMidpoint(depthCm);
  }

  const reading: SoilReadingInput = {
    site_id: rawSite !== null ? sanitizeSpreadsheetCell(rawSite) : null,
    device_id: rawDevice !== null ? sanitizeSpreadsheetCell(rawDevice) : null,
    raw_site_id: rawSite,
    raw_device_id: rawDevice,
    timestamp: validateIsoTimestamp(toOptionalString(mapped.timestamp)),
    aez_zone: toOptionalString(mapped.aez_zone),
    lat: toOptionalFloat(mapped.lat, "lat"),
    lon: toOptionalFloat(mapped.lon, "lon"),
    depth_cm: depthCm,
    depth_mid_cm: depthMid,
    nitrogen_mg_kg: toOptionalFloat(mapped.nitrogen_mg_kg, "nitrogen_mg_kg"),
    phosphorus_mg_kg: toOptionalFloat(mapped.phosphorus_mg_kg, "phosphorus_mg_kg"),
    potassium_mg_kg: potassiumMgKg,
    ph: toOptionalFloat(mapped.ph, "ph"),
    ec_ds_m: ecDsMVal,
    ec_raw: ecRawVal,
    ec_unit: resolvedEcUnit,
    salinity_mg_l: toOptionalFloat(mapped.salinity_mg_l, "salinity_mg_l"),
    temperature_c: toOptionalFloat(mapped.temperature_c, "temperature_c"),
    moisture_pct: toOptionalFloat(mapped.moisture_pct, "moisture_pct"),
    days_since_rain: toOptionalFloat(mapped.days_since_rain, "days_since_rain"),
    days_since_fertilizer: toOptionalFloat(mapped.days_since_fertilizer, "days_since_fertilizer"),
    total_nitrogen_pct: toOptionalFloat(mapped.total_nitrogen_pct, "total_nitrogen_pct"),
    sand_pct: toOptionalFloat(mapped.sand_pct, "sand_pct"),
    silt_pct: toOptionalFloat(mapped.silt_pct, "silt_pct"),
    clay_pct: toOptionalFloat(mapped.clay_pct, "clay_pct"),
    texture_class: toOptionalString(mapped.texture_class),
    crop: cropRaw !== null ? sanitizeSpreadsheetCell(cropRaw) : null,
  };

  const labSocPct = toOptionalFloat(rawRecord.lab_soc_pct, "lab_soc_pct");
  const labPoxcMgKg = toOptionalFloat(rawRecord.lab_poxc_mg_kg, "lab_poxc_mg_kg");
  const labMethod = toOptionalString(rawRecord.lab_method);
  const report = validateSoilReading(reading, { socPct: labSocPct });

  return {
    reading,
    report,
    strippedKeys,
    labSocPct,
    labPoxcMgKg,
    labMethod,
    hasLeakedTnColumn: reading.total_nitrogen_pct !== null || "TN_pct" in rawRecord || "tn_pct" in rawRecord,
  };
}

export interface ParseBatchOptions extends NormalizeRecordOptions {
  maxBytes?: number;
  maxRows?: number;
}

export function parseEsrcJson(
  rawJson: string,
  options: ParseBatchOptions = {}
): ParsedEsrcRecord[] {
  const maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
  const maxRows = options.maxRows ?? MAX_UPLOAD_ROWS;
  const { decoded, strippedKeys } = parseSafeJsonPayload(rawJson, maxBytes);

  let records: Record<string, unknown>[];
  if (isPlainRecord(decoded)) {
    records = [decoded];
  } else if (Array.isArray(decoded)) {
    if (decoded.length > maxRows) {
      throw new Error(`JSON batch exceeds maximum allowed row limit of ${maxRows}.`);
    }
    if (decoded.length === 0) {
      throw new Error("JSON array contains no telemetry records.");
    }
    for (const item of decoded) {
      if (!isPlainRecord(item)) {
        throw new Error("JSON batch elements must all be plain JSON objects.");
      }
    }
    records = decoded as Record<string, unknown>[];
  } else {
    throw new Error("ESRC JSON payload must be a plain JSON object or an array of objects.");
  }

  return records.map((rec) => normalizeEsrcRecord(rec, { ...options, strippedKeys }));
}

function parseCsvRows(text: string, maxRows: number): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.trimStart().startsWith("#"));

  if (lines.length < 2) {
    throw new Error("CSV must include a header row and at least one data row.");
  }

  const splitLine = (line: string): string[] => {
    const cells: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          current += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        cells.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    cells.push(current.trim());
    return cells;
  };

  const headerLine = lines[0];
  if (!headerLine) {
    throw new Error("CSV header row is missing.");
  }
  const headers = splitLine(headerLine).map((h) => h.replace(/^\uFEFF/, ""));
  if (headers.some((h) => PROTO_POLLUTION_KEYS.has(h))) {
    throw new Error("CSV header contains forbidden prototype-pollution column name.");
  }

  const dataLines = lines.slice(1);
  if (dataLines.length > maxRows) {
    throw new Error(`CSV exceeds maximum allowed row count (${maxRows}).`);
  }

  const rows: Record<string, string>[] = [];
  for (const dataLine of dataLines) {
    const values = splitLine(dataLine);
    const rowObj: Record<string, string> = {};
    for (let idx = 0; idx < headers.length; idx++) {
      const headerName = headers[idx];
      if (headerName !== undefined && headerName.length > 0) {
        rowObj[headerName] = values[idx] ?? "";
      }
    }
    rows.push(rowObj);
  }

  return { headers, rows };
}

export interface ParsedCsvBatch {
  headers: string[];
  records: ParsedEsrcRecord[];
  hasTnLeakColumn: boolean;
}

export function parseEsrcCsv(
  csvText: string,
  options: ParseBatchOptions = {}
): ParsedCsvBatch {
  const maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
  const maxRows = options.maxRows ?? MAX_UPLOAD_ROWS;

  const byteLength = new TextEncoder().encode(csvText).length;
  if (byteLength > maxBytes) {
    throw new Error(`CSV payload exceeds max allowed size of ${maxBytes} bytes.`);
  }

  const { headers, rows } = parseCsvRows(csvText, maxRows);
  const hasTnLeakColumn = headers.some((h) => {
    const low = h.trim().toLowerCase();
    return low === "tn_pct" || low === "total_nitrogen_pct";
  });

  const records = rows.map((row) => normalizeEsrcRecord(row, options));
  return { headers, records, hasTnLeakColumn };
}
