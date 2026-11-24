"""Horse racing value finder, UK multiples calculator (Trixie/Patent/Yankee/Lucky 15), and Bet365 handoff."""

from __future__ import annotations

import itertools
import json
import sqlite3
import urllib.parse
from datetime import date, datetime, timedelta, timezone
from typing import Any

from accalab.config import RACING_REGIONS
from accalab.racing_ingest import _is_uk_bst, normalize_course_slug
from accalab.racing_model import _fmt_uk_odds_text, uk_place_terms

RACING_MULTIPLES: dict[str, dict[str, Any]] = {
    "single": {"label": "Single", "folds": [1], "min_legs": 1, "max_legs": 1},
    "double": {"label": "Double", "folds": [2], "min_legs": 2, "max_legs": 2},
    "treble": {"label": "Treble", "folds": [3], "min_legs": 3, "max_legs": 3},
    "acca": {"label": "Accumulator", "folds": None, "min_legs": 2, "max_legs": 6},
    "trixie": {"label": "Trixie (3 Picks • 4 Bets)", "folds": [2, 3], "min_legs": 3, "max_legs": 3},
    "patent": {"label": "Patent (3 Picks • 7 Bets)", "folds": [1, 2, 3], "min_legs": 3, "max_legs": 3},
    "yankee": {"label": "Yankee (4 Picks • 11 Bets)", "folds": [2, 3, 4], "min_legs": 4, "max_legs": 4},
    "lucky15": {"label": "Lucky 15 (4 Picks • 15 Bets)", "folds": [1, 2, 3, 4], "min_legs": 4, "max_legs": 4},
}


def _uk_now() -> datetime:
    dt_utc = datetime.now(timezone.utc)
    return dt_utc + (timedelta(hours=1) if _is_uk_bst(dt_utc) else timedelta(0))


def is_race_upcoming(race: dict[str, Any], now_uk: datetime | None = None) -> bool:
    """Return True if a race is upcoming relative to current UK local time and not settled."""
    if str(race.get("status") or "").lower() == "result":
        return False
    ref = now_uk or _uk_now()
    today_iso = ref.strftime("%Y-%m-%d")
    now_hhmm = ref.strftime("%H:%M")
    r_date = str(race.get("race_date") or "").strip()
    if not r_date:
        return True
    if r_date > today_iso:
        return True
    if r_date < today_iso:
        return False
    off_time = str(race.get("off_time") or "").strip()
    if not off_time:
        return True
    return off_time > now_hhmm


def _prob_at_least_k(probs: list[float], k: int) -> float:
    """Exact Poisson-Binomial probability that at least k independent selections succeed."""
    if k <= 0:
        return 1.0
    n = len(probs)
    if k > n:
        return 0.0
    dp = [1.0] + [0.0] * n
    for p in probs:
        clamped = max(0.0, min(1.0, float(p)))
        nxt = [0.0] * (n + 1)
        for c in range(n + 1):
            nxt[c] += dp[c] * (1.0 - clamped)
            if c + 1 <= n:
                nxt[c + 1] += dp[c] * clamped
        dp = nxt
    return sum(dp[k:])


def _normalize_leg(leg: dict[str, Any]) -> dict[str, Any]:
    win_odds = float(leg.get("win_odds") or leg.get("odds") or 2.0)
    win_odds = max(1.02, win_odds)
    pf = float(leg.get("place_fraction") or 0.0)
    ew_eligible = bool(leg.get("ew_eligible")) if "ew_eligible" in leg else pf > 0
    if not ew_eligible:
        pf = 0.0
    place_odds = float(leg.get("place_odds") or (1.0 + (win_odds - 1.0) * pf if pf > 0 else 1.0))
    if str(leg.get("market") or "").upper() == "R_PLC" and leg.get("odds") and not leg.get("place_odds"):
        place_odds = max(1.02, float(leg["odds"]))

    win_prob = float(leg.get("model_win_prob") if leg.get("model_win_prob") is not None else leg.get("model_prob") or 0.25)
    if win_prob > 1.0:
        win_prob /= 100.0
    win_prob = max(0.004, min(0.95, win_prob))

    place_prob = float(leg.get("model_place_prob") if leg.get("model_place_prob") is not None else min(0.96, win_prob * 2.4))
    if place_prob > 1.0:
        place_prob /= 100.0
    place_prob = max(win_prob, min(0.98, place_prob))

    return {
        **leg,
        "win_odds": round(win_odds, 2),
        "place_odds": round(place_odds, 3),
        "place_fraction": pf,
        "ew_eligible": ew_eligible,
        "model_win_prob": win_prob,
        "model_place_prob": place_prob,
    }


