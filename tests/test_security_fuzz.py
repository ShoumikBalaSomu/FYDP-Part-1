"""Adversarial security, fuzzing, DoS, numerical poison, and integrity tests for ml_core."""

from __future__ import annotations

import copy
import json
import math
import sys
import time
from pathlib import Path
from typing import Any

import pandas as pd
import pytest

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from ml_core import export_artifacts  # noqa: E402
from ml_core.esrc_adapter import (  # noqa: E402
    MAX_UPLOAD_BYTES,
    MAX_UPLOAD_ROWS,
    export_safe_csv,
    parse_aez_csv,
    parse_esrc_json,
    parse_esrc_record,
    sanitize_spreadsheet_cell,
)
from ml_core.export_artifacts import predict_from_registry_entry  # noqa: E402
from ml_core.soil_physics import k_cmol_to_mg_kg  # noqa: E402

REGISTRY_PATH = ROOT_DIR / "models" / "registry.json"

FORMULA_VECTORS: tuple[str, ...] = (
    "=CMD|'/C calc'!A0",
    "+1+1",
    "-2+3",
    "@SUM(1+1)*cmd",
    "\t=1+1",
    "\r=1+1",
    "\n=1+1",
    " =CMD|'/C calc'!A0",
)

XSS_VECTORS: tuple[str, ...] = (
    "<script>alert(1)</script>",
    "<svg onload=alert(1)>",
    "cumilla 2 <script>alert(1)</script>",
    'cumilla 2 "><svg onload=alert(1)>',
)


@pytest.mark.parametrize("payload", FORMULA_VECTORS)
def test_csv_formula_injection_neutralized_in_cells_and_exports(payload: str) -> None:
    neutralized = sanitize_spreadsheet_cell(payload)
    assert neutralized.startswith("'"), f"Failed to neutralize formula prefix for {payload!r}"

    # Verify parse_esrc_record neutralizes all string metadata fields, not only site_id/device_id
    reading, _ = parse_esrc_record(
        {
            "site_id": payload,
            "device_id": payload,
            "aez_zone": payload,
            "depth_cm": payload,
            "texture_class": payload,
            "crop": payload,
            "PH": 6.6,
            "Moisture": 35.0,
        }
    )
    for field_name in ("site_id", "device_id", "aez_zone", "depth_cm", "texture_class", "crop"):
        val = getattr(reading, field_name)
        assert val is not None
        assert not val.lstrip().startswith(("=", "+", "-", "@")), (
            f"Unsanitized formula leaked in {field_name}: {val!r}"
        )

    # Verify export_safe_csv neutralizes both cell values and column headers
    df = pd.DataFrame([{payload: payload, "site_id": payload, "ph": 6.6}])
    csv_text = export_safe_csv(df)
    lines = [line for line in csv_text.splitlines() if line.strip()]
    assert len(lines) == 2
    header_cells = lines[0].split(",")
    assert all(not h.strip('"').lstrip().startswith(("=", "+", "-", "@")) for h in header_cells), (
        f"Formula leaked in CSV header: {lines[0]!r}"
    )
    assert payload not in lines[1] or f"'{payload}" in lines[1]


def test_csv_import_formula_injection_and_xss_headers() -> None:
    csv_lines = [
        "site_id,device_id,aez_zone,texture_class,lab_method,PH,Moisture,EC,ec_unit",
        (
            "\"=CMD|'/C calc'!A0\",+1+1,-2+3,@SUM(1+1)*cmd,"
            "\"=HYPERLINK(\"\"http://evil.invalid\"\",\"\"x\"\")\",6.6,35.0,0.5,dS/m"
        ),
    ]
    df, reports = parse_aez_csv("\n".join(csv_lines))
    assert len(df) == 1
    assert reports[0].passed_hard_gates is True
    for col in ("site_id", "device_id", "aez_zone", "texture_class", "lab_method"):
        cell = str(df.loc[0, col])
        assert cell.startswith("'"), f"Column {col} was not formula-neutralized: {cell!r}"

    # XSS strings in site_id, device_id, and extra CSV headers must remain inert
    for xss in XSS_VECTORS:
        q_xss = xss.replace('"', '""')
        xss_csv = f'site_id,device_id,"{q_xss}",PH,Moisture\n"{q_xss}","{q_xss}",1.0,6.6,35.0\n'
        xss_df, xss_reps = parse_aez_csv(xss_csv)
        assert len(xss_df) == 1
        assert xss_reps[0].passed_hard_gates is True
        assert xss_df.loc[0, "site_id"] == xss.strip()


