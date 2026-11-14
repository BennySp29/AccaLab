"""End-to-end data sync, modelling, backtesting, settlement, and alerting pipeline."""

from __future__ import annotations

from typing import Any

import httpx

from accalab.db import db_session, init_db
from accalab.ingest import (
    HEADERS,
    ingest_football_data_csvs,
    ingest_news_feeds,
    ingest_upcoming_fixtures,
)
from accalab.modeling import run_model_and_predictions, run_walk_forward_backtest
from accalab.value_engine import generate_value_alerts, seed_demo_historical_bets, settle_bets


def run_full_sync(run_backtest: bool = True) -> dict[str, Any]:
    """Execute full ingestion -> model -> backtest -> bet settlement -> alert pipeline."""
    init_db()
    with db_session() as conn:
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

        counts = {
            "historical_matches": conn.execute("SELECT COUNT(*) AS c FROM historical_matches").fetchone()["c"],
            "upcoming_fixtures": conn.execute("SELECT COUNT(*) AS c FROM upcoming_fixtures WHERE status='scheduled'").fetchone()["c"],
            "team_ratings": conn.execute("SELECT COUNT(*) AS c FROM team_ratings").fetchone()["c"],
            "news_items": conn.execute("SELECT COUNT(*) AS c FROM news_items").fetchone()["c"],
            "backtest_rows": conn.execute("SELECT COUNT(*) AS c FROM backtest_results").fetchone()["c"],
        }

    return {
        "historical": hist_res,
        "upcoming": up_res,
        "news": news_res,
        "model": model_res,
        "settled_bets": settled_cnt,
        "new_alerts": alerts_cnt,
        "backtest_computed": len(bt_res),
        "counts": counts,
    }
