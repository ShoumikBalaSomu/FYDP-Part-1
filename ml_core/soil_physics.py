"""Soil physics guardrails, unit conversions, disturbance checks, and outlier detection."""

from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import datetime
from typing import Any

import pandas as pd

from ml_core.schemas import (
    ECUnit,
    FertilityClassBARC,
    PhysicsDiagnosticFlag,
    PhysicsValidationReport,
    SoilReadingInput,
)

# Physical and agronomic constants (Dr. Fizar Ahmed / BARC-SRDI / USDA-KSSL protocols)
DEFAULT_VAN_BEMMELEN_K: float = 1.724
K_CMOL_TO_MG_KG: float = 391.0
USDA_SOC_G_KG_TO_PCT_DIVISOR: float = 10.0

PH_CRITICAL_MIN: float = 3.0
PH_CRITICAL_MAX: float = 10.0
MOISTURE_MIN_PCT: float = 0.0
MOISTURE_SATURATION_WARN_PCT: float = 98.0
MOISTURE_MAX_PCT: float = 100.0
TEMP_MIN_C: float = -10.0
TEMP_MAX_C: float = 60.0

EC_TRANSIENT_DS_M: float = 2.0
EC_RECENT_EVENT_ELEVATED_DS_M: float = 1.5
MOISTURE_TRANSIENT_PCT: float = 70.0
RECENT_EVENT_DAYS: float = 3.0
DAILY_SOM_JUMP_THRESHOLD_PCT: float = 0.35

CN_RATIO_MIN: float = 5.0
CN_RATIO_MAX: float = 35.0

EC_SALINITY_RATIO_MIN: float = 0.25
EC_SALINITY_RATIO_MAX: float = 1.20
EC_SALINITY_MIN_US_CM: float = 10.0

KAGGLE_OC_MAX_PCT: float = 5.0
KAGGLE_ZN_MAX_MG_KG: float = 10.0
KAGGLE_FE_MAX_MG_KG: float = 20.0


def k_cmol_to_mg_kg(k_cmol_kg: float) -> float:
    """Convert exchangeable K from cmol(+)/kg to mg/kg using 391.0 mg/kg per cmol(+)/kg."""
    return float(k_cmol_kg) * K_CMOL_TO_MG_KG


def soc_g_kg_to_pct(soc_g_kg: float) -> float:
    """Convert soil organic carbon from g C/kg (or mg/g) to percent (%) by dividing by 10."""
    return float(soc_g_kg) / USDA_SOC_G_KG_TO_PCT_DIVISOR


def normalize_ec_to_ds_m(
    value: float,
    unit: ECUnit,
) -> tuple[float | None, PhysicsDiagnosticFlag | None]:
    """Normalize EC to dS/m; return None with warning flag if unit metadata is missing."""
    if not math.isfinite(value):
        raise ValueError(f"EC value must be finite, got {value!r}")
    if unit in ("dS/m", "mS/cm"):
        return float(value), None
    if unit == "uS/cm":
        return float(value) / 1000.0, None
    return None, PhysicsDiagnosticFlag(
        code="EC_UNIT_AMBIGUITY_WARNING",
        severity="WARNING",
        field="ec_raw",
        value=float(value),
        message=(
            "EC unit is missing ('unknown'); cannot mix uS/cm (e.g. 620) with dS/m (e.g. 0.62)."
        ),
        probable_causes=[
            "ESRC firmware or CSV header omitted explicit dS/m vs uS/cm unit declaration."
        ],
        remediation="Declare explicit EC unit ('dS/m' or 'uS/cm') before running calibration.",
    )


def soc_to_som(soc_pct: float, k: float = DEFAULT_VAN_BEMMELEN_K) -> float:
    """Convert %SOC to %SOM via SOM = k * max(0, SOC), defaulting to Van Bemmelen k=1.724."""
    if k <= 0 or not math.isfinite(k):
        raise ValueError(f"Van Bemmelen factor k must be positive and finite, got {k!r}")
    return float(k) * max(0.0, float(soc_pct))


