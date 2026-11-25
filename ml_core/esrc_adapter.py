"""ESRC Device - 1 JSON telemetry and AEZ calibration CSV adapter with security hardening."""

from __future__ import annotations

import csv
import io
import json
import math
from collections.abc import Mapping, Sequence
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd

from ml_core.schemas import ECUnit, PhysicsValidationReport, SoilReadingInput
from ml_core.soil_physics import normalize_ec_to_ds_m, validate_soil_reading

MAX_UPLOAD_BYTES: int = 10 * 1024 * 1024
MAX_UPLOAD_ROWS: int = 50_000
_PROTO_POLLUTION_KEYS = frozenset({"__proto__", "constructor", "prototype"})
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")

# Case-insensitive alias table mapping ESRC IoT / AEZ CSV columns to canonical SoilReadingInput keys
_FIELD_ALIASES: dict[str, str] = {
    "temperature": "temperature_c",
    "temp_c": "temperature_c",
    "temp": "temperature_c",
    "temperature_c": "temperature_c",
    "humidity": "moisture_pct",
    "moisture": "moisture_pct",
    "moisture_pct": "moisture_pct",
    "ec": "ec_generic",
    "ec_us_cm": "ec_us_cm",
    "ec_ds_m": "ec_ds_m",
    "ec_ms_cm": "ec_ms_cm",
    "ec_unit": "ec_unit",
    "salinity": "salinity_mg_l",
    "salinity_mg_l": "salinity_mg_l",
    "ph": "ph",
    "nitrogen": "nitrogen_mg_kg",
    "n": "nitrogen_mg_kg",
    "nitrogen_mg_kg": "nitrogen_mg_kg",
    "phosphorus": "phosphorus_mg_kg",
    "p": "phosphorus_mg_kg",
    "phosphorus_mg_kg": "phosphorus_mg_kg",
    "potassium": "potassium_mg_kg",
    "k": "potassium_mg_kg",
    "potassium_mg_kg": "potassium_mg_kg",
    "device_id": "device_id",
    "device": "device_id",
    "sensor_model": "device_id",
    "site_id": "site_id",
    "site": "site_id",
    "location": "site_id",
    "timestamp": "timestamp",
    "created_at": "timestamp",
    "aez_zone": "aez_zone",
    "lat": "lat",
    "latitude": "lat",
    "lon": "lon",
    "longitude": "lon",
    "depth_cm": "depth_cm",
    "depth_mid_cm": "depth_mid_cm",
    "days_since_rain": "days_since_rain",
    "days_since_fertilizer": "days_since_fertilizer",
    "tn_pct": "total_nitrogen_pct",
    "total_nitrogen_pct": "total_nitrogen_pct",
    "sand": "sand_pct",
    "sand_pct": "sand_pct",
    "silt": "silt_pct",
    "silt_pct": "silt_pct",
    "clay": "clay_pct",
    "clay_pct": "clay_pct",
    "texture_class": "texture_class",
    "crop": "crop",
}


def sanitize_spreadsheet_cell(value: str) -> str:
    """Neutralize CSV/Excel formula injection prefixes (=, +, -, @, tab, CR)."""
    if value.startswith(_FORMULA_PREFIXES):
        return f"'{value}"
    return value


def reject_prototype_pollution(obj: object) -> None:
    """Recursively reject prototype-pollution keys (__proto__, constructor, prototype)."""
    if isinstance(obj, Mapping):
        for k, v in obj.items():
            if not isinstance(k, str):
                raise ValueError("JSON object keys must be strings.")
            if k in _PROTO_POLLUTION_KEYS:
                raise ValueError(f"Rejected forbidden prototype-pollution key: {k!r}")
            reject_prototype_pollution(v)
    elif isinstance(obj, list):
        for item in obj:
            reject_prototype_pollution(item)


def _reject_non_finite_constant(token: str) -> Any:
    raise ValueError(f"Rejected non-finite JSON token: {token!r}")


