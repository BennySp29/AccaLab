"""CLI entrypoint for AccaLab: run live sync pipeline or launch the PWA web server."""

from __future__ import annotations

import argparse
import json
import sys

from accalab.db import db_session, init_db
from accalab.pipeline import run_full_sync
from accalab.web import create_app


def main() -> int:
    parser = argparse.ArgumentParser(description="AccaLab Football Betting Assistant")
    sub = parser.add_subparsers(dest="command")

    sync_p = sub.add_parser("sync", help="Ingest live data, fit Dixon-Coles + Elo, backtest & settle bets")
    sync_p.add_argument("--no-backtest", action="store_true", help="Skip walk-forward backtest recomputation")

    serve_p = sub.add_parser("serve", help="Start the AccaLab PWA web server")
    serve_p.add_argument("--host", default="127.0.0.1")
    serve_p.add_argument("--port", type=int, default=5000)
    serve_p.add_argument("--skip-initial-sync", action="store_true")

    args = parser.parse_args()
    cmd = args.command or "serve"

    if cmd == "sync":
        result = run_full_sync(run_backtest=not args.no_backtest)
        print(json.dumps(result, indent=2))
        return 0

    init_db()
    if not getattr(args, "skip_initial_sync", False):
        with db_session() as conn:
            hist_cnt = conn.execute("SELECT COUNT(*) AS c FROM historical_matches").fetchone()["c"]
        if hist_cnt == 0:
            print("Database empty — running initial live data sync & model fit...")
            res = run_full_sync(run_backtest=True)
            print(f"Initial sync complete: {res['counts']}")

    app = create_app()
    host = getattr(args, "host", "127.0.0.1")
    port = getattr(args, "port", 5000)
    print(f"AccaLab PWA running at http://{host}:{port}")
    app.run(host=host, port=port, debug=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
