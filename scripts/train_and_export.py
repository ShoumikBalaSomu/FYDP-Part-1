"""Train SOMSense benchmark models, run audits, verify <1e-6 JSON parity, and export registry."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path
from typing import Any

import numpy as np

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from ml_core.conformal_uncertainty import evaluate_oof_conformal  # noqa: E402
from ml_core.datasets import (  # noqa: E402
    load_kaggle_soil_fertility,
    load_srdi_kushtia,
)
from ml_core.export_artifacts import (  # noqa: E402
    build_model_entry,
    build_registry_document,
    verify_registry_parity,
    write_registry_and_manifest,
)
from ml_core.ood_detector import OODDetector  # noqa: E402
from ml_core.poxc_pipeline import train_poxc_pipeline  # noqa: E402
from ml_core.spatial_cv import (  # noqa: E402
    compute_srdi_leakage_comparison,
    evaluate_model_ladder,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

MODEL_VERSION = "1.0.0"


def _add_kaggle_strata(df: Any) -> Any:
    """Add agronomic pH band stratum for Kaggle stratified error diagnostics."""
    out = df.copy()

    def _ph_band(ph: float) -> str:
        if ph < 6.5:
            return "Acidic (<6.5)"
        if ph <= 7.5:
            return "Neutral (6.5-7.5)"
        return "Alkaline (>7.5)"

    out["ph_band"] = out["ph"].map(_ph_band)
    if "Output" in out.columns:
        out["fertility_class_label"] = out["Output"].map(lambda v: f"Class_{int(v)}")
    return out


def _add_usda_strata(df: Any) -> Any:
    """Add depth band stratum alongside Soil Order for USDA KSSL POXC error diagnostics."""
    out = df.copy()
    out["depth_band"] = out["depth_mid_cm"].map(
        lambda d: "Surface (<=5 cm)" if float(d) <= 5.0 else "Subsurface (>5 cm)"
    )
    return out


def run_pipeline(
    *,
    registry_path: Path = ROOT_DIR / "models" / "registry.json",
    manifest_path: Path = ROOT_DIR / "models" / "artifacts_manifest.json",
) -> dict[str, Any]:
    """Execute full SOMSense training, conformal calibration, OOD, and export pipeline."""
    # 1. SRDI Kushtia (171 rows, 57 Sample_IDs x 3 depths, TN_pct strictly excluded)
    logger.info("Training SRDI Kushtia SOM calibration models (GroupKFold by Sample_ID)...")
    srdi_bundle = load_srdi_kushtia(include_leaked_tn=False)
    srdi_eval = evaluate_model_ladder(srdi_bundle, n_splits=5, random_state=42)
    srdi_y = srdi_bundle.df[srdi_bundle.target_column].to_numpy(dtype=np.float64)
    srdi_X = srdi_bundle.df[srdi_bundle.feature_columns].to_numpy(dtype=np.float64)
    srdi_ood = OODDetector(srdi_bundle.feature_columns, random_state=42).fit(srdi_X)

    srdi_champ_conf = evaluate_oof_conformal(
        srdi_y,
        srdi_eval.champion_result.oof_predictions,
        srdi_eval.champion_result.fold_ids,
        alpha=0.05,
    )
    srdi_ols_conf = evaluate_oof_conformal(
        srdi_y,
        srdi_eval.baseline_result.oof_predictions,
        srdi_eval.baseline_result.fold_ids,
        alpha=0.05,
    )
    srdi_leakage = compute_srdi_leakage_comparison(random_state=42)

    srdi_champ_entry = build_model_entry(
        model_id="srdi_kushtia_om_champion",
        model_version=MODEL_VERSION,
        bundle=srdi_bundle,
        evaluation=srdi_eval,
        cv_result=srdi_eval.champion_result,
        fitted_pipeline=srdi_eval.champion_pipeline,
        conformal=srdi_champ_conf,
        ood_detector=srdi_ood,
        selection_status=(
            "selected_champion"
            if srdi_eval.champion_result.beats_ols_baseline
            else "baseline_ols"
        ),
        stratum_columns=["Depth_cm", "Soil_texture", "Land_use_grouped"],
        notes=(
            "Trained on SRDI Kushtia (171 rows, 57 Sample_IDs) using K_mg_kg = K_cmol_kg * 391 "
            "and depth_mid_cm. TN_pct strictly excluded due to circular derivation "
            f"({srdi_leakage['tn_om_formula']}, r={srdi_leakage['tn_om_correlation']:.4f})."
        ),
    )

    srdi_ols_entry = build_model_entry(
        model_id="srdi_kushtia_om_baseline_ols",
        model_version=MODEL_VERSION,
        bundle=srdi_bundle,
        evaluation=srdi_eval,
        cv_result=srdi_eval.baseline_result,
        fitted_pipeline=srdi_eval.baseline_pipeline,
        conformal=srdi_ols_conf,
        ood_detector=srdi_ood,
        selection_status="baseline_ols",
        stratum_columns=["Depth_cm", "Soil_texture", "Land_use_grouped"],
        notes=(
            "Standardized Linear OLS baseline on SRDI Kushtia (5 physical/mineral features, "
            "excluding TN_pct) used as benchmark gate."
        ),
    )

    # 2. Kaggle Soil Fertility (880 raw -> 7 corrupt outliers flagged -> 873 clean rows)
    logger.info("Benchmarking Kaggle Soil Fertility mineral-only dataset (880 -> 873 clean)...")
    kaggle_bundle = load_kaggle_soil_fertility(allow_fixture_fallback=False)
    kaggle_bundle_strat = type(kaggle_bundle)(
        dataset_id=kaggle_bundle.dataset_id,
        source_title=kaggle_bundle.source_title,
        doi_or_slug=kaggle_bundle.doi_or_slug,
        is_synthetic_or_fixture=kaggle_bundle.is_synthetic_or_fixture,
        df=_add_kaggle_strata(kaggle_bundle.df),
        excluded_df=kaggle_bundle.excluded_df,
        feature_columns=kaggle_bundle.feature_columns,
        target_column=kaggle_bundle.target_column,
        target_unit=kaggle_bundle.target_unit,
        group_column=kaggle_bundle.group_column,
        audit_info=kaggle_bundle.audit_info,
    )
    kaggle_eval = evaluate_model_ladder(kaggle_bundle_strat, n_splits=5, random_state=42)
    kaggle_y = kaggle_bundle_strat.df[kaggle_bundle_strat.target_column].to_numpy(
        dtype=np.float64
    )
    kaggle_X = kaggle_bundle_strat.df[kaggle_bundle_strat.feature_columns].to_numpy(
        dtype=np.float64
    )
    kaggle_ood = OODDetector(kaggle_bundle_strat.feature_columns, random_state=42).fit(kaggle_X)
    kaggle_ridge_res = next(r for r in kaggle_eval.all_results if r.spec.key == "ridge")
    kaggle_ols_conf = evaluate_oof_conformal(
        kaggle_y,
        kaggle_eval.baseline_result.oof_predictions,
        kaggle_eval.baseline_result.fold_ids,
        alpha=0.05,
    )

    kaggle_entry = build_model_entry(
        model_id="kaggle_mineral_oc_benchmark",
        model_version=MODEL_VERSION,
        bundle=kaggle_bundle_strat,
        evaluation=kaggle_eval,
        cv_result=kaggle_eval.baseline_result,
        fitted_pipeline=kaggle_eval.baseline_pipeline,
        conformal=kaggle_ols_conf,
        ood_detector=kaggle_ood,
        selection_status="benchmark_reference",
        stratum_columns=["ph_band", "fertility_class_label"],
        notes=(
            "Honest negative/near-zero R2 benchmark on 873 cleaned rows (7 corrupt outliers "
            "flagged: pH 0.90/10.05-11.15, OC=24.0%, Zn=42.0/Fe=44.0). Demonstrates that "
            "mineral-only N, P, K, pH, EC cannot predict OC/SOM without Temperature, Moisture, "
            "and local AEZ calibration."
        ),
    )

    kaggle_audit = {
        "raw_rows": int(kaggle_bundle.audit_info["raw_rows"]),
        "flagged_outlier_rows": int(kaggle_bundle.audit_info["flagged_outlier_rows"]),
        "clean_rows": int(kaggle_bundle.audit_info["clean_rows"]),
        "ridge_5feat_r2": round(float(kaggle_ridge_res.r2), 6),
        "ridge_5feat_rmse": round(float(kaggle_ridge_res.rmse), 6),
        "outlier_criteria": str(kaggle_bundle.audit_info["outlier_criteria"]),
    }

    # 3. USDA KSSL POX-C (separate active carbon pipeline with and without lab SOC)
    logger.info("Training USDA KSSL POX-C pipelines (GroupKFold by Pedon_ID)...")
    poxc_with = train_poxc_pipeline(include_lab_soc=True, n_splits=5, random_state=42)
    poxc_without = train_poxc_pipeline(include_lab_soc=False, n_splits=5, random_state=42)

    poxc_with_bundle = type(poxc_with.dataset_bundle)(
        dataset_id=poxc_with.dataset_bundle.dataset_id,
        source_title=poxc_with.dataset_bundle.source_title,
        doi_or_slug=poxc_with.dataset_bundle.doi_or_slug,
        is_synthetic_or_fixture=poxc_with.dataset_bundle.is_synthetic_or_fixture,
        df=_add_usda_strata(poxc_with.dataset_bundle.df),
        excluded_df=poxc_with.dataset_bundle.excluded_df,
        feature_columns=poxc_with.dataset_bundle.feature_columns,
        target_column=poxc_with.dataset_bundle.target_column,
        target_unit=poxc_with.dataset_bundle.target_unit,
        group_column=poxc_with.dataset_bundle.group_column,
        audit_info=poxc_with.dataset_bundle.audit_info,
    )
    poxc_without_bundle = type(poxc_without.dataset_bundle)(
        dataset_id=poxc_without.dataset_bundle.dataset_id,
        source_title=poxc_without.dataset_bundle.source_title,
        doi_or_slug=poxc_without.dataset_bundle.doi_or_slug,
        is_synthetic_or_fixture=poxc_without.dataset_bundle.is_synthetic_or_fixture,
        df=_add_usda_strata(poxc_without.dataset_bundle.df),
        excluded_df=poxc_without.dataset_bundle.excluded_df,
        feature_columns=poxc_without.dataset_bundle.feature_columns,
        target_column=poxc_without.dataset_bundle.target_column,
        target_unit=poxc_without.dataset_bundle.target_unit,
        group_column=poxc_without.dataset_bundle.group_column,
        audit_info=poxc_without.dataset_bundle.audit_info,
    )

    poxc_with_entry = build_model_entry(
        model_id="usda_kssl_poxc_with_soc",
        model_version=MODEL_VERSION,
        bundle=poxc_with_bundle,
        evaluation=poxc_with.evaluation,
        cv_result=poxc_with.evaluation.champion_result,
        fitted_pipeline=poxc_with.evaluation.champion_pipeline,
        conformal=poxc_with.conformal,
        ood_detector=poxc_with.ood_detector,
        selection_status=(
            "selected_champion"
            if poxc_with.evaluation.champion_result.beats_ols_baseline
            else "baseline_ols"
        ),
        stratum_columns=["Order", "depth_band"],
        notes=(
            "Separate USDA-NRCS KSSL POX-C (mg C/kg dry soil) model on <2 mm & 2.5 g subset "
            "including lab SOC (% = g/kg / 10). Enforces Passive C != Total SOC - POXC."
        ),
    )

    poxc_without_entry = build_model_entry(
        model_id="usda_kssl_poxc_without_soc",
        model_version=MODEL_VERSION,
        bundle=poxc_without_bundle,
        evaluation=poxc_without.evaluation,
        cv_result=poxc_without.evaluation.champion_result,
        fitted_pipeline=poxc_without.evaluation.champion_pipeline,
        conformal=poxc_without.conformal,
        ood_detector=poxc_without.ood_detector,
        selection_status=(
            "selected_champion"
            if poxc_without.evaluation.champion_result.beats_ols_baseline
            else "baseline_ols"
        ),
        stratum_columns=["Order", "depth_band"],
        notes=(
            "USDA-NRCS KSSL POX-C (mg C/kg dry soil) baseline without lab SOC (pH, Sand, Silt, "
            "Clay, depth_mid_cm) on <2 mm & 2.5 g subset."
        ),
    )

    usda_audit_raw = poxc_with.dataset_bundle.audit_info
    usda_audit = {
        "raw_samples": int(usda_audit_raw["raw_samples"]),
        "raw_pedons": int(usda_audit_raw["raw_pedons"]),
        "standard_subset_prep": str(usda_audit_raw["standard_subset_prep"]),
        "standard_subset_mass_g": float(usda_audit_raw["standard_subset_mass_g"]),
        "standard_rows_total": int(usda_audit_raw["standard_rows_total"]),
        "valid_quantified_rows": int(usda_audit_raw["valid_quantified_rows"]),
        "reagent_exhausted_or_unquantified_rows": int(
            usda_audit_raw["reagent_exhausted_or_unquantified_rows"]
        ),
        "unit_bug_factor": float(usda_audit_raw["unit_bug_factor"]),
    }

    models_map = {
        "srdi_kushtia_om_champion": srdi_champ_entry,
        "srdi_kushtia_om_baseline_ols": srdi_ols_entry,
        "kaggle_mineral_oc_benchmark": kaggle_entry,
        "usda_kssl_poxc_with_soc": poxc_with_entry,
        "usda_kssl_poxc_without_soc": poxc_without_entry,
    }

    parity_diffs = {
        "srdi_kushtia_om_champion": verify_registry_parity(
            srdi_champ_entry, srdi_eval.champion_pipeline, srdi_bundle
        ),
        "srdi_kushtia_om_baseline_ols": verify_registry_parity(
            srdi_ols_entry, srdi_eval.baseline_pipeline, srdi_bundle
        ),
        "kaggle_mineral_oc_benchmark": verify_registry_parity(
            kaggle_entry, kaggle_eval.baseline_pipeline, kaggle_bundle_strat
        ),
        "usda_kssl_poxc_with_soc": verify_registry_parity(
            poxc_with_entry, poxc_with.evaluation.champion_pipeline, poxc_with_bundle
        ),
        "usda_kssl_poxc_without_soc": verify_registry_parity(
            poxc_without_entry, poxc_without.evaluation.champion_pipeline, poxc_without_bundle
        ),
    }

    registry_doc = build_registry_document(
        models=models_map,
        srdi_tn_leakage=srdi_leakage,
        kaggle_mineral_only=kaggle_audit,
        usda_poxc_unit_audit=usda_audit,
    )
    write_registry_and_manifest(
        registry_doc,
        registry_path=registry_path,
        manifest_path=manifest_path,
        parity_diffs=parity_diffs,
    )
    logger.info("Wrote %s and %s", registry_path, manifest_path)
    return registry_doc


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--registry",
        type=Path,
        default=ROOT_DIR / "models" / "registry.json",
        help="Output path for portable models/registry.json.",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=ROOT_DIR / "models" / "artifacts_manifest.json",
        help="Output path for models/artifacts_manifest.json.",
    )
    args = parser.parse_args()
    doc = run_pipeline(registry_path=args.registry, manifest_path=args.manifest)

    for mid, entry in doc["models"].items():
        m = entry["metrics"]
        u = entry["uncertainty"]
        logger.info(
            "%-30s family=%-31s R2=%7.4f RMSE=%8.4f q95=%7.4f cov=%.3f",
            mid,
            entry["selected_model_family"],
            m["r2"],
            m["rmse"],
            u["q_095"],
            u["empirical_coverage"],
        )
    logger.info("SRDI TN leakage audit: %s", doc["leakage_and_quality_audits"]["srdi_tn_leakage"])
    logger.info("Kaggle audit: %s", doc["leakage_and_quality_audits"]["kaggle_mineral_only"])
    logger.info("USDA POXC audit: %s", doc["leakage_and_quality_audits"]["usda_poxc_unit_audit"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
