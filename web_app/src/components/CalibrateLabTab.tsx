import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileCheck2,
  FileText,
  FlaskConical,
  ShieldAlert,
  Upload,
} from "lucide-react";
import { useId, useState } from "react";
import { AEZ_CALIBRATION_TEMPLATE_CSV, UI_COPY } from "../copy/uiCopy";
import { runInBrowserCalibration, type CalibrationRunResult } from "../engine/calibrationEngine";
import type { ECUnit, KUnit, ModelEntry, ModelRegistry, SOCUnit } from "../engine/types";
import { triggerBrowserDownload } from "../utils/download";

function buildAez19LeakDemoCsv(): string {
  const header =
    "site_id,aez_zone,lat,lon,depth_cm,timestamp,N,P,K,pH,EC,Salinity,Temp_C,Moisture_pct,texture_class,crop,days_since_rain,days_since_fertilizer,lab_soc_pct,lab_method,lab_poxc_mg_kg,sensor_model,TN_pct";
  const rows = [header];
  const sites = ["cumilla_p1", "cumilla_p2", "cumilla_p3", "cumilla_p4", "cumilla_p5", "cumilla_p6"];
  const depths = ["0-15", "0-20", "20-40"];
  for (let i = 0; i < 18; i++) {
    const site = sites[i % sites.length]!;
    const depth = depths[i % depths.length]!;
    const n = 155 + ((i * 19) % 110);
    const p = 14.5 + ((i * 7) % 16);
    const k = 142 + ((i * 29) % 95);
    const ph = 5.9 + ((i * 3) % 11) * 0.14;
    const ec = 0.32 + ((i * 5) % 9) * 0.09;
    const sal = Math.round(ec * 640);
    const temp = 24.8 + ((i * 11) % 7) * 0.85;
    const moist = 26.0 + ((i * 13) % 12) * 3.1;
    const soc = 0.85 + 0.0022 * n + 0.011 * moist - 0.018 * (temp - 26.0) + (i % 3) * 0.04;
    const tn = 0.0492 * (soc * 1.724) - 0.0065;
    rows.push(
      `${site},AEZ-19,23.46,${(91.18 + i * 0.001).toFixed(4)},${depth},2026-10-02T09:${String(
        10 + i
      ).padStart(2, "0")}:00+06:00,${n},${p.toFixed(1)},${k},${ph.toFixed(2)},${ec.toFixed(
        2
      )},${sal},${temp.toFixed(1)},${moist.toFixed(1)},Clay Loam,Aman Rice,5,18,${soc.toFixed(
        3
      )},Walkley-Black,${Math.round(soc * 420)},ESRC Device - 1,${tn.toFixed(4)}`
    );
  }
  // Real cumilla 2 fault row quarantined during calibration
  rows.push(
    "cumilla_2_fault_row,AEZ-19,23.46,91.18,0-15,2026-09-29T10:15:00+06:00,185,18.0,175,0.12,1.48,947,29.4,100.0,Clay Loam,Aman Rice,1,5,1.24,Walkley-Black,510,ESRC Device - 1,0.0987"
  );
  return rows.join("\n") + "\n";
}

interface CalibrateLabTabProps {
  baseRegistry: ModelRegistry | null;
  onActivateLocalModel: (entry: ModelEntry) => void;
  onAnnounce: (msg: string) => void;
}

