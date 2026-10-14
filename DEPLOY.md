# Deploy guide

Everything here is free. You need a GitHub account, a Cloudflare account, and about 15 minutes.

## How it fits together

```
GitHub Actions (free, scheduled)           Cloudflare Worker (free)             Your phone / browser
 python -m pipeline.run ...  ──► `data` branch ◄── reads + caches ── /api/* ◄──  the PWA
 quotes   every 10 min, market hours       serves public/ as the site            polls /api/live every 30 s
 filings  hourly (SEC 10-Q / 10-K)         /api/live = Yahoo quote proxy         TradingView widgets (browser)
 daily    close + pre-open: history,
          statements, news, management,
          evidence
```

Why two hosts: the free Cloudflare plan allows 10 ms of CPU per request, too little to parse SEC filings, and yfinance cannot run
there at all. The heavy work runs on GitHub's free runners; the Worker only relays and caches the results. Netlify's free tier was
dropped because its monthly credit cap can pause the site.

## One-time setup (automatic)

```
scripts/setup.sh "Your Name you@example.com"
```

It creates a public GitHub repo, stores the SEC contact string as a secret, points the Worker at the repo, starts the first data
runs, and deploys the site. Needs `git`, the GitHub CLI (`gh auth login`), and Node 20+.

Optional: `GEMINI_API_KEY=... scripts/setup.sh ...` stores a free Google AI Studio key. With it, the daily job reads earnings
releases and builds the guidance record (see below). Without it, everything else still works.

## One-time setup (by hand)

1. Create a GitHub repository (public) and push this folder to `main`.
2. Repo Settings → Secrets and variables → Actions → add `SEC_USER_AGENT` = `Your Name you@example.com`.
3. Repo Settings → Actions → General → Workflow permissions → Read and write.
4. Actions tab → run **daily** once, then **quotes** and **filings**. The first daily run takes five to ten minutes and creates the
   `data` branch.
5. Edit `worker/wrangler.toml`: set `REPO = "your-username/your-repo"`.
6. `npm install`, then `npx wrangler login`, then `npx wrangler deploy --config worker/wrangler.toml`.
7. Open the `*.workers.dev` address on your phone and Add to Home Screen.

A private repo works too: create a fine-grained GitHub token with read-only Contents access to that repo and run
`npx wrangler secret put GH_TOKEN --config worker/wrangler.toml`.

## What refreshes on its own

| What | How often | Source |
|---|---|---|
| Header price on the stock page, Markets board | every 30 s while open | Worker `/api/live` → Yahoo chart feed (delayed) |
| Quotes, intraday bars, index levels, 10-year yield | every 10 min in market hours | Actions → Yahoo, Stooq as backup |
| New 10-Q / 10-K detection, baseline rebase | hourly | SEC EDGAR |
| Statements, ratios inputs, profile, analyst targets | daily and on a new filing | SEC XBRL, yfinance for gaps |
| Price history, technical read | daily | Yahoo, Stooq backup |
| Headlines | daily | yfinance, Yahoo RSS backup |
| Tripwire readings, statistical driver checks, review flags | after every data run | computed from the above |
| Management record (surprises, capital allocation, quality, governance, insiders) | daily | yfinance + statements |
| Guidance record | daily, three new releases per name per run | SEC 8-K earnings releases, optional model key |

The TradingView widgets load from TradingView in the browser and are free but mostly delayed by 15 minutes.

## What does not refresh by itself

The narrative in each research file (pillars, variant view, driver reasoning, catalysts) and the curated digest items are written by
a person or by Claude in a session. The pipeline recomputes the numbers around them and raises a "needs a human look" flag when a
new filing lands or a tripwire trips, but it never rewrites the text.

## Limits and failure modes

- GitHub schedules can run late by several minutes, and GitHub disables scheduled workflows after 60 days without repo activity.
  Push any commit (or re-enable in the Actions tab) if the data goes stale.
- Yahoo sometimes refuses cloud IP ranges. Quotes then fall back to Stooq end-of-day; the header price still comes from the Worker.
- yfinance is an unofficial scraper and can break. Statements come from SEC filings first, so a yfinance break only loses analyst
  targets, insider trades, consensus estimates and news (news falls back to Yahoo RSS).
- The app never breaks when the backend is down: it falls back to the files shipped with it and says so.
- Check `/api/health` for the last run of each job and its errors.

## Guidance record, honestly

No free source supplies a clean history of company guidance. This build reads each earnings release (8-K Item 2.02), asks a model
for guidance and reported-result sentences, and keeps an item only if its quote appears word for word in the release and its numbers
appear in the quote. Whether a guide was hit is then decided by plain code. Only public press-release text is sent to the provider.
Expect a thin record for the first few weeks; it deepens each run.
