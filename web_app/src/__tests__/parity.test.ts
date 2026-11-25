import { describe, expect, it } from "vitest";
import registryRawText from "../../public/models/registry.json?raw";
import { normalizeEsrcRecord } from "../engine/esrcAdapter";
import { predictRawFromRegistryEntry, runSomPrediction } from "../engine/inferenceEngine";
import { parseAndVerifyRegistryText } from "../engine/registryLoader";
import type { ModelEntry } from "../engine/types";
import goldenVectors from "./fixtures/python_golden_vectors.json";

interface GoldenCase {
  row_index?: number;
  name?: string;
  model_id?: string;
  sample: Record<string, number | null>;
  expected: {
    point: number;
    ci_low: number;
    ci_high: number;
    domain_status: string;
    d2: number;
  };
}

describe("Registry WebCrypto SHA-256 & Python-to-TypeScript <1e-6 Numerical Parity", () => {
  it("verifies public/models/registry.json root SHA-256 and all 5 model artifact SHA-256 hashes", async () => {
    const result = await parseAndVerifyRegistryText(registryRawText);

    expect(result.verifiedModels).toBe(5);
    expect(result.rootSha256).toBe(result.registry.integrity.canonical_payload_sha256);
    expect(result.registry.authority_protocol.forbid_direct_sensor_om).toBe(true);
    expect(result.registry.authority_protocol.forbid_passive_c_subtraction).toBe(true);
  });

  it("rejects tampered registry payloads when SHA-256 fails", async () => {
    const tampered = registryRawText.replace('"default_van_bemmelen_k": 1.724', '"default_van_bemmelen_k": 1.999');
    await expect(parseAndVerifyRegistryText(tampered)).rejects.toThrow(/SHA-256 mismatch/);
  });

  it("matches Python predictions within < 1e-6 across all 5 real dataset models and edge cases", async () => {
    const { registry } = await parseAndVerifyRegistryText(registryRawText);

    const modelGroups: Array<[keyof typeof goldenVectors, string]> = [
      ["srdi_kushtia_om_champion", "srdi_kushtia_om_champion"],
      ["srdi_kushtia_om_baseline_ols", "srdi_kushtia_om_baseline_ols"],
      ["kaggle_mineral_oc_benchmark", "kaggle_mineral_oc_benchmark"],
      ["usda_kssl_poxc_with_soc", "usda_kssl_poxc_with_soc"],
      ["usda_kssl_poxc_without_soc", "usda_kssl_poxc_without_soc"],
    ];

    for (const [groupKey, modelId] of modelGroups) {
      const entry = registry.models[modelId];
      expect(entry).toBeDefined();
      const cases = goldenVectors[groupKey] as GoldenCase[];
      for (const testCase of cases) {
        const res = predictRawFromRegistryEntry(entry!, testCase.sample);
        expect(Math.abs(res.point - testCase.expected.point)).toBeLessThan(1e-6);
        expect(Math.abs(res.ciLow - testCase.expected.ci_low)).toBeLessThan(1e-6);
        expect(Math.abs(res.ciHigh - testCase.expected.ci_high)).toBeLessThan(1e-6);
        expect(Math.abs(res.d2 - testCase.expected.d2)).toBeLessThan(1e-6);
        expect(res.domainStatus).toBe(testCase.expected.domain_status);
      }
    }

    for (const edge of goldenVectors.edge_cases as GoldenCase[]) {
      const entry = registry.models[edge.model_id!];
      expect(entry).toBeDefined();
      const res = predictRawFromRegistryEntry(entry!, edge.sample);
      expect(Math.abs(res.point - edge.expected.point)).toBeLessThan(1e-6);
      expect(res.domainStatus).toBe(edge.expected.domain_status);
    }
  });

  it("evaluates z_product interactions with optional restandardization and float32 tree routing accurately", () => {
    const syntheticEntry: ModelEntry = {
      model_id: "test_interaction_linear",
      model_version: "1.0.0",
      dataset_id: "test",
      target_name: "SOC_pct",
      target_unit: "%",
      van_bemmelen_k: 1.724,
      selection_status: "selected_champion",
      selected_model_family: "standardized_linear_interaction",
      beats_ols_baseline: true,
      provenance: {
        source_title: "Synthetic Test",
        doi_or_slug: "test",
        is_synthetic_or_fixture: true,
      },
      preprocessing: {
        raw_features: ["temperature_c", "moisture_pct", "ec_ds_m"],
        interaction_terms: [
          {
            name: "z_T_x_z_M",
            op: "z_product",
            left: "temperature_c",
            right: "moisture_pct",
            restandardize: true,
            post_mean: 0.25,
            post_std: 0.5,
          },
          {
            name: "z_EC_x_z_M",
            op: "z_product",
            left: "ec_ds_m",
            right: "moisture_pct",
            restandardize: false,
          },
        ],
        model_feature_order: ["temperature_c", "moisture_pct", "ec_ds_m", "z_T_x_z_M", "z_EC_x_z_M"],
        feature_means: { temperature_c: 25.0, moisture_pct: 30.0, ec_ds_m: 1.0 },
        feature_stds: { temperature_c: 2.0, moisture_pct: 5.0, ec_ds_m: 0.5 },
        feature_mins: { temperature_c: 15.0, moisture_pct: 10.0, ec_ds_m: 0.1 },
        feature_maxs: { temperature_c: 35.0, moisture_pct: 70.0, ec_ds_m: 3.0 },
      },
      predictor: {
        type: "linear",
        input_space: "standardized",
        intercept: 1.2,
        coefficients: [0.1, 0.2, -0.05, 0.3, -0.1],
        clip_non_negative: true,
      },
      uncertainty: {
        method: "oof_conformal",
        alpha: 0.05,
        q_095: 0.25,
        empirical_coverage: 0.95,
        mean_interval_width: 0.5,
        clip_lower_at_zero: true,
        apply_van_bemmelen_to_interval: true,
      },
      ood: {
        feature_order: ["temperature_c", "moisture_pct", "ec_ds_m"],
        feature_mins: [15.0, 10.0, 0.1],
        feature_maxs: [35.0, 70.0, 3.0],
        mahalanobis_mean: [25.0, 30.0, 1.0],
        mahalanobis_inv_cov: [
          [0.25, 0, 0],
          [0, 0.04, 0],
          [0, 0, 4.0],
        ],
        regularization_eps: 1e-3,
        d2_caution_threshold: 8.0,
        d2_ood_threshold: 12.0,
        domain_status_labels: ["In-Range", "Caution", "Outside Calibration Range"],
      },
      explainability: {
        method: "standardized_coefficients",
        global_importance: [{ feature: "z_T_x_z_M", importance: 0.3, signed_effect: 0.3, rank: 1 }],
        stratified_errors: [],
      },
      metrics: {
        cv_strategy: "GroupKFold(5)",
        n_samples: 30,
        n_groups: 10,
        rmse: 0.1,
        mae: 0.08,
        r2: 0.85,
        baseline_ols_rmse: 0.12,
        baseline_ols_mae: 0.09,
        baseline_ols_r2: 0.8,
        model_comparison: [
          {
            model_name: "ols_interaction",
            rmse: 0.1,
            mae: 0.08,
            r2: 0.85,
            beats_ols_baseline: false,
            retained: true,
          },
        ],
      },
      artifact_sha256: "0".repeat(64),
    };

    // T=27 -> zT=1.0; M=40 -> zM=2.0; EC=1.5 -> zEC=1.0
    // z_T_x_z_M = ((1*2) - 0.25)/0.5 = 3.5; z_EC_x_z_M = 1*2 = 2.0
    // y_hat = 1.2 + 0.1*1 + 0.2*2 - 0.05*1 + 0.3*3.5 - 0.1*2 = 2.5
    const pred = predictRawFromRegistryEntry(syntheticEntry, {
      temperature_c: 27.0,
      moisture_pct: 40.0,
      ec_ds_m: 1.5,
    });
    expect(pred.point).toBeCloseTo(2.5, 12);
  });

  it("blocks out-of-domain inputs (acid soil pH=4.2 on Kushtia model) and finishes under 50 ms", async () => {
    const { registry } = await parseAndVerifyRegistryText(registryRawText);
    const champion = registry.models.srdi_kushtia_om_champion!;

    const { reading } = normalizeEsrcRecord({
      site_id: "sylhet-acid-plot",
      pH: 4.2,
      P: 4.0,
      K: 65.0,
      Moisture: 28.0,
      depth_cm: "0-20",
    });

    const res = runSomPrediction(champion, reading);
    expect(res.blocked).toBe(true);
    expect(res.blockReason).toBe("OUTSIDE_CALIBRATION_RANGE");
    expect(res.calibrationDomainStatus).toBe("Outside Calibration Range");
    expect(res.estimatedSomPct).toBeNull();
    expect(res.inferenceMs).toBeLessThan(50);

    // Healthy Kushtia plot with configurable Van Bemmelen k=2.0
    const healthy = normalizeEsrcRecord({
      site_id: "Katdaha Char",
      pH: 7.8,
      P: 22.5,
      K: 0.23,
      Moisture: 36.0,
      depth_cm: "0-20",
    }, { potassiumUnit: "cmol(+)/kg" });
    const healthyRes = runSomPrediction(champion, healthy.reading, { vanBemmelenK: 2.0 });
    expect(healthyRes.blocked).toBe(false);
    expect(healthyRes.calibrationDomainStatus).toBe("In-Range");
    expect(healthyRes.estimatedSomPct).toBeCloseTo(2.1767, 3);
    expect(healthyRes.estimatedSocPct).toBeCloseTo(2.1767 / 2.0, 3);
    expect(healthyRes.inferenceMs).toBeLessThan(50);
  });
});
