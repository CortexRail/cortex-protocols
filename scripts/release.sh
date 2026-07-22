#!/usr/bin/env bash
# =============================================================================
# Cortex Protocol — Release Version Bump
# =============================================================================
# Bumps the monorepo to a new semantic version in one shot:
#   - backend/package.json + package-lock.json
#   - frontend/package.json + package-lock.json
#   - contract/contracts/*/Cargo.toml
#   - CHANGELOG.md ([Unreleased] section becomes the new version)
#
# Usage:
#   bash scripts/release.sh <major|minor|patch|X.Y.Z>
#
# The script only edits files. Review the diff, then commit, tag, and push —
# pushing the v<X.Y.Z> tag triggers .github/workflows/release.yml, which
# publishes a GitHub release from the CHANGELOG section.
# =============================================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REPO_URL="https://github.com/CortexRail/cortex-protocols"

BUMP="${1:-}"
if [[ -z "$BUMP" ]]; then
  echo "Usage: bash scripts/release.sh <major|minor|patch|X.Y.Z>" >&2
  exit 1
fi

current=$(jq -r .version backend/package.json)

case "$BUMP" in
  major|minor|patch)
    IFS=. read -r maj min pat <<<"$current"
    case "$BUMP" in
      major) next="$((maj + 1)).0.0" ;;
      minor) next="$maj.$((min + 1)).0" ;;
      patch) next="$maj.$min.$((pat + 1))" ;;
    esac
    ;;
  *)
    if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      next="$BUMP"
    else
      echo "Invalid version '$BUMP' — use major, minor, patch, or X.Y.Z" >&2
      exit 1
    fi
    ;;
esac

if ! grep -q '^## \[Unreleased\]' CHANGELOG.md; then
  echo "CHANGELOG.md has no '## [Unreleased]' section to promote" >&2
  exit 1
fi

echo "Bumping $current → $next"

# ── package.json + lockfiles ──────────────────────────────────────────────────

npm --prefix backend version "$next" --no-git-tag-version >/dev/null
npm --prefix frontend version "$next" --no-git-tag-version >/dev/null
echo "  ✔ backend/ and frontend/ package.json"

# ── Contract crates ───────────────────────────────────────────────────────────
# Replace only the first `version = "..."` line — that's the [package] version.

for crate in contract/contracts/*/Cargo.toml; do
  perl -pi -e '$done ||= s/^version = "[^"]*"/version = "'"$next"'"/' "$crate"
  echo "  ✔ $crate"
done

# ── CHANGELOG ─────────────────────────────────────────────────────────────────
# The Unreleased content moves under the new version heading; a fresh empty
# Unreleased section sits above it, and the compare links are rewritten.

today=$(date +%Y-%m-%d)
perl -pi -e "s/^## \\[Unreleased\\]\$/## [Unreleased]\n\n## [$next] - $today/" CHANGELOG.md
perl -pi -e "s|^\\[Unreleased\\]:.*\$|[Unreleased]: $REPO_URL/compare/v$next...HEAD\n[$next]: $REPO_URL/compare/v$current...v$next|" CHANGELOG.md
echo "  ✔ CHANGELOG.md"

echo ""
echo "Done. Review the diff, then:"
echo "  git commit -am \"chore(release): v$next\""
echo "  git tag v$next"
echo "  git push origin HEAD --tags   # tag push triggers the release workflow"
