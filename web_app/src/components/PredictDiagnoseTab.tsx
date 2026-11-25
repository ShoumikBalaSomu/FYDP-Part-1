import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Compass,
  Download,
  FileJson,
  FileText,
  OctagonAlert,
  Printer,
  RotateCcw,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  BARC_SRDI_FERTILITY_SCALE,
  FEATURE_DISPLAY_LABELS,
  MODEL_DISPLAY_LABELS,
  PRESET_SCENARIOS,
  UI_COPY,
  type PresetScenario,
} from "../copy/uiCopy";
import { normalizeEsrcRecord, parseEsrcCsv, parseEsrcJson } from "../engine/esrcAdapter";
import { runSomPrediction } from "../engine/inferenceEngine";
import {
  exportReadingToJsonBundle,
  exportReadingToMarkdownBrief,
  exportReadingToSafeCsv,
} from "../engine/reportExporter";
import { DEFAULT_VAN_BEMMELEN_K } from "../engine/soilPhysics";
import type {
  ECUnit,
  HardwarePhysicsGuardrails,
  KUnit,
  ModelEntry,
  ThemeMode,
} from "../engine/types";
import { triggerBrowserDownload } from "../utils/download";

interface FormState {
  siteId: string;
  deviceId: string;
  aezZone: string;
  timestamp: string;
  depthCm: string;
  textureClass: string;
  nitrogen: string;
  phosphorus: string;
  potassium: string;
  potassiumUnit: KUnit;
  ph: string;
  ec: string;
  ecUnit: ECUnit;
  salinity: string;
  temperature: string;
  moisture: string;
  daysSinceRain: string;
  daysSinceFertilizer: string;
  previousSomPct: string;
  vanBemmelenK: string;
}

const INITIAL_EMPTY_FORM: FormState = {
  siteId: "",
  deviceId: "ESRC Device - 1",
  aezZone: "AEZ-19",
  timestamp: "",
  depthCm: "0-20",
  textureClass: "Clay",
  nitrogen: "",
  phosphorus: "",
  potassium: "",
  potassiumUnit: "mg/kg",
  ph: "",
  ec: "",
  ecUnit: "dS/m",
  salinity: "",
  temperature: "",
  moisture: "",
  daysSinceRain: "",
  daysSinceFertilizer: "",
  previousSomPct: "",
  vanBemmelenK: String(DEFAULT_VAN_BEMMELEN_K),
};

interface PredictDiagnoseTabProps {
  models: Record<string, ModelEntry>;
  activeModelId: string;
  onSelectModelId: (modelId: string) => void;
  guardrails?: Partial<HardwarePhysicsGuardrails>;
  theme: ThemeMode;
  onAnnounce: (msg: string) => void;
  onRecordInferenceMs: (ms: number) => void;
}

function parseOptionalInputFloat(raw: string): { valid: boolean; value: number | null; error?: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { valid: true, value: null };
  const lowered = trimmed.toLowerCase();
  if (lowered === "nan" || lowered === "infinity" || lowered === "-infinity") {
    return { valid: false, value: null, error: "Value must be finite (NaN/Infinity blocked)." };
  }
  const num = Number(trimmed);
  if (!Number.isFinite(num)) {
    return { valid: false, value: null, error: "Enter a valid finite number." };
  }
  return { valid: true, value: num };
}

