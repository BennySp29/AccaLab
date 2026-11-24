"""SQLite database connection, schema initialization, and user seeding for AccaLab."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

from werkzeug.security import generate_password_hash

from accalab.config import DATA_DIR, DB_PATH


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def get_connection() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    try:
        conn.execute("PRAGMA journal_mode = WAL;")
    except sqlite3.OperationalError:
        conn.execute("PRAGMA journal_mode = DELETE;")
    conn.execute("PRAGMA busy_timeout = 10000;")
    return conn


@contextmanager
def db_session() -> Iterator[sqlite3.Connection]:
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL DEFAULT '',
    avatar_color TEXT NOT NULL DEFAULT '#10b981',
    bankroll REAL NOT NULL DEFAULT 250.0,
    kelly_fraction REAL NOT NULL DEFAULT 0.25,
    min_edge_pct REAL NOT NULL DEFAULT 4.0,
    telegram_chat_id TEXT DEFAULT '',
    monthly_stake_limit REAL NOT NULL DEFAULT 200.0,
    show_on_leaderboard INTEGER NOT NULL DEFAULT 1,
    favourite_teams_json TEXT NOT NULL DEFAULT '[]',
    preferred_leagues_json TEXT NOT NULL DEFAULT '["E0","E1","E2","E3"]',
    default_stake REAL NOT NULL DEFAULT 10.0,
    active_slip_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS historical_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season TEXT NOT NULL,
    div TEXT NOT NULL,
    match_date TEXT NOT NULL,
    kickoff_time TEXT DEFAULT '',
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    fthg INTEGER,
    ftag INTEGER,
    ftr TEXT,
    hthg INTEGER,
    htag INTEGER,
    hs INTEGER,
    as_shots INTEGER,
    hst INTEGER,
    ast INTEGER,
    hc INTEGER,
    ac INTEGER,
    hy INTEGER,
    ay INTEGER,
    hr INTEGER,
    ar INTEGER,
    referee TEXT DEFAULT '',
    b365h REAL,
    b365d REAL,
    b365a REAL,
    b365_over25 REAL,
    b365_under25 REAL,
    b365ch REAL,
    b365cd REAL,
    b365ca REAL,
    b365c_over25 REAL,
    b365c_under25 REAL,
    avg_h REAL,
    avg_d REAL,
    avg_a REAL,
    UNIQUE(season, div, match_date, home_team, away_team)
);

CREATE INDEX IF NOT EXISTS idx_hist_div_date ON historical_matches(div, match_date);
CREATE INDEX IF NOT EXISTS idx_hist_teams ON historical_matches(home_team, away_team);

CREATE TABLE IF NOT EXISTS upcoming_fixtures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    div TEXT NOT NULL,
    round_number INTEGER,
    match_date TEXT NOT NULL,
    kickoff_time TEXT DEFAULT '',
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    venue TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'scheduled',
    b365h REAL,
    b365d REAL,
    b365a REAL,
    b365_over25 REAL,
    b365_under25 REAL,
    b365_btts_yes REAL,
    b365_btts_no REAL,
    b365_open_h REAL,
    b365_open_d REAL,
    b365_open_a REAL,
    odds_source TEXT NOT NULL DEFAULT 'market_estimate',
    updated_at TEXT NOT NULL,
    UNIQUE(div, match_date, home_team, away_team)
);

CREATE INDEX IF NOT EXISTS idx_up_div_date ON upcoming_fixtures(div, match_date);

CREATE TABLE IF NOT EXISTS team_ratings (
    team_name TEXT PRIMARY KEY,
    div TEXT NOT NULL,
    elo REAL NOT NULL DEFAULT 1500.0,
    elo_change_last5 REAL NOT NULL DEFAULT 0.0,
    dc_attack REAL NOT NULL DEFAULT 0.0,
    dc_defence REAL NOT NULL DEFAULT 0.0,
    matches_played INTEGER NOT NULL DEFAULT 0,
    points INTEGER NOT NULL DEFAULT 0,
    gf INTEGER NOT NULL DEFAULT 0,
    ga INTEGER NOT NULL DEFAULT 0,
    shots_for_pg REAL NOT NULL DEFAULT 0.0,
    shots_against_pg REAL NOT NULL DEFAULT 0.0,
    sot_for_pg REAL NOT NULL DEFAULT 0.0,
    sot_against_pg REAL NOT NULL DEFAULT 0.0,
    form_last6 TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS predictions (
    fixture_id INTEGER PRIMARY KEY REFERENCES upcoming_fixtures(id) ON DELETE CASCADE,
    lambda_home REAL NOT NULL,
    mu_away REAL NOT NULL,
    rho REAL NOT NULL,
    prob_home REAL NOT NULL,
    prob_draw REAL NOT NULL,
    prob_away REAL NOT NULL,
    prob_over25 REAL NOT NULL,
    prob_under25 REAL NOT NULL,
    prob_btts_yes REAL NOT NULL,
    prob_btts_no REAL NOT NULL,
    top_scorelines_json TEXT NOT NULL,
    tipster_consensus_json TEXT NOT NULL,
    ai_summary TEXT NOT NULL DEFAULT '',
    ai_summary_source TEXT NOT NULL DEFAULT 'analyst_engine',
    model_version TEXT NOT NULL DEFAULT 'dc-elo-v1',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS news_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    published_at TEXT NOT NULL,
    matched_teams_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bet_type TEXT NOT NULL DEFAULT 'single',
    stake REAL NOT NULL,
    combined_odds REAL NOT NULL,
    combined_model_prob REAL NOT NULL,
    expected_value_pct REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    pnl REAL NOT NULL DEFAULT 0.0,
    clv_pct REAL,
    notes TEXT NOT NULL DEFAULT '',
    placed_at TEXT NOT NULL,
    settled_at TEXT
);

CREATE TABLE IF NOT EXISTS bet_legs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bet_id INTEGER NOT NULL REFERENCES bets(id) ON DELETE CASCADE,
    fixture_id INTEGER,
    div TEXT NOT NULL,
    match_date TEXT NOT NULL,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    market TEXT NOT NULL,
    selection_label TEXT NOT NULL,
    odds_taken REAL NOT NULL,
    closing_odds REAL,
    model_prob REAL NOT NULL,
    leg_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    alert_type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    fixture_id INTEGER,
    is_read INTEGER NOT NULL DEFAULT 0,
    sent_telegram INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    div TEXT NOT NULL,
    market TEXT NOT NULL,
    matches_tested INTEGER NOT NULL,
    brier_score REAL NOT NULL,
    log_loss REAL NOT NULL,
    value_bets_count INTEGER NOT NULL,
    win_rate_pct REAL NOT NULL,
    flat_roi_pct REAL NOT NULL,
    kelly_roi_pct REAL NOT NULL,
    avg_clv_pct REAL NOT NULL,
    calibration_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(div, market)
);

CREATE TABLE IF NOT EXISTS api_usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    status_code INTEGER,
    called_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS saved_fixtures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fixture_id INTEGER NOT NULL REFERENCES upcoming_fixtures(id) ON DELETE CASCADE,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE(user_id, fixture_id)
);

CREATE TABLE IF NOT EXISTS saved_accas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    stake REAL NOT NULL DEFAULT 10.0,
    legs_json TEXT NOT NULL,
    combined_odds REAL NOT NULL,
    combined_prob REAL NOT NULL,
    ev_pct REAL NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS racing_races (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    race_key TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    external_id TEXT DEFAULT '',
    region_code TEXT NOT NULL,
    country_name TEXT NOT NULL DEFAULT '',
    course TEXT NOT NULL,
    race_date TEXT NOT NULL,
    off_time TEXT NOT NULL,
    off_timestamp_utc TEXT DEFAULT '',
    race_name TEXT NOT NULL,
    race_type TEXT NOT NULL DEFAULT 'Flat',
    race_class TEXT DEFAULT '',
    is_handicap INTEGER NOT NULL DEFAULT 0,
    distance_text TEXT DEFAULT '',
    distance_meters INTEGER DEFAULT 0,
    going TEXT DEFAULT '',
    surface TEXT DEFAULT '',
    prize_text TEXT DEFAULT '',
    runners_count INTEGER NOT NULL DEFAULT 0,
    places_paid INTEGER NOT NULL DEFAULT 3,
    place_fraction REAL NOT NULL DEFAULT 0.2,
    status TEXT NOT NULL DEFAULT 'scheduled',
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_racing_races_date_region ON racing_races(race_date, region_code);

CREATE TABLE IF NOT EXISTS racing_runners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    race_id INTEGER NOT NULL REFERENCES racing_races(id) ON DELETE CASCADE,
    runner_key TEXT NOT NULL,
    saddle_cloth INTEGER DEFAULT 0,
    draw INTEGER,
    horse_name TEXT NOT NULL,
    age INTEGER,
    sex TEXT DEFAULT '',
    weight_lbs INTEGER,
    weight_display TEXT DEFAULT '',
    official_rating INTEGER,
    jockey TEXT DEFAULT '',
    trainer TEXT DEFAULT '',
    owner TEXT DEFAULT '',
    form_string TEXT DEFAULT '',
    form_direction TEXT NOT NULL DEFAULT 'rtl',
    days_since_run INTEGER,
    headgear TEXT DEFAULT '',
    career_runs INTEGER DEFAULT 0,
    career_wins INTEGER DEFAULT 0,
    career_places INTEGER DEFAULT 0,
    career_earnings REAL DEFAULT 0.0,
    silk_url TEXT DEFAULT '',
    is_debutant INTEGER NOT NULL DEFAULT 0,
    non_runner INTEGER NOT NULL DEFAULT 0,
    finish_pos INTEGER,
    market_odds REAL,
    odds_source TEXT NOT NULL DEFAULT 'model_tissue',
    model_rating REAL NOT NULL DEFAULT 50.0,
    model_win_prob REAL NOT NULL DEFAULT 0.0,
    model_place_prob REAL NOT NULL DEFAULT 0.0,
    fair_win_odds REAL NOT NULL DEFAULT 0.0,
    fair_place_odds REAL NOT NULL DEFAULT 0.0,
    win_edge_pct REAL NOT NULL DEFAULT 0.0,
    ew_edge_pct REAL NOT NULL DEFAULT 0.0,
    reasons_json TEXT NOT NULL DEFAULT '[]',
    reason_stats_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    UNIQUE(race_id, runner_key)
);

CREATE INDEX IF NOT EXISTS idx_racing_runners_race ON racing_runners(race_id);

CREATE TABLE IF NOT EXISTS racing_news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    published_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""


def _migrate_users_table(conn: sqlite3.Connection) -> None:
    """Safely add new account & personalisation columns to existing SQLite users table."""
    existing_cols = {
        row["name"] for row in conn.execute("PRAGMA table_info(users)").fetchall()
    }
    migrations = [
        ("email", "TEXT NOT NULL DEFAULT ''"),
        ("password_hash", "TEXT NOT NULL DEFAULT ''"),
        ("favourite_teams_json", "TEXT NOT NULL DEFAULT '[]'"),
        ("preferred_leagues_json", """TEXT NOT NULL DEFAULT '["E0","E1","E2","E3"]'"""),
        ("default_stake", "REAL NOT NULL DEFAULT 10.0"),
        ("active_slip_json", "TEXT NOT NULL DEFAULT '[]'"),
    ]
    for col, col_def in migrations:
        if col not in existing_cols:
            conn.execute(f"ALTER TABLE users ADD COLUMN {col} {col_def};")


def init_db() -> None:
    """Create database tables and apply safe schema migrations."""
    with db_session() as conn:
        conn.executescript(SCHEMA_SQL)
        _migrate_users_table(conn)


def is_within_cache_window(last_iso: str | None, minutes: int) -> bool:
    """Return True when a UTC ISO timestamp is strictly newer than `minutes` ago."""
    if not last_iso or minutes <= 0:
        return False
    try:
        dt = datetime.strptime(last_iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return False
    return (datetime.now(timezone.utc) - dt) < timedelta(minutes=minutes)


def get_provider_calls_today(conn: sqlite3.Connection, provider: str) -> int:
    """Count API usage log entries recorded today (UTC) for `provider`."""
    today_prefix = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    row = conn.execute(
        "SELECT COUNT(*) AS cnt FROM api_usage_log WHERE provider = ? AND called_at LIKE ?",
        (provider, f"{today_prefix}%"),
    ).fetchone()
    return int(row["cnt"]) if row else 0


def get_last_provider_call_iso(
    conn: sqlite3.Connection,
    provider: str,
    endpoint_prefix: str = "",
    status_code: int | None = None,
) -> str | None:
    """Return the latest UTC ISO timestamp for a provider call matching optional filters."""
    sql = "SELECT called_at FROM api_usage_log WHERE provider = ?"
    params: list[Any] = [provider]
    if endpoint_prefix:
        sql += " AND endpoint LIKE ?"
        params.append(f"{endpoint_prefix}%")
    if status_code is not None:
        sql += " AND status_code = ?"
        params.append(status_code)
    sql += " ORDER BY called_at DESC, id DESC LIMIT 1"
    row = conn.execute(sql, params).fetchone()
    return str(row["called_at"]) if row and row["called_at"] else None


def get_api_football_calls_today(conn: sqlite3.Connection) -> int:
    return get_provider_calls_today(conn, "api_football")


def get_api_quota_summary(conn: sqlite3.Connection) -> dict[str, Any]:
    """Return live usage counters, remaining daily budgets, and cache TTL status."""
    af_used = get_provider_calls_today(conn, "api_football")
    gem_used = get_provider_calls_today(conn, "gemini_flash")
    last_sync_at = get_last_provider_call_iso(conn, "core_sync", status_code=200)
    last_racing_at = (
        get_last_provider_call_iso(conn, "entain_public", status_code=200)
        or get_last_provider_call_iso(conn, "pmu_public", status_code=200)
    )
    return {
        "core_feeds": {
            "status": "unlimited",
            "label": "Unlimited Free Feeds (Football-Data + FixtureDownload + RSS)",
        },
        "last_sync_at": last_sync_at,
        "cache_ttl_minutes": 30,
        "cache_active": is_within_cache_window(last_sync_at, 30),
        "api_football": {
            "used_today": af_used,
            "daily_limit": 100,
            "remaining": max(0, 100 - af_used),
            "cache_window_hours": 6,
        },
        "gemini_ai": {
            "used_today": gem_used,
            "daily_limit": 60,
            "remaining": max(0, 60 - gem_used),
            "fallback": "Built-in Analyst Engine (Unlimited)",
        },
        "racing_feeds": {
            "status": "free_public_no_key",
            "last_sync_at": last_racing_at,
            "label": "Free Public Feeds (TAB/Entain + PMU + BBC RSS • No Card/Key)",
        },
    }
