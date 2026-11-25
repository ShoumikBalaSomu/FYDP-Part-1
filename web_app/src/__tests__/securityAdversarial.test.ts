import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import indexHtml from "../../index.html?raw";
import registryRawText from "../../public/models/registry.json?raw";
import swSource from "../../public/sw.js?raw";
import { App } from "../App";
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_ROWS,
  normalizeEsrcRecord,
  parseEsrcCsv,
  parseEsrcJson,
  sanitizeSpreadsheetCell,
} from "../engine/esrcAdapter";
import { predictRawFromRegistryEntry, runSomPrediction } from "../engine/inferenceEngine";
import {
  loadLocalCalibratedModels,
  parseAndVerifyRegistryText,
} from "../engine/registryLoader";
import {
  exportReadingToJsonBundle,
  exportReadingToMarkdownBrief,
  exportReadingToSafeCsv,
} from "../engine/reportExporter";
import { kCmolToMgKg } from "../engine/soilPhysics";
import type { ModelRegistry } from "../engine/types";

const FORMULA_VECTORS = [
  "=CMD|'/C calc'!A0",
  "+1+1",
  "-2+3",
  "@SUM(1+1)*cmd",
  "\t=1+1",
  "\r=1+1",
  "\n=1+1",
  " =CMD|'/C calc'!A0",
] as const;

const XSS_VECTORS = [
  "<script>alert(1)</script>",
  "<svg onload=alert(1)>",
  "cumilla 2 <script>alert(1)</script>",
  'cumilla 2 "><svg onload=alert(1)>',
] as const;

