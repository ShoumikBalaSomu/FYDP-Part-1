"""Calibration model ladder and fold-safe standardized linear+interaction preprocessing."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

import numpy as np
from lightgbm import LGBMRegressor
from numpy.typing import NDArray
from sklearn.base import BaseEstimator, TransformerMixin
from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import ElasticNet, HuberRegressor, LinearRegression, Ridge
from sklearn.pipeline import Pipeline

ModelFamily = Literal[
    "standardized_linear_interaction",
    "ridge",
    "elastic_net",
    "huber",
    "random_forest",
    "hist_gradient_boosting",
    "lightgbm",
]


@dataclass(frozen=True)
class InteractionSpec:
    """Definition of a standardized product interaction term (e.g., z_T * z_M)."""

    name: str
    op: Literal["z_product"]
    left: str
    right: str


@dataclass(frozen=True)
class ModelSpec:
    """Candidate benchmark model definition."""

    key: str
    family_name: ModelFamily
    factory: Callable[[], BaseEstimator]


class StandardizedInteractionPreprocessor(BaseEstimator, TransformerMixin):  # type: ignore[misc]
    """Fold-safe mean imputer, z-score standardizer, and physical interaction builder.

    Fits training means/stds strictly on the training fold. Missing values imputed by
    training mean become z=0.0 in standardized space. When temperature_c, moisture_pct,
    and/or ec_ds_m are present, appends z_T * z_M and z_EC * z_M interaction terms.
    """

    def __init__(
        self,
        feature_names: list[str],
        *,
        include_interactions: bool = True,
    ) -> None:
        self.feature_names = feature_names
        self.include_interactions = include_interactions

    def fit(self, X: Any, y: Any = None) -> StandardizedInteractionPreprocessor:
        """Fit training-fold means, standard deviations, bounds, and interaction metadata."""
        _ = y
        arr = np.asarray(X, dtype=np.float64)
        if arr.ndim != 2 or arr.shape[1] != len(self.feature_names):
            raise ValueError(
                f"Expected 2D array with {len(self.feature_names)} columns, got {arr.shape}."
            )

        means = np.nanmean(arr, axis=0)
        means = np.where(np.isfinite(means), means, 0.0)

        imputed = np.where(np.isnan(arr), means[np.newaxis, :], arr)
        stds = np.std(imputed, axis=0, ddof=0)
        stds = np.where(np.isfinite(stds) & (stds > 1e-12), stds, 1.0)

        self.means_: NDArray[np.float64] = means
        self.stds_: NDArray[np.float64] = stds
        self.mins_: NDArray[np.float64] = np.min(imputed, axis=0)
        self.maxs_: NDArray[np.float64] = np.max(imputed, axis=0)
        self.q01_: NDArray[np.float64] = np.percentile(imputed, 1.0, axis=0)
        self.q99_: NDArray[np.float64] = np.percentile(imputed, 99.0, axis=0)

        specs: list[InteractionSpec] = []
        if self.include_interactions:
            name_set = set(self.feature_names)
            if "temperature_c" in name_set and "moisture_pct" in name_set:
                specs.append(
                    InteractionSpec(
                        name="z_temperature_c_x_z_moisture_pct",
                        op="z_product",
                        left="temperature_c",
                        right="moisture_pct",
                    )
                )
            if "ec_ds_m" in name_set and "moisture_pct" in name_set:
                specs.append(
                    InteractionSpec(
                        name="z_ec_ds_m_x_z_moisture_pct",
                        op="z_product",
                        left="ec_ds_m",
                        right="moisture_pct",
                    )
                )

        self.interaction_specs_: list[InteractionSpec] = specs
        self.output_feature_names_: list[str] = [
            *self.feature_names,
            *(s.name for s in specs),
        ]
        return self

    def transform(self, X: Any) -> NDArray[np.float64]:
        """Standardize inputs using fitted training parameters and append interaction columns."""
        arr = np.asarray(X, dtype=np.float64)
        if arr.ndim != 2 or arr.shape[1] != len(self.feature_names):
            raise ValueError(
                f"Expected 2D array with {len(self.feature_names)} columns, got {arr.shape}."
            )
        imputed = np.where(np.isnan(arr), self.means_[np.newaxis, :], arr)
        z = (imputed - self.means_[np.newaxis, :]) / self.stds_[np.newaxis, :]
        if not self.interaction_specs_:
            return z

        col_idx = {name: i for i, name in enumerate(self.feature_names)}
        interactions = [
            z[:, col_idx[spec.left]] * z[:, col_idx[spec.right]]
            for spec in self.interaction_specs_
        ]
        return np.column_stack([z, *interactions])


def build_benchmark_ladder(n_samples: int, *, random_state: int = 42) -> list[ModelSpec]:
    """Construct the ordered 4-tier benchmark ladder (OLS baseline -> linear reg -> RF -> GBDT)."""
    min_leaf_rf = max(2, min(3, max(2, n_samples // 12)))
    min_leaf_gb = max(3, min(8, max(3, n_samples // 6)))
    return [
        ModelSpec(
            key="ols_interaction",
            family_name="standardized_linear_interaction",
            factory=lambda: LinearRegression(),
        ),
        ModelSpec(
            key="ridge",
            family_name="ridge",
            factory=lambda: Ridge(alpha=10.0),
        ),
        ModelSpec(
            key="elastic_net",
            family_name="elastic_net",
            factory=lambda: ElasticNet(
                alpha=0.05, l1_ratio=0.5, max_iter=5000, random_state=random_state
            ),
        ),
        ModelSpec(
            key="huber",
            family_name="huber",
            factory=lambda: HuberRegressor(max_iter=2000),
        ),
        ModelSpec(
            key="random_forest",
            family_name="random_forest",
            factory=lambda: RandomForestRegressor(
                n_estimators=100,
                max_depth=5,
                min_samples_leaf=min_leaf_rf,
                random_state=random_state,
                n_jobs=1,
            ),
        ),
        ModelSpec(
            key="hist_gradient_boosting",
            family_name="hist_gradient_boosting",
            factory=lambda: HistGradientBoostingRegressor(
                max_depth=3,
                learning_rate=0.05,
                max_iter=80,
                min_samples_leaf=min_leaf_gb,
                random_state=random_state,
            ),
        ),
        ModelSpec(
            key="lightgbm",
            family_name="lightgbm",
            factory=lambda: LGBMRegressor(
                n_estimators=80,
                max_depth=3,
                num_leaves=7,
                learning_rate=0.05,
                min_child_samples=min_leaf_gb,
                verbose=-1,
                random_state=random_state,
                n_jobs=1,
            ),
        ),
    ]


def build_model_pipeline(
    feature_names: list[str],
    spec: ModelSpec,
    *,
    include_interactions: bool = True,
) -> Pipeline:
    """Create a fresh, unfitted sklearn Pipeline for fold-safe cross-validation."""
    return Pipeline(
        [
            (
                "prep",
                StandardizedInteractionPreprocessor(
                    feature_names=feature_names,
                    include_interactions=include_interactions,
                ),
            ),
            ("model", spec.factory()),
        ]
    )