def som_to_soc(som_pct: float, k: float = DEFAULT_VAN_BEMMELEN_K) -> float:
    """Convert %SOM to %SOC via SOC = max(0, SOM) / k."""
    if k <= 0 or not math.isfinite(k):
        raise ValueError(f"Van Bemmelen factor k must be positive and finite, got {k!r}")
    return max(0.0, float(som_pct)) / float(k)


def classify_barc_som(som_pct: float) -> FertilityClassBARC:
    """Classify SOM (%) into BARC/SRDI agronomic fertility reference bands."""
    val = max(0.0, float(som_pct))
    if val < 1.0:
        return "Very Low"
    if val < 1.7:
        return "Low"
    if val < 3.4:
        return "Medium"
    if val < 5.5:
        return "High"
    return "Very High"


def compute_passive_carbon_guarded(
    total_soc_pct: float,
    poxc_mg_kg: float,
    *,
    mineral_associated_oc_pct: float | None = None,
) -> float:
    """Guard against computing passive carbon as Total SOC - POXC without full fractionation.

    POXC (mg C/kg) reflects permanganate-oxidizable active carbon under specific kinetic oxidation,
    not an additive stoichiometric partition of Total SOC. Without physical/density fractionation
    (e.g., MAOC / POM separation), subtracting POXC from Total SOC is scientifically invalid.
    """
    if mineral_associated_oc_pct is None:
        raise ValueError(
            "PASSIVE_CARBON_GUARDRAIL_VIOLATION: Passive carbon cannot be computed as "
            "Total SOC - POXC without full physical fractionation (MAOC/POM) data."
        )
    if mineral_associated_oc_pct < 0 or mineral_associated_oc_pct > total_soc_pct:
        raise ValueError(
            "Fractionated mineral-associated OC (%) must lie within [0, total_soc_pct]."
        )
    _ = poxc_mg_kg
    return float(mineral_associated_oc_pct)


def _diagnose_ph_fault(ph: float, device_label: str, site_label: str) -> PhysicsDiagnosticFlag:
    causes = [
        "Disconnected, dry, or uncalibrated glass/ISFET pH probe.",
        "RS485/Modbus decimal shift or register scaling mismatch.",
    ]
    if 0.0 <= ph <= 0.30:
        causes.append(
            f"Observed pH={ph:.2f} (matching ESRC cumilla 2 failure mode): "
            f"x10={ph * 10:.2f} and x100={ph * 100:.1f} remain non-viable, "
            "indicating open-circuit or uncalibrated electrode."
        )
    return PhysicsDiagnosticFlag(
        code="SENSOR_FAULT_CRITICAL",
        severity="CRITICAL",
        field="ph",
        value=ph,
        message=(
            f"Critical pH sensor fault on {device_label} ({site_label}): "
            f"pH={ph:.2f} is outside physical arable soil bounds [{PH_CRITICAL_MIN}, "
            f"{PH_CRITICAL_MAX}]."
        ),
        probable_causes=causes,
        remediation=(
            "Inspect pH probe connector, verify Modbus register scale factor, "
            "and recalibrate with pH 4.0/7.0 buffer solutions before predicting."
        ),
    )