export function PredictDiagnoseTab({
  models,
  activeModelId,
  onSelectModelId,
  guardrails,
  theme,
  onAnnounce,
  onRecordInferenceMs,
}: PredictDiagnoseTabProps) {
  const formIdPrefix = useId();
  const [form, setForm] = useState<FormState>(() => {
    const healthy = PRESET_SCENARIOS[1]!;
    return {
      siteId: healthy.payload.site_id,
      deviceId: healthy.payload.device_id,
      aezZone: healthy.payload.aez_zone,
      timestamp: healthy.payload.timestamp,
      depthCm: healthy.payload.depth_cm,
      textureClass: healthy.payload.texture_class,
      nitrogen: String(healthy.payload.nitrogen_mg_kg),
      phosphorus: String(healthy.payload.phosphorus_mg_kg),
      potassium: String(healthy.payload.potassium_mg_kg),
      potassiumUnit: "mg/kg",
      ph: String(healthy.payload.ph),
      ec: String(healthy.payload.ec_value),
      ecUnit: healthy.payload.ec_unit,
      salinity: String(healthy.payload.salinity_mg_l),
      temperature: String(healthy.payload.temperature_c),
      moisture: String(healthy.payload.moisture_pct),
      daysSinceRain: "6",
      daysSinceFertilizer: "18",
      previousSomPct: "",
      vanBemmelenK: String(DEFAULT_VAN_BEMMELEN_K),
    };
  });

  const [openAccordion, setOpenAccordion] = useState<{
    equations: boolean;
    drivers: boolean;
    rawImport: boolean;
  }>({
    equations: false,
    drivers: false,
    rawImport: false,
  });

  const [rawJsonInput, setRawJsonInput] = useState("");
  const [rawImportEcUnit, setRawImportEcUnit] = useState<ECUnit>("unknown");
  const [rawImportMessage, setRawImportMessage] = useState<{
    kind: "ok" | "warn" | "error";
    text: string;
  } | null>(null);

  const somModels = useMemo(
    () => Object.values(models).filter((m) => m.target_name !== "POXC_mg_kg"),
    [models]
  );

  const activeModel = models[activeModelId] ?? somModels[0];

  const hasAnyNumericInput =
    form.nitrogen.trim() !== "" ||
    form.phosphorus.trim() !== "" ||
    form.potassium.trim() !== "" ||
    form.ph.trim() !== "" ||
    form.ec.trim() !== "" ||
    form.temperature.trim() !== "" ||
    form.moisture.trim() !== "";

  const fieldErrors = useMemo(() => {
    const errs: Record<string, string> = {};
    const checkNum = (key: string, val: string, min?: number, max?: number) => {
      const parsed = parseOptionalInputFloat(val);
      if (!parsed.valid) {
        errs[key] = parsed.error ?? "Invalid number";
        return;
      }
      if (parsed.value !== null) {
        if (min !== undefined && parsed.value < min) {
          errs[key] = `Reading (${parsed.value}) sits below physical floor ${min}.`;
        } else if (max !== undefined && parsed.value > max) {
          errs[key] = `Reading (${parsed.value}) exceeds physical ceiling ${max}.`;
        }
      }
    };
    checkNum("nitrogen", form.nitrogen, 0);
    checkNum("phosphorus", form.phosphorus, 0);
    checkNum("potassium", form.potassium, 0);
    checkNum("ph", form.ph, 3.0, 10.0);
    checkNum("ec", form.ec, 0);
    checkNum("salinity", form.salinity, 0);
    checkNum("temperature", form.temperature, -10.0, 60.0);
    checkNum("moisture", form.moisture, 0, 100.0);
    checkNum("vanBemmelenK", form.vanBemmelenK, 1.0, 3.0);
    return errs;
  }, [form]);

  const evaluation = useMemo(() => {
    if (!activeModel || !hasAnyNumericInput) return null;
    try {
      const nVal = parseOptionalInputFloat(form.nitrogen);
      const pVal = parseOptionalInputFloat(form.phosphorus);
      const kVal = parseOptionalInputFloat(form.potassium);
      const phVal = parseOptionalInputFloat(form.ph);
      const ecVal = parseOptionalInputFloat(form.ec);
      const salVal = parseOptionalInputFloat(form.salinity);
      const tVal = parseOptionalInputFloat(form.temperature);
      const mVal = parseOptionalInputFloat(form.moisture);
      const rainVal = parseOptionalInputFloat(form.daysSinceRain);
      const fertVal = parseOptionalInputFloat(form.daysSinceFertilizer);
      const prevSom = parseOptionalInputFloat(form.previousSomPct);
      const kFactor = parseOptionalInputFloat(form.vanBemmelenK);

      if (
        !nVal.valid ||
        !pVal.valid ||
        !kVal.valid ||
        !phVal.valid ||
        !ecVal.valid ||
        !salVal.valid ||
        !tVal.valid ||
        !mVal.valid
      ) {
        return { error: "Fix non-finite numeric input values before running calibration." } as const;
      }

      const rawTs = form.timestamp.trim() || new Date().toISOString();
      const { reading } = normalizeEsrcRecord(
        {
          site_id: form.siteId || null,
          device_id: form.deviceId || null,
          aez_zone: form.aezZone || null,
          timestamp: rawTs,
          depth_cm: form.depthCm || null,
          texture_class: form.textureClass || null,
          N: nVal.value,
          P: pVal.value,
          K: kVal.value,
          EC: ecVal.value,
          Salinity: salVal.value,
          pH: phVal.value,
          Temp_C: tVal.value,
          Moisture_pct: mVal.value,
          days_since_rain: rainVal.value,
          days_since_fertilizer: fertVal.value,
        },
        {
          ecUnit: form.ecUnit,
          potassiumUnit: form.potassiumUnit,
        }
      );

      const prevObs =
        prevSom.valid && prevSom.value !== null
          ? {
              timestampIso: new Date(Date.parse(rawTs) - 6 * 3_600_000).toISOString(),
              somPct: prevSom.value,
            }
          : null;

      const resolvedK =
        kFactor.valid && kFactor.value !== null && kFactor.value >= 1.0 && kFactor.value <= 3.0
          ? kFactor.value
          : DEFAULT_VAN_BEMMELEN_K;

      const result = runSomPrediction(activeModel, reading, {
        vanBemmelenK: resolvedK,
        guardrails,
        previousObservation: prevObs,
      });

      return { reading, result } as const;
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "Unable to evaluate reading.",
      } as const;
    }
  }, [activeModel, form, guardrails, hasAnyNumericInput]);

  const loadPreset = (preset: PresetScenario): void => {
    const p = preset.payload;
    setForm({
      siteId: p.site_id,
      deviceId: p.device_id,
      aezZone: p.aez_zone,
      timestamp: p.timestamp,
      depthCm: p.depth_cm,
      textureClass: p.texture_class,
      nitrogen: String(p.nitrogen_mg_kg),
      phosphorus: String(p.phosphorus_mg_kg),
      potassium: String(p.potassium_mg_kg),
      potassiumUnit: "mg/kg",
      ph: String(p.ph),
      ec: String(p.ec_value),
      ecUnit: p.ec_unit,
      salinity: String(p.salinity_mg_l),
      temperature: String(p.temperature_c),
      moisture: String(p.moisture_pct),
      daysSinceRain: preset.id === "wet_paddy_caution" ? "1" : "5",
      daysSinceFertilizer: preset.id === "wet_paddy_caution" ? "2" : "14",
      previousSomPct: "",
      vanBemmelenK: String(DEFAULT_VAN_BEMMELEN_K),
    });
    onAnnounce(`Loaded scenario ${preset.button_label}.`);
  };

  const handleRunExplicitCheck = (): void => {
    if (evaluation && "result" in evaluation && evaluation.result) {
      const res = evaluation.result;
      onRecordInferenceMs(res.inferenceMs);
      if (res.blocked) {
        onAnnounce(
          `Blocked estimation due to ${res.blockReason ?? "physics or domain limit"}.`
        );
      } else {
        onAnnounce(
          `Estimated SOM updated to ${res.estimatedSomPct?.toFixed(
            2
          )} percent with 95 percent interval ${res.somCi95Lower?.toFixed(
            2
          )} to ${res.somCi95Upper?.toFixed(2)}. Domain status is ${
            res.calibrationDomainStatus
          }.`
        );
      }
    }
  };

  const handleClear = (): void => {
    setForm(INITIAL_EMPTY_FORM);
    setRawImportMessage(null);
    onAnnounce("Cleared sensor inputs.");
  };

  const handleParseRawTelemetry = (): void => {
    const text = rawJsonInput.trim();
    if (!text) {
      setRawImportMessage({ kind: "error", text: "Paste JSON or CSV telemetry first." });
      return;
    }
    try {
      if (text.startsWith("{") || text.startsWith("[")) {
        const records = parseEsrcJson(text, { ecUnit: rawImportEcUnit });
        const first = records[0]!;
        const r = first.reading;
        setForm((prev) => ({
          ...prev,
          siteId: r.raw_site_id ?? prev.siteId,
          deviceId: r.raw_device_id ?? prev.deviceId,
          aezZone: r.aez_zone ?? prev.aezZone,
          timestamp: r.timestamp ?? prev.timestamp,
          depthCm: r.depth_cm ?? prev.depthCm,
          textureClass: r.texture_class ?? prev.textureClass,
          nitrogen: r.nitrogen_mg_kg !== null ? String(r.nitrogen_mg_kg) : "",
          phosphorus: r.phosphorus_mg_kg !== null ? String(r.phosphorus_mg_kg) : "",
          potassium: r.potassium_mg_kg !== null ? String(r.potassium_mg_kg) : "",
          potassiumUnit: "mg/kg",
          ph: r.ph !== null ? String(r.ph) : "",
          ec: r.ec_raw !== null ? String(r.ec_raw) : "",
          ecUnit: r.ec_unit,
          salinity: r.salinity_mg_l !== null ? String(r.salinity_mg_l) : "",
          temperature: r.temperature_c !== null ? String(r.temperature_c) : "",
          moisture: r.moisture_pct !== null ? String(r.moisture_pct) : "",
        }));
        const strippedNote =
          first.strippedKeys.length > 0
            ? ` Stripped forbidden key(s): ${first.strippedKeys.join(", ")}.`
            : "";
        const batchNote =
          records.length > 1
            ? ` Batch contained ${records.length} rows (loaded row 1 into live diagnostics).`
            : "";
        setRawImportMessage({
          kind: first.strippedKeys.length > 0 || !first.report.passed_hard_gates ? "warn" : "ok",
          text: `Normalized ${records.length} ESRC JSON record(s).${strippedNote}${batchNote}`,
        });
      } else {
        const csvBatch = parseEsrcCsv(text, { ecUnit: rawImportEcUnit });
        const first = csvBatch.records[0];
        if (!first) throw new Error("CSV contains zero data rows.");
        const r = first.reading;
        setForm((prev) => ({
          ...prev,
          siteId: r.raw_site_id ?? prev.siteId,
          deviceId: r.raw_device_id ?? prev.deviceId,
          depthCm: r.depth_cm ?? prev.depthCm,
          nitrogen: r.nitrogen_mg_kg !== null ? String(r.nitrogen_mg_kg) : "",
          phosphorus: r.phosphorus_mg_kg !== null ? String(r.phosphorus_mg_kg) : "",
          potassium: r.potassium_mg_kg !== null ? String(r.potassium_mg_kg) : "",
          potassiumUnit: "mg/kg",
          ph: r.ph !== null ? String(r.ph) : "",
          ec: r.ec_raw !== null ? String(r.ec_raw) : "",
          ecUnit: r.ec_unit,
          salinity: r.salinity_mg_l !== null ? String(r.salinity_mg_l) : "",
          temperature: r.temperature_c !== null ? String(r.temperature_c) : "",
          moisture: r.moisture_pct !== null ? String(r.moisture_pct) : "",
        }));
        const criticalCount = csvBatch.records.filter((x) => !x.report.passed_hard_gates).length;
        const warnCount = csvBatch.records.filter(
          (x) => x.report.passed_hard_gates && x.report.has_warnings
        ).length;
        setRawImportMessage({
          kind: criticalCount > 0 ? "warn" : "ok",
          text: `Parsed ${csvBatch.records.length} CSV rows (${csvBatch.records.length - criticalCount - warnCount} clean, ${warnCount} warnings, ${criticalCount} critical faults). Loaded row 1.`,
        });
      }
    } catch (err) {
      setRawImportMessage({
        kind: "error",
        text: err instanceof Error ? err.message : UI_COPY.error_states.json_malformed,
      });
    }
  };

  const handleTelemetryFileUpload = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setRawImportMessage({
        kind: "error",
        text: "File exceeds 10 MB upload limit.",
      });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setRawJsonInput(reader.result);
      }
    };
    reader.readAsText(file);
  };

  const pred = evaluation && "result" in evaluation ? evaluation.result : null;
  const reading = evaluation && "reading" in evaluation ? evaluation.reading : null;
  const evalError = evaluation && "error" in evaluation ? evaluation.error : null;

  const barcTier = useMemo(() => {
    if (!pred || pred.blocked || pred.fertilityClassBarc === null) return null;
    return BARC_SRDI_FERTILITY_SCALE.find((t) => t.label === pred.fertilityClassBarc) ?? null;
  }, [pred]);

  // Gauge visual math over 0..6% SOM span
  const gaugeMaxSom = 6.0;
  const toGaugePct = (val: number): number => Math.min(100, Math.max(0, (val / gaugeMaxSom) * 100));

  const driverChartData = useMemo(() => {
    if (!pred || pred.blocked) return [];
    return pred.featureDrivers.map((d) => ({
      name: d.label,
      contribution: Number(d.contribution.toFixed(4)),
    }));
  }, [pred]);

  const inputBaseClass =
    "min-h-[48px] w-full rounded-md border bg-surface px-3 py-2 font-mono text-[1rem] text-ink-primary tabular-nums placeholder:text-ink-muted focus:border-brand";

  return (
    <div id="panel-predict_diagnose" role="tabpanel" aria-labelledby="tab-predict_diagnose" className="space-y-6">
      {/* Quick Field Scenarios Bar */}
      <section aria-labelledby="presets-heading" className="no-print rounded-lg border border-line-subtle bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h2 id="presets-heading" className="text-[1.125rem] font-semibold text-ink-primary">
            {UI_COPY.tab_predict_diagnose.section_presets_heading}
          </h2>
          <span className="text-[0.8125rem] text-ink-muted">
            One-tap field logs and boundary stress checks
          </span>
        </div>
        <div className="flex flex-wrap items-stretch gap-3">
          {PRESET_SCENARIOS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => loadPreset(preset)}
              title={preset.description}
              className="somsense-transition flex min-h-[44px] flex-col items-start justify-center rounded-md border border-line-subtle bg-sunken px-3.5 py-2 text-left hover:border-brand hover:bg-brand-soft"
            >
              <span className="text-[0.875rem] font-semibold text-ink-primary">
                {preset.button_label}
              </span>
              <span className="text-[0.75rem] font-medium text-ink-muted">{preset.badge}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left Column: Inputs */}
        <section
          aria-labelledby="inputs-heading"
          className="no-print min-w-0 rounded-lg border border-line-subtle bg-surface p-4 sm:p-5 lg:col-span-5"
        >
          <h2 id="inputs-heading" className="text-[1.125rem] font-semibold text-ink-primary mb-4">
            {UI_COPY.tab_predict_diagnose.section_inputs_heading}
          </h2>

          {/* Active Model Selector */}
          <div className="mb-4">
            <label
              htmlFor={`${formIdPrefix}-model-select`}
              className="block text-[0.8125rem] font-medium text-ink-secondary mb-1.5"
            >
              Active Calibration Model
            </label>
            <select
              id={`${formIdPrefix}-model-select`}
              value={activeModel?.model_id ?? ""}
              onChange={(e) => onSelectModelId(e.target.value)}
              className="min-h-[48px] w-full rounded-md border border-line-input bg-surface px-3 py-2 text-[0.9375rem] font-medium text-ink-primary"
            >
              {somModels.map((m) => (
                <option key={m.model_id} value={m.model_id}>
                  {MODEL_DISPLAY_LABELS[m.model_id] ?? `${m.provenance.source_title} (${m.model_id})`}
                </option>
              ))}
            </select>
            {activeModel && (
              <p className="mt-1 text-[0.75rem] text-ink-muted">
                Requires: {activeModel.preprocessing.raw_features.join(", ")} | CV{" "}
                {activeModel.metrics.cv_strategy} (R2={activeModel.metrics.r2.toFixed(3)})
              </p>
            )}
          </div>

          {/* Site / Device / Horizon */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 mb-4">
            <div>
              <label
                htmlFor={`${formIdPrefix}-site`}
                className="block text-[0.8125rem] font-medium text-ink-secondary mb-1"
              >
                Site Label
              </label>
              <input
                id={`${formIdPrefix}-site`}
                type="text"
                value={form.siteId}
                placeholder="cumilla 2"
                onChange={(e) => setForm({ ...form, siteId: e.target.value })}
                className="min-h-[48px] w-full rounded-md border border-line-input bg-surface px-3 py-2 text-[0.9375rem] text-ink-primary"
              />
            </div>
            <div>
              <label
                htmlFor={`${formIdPrefix}-device`}
                className="block text-[0.8125rem] font-medium text-ink-secondary mb-1"
              >
                Sensor Unit
              </label>
              <input
                id={`${formIdPrefix}-device`}
                type="text"
                value={form.deviceId}
                placeholder="ESRC Device - 1"
                onChange={(e) => setForm({ ...form, deviceId: e.target.value })}
                className="min-h-[48px] w-full rounded-md border border-line-input bg-surface px-3 py-2 text-[0.9375rem] text-ink-primary"
              />
            </div>
            <div>
              <label
                htmlFor={`${formIdPrefix}-depth`}
                className="block text-[0.8125rem] font-medium text-ink-secondary mb-1"
              >
                Sampling Depth (cm)
              </label>
              <select
                id={`${formIdPrefix}-depth`}
                value={form.depthCm}
                onChange={(e) => setForm({ ...form, depthCm: e.target.value })}
                className="min-h-[48px] w-full rounded-md border border-line-input bg-surface px-3 py-2 text-[0.9375rem] text-ink-primary"
              >
                <option value="0-15">0-15 cm (midpoint 7.5 cm)</option>
                <option value="0-20">0-20 cm (midpoint 10 cm)</option>
                <option value="20-40">20-40 cm (midpoint 30 cm)</option>
                <option value="40-60">40-60 cm (midpoint 50 cm)</option>
              </select>
            </div>
            <div>
              <label
                htmlFor={`${formIdPrefix}-texture`}
                className="block text-[0.8125rem] font-medium text-ink-secondary mb-1"
              >
                Soil Texture
              </label>
              <select
                id={`${formIdPrefix}-texture`}
                value={form.textureClass}
                onChange={(e) => setForm({ ...form, textureClass: e.target.value })}
                className="min-h-[48px] w-full rounded-md border border-line-input bg-surface px-3 py-2 text-[0.9375rem] text-ink-primary"
              >
                <option value="Loam">Loam</option>
                <option value="Clay Loam">Clay Loam</option>
                <option value="Silty Clay">Silty Clay</option>
                <option value="Clay">Clay</option>
                <option value="Sandy Loam">Sandy Loam</option>
                <option value="Unknown">Unknown</option>
              </select>
            </div>
          </div>

          {/* Numeric Probe Fields (12px vertical gap, 48px touch inputs) */}
          <div className="space-y-3">
            {/* Soil pH */}
            <div>
              <label
                htmlFor={`${formIdPrefix}-ph`}
                className="block text-[0.8125rem] font-medium text-ink-secondary mb-1"
              >
                Soil pH (pH units)
              </label>
              <input
                id={`${formIdPrefix}-ph`}
                inputMode="decimal"
                value={form.ph}
                placeholder="6.5"
                aria-invalid={Boolean(fieldErrors.ph)}
                aria-describedby={fieldErrors.ph ? `${formIdPrefix}-ph-err` : `${formIdPrefix}-ph-help`}
                onChange={(e) => setForm({ ...form, ph: e.target.value })}
                className={`${inputBaseClass} ${
                  fieldErrors.ph ? "border-fault-border" : "border-line-input"
                }`}
              />
              {fieldErrors.ph ? (
                <p id={`${formIdPrefix}-ph-err`} role="alert" className="mt-1 text-[0.75rem] font-medium text-fault-text">
                  {fieldErrors.ph}
                </p>
              ) : (
                <p id={`${formIdPrefix}-ph-help`} className="mt-1 text-[0.75rem] text-ink-muted">
                  Valid soil probe range spans pH 3.0 to 10.0.
                </p>
              )}
            </div>

            {/* N and P */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor={`${formIdPrefix}-n`}
                  className="block text-[0.8125rem] font-medium text-ink-secondary mb-1"
                >
                  Available Nitrogen N (mg/kg)
                </label>
                <input
                  id={`${formIdPrefix}-n`}
                  inputMode="decimal"
                  value={form.nitrogen}
                  placeholder="185"
                  aria-invalid={Boolean(fieldErrors.nitrogen)}
                  aria-describedby={fieldErrors.nitrogen ? `${formIdPrefix}-n-err` : undefined}
                  onChange={(e) => setForm({ ...form, nitrogen: e.target.value })}
                  className={`${inputBaseClass} ${
                    fieldErrors.nitrogen ? "border-fault-border" : "border-line-input"
                  }`}
                />
                {fieldErrors.nitrogen && (
                  <p id={`${formIdPrefix}-n-err`} role="alert" className="mt-1 text-[0.75rem] font-medium text-fault-text">
                    {fieldErrors.nitrogen}
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor={`${formIdPrefix}-p`}
                  className="block text-[0.8125rem] font-medium text-ink-secondary mb-1"
                >
                  Phosphorus P (mg/kg)
                </label>
                <input
                  id={`${formIdPrefix}-p`}
                  inputMode="decimal"
                  value={form.phosphorus}
                  placeholder="22.5"
                  aria-invalid={Boolean(fieldErrors.phosphorus)}
                  aria-describedby={fieldErrors.phosphorus ? `${formIdPrefix}-p-err` : undefined}
                  onChange={(e) => setForm({ ...form, phosphorus: e.target.value })}
                  className={`${inputBaseClass} ${
                    fieldErrors.phosphorus ? "border-fault-border" : "border-line-input"
                  }`}
                />
                {fieldErrors.phosphorus && (
                  <p id={`${formIdPrefix}-p-err`} role="alert" className="mt-1 text-[0.75rem] font-medium text-fault-text">
                    {fieldErrors.phosphorus}
                  </p>
                )}
              </div>
            </div>

            {/* Potassium with unit switch */}
            <div>
              <label
                htmlFor={`${formIdPrefix}-k`}
                className="block text-[0.8125rem] font-medium text-ink-secondary mb-1"
              >
                Potassium K
              </label>
              <div className="flex gap-2">
                <input
                  id={`${formIdPrefix}-k`}
                  inputMode="decimal"
                  value={form.potassium}
                  placeholder="89.93"
                  aria-invalid={Boolean(fieldErrors.potassium)}
                  aria-describedby={fieldErrors.potassium ? `${formIdPrefix}-k-err` : `${formIdPrefix}-k-help`}
                  onChange={(e) => setForm({ ...form, potassium: e.target.value })}
                  className={`${inputBaseClass} ${
                    fieldErrors.potassium ? "border-fault-border" : "border-line-input"
                  }`}
                />
                <select
                  aria-label="Potassium unit"
                  value={form.potassiumUnit}
                  onChange={(e) => setForm({ ...form, potassiumUnit: e.target.value as KUnit })}
                  className="min-h-[48px] shrink-0 rounded-md border border-line-input bg-sunken px-2.5 text-[0.875rem] font-medium text-ink-primary"
                >
                  <option value="mg/kg">mg/kg</option>
                  <option value="cmol(+)/kg">cmol(+)/kg</option>
                </select>
              </div>
              {fieldErrors.potassium ? (
                <p id={`${formIdPrefix}-k-err`} role="alert" className="mt-1 text-[0.75rem] font-medium text-fault-text">
                  {fieldErrors.potassium}
                </p>
              ) : (
                <p id={`${formIdPrefix}-k-help`} className="mt-1 text-[0.75rem] text-ink-muted">
                  SRDI lab reports in cmol(+)/kg convert automatically by multiplying by 391.
                </p>
              )}
            </div>

            {/* EC with explicit unit switch + Salinity */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor={`${formIdPrefix}-ec`}
                  className="block text-[0.8125rem] font-medium text-ink-secondary mb-1"
                >
                  Electrical Conductivity (EC)
                </label>
                <div className="flex gap-2">
                  <input
                    id={`${formIdPrefix}-ec`}
                    inputMode="decimal"
                    value={form.ec}
                    placeholder="0.54"
                    aria-invalid={Boolean(fieldErrors.ec)}
                    onChange={(e) => setForm({ ...form, ec: e.target.value })}
                    className={`${inputBaseClass} ${
                      fieldErrors.ec ? "border-fault-border" : "border-line-input"
                    }`}
                  />
                  <select
                    aria-label="EC unit"
                    value={form.ecUnit}
                    onChange={(e) => setForm({ ...form, ecUnit: e.target.value as ECUnit })}
                    className="min-h-[48px] shrink-0 rounded-md border border-line-input bg-sunken px-2 text-[0.875rem] font-medium text-ink-primary"
                  >
                    <option value="dS/m">dS/m</option>
                    <option value="uS/cm">uS/cm</option>
                    <option value="unknown">unknown</option>
                  </select>
                </div>
                {fieldErrors.ec && (
                  <p role="alert" className="mt-1 text-[0.75rem] font-medium text-fault-text">
                    {fieldErrors.ec}
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor={`${formIdPrefix}-sal`}
                  className="block text-[0.8125rem] font-medium text-ink-secondary mb-1"
                >
                  Salinity (mg/L, optional)
                </label>
                <input
                  id={`${formIdPrefix}-sal`}
                  inputMode="decimal"
                  value={form.salinity}
                  placeholder="346"
                  aria-invalid={Boolean(fieldErrors.salinity)}
                  onChange={(e) => setForm({ ...form, salinity: e.target.value })}
                  className={`${inputBaseClass} ${
                    fieldErrors.salinity ? "border-fault-border" : "border-line-input"
                  }`}
                />
                {fieldErrors.salinity && (
                  <p role="alert" className="mt-1 text-[0.75rem] font-medium text-fault-text">
                    {fieldErrors.salinity}
                  </p>
                )}
              </div>
            </div>

            {/* Temperature & Moisture */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor={`${formIdPrefix}-temp`}
                  className="block text-[0.8125rem] font-medium text-ink-secondary mb-1"
                >
                  Soil Temperature (deg C)
                </label>
                <input
                  id={`${formIdPrefix}-temp`}
                  inputMode="decimal"
                  value={form.temperature}
                  placeholder="26.8"
                  aria-invalid={Boolean(fieldErrors.temperature)}
                  aria-describedby={fieldErrors.temperature ? `${formIdPrefix}-t-err` : undefined}
                  onChange={(e) => setForm({ ...form, temperature: e.target.value })}
                  className={`${inputBaseClass} ${
                    fieldErrors.temperature ? "border-fault-border" : "border-line-input"
                  }`}
                />
                {fieldErrors.temperature && (
                  <p id={`${formIdPrefix}-t-err`} role="alert" className="mt-1 text-[0.75rem] font-medium text-fault-text">
                    {fieldErrors.temperature}
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor={`${formIdPrefix}-moist`}
                  className="block text-[0.8125rem] font-medium text-ink-secondary mb-1"
                >
                  Soil Moisture / Humidity (%)
                </label>
                <input
                  id={`${formIdPrefix}-moist`}
                  inputMode="decimal"
                  value={form.moisture}
                  placeholder="36.0"
                  aria-invalid={Boolean(fieldErrors.moisture)}
                  aria-describedby={fieldErrors.moisture ? `${formIdPrefix}-m-err` : undefined}
                  onChange={(e) => setForm({ ...form, moisture: e.target.value })}
                  className={`${inputBaseClass} ${
                    fieldErrors.moisture ? "border-fault-border" : "border-line-input"
                  }`}
                />
                {fieldErrors.moisture && (
                  <p id={`${formIdPrefix}-m-err`} role="alert" className="mt-1 text-[0.75rem] font-medium text-fault-text">
                    {fieldErrors.moisture}
                  </p>
                )}
              </div>
            </div>

            {/* Field Context: Rain, Fertilizer, 24h Previous SOM */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label
                  htmlFor={`${formIdPrefix}-rain`}
                  className="block text-[0.75rem] font-medium text-ink-secondary mb-1"
                >
                  Days Since Rain
                </label>
                <input
                  id={`${formIdPrefix}-rain`}
                  inputMode="decimal"
                  value={form.daysSinceRain}
                  placeholder="5"
                  onChange={(e) => setForm({ ...form, daysSinceRain: e.target.value })}
                  className={`${inputBaseClass} border-line-input`}
                />
              </div>
              <div>
                <label
                  htmlFor={`${formIdPrefix}-fert`}
                  className="block text-[0.75rem] font-medium text-ink-secondary mb-1"
                >
                  Days Since Fert.
                </label>
                <input
                  id={`${formIdPrefix}-fert`}
                  inputMode="decimal"
                  value={form.daysSinceFertilizer}
                  placeholder="14"
                  onChange={(e) => setForm({ ...form, daysSinceFertilizer: e.target.value })}
                  className={`${inputBaseClass} border-line-input`}
                />
              </div>
              <div>
                <label
                  htmlFor={`${formIdPrefix}-prevsom`}
                  className="block text-[0.75rem] font-medium text-ink-secondary mb-1"
                >
                  Prior 24h SOM (%)
                </label>
                <input
                  id={`${formIdPrefix}-prevsom`}
                  inputMode="decimal"
                  value={form.previousSomPct}
                  placeholder="Optional"
                  onChange={(e) => setForm({ ...form, previousSomPct: e.target.value })}
                  className={`${inputBaseClass} border-line-input`}
                />
              </div>
            </div>
          </div>

          {/* Primary Actions (spaced 16px from presets/fields) */}
          <div className="mt-5 flex flex-wrap gap-4 border-t border-line-subtle pt-4">
            <button
              type="button"
              onClick={handleRunExplicitCheck}
              className="somsense-transition min-h-[44px] flex-1 rounded-md bg-brand px-4 py-2 text-[0.9375rem] font-semibold text-ink-inverse hover:bg-brand-hover"
            >
              {UI_COPY.tab_predict_diagnose.calculate_button}
            </button>
            <button
              type="button"
              onClick={handleClear}
              className="somsense-transition inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-md border border-line-input bg-surface px-4 py-2 text-[0.875rem] font-medium text-ink-secondary hover:bg-sunken hover:text-ink-primary"
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              <span>{UI_COPY.tab_predict_diagnose.reset_button}</span>
            </button>
          </div>
        </section>

        {/* Right Column: Diagnostics, Trust Gauge, Accordions & Exports */}
        <div className="min-w-0 space-y-5 lg:col-span-7">
          {evalError && (
            <div
              role="alert"
              className="rounded-lg border border-fault-border bg-fault-bg p-4 text-fault-text"
            >
              <p className="font-semibold">Input Validation Error</p>
              <p className="mt-1 text-[0.875rem]">{evalError}</p>
            </div>
          )}

          {/* Sensor Health Doctor Alerts */}
          {pred && pred.physicsReport.flags.length > 0 && (
            <div className="space-y-3" aria-label="Sensor Health Doctor diagnostics">
              {pred.physicsReport.flags.map((flag, idx) => {
                const isCritical = flag.severity === "CRITICAL";
                return (
                  <div
                    key={`${flag.code}-${flag.field}-${idx}`}
                    role={isCritical ? "alert" : "status"}
                    className={`rounded-lg border p-4 ${
                      isCritical
                        ? "border-fault-border bg-fault-bg text-fault-text"
                        : "border-warn-border bg-warn-bg text-warn-text"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      {isCritical ? (
                        <OctagonAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                      ) : (
                        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h3 className="text-[0.9375rem] font-semibold">
                            {isCritical
                              ? UI_COPY.tab_predict_diagnose.banners.hardware_fault.title
                              : flag.code === "SATURATION_DISTURBANCE_WARNING"
                                ? UI_COPY.tab_predict_diagnose.banners.saturation_disturbance.title
                                : flag.code === "TRANSIENT_ION_DISTURBANCE"
                                  ? UI_COPY.tab_predict_diagnose.banners.transient_ion_disturbance.title
                                  : flag.code === "TEMPORAL_JUMP_WARNING"
                                    ? UI_COPY.tab_predict_diagnose.banners.temporal_jump.title
                                    : flag.code}
                          </h3>
                          <span className="rounded border border-current px-2 py-0.5 font-mono text-[0.75rem] font-semibold">
                            {flag.code}
                          </span>
                        </div>
                        <p className="mt-1.5 text-[0.875rem]">{flag.message}</p>
                        {flag.probable_causes.length > 0 && (
                          <ul className="mt-2 list-disc pl-5 text-[0.8125rem] space-y-0.5">
                            {flag.probable_causes.map((cause, cIdx) => (
                              <li key={cIdx}>{cause}</li>
                            ))}
                          </ul>
                        )}
                        {isCritical && flag.field === "ph" && (
                          <div className="mt-3 rounded border border-current/30 bg-surface/60 p-3 text-[0.8125rem]">
                            <p className="font-semibold mb-1">
                              {UI_COPY.tab_predict_diagnose.banners.hardware_fault.checklist_heading}
                            </p>
                            <ol className="space-y-1">
                              {UI_COPY.tab_predict_diagnose.banners.hardware_fault.steps.map(
                                (step, sIdx) => (
                                  <li key={sIdx}>{step}</li>
                                )
                              )}
                            </ol>
                          </div>
                        )}
                        <p className="mt-2 text-[0.8125rem] font-medium">
                          Action: {flag.remediation}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Out-of-Calibration-Range Banner (when physics passes, OOD blocks) */}
          {pred && pred.blockReason === "OUTSIDE_CALIBRATION_RANGE" && (
            <div
              role="alert"
              className="rounded-lg border border-ood-border bg-ood-bg p-4 text-ood-text"
            >
              <div className="flex items-start gap-3">
                <Compass className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-[0.9375rem] font-semibold">
                      {UI_COPY.tab_predict_diagnose.banners.ood_rejected.title}
                    </h3>
                    <span className="rounded border border-current px-2 py-0.5 font-mono text-[0.75rem] font-semibold">
                      {UI_COPY.tab_predict_diagnose.banners.ood_rejected.code}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[0.875rem]">
                    {UI_COPY.tab_predict_diagnose.banners.ood_rejected.summary}
                  </p>
                  <p className="mt-2 font-mono text-[0.8125rem]">
                    Detail: {pred.oodAssessment.reason}
                  </p>
                  <p className="mt-1.5 text-[0.8125rem] font-medium">
                    {UI_COPY.tab_predict_diagnose.banners.ood_rejected.action}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Instrument Range Gauge Card */}
          <section
            aria-labelledby="output-heading"
            className="rounded-lg border border-line-subtle bg-surface p-4 sm:p-6"
          >
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line-subtle pb-4">
              <div>
                <h2 id="output-heading" className="text-[1.125rem] font-semibold text-ink-primary">
                  {UI_COPY.tab_predict_diagnose.section_output_heading}
                </h2>
                <p className="mt-0.5 text-[0.8125rem] text-ink-muted">
                  {UI_COPY.tab_predict_diagnose.trust_gauge.disclosure}
                </p>
              </div>

              {/* Configurable Van Bemmelen k */}
              <div className="flex items-center gap-2">
                <label
                  htmlFor={`${formIdPrefix}-vbk`}
                  className="text-[0.75rem] font-medium text-ink-secondary"
                >
                  Van Bemmelen k
                </label>
                <input
                  id={`${formIdPrefix}-vbk`}
                  inputMode="decimal"
                  value={form.vanBemmelenK}
                  aria-invalid={Boolean(fieldErrors.vanBemmelenK)}
                  onChange={(e) => setForm({ ...form, vanBemmelenK: e.target.value })}
                  className="min-h-[44px] w-24 rounded-md border border-line-input bg-sunken px-2.5 text-right font-mono text-[0.9375rem] font-semibold text-ink-primary tabular-nums"
                />
              </div>
            </div>

            {!pred ? (
              <div className="py-10 text-center text-[0.9375rem] text-ink-muted">
                {UI_COPY.tab_predict_diagnose.trust_gauge.empty_prompt}
              </div>
            ) : (
              <div className="mt-5 space-y-5">
                {/* Hero SOM & SOC Readout + Domain Status Pill */}
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <p className="text-[0.8125rem] font-medium text-ink-secondary">
                      {UI_COPY.tab_predict_diagnose.trust_gauge.metric_title}
                    </p>
                    <div className="mt-1 flex items-baseline gap-3">
                      <span
                        data-testid="estimated-som-readout"
                        className="font-mono text-[2.25rem] font-semibold leading-none text-ink-primary tabular-nums"
                      >
                        {pred.blocked || pred.estimatedSomPct === null
                          ? "---"
                          : `${pred.estimatedSomPct.toFixed(2)}%`}
                      </span>
                      <span className="font-mono text-[0.9375rem] text-ink-secondary tabular-nums">
                        {UI_COPY.tab_predict_diagnose.trust_gauge.soc_secondary_label}:{" "}
                        {pred.blocked || pred.estimatedSocPct === null
                          ? "---"
                          : `${pred.estimatedSocPct.toFixed(2)}%`}
                      </span>
                    </div>
                  </div>

                  {/* Calibration Domain Status Pill */}
                  <div className="flex flex-col items-start sm:items-end gap-1.5">
                    <span className="text-[0.75rem] font-medium text-ink-muted">
                      {UI_COPY.tab_predict_diagnose.trust_gauge.domain_status_label}
                    </span>
                    <div
                      data-testid="domain-status-pill"
                      className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-full border px-3 py-1 text-[0.8125rem] font-semibold ${
                        pred.calibrationDomainStatus === "In-Range"
                          ? "border-brand bg-brand-soft text-brand-softText"
                          : pred.calibrationDomainStatus === "Caution"
                            ? "border-warn-border bg-warn-bg text-warn-text"
                            : "border-ood-border bg-ood-bg text-ood-text"
                      }`}
                    >
                      {pred.calibrationDomainStatus === "In-Range" ? (
                        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                      ) : pred.calibrationDomainStatus === "Caution" ? (
                        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                      ) : (
                        <Compass className="h-4 w-4 shrink-0" aria-hidden="true" />
                      )}
                      <span>{pred.calibrationDomainStatus}</span>
                    </div>
                  </div>
                </div>

                {/* 95% Prediction Interval Visual Gauge Bar */}
                <div className="rounded-md border border-line-subtle bg-sunken p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[0.8125rem]">
                    <span className="font-medium text-ink-secondary">
                      {UI_COPY.tab_predict_diagnose.trust_gauge.interval_label}
                    </span>
                    <span className="font-mono font-semibold text-ink-primary tabular-nums">
                      {pred.blocked || pred.somCi95Lower === null || pred.somCi95Upper === null
                        ? "Withheld (---)"
                        : `[${pred.somCi95Lower.toFixed(2)}%, ${pred.somCi95Upper.toFixed(2)}%]`}
                    </span>
                  </div>

                  {/* Horizontal Instrument Scale 0% -> 6% */}
                  <div className="mt-3 relative h-5 w-full rounded bg-surface border border-line-subtle overflow-hidden" aria-hidden="true">
                    {/* BARC threshold ticks */}
                    <div className="absolute inset-y-0 border-l border-line-subtle" style={{ left: `${toGaugePct(1.0)}%` }} />
                    <div className="absolute inset-y-0 border-l border-line-subtle" style={{ left: `${toGaugePct(1.7)}%` }} />
                    <div className="absolute inset-y-0 border-l border-line-subtle" style={{ left: `${toGaugePct(3.4)}%` }} />
                    <div className="absolute inset-y-0 border-l border-line-subtle" style={{ left: `${toGaugePct(5.5)}%` }} />

                    {!pred.blocked &&
                      pred.estimatedSomPct !== null &&
                      pred.somCi95Lower !== null &&
                      pred.somCi95Upper !== null && (
                        <>
                          <div
                            className="absolute inset-y-1 rounded-sm bg-brand/30 border border-brand"
                            style={{
                              left: `${toGaugePct(pred.somCi95Lower)}%`,
                              width: `${Math.max(
                                1.5,
                                toGaugePct(pred.somCi95Upper) - toGaugePct(pred.somCi95Lower)
                              )}%`,
                            }}
                          />
                          <div
                            className="absolute inset-y-0 w-1 bg-brand"
                            style={{ left: `${toGaugePct(pred.estimatedSomPct)}%` }}
                          />
                        </>
                      )}
                  </div>
                  <div className="mt-1.5 flex justify-between font-mono text-[0.7rem] text-ink-muted tabular-nums">
                    <span>0.0%</span>
                    <span>1.0%</span>
                    <span>1.7%</span>
                    <span>3.4%</span>
                    <span>5.5%</span>
                    <span>6.0%+</span>
                  </div>
                </div>

                {/* Metadata Grid: Model Version, Mahalanobis D^2, BARC/SRDI Tier */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="rounded-md border border-line-subtle bg-surface p-3">
                    <p className="text-[0.75rem] font-medium text-ink-muted">
                      {UI_COPY.tab_predict_diagnose.trust_gauge.model_version_label}
                    </p>
                    <p className="mt-1 font-mono text-[0.875rem] font-semibold text-ink-primary break-all">
                      {pred.modelId} (v{pred.modelVersion})
                    </p>
                    <p className="mt-0.5 font-mono text-[0.75rem] text-ink-muted tabular-nums">
                      D^2 = {pred.oodAssessment.mahalanobisD2.toFixed(2)} | Latency{" "}
                      {pred.inferenceMs.toFixed(2)} ms
                    </p>
                  </div>

                  <div className="rounded-md border border-line-subtle bg-surface p-3">
                    <p className="text-[0.75rem] font-medium text-ink-muted">
                      {UI_COPY.tab_predict_diagnose.trust_gauge.barc_badge_label}
                    </p>
                    {barcTier ? (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <span
                          className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[0.8125rem] font-semibold"
                          style={{
                            backgroundColor: theme === "dark" ? barcTier.dark_bg : barcTier.light_bg,
                            color: theme === "dark" ? barcTier.dark_fg : barcTier.light_fg,
                          }}
                        >
                          {barcTier.label} ({barcTier.range_label})
                        </span>
                      </div>
                    ) : (
                      <p className="mt-1 font-mono text-[0.875rem] text-ink-muted">
                        Withheld while blocked
                      </p>
                    )}
                    <p className="mt-1 text-[0.7rem] text-ink-muted">
                      {UI_COPY.tab_predict_diagnose.trust_gauge.barc_disclaimer}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* 3 Collapsed-by-Default Accordions */}
          <section aria-labelledby="details-heading" className="space-y-3">
            <h2 id="details-heading" className="sr-only">
              {UI_COPY.tab_predict_diagnose.section_details_heading}
            </h2>

            {/* Accordion 1: Equations & Standardization */}
            <div className="rounded-lg border border-line-subtle bg-surface">
              <button
                type="button"
                aria-expanded={openAccordion.equations}
                aria-controls="acc-equations-panel"
                onClick={() =>
                  setOpenAccordion((prev) => ({ ...prev, equations: !prev.equations }))
                }
                className="somsense-transition flex min-h-[48px] w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-sunken"
              >
                <div>
                  <span className="block text-[0.9375rem] font-semibold text-ink-primary">
                    {UI_COPY.tab_predict_diagnose.accordions.equations.title}
                  </span>
                  <span className="block text-[0.8125rem] text-ink-muted">
                    {UI_COPY.tab_predict_diagnose.accordions.equations.subtitle}
                  </span>
                </div>
                <ChevronDown
                  className={`h-5 w-5 shrink-0 text-ink-secondary transition-transform ${
                    openAccordion.equations ? "rotate-180" : ""
                  }`}
                  aria-hidden="true"
                />
              </button>
              {openAccordion.equations && activeModel && (
                <div id="acc-equations-panel" className="border-t border-line-subtle p-4 space-y-3">
                  <p className="text-[0.8125rem] text-ink-secondary">
                    {UI_COPY.tab_predict_diagnose.accordions.equations.note}
                  </p>
                  <div className="rounded border border-line-subtle bg-sunken p-3 font-mono text-[0.8125rem] text-ink-primary">
                    z_j = (x_j - mu_j) / s_j |{" "}
                    {activeModel.target_name === "OM_pct"
                      ? `SOM (%) = model_pred(z), SOC (%) = SOM / ${form.vanBemmelenK || "1.724"}`
                      : `SOC (%) = model_pred(z), SOM (%) = ${form.vanBemmelenK || "1.724"} * SOC`}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left font-mono text-[0.75rem] tabular-nums">
                      <thead>
                        <tr className="border-b border-line-subtle text-ink-muted">
                          <th className="py-1.5 pr-3">Feature</th>
                          <th className="py-1.5 pr-3">Train Mean</th>
                          <th className="py-1.5 pr-3">Train Std</th>
                          <th className="py-1.5 pr-3">Current z_j</th>
                          <th className="py-1.5">Min .. Max</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeModel.preprocessing.raw_features.map((feat) => (
                          <tr key={feat} className="border-b border-line-subtle/60">
                            <td className="py-1.5 pr-3 font-sans font-medium text-ink-primary">
                              {FEATURE_DISPLAY_LABELS[feat] ?? feat}
                            </td>
                            <td className="py-1.5 pr-3">
                              {(activeModel.preprocessing.feature_means[feat] ?? 0).toFixed(3)}
                            </td>
                            <td className="py-1.5 pr-3">
                              {(activeModel.preprocessing.feature_stds[feat] ?? 1).toFixed(3)}
                            </td>
                            <td className="py-1.5 pr-3">
                              {pred?.standardizedVector[feat] !== undefined
                                ? pred.standardizedVector[feat]!.toFixed(3)
                                : "---"}
                            </td>
                            <td className="py-1.5">
                              {(activeModel.preprocessing.feature_mins[feat] ?? 0).toFixed(2)} ..{" "}
                              {(activeModel.preprocessing.feature_maxs[feat] ?? 0).toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* Accordion 2: Feature Drivers (SHAP & Coefficients) */}
            <div className="rounded-lg border border-line-subtle bg-surface">
              <button
                type="button"
                aria-expanded={openAccordion.drivers}
                aria-controls="acc-drivers-panel"
                onClick={() =>
                  setOpenAccordion((prev) => ({ ...prev, drivers: !prev.drivers }))
                }
                className="somsense-transition flex min-h-[48px] w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-sunken"
              >
                <div>
                  <span className="block text-[0.9375rem] font-semibold text-ink-primary">
                    {UI_COPY.tab_predict_diagnose.accordions.shap_drivers.title}
                  </span>
                  <span className="block text-[0.8125rem] text-ink-muted">
                    {UI_COPY.tab_predict_diagnose.accordions.shap_drivers.subtitle}
                  </span>
                </div>
                <ChevronDown
                  className={`h-5 w-5 shrink-0 text-ink-secondary transition-transform ${
                    openAccordion.drivers ? "rotate-180" : ""
                  }`}
                  aria-hidden="true"
                />
              </button>
              {openAccordion.drivers && (
                <div id="acc-drivers-panel" className="border-t border-line-subtle p-4">
                  {!pred || pred.blocked ? (
                    <p className="text-[0.875rem] text-ink-muted">
                      {UI_COPY.tab_predict_diagnose.accordions.shap_drivers.blocked_note}
                    </p>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex flex-wrap gap-4 text-[0.75rem] text-ink-secondary">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className="h-3 w-3 rounded-sm"
                            style={{ backgroundColor: "var(--chart-positive)" }}
                          />
                          {UI_COPY.tab_predict_diagnose.accordions.shap_drivers.positive_legend}
                        </span>
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className="h-3 w-3 rounded-sm"
                            style={{ backgroundColor: "var(--chart-negative)" }}
                          />
                          {UI_COPY.tab_predict_diagnose.accordions.shap_drivers.negative_legend}
                        </span>
                      </div>
                      <div className="h-[240px] w-full min-w-0">
                        <ResponsiveContainer width="100%" height={240}>
                          <BarChart
                            data={driverChartData}
                            layout="vertical"
                            margin={{ top: 6, right: 24, left: 16, bottom: 6 }}
                          >
                            <XAxis
                              type="number"
                              tick={{ fill: "var(--text-secondary)", fontSize: 12 }}
                              stroke="var(--border-subtle)"
                            />
                            <YAxis
                              type="category"
                              dataKey="name"
                              width={150}
                              tick={{ fill: "var(--text-primary)", fontSize: 12 }}
                              stroke="var(--border-subtle)"
                            />
                            <ReferenceLine x={0} stroke="var(--text-muted)" />
                            <Tooltip
                              contentStyle={{
                                backgroundColor: "var(--bg-surface-elevated)",
                                borderColor: "var(--border-subtle)",
                                color: "var(--text-primary)",
                                fontSize: "12px",
                              }}
                            />
                            <Bar dataKey="contribution" radius={[3, 3, 3, 3]}>
                              {driverChartData.map((entry, idx) => (
                                <Cell
                                  key={`cell-${idx}`}
                                  fill={
                                    entry.contribution >= 0
                                      ? "var(--chart-positive)"
                                      : "var(--chart-negative)"
                                  }
                                />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Accordion 3: Raw Telemetry JSON/CSV Import & Sanitizer */}
            <div className="no-print rounded-lg border border-line-subtle bg-surface">
              <button
                type="button"
                aria-expanded={openAccordion.rawImport}
                aria-controls="acc-raw-panel"
                onClick={() =>
                  setOpenAccordion((prev) => ({ ...prev, rawImport: !prev.rawImport }))
                }
                className="somsense-transition flex min-h-[48px] w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-sunken"
              >
                <div>
                  <span className="block text-[0.9375rem] font-semibold text-ink-primary">
                    {UI_COPY.tab_predict_diagnose.accordions.raw_telemetry.title}
                  </span>
                  <span className="block text-[0.8125rem] text-ink-muted">
                    {UI_COPY.tab_predict_diagnose.accordions.raw_telemetry.subtitle}
                  </span>
                </div>
                <ChevronDown
                  className={`h-5 w-5 shrink-0 text-ink-secondary transition-transform ${
                    openAccordion.rawImport ? "rotate-180" : ""
                  }`}
                  aria-hidden="true"
                />
              </button>
              {openAccordion.rawImport && (
                <div id="acc-raw-panel" className="border-t border-line-subtle p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label
                      htmlFor={`${formIdPrefix}-raw-json`}
                      className="text-[0.8125rem] font-medium text-ink-secondary"
                    >
                      {UI_COPY.tab_predict_diagnose.accordions.raw_telemetry.paste_label}
                    </label>
                    <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-1.5 rounded-md border border-line-input bg-sunken px-3 py-1.5 text-[0.8125rem] font-medium text-ink-primary hover:bg-brand-soft">
                      <Upload className="h-4 w-4" aria-hidden="true" />
                      <span>Load JSON/CSV File</span>
                      <input
                        type="file"
                        accept=".json,.csv,application/json,text/csv"
                        onChange={handleTelemetryFileUpload}
                        className="sr-only"
                      />
                    </label>
                  </div>
                  <textarea
                    id={`${formIdPrefix}-raw-json`}
                    rows={4}
                    value={rawJsonInput}
                    placeholder={
                      UI_COPY.tab_predict_diagnose.accordions.raw_telemetry.paste_placeholder
                    }
                    onChange={(e) => setRawJsonInput(e.target.value)}
                    className="w-full rounded-md border border-line-input bg-sunken p-3 font-mono text-[0.8125rem] text-ink-primary"
                  />
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2">
                      <label
                        htmlFor={`${formIdPrefix}-raw-ec-unit`}
                        className="text-[0.8125rem] font-medium text-ink-secondary"
                      >
                        Default EC Unit
                      </label>
                      <select
                        id={`${formIdPrefix}-raw-ec-unit`}
                        value={rawImportEcUnit}
                        onChange={(e) => setRawImportEcUnit(e.target.value as ECUnit)}
                        className="min-h-[44px] rounded-md border border-line-input bg-sunken px-2.5 text-[0.8125rem] font-medium text-ink-primary"
                      >
                        <option value="unknown">Require Payload Unit / Flag Unknown</option>
                        <option value="dS/m">dS/m</option>
                        <option value="uS/cm">uS/cm (/ 1000)</option>
                      </select>
                    </div>
                    <button
                      type="button"
                      onClick={handleParseRawTelemetry}
                      className="somsense-transition min-h-[44px] rounded-md bg-brand px-4 py-2 text-[0.875rem] font-semibold text-ink-inverse hover:bg-brand-hover"
                    >
                      {UI_COPY.tab_predict_diagnose.accordions.raw_telemetry.parse_button}
                    </button>
                  </div>
                  <p className="flex items-start gap-1.5 text-[0.75rem] text-ink-muted">
                    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
                    <span>
                      {UI_COPY.tab_predict_diagnose.accordions.raw_telemetry.security_note}
                    </span>
                  </p>
                  {rawImportMessage && (
                    <div
                      role={rawImportMessage.kind === "error" ? "alert" : "status"}
                      className={`rounded-md border p-3 text-[0.8125rem] font-medium ${
                        rawImportMessage.kind === "error"
                          ? "border-fault-border bg-fault-bg text-fault-text"
                          : rawImportMessage.kind === "warn"
                            ? "border-warn-border bg-warn-bg text-warn-text"
                            : "border-brand bg-brand-soft text-brand-softText"
                      }`}
                    >
                      {rawImportMessage.text}
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Offline Plot Exports Footer */}
          <section
            aria-labelledby="exports-heading"
            className="no-print rounded-lg border border-line-subtle bg-surface p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <h2 id="exports-heading" className="text-[0.9375rem] font-semibold text-ink-primary">
                {UI_COPY.tab_predict_diagnose.exports.heading}
              </h2>
              <span className="text-[0.75rem] text-ink-muted">
                {UI_COPY.tab_predict_diagnose.exports.formula_safe_note}
              </span>
            </div>
            <div className="flex flex-wrap gap-2.5">
              <button
                type="button"
                disabled={!pred || !reading || !activeModel}
                onClick={() => {
                  if (!pred || !reading || !activeModel) return;
                  const csv = exportReadingToSafeCsv(reading, pred, activeModel);
                  triggerBrowserDownload("somsense_reading.csv", csv, "text/csv;charset=utf-8");
                  onAnnounce("Saved somsense_reading.csv to your device.");
                }}
                className="somsense-transition inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-line-input bg-sunken px-3.5 py-2 text-[0.8125rem] font-semibold text-ink-primary hover:bg-brand-soft disabled:opacity-50"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                <span>{UI_COPY.tab_predict_diagnose.exports.export_csv}</span>
              </button>

              <button
                type="button"
                disabled={!pred || !reading || !activeModel}
                onClick={() => {
                  if (!pred || !reading || !activeModel) return;
                  const json = exportReadingToJsonBundle(reading, pred, activeModel);
                  triggerBrowserDownload("somsense_bundle.json", json, "application/json");
                  onAnnounce("Saved somsense_bundle.json to your device.");
                }}
                className="somsense-transition inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-line-input bg-sunken px-3.5 py-2 text-[0.8125rem] font-semibold text-ink-primary hover:bg-brand-soft disabled:opacity-50"
              >
                <FileJson className="h-4 w-4" aria-hidden="true" />
                <span>{UI_COPY.tab_predict_diagnose.exports.export_json}</span>
              </button>

              <button
                type="button"
                disabled={!pred || !reading || !activeModel}
                onClick={() => {
                  if (!pred || !reading || !activeModel) return;
                  const md = exportReadingToMarkdownBrief(reading, pred, activeModel);
                  triggerBrowserDownload("somsense_brief.md", md, "text/markdown;charset=utf-8");
                  onAnnounce("Saved somsense_brief.md to your device.");
                }}
                className="somsense-transition inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-line-input bg-sunken px-3.5 py-2 text-[0.8125rem] font-semibold text-ink-primary hover:bg-brand-soft disabled:opacity-50"
              >
                <FileText className="h-4 w-4" aria-hidden="true" />
                <span>{UI_COPY.tab_predict_diagnose.exports.export_md}</span>
              </button>

              <button
                type="button"
                onClick={() => window.print()}
                className="somsense-transition inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-line-input bg-surface px-3.5 py-2 text-[0.8125rem] font-medium text-ink-secondary hover:bg-sunken"
              >
                <Printer className="h-4 w-4" aria-hidden="true" />
                <span>{UI_COPY.tab_predict_diagnose.exports.print_card}</span>
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
