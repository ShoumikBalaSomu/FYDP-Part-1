"""OOD detection via training bounds, regularized Mahalanobis D^2, and IsolationForest."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import numpy as np
from numpy.typing import NDArray
from sklearn.ensemble import IsolationForest

from ml_core.schemas import CalibrationDomainStatus


@dataclass(frozen=True)
class OODAssessment:
    """Detailed domain check returning In-Range, Caution, or Outside Calibration Range."""

    status: CalibrationDomainStatus
    mahalanobis_d2: float
    isolation_score: float
    out_of_bounds_features: list[str]
    tail_caution_features: list[str]
    reason: str


class OODDetector:
    """Domain detector combining min/max bounds, Mahalanobis D^2, and IsolationForest."""

    def __init__(
        self,
        feature_order: list[str],
        *,
        regularization_eps: float = 1e-3,
        contamination: float = 0.05,
        random_state: int = 42,
    ) -> None:
        self.feature_order = feature_order
        self.regularization_eps = float(regularization_eps)
        self.contamination = float(contamination)
        self.random_state = int(random_state)

        self.feature_mins_: NDArray[np.float64]
        self.feature_maxs_: NDArray[np.float64]
        self.feature_q01_: NDArray[np.float64]
        self.feature_q99_: NDArray[np.float64]
        self.mahalanobis_mean_: NDArray[np.float64]
        self.mahalanobis_inv_cov_: NDArray[np.float64]
        self.d2_caution_threshold_: float
        self.d2_ood_threshold_: float
        self.stds_: NDArray[np.float64]
        self.iso_forest_: IsolationForest
        self.train_ood_rate_: float
        self.iso_offset_: float

    def fit(self, X_train: NDArray[np.float64]) -> OODDetector:
        """Fit domain boundaries strictly on training-set features."""
        arr = np.asarray(X_train, dtype=np.float64)
        if arr.ndim != 2 or arr.shape[1] != len(self.feature_order):
            raise ValueError(
                f"Expected 2D array with {len(self.feature_order)} columns, got {arr.shape}."
            )

        means = np.nanmean(arr, axis=0)
        means = np.where(np.isfinite(means), means, 0.0)
        imputed = np.where(np.isnan(arr), means[np.newaxis, :], arr)

        stds = np.std(imputed, axis=0, ddof=0)
        stds = np.where(np.isfinite(stds) & (stds > 1e-12), stds, 1.0)
        z = (imputed - means[np.newaxis, :]) / stds[np.newaxis, :]

        # Scale-invariant regularized Mahalanobis precision in raw feature coordinates:
        # inv_cov_raw = D^-1 @ inv(Cov(Z) + eps * I) @ D^-1
        cov_z = np.cov(z, rowvar=False)
        if cov_z.ndim == 0:
            cov_z = np.array([[float(cov_z)]], dtype=np.float64)
        reg_cov_z = cov_z + self.regularization_eps * np.eye(len(self.feature_order))
        inv_cov_z = np.linalg.inv(reg_cov_z)
        d_inv = np.diag(1.0 / stds)
        inv_cov_raw = d_inv @ inv_cov_z @ d_inv

        diff = imputed - means[np.newaxis, :]
        d2_train = np.einsum("ij,jk,ik->i", diff, inv_cov_raw, diff)

        d2_q95 = float(np.quantile(d2_train, 0.95))
        d2_q99 = float(np.quantile(d2_train, 0.99))
        if d2_q99 <= d2_q95:
            d2_q99 = d2_q95 * 1.05 + 1e-6

        iso = IsolationForest(
            n_estimators=100,
            contamination=self.contamination,
            random_state=self.random_state,
        )
        iso.fit(z)
        iso_preds = iso.predict(z)

        self.feature_mins_ = np.min(imputed, axis=0)
        self.feature_maxs_ = np.max(imputed, axis=0)
        self.feature_q01_ = np.percentile(imputed, 1.0, axis=0)
        self.feature_q99_ = np.percentile(imputed, 99.0, axis=0)
        self.mahalanobis_mean_ = means
        self.stds_ = stds
        self.mahalanobis_inv_cov_ = inv_cov_raw
        self.d2_caution_threshold_ = d2_q95
        self.d2_ood_threshold_ = d2_q99
        self.iso_forest_ = iso
        self.train_ood_rate_ = float(np.mean(iso_preds == -1))
        self.iso_offset_ = float(iso.offset_)
        return self

    def mahalanobis_d2(self, x_vec: NDArray[np.float64]) -> float:
        """Compute regularized squared Mahalanobis distance for a single feature vector."""
        diff = x_vec - self.mahalanobis_mean_
        return float(diff @ self.mahalanobis_inv_cov_ @ diff)

    def assess(self, sample: Mapping[str, float | None]) -> OODAssessment:
        """Classify a reading as In-Range, Caution, or Outside Calibration Range."""
        vec = np.zeros(len(self.feature_order), dtype=np.float64)
        missing: list[str] = []
        for idx, feat in enumerate(self.feature_order):
            raw_val = sample.get(feat)
            if raw_val is None or not np.isfinite(float(raw_val)):
                missing.append(feat)
                vec[idx] = self.mahalanobis_mean_[idx]
            else:
                vec[idx] = float(raw_val)

        out_of_bounds: list[str] = []
        tail_caution: list[str] = []
        for idx, feat in enumerate(self.feature_order):
            val = vec[idx]
            if val < self.feature_mins_[idx] or val > self.feature_maxs_[idx]:
                out_of_bounds.append(feat)
            elif val < self.feature_q01_[idx] or val > self.feature_q99_[idx]:
                tail_caution.append(feat)

        d2 = self.mahalanobis_d2(vec)
        z = ((vec - self.mahalanobis_mean_) / self.stds_).reshape(1, -1)
        iso_score = float(self.iso_forest_.decision_function(z)[0])

        if out_of_bounds or d2 > self.d2_ood_threshold_:
            status: CalibrationDomainStatus = "Outside Calibration Range"
            reasons: list[str] = []
            if out_of_bounds:
                reasons.append(f"outside min/max bounds on {', '.join(out_of_bounds)}")
            if d2 > self.d2_ood_threshold_:
                reasons.append(
                    f"Mahalanobis D^2={d2:.2f} > {self.d2_ood_threshold_:.2f} (99th pct)"
                )
            reason = "; ".join(reasons)
        elif missing or tail_caution or d2 > self.d2_caution_threshold_ or iso_score < 0.0:
            status = "Caution"
            reasons = []
            if missing:
                reasons.append(f"mean-imputed missing feature(s): {', '.join(missing)}")
            if tail_caution:
                reasons.append(f"near distribution tails (q01-q99) on {', '.join(tail_caution)}")
            if d2 > self.d2_caution_threshold_:
                reasons.append(
                    f"Mahalanobis D^2={d2:.2f} > {self.d2_caution_threshold_:.2f} (95th pct)"
                )
            if iso_score < 0.0:
                reasons.append(f"IsolationForest decision score {iso_score:.3f} < 0")
            reason = "; ".join(reasons)
        else:
            status = "In-Range"
            reason = (
                f"Within training feature bounds and Mahalanobis D^2={d2:.2f} "
                f"<= {self.d2_caution_threshold_:.2f}."
            )

        return OODAssessment(
            status=status,
            mahalanobis_d2=d2,
            isolation_score=iso_score,
            out_of_bounds_features=out_of_bounds,
            tail_caution_features=tail_caution,
            reason=reason,
        )

    def to_registry_dict(self) -> dict[str, Any]:
        """Serialize OOD boundaries and precision matrix matching model_registry_schema.json."""
        return {
            "feature_order": list(self.feature_order),
            "feature_mins": [float(v) for v in self.feature_mins_],
            "feature_maxs": [float(v) for v in self.feature_maxs_],
            "feature_q01": [float(v) for v in self.feature_q01_],
            "feature_q99": [float(v) for v in self.feature_q99_],
            "mahalanobis_mean": [float(v) for v in self.mahalanobis_mean_],
            "mahalanobis_inv_cov": [
                [float(cell) for cell in row] for row in self.mahalanobis_inv_cov_
            ],
            "regularization_eps": float(self.regularization_eps),
            "d2_caution_threshold": float(self.d2_caution_threshold_),
            "d2_ood_threshold": float(self.d2_ood_threshold_),
            "isolation_forest_summary": {
                "n_estimators": 100,
                "contamination": float(self.contamination),
                "train_ood_rate": float(self.train_ood_rate_),
                "offset": float(self.iso_offset_),
            },
            "domain_status_labels": ["In-Range", "Caution", "Outside Calibration Range"],
        }