export function CalibrateLabTab({
  baseRegistry,
  onActivateLocalModel,
  onAnnounce,
}: CalibrateLabTabProps) {
  const idPrefix = useId();
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [ecUnit, setEcUnit] = useState<ECUnit>("dS/m");
  const [potassiumUnit, setPotassiumUnit] = useState<KUnit>("mg/kg");
  const [socUnit, setSocUnit] = useState<SOCUnit>("%");
  const [aezZone, setAezZone] = useState("AEZ-19");
  const [modelLabel, setModelLabel] = useState("AEZ-19 Cumilla Local Calibration");

  const [isRunning, setIsRunning] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<CalibrationRunResult | null>(null);
  const [activatedId, setActivatedId] = useState<string | null>(null);

  const handleFileChange = (file: File | undefined): void => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setErrorMsg("File exceeds 10 MB browser limit. Split your log into smaller batches and retry.");
      return;
    }
    setFileName(file.name);
    setErrorMsg(null);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setCsvText(reader.result);
      }
    };
    reader.readAsText(file);
  };

  const runCalibration = async (overrideCsv?: string): Promise<void> => {
    const source = overrideCsv ?? csvText;
    if (!source.trim()) {
      setErrorMsg("Upload a paired CSV or click the TN_pct Demo Dataset button first.");
      return;
    }
    setIsRunning(true);
    setErrorMsg(null);
    setActivatedId(null);
    try {
      const cal = await runInBrowserCalibration(source, {
        ecUnit,
        potassiumUnit,
        socUnit,
        aezZone,
        modelLabel,
        baseRegistry,
      });
      setResult(cal);
      onAnnounce(`Local calibration completed across ${cal.uniqueSiteCount} sites.`);
    } catch (err) {
      setResult(null);
      setErrorMsg(err instanceof Error ? err.message : "Calibration failed.");
    } finally {
      setIsRunning(false);
    }
  };

  const handleLoadLeakDemo = (): void => {
    const demoCsv = buildAez19LeakDemoCsv();
    setCsvText(demoCsv);
    setFileName("demo_aez19_paired_with_tn_leak.csv");
    setEcUnit("dS/m");
    setPotassiumUnit("mg/kg");
    setSocUnit("%");
    void runCalibration(demoCsv);
  };

  const buildCertificateMarkdown = (cal: CalibrationRunResult): string => {
    const m = cal.modelEntry;
    return [
      `# SOMSense Local Calibration Certificate — ${m.model_id}`,
      "",
      `- **Source Label**: ${m.provenance.source_title}`,
      `- **Selected Model Family**: ${m.selected_model_family} (beats OLS baseline: ${m.beats_ols_baseline})`,
      `- **CV Strategy**: ${m.metrics.cv_strategy}`,
      `- **Valid Rows / Sites**: ${cal.validRowCount} rows across ${cal.uniqueSiteCount} sites (${cal.quarantinedRowCount} faulted rows quarantined)`,
      `- **TN_pct Circular Leak Guard**: ${cal.hasTnLeakColumn ? `Detected and excluded (r=${cal.tnOmCorrelation?.toFixed(4) ?? "N/A"})` : "No TN_pct column present"}`,
      `- **Held-Out GroupKFold RMSE (% SOC)**: ${m.metrics.rmse.toFixed(4)} (OLS baseline ${m.metrics.baseline_ols_rmse.toFixed(4)})`,
      `- **Held-Out GroupKFold R^2**: ${m.metrics.r2.toFixed(4)}`,
      `- **Conformal q_095 (% SOC)**: +/- ${m.uncertainty.q_095.toFixed(4)} (Empirical coverage ${(m.uncertainty.empirical_coverage * 100).toFixed(1)}%)`,
      `- **Artifact SHA-256**: \`${m.artifact_sha256}\``,
      "",
    ].join("\n");
  };

  return (
    <div id="panel-calibrate_lab" role="tabpanel" aria-labelledby="tab-calibrate_lab" className="space-y-6">
      {/* Header & Template Controls */}
      <section className="rounded-lg border border-line-subtle bg-surface p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h2 className="text-[1.125rem] font-semibold text-ink-primary">
              {UI_COPY.tab_calibrate_lab.heading}
            </h2>
            <p className="mt-1 text-[0.9375rem] text-ink-secondary">
              {UI_COPY.tab_calibrate_lab.intro}
            </p>
          </div>
          <div className="flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={() => {
                triggerBrowserDownload(
                  "esrc_aez_calibration_template.csv",
                  AEZ_CALIBRATION_TEMPLATE_CSV,
                  "text/csv;charset=utf-8"
                );
                onAnnounce("Saved esrc_aez_calibration_template.csv.");
              }}
              className="somsense-transition inline-flex min-h-[44px] items-center gap-2 rounded-md border border-line-input bg-sunken px-3.5 py-2 text-[0.875rem] font-semibold text-ink-primary hover:bg-brand-soft"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              <span>{UI_COPY.tab_calibrate_lab.download_template_button}</span>
            </button>

            <button
              type="button"
              onClick={handleLoadLeakDemo}
              className="somsense-transition inline-flex min-h-[44px] items-center gap-2 rounded-md border border-brand bg-brand-soft px-3.5 py-2 text-[0.875rem] font-semibold text-brand-softText hover:bg-brand hover:text-ink-inverse"
            >
              <FlaskConical className="h-4 w-4" aria-hidden="true" />
              <span>Run AEZ-19 & TN_pct Leak Demo</span>
            </button>
          </div>
        </div>

        {/* Unit Rules & Circular Leak Guardrail Info */}
        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="rounded-md border border-line-subtle bg-sunken p-4">
            <h3 className="text-[0.9375rem] font-semibold text-ink-primary">
              {UI_COPY.tab_calibrate_lab.unit_harmonization_heading}
            </h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-[0.8125rem] text-ink-secondary">
              {UI_COPY.tab_calibrate_lab.unit_rules.map((rule, idx) => (
                <li key={idx}>{rule}</li>
              ))}
            </ul>
          </div>

          <div className="rounded-md border border-warn-border bg-warn-bg p-4 text-warn-text">
            <div className="flex items-start gap-2.5">
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
              <div>
                <h3 className="text-[0.9375rem] font-semibold">
                  {UI_COPY.tab_calibrate_lab.leak_guardrail_title}
                </h3>
                <p className="mt-1 text-[0.8125rem]">
                  {UI_COPY.tab_calibrate_lab.leak_guardrail_body}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Upload & Explicit Unit Confirmation */}
      <section className="rounded-lg border border-line-subtle bg-surface p-4 sm:p-6 space-y-5">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="lg:col-span-6 space-y-3">
            <label
              htmlFor={`${idPrefix}-csv-file`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                handleFileChange(e.dataTransfer.files?.[0]);
              }}
              className="flex min-h-[120px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-line-input bg-sunken p-4 text-center hover:border-brand"
            >
              <Upload className="h-6 w-6 text-brand mb-2" aria-hidden="true" />
              <span className="text-[0.9375rem] font-semibold text-ink-primary">
                {fileName ? `Loaded: ${fileName}` : UI_COPY.tab_calibrate_lab.upload_dropzone_label}
              </span>
              <span className="mt-1 text-[0.75rem] text-ink-muted">
                {UI_COPY.tab_calibrate_lab.upload_limits_note}
              </span>
              <input
                id={`${idPrefix}-csv-file`}
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => handleFileChange(e.target.files?.[0])}
                className="sr-only"
              />
            </label>

            <div>
              <label
                htmlFor={`${idPrefix}-csv-text`}
                className="block text-[0.8125rem] font-medium text-ink-secondary mb-1"
              >
                Or Paste Paired Calibration CSV Rows
              </label>
              <textarea
                id={`${idPrefix}-csv-text`}
                rows={4}
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                placeholder="site_id,aez_zone,depth_cm,N,P,K,pH,EC,Temp_C,Moisture_pct,lab_soc_pct"
                className="w-full rounded-md border border-line-input bg-sunken p-3 font-mono text-[0.75rem] text-ink-primary"
              />
            </div>
          </div>

          {/* Explicit Unit Confirmation + Metadata */}
          <div className="lg:col-span-6 space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor={`${idPrefix}-aez`}
                  className="block text-[0.8125rem] font-medium text-ink-secondary mb-1"
                >
                  AEZ Zone Tag
                </label>
                <input
                  id={`${idPrefix}-aez`}
                  type="text"
                  value={aezZone}
                  onChange={(e) => setAezZone(e.target.value)}
                  className="min-h-[48px] w-full rounded-md border border-line-input bg-surface px-3 py-2 text-[0.9375rem] text-ink-primary"
                />
              </div>
              <div>
                <label
                  htmlFor={`${idPrefix}-label`}
                  className="block text-[0.8125rem] font-medium text-ink-secondary mb-1"
                >
                  Calibration Model Label
                </label>
                <input
                  id={`${idPrefix}-label`}
                  type="text"
                  value={modelLabel}
                  onChange={(e) => setModelLabel(e.target.value)}
                  className="min-h-[48px] w-full rounded-md border border-line-input bg-surface px-3 py-2 text-[0.9375rem] text-ink-primary"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label
                  htmlFor={`${idPrefix}-ec-unit`}
                  className="block text-[0.8125rem] font-medium text-ink-secondary mb-1"
                >
                  Confirm EC Unit
                </label>
                <select
                  id={`${idPrefix}-ec-unit`}
                  value={ecUnit}
                  onChange={(e) => setEcUnit(e.target.value as ECUnit)}
                  className="min-h-[48px] w-full rounded-md border border-line-input bg-surface px-2.5 text-[0.875rem] font-medium text-ink-primary"
                >
                  <option value="dS/m">dS/m</option>
                  <option value="uS/cm">uS/cm (/ 1000)</option>
                  <option value="unknown">Unknown (Block)</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor={`${idPrefix}-k-unit`}
                  className="block text-[0.8125rem] font-medium text-ink-secondary mb-1"
                >
                  Confirm K Unit
                </label>
                <select
                  id={`${idPrefix}-k-unit`}
                  value={potassiumUnit}
                  onChange={(e) => setPotassiumUnit(e.target.value as KUnit)}
                  className="min-h-[48px] w-full rounded-md border border-line-input bg-surface px-2.5 text-[0.875rem] font-medium text-ink-primary"
                >
                  <option value="mg/kg">mg/kg</option>
                  <option value="cmol(+)/kg">cmol(+)/kg (* 391)</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor={`${idPrefix}-soc-unit`}
                  className="block text-[0.8125rem] font-medium text-ink-secondary mb-1"
                >
                  Confirm Lab SOC Unit
                </label>
                <select
                  id={`${idPrefix}-soc-unit`}
                  value={socUnit}
                  onChange={(e) => setSocUnit(e.target.value as SOCUnit)}
                  className="min-h-[48px] w-full rounded-md border border-line-input bg-surface px-2.5 text-[0.875rem] font-medium text-ink-primary"
                >
                  <option value="%">% (dry mass)</option>
                  <option value="g/kg">g C/kg (/ 10)</option>
                </select>
              </div>
            </div>

            <div className="pt-2">
              <button
                type="button"
                disabled={isRunning}
                onClick={() => void runCalibration()}
                className="somsense-transition min-h-[48px] w-full rounded-md bg-brand px-4 py-2 text-[0.9375rem] font-semibold text-ink-inverse hover:bg-brand-hover disabled:opacity-50"
              >
                {isRunning
                  ? "Running GroupKFold QR Calibration..."
                  : UI_COPY.tab_calibrate_lab.refit_button}
              </button>
            </div>
          </div>
        </div>

        {errorMsg && (
          <div role="alert" className="rounded-md border border-fault-border bg-fault-bg p-4 text-fault-text">
            <p className="font-semibold">Calibration Blocked</p>
            <p className="mt-1 text-[0.875rem]">{errorMsg}</p>
          </div>
        )}
      </section>

      {/* Calibration Results */}
      {!result ? (
        <div className="rounded-lg border border-line-subtle bg-surface p-6 text-center text-[0.9375rem] text-ink-muted">
          {UI_COPY.tab_calibrate_lab.empty_state}
        </div>
      ) : (
        <section className="space-y-5">
          {/* Circular Leak & Quarantine Summary */}
          {(result.hasTnLeakColumn || result.quarantinedRowCount > 0 || result.cnWarningCount > 0) && (
            <div className="space-y-3">
              {result.hasTnLeakColumn && (
                <div
                  role="status"
                  className="rounded-lg border border-warn-border bg-warn-bg p-4 text-warn-text"
                >
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                    <div>
                      <p className="font-semibold">
                        Circular TN_pct Column Detected and Excluded From Features
                      </p>
                      <p className="mt-1 text-[0.8125rem]">
                        Your CSV included a Total Nitrogen column (
                        {result.tnOmCorrelation !== null
                          ? `Pearson r vs OM = ${result.tnOmCorrelation.toFixed(4)}`
                          : "circular predictor risk"}
                        ). SOMSense blocked TN_pct from the predictor matrix to prevent target leakage.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {result.quarantinedRowCount > 0 && (
                <div
                  role="status"
                  className="rounded-lg border border-fault-border bg-fault-bg p-4 text-fault-text"
                >
                  <p className="font-semibold">
                    Quarantined {result.quarantinedRowCount} Faulted Calibration Row(s)
                  </p>
                  <p className="mt-1 text-[0.8125rem]">
                    Rows failing SENSOR_FAULT_CRITICAL (e.g. pH &lt; 3.0 or &gt; 10.0) were excluded from model fitting and GroupKFold scoring.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Validation Metrics Grid */}
          <div className="rounded-lg border border-line-subtle bg-surface p-4 sm:p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-[1.125rem] font-semibold text-ink-primary">
                  Local Calibration Summary ({result.modelEntry.selected_model_family})
                </h3>
                <p className="text-[0.8125rem] text-ink-muted">
                  CV: {result.modelEntry.metrics.cv_strategy} | Features:{" "}
                  {result.modelEntry.preprocessing.model_feature_order.length} standardized terms
                </p>
              </div>
              <div className="flex flex-wrap gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    onActivateLocalModel(result.modelEntry);
                    setActivatedId(result.modelEntry.model_id);
                  }}
                  className="somsense-transition inline-flex min-h-[44px] items-center gap-2 rounded-md bg-brand px-4 py-2 text-[0.875rem] font-semibold text-ink-inverse hover:bg-brand-hover"
                >
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  <span>
                    {activatedId === result.modelEntry.model_id
                      ? "Active in Predict & Diagnose"
                      : "Activate Local AEZ Model"}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    const payload = result.updatedRegistry ?? result.modelEntry;
                    triggerBrowserDownload(
                      `${result.modelEntry.model_id}_registry.json`,
                      JSON.stringify(payload, null, 2) + "\n",
                      "application/json"
                    );
                    onAnnounce("Downloaded updated registry JSON.");
                  }}
                  className="somsense-transition inline-flex min-h-[44px] items-center gap-2 rounded-md border border-line-input bg-sunken px-3.5 py-2 text-[0.8125rem] font-semibold text-ink-primary hover:bg-brand-soft"
                >
                  <FileCheck2 className="h-4 w-4" aria-hidden="true" />
                  <span>{UI_COPY.tab_calibrate_lab.download_registry_button}</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    triggerBrowserDownload(
                      `${result.modelEntry.model_id}_certificate.md`,
                      buildCertificateMarkdown(result),
                      "text/markdown;charset=utf-8"
                    );
                    onAnnounce("Downloaded calibration certificate.");
                  }}
                  className="somsense-transition inline-flex min-h-[44px] items-center gap-2 rounded-md border border-line-input bg-sunken px-3.5 py-2 text-[0.8125rem] font-semibold text-ink-primary hover:bg-brand-soft"
                >
                  <FileText className="h-4 w-4" aria-hidden="true" />
                  <span>Certificate (MD)</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-md border border-line-subtle bg-sunken p-3">
                <p className="text-[0.75rem] font-medium text-ink-muted">Held-Out GroupKFold RMSE</p>
                <p className="mt-1 font-mono text-[1.25rem] font-semibold text-ink-primary tabular-nums">
                  {result.modelEntry.metrics.rmse.toFixed(4)}% SOC
                </p>
                <p className="font-mono text-[0.7rem] text-ink-muted tabular-nums">
                  OLS: {result.olsMetrics.rmse.toFixed(4)} | Ridge: {result.ridgeMetrics.rmse.toFixed(4)}
                </p>
              </div>

              <div className="rounded-md border border-line-subtle bg-sunken p-3">
                <p className="text-[0.75rem] font-medium text-ink-muted">Held-Out GroupKFold R^2</p>
                <p className="mt-1 font-mono text-[1.25rem] font-semibold text-ink-primary tabular-nums">
                  {result.modelEntry.metrics.r2.toFixed(3)}
                </p>
                <p className="font-mono text-[0.7rem] text-ink-muted tabular-nums">
                  MAE: {result.modelEntry.metrics.mae.toFixed(4)}%
                </p>
              </div>

              <div className="rounded-md border border-line-subtle bg-sunken p-3">
                <p className="text-[0.75rem] font-medium text-ink-muted">Conformal 95% Coverage</p>
                <p className="mt-1 font-mono text-[1.25rem] font-semibold text-ink-primary tabular-nums">
                  {(result.modelEntry.uncertainty.empirical_coverage * 100).toFixed(1)}%
                </p>
                <p className="font-mono text-[0.7rem] text-ink-muted tabular-nums">
                  q_095 = +/- {result.modelEntry.uncertainty.q_095.toFixed(4)}%
                </p>
              </div>

              <div className="rounded-md border border-line-subtle bg-sunken p-3">
                <p className="text-[0.75rem] font-medium text-ink-muted">Valid Paired Rows</p>
                <p className="mt-1 font-mono text-[1.25rem] font-semibold text-ink-primary tabular-nums">
                  {result.validRowCount} / {result.rowSummaries.length}
                </p>
                <p className="font-mono text-[0.7rem] text-ink-muted tabular-nums">
                  {result.uniqueSiteCount} sites ({result.quarantinedRowCount} quarantined)
                </p>
              </div>
            </div>

            {/* Residual & Quarantine Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-left font-mono text-[0.8125rem] tabular-nums">
                <thead>
                  <tr className="border-b border-line-subtle text-ink-muted">
                    <th className="py-2 pr-3 font-sans">Row</th>
                    <th className="py-2 pr-3 font-sans">Site ID</th>
                    <th className="py-2 pr-3 font-sans">Depth (cm)</th>
                    <th className="py-2 pr-3 font-sans">Lab SOC (%)</th>
                    <th className="py-2 pr-3 font-sans">Predicted SOC (%)</th>
                    <th className="py-2 pr-3 font-sans">Residual</th>
                    <th className="py-2 font-sans">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rowSummaries.map((row) => (
                    <tr key={row.rowIndex} className="border-b border-line-subtle/60">
                      <td className="py-2 pr-3">{row.rowIndex}</td>
                      <td className="py-2 pr-3 font-sans font-medium text-ink-primary">
                        {row.siteId}
                      </td>
                      <td className="py-2 pr-3">{row.depthCm}</td>
                      <td className="py-2 pr-3">
                        {row.labSocPct !== null ? row.labSocPct.toFixed(3) : "---"}
                      </td>
                      <td className="py-2 pr-3">
                        {row.predictedSocPct !== null ? row.predictedSocPct.toFixed(3) : "---"}
                      </td>
                      <td className="py-2 pr-3">
                        {row.residual !== null
                          ? `${row.residual >= 0 ? "+" : ""}${row.residual.toFixed(3)}`
                          : "---"}
                      </td>
                      <td className="py-2 font-sans">
                        <span
                          className={`inline-block rounded px-2 py-0.5 text-[0.75rem] font-semibold ${
                            row.quarantined
                              ? "bg-fault-bg text-fault-text"
                              : row.status.startsWith("Warning")
                                ? "bg-warn-bg text-warn-text"
                                : "bg-brand-soft text-brand-softText"
                          }`}
                        >
                          {row.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