def evaluate_racing_multiple(
    legs: list[dict[str, Any]],
    structure: str = "acca",
    each_way: bool = False,
    unit_stake: float = 1.0,
) -> dict[str, Any]:
    """Compute exact UK multiple permutations, total stake, max/place returns, and expected value."""
    struct_key = str(structure or "acca").strip().lower()
    if struct_key not in RACING_MULTIPLES:
        struct_key = "acca"
    spec = RACING_MULTIPLES[struct_key]
    clean_unit = round(max(0.1, float(unit_stake or 1.0)), 2)
    norm_legs = [_normalize_leg(l) for l in (legs or [])]
    n = len(norm_legs)

    if n == 0:
        return {
            "structure": struct_key,
            "structure_label": spec["label"],
            "each_way": bool(each_way),
            "unit_stake": clean_unit,
            "leg_count": 0,
            "base_lines": 0,
            "total_bets": 0,
            "total_stake": 0.0,
            "max_return": 0.0,
            "all_place_return": 0.0,
            "expected_return": 0.0,
            "expected_profit": 0.0,
            "expected_value_pct": 0.0,
            "prob_all_win_pct": 0.0,
            "prob_all_place_pct": 0.0,
            "prob_any_return_pct": 0.0,
            "breakdown": [],
            "warnings": ["Select at least one runner to evaluate."],
        }

    # Resolve fold list cleanly based on chosen structure and current leg count
    folds = list(spec["folds"]) if spec["folds"] is not None else [max(1, n)]
    if struct_key != "acca":
        folds = [f for f in folds if f <= n]
        if not folds:
            folds = [n]

    warnings: list[str] = []
    if n < spec["min_legs"]:
        warnings.append(f"{spec['label']} normally uses {spec['min_legs']} picks ({n} currently selected).")
    elif n > spec["max_legs"]:
        warnings.append(f"{spec['label']} takes {spec['max_legs']} picks — currently evaluating all {n} picks.")

    by_race: dict[str, list[str]] = {}
    win_only_count = 0
    for lg in norm_legs:
        rk = str(lg.get("race_id") or f"{lg.get('race_date')}|{lg.get('course')}|{lg.get('off_time')}")
        by_race.setdefault(rk, []).append(str(lg.get("horse_name") or "Runner"))
        if each_way and not lg["ew_eligible"]:
            win_only_count += 1
    for rk, horses in by_race.items():
        if len(horses) > 1:
            warnings.append(
                f"Same-race conflict ({', '.join(horses)}): two horses cannot both win the same race in a multiple."
            )
    if win_only_count > 0:
        warnings.append(
            f"{win_only_count} leg(s) are in <5 runner races (Win Only under UK rules — Each-Way place payout reduced)."
        )

    all_place_only = not each_way and all(str(l.get("market") or "").upper() == "R_PLC" for l in norm_legs)

    base_lines = 0
    max_return = 0.0
    all_place_return = 0.0
    expected_return = 0.0
    breakdown: list[dict[str, Any]] = []

    fold_names = {1: "Singles", 2: "Doubles", 3: "Trebles", 4: "4-Folds", 5: "5-Folds", 6: "6-Folds"}

    for f_size in folds:
        combos = list(itertools.combinations(norm_legs, f_size))
        line_cnt = len(combos)
        base_lines += line_cnt
        fold_max = 0.0
        fold_plc_only = 0.0
        fold_exp = 0.0

        for combo in combos:
            win_odds_prod = 1.0
            win_prob_prod = 1.0
            plc_odds_prod = 1.0
            plc_prob_prod = 1.0
            single_plc_mode_odds = 1.0
            single_plc_mode_prob = 1.0
            for c_leg in combo:
                win_odds_prod *= c_leg["win_odds"]
                win_prob_prod *= c_leg["model_win_prob"]
                plc_odds_prod *= c_leg["place_odds"]
                plc_prob_prod *= c_leg["model_place_prob"]
                if str(c_leg.get("market") or "").upper() == "R_PLC":
                    single_plc_mode_odds *= c_leg["place_odds"]
                    single_plc_mode_prob *= c_leg["model_place_prob"]
                else:
                    single_plc_mode_odds *= c_leg["win_odds"]
                    single_plc_mode_prob *= c_leg["model_win_prob"]

            if each_way:
                fold_max += clean_unit * (win_odds_prod + plc_odds_prod)
                fold_plc_only += clean_unit * plc_odds_prod
                fold_exp += clean_unit * (win_prob_prod * win_odds_prod + plc_prob_prod * plc_odds_prod)
            elif all_place_only:
                fold_max += clean_unit * plc_odds_prod
                fold_plc_only += clean_unit * plc_odds_prod
                fold_exp += clean_unit * plc_prob_prod * plc_odds_prod
            else:
                fold_max += clean_unit * single_plc_mode_odds
                fold_exp += clean_unit * single_plc_mode_prob * single_plc_mode_odds

        max_return += fold_max
        all_place_return += fold_plc_only
        expected_return += fold_exp
        breakdown.append(
            {
                "fold": f_size,
                "label": fold_names.get(f_size, f"{f_size}-Folds"),
                "lines": line_cnt * (2 if each_way else 1),
                "max_return": round(fold_max, 2),
                "all_place_return": round(fold_plc_only, 2),
                "expected_return": round(fold_exp, 2),
            }
        )

    total_bets = base_lines * (2 if each_way else 1)
    total_stake = round(total_bets * clean_unit, 2)
    expected_profit = round(expected_return - total_stake, 2)
    ev_pct = round(((expected_return / total_stake) - 1.0) * 100.0, 2) if total_stake > 0 else 0.0

    p_all_win = 1.0
    p_all_plc = 1.0
    hit_probs: list[float] = []
    for lg in norm_legs:
        p_all_win *= lg["model_win_prob"]
        p_all_plc *= lg["model_place_prob"]
        hit_probs.append(
            lg["model_place_prob"]
            if (each_way or str(lg.get("market") or "").upper() == "R_PLC")
            else lg["model_win_prob"]
        )

    min_fold = min(folds) if folds else n
    prob_any = _prob_at_least_k(hit_probs, min_fold)

    return {
        "structure": struct_key,
        "structure_label": spec["label"],
        "each_way": bool(each_way),
        "unit_stake": clean_unit,
        "leg_count": n,
        "base_lines": base_lines,
        "total_bets": total_bets,
        "total_stake": total_stake,
        "max_return": round(max_return, 2),
        "all_place_return": round(all_place_return, 2),
        "expected_return": round(expected_return, 2),
        "expected_profit": expected_profit,
        "expected_value_pct": ev_pct,
        "prob_all_win_pct": round(p_all_win * 100.0, 2),
        "prob_all_place_pct": round(p_all_plc * 100.0, 2),
        "prob_any_return_pct": round(prob_any * 100.0, 1),
        "breakdown": breakdown,
        "warnings": warnings,
    }


