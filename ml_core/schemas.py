"""Strict Pydantic v2 schemas for soil readings, physics checks, and portable registry."""

from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

SeverityLevel = Literal["OK", "WARNING", "CRITICAL"]
CalibrationDomainStatus = Literal["In-Range", "Caution", "Outside Calibration Range"]
FertilityClassBARC = Literal["Very Low", "Low", "Medium", "High", "Very High"]
ECUnit = Literal["dS/m", "uS/cm", "mS/cm", "unknown"]

PhysicsFlagCode = Literal[
    "SENSOR_FAULT_CRITICAL",
    "SATURATION_DISTURBANCE_WARNING",
    "TRANSIENT_ION_DISTURBANCE",
    "TEMPORAL_STABILITY_WARNING",
    "CN_PLAUSIBILITY_WARNING",
    "EC_UNIT_AMBIGUITY_WARNING",
    "EC_SALINITY_MISMATCH_WARNING",
    "EXTREME_OUTLIER_EXCLUDED",
    "PASSIVE_CARBON_GUARDRAIL_VIOLATION",
]


def _check_finite_float(value: float | None, field_name: str) -> float | None:
    if value is None:
        return None
    if not math.isfinite(value):
        raise ValueError(f"Non-finite numeric value for '{field_name}': {value!r}")
    return float(value)


class SoilReadingInput(BaseModel):
    """Normalized soil sensor or laboratory observation at the inference boundary."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    site_id: str | None = None
    device_id: str | None = None
    raw_site_id: str | None = None
    raw_device_id: str | None = None
    timestamp: str | None = None
    aez_zone: str | None = None
    lat: float | None = None
    lon: float | None = None
    depth_cm: str | None = None
    depth_mid_cm: float | None = None

    nitrogen_mg_kg: float | None = None
    phosphorus_mg_kg: float | None = None
    potassium_mg_kg: float | None = None
    ph: float | None = None
    ec_ds_m: float | None = None
    ec_raw: float | None = None
    ec_unit: ECUnit = "dS/m"
    salinity_mg_l: float | None = None
    temperature_c: float | None = None
    moisture_pct: float | None = None

    days_since_rain: float | None = None
    days_since_fertilizer: float | None = None
    total_nitrogen_pct: float | None = None
    sand_pct: float | None = None
    silt_pct: float | None = None
    clay_pct: float | None = None
    texture_class: str | None = None
    crop: str | None = None

    @field_validator(
        "lat",
        "lon",
        "depth_mid_cm",
        "nitrogen_mg_kg",
        "phosphorus_mg_kg",
        "potassium_mg_kg",
        "ph",
        "ec_ds_m",
        "ec_raw",
        "salinity_mg_l",
        "temperature_c",
        "moisture_pct",
        "days_since_rain",
        "days_since_fertilizer",
        "total_nitrogen_pct",
        "sand_pct",
        "silt_pct",
        "clay_pct",
        mode="before",
    )
    @classmethod
    def _reject_non_finite(cls, v: object, info: object) -> object:
        if isinstance(v, bool):
            raise ValueError("Boolean value is not valid for a numeric soil field.")
        if isinstance(v, (int, float)):
            field_name = getattr(info, "field_name", "value")
            return _check_finite_float(float(v), str(field_name))
        return v


class PhysicsDiagnosticFlag(BaseModel):
    """Single physics, hardware, or disturbance diagnostic raised for an observation."""

    model_config = ConfigDict(extra="forbid")

    code: PhysicsFlagCode
    severity: SeverityLevel
    field: str
    value: float | str | None = None
    message: str
    probable_causes: list[str] = Field(default_factory=list)
    remediation: str


class PhysicsValidationReport(BaseModel):
    """Aggregate soil-physics and hardware-gate validation outcome."""

    model_config = ConfigDict(extra="forbid")

    passed_hard_gates: bool
    has_warnings: bool
    flags: list[PhysicsDiagnosticFlag] = Field(default_factory=list)
    cn_ratio: float | None = None


class PredictionResult(BaseModel):
    """Calibrated SOC/SOM prediction with 95% conformal bounds and OOD status."""

    model_config = ConfigDict(extra="forbid")

    estimated_soc_pct: float | None = None
    estimated_som_pct: float | None = None
    som_ci95_lower: float | None = None
    som_ci95_upper: float | None = None
    van_bemmelen_k: float = 1.724
    fertility_class_barc: FertilityClassBARC | None = None
    calibration_domain_status: CalibrationDomainStatus
    ood_mahalanobis_d2: float | None = None
    ood_isolation_score: float | None = None
    model_id: str
    model_version: str
    blocked: bool = False
    block_reason: str | None = None
    physics_report: PhysicsValidationReport
    feature_contributions: dict[str, float] = Field(default_factory=dict)


class POXCPredictionResult(BaseModel):
    """Separate active-carbon (POXC) prediction strictly in mg C/kg dry soil."""

    model_config = ConfigDict(extra="forbid")

    estimated_poxc_mg_kg: float | None = None
    poxc_ci95_lower: float | None = None
    poxc_ci95_upper: float | None = None
    unit: Literal["mg C/kg dry soil"] = "mg C/kg dry soil"
    model_id: str
    model_version: str
    calibration_domain_status: CalibrationDomainStatus
    ood_mahalanobis_d2: float | None = None
    blocked: bool = False
    block_reason: str | None = None
    physics_report: PhysicsValidationReport