def validate_soil_reading(
    reading: SoilReadingInput,
    *,
    soc_pct: float | None = None,
) -> PhysicsValidationReport:
    """Run all physical bounds, hardware fault gates, saturation, and C:N plausibility checks."""
    flags: list[PhysicsDiagnosticFlag] = []
    device_label = reading.raw_device_id or reading.device_id or "ESRC Sensor"
    site_label = reading.raw_site_id or reading.site_id or "unspecified site"

    # 1. Hard gate: pH bounds
    if reading.ph is not None and (reading.ph < PH_CRITICAL_MIN or reading.ph > PH_CRITICAL_MAX):
        flags.append(_diagnose_ph_fault(reading.ph, device_label, site_label))

    # 2. Hard gate: non-negative chemical & moisture fields
    non_negative_fields: list[tuple[str, float | None]] = [
        ("nitrogen_mg_kg", reading.nitrogen_mg_kg),
        ("phosphorus_mg_kg", reading.phosphorus_mg_kg),
        ("potassium_mg_kg", reading.potassium_mg_kg),
        ("ec_ds_m", reading.ec_ds_m),
        ("salinity_mg_l", reading.salinity_mg_l),
        ("moisture_pct", reading.moisture_pct),
    ]
    for field_name, val in non_negative_fields:
        if val is not None and val < 0.0:
            flags.append(
                PhysicsDiagnosticFlag(
                    code="SENSOR_FAULT_CRITICAL",
                    severity="CRITICAL",
                    field=field_name,
                    value=val,
                    message=f"Negative physical reading for {field_name}: {val}.",
                    probable_causes=["Signed integer underflow or corrupted sensor payload."],
                    remediation="Check sensor register signedness and re-acquire measurement.",
                )
            )

    # 3. Hard gate: moisture > 100% and temperature bounds
    if reading.moisture_pct is not None and reading.moisture_pct > MOISTURE_MAX_PCT:
        flags.append(
            PhysicsDiagnosticFlag(
                code="SENSOR_FAULT_CRITICAL",
                severity="CRITICAL",
                field="moisture_pct",
                value=reading.moisture_pct,
                message=(
                    f"Moisture {reading.moisture_pct:.1f}% exceeds physical 100% ceiling "
                    f"on {device_label} ({site_label})."
                ),
                probable_causes=["Uncalibrated dielectric probe or scaling overflow."],
                remediation="Recalibrate volumetric moisture probe and verify firmware scaling.",
            )
        )

    if reading.temperature_c is not None and (
        reading.temperature_c < TEMP_MIN_C or reading.temperature_c > TEMP_MAX_C
    ):
        flags.append(
            PhysicsDiagnosticFlag(
                code="SENSOR_FAULT_CRITICAL",
                severity="CRITICAL",
                field="temperature_c",
                value=reading.temperature_c,
                message=(
                    f"Soil temperature {reading.temperature_c:.2f} C outside physical bounds "
                    f"[{TEMP_MIN_C}, {TEMP_MAX_C}] C."
                ),
                probable_causes=["Open/shorted thermistor or NTC lookup error."],
                remediation="Inspect temperature thermistor wiring and replace faulty probe.",
            )
        )

    # 4. Warning: EC unit ambiguity
    if reading.ec_raw is not None and reading.ec_unit == "unknown":
        _, ec_flag = normalize_ec_to_ds_m(reading.ec_raw, "unknown")
        if ec_flag is not None:
            flags.append(ec_flag)

    # 5. Warning: Saturation disturbance (Humidity >= 98%)
    if (
        reading.moisture_pct is not None
        and MOISTURE_SATURATION_WARN_PCT <= reading.moisture_pct <= MOISTURE_MAX_PCT
    ):
        flags.append(
            PhysicsDiagnosticFlag(
                code="SATURATION_DISTURBANCE_WARNING",
                severity="WARNING",
                field="moisture_pct",
                value=reading.moisture_pct,
                message=(
                    f"Soil moisture/humidity is {reading.moisture_pct:.1f}% (>= 98%) on "
                    f"{device_label} ({site_label}); standing water or post-rain saturation "
                    "inflates apparent bulk EC via EC*Moisture cross-talk."
                ),
                probable_causes=[
                    "Waterlogged paddy/field condition or condensation on probe.",
                    "Recent heavy rainfall increasing pore-water ionic mobility.",
                ],
                remediation=(
                    "Treat EC-driven predictions as provisional and resample after surface "
                    "drainage (24-48 hours)."
                ),
            )
        )

    # 6. Warning: Transient ionic disturbance (high EC + high moisture or recent rain/fertilizer)
    recent_rain = (
        reading.days_since_rain is not None and reading.days_since_rain < RECENT_EVENT_DAYS
    )
    recent_fert = (
        reading.days_since_fertilizer is not None
        and reading.days_since_fertilizer < RECENT_EVENT_DAYS
    )
    high_moisture = (
        reading.moisture_pct is not None and reading.moisture_pct >= MOISTURE_TRANSIENT_PCT
    )
    if reading.ec_ds_m is not None and (
        (reading.ec_ds_m > EC_TRANSIENT_DS_M and (high_moisture or recent_rain or recent_fert))
        or (reading.ec_ds_m >= EC_RECENT_EVENT_ELEVATED_DS_M and (recent_rain or recent_fert))
    ):
        flags.append(
            PhysicsDiagnosticFlag(
                code="TRANSIENT_ION_DISTURBANCE",
                severity="WARNING",
                field="ec_ds_m",
                value=reading.ec_ds_m,
                message=(
                    f"Elevated EC ({reading.ec_ds_m:.2f} dS/m) paired with wet soil or recent "
                    "rain/fertilizer (<3 days) indicates transient ionic spike."
                ),
                probable_causes=[
                    "Recent NPK fertilizer dissolution or irrigation/rain flush.",
                ],
                remediation="Flag reading as disturbed and wait >= 72h after fertilization.",
            )
        )

    # 7. Warning: EC vs Salinity consistency check
    if (
        reading.ec_ds_m is not None
        and reading.ec_ds_m > 0.0
        and reading.salinity_mg_l is not None
        and reading.salinity_mg_l >= 0.0
    ):
        ec_us_cm = reading.ec_ds_m * 1000.0
        if ec_us_cm > EC_SALINITY_MIN_US_CM:
            ratio = reading.salinity_mg_l / ec_us_cm
            if ratio < EC_SALINITY_RATIO_MIN or ratio > EC_SALINITY_RATIO_MAX:
                flags.append(
                    PhysicsDiagnosticFlag(
                        code="EC_SALINITY_MISMATCH_WARNING",
                        severity="WARNING",
                        field="salinity_mg_l",
                        value=reading.salinity_mg_l,
                        message=(
                            f"Salinity ({reading.salinity_mg_l:.1f} mg/L) vs EC "
                            f"({ec_us_cm:.1f} uS/cm) ratio={ratio:.3f} falls outside expected "
                            "0.5-0.7 TDS-to-EC range."
                        ),
                        probable_causes=[
                            "Possible uS/cm vs dS/m unit mismatch or Modbus register swap.",
                        ],
                        remediation="Verify EC unit manifest and Salinity register offset.",
                    )
                )

    # 8. Warning: C:N plausibility when independent Total N (%) and SOC (%) are supplied
    cn_ratio: float | None = None
    if (
        soc_pct is not None
        and soc_pct >= 0.0
        and reading.total_nitrogen_pct is not None
        and reading.total_nitrogen_pct > 0.0
    ):
        cn_ratio = float(soc_pct) / float(reading.total_nitrogen_pct)
        if cn_ratio < CN_RATIO_MIN or cn_ratio > CN_RATIO_MAX:
            flags.append(
                PhysicsDiagnosticFlag(
                    code="CN_PLAUSIBILITY_WARNING",
                    severity="WARNING",
                    field="total_nitrogen_pct",
                    value=round(cn_ratio, 3),
                    message=(
                        f"Soil C:N ratio ({cn_ratio:.2f}) falls outside plausible arable mineral "
                        f"range [{CN_RATIO_MIN}, {CN_RATIO_MAX}]."
                    ),
                    probable_causes=[
                        "Nitrogen unit confusion (mg/kg vs %).",
                        "Peat/organic horizon or miscalibrated Kjeldahl/SOC analysis.",
                    ],
                    remediation="Verify TN (%) vs mineral N (mg/kg) units before agronomic use.",
                )
            )

    passed_hard_gates = not any(f.severity == "CRITICAL" for f in flags)
    has_warnings = any(f.severity == "WARNING" for f in flags)
    return PhysicsValidationReport(
        passed_hard_gates=passed_hard_gates,
        has_warnings=has_warnings,
        flags=flags,
        cn_ratio=cn_ratio,
    )


