"""Value Bet Finder, Kelly Staking, Acca Correlation Engine, Bet Settlement, and Telegram Alerts."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

import httpx

from accalab.config import CURRENT_SEASON, LEAGUES, MARKET_LABELS, TELEGRAM_BOT_TOKEN, TELEGRAM_DEFAULT_CHAT_ID
from accalab.db import utc_now_iso


def devig_three_way(o1: float, o2: float, o3: float) -> tuple[float, float, float, float]:
    """Return fair implied probabilities (p1, p2, p3) and bookmaker overround %."""
    inv = [1.0 / o1, 1.0 / o2, 1.0 / o3]
    total = sum(inv)
    overround_pct = (total - 1.0) * 100.0
    return inv[0] / total, inv[1] / total, inv[2] / total, overround_pct


def devig_two_way(o1: float, o2: float) -> tuple[float, float, float]:
    """Return fair implied probabilities (p1, p2) and bookmaker overround %."""
    inv1, inv2 = 1.0 / o1, 1.0 / o2
    total = inv1 + inv2
    overround_pct = (total - 1.0) * 100.0
    return inv1 / total, inv2 / total, overround_pct


def kelly_stake_amount(
    model_prob: float,
    odds: float,
    bankroll: float,
    kelly_fraction: float = 0.25,
    max_pct: float = 0.05,
) -> tuple[float, float]:
    """Compute fractional Kelly stake % and GBP amount (capped at max_pct)."""
    if odds <= 1.01 or model_prob <= 0:
        return 0.0, 0.0
    edge = model_prob * odds - 1.0
    if edge <= 0:
        return 0.0, 0.0
    full_kelly = edge / (odds - 1.0)
    frac_pct = min(max_pct, max(0.0, kelly_fraction * full_kelly))
    return round(frac_pct * 100.0, 2), round(bankroll * frac_pct, 2)


def _market_tuples_for_fixture(row: dict[str, Any]) -> list[tuple[str, str, float, float | None, float | None]]:
    """Return list of (market_code, selection_label, model_prob, odds, fair_bookie_prob)."""
    items: list[tuple[str, str, float, float | None, float | None]] = []

    h_o, d_o, a_o = row.get("b365h"), row.get("b365d"), row.get("b365a")
    if h_o and d_o and a_o:
        fh, fd, fa, _ = devig_three_way(h_o, d_o, a_o)
    else:
        fh = fd = fa = None

    items.append(("1X2_H", f"{row['home_team']} Win", row["prob_home"], h_o, fh))
    items.append(("1X2_D", "Draw", row["prob_draw"], d_o, fd))
    items.append(("1X2_A", f"{row['away_team']} Win", row["prob_away"], a_o, fa))

    o25, u25 = row.get("b365_over25"), row.get("b365_under25")
    if o25 and u25:
        fo, fu, _ = devig_two_way(o25, u25)
    else:
        fo = fu = None
    items.append(("OU_O25", "Over 2.5 Goals", row["prob_over25"], o25, fo))
    items.append(("OU_U25", "Under 2.5 Goals", row["prob_under25"], u25, fu))

    by, bn = row.get("b365_btts_yes"), row.get("b365_btts_no")
    if by and bn:
        fby, fbn, _ = devig_two_way(by, bn)
    else:
        fby = fbn = None
    items.append(("BTTS_Y", "BTTS Yes", row["prob_btts_yes"], by, fby))
    items.append(("BTTS_N", "BTTS No", row["prob_btts_no"], bn, fbn))

    return items


def find_value_opportunities(
    conn: sqlite3.Connection,
    bankroll: float = 250.0,
    kelly_fraction: float = 0.25,
    min_edge_pct: float = 2.0,
    div_filter: str | None = None,
    market_filter: str | None = None,
    official_only: bool = False,
) -> list[dict[str, Any]]:
    """Rank upcoming selections with positive edge vs Bet365 / market odds."""
    sql = """
        SELECT f.*, p.prob_home, p.prob_draw, p.prob_away,
               p.prob_over25, p.prob_under25, p.prob_btts_yes, p.prob_btts_no,
               p.lambda_home, p.mu_away
        FROM upcoming_fixtures f
        JOIN predictions p ON p.fixture_id = f.id
        WHERE f.status = 'scheduled'
    """
    params: list[Any] = []
    if div_filter and div_filter in LEAGUES:
        sql += " AND f.div = ?"
        params.append(div_filter)
    if official_only:
        sql += " AND f.odds_source IN ('bet365_official', 'api_football_b365', 'user_manual')"

    rows = [dict(r) for r in conn.execute(sql, params).fetchall()]

    # Load backtest trust metrics per (div, market_group)
    bt_map: dict[tuple[str, str], dict[str, Any]] = {}
    for b in conn.execute("SELECT * FROM backtest_results").fetchall():
        bt_map[(b["div"], b["market"])] = dict(b)

    opportunities: list[dict[str, Any]] = []
    for row in rows:
        for m_code, sel_label, m_prob, odds, fair_b_prob in _market_tuples_for_fixture(row):
            if market_filter and m_code != market_filter:
                continue
            if official_only and row["odds_source"] == "bet365_official" and m_code.startswith("BTTS"):
                continue
            if not odds or odds <= 1.01:
                continue
            edge_pct = (m_prob * odds - 1.0) * 100.0
            if edge_pct < min_edge_pct:
                continue

            kelly_pct, stake_gbp = kelly_stake_amount(m_prob, odds, bankroll, kelly_fraction)
            bt_key = (row["div"], "1X2" if m_code.startswith("1X2") else "O/U 2.5")
            bt = bt_map.get(bt_key)
            backtest_roi = bt["flat_roi_pct"] if bt else None
            trust_badge = (
                "Backtest Proven"
                if (bt and bt["flat_roi_pct"] > 0 and bt["value_bets_count"] >= 10)
                else ("Positive CLV" if (bt and bt["avg_clv_pct"] > 0) else "Model Edge")
            )

            opportunities.append(
                {
                    "fixture_id": row["id"],
                    "div": row["div"],
                    "league_name": LEAGUES.get(row["div"], {}).get("name", row["div"]),
                    "match_date": row["match_date"],
                    "kickoff_time": row["kickoff_time"],
                    "home_team": row["home_team"],
                    "away_team": row["away_team"],
                    "market": m_code,
                    "market_label": MARKET_LABELS.get(m_code, m_code),
                    "selection_label": sel_label,
                    "odds": round(odds, 2),
                    "fair_odds": round(1.0 / max(m_prob, 0.01), 2),
                    "model_prob_pct": round(m_prob * 100.0, 1),
                    "implied_prob_pct": round((fair_b_prob if fair_b_prob else 1.0 / odds) * 100.0, 1),
                    "edge_pct": round(edge_pct, 2),
                    "kelly_pct": kelly_pct,
                    "suggested_stake": stake_gbp,
                    "odds_source": row["odds_source"],
                    "trust_badge": trust_badge,
                    "backtest_roi_pct": backtest_roi,
                }
            )

    opportunities.sort(key=lambda x: x["edge_pct"], reverse=True)
    return opportunities


def evaluate_acca(legs: list[dict[str, Any]], stake: float = 10.0) -> dict[str, Any]:
    """Compute combined Acca odds, probability, compounded margin, EV, and correlation warnings."""
    if not legs:
        return {
            "legs": [],
            "combined_odds": 1.0,
            "combined_model_prob": 1.0,
            "fair_combined_odds": 1.0,
            "expected_value_pct": 0.0,
            "potential_return": 0.0,
            "expected_profit": 0.0,
            "compounded_margin_pct": 0.0,
            "warnings": [],
        }

    comb_odds = 1.0
    comb_prob = 1.0
    by_fixture: dict[Any, list[str]] = {}
    warnings: list[str] = []

    for leg in legs:
        o = float(leg.get("odds", 1.0))
        p = float(leg.get("model_prob", 0.5))
        if p > 1.0:
            p = p / 100.0
        comb_odds *= o
        comb_prob *= p
        fid = leg.get("fixture_id")
        if fid is not None:
            by_fixture.setdefault(fid, []).append(leg.get("market", ""))

    # Correlation checks
    for fid, mkts in by_fixture.items():
        if len(mkts) > 1:
            warnings.append(
                f"Same-match correlation detected on fixture #{fid} ({', '.join(mkts)}): independent multiplication overstates joint probability."
            )

    # Check if two separate fixtures have opposite high-variance risk
    if len(legs) >= 5:
        warnings.append(
            f"{len(legs)}-fold accumulator compounds bookmaker margin (~{((1.052**len(legs))-1)*100:.1f}% house edge). Consider 2–4 legs for steadier ROI."
        )

    ev_pct = (comb_prob * comb_odds - 1.0) * 100.0
    implied_prod = 1.0 / max(comb_odds, 1.01)
    # Approximate compounded overround assuming ~5.2% per leg if fair odds unavailable
    compounded_margin_pct = ((1.052 ** len(legs)) - 1.0) * 100.0

    return {
        "legs": legs,
        "leg_count": len(legs),
        "combined_odds": round(comb_odds, 2),
        "combined_model_prob": round(comb_prob, 5),
        "combined_model_prob_pct": round(comb_prob * 100.0, 2),
        "fair_combined_odds": round(1.0 / max(comb_prob, 0.0001), 2),
        "expected_value_pct": round(ev_pct, 2),
        "potential_return": round(stake * comb_odds, 2),
        "expected_profit": round(stake * (comb_prob * comb_odds - 1.0), 2),
        "compounded_margin_pct": round(compounded_margin_pct, 1),
        "implied_prob_pct": round(implied_prod * 100.0, 2),
        "warnings": warnings,
    }


def build_acca_presets(conn: sqlite3.Connection, bankroll: float = 250.0) -> list[dict[str, Any]]:
    """Build 3 smart uncorrelated accumulator presets across English leagues."""
    all_rows = [
        dict(r)
        for r in conn.execute(
            """
            SELECT f.*, p.prob_home, p.prob_draw, p.prob_away,
                   p.prob_over25, p.prob_under25, p.prob_btts_yes, p.prob_btts_no
            FROM upcoming_fixtures f
            JOIN predictions p ON p.fixture_id = f.id
            WHERE f.status = 'scheduled'
            ORDER BY f.match_date ASC
            """
        ).fetchall()
    ]

    candidates: list[dict[str, Any]] = []
    for r in all_rows:
        for m_code, sel_label, m_prob, odds, _ in _market_tuples_for_fixture(r):
            if not odds or odds <= 1.05:
                continue
            edge_pct = (m_prob * odds - 1.0) * 100.0
            candidates.append(
                {
                    "fixture_id": r["id"],
                    "div": r["div"],
                    "league_name": LEAGUES[r["div"]]["name"],
                    "match_date": r["match_date"],
                    "home_team": r["home_team"],
                    "away_team": r["away_team"],
                    "market": m_code,
                    "selection_label": sel_label,
                    "odds": round(odds, 2),
                    "model_prob": round(m_prob, 5),
                    "edge_pct": round(edge_pct, 2),
                    "odds_source": r["odds_source"],
                }
            )

    def _pick_unique(items: list[dict[str, Any]], count: int) -> list[dict[str, Any]]:
        picked: list[dict[str, Any]] = []
        seen_fids: set[int] = set()
        for it in items:
            if it["fixture_id"] in seen_fids:
                continue
            seen_fids.add(it["fixture_id"])
            picked.append(it)
            if len(picked) == count:
                break
        return picked

    presets: list[dict[str, Any]] = []

    # 1. Value Treble
    value_sorted = sorted([c for c in candidates if c["edge_pct"] >= 2.0 and c["odds"] <= 4.5], key=lambda x: x["edge_pct"], reverse=True)
    if not value_sorted:
        value_sorted = sorted(candidates, key=lambda x: x["edge_pct"], reverse=True)
    treble_legs = _pick_unique(value_sorted, 3)
    if treble_legs:
        ev = evaluate_acca(treble_legs, stake=round(min(15.0, bankroll * 0.04), 2))
        presets.append(
            {
                "id": "value_treble",
                "title": "Value Edge Treble",
                "subtitle": "Top 3 uncorrelated positive-EV legs across EPL–L2",
                **ev,
            }
        )

    # 2. High-Probability 4-Fold
    banker_sorted = sorted(
        [c for c in candidates if c["model_prob"] >= 0.56 and c["edge_pct"] >= -2.5],
        key=lambda x: (x["edge_pct"] + x["model_prob"] * 20.0),
        reverse=True,
    )
    if len(banker_sorted) < 4:
        banker_sorted = sorted(candidates, key=lambda x: x["model_prob"], reverse=True)
    four_legs = _pick_unique(banker_sorted, 4)
    if four_legs:
        ev = evaluate_acca(four_legs, stake=round(min(20.0, bankroll * 0.05), 2))
        presets.append(
            {
                "id": "banker_4fold",
                "title": "Weekend Strong-Prob 4-Fold",
                "subtitle": "High-probability favourites with minimal overround drag",
                **ev,
            }
        )

    # 3. Goals & BTTS Treble
    goals_sorted = sorted(
        [c for c in candidates if c["market"] in ("OU_O25", "BTTS_Y")],
        key=lambda x: x["edge_pct"],
        reverse=True,
    )
    goals_legs = _pick_unique(goals_sorted, 3)
    if goals_legs:
        ev = evaluate_acca(goals_legs, stake=10.0)
        presets.append(
            {
                "id": "goals_treble",
                "title": "Goals & BTTS Action Treble",
                "subtitle": "Top Over 2.5 & Both Teams To Score model selections",
                **ev,
            }
        )

    return presets


def _leg_won(market: str, fthg: int, ftag: int) -> bool:
    if market == "1X2_H":
        return fthg > ftag
    if market == "1X2_D":
        return fthg == ftag
    if market == "1X2_A":
        return ftag > fthg
    if market == "OU_O25":
        return (fthg + ftag) >= 3
    if market == "OU_U25":
        return (fthg + ftag) <= 2
    if market == "BTTS_Y":
        return fthg >= 1 and ftag >= 1
    if market == "BTTS_N":
        return fthg == 0 or ftag == 0
    return False


def _closing_odds_for_market(market: str, match_row: dict[str, Any]) -> float | None:
    mapping = {
        "1X2_H": match_row.get("b365ch") or match_row.get("b365h"),
        "1X2_D": match_row.get("b365cd") or match_row.get("b365d"),
        "1X2_A": match_row.get("b365ca") or match_row.get("b365a"),
        "OU_O25": match_row.get("b365c_over25") or match_row.get("b365_over25"),
        "OU_U25": match_row.get("b365c_under25") or match_row.get("b365_under25"),
    }
    return mapping.get(market)


def settle_bets(conn: sqlite3.Connection) -> int:
    """Auto-settle pending bets against historical_matches and calculate P&L + Closing Line Value (CLV)."""
    now = utc_now_iso()
    pending_bets = conn.execute("SELECT * FROM bets WHERE status = 'pending'").fetchall()
    settled_count = 0

    for bet in pending_bets:
        legs = conn.execute("SELECT * FROM bet_legs WHERE bet_id = ?", (bet["id"],)).fetchall()
        if not legs:
            continue

        all_resolved = True
        any_lost = False
        clv_terms: list[float] = []

        for leg in legs:
            if leg["leg_status"] in ("won", "lost", "void"):
                if leg["leg_status"] == "lost":
                    any_lost = True
                if leg["closing_odds"] and leg["closing_odds"] > 1.0:
                    clv_terms.append((leg["odds_taken"] / leg["closing_odds"] - 1.0) * 100.0)
                continue

            hist = conn.execute(
                """
                SELECT * FROM historical_matches
                WHERE div = ? AND match_date = ? AND home_team = ? AND away_team = ?
                """,
                (leg["div"], leg["match_date"], leg["home_team"], leg["away_team"]),
            ).fetchone()
            if not hist:
                all_resolved = False
                continue

            h_dict = dict(hist)
            won = _leg_won(leg["market"], int(h_dict["fthg"]), int(h_dict["ftag"]))
            c_odds = _closing_odds_for_market(leg["market"], h_dict) or leg["closing_odds"]
            new_leg_status = "won" if won else "lost"
            if not won:
                any_lost = True
            if c_odds and c_odds > 1.0:
                clv_terms.append((leg["odds_taken"] / c_odds - 1.0) * 100.0)

            conn.execute(
                "UPDATE bet_legs SET leg_status = ?, closing_odds = ? WHERE id = ?",
                (new_leg_status, c_odds, leg["id"]),
            )

        if all_resolved:
            final_status = "lost" if any_lost else "won"
            pnl = round(bet["stake"] * (bet["combined_odds"] - 1.0), 2) if final_status == "won" else round(-bet["stake"], 2)
            avg_clv = round(sum(clv_terms) / len(clv_terms), 2) if clv_terms else None
            conn.execute(
                """
                UPDATE bets SET status = ?, pnl = ?, clv_pct = ?, settled_at = ?
                WHERE id = ?
                """,
                (final_status, pnl, avg_clv, now, bet["id"]),
            )
            settled_count += 1

    return settled_count


def seed_demo_historical_bets(conn: sqlite3.Connection) -> None:
    """Seed realistic settled bets from actual 2026/27 played matches so P&L & CLV charts work immediately."""
    existing_bets = conn.execute("SELECT COUNT(*) AS cnt FROM bets").fetchone()["cnt"]
    if existing_bets > 0:
        return

    users = {r["username"]: r["id"] for r in conn.execute("SELECT id, username FROM users").fetchall()}
    if not users:
        return

    sample_matches = [
        dict(r)
        for r in conn.execute(
            """
            SELECT * FROM historical_matches
            WHERE season = ? AND b365h IS NOT NULL AND b365ch IS NOT NULL AND b365_over25 IS NOT NULL
            ORDER BY match_date DESC
            LIMIT 24
            """,
            (CURRENT_SEASON,),
        ).fetchall()
    ]
    if len(sample_matches) < 8:
        return

    admin_id = users.get("admin") or next(iter(users.values()))
    dave_id = users.get("dave") or admin_id
    callum_id = users.get("callum") or admin_id

    specs = [
        (admin_id, sample_matches[0], "1X2_H", f"{sample_matches[0]['home_team']} Win", sample_matches[0]["b365h"], 0.54, 15.0, "Model home value"),
        (admin_id, sample_matches[1], "OU_O25", "Over 2.5 Goals", sample_matches[1]["b365_over25"], 0.56, 12.0, "High xG pace"),
        (admin_id, sample_matches[2], "1X2_A", f"{sample_matches[2]['away_team']} Win", sample_matches[2]["b365a"], 0.41, 10.0, "Away Elo edge"),
        (admin_id, sample_matches[3], "OU_U25", "Under 2.5 Goals", sample_matches[3]["b365_under25"], 0.55, 14.0, "Low-scoring matchup"),
        (dave_id, sample_matches[4], "1X2_H", f"{sample_matches[4]['home_team']} Win", sample_matches[4]["b365h"], 0.58, 20.0, "Weekend single"),
        (dave_id, sample_matches[5], "OU_O25", "Over 2.5 Goals", sample_matches[5]["b365_over25"], 0.53, 15.0, "Goals angle"),
        (callum_id, sample_matches[6], "1X2_D", "Draw", sample_matches[6]["b365d"], 0.31, 10.0, "Tight mid-table clash"),
        (callum_id, sample_matches[7], "1X2_H", f"{sample_matches[7]['home_team']} Win", sample_matches[7]["b365h"], 0.61, 25.0, "Home banker"),
    ]

    for uid, m, mkt, sel, odds, m_prob, stake, note in specs:
        if not odds:
            continue
        ev_pct = round((m_prob * odds - 1.0) * 100.0, 2)
        cur = conn.execute(
            """
            INSERT INTO bets (user_id, bet_type, stake, combined_odds, combined_model_prob, expected_value_pct, status, notes, placed_at)
            VALUES (?, 'single', ?, ?, ?, ?, 'pending', ?, ?)
            """,
            (uid, stake, round(odds, 2), m_prob, ev_pct, note, f"{m['match_date']}T12:00:00Z"),
        )
        bet_id = cur.lastrowid
        conn.execute(
            """
            INSERT INTO bet_legs (bet_id, fixture_id, div, match_date, home_team, away_team, market, selection_label, odds_taken, model_prob)
            VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (bet_id, m["div"], m["match_date"], m["home_team"], m["away_team"], mkt, sel, round(odds, 2), m_prob),
        )

    settle_bets(conn)


