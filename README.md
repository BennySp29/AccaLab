# AccaLab — Private Football Betting Assistant (EPL → League Two)

AccaLab is an installable Progressive Web App (PWA) for you and a small group of friends. It combines free, legitimate English football data sources, a time-decayed Dixon-Coles + Club Elo statistical model, Bet365 odds comparison, accumulator correlation math, walk-forward backtesting, Closing-Line Value (CLV) bet tracking, news RSS matching, and optional Gemini & Telegram alerts.

## Quick Start (Windows)

Run the live data sync & model calibration (uses your signed Python installation):

```powershell
& "C:\Users\bchad\AppData\Local\Python\bin\python.exe" run.py sync
```

Start the local PWA server:

```powershell
& "C:\Users\bchad\AppData\Local\Python\bin\python.exe" run.py serve
```

Then open **http://127.0.0.1:5000** in Chrome or Edge (you can click **Install AccaLab** in the browser address bar to install it as an app).

## User Accounts & Personalisation

- Click **Account** in the sidebar/header to create a personal account (requires your group invite code — `ACCALAB2026` by default) or sign in to an existing profile (seeded demo profiles use password `accalab`).
- Authenticated users stay signed in via persistent 30-day HTTP-only Flask sessions.
- Save **Favourite Clubs**, **Preferred Leagues** (`E0`–`E3`), **Fixture Watchlist (`★`)**, your active **Bet Slip & Default Stake**, and **Saved Draft Accumulators** directly to your account.

## Optional Free-Tier API Keys (`.env`)

Copy `.env.example` to `.env` if you want to enable optional extras:

- `API_FOOTBALL_KEY` — Free 100 req/day quota on `api-sports.io` (tracked automatically in `api_usage_log` with a 90/day safety cap) for live Bet365 pre-match odds (`bookmaker=8`).
- `GEMINI_API_KEY` — Google AI Studio free tier (`gemini-2.5-flash`) for on-demand AI match previews grounded strictly in ingested stats & RSS headlines.
- `TELEGRAM_BOT_TOKEN` & `TELEGRAM_DEFAULT_CHAT_ID` — Push high-edge value alerts directly to Telegram.
- `ACCALAB_INVITE_CODE` — Invite code required when adding a friend profile (`ACCALAB2026` by default).

## Project Structure

- `accalab/config.py` — League configs (`E0`–`E3`) and canonical club-name alias map
- `accalab/db.py` — SQLite schema & default group profiles
- `accalab/ingest.py` — `football-data.co.uk` CSVs (`2425`, `2526`, `2627` + `fixtures.csv`), `fixturedownload.com` 2026/27 schedules, optional API-Football Bet365 enrichment, and BBC/Sky/Guardian RSS feeds
- `accalab/modeling.py` — Chronological Club Elo, time-decayed Dixon-Coles Poisson MLE, scoreline heatmaps, grounded summaries, and walk-forward backtester
- `accalab/value_engine.py` — Multiplicative de-vigging, ¼ Kelly staking, Acca correlation detector, auto-settlement + CLV calculation, and Telegram dispatcher
- `accalab/web.py` — Flask REST API & PWA server
- `supabase/migrations/0001_initial_schema.sql` — Cloud PostgreSQL + Row-Level Security migration for Supabase hosting
- `.github/workflows/sync_pipeline.yml` — Scheduled 6-hour GitHub Actions pipeline
