#!/usr/bin/env bash
set -euo pipefail

# SOMSense (ESRC) safe quad-remote release script.
# Zero hardcoded credentials: relies strictly on configured git SSH/credential helpers or env vars.

DRY_RUN=false
TAG=""
REMOTES_STR="github gitlab bitbucket sourceforge"

usage() {
  cat <<'EOF'
Usage: scripts/release-all.sh [OPTIONS]

Options:
  --tag <vX.Y.Z>       Release tag to package and push (default: v<version> from pyproject.toml)
  --remotes "<list>"   Space-separated git remotes (default: "github gitlab bitbucket sourceforge")
  --dry-run            Validate gates and print packaging/push plan without modifying git or pushing
  -h, --help           Show this help text
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --tag)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --tag requires a value (for example v1.0.0)." >&2
        exit 2
      fi
      TAG="$2"
      shift 2
      ;;
    --remotes)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --remotes requires a quoted space-separated string." >&2
        exit 2
      fi
      REMOTES_STR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

ROOT_DIR="$(git rev-parse --show-toplevel)"
cd "$ROOT_DIR"

if [[ -x "$ROOT_DIR/.venv/bin/python" ]]; then
  PYTHON_BIN="$ROOT_DIR/.venv/bin/python"
  BIN_DIR="$ROOT_DIR/.venv/bin"
else
  PYTHON_BIN="$(command -v python3)"
  BIN_DIR="$(dirname "$PYTHON_BIN")"
fi

run_tool() {
  local tool="$1"
  shift
  if [[ -x "$BIN_DIR/$tool" ]]; then
    "$BIN_DIR/$tool" "$@"
  else
    "$tool" "$@"
  fi
}

if [[ -z "$TAG" ]]; then
  PY_VER="$("$PYTHON_BIN" -c 'import tomllib; print(tomllib.load(open("pyproject.toml","rb"))["project"]["version"])')"
  TAG="v${PY_VER}"
fi

if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "ERROR: Tag '$TAG' does not match semantic version tag format vX.Y.Z." >&2
  exit 2
fi

echo "==> SOMSense Release Gate (tag=${TAG}, dry_run=${DRY_RUN})"

# 1. Validate clean git status
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[DRY-RUN] Current branch is '${CURRENT_BRANCH}' (live release requires 'main')."
  else
    echo "ERROR: Release must run from 'main' branch (currently '${CURRENT_BRANCH}')." >&2
    exit 1
  fi
fi

if [[ -n "$(git status --porcelain)" ]]; then
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[DRY-RUN] Working tree is dirty (live release aborts on uncommitted/untracked files)."
  else
    echo "ERROR: Working tree is not clean. Commit or stash changes before releasing." >&2
    git status --short >&2
    exit 1
  fi
else
  echo "[OK] Working tree is clean."
fi

# 2. Secret hygiene gate (ensure no secret files are tracked and no token patterns appear)
echo "==> Running secret hygiene scan..."
if git ls-files | grep -E '(^|/)\.env($|\.)|kaggle\.json|\.pem$|\.key$|^\.netrc$' >/dev/null 2>&1; then
  echo "ERROR: Sensitive credential file pattern is tracked in git!" >&2
  git ls-files | grep -E '(^|/)\.env($|\.)|kaggle\.json|\.pem$|\.key$|^\.netrc$' >&2
  exit 1
fi

"$PYTHON_BIN" - <<'PY'
import re
import subprocess
import sys
from pathlib import Path