def send_telegram_message(text: str, chat_id: str | None = None) -> tuple[bool, str]:
    """Send a Telegram alert if bot token and chat ID are configured."""
    token = TELEGRAM_BOT_TOKEN
    target = (chat_id or TELEGRAM_DEFAULT_CHAT_ID or "").strip()
    if not token or not target:
        return False, "TELEGRAM_BOT_TOKEN or chat ID not configured"
    try:
        resp = httpx.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": target, "text": text, "parse_mode": "HTML"},
            timeout=10.0,
        )
        if resp.status_code == 200:
            return True, "Sent to Telegram"
        return False, f"Telegram API HTTP {resp.status_code}: {resp.text[:160]}"
    except Exception as exc:
        return False, str(exc)


def generate_value_alerts(conn: sqlite3.Connection) -> int:
    """Create in-app alerts (and optional Telegram pushes) for top high-edge official/scheduled picks."""
    now = utc_now_iso()
    opps = find_value_opportunities(conn, bankroll=250.0, kelly_fraction=0.25, min_edge_pct=6.0)
    created = 0
    for opp in opps[:5]:
        title = f"Value Alert ({opp['edge_pct']:+.1f}% EV): {opp['selection_label']}"
        exists = conn.execute(
            "SELECT 1 FROM alerts WHERE fixture_id = ? AND title = ?",
            (opp["fixture_id"], title),
        ).fetchone()
        if exists:
            continue
        msg = (
            f"{opp['home_team']} vs {opp['away_team']} ({opp['league_name']}, {opp['match_date']}) — "
            f"{opp['selection_label']} @ {opp['odds']:.2f} vs Model {opp['model_prob_pct']:.1f}% "
            f"(Fair {opp['fair_odds']:.2f}). Suggested ¼ Kelly: £{opp['suggested_stake']:.2f}."
        )
        sent_tg = 0
        if TELEGRAM_BOT_TOKEN and TELEGRAM_DEFAULT_CHAT_ID:
            ok, _ = send_telegram_message(f"<b>{title}</b>\n{msg}")
            if ok:
                sent_tg = 1
        conn.execute(
            """
            INSERT INTO alerts (user_id, alert_type, title, message, fixture_id, is_read, sent_telegram, created_at)
            VALUES (NULL, 'value_bet', ?, ?, ?, 0, ?, ?)
            """,
            (title, msg, opp["fixture_id"], sent_tg, now),
        )
        created += 1
    return created