def check_temporal_stability(
    observations: Sequence[tuple[datetime, float]],
    *,
    site_id: str | None = None,
    max_jump_pct: float = DAILY_SOM_JUMP_THRESHOLD_PCT,
) -> list[PhysicsDiagnosticFlag]:
    """Flag apparent >0.35% SOM jumps within <=24h as wetting/fertilizer artifacts."""
    if len(observations) < 2:
        return []
    ordered = sorted(observations, key=lambda item: item[0])
    flags: list[PhysicsDiagnosticFlag] = []
    label = site_id or "site"
    for idx in range(1, len(ordered)):
        t_prev, som_prev = ordered[idx - 1]
        t_curr, som_curr = ordered[idx]
        dt_hours = (t_curr - t_prev).total_seconds() / 3600.0
        jump = abs(som_curr - som_prev)
        if 0.0 <= dt_hours <= 24.0 and jump > max_jump_pct:
            flags.append(
                PhysicsDiagnosticFlag(
                    code="TEMPORAL_STABILITY_WARNING",
                    severity="WARNING",
                    field="estimated_som_pct",
                    value=round(jump, 4),
                    message=(
                        f"Apparent %SOM shifted by {jump:.3f} percentage points in "
                        f"{dt_hours:.1f}h at {label} (threshold {max_jump_pct:.2f}%/24h)."
                    ),
                    probable_causes=[
                        "Soil organic matter does not change >0.35% within 24 hours; "
                        "shift reflects moisture/fertilizer ionic interference."
                    ],
                    remediation="Hold steady-state SOM baseline and discard transient spike.",
                )
            )
    return flags


