"""Separate USDA KSSL POX-C active carbon pipeline (mg C/kg dry soil) with Pedon_ID GroupKFold."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ml_core.conformal_uncertainty import (
    ConformalSummary,
    conformal_interval,
    evaluate_oof_conformal,
)
from ml_core.datasets import DatasetBundle, load_usda_kssl_poxc
from ml_core.ood_detector import OODDetector
from ml_core.schemas import POXCPredictionResult, SoilReadingInput
from ml_core.soil_physics import compute_passive_carbon_guarded, validate_soil_reading
from ml_core.spatial_cv import BenchmarkEvaluation, evaluate_model_ladder


@dataclass(frozen=True)
class POXCArtifactBundle:
    """Complete trained POXC benchmark, OOD detector, and conformal uncertainty summary."""

    dataset_bundle: DatasetBundle
    evaluation: BenchmarkEvaluation
    conformal: ConformalSummary
    ood_detector: OODDetector


def train_poxc_pipeline(
    *,
    include_lab_soc: bool,
    n_splits: int = 5,
    random_state: int = 42,
) -> POXCArtifactBundle:
    """Train and evaluate POXC pipeline using GroupKFold(groups=Pedon_ID).

    Trains separate models with and without laboratory SOC (converted from g/kg to %).
    """
    bundle = load_usda_kssl_poxc(include_lab_soc=include_lab_soc)
    evaluation = evaluate_model_ladder(
        bundle,
        n_splits=n_splits,
        random_state=random_state,
        include_interactions=False,
    )
    y_true = bundle.df[bundle.target_column].to_numpy(dtype=np.float64)
    conformal = evaluate_oof_conformal(
        y_true=y_true,
        y_pred_oof=evaluation.champion_result.oof_predictions,
        fold_ids=evaluation.champion_result.fold_ids,
        alpha=0.05,
    )
    X_full = bundle.df[bundle.feature_columns].to_numpy(dtype=np.float64)
    ood = OODDetector(feature_order=bundle.feature_columns, random_state=random_state).fit(X_full)
    return POXCArtifactBundle(
        dataset_bundle=bundle,
        evaluation=evaluation,
        conformal=conformal,
        ood_detector=ood,
    )


def predict_poxc(
    artifact: POXCArtifactBundle,
    reading: SoilReadingInput,
    *,
    lab_soc_pct: float | None = None,
    model_version: str = "1.0.0",
) -> POXCPredictionResult:
    """Predict active carbon (POXC) strictly in mg C/kg dry soil with 95% conformal PI."""
    report = validate_soil_reading(reading, soc_pct=lab_soc_pct)
    model_id = artifact.dataset_bundle.dataset_id

    if not report.passed_hard_gates:
        return POXCPredictionResult(
            estimated_poxc_mg_kg=None,
            poxc_ci95_lower=None,
            poxc_ci95_upper=None,
            model_id=model_id,
            model_version=model_version,
            calibration_domain_status="Outside Calibration Range",
            ood_mahalanobis_d2=None,
            blocked=True,
            block_reason="Blocked by critical soil physics/sensor fault gate.",
            physics_report=report,
        )

    sample_map: dict[str, float | None] = {
        "soc_pct": lab_soc_pct,
        "ph": reading.ph,
        "sand_pct": reading.sand_pct,
        "silt_pct": reading.silt_pct,
        "clay_pct": reading.clay_pct,
        "depth_mid_cm": reading.depth_mid_cm,
    }
    if "soc_pct" in artifact.dataset_bundle.feature_columns and lab_soc_pct is None:
        raise ValueError("POXC with-SOC pipeline requires lab_soc_pct (%SOC).")

    ood_res = artifact.ood_detector.assess(sample_map)
    x_vec = np.array(
        [
            np.nan if sample_map[col] is None else float(sample_map[col])  # type: ignore[arg-type]
            for col in artifact.dataset_bundle.feature_columns
        ],
        dtype=np.float64,
    ).reshape(1, -1)
    y_hat = float(artifact.evaluation.champion_pipeline.predict(x_vec)[0])
    point, lower, upper = conformal_interval(y_hat, artifact.conformal.q_quantile)

    return POXCPredictionResult(
        estimated_poxc_mg_kg=point,
        poxc_ci95_lower=lower,
        poxc_ci95_upper=upper,
        model_id=model_id,
        model_version=model_version,
        calibration_domain_status=ood_res.status,
        ood_mahalanobis_d2=ood_res.mahalanobis_d2,
        blocked=False,
        block_reason=None,
        physics_report=report,
    )


def enforce_no_passive_c_subtraction(
    total_soc_pct: float,
    poxc_mg_kg: float,
    *,
    mineral_associated_oc_pct: float | None = None,
) -> float:
    """Enforce Passive C != Total SOC - POXC guardrail unless full fractionation is supplied."""
    return compute_passive_carbon_guarded(
        total_soc_pct=total_soc_pct,
        poxc_mg_kg=poxc_mg_kg,
        mineral_associated_oc_pct=mineral_associated_oc_pct,
    )
