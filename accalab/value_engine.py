"""Value Bet Finder, Kelly Staking, Acca Correlation Engine, Bet Settlement, and Telegram Alerts."""

from __future__ import annotations

import base64
import json
import sqlite3
import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from accalab.config import (
    CURRENT_SEASON,
    LEAGUES,
    MARKET_LABELS,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_DEFAULT_CHAT_ID,
    expand_bet_type_filters,
    market_bet_type,
)
from accalab.db import utc_now_iso
from accalab.modeling import estimate_two_way_odds, extract_extended_goals_probs


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


def _market_tuples_for_fixture(row: dict[str, Any]) -> list[tuple[str, str, float, float | None, float | None, str]]:
    """Return list of (market_code, selection_label, model_prob, odds, fair_bookie_prob, odds_source)."""
    items: list[tuple[str, str, float, float | None, float | None, str]] = []
    raw_src = str(row.get("odds_source") or "market_estimate")
    official_sources = {"bet365_official", "api_football_b365", "live_sportsbook", "user_manual"}

    h_o, d_o, a_o = row.get("b365h"), row.get("b365d"), row.get("b365a")
    if h_o and d_o and a_o:
        fh, fd, fa, _ = devig_three_way(h_o, d_o, a_o)
    else:
        fh = fd = fa = None
    src_1x2 = raw_src if (raw_src in official_sources and h_o and d_o and a_o) else "market_estimate"

    items.append(("1X2_H", f"{row['home_team']} Win", row["prob_home"], h_o, fh, src_1x2))
    items.append(("1X2_D", "Draw", row["prob_draw"], d_o, fd, src_1x2))
    items.append(("1X2_A", f"{row['away_team']} Win", row["prob_away"], a_o, fa, src_1x2))

    o25, u25 = row.get("b365_over25"), row.get("b365_under25")
    has_live_ou25 = raw_src in official_sources and bool(o25 and u25)
    if not (o25 and u25):
        o25, u25 = estimate_two_way_odds(row["prob_over25"], base_yes=0.50)
        src_ou25 = "market_estimate"
    else:
        src_ou25 = raw_src if has_live_ou25 else "market_estimate"
    fo, fu, _ = devig_two_way(o25, u25)
    items.append(("OU_O25", "Over 2.5 Goals", row["prob_over25"], o25, fo, src_ou25))
    items.append(("OU_U25", "Under 2.5 Goals", row["prob_under25"], u25, fu, src_ou25))

    by, bn = row.get("b365_btts_yes"), row.get("b365_btts_no")
    has_live_btts = raw_src in ("api_football_b365", "user_manual") and bool(by and bn)
    if not (by and bn):
        by, bn = estimate_two_way_odds(row["prob_btts_yes"], base_yes=0.52)
        src_btts = "market_estimate"
    else:
        src_btts = raw_src if has_live_btts else "market_estimate"
    fby, fbn, _ = devig_two_way(by, bn)
    items.append(("BTTS_Y", "BTTS Yes", row["prob_btts_yes"], by, fby, src_btts))
    items.append(("BTTS_N", "BTTS No", row["prob_btts_no"], bn, fbn, src_btts))

    if row.get("lambda_home") is not None and row.get("mu_away") is not None:
        rho_val = float(row.get("rho") if row.get("rho") is not None else -0.04)
        ext = extract_extended_goals_probs(float(row["lambda_home"]), float(row["mu_away"]), rho_val)
        o15, u15 = estimate_two_way_odds(ext["prob_over15"], base_yes=0.75)
        fo15, fu15, _ = devig_two_way(o15, u15)
        items.append(("OU_O15", "Over 1.5 Goals", ext["prob_over15"], o15, fo15, "market_estimate"))
        items.append(("OU_U15", "Under 1.5 Goals", ext["prob_under15"], u15, fu15, "market_estimate"))

        o35, u35 = estimate_two_way_odds(ext["prob_over35"], base_yes=0.29)
        fo35, fu35, _ = devig_two_way(o35, u35)
        items.append(("OU_O35", "Over 3.5 Goals", ext["prob_over35"], o35, fo35, "market_estimate"))
        items.append(("OU_U35", "Under 3.5 Goals", ext["prob_under35"], u35, fu35, "market_estimate"))

    return items