def _enrich_runner_row(race: dict[str, Any], runner: dict[str, Any]) -> dict[str, Any]:
    """Combine race + runner columns into a clean, JSON-ready dictionary."""
    win_odds = float(runner.get("market_odds") or runner.get("fair_win_odds") or 4.0)
    pf = float(race.get("place_fraction") or 0.2)
    places_paid = int(race.get("places_paid") or 3)
    ew_eligible = places_paid >= 2 and pf > 0
    place_odds = round(1.0 + (win_odds - 1.0) * pf, 3) if ew_eligible else 1.0
    p_win = float(runner.get("model_win_prob") or 0.0)
    p_plc = float(runner.get("model_place_prob") or 0.0)
    place_edge_pct = (p_plc * place_odds - 1.0) * 100.0 if ew_eligible else float(runner.get("win_edge_pct") or 0.0)
    terms = uk_place_terms(int(race.get("runners_count") or 8), bool(race.get("is_handicap")))

    try:
        reasons = json.loads(runner.get("reasons_json") or "[]")
    except (TypeError, ValueError):
        reasons = []
    try:
        reason_stats = json.loads(runner.get("reason_stats_json") or "{}")
    except (TypeError, ValueError):
        reason_stats = {}

    reg_meta = RACING_REGIONS.get(race.get("region_code", "INTL"), RACING_REGIONS["INTL"])
    return {
        "runner_id": int(runner["id"]),
        "race_id": int(race["id"]),
        "race_key": race["race_key"],
        "region_code": race["region_code"],
        "region_flag": reg_meta["flag"],
        "country_name": race.get("country_name") or reg_meta["name"],
        "course": race["course"],
        "race_date": race["race_date"],
        "off_time": race["off_time"],
        "race_name": race["race_name"],
        "race_type": race["race_type"],
        "is_handicap": bool(race["is_handicap"]),
        "distance_text": race.get("distance_text") or "",
        "going": race.get("going") or "",
        "surface": race.get("surface") or "",
        "runners_count": int(race.get("runners_count") or 0),
        "places_paid": places_paid,
        "place_fraction": pf,
        "ew_eligible": ew_eligible,
        "place_terms_label": terms["label"],
        "saddle_cloth": int(runner.get("saddle_cloth") or 0),
        "draw": runner.get("draw"),
        "horse_name": runner["horse_name"],
        "age": runner.get("age"),
        "sex": runner.get("sex") or "",
        "weight_display": runner.get("weight_display") or "",
        "official_rating": runner.get("official_rating"),
        "jockey": runner.get("jockey") or "",
        "trainer": runner.get("trainer") or "",
        "form_string": runner.get("form_string") or "",
        "form_direction": runner.get("form_direction") or "rtl",
        "display_form": reason_stats.get("display_form") or runner.get("form_string") or "",
        "headgear": runner.get("headgear") or "",
        "career_runs": int(runner.get("career_runs") or 0),
        "career_wins": int(runner.get("career_wins") or 0),
        "career_places": int(runner.get("career_places") or 0),
        "silk_url": runner.get("silk_url") or "",
        "is_debutant": bool(runner.get("is_debutant")),
        "non_runner": bool(runner.get("non_runner")),
        "finish_pos": runner.get("finish_pos"),
        "odds": round(win_odds, 2),
        "odds_fractional": _fmt_uk_odds_text(win_odds),
        "win_odds": round(win_odds, 2),
        "place_odds": place_odds,
        "place_odds_fractional": _fmt_uk_odds_text(place_odds) if ew_eligible else "—",
        "odds_source": runner.get("odds_source") or "model_tissue",
        "model_rating": round(float(runner.get("model_rating") or 50.0), 1),
        "model_win_prob": round(p_win, 5),
        "model_win_prob_pct": round(p_win * 100.0, 1),
        "model_place_prob": round(p_plc, 5),
        "model_place_prob_pct": round(p_plc * 100.0, 1),
        "fair_win_odds": round(float(runner.get("fair_win_odds") or (1.0 / max(0.005, p_win))), 2),
        "fair_win_odds_fractional": _fmt_uk_odds_text(float(runner.get("fair_win_odds") or (1.0 / max(0.005, p_win)))),
        "fair_place_odds": round(float(runner.get("fair_place_odds") or (1.0 / max(0.01, p_plc))), 2),
        "fair_place_odds_fractional": _fmt_uk_odds_text(float(runner.get("fair_place_odds") or (1.0 / max(0.01, p_plc)))),
        "win_edge_pct": round(float(runner.get("win_edge_pct") or 0.0), 2),
        "ew_edge_pct": round(float(runner.get("ew_edge_pct") or 0.0), 2),
        "place_edge_pct": round(place_edge_pct, 2),
        "reasons": reasons,
        "reason_stats": reason_stats,
    }


def _load_active_racing_pool(
    conn: sqlite3.Connection,
    region: str | None = None,
    day: str | None = None,
    race_type: str | None = None,
) -> list[tuple[dict[str, Any], list[dict[str, Any]]]]:
    """Return list of (race_dict, active_enriched_runners) filtered cleanly."""
    races = [
        dict(r)
        for r in conn.execute(
            "SELECT * FROM racing_races ORDER BY race_date ASC, off_time ASC, course ASC"
        ).fetchall()
    ]
    if not races:
        return []

    now_uk = _uk_now()
    today_iso = now_uk.strftime("%Y-%m-%d")
    tomorrow_iso = (date.fromisoformat(today_iso) + timedelta(days=1)).isoformat()

    day_norm = str(day or "").strip().lower()
    if day_norm == "today":
        races = [r for r in races if r["race_date"] == today_iso]
    elif day_norm == "tomorrow":
        races = [r for r in races if r["race_date"] == tomorrow_iso]
    else:
        upcoming = [r for r in races if is_race_upcoming(r, now_uk=now_uk)]
        if upcoming:
            races = upcoming

    reg_norm = str(region or "").strip().upper()
    if reg_norm and reg_norm != "ALL":
        if reg_norm in ("UK_IRE", "GB_IRE"):
            races = [r for r in races if r["region_code"] in ("GB", "IRE")]
        else:
            races = [r for r in races if r["region_code"] == reg_norm]

    rt_norm = str(race_type or "").strip().lower()
    if rt_norm and rt_norm != "all":
        if rt_norm == "jumps":
            races = [r for r in races if str(r["race_type"] or "").lower() in ("hurdle", "chase", "jumps", "nh flat")]
        else:
            races = [r for r in races if str(r["race_type"] or "").lower() == rt_norm]

    if not races:
        return []

    race_ids = [int(r["id"]) for r in races]
    placeholders = ",".join("?" for _ in race_ids)
    runners_all = conn.execute(
        f"""
        SELECT * FROM racing_runners
        WHERE race_id IN ({placeholders}) AND non_runner = 0
        ORDER BY race_id ASC, model_rating DESC, saddle_cloth ASC
        """,
        race_ids,
    ).fetchall()

    by_race: dict[int, list[dict[str, Any]]] = {rid: [] for rid in race_ids}
    race_lookup = {int(r["id"]): r for r in races}
    for rn in runners_all:
        rc = race_lookup.get(int(rn["race_id"]))
        if rc:
            by_race[int(rn["race_id"])].append(_enrich_runner_row(rc, dict(rn)))

    return [(r, by_race.get(int(r["id"]), [])) for r in races if by_race.get(int(r["id"]))]