describe("Adversarial Security, Fuzzing, DoS, and Fail-Closed Integrity", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("neutralizes all CSV formula injection prefixes across import, CSV, JSON, and Markdown exports", async () => {
    const { registry } = await parseAndVerifyRegistryText(registryRawText);
    const champion = registry.models.srdi_kushtia_om_champion!;

    for (const payload of FORMULA_VECTORS) {
      const sanitized = sanitizeSpreadsheetCell(payload);
      expect(sanitized.startsWith("'")).toBe(true);

      const csvCell = `"${payload.replace(/"/g, '""')}"`;
      const csvImport = [
        "site_id,device_id,aez_zone,depth_cm,texture_class,crop,lab_method,pH,P,K,Moisture",
        `${csvCell},${csvCell},${csvCell},${csvCell},${csvCell},${csvCell},${csvCell},7.8,22.5,89.93,36.0`,
      ].join("\n");

      const parsedCsv = parseEsrcCsv(csvImport);
      const rec = parsedCsv.records[0]!;
      expect(rec.reading.site_id?.startsWith("'")).toBe(true);
      expect(rec.reading.device_id?.startsWith("'")).toBe(true);
      expect(rec.reading.crop?.startsWith("'")).toBe(true);
      expect(rec.reading.aez_zone?.startsWith("'")).toBe(true);
      expect(rec.reading.texture_class?.startsWith("'")).toBe(true);
      expect(rec.labMethod?.startsWith("'")).toBe(true);

      const { reading } = normalizeEsrcRecord({
        site_id: payload,
        device_id: payload,
        aez_zone: payload,
        depth_cm: "0-20",
        texture_class: payload,
        crop: payload,
        pH: 7.8,
        P: 22.5,
        K: 89.93,
        Moisture: 36.0,
      });
      const pred = runSomPrediction(champion, reading);

      // CSV export neutralization (including notes with leading space / newline formula)
      const safeCsv = exportReadingToSafeCsv(reading, pred, champion, payload);
      const csvRows = safeCsv.trimEnd().split("\n");
      expect(csvRows.length).toBeGreaterThanOrEqual(2);
      expect(safeCsv).not.toContain(`,${payload}`);
      expect(safeCsv).toContain(`'${payload.replace(/"/g, '""')}`);

      // JSON export must not expose unsanitized raw_site_id / raw_device_id / aez_zone / texture_class
      const bundle = JSON.parse(exportReadingToJsonBundle(reading, pred, champion)) as {
        input_telemetry: Record<string, unknown>;
      };
      for (const field of ["site_id", "device_id", "raw_site_id", "raw_device_id", "aez_zone", "texture_class", "crop"]) {
        const val = bundle.input_telemetry[field];
        if (typeof val === "string" && val.length > 0) {
          expect(val.startsWith("'")).toBe(true);
        }
      }

      // Markdown export must neutralize raw leading formula prefixes as well
      const md = exportReadingToMarkdownBrief(reading, pred, champion);
      expect(md).not.toMatch(new RegExp(`—\\s*${payload.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    }
  });

  it("blocks XSS payloads in Markdown exports and renders XSS safely in React DOM", async () => {
    const { registry } = await parseAndVerifyRegistryText(registryRawText);
    const champion = registry.models.srdi_kushtia_om_champion!;

    for (const xss of XSS_VECTORS) {
      const { reading } = normalizeEsrcRecord({
        site_id: xss,
        device_id: xss,
        aez_zone: xss,
        pH: 0.12,
        P: 22.5,
        K: 89.93,
        Moisture: 100.0,
        depth_cm: "0-20",
      });
      const pred = runSomPrediction(champion, reading);
      const md = exportReadingToMarkdownBrief(reading, pred, champion);
      expect(md.toLowerCase()).not.toContain("<script>");
      expect(md.toLowerCase()).not.toContain("<svg");
      expect(md).not.toMatch(/<\s*(script|svg|img|iframe)\b/i);
    }

    // Verify React DOM never injects <script> or <svg onload=...> from Raw Telemetry JSON Import
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => registryRawText,
      }))
    );

    const { container } = render(createElement(App));
    await waitFor(() => screen.getByText("Raw Telemetry JSON Import and Sanitizer"));
    fireEvent.click(
      screen.getByRole("button", { name: /Raw Telemetry JSON Import and Sanitizer/i })
    );

    const textarea = screen.getByLabelText("Raw Sensor JSON Payload");
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          site: "cumilla 2 <script>alert(1)</script><svg onload=alert(1)>",
          Device: "<svg onload=alert(1)>",
          PH: 0.12,
          Humidity: 100,
          EC: 1.48,
        }),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Parse and Validate JSON" }));

    expect(container.querySelectorAll("script")).toHaveLength(0);
    expect(container.querySelectorAll("svg[onload]")).toHaveLength(0);
  });

  it("strips or rejects prototype pollution in JSON, CSV headers, registry AST, and localStorage", async () => {
    const protoPayloads = [
      '{"__proto__": {"polluted": true}, "PH": 6.5}',
      '{"constructor": {"prototype": {"x": 1}}, "PH": 6.5}',
      '{"nested": {"__proto__": {"polluted": true}}, "PH": 6.5}',
    ];

    for (const payload of protoPayloads) {
      const parsed = parseEsrcJson(payload);
      expect(parsed).toHaveLength(1);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(({} as Record<string, unknown>).x).toBeUndefined();
      expect(parsed[0]!.strippedKeys.length).toBeGreaterThan(0);
    }

    for (const badHeader of ["__proto__", "constructor", "prototype", "\ufeff__proto__"]) {
      const csv = `site_id,${badHeader},PH,Moisture\ncumilla 2,1,6.5,35\n`;
      expect(() => parseEsrcCsv(csv)).toThrow(/prototype-pollution|forbidden/i);
    }

    // Registry AST must reject __proto__ / constructor / prototype
    const protoRegistry = registryRawText.replace(
      '"platform": "SOMSense-ESRC"',
      '"platform": "SOMSense-ESRC", "__proto__": {"polluted": true}'
    );
    await expect(parseAndVerifyRegistryText(protoRegistry)).rejects.toThrow(/forbidden key/i);

    // Poisoned localStorage must not pollute prototypes or override built-in verified models
    const regObj = JSON.parse(registryRawText) as ModelRegistry;
    const tamperedChamp = { ...regObj.models.srdi_kushtia_om_champion!, artifact_sha256: "0".repeat(64) };
    localStorage.setItem(
      "somsense_local_aez_models_v1",
      JSON.stringify({
        __proto__: { polluted: true },
        srdi_kushtia_om_champion: tamperedChamp,
      })
    );
    const localModels = loadLocalCalibratedModels();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(localModels.srdi_kushtia_om_champion).toBeUndefined();
  });

  it("enforces DoS size, row count, nesting depth (>32), tree cycle guard, and ReDoS bounds", async () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_UPLOAD_ROWS).toBe(10_000);

    // >10 MB JSON & CSV
    const bigJson = `{"site_id":"${"A".repeat(MAX_UPLOAD_BYTES + 128)}","PH":6.5}`;
    expect(() => parseEsrcJson(bigJson)).toThrow(/max allowed size/i);

    const bigCsv = `site_id,PH\n${"A".repeat(MAX_UPLOAD_BYTES + 128)},6.5\n`;
    expect(() => parseEsrcCsv(bigCsv)).toThrow(/max allowed size/i);

    // >10,000 rows JSON & CSV
    const tooManyJson = JSON.stringify(Array.from({ length: MAX_UPLOAD_ROWS + 1 }, () => ({ PH: 6.5 })));
    expect(() => parseEsrcJson(tooManyJson)).toThrow(/row limit/i);

    const tooManyCsv = "site_id,PH\n" + "s1,6.5\n".repeat(MAX_UPLOAD_ROWS + 1);
    expect(() => parseEsrcCsv(tooManyCsv)).toThrow(/row count/i);

    // Deeply nested JSON > 32 levels (depth 40 and depth 12000 must fail closed cleanly, never stack overflow)
    const depth40 = `${'{"a":'.repeat(40)}{"PH":6.5}${"}".repeat(40)}`;
    expect(() => parseEsrcJson(depth40)).toThrow(/depth|nested/i);
    await expect(parseAndVerifyRegistryText(depth40)).rejects.toThrow(/depth|nested/i);

    const depth12000 = `${"[".repeat(12000)}${"]".repeat(12000)}`;
    await expect(parseAndVerifyRegistryText(depth12000)).rejects.toThrow(/depth|nested/i);

    // Cyclic tree node in unverified tree_ensemble must not hang infinitely
    const { registry } = await parseAndVerifyRegistryText(registryRawText);
    const cyclicEntry = structuredClone(registry.models.srdi_kushtia_om_champion!);
    if (cyclicEntry.predictor.type === "tree_ensemble") {
      cyclicEntry.predictor.trees[0]!.children_left[0] = 0;
      cyclicEntry.predictor.trees[0]!.children_right[0] = 0;
    }
    expect(() =>
      predictRawFromRegistryEntry(cyclicEntry, {
        ph: 7.8,
        phosphorus_mg_kg: 22.5,
        potassium_mg_kg: 89.93,
        moisture_pct: 36.0,
        depth_mid_cm: 10.0,
      })
    ).toThrow(/cycle|depth|invalid tree/i);

    // ReDoS pathological strings must execute in < 200 ms
    const t0 = performance.now();
    expect(() =>
      normalizeEsrcRecord({ PH: 6.5, timestamp: `2026-09-29T${"A".repeat(100_000)}` })
    ).toThrow(/timestamp/i);
    normalizeEsrcRecord({
      PH: 6.5,
      depth_cm: `0-${"1".repeat(50_000)}`,
      aez_zone: "_".repeat(50_000),
      site_id: "cumilla 2 ".repeat(5_000),
    });
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("rejects NaN, Infinity, -Infinity, and blocks 1e308 numerical poison", async () => {
    for (const token of ["NaN", "Infinity", "-Infinity", '"NaN"', '"Infinity"', '"-Infinity"', "1e309"]) {
      expect(() => parseEsrcJson(`{"PH": ${token}}`)).toThrow(/non-finite|invalid/i);
    }

    // kCmolToMgKg(1e308) overflows to Infinity -> must throw finite error
    expect(() => kCmolToMgKg(1e308)).toThrow(/finite|overflow/i);
    expect(() =>
      normalizeEsrcRecord({ PH: 6.5, Moisture: 35.0, k_cmol_kg: 1e308 })
    ).toThrow(/finite|overflow/i);

    // 1e308 in N or K must never pass as In-Range or produce Infinity D^2
    const { registry } = await parseAndVerifyRegistryText(registryRawText);
    const champion = registry.models.srdi_kushtia_om_champion!;
    const { reading: poisoned } = normalizeEsrcRecord({
      site_id: "poisoned",
      PH: 7.8,
      P: 22.5,
      K: 89.93,
      Moisture: 36.0,
      depth_cm: "0-20",
      N: 1e308,
    });
    const res = runSomPrediction(champion, poisoned);
    expect(res.blocked).toBe(true);
    expect(Number.isFinite(res.oodAssessment.mahalanobisD2)).toBe(true);
  });

  it("rejects tampered registry weight or SHA-256 hash and fails closed in UI", async () => {
    const obj = JSON.parse(registryRawText) as ModelRegistry;

    // Mutate 1 weight in OLS model
    const mutatedWeight = structuredClone(obj);
    if (mutatedWeight.models.srdi_kushtia_om_baseline_ols!.predictor.type === "linear") {
      mutatedWeight.models.srdi_kushtia_om_baseline_ols!.predictor.intercept += 0.0001;
    }
    await expect(parseAndVerifyRegistryText(JSON.stringify(mutatedWeight))).rejects.toThrow(
      /SHA-256 mismatch/i
    );

    // Mutate 1 character of canonical_payload_sha256
    const mutatedHash = structuredClone(obj);
    const orig = mutatedHash.integrity.canonical_payload_sha256;
    mutatedHash.integrity.canonical_payload_sha256 = (orig[0] === "0" ? "1" : "0") + orig.slice(1);
    await expect(parseAndVerifyRegistryText(JSON.stringify(mutatedHash))).rejects.toThrow(
      /SHA-256 mismatch/i
    );

    // UI fails closed when fetch delivers tampered registry
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(mutatedWeight),
      }))
    );
    render(createElement(App));
    await waitFor(() => {
      expect(screen.getByText(/Integrity Check Failed/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/SHA-256 verification failed/i)).toBeInTheDocument();
  });

  it("enforces strict CSP, offline service worker same-origin guard, and 1-click Local Storage wipe", async () => {
    expect(indexHtml).toContain("Content-Security-Policy");
    expect(indexHtml).toContain("default-src 'self'");
    expect(indexHtml).toContain("script-src 'self'");
    expect(indexHtml).toContain("font-src 'self'");
    expect(indexHtml).toContain("connect-src 'self'");
    expect(indexHtml).toContain("object-src 'none'");
    expect(indexHtml).toContain("base-uri 'self'");
    expect(indexHtml).not.toContain("unsafe-eval");
    expect(indexHtml).not.toMatch(/https?:\/\/fonts\.googleapis|https?:\/\/cdn\./i);

    expect(swSource).toContain("url.origin !== self.location.origin");

    // 1-click Local Storage wipe in App
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => registryRawText,
      }))
    );
    localStorage.setItem("somsense_probe_key", "sensitive-soil-reading");
    render(createElement(App));
    await waitFor(() => expect(screen.getByText("Offline Engine Ready")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Clear Local Storage" }));
    expect(localStorage.length).toBe(0);
  });
});