def _build_selection_reasons(
    row: dict[str, Any],
    m_code: str,
    sel_label: str,
    m_prob: float,
    odds: float,
    edge_pct: float,
    bt: dict[str, Any] | None,
    matched_news: list[dict[str, Any]],
    mkt_src: str,
    trust_badge: str,
    include_empty_news_note: bool = True,
) -> tuple[list[str], dict[str, Any]]:
    """Build market-tailored reasoning bullets and compact stats for a selection."""
    lam = float(row.get("lambda_home") if row.get("lambda_home") is not None else 1.35)
    mu = float(row.get("mu_away") if row.get("mu_away") is not None else 1.15)
    tot_xg = lam + mu
    h_elo = float(row.get("home_elo") or 1500.0)
    a_elo = float(row.get("away_elo") or 1500.0)
    elo_gap = h_elo - a_elo
    h_form = row.get("home_form") or "N/A"
    a_form = row.get("away_form") or "N/A"
    h_sot_for = float(row.get("h_sot_for") or 0.0)
    a_sot_for = float(row.get("a_sot_for") or 0.0)
    fair_odds = 1.0 / max(m_prob, 0.01)
    is_est = mkt_src == "market_estimate"
    price_tag = "estimated " if is_est else ""

    if edge_pct >= 0:
        b1 = (
            f"Value Edge: Model rates {sel_label} at {m_prob*100:.1f}% "
            f"(fair {decimal_to_fractional(fair_odds)}) vs {decimal_to_fractional(odds)} "
            f"{price_tag}odds ({edge_pct:+.1f}% edge)."
        )
    else:
        b1 = (
            f"Model Probability: Rates {sel_label} at {m_prob*100:.1f}% "
            f"(fair {decimal_to_fractional(fair_odds)}) vs {decimal_to_fractional(odds)} "
            f"{price_tag}odds ({edge_pct:+.1f}% vs market)."
        )

    elo_str = f"{row['home_team']} {h_elo:.0f} vs {row['away_team']} {a_elo:.0f}"
    sot_str = (
        f" • SoT/game: {h_sot_for:.1f} vs {a_sot_for:.1f}"
        if (h_sot_for > 0 or a_sot_for > 0)
        else ""
    )
    if m_code == "1X2_H":
        gap_txt = f"{elo_gap:+.0f} home Elo edge" if elo_gap >= 15 else f"Elo gap {elo_gap:+.0f}"
        b2 = f"Matchup & xG: Projected xG {lam:.2f}–{mu:.2f} ({gap_txt}; {elo_str}){sot_str}."
    elif m_code == "1X2_A":
        gap_txt = f"{-elo_gap:+.0f} away Elo edge" if -elo_gap >= 15 else f"Elo {-elo_gap:+.0f}"
        b2 = f"Matchup & xG: Projected xG {lam:.2f}–{mu:.2f} ({gap_txt}; {elo_str}){sot_str}."
    elif m_code == "1X2_D":
        b2 = f"Tight Balance: Projected xG {lam:.2f}–{mu:.2f} with close Elo ({elo_str}, gap {abs(elo_gap):.0f}){sot_str}."
    elif m_code == "BTTS_Y":
        b2 = f"Attacking Output: Projected {lam:.2f}–{mu:.2f} xG ({tot_xg:.2f} total) supports both sides scoring{sot_str}."
    elif m_code == "BTTS_N":
        b2 = f"Clean-Sheet Profile: Projected {lam:.2f}–{mu:.2f} xG points to at least one shutout ({elo_str}){sot_str}."
    elif m_code.startswith("OU_O"):
        line = "1.5" if "15" in m_code else ("3.5" if "35" in m_code else "2.5")
        b2 = f"Goal Expectancy: Combined {tot_xg:.2f} xG ({lam:.2f} + {mu:.2f}) favours Over {line} goals{sot_str}."
    else:
        line = "1.5" if "15" in m_code else ("3.5" if "35" in m_code else "2.5")
        b2 = f"Low-Scoring Profile: Combined {tot_xg:.2f} xG ({lam:.2f} + {mu:.2f}) leans Under {line} goals{sot_str}."

    bt_detail = ""
    if bt and bt.get("value_bets_count") is not None:
        bt_detail = f" ({bt['flat_roi_pct']:+.1f}% ROI over {bt['value_bets_count']} bets)"
    elif bt and bt.get("avg_clv_pct"):
        bt_detail = f" (+{bt['avg_clv_pct']:.1f}% avg CLV)"
    b3 = f"Form & Track Record: {h_form} (H) vs {a_form} (A) • {trust_badge}{bt_detail}."

    reasons = [b1, b2, b3]
    if matched_news:
        reasons.append(f"Team News: [{matched_news[0]['source']}] {matched_news[0]['title']}")
    elif include_empty_news_note:
        reasons.append("News Check: No disruptive late club headlines in BBC/Sky/Guardian feeds.")

    reason_stats: dict[str, Any] = {
        "xg_home": round(lam, 2),
        "xg_away": round(mu, 2),
        "total_xg": round(tot_xg, 2),
        "elo_home": round(h_elo),
        "elo_away": round(a_elo),
        "form_home": h_form,
        "form_away": a_form,
        "fair_odds": round(fair_odds, 2),
        "trust_badge": trust_badge,
    }
    if h_sot_for > 0 or a_sot_for > 0:
        reason_stats["sot_home"] = round(h_sot_for, 1)
        reason_stats["sot_away"] = round(a_sot_for, 1)
    if bt and bt.get("flat_roi_pct") is not None:
        reason_stats["backtest_roi_pct"] = round(float(bt["flat_roi_pct"]), 1)
    if matched_news:
        reason_stats["news_headline"] = f"[{matched_news[0]['source']}] {matched_news[0]['title']}"

    return reasons, reason_stats


