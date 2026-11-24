"""Value Bet Finder, Kelly Staking, Acca Correlation Engine, Bet Settlement, and Telegram Alerts."""

from __future__ import annotations

import base64
import json
import math
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
from accalab.modeling import estimate_two_way_odds, extract_extended_goals_probs, score_matrix


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
    "DC_1X": "Double Chance",
    "DC_X2": "Double Chance",
    "OU_O15": "Goals Over/Under",
    "OU_U15": "Goals Over/Under",
    "OU_O25": "Goals Over/Under",
    "OU_U25": "Goals Over/Under",
    "OU_O35": "Goals Over/Under",
    "OU_U35": "Goals Over/Under",
    "TEAM_H_O15": "Team Total Goals",
    "TEAM_A_O15": "Team Total Goals",
    "BTTS_Y": "Both Teams to Score",
    "BTTS_N": "Both Teams to Score",
    "CORN_O75": "Corners",
    "CORN_O85": "Corners",
    "CORN_O95": "Corners",
    "CORN_O105": "Corners",
    "CORN_U105": "Corners",
    "CARD_O25": "Cards",
    "CARD_O35": "Cards",
    "CARD_O45": "Cards",
    "CARD_U35": "Cards",
}


def _bet365_selection_name(leg: dict[str, Any]) -> str:
    mkt = str(leg.get("market") or "")
    home = str(leg.get("home_team") or leg.get("selection_label") or "Home")
    away = str(leg.get("away_team") or leg.get("selection_label") or "Away")
    if mkt == "1X2_H":
        return home
    if mkt == "1X2_D":
        return "Draw"
    if mkt == "1X2_A":
        return away
    if mkt == "DC_1X":
        return f"{home} or Draw"
    if mkt == "DC_X2":
        return f"Draw or {away}"
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
    if mkt == "TEAM_H_O15":
        return f"{home} Over 1.5 Goals"
    if mkt == "TEAM_A_O15":
        return f"{away} Over 1.5 Goals"
    if mkt == "BTTS_Y":
        return "Yes"
    if mkt == "BTTS_N":
        return "No"
    if mkt == "CORN_O75":
        return "Over 7.5 Corners"
    if mkt == "CORN_O85":
        return "Over 8.5 Corners"
    if mkt == "CORN_O95":
        return "Over 9.5 Corners"
    if mkt == "CORN_O105":
        return "Over 10.5 Corners"
    if mkt == "CORN_U105":
        return "Under 10.5 Corners"
    if mkt == "CARD_O25":
        return "Over 2.5 Cards"
    if mkt == "CARD_O35":
        return "Over 3.5 Cards"
    if mkt == "CARD_O45":
        return "Over 4.5 Cards"
    if mkt == "CARD_U35":
        return "Under 3.5 Cards"
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
        default_mkt_name = "Bet Builder" if (mkt.startswith("BB_") or mkt.startswith("COMBO_")) else _BET365_MARKET_NAMES.get(mkt, "Full Time Result")
        b365_market = str(leg.get("b365_market_name") or default_mkt_name)
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
    if m.startswith("1X2_") or m.startswith("DC_"):
        return "1X2"
    if m.startswith("BTTS_"):
        return "BTTS"
    if m.startswith("OU_") or m.startswith("TEAM_"):
        return "OU"
    if m.startswith("CORN_"):
        return "CORN"
    if m.startswith("CARD_"):
        return "CARD"
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


# ---------------------------------------------------------------------------
# Same-Game Build a Bet (Bet Builder) Engine
# ---------------------------------------------------------------------------

_BB_STYLE_LABELS: dict[str, str] = {
    "safer": "🟢 Safer Builder",
    "goals_btts": "⚽ Goals & BTTS",
    "tight": "🛡️ Win to Nil / Tight",
    "corners_cards": "🚩 Corners & Cards",
    "high_odds": "🔥 High Odds",
}

_BB_RISK_ODDS_BANDS: dict[str, tuple[float, float]] = {
    "low": (1.8, 3.5),
    "medium": (3.0, 6.0),
    "high": (5.2, 11.5),
    "longshot": (9.5, 28.0),
}

_BB_SCORELINE_CODES: frozenset[str] = frozenset(
    {
        "1X2_H",
        "1X2_A",
        "1X2_D",
        "DC_1X",
        "DC_X2",
        "OU_O15",
        "OU_O25",
        "OU_O35",
        "OU_U25",
        "OU_U35",
        "TEAM_H_O15",
        "TEAM_A_O15",
        "BTTS_Y",
        "BTTS_N",
    }
)


def _scoreline_passes(code: str, x: int, y: int) -> bool:
    if code == "1X2_H":
        return x > y
    if code == "1X2_A":
        return y > x
    if code == "1X2_D":
        return x == y
    if code == "DC_1X":
        return x >= y
    if code == "DC_X2":
        return y >= x
    if code == "OU_O15":
        return x + y >= 2
    if code == "OU_O25":
        return x + y >= 3
    if code == "OU_O35":
        return x + y >= 4
    if code == "OU_U25":
        return x + y <= 2
    if code == "OU_U35":
        return x + y <= 3
    if code == "TEAM_H_O15":
        return x >= 2
    if code == "TEAM_A_O15":
        return y >= 2
    if code == "BTTS_Y":
        return x >= 1 and y >= 1
    if code == "BTTS_N":
        return x == 0 or y == 0
    return False


_SCORELINE_MASKS: dict[str, int] = {
    code: sum(
        1 << (x * 8 + y)
        for x in range(8)
        for y in range(8)
        if _scoreline_passes(code, x, y)
    )
    for code in _BB_SCORELINE_CODES
}
_ALL_SCORELINE_MASK: int = (1 << 64) - 1


def _poisson_le(rate: float, k: int) -> float:
    r = max(0.1, float(rate))
    term = math.exp(-r)
    cdf = term
    for i in range(1, max(0, k) + 1):
        term *= r / i
        cdf += term
    return max(0.01, min(0.99, cdf))


def _poisson_ge(rate: float, k: int) -> float:
    if k <= 0:
        return 0.99
    return max(0.01, min(0.99, 1.0 - _poisson_le(rate, k - 1)))


