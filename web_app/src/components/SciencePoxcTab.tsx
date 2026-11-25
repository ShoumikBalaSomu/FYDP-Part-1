import { AlertTriangle, CheckCircle2, Compass, OctagonAlert, ShieldAlert } from "lucide-react";
import { useId, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { UI_COPY } from "../copy/uiCopy";
import { normalizeEsrcRecord } from "../engine/esrcAdapter";
import { runPoxcPrediction } from "../engine/inferenceEngine";
import { socGKgToPct } from "../engine/soilPhysics";
import type { ModelRegistry, SOCUnit } from "../engine/types";

interface SciencePoxcTabProps {
  registry: ModelRegistry | null;
}

export function SciencePoxcTab({ registry }: SciencePoxcTabProps) {
  const idPrefix = useId();
  const [useLabSoc, setUseLabSoc] = useState(true);
  const [socValue, setSocValue] = useState("28.0");
  const [socUnit, setSocUnit] = useState<SOCUnit>("g/kg");
  const [ph, setPh] = useState("6.5");
  const [sand, setSand] = useState("25.0");
  const [silt, setSilt] = useState("45.0");
  const [clay, setClay] = useState("30.0");
  const [depthMid, setDepthMid] = useState("5.0");

  const [stratumModelId, setStratumModelId] = useState<string>("srdi_kushtia_om_champion");

  const poxcModel = useMemo(() => {
    if (!registry) return null;
    const key = useLabSoc ? "usda_kssl_poxc_with_soc" : "usda_kssl_poxc_without_soc";
    return registry.models[key] ?? null;
  }, [registry, useLabSoc]);

  const poxcResult = useMemo(() => {
    if (!poxcModel || !registry) return null;
    try {
      const parsedSoc = socValue.trim() === "" ? null : Number(socValue);
      const effectiveSocPct =
        parsedSoc !== null && Number.isFinite(parsedSoc)
          ? socUnit === "g/kg"
            ? socGKgToPct(parsedSoc)
            : parsedSoc
          : null;

      const { reading } = normalizeEsrcRecord({
        site_id: "usda-kssl-pedon",
        pH: Number(ph),
        sand_pct: Number(sand),
        silt_pct: Number(silt),
        clay_pct: Number(clay),
        depth_mid_cm: Number(depthMid),
      });

      return runPoxcPrediction(
        poxcModel,
        reading,
        useLabSoc ? effectiveSocPct : null,
        registry.hardware_physics_guardrails
      );
    } catch {
      return null;
    }
  }, [poxcModel, registry, socValue, socUnit, ph, sand, silt, clay, depthMid, useLabSoc]);

  // Chart 1 data: SRDI Kushtia TN_pct leakage audit
  const leakageChartData = useMemo(() => {
    if (!registry) return [];
    const tn = registry.leakage_and_quality_audits.srdi_tn_leakage;
    const champ = registry.models.srdi_kushtia_om_champion;
    return [
      {
        label: "With TN (Random)",
        r2: Number(tn.with_tn_random_r2.toFixed(3)),
        leaked: true,
      },
      {
        label: "With TN (GroupKFold)",
        r2: Number(tn.with_tn_group_r2.toFixed(3)),
        leaked: true,
      },
      {
        label: "No TN (Random OLS)",
        r2: Number(tn.without_tn_random_r2.toFixed(3)),
        leaked: false,
      },
      {
        label: "No TN (Group OLS)",
        r2: Number(tn.without_tn_group_r2.toFixed(3)),
        leaked: false,
      },
      {
        label: "Champion HGB (Honest)",
        r2: Number((champ?.metrics.r2 ?? 0.173).toFixed(3)),
        leaked: false,
      },
    ];
  }, [registry]);

  // Chart 2 data: Kaggle 5-feature mineral-only comparison
  const kaggleChartData = useMemo(() => {
    const kaggleModel = registry?.models.kaggle_mineral_oc_benchmark;
    if (!kaggleModel) return [];
    return kaggleModel.metrics.model_comparison.map((row) => ({
      model: row.model_name.replace(/_/g, " "),
      r2: Number(row.r2.toFixed(4)),
      rmse: Number(row.rmse.toFixed(4)),
    }));
  }, [registry]);

  // Chart 3 data: Stratified errors
  const stratifiedChartData = useMemo(() => {
    const model = registry?.models[stratumModelId];
    if (!model) return [];
    return model.explainability.stratified_errors.map((s) => ({
      stratum: `${s.stratum_value} (n=${s.n})`,
      rmse: Number(s.rmse.toFixed(4)),
      mae: Number(s.mae.toFixed(4)),
      n: s.n,
      r2: s.r2,
    }));
  }, [registry, stratumModelId]);

  const loadUsdaSample64511 = (): void => {
    setUseLabSoc(true);
    setSocUnit("g/kg");
    setSocValue("28.0");
    setPh("6.5");
    setSand("25.0");
    setSilt("45.0");
    setClay("30.0");
    setDepthMid("5.0");
  };

  return (
    <div id="panel-science_poxc" role="tabpanel" aria-labelledby="tab-science_poxc" className="space-y-6">
      {/* Scientific Pathway Summary */}
      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-line-subtle bg-surface p-5">
          <h2 className="text-[1.125rem] font-semibold text-ink-primary">
            {UI_COPY.tab_science_poxc.fizar_pathway_title}
          </h2>
          <p className="mt-2 text-[0.9375rem] text-ink-secondary">
            {UI_COPY.tab_science_poxc.fizar_pathway_body}
          </p>
        </div>

        <div className="rounded-lg border border-line-subtle bg-surface p-5">
          <h2 className="text-[1.125rem] font-semibold text-ink-primary">
            {UI_COPY.tab_science_poxc.mineral_only_proof_title}
          </h2>
          <p className="mt-2 text-[0.9375rem] text-ink-secondary">
            {UI_COPY.tab_science_poxc.mineral_only_proof_body}
          </p>
        </div>
      </section>

      {/* Isolated Active Carbon (POXC) Calculator */}
      <section aria-labelledby="poxc-heading" className="rounded-lg border border-line-subtle bg-surface p-4 sm:p-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line-subtle pb-4">
          <div className="max-w-2xl">
            <h2 id="poxc-heading" className="text-[1.125rem] font-semibold text-ink-primary">
              {UI_COPY.tab_science_poxc.poxc_section_title}
            </h2>
            <p className="mt-1 text-[0.875rem] text-ink-secondary">
              {UI_COPY.tab_science_poxc.poxc_section_body}
            </p>
          </div>
          <button
            type="button"
            onClick={loadUsdaSample64511}
            className="somsense-transition min-h-[44px] rounded-md border border-brand bg-brand-soft px-3.5 py-2 text-[0.8125rem] font-semibold text-brand-softText hover:bg-brand hover:text-ink-inverse"
          >
            Load USDA Sample 64511 (28.0 g/kg -&gt; 2.80% SOC)
          </button>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* POXC Inputs */}
          <div className="lg:col-span-6 space-y-4">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                aria-pressed={useLabSoc}
                onClick={() => setUseLabSoc(true)}
                className={`min-h-[44px] flex-1 rounded-md border px-3 py-2 text-[0.8125rem] font-semibold ${
                  useLabSoc
                    ? "border-brand bg-brand text-ink-inverse"
                    : "border-line-subtle bg-sunken text-ink-primary"
                }`}
              >
                With Lab SOC (ElasticNet, R2=0.749)
              </button>
              <button
                type="button"
                aria-pressed={!useLabSoc}
                onClick={() => setUseLabSoc(false)}
                className={`min-h-[44px] flex-1 rounded-md border px-3 py-2 text-[0.8125rem] font-semibold ${
                  !useLabSoc
                    ? "border-brand bg-brand text-ink-inverse"
                    : "border-line-subtle bg-sunken text-ink-primary"
                }`}
              >
                Without SOC (RandomForest, R2=0.184)
              </button>
            </div>

            {useLabSoc && (
              <div>
                <label
                  htmlFor={`${idPrefix}-poxc-soc`}
                  className="block text-[0.8125rem] font-medium text-ink-secondary mb-1"
                >
                  Laboratory SOC (auto-fixes USDA g/kg 10x bug)
                </label>
                <div className="flex gap-2">
                  <input
                    id={`${idPrefix}-poxc-soc`}
                    inputMode="decimal"
                    value={socValue}
                    onChange={(e) => setSocValue(e.target.value)}
                    className="min-h-[48px] w-full rounded-md border border-line-input bg-surface px-3 font-mono text-[1rem] text-ink-primary tabular-nums"
                  />
                  <select
                    aria-label="POXC SOC unit"
                    value={socUnit}
                    onChange={(e) => setSocUnit(e.target.value as SOCUnit)}
                    className="min-h-[48px] shrink-0 rounded-md border border-line-input bg-sunken px-2.5 text-[0.875rem] font-medium text-ink-primary"
                  >
                    <option value="g/kg">g C/kg (/ 10)</option>
                    <option value="%">% SOC</option>
                  </select>
                </div>
                {socUnit === "g/kg" && Number.isFinite(Number(socValue)) && (
                  <p className="mt-1 font-mono text-[0.75rem] text-ink-muted tabular-nums">
                    Converted to %SOC: {socGKgToPct(Number(socValue)).toFixed(2)}%
                  </p>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor={`${idPrefix}-poxc-ph`} className="block text-[0.8125rem] font-medium text-ink-secondary mb-1">
                  Soil pH
                </label>
                <input
                  id={`${idPrefix}-poxc-ph`}
                  inputMode="decimal"
                  value={ph}
                  onChange={(e) => setPh(e.target.value)}
                  className="min-h-[48px] w-full rounded-md border border-line-input bg-surface px-3 font-mono text-[1rem] text-ink-primary tabular-nums"
                />
              </div>
              <div>
                <label htmlFor={`${idPrefix}-poxc-depth`} className="block text-[0.8125rem] font-medium text-ink-secondary mb-1">
                  Depth Mid (cm)
                </label>
                <input
                  id={`${idPrefix}-poxc-depth`}
                  inputMode="decimal"
                  value={depthMid}
                  onChange={(e) => setDepthMid(e.target.value)}
                  className="min-h-[48px] w-full rounded-md border border-line-input bg-surface px-3 font-mono text-[1rem] text-ink-primary tabular-nums"
                />
              </div>
              <div>
                <label htmlFor={`${idPrefix}-poxc-sand`} className="block text-[0.8125rem] font-medium text-ink-secondary mb-1">
                  Sand (%)
                </label>
                <input
                  id={`${idPrefix}-poxc-sand`}
                  inputMode="decimal"
                  value={sand}
                  onChange={(e) => setSand(e.target.value)}
                  className="min-h-[48px] w-full rounded-md border border-line-input bg-surface px-3 font-mono text-[1rem] text-ink-primary tabular-nums"
                />
              </div>
              <div>
                <label htmlFor={`${idPrefix}-poxc-silt`} className="block text-[0.8125rem] font-medium text-ink-secondary mb-1">
                  Silt (%)
                </label>
                <input
                  id={`${idPrefix}-poxc-silt`}
                  inputMode="decimal"
                  value={silt}
                  onChange={(e) => setSilt(e.target.value)}
                  className="min-h-[48px] w-full rounded-md border border-line-input bg-surface px-3 font-mono text-[1rem] text-ink-primary tabular-nums"
                />
              </div>
              <div>
                <label htmlFor={`${idPrefix}-poxc-clay`} className="block text-[0.8125rem] font-medium text-ink-secondary mb-1">
                  Clay (%)
                </label>
                <input
                  id={`${idPrefix}-poxc-clay`}
                  inputMode="decimal"
                  value={clay}
                  onChange={(e) => setClay(e.target.value)}
                  className="min-h-[48px] w-full rounded-md border border-line-input bg-surface px-3 font-mono text-[1rem] text-ink-primary tabular-nums"
                />
              </div>
            </div>
          </div>

          {/* POXC Output + Guardrail */}
          <div className="lg:col-span-6 space-y-4">
            <div className="rounded-lg border border-line-subtle bg-sunken p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-[0.8125rem] font-medium text-ink-secondary">
                    {UI_COPY.tab_science_poxc.poxc_estimator.output_label}
                  </p>
                  <p
                    data-testid="poxc-readout"
                    className="mt-1 font-mono text-[2rem] font-semibold text-ink-primary tabular-nums"
                  >
                    {!poxcResult || poxcResult.blocked || poxcResult.estimatedPoxcMgKg === null
                      ? "---"
                      : `${poxcResult.estimatedPoxcMgKg.toFixed(1)} mg C/kg dry soil`}
                  </p>
                </div>

                {poxcResult && (
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[0.75rem] font-semibold ${
                      poxcResult.blocked
                        ? "border-fault-border bg-fault-bg text-fault-text"
                        : poxcResult.calibrationDomainStatus === "In-Range"
                          ? "border-brand bg-brand-soft text-brand-softText"
                          : poxcResult.calibrationDomainStatus === "Caution"
                            ? "border-warn-border bg-warn-bg text-warn-text"
                            : "border-ood-border bg-ood-bg text-ood-text"
                    }`}
                  >
                    {poxcResult.blocked ? (
                      <OctagonAlert className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : poxcResult.calibrationDomainStatus === "In-Range" ? (
                      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : poxcResult.calibrationDomainStatus === "Caution" ? (
                      <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <Compass className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    <span>
                      {poxcResult.blocked
                        ? poxcResult.blockReason
                        : poxcResult.calibrationDomainStatus}
                    </span>
                  </span>
                )}
              </div>

              {poxcResult && !poxcResult.blocked && (
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 font-mono text-[0.8125rem] tabular-nums">
                  <div>
                    <span className="font-sans text-ink-muted">95% PI: </span>
                    <span className="font-semibold text-ink-primary">
                      [{poxcResult.poxcCi95Lower?.toFixed(1)}, {poxcResult.poxcCi95Upper?.toFixed(1)}] mg C/kg
                    </span>
                  </div>
                  <div>
                    <span className="font-sans text-ink-muted">POXC:SOC Ratio: </span>
                    <span className="font-semibold text-ink-primary">
                      {poxcResult.poxcToSocRatio !== null
                        ? poxcResult.poxcToSocRatio.toFixed(4)
                        : "N/A (no SOC input)"}
                    </span>
                  </div>
                </div>
              )}
              <p className="mt-2 text-[0.75rem] text-ink-muted">
                {UI_COPY.tab_science_poxc.poxc_estimator.ratio_note}
              </p>
            </div>

            {/* Passive C != Total SOC - POXC Guardrail */}
            <div
              role="note"
              className="rounded-lg border border-warn-border bg-warn-bg p-4 text-warn-text"
            >
              <div className="flex items-start gap-2.5">
                <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                <div>
                  <h3 className="text-[0.9375rem] font-semibold">
                    {UI_COPY.tab_science_poxc.passive_c_guardrail_title} (Passive C != Total SOC - POXC)
                  </h3>
                  <p className="mt-1 text-[0.8125rem]">
                    {UI_COPY.tab_science_poxc.passive_c_guardrail_body}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Leakage & Benchmark Lab Charts */}
      <section aria-labelledby="lab-charts-heading" className="space-y-5">
        <h2 id="lab-charts-heading" className="text-[1.125rem] font-semibold text-ink-primary">
          Leakage and Benchmark Lab
        </h2>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {/* Chart 1: SRDI Kushtia TN_pct Leakage */}
          <div className="min-w-0 rounded-lg border border-line-subtle bg-surface p-4 sm:p-5">
            <h3 className="text-[0.9375rem] font-semibold text-ink-primary">
              SRDI Kushtia: Circular TN_pct Leakage (0.953) vs Honest CV (0.173)
            </h3>
            <p className="mt-1 font-mono text-[0.75rem] text-ink-muted">
              {registry?.leakage_and_quality_audits.srdi_tn_leakage.tn_om_formula} (r ={" "}
              {registry?.leakage_and_quality_audits.srdi_tn_leakage.tn_om_correlation.toFixed(4)})
            </p>
            <div className="mt-4 h-[240px] w-full min-w-0">
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={leakageChartData} margin={{ top: 10, right: 16, left: 0, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: "var(--text-secondary)", fontSize: 11 }}
                    interval={0}
                    angle={-15}
                    textAnchor="end"
                    height={55}
                  />
                  <YAxis domain={[0, 1]} tick={{ fill: "var(--text-secondary)", fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "var(--bg-surface-elevated)",
                      borderColor: "var(--border-subtle)",
                      color: "var(--text-primary)",
                    }}
                  />
                  <Bar dataKey="r2" name="CV R^2" radius={[4, 4, 0, 0]}>
                    {leakageChartData.map((entry, idx) => (
                      <Cell
                        key={`leak-${idx}`}
                        fill={entry.leaked ? "var(--chart-negative)" : "var(--chart-positive)"}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Chart 2: Kaggle 5-Feature Negative R^2 */}
          <div className="min-w-0 rounded-lg border border-line-subtle bg-surface p-4 sm:p-5">
            <h3 className="text-[0.9375rem] font-semibold text-ink-primary">
              Kaggle Mineral-Only Benchmark (873 Clean Rows, N/P/K/pH/EC Only)
            </h3>
            <p className="mt-1 text-[0.75rem] text-ink-muted">
              All 7 model families yield negative held-out R^2 without T, Moisture, or local AEZ covariates. (7 corrupt rows removed.)
            </p>
            <div className="mt-4 h-[240px] w-full min-w-0">
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={kaggleChartData} margin={{ top: 10, right: 16, left: 0, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                  <XAxis
                    dataKey="model"
                    tick={{ fill: "var(--text-secondary)", fontSize: 11 }}
                    interval={0}
                    angle={-18}
                    textAnchor="end"
                    height={60}
                  />
                  <YAxis tick={{ fill: "var(--text-secondary)", fontSize: 12 }} />
                  <ReferenceLine y={0} stroke="var(--text-muted)" />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "var(--bg-surface-elevated)",
                      borderColor: "var(--border-subtle)",
                      color: "var(--text-primary)",
                    }}
                  />
                  <Bar dataKey="r2" name="5-Fold R^2" fill="var(--chart-negative)" radius={[0, 0, 4, 4]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Chart 3: Stratified Errors across Depth / Texture / Soil Order */}
        <div className="min-w-0 rounded-lg border border-line-subtle bg-surface p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-[0.9375rem] font-semibold text-ink-primary">
                Stratified Error Audit by Depth, Texture, and Soil Order
              </h3>
              <p className="text-[0.8125rem] text-ink-muted">
                Inspect held-out RMSE and MAE across agronomic subgroups.
              </p>
            </div>
            <select
              aria-label="Select model for stratified errors"
              value={stratumModelId}
              onChange={(e) => setStratumModelId(e.target.value)}
              className="min-h-[44px] rounded-md border border-line-input bg-sunken px-3 text-[0.875rem] font-medium text-ink-primary"
            >
              <option value="srdi_kushtia_om_champion">SRDI Kushtia (Depth / Texture / Land Use)</option>
              <option value="kaggle_mineral_oc_benchmark">Kaggle Mineral (pH Band / Class)</option>
              <option value="usda_kssl_poxc_with_soc">USDA KSSL POXC (Soil Order / Depth)</option>
            </select>
          </div>

          <div className="h-[240px] w-full min-w-0">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={stratifiedChartData} margin={{ top: 10, right: 16, left: 0, bottom: 25 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                <XAxis
                  dataKey="stratum"
                  tick={{ fill: "var(--text-secondary)", fontSize: 11 }}
                  interval={0}
                  angle={-15}
                  textAnchor="end"
                  height={60}
                />
                <YAxis tick={{ fill: "var(--text-secondary)", fontSize: 12 }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--bg-surface-elevated)",
                    borderColor: "var(--border-subtle)",
                    color: "var(--text-primary)",
                  }}
                />
                <Legend />
                <Bar dataKey="rmse" name="RMSE" fill="var(--chart-positive)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="mae" name="MAE" fill="var(--chart-neutral)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      {/* Dataset Provenance Cards */}
      <section aria-labelledby="datasets-heading" className="space-y-3">
        <h2 id="datasets-heading" className="text-[1.125rem] font-semibold text-ink-primary">
          {UI_COPY.tab_science_poxc.datasets_heading}
        </h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {UI_COPY.tab_science_poxc.dataset_cards.map((card, idx) => (
            <div key={idx} className="rounded-lg border border-line-subtle bg-surface p-4">
              <h3 className="text-[0.9375rem] font-semibold text-ink-primary">{card.name}</h3>
              <p className="mt-1.5 text-[0.8125rem] text-ink-secondary">{card.detail}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
