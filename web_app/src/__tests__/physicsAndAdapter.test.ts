import { describe, expect, it } from "vitest";
import {
  normalizeEsrcRecord,
  parseEsrcCsv,
  parseEsrcJson,
  sanitizeSpreadsheetCell,
} from "../engine/esrcAdapter";
import {
  checkTemporalStability,
  classifyBarcSom,
  computePassiveCarbonGuarded,
  kCmolToMgKg,
  socGKgToPct,
  validateSoilReading,
} from "../engine/soilPhysics";

describe("Soil Physics Guardrails & ESRC Adapter Security", () => {
  it("flags SENSOR_FAULT_CRITICAL and SATURATION_DISTURBANCE_WARNING on cumilla 2 (pH=0.12, Humidity=100%)", () => {
    const raw = JSON.stringify({
      Device: "ESRC Device - 1",
      site: "cumilla 2",
      created_at: "2026-09-29T10:15:00+06:00",
      Temperature: 29.4,
      Humidity: 100.0,
      EC: 620.0,
      ec_unit: "uS/cm",
      Salinity: 395.0,
      PH: 0.12,
      Nitrogen: 185,
      Phosphorus: 19.2,
      Potassium: 178,
    });

    const parsed = parseEsrcJson(raw);
    expect(parsed).toHaveLength(1);
    const { reading, report } = parsed[0]!;

    expect(reading.raw_site_id).toBe("cumilla 2");
    expect(reading.raw_device_id).toBe("ESRC Device - 1");
    expect(reading.ec_ds_m).toBeCloseTo(0.62, 6);
    expect(report.passed_hard_gates).toBe(false);

    const codes = new Set(report.flags.map((f) => f.code));
    expect(codes.has("SENSOR_FAULT_CRITICAL")).toBe(true);
    expect(codes.has("SATURATION_DISTURBANCE_WARNING")).toBe(true);
  });

  it("strips __proto__, constructor, and prototype keys without polluting Object.prototype and rejects NaN/Infinity", () => {
    const hostile =
      '{"__proto__": {"polluted": "yes"}, "constructor": {"bad": 1}, "prototype": {"x": 2}, "PH": 11.15, "Humidity": 45}';
    const parsed = parseEsrcJson(hostile);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(parsed[0]!.strippedKeys).toEqual(["__proto__", "constructor", "prototype"]);
    expect(parsed[0]!.report.passed_hard_gates).toBe(false);
    expect(parsed[0]!.report.flags[0]!.code).toBe("SENSOR_FAULT_CRITICAL");

    expect(() => parseEsrcJson('{"PH": NaN}')).toThrow(/non-finite/i);
    expect(() => parseEsrcJson('{"PH": Infinity}')).toThrow(/non-finite/i);
    expect(() => parseEsrcJson('{"PH": "NaN"}')).toThrow(/non-finite/i);
  });

  it("enforces upload byte and row limits and rejects missing EC units when required", () => {
    expect(() => parseEsrcJson('{"PH": 6.5}', { maxBytes: 5 })).toThrow(/max allowed size/i);
    expect(() =>
      parseEsrcJson(JSON.stringify([{ PH: 6.5 }, { PH: 6.6 }]), { maxRows: 1 })
    ).toThrow(/row limit/i);

    const ambiguous = normalizeEsrcRecord(
      { site_id: "test", PH: 6.5, EC: 620 },
      { ecUnit: "unknown" }
    );
    expect(ambiguous.reading.ec_ds_m).toBeNull();
    expect(ambiguous.report.flags.some((f) => f.code === "EC_UNIT_AMBIGUITY_WARNING")).toBe(true);

    expect(() =>
      normalizeEsrcRecord({ site_id: "test", PH: 6.5, EC: 620 }, { ecUnit: "unknown", requireExplicitEcUnit: true })
    ).toThrow(/EC unit is ambiguous/i);
  });

  it("detects transient ion disturbance, EC/salinity mismatch, 24h jump, and C:N plausibility", () => {
    const ion = normalizeEsrcRecord({
      site_id: "wet-fert",
      PH: 6.6,
      ec_ds_m: 2.35,
      Moisture: 75.0,
      days_since_fertilizer: 1,
    });
    expect(ion.report.flags.some((f) => f.code === "TRANSIENT_ION_DISTURBANCE")).toBe(true);

    const mismatch = normalizeEsrcRecord({
      site_id: "bad-tds",
      PH: 6.8,
      ec_ds_m: 520,
      Salinity: 333,
      Moisture: 40,
    });
    expect(mismatch.report.flags.some((f) => f.code === "EC_SALINITY_MISMATCH")).toBe(true);

    const jumpFlags = checkTemporalStability(
      [
        { timestampIso: "2026-09-29T08:00:00Z", somPct: 1.45 },
        { timestampIso: "2026-09-29T14:00:00Z", somPct: 1.92 },
      ],
      "cumilla 2"
    );
    expect(jumpFlags).toHaveLength(1);
    expect(jumpFlags[0]!.code).toBe("TEMPORAL_JUMP_WARNING");

    const cnRep = validateSoilReading(
      normalizeEsrcRecord({ PH: 6.7, tn_pct: 0.5 }).reading,
      { socPct: 1.2 }
    );
    expect(cnRep.flags.some((f) => f.code === "CN_PLAUSIBILITY_WARNING")).toBe(true);
  });

  it("enforces unit math, BARC tiers, Passive C guardrail, and CSV formula neutralization", () => {
    expect(kCmolToMgKg(0.23)).toBeCloseTo(89.93, 6);
    expect(socGKgToPct(28.0)).toBeCloseTo(2.8, 6);
    expect(classifyBarcSom(0.8)).toBe("Very Low");
    expect(classifyBarcSom(1.4)).toBe("Low");
    expect(classifyBarcSom(2.1)).toBe("Medium");
    expect(classifyBarcSom(4.0)).toBe("High");
    expect(classifyBarcSom(6.0)).toBe("Very High");

    expect(() => computePassiveCarbonGuarded(2.5, 750)).toThrow(/PASSIVE_CARBON_GUARDRAIL_VIOLATION/);
    expect(computePassiveCarbonGuarded(2.5, 750, 1.4)).toBeCloseTo(1.4, 6);

    expect(sanitizeSpreadsheetCell("=CMD|'calc'!A0")).toBe("'=CMD|'calc'!A0");
    expect(sanitizeSpreadsheetCell("+1+1")).toBe("'+1+1");
    expect(sanitizeSpreadsheetCell("-10")).toBe("'-10");
    expect(sanitizeSpreadsheetCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(sanitizeSpreadsheetCell("\tcmd")).toBe("'\tcmd");
    expect(sanitizeSpreadsheetCell("\rcmd")).toBe("'\rcmd");
    expect(sanitizeSpreadsheetCell("cumilla 2")).toBe("cumilla 2");

    const csvBatch = parseEsrcCsv(
      "site_id,pH,K,EC,Temp_C,Moisture_pct,TN_pct\ns1,7.2,0.25,500,28,35,0.12\n",
      { ecUnit: "uS/cm", potassiumUnit: "cmol(+)/kg" }
    );
    expect(csvBatch.hasTnLeakColumn).toBe(true);
    expect(csvBatch.records[0]!.reading.potassium_mg_kg).toBeCloseTo(0.25 * 391.0, 6);
    expect(csvBatch.records[0]!.reading.ec_ds_m).toBeCloseTo(0.5, 6);
  });
});