def find_racing_tips(
    conn: sqlite3.Connection,
    user: dict[str, Any] | None = None,
    region: str | None = None,
    bet_type: str | None = None,
    day: str | None = None,
    race_type: str | None = None,
    limit: int = 60,
) -> list[dict[str, Any]]:
    """Generate ranked Win (R_WIN), Each-Way Value (R_EW), and Place Lock (R_PLC) racing tips."""
    race_groups = _load_active_racing_pool(conn, region=region, day=day, race_type=race_type)
    if not race_groups:
        return []

    bankroll = float((user or {}).get("bankroll") or 250.0)
    kelly_frac = float((user or {}).get("kelly_fraction") or 0.25)
    bt_filter = str(bet_type or "ALL").strip().upper()
    if bt_filter in ("WIN", "R_WIN"):
        bt_filter = "R_WIN"
    elif bt_filter in ("EW", "EACH_WAY", "R_EW"):
        bt_filter = "R_EW"
    elif bt_filter in ("PLC", "PLACE", "R_PLC"):
        bt_filter = "R_PLC"
    else:
        bt_filter = "ALL"

    win_tips: list[dict[str, Any]] = []
    ew_tips: list[dict[str, Any]] = []
    plc_tips: list[dict[str, Any]] = []

    def _kelly(prob: float, odd: float) -> float:
        if odd <= 1.02 or prob <= 0:
            return 0.0
        edge = prob * odd - 1.0
        if edge <= 0:
            return 0.0
        fk = edge / (odd - 1.0)
        return round(bankroll * min(0.04, max(0.0, kelly_frac * fk)), 2)

    for race, runners in race_groups:
        if not runners:
            continue
        sorted_r = sorted(runners, key=lambda x: (x["model_rating"], x["model_win_prob"]), reverse=True)
        top = sorted_r[0]
        second_rating = sorted_r[1]["model_rating"] if len(sorted_r) > 1 else top["model_rating"] - 6.0
        rating_lead = max(0.0, top["model_rating"] - second_rating)

        # 1. Win Tip (top-rated contender)
        if bt_filter in ("ALL", "R_WIN") and (top["model_win_prob"] >= 0.16 or top["win_edge_pct"] >= 0.0):
            score_win = top["model_rating"] * 0.55 + top["model_win_prob_pct"] * 0.8 + top["win_edge_pct"] * 0.65 + rating_lead * 1.1
            conf_w = max(54, min(97, round(52 + top["model_win_prob_pct"] * 0.7 + max(0.0, top["win_edge_pct"]) * 0.8 + rating_lead)))
            w_tip = {
                **top,
                "tip_id": f"{top['race_id']}:{top['runner_id']}:R_WIN",
                "market": "R_WIN",
                "bet_type": "r_win",
                "bet_type_label": "To Win",
                "selection_label": f"{top['horse_name']} (Win)",
                "odds": top["win_odds"],
                "odds_fractional": top["odds_fractional"],
                "fair_odds": top["fair_win_odds"],
                "fair_odds_fractional": top["fair_win_odds_fractional"],
                "min_bet365_odds": top["fair_win_odds"],
                "min_bet365_fractional": top["fair_win_odds_fractional"],
                "model_prob": top["model_win_prob"],
                "model_prob_pct": top["model_win_prob_pct"],
                "edge_pct": top["win_edge_pct"],
                "confidence_score": conf_w,
                "kelly_stake": _kelly(top["model_win_prob"], top["win_odds"]),
                "value_tag": "Value Win" if top["win_edge_pct"] >= 8.0 else "Strong Win",
                "_sort_score": score_win,
            }
            win_tips.append(w_tip)

        # 2. Each-Way Value (bigger price in >=5 runner EW races with high place likelihood)
        if bt_filter in ("ALL", "R_EW") and top["ew_eligible"]:
            ew_cands = [
                r
                for r in sorted_r[:5]
                if r["win_odds"] >= 4.5 and r["win_odds"] <= 26.0 and r["model_place_prob"] >= 0.24
            ]
            if ew_cands:
                ew_pick = max(
                    ew_cands,
                    key=lambda r: r["ew_edge_pct"] * 0.85 + r["model_place_prob_pct"] * 0.75 + (r["model_rating"] - 50.0) * 0.45,
                )
                comb_prob = round(0.5 * ew_pick["model_win_prob"] + 0.5 * ew_pick["model_place_prob"], 5)
                conf_ew = max(52, min(94, round(48 + ew_pick["model_place_prob_pct"] * 0.72 + max(0.0, ew_pick["ew_edge_pct"]) * 0.7)))
                score_ew = ew_pick["ew_edge_pct"] * 0.8 + ew_pick["model_place_prob_pct"] * 0.85 + (ew_pick["model_rating"] - 50.0) * 0.5
                ew_tips.append(
                    {
                        **ew_pick,
                        "tip_id": f"{ew_pick['race_id']}:{ew_pick['runner_id']}:R_EW",
                        "market": "R_EW",
                        "bet_type": "r_ew",
                        "bet_type_label": "Each-Way",
                        "selection_label": f"{ew_pick['horse_name']} (E/W)",
                        "odds": ew_pick["win_odds"],
                        "odds_fractional": ew_pick["odds_fractional"],
                        "fair_odds": ew_pick["fair_win_odds"],
                        "fair_odds_fractional": ew_pick["fair_win_odds_fractional"],
                        "min_bet365_odds": ew_pick["fair_win_odds"],
                        "min_bet365_fractional": ew_pick["fair_win_odds_fractional"],
                        "model_prob": comb_prob,
                        "model_prob_pct": round(comb_prob * 100.0, 1),
                        "edge_pct": ew_pick["ew_edge_pct"],
                        "confidence_score": conf_ew,
                        "kelly_stake": _kelly(ew_pick["model_place_prob"], ew_pick["place_odds"]),
                        "value_tag": "EW Outsider" if ew_pick["win_odds"] >= 8.0 else "EW Value",
                        "_sort_score": score_ew,
                    }
                )

        # 3. Place Locks (consistent frame hitters in >=5 runner fields)
        if bt_filter in ("ALL", "R_PLC") and top["ew_eligible"]:
            plc_cands = [r for r in sorted_r[:3] if r["model_place_prob"] >= 0.42 and r["place_odds"] >= 1.18]
            if plc_cands:
                plc_pick = max(
                    plc_cands,
                    key=lambda r: r["model_place_prob_pct"] * 1.1 + r["place_edge_pct"] * 0.7 + r["model_rating"] * 0.35,
                )
                conf_p = max(58, min(97, round(46 + plc_pick["model_place_prob_pct"] * 0.68 + max(0.0, plc_pick["place_edge_pct"]) * 0.5)))
                score_p = plc_pick["model_place_prob_pct"] * 1.05 + plc_pick["place_edge_pct"] * 0.65 + plc_pick["model_rating"] * 0.3
                plc_tips.append(
                    {
                        **plc_pick,
                        "tip_id": f"{plc_pick['race_id']}:{plc_pick['runner_id']}:R_PLC",
                        "market": "R_PLC",
                        "bet_type": "r_plc",
                        "bet_type_label": "To Place",
                        "selection_label": f"{plc_pick['horse_name']} (Place {plc_pick['places_paid']})",
                        "odds": plc_pick["place_odds"],
                        "odds_fractional": plc_pick["place_odds_fractional"],
                        "fair_odds": plc_pick["fair_place_odds"],
                        "fair_odds_fractional": plc_pick["fair_place_odds_fractional"],
                        "min_bet365_odds": plc_pick["fair_place_odds"],
                        "min_bet365_fractional": plc_pick["fair_place_odds_fractional"],
                        "model_prob": plc_pick["model_place_prob"],
                        "model_prob_pct": plc_pick["model_place_prob_pct"],
                        "edge_pct": plc_pick["place_edge_pct"],
                        "confidence_score": conf_p,
                        "kelly_stake": _kelly(plc_pick["model_place_prob"], plc_pick["place_odds"]),
                        "value_tag": "Place Lock" if plc_pick["model_place_prob"] >= 0.58 else "Place Anchor",
                        "_sort_score": score_p,
                    }
                )

    win_tips.sort(key=lambda x: x["_sort_score"], reverse=True)
    ew_tips.sort(key=lambda x: x["_sort_score"], reverse=True)
    plc_tips.sort(key=lambda x: x["_sort_score"], reverse=True)

    if win_tips:
        win_tips[0]["value_tag"] = "NAP"
    if len(win_tips) > 1:
        win_tips[1]["value_tag"] = "NB"

    merged = win_tips + ew_tips + plc_tips
    merged.sort(key=lambda x: (1 if x["value_tag"] in ("NAP", "NB") else 0, x["_sort_score"]), reverse=True)
    for item in merged:
        item.pop("_sort_score", None)
    return merged[: max(1, int(limit))]


