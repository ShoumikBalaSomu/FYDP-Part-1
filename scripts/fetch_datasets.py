"""Download and SHA-256 verify public benchmark datasets listed in data/manifest.json."""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import shutil
import urllib.request
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

ROOT_DIR = Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT_DIR / "data" / "manifest.json"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_url(url: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "SOMSense-DatasetFetcher/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp, target.open("wb") as out:
        shutil.copyfileobj(resp, out)


def fetch_kaggle(slug: str, target: Path) -> bool:
    try:
        import kagglehub
    except ImportError:
        logger.warning("kagglehub is not installed; skipping Kaggle dataset download.")
        return False

    try:
        cached = Path(kagglehub.dataset_download(slug))
    except Exception as exc:  # noqa: BLE001 - Kaggle auth may be absent in CI
        logger.warning("Kaggle download skipped (%s). Set KAGGLE_USERNAME/KAGGLE_KEY.", exc)
        return False

    target.parent.mkdir(parents=True, exist_ok=True)
    csv_files = list(cached.rglob("*.csv"))
    if not csv_files:
        logger.warning("No CSV files found in Kaggle cache directory %s.", cached)
        return False
    shutil.copy2(csv_files[0], target)
    return True


def run(verify_only: bool = False, include_kaggle: bool = True) -> int:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    failures = 0

    for dataset_id, meta in manifest["datasets"].items():
        if dataset_id == "kaggle_soil_fertility" and not include_kaggle:
            logger.info("Skipping %s (--skip-kaggle).", dataset_id)
            continue

        for entry in meta["files"]:
            target = ROOT_DIR / entry["path"]
            expected = entry["sha256"]

            if not target.exists():
                if verify_only:
                    logger.error("Missing dataset file: %s", entry["path"])
                    failures += 1
                    continue
                if entry.get("download_method") == "kagglehub":
                    ok = fetch_kaggle(meta["kaggle_slug"], target)
                    if not ok:
                        logger.warning(
                            "Kaggle file missing and auth unavailable; use "
                            "data/fixtures/schema_validation_fixture.csv ONLY for schema CI tests."
                        )
                        continue
                else:
                    logger.info("Downloading %s -> %s", dataset_id, entry["path"])
                    download_url(entry["download_url"], target)

            actual = sha256_file(target)
            if actual != expected:
                logger.error(
                    "SHA-256 mismatch for %s: expected %s, got %s",
                    entry["path"],
                    expected,
                    actual,
                )
                failures += 1
            else:
                logger.info("Verified %s (%s)", entry["path"], actual[:12])

    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-only", action="store_true", help="Only verify existing hashes.")
    parser.add_argument(
        "--skip-kaggle",
        action="store_true",
        help="Skip Kaggle dataset (useful in credential-free CI).",
    )
    args = parser.parse_args()
    return run(verify_only=args.verify_only, include_kaggle=not args.skip_kaggle)


if __name__ == "__main__":
    raise SystemExit(main())
