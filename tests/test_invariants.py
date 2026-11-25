"""Scientific, JSON-Schema contract, cryptographic hash, and parity invariants."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import jsonschema
import numpy as np
import pytest

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from ml_core.datasets import (  # noqa: E402
    load_kaggle_soil_fertility,
    load_srdi_kushtia,
    load_usda_kssl_poxc,
)
from ml_core.export_artifacts import (  # noqa: E402
    canonical_sha256,
    predict_from_registry_entry,
    verify_registry_parity,
)
from ml_core.poxc_pipeline import train_poxc_pipeline  # noqa: E402
from ml_core.soil_physics import soc_to_som  # noqa: E402
from ml_core.spatial_cv import evaluate_model_ladder  # noqa: E402

REGISTRY_PATH = ROOT_DIR / "models" / "registry.json"
MANIFEST_PATH = ROOT_DIR / "models" / "artifacts_manifest.json"
SCHEMA_PATH = ROOT_DIR / "docs" / "contracts" / "model_registry_schema.json"
KAGGLE_CSV_PATH = ROOT_DIR / "data" / "raw" / "kaggle_soil_fertility" / "dataset1.csv"


def test_registry_conforms_to_draft_2020_12_schema() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))

    jsonschema.Draft202012Validator.check_schema(schema)
    validator = jsonschema.Draft202012Validator(schema)
    errors = list(validator.iter_errors(registry))
    assert errors == [], f"Schema validation errors: {[e.message for e in errors]}"


def test_registry_and_artifact_sha256_integrity() -> None:
    registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    payload_no_integrity = {k: v for k, v in registry.items() if k != "integrity"}
    expected_root_hash = canonical_sha256(payload_no_integrity)
    assert registry["integrity"]["canonical_payload_sha256"] == expected_root_hash
    assert manifest["canonical_payload_sha256"] == expected_root_hash

    for model_id, entry in registry["models"].items():
        entry_no_hash = {k: v for k, v in entry.items() if k != "artifact_sha256"}
        assert entry["artifact_sha256"] == canonical_sha256(entry_no_hash)
        assert manifest["models"][model_id]["artifact_sha256"] == entry["artifact_sha256"]


def test_no_tn_leakage_or_direct_om_in_registry_invariants() -> None:
    registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    assert registry["authority_protocol"]["forbid_direct_sensor_om"] is True
    assert registry["authority_protocol"]["forbid_passive_c_subtraction"] is True

    for model_id, entry in registry["models"].items():
        raw_feats = set(entry["preprocessing"]["raw_features"])
        assert "total_nitrogen_pct" not in raw_feats, f"TN leak in {model_id}"
        assert "TN_pct" not in raw_feats, f"TN leak in {model_id}"
        assert entry["uncertainty"]["clip_lower_at_zero"] is True


def test_python_vs_registry_json_prediction_parity_under_1e_minus_6() -> None:
    registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))

    srdi_bundle = load_srdi_kushtia(include_leaked_tn=False)
    srdi_eval = evaluate_model_ladder(srdi_bundle, n_splits=5, random_state=42)
    assert (
        verify_registry_parity(
            registry["models"]["srdi_kushtia_om_champion"],
            srdi_eval.champion_pipeline,
            srdi_bundle,
            tolerance=1e-6,
        )
        < 1e-6
    )
    assert (
        verify_registry_parity(
            registry["models"]["srdi_kushtia_om_baseline_ols"],
            srdi_eval.baseline_pipeline,
            srdi_bundle,
            tolerance=1e-6,
        )
        < 1e-6
    )

    poxc_with = train_poxc_pipeline(include_lab_soc=True, n_splits=5, random_state=42)
    poxc_without = train_poxc_pipeline(include_lab_soc=False, n_splits=5, random_state=42)
    assert (
        verify_registry_parity(
            registry["models"]["usda_kssl_poxc_with_soc"],
            poxc_with.evaluation.champion_pipeline,
            load_usda_kssl_poxc(include_lab_soc=True),
            tolerance=1e-6,
        )
        < 1e-6
    )
    assert (
        verify_registry_parity(
            registry["models"]["usda_kssl_poxc_without_soc"],
            poxc_without.evaluation.champion_pipeline,
            load_usda_kssl_poxc(include_lab_soc=False),
            tolerance=1e-6,
        )
        < 1e-6
    )


@pytest.mark.skipif(
    not KAGGLE_CSV_PATH.exists(),
    reason="Kaggle dataset1.csv absent in credential-free CI (--skip-kaggle).",
)
def test_kaggle_registry_json_prediction_parity_under_1e_minus_6() -> None:
    registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    kaggle_bundle = load_kaggle_soil_fertility(allow_fixture_fallback=False)
    kaggle_eval = evaluate_model_ladder(kaggle_bundle, n_splits=5, random_state=42)
    assert (
        verify_registry_parity(
            registry["models"]["kaggle_mineral_oc_benchmark"],
            kaggle_eval.baseline_pipeline,
            kaggle_bundle,
            tolerance=1e-6,
        )
        < 1e-6
    )


def test_non_negative_predictions_and_configurable_van_bemmelen() -> None:
    registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    for entry in registry["models"].values():
        zeros = {f: 0.0 for f in entry["preprocessing"]["raw_features"]}
        pred, lo, hi, status, d2 = predict_from_registry_entry(entry, zeros)
        assert pred >= 0.0
        assert lo >= 0.0
        assert hi >= pred
        assert np.isfinite(d2)
        assert status in {"In-Range", "Caution", "Outside Calibration Range"}

    assert soc_to_som(1.25, k=1.724) == pytest.approx(2.155)
    assert soc_to_som(1.25, k=2.0) == pytest.approx(2.5)
