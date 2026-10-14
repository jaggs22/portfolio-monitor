#!/usr/bin/env bash
# Check out the existing `data` branch into ./out (or start an empty one) so jobs can update files incrementally.
set -euo pipefail
REPO="${GITHUB_REPOSITORY:?}"
URL="https://x-access-token:${GITHUB_TOKEN:?}@github.com/${REPO}.git"
rm -rf out
if git ls-remote --exit-code --heads "$URL" data >/dev/null 2>&1; then
  git clone --quiet --depth 1 --branch data "$URL" out
else
  mkdir out
fi
