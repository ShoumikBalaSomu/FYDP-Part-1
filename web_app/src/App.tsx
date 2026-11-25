import { useCallback, useEffect, useMemo, useState } from "react";
import { AppHeader } from "./components/AppHeader";
import { CalibrateLabTab } from "./components/CalibrateLabTab";
import { PredictDiagnoseTab } from "./components/PredictDiagnoseTab";
import { SciencePoxcTab } from "./components/SciencePoxcTab";
import { UI_COPY } from "./copy/uiCopy";
import {
  clearAllLocalStorageAndCaches,
  fetchAndVerifyRegistry,
  loadLocalCalibratedModels,
  saveLocalCalibratedModel,
} from "./engine/registryLoader";
import type { ModelEntry, ModelRegistry, TabId, ThemeMode } from "./engine/types";

export function App() {
  const [theme, setTheme] = useState<ThemeMode>("light");
  const [activeTab, setActiveTab] = useState<TabId>("predict_diagnose");
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [registry, setRegistry] = useState<ModelRegistry | null>(null);
  const [registryState, setRegistryState] = useState<"loading" | "ready" | "error">("loading");
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [localModels, setLocalModels] = useState<Record<string, ModelEntry>>(() =>
    loadLocalCalibratedModels()
  );
  const [activeModelId, setActiveModelId] = useState<string>("srdi_kushtia_om_champion");
  const [lastInferenceMs, setLastInferenceMs] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [resetGeneration, setResetGeneration] = useState(0);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    const onOnline = (): void => setIsOnline(true);
    const onOffline = (): void => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setRegistryState("loading");
    fetchAndVerifyRegistry("./models/registry.json")
      .then((verified) => {
        if (cancelled) return;
        setRegistry(verified.registry);
        setRegistryState("ready");
        setRegistryError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRegistryState("error");
        setRegistryError(
          err instanceof Error ? err.message : UI_COPY.error_states.registry_checksum_failed
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const mergedModels = useMemo<Record<string, ModelEntry>>(() => {
    return {
      ...localModels,
      ...(registry?.models ?? {}),
    };
  }, [registry, localModels]);

  const handleToggleTheme = useCallback((): void => {
    setTheme((prev) => {
      const next: ThemeMode = prev === "light" ? "dark" : "light";
      setAnnouncement(
        `Switched appearance to ${
          next === "dark" ? UI_COPY.app_shell.theme_toggle_dark : UI_COPY.app_shell.theme_toggle_light
        }.`
      );
      return next;
    });
  }, []);

  const handleActivateLocalModel = useCallback((entry: ModelEntry): void => {
    saveLocalCalibratedModel(entry);
    setLocalModels((prev) => ({ ...prev, [entry.model_id]: entry }));
    setActiveModelId(entry.model_id);
    setActiveTab("predict_diagnose");
    setAnnouncement(`Activated local calibrated model ${entry.model_id}.`);
  }, []);

  const handleClearLocalStorage = useCallback((): void => {
    clearAllLocalStorageAndCaches();
    setLocalModels({});
    setActiveModelId("srdi_kushtia_om_champion");
    setLastInferenceMs(null);
    setResetGeneration((g) => g + 1);
    setAnnouncement("Cleared all locally stored calibration models and browser state.");
  }, []);

  return (
    <div className="min-h-screen flex flex-col bg-canvas text-ink-primary">
      <a href="#main-workspace" className="skip-link">
        {UI_COPY.app_shell.skip_to_main}
      </a>

      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>

      <AppHeader
        theme={theme}
        onToggleTheme={handleToggleTheme}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        isOnline={isOnline}
        registryState={registryState}
        lastInferenceMs={lastInferenceMs}
        localModelCount={Object.keys(localModels).length}
        onClearLocalStorage={handleClearLocalStorage}
      />

      <main id="main-workspace" className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-6 sm:px-6">
        {registryState === "error" && (
          <div
            role="alert"
            className="mb-6 rounded-lg border border-fault-border bg-fault-bg p-4 text-fault-text"
          >
            <p className="font-semibold">{UI_COPY.error_states.registry_checksum_failed}</p>
            {registryError && <p className="mt-1 font-mono text-[0.8125rem]">{registryError}</p>}
          </div>
        )}

        {registryState === "loading" ? (
          <div className="rounded-lg border border-line-subtle bg-surface p-8 text-center text-[0.9375rem] text-ink-muted">
            Verifying offline model registry SHA-256 checksum...
          </div>
        ) : (
          <>
            {activeTab === "predict_diagnose" && (
              <PredictDiagnoseTab
                key={`predict-${resetGeneration}`}
                models={mergedModels}
                activeModelId={activeModelId}
                onSelectModelId={setActiveModelId}
                guardrails={registry?.hardware_physics_guardrails}
                theme={theme}
                onAnnounce={setAnnouncement}
                onRecordInferenceMs={setLastInferenceMs}
              />
            )}

            {activeTab === "calibrate_lab" && (
              <CalibrateLabTab
                key={`calibrate-${resetGeneration}`}
                baseRegistry={registry}
                onActivateLocalModel={handleActivateLocalModel}
                onAnnounce={setAnnouncement}
              />
            )}

            {activeTab === "science_poxc" && <SciencePoxcTab registry={registry} />}
          </>
        )}
      </main>

      <footer className="no-print border-t border-line-subtle bg-surface py-4">
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-2 px-4 text-[0.75rem] text-ink-muted sm:px-6">
          <p>{UI_COPY.app_shell.footer_provenance}</p>
          {registry && (
            <p className="font-mono">
              Registry SHA-256: {registry.integrity.canonical_payload_sha256.slice(0, 16)}...
            </p>
          )}
        </div>
      </footer>
    </div>
  );
}

export default App;