def _tip_to_racing_leg(tip: dict[str, Any]) -> dict[str, Any]:
    return {
        "runner_id": tip["runner_id"],
        "race_id": tip["race_id"],
        "race_key": tip["race_key"],
        "region_code": tip["region_code"],
        "region_flag": tip.get("region_flag", ""),
        "course": tip["course"],
        "race_date": tip["race_date"],
        "off_time": tip["off_time"],
        "race_name": tip["race_name"],
        "race_type": tip["race_type"],
        "runners_count": tip["runners_count"],
        "places_paid": tip["places_paid"],
        "place_fraction": tip["place_fraction"],
        "ew_eligible": tip["ew_eligible"],
        "place_terms_label": tip["place_terms_label"],
        "saddle_cloth": tip["saddle_cloth"],
        "horse_name": tip["horse_name"],
        "jockey": tip.get("jockey", ""),
        "trainer": tip.get("trainer", ""),
        "market": tip["market"],
        "bet_type": tip["bet_type"],
        "bet_type_label": tip["bet_type_label"],
        "selection_label": tip["selection_label"],
        "odds": tip["odds"],
        "odds_fractional": tip["odds_fractional"],
        "win_odds": tip["win_odds"],
        "place_odds": tip["place_odds"],
        "odds_source": tip["odds_source"],
        "model_prob": tip["model_prob"],
        "model_win_prob": tip["model_win_prob"],
        "model_place_prob": tip["model_place_prob"],
        "edge_pct": tip["edge_pct"],
        "confidence_score": tip["confidence_score"],
        "model_rating": tip["model_rating"],
        "value_tag": tip.get("value_tag", ""),
        "reasons": list(tip.get("reasons") or []),
        "reason_stats": tip.get("reason_stats") or {},
    }


