"""Flask web application and REST API for AccaLab PWA."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

from flask import Flask, Response, jsonify, render_template, request, session
from werkzeug.security import check_password_hash, generate_password_hash

from accalab.config import (
    ACCALAB_INVITE_CODE,
    API_FOOTBALL_KEY,
    CURRENT_SEASON,
    GEMINI_API_KEY,
    LEAGUES,
    MARKET_LABELS,
    SECRET_KEY,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_DEFAULT_CHAT_ID,
)
from accalab.db import (
    db_session,
    get_api_football_calls_today,
    get_api_quota_summary,
    get_provider_calls_today,
    init_db,
    is_within_cache_window,
    utc_now_iso,
)
from accalab.modeling import (
    generate_grounded_summary,
    score_matrix,
)
from accalab.pipeline import run_full_sync
from accalab.value_engine import (
    build_acca_presets,
    build_bet365_export,
    build_bet_suggestions,
    devig_three_way,
    devig_two_way,
    evaluate_acca,
    find_value_opportunities,
    kelly_stake_amount,
    parse_odds_value,
    send_telegram_message,
    settle_bets,
)


def create_app() -> Flask:
    app = Flask(__name__, template_folder="templates", static_folder="static")
    app.secret_key = SECRET_KEY
    app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=30)
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
    init_db()

    def _safe_json_list(raw: Any, fallback: list[Any]) -> list[Any]:
        if isinstance(raw, list):
            return raw
        if isinstance(raw, str) and raw.strip():
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, list):
                    return parsed
            except json.JSONDecodeError:
                pass
        return list(fallback)

    def _serialize_user(row: Any) -> dict[str, Any]:
        d = dict(row)
        d.pop("password_hash", None)
        d["favourite_teams"] = _safe_json_list(d.pop("favourite_teams_json", "[]"), [])
        d["preferred_leagues"] = _safe_json_list(
            d.pop("preferred_leagues_json", '["E0","E1","E2","E3"]'), ["E0", "E1", "E2", "E3"]
        )
        d["active_slip"] = _safe_json_list(d.pop("active_slip_json", "[]"), [])
        d["default_stake"] = float(d.get("default_stake") or 10.0)
        return d

    def _get_active_user(conn: Any) -> dict[str, Any]:
        sid = session.get("user_id")
        if sid:
            row = conn.execute("SELECT * FROM users WHERE id = ?", (int(sid),)).fetchone()
            if row:
                return _serialize_user(row)
        uid = request.args.get("user_id") or request.headers.get("X-User-Id")
        if uid and str(uid).isdigit():
            row = conn.execute("SELECT * FROM users WHERE id = ?", (int(uid),)).fetchone()
            if row:
                return _serialize_user(row)
        row = conn.execute("SELECT * FROM users ORDER BY id ASC LIMIT 1").fetchone()
        if row:
            return _serialize_user(row)
        return {
            "id": 1,
            "username": "admin",
            "display_name": "You (Admin)",
            "email": "",
            "avatar_color": "#10b981",
            "bankroll": 250.0,
            "kelly_fraction": 0.25,
            "min_edge_pct": 4.0,
            "telegram_chat_id": "",
            "monthly_stake_limit": 200.0,
            "show_on_leaderboard": 1,
            "favourite_teams": [],
            "preferred_leagues": ["E0", "E1", "E2", "E3"],
            "default_stake": 10.0,
            "active_slip": [],
        }

    def _all_teams_by_league(conn: Any) -> dict[str, list[str]]:
        grouped: dict[str, list[str]] = {code: [] for code in LEAGUES}
        rows = conn.execute(
            "SELECT team_name, div FROM team_ratings ORDER BY div ASC, team_name ASC"
        ).fetchall()
        for r in rows:
            if r["div"] in grouped:
                grouped[r["div"]].append(r["team_name"])
        return grouped

    def _fixture_best_edge(row: dict[str, Any]) -> dict[str, Any]:
        candidates: list[tuple[str, str, float, float | None]] = [
            ("1X2_H", f"{row['home_team']} Win", row["prob_home"], row.get("b365h")),
            ("1X2_D", "Draw", row["prob_draw"], row.get("b365d")),
            ("1X2_A", f"{row['away_team']} Win", row["prob_away"], row.get("b365a")),
            ("OU_O25", "Over 2.5", row["prob_over25"], row.get("b365_over25")),
            ("OU_U25", "Under 2.5", row["prob_under25"], row.get("b365_under25")),
            ("BTTS_Y", "BTTS Yes", row["prob_btts_yes"], row.get("b365_btts_yes")),
            ("BTTS_N", "BTTS No", row["prob_btts_no"], row.get("b365_btts_no")),
        ]
        best = {"market": "", "label": "", "edge_pct": -999.0, "odds": 0.0}
        for m_code, label, prob, odd in candidates:
            if odd and odd > 1.01:
                edge = (prob * odd - 1.0) * 100.0
                if edge > best["edge_pct"]:
                    best = {"market": m_code, "label": label, "edge_pct": round(edge, 1), "odds": round(odd, 2)}
        return best

    def _team_split_stats(conn: Any, team: str, is_home: bool) -> dict[str, Any]:
        col = "home_team" if is_home else "away_team"
        rows = conn.execute(
            f"""
            SELECT * FROM historical_matches
            WHERE season = ? AND {col} = ?
            ORDER BY match_date DESC LIMIT 6
            """,
            (CURRENT_SEASON, team),
        ).fetchall()
        played = len(rows)
        if played == 0:
            return {"played": 0, "w": 0, "d": 0, "l": 0, "gf": 0, "ga": 0, "avg_gf": 0.0, "avg_ga": 0.0}
        w = d = l = gf = ga = 0
        for r in rows:
            tg = r["fthg"] if is_home else r["ftag"]
            og = r["ftag"] if is_home else r["fthg"]
            gf += int(tg or 0)
            ga += int(og or 0)
            if tg > og:
                w += 1
            elif tg == og:
                d += 1
            else:
                l += 1
        return {
            "played": played,
            "w": w,
            "d": d,
            "l": l,
            "gf": gf,
            "ga": ga,
            "avg_gf": round(gf / played, 2),
            "avg_ga": round(ga / played, 2),
        }

    def _league_standings(conn: Any, div: str) -> list[dict[str, Any]]:
        rows = conn.execute(
            """
            SELECT * FROM team_ratings
            WHERE div = ?
            ORDER BY points DESC, (gf - ga) DESC, gf DESC, elo DESC
            """,
            (div,),
        ).fetchall()
        table = []
        for pos, r in enumerate(rows, start=1):
            d = dict(r)
            d["pos"] = pos
            d["gd"] = d["gf"] - d["ga"]
            table.append(d)
        return table

    @app.route("/")
    def index() -> str:
        return render_template("index.html")

    @app.route("/manifest.json")
    def manifest() -> Response:
        return app.send_static_file("manifest.json")

    @app.route("/sw.js")
    def service_worker() -> Response:
        resp = app.send_static_file("sw.js")
        resp.headers["Content-Type"] = "application/javascript"
        return resp

    @app.route("/icon.svg")
    def app_icon() -> Response:
        svg = (
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
            '<rect width="128" height="128" rx="28" fill="#0f172a"/>'
            '<circle cx="64" cy="64" r="44" fill="none" stroke="#10b981" stroke-width="8"/>'
            '<path d="M40 78 L58 46 L72 68 L88 42" fill="none" stroke="#34d399" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>'
            '<circle cx="88" cy="42" r="6" fill="#fbbf24"/>'
            '</svg>'
        )
        return Response(svg, mimetype="image/svg+xml")

    @app.route("/api/dashboard")
    def api_dashboard() -> Response:
        with db_session() as conn:
            user = _get_active_user(conn)
            users = [
                _serialize_user(r)
                for r in conn.execute("SELECT * FROM users ORDER BY id ASC").fetchall()
            ]
            watched_ids = [
                r["fixture_id"]
                for r in conn.execute("SELECT fixture_id FROM saved_fixtures WHERE user_id = ?", (user["id"],)).fetchall()
            ]
            saved_accas_count = conn.execute(
                "SELECT COUNT(*) AS c FROM saved_accas WHERE user_id = ?", (user["id"],)
            ).fetchone()["c"]
            opps = find_value_opportunities(
                conn,
                bankroll=user["bankroll"],
                kelly_fraction=user["kelly_fraction"],
                min_edge_pct=user["min_edge_pct"],
            )
            fav_set = set(user.get("favourite_teams") or [])
            watched_set = set(watched_ids)
            for_you_rows = [
                dict(r)
                for r in conn.execute(
                    """
                    SELECT f.id, f.div, f.match_date, f.kickoff_time, f.home_team, f.away_team,
                           f.b365h, f.b365d, f.b365a, f.odds_source,
                           p.prob_home, p.prob_draw, p.prob_away
                    FROM upcoming_fixtures f
                    JOIN predictions p ON p.fixture_id = f.id
                    WHERE f.status = 'scheduled'
                    ORDER BY f.match_date ASC, f.kickoff_time ASC
                    """
                ).fetchall()
                if r["home_team"] in fav_set or r["away_team"] in fav_set or r["id"] in watched_set
            ][:6]
            for fy in for_you_rows:
                fy["league_name"] = LEAGUES.get(fy["div"], {}).get("name", fy["div"])
                fy["is_watched"] = fy["id"] in watched_set

            counts = {
                "historical_matches": conn.execute("SELECT COUNT(*) AS c FROM historical_matches").fetchone()["c"],
                "upcoming_fixtures": conn.execute("SELECT COUNT(*) AS c FROM upcoming_fixtures WHERE status='scheduled'").fetchone()["c"],
                "official_b365_fixtures": conn.execute("SELECT COUNT(*) AS c FROM upcoming_fixtures WHERE status='scheduled' AND odds_source IN ('bet365_official','api_football_b365','user_manual')").fetchone()["c"],
                "teams_rated": conn.execute("SELECT COUNT(*) AS c FROM team_ratings").fetchone()["c"],
                "news_items": conn.execute("SELECT COUNT(*) AS c FROM news_items").fetchone()["c"],
                "unread_alerts": conn.execute("SELECT COUNT(*) AS c FROM alerts WHERE is_read = 0").fetchone()["c"],
                "api_football_calls_today": get_api_football_calls_today(conn),
                "saved_accas": saved_accas_count,
                "watched_fixtures": len(watched_ids),
            }
            user_bets = conn.execute("SELECT status, pnl, stake, clv_pct FROM bets WHERE user_id = ?", (user["id"],)).fetchall()
            settled = [b for b in user_bets if b["status"] in ("won", "lost")]
            tot_stake = sum(b["stake"] for b in settled)
            tot_pnl = sum(b["pnl"] for b in settled)
            clvs = [b["clv_pct"] for b in settled if b["clv_pct"] is not None]
            user_summary = {
                "total_bets": len(user_bets),
                "pending_bets": sum(1 for b in user_bets if b["status"] == "pending"),
                "settled_bets": len(settled),
                "total_pnl": round(tot_pnl, 2),
                "roi_pct": round((tot_pnl / tot_stake) * 100.0, 2) if tot_stake > 0 else 0.0,
                "avg_clv_pct": round(sum(clvs) / len(clvs), 2) if clvs else 0.0,
            }
            leagues_counts = {
                r["div"]: r["cnt"]
                for r in conn.execute("SELECT div, COUNT(*) AS cnt FROM upcoming_fixtures WHERE status='scheduled' GROUP BY div").fetchall()
            }
            integrations = {
                "api_football_configured": bool(API_FOOTBALL_KEY),
                "gemini_configured": bool(GEMINI_API_KEY),
                "telegram_configured": bool(TELEGRAM_BOT_TOKEN and (user.get("telegram_chat_id") or TELEGRAM_DEFAULT_CHAT_ID)),
            }
            quota = get_api_quota_summary(conn)
            suggestions_data = build_bet_suggestions(conn, user)
            featured_suggestion = suggestions_data.get("top_single")
            return jsonify(
                {
                    "authenticated": bool(session.get("user_id")),
                    "active_user": user,
                    "users": users,
                    "watched_fixture_ids": watched_ids,
                    "favourite_teams": user["favourite_teams"],
                    "for_you_fixtures": for_you_rows,
                    "all_teams_by_league": _all_teams_by_league(conn),
                    "counts": counts,
                    "leagues_counts": leagues_counts,
                    "user_summary": user_summary,
                    "top_value_bets": opps[:6],
                    "featured_suggestion": featured_suggestion,
                    "featured_by_risk": suggestions_data.get("by_risk", {}),
                    "quota": quota,
                    "integrations": integrations,
                    "leagues": LEAGUES,
                }
            )

    @app.route("/api/fixtures")
    def api_fixtures() -> Response:
        div = (request.args.get("div") or "").strip()
        search = (request.args.get("search") or "").strip().lower()
        date_filter = (request.args.get("date") or "").strip()

        with db_session() as conn:
            user = _get_active_user(conn)
            fav_set = set(user.get("favourite_teams") or [])
            watched_set = {
                r["fixture_id"]
                for r in conn.execute("SELECT fixture_id FROM saved_fixtures WHERE user_id = ?", (user["id"],)).fetchall()
            }

            sql = """
                SELECT f.*, p.lambda_home, p.mu_away, p.rho,
                       p.prob_home, p.prob_draw, p.prob_away,
                       p.prob_over25, p.prob_under25, p.prob_btts_yes, p.prob_btts_no,
                       p.top_scorelines_json, p.tipster_consensus_json, p.ai_summary_source,
                       hr.elo AS home_elo, hr.form_last6 AS home_form,
                       ar.elo AS away_elo, ar.form_last6 AS away_form
                FROM upcoming_fixtures f
                JOIN predictions p ON p.fixture_id = f.id
                LEFT JOIN team_ratings hr ON hr.team_name = f.home_team
                LEFT JOIN team_ratings ar ON ar.team_name = f.away_team
                WHERE f.status = 'scheduled'
            """
            params: list[Any] = []
            if div in LEAGUES:
                sql += " AND f.div = ?"
                params.append(div)
            if date_filter:
                sql += " AND f.match_date = ?"
                params.append(date_filter)
            sql += " ORDER BY f.match_date ASC, f.kickoff_time ASC, f.div ASC"

            fixtures = []
            for r in conn.execute(sql, params).fetchall():
                d = dict(r)
                is_fav = d["home_team"] in fav_set or d["away_team"] in fav_set
                is_watched = d["id"] in watched_set
                if div == "MY_TEAMS" and not (is_fav or is_watched):
                    continue
                if div == "WATCHLIST" and not is_watched:
                    continue
                if search and search not in d["home_team"].lower() and search not in d["away_team"].lower():
                    continue
                d["league_name"] = LEAGUES.get(d["div"], {}).get("name", d["div"])
                d["top_scorelines"] = json.loads(d.pop("top_scorelines_json") or "[]")
                d["tipster_consensus"] = json.loads(d.pop("tipster_consensus_json") or "{}")
                d["best_edge"] = _fixture_best_edge(d)
                d["is_watched"] = is_watched
                d["is_favourite_match"] = is_fav
                fixtures.append(d)

            return jsonify(
                {
                    "fixtures": fixtures,
                    "total": len(fixtures),
                    "watched_fixture_ids": list(watched_set),
                    "favourite_teams": list(fav_set),
                }
            )

    @app.route("/api/fixture/<int:fixture_id>")
    def api_fixture_detail(fixture_id: int) -> tuple[Response, int] | Response:
        with db_session() as conn:
            user = _get_active_user(conn)
            row = conn.execute(
                """
                SELECT f.*, p.*
                FROM upcoming_fixtures f
                JOIN predictions p ON p.fixture_id = f.id
                WHERE f.id = ?
                """,
                (fixture_id,),
            ).fetchone()
            if not row:
                return jsonify({"error": "Fixture not found"}), 404

            fix = dict(row)
            fix["league_name"] = LEAGUES.get(fix["div"], {}).get("name", fix["div"])
            fix["top_scorelines"] = json.loads(fix.pop("top_scorelines_json") or "[]")
            fix["tipster_consensus"] = json.loads(fix.pop("tipster_consensus_json") or "{}")

            home_rating = conn.execute("SELECT * FROM team_ratings WHERE team_name = ?", (fix["home_team"],)).fetchone()
            away_rating = conn.execute("SELECT * FROM team_ratings WHERE team_name = ?", (fix["away_team"],)).fetchone()

            h2h = [
                dict(r)
                for r in conn.execute(
                    """
                    SELECT match_date, div, home_team, away_team, fthg, ftag, ftr, b365h, b365d, b365a
                    FROM historical_matches
                    WHERE (home_team = ? AND away_team = ?) OR (home_team = ? AND away_team = ?)
                    ORDER BY match_date DESC LIMIT 6
                    """,
                    (fix["home_team"], fix["away_team"], fix["away_team"], fix["home_team"]),
                ).fetchall()
            ]

            recent_home = [
                dict(r)
                for r in conn.execute(
                    """
                    SELECT match_date, home_team, away_team, fthg, ftag, hs, as_shots, hst, ast
                    FROM historical_matches
                    WHERE home_team = ? OR away_team = ?
                    ORDER BY match_date DESC LIMIT 6
                    """,
                    (fix["home_team"], fix["home_team"]),
                ).fetchall()
            ]
            recent_away = [
                dict(r)
                for r in conn.execute(
                    """
                    SELECT match_date, home_team, away_team, fthg, ftag, hs, as_shots, hst, ast
                    FROM historical_matches
                    WHERE home_team = ? OR away_team = ?
                    ORDER BY match_date DESC LIMIT 6
                    """,
                    (fix["away_team"], fix["away_team"]),
                ).fetchall()
            ]

            # Build 5x5 score matrix for heatmap visualization
            mat = score_matrix(fix["lambda_home"], fix["mu_away"], fix["rho"], max_goals=4)
            heatmap = [[round(mat[x][y] * 100.0, 1) for y in range(5)] for x in range(5)]

            # Market comparison table
            if fix.get("b365h") and fix.get("b365d") and fix.get("b365a"):
                fh, fd, fa, over_1x2 = devig_three_way(fix["b365h"], fix["b365d"], fix["b365a"])
            else:
                fh = fd = fa = over_1x2 = 0.0
            if fix.get("b365_over25") and fix.get("b365_under25"):
                fo, fu, over_ou = devig_two_way(fix["b365_over25"], fix["b365_under25"])
            else:
                fo = fu = over_ou = 0.0
            if fix.get("b365_btts_yes") and fix.get("b365_btts_no"):
                fby, fbn, _ = devig_two_way(fix["b365_btts_yes"], fix["b365_btts_no"])
            else:
                fby = fbn = 0.0

            markets = []
            for m_code, label, m_prob, odd, fair_b in [
                ("1X2_H", f"{fix['home_team']} Win", fix["prob_home"], fix.get("b365h"), fh),
                ("1X2_D", "Draw", fix["prob_draw"], fix.get("b365d"), fd),
                ("1X2_A", f"{fix['away_team']} Win", fix["prob_away"], fix.get("b365a"), fa),
                ("OU_O25", "Over 2.5 Goals", fix["prob_over25"], fix.get("b365_over25"), fo),
                ("OU_U25", "Under 2.5 Goals", fix["prob_under25"], fix.get("b365_under25"), fu),
                ("BTTS_Y", "BTTS Yes", fix["prob_btts_yes"], fix.get("b365_btts_yes"), fby),
                ("BTTS_N", "BTTS No", fix["prob_btts_no"], fix.get("b365_btts_no"), fbn),
            ]:
                edge = (m_prob * odd - 1.0) * 100.0 if odd else 0.0
                kpct, kstake = kelly_stake_amount(m_prob, odd or 1.0, user["bankroll"], user["kelly_fraction"])
                markets.append(
                    {
                        "market": m_code,
                        "label": label,
                        "model_prob_pct": round(m_prob * 100.0, 1),
                        "fair_odds": round(1.0 / max(m_prob, 0.01), 2),
                        "b365_odds": round(odd, 2) if odd else None,
                        "implied_fair_pct": round(fair_b * 100.0, 1) if fair_b else None,
                        "edge_pct": round(edge, 2),
                        "kelly_pct": kpct,
                        "suggested_stake": kstake,
                    }
                )

            news_all = [
                dict(r)
                for r in conn.execute("SELECT * FROM news_items ORDER BY published_at DESC LIMIT 80").fetchall()
            ]
            matched_news = [
                n
                for n in news_all
                if fix["home_team"] in json.loads(n["matched_teams_json"])
                or fix["away_team"] in json.loads(n["matched_teams_json"])
            ][:6]

            return jsonify(
                {
                    "fixture": fix,
                    "home_rating": dict(home_rating) if home_rating else {},
                    "away_rating": dict(away_rating) if away_rating else {},
                    "home_split": _team_split_stats(conn, fix["home_team"], is_home=True),
                    "away_split": _team_split_stats(conn, fix["away_team"], is_home=False),
                    "h2h": h2h,
                    "recent_home": recent_home,
                    "recent_away": recent_away,
                    "standings": _league_standings(conn, fix["div"]),
                    "score_heatmap": heatmap,
                    "markets": markets,
                    "overround_1x2_pct": round(over_1x2, 2),
                    "overround_ou25_pct": round(over_ou, 2),
                    "matched_news": matched_news,
                }
            )

    @app.route("/api/fixture/<int:fixture_id>/odds", methods=["POST"])
    def api_update_fixture_odds(fixture_id: int) -> tuple[Response, int] | Response:
        data = request.get_json(silent=True) or {}
        now = utc_now_iso()
        with db_session() as conn:
            fix = conn.execute("SELECT * FROM upcoming_fixtures WHERE id = ?", (fixture_id,)).fetchone()
            if not fix:
                return jsonify({"error": "Fixture not found"}), 404

            def _opt_odds(key: str, default: float | None) -> float | None:
                return parse_odds_value(data.get(key), default)

            conn.execute(
                """
                UPDATE upcoming_fixtures SET
                    b365h = ?, b365d = ?, b365a = ?,
                    b365_over25 = ?, b365_under25 = ?,
                    b365_btts_yes = ?, b365_btts_no = ?,
                    odds_source = 'user_manual',
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    _opt_odds("b365h", fix["b365h"]),
                    _opt_odds("b365d", fix["b365d"]),
                    _opt_odds("b365a", fix["b365a"]),
                    _opt_odds("b365_over25", fix["b365_over25"]),
                    _opt_odds("b365_under25", fix["b365_under25"]),
                    _opt_odds("b365_btts_yes", fix["b365_btts_yes"]),
                    _opt_odds("b365_btts_no", fix["b365_btts_no"]),
                    now,
                    fixture_id,
                ),
            )
        return jsonify({"ok": True, "fixture_id": fixture_id, "odds_source": "user_manual"})

    @app.route("/api/fixture/<int:fixture_id>/ai-summary", methods=["POST"])
    def api_regen_ai_summary(fixture_id: int) -> tuple[Response, int] | Response:
        now = utc_now_iso()
        with db_session() as conn:
            row = conn.execute(
                """
                SELECT f.*, p.*
                FROM upcoming_fixtures f JOIN predictions p ON p.fixture_id = f.id
                WHERE f.id = ?
                """,
                (fixture_id,),
            ).fetchone()
            if not row:
                return jsonify({"error": "Fixture not found"}), 404
            fix = dict(row)
            probs = {
                "prob_home": fix["prob_home"],
                "prob_draw": fix["prob_draw"],
                "prob_away": fix["prob_away"],
                "prob_over25": fix["prob_over25"],
                "prob_under25": fix["prob_under25"],
                "prob_btts_yes": fix["prob_btts_yes"],
                "prob_btts_no": fix["prob_btts_no"],
                "top_scorelines": json.loads(fix.get("top_scorelines_json") or "[]"),
            }
            h_row = dict(conn.execute("SELECT * FROM team_ratings WHERE team_name = ?", (fix["home_team"],)).fetchone() or {})
            a_row = dict(conn.execute("SELECT * FROM team_ratings WHERE team_name = ?", (fix["away_team"],)).fetchone() or {})
            h2h = [
                dict(r)
                for r in conn.execute(
                    """
                    SELECT match_date, home_team, away_team, fthg, ftag
                    FROM historical_matches
                    WHERE (home_team = ? AND away_team = ?) OR (home_team = ? AND away_team = ?)
                    ORDER BY match_date DESC LIMIT 3
                    """,
                    (fix["home_team"], fix["away_team"], fix["away_team"], fix["home_team"]),
                ).fetchall()
            ]
            news_all = [dict(r) for r in conn.execute("SELECT * FROM news_items ORDER BY published_at DESC LIMIT 80").fetchall()]
            matched_news = [
                n for n in news_all
                if fix["home_team"] in json.loads(n["matched_teams_json"]) or fix["away_team"] in json.loads(n["matched_teams_json"])
            ]
            if (
                fix.get("ai_summary")
                and fix.get("ai_summary_source") == "gemini_flash"
                and is_within_cache_window(fix.get("updated_at"), minutes=15)
            ):
                return jsonify({"ai_summary": fix["ai_summary"], "ai_summary_source": "gemini_flash", "cached": True})

            can_call_gemini = bool(GEMINI_API_KEY) and get_provider_calls_today(conn, "gemini_flash") < 60
            text, src = generate_grounded_summary(
                fix,
                h_row,
                a_row,
                probs,
                fix["lambda_home"],
                fix["mu_away"],
                h2h,
                matched_news,
                use_gemini=can_call_gemini,
            )
            if src == "gemini_flash":
                conn.execute(
                    "INSERT INTO api_usage_log (provider, endpoint, status_code, called_at) VALUES (?, ?, ?, ?)",
                    ("gemini_flash", f"/fixture/{fixture_id}/ai-summary", 200, now),
                )
            conn.execute(
                "UPDATE predictions SET ai_summary = ?, ai_summary_source = ?, updated_at = ? WHERE fixture_id = ?",
                (text, src, now, fixture_id),
            )
        return jsonify({"ai_summary": text, "ai_summary_source": src, "cached": False})

    @app.route("/api/value-bets")
    def api_value_bets() -> Response:
        div = (request.args.get("div") or "").strip() or None
        market = (request.args.get("market") or "").strip() or None
        official_only = request.args.get("official_only") == "1"
        try:
            min_edge = float(request.args.get("min_edge", "2.0"))
        except ValueError:
            min_edge = 2.0

        with db_session() as conn:
            user = _get_active_user(conn)
            opps = find_value_opportunities(
                conn,
                bankroll=user["bankroll"],
                kelly_fraction=user["kelly_fraction"],
                min_edge_pct=min_edge,
                div_filter=div,
                market_filter=market,
                official_only=official_only,
            )
            return jsonify({"opportunities": opps, "total": len(opps), "bankroll": user["bankroll"], "kelly_fraction": user["kelly_fraction"]})

    @app.route("/api/acca/presets")
    def api_acca_presets() -> Response:
        with db_session() as conn:
            user = _get_active_user(conn)
            presets = build_acca_presets(conn, bankroll=user["bankroll"])
            return jsonify({"presets": presets})

    @app.route("/api/acca/evaluate", methods=["POST"])
    def api_acca_evaluate() -> Response:
        payload = request.get_json(silent=True) or {}
        legs = payload.get("legs") or []
        try:
            stake = float(payload.get("stake", 10.0))
        except (TypeError, ValueError):
            stake = 10.0
        return jsonify(evaluate_acca(legs, stake=stake))

    @app.route("/api/suggest-bet")
    def api_suggest_bet() -> Response:
        with db_session() as conn:
            user = _get_active_user(conn)
            return jsonify(build_bet_suggestions(conn, user))

    @app.route("/api/bet365/export", methods=["POST"])
    def api_bet365_export() -> Response:
        payload = request.get_json(silent=True) or {}
        legs = payload.get("legs") or []
        try:
            stake = float(payload.get("stake", 10.0))
        except (TypeError, ValueError):
            stake = 10.0
        title = (payload.get("title") or "AccaLab Suggested Bet").strip()
        options_override = (payload.get("options_override") or "").strip()
        return jsonify(build_bet365_export(legs, stake=stake, title=title, options_override=options_override))

    @app.route("/api/bets", methods=["GET", "POST"])
    def api_bets() -> tuple[Response, int] | Response:
        if request.method == "GET":
            with db_session() as conn:
                user = _get_active_user(conn)
                bets_rows = [
                    dict(r)
                    for r in conn.execute(
                        "SELECT * FROM bets WHERE user_id = ? ORDER BY placed_at DESC, id DESC",
                        (user["id"],),
                    ).fetchall()
                ]
                for b in bets_rows:
                    b["legs"] = [
                        dict(l)
                        for l in conn.execute("SELECT * FROM bet_legs WHERE bet_id = ?", (b["id"],)).fetchall()
                    ]

                settled = [b for b in bets_rows if b["status"] in ("won", "lost")]
                wins = sum(1 for b in settled if b["status"] == "won")
                tot_stake = sum(b["stake"] for b in settled)
                tot_pnl = sum(b["pnl"] for b in settled)
                clvs = [b["clv_pct"] for b in settled if b["clv_pct"] is not None]

                # Breakdown by league from bet_legs
                by_league: dict[str, dict[str, Any]] = {}
                for b in settled:
                    for lg in b["legs"]:
                        dv = lg["div"]
                        entry = by_league.setdefault(dv, {"div": dv, "league_name": LEAGUES.get(dv, {}).get("name", dv), "bets": 0, "wins": 0, "pnl": 0.0, "staked": 0.0})
                        entry["bets"] += 1
                        if b["status"] == "won":
                            entry["wins"] += 1
                        share = 1.0 / max(1, len(b["legs"]))
                        entry["pnl"] += b["pnl"] * share
                        entry["staked"] += b["stake"] * share

                for v in by_league.values():
                    v["pnl"] = round(v["pnl"], 2)
                    v["staked"] = round(v["staked"], 2)
                    v["roi_pct"] = round((v["pnl"] / v["staked"]) * 100.0, 1) if v["staked"] > 0 else 0.0

                # Cumulative P&L series (chronological)
                cum_series = []
                running = 0.0
                for b in reversed(settled):
                    running += b["pnl"]
                    cum_series.append({"label": b["placed_at"][:10], "pnl": round(running, 2)})

                # Current month staked check
                month_prefix = datetime.now(timezone.utc).strftime("%Y-%m")
                month_staked = sum(b["stake"] for b in bets_rows if b["placed_at"].startswith(month_prefix))

                return jsonify(
                    {
                        "user": user,
                        "bets": bets_rows,
                        "stats": {
                            "total_bets": len(bets_rows),
                            "settled_count": len(settled),
                            "pending_count": sum(1 for b in bets_rows if b["status"] == "pending"),
                            "win_rate_pct": round(100.0 * wins / len(settled), 1) if settled else 0.0,
                            "total_staked": round(tot_stake, 2),
                            "total_pnl": round(tot_pnl, 2),
                            "roi_pct": round((tot_pnl / tot_stake) * 100.0, 2) if tot_stake > 0 else 0.0,
                            "avg_clv_pct": round(sum(clvs) / len(clvs), 2) if clvs else 0.0,
                            "month_staked": round(month_staked, 2),
                        },
                        "by_league": list(by_league.values()),
                        "pnl_series": cum_series,
                    }
                )

        # POST /api/bets
        payload = request.get_json(silent=True) or {}
        legs = payload.get("legs") or []
        if not legs:
            return jsonify({"error": "At least one leg is required"}), 400
        try:
            stake = float(payload.get("stake", 10.0))
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid stake"}), 400
        if stake <= 0:
            return jsonify({"error": "Stake must be positive"}), 400

        with db_session() as conn:
            uid = payload.get("user_id")
            if uid:
                urow = conn.execute("SELECT * FROM users WHERE id = ?", (int(uid),)).fetchone()
                user = dict(urow) if urow else _get_active_user(conn)
            else:
                user = _get_active_user(conn)

            ev_summary = evaluate_acca(legs, stake=stake)
            bet_type = "acca" if len(legs) > 1 else "single"
            now = utc_now_iso()
            cur = conn.execute(
                """
                INSERT INTO bets (
                    user_id, bet_type, stake, combined_odds, combined_model_prob,
                    expected_value_pct, status, notes, placed_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                """,
                (
                    user["id"],
                    bet_type,
                    round(stake, 2),
                    ev_summary["combined_odds"],
                    ev_summary["combined_model_prob"],
                    ev_summary["expected_value_pct"],
                    (payload.get("notes") or "").strip(),
                    now,
                ),
            )
            bet_id = cur.lastrowid

            for leg in legs:
                fid = leg.get("fixture_id")
                div = leg.get("div", "E0")
                mdate = leg.get("match_date", now[:10])
                home = leg.get("home_team", "")
                away = leg.get("away_team", "")
                if fid and (not home or not away):
                    frow = conn.execute("SELECT * FROM upcoming_fixtures WHERE id = ?", (int(fid),)).fetchone()
                    if frow:
                        div = frow["div"]
                        mdate = frow["match_date"]
                        home = frow["home_team"]
                        away = frow["away_team"]
                p = float(leg.get("model_prob", 0.5))
                if p > 1.0:
                    p /= 100.0
                mkt = leg.get("market", "1X2_H")
                sel = leg.get("selection_label") or MARKET_LABELS.get(mkt, mkt)
                conn.execute(
                    """
                    INSERT INTO bet_legs (
                        bet_id, fixture_id, div, match_date, home_team, away_team,
                        market, selection_label, odds_taken, model_prob
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (bet_id, fid, div, mdate, home, away, mkt, sel, float(leg.get("odds", 2.0)), p),
                )

            settled_now = settle_bets(conn)
            return jsonify({"ok": True, "bet_id": bet_id, "auto_settled": settled_now}), 201

    @app.route("/api/bets/settle", methods=["POST"])
    def api_bets_settle() -> Response:
        with db_session() as conn:
            settled = settle_bets(conn)
            return jsonify({"settled": settled})

    @app.route("/api/leaderboard")
    def api_leaderboard() -> Response:
        with db_session() as conn:
            users = conn.execute(
                "SELECT * FROM users WHERE show_on_leaderboard = 1 ORDER BY id ASC"
            ).fetchall()
            board = []
            for u in users:
                bets = conn.execute(
                    "SELECT status, stake, pnl, clv_pct FROM bets WHERE user_id = ? AND status IN ('won', 'lost')",
                    (u["id"],),
                ).fetchall()
                cnt = len(bets)
                wins = sum(1 for b in bets if b["status"] == "won")
                staked = sum(b["stake"] for b in bets)
                pnl = sum(b["pnl"] for b in bets)
                clvs = [b["clv_pct"] for b in bets if b["clv_pct"] is not None]
                board.append(
                    {
                        "user_id": u["id"],
                        "display_name": u["display_name"],
                        "username": u["username"],
                        "avatar_color": u["avatar_color"],
                        "bets_settled": cnt,
                        "win_rate_pct": round(100.0 * wins / cnt, 1) if cnt else 0.0,
                        "total_staked": round(staked, 2),
                        "total_pnl": round(pnl, 2),
                        "roi_pct": round((pnl / staked) * 100.0, 2) if staked > 0 else 0.0,
                        "avg_clv_pct": round(sum(clvs) / len(clvs), 2) if clvs else 0.0,
                    }
                )
            board.sort(key=lambda x: (x["roi_pct"], x["total_pnl"]), reverse=True)
            return jsonify({"leaderboard": board, "invite_code_hint": "Ask admin for invite code"})

    @app.route("/api/auth/me")
    def api_auth_me() -> Response:
        with db_session() as conn:
            user = _get_active_user(conn)
            return jsonify(
                {
                    "authenticated": bool(session.get("user_id")),
                    "user": user,
                    "all_teams": _all_teams_by_league(conn),
                }
            )

    @app.route("/api/auth/register", methods=["POST"])
    def api_auth_register() -> tuple[Response, int] | Response:
        data = request.get_json(silent=True) or {}
        invite = (data.get("invite_code") or "").strip()
        if invite != ACCALAB_INVITE_CODE:
            return jsonify({"error": "Invalid group invite code"}), 403
        display_name = (data.get("display_name") or "").strip()
        raw_username = (data.get("username") or display_name).strip().lower()
        username = "".join(ch for ch in raw_username if ch.isalnum() or ch in ("_", "-"))
        password = str(data.get("password") or "")
        if not display_name or not username:
            return jsonify({"error": "Display name and username are required"}), 400
        if len(password) < 4:
            return jsonify({"error": "Password must be at least 4 characters"}), 400

        email = (data.get("email") or "").strip().lower()
        fav_teams = [t for t in (data.get("favourite_teams") or []) if isinstance(t, str)]
        pref_leagues = [l for l in (data.get("preferred_leagues") or ["E0", "E1", "E2", "E3"]) if l in LEAGUES]
        if not pref_leagues:
            pref_leagues = ["E0", "E1", "E2", "E3"]
        now = utc_now_iso()

        with db_session() as conn:
            if conn.execute("SELECT 1 FROM users WHERE LOWER(username) = ?", (username,)).fetchone():
                return jsonify({"error": f"Username '{username}' is already taken"}), 409
            cur = conn.execute(
                """
                INSERT INTO users (
                    username, display_name, email, password_hash, avatar_color,
                    bankroll, kelly_fraction, min_edge_pct, telegram_chat_id,
                    monthly_stake_limit, show_on_leaderboard,
                    favourite_teams_json, preferred_leagues_json, default_stake, active_slip_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)
                """,
                (
                    username,
                    display_name,
                    email,
                    generate_password_hash(password),
                    data.get("avatar_color") or "#8b5cf6",
                    float(data.get("bankroll", 200.0)),
                    float(data.get("kelly_fraction", 0.25)),
                    float(data.get("min_edge_pct", 4.0)),
                    (data.get("telegram_chat_id") or "").strip(),
                    float(data.get("monthly_stake_limit", 150.0)),
                    1 if data.get("show_on_leaderboard", True) else 0,
                    json.dumps(fav_teams),
                    json.dumps(pref_leagues),
                    float(data.get("default_stake", 10.0)),
                    now,
                ),
            )
            new_row = conn.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
            session.permanent = True
            session["user_id"] = int(cur.lastrowid)
            return jsonify({"ok": True, "user": _serialize_user(new_row)}), 201

    @app.route("/api/auth/login", methods=["POST"])
    def api_auth_login() -> tuple[Response, int] | Response:
        data = request.get_json(silent=True) or {}
        ident = (data.get("username") or "").strip().lower()
        password = str(data.get("password") or "")
        if not ident or not password:
            return jsonify({"error": "Username and password are required"}), 400

        with db_session() as conn:
            row = conn.execute(
                """
                SELECT * FROM users
                WHERE LOWER(username) = ? OR LOWER(email) = ? OR LOWER(display_name) = ?
                LIMIT 1
                """,
                (ident, ident, ident),
            ).fetchone()
            if not row or not row["password_hash"] or not check_password_hash(row["password_hash"], password):
                return jsonify({"error": "Invalid username or password"}), 401
            session.permanent = True
            session["user_id"] = int(row["id"])
            return jsonify({"ok": True, "user": _serialize_user(row)})

    @app.route("/api/auth/logout", methods=["POST"])
    def api_auth_logout() -> Response:
        session.pop("user_id", None)
        return jsonify({"ok": True})

    @app.route("/api/auth/password", methods=["POST"])
    def api_auth_password() -> tuple[Response, int] | Response:
        data = request.get_json(silent=True) or {}
        curr = str(data.get("current_password") or "")
        new_pw = str(data.get("new_password") or "")
        if len(new_pw) < 4:
            return jsonify({"error": "New password must be at least 4 characters"}), 400
        with db_session() as conn:
            user = _get_active_user(conn)
            row = conn.execute("SELECT password_hash FROM users WHERE id = ?", (user["id"],)).fetchone()
            if not row or not check_password_hash(row["password_hash"], curr):
                return jsonify({"error": "Current password is incorrect"}), 401
            conn.execute(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                (generate_password_hash(new_pw), user["id"]),
            )
        return jsonify({"ok": True})

    @app.route("/api/user/preferences", methods=["POST"])
    def api_user_preferences() -> Response:
        data = request.get_json(silent=True) or {}
        with db_session() as conn:
            uid = data.get("user_id")
            if uid and not session.get("user_id"):
                row = conn.execute("SELECT * FROM users WHERE id = ?", (int(uid),)).fetchone()
                user = _serialize_user(row) if row else _get_active_user(conn)
            else:
                user = _get_active_user(conn)

            fav_teams = list(user["favourite_teams"])
            if "favourite_teams" in data and isinstance(data["favourite_teams"], list):
                fav_teams = [str(t) for t in data["favourite_teams"] if str(t).strip()]
            elif data.get("toggle_team"):
                t_name = str(data["toggle_team"]).strip()
                if t_name in fav_teams:
                    fav_teams = [t for t in fav_teams if t != t_name]
                else:
                    fav_teams.append(t_name)

            pref_leagues = list(user["preferred_leagues"])
            if "preferred_leagues" in data and isinstance(data["preferred_leagues"], list):
                cleaned_l = [str(l) for l in data["preferred_leagues"] if l in LEAGUES]
                if cleaned_l:
                    pref_leagues = cleaned_l

            conn.execute(
                """
                UPDATE users SET
                    display_name = ?,
                    avatar_color = ?,
                    bankroll = ?,
                    kelly_fraction = ?,
                    min_edge_pct = ?,
                    monthly_stake_limit = ?,
                    telegram_chat_id = ?,
                    show_on_leaderboard = ?,
                    favourite_teams_json = ?,
                    preferred_leagues_json = ?,
                    default_stake = ?
                WHERE id = ?
                """,
                (
                    (data.get("display_name") or user["display_name"]).strip(),
                    data.get("avatar_color") or user["avatar_color"],
                    float(data.get("bankroll", user["bankroll"])),
                    float(data.get("kelly_fraction", user["kelly_fraction"])),
                    float(data.get("min_edge_pct", user["min_edge_pct"])),
                    float(data.get("monthly_stake_limit", user["monthly_stake_limit"])),
                    (data.get("telegram_chat_id", user["telegram_chat_id"]) or "").strip(),
                    1 if data.get("show_on_leaderboard", bool(user["show_on_leaderboard"])) else 0,
                    json.dumps(fav_teams),
                    json.dumps(pref_leagues),
                    float(data.get("default_stake", user["default_stake"])),
                    user["id"],
                ),
            )
            updated = conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
            return jsonify({"ok": True, "user": _serialize_user(updated)})

    @app.route("/api/user/watchlist")
    def api_user_watchlist() -> Response:
        with db_session() as conn:
            user = _get_active_user(conn)
            rows = [
                dict(r)
                for r in conn.execute(
                    """
                    SELECT sf.fixture_id, sf.note, sf.created_at,
                           f.div, f.match_date, f.kickoff_time, f.home_team, f.away_team,
                           f.b365h, f.b365d, f.b365a, f.odds_source
                    FROM saved_fixtures sf
                    JOIN upcoming_fixtures f ON f.id = sf.fixture_id
                    WHERE sf.user_id = ?
                    ORDER BY f.match_date ASC, f.kickoff_time ASC
                    """,
                    (user["id"],),
                ).fetchall()
            ]
            return jsonify({"watchlist": rows, "fixture_ids": [r["fixture_id"] for r in rows]})

    @app.route("/api/user/watchlist/toggle", methods=["POST"])
    def api_user_watchlist_toggle() -> tuple[Response, int] | Response:
        data = request.get_json(silent=True) or {}
        fid = data.get("fixture_id")
        if not fid or not str(fid).isdigit():
            return jsonify({"error": "Valid fixture_id is required"}), 400
        fid_int = int(fid)
        now = utc_now_iso()
        with db_session() as conn:
            user = _get_active_user(conn)
            exists = conn.execute(
                "SELECT id FROM saved_fixtures WHERE user_id = ? AND fixture_id = ?",
                (user["id"], fid_int),
            ).fetchone()
            if exists:
                conn.execute("DELETE FROM saved_fixtures WHERE id = ?", (exists["id"],))
                watched = False
            else:
                conn.execute(
                    "INSERT INTO saved_fixtures (user_id, fixture_id, note, created_at) VALUES (?, ?, ?, ?)",
                    (user["id"], fid_int, (data.get("note") or "").strip(), now),
                )
                watched = True
            ids = [
                r["fixture_id"]
                for r in conn.execute("SELECT fixture_id FROM saved_fixtures WHERE user_id = ?", (user["id"],)).fetchall()
            ]
            return jsonify({"ok": True, "watched": watched, "watched_fixture_ids": ids})

    @app.route("/api/user/slip", methods=["PUT"])
    def api_user_slip_save() -> Response:
        data = request.get_json(silent=True) or {}
        legs = data.get("legs")
        if not isinstance(legs, list):
            legs = []
        try:
            stake = max(1.0, float(data.get("stake", 10.0)))
        except (TypeError, ValueError):
            stake = 10.0
        with db_session() as conn:
            user = _get_active_user(conn)
            conn.execute(
                "UPDATE users SET active_slip_json = ?, default_stake = ? WHERE id = ?",
                (json.dumps(legs), stake, user["id"]),
            )
        return jsonify({"ok": True, "leg_count": len(legs), "default_stake": stake})

    @app.route("/api/user/saved-accas", methods=["GET", "POST"])
    def api_user_saved_accas() -> tuple[Response, int] | Response:
        with db_session() as conn:
            user = _get_active_user(conn)
            if request.method == "GET":
                rows = []
                for r in conn.execute(
                    "SELECT * FROM saved_accas WHERE user_id = ? ORDER BY created_at DESC, id DESC",
                    (user["id"],),
                ).fetchall():
                    d = dict(r)
                    d["legs"] = json.loads(d.pop("legs_json") or "[]")
                    rows.append(d)
                return jsonify({"saved_accas": rows})

            data = request.get_json(silent=True) or {}
            legs = data.get("legs") or []
            if not legs:
                return jsonify({"error": "Cannot save an empty accumulator"}), 400
            name = (data.get("name") or "").strip() or f"Draft Acca ({len(legs)} legs)"
            try:
                stake = max(1.0, float(data.get("stake", 10.0)))
            except (TypeError, ValueError):
                stake = 10.0
            ev = evaluate_acca(legs, stake=stake)
            now = utc_now_iso()
            cur = conn.execute(
                """
                INSERT INTO saved_accas (
                    user_id, name, stake, legs_json, combined_odds, combined_prob, ev_pct, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    user["id"],
                    name,
                    stake,
                    json.dumps(legs),
                    ev["combined_odds"],
                    ev["combined_model_prob"],
                    ev["expected_value_pct"],
                    now,
                ),
            )
            saved_row = dict(conn.execute("SELECT * FROM saved_accas WHERE id = ?", (cur.lastrowid,)).fetchone())
            saved_row["legs"] = json.loads(saved_row.pop("legs_json") or "[]")
            return jsonify({"ok": True, "saved_acca": saved_row}), 201

    @app.route("/api/user/saved-accas/<int:acca_id>", methods=["DELETE"])
    def api_user_saved_acca_delete(acca_id: int) -> tuple[Response, int] | Response:
        with db_session() as conn:
            user = _get_active_user(conn)
            cur = conn.execute(
                "DELETE FROM saved_accas WHERE id = ? AND user_id = ?",
                (acca_id, user["id"]),
            )
            if cur.rowcount == 0:
                return jsonify({"error": "Saved acca not found"}), 404
        return jsonify({"ok": True})

    @app.route("/api/users", methods=["POST"])
    def api_users_create() -> tuple[Response, int] | Response:
        data = request.get_json(silent=True) or {}
        invite = (data.get("invite_code") or "").strip()
        if invite != ACCALAB_INVITE_CODE:
            return jsonify({"error": "Invalid group invite code"}), 403
        display_name = (data.get("display_name") or "").strip()
        if not display_name:
            return jsonify({"error": "Display name is required"}), 400
        username = "".join(ch for ch in display_name.lower() if ch.isalnum()) or f"friend{int(datetime.now().timestamp())}"
        password = str(data.get("password") or "accalab")
        now = utc_now_iso()
        with db_session() as conn:
            exists = conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone()
            if exists:
                username = f"{username}_{int(datetime.now().timestamp()) % 1000}"
            cur = conn.execute(
                """
                INSERT INTO users (
                    username, display_name, password_hash, avatar_color, bankroll, kelly_fraction,
                    min_edge_pct, telegram_chat_id, monthly_stake_limit, show_on_leaderboard, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    username,
                    display_name,
                    generate_password_hash(password),
                    data.get("avatar_color") or "#8b5cf6",
                    float(data.get("bankroll", 200.0)),
                    float(data.get("kelly_fraction", 0.25)),
                    float(data.get("min_edge_pct", 4.0)),
                    (data.get("telegram_chat_id") or "").strip(),
                    float(data.get("monthly_stake_limit", 150.0)),
                    1 if data.get("show_on_leaderboard", True) else 0,
                    now,
                ),
            )
            new_user = _serialize_user(conn.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone())
            session.permanent = True
            session["user_id"] = int(new_user["id"])
        return jsonify({"ok": True, "user": new_user}), 201

    @app.route("/api/users/settings", methods=["POST"])
    def api_users_update_settings() -> Response:
        data = request.get_json(silent=True) or {}
        with db_session() as conn:
            uid = data.get("user_id")
            user = _serialize_user(conn.execute("SELECT * FROM users WHERE id = ?", (int(uid),)).fetchone()) if uid else _get_active_user(conn)
            conn.execute(
                """
                UPDATE users SET
                    bankroll = ?,
                    kelly_fraction = ?,
                    min_edge_pct = ?,
                    monthly_stake_limit = ?,
                    telegram_chat_id = ?,
                    show_on_leaderboard = ?
                WHERE id = ?
                """,
                (
                    float(data.get("bankroll", user["bankroll"])),
                    float(data.get("kelly_fraction", user["kelly_fraction"])),
                    float(data.get("min_edge_pct", user["min_edge_pct"])),
                    float(data.get("monthly_stake_limit", user["monthly_stake_limit"])),
                    (data.get("telegram_chat_id", user["telegram_chat_id"]) or "").strip(),
                    1 if data.get("show_on_leaderboard", bool(user["show_on_leaderboard"])) else 0,
                    user["id"],
                ),
            )
            updated = _serialize_user(conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone())
        return jsonify({"ok": True, "user": updated})

    @app.route("/api/backtest")
    def api_backtest() -> Response:
        with db_session() as conn:
            rows = []
            for r in conn.execute("SELECT * FROM backtest_results ORDER BY div ASC, market ASC").fetchall():
                d = dict(r)
                d["league_name"] = LEAGUES.get(d["div"], {}).get("name", d["div"])
                d["calibration"] = json.loads(d.pop("calibration_json") or "[]")
                rows.append(d)
            ratings = [
                dict(r)
                for r in conn.execute(
                    "SELECT team_name, div, elo, elo_change_last5, points, matches_played, form_last6 FROM team_ratings ORDER BY elo DESC LIMIT 40"
                ).fetchall()
            ]
            return jsonify({"results": rows, "top_elo_teams": ratings})

    @app.route("/api/news")
    def api_news() -> Response:
        team = (request.args.get("team") or "").strip().lower()
        with db_session() as conn:
            items = []
            for r in conn.execute("SELECT * FROM news_items ORDER BY published_at DESC LIMIT 60").fetchall():
                d = dict(r)
                d["matched_teams"] = json.loads(d.pop("matched_teams_json") or "[]")
                if team and not any(team in t.lower() for t in d["matched_teams"]) and team not in d["title"].lower():
                    continue
                items.append(d)
            return jsonify({"news": items})

    @app.route("/api/alerts")
    def api_alerts() -> Response:
        with db_session() as conn:
            rows = [dict(r) for r in conn.execute("SELECT * FROM alerts ORDER BY created_at DESC, id DESC LIMIT 40").fetchall()]
            return jsonify({"alerts": rows})

    @app.route("/api/alerts/mark-read", methods=["POST"])
    def api_alerts_mark_read() -> Response:
        with db_session() as conn:
            conn.execute("UPDATE alerts SET is_read = 1 WHERE is_read = 0")
        return jsonify({"ok": True})

    @app.route("/api/alerts/test-telegram", methods=["POST"])
    def api_test_telegram() -> tuple[Response, int] | Response:
        data = request.get_json(silent=True) or {}
        chat_id = (data.get("chat_id") or "").strip() or None
        ok, info = send_telegram_message(
            "<b>AccaLab Test Alert</b>\nYour Telegram alert channel is connected and ready for value bet &amp; line movement notifications.",
            chat_id=chat_id,
        )
        status = 200 if ok else 400
        return jsonify({"ok": ok, "message": info}), status

    @app.route("/api/sync", methods=["POST"])
    def api_sync() -> Response:
        data = request.get_json(silent=True) or {}
        run_bt = bool(data.get("run_backtest", False))
        force = bool(data.get("force", False))
        summary = run_full_sync(run_backtest=run_bt, force=force)
        with db_session() as conn:
            quota = get_api_quota_summary(conn)
        return jsonify({"ok": True, "summary": summary, "quota": quota})

    return app
