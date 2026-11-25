"""ESRC Device - 1 IoT telemetry adapter, physics diagnostics, and security tests."""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pandas as pd
import pytest

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from ml_core.esrc_adapter import (  # noqa: E402
    export_safe_csv,
    parse_aez_csv,
    parse_esrc_json,
    parse_esrc_record,
    sanitize_spreadsheet_cell,
    summarize_telemetry_batch,
)
from ml_core.schemas import SoilReadingInput  # noqa: E402
from ml_core.soil_physics import check_temporal_stability, validate_soil_reading  # noqa: E402


def test_cumilla_2_real_hardware_fault_and_saturation_warning() -> None:
    payload = json.dumps(
        {
            "device": "ESRC Device - 1",
            "location": "cumilla 2",
            "created_at": "2026-09-29T10:15:00+06:00",
            "Temperature": 29.4,
            "Humidity": 100.0,
            "EC": 620.0,
            "ec_unit": "uS/cm",
            "Salinity": 395.0,
            "PH": 0.12,
            "Nitrogen": 185.0,
            "Phosphorus": 19.2,
            "Potassium": 178.0,
        }
    )
    results = parse_esrc_json(payload)
    assert len(results) == 1
    reading, report = results[0]

    assert reading.raw_site_id == "cumilla 2"
    assert reading.raw_device_id == "ESRC Device - 1"
    assert reading.ec_ds_m == pytest.approx(0.62)
    assert report.passed_hard_gates is False
    codes = {f.code for f in report.flags}
    assert "SENSOR_FAULT_CRITICAL" in codes
    assert "SATURATION_DISTURBANCE_WARNING" in codes


def test_ec_unit_ambiguity_blocked_when_unspecified() -> None:
    reading, report = parse_esrc_record(
        {
            "site_id": "test_plot",
            "Temperature": 27.0,
            "Humidity": 35.0,
            "EC": 620.0,
            "PH": 6.6,
        },
        ec_unit="unknown",
    )
    assert reading.ec_ds_m is None
    assert reading.ec_unit == "unknown"
    assert any(f.code == "EC_UNIT_AMBIGUITY_WARNING" for f in report.flags)


def test_ec_salinity_mismatch_and_transient_ion_disturbance() -> None:
    # Mismatched unit: EC labeled dS/m=520 with Salinity=333 -> TDS/EC_uS = 0.00064
    _, mismatch_rep = parse_esrc_record(
        {
            "site_id": "plot_mismatch",
            "PH": 6.8,
            "ec_ds_m": 520.0,
            "Salinity": 333.0,
            "Moisture": 40.0,
        }
    )
    assert any(f.code == "EC_SALINITY_MISMATCH_WARNING" for f in mismatch_rep.flags)

    # High EC + high moisture + recent fertilizer -> TRANSIENT_ION_DISTURBANCE
    _, ion_rep = parse_esrc_record(
        {
            "site_id": "plot_fert",
            "PH": 6.8,
            "ec_ds_m": 2.4,
            "Moisture": 76.0,
            "days_since_fertilizer": 1.0,
        }
    )
    assert any(f.code == "TRANSIENT_ION_DISTURBANCE" for f in ion_rep.flags)


def test_temporal_stability_and_cn_plausibility() -> None:
    t0 = datetime(2026, 9, 29, 8, 0, tzinfo=UTC)
    flags = check_temporal_stability(
        [
            (t0, 1.45),
            (t0 + timedelta(hours=6), 1.92),  # +0.47% jump > 0.35% within 24h
        ],
        site_id="cumilla 2",
    )
    assert len(flags) == 1
    assert flags[0].code == "TEMPORAL_STABILITY_WARNING"

    stable_flags = check_temporal_stability(
        [
            (t0, 1.45),
            (t0 + timedelta(hours=30), 1.92),  # > 24h window
        ]
    )
    assert stable_flags == []

    cn_rep = validate_soil_reading(
        SoilReadingInput(ph=6.7, total_nitrogen_pct=0.5),
        soc_pct=1.2,  # C:N = 2.4 < 5.0
    )
    assert any(f.code == "CN_PLAUSIBILITY_WARNING" for f in cn_rep.flags)


def test_security_sanitization_and_rejection_boundaries() -> None:
    # Prototype pollution rejection
    evil = '{"__proto__": {"polluted": true}, "PH": 6.5}'
    with pytest.raises(ValueError, match="prototype-pollution"):
        parse_esrc_json(evil)

    # Non-finite JSON rejection
    with pytest.raises(ValueError, match="non-finite"):
        parse_esrc_json('{"PH": NaN}')
    with pytest.raises(ValueError, match="non-finite"):
        parse_esrc_json('{"PH": Infinity}')

    # Malformed timestamp rejection
    with pytest.raises(ValueError, match="timestamp"):
        parse_esrc_record({"PH": 6.5, "timestamp": "not-a-timestamp"})

    # Payload byte limit rejection
    with pytest.raises(ValueError, match="max allowed size"):
        parse_esrc_json('{"PH": 6.5}', max_bytes=5)

    # Spreadsheet formula injection neutralization
    assert sanitize_spreadsheet_cell("=CMD|'/C calc'!A0") == "'=CMD|'/C calc'!A0"
    assert sanitize_spreadsheet_cell("+1+1") == "'+1+1"
    assert sanitize_spreadsheet_cell("cumilla 2") == "cumilla 2"

    df = pd.DataFrame([{"site_id": "=2+2", "notes": "@SUM(A1:A2)", "ph": 6.8}])
    csv_out = export_safe_csv(df)
    assert "'=2+2" in csv_out
    assert "'@SUM(A1:A2)" in csv_out


def test_parse_aez_template_and_fixture_csvs() -> None:
    template_path = ROOT_DIR / "data" / "templates" / "esrc_aez_calibration_template.csv"
    df_tmpl, reps_tmpl = parse_aez_csv(template_path, default_ec_unit="dS/m")
    assert len(df_tmpl) == 2
    assert all(r.passed_hard_gates for r in reps_tmpl)

    fixture_path = ROOT_DIR / "data" / "fixtures" / "schema_validation_fixture.csv"
    df_fix, reps_fix = parse_aez_csv(fixture_path, default_ec_unit="dS/m")
    assert len(df_fix) == 6
    assert all(r.passed_hard_gates for r in reps_fix)

    summary = summarize_telemetry_batch(
        [
            parse_esrc_record({"PH": 6.5, "Moisture": 35.0}),
            parse_esrc_record({"PH": 0.12, "Moisture": 100.0}),
        ]
    )
    assert summary == {
        "total_rows": 2,
        "clean_rows": 1,
        "warning_rows": 0,
        "critical_fault_rows": 1,
    }