tracked = subprocess.check_output(
    ["git", "ls-files", "-c", "-o", "--exclude-standard"], text=True
).splitlines()
patterns = [
    ("AWS Access Key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("GitHub Classic Token", re.compile(r"ghp_[A-Za-z0-9]{20,}")),
    ("GitHub Fine-Grained Token", re.compile(r"github_pat_[A-Za-z0-9_]{20,}")),
    ("GitLab PAT", re.compile(r"glpat-[A-Za-z0-9_-]{20,}")),
    ("Private Key PEM Header", re.compile(r"-----BEGIN (?:RSA|OPENSSH|EC|PGP) PRIVATE KEY-----")),
    ("Hardcoded Kaggle Key Assignment", re.compile(r"""KAGGLE_KEY\s*=\s*['"][A-Za-z0-9]{16,}['"]""")),
]

hits = []
for rel in tracked:
    if rel == "scripts/release-all.sh":
        continue
    p = Path(rel)
    if not p.is_file() or p.stat().st_size > 2_000_000:
        continue
    try:
        text = p.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        continue
    for label, pat in patterns:
        if pat.search(text):
            hits.append(f"{rel}: {label}")

if hits:
    print("ERROR: Potential secret detected in tracked files:", file=sys.stderr)
    for h in hits:
        print(f"  - {h}", file=sys.stderr)
    sys.exit(1)
print("[OK] Zero tracked secret files or hardcoded tokens detected.")
PY

# 3. Dataset, Python lint/type/test/audit, and registry SHA-256 gates
echo "==> Verifying dataset checksums..."
if [[ -f "data/raw/kaggle_soil_fertility/dataset1.csv" ]]; then
  "$PYTHON_BIN" scripts/fetch_datasets.py --verify-only
else
  "$PYTHON_BIN" scripts/fetch_datasets.py --skip-kaggle --verify-only
fi

echo "==> Running Python lint, typecheck, pytest, and pip-audit..."
run_tool ruff check ml_core scripts tests
run_tool mypy ml_core scripts tests
run_tool pytest -q
run_tool pip-audit

echo "==> Verifying models/registry.json parity with web_app/public/models/registry.json..."
ROOT_REG_SHA="$(sha256sum models/registry.json | awk '{print $1}')"
WEB_REG_SHA="$(sha256sum web_app/public/models/registry.json | awk '{print $1}')"
if [[ "$ROOT_REG_SHA" != "$WEB_REG_SHA" ]]; then
  echo "ERROR: SHA-256 mismatch: models/registry.json (${ROOT_REG_SHA}) != web_app/public/models/registry.json (${WEB_REG_SHA})" >&2
  exit 1
fi
"$PYTHON_BIN" - <<'PY'
import json
import sys
from pathlib import Path

manifest = json.loads(Path("models/artifacts_manifest.json").read_text(encoding="utf-8"))
registry = json.loads(Path("models/registry.json").read_text(encoding="utf-8"))
if manifest["canonical_payload_sha256"] != registry["integrity"]["canonical_payload_sha256"]:
    print("ERROR: artifacts_manifest.json canonical_payload_sha256 diverges from registry.json", file=sys.stderr)
    sys.exit(1)
print(f"[OK] Registry SHA-256 and canonical hash verified ({manifest['canonical_payload_sha256'][:12]}...).")
PY

# 4. Web verification & production build
echo "==> Running web_app TypeScript, Vitest, and Vite build..."
(
  cd "$ROOT_DIR/web_app"
  npx tsc --noEmit
  npx vitest run
  npm run build
)

# 5. Package release archives + SHA256SUMS
RELEASE_DIR="$ROOT_DIR/dist/release-${TAG}"
TAR_FILE="somsense-${TAG}-web-dist.tar.gz"
ZIP_FILE="somsense-${TAG}-web-dist.zip"
REG_COPY="somsense-${TAG}-models-registry.json"
MAN_COPY="somsense-${TAG}-models-manifest.json"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would create ${RELEASE_DIR}/{${TAR_FILE},${ZIP_FILE},${REG_COPY},${MAN_COPY},SHA256SUMS} and verify sha256sum -c SHA256SUMS."
else
  rm -rf "$RELEASE_DIR"
  mkdir -p "$RELEASE_DIR"
  tar -C "$ROOT_DIR/web_app/dist" -czf "${RELEASE_DIR}/${TAR_FILE}" .
  if command -v zip >/dev/null 2>&1; then
    (cd "$ROOT_DIR/web_app/dist" && zip -qr "${RELEASE_DIR}/${ZIP_FILE}" .)
  else
    "$PYTHON_BIN" - "$ROOT_DIR/web_app/dist" "${RELEASE_DIR}/${ZIP_FILE}" <<'PY'
import sys
import zipfile
from pathlib import Path

src = Path(sys.argv[1])
out_zip = Path(sys.argv[2])
with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
    for item in sorted(src.rglob("*")):
        if item.is_file():
            zf.write(item, item.relative_to(src))
PY
  fi
  cp "$ROOT_DIR/models/registry.json" "${RELEASE_DIR}/${REG_COPY}"
  cp "$ROOT_DIR/models/artifacts_manifest.json" "${RELEASE_DIR}/${MAN_COPY}"
  (
    cd "$RELEASE_DIR"
    sha256sum "$TAR_FILE" "$ZIP_FILE" "$REG_COPY" "$MAN_COPY" > SHA256SUMS
    sha256sum -c SHA256SUMS
  )
  echo "[OK] Packaged and checksummed release artifacts in ${RELEASE_DIR}."
fi

# 6. Tag and push synchronized main + tag across configured remotes
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  TAG_TARGET="$(git rev-list -n 1 "$TAG")"
  HEAD_SHA="$(git rev-parse HEAD)"
  if [[ "$TAG_TARGET" != "$HEAD_SHA" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "[DRY-RUN] Existing tag ${TAG} (${TAG_TARGET:0:7}) does not match HEAD (${HEAD_SHA:0:7})."
    else
      echo "ERROR: Existing tag ${TAG} points to ${TAG_TARGET}, not HEAD (${HEAD_SHA})." >&2
      exit 1
    fi
  else
    echo "[OK] Tag ${TAG} already points to HEAD (${HEAD_SHA:0:7})."
  fi
else
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[DRY-RUN] Would run: git tag -a ${TAG} -m \"SOMSense ${TAG}\""
  else
    git tag -a "$TAG" -m "SOMSense ${TAG}"
    echo "[OK] Created annotated tag ${TAG}."
  fi
fi

read -r -a REMOTES <<< "$REMOTES_STR"
for remote in "${REMOTES[@]}"; do
  if ! REMOTE_URL="$(git remote get-url "$remote" 2>/dev/null)"; then
    if [[ "$DRY_RUN" == "true" ]]; then
      echo "[DRY-RUN] Remote '${remote}' is not configured yet (would require: git remote add ${remote} <url>)."
      continue
    else
      echo "ERROR: Git remote '${remote}' is not configured. Add all target remotes before releasing." >&2
      exit 1
    fi
  fi

  if [[ "$REMOTE_URL" =~ ://[^/]+:[^/]+@ ]]; then
    echo "ERROR: Remote '${remote}' URL embeds credentials; use SSH or git credential helpers instead." >&2
    exit 1
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[DRY-RUN] Would push main and ${TAG} to remote '${remote}' (${REMOTE_URL})."
  else
    echo "==> Pushing main and ${TAG} to '${remote}'..."
    git push "$remote" main
    git push "$remote" "$TAG"
  fi
done

echo "==> Release flow complete (dry_run=${DRY_RUN}, tag=${TAG})."