def compute_team_prop_averages(conn: sqlite3.Connection) -> dict[str, Any]:
    """Compute weighted corners and yellow cards averages by division and team from historical_matches."""
    rows = conn.execute(
        """
        SELECT div, season, home_team, away_team, hc, ac, hy, ay
        FROM historical_matches
        WHERE season IN ('2526', '2627')
          AND hc IS NOT NULL AND ac IS NOT NULL
          AND hy IS NOT NULL AND ay IS NOT NULL
        """
    ).fetchall()

    div_acc: dict[str, list[float]] = {}
    team_acc: dict[str, dict[str, Any]] = {}
    for r in rows:
        div = r["div"]
        w = 2.0 if str(r["season"]) == "2627" else 1.0
        hc, ac, hy, ay = float(r["hc"]), float(r["ac"]), float(r["hy"]), float(r["ay"])

        da = div_acc.setdefault(div, [0.0, 0.0, 0.0, 0.0, 0.0])
        da[0] += w * hc
        da[1] += w * ac
        da[2] += w * hy
        da[3] += w * ay
        da[4] += w

        for tm, cf, ca, yf, ya in (
            (r["home_team"], hc, ac, hy, ay),
            (r["away_team"], ac, hc, ay, hy),
        ):
            ta = team_acc.setdefault(
                tm, {"div": div, "cf": 0.0, "ca": 0.0, "yf": 0.0, "ya": 0.0, "w": 0.0}
            )
            ta["div"] = div
            ta["cf"] += w * cf
            ta["ca"] += w * ca
            ta["yf"] += w * yf
            ta["ya"] += w * ya
            ta["w"] += w

    div_avg: dict[str, dict[str, float]] = {}
    for div, (shc, sac, shy, say, sw) in div_acc.items():
        sw_s = max(1.0, sw)
        div_avg[div] = {
            "avg_hc": round(shc / sw_s, 2),
            "avg_ac": round(sac / sw_s, 2),
            "avg_hy": round(shy / sw_s, 2),
            "avg_ay": round(say / sw_s, 2),
            "avg_c_team": round(0.5 * (shc + sac) / sw_s, 2),
            "avg_y_team": round(0.5 * (shy + say) / sw_s, 2),
        }

    default_div = {
        "avg_hc": 5.45,
        "avg_ac": 4.65,
        "avg_hy": 1.72,
        "avg_ay": 2.03,
        "avg_c_team": 5.05,
        "avg_y_team": 1.88,
    }
    prior_n = 6.0
    teams: dict[str, dict[str, float]] = {}
    for tm, ta in team_acc.items():
        base = div_avg.get(ta["div"], default_div)
        w = float(ta["w"])
        denom = w + prior_n
        bc = base["avg_c_team"]
        by = base["avg_y_team"]
        teams[tm] = {
            "corners_for_pg": round((ta["cf"] + prior_n * bc) / denom, 2),
            "corners_against_pg": round((ta["ca"] + prior_n * bc) / denom, 2),
            "cards_for_pg": round((ta["yf"] + prior_n * by) / denom, 2),
            "cards_against_pg": round((ta["ya"] + prior_n * by) / denom, 2),
        }

    return {"div_avg": div_avg, "default_div": default_div, "teams": teams}


def estimate_fixture_props(row: dict[str, Any], prop_stats: dict[str, Any]) -> dict[str, float]:
    """Estimate expected corners and cards for an upcoming fixture from shrunk team averages."""
    div = str(row.get("div") or "")
    home = str(row.get("home_team") or "")
    away = str(row.get("away_team") or "")
    base = prop_stats.get("div_avg", {}).get(div) or prop_stats.get("default_div") or {
        "avg_hc": 5.45,
        "avg_ac": 4.65,
        "avg_hy": 1.72,
        "avg_ay": 2.03,
        "avg_c_team": 5.05,
        "avg_y_team": 1.88,
    }
    teams = prop_stats.get("teams", {})
    hr = teams.get(home) or {
        "corners_for_pg": base["avg_hc"],
        "corners_against_pg": base["avg_ac"],
        "cards_for_pg": base["avg_hy"],
        "cards_against_pg": base["avg_ay"],
    }
    ar = teams.get(away) or {
        "corners_for_pg": base["avg_ac"],
        "corners_against_pg": base["avg_hc"],
        "cards_for_pg": base["avg_ay"],
        "cards_against_pg": base["avg_hy"],
    }

    h_exp_c = 0.5 * (hr["corners_for_pg"] + ar["corners_against_pg"])
    a_exp_c = 0.5 * (ar["corners_for_pg"] + hr["corners_against_pg"])
    exp_corners = round(max(6.5, min(14.5, h_exp_c + a_exp_c)), 2)

    h_exp_y = 0.5 * (hr["cards_for_pg"] + ar["cards_against_pg"])
    a_exp_y = 0.5 * (ar["cards_for_pg"] + hr["cards_against_pg"])
    exp_cards = round(max(2.0, min(6.5, h_exp_y + a_exp_y)), 2)

    return {
        "exp_corners": exp_corners,
        "exp_cards": exp_cards,
        "h_corners_for": round(hr["corners_for_pg"], 1),
        "a_corners_for": round(ar["corners_for_pg"], 1),
        "h_cards_for": round(hr["cards_for_pg"], 1),
        "a_cards_for": round(ar["cards_for_pg"], 1),
    }


def _bb_anchor_ratio(row: dict[str, Any], s_legs: list[dict[str, Any]]) -> float:
    """Compute bounded ratio comparing fixture market prices to Dixon-Coles model probabilities."""
    ratios: list[float] = []
    h_o, d_o, a_o = row.get("b365h"), row.get("b365d"), row.get("b365a")
    fh = fd = fa = None
    if h_o and d_o and a_o:
        fh, fd, fa, _ = devig_three_way(h_o, d_o, a_o)

    o25, u25 = row.get("b365_over25"), row.get("b365_under25")
    fo = fu = None
    if o25 and u25:
        fo, fu, _ = devig_two_way(o25, u25)

    by, bn = row.get("b365_btts_yes"), row.get("b365_btts_no")
    fby = fbn = None
    if by and bn:
        fby, fbn, _ = devig_two_way(by, bn)

    for sl in s_legs:
        c = sl["market"]
        mp = max(0.03, float(sl["model_prob"]))
        if c == "1X2_H" and fh:
            ratios.append(fh / mp)
        elif c == "1X2_D" and fd:
            ratios.append(fd / mp)
        elif c == "1X2_A" and fa:
            ratios.append(fa / mp)
        elif c == "DC_1X" and fh and fd:
            ratios.append((fh + fd) / mp)
        elif c == "DC_X2" and fa and fd:
            ratios.append((fa + fd) / mp)
        elif c == "OU_O25" and fo:
            ratios.append(fo / mp)
        elif c == "OU_U25" and fu:
            ratios.append(fu / mp)
        elif c == "BTTS_Y" and fby:
            ratios.append(fby / mp)
        elif c == "BTTS_N" and fbn:
            ratios.append(fbn / mp)

    if not ratios:
        return 1.0
    avg = sum(ratios) / len(ratios)
    return max(0.86, min(1.12, avg))


