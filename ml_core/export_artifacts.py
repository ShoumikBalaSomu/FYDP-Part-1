"""Export portable browser-ready models/registry.json and verify <1e-6 Python/JSON parity."""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from lightgbm import LGBMRegressor
from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.pipeline import Pipeline

from ml_core.calibration_models import StandardizedInteractionPreprocessor
from ml_core.conformal_uncertainty import ConformalSummary, conformal_interval
from ml_core.datasets import DatasetBundle
from ml_core.explainability import compute_global_importance, compute_stratified_errors
from ml_core.ood_detector import OODDetector
from ml_core.schemas import CalibrationDomainStatus
from ml_core.soil_physics import (
    CN_RATIO_MAX,
    CN_RATIO_MIN,
    DAILY_SOM_JUMP_THRESHOLD_PCT,
    DEFAULT_VAN_BEMMELEN_K,
    EC_TRANSIENT_DS_M,
    K_CMOL_TO_MG_KG,
    MOISTURE_MAX_PCT,
    MOISTURE_SATURATION_WARN_PCT,
    MOISTURE_TRANSIENT_PCT,
    PH_CRITICAL_MAX,
    PH_CRITICAL_MIN,
    TEMP_MAX_C,
    TEMP_MIN_C,
    USDA_SOC_G_KG_TO_PCT_DIVISOR,
)
from ml_core.spatial_cv import BenchmarkEvaluation, ModelCVResult

ROOT_DIR: Path = Path(__file__).resolve().parent.parent
MAX_INFERENCE_ABS_VALUE: float = 1e12
CANONICALIZATION_DESC = (
    "json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False)"
)


