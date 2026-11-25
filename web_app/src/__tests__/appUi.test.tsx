import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registryRawText from "../../public/models/registry.json?raw";
import { App } from "../App";

describe("SOMSense 3-Tab Field Ergonomic UI Integration", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => registryRawText,
      }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads verified registry, evaluates Healthy Kushtia Plot, and responds to Van Bemmelen k", async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("estimated-som-readout")).toHaveTextContent("2.18%");
    });

    expect(screen.getByTestId("domain-status-pill")).toHaveTextContent("In-Range");
    expect(screen.getByText(/Medium \(1\.7 - 3\.4% SOM\)/)).toBeInTheDocument();
    expect(screen.getByText(/Offline Engine Ready/)).toBeInTheDocument();

    // Update Van Bemmelen k from 1.724 to 2.0 -> SOC shifts while Kushtia OM stays 2.18%
    const kInput = screen.getByLabelText("Van Bemmelen k");
    fireEvent.change(kInput, { target: { value: "2.0" } });
    expect(screen.getByText(/Estimated SOC \(%\): 1\.09%/)).toBeInTheDocument();
  });

  it("blocks numeric output on cumilla 2 fault (pH=0.12, Humidity=100%) and OOD samples", async () => {
    render(<App />);
    await waitFor(() => screen.getByText("Load cumilla 2 Fault"));

    fireEvent.click(screen.getByText("Load cumilla 2 Fault"));
    expect(screen.getByTestId("estimated-som-readout")).toHaveTextContent("---");
    expect(screen.getByText("SENSOR_FAULT_CRITICAL")).toBeInTheDocument();
    expect(screen.getByText("SATURATION_DISTURBANCE_WARNING")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Load Out-of-Range Sample"));
    expect(screen.getByTestId("estimated-som-readout")).toHaveTextContent("---");
    expect(screen.getByText("OUTSIDE_CALIBRATION_RANGE")).toBeInTheDocument();
  });

  it("keeps accordions collapsed by default and safely strips __proto__ in Raw Telemetry JSON Import", async () => {
    render(<App />);
    await waitFor(() => screen.getByText("Raw Telemetry JSON Import and Sanitizer"));

    const rawToggle = screen.getByRole("button", {
      name: /Raw Telemetry JSON Import and Sanitizer/i,
    });
    expect(rawToggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(rawToggle);
    expect(rawToggle).toHaveAttribute("aria-expanded", "true");

    const textarea = screen.getByLabelText("Raw Sensor JSON Payload");
    fireEvent.change(textarea, {
      target: {
        value:
          '{"__proto__": {"polluted": true}, "Device": "ESRC Device - 1", "site": "cumilla 2", "PH": 0.12, "Humidity": 100, "EC": 1.48}',
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Parse and Validate JSON" }));

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(screen.getByText(/Stripped forbidden key\(s\): __proto__/i)).toBeInTheDocument();
    expect(screen.getByText("SENSOR_FAULT_CRITICAL")).toBeInTheDocument();
  });

  it("runs Tab 2 AEZ-19 & TN_pct leak calibration demo, activates model, and clears storage cleanly", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Offline Engine Ready")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("tab", { name: "Calibrate Lab Data" }));
    fireEvent.click(screen.getByRole("button", { name: /Run AEZ-19 & TN_pct Leak Demo/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/Circular TN_pct Column Detected and Excluded From Features/i)
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/Quarantined 1 Faulted Calibration Row/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Activate Local AEZ Model" }));
    await waitFor(() => {
      expect(screen.getByTestId("estimated-som-readout")).toBeInTheDocument();
    });

    // Clear Local Storage privacy reset
    fireEvent.click(screen.getByRole("button", { name: "Clear Local Storage" }));
    expect(localStorage.length).toBe(0);
  });

  it("renders Tab 3 POXC calculator in mg C/kg dry soil, Passive C guardrail, and Dark Mode toggle", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("Offline Engine Ready")).toBeInTheDocument());

    // Toggle Dark Mode
    const themeBtn = screen.getByRole("button", { name: "Lab Dark" });
    fireEvent.click(themeBtn);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    fireEvent.click(screen.getByRole("tab", { name: "Science & POXC" }));
    fireEvent.click(screen.getByRole("button", { name: /Load USDA Sample 64511/i }));

    expect(screen.getByTestId("poxc-readout")).toHaveTextContent("mg C/kg dry soil");
    expect(screen.getByText(/Passive C != Total SOC - POXC/)).toBeInTheDocument();
    expect(
      screen.getByText(/SRDI Kushtia: Circular TN_pct Leakage \(0\.953\) vs Honest CV \(0\.173\)/)
    ).toBeInTheDocument();
  });
});