def _bb_leg_catalog(
    row: dict[str, Any],
    props: dict[str, float],
    nz_cells: list[tuple[int, float]],
) -> dict[str, list[dict[str, Any]]]:
    """Construct lightweight scored leg stubs per Bet Builder category for a fixture."""
    home = str(row["home_team"])
    away = str(row["away_team"])
    exp_c = props["exp_corners"]
    exp_y = props["exp_cards"]

    def _mask_prob(code: str) -> float:
        m = _SCORELINE_MASKS[code]
        p = sum(prob for idx, prob in nz_cells if (m >> idx) & 1)
        return max(0.02, min(0.95, p))

    def _score_leg(cat: str, code: str, label: str) -> dict[str, Any]:
        mp = _mask_prob(code)
        bt_meta = market_bet_type(code)
        return {
            "category": cat,
            "market": code,
            "bet_type": bt_meta["key"],
            "bet_type_label": bt_meta["label"],
            "selection_label": label,
            "model_prob": round(mp, 5),
            "model_prob_pct": round(mp * 100.0, 1),
            "is_scoreline": True,
            "mask": _SCORELINE_MASKS[code],
        }

    def _prop_leg(cat: str, code: str, label: str, mp: float) -> dict[str, Any]:
        bt_meta = market_bet_type(code)
        return {
            "category": cat,
            "market": code,
            "bet_type": bt_meta["key"],
            "bet_type_label": bt_meta["label"],
            "selection_label": label,
            "model_prob": round(mp, 5),
            "model_prob_pct": round(mp * 100.0, 1),
            "is_scoreline": False,
            "mask": _ALL_SCORELINE_MASK,
        }

    result_legs = [
        _score_leg("result", "1X2_H", f"{home} Win"),
        _score_leg("result", "1X2_A", f"{away} Win"),
        _score_leg("result", "1X2_D", "Draw"),
        _score_leg("result", "DC_1X", f"{home} or Draw"),
        _score_leg("result", "DC_X2", f"Draw or {away}"),
    ]
    goals_legs = [
        _score_leg("goals", "OU_O15", "Over 1.5 Goals"),
        _score_leg("goals", "OU_O25", "Over 2.5 Goals"),
        _score_leg("goals", "OU_O35", "Over 3.5 Goals"),
        _score_leg("goals", "OU_U25", "Under 2.5 Goals"),
        _score_leg("goals", "OU_U35", "Under 3.5 Goals"),
        _score_leg("goals", "TEAM_H_O15", f"{home} Over 1.5 Goals"),
        _score_leg("goals", "TEAM_A_O15", f"{away} Over 1.5 Goals"),
    ]
    btts_legs = [
        _score_leg("btts", "BTTS_Y", "BTTS Yes"),
        _score_leg("btts", "BTTS_N", "BTTS No"),
    ]
    raw_corners = [
        ("CORN_O75", "Over 7.5 Corners", _poisson_ge(exp_c, 8)),
        ("CORN_O85", "Over 8.5 Corners", _poisson_ge(exp_c, 9)),
        ("CORN_O95", "Over 9.5 Corners", _poisson_ge(exp_c, 10)),
        ("CORN_O105", "Over 10.5 Corners", _poisson_ge(exp_c, 11)),
        ("CORN_U105", "Under 10.5 Corners", _poisson_le(exp_c, 10)),
    ]
    corners_legs = [
        _prop_leg("corners", c, lbl, p)
        for c, lbl, p in raw_corners
        if 0.16 <= p <= 0.84
    ]
    if not corners_legs:
        best_c = min(raw_corners, key=lambda it: abs(it[2] - 0.58))
        corners_legs = [_prop_leg("corners", best_c[0], best_c[1], best_c[2])]

    raw_cards = [
        ("CARD_O25", "Over 2.5 Cards", _poisson_ge(exp_y, 3)),
        ("CARD_O35", "Over 3.5 Cards", _poisson_ge(exp_y, 4)),
        ("CARD_O45", "Over 4.5 Cards", _poisson_ge(exp_y, 5)),
        ("CARD_U35", "Under 3.5 Cards", _poisson_le(exp_y, 3)),
    ]
    cards_legs = [
        _prop_leg("cards", c, lbl, p)
        for c, lbl, p in raw_cards
        if 0.16 <= p <= 0.84
    ]
    if not cards_legs:
        best_y = min(raw_cards, key=lambda it: abs(it[2] - 0.58))
        cards_legs = [_prop_leg("cards", best_y[0], best_y[1], best_y[2])]

    return {
        "result": [l for l in result_legs if 0.12 <= l["model_prob"] <= 0.88],
        "goals": [l for l in goals_legs if 0.14 <= l["model_prob"] <= 0.88],
        "btts": [l for l in btts_legs if 0.16 <= l["model_prob"] <= 0.84],
        "corners": corners_legs,
        "cards": cards_legs,
    }


