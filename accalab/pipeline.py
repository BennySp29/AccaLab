"""End-to-end data sync, modelling, backtesting, settlement, and alerting pipeline."""

from __future__ import annotations

from typing import Any

import httpx

from accalab.db import (
    db_session,
    get_last_provider_call_iso,
    init_db,
    is_within_cache_window,
    utc_now_iso,
)
from accalab.ingest import (
    HEADERS,
    ingest_football_data_csvs,
    ingest_news_feeds,
    ingest_upcoming_fixtures,
)
from accalab.modeling import run_model_and_predictions, run_walk_forward_backtest
from accalab.value_engine import generate_value_alerts, seed_demo_historical_bets, settle_bets


def _sync_counts(conn) -> dict[str, int]:
    return {
        "historical_matches": conn.execute("SELECT COUNT(*) AS c FROM historical_matches").fetchone()["c"],
        "upcoming_fixtures": conn.execute("SELECT COUNT(*) AS c FROM upcoming_fixtures WHERE status='scheduled'").fetchone()["c"],
        "team_ratings": conn.execute("SELECT COUNT(*) AS c FROM team_ratings").fetchone()["c"],
        "news_items": conn.execute("SELECT COUNT(*) AS c FROM news_items").fetchone()["c"],
        "backtest_rows": conn.execute("SELECT COUNT(*) AS c FROM backtest_results").fetchone()["c"],
    }


def run_full_sync(run_backtest: bool = True, force: bool = False) -> dict[str, Any]:
    """Execute ingestion -> model -> backtest -> settlement -> alerts, honoring a 30-minute smart cache."""
    init_db()
    with db_session() as conn:
        last_sync = get_last_provider_call_iso(conn, "core_sync", status_code=200)
        scheduled_cnt = conn.execute(
            "SELECT COUNT(*) AS c FROM upcoming_fixtures WHERE status='scheduled'"
        ).fetchone()["c"]

        if not force and scheduled_cnt > 0 and is_within_cache_window(last_sync, minutes=30):
            settled_cnt = settle_bets(conn)
            alerts_cnt = generate_value_alerts(conn)
            return {
                "cached": True,
                "last_sync_at": last_sync,
                "historical": {"cached": True},
                "upcoming": {"cached": True},
                "news": {"cached": True},
                "model": {"cached": True},
                "settled_bets": settled_cnt,
                "new_alerts": alerts_cnt,
                "backtest_computed": 0,
                "counts": _sync_counts(conn),
            }

        with httpx.Client(headers=HEADERS, follow_redirects=True, timeout=20.0) as client:
            hist_res = ingest_football_data_csvs(conn, client=client)
            up_res = ingest_upcoming_fixtures(conn, client=client)
            news_res = ingest_news_feeds(conn, client=client)

        model_res = run_model_and_predictions(conn)
        seed_demo_historical_bets(conn)
        settled_cnt = settle_bets(conn)

        bt_res: list[dict[str, Any]] = []
        if run_backtest:
            bt_res = run_walk_forward_backtest(conn)
        else:
            existing_bt = conn.execute("SELECT COUNT(*) AS cnt FROM backtest_results").fetchone()["cnt"]
            if existing_bt == 0:
                bt_res = run_walk_forward_backtest(conn)

        alerts_cnt = generate_value_alerts(conn)
        sync_ts = utc_now_iso()
        conn.execute(
            "INSERT INTO api_usage_log (provider, endpoint, status_code, called_at) VALUES (?, ?, ?, ?)",
            ("core_sync", "/pipeline/sync", 200, sync_ts),
        )

        counts = _sync_counts(conn)

    static_res: dict[str, Any] = {}
    try:
        from accalab.static_export import export_static_site

        static_res = export_static_site()
    except Exception as exc:
        static_res = {"error": str(exc)}

    return {
        "cached": False,
        "last_sync_at": sync_ts,
        "historical": hist_res,
        "upcoming": up_res,
        "news": news_res,
        "model": model_res,
        "settled_bets": settled_cnt,
        "new_alerts": alerts_cnt,
        "backtest_computed": len(bt_res),
        "counts": counts,
        "static_export": static_res,
    }