@pytest.mark.parametrize(
    "evil_json",
    [
        '{"__proto__": {"polluted": true}, "PH": 6.5}',
        '{"constructor": {"prototype": {"x": 1}}, "PH": 6.5}',
        '{"prototype": {"polluted": true}, "PH": 6.5}',
        '{"meta": {"__proto__": {"polluted": true}}, "PH": 6.5}',
        '[{"PH": 6.5}, {"meta": {"constructor": {"prototype": {"x": 1}}}}]',
    ],
)
def test_prototype_pollution_rejected_in_json(evil_json: str) -> None:
    with pytest.raises(ValueError, match="prototype-pollution"):
        parse_esrc_json(evil_json)


@pytest.mark.parametrize("bad_col", ["__proto__", "constructor", "prototype", "\ufeff__proto__"])
def test_prototype_pollution_rejected_in_csv_headers(bad_col: str) -> None:
    csv_text = f"site_id,{bad_col},PH,Moisture\ncumilla 2,1,6.5,35.0\n"
    with pytest.raises(ValueError, match="prototype-pollution|forbidden"):
        parse_aez_csv(csv_text)


def test_dos_oversized_payload_and_row_limits() -> None:
    assert MAX_UPLOAD_BYTES == 10 * 1024 * 1024
    assert MAX_UPLOAD_ROWS == 10_000

    # >10 MB JSON payload
    oversized_json = '{"site_id": "' + ("A" * (MAX_UPLOAD_BYTES + 64)) + '", "PH": 6.5}'
    with pytest.raises(ValueError, match="max allowed size"):
        parse_esrc_json(oversized_json)

    # >10 MB single-line CSV without newline (must not raise OSError: File name too long)
    oversized_single_line_csv = "site_id,PH," + ("X" * (MAX_UPLOAD_BYTES + 64))
    with pytest.raises(ValueError, match="max allowed size"):
        parse_aez_csv(oversized_single_line_csv)

    # >10,000 rows JSON batch
    big_batch = json.dumps([{"PH": 6.5, "Moisture": 35.0}] * (MAX_UPLOAD_ROWS + 1))
    with pytest.raises(ValueError, match="row limit"):
        parse_esrc_json(big_batch)

    # >10,000 rows CSV batch
    big_csv = "site_id,PH,Moisture\n" + ("s1,6.5,35.0\n" * (MAX_UPLOAD_ROWS + 1))
    with pytest.raises(ValueError, match="row count|row limit"):
        parse_aez_csv(big_csv)


@pytest.mark.parametrize(
    "bad_json",
    [
        '{"PH": NaN}',
        '{"PH": Infinity}',
        '{"PH": -Infinity}',
        '{"PH": "NaN"}',
        '{"PH": "Infinity"}',
        '{"PH": "-Infinity"}',
        '{"PH": 1e309}',
        '{"N": "1e309", "PH": 6.5}',
    ],
)
def test_non_finite_json_tokens_rejected(bad_json: str) -> None:
    with pytest.raises(ValueError, match="non-finite|Non-finite|Invalid"):
        parse_esrc_json(bad_json)


def test_numerical_poison_1e308_rejected_or_blocked_safely() -> None:
    # 1e308 * 391 overflows float64 to inf; must fail closed rather than returning inf
    with pytest.raises(ValueError, match="finite|overflow|exceeds"):
        k_cmol_to_mg_kg(1e308)

    # 1e308 in nitrogen/potassium/ec must fail validation or critical gate, never pass as In-Range
    with pytest.raises(ValueError):
        reading, report = parse_esrc_record(
            {
                "site_id": "cumilla 2",
                "PH": 7.8,
                "P": 22.5,
                "K": 89.93,
                "Moisture": 36.0,
                "depth_cm": "0-20",
                "N": 1e308,
            }
        )
        assert not report.passed_hard_gates
        raise ValueError("blocked via critical physics gate")

    reg: dict[str, Any] = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    kaggle_entry = reg["models"]["kaggle_mineral_oc_benchmark"]
    # predict_from_registry_entry must not return non-finite d2 or raise RuntimeWarning overflow
    with pytest.raises(ValueError):
        _, _, _, _, d2 = predict_from_registry_entry(
            kaggle_entry,
            {
                "nitrogen_mg_kg": 1e308,
                "phosphorus_mg_kg": 20.0,
                "potassium_mg_kg": 100.0,
                "ph": 6.5,
                "ec_ds_m": 0.5,
            },
        )
        if not math.isfinite(d2):
            raise ValueError("Non-finite Mahalanobis D^2")