def _materialize_bb_leg(
    row: dict[str, Any],
    props: dict[str, float],
    sl: dict[str, Any],
    bt_map: dict[tuple[str, str], dict[str, Any]],
    matched_news: list[dict[str, Any]],
) -> dict[str, Any]:
    """Attach detailed rationale, stats and Bet365 metadata ONLY to a selected Bet Builder sub-leg."""
    home = str(row["home_team"])
    away = str(row["away_team"])
    div = str(row["div"])
    league_name = LEAGUES.get(div, {}).get("name", div)
    lam = float(row.get("lambda_home") if row.get("lambda_home") is not None else 1.35)
    mu = float(row.get("mu_away") if row.get("mu_away") is not None else 1.15)
    h_elo = float(row.get("home_elo") or 1500.0)
    a_elo = float(row.get("away_elo") or 1500.0)
    h_form = row.get("home_form") or "N/A"
    a_form = row.get("away_form") or "N/A"
    code = sl["market"]
    label = sl["selection_label"]
    mp = float(sl["model_prob"])
    fair_o = round(1.0 / max(mp, 0.02), 2)

    if sl["is_scoreline"]:
        bt_grp = "1X2" if code.startswith(("1X2", "DC_")) else ("BTTS" if code.startswith("BTTS") else "O/U 2.5")
        bt = bt_map.get((div, bt_grp))
        trust = (
            "Backtest Proven"
            if (bt and bt["flat_roi_pct"] > 0 and bt["value_bets_count"] >= 10)
            else ("Positive CLV" if (bt and bt["avg_clv_pct"] > 0) else "Model Edge")
        )
        if code.startswith(("DC_", "TEAM_")):
            rsn = [
                f"Joint Scoreline Model: {label} hits in {mp*100:.1f}% of simulated scorelines (fair {decimal_to_fractional(fair_o)}).",
                f"Matchup & xG: Projected xG {lam:.2f}–{mu:.2f} ({home} {h_elo:.0f} vs {away} {a_elo:.0f} Elo).",
                f"Form (Last 6): {h_form} (H) vs {a_form} (A) • {trust}.",
            ]
            if matched_news:
                rsn.append(f"Team News: [{matched_news[0]['source']}] {matched_news[0]['title']}")
            r_stats: dict[str, Any] = {
                "xg_home": round(lam, 2),
                "xg_away": round(mu, 2),
                "total_xg": round(lam + mu, 2),
                "elo_home": round(h_elo),
                "elo_away": round(a_elo),
                "form_home": h_form,
                "form_away": a_form,
                "fair_odds": fair_o,
                "trust_badge": trust,
            }
        else:
            rsn, r_stats = _build_selection_reasons(
                row,
                code,
                label,
                mp,
                fair_o,
                0.0,
                bt,
                matched_news,
                "market_estimate",
                trust,
                include_empty_news_note=False,
            )
    else:
        exp_c = props["exp_corners"]
        exp_y = props["exp_cards"]
        if sl["category"] == "corners":
            rsn = [
                f"Corner Model: {label} projected at {mp*100:.1f}% (fair {decimal_to_fractional(fair_o)}) with {exp_c:.1f} expected match corners.",
                f"Team Corner Rates: {home} win {props['h_corners_for']:.1f}/g vs {away} {props['a_corners_for']:.1f}/g across recent 2025/26–26/27 matches.",
                f"Tempo Context: Projected {lam:.2f}–{mu:.2f} xG supports sustained final-third pressure.",
            ]
        else:
            rsn = [
                f"Discipline Model: {label} projected at {mp*100:.1f}% (fair {decimal_to_fractional(fair_o)}) with {exp_y:.1f} expected cards.",
                f"Team Booking Rates: {home} average {props['h_cards_for']:.1f} cards/g vs {away} {props['a_cards_for']:.1f} cards/g across recent league games.",
                f"Match Tension: Elo {h_elo:.0f} vs {a_elo:.0f} ({h_form} vs {a_form}).",
            ]
        r_stats = {
            "xg_home": round(lam, 2),
            "xg_away": round(mu, 2),
            "exp_corners": exp_c,
            "exp_cards": exp_y,
            "elo_home": round(h_elo),
            "elo_away": round(a_elo),
            "fair_odds": fair_o,
        }

    return {
        "fixture_id": row["id"],
        "div": div,
        "league_name": league_name,
        "match_date": row["match_date"],
        "kickoff_time": row.get("kickoff_time") or "",
        "home_team": home,
        "away_team": away,
        "category": sl["category"],
        "market": code,
        "bet_type": sl["bet_type"],
        "bet_type_label": sl["bet_type_label"],
        "selection_label": label,
        "model_prob": sl["model_prob"],
        "model_prob_pct": sl["model_prob_pct"],
        "odds": round(1.0 / max(mp, 0.05), 2),
        "b365_market_name": f"Bet Builder — {_BET365_MARKET_NAMES.get(code, 'Match Market')}",
        "reasons": rsn,
        "reason_stats": r_stats,
    }


def _materialize_bet_builder(
    row: dict[str, Any],
    props: dict[str, float],
    bt_map: dict[tuple[str, str], dict[str, Any]],
    matched_news: list[dict[str, Any]],
    cand: dict[str, Any],
    stake: float = 10.0,
    exclude_already_bet: bool = False,
) -> dict[str, Any]:
    """Expand a winning lightweight Bet Builder candidate into its full API representation."""
    lam = float(row.get("lambda_home") if row.get("lambda_home") is not None else 1.35)
    mu = float(row.get("mu_away") if row.get("mu_away") is not None else 1.15)
    h_elo = float(row.get("home_elo") or 1500.0)
    a_elo = float(row.get("away_elo") or 1500.0)
    h_form = row.get("home_form") or "N/A"
    a_form = row.get("away_form") or "N/A"
    div = str(row["div"])
    league_name = LEAGUES.get(div, {}).get("name", div)

    sorted_legs = cand["sorted_legs"]
    joint_prob = cand["joint_prob"]
    fair_odds = cand["fair_odds"]
    est_odds = cand["est_odds"]
    est_edge_pct = cand["est_edge_pct"]
    primary_style = cand["primary_style"]
    p_score = cand["p_score"]
    s_legs = [l for l in sorted_legs if l["is_scoreline"]]

    sel_label = " + ".join(l["selection_label"] for l in sorted_legs)
    indep_prob = 1.0
    for sl in s_legs:
        indep_prob *= float(sl["model_prob"])
    corr_note = ""
    if len(s_legs) >= 2 and indep_prob > 0:
        corr_diff = (p_score / indep_prob - 1.0) * 100.0
        if corr_diff >= 4.0:
            corr_note = f" (positive same-game correlation +{corr_diff:.0f}% vs naive multiply)"
        elif corr_diff <= -4.0:
            corr_note = f" (overlap-adjusted {corr_diff:.0f}% vs naive multiply)"

    bet_reasons = [
        f"Joint Scoreline & Prop Math: {round(joint_prob * 100.0, 1)}% true win chance (fair {decimal_to_fractional(fair_odds)}){corr_note} vs {decimal_to_fractional(est_odds)} est. Bet Builder price.",
        f"Match Script: Projected xG {lam:.2f}–{mu:.2f} • {row['home_team']} ({h_elo:.0f} Elo, {h_form}) vs {row['away_team']} ({a_elo:.0f} Elo, {a_form}).",
        f"Props Tempo: Expected {props['exp_corners']:.1f} corners ({props['h_corners_for']:.1f} + {props['a_corners_for']:.1f} for/g) & {props['exp_cards']:.1f} yellow cards ({props['h_cards_for']:.1f} + {props['a_cards_for']:.1f}/g).",
    ]
    if matched_news:
        bet_reasons.append(f"Team News: [{matched_news[0]['source']}] {matched_news[0]['title']}")
    if exclude_already_bet:
        bet_reasons.append("Duplicate Guard: Screened against your active placed, saved & slip selections on this fixture.")

    clean_sub_legs = [_materialize_bb_leg(row, props, l, bt_map, matched_news) for l in sorted_legs]
    reason_stats = {
        "xg_home": round(lam, 2),
        "xg_away": round(mu, 2),
        "total_xg": round(lam + mu, 2),
        "elo_home": round(h_elo),
        "elo_away": round(a_elo),
        "form_home": h_form,
        "form_away": a_form,
        "exp_corners": props["exp_corners"],
        "exp_cards": props["exp_cards"],
        "fair_odds": fair_odds,
        "trust_badge": _BB_STYLE_LABELS.get(primary_style, primary_style),
    }

    return {
        "id": f"bb_{row['id']}_{cand['combo_key']}",
        "fixture_id": row["id"],
        "div": div,
        "league_name": league_name,
        "match_date": row["match_date"],
        "kickoff_time": row.get("kickoff_time") or "",
        "home_team": row["home_team"],
        "away_team": row["away_team"],
        "combo_key": cand["combo_key"],
        "market": cand["combo_key"],
        "bet_type": "bet_builder",
        "bet_type_label": "Build a Bet",
        "selection_label": sel_label,
        "style": primary_style,
        "style_label": _BB_STYLE_LABELS.get(primary_style, "Build a Bet"),
        "style_tags": cand["style_tags"],
        "legs": clean_sub_legs,
        "legs_count": len(clean_sub_legs),
        "joint_prob": round(joint_prob, 5),
        "joint_prob_pct": round(joint_prob * 100.0, 1),
        "fair_odds": fair_odds,
        "fair_odds_fractional": decimal_to_fractional(fair_odds),
        "est_odds": est_odds,
        "odds": est_odds,
        "est_odds_fractional": decimal_to_fractional(est_odds),
        "est_edge_pct": est_edge_pct,
        "edge_pct": est_edge_pct,
        "confidence_score": cand["conf_score"],
        "odds_source": row.get("odds_source") or "market_estimate",
        "exp_corners": props["exp_corners"],
        "exp_cards": props["exp_cards"],
        "bet_reasons": bet_reasons,
        "reasons": bet_reasons,
        "reason_stats": reason_stats,
        "stake": round(stake, 2),
        "_rank": cand["_rank"],
        "_eff_score": cand["_eff_score"],
    }


