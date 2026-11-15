"""Value Bet Finder, Kelly Staking, Acca Correlation Engine, Bet Settlement, and Telegram Alerts."""

from __future__ import annotations

import base64
import json
import sqlite3
import urllib.parse
from datetime import datetime, timezone
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
        sql += " AND f.odds_source IN ('bet365_official', 'api_football_b365', 'live_sportsbook', 'user_manual')"

    rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    upcoming = [r for r in rows if is_fixture_upcoming(r)]
    if upcoming:
        rows = upcoming

    # Load backtest trust metrics per (div, market_group)
    bt_map: dict[tuple[str, str], dict[str, Any]] = {}
    for b in conn.execute("SELECT * FROM backtest_results").fetchall():
        bt_map[(b["div"], b["market"])] = dict(b)

    opportunities: list[dict[str, Any]] = []
    for row in rows:
        for m_code, sel_label, m_prob, odds, fair_b_prob in _market_tuples_for_fixture(row):
            if market_filter and m_code != market_filter:
                continue
            if official_only and row["odds_source"] in ("bet365_official", "live_sportsbook") and m_code.startswith("BTTS"):
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
            ORDER BY f.match_date ASC, f.kickoff_time ASC
            """
        ).fetchall()
    ]
    upcoming_all = [r for r in all_rows if is_fixture_upcoming(r)]
    if upcoming_all:
        all_rows = upcoming_all

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
    """No-op: production mode never seeds synthetic demo bets."""
    return


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


_UK_FRACTIONAL_TABLE: tuple[tuple[int, int], ...] = (
    (1, 10), (1, 9), (1, 8), (1, 7), (1, 6), (1, 5), (2, 9), (1, 4), (2, 7), (3, 10),
    (1, 3), (4, 11), (2, 5), (4, 9), (1, 2), (8, 15), (4, 7), (8, 13), (4, 6), (8, 11),
    (4, 5), (5, 6), (10, 11), (1, 1), (11, 10), (6, 5), (5, 4), (13, 10), (11, 8),
    (7, 5), (6, 4), (8, 5), (13, 8), (7, 4), (9, 5), (15, 8), (2, 1), (9, 4), (5, 2),
    (11, 4), (3, 1), (10, 3), (7, 2), (4, 1), (9, 2), (5, 1), (11, 2), (6, 1), (13, 2),
    (7, 1), (15, 2), (8, 1), (9, 1), (10, 1),
)


def decimal_to_fractional(odds: float | None) -> str:
    """Convert decimal odds (e.g. 2.0, 2.5, 3.5) to UK bookmaker fractional format (e.g. '1/1', '6/4', '5/2')."""
    if odds is None:
        return "—"
    try:
        dec = float(odds)
    except (TypeError, ValueError):
        return "—"
    if dec <= 1.01:
        return "—"
    if dec > 11.0:
        return f"{max(10, int(round(dec - 1.0)))}/1"
    best_num, best_den = min(
        _UK_FRACTIONAL_TABLE,
        key=lambda frac: abs((1.0 + frac[0] / frac[1]) - dec),
    )
    return f"{best_num}/{best_den}"


def parse_odds_value(val: Any, default: float | None = None) -> float | None:
    """Parse UK fractional ('5/2', '1/1', 'evens') or decimal odds ('3.50') into a decimal float."""
    if val in (None, ""):
        return default
    if isinstance(val, (int, float)):
        f = float(val)
        return round(f, 4) if f > 1.01 else default
    s = str(val).strip().lower()
    if s in ("evs", "evens", "evn"):
        return 2.0
    if "/" in s:
        parts = s.split("/", 1)
        try:
            num = float(parts[0].strip())
            den = float(parts[1].strip())
            if num > 0 and den > 0:
                dec = 1.0 + (num / den)
                return round(dec, 4) if dec > 1.01 else default
        except (TypeError, ValueError):
            return default
    try:
        f = float(s)
        return round(f, 4) if f > 1.01 else default
    except (TypeError, ValueError):
        return default


_B365_TEAM_SEARCH_NAMES: dict[str, str] = {
    "Nott'm Forest": "Nottingham Forest",
    "Sheffield Weds": "Sheffield Wednesday",
    "Peterboro": "Peterborough",
    "Bristol Rvs": "Bristol Rovers",
    "Milton Keynes Dons": "MK Dons",
    "West Brom": "West Bromwich Albion",
    "Sheffield United": "Sheff Utd",
}


def _b365_search_team(name: str) -> str:
    cleaned = str(name or "").strip()
    return _B365_TEAM_SEARCH_NAMES.get(cleaned, cleaned)


def is_fixture_upcoming(row: dict[str, Any], now_dt: datetime | None = None) -> bool:
    """Return True if the fixture has not yet kicked off (UTC match_date + kickoff_time)."""
    current = now_dt or datetime.now(timezone.utc)
    today_iso = current.strftime("%Y-%m-%d")
    now_hhmm = current.strftime("%H:%M")
    mdate = str(row.get("match_date") or "").strip()
    if not mdate:
        return True
    if mdate > today_iso:
        return True
    if mdate < today_iso:
        return False
    ko = str(row.get("kickoff_time") or "").strip()
    if not ko:
        return True
    return ko > now_hhmm


_BET365_MARKET_NAMES: dict[str, str] = {
    "1X2_H": "Full Time Result",
    "1X2_D": "Full Time Result",
    "1X2_A": "Full Time Result",
    "OU_O25": "Goals Over/Under",
    "OU_U25": "Goals Over/Under",
    "BTTS_Y": "Both Teams to Score",
    "BTTS_N": "Both Teams to Score",
}


def _bet365_selection_name(leg: dict[str, Any]) -> str:
    mkt = str(leg.get("market") or "")
    if mkt == "1X2_H":
        return str(leg.get("home_team") or leg.get("selection_label") or "Home")
    if mkt == "1X2_D":
        return "Draw"
    if mkt == "1X2_A":
        return str(leg.get("away_team") or leg.get("selection_label") or "Away")
    if mkt == "OU_O25":
        return "Over 2.5"
    if mkt == "OU_U25":
        return "Under 2.5"
    if mkt == "BTTS_Y":
        return "Yes"
    if mkt == "BTTS_N":
        return "No"
    return str(leg.get("selection_label") or mkt)


def build_bet365_export(
    legs: list[dict[str, Any]],
    stake: float = 10.0,
    title: str = "AccaLab Suggested Bet",
    options_override: str = "",
) -> dict[str, Any]:
    """Generate Bet365 handoff payload, Home-v-Away search links, Companion token, and slip text."""
    try:
        clean_stake = max(0.5, float(stake or 10.0))
    except (TypeError, ValueError):
        clean_stake = 10.0

    eval_summary = evaluate_acca(legs, stake=clean_stake)
    comb_frac = decimal_to_fractional(eval_summary.get("combined_odds"))
    eval_summary["combined_odds_fractional"] = comb_frac
    exported_legs: list[dict[str, Any]] = []
    leg_option_tokens: list[str] = []
    compact_legs: list[dict[str, str]] = []

    for leg in legs:
        div = str(leg.get("div") or "")
        league_name = LEAGUES.get(div, {}).get("name", div or "English Football")
        home = str(leg.get("home_team") or "").strip()
        away = str(leg.get("away_team") or "").strip()
        b365_home = _b365_search_team(home)
        b365_away = _b365_search_team(away)
        mkt = str(leg.get("market") or "1X2_H")
        b365_market = _BET365_MARKET_NAMES.get(mkt, "Full Time Result")
        b365_selection = _bet365_selection_name(leg)
        odds_val = round(float(leg.get("odds") or 1.0), 2)
        odds_frac = decimal_to_fractional(odds_val)
        search_term = f"{b365_home} v {b365_away}" if (b365_home and b365_away) else (b365_home or b365_away or "Football")
        search_hash = f"#/AX/K^{urllib.parse.quote(search_term)}"

        opt_tok = str(leg.get("b365_options_id") or "").strip()
        if opt_tok:
            leg_option_tokens.append(opt_tok)

        compact_legs.append(
            {
                "h": b365_home,
                "a": b365_away,
                "k": search_term,
                "l": str(leg.get("selection_label") or b365_selection),
                "m": b365_market,
                "s": b365_selection,
                "o": odds_frac,
                "lg": league_name,
            }
        )

        exported_legs.append(
            {
                "fixture_id": leg.get("fixture_id"),
                "div": div,
                "league_name": league_name,
                "match_date": leg.get("match_date", ""),
                "kickoff_time": leg.get("kickoff_time", ""),
                "home_team": home,
                "away_team": away,
                "market": mkt,
                "selection_label": leg.get("selection_label") or b365_selection,
                "odds": odds_val,
                "odds_fractional": odds_frac,
                "b365_market_name": b365_market,
                "b365_selection_name": b365_selection,
                "b365_search_query": search_term,
                "b365_search_hash": search_hash,
                "b365_path": f"Soccer → United Kingdom → {league_name} → {home} v {away} → {b365_market}",
                "b365_search_url": f"https://www.bet365.com/{search_hash}",
            }
        )

    slip_payload = {
        "t": title,
        "st": round(clean_stake, 2),
        "od": comb_frac,
        "legs": compact_legs,
    }
    slip_raw = json.dumps(slip_payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    slip_token = base64.urlsafe_b64encode(slip_raw).decode("ascii").rstrip("=")
    for item in exported_legs:
        item["b365_search_url"] = f"https://www.bet365.com/?accalab_slip={slip_token}{item['b365_search_hash']}"

    bet_type = "combo" if len(legs) > 1 else "single"
    override_clean = (options_override or "").strip()
    resolved_options = override_clean or (
        ",".join(leg_option_tokens) if len(leg_option_tokens) == len(legs) and leg_option_tokens else ""
    )

    prefill_template_url = (
        f"https://www.bet365.com/en/sports?options={{eventId}}-{{marketId}}-{{selectionId}}"
        f"&type={bet_type}&stake={clean_stake:.2f}&currency=GBP"
    )
    if resolved_options:
        deep_link_url = (
            f"https://www.bet365.com/en/sports?options={urllib.parse.quote(resolved_options, safe='-,~')}"
            f"&type={bet_type}&stake={clean_stake:.2f}&currency=GBP"
        )
        launch_url = deep_link_url
        mode = "direct_prefill"
    else:
        deep_link_url = None
        launch_url = exported_legs[0]["b365_search_url"] if exported_legs else f"https://www.bet365.com/?accalab_slip={slip_token}#/HO/"
        mode = "express_handoff"

    lines = [
        f"{title} ({'Acca ' + str(len(legs)) + '-Fold' if len(legs) > 1 else 'Single'})",
        f"Stake: £{clean_stake:.2f} | Combined Odds: {comb_frac} | Potential Return: £{eval_summary['potential_return']:.2f}",
        f"Model Hit Prob: {eval_summary['combined_model_prob_pct']}% | Expected Value: {eval_summary['expected_value_pct']:+.1f}%",
        "",
    ]
    for idx, item in enumerate(exported_legs, start=1):
        lines.append(
            f"{idx}. {item['home_team']} v {item['away_team']} ({item['league_name']}) — {item['b365_market_name']}: {item['selection_label']} @ {item['odds_fractional']}"
        )

    return {
        "title": title,
        "mode": mode,
        "bet_type": bet_type,
        "stake": round(clean_stake, 2),
        "slip_token": slip_token,
        "launch_url": launch_url,
        "deep_link_url": deep_link_url,
        "prefill_template_url": prefill_template_url,
        "clipboard_text": "\n".join(lines),
        "eval": eval_summary,
        "legs": exported_legs,
    }


def _pick_distinct_fixtures(items: list[dict[str, Any]], count: int) -> list[dict[str, Any]]:
    picked: list[dict[str, Any]] = []
    seen_fids: set[int] = set()
    for it in items:
        fid = int(it["fixture_id"])
        if fid in seen_fids:
            continue
        seen_fids.add(fid)
        picked.append(it)
        if len(picked) == count:
            break
    return picked


def build_bet_suggestions(conn: sqlite3.Connection, user: dict[str, Any]) -> dict[str, Any]:
    """Synthesize stats, Dixon-Coles/Elo, backtest ROI, Bet365 prices & news into 4 ready-to-bet suggestions."""
    bankroll = float(user.get("bankroll") or 250.0)
    kelly_frac = float(user.get("kelly_fraction") or 0.25)
    default_stake = float(user.get("default_stake") or 10.0)
    fav_teams = set(user.get("favourite_teams") or [])
    pref_leagues = set(user.get("preferred_leagues") or LEAGUES.keys())

    rows = [
        dict(r)
        for r in conn.execute(
            """
            SELECT f.*, p.prob_home, p.prob_draw, p.prob_away,
                   p.prob_over25, p.prob_under25, p.prob_btts_yes, p.prob_btts_no,
                   p.lambda_home, p.mu_away,
                   hr.elo AS home_elo, hr.form_last6 AS home_form,
                   hr.sot_for_pg AS h_sot_for, hr.sot_against_pg AS h_sot_ag,
                   ar.elo AS away_elo, ar.form_last6 AS away_form,
                   ar.sot_for_pg AS a_sot_for, ar.sot_against_pg AS a_sot_ag
            FROM upcoming_fixtures f
            JOIN predictions p ON p.fixture_id = f.id
            LEFT JOIN team_ratings hr ON hr.team_name = f.home_team
            LEFT JOIN team_ratings ar ON ar.team_name = f.away_team
            WHERE f.status = 'scheduled'
            ORDER BY f.match_date ASC, f.kickoff_time ASC
            """
        ).fetchall()
    ]

    rows = [r for r in rows if is_fixture_upcoming(r)] or rows
    if not rows:
        return {"risk_levels": [], "by_risk": {}, "suggestions": [], "by_id": {}, "top_single": None}

    bt_map: dict[tuple[str, str], dict[str, Any]] = {
        (b["div"], b["market"]): dict(b)
        for b in conn.execute("SELECT * FROM backtest_results").fetchall()
    }
    news_by_team: dict[str, list[dict[str, Any]]] = {}
    for nr in conn.execute("SELECT title, source, url, matched_teams_json FROM news_items ORDER BY published_at DESC LIMIT 80").fetchall():
        nd = dict(nr)
        for team in json.loads(nd.get("matched_teams_json") or "[]"):
            news_by_team.setdefault(team, []).append(nd)

    candidates: list[dict[str, Any]] = []
    for r in rows:
        h_elo = float(r.get("home_elo") or 1500.0)
        a_elo = float(r.get("away_elo") or 1500.0)
        h_sot_for = float(r.get("h_sot_for") or 0.0)
        h_sot_ag = float(r.get("h_sot_ag") or 0.0)
        a_sot_for = float(r.get("a_sot_for") or 0.0)
        a_sot_ag = float(r.get("a_sot_ag") or 0.0)
        h_form = r.get("home_form") or "N/A"
        a_form = r.get("away_form") or "N/A"
        is_official = r["odds_source"] in ("bet365_official", "api_football_b365", "live_sportsbook", "user_manual")
        matched_news = (news_by_team.get(r["home_team"], []) + news_by_team.get(r["away_team"], []))[:1]

        for m_code, sel_label, m_prob, odds, _ in _market_tuples_for_fixture(r):
            if not odds or odds < 1.25 or odds > 5.50:
                continue
            if r["odds_source"] in ("bet365_official", "live_sportsbook") and m_code.startswith("BTTS"):
                continue

            edge_pct = (m_prob * odds - 1.0) * 100.0
            bt_key = (r["div"], "1X2" if m_code.startswith("1X2") else ("BTTS" if m_code.startswith("BTTS") else "O/U 2.5"))
            bt = bt_map.get(bt_key)
            trust_badge = (
                "Backtest Proven"
                if (bt and bt["flat_roi_pct"] > 0 and bt["value_bets_count"] >= 10)
                else ("Positive CLV" if (bt and bt["avg_clv_pct"] > 0) else "Model Edge")
            )

            h_sot_diff = h_sot_for - h_sot_ag
            a_sot_diff = a_sot_for - a_sot_ag
            elo_gap = h_elo - a_elo
            aligned = (
                (m_code == "1X2_H" and elo_gap >= 30 and h_sot_diff >= a_sot_diff)
                or (m_code == "1X2_A" and elo_gap <= -30 and a_sot_diff >= h_sot_diff)
                or (m_code in ("OU_O25", "BTTS_Y") and (r["lambda_home"] + r["mu_away"]) >= 2.75)
                or (m_code == "OU_U25" and (r["lambda_home"] + r["mu_away"]) <= 2.35)
                or (m_code == "1X2_D" and abs(elo_gap) <= 35)
            )
            bt_bonus = 6.0 if (bt and bt["flat_roi_pct"] > 0 and bt["value_bets_count"] >= 10) else (3.0 if (bt and bt["avg_clv_pct"] > 0) else 0.0)
            off_bonus = 5.0 if is_official else 0.0
            align_bonus = 5.0 if aligned else 0.0
            raw_conf = 35.0 + edge_pct * 2.2 + m_prob * 45.0 + bt_bonus + off_bonus + align_bonus
            conf_score = int(max(45, min(98, round(raw_conf))))
            _, k_stake = kelly_stake_amount(m_prob, odds, bankroll, kelly_frac)

            reasons = [
                f"Model rates {sel_label} at {m_prob*100:.1f}% (fair {decimal_to_fractional(1.0/max(m_prob,0.01))}) vs {decimal_to_fractional(odds)} odds ({edge_pct:+.1f}% edge), xG {r['lambda_home']:.2f}–{r['mu_away']:.2f}.",
                f"Elo & SoT: {r['home_team']} {h_elo:.0f} ({h_sot_for:.1f} SoT/g) vs {r['away_team']} {a_elo:.0f} ({a_sot_for:.1f} SoT/g).",
                f"Form (Last 6): {h_form} vs {a_form} • {trust_badge}"
                + (f" ({bt['flat_roi_pct']:+.1f}% backtest ROI)" if bt else ""),
                (
                    f"Latest team news: [{matched_news[0]['source']}] {matched_news[0]['title']}"
                    if matched_news
                    else "News check: No disruptive late club headlines in BBC/Sky/Guardian feeds."
                ),
            ]

            candidates.append(
                {
                    "fixture_id": r["id"],
                    "div": r["div"],
                    "league_name": LEAGUES[r["div"]]["name"],
                    "match_date": r["match_date"],
                    "kickoff_time": r.get("kickoff_time") or "",
                    "home_team": r["home_team"],
                    "away_team": r["away_team"],
                    "market": m_code,
                    "selection_label": sel_label,
                    "odds": round(odds, 2),
                    "odds_fractional": decimal_to_fractional(odds),
                    "total_xg": round(float(r["lambda_home"]) + float(r["mu_away"]), 2),
                    "model_prob": round(m_prob, 5),
                    "model_prob_pct": round(m_prob * 100.0, 1),
                    "edge_pct": round(edge_pct, 2),
                    "confidence_score": conf_score,
                    "kelly_stake": k_stake,
                    "odds_source": r["odds_source"],
                    "is_official": is_official,
                    "trust_badge": trust_badge,
                    "reasons": reasons,
                }
            )

    if not candidates:
        return {"risk_levels": [], "by_risk": {}, "suggestions": [], "by_id": {}, "top_single": None}

    def _build_pkg(
        pkg_id: str,
        risk_level: str,
        title: str,
        badge: str,
        subtitle: str,
        legs: list[dict[str, Any]],
        stake: float,
    ) -> dict[str, Any]:
        avg_conf = int(round(sum(l["confidence_score"] for l in legs) / max(1, len(legs))))
        merged_reasons: list[str] = []
        seen_r: set[str] = set()
        for l in legs:
            for rsn in l["reasons"][: (4 if len(legs) == 1 else 2)]:
                if rsn not in seen_r:
                    seen_r.add(rsn)
                    merged_reasons.append(rsn)
        clean_legs = [
            {
                "fixture_id": l["fixture_id"],
                "div": l["div"],
                "league_name": l["league_name"],
                "match_date": l["match_date"],
                "kickoff_time": l.get("kickoff_time") or "",
                "home_team": l["home_team"],
                "away_team": l["away_team"],
                "market": l["market"],
                "selection_label": l["selection_label"],
                "odds": l["odds"],
                "odds_fractional": l.get("odds_fractional") or decimal_to_fractional(l["odds"]),
                "model_prob": l["model_prob"],
                "edge_pct": l["edge_pct"],
                "odds_source": l["odds_source"],
            }
            for l in legs
        ]
        ev = evaluate_acca(clean_legs, stake=stake)
        ev["combined_odds_fractional"] = decimal_to_fractional(ev.get("combined_odds"))
        b365 = build_bet365_export(clean_legs, stake=stake, title=title)
        return {
            "id": pkg_id,
            "risk_level": risk_level,
            "title": title,
            "badge": badge,
            "subtitle": subtitle,
            "confidence_score": avg_conf,
            "stake": round(stake, 2),
            "legs": clean_legs,
            "eval": ev,
            "reasons": merged_reasons[:4],
            "bet365_export": b365,
        }

    def _pool_or_fallback(preferred: list[dict[str, Any]], needed: int, fallback_sorted: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if len({c["fixture_id"] for c in preferred}) >= needed:
            return preferred
        seen = {(c["fixture_id"], c["market"]) for c in preferred}
        return preferred + [c for c in fallback_sorted if (c["fixture_id"], c["market"]) not in seen]

    # --- LOW RISK (1/1 - 2/1 Target, Safe Bankroll Builders) ---
    low_stake = round(max(5.0, default_stake), 2)
    low_single_pool = sorted(
        _pool_or_fallback(
            [c for c in candidates if c["model_prob"] >= 0.56 and c["odds"] <= 2.30],
            1,
            sorted(candidates, key=lambda c: (c["model_prob"], c["edge_pct"]), reverse=True),
        ),
        key=lambda c: (1 if c["is_official"] else 0, c["confidence_score"], c["model_prob"], c["edge_pct"]),
        reverse=True,
    )
    pkg_low_single = _build_pkg(
        "low_single",
        "low",
        "Banker Single",
        "Top Hit-Rate",
        "Strongest high-probability single backed by Elo, shots & Bet365 value",
        [low_single_pool[0]],
        max(5.0, low_single_pool[0]["kelly_stake"] or low_stake),
    )

    low_double_pool = sorted(
        _pool_or_fallback(
            [c for c in candidates if c["model_prob"] >= 0.55 and c["edge_pct"] >= -2.5],
            2,
            sorted(candidates, key=lambda c: (c["model_prob"], c["edge_pct"]), reverse=True),
        ),
        key=lambda c: (1 if c["is_official"] else 0, c["model_prob"] * 100.0 + c["edge_pct"], c["confidence_score"]),
        reverse=True,
    )
    pkg_low_double = _build_pkg(
        "low_double",
        "low",
        "Steady Banker Double",
        "Low Variance",
        "2 uncorrelated short-priced favourites with minimal margin drag",
        _pick_distinct_fixtures(low_double_pool, 2),
        low_stake,
    )

    low_goals_pool = sorted(
        _pool_or_fallback(
            [c for c in candidates if c["market"] in ("OU_O25", "BTTS_Y") and c["model_prob"] >= 0.52],
            2,
            sorted([c for c in candidates if c["market"] in ("OU_O25", "BTTS_Y")] or candidates, key=lambda c: c["model_prob"], reverse=True),
        ),
        key=lambda c: (c["model_prob"] * 100.0 + c["edge_pct"]),
        reverse=True,
    )
    pkg_low_goals = _build_pkg(
        "low_goals",
        "low",
        "Steady Goals Double",
        "Goals Angle",
        "2 highest-probability Over 2.5 / BTTS selections",
        _pick_distinct_fixtures(low_goals_pool, 2),
        low_stake,
    )

    # --- MEDIUM RISK (3/1 - 7/1 Target, Balanced Positive-EV Trebles) ---
    med_stake = round(default_stake, 2)
    med_pool = sorted(
        _pool_or_fallback(
            [c for c in candidates if c["odds"] <= 3.60 and c["edge_pct"] >= 2.0],
            3,
            sorted(candidates, key=lambda c: c["edge_pct"], reverse=True),
        ),
        key=lambda c: (c["edge_pct"], c["confidence_score"]),
        reverse=True,
    )
    pkg_med_treble = _build_pkg(
        "med_treble",
        "medium",
        "Smart Value Treble",
        "Balanced EV",
        "3 positive-EV selections across distinct fixtures balancing hit-rate & price",
        _pick_distinct_fixtures(med_pool, 3),
        med_stake,
    )

    med_goals_pool = sorted(
        _pool_or_fallback(
            [c for c in candidates if c["market"] in ("OU_O25", "BTTS_Y") and c["edge_pct"] >= 0.0],
            3,
            sorted([c for c in candidates if c["market"] in ("OU_O25", "BTTS_Y")] or candidates, key=lambda c: c["edge_pct"], reverse=True),
        ),
        key=lambda c: (c["edge_pct"], c["total_xg"]),
        reverse=True,
    )
    pkg_med_goals = _build_pkg(
        "med_goals",
        "medium",
        "Goals & BTTS Treble",
        "O2.5 / BTTS",
        "3 attacking matchups topped by Poisson xG & Bet365 value",
        _pick_distinct_fixtures(med_goals_pool, 3),
        med_stake,
    )

    fav_pool = [c for c in candidates if c["home_team"] in fav_teams or c["away_team"] in fav_teams]
    if not fav_pool:
        fav_pool = [c for c in candidates if c["div"] in pref_leagues] or candidates
    fav_sorted = sorted(fav_pool, key=lambda c: (c["confidence_score"], c["edge_pct"]), reverse=True)
    med_clubs_count = 3 if len({c["fixture_id"] for c in fav_sorted}) >= 3 else (2 if len({c["fixture_id"] for c in fav_sorted}) >= 2 else 1)
    pkg_med_clubs = _build_pkg(
        "med_clubs",
        "medium",
        "My Clubs Special",
        "Personalised",
        "Tailored to your followed clubs and preferred English leagues",
        _pick_distinct_fixtures(fav_sorted, med_clubs_count),
        med_stake,
    )

    # --- HIGH RISK (12/1 - 35/1 Target, Smaller Stake for Big Return) ---
    high_stake = 5.0
    high_5fold_pool = sorted(
        _pool_or_fallback(
            [c for c in candidates if 1.55 <= c["odds"] <= 3.40 and c["edge_pct"] >= 1.5],
            5,
            sorted(candidates, key=lambda c: c["edge_pct"], reverse=True),
        ),
        key=lambda c: (c["edge_pct"], c["confidence_score"]),
        reverse=True,
    )
    pkg_high_5fold = _build_pkg(
        "high_5fold",
        "high",
        "5-Fold Value Acca",
        "12/1–35/1 Target",
        "Small £5 stake across 5 uncorrelated positive-EV English selections",
        _pick_distinct_fixtures(high_5fold_pool, 5),
        high_stake,
    )

    high_goals_pool = sorted(
        _pool_or_fallback(
            [c for c in candidates if c["market"] in ("OU_O25", "BTTS_Y") and c["total_xg"] >= 2.55],
            5,
            sorted([c for c in candidates if c["market"] in ("OU_O25", "BTTS_Y")] or candidates, key=lambda c: (c["edge_pct"], c["total_xg"]), reverse=True),
        ),
        key=lambda c: (c["edge_pct"] + (c["total_xg"] - 2.5) * 8.0),
        reverse=True,
    )
    pkg_high_goals = _build_pkg(
        "high_goals_5fold",
        "high",
        "5-Fold Goals Bonanza",
        "5-Leg O2.5/BTTS",
        "High-tempo Over 2.5 & BTTS 5-fold chasing a big £5 acca return",
        _pick_distinct_fixtures(high_goals_pool, 5),
        high_stake,
    )

    high_dog_pool = sorted(
        _pool_or_fallback(
            [c for c in candidates if c["odds"] >= 2.35 and c["edge_pct"] >= 0.0],
            3,
            sorted([c for c in candidates if c["odds"] >= 2.0] or candidates, key=lambda c: (c["edge_pct"], c["odds"]), reverse=True),
        ),
        key=lambda c: (c["edge_pct"], c["odds"]),
        reverse=True,
    )
    pkg_high_dogs = _build_pkg(
        "high_underdogs",
        "high",
        "Value Underdog Treble",
        "Upside 3-Fold",
        "3 mispriced outsiders & away edges offering 15/1–30/1 payout upside",
        _pick_distinct_fixtures(high_dog_pool, 3),
        high_stake,
    )

    # --- MEGA LONGSHOT (40/1 - 150/1+ Target, Tiny Stake Huge Return) ---
    long_stake = 2.0
    long_7fold_pool = sorted(
        _pool_or_fallback(
            [c for c in candidates if c["odds"] >= 1.65 and c["edge_pct"] >= 0.5],
            7,
            sorted(candidates, key=lambda c: (c["edge_pct"], c["odds"]), reverse=True),
        ),
        key=lambda c: (c["edge_pct"] + c["confidence_score"] * 0.15, c["odds"]),
        reverse=True,
    )
    pkg_long_7fold = _build_pkg(
        "longshot_7fold",
        "longshot",
        "7-Fold Weekend Monster",
        "40/1+ Super Acca",
        "£2 micro-stake 7-fold builder hunting a 40/1–150/1+ jackpot return",
        _pick_distinct_fixtures(long_7fold_pool, 7),
        long_stake,
    )

    long_boomer_pool = sorted(
        _pool_or_fallback(
            [c for c in candidates if c["odds"] >= 2.60 and c["edge_pct"] >= 0.0],
            4,
            sorted([c for c in candidates if c["odds"] >= 2.20] or candidates, key=lambda c: (c["edge_pct"], c["odds"]), reverse=True),
        ),
        key=lambda c: (c["edge_pct"] * 1.2 + c["odds"] * 3.0),
        reverse=True,
    )
    pkg_long_boomers = _build_pkg(
        "longshot_boomers",
        "longshot",
        "4-Fold Longshot Boomers",
        "High-Odds Value",
        "4 big-priced value upsets & draws where Bet365 underestimates the upset",
        _pick_distinct_fixtures(long_boomer_pool, 4),
        long_stake,
    )

    long_goals_pool = sorted(
        _pool_or_fallback(
            [c for c in candidates if c["market"] in ("OU_O25", "BTTS_Y")],
            6,
            sorted(candidates, key=lambda c: (c["total_xg"], c["edge_pct"]), reverse=True),
        ),
        key=lambda c: (c["total_xg"] * 10.0 + c["edge_pct"]),
        reverse=True,
    )
    pkg_long_goals = _build_pkg(
        "longshot_goals_6fold",
        "longshot",
        "6-Fold Goals Explosion",
        "6-Leg xG Special",
        "6 highest-xG goals selections combined for massive small-stake return",
        _pick_distinct_fixtures(long_goals_pool, 6),
        long_stake,
    )

    risk_levels = [
        {
            "id": "low",
            "label": "Low Risk • Safe Builder",
            "short_label": "Low Risk",
            "emoji": "🟢",
            "target_odds_label": "1/1 – 2/1 Target",
            "default_stake": low_stake,
            "description": "High-probability singles & steady doubles designed for consistent hit rates",
            "primary": pkg_low_single,
            "options": [pkg_low_single, pkg_low_double, pkg_low_goals],
        },
        {
            "id": "medium",
            "label": "Medium Risk • Balanced Value",
            "short_label": "Medium Risk",
            "emoji": "🟡",
            "target_odds_label": "3/1 – 7/1 Target",
            "default_stake": med_stake,
            "description": "Balanced 3-leg value trebles mixing solid win chance with Bet365 EV edge",
            "primary": pkg_med_treble,
            "options": [pkg_med_treble, pkg_med_goals, pkg_med_clubs],
        },
        {
            "id": "high",
            "label": "High Risk • Big Return",
            "short_label": "High Risk",
            "emoji": "🟠",
            "target_odds_label": "12/1 – 35/1 Target",
            "default_stake": high_stake,
            "description": "Smaller £5 stake chasing big weekend payouts via 5-folds & value underdogs",
            "primary": pkg_high_5fold,
            "options": [pkg_high_5fold, pkg_high_goals, pkg_high_dogs],
        },
        {
            "id": "longshot",
            "label": "Mega Longshot • Small Stake",
            "short_label": "Longshot",
            "emoji": "🔥",
            "target_odds_label": "40/1 – 150/1+ Target",
            "default_stake": long_stake,
            "description": "Tiny £1–£2 stake hunting huge 40/1 to 150/1+ payouts from model-backed outsiders",
            "primary": pkg_long_7fold,
            "options": [pkg_long_7fold, pkg_long_boomers, pkg_long_goals],
        },
    ]

    by_id: dict[str, dict[str, Any]] = {}
    for rl in risk_levels:
        for opt in rl["options"]:
            by_id[opt["id"]] = opt
    # Preserve friendly aliases
    by_id["top_single"] = pkg_low_single
    by_id["banker_double"] = pkg_low_double
    by_id["value_treble"] = pkg_med_treble
    by_id["my_clubs"] = pkg_med_clubs

    primary_suggestions = [rl["primary"] for rl in risk_levels]
    return {
        "risk_levels": risk_levels,
        "by_risk": {rl["id"]: rl for rl in risk_levels},
        "suggestions": primary_suggestions,
        "by_id": by_id,
        "top_single": pkg_low_single,
    }