def _to_optional_float(val: object, field_name: str) -> float | None:
    if val is None:
        return None
    if isinstance(val, bool):
        raise ValueError(f"Boolean is not valid for numeric field '{field_name}'.")
    if isinstance(val, str):
        stripped = val.strip()
        if stripped == "" or stripped.lower() in {"na", "null", "none"}:
            return None
        num = float(stripped)
    elif isinstance(val, (int, float)):
        num = float(val)
    else:
        raise ValueError(f"Invalid value type for '{field_name}': {type(val).__name__}")
    if not math.isfinite(num):
        raise ValueError(f"Non-finite numeric value for '{field_name}': {val!r}")
    return num


def _to_optional_str(val: object) -> str | None:
    if val is None:
        return None
    text = str(val).strip()
    return text if text else None


def _validate_iso_timestamp(ts: str | None) -> str | None:
    if ts is None:
        return None
    normalized = ts[:-1] + "+00:00" if ts.endswith("Z") else ts
    try:
        datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError(f"Malformed ISO-8601 timestamp: {ts!r}") from exc
    return ts


def _parse_depth_midpoint(depth_cm: str | None) -> float | None:
    if depth_cm is None:
        return None
    if "-" in depth_cm:
        parts = depth_cm.split("-", maxsplit=1)
        try:
            top = float(parts[0].strip())
            bottom = float(parts[1].strip())
            if top <= bottom:
                return (top + bottom) / 2.0
        except ValueError:
            return None
    try:
        return float(depth_cm)
    except ValueError:
        return None