def _is_builder_markets_excluded(
    row: dict[str, Any],
    combo_key: str,
    sub_markets: list[str],
    excl_sets: dict[str, set[Any]],
    scope: str = "market_family",
) -> bool:
    fid = row.get("id") if row.get("id") is not None else row.get("fixture_id")
    fid_int = int(fid) if fid is not None and str(fid).isdigit() else None
    mkey = _canonical_match_key(row)
    if scope == "fixture":
        if fid_int is not None and fid_int in excl_sets["fixture_ids"]:
            return True
        if mkey and mkey in excl_sets["match_keys"]:
            return True
        return False

    if fid_int is not None and (fid_int, combo_key) in excl_sets["exact_fid_mkts"]:
        return True
    if mkey and (mkey, combo_key) in excl_sets["exact_key_mkts"]:
        return True

    for sm in sub_markets:
        if _is_candidate_excluded({"fixture_id": fid_int, "match_date": row.get("match_date"), "home_team": row.get("home_team"), "away_team": row.get("away_team"), "market": sm}, excl_sets, scope="market_family"):
            return True

    sub_set = set(sub_markets)
    for ex_fid, ex_mkt in excl_sets["exact_fid_mkts"]:
        if fid_int is not None and ex_fid == fid_int and str(ex_mkt).startswith("BB_"):
            if sub_set & set(str(ex_mkt)[3:].split("+")):
                return True
    for ex_mk, ex_mkt in excl_sets["exact_key_mkts"]:
        if mkey and ex_mk == mkey and str(ex_mkt).startswith("BB_"):
            if sub_set & set(str(ex_mkt)[3:].split("+")):
                return True
    return False


