import {
  CheckCircle2,
  HardDriveDownload,
  Layers,
  Moon,
  OctagonAlert,
  Sun,
  Trash2,
  WifiOff,
} from "lucide-react";
import { NAVIGATION_TABS, UI_COPY } from "../copy/uiCopy";
import type { TabId, ThemeMode } from "../engine/types";

interface AppHeaderProps {
  theme: ThemeMode;
  onToggleTheme: () => void;
  activeTab: TabId;
  onSelectTab: (tab: TabId) => void;
  isOnline: boolean;
  registryState: "loading" | "ready" | "error";
  lastInferenceMs: number | null;
  localModelCount: number;
  onClearLocalStorage: () => void;
}

export function AppHeader({
  theme,
  onToggleTheme,
  activeTab,
  onSelectTab,
  isOnline,
  registryState,
  lastInferenceMs,
  localModelCount,
  onClearLocalStorage,
}: AppHeaderProps) {
  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, idx: number): void => {
    const count = NAVIGATION_TABS.length;
    let nextIdx: number | null = null;
    if (event.key === "ArrowRight") nextIdx = (idx + 1) % count;
    else if (event.key === "ArrowLeft") nextIdx = (idx - 1 + count) % count;
    else if (event.key === "Home") nextIdx = 0;
    else if (event.key === "End") nextIdx = count - 1;

    if (nextIdx !== null) {
      event.preventDefault();
      const targetTab = NAVIGATION_TABS[nextIdx];
      if (targetTab) {
        onSelectTab(targetTab.id);
        const el = document.getElementById(`tab-${targetTab.id}`);
        el?.focus();
      }
    }
  };

  return (
    <header className="no-print border-b border-line-subtle bg-surface">
      <div className="mx-auto max-w-[1280px] px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-brand text-ink-inverse"
              aria-hidden="true"
            >
              <Layers className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-[1.25rem] sm:text-[1.5rem] font-semibold leading-tight text-ink-primary">
                {UI_COPY.app_shell.brand_title}
              </h1>
              <p className="truncate text-[0.8125rem] font-medium text-ink-muted">
                {UI_COPY.app_shell.brand_subtitle}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Offline & Verification Pill */}
            <div
              className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-full border px-3 py-1 text-[0.8125rem] font-medium ${
                registryState === "error"
                  ? "border-fault-border bg-fault-bg text-fault-text"
                  : !isOnline
                    ? "border-warn-border bg-warn-bg text-warn-text"
                    : "border-line-subtle bg-brand-soft text-brand-softText"
              }`}
              role="status"
            >
              {registryState === "error" ? (
                <OctagonAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
              ) : !isOnline ? (
                <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
              ) : registryState === "loading" ? (
                <HardDriveDownload className="h-4 w-4 shrink-0" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              <span>
                {registryState === "error"
                  ? "Integrity Check Failed"
                  : registryState === "loading"
                    ? UI_COPY.app_shell.offline_badge_syncing
                    : !isOnline
                      ? UI_COPY.app_shell.offline_badge_browser_offline
                      : UI_COPY.app_shell.offline_badge_ready}
              </span>
            </div>

            {/* Sub-50ms Latency Pill */}
            {lastInferenceMs !== null && (
              <div className="inline-flex min-h-[36px] items-center rounded-full border border-line-subtle bg-sunken px-3 py-1 font-mono text-[0.8125rem] font-medium text-ink-secondary tabular-nums">
                {UI_COPY.app_shell.latency_readout_template.replace(
                  "{ms}",
                  lastInferenceMs.toFixed(2)
                )}
              </div>
            )}

            {/* Theme Toggle */}
            <button
              type="button"
              onClick={onToggleTheme}
              aria-pressed={theme === "dark"}
              className="somsense-transition inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-2 rounded-md border border-line-input bg-surface px-3 py-2 text-[0.8125rem] font-medium text-ink-primary hover:bg-sunken"
            >
              {theme === "dark" ? (
                <>
                  <Sun className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{UI_COPY.app_shell.theme_toggle_light}</span>
                </>
              ) : (
                <>
                  <Moon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{UI_COPY.app_shell.theme_toggle_dark}</span>
                </>
              )}
            </button>

            {/* 1-Click Privacy Reset */}
            <button
              type="button"
              onClick={onClearLocalStorage}
              title={
                localModelCount > 0
                  ? `Clear ${localModelCount} local calibrated model(s) and form memory`
                  : "Clear locally saved calibration data and form inputs"
              }
              className="somsense-transition inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-md border border-line-input bg-surface px-3 py-2 text-[0.8125rem] font-medium text-ink-secondary hover:bg-sunken hover:text-ink-primary"
            >
              <Trash2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{UI_COPY.app_shell.clear_storage_label}</span>
            </button>
          </div>
        </div>

        {/* 3-Tab Navigation Bar (48px touch targets) */}
        <nav
          aria-label="SOMSense Workspaces"
          className="mt-3 flex flex-wrap gap-2 border-t border-line-subtle pt-3"
        >
          <div role="tablist" className="flex w-full flex-wrap gap-2 sm:w-auto">
            {NAVIGATION_TABS.map((tab, idx) => {
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  id={`tab-${tab.id}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`panel-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => onSelectTab(tab.id)}
                  onKeyDown={(e) => handleTabKeyDown(e, idx)}
                  className={`somsense-transition min-h-[48px] flex-1 sm:flex-none rounded-md border px-4 py-2 text-left text-[0.9375rem] font-semibold ${
                    selected
                      ? "border-brand bg-brand text-ink-inverse"
                      : "border-line-subtle bg-sunken text-ink-primary hover:border-line-input hover:bg-surface"
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </nav>
      </div>
    </header>
  );
}