def test_deeply_nested_json_over_32_levels_rejected_without_recursion_error() -> None:
    # Depth 40 (> 32 level ceiling) must fail cleanly with ValueError
    depth_40 = '{"a":' * 40 + '{"PH": 6.5}' + "}" * 40
    with pytest.raises(ValueError, match="nesting depth|depth"):
        parse_esrc_json(depth_40)

    # Depth 1500 must raise ValueError, never raw RecursionError
    depth_1500 = '{"a":' * 1500 + '{"PH": 6.5}' + "}" * 1500
    with pytest.raises(ValueError, match="nesting depth|depth"):
        parse_esrc_json(depth_1500)


def test_redos_pathological_strings_stay_sub_200ms() -> None:
    t0 = time.perf_counter()
    with pytest.raises(ValueError):
        parse_esrc_record({"PH": 6.5, "timestamp": "2026-09-29T" + ("A" * 100_000)})

    # Pathological depth_cm, aez_zone, and site_id strings
    reading, _ = parse_esrc_record(
        {
            "PH": 6.5,
            "Moisture": 35.0,
            "depth_cm": "0-" + ("1" * 50_000),
            "aez_zone": "_" * 50_000,
            "site_id": ("cumilla 2 " * 5_000).strip(),
        }
    )
    assert reading.depth_mid_cm is None
    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    assert elapsed_ms < 200.0, f"Pathological input took {elapsed_ms:.1f} ms"


def test_python_registry_loader_rejects_tampered_weight_or_hash() -> None:
    verifier = getattr(export_artifacts, "verify_registry_document", None) or getattr(
        export_artifacts, "load_and_verify_registry", None
    )
    assert verifier is not None, (
        "ml_core.export_artifacts must expose verify_registry_document / load_and_verify_registry "
        "to reject tampered registry weights or SHA-256 hashes and fail closed."
    )

    raw_doc: dict[str, Any] = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    # Valid registry must pass
    verified = verifier(copy.deepcopy(raw_doc))
    assert verified["platform"] == "SOMSense-ESRC"

    # 1. Mutate 1 model weight (intercept or tree leaf value) without updating hashes
    tampered_weight = copy.deepcopy(raw_doc)
    ols_entry = tampered_weight["models"]["srdi_kushtia_om_baseline_ols"]
    ols_entry["predictor"]["intercept"] += 0.0001
    with pytest.raises(ValueError, match="SHA-256|mismatch|integrity"):
        verifier(tampered_weight)

    # 2. Mutate 1 tree leaf value in HGB champion while leaving hashes untouched
    tampered_tree = copy.deepcopy(raw_doc)
    champ = tampered_tree["models"]["srdi_kushtia_om_champion"]
    champ["predictor"]["trees"][0]["value"][-1] += 0.05
    with pytest.raises(ValueError, match="SHA-256|mismatch|integrity"):
        verifier(tampered_tree)

    # 3. Mutate 1 character of canonical_payload_sha256
    tampered_root_hash = copy.deepcopy(raw_doc)
    orig_hash = tampered_root_hash["integrity"]["canonical_payload_sha256"]
    flipped = ("0" if orig_hash[0] != "0" else "1") + orig_hash[1:]
    tampered_root_hash["integrity"]["canonical_payload_sha256"] = flipped
    with pytest.raises(ValueError, match="SHA-256|mismatch|integrity"):
        verifier(tampered_root_hash)

    # 4. Mutate 1 character of an individual model's artifact_sha256
    tampered_model_hash = copy.deepcopy(raw_doc)
    m_hash = tampered_model_hash["models"]["srdi_kushtia_om_champion"]["artifact_sha256"]
    tampered_model_hash["models"]["srdi_kushtia_om_champion"]["artifact_sha256"] = (
        ("a" if m_hash[0] != "a" else "b") + m_hash[1:]
    )
    with pytest.raises(ValueError, match="SHA-256|mismatch|integrity"):
        verifier(tampered_model_hash)