def _build_racing_bet_reasons(
    title: str,
    legs: list[dict[str, Any]],
    ev: dict[str, Any],
    each_way: bool,
) -> list[str]:
    if not legs:
        return []
    distinct_courses = len({l["course"] for l in legs})
    top_leg = max(legs, key=lambda l: float(l.get("model_rating") or 0))
    return [
        (
            f"Bet Structure: {ev['structure_label']} ({'Each-Way • 2x lines' if each_way else 'Win/Place'}) "
            f"combining {len(legs)} distinct races across {distinct_courses} track(s) at £{ev['unit_stake']:.2f}/line "
            f"(Total stake £{ev['total_stake']:.2f})."
        ),
        (
            f"Payout & Math: Max return £{ev['max_return']:.2f}"
            + (f" (all-place return £{ev['all_place_return']:.2f})" if each_way else "")
            + f" • {ev['prob_any_return_pct']:.1f}% chance of at least one return • EV {ev['expected_value_pct']:+.1f}%."
        ),
        (
            f"Anchor Runner: {top_leg['horse_name']} ({top_leg['off_time']} {top_leg['course']}) tops the card at "
            f"{top_leg['model_rating']:.0f}/100 ({top_leg['model_win_prob']*100:.1f}% Win / {top_leg['model_place_prob']*100:.1f}% Place)."
        ),
        "Race Discipline Rule: Strict 1 runner per race inside every multiple, screening out already-backed races & runners.",
    ]


def build_racing_bet365_export(
    legs: list[dict[str, Any]],
    structure: str = "acca",
    each_way: bool = False,
    unit_stake: float = 1.0,
    title: str = "AccaLab Racing Bet",
) -> dict[str, Any]:
    """Generate Bet365 Horse Racing links, multiple checklist instructions, and share text."""
    ev = evaluate_racing_multiple(legs, structure=structure, each_way=each_way, unit_stake=unit_stake)
    exported_legs: list[dict[str, Any]] = []
    for idx, lg in enumerate(legs or [], start=1):
        horse = str(lg.get("horse_name") or "").strip()
        course = str(lg.get("course") or "").strip()
        off_t = str(lg.get("off_time") or "").strip()
        search_q = horse or f"{course} {off_t}".strip() or "Horse Racing"
        search_hash = f"#/AX/K^{urllib.parse.quote(search_q, safe='')}/"
        exported_legs.append(
            {
                "index": idx,
                "horse_name": horse,
                "course": course,
                "race_date": lg.get("race_date", ""),
                "off_time": off_t,
                "saddle_cloth": lg.get("saddle_cloth", 0),
                "selection_label": lg.get("selection_label") or horse,
                "market": lg.get("market", "R_WIN"),
                "odds": round(float(lg.get("odds") or 2.0), 2),
                "odds_fractional": lg.get("odds_fractional") or _fmt_uk_odds_text(float(lg.get("odds") or 2.0)),
                "place_terms_label": lg.get("place_terms_label") or "",
                "b365_search_url": f"https://www.bet365.com/{search_hash}",
            }
        )

    ew_tag = "Each-Way " if each_way else ""
    lines = [
        f"🏇 {title} — {ew_tag}{ev['structure_label']}",
        f"Unit Stake: £{ev['unit_stake']:.2f} × {ev['total_bets']} bets = £{ev['total_stake']:.2f} total",
        f"Max Return: £{ev['max_return']:.2f}"
        + (f" | All Place Return: £{ev['all_place_return']:.2f}" if each_way else ""),
        f"Expected Value: {ev['expected_value_pct']:+.1f}% | Hit Any Return: {ev['prob_any_return_pct']:.1f}%",
        "",
    ]
    for item in exported_legs:
        lines.append(
            f"{item['index']}. {item['off_time']} {item['course']} — #{item['saddle_cloth']} {item['horse_name']} "
            f"@ {item['odds_fractional']} ({item['place_terms_label'] or 'Win'})"
        )
    lines.extend(["", f"On Bet365 Slip: Select '{ev['structure_label'].split(' (')[0]}'" + (" & tick E/W box." if each_way else ".")])

    return {
        "title": title,
        "structure": ev["structure"],
        "structure_label": ev["structure_label"],
        "each_way": bool(each_way),
        "launch_url": exported_legs[0]["b365_search_url"] if exported_legs else "https://www.bet365.com/#/AS/B2/",
        "racing_hub_url": "https://www.bet365.com/#/AS/B2/",
        "clipboard_text": "\n".join(lines),
        "eval": ev,
        "legs": exported_legs,
    }


def _racing_exclusion_sets(exclude_legs: list[dict[str, Any]] | None) -> tuple[set[str], set[str]]:
    race_keys: set[str] = set()
    runner_keys: set[str] = set()
    for lg in exclude_legs or []:
        if not isinstance(lg, dict):
            continue
        rid = lg.get("race_id")
        r_slug = normalize_course_slug(lg.get("course") or "")
        r_date = str(lg.get("race_date") or "")[:10]
        off_t = str(lg.get("off_time") or "")
        race_sig = f"id:{rid}" if rid else (f"{r_date}:{r_slug}:{off_t}" if r_slug else "")
        if race_sig:
            race_keys.add(race_sig)
        h_name = str(lg.get("horse_name") or "").strip().lower()
        rn_id = lg.get("runner_id")
        if rn_id:
            runner_keys.add(f"rn:{rn_id}")
        if race_sig and h_name:
            runner_keys.add(f"{race_sig}:{h_name}")
    return race_keys, runner_keys


def _is_tip_excluded(
    tip: dict[str, Any],
    race_keys: set[str],
    runner_keys: set[str],
    scope: str = "race",
) -> bool:
    r_slug = normalize_course_slug(tip.get("course") or "")
    r_sig_id = f"id:{tip['race_id']}" if tip.get("race_id") else ""
    r_sig_txt = f"{tip.get('race_date', '')}:{r_slug}:{tip.get('off_time', '')}"
    if scope == "race":
        return (r_sig_id in race_keys) or (r_sig_txt in race_keys)
    rn_id = tip.get("runner_id")
    h_name = str(tip.get("horse_name") or "").strip().lower()
    if rn_id and f"rn:{rn_id}" in runner_keys:
        return True
    if r_sig_id and f"{r_sig_id}:{h_name}" in runner_keys:
        return True
    if f"{r_sig_txt}:{h_name}" in runner_keys:
        return True
    return False


