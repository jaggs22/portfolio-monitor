#!/usr/bin/env bash
# Publish ./out to the `data` branch as ONE commit (history is discarded on purpose: the branch is a cache, not a record).
set -euo pipefail
REPO="${GITHUB_REPOSITORY:?}"
URL="https://x-access-token:${GITHUB_TOKEN:?}@github.com/${REPO}.git"
cd out
rm -rf .git
git init --quiet -b data
git config user.name "data-bot"
git config user.email "data-bot@users.noreply.github.com"
git add -A
if git diff --cached --quiet; then echo "nothing to publish"; exit 0; fi
git commit --quiet -m "data $(date -u +%Y-%m-%dT%H:%MZ)"
git push --quiet --force "$URL" data:data
echo "published"
