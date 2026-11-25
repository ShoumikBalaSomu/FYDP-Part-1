"""Dataset loaders & harmonization for SRDI Kushtia, Kaggle Fertility, and USDA KSSL POX-C."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import numpy as np
import pandas as pd

from ml_core.esrc_adapter import parse_aez_csv
from ml_core.soil_physics import (
    DEFAULT_VAN_BEMMELEN_K,
    K_CMOL_TO_MG_KG,
    USDA_SOC_G_KG_TO_PCT_DIVISOR,
    flag_kaggle_outliers,
    k_cmol_to_mg_kg,
    soc_g_kg_to_pct,
    soc_to_som,
    som_to_soc,
)

ROOT_DIR: Path = Path(__file__).resolve().parent.parent
SRDI_DEFAULT_PATH: Path = ROOT_DIR / "data" / "raw" / "srdi_kushtia" / "Supplementary_Data_S10.csv"
KAGGLE_DEFAULT_PATH: Path = ROOT_DIR / "data" / "raw" / "kaggle_soil_fertility" / "dataset1.csv"
KAGGLE_FIXTURE_PATH: Path = ROOT_DIR / "data" / "fixtures" / "schema_validation_fixture.csv"
USDA_S1_DEFAULT_PATH: Path = (
    ROOT_DIR / "data" / "raw" / "usda_kssl_poxc" / "Table.S1.KSSL_SelectedSamples.csv"
)
USDA_S2_DEFAULT_PATH: Path = (
    ROOT_DIR / "data" / "raw" / "usda_kssl_poxc" / "Table.S2.SampleData.csv"
)

SRDI_DEPTH_MIDPOINT_CM: dict[str, float] = {
    "0-20": 10.0,
    "20-40": 30.0,
    "40-60": 50.0,
}


@dataclass(frozen=True)
class DatasetBundle:
    """Harmonized dataset bundle ready for GroupKFold/KFold benchmarking and OOD fitting."""

    dataset_id: str
    source_title: str
    doi_or_slug: str
    is_synthetic_or_fixture: bool
    df: pd.DataFrame
    excluded_df: pd.DataFrame
    feature_columns: list[str]
    target_column: str
    target_unit: Literal["%", "mg C/kg dry soil"]
    group_column: str | None
    audit_info: dict[str, Any]


def load_srdi_kushtia(
    path: Path = SRDI_DEFAULT_PATH,
    *,
    include_leaked_tn: bool = False,
    include_micronutrients: bool = False,
    van_bemmelen_k: float = DEFAULT_VAN_BEMMELEN_K,
) -> DatasetBundle:
    """Load SRDI Kushtia dataset (171 rows, 57 Sample_IDs x 3 depths).

    - Converts K_cmol_kg -> potassium_mg_kg via K_cmol_kg * 391.0.
    - Maps Depth_cm to depth_mid_cm.
    - Strictly excludes TN_pct from features unless include_leaked_tn=True (for leakage demo).
    """
    raw = pd.read_csv(path)
    df = raw.copy()
    df["potassium_mg_kg"] = df["K_cmol_kg"].map(k_cmol_to_mg_kg)
    df["depth_mid_cm"] = df["Depth_cm"].map(SRDI_DEPTH_MIDPOINT_CM)
    if df["depth_mid_cm"].isna().any():
        raise ValueError("Unmapped Depth_cm interval found in SRDI Kushtia dataset.")

    df["ph"] = df["pH"].astype(float)
    df["phosphorus_mg_kg"] = df["P_mg_kg"].astype(float)
    df["moisture_pct"] = df["Moisture_pct"].astype(float)
    df["om_pct"] = df["OM_pct"].astype(float)
    df["soc_pct"] = df["om_pct"].map(lambda om: som_to_soc(om, k=van_bemmelen_k))
    df["total_nitrogen_pct"] = df["TN_pct"].astype(float)
    df["sulfur_mg_kg"] = df["S_mg_kg"].astype(float)
    df["zinc_mg_kg"] = df["Zn_mg_kg"].astype(float)
    df["boron_mg_kg"] = df["B_mg_kg"].astype(float)

    # Audit circular TN-OM derivation: TN = 0.0492 * OM - 0.0065 (r = 0.978)
    corr = float(np.corrcoef(df["om_pct"].to_numpy(), df["total_nitrogen_pct"].to_numpy())[0, 1])
    slope, intercept = np.polyfit(df["om_pct"].to_numpy(), df["total_nitrogen_pct"].to_numpy(), 1)

    features = [
        "ph",
        "phosphorus_mg_kg",
        "potassium_mg_kg",
        "moisture_pct",
        "depth_mid_cm",
    ]
    if include_micronutrients:
        features.extend(["sulfur_mg_kg", "zinc_mg_kg", "boron_mg_kg"])
    if include_leaked_tn:
        features.append("total_nitrogen_pct")

    return DatasetBundle(
        dataset_id="srdi_kushtia_2024",
        source_title=(
            "Soil nutrient status at three depths across 57 grid points, Kushtia, Bangladesh (2024)"
        ),
        doi_or_slug="10.17632/frkzb57y7p.1",
        is_synthetic_or_fixture=False,
        df=df,
        excluded_df=pd.DataFrame(columns=df.columns),
        feature_columns=features,
        target_column="om_pct",
        target_unit="%",
        group_column="Sample_ID",
        audit_info={
            "n_rows": int(len(df)),
            "n_unique_sites": int(df["Sample_ID"].nunique()),
            "k_conversion_factor": K_CMOL_TO_MG_KG,
            "tn_om_correlation": corr,
            "tn_om_slope": float(slope),
            "tn_om_intercept": float(intercept),
            "tn_om_formula": f"TN = {slope:.4f} * OM + ({intercept:.4f})",
            "tn_excluded": not include_leaked_tn,
        },
    )


def load_kaggle_soil_fertility(
    path: Path = KAGGLE_DEFAULT_PATH,
    *,
    allow_fixture_fallback: bool = False,
    fixture_path: Path = KAGGLE_FIXTURE_PATH,
    van_bemmelen_k: float = DEFAULT_VAN_BEMMELEN_K,
) -> DatasetBundle:
    """Load Kaggle Soil Fertility (880 rows -> 873 clean after flagging 7 corrupt outliers).

    Falls back to schema_validation_fixture.csv ONLY when explicitly enabled for credential-free
    unit/CI schema tests, marking is_synthetic_or_fixture=True so fixture metrics are never mixed
    with scientific results.
    """
    if not path.exists():
        if not allow_fixture_fallback:
            raise FileNotFoundError(
                f"Kaggle dataset not found at {path}. Run scripts/fetch_datasets.py "
                "or pass allow_fixture_fallback=True strictly for CI schema tests."
            )
        fixture_df, _ = parse_aez_csv(fixture_path, default_ec_unit="dS/m")
        fixture_df["oc_pct"] = fixture_df["lab_soc_pct"].astype(float)
        fixture_df["som_pct"] = fixture_df["oc_pct"].map(
            lambda oc: soc_to_som(oc, k=van_bemmelen_k)
        )
        return DatasetBundle(
            dataset_id="ci_schema_fixture_only",
            source_title="CI Schema Validation Fixture (NOT FOR SCIENTIFIC CLAIMS)",
            doi_or_slug="data/fixtures/schema_validation_fixture.csv",
            is_synthetic_or_fixture=True,
            df=fixture_df,
            excluded_df=pd.DataFrame(columns=fixture_df.columns),
            feature_columns=[
                "nitrogen_mg_kg",
                "phosphorus_mg_kg",
                "potassium_mg_kg",
                "ph",
                "ec_ds_m",
            ],
            target_column="oc_pct",
            target_unit="%",
            group_column="site_id",
            audit_info={
                "is_fixture_fallback": True,
                "raw_rows": int(len(fixture_df)),
                "flagged_outlier_rows": 0,
                "clean_rows": int(len(fixture_df)),
            },
        )

    raw = pd.read_csv(path)
    clean_df, outlier_df, outlier_details = flag_kaggle_outliers(raw)

    clean_df["nitrogen_mg_kg"] = clean_df["N"].astype(float)
    clean_df["phosphorus_mg_kg"] = clean_df["P"].astype(float)
    clean_df["potassium_mg_kg"] = clean_df["K"].astype(float)
    clean_df["ph"] = clean_df["pH"].astype(float)
    clean_df["ec_ds_m"] = clean_df["EC"].astype(float)
    clean_df["oc_pct"] = clean_df["OC"].astype(float)
    clean_df["som_pct"] = clean_df["oc_pct"].map(lambda oc: soc_to_som(oc, k=van_bemmelen_k))

    return DatasetBundle(
        dataset_id="kaggle_soil_fertility",
        source_title="Soil Fertility Dataset (N, P, K, pH, EC -> OC%)",
        doi_or_slug="rahuljaiswalonkaggle/soil-fertility-dataset",
        is_synthetic_or_fixture=False,
        df=clean_df.reset_index(drop=True),
        excluded_df=outlier_df.reset_index(drop=True),
        feature_columns=["nitrogen_mg_kg", "phosphorus_mg_kg", "potassium_mg_kg", "ph", "ec_ds_m"],
        target_column="oc_pct",
        target_unit="%",
        group_column=None,
        audit_info={
            "is_fixture_fallback": False,
            "raw_rows": int(len(raw)),
            "flagged_outlier_rows": int(len(outlier_df)),
            "clean_rows": int(len(clean_df)),
            "outlier_details": outlier_details,
            "outlier_criteria": (
                "pH < 3.0 or pH > 10.0, OC > 5.0%, Zn > 10.0 mg/kg, Fe > 20.0 mg/kg"
            ),
        },
    )


def load_usda_kssl_poxc(
    s1_path: Path = USDA_S1_DEFAULT_PATH,
    s2_path: Path = USDA_S2_DEFAULT_PATH,
    *,
    include_lab_soc: bool = True,
    sample_prep: str = "< 2 mm Grind",
    sample_mass_g: float = 2.5,
) -> DatasetBundle:
    """Load USDA-NRCS KSSL POX-C dataset (<2 mm & 2.5 g standard subset).

    Fixes the POXC_DataDictionary unit bug where Table.S1 SOC is recorded in g C/kg
    (divides by 10.0 to yield %SOC, verified against Ratio_poxc-soc).
    """
    t1 = pd.read_csv(s1_path)
    t2 = pd.read_csv(s2_path)
    subset = t2[(t2["Sample Prep"] == sample_prep) & (t2["Sample Mass"] == sample_mass_g)].copy()
    merged = subset.merge(t1, left_on="SampleID", right_on="KSSL_Sample_ID", how="inner")

    merged["soc_pct"] = merged["SOC"].map(soc_g_kg_to_pct)
    merged["ph"] = merged["pH"].astype(float)
    merged["sand_pct"] = merged["Sand"].astype(float)
    merged["silt_pct"] = merged["Silt"].astype(float)
    merged["clay_pct"] = merged["Clay"].astype(float)
    merged["depth_mid_cm"] = (merged["Top"].astype(float) + merged["Bottom"].astype(float)) / 2.0
    merged["poxc_mg_kg"] = merged["POXC_mgkg-1"].astype(float)

    valid_mask = merged["poxc_mg_kg"].notna() & np.isfinite(merged["poxc_mg_kg"])
    valid_df = merged.loc[valid_mask].copy().reset_index(drop=True)
    excluded_df = merged.loc[~valid_mask].copy().reset_index(drop=True)

    # Verify unit conversion consistency: POXC / (SOC_% * 10000) == Ratio_poxc-soc
    computed_ratio = valid_df["poxc_mg_kg"] / (valid_df["soc_pct"] * 10000.0)
    max_ratio_diff = float(np.max(np.abs(computed_ratio - valid_df["Ratio_poxc-soc"])))
    if max_ratio_diff > 0.002:
        raise ValueError(
            f"USDA KSSL POXC/SOC ratio verification failed (max diff={max_ratio_diff:.4f})."
        )

    features = ["ph", "sand_pct", "silt_pct", "clay_pct", "depth_mid_cm"]
    if include_lab_soc:
        features = ["soc_pct", *features]

    return DatasetBundle(
        dataset_id="usda_kssl_poxc_with_soc" if include_lab_soc else "usda_kssl_poxc_without_soc",
        source_title="Kellogg Soil Survey Laboratory (KSSL) POX-C dataset",
        doi_or_slug="10.15482/USDA.ADC/1518679",
        is_synthetic_or_fixture=False,
        df=valid_df,
        excluded_df=excluded_df,
        feature_columns=features,
        target_column="poxc_mg_kg",
        target_unit="mg C/kg dry soil",
        group_column="Pedon_ID",
        audit_info={
            "raw_samples": int(len(t1)),
            "raw_pedons": int(t1["Pedon_ID"].nunique()),
            "standard_subset_prep": sample_prep,
            "standard_subset_mass_g": float(sample_mass_g),
            "standard_rows_total": int(len(merged)),
            "valid_quantified_rows": int(len(valid_df)),
            "valid_pedons": int(valid_df["Pedon_ID"].nunique()),
            "reagent_exhausted_or_unquantified_rows": int(len(excluded_df)),
            "unit_bug_factor": USDA_SOC_G_KG_TO_PCT_DIVISOR,
            "max_ratio_verification_diff": max_ratio_diff,
        },
    )
