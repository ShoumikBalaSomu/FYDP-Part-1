import { describe, expect, it } from "vitest";
import { runInBrowserCalibration, solveLeastSquaresQR } from "../engine/calibrationEngine";
import { normalizeEsrcRecord } from "../engine/esrcAdapter";
import { runSomPrediction } from "../engine/inferenceEngine";
import {
  exportReadingToJsonBundle,
  exportReadingToMarkdownBrief,
  exportReadingToSafeCsv,
} from "../engine/reportExporter";

describe("In-Browser QR Calibration Solver & Safe Report Exporter", () => {
  it("solves overdetermined least-squares systems accurately via Householder QR", () => {
    // Fit y = 2.0 + 3.0 * x1 - 1.5 * x2
    const A = [
      [1, 0, 0],
      [1, 1, 0],
      [1, 0, 1],
      [1, 2, 1],
      [1, 3, 2],
    ];
    const b = A.map(([, x1, x2]) => 2.0 + 3.0 * (x1 ?? 0) - 1.5 * (x2 ?? 0));
    const sol = solveLeastSquaresQR(A, b);
    expect(sol[0]).toBeCloseTo(2.0, 10);
    expect(sol[1]).toBeCloseTo(3.0, 10);
    expect(sol[2]).toBeCloseTo(-1.5, 10);
  });

  it("calibrates 9-term standardized interaction model, blocks TN_pct leak, quarantines fault rows, and builds OOD bounds", async () => {
    const header =
      "site_id,aez_zone,depth_cm,N,P,K,pH,EC,Temp_C,Moisture_pct,lab_soc_pct,TN_pct";
    const rows: string[] = [header];

    // 15 valid paired rows across 5 distinct sites + 1 fault row (pH=0.12) + TN_pct circular leak column
    const sites = ["site_a", "site_b", "site_c", "site_d", "site_e"];
    for (let i = 0; i < 15; i++) {
      const site = sites[i % sites.length]!;
      const n = 160 + ((i * 17) % 90);
      const p = 14 + ((i * 7) % 15);
      const k = 140 + ((i * 23) % 85);
      const ph = 6.1 + ((i * 3) % 11) * 0.12;
      const ec = 0.35 + ((i * 5) % 9) * 0.08;
      const temp = 24.5 + ((i * 11) % 7) * 0.9;
      const moist = 26.0 + ((i * 13) % 11) * 2.4;
      const soc = 0.9 + 0.002 * n + 0.012 * moist - 0.02 * (temp - 26) + (i % 3) * 0.03;
      const tn = 0.0492 * (soc * 1.724) - 0.0065;
      rows.push(`${site},AEZ-19,0-15,${n},${p},${k},${ph.toFixed(2)},${ec.toFixed(2)},${temp.toFixed(1)},${moist.toFixed(1)},${soc.toFixed(4)},${tn.toFixed(4)}`);
    }
    // Inject fault row matching cumilla 2 failure
    rows.push("site_fault,AEZ-19,0-15,185,18.0,175,0.12,1.48,29.4,100.0,1.20,0.095");

    const result = await runInBrowserCalibration(rows.join("\n"), {
      ecUnit: "dS/m",
      potassiumUnit: "mg/kg",
      socUnit: "%",
      aezZone: "AEZ-19",
      modelLabel: "AEZ-19 Test Calibration",
    });

    expect(result.validRowCount).toBe(15);
    expect(result.quarantinedRowCount).toBe(1);
    expect(result.uniqueSiteCount).toBe(5);
    expect(result.hasTnLeakColumn).toBe(true);
    expect(result.tnOmCorrelation).toBeGreaterThan(0.95);

    const entry = result.modelEntry;
    expect(entry.preprocessing.raw_features).toHaveLength(7);
    expect(entry.preprocessing.raw_features).not.toContain("total_nitrogen_pct");
    expect(entry.preprocessing.raw_features).not.toContain("TN_pct");
    expect(entry.preprocessing.model_feature_order).toHaveLength(9);
    expect(entry.preprocessing.interaction_terms.map((t) => t.name)).toEqual([
      "z_temperature_c_x_z_moisture_pct",
      "z_ec_ds_m_x_z_moisture_pct",
    ]);
    expect(entry.uncertainty.q_095).toBeGreaterThan(0);
    expect(entry.artifact_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.ood.mahalanobis_inv_cov).toHaveLength(7);

    // Run live inference using newly calibrated local model
    const { reading } = normalizeEsrcRecord({
      site_id: "new_plot",
      N: 200,
      P: 18,
      K: 185,
      pH: 6.7,
      EC: 0.55,
      Temp_C: 27.0,
      Moisture_pct: 36.0,
    }, { ecUnit: "dS/m" });
    const pred = runSomPrediction(entry, reading);
    expect(pred.blocked).toBe(false);
    expect(pred.estimatedSomPct).toBeGreaterThan(1.0);
    expect(pred.somCi95Lower).toBeGreaterThanOrEqual(0.0);

    // Export CSV neutralization check for hostile site_id
    const { reading: evilReading } = normalizeEsrcRecord({
      site_id: '=HYPERLINK("http://evil.invalid","pwn")',
      device_id: "@ESRC",
      N: 200,
      P: 18,
      K: 185,
      pH: 6.7,
      EC: 0.55,
      Temp_C: 27.0,
      Moisture_pct: 36.0,
    }, { ecUnit: "dS/m" });
    const csvOut = exportReadingToSafeCsv(evilReading, pred, entry);
    expect(csvOut).toContain('"\'=HYPERLINK(""http://evil.invalid"",""pwn"")"');
    expect(csvOut).toContain("'@ESRC");

    const jsonBundle = JSON.parse(exportReadingToJsonBundle(evilReading, pred, entry));
    expect(jsonBundle.input_telemetry.site_id.startsWith("'=")).toBe(true);
    expect(jsonBundle.model_provenance.artifact_sha256).toBe(entry.artifact_sha256);

    const mdBrief = exportReadingToMarkdownBrief(evilReading, pred, entry);
    expect(mdBrief).toContain("Estimated SOM (%)");
    expect(mdBrief).toContain("95% Prediction Interval");
  });
});