def _generate_fixture_bet_builders(
    row: dict[str, Any],
    prop_stats: dict[str, Any],
    bt_map: dict[tuple[str, str], dict[str, Any]],
    matched_news: list[dict[str, Any]],
    categories: list[str] | None = None,
    legs_count: int | None = None,
    exclude_already_bet: bool = False,
    stake: float = 10.0,
    style_filter: str = "",
    risk_scorer: Any | None = None,
    excl_sets: dict[str, set[Any]] | None = None,
    exclude_scope: str = "market_family",
    avoid_keys: set[str] | None = None,
    top_k: int | None = None,
    diverse_styles: bool = False,
) -> list[dict[str, Any]]:
    """Generate correlation-aware Same-Game Bet Builders via two-phase score-then-materialize."""
    if excl_sets is not None and exclude_scope == "fixture":
        if _is_builder_markets_excluded(row, "", [], excl_sets, scope="fixture"):
            return []

    lam = float(row.get("lambda_home") if row.get("lambda_home") is not None else 1.35)
    mu = float(row.get("mu_away") if row.get("mu_away") is not None else 1.15)
    rho = float(row.get("rho") if row.get("rho") is not None else -0.04)
    mat = score_matrix(lam, mu, rho, max_goals=7)
    nz_cells = [(x * 8 + y, mat[x][y]) for x in range(8) for y in range(8) if mat[x][y] > 1e-5]
    props = estimate_fixture_props(row, prop_stats)
    catalog = _bb_leg_catalog(row, props, nz_cells)

    valid_cats = ["result", "goals", "btts", "corners", "cards"]
    active_cats = [c for c in (categories or valid_cats) if c in valid_cats and catalog.get(c)]
    if len(active_cats) < 2:
        return []

    target_sizes = [legs_count] if legs_count and 2 <= legs_count <= len(active_cats) else [2, 3, 4]
    if categories is None:
        catalog["corners"] = sorted(catalog["corners"], key=lambda l: abs(l["model_prob"] - 0.58))[:3]
        catalog["cards"] = sorted(catalog["cards"], key=lambda l: abs(l["model_prob"] - 0.58))[:2]

    h_elo = float(row.get("home_elo") or 1500.0)
    a_elo = float(row.get("away_elo") or 1500.0)
    align_bonus = 5.0 if abs(h_elo - a_elo) >= 45 else 0.0
    fid = row["id"]

    # Pre-cache devigged market prices once per fixture
    h_o, d_o, a_o = row.get("b365h"), row.get("b365d"), row.get("b365a")
    fh = fd = fa = None
    if h_o and d_o and a_o:
        fh, fd, fa, _ = devig_three_way(h_o, d_o, a_o)
    o25, u25 = row.get("b365_over25"), row.get("b365_under25")
    fo = fu = None
    if o25 and u25:
        fo, fu, _ = devig_two_way(o25, u25)
    by, bn = row.get("b365_btts_yes"), row.get("b365_btts_no")
    fby = fbn = None
    if by and bn:
        fby, fbn, _ = devig_two_way(by, bn)

    def _fast_anchor(s_legs: list[dict[str, Any]]) -> float:
        ratios: list[float] = []
        for sl in s_legs:
            c = sl["market"]
            mp = max(0.03, float(sl["model_prob"]))
            if c == "1X2_H" and fh:
                ratios.append(fh / mp)
            elif c == "1X2_D" and fd:
                ratios.append(fd / mp)
            elif c == "1X2_A" and fa:
                ratios.append(fa / mp)
            elif c == "DC_1X" and fh and fd:
                ratios.append((fh + fd) / mp)
            elif c == "DC_X2" and fa and fd:
                ratios.append((fa + fd) / mp)
            elif c == "OU_O25" and fo:
                ratios.append(fo / mp)
            elif c == "OU_U25" and fu:
                ratios.append(fu / mp)
            elif c == "BTTS_Y" and fby:
                ratios.append(fby / mp)
            elif c == "BTTS_N" and fbn:
                ratios.append(fbn / mp)
        if not ratios:
            return 1.0
        return max(0.86, min(1.12, sum(ratios) / len(ratios)))

    from itertools import combinations, product

    clean_style = str(style_filter or "").strip().lower()
    if clean_style in ("", "all"):
        clean_style = ""

    # Factor independent scoreline subsets (result, goals, btts) from prop subsets (corners, cards)
    score_cats = [c for c in ("result", "goals", "btts") if c in active_cats]
    prop_cats = [c for c in ("corners", "cards") if c in active_cats]

    # Build score_by_len[k_s] where each item = (s_legs, s_mkts, p_score, anchor, s_tags, s_key)
    score_by_len: dict[int, list[tuple[list[dict[str, Any]], set[str], float, float, set[str], str]]] = {
        0: [([], set(), 1.0, 1.0, set(), "")]
    }
    max_s = min(len(score_cats), max(target_sizes))
    for k_s in range(1, max_s + 1):
        bucket: list[tuple[list[dict[str, Any]], set[str], float, float, set[str], str]] = []
        for cat_tup in combinations(score_cats, k_s):
            for s_tup in product(*(catalog[c] for c in cat_tup)):
                s_legs = list(s_tup)
                mkts = {l["market"] for l in s_legs}
                if ("1X2_H" in mkts or "DC_1X" in mkts) and "TEAM_A_O15" in mkts:
                    continue
                if ("1X2_A" in mkts or "DC_X2" in mkts) and "TEAM_H_O15" in mkts:
                    continue
                comb_mask = _ALL_SCORELINE_MASK
                for sl in s_legs:
                    comb_mask &= sl["mask"]
                p_score = sum(prob for idx, prob in nz_cells if (comb_mask >> idx) & 1)
                if p_score < 0.05:
                    continue
                if k_s >= 2:
                    redundant = False
                    for idx in range(k_s):
                        other_mask = _ALL_SCORELINE_MASK
                        for j in range(k_s):
                            if j != idx:
                                other_mask &= s_legs[j]["mask"]
                        p_without = sum(prob for cell_idx, prob in nz_cells if (other_mask >> cell_idx) & 1)
                        if p_score > 0.94 * p_without:
                            redundant = True
                            break
                    if redundant:
                        continue
                anchor = _fast_anchor(s_legs)
                s_tags: set[str] = set()
                if ("BTTS_Y" in mkts or "OU_O25" in mkts or "OU_O35" in mkts) and "BTTS_N" not in mkts:
                    s_tags.add("goals_btts")
                if "BTTS_N" in mkts or "OU_U25" in mkts or "OU_U35" in mkts:
                    s_tags.add("tight")
                s_key = "+".join(l["market"] for l in s_legs)
                bucket.append((s_legs, mkts, p_score, anchor, s_tags, s_key))
        if bucket:
            score_by_len[k_s] = bucket

    # Build prop_by_len[k_p] where each item = (p_legs, p_props, p_key)
    prop_by_len: dict[int, list[tuple[list[dict[str, Any]], float, str]]] = {0: [([], 1.0, "")]}
    max_p = min(len(prop_cats), max(target_sizes))
    for k_p in range(1, max_p + 1):
        pbucket: list[tuple[list[dict[str, Any]], float, str]] = []
        for cat_tup in combinations(prop_cats, k_p):
            for p_tup in product(*(catalog[c] for c in cat_tup)):
                p_legs = list(p_tup)
                p_props = 1.0
                for pl in p_legs:
                    p_props *= float(pl["model_prob"])
                p_key = "+".join(l["market"] for l in p_legs)
                pbucket.append((p_legs, p_props, p_key))
        if pbucket:
            prop_by_len[k_p] = pbucket

    lightweight: list[dict[str, Any]] = []
    for n_legs in target_sizes:
        if n_legs > len(active_cats):
            continue
        margin = 1.075 + 0.015 * max(0, n_legs - 2)
        len_bonus = 4.0 if n_legs in (2, 3) else 0.0
        len_pen = max(0, n_legs - 3) * 3.0
        for k_s, s_bucket in score_by_len.items():
            k_p = n_legs - k_s
            p_bucket = prop_by_len.get(k_p)
            if not p_bucket:
                continue
            for s_legs, _mkts, p_score, anchor, s_tags, s_key in s_bucket:
                for p_legs, p_props, p_key in p_bucket:
                    joint_prob = p_score * p_props
                    if joint_prob < 0.03:
                        joint_prob = 0.03
                    elif joint_prob > 0.62:
                        continue

                    if s_key and p_key:
                        combo_key = f"BB_{s_key}+{p_key}"
                    elif s_key:
                        combo_key = f"BB_{s_key}"
                    else:
                        combo_key = f"BB_{p_key}"

                    sorted_legs = s_legs + p_legs
                    if avoid_keys and (combo_key in avoid_keys or f"{fid}:{combo_key}" in avoid_keys):
                        continue
                    if excl_sets is not None and _is_builder_markets_excluded(
                        row, combo_key, [l["market"] for l in sorted_legs], excl_sets, scope=exclude_scope
                    ):
                        continue

                    fair_odds = round(1.0 / joint_prob, 2)
                    mkt_joint_prob = max(0.025, min(0.90, joint_prob * anchor))
                    est_odds = round(max(1.30, 1.0 / (mkt_joint_prob * margin)), 2)
                    est_edge_pct = round((joint_prob * est_odds - 1.0) * 100.0, 1)

                    tags = set(s_tags)
                    if est_odds <= 3.6 and joint_prob >= 0.27:
                        tags.add("safer")
                    if k_p > 0:
                        tags.add("corners_cards")
                    if est_odds >= 5.5:
                        tags.add("high_odds")

                    if "high_odds" in tags and est_odds >= 6.5:
                        primary_style = "high_odds"
                    elif k_p > 0 and (k_p == 2 or k_s == 0 or "safer" not in tags):
                        primary_style = "corners_cards"
                    elif "tight" in tags:
                        primary_style = "tight"
                    elif "safer" in tags and n_legs <= 3:
                        primary_style = "safer"
                    elif "goals_btts" in tags:
                        primary_style = "goals_btts"
                    elif k_p > 0:
                        primary_style = "corners_cards"
                    else:
                        primary_style = "safer" if est_odds <= 4.0 else "high_odds"

                    if clean_style and primary_style != clean_style and clean_style not in tags:
                        continue

                    prob_sweet = max(0.0, 1.0 - abs(joint_prob - 0.28) * 1.35)
                    anchor_bonus = max(-4.0, min(8.0, (est_edge_pct + 7.5) * 0.6))
                    raw_conf = 48.0 + prob_sweet * 22.0 + joint_prob * 25.0 + align_bonus + anchor_bonus - len_pen
                    conf_score = int(max(46, min(95, round(raw_conf))))
                    rank_score = conf_score + est_edge_pct * 0.9 + len_bonus
                    if primary_style == "safer":
                        rank_score += joint_prob * 18.0

                    stub = {
                        "sorted_legs": sorted_legs,
                        "combo_key": combo_key,
                        "joint_prob": joint_prob,
                        "fair_odds": fair_odds,
                        "est_odds": est_odds,
                        "est_edge_pct": est_edge_pct,
                        "primary_style": primary_style,
                        "style_tags": sorted(tags),
                        "conf_score": conf_score,
                        "p_score": p_score,
                        "_rank": round(rank_score, 3),
                    }
                    stub["_eff_score"] = risk_scorer(stub) if risk_scorer else stub["_rank"]
                    lightweight.append(stub)

    if not lightweight:
        return []

    lightweight.sort(key=lambda x: (x["_eff_score"], x["conf_score"], x["joint_prob"]), reverse=True)

    winners: list[dict[str, Any]]
    if diverse_styles:
        winners = []
        used_styles: set[str] = set()
        limit_k = top_k or (1 if clean_style else 2)
        for c in lightweight:
            st = clean_style or c["primary_style"]
            if not winners or (c["primary_style"] not in used_styles and c["combo_key"] != winners[0]["combo_key"]):
                winners.append(c)
                used_styles.add(st)
            if len(winners) >= limit_k:
                break
    elif top_k:
        winners = lightweight[:top_k]
    else:
        winners = lightweight

    return [
        _materialize_bet_builder(
            row,
            props,
            bt_map,
            matched_news,
            w,
            stake=stake,
            exclude_already_bet=exclude_already_bet,
        )
        for w in winners
    ]