def build_racing_suggestions(
    conn: sqlite3.Connection,
    user: dict[str, Any] | None = None,
    exclude_legs: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build 4 curated Quick Daily Racing Cards (NAP Single, EW Double, Win/Place Treble, Daily Lucky 15)."""
    all_tips = find_racing_tips(conn, user=user, limit=120)
    race_keys, runner_keys = _racing_exclusion_sets(exclude_legs)
    if race_keys or runner_keys:
        all_tips = [t for t in all_tips if not _is_tip_excluded(t, race_keys, runner_keys, scope="race")]

    win_pool = [t for t in all_tips if t["market"] == "R_WIN"]
    ew_pool = [t for t in all_tips if t["market"] == "R_EW"]
    plc_pool = [t for t in all_tips if t["market"] == "R_PLC"]

    def _pick_distinct(pool: list[dict[str, Any]], count: int, used_races: set[int] | None = None) -> list[dict[str, Any]]:
        seen = set(used_races or set())
        out: list[dict[str, Any]] = []
        for item in pool:
            if item["race_id"] in seen:
                continue
            seen.add(item["race_id"])
            out.append(_tip_to_racing_leg(item))
            if len(out) >= count:
                break
        return out

    cards: list[dict[str, Any]] = []

    # 1. NAP Win Single
    nap_legs = _pick_distinct(win_pool or all_tips, 1)
    if nap_legs:
        ev = evaluate_racing_multiple(nap_legs, structure="single", each_way=False, unit_stake=10.0)
        cards.append(
            {
                "id": "nap_single",
                "title": "Today's NAP Single",
                "badge": "🏆 Top Rated Win",
                "subtitle": f"{nap_legs[0]['off_time']} {nap_legs[0]['course']} • Best rating & edge on card",
                "structure": "single",
                "each_way": False,
                "unit_stake": 10.0,
                "legs": nap_legs,
                "eval": ev,
                "bet_reasons": _build_racing_bet_reasons("Today's NAP Single", nap_legs, ev, False),
                "bet365_export": build_racing_bet365_export(nap_legs, "single", False, 10.0, "Today's NAP Single"),
            }
        )

    # 2. Each-Way Value Double
    ew_double_legs = _pick_distinct(ew_pool if len(ew_pool) >= 2 else win_pool, 2)
    if len(ew_double_legs) >= 2:
        is_ew = all(l["ew_eligible"] for l in ew_double_legs)
        ev = evaluate_racing_multiple(ew_double_legs, structure="double", each_way=is_ew, unit_stake=5.0)
        cards.append(
            {
                "id": "ew_double",
                "title": "Each-Way Value Double",
                "badge": "⚖️ Each-Way Double" if is_ew else "🏆 Win Double",
                "subtitle": "2 value runners at generous odds with strong place equity",
                "structure": "double",
                "each_way": is_ew,
                "unit_stake": 5.0,
                "legs": ew_double_legs,
                "eval": ev,
                "bet_reasons": _build_racing_bet_reasons("Each-Way Value Double", ew_double_legs, ev, is_ew),
                "bet365_export": build_racing_bet365_export(ew_double_legs, "double", is_ew, 5.0, "Each-Way Value Double"),
            }
        )

    # 3. Win / Place Treble
    treble_pool = plc_pool if len(plc_pool) >= 3 else win_pool
    treble_legs = _pick_distinct(treble_pool, 3)
    if len(treble_legs) >= 3:
        ev = evaluate_racing_multiple(treble_legs, structure="treble", each_way=False, unit_stake=5.0)
        cards.append(
            {
                "id": "win_place_treble",
                "title": "Win / Place Treble",
                "badge": "🎯 High-Hit Treble",
                "subtitle": "3 distinct races anchored by strong Top-3 finishers",
                "structure": "treble",
                "each_way": False,
                "unit_stake": 5.0,
                "legs": treble_legs,
                "eval": ev,
                "bet_reasons": _build_racing_bet_reasons("Win / Place Treble", treble_legs, ev, False),
                "bet365_export": build_racing_bet365_export(treble_legs, "treble", False, 5.0, "Win / Place Treble"),
            }
        )

    # 4. Daily Lucky 15 (4 runners)
    l15_pool = ew_pool if len(ew_pool) >= 4 else sorted(
        win_pool + ew_pool,
        key=lambda x: (x["model_rating"], x["model_win_prob_pct"]),
        reverse=True,
    )
    l15_legs = _pick_distinct(l15_pool, 4)
    if len(l15_legs) < 4:
        l15_legs = _pick_distinct(all_tips, 4)
    if len(l15_legs) >= 4:
        avg_odds = sum(l["win_odds"] for l in l15_legs) / 4.0
        ew_l15 = avg_odds >= 4.0 and all(l["ew_eligible"] for l in l15_legs)
        ev = evaluate_racing_multiple(l15_legs, structure="lucky15", each_way=ew_l15, unit_stake=1.0)
        cards.append(
            {
                "id": "daily_lucky15",
                "title": "Daily Lucky 15" + (" (E/W)" if ew_l15 else " (Win)"),
                "badge": "🍀 Lucky 15 (30 Bets)" if ew_l15 else "🍀 Lucky 15 (15 Bets)",
                "subtitle": "4 Singles, 6 Doubles, 4 Trebles & 4-Fold Acca across 4 races",
                "structure": "lucky15",
                "each_way": ew_l15,
                "unit_stake": 1.0,
                "legs": l15_legs,
                "eval": ev,
                "bet_reasons": _build_racing_bet_reasons("Daily Lucky 15", l15_legs, ev, ew_l15),
                "bet365_export": build_racing_bet365_export(l15_legs, "lucky15", ew_l15, 1.0, "Daily Lucky 15"),
            }
        )

    return {
        "cards": cards,
        "structures": RACING_MULTIPLES,
        "total_pool_tips": len(all_tips),
    }


def _score_racing_candidate_for_risk(tip: dict[str, Any], risk_level: str) -> float:
    win_odds = float(tip.get("win_odds") or tip.get("odds") or 3.0)
    rating = float(tip.get("model_rating") or 50.0)
    win_p = float(tip.get("model_win_prob_pct") or 10.0)
    plc_p = float(tip.get("model_place_prob_pct") or 30.0)
    edge = float(tip.get("edge_pct") or 0.0)
    if risk_level == "low":
        return plc_p * 1.15 + win_p * 0.75 + rating * 0.45 - max(0.0, win_odds - 5.0) * 4.5
    if risk_level == "high":
        return edge * 1.1 + min(win_odds, 14.0) * 3.0 + rating * 0.55 - max(0.0, 2.5 - win_odds) * 8.0
    if risk_level == "longshot":
        return edge * 1.0 + min(win_odds, 22.0) * 3.6 + plc_p * 0.55 - max(0.0, 5.0 - win_odds) * 10.0
    return rating * 0.7 + edge * 0.9 + plc_p * 0.5 + win_p * 0.55 - max(0.0, win_odds - 10.0) * 1.8


def build_custom_racing_bets(
    conn: sqlite3.Connection,
    user: dict[str, Any] | None = None,
    criteria: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build 1-3 custom UK horse racing Singles/Doubles/Trebles/Accas/Trixies/Patents/Yankees/Lucky 15s."""
    crit = criteria or {}
    struct = str(crit.get("structure") or "lucky15").strip().lower()
    if struct not in RACING_MULTIPLES:
        struct = "lucky15"
    spec = RACING_MULTIPLES[struct]
    each_way = bool(crit.get("each_way"))
    unit_stake = round(max(0.1, float(crit.get("unit_stake") or 1.0)), 2)
    style = str(crit.get("style") or "ALL").strip().upper()
    risk_level = str(crit.get("risk_level") or "medium").strip().lower()
    if risk_level not in ("low", "medium", "high", "longshot"):
        risk_level = "medium"

    if struct == "acca":
        req_legs = max(2, min(6, int(crit.get("legs_count") or 4)))
    else:
        req_legs = spec["min_legs"]

    num_bets = max(1, min(3, int(crit.get("num_bets") or 1)))
    region = (crit.get("region") or "ALL").strip()
    day = (crit.get("day") or "ALL").strip()
    race_type = (crit.get("race_type") or "ALL").strip()
    exclude_already = bool(crit.get("exclude_already_bet", True))
    exclude_scope = "runner" if crit.get("exclude_scope") == "runner" else "race"

    pool = find_racing_tips(
        conn,
        user=user,
        region=region,
        bet_type=style,
        day=day,
        race_type=race_type,
        limit=240,
    )
    if each_way:
        pool = [t for t in pool if t.get("ew_eligible") and t.get("win_odds", 0) >= 2.2] or pool

    excl_legs = list(crit.get("excluded_legs") or []) if exclude_already else []
    avoid_legs = list(crit.get("avoid_legs") or [])
    race_keys, runner_keys = _racing_exclusion_sets(excl_legs)
    avoid_rk, avoid_rn = _racing_exclusion_sets(avoid_legs)

    filtered: list[dict[str, Any]] = []
    for t in pool:
        if exclude_already and _is_tip_excluded(t, race_keys, runner_keys, scope=exclude_scope):
            continue
        if (avoid_rk or avoid_rn) and _is_tip_excluded(t, avoid_rk, avoid_rn, scope="race"):
            continue
        t_copy = dict(t)
        t_copy["_score"] = _score_racing_candidate_for_risk(t, risk_level)
        filtered.append(t_copy)

    filtered.sort(key=lambda x: x["_score"], reverse=True)
    # Deduplicate same runner across different tip markets (prefer best score for that runner/race)
    if not filtered:
        return {
            "bets": [],
            "requested_bets": num_bets,
            "requested_legs": req_legs,
            "excluded_count": len(race_keys),
            "available_pool_count": 0,
            "notice": "No matching runners found for these criteria — try widening regions, dates, or exclusions.",
        }

    used_races_global: set[int] = set()
    built_bets: list[dict[str, Any]] = []
    notice = ""

    risk_names = {"low": "Low Risk", "medium": "Balanced", "high": "High Risk", "longshot": "Longshot"}
    style_names = {"ALL": "Mixed", "R_WIN": "Win", "R_EW": "Each-Way Value", "R_PLC": "Place Locks"}
    struct_short = spec["label"].split(" (")[0]

    for b_idx in range(num_bets):
        picked: list[dict[str, Any]] = []
        used_this_bet: set[int] = set()
        for t in filtered:
            rid = int(t["race_id"])
            if rid in used_this_bet or rid in used_races_global:
                continue
            used_this_bet.add(rid)
            picked.append(t)
            if len(picked) >= req_legs:
                break

        if len(picked) < req_legs:
            if b_idx == 0 and picked:
                notice = f"Only {len(picked)} distinct races matched your filters (requested {req_legs} picks)."
            elif b_idx > 0:
                notice = f"Built {len(built_bets)} of {num_bets} requested bets — not enough unused races left."
                break
        if not picked:
            break

        for p in picked:
            used_races_global.add(int(p["race_id"]))

        legs = [_tip_to_racing_leg(p) for p in picked]
        ew_tag = "Each-Way " if each_way else ""
        title = f"{ew_tag}{style_names.get(style, 'Racing')} {struct_short}" + (f" #{b_idx + 1}" if num_bets > 1 else "")
        subtitle = f"{risk_names[risk_level]} • {len(legs)} races • £{unit_stake:.2f}/line"
        ev = evaluate_racing_multiple(legs, structure=struct, each_way=each_way, unit_stake=unit_stake)
        built_bets.append(
            {
                "id": f"r_custom_{b_idx + 1}",
                "title": title,
                "badge": f"{risk_names[risk_level]} • {ew_tag}{struct_short}",
                "subtitle": subtitle,
                "structure": struct,
                "each_way": each_way,
                "unit_stake": unit_stake,
                "legs": legs,
                "eval": ev,
                "bet_reasons": _build_racing_bet_reasons(title, legs, ev, each_way),
                "bet365_export": build_racing_bet365_export(legs, struct, each_way, unit_stake, title),
            }
        )

    return {
        "bets": built_bets,
        "requested_bets": num_bets,
        "requested_legs": req_legs,
        "excluded_count": len(race_keys),
        "available_pool_count": len(filtered),
        "notice": notice,
    }