def canonical_sha256(obj: Mapping[str, Any]) -> str:
    """Compute deterministic SHA-256 over sorted-key compact JSON representation."""
    encoded = json.dumps(
        obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _serialize_rf_trees(rf: RandomForestRegressor) -> dict[str, Any]:
    trees: list[dict[str, Any]] = []
    for est in rf.estimators_:
        state = est.tree_.__getstate__()
        nodes = state["nodes"]
        values = state["values"][:, 0, 0]
        children_left = [int(x) for x in nodes["left_child"]]
        children_right = [int(x) for x in nodes["right_child"]]
        feature = [int(x) for x in nodes["feature"]]
        threshold = [float(x) for x in nodes["threshold"]]
        missing_go_to_left = [bool(x) for x in nodes["missing_go_to_left"]]
        node_values = [float(v) for v in values]
        trees.append(
            {
                "children_left": children_left,
                "children_right": children_right,
                "feature": feature,
                "threshold": threshold,
                "value": node_values,
                "missing_go_to_left": missing_go_to_left,
            }
        )
    return {
        "type": "tree_ensemble",
        "input_space": "standardized",
        "feature_cast": "float32",
        "base_score": 0.0,
        "aggregation": "mean",
        "learning_rate": 1.0,
        "clip_non_negative": True,
        "trees": trees,
    }


def _serialize_hgb_trees(hgb: HistGradientBoostingRegressor) -> dict[str, Any]:
    trees: list[dict[str, Any]] = []
    for predictor_row in hgb._predictors:
        pred = predictor_row[0]
        nodes = pred.nodes
        n_nodes = len(nodes)
        children_left: list[int] = []
        children_right: list[int] = []
        feature: list[int] = []
        threshold: list[float] = []
        values: list[float] = []
        missing_go_to_left: list[bool] = []
        for idx in range(n_nodes):
            node = nodes[idx]
            is_leaf = bool(node["is_leaf"])
            if is_leaf:
                children_left.append(-1)
                children_right.append(-1)
                feature.append(-2)
                threshold.append(0.0)
                values.append(float(node["value"]))
                missing_go_to_left.append(False)
            else:
                children_left.append(int(node["left"]))
                children_right.append(int(node["right"]))
                feature.append(int(node["feature_idx"]))
                threshold.append(float(node["num_threshold"]))
                values.append(0.0)
                missing_go_to_left.append(bool(node["missing_go_to_left"]))
        trees.append(
            {
                "children_left": children_left,
                "children_right": children_right,
                "feature": feature,
                "threshold": threshold,
                "value": values,
                "missing_go_to_left": missing_go_to_left,
            }
        )
    return {
        "type": "tree_ensemble",
        "input_space": "standardized",
        "feature_cast": "float64",
        "base_score": float(hgb._baseline_prediction[0, 0]),
        "aggregation": "sum",
        "learning_rate": 1.0,
        "clip_non_negative": True,
        "trees": trees,
    }


def _flatten_lgb_tree(root: Mapping[str, Any]) -> dict[str, Any]:
    children_left: list[int] = []
    children_right: list[int] = []
    feature: list[int] = []
    threshold: list[float] = []
    values: list[float] = []
    missing_go_to_left: list[bool] = []

    def _visit(node: Mapping[str, Any]) -> int:
        node_idx = len(children_left)
        children_left.append(-1)
        children_right.append(-1)
        feature.append(-2)
        threshold.append(0.0)
        values.append(0.0)
        missing_go_to_left.append(False)

        if "leaf_value" in node:
            values[node_idx] = float(node["leaf_value"])
            return node_idx

        left_idx = _visit(node["left_child"])
        right_idx = _visit(node["right_child"])
        children_left[node_idx] = left_idx
        children_right[node_idx] = right_idx
        feature[node_idx] = int(node["split_feature"])
        threshold[node_idx] = float(node["threshold"])
        missing_go_to_left[node_idx] = bool(node["default_left"])
        return node_idx

    _visit(root)
    return {
        "children_left": children_left,
        "children_right": children_right,
        "feature": feature,
        "threshold": threshold,
        "value": values,
        "missing_go_to_left": missing_go_to_left,
    }


def _serialize_lgbm_trees(lgbm: LGBMRegressor) -> dict[str, Any]:
    dump = lgbm.booster_.dump_model()
    trees = [_flatten_lgb_tree(tree_info["tree_structure"]) for tree_info in dump["tree_info"]]
    return {
        "type": "tree_ensemble",
        "input_space": "standardized",
        "feature_cast": "float64",
        "base_score": 0.0,
        "aggregation": "sum",
        "learning_rate": 1.0,
        "clip_non_negative": True,
        "trees": trees,
    }


def serialize_predictor(pipeline: Pipeline) -> dict[str, Any]:
    """Serialize linear coefficients or exact tree arrays from a fitted sklearn Pipeline."""
    prep: StandardizedInteractionPreprocessor = pipeline.named_steps["prep"]
    est = pipeline.named_steps["model"]
    if hasattr(est, "coef_"):
        coefs = [float(c) for c in np.asarray(est.coef_, dtype=np.float64).ravel()]
        named = {
            name: coef for name, coef in zip(prep.output_feature_names_, coefs, strict=True)
        }
        return {
            "type": "linear",
            "input_space": "standardized",
            "intercept": float(est.intercept_),
            "coefficients": coefs,
            "named_coefficients": named,
            "clip_non_negative": True,
        }
    if isinstance(est, RandomForestRegressor):
        return _serialize_rf_trees(est)
    if isinstance(est, HistGradientBoostingRegressor):
        return _serialize_hgb_trees(est)
    if isinstance(est, LGBMRegressor):
        return _serialize_lgbm_trees(est)
    raise TypeError(f"Unsupported predictor type for JSON serialization: {type(est).__name__}")


def _eval_serialized_tree(tree: Mapping[str, Any], features: Sequence[float]) -> float:
    idx = 0
    left = tree["children_left"]
    right = tree["children_right"]
    feat_arr = tree["feature"]
    thresh = tree["threshold"]
    vals = tree["value"]
    missing_left = tree.get("missing_go_to_left")

    max_steps = len(left)
    steps = 0
    while left[idx] != -1:
        steps += 1
        if steps > max_steps:
            raise ValueError("Invalid cyclic decision tree detected during inference.")
        f_idx = int(feat_arr[idx])
        val = float(features[f_idx])
        if np.isnan(val):
            go_left = bool(missing_left[idx]) if missing_left is not None else True
        else:
            go_left = val <= float(thresh[idx])
        idx = int(left[idx]) if go_left else int(right[idx])
    return float(vals[idx])


def predict_from_registry_entry(
    entry: Mapping[str, Any],
    raw_sample: Mapping[str, float | None],
) -> tuple[float, float, float, CalibrationDomainStatus, float]:
    """Execute deterministic browser-equivalent inference strictly from serialized JSON dicts."""
    prep = entry["preprocessing"]
    raw_features: list[str] = prep["raw_features"]
    means: Mapping[str, float] = prep["feature_means"]
    stds: Mapping[str, float] = prep["feature_stds"]

    # 1. Validate numeric sanity, impute missing with training mean, and standardize
    raw_vec = np.zeros(len(raw_features), dtype=np.float64)
    z_map: dict[str, float] = {}
    for i, feat in enumerate(raw_features):
        val = raw_sample.get(feat)
        if val is None:
            imputed = float(means[feat])
        else:
            fval = float(val)
            if not math.isfinite(fval) or abs(fval) > MAX_INFERENCE_ABS_VALUE:
                raise ValueError(
                    f"Non-finite or extreme value for '{feat}' exceeds inference bounds: {val!r}"
                )
            imputed = fval
        raw_vec[i] = imputed
        z_map[feat] = (imputed - float(means[feat])) / float(stds[feat])

    model_vec: list[float] = [z_map[f] for f in raw_features]
    for term in prep["interaction_terms"]:
        if term["op"] == "z_product":
            prod = z_map[term["left"]] * z_map[term["right"]]
        else:
            idx_l = raw_features.index(term["left"])
            idx_r = raw_features.index(term["right"])
            prod = float(raw_vec[idx_l] * raw_vec[idx_r])
        if term.get("restandardize", False):
            prod = (prod - float(term.get("post_mean", 0.0))) / float(term.get("post_std", 1.0))
        model_vec.append(prod)

    # 2. Evaluate serialized predictor
    pred_cfg = entry["predictor"]
    if pred_cfg["type"] == "linear":
        raw_input = model_vec if pred_cfg["input_space"] == "standardized" else raw_vec.tolist()
        coefs: list[float] = pred_cfg["coefficients"]
        y_hat = float(pred_cfg["intercept"]) + sum(
            float(c) * float(v) for c, v in zip(coefs, raw_input, strict=True)
        )
    else:
        cast_type = np.float32 if pred_cfg["feature_cast"] == "float32" else np.float64
        eval_vec = [float(cast_type(v)) for v in model_vec]
        tree_outputs = [_eval_serialized_tree(tree, eval_vec) for tree in pred_cfg["trees"]]
        agg = (
            float(np.mean(tree_outputs))
            if pred_cfg["aggregation"] == "mean"
            else sum(tree_outputs)
        )
        y_hat = float(pred_cfg["base_score"]) + float(pred_cfg["learning_rate"]) * agg

    if not math.isfinite(y_hat):
        raise ValueError("Model inference overflowed to non-finite value.")
    y_hat = max(0.0, y_hat)

    # 3. Conformal 95% bounds
    q_095 = float(entry["uncertainty"]["q_095"])
    point, ci_low, ci_high = conformal_interval(y_hat, q_095, scale_factor=1.0)

    # 4. OOD assessment (feature bounds + Mahalanobis D^2)
    ood_cfg = entry["ood"]
    ood_features: list[str] = ood_cfg["feature_order"]
    ood_mins: list[float] = ood_cfg["feature_mins"]
    ood_maxs: list[float] = ood_cfg["feature_maxs"]
    ood_q01: list[float] = ood_cfg.get("feature_q01", ood_mins)
    ood_q99: list[float] = ood_cfg.get("feature_q99", ood_maxs)
    maha_mean = np.asarray(ood_cfg["mahalanobis_mean"], dtype=np.float64)
    maha_inv_cov = np.asarray(ood_cfg["mahalanobis_inv_cov"], dtype=np.float64)

    ood_vec = np.zeros(len(ood_features), dtype=np.float64)
    missing_any = False
    out_bounds = False
    tail_bounds = False
    for idx, feat in enumerate(ood_features):
        val = raw_sample.get(feat)
        if val is None:
            missing_any = True
            ood_vec[idx] = maha_mean[idx]
        else:
            fval = float(val)
            if not math.isfinite(fval) or abs(fval) > MAX_INFERENCE_ABS_VALUE:
                raise ValueError(
                    f"Non-finite or extreme value for '{feat}' exceeds OOD bounds: {val!r}"
                )
            ood_vec[idx] = fval
            if fval < ood_mins[idx] or fval > ood_maxs[idx]:
                out_bounds = True
            elif fval < ood_q01[idx] or fval > ood_q99[idx]:
                tail_bounds = True

    diff = ood_vec - maha_mean
    d2 = float(diff @ maha_inv_cov @ diff)
    if not math.isfinite(d2):
        raise ValueError("Mahalanobis D^2 computation overflowed to non-finite value.")
    if out_bounds or d2 > float(ood_cfg["d2_ood_threshold"]):
        domain_status: CalibrationDomainStatus = "Outside Calibration Range"
    elif missing_any or tail_bounds or d2 > float(ood_cfg["d2_caution_threshold"]):
        domain_status = "Caution"
    else:
        domain_status = "In-Range"

    return point, ci_low, ci_high, domain_status, d2


def verify_registry_document(doc: Mapping[str, Any]) -> Mapping[str, Any]:
    """Verify platform invariants, canonical root SHA-256, and per-model artifact hashes."""
    if doc.get("platform") != "SOMSense-ESRC":
        raise ValueError(f"Unexpected registry platform: {doc.get('platform')!r}")

    proto = doc.get("authority_protocol")
    if not isinstance(proto, Mapping):
        raise ValueError("Missing authority_protocol object in registry.")
    if proto.get("forbid_direct_sensor_om") is not True:
        raise ValueError("authority_protocol.forbid_direct_sensor_om must be true.")
    if proto.get("forbid_passive_c_subtraction") is not True:
        raise ValueError("authority_protocol.forbid_passive_c_subtraction must be true.")

    integrity = doc.get("integrity")
    if not isinstance(integrity, Mapping):
        raise ValueError("Missing integrity block in registry.")
    if integrity.get("hash_algorithm") != "SHA-256":
        raise ValueError(
            f"Unsupported registry hash algorithm: {integrity.get('hash_algorithm')!r}"
        )

    payload_no_integrity = {k: v for k, v in doc.items() if k != "integrity"}
    expected_root_hash = canonical_sha256(payload_no_integrity)
    actual_root_hash = integrity.get("canonical_payload_sha256")
    if actual_root_hash != expected_root_hash:
        raise ValueError(
            "Registry integrity SHA-256 mismatch: "
            f"expected {expected_root_hash}, got {actual_root_hash!r}."
        )

    models = doc.get("models")
    if not isinstance(models, Mapping) or not models:
        raise ValueError("Registry must define a non-empty 'models' map.")
    for model_id, entry in models.items():
        if not isinstance(entry, Mapping):
            raise ValueError(f"Model entry '{model_id}' must be a mapping.")
        entry_no_hash = {k: v for k, v in entry.items() if k != "artifact_sha256"}
        expected_entry_hash = canonical_sha256(entry_no_hash)
        actual_entry_hash = entry.get("artifact_sha256")
        if actual_entry_hash != expected_entry_hash:
            raise ValueError(
                f"Model '{model_id}' artifact_sha256 mismatch: "
                f"expected {expected_entry_hash}, got {actual_entry_hash!r}."
            )
    return doc


def load_and_verify_registry(
    path: Path = ROOT_DIR / "models" / "registry.json",
) -> dict[str, Any]:
    """Load models/registry.json from disk and fail closed on any integrity mismatch."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("Registry JSON root must be an object.")
    verify_registry_document(raw)
    return raw


def verify_registry_parity(
    entry: Mapping[str, Any],
    pipeline: Pipeline,
    bundle: DatasetBundle,
    *,
    tolerance: float = 1e-6,
) -> float:
    """Assert serialized JSON prediction matches Python sklearn/lgbm Pipeline within tolerance."""
    X_df = bundle.df[bundle.feature_columns]
    X_np = X_df.to_numpy(dtype=np.float64)
    py_preds = np.maximum(0.0, np.asarray(pipeline.predict(X_np), dtype=np.float64))

    max_diff = 0.0
    for idx in range(len(X_df)):
        row = X_df.iloc[idx]
        sample = {
            col: (None if pd.isna(row[col]) else float(row[col]))
            for col in bundle.feature_columns
        }
        json_pred, _, _, _, _ = predict_from_registry_entry(entry, sample)
        diff = abs(float(py_preds[idx]) - json_pred)
        if diff > max_diff:
            max_diff = diff

    if max_diff >= tolerance:
        raise AssertionError(
            f"Parity violation for {entry['model_id']}: max_diff={max_diff:.3e} >= {tolerance}"
        )
    return max_diff


def build_model_entry(
    *,
    model_id: str,
    model_version: str,
    bundle: DatasetBundle,
    evaluation: BenchmarkEvaluation,
    cv_result: ModelCVResult,
    fitted_pipeline: Pipeline,
    conformal: ConformalSummary,
    ood_detector: OODDetector,
    selection_status: str,
    stratum_columns: Sequence[str],
    notes: str,
) -> dict[str, Any]:
    """Assemble a schema-compliant ModelEntry dict with verified parity and artifact SHA-256."""
    prep: StandardizedInteractionPreprocessor = fitted_pipeline.named_steps["prep"]
    X_full = bundle.df[bundle.feature_columns].to_numpy(dtype=np.float64)
    y_full = bundle.df[bundle.target_column].to_numpy(dtype=np.float64)

    exp_method, global_imp = compute_global_importance(fitted_pipeline, X_full)
    stratified = compute_stratified_errors(
        bundle.df, y_full, cv_result.oof_predictions, stratum_columns
    )

    van_k: float | None = (
        None if bundle.target_column == "poxc_mg_kg" else DEFAULT_VAN_BEMMELEN_K
    )
    target_name_map = {
        "om_pct": "OM_pct",
        "soc_pct": "SOC_pct",
        "oc_pct": "OC_pct",
        "poxc_mg_kg": "POXC_mg_kg",
    }

    entry: dict[str, Any] = {
        "model_id": model_id,
        "model_version": model_version,
        "dataset_id": bundle.dataset_id,
        "target_name": target_name_map[bundle.target_column],
        "target_unit": bundle.target_unit,
        "van_bemmelen_k": van_k,
        "selection_status": selection_status,
        "selected_model_family": cv_result.spec.family_name,
        "beats_ols_baseline": bool(cv_result.beats_ols_baseline),
        "provenance": {
            "source_title": bundle.source_title,
            "doi_or_slug": bundle.doi_or_slug,
            "is_synthetic_or_fixture": bool(bundle.is_synthetic_or_fixture),
        },
        "preprocessing": {
            "raw_features": list(bundle.feature_columns),
            "interaction_terms": [
                {
                    "name": spec.name,
                    "op": spec.op,
                    "left": spec.left,
                    "right": spec.right,
                    "restandardize": False,
                    "post_mean": 0.0,
                    "post_std": 1.0,
                }
                for spec in prep.interaction_specs_
            ],
            "model_feature_order": list(prep.output_feature_names_),
            "feature_means": {
                f: float(m) for f, m in zip(bundle.feature_columns, prep.means_, strict=True)
            },
            "feature_stds": {
                f: float(s) for f, s in zip(bundle.feature_columns, prep.stds_, strict=True)
            },
            "feature_mins": {
                f: float(v) for f, v in zip(bundle.feature_columns, prep.mins_, strict=True)
            },
            "feature_maxs": {
                f: float(v) for f, v in zip(bundle.feature_columns, prep.maxs_, strict=True)
            },
            "feature_q01": {
                f: float(v) for f, v in zip(bundle.feature_columns, prep.q01_, strict=True)
            },
            "feature_q99": {
                f: float(v) for f, v in zip(bundle.feature_columns, prep.q99_, strict=True)
            },
        },
        "predictor": serialize_predictor(fitted_pipeline),
        "uncertainty": {
            "method": conformal.method,
            "alpha": float(conformal.alpha),
            "q_095": round(float(conformal.q_quantile), 8),
            "empirical_coverage": round(float(conformal.empirical_coverage), 6),
            "mean_interval_width": round(float(conformal.mean_interval_width), 6),
            "clip_lower_at_zero": True,
            "apply_van_bemmelen_to_interval": bundle.target_column in ("oc_pct", "soc_pct"),
        },
        "ood": ood_detector.to_registry_dict(),
        "explainability": {
            "method": exp_method,
            "global_importance": global_imp,
            "stratified_errors": stratified,
        },
        "metrics": {
            "cv_strategy": evaluation.cv_strategy,
            "n_samples": evaluation.n_samples,
            "n_groups": evaluation.n_groups,
            "rmse": round(float(cv_result.rmse), 6),
            "mae": round(float(cv_result.mae), 6),
            "r2": round(float(cv_result.r2), 6),
            "baseline_ols_rmse": round(float(evaluation.baseline_result.rmse), 6),
            "baseline_ols_mae": round(float(evaluation.baseline_result.mae), 6),
            "baseline_ols_r2": round(float(evaluation.baseline_result.r2), 6),
            "model_comparison": [
                {
                    "model_name": r.spec.key,
                    "rmse": round(float(r.rmse), 6),
                    "mae": round(float(r.mae), 6),
                    "r2": round(float(r.r2), 6),
                    "beats_ols_baseline": bool(r.beats_ols_baseline),
                    "retained": bool(r.retained),
                }
                for r in evaluation.all_results
            ],
        },
        "notes": notes,
    }
    verify_registry_parity(entry, fitted_pipeline, bundle, tolerance=1e-6)
    entry["artifact_sha256"] = canonical_sha256(entry)
    return entry


def build_registry_document(
    *,
    models: dict[str, dict[str, Any]],
    srdi_tn_leakage: dict[str, Any],
    kaggle_mineral_only: dict[str, Any],
    usda_poxc_unit_audit: dict[str, Any],
) -> dict[str, Any]:
    """Assemble the complete models/registry.json document with canonical SHA-256 integrity."""
    payload: dict[str, Any] = {
        "schema_version": "1.0.0",
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "platform": "SOMSense-ESRC",
        "authority_protocol": {
            "source": "Dr. Fizar Ahmed ESRC Technical Calibration Protocol (2026-09-29)",
            "default_van_bemmelen_k": DEFAULT_VAN_BEMMELEN_K,
            "forbid_direct_sensor_om": True,
            "forbid_passive_c_subtraction": True,
            "required_report_fields": [
                "estimated_som_pct",
                "som_ci95_lower",
                "som_ci95_upper",
                "model_version",
                "calibration_domain_status",
            ],
        },
        "hardware_physics_guardrails": {
            "ph_critical_min": PH_CRITICAL_MIN,
            "ph_critical_max": PH_CRITICAL_MAX,
            "moisture_saturation_warning_min": MOISTURE_SATURATION_WARN_PCT,
            "moisture_max_pct": MOISTURE_MAX_PCT,
            "temperature_min_c": TEMP_MIN_C,
            "temperature_max_c": TEMP_MAX_C,
            "ec_transient_disturbance_ds_m": EC_TRANSIENT_DS_M,
            "moisture_transient_disturbance_pct": MOISTURE_TRANSIENT_PCT,
            "daily_som_jump_threshold_pct": DAILY_SOM_JUMP_THRESHOLD_PCT,
            "cn_ratio_min": CN_RATIO_MIN,
            "cn_ratio_max": CN_RATIO_MAX,
            "k_cmol_to_mg_kg": K_CMOL_TO_MG_KG,
            "usda_soc_g_kg_to_pct_divisor": USDA_SOC_G_KG_TO_PCT_DIVISOR,
        },
        "models": models,
        "leakage_and_quality_audits": {
            "srdi_tn_leakage": srdi_tn_leakage,
            "kaggle_mineral_only": kaggle_mineral_only,
            "usda_poxc_unit_audit": usda_poxc_unit_audit,
        },
    }
    digest = canonical_sha256(payload)
    payload["integrity"] = {
        "hash_algorithm": "SHA-256",
        "canonicalization": CANONICALIZATION_DESC,
        "canonical_payload_sha256": digest,
    }
    return payload


def write_registry_and_manifest(
    registry_doc: Mapping[str, Any],
    *,
    registry_path: Path = ROOT_DIR / "models" / "registry.json",
    manifest_path: Path = ROOT_DIR / "models" / "artifacts_manifest.json",
    parity_diffs: Mapping[str, float] | None = None,
) -> None:
    """Write models/registry.json and models/artifacts_manifest.json atomically."""
    registry_path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(registry_doc, indent=2, ensure_ascii=False) + "\n"
    registry_path.write_text(serialized, encoding="utf-8")
    file_sha256 = hashlib.sha256(serialized.encode("utf-8")).hexdigest()

    manifest = {
        "schema_version": "1.0.0",
        "generated_at_utc": registry_doc["generated_at_utc"],
        "registry_file": str(registry_path.relative_to(ROOT_DIR)),
        "registry_file_sha256": file_sha256,
        "registry_file_bytes": len(serialized.encode("utf-8")),
        "canonical_payload_sha256": registry_doc["integrity"]["canonical_payload_sha256"],
        "models": {
            mid: {
                "dataset_id": entry["dataset_id"],
                "selection_status": entry["selection_status"],
                "selected_model_family": entry["selected_model_family"],
                "target_name": entry["target_name"],
                "target_unit": entry["target_unit"],
                "rmse": entry["metrics"]["rmse"],
                "r2": entry["metrics"]["r2"],
                "q_095": entry["uncertainty"]["q_095"],
                "empirical_coverage": entry["uncertainty"]["empirical_coverage"],
                "artifact_sha256": entry["artifact_sha256"],
                "python_json_max_abs_diff": (
                    None if parity_diffs is None else parity_diffs.get(mid)
                ),
            }
            for mid, entry in registry_doc["models"].items()
        },
    }
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