def _is_builder_excluded(
    builder: dict[str, Any],
    excl_sets: dict[str, set[Any]],
    scope: str = "market_family",
) -> bool:
    return _is_builder_markets_excluded(
        builder,
        str(builder.get("combo_key") or builder.get("market") or "").strip(),
        [str(sl.get("market") or "") for sl in builder.get("legs") or []],
        excl_sets,
        scope=scope,
    )


def _load_fixture_rows_with_context(
    conn: sqlite3.Connection,
    div_filter: str | None = None,
) -> tuple[list[dict[str, Any]], dict[tuple[str, str], dict[str, Any]], dict[str, list[dict[str, Any]]], dict[str, Any]]:
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
    sql += " ORDER BY f.match_date ASC, f.kickoff_time ASC"

    raw_rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    rows = [r for r in raw_rows if is_fixture_upcoming(r)] or raw_rows

    bt_map: dict[tuple[str, str], dict[str, Any]] = {
        (b["div"], b["market"]): dict(b)
        for b in conn.execute("SELECT * FROM backtest_results").fetchall()
    }
    news_by_team: dict[str, list[dict[str, Any]]] = {}
    for nr in conn.execute("SELECT title, source, url, matched_teams_json FROM news_items ORDER BY published_at DESC LIMIT 80").fetchall():
        nd = dict(nr)
        for team in json.loads(nd.get("matched_teams_json") or "[]"):
            news_by_team.setdefault(team, []).append(nd)
    prop_stats = compute_team_prop_averages(conn)
    return rows, bt_map, news_by_team, prop_stats


def find_bet_builder_tips(
    conn: sqlite3.Connection,
    user: dict[str, Any],
    div_filter: str | None = None,
    style_filter: str | None = None,
    limit: int = 36,
) -> list[dict[str, Any]]:
    """Curate top Same-Game Bet Builder tips across upcoming fixtures with diversity per fixture/style."""
    rows, bt_map, news_by_team, prop_stats = _load_fixture_rows_with_context(conn, div_filter=div_filter)
    if not rows:
        return []

    clean_style = str(style_filter or "").strip().lower()
    if clean_style in ("", "all"):
        clean_style = ""

    stake = float(user.get("default_stake") or 10.0)
    per_fixture_selected: list[dict[str, Any]] = []

    for r in rows:
        matched_news = (news_by_team.get(r["home_team"], []) + news_by_team.get(r["away_team"], []))[:1]
        chosen = _generate_fixture_bet_builders(
            r,
            prop_stats,
            bt_map,
            matched_news,
            exclude_already_bet=False,
            stake=stake,
            style_filter=clean_style,
            top_k=(1 if clean_style else 2),
            diverse_styles=True,
        )
        per_fixture_selected.extend(chosen)

    per_fixture_selected.sort(
        key=lambda x: (x.get("_eff_score", x.get("_rank", 0)), x["confidence_score"], x["joint_prob"]),
        reverse=True,
    )
    out: list[dict[str, Any]] = []
    for item in per_fixture_selected[:limit]:
        item.pop("_rank", None)
        item.pop("_eff_score", None)
        out.append(item)
    return out


