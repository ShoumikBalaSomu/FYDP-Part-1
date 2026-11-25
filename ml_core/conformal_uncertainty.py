"""Out-of-fold / split conformal prediction intervals with non-negative lower-bound clamping."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray


@dataclass(frozen=True)
class ConformalSummary:
    """Calibrated conformal quantile and out-of-fold empirical coverage diagnostics."""

    method: str
    alpha: float
    q_quantile: float
    empirical_coverage: float
    mean_interval_width: float


def compute_conformal_quantile(residuals: NDArray[np.float64], alpha: float = 0.05) -> float:
    """Compute finite-sample conformal quantile q_{1-alpha} using ceil((n+1)*(1-alpha))/n."""
    if not 0.0 < alpha < 1.0:
        raise ValueError(f"alpha must lie in (0, 1), got {alpha}")
    n = len(residuals)
    if n < 1:
        raise ValueError("At least 1 calibration residual is required.")
    level = min(1.0, math.ceil((n + 1) * (1.0 - alpha)) / float(n))
    q_val = float(np.quantile(residuals, level, method="higher"))
    return max(0.0, q_val)


def evaluate_oof_conformal(
    y_true: NDArray[np.float64],
    y_pred_oof: NDArray[np.float64],
    fold_ids: NDArray[np.int64],
    *,
    alpha: float = 0.05,
) -> ConformalSummary:
    """Compute OOF conformal quantile and verify held-out cross-conformal empirical coverage."""
    residuals = np.abs(y_true - y_pred_oof)
    unique_folds = np.unique(fold_ids)

    covered_flags: list[bool] = []
    widths: list[float] = []
    for f in unique_folds:
        val_mask = fold_ids == f
        cal_mask = ~val_mask
        cal_res = residuals[cal_mask] if np.any(cal_mask) else residuals
        q_f = compute_conformal_quantile(cal_res, alpha=alpha)
        lo = np.maximum(0.0, y_pred_oof[val_mask] - q_f)
        hi = np.maximum(0.0, y_pred_oof[val_mask] + q_f)
        cov = (y_true[val_mask] >= lo) & (y_true[val_mask] <= hi)
        covered_flags.extend(bool(c) for c in cov)
        widths.extend(float(w) for w in (hi - lo))

    q_final = compute_conformal_quantile(residuals, alpha=alpha)
    return ConformalSummary(
        method="oof_conformal",
        alpha=float(alpha),
        q_quantile=q_final,
        empirical_coverage=float(np.mean(covered_flags)),
        mean_interval_width=float(np.mean(widths)),
    )


def conformal_interval(
    y_hat: float,
    q_quantile: float,
    *,
    scale_factor: float = 1.0,
) -> tuple[float, float, float]:
    """Return clamped (point_estimate, ci_lower >= 0, ci_upper >= 0) scaled by optional factor."""
    point = max(0.0, float(y_hat)) * float(scale_factor)
    half_width = max(0.0, float(q_quantile)) * float(scale_factor)
    lower = max(0.0, point - half_width)
    upper = max(0.0, point + half_width)
    return point, lower, upper