def parse_esrc_record(
    raw_record: Mapping[str, Any],
    *,
    ec_unit: ECUnit = "unknown",
) -> tuple[SoilReadingInput, PhysicsValidationReport]:
    """Normalize a single ESRC JSON or CSV row dictionary and run physics validation."""
    reject_prototype_pollution(raw_record)

    mapped: dict[str, Any] = {}
    for key, value in raw_record.items():
        canon = _FIELD_ALIASES.get(key.strip().lower())
        if canon is not None and canon not in mapped:
            mapped[canon] = value

    # Determine EC unit & value without silent ambiguity
    resolved_unit: ECUnit = ec_unit
    ec_raw_val: float | None = None
    ec_ds_m_val: float | None = None

    if "ec_unit" in mapped and mapped["ec_unit"] is not None:
        raw_u = str(mapped["ec_unit"]).strip()
        if raw_u in ("dS/m", "uS/cm", "mS/cm", "unknown"):
            resolved_unit = raw_u  # type: ignore[assignment]

    if "ec_ds_m" in mapped and _to_optional_float(mapped["ec_ds_m"], "ec_ds_m") is not None:
        ec_raw_val = _to_optional_float(mapped["ec_ds_m"], "ec_ds_m")
        resolved_unit = "dS/m"
    elif "ec_ms_cm" in mapped and _to_optional_float(mapped["ec_ms_cm"], "ec_ms_cm") is not None:
        ec_raw_val = _to_optional_float(mapped["ec_ms_cm"], "ec_ms_cm")
        resolved_unit = "mS/cm"
    elif "ec_us_cm" in mapped and _to_optional_float(mapped["ec_us_cm"], "ec_us_cm") is not None:
        ec_raw_val = _to_optional_float(mapped["ec_us_cm"], "ec_us_cm")
        resolved_unit = "uS/cm"
    elif "ec_generic" in mapped:
        ec_raw_val = _to_optional_float(mapped["ec_generic"], "EC")

    if ec_raw_val is not None:
        ec_ds_m_val, _ = normalize_ec_to_ds_m(ec_raw_val, resolved_unit)

    raw_site = _to_optional_str(mapped.get("site_id"))
    raw_device = _to_optional_str(mapped.get("device_id"))
    safe_site = sanitize_spreadsheet_cell(raw_site) if raw_site is not None else None
    safe_device = sanitize_spreadsheet_cell(raw_device) if raw_device is not None else None
    crop_raw = _to_optional_str(mapped.get("crop"))
    safe_crop = sanitize_spreadsheet_cell(crop_raw) if crop_raw is not None else None
    depth_cm = _to_optional_str(mapped.get("depth_cm"))
    depth_mid = _to_optional_float(mapped.get("depth_mid_cm"), "depth_mid_cm")
    if depth_mid is None:
        depth_mid = _parse_depth_midpoint(depth_cm)

    reading = SoilReadingInput(
        site_id=safe_site,
        device_id=safe_device,
        raw_site_id=raw_site,
        raw_device_id=raw_device,
        timestamp=_validate_iso_timestamp(_to_optional_str(mapped.get("timestamp"))),
        aez_zone=_to_optional_str(mapped.get("aez_zone")),
        lat=_to_optional_float(mapped.get("lat"), "lat"),
        lon=_to_optional_float(mapped.get("lon"), "lon"),
        depth_cm=depth_cm,
        depth_mid_cm=depth_mid,
        nitrogen_mg_kg=_to_optional_float(mapped.get("nitrogen_mg_kg"), "nitrogen_mg_kg"),
        phosphorus_mg_kg=_to_optional_float(mapped.get("phosphorus_mg_kg"), "phosphorus_mg_kg"),
        potassium_mg_kg=_to_optional_float(mapped.get("potassium_mg_kg"), "potassium_mg_kg"),
        ph=_to_optional_float(mapped.get("ph"), "ph"),
        ec_ds_m=ec_ds_m_val,
        ec_raw=ec_raw_val,
        ec_unit=resolved_unit,
        salinity_mg_l=_to_optional_float(mapped.get("salinity_mg_l"), "salinity_mg_l"),
        temperature_c=_to_optional_float(mapped.get("temperature_c"), "temperature_c"),
        moisture_pct=_to_optional_float(mapped.get("moisture_pct"), "moisture_pct"),
        days_since_rain=_to_optional_float(mapped.get("days_since_rain"), "days_since_rain"),
        days_since_fertilizer=_to_optional_float(
            mapped.get("days_since_fertilizer"), "days_since_fertilizer"
        ),
        total_nitrogen_pct=_to_optional_float(
            mapped.get("total_nitrogen_pct"), "total_nitrogen_pct"
        ),
        sand_pct=_to_optional_float(mapped.get("sand_pct"), "sand_pct"),
        silt_pct=_to_optional_float(mapped.get("silt_pct"), "silt_pct"),
        clay_pct=_to_optional_float(mapped.get("clay_pct"), "clay_pct"),
        texture_class=_to_optional_str(mapped.get("texture_class")),
        crop=safe_crop,
    )

    lab_soc = _to_optional_float(raw_record.get("lab_soc_pct"), "lab_soc_pct")
    report = validate_soil_reading(reading, soc_pct=lab_soc)
    return reading, report


def parse_esrc_json(
    raw_json: str | bytes,
    *,
    ec_unit: ECUnit = "unknown",
    max_bytes: int = MAX_UPLOAD_BYTES,
    max_rows: int = MAX_UPLOAD_ROWS,
) -> list[tuple[SoilReadingInput, PhysicsValidationReport]]:
    """Parse ESRC IoT single-reading JSON or batch list with strict security/physics checks."""
    raw_bytes = raw_json.encode("utf-8") if isinstance(raw_json, str) else raw_json
    if len(raw_bytes) > max_bytes:
        raise ValueError(f"JSON payload exceeds max allowed size of {max_bytes} bytes.")

    decoded = json.loads(
        raw_bytes.decode("utf-8"),
        parse_constant=_reject_non_finite_constant,
    )
    reject_prototype_pollution(decoded)

    records: list[Mapping[str, Any]]
    if isinstance(decoded, dict):
        records = [decoded]
    elif isinstance(decoded, list):
        if len(decoded) > max_rows:
            raise ValueError(f"Batch exceeds max row limit of {max_rows}.")
        if not all(isinstance(item, dict) for item in decoded):
            raise ValueError("JSON batch elements must all be plain objects.")
        records = decoded
    else:
        raise ValueError("ESRC JSON payload must be a JSON object or array of objects.")

    return [parse_esrc_record(rec, ec_unit=ec_unit) for rec in records]


