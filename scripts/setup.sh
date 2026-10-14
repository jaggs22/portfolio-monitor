#!/usr/bin/env bash
# One-time setup from your own computer. Needs: git, gh (GitHub CLI, logged in), node 20+.
# Usage: scripts/setup.sh "Your Name you@example.com" [repo-name]
set -euo pipefail
UA="${1:?usage: scripts/setup.sh \"Your Name you@example.com\" [repo-name]}"
NAME="${2:-portfolio-monitor}"
OWNER="$(gh api user -q .login)"
REPO="$OWNER/$NAME"

echo "1/5 Creating the GitHub repository $REPO (public, so the Worker can read the data branch without a token)"
[ -d .git ] || git init -b main
git branch -M main
git add -A && git commit -qm "Portfolio monitor" || true
gh repo view "$REPO" >/dev/null 2>&1 || gh repo create "$REPO" --public --source . --remote origin --push
git push -u origin main

echo "2/5 Storing the SEC contact string as a secret (SEC requires it on every request)"
gh secret set SEC_USER_AGENT --body "$UA" --repo "$REPO"
if [ -n "${GEMINI_API_KEY:-}" ]; then gh secret set GEMINI_API_KEY --body "$GEMINI_API_KEY" --repo "$REPO"; echo "   optional guidance-extraction key stored"; fi

echo "3/5 Pointing the Worker at the repository"
sed -i.bak "s#CHANGE_ME/portfolio-monitor#$REPO#" worker/wrangler.toml && rm -f worker/wrangler.toml.bak
git add worker/wrangler.toml && git commit -qm "Set data repo" && git push -q

echo "4/5 Running the data jobs once (the daily job takes about five to ten minutes)"
gh workflow run daily --repo "$REPO"
sleep 5
gh workflow run quotes --repo "$REPO" || true
gh workflow run filings --repo "$REPO" || true

echo "5/5 Deploying the site to Cloudflare Workers (a browser window opens the first time to log in)"
npm install --silent
npx wrangler deploy --config worker/wrangler.toml

echo
echo "Done. Open the workers.dev address printed above on your phone, then Add to Home Screen."
echo "Watch the first data run: https://github.com/$REPO/actions"
