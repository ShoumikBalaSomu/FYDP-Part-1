"""Core ML pipeline, dataset harmonization, conformal intervals, OOD, and POXC tests."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from ml_core.calibration_models import (  # noqa: E402
    StandardizedInteractionPreprocessor,
    build_benchmark_ladder,
    build_model_pipeline,
)
from ml_core.conformal_uncertainty import conformal_interval, evaluate_oof_conformal  # noqa: E402
from ml_core.datasets import (  # noqa: E402
    load_kaggle_soil_fertility,
    load_srdi_kushtia,
    load_usda_kssl_poxc,
)
from ml_core.explainability import compute_global_importance, compute_stratified_errors  # noqa: E402
from ml_core.ood_detector import OODDetector  # noqa: E402
from ml_core.poxc_pipeline import (  # noqa: E402
    enforce_no_passive_c_subtraction,
    predict_poxc,
    train_poxc_pipeline,
)
from ml_core.schemas import SoilReadingInput  # noqa: E402
from ml_core.soil_physics import (  # noqa: E402
    DEFAULT_VAN_BEMMELEN_K,
    classify_barc_som,
    k_cmol_to_mg_kg,
    soc_g_kg_to_pct,
    soc_to_som,
)
from ml_core.spatial_cv import compute_srdi_leakage_comparison, evaluate_model_ladder  # noqa: E402


def test_srdi_kushtia_harmonization_and_tn_exclusion() -> None:
    bundle = load_srdi_kushtia()
    assert len(bundle.df) == 171
    assert bundle.df["Sample_ID"].nunique() == 57
    assert "total_nitrogen_pct" not in bundle.feature_columns
    assert "TN_pct" not in bundle.feature_columns
    assert np.allclose(bundle.df["potassium_mg_kg"], bundle.df["K_cmol_kg"] * 391.0)
    assert set(bundle.df["depth_mid_cm"].unique()) == {10.0, 30.0, 50.0}
    assert bundle.audit_info["tn_om_correlation"] > 0.97
    assert k_cmol_to_mg_kg(0.23) == pytest.approx(89.93)


def test_kaggle_outlier_flagging_and_fixture_fallback(tmp_path: Path) -> None:
    bundle = load_kaggle_soil_fertility(allow_fixture_fallback=False)
    assert bundle.audit_info["raw_rows"] == 880
    assert bundle.audit_info["flagged_outlier_rows"] == 7
    assert bundle.audit_info["clean_rows"] == 873
    assert len(bundle.df) == 873
    assert len(bundle.excluded_df) == 7
    assert not bundle.is_synthetic_or_fixture

    missing = tmp_path / "missing.csv"
    with pytest.raises(FileNotFoundError):
        load_kaggle_soil_fertility(path=missing, allow_fixture_fallback=False)

    fixture_bundle = load_kaggle_soil_fertility(path=missing, allow_fixture_fallback=True)
    assert fixture_bundle.is_synthetic_or_fixture is True
    assert fixture_bundle.dataset_id == "ci_schema_fixture_only"
    assert len(fixture_bundle.df) == 6


def test_usda_kssl_poxc_unit_conversion_and_subset() -> None:
    bundle = load_usda_kssl_poxc(include_lab_soc=True)
    assert bundle.audit_info["raw_samples"] == 42
    assert bundle.audit_info["raw_pedons"] == 38
    assert bundle.audit_info["standard_rows_total"] == 42
    assert bundle.audit_info["valid_quantified_rows"] == 38
    assert bundle.audit_info["reagent_exhausted_or_unquantified_rows"] == 4
    assert soc_g_kg_to_pct(28.0) == pytest.approx(2.8)
    assert bundle.audit_info["max_ratio_verification_diff"] < 0.001


def test_standardized_interaction_preprocessor_adds_t_m_ec_terms() -> None:
    features = [
        "nitrogen_mg_kg",
        "phosphorus_mg_kg",
        "potassium_mg_kg",
        "ph",
        "ec_ds_m",
        "temperature_c",
        "moisture_pct",
    ]
    rng = np.random.default_rng(42)
    X = rng.normal(loc=10.0, scale=2.0, size=(30, len(features)))
    X[0, 1] = np.nan  # test mean-imputation -> z = 0.0

    prep = StandardizedInteractionPreprocessor(features, include_interactions=True)
    z = prep.fit_transform(X)
    assert z.shape == (30, 9)
    assert prep.output_feature_names_[-2:] == [
        "z_temperature_c_x_z_moisture_pct",
        "z_ec_ds_m_x_z_moisture_pct",
    ]
    assert z[0, 1] == pytest.approx(0.0, abs=1e-12)


def test_srdi_groupkfold_ladder_and_leakage_demo() -> None:
    bundle = load_srdi_kushtia()
    ev = evaluate_model_ladder(bundle, n_splits=5, random_state=42)
    assert "GroupKFold" in ev.cv_strategy
    assert ev.n_groups == 57
    assert ev.champion_result.beats_ols_baseline is True
    assert ev.champion_result.rmse < ev.baseline_result.rmse

    leak = compute_srdi_leakage_comparison(random_state=42)
    assert leak["with_tn_group_r2"] > 0.90
    assert leak["without_tn_group_r2"] < 0.25


def test_conformal_coverage_and_non_negative_bounds() -> None:
    bundle = load_srdi_kushtia()
    ev = evaluate_model_ladder(bundle, n_splits=5, random_state=42)
    y = bundle.df[bundle.target_column].to_numpy(dtype=np.float64)
    conf = evaluate_oof_conformal(
        y, ev.champion_result.oof_predictions, ev.champion_result.fold_ids, alpha=0.05
    )
    assert conf.empirical_coverage >= 0.90
    assert conf.q_quantile > 0.0
    pt, lo, hi = conformal_interval(0.1, conf.q_quantile)
    assert pt == pytest.approx(0.1)
    assert lo == 0.0
    assert hi > pt


def test_ood_detector_status_transitions() -> None:
    bundle = load_srdi_kushtia()
    X = bundle.df[bundle.feature_columns].to_numpy(dtype=np.float64)
    ood = OODDetector(bundle.feature_columns, random_state=42).fit(X)

    medians = {
        col: float(np.median(bundle.df[col])) for col in bundle.feature_columns
    }
    in_range = ood.assess(medians)
    assert in_range.status == "In-Range"

    extreme = dict(medians)
    extreme["potassium_mg_kg"] = 950.0  # far beyond SRDI max ~180 mg/kg
    outside = ood.assess(extreme)
    assert outside.status == "Outside Calibration Range"


def test_poxc_pipeline_and_passive_carbon_guardrail() -> None:
    poxc_with = train_poxc_pipeline(include_lab_soc=True, n_splits=5, random_state=42)
    poxc_without = train_poxc_pipeline(include_lab_soc=False, n_splits=5, random_state=42)
    assert poxc_with.evaluation.champion_result.r2 > 0.65
    assert poxc_without.evaluation.champion_result.r2 > 0.10

    healthy = SoilReadingInput(
        ph=6.5, sand_pct=25.0, silt_pct=45.0, clay_pct=30.0, depth_mid_cm=5.0
    )
    res = predict_poxc(poxc_with, healthy, lab_soc_pct=2.2)
    assert not res.blocked
    assert res.unit == "mg C/kg dry soil"
    assert res.estimated_poxc_mg_kg is not None and res.estimated_poxc_mg_kg > 0.0
    assert res.poxc_ci95_lower is not None and res.poxc_ci95_lower >= 0.0

    fault = SoilReadingInput(ph=0.12, sand_pct=25.0, silt_pct=45.0, clay_pct=30.0, depth_mid_cm=5.0)
    blocked = predict_poxc(poxc_with, fault, lab_soc_pct=2.2)
    assert blocked.blocked is True
    assert blocked.estimated_poxc_mg_kg is None

    with pytest.raises(ValueError, match="PASSIVE_CARBON_GUARDRAIL_VIOLATION"):
        enforce_no_passive_c_subtraction(total_soc_pct=2.5, poxc_mg_kg=750.0)

    assert enforce_no_passive_c_subtraction(
        total_soc_pct=2.5, poxc_mg_kg=750.0, mineral_associated_oc_pct=1.4
    ) == pytest.approx(1.4)


def test_explainability_and_barc_helpers() -> None:
    bundle = load_srdi_kushtia()
    spec = build_benchmark_ladder(len(bundle.df))[0]
    pipe = build_model_pipeline(bundle.feature_columns, spec)
    X = bundle.df[bundle.feature_columns].to_numpy(dtype=np.float64)
    y = bundle.df[bundle.target_column].to_numpy(dtype=np.float64)
    pipe.fit(X, y)

    method, ranked = compute_global_importance(pipe, X)
    assert method == "standardized_coefficients"
    assert [r["rank"] for r in ranked] == list(range(1, len(bundle.feature_columns) + 1))

    strata = compute_stratified_errors(bundle.df, y, pipe.predict(X), ["Depth_cm", "Soil_texture"])
    assert len(strata) >= 6

    assert soc_to_som(1.0) == pytest.approx(DEFAULT_VAN_BEMMELEN_K)
    assert soc_to_som(-0.5) == 0.0
    assert classify_barc_som(0.8) == "Very Low"
    assert classify_barc_som(1.4) == "Low"
    assert classify_barc_som(2.1) == "Medium"
    assert classify_barc_som(4.0) == "High"
    assert classify_barc_som(6.0) == "Very High"
