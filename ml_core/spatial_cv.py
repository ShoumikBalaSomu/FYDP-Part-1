"""GroupKFold spatial cross-validation, model retention gates, and TN leakage audit."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from numpy.typing import NDArray
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import GroupKFold, KFold
from sklearn.pipeline import Pipeline

from ml_core.calibration_models import ModelSpec, build_benchmark_ladder, build_model_pipeline
from ml_core.datasets import DatasetBundle, load_srdi_kushtia


@dataclass(frozen=True)
class ModelCVResult:
    """Cross-validation metrics and out-of-fold predictions for one candidate model."""

    spec: ModelSpec
    rmse: float
    mae: float
    r2: float
    oof_predictions: NDArray[np.float64]
    fold_ids: NDArray[np.int64]
    beats_ols_baseline: bool
    retained: bool


@dataclass(frozen=True)
class BenchmarkEvaluation:
    """Complete benchmark ladder outcome with selected champion and fitted pipeline."""

    dataset_id: str
    cv_strategy: str
    n_samples: int
    n_groups: int | None
    baseline_result: ModelCVResult
    champion_result: ModelCVResult
    champion_pipeline: Pipeline
    baseline_pipeline: Pipeline
    all_results: list[ModelCVResult]


def _regression_metrics(
    y_true: NDArray[np.float64], y_pred: NDArray[np.float64]
) -> tuple[float, float, float]:
    rmse = float(np.sqrt(mean_squared_error(y_true, y_pred)))
    mae = float(mean_absolute_error(y_true, y_pred))
    r2 = float(r2_score(y_true, y_pred))
    return rmse, mae, r2


def run_cv_for_spec(
    bundle: DatasetBundle,
    spec: ModelSpec,
    *,
    n_splits: int = 5,
    use_groups: bool = True,
    random_state: int = 42,
    include_interactions: bool = True,
) -> tuple[ModelCVResult, str, int | None]:
    """Run strictly fold-isolated CV (GroupKFold when groups exist) for a single model spec."""
    X = bundle.df[bundle.feature_columns].to_numpy(dtype=np.float64)
    y = bundle.df[bundle.target_column].to_numpy(dtype=np.float64)

    groups_arr: NDArray[Any] | None = None
    n_groups: int | None = None
    if use_groups and bundle.group_column is not None and bundle.group_column in bundle.df.columns:
        groups_arr = bundle.df[bundle.group_column].to_numpy()
        n_groups = int(bundle.df[bundle.group_column].nunique())
        effective_splits = min(n_splits, n_groups)
        splitter = GroupKFold(n_splits=effective_splits)
        splits = list(splitter.split(X, y, groups_arr))
        cv_strategy = f"GroupKFold({effective_splits}, groups={bundle.group_column})"
    else:
        effective_splits = min(n_splits, len(y))
        splitter_kf = KFold(n_splits=effective_splits, shuffle=True, random_state=random_state)
        splits = list(splitter_kf.split(X, y))
        cv_strategy = f"KFold({effective_splits}, shuffle=True, seed={random_state})"

    oof = np.zeros(len(y), dtype=np.float64)
    fold_ids = np.zeros(len(y), dtype=np.int64)
    for fold_idx, (tr_idx, te_idx) in enumerate(splits):
        pipe = build_model_pipeline(
            bundle.feature_columns, spec, include_interactions=include_interactions
        )
        pipe.fit(X[tr_idx], y[tr_idx])
        preds = np.asarray(pipe.predict(X[te_idx]), dtype=np.float64)
        oof[te_idx] = np.maximum(0.0, preds)
        fold_ids[te_idx] = fold_idx

    rmse, mae, r2 = _regression_metrics(y, oof)
    res = ModelCVResult(
        spec=spec,
        rmse=rmse,
        mae=mae,
        r2=r2,
        oof_predictions=oof,
        fold_ids=fold_ids,
        beats_ols_baseline=False,
        retained=spec.key == "ols_interaction",
    )
    return res, cv_strategy, n_groups


def evaluate_model_ladder(
    bundle: DatasetBundle,
    *,
    n_splits: int = 5,
    random_state: int = 42,
    include_interactions: bool = True,
) -> BenchmarkEvaluation:
    """Evaluate all ladder models and retain only models that beat OLS on held-out folds."""
    ladder = build_benchmark_ladder(len(bundle.df), random_state=random_state)
    raw_results: list[ModelCVResult] = []
    cv_strategy = ""
    n_groups: int | None = None

    for spec in ladder:
        res, cv_strategy, n_groups = run_cv_for_spec(
            bundle,
            spec,
            n_splits=n_splits,
            use_groups=True,
            random_state=random_state,
            include_interactions=include_interactions,
        )
        raw_results.append(res)

    baseline_raw = next(r for r in raw_results if r.spec.key == "ols_interaction")
    annotated: list[ModelCVResult] = []
    for res in raw_results:
        is_baseline = res.spec.key == "ols_interaction"
        beats = (
            not is_baseline
            and (res.rmse < baseline_raw.rmse - 1e-9)
            and (res.r2 > baseline_raw.r2 + 1e-9)
        )
        annotated.append(
            ModelCVResult(
                spec=res.spec,
                rmse=res.rmse,
                mae=res.mae,
                r2=res.r2,
                oof_predictions=res.oof_predictions,
                fold_ids=res.fold_ids,
                beats_ols_baseline=beats,
                retained=is_baseline or beats,
            )
        )

    baseline_res = next(r for r in annotated if r.spec.key == "ols_interaction")
    beating = [r for r in annotated if r.beats_ols_baseline]
    champion_res = min(beating, key=lambda r: r.rmse) if beating else baseline_res

    X_full = bundle.df[bundle.feature_columns].to_numpy(dtype=np.float64)
    y_full = bundle.df[bundle.target_column].to_numpy(dtype=np.float64)

    champion_pipe = build_model_pipeline(
        bundle.feature_columns, champion_res.spec, include_interactions=include_interactions
    )
    champion_pipe.fit(X_full, y_full)

    baseline_pipe = build_model_pipeline(
        bundle.feature_columns, baseline_res.spec, include_interactions=include_interactions
    )
    baseline_pipe.fit(X_full, y_full)

    return BenchmarkEvaluation(
        dataset_id=bundle.dataset_id,
        cv_strategy=cv_strategy,
        n_samples=len(bundle.df),
        n_groups=n_groups,
        baseline_result=baseline_res,
        champion_result=champion_res,
        champion_pipeline=champion_pipe,
        baseline_pipeline=baseline_pipe,
        all_results=annotated,
    )


def compute_srdi_leakage_comparison(*, random_state: int = 42) -> dict[str, Any]:
    """Compare SRDI Kushtia with vs without TN_pct and Random KFold vs GroupKFold."""
    clean_bundle = load_srdi_kushtia(include_leaked_tn=False)
    leaked_bundle = load_srdi_kushtia(include_leaked_tn=True)
    ols_spec = build_benchmark_ladder(len(clean_bundle.df), random_state=random_state)[0]

    no_tn_rand, _, _ = run_cv_for_spec(
        clean_bundle, ols_spec, n_splits=5, use_groups=False, random_state=random_state
    )
    no_tn_grp, _, _ = run_cv_for_spec(
        clean_bundle, ols_spec, n_splits=5, use_groups=True, random_state=random_state
    )
    with_tn_rand, _, _ = run_cv_for_spec(
        leaked_bundle, ols_spec, n_splits=5, use_groups=False, random_state=random_state
    )
    with_tn_grp, _, _ = run_cv_for_spec(
        leaked_bundle, ols_spec, n_splits=5, use_groups=True, random_state=random_state
    )

    return {
        "with_tn_random_r2": round(with_tn_rand.r2, 6),
        "with_tn_group_r2": round(with_tn_grp.r2, 6),
        "without_tn_random_r2": round(no_tn_rand.r2, 6),
        "without_tn_group_r2": round(no_tn_grp.r2, 6),
        "with_tn_group_rmse": round(with_tn_grp.rmse, 6),
        "without_tn_group_rmse": round(no_tn_grp.rmse, 6),
        "tn_om_correlation": round(float(clean_bundle.audit_info["tn_om_correlation"]), 6),
        "tn_om_formula": str(clean_bundle.audit_info["tn_om_formula"]),
    }