def parse_aez_csv(
    source: str | Path,
    *,
    default_ec_unit: ECUnit = "unknown",
    max_bytes: int = MAX_UPLOAD_BYTES,
    max_rows: int = MAX_UPLOAD_ROWS,
) -> tuple[pd.DataFrame, list[PhysicsValidationReport]]:
    """Parse an AEZ calibration or ESRC telemetry CSV safely with row/byte bounds."""
    if isinstance(source, Path) or (
        isinstance(source, str) and "\n" not in source and Path(source).exists()
    ):
        path = Path(source)
        size = path.stat().st_size
        if size > max_bytes:
            raise ValueError(f"CSV file exceeds max allowed size of {max_bytes} bytes.")
        text = path.read_text(encoding="utf-8")
    else:
        text = source
        if len(text.encode("utf-8")) > max_bytes:
            raise ValueError(f"CSV payload exceeds max allowed size of {max_bytes} bytes.")

    non_comment_lines = [
        line for line in text.splitlines() if line.strip() and not line.startswith("#")
    ]
    if not non_comment_lines:
        raise ValueError("CSV input contains no header or data rows.")

    reader = csv.DictReader(io.StringIO("\n".join(non_comment_lines)))
    if reader.fieldnames is None:
        raise ValueError("CSV header is missing.")

    readings: list[dict[str, Any]] = []
    reports: list[PhysicsValidationReport] = []
    for idx, row in enumerate(reader):
        if idx >= max_rows:
            raise ValueError(f"CSV exceeds maximum allowed row count ({max_rows}).")
        reading, report = parse_esrc_record(row, ec_unit=default_ec_unit)
        row_dict = reading.model_dump()
        row_dict["lab_soc_pct"] = _to_optional_float(row.get("lab_soc_pct"), "lab_soc_pct")
        row_dict["lab_poxc_mg_kg"] = _to_optional_float(
            row.get("lab_poxc_mg_kg"), "lab_poxc_mg_kg"
        )
        row_dict["lab_method"] = _to_optional_str(row.get("lab_method"))
        row_dict["passed_hard_gates"] = report.passed_hard_gates
        row_dict["has_warnings"] = report.has_warnings
        readings.append(row_dict)
        reports.append(report)

    return pd.DataFrame(readings), reports


def export_safe_csv(df: pd.DataFrame) -> str:
    """Export a DataFrame to CSV with spreadsheet formula-injection neutralization."""
    safe_df = df.copy()
    for col in safe_df.columns:
        if pd.api.types.is_string_dtype(safe_df[col]) or safe_df[col].dtype == object:
            safe_df[col] = safe_df[col].map(
                lambda x: sanitize_spreadsheet_cell(x) if isinstance(x, str) else x
            )
    return str(safe_df.to_csv(index=False))


def summarize_telemetry_batch(
    parsed: Sequence[tuple[SoilReadingInput, PhysicsValidationReport]],
) -> dict[str, Any]:
    """Summarize parsed ESRC readings into counts of valid, warning, and faulted rows."""
    critical_count = sum(1 for _, rep in parsed if not rep.passed_hard_gates)
    warning_count = sum(1 for _, rep in parsed if rep.passed_hard_gates and rep.has_warnings)
    clean_count = len(parsed) - critical_count - warning_count
    return {
        "total_rows": len(parsed),
        "clean_rows": clean_count,
        "warning_rows": warning_count,
        "critical_fault_rows": critical_count,
    }