def flag_kaggle_outliers(
    df: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame, list[dict[str, Any]]]:
    """Detect physically invalid and decimal-corrupted rows in Kaggle Soil Fertility CSV.

    Identifies the 7 corrupt rows in dataset1.csv:
    - pH < 3.0 or pH > 10.0 (5 rows: 0.90, 10.05, 10.60, 11.15)
    - OC > 5.0% (row 667: OC=24.0%, Zn=38.0, Fe=34.0)
    - Missing-decimal micronutrient spikes Zn > 10.0 or Fe > 20.0 (row 659: Zn=42.0, Fe=44.0)
    """
    reasons: list[str] = []
    mask = pd.Series(False, index=df.index)
    details: list[dict[str, Any]] = []

    for idx, row in df.iterrows():
        row_reasons: list[str] = []
        ph_val = float(row["pH"])
        oc_val = float(row["OC"])
        if ph_val < PH_CRITICAL_MIN or ph_val > PH_CRITICAL_MAX:
            row_reasons.append(f"pH={ph_val:.2f} outside [{PH_CRITICAL_MIN}, {PH_CRITICAL_MAX}]")
        if oc_val > KAGGLE_OC_MAX_PCT or oc_val < 0.0:
            row_reasons.append(f"OC={oc_val:.2f}% outside [0, {KAGGLE_OC_MAX_PCT}]")
        if "Zn" in df.columns and float(row["Zn"]) > KAGGLE_ZN_MAX_MG_KG:
            row_reasons.append(f"Zn={float(row['Zn']):.2f} > {KAGGLE_ZN_MAX_MG_KG}")
        if "Fe" in df.columns and float(row["Fe"]) > KAGGLE_FE_MAX_MG_KG:
            row_reasons.append(f"Fe={float(row['Fe']):.2f} > {KAGGLE_FE_MAX_MG_KG}")
        for col in ("N", "P", "K", "EC"):
            if col in df.columns and float(row[col]) < 0.0:
                row_reasons.append(f"{col}={float(row[col]):.2f} < 0")

        if row_reasons:
            mask.loc[idx] = True
            reason_str = "; ".join(row_reasons)
            reasons.append(reason_str)
            details.append(
                {
                    "row_index": int(idx) if isinstance(idx, (int, float)) else str(idx),
                    "reasons": row_reasons,
                    "pH": ph_val,
                    "OC": oc_val,
                }
            )

    clean_df = df.loc[~mask].copy()
    outlier_df = df.loc[mask].copy()
    outlier_df["outlier_reason"] = reasons
    return clean_df, outlier_df, details