def _build_bet_level_reasons(
    title: str,
    legs: list[dict[str, Any]],
    ev: dict[str, Any],
    risk_level: str,
    criteria: dict[str, Any] | None = None,
    exclude_already_bet: bool = False,
) -> list[str]:
    """Generate whole-bet rationale bullets summarizing criteria fit, math, strongest leg & promos."""
    if not legs:
        return []
    risk_labels = {
        "low": "Low Risk",
        "medium": "Balanced",
        "high": "High Risk",
        "longshot": "Longshot",
    }
    r_label = risk_labels.get(risk_level, risk_level.title())
    distinct_fixtures = len({_canonical_match_key(l) or l.get("fixture_id") for l in legs})
    comb_frac = ev.get("combined_odds_fractional") or decimal_to_fractional(ev.get("combined_odds"))
    comb_prob = float(ev.get("combined_model_prob_pct") or 0.0)
    ev_pct = float(ev.get("expected_value_pct") or 0.0)
    best_leg = max(legs, key=lambda l: float(l.get("edge_pct") or 0.0))

    bet_reasons: list[str] = []
    if criteria and criteria.get("bet_type_summary"):
        bet_reasons.append(
            f"Criteria Match: {r_label} {len(legs)}-leg build focused on {criteria['bet_type_summary']} across {distinct_fixtures} distinct fixtures."
        )
    else:
        bet_reasons.append(
            f"Selection Strategy: {title} ({r_label}) combining {len(legs)} top-scoring {'leg' if len(legs) == 1 else 'legs'} across {distinct_fixtures} matches."
        )

    bet_reasons.append(
        f"Combined Math: {comb_frac} combined odds • {comb_prob:.1f}% model win chance ({ev_pct:+.1f}% expected value)."
    )
    bet_reasons.append(
        f"Strongest Driver: {best_leg['selection_label']} ({best_leg['home_team']} vs {best_leg['away_team']}) leads at {float(best_leg.get('edge_pct') or 0):+.1f}% edge."
    )

    two_up_count = sum(1 for l in legs if l.get("market") in ("1X2_H", "1X2_A"))
    notes: list[str] = []
    if exclude_already_bet:
        notes.append("screened out your active placed/saved/slip legs")
    if two_up_count > 0:
        notes.append(f"{two_up_count}x 2-Up Early Payout eligible")
    if len(legs) >= 2:
        notes.append("Acca Boost qualifying leg structure")
    if notes:
        bet_reasons.append(f"Bet Safeguards & Perks: {notes[0][0].upper()}{notes[0][1:]}{(' • ' + ' • '.join(notes[1:])) if len(notes) > 1 else ''}.")

    return bet_reasons


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
               p.lambda_home, p.mu_away, p.rho,
               hr.elo AS home_elo, hr.form_last6 AS home_form,
               hr.sot_for_pg AS h_sot_for, hr.sot_against_pg AS h_sot_ag,
               ar.elo AS away_elo, ar.form_last6 AS away_form,
               ar.sot_for_pg AS a_sot_for, ar.sot_against_pg AS a_sot_ag
        FROM upcoming_fixtures f
        JOIN predictions p ON p.fixture_id = f.id
        LEFT JOIN team_ratings hr ON hr.team_name = f.home_team
        LEFT JOIN team_ratings ar ON ar.team_name = f.away_team
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

    news_by_team: dict[str, list[dict[str, Any]]] = {}
    for nr in conn.execute("SELECT title, source, url, matched_teams_json FROM news_items ORDER BY published_at DESC LIMIT 80").fetchall():
        nd = dict(nr)
        for team in json.loads(nd.get("matched_teams_json") or "[]"):
            news_by_team.setdefault(team, []).append(nd)

    allowed_markets = expand_bet_type_filters(market_filter) if market_filter else None
    official_sources = {"bet365_official", "api_football_b365", "live_sportsbook", "user_manual"}

    opportunities: list[dict[str, Any]] = []
    for row in rows:
        matched_news = (news_by_team.get(row["home_team"], []) + news_by_team.get(row["away_team"], []))[:1]
        for m_code, sel_label, m_prob, odds, fair_b_prob, mkt_odds_source in _market_tuples_for_fixture(row):
            if allowed_markets is not None and m_code not in allowed_markets:
                continue
            if official_only and mkt_odds_source not in official_sources:
                continue
            if not odds or odds <= 1.01:
                continue
            edge_pct = (m_prob * odds - 1.0) * 100.0
            if edge_pct < min_edge_pct:
                continue

            kelly_pct, stake_gbp = kelly_stake_amount(m_prob, odds, bankroll, kelly_fraction)
            bt_key = (row["div"], "1X2" if m_code.startswith("1X2") else ("BTTS" if m_code.startswith("BTTS") else "O/U 2.5"))
            bt = bt_map.get(bt_key)
            backtest_roi = bt["flat_roi_pct"] if bt else None
            trust_badge = (
                "Backtest Proven"
                if (bt and bt["flat_roi_pct"] > 0 and bt["value_bets_count"] >= 10)
                else ("Positive CLV" if (bt and bt["avg_clv_pct"] > 0) else "Model Edge")
            )
            bt_meta = market_bet_type(m_code)
            reasons, reason_stats = _build_selection_reasons(
                row,
                m_code,
                sel_label,
                float(m_prob),
                float(odds),
                edge_pct,
                bt,
                matched_news,
                mkt_odds_source,
                trust_badge,
                include_empty_news_note=False,
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
                    "bet_type": bt_meta["key"],
                    "bet_type_label": bt_meta["label"],
                    "selection_label": sel_label,
                    "odds": round(odds, 2),
                    "fair_odds": round(1.0 / max(m_prob, 0.01), 2),
                    "model_prob_pct": round(m_prob * 100.0, 1),
                    "implied_prob_pct": round((fair_b_prob if fair_b_prob else 1.0 / odds) * 100.0, 1),
                    "edge_pct": round(edge_pct, 2),
                    "kelly_pct": kelly_pct,
                    "suggested_stake": stake_gbp,
                    "odds_source": mkt_odds_source,
                    "trust_badge": trust_badge,
                    "backtest_roi_pct": backtest_roi,
                    "reasons": reasons,
                    "reason_stats": reason_stats,
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
                   p.prob_over25, p.prob_under25, p.prob_btts_yes, p.prob_btts_no,
                   p.lambda_home, p.mu_away, p.rho
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
        for m_code, sel_label, m_prob, odds, _, mkt_src in _market_tuples_for_fixture(r):
            if not odds or odds <= 1.05:
                continue
            edge_pct = (m_prob * odds - 1.0) * 100.0
            bt_meta = market_bet_type(m_code)
            candidates.append(
                {
                    "fixture_id": r["id"],
                    "div": r["div"],
                    "league_name": LEAGUES[r["div"]]["name"],
                    "match_date": r["match_date"],
                    "home_team": r["home_team"],
                    "away_team": r["away_team"],
                    "market": m_code,
                    "bet_type": bt_meta["key"],
                    "bet_type_label": bt_meta["label"],
                    "selection_label": sel_label,
                    "odds": round(odds, 2),
                    "model_prob": round(m_prob, 5),
                    "edge_pct": round(edge_pct, 2),
                    "odds_source": mkt_src,
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
    if market == "OU_O15":
        return (fthg + ftag) >= 2
    if market == "OU_U15":
        return (fthg + ftag) <= 1
    if market == "OU_O25":
        return (fthg + ftag) >= 3
    if market == "OU_U25":
        return (fthg + ftag) <= 2
    if market == "OU_O35":
        return (fthg + ftag) >= 4
    if market == "OU_U35":
        return (fthg + ftag) <= 3
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
    "OU_O15": "Goals Over/Under",
    "OU_U15": "Goals Over/Under",
    "OU_O25": "Goals Over/Under",
    "OU_U25": "Goals Over/Under",
    "OU_O35": "Goals Over/Under",
    "OU_U35": "Goals Over/Under",
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
    if mkt == "OU_O15":
        return "Over 1.5"
    if mkt == "OU_U15":
        return "Under 1.5"
    if mkt == "OU_O25":
        return "Over 2.5"
    if mkt == "OU_U25":
        return "Under 2.5"
    if mkt == "OU_O35":
        return "Over 3.5"
    if mkt == "OU_U35":
        return "Under 3.5"
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
        search_hash = f"#/AX/K^{urllib.parse.quote(search_term)}/"

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
                "model_prob": float(leg.get("model_prob") or 0.5),
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
        launch_url = exported_legs[0]["b365_search_url"] if exported_legs else "https://www.bet365.com/#/HO/"
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


def _market_family(market: str) -> str:
    m = str(market or "").strip()
    if m.startswith("1X2_"):
        return "1X2"
    if m.startswith("BTTS_"):
        return "BTTS"
    if m.startswith("OU_"):
        return "OU"
    return m


def _canonical_match_key(item: dict[str, Any]) -> str:
    mdate = str(item.get("match_date") or "")[:10].strip()
    home = str(item.get("home_team") or "").strip().lower()
    away = str(item.get("away_team") or "").strip().lower()
    return f"{mdate}|{home}|{away}" if (home and away) else ""


def _matches_kickoff_filter(row: dict[str, Any], mode: str, now_dt: datetime | None = None) -> bool:
    clean_mode = str(mode or "ALL").strip().upper()
    if not clean_mode or clean_mode == "ALL":
        return True
    mdate = str(row.get("match_date") or "").strip()
    if not mdate:
        return True
    current = now_dt or datetime.now(timezone.utc)
    today_iso = current.strftime("%Y-%m-%d")
    if clean_mode == "TODAY":
        return mdate == today_iso
    try:
        dt = datetime.strptime(mdate[:10], "%Y-%m-%d")
    except ValueError:
        return True
    dow = dt.weekday()  # 0=Mon .. 4=Fri, 5=Sat, 6=Sun
    ktime = str(row.get("kickoff_time") or "").strip()
    if clean_mode == "SAT_3PM":
        return dow == 5 and (not ktime or "14:45" <= ktime <= "15:15")
    if clean_mode == "WEEKEND":
        return dow in (5, 6) or (dow == 4 and (not ktime or ktime >= "18:00"))
    if clean_mode == "MIDWEEK":
        return dow in (0, 1, 2, 3)
    return True


def get_user_already_bet_legs(
    conn: sqlite3.Connection,
    user: dict[str, Any],
    include_bets: bool = True,
    include_saved: bool = True,
    include_slip: bool = True,
) -> list[dict[str, Any]]:
    """Collect upcoming/pending legs the user already bet on, saved as drafts, or holds in their slip."""
    uid = int(user.get("id") or 0)
    today_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    collected: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    def _push(leg: dict[str, Any], source: str) -> None:
        mkey = _canonical_match_key(leg)
        fid_str = str(leg.get("fixture_id") or "")
        ident = mkey or fid_str
        mkt = str(leg.get("market") or "").strip()
        if not ident or not mkt:
            return
        dedup_k = (f"{ident}:{mkt}", source)
        if dedup_k in seen:
            return
        seen.add(dedup_k)
        collected.append(
            {
                "fixture_id": leg.get("fixture_id"),
                "match_date": str(leg.get("match_date") or "")[:10],
                "home_team": str(leg.get("home_team") or ""),
                "away_team": str(leg.get("away_team") or ""),
                "market": mkt,
                "selection_label": str(leg.get("selection_label") or MARKET_LABELS.get(mkt, mkt)),
                "source": source,
            }
        )

    if uid > 0 and include_bets:
        rows = conn.execute(
            """
            SELECT bl.fixture_id, bl.match_date, bl.home_team, bl.away_team,
                   bl.market, bl.selection_label
            FROM bet_legs bl
            JOIN bets b ON b.id = bl.bet_id
            WHERE b.user_id = ? AND (b.status = 'pending' OR bl.match_date >= ?)
            ORDER BY b.placed_at DESC
            """,
            (uid, today_iso),
        ).fetchall()
        for r in rows:
            _push(dict(r), "placed")

    if uid > 0 and include_saved:
        saved_rows = conn.execute(
            "SELECT legs_json FROM saved_accas WHERE user_id = ? ORDER BY created_at DESC",
            (uid,),
        ).fetchall()
        for sr in saved_rows:
            try:
                legs = json.loads(sr["legs_json"] or "[]")
            except json.JSONDecodeError:
                legs = []
            if not isinstance(legs, list):
                continue
            for lg in legs:
                if not isinstance(lg, dict):
                    continue
                md = str(lg.get("match_date") or "")[:10]
                if not md or md >= today_iso:
                    _push(lg, "saved_acca")

    if include_slip:
        for lg in user.get("active_slip") or []:
            if not isinstance(lg, dict):
                continue
            md = str(lg.get("match_date") or "")[:10]
            if not md or md >= today_iso:
                _push(lg, "slip")

    return collected


def _build_exclusion_sets(legs: list[dict[str, Any]]) -> dict[str, set[Any]]:
    fixture_ids: set[int] = set()
    match_keys: set[str] = set()
    exact_fid_mkts: set[tuple[int, str]] = set()
    exact_key_mkts: set[tuple[str, str]] = set()
    fam_fid_mkts: set[tuple[int, str]] = set()
    fam_key_mkts: set[tuple[str, str]] = set()

    for lg in legs:
        if not isinstance(lg, dict):
            continue
        fid = lg.get("fixture_id")
        fid_int = int(fid) if fid is not None and str(fid).isdigit() else None
        mkey = _canonical_match_key(lg)
        mkt = str(lg.get("market") or "").strip()
        fam = _market_family(mkt)
        if fid_int is not None:
            fixture_ids.add(fid_int)
            if mkt:
                exact_fid_mkts.add((fid_int, mkt))
                fam_fid_mkts.add((fid_int, fam))
        if mkey:
            match_keys.add(mkey)
            if mkt:
                exact_key_mkts.add((mkey, mkt))
                fam_key_mkts.add((mkey, fam))

    return {
        "fixture_ids": fixture_ids,
        "match_keys": match_keys,
        "exact_fid_mkts": exact_fid_mkts,
        "exact_key_mkts": exact_key_mkts,
        "fam_fid_mkts": fam_fid_mkts,
        "fam_key_mkts": fam_key_mkts,
    }


def _is_candidate_excluded(
    cand: dict[str, Any],
    excl_sets: dict[str, set[Any]],
    scope: str = "market_family",
) -> bool:
    fid = cand.get("fixture_id")
    fid_int = int(fid) if fid is not None and str(fid).isdigit() else None
    mkey = _canonical_match_key(cand)
    if scope == "fixture":
        if fid_int is not None and fid_int in excl_sets["fixture_ids"]:
            return True
        if mkey and mkey in excl_sets["match_keys"]:
            return True
        return False

    mkt = str(cand.get("market") or "").strip()
    fam = _market_family(mkt)
    if fid_int is not None:
        if (fid_int, mkt) in excl_sets["exact_fid_mkts"] or (fid_int, fam) in excl_sets["fam_fid_mkts"]:
            return True
    if mkey:
        if (mkey, mkt) in excl_sets["exact_key_mkts"] or (mkey, fam) in excl_sets["fam_key_mkts"]:
            return True
    return False


def _build_suggestion_package(
    pkg_id: str,
    risk_level: str,
    title: str,
    badge: str,
    subtitle: str,
    legs: list[dict[str, Any]],
    stake: float,
    extra: dict[str, Any] | None = None,
    exclude_already_bet: bool = False,
) -> dict[str, Any]:
    avg_conf = int(round(sum(l["confidence_score"] for l in legs) / max(1, len(legs))))
    merged_reasons: list[str] = []
    seen_r: set[str] = set()
    for l in legs:
        for rsn in l.get("reasons", [])[: (4 if len(legs) == 1 else 2)]:
            if rsn not in seen_r:
                seen_r.add(rsn)
                merged_reasons.append(rsn)
    clean_legs = []
    for l in legs:
        bt_meta = market_bet_type(l["market"])
        clean_legs.append(
            {
                "fixture_id": l["fixture_id"],
                "div": l["div"],
                "league_name": l["league_name"],
                "match_date": l["match_date"],
                "kickoff_time": l.get("kickoff_time") or "",
                "home_team": l["home_team"],
                "away_team": l["away_team"],
                "market": l["market"],
                "bet_type": l.get("bet_type") or bt_meta["key"],
                "bet_type_label": l.get("bet_type_label") or bt_meta["label"],
                "selection_label": l["selection_label"],
                "odds": l["odds"],
                "odds_fractional": l.get("odds_fractional") or decimal_to_fractional(l["odds"]),
                "model_prob": l["model_prob"],
                "edge_pct": l["edge_pct"],
                "odds_source": l["odds_source"],
                "confidence_score": l.get("confidence_score"),
                "trust_badge": l.get("trust_badge"),
                "reasons": list(l.get("reasons") or []),
                "reason_stats": l.get("reason_stats"),
            }
        )
    ev = evaluate_acca(clean_legs, stake=stake)
    ev["combined_odds_fractional"] = decimal_to_fractional(ev.get("combined_odds"))
    criteria = (extra or {}).get("criteria") if extra else None
    bet_reasons = _build_bet_level_reasons(
        title=title,
        legs=clean_legs,
        ev=ev,
        risk_level=risk_level,
        criteria=criteria,
        exclude_already_bet=exclude_already_bet,
    )
    b365 = build_bet365_export(clean_legs, stake=stake, title=title)
    pkg: dict[str, Any] = {
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
        "bet_reasons": bet_reasons,
        "bet365_export": b365,
    }
    if extra:
        pkg.update(extra)
    return pkg


def _build_scored_candidates(conn: sqlite3.Connection, user: dict[str, Any]) -> list[dict[str, Any]]:
    bankroll = float(user.get("bankroll") or 250.0)
    kelly_frac = float(user.get("kelly_fraction") or 0.25)

    rows = [
        dict(r)
        for r in conn.execute(
            """
            SELECT f.*, p.prob_home, p.prob_draw, p.prob_away,
                   p.prob_over25, p.prob_under25, p.prob_btts_yes, p.prob_btts_no,
                   p.lambda_home, p.mu_away, p.rho,
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
        return []

    bt_map: dict[tuple[str, str], dict[str, Any]] = {
        (b["div"], b["market"]): dict(b)
        for b in conn.execute("SELECT * FROM backtest_results").fetchall()
    }
    news_by_team: dict[str, list[dict[str, Any]]] = {}
    for nr in conn.execute("SELECT title, source, url, matched_teams_json FROM news_items ORDER BY published_at DESC LIMIT 80").fetchall():
        nd = dict(nr)
        for team in json.loads(nd.get("matched_teams_json") or "[]"):
            news_by_team.setdefault(team, []).append(nd)

    official_sources = {"bet365_official", "api_football_b365", "live_sportsbook", "user_manual"}
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
        matched_news = (news_by_team.get(r["home_team"], []) + news_by_team.get(r["away_team"], []))[:1]

        for m_code, sel_label, m_prob, odds, _, mkt_src in _market_tuples_for_fixture(r):
            if not odds or odds < 1.05 or odds > 10.0:
                continue

            is_official = mkt_src in official_sources
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
            tot_xg = float(r["lambda_home"]) + float(r["mu_away"])
            aligned = (
                (m_code == "1X2_H" and elo_gap >= 30 and h_sot_diff >= a_sot_diff)
                or (m_code == "1X2_A" and elo_gap <= -30 and a_sot_diff >= h_sot_diff)
                or (m_code in ("OU_O15", "OU_O25", "OU_O35", "BTTS_Y") and tot_xg >= 2.75)
                or (m_code in ("OU_U15", "OU_U25", "OU_U35", "BTTS_N") and tot_xg <= 2.35)
                or (m_code == "1X2_D" and abs(elo_gap) <= 35)
            )
            bt_bonus = 6.0 if (bt and bt["flat_roi_pct"] > 0 and bt["value_bets_count"] >= 10) else (3.0 if (bt and bt["avg_clv_pct"] > 0) else 0.0)
            off_bonus = 5.0 if is_official else 0.0
            align_bonus = 5.0 if aligned else 0.0
            raw_conf = 35.0 + edge_pct * 2.2 + m_prob * 45.0 + bt_bonus + off_bonus + align_bonus
            conf_score = int(max(45, min(98, round(raw_conf))))
            _, k_stake = kelly_stake_amount(m_prob, odds, bankroll, kelly_frac)
            bt_meta = market_bet_type(m_code)
            reasons, reason_stats = _build_selection_reasons(
                r,
                m_code,
                sel_label,
                float(m_prob),
                float(odds),
                edge_pct,
                bt,
                matched_news,
                mkt_src,
                trust_badge,
                include_empty_news_note=True,
            )

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
                    "bet_type": bt_meta["key"],
                    "bet_type_label": bt_meta["label"],
                    "selection_label": sel_label,
                    "odds": round(odds, 2),
                    "odds_fractional": decimal_to_fractional(odds),
                    "total_xg": round(tot_xg, 2),
                    "model_prob": round(m_prob, 5),
                    "model_prob_pct": round(m_prob * 100.0, 1),
                    "edge_pct": round(edge_pct, 2),
                    "confidence_score": conf_score,
                    "kelly_stake": k_stake,
                    "odds_source": mkt_src,
                    "is_official": is_official,
                    "trust_badge": trust_badge,
                    "reasons": reasons,
                    "reason_stats": reason_stats,
                }
            )

    return candidates


def build_bet_suggestions(
    conn: sqlite3.Connection,
    user: dict[str, Any],
    exclude_legs: list[dict[str, Any]] | None = None,
    exclude_already_bet: bool = False,
    exclude_scope: str = "market_family",
) -> dict[str, Any]:
    """Synthesize stats, Dixon-Coles/Elo, backtest ROI, Bet365 prices & news into 4 ready-to-bet suggestions."""
    default_stake = float(user.get("default_stake") or 10.0)
    fav_teams = set(user.get("favourite_teams") or [])
    pref_leagues = set(user.get("preferred_leagues") or LEAGUES.keys())

    all_cands = _build_scored_candidates(conn, user)
    candidates = [c for c in all_cands if 1.25 <= c["odds"] <= 5.50]
    if not candidates:
        candidates = list(all_cands)

    if exclude_already_bet or exclude_legs:
        combined_excl = (
            get_user_already_bet_legs(conn, user) if exclude_already_bet else []
        ) + list(exclude_legs or [])
        if combined_excl:
            excl_sets = _build_exclusion_sets(combined_excl)
            filtered = [
                c for c in candidates if not _is_candidate_excluded(c, excl_sets, scope=exclude_scope)
            ]
            if filtered:
                candidates = filtered

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
        return _build_suggestion_package(
            pkg_id,
            risk_level,
            title,
            badge,
            subtitle,
            legs,
            stake,
            exclude_already_bet=exclude_already_bet,
        )

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


_CUSTOM_BET_TYPE_LABELS: dict[str, str] = {
    "ALL": "Any Mix",
    "TO_WIN": "To Win",
    "DRAW": "Draw",
    "1X2": "Match Result",
    "BTTS": "BTTS",
    "BTTS_Y": "BTTS Yes",
    "BTTS_N": "BTTS No",
    "GOALS": "Goals",
    "OU_O15": "Over 1.5",
    "OU_U15": "Under 1.5",
    "OU_O25": "Over 2.5",
    "OU_U25": "Under 2.5",
    "OU_O35": "Over 3.5",
    "OU_U35": "Under 3.5",
}


def _score_candidate_for_risk(c: dict[str, Any], risk_level: str) -> float:
    odds = float(c["odds"])
    prob = float(c["model_prob"])
    edge = float(c["edge_pct"])
    conf = float(c["confidence_score"])
    off = 4.0 if c.get("is_official") else 0.0
    if risk_level == "low":
        return prob * 100.0 + edge * 1.3 + off - max(0.0, odds - 2.35) * 14.0
    if risk_level == "high":
        return edge * 1.8 + min(odds, 4.5) * 6.5 + conf * 0.2 - max(0.0, 1.50 - odds) * 12.0
    if risk_level == "longshot":
        return edge * 1.6 + min(odds, 7.0) * 8.0 + prob * 15.0 - max(0.0, 1.80 - odds) * 14.0
    # medium (default)
    return edge * 1.6 + prob * 45.0 + conf * 0.25 + off * 0.5 - max(0.0, odds - 3.80) * 6.0


def build_custom_bets(
    conn: sqlite3.Connection,
    user: dict[str, Any],
    criteria: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build 1..5 custom single/accumulator bets matching user criteria while excluding already-bet legs."""
    cfg = criteria or {}
    bet_types_raw = cfg.get("bet_types") or ["ALL"]
    if isinstance(bet_types_raw, str):
        bet_types_raw = [bet_types_raw]
    bet_types_clean = [str(t).strip().upper() for t in bet_types_raw if str(t).strip()] or ["ALL"]
    allowed_markets = expand_bet_type_filters(bet_types_clean)

    risk_level = str(cfg.get("risk_level") or "medium").strip().lower()
    if risk_level not in ("low", "medium", "high", "longshot"):
        risk_level = "medium"

    try:
        legs_count = max(1, min(8, int(cfg.get("legs_count") or 4)))
    except (TypeError, ValueError):
        legs_count = 4
    try:
        num_bets = max(1, min(5, int(cfg.get("num_bets") or 1)))
    except (TypeError, ValueError):
        num_bets = 1

    div_filter = str(cfg.get("div") or "").strip()
    kickoff_filter = str(cfg.get("kickoff_filter") or "ALL").strip().upper()
    official_only = bool(cfg.get("official_only", False))
    exclude_already_bet = bool(cfg.get("exclude_already_bet", True))
    exclude_scope = str(cfg.get("exclude_scope") or "market_family").strip()
    if exclude_scope not in ("market_family", "fixture"):
        exclude_scope = "market_family"
    include_saved = bool(cfg.get("include_saved", True))
    include_slip = bool(cfg.get("include_slip", True))

    all_cands = _build_scored_candidates(conn, user)
    if not all_cands:
        return {
            "bets": [],
            "requested_bets": num_bets,
            "requested_legs": legs_count,
            "excluded_count": 0,
            "available_pool_count": 0,
            "notice": "No scheduled fixtures available yet — click Smart Sync Data first.",
        }

    excl_legs: list[dict[str, Any]] = []
    if exclude_already_bet:
        excl_legs.extend(
            get_user_already_bet_legs(
                conn, user, include_bets=True, include_saved=include_saved, include_slip=include_slip
            )
        )
        for cl in cfg.get("excluded_legs") or []:
            if isinstance(cl, dict):
                excl_legs.append(cl)
    excl_sets = _build_exclusion_sets(excl_legs)

    avoid_legs = [al for al in (cfg.get("avoid_legs") or []) if isinstance(al, dict)]
    avoid_sets = _build_exclusion_sets(avoid_legs)

    pref_leagues = set(user.get("preferred_leagues") or LEAGUES.keys())
    pool: list[dict[str, Any]] = []
    for c in all_cands:
        if c["market"] not in allowed_markets:
            continue
        if c["odds"] < 1.08 or c["odds"] > 10.0:
            continue
        if div_filter == "PREFERRED":
            if pref_leagues and c["div"] not in pref_leagues:
                continue
        elif div_filter in LEAGUES and c["div"] != div_filter:
            continue
        if not _matches_kickoff_filter(c, kickoff_filter):
            continue
        if official_only and not c.get("is_official"):
            continue
        if exclude_already_bet and _is_candidate_excluded(c, excl_sets, scope=exclude_scope):
            continue
        if avoid_legs and _is_candidate_excluded(c, avoid_sets, scope="market_family"):
            continue
        scored = dict(c)
        scored["_score"] = _score_candidate_for_risk(c, risk_level)
        pool.append(scored)

    pool.sort(key=lambda x: (x["_score"], x["edge_pct"], x["model_prob"]), reverse=True)
    dedup_excl_count = len(
        {
            f"{_canonical_match_key(l) or l.get('fixture_id')}:{l.get('market')}"
            for l in excl_legs
            if l.get("market")
        }
    )

    if not pool:
        return {
            "bets": [],
            "requested_bets": num_bets,
            "requested_legs": legs_count,
            "excluded_count": dedup_excl_count,
            "available_pool_count": 0,
            "notice": "No matching legs found for these criteria — try enabling more bet types, leagues, or turning off strict exclusions.",
        }

    default_stake = float(user.get("default_stake") or 10.0)
    stake_by_risk = {
        "low": round(max(5.0, default_stake), 2),
        "medium": round(default_stake, 2),
        "high": 5.0,
        "longshot": 2.0,
    }
    bet_stake = stake_by_risk[risk_level]
    risk_names = {
        "low": "Low Risk",
        "medium": "Balanced",
        "high": "High Risk",
        "longshot": "Longshot",
    }

    if "ALL" in bet_types_clean:
        bt_summary = "Mixed"
    elif len(bet_types_clean) <= 2:
        bt_summary = " + ".join(_CUSTOM_BET_TYPE_LABELS.get(t, t) for t in bet_types_clean)
    else:
        bt_summary = f"{len(bet_types_clean)} Bet Types"

    distinct_bet_type_keys = {market_bet_type(m)["key"] for m in allowed_markets}
    multi_type_mode = len(distinct_bet_type_keys) > 1 or len(allowed_markets) > 2

    def _cand_match_id(c: dict[str, Any]) -> str:
        return _canonical_match_key(c) or f"fid:{c['fixture_id']}"

    used_match_keys_all: set[str] = set()
    used_family_keys_all: set[tuple[str, str]] = set()
    for al in avoid_legs:
        mk = _canonical_match_key(al) or (f"fid:{al['fixture_id']}" if al.get("fixture_id") else "")
        if mk:
            used_match_keys_all.add(mk)
            used_family_keys_all.add((mk, _market_family(str(al.get("market") or ""))))

    built_bets: list[dict[str, Any]] = []
    notice = ""

    for b_idx in range(num_bets):
        picked: list[dict[str, Any]] = []
        used_this_bet: set[str] = set()
        type_counts: dict[str, int] = {}

        def _pick_next(allow_reused_fixture: bool) -> dict[str, Any] | None:
            best_c: dict[str, Any] | None = None
            best_adj = -1e18
            for c in pool:
                mk = _cand_match_id(c)
                fam = _market_family(c["market"])
                if mk in used_this_bet:
                    continue
                if (mk, fam) in used_family_keys_all:
                    continue
                if not allow_reused_fixture and mk in used_match_keys_all:
                    continue
                adj = c["_score"]
                if multi_type_mode:
                    adj -= type_counts.get(c["bet_type"], 0) * 4.5
                if adj > best_adj:
                    best_adj = adj
                    best_c = c
            return best_c

        while len(picked) < legs_count:
            nxt = _pick_next(allow_reused_fixture=False)
            if not nxt:
                break
            picked.append(nxt)
            mk = _cand_match_id(nxt)
            used_this_bet.add(mk)
            type_counts[nxt["bet_type"]] = type_counts.get(nxt["bet_type"], 0) + 1

        if len(picked) < legs_count and len(allowed_markets) > 1:
            while len(picked) < legs_count:
                nxt = _pick_next(allow_reused_fixture=True)
                if not nxt:
                    break
                picked.append(nxt)
                mk = _cand_match_id(nxt)
                used_this_bet.add(mk)
                type_counts[nxt["bet_type"]] = type_counts.get(nxt["bet_type"], 0) + 1

        if not picked:
            notice = (
                f"Stopped at {len(built_bets)} of {num_bets} requested bets — not enough unique fixtures left matching your criteria."
            )
            break
        if b_idx > 0 and len(picked) < legs_count:
            notice = (
                f"Built {len(built_bets)} full {legs_count}-leg bets (not enough unused matches left for bet #{b_idx + 1})."
            )
            break

        for leg in picked:
            mk = _cand_match_id(leg)
            used_match_keys_all.add(mk)
            used_family_keys_all.add((mk, _market_family(leg["market"])))

        fold_label = "Single" if len(picked) == 1 else f"{len(picked)}-Fold"
        title = f"{bt_summary} {fold_label} #{b_idx + 1}" if num_bets > 1 else f"{bt_summary} {fold_label}"
        subtitle = (
            f"{risk_names[risk_level]} • {len(picked)} {'leg' if len(picked) == 1 else 'legs'}"
            + (" • Excludes already-bet legs" if exclude_already_bet else "")
        )
        pkg = _build_suggestion_package(
            pkg_id=f"custom_{b_idx + 1}",
            risk_level=risk_level,
            title=title,
            badge=f"{risk_names[risk_level]} • {bt_summary}",
            subtitle=subtitle,
            legs=picked,
            stake=bet_stake,
            extra={
                "criteria": {
                    "bet_types": bet_types_clean,
                    "bet_type_summary": bt_summary,
                    "risk_level": risk_level,
                    "legs_count": legs_count,
                }
            },
            exclude_already_bet=exclude_already_bet,
        )
        built_bets.append(pkg)
        if b_idx == 0 and len(picked) < legs_count:
            notice = f"Only {len(picked)} distinct matches matched your criteria (requested {legs_count} legs)."

    return {
        "bets": built_bets,
        "requested_bets": num_bets,
        "requested_legs": legs_count,
        "excluded_count": dedup_excl_count,
        "available_pool_count": len(pool),
        "notice": notice,
    }