def build_custom_bet_builders(
    conn: sqlite3.Connection,
    user: dict[str, Any],
    criteria: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build 1..5 custom Same-Game Bet Builders tailored to fixture, categories, leg count & risk tier."""
    cfg = criteria or {}
    fixture_id_raw = cfg.get("fixture_id")
    fixture_id = int(fixture_id_raw) if fixture_id_raw not in (None, "", "AUTO") else None

    raw_cats = cfg.get("categories") or ["result", "goals", "btts", "corners", "cards"]
    valid_cats = ("result", "goals", "btts", "corners", "cards")
    categories = [str(c).strip().lower() for c in raw_cats if str(c).strip().lower() in valid_cats]
    if not categories:
        categories = list(valid_cats)

    risk_raw = str(cfg.get("risk_level") or "medium").strip().lower()
    risk_level = risk_raw if risk_raw in _BB_RISK_ODDS_BANDS else "medium"
    target_lo, target_hi = _BB_RISK_ODDS_BANDS[risk_level]

    legs_count = max(2, min(5, int(cfg.get("legs_count") or 3)))
    num_bets = max(1, min(5, int(cfg.get("num_bets") or 1)))
    div_filter = str(cfg.get("div") or "").strip()
    kickoff_filter = str(cfg.get("kickoff_filter") or "ALL").strip().upper()
    exclude_already_bet = bool(cfg.get("exclude_already_bet", True))
    exclude_scope = "fixture" if cfg.get("exclude_scope") == "fixture" else "market_family"
    include_saved = bool(cfg.get("include_saved", True))
    include_slip = bool(cfg.get("include_slip", True))
    avoid_combo_keys = {str(x) for x in (cfg.get("avoid_combo_keys") or []) if x}
    avoid_fixture_ids = {int(x) for x in (cfg.get("avoid_fixture_ids") or []) if str(x).isdigit()}

    default_stake = float(user.get("default_stake") or 10.0)
    stake_by_risk = {"low": max(5.0, default_stake), "medium": default_stake, "high": 5.0, "longshot": 2.0}
    bet_stake = round(stake_by_risk[risk_level], 2)

    if len(categories) < 2:
        return {
            "builders": [],
            "requested_bets": num_bets,
            "requested_legs": legs_count,
            "excluded_count": 0,
            "available_fixtures": 0,
            "notice": "Select at least 2 Bet Builder market categories (e.g. Result + Goals or Corners).",
        }

    eff_legs = min(legs_count, len(categories))
    notice = ""
    if eff_legs < legs_count:
        notice = f"Adjusted to {eff_legs} legs per builder because {len(categories)} market categories are selected."

    rows, bt_map, news_by_team, prop_stats = _load_fixture_rows_with_context(
        conn, div_filter=(div_filter if div_filter in LEAGUES else None)
    )
    pref_leagues = set(user.get("preferred_leagues") or LEAGUES.keys())
    if fixture_id is not None:
        rows = [r for r in rows if int(r["id"]) == fixture_id]
    else:
        filtered_rows = []
        for r in rows:
            if div_filter == "PREFERRED" and pref_leagues and r["div"] not in pref_leagues:
                continue
            if not _matches_kickoff_filter(r, kickoff_filter):
                continue
            filtered_rows.append(r)
        rows = filtered_rows

    if not rows:
        return {
            "builders": [],
            "requested_bets": num_bets,
            "requested_legs": eff_legs,
            "excluded_count": 0,
            "available_fixtures": 0,
            "notice": "No upcoming matches found for these league / kickoff filters.",
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
    dedup_excl_count = len(
        {f"{_canonical_match_key(l) or l.get('fixture_id')}:{l.get('market')}" for l in excl_legs if l.get("market")}
    )

    mid_odds = math.sqrt(target_lo * target_hi)

    def _score_for_risk(b: dict[str, Any]) -> float:
        o = float(b["est_odds"])
        in_band = target_lo <= o <= target_hi
        dist = abs(math.log(max(o, 1.05) / mid_odds))
        band_bonus = 18.0 if in_band else -dist * 22.0
        return b["_rank"] + band_bonus - dist * 6.0

    built: list[dict[str, Any]] = []
    active_excl = excl_sets if exclude_already_bet else None

    if fixture_id is not None:
        r = rows[0]
        matched_news = (news_by_team.get(r["home_team"], []) + news_by_team.get(r["away_team"], []))[:1]
        cands = _generate_fixture_bet_builders(
            r,
            prop_stats,
            bt_map,
            matched_news,
            categories=categories,
            legs_count=eff_legs,
            exclude_already_bet=exclude_already_bet,
            stake=bet_stake,
            risk_scorer=_score_for_risk,
            excl_sets=active_excl,
            exclude_scope=exclude_scope,
            avoid_keys=avoid_combo_keys,
            top_k=num_bets,
        )
        for c in cands[:num_bets]:
            c.pop("_rank", None)
            c.pop("_eff_score", None)
            c["risk_level"] = risk_level
            built.append(c)
        if not built:
            notice = notice or "No non-conflicting Bet Builder combos matched your selected categories on this fixture."
    else:
        all_candidates: list[dict[str, Any]] = []
        for r in rows:
            if int(r["id"]) in avoid_fixture_ids:
                continue
            matched_news = (news_by_team.get(r["home_team"], []) + news_by_team.get(r["away_team"], []))[:1]
            cands = _generate_fixture_bet_builders(
                r,
                prop_stats,
                bt_map,
                matched_news,
                categories=categories,
                legs_count=eff_legs,
                exclude_already_bet=exclude_already_bet,
                stake=bet_stake,
                risk_scorer=_score_for_risk,
                excl_sets=active_excl,
                exclude_scope=exclude_scope,
                top_k=1,
            )
            if cands:
                all_candidates.append(cands[0])

        all_candidates.sort(key=lambda x: x.get("_eff_score", x.get("_rank", 0)), reverse=True)
        for c in all_candidates[:num_bets]:
            c.pop("_rank", None)
            c.pop("_eff_score", None)
            c["risk_level"] = risk_level
            built.append(c)
        if len(built) < num_bets and not notice:
            notice = f"Built {len(built)} of {num_bets} requested Build a Bets across available non-excluded matches."

    return {
        "builders": built,
        "requested_bets": num_bets,
        "requested_legs": eff_legs,
        "excluded_count": dedup_excl_count,
        "available_fixtures": len(rows),
        "notice": notice,
    }
