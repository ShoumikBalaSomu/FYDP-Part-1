"""Model explainability (SHAP / standardized coefficients) and subgroup error stratification."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd
import shap
from numpy.typing import NDArray
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.pipeline import Pipeline

from ml_core.calibration_models import StandardizedInteractionPreprocessor


@dataclass(frozen=True)
class _RawImportance:
    feature: str
    importance: float
    signed_effect: float | None


def compute_global_importance(
    pipeline: Pipeline,
    X_train: NDArray[np.float64],
) -> tuple[str, list[dict[str, Any]]]:
    """Compute global feature importances via coefficients or SHAP TreeExplainer."""
    prep: StandardizedInteractionPreprocessor = pipeline.named_steps["prep"]
    est = pipeline.named_steps["model"]
    z_train = prep.transform(X_train)
    feature_names = prep.output_feature_names_

    raw_items: list[_RawImportance]
    if hasattr(est, "coef_"):
        method = "standardized_coefficients"
        coefs = np.asarray(est.coef_, dtype=np.float64).ravel()
        raw_items = [
            _RawImportance(feature=name, importance=float(abs(coef)), signed_effect=float(coef))
            for name, coef in zip(feature_names, coefs, strict=True)
        ]
    else:
        method = "shap_tree_explainer"
        explainer = shap.TreeExplainer(est)
        shap_vals = np.asarray(explainer.shap_values(z_train), dtype=np.float64)
        raw_items = []
        for idx, name in enumerate(feature_names):
            sv = shap_vals[:, idx]
            imp = float(np.mean(np.abs(sv)))
            z_col = z_train[:, idx]
            signed: float | None = None
            if np.std(sv) > 1e-12 and np.std(z_col) > 1e-12:
                corr = float(np.corrcoef(z_col, sv)[0, 1])
                signed = float(corr * imp)
            raw_items.append(_RawImportance(feature=name, importance=imp, signed_effect=signed))

    sorted_items = sorted(raw_items, key=lambda d: d.importance, reverse=True)
    ranked: list[dict[str, Any]] = [
        {
            "feature": item.feature,
            "importance": round(item.importance, 8),
            "signed_effect": (
                None if item.signed_effect is None else round(item.signed_effect, 8)
            ),
            "rank": rank_idx,
        }
        for rank_idx, item in enumerate(sorted_items, start=1)
    ]
    return method, ranked


def compute_stratified_errors(
    df: pd.DataFrame,
    y_true: NDArray[np.float64],
    y_pred_oof: NDArray[np.float64],
    stratum_columns: Sequence[str],
) -> list[dict[str, Any]]:
    """Compute held-out OOF RMSE, MAE, and R2 across agronomic strata (depth, texture, order)."""
    records: list[dict[str, Any]] = []
    for col in stratum_columns:
        if col not in df.columns:
            continue
        series = df[col].fillna("Missing").astype(str)
        for val in sorted(series.unique()):
            mask = (series == val).to_numpy()
            n_sub = int(np.sum(mask))
            if n_sub < 1:
                continue
            yt = y_true[mask]
            yp = y_pred_oof[mask]
            rmse = float(np.sqrt(mean_squared_error(yt, yp)))
            mae = float(mean_absolute_error(yt, yp))
            r2_val: float | None = None
            if n_sub >= 2 and float(np.var(yt)) > 1e-12:
                r2_val = round(float(r2_score(yt, yp)), 6)
            records.append(
                {
                    "stratum_column": col,
                    "stratum_value": val,
                    "n": n_sub,
                    "rmse": round(rmse, 6),
                    "mae": round(mae, 6),
                    "r2": r2_val,
                }
            )
    return records
