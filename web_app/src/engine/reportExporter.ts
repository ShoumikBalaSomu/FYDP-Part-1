import { sanitizeSpreadsheetCell } from "./esrcAdapter";
import type { InferencePredictionResult, ModelEntry, SoilReadingInput } from "./types";

function escapeCsvField(raw: string): string {
  const safe = sanitizeSpreadsheetCell(raw);
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function exportReadingToSafeCsv(
  reading: SoilReadingInput,
  prediction: InferencePredictionResult,
  model: ModelEntry,
  notes = ""
): string {
  const headers = [
    "timestamp",
    "site_id",
    "device_id",
    "aez_zone",
    "depth_cm",
    "texture_class",
    "crop",
    "nitrogen_mg_kg",
    "phosphorus_mg_kg",
    "potassium_mg_kg",
    "ph",
    "ec_ds_m",
    "temperature_c",
    "moisture_pct",
    "estimated_som_pct",
    "estimated_soc_pct",
    "som_ci95_lower",
    "som_ci95_upper",
    "van_bemmelen_k",
    "fertility_class_barc",
    "calibration_domain_status",
    "mahalanobis_d2",
    "model_id",
    "model_version",
    "artifact_sha256",
    "blocked",
    "block_reason",
    "active_flags",
    "notes",
  ];

  const fmtNum = (n: number | null | undefined, digits = 4): string =>
    n === null || n === undefined || !Number.isFinite(n) ? "" : n.toFixed(digits);

  const row = [
    reading.timestamp ?? new Date().toISOString(),
    reading.raw_site_id ?? reading.site_id ?? "",
    reading.raw_device_id ?? reading.device_id ?? "",
    reading.aez_zone ?? "",
    reading.depth_cm ?? "",
    reading.texture_class ?? "",
    reading.crop ?? "",
    fmtNum(reading.nitrogen_mg_kg, 2),
    fmtNum(reading.phosphorus_mg_kg, 2),
    fmtNum(reading.potassium_mg_kg, 2),
    fmtNum(reading.ph, 2),
    fmtNum(reading.ec_ds_m, 3),
    fmtNum(reading.temperature_c, 2),
    fmtNum(reading.moisture_pct, 2),
    fmtNum(prediction.estimatedSomPct, 4),
    fmtNum(prediction.estimatedSocPct, 4),
    fmtNum(prediction.somCi95Lower, 4),
    fmtNum(prediction.somCi95Upper, 4),
    fmtNum(prediction.vanBemmelenK, 3),
    prediction.fertilityClassBarc ?? "",
    prediction.calibrationDomainStatus,
    fmtNum(prediction.oodAssessment.mahalanobisD2, 3),
    model.model_id,
    model.model_version,
    model.artifact_sha256,
    String(prediction.blocked),
    prediction.blockReason ?? "",
    prediction.physicsReport.flags.map((f) => f.code).join("; "),
    notes,
  ];

  return `${headers.join(",")}\n${row.map(escapeCsvField).join(",")}\n`;
}

export function exportReadingToJsonBundle(
  reading: SoilReadingInput,
  prediction: InferencePredictionResult,
  model: ModelEntry
): string {
  const bundle = {
    schema_version: "1.0.0",
    exported_at_utc: new Date().toISOString(),
    platform: "SOMSense-ESRC",
    input_telemetry: {
      ...reading,
      site_id: sanitizeSpreadsheetCell(reading.raw_site_id ?? reading.site_id ?? ""),
      device_id: sanitizeSpreadsheetCell(reading.raw_device_id ?? reading.device_id ?? ""),
      crop: reading.crop ? sanitizeSpreadsheetCell(reading.crop) : null,
    },
    prediction_summary: {
      blocked: prediction.blocked,
      block_reason: prediction.blockReason,
      estimated_som_pct: prediction.estimatedSomPct,
      estimated_soc_pct: prediction.estimatedSocPct,
      som_ci95_lower: prediction.somCi95Lower,
      som_ci95_upper: prediction.somCi95Upper,
      van_bemmelen_k: prediction.vanBemmelenK,
      fertility_class_barc: prediction.fertilityClassBarc,
      calibration_domain_status: prediction.calibrationDomainStatus,
      ood_mahalanobis_d2: prediction.oodAssessment.mahalanobisD2,
      inference_ms: Number(prediction.inferenceMs.toFixed(3)),
    },
    model_provenance: {
      model_id: model.model_id,
      model_version: model.model_version,
      selected_model_family: model.selected_model_family,
      artifact_sha256: model.artifact_sha256,
    },
    physics_diagnostics: prediction.physicsReport,
  };
  return JSON.stringify(bundle, null, 2) + "\n";
}

export function exportReadingToMarkdownBrief(
  reading: SoilReadingInput,
  prediction: InferencePredictionResult,
  model: ModelEntry
): string {
  const site = reading.raw_site_id ?? reading.site_id ?? "Unspecified Site";
  const device = reading.raw_device_id ?? reading.device_id ?? "ESRC Sensor";
  const lines: string[] = [
    `# SOMSense Field Calibration Brief — ${site}`,
    "",
    `- **Sensor Unit**: ${device}`,
    `- **AEZ / Depth**: ${reading.aez_zone ?? "N/A"} | ${reading.depth_cm ?? "N/A"} cm`,
    `- **Timestamp**: ${reading.timestamp ?? new Date().toISOString()}`,
    `- **Model Version**: \`${model.model_id}\` v${model.model_version} (\`${model.artifact_sha256.slice(0, 12)}...\`)`,
    `- **Calibration Domain Status**: ${prediction.calibrationDomainStatus} (Mahalanobis D^2 = ${prediction.oodAssessment.mahalanobisD2.toFixed(2)})`,
    "",
    "## Calibrated Output",
    "",
  ];

  if (prediction.blocked || prediction.estimatedSomPct === null) {
    lines.push(
      `- **Status**: Prediction Withheld (${prediction.blockReason ?? "Blocked"})`,
      `- **Estimated SOM (%)**: ---`,
      ""
    );
  } else {
    lines.push(
      `- **Estimated SOM (%)**: ${prediction.estimatedSomPct.toFixed(2)}%`,
      `- **Estimated SOC (%)**: ${prediction.estimatedSocPct?.toFixed(2) ?? "---"}% (Van Bemmelen k = ${prediction.vanBemmelenK.toFixed(3)})`,
      `- **95% Prediction Interval**: [${prediction.somCi95Lower?.toFixed(2)}%, ${prediction.somCi95Upper?.toFixed(2)}%]`,
      `- **BARC/SRDI Agronomic Reference**: ${prediction.fertilityClassBarc ?? "N/A"}`,
      ""
    );
  }

  lines.push("## Physics Diagnostics", "");
  if (prediction.physicsReport.flags.length === 0) {
    lines.push("- All soil physics and sensor integrity checks passed.");
  } else {
    for (const flag of prediction.physicsReport.flags) {
      lines.push(`- **${flag.code}** (${flag.severity}): ${flag.message}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
