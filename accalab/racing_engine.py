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

        fold_max = min(1_000_000.0, fold_max)
        fold_plc_only = min(1_000_000.0, fold_plc_only)
        max_return = min(1_000_000.0, max_return + fold_max)
        all_place_return = min(1_000_000.0, all_place_return + fold_plc_only)
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


def _clean_iso_date(val: Any) -> str | None:
    """Validate and normalize a YYYY-MM-DD date string, returning None if empty/invalid."""
    s = str(val or "").strip()
    if len(s) < 10:
        return None
    try:
        return date.fromisoformat(s[:10]).isoformat()
    except ValueError:
        return None


def filter_races_by_date_range(
    races: list[dict[str, Any]],
    day: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    include_past: bool = False,
    fallback_to_matched: bool = False,
    now_uk: datetime | None = None,
) -> list[dict[str, Any]]:
    """Filter race dicts by preset window ('today', 'tomorrow', 'next_2', 'next_3') or custom date bounds."""
    if not races:
        return []
    ref = now_uk or _uk_now()
    today_d = ref.date()
    today_iso = today_d.isoformat()
    tomorrow_iso = (today_d + timedelta(days=1)).isoformat()
    day2_iso = (today_d + timedelta(days=2)).isoformat()

    d_from = _clean_iso_date(date_from)
    d_to = _clean_iso_date(date_to)
    if d_from and d_to and d_from > d_to:
        d_from, d_to = d_to, d_from

    day_norm = str(day or "").strip().lower()
    explicit_date = _clean_iso_date(day_norm)

    if d_from or d_to:
        matched = [
            r
            for r in races
            if (not d_from or str(r.get("race_date") or "") >= d_from)
            and (not d_to or str(r.get("race_date") or "") <= d_to)
        ]
    elif day_norm == "today":
        matched = [r for r in races if str(r.get("race_date") or "") == today_iso]
    elif day_norm == "tomorrow":
        matched = [r for r in races if str(r.get("race_date") or "") == tomorrow_iso]
    elif day_norm in ("next_2", "2d"):
        matched = [r for r in races if today_iso <= str(r.get("race_date") or "") <= tomorrow_iso]
    elif day_norm in ("next_3", "3d"):
        matched = [r for r in races if today_iso <= str(r.get("race_date") or "") <= day2_iso]
    elif explicit_date:
        matched = [r for r in races if str(r.get("race_date") or "") == explicit_date]
    else:
        if include_past:
            return list(races)
        upcoming = [r for r in races if is_race_upcoming(r, now_uk=ref)]
        return upcoming or list(races)

    if include_past:
        return matched
    upcoming = [r for r in matched if is_race_upcoming(r, now_uk=ref)]
    if upcoming:
        return upcoming
    return matched if fallback_to_matched else []


def get_available_racing_dates(
    conn: sqlite3.Connection,
    now_uk: datetime | None = None,
) -> list[str]:
    """Return sorted distinct YYYY-MM-DD race dates available (upcoming first, else all stored races)."""
    rows = [
        dict(r)
        for r in conn.execute(
            "SELECT race_date, off_time, status FROM racing_races ORDER BY race_date ASC"
        ).fetchall()
    ]
    ref = now_uk or _uk_now()
    upcoming = [r for r in rows if is_race_upcoming(r, now_uk=ref)]
    pool = upcoming or rows
    return sorted({str(r.get("race_date") or "") for r in pool if r.get("race_date")})


def _load_active_racing_pool(
    conn: sqlite3.Connection,
    region: str | None = None,
    day: str | None = None,
    race_type: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
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

    races = filter_races_by_date_range(
        races,
        day=day,
        date_from=date_from,
        date_to=date_to,
        include_past=False,
        fallback_to_matched=False,
    )

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
    date_from: str | None = None,
    date_to: str | None = None,
) -> list[dict[str, Any]]:
    """Generate ranked Win (R_WIN), Each-Way Value (R_EW), and Place Lock (R_PLC) racing tips."""
    race_groups = _load_active_racing_pool(
        conn,
        region=region,
        day=day,
        race_type=race_type,
        date_from=date_from,
        date_to=date_to,
    )
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

        active_r = [r for r in sorted_r if (r.get("reason_stats") or {}).get("news_sentiment") != "caution"]
        if not active_r:
            active_r = sorted_r
        top_active = active_r[0]
        win_picked_id: int | None = None
        ew_picked_id: int | None = None

        # 1. Win Tip (genuine contender within realistic win odds <= 10.0, strong recent form / weak-field edge)
        if bt_filter in ("ALL", "R_WIN"):
            win_cands = []
            for r in active_r[:2]:
                rs = r.get("reason_stats") or {}
                weak_edge = bool(rs.get("weak_field_edge"))
                f_score = float(rs.get("form_score") or 0.0)
                min_wp = 0.16 if weak_edge else 0.18
                if (
                    r["win_odds"] <= 10.0
                    and r["model_win_prob"] >= min_wp
                    and r["win_edge_pct"] >= -5.0
                    and (f_score >= -0.05 or bool(r.get("is_debutant")) or weak_edge)
                ):
                    win_cands.append(r)
            if win_cands:
                top_w = max(
                    win_cands,
                    key=lambda r: (
                        r["model_rating"] * 0.65
                        + r["model_win_prob_pct"] * 1.05
                        + min(35.0, max(-10.0, r["win_edge_pct"])) * 0.45
                        + (4.5 if (r.get("reason_stats") or {}).get("weak_field_edge") else 0.0)
                        + (3.0 if (r.get("reason_stats") or {}).get("news_sentiment") == "positive" else 0.0)
                    ),
                )
                rs_w = top_w.get("reason_stats") or {}
                weak_w = bool(rs_w.get("weak_field_edge"))
                pos_w = rs_w.get("news_sentiment") == "positive"
                win_picked_id = top_w["runner_id"] if bt_filter == "ALL" else None
                capped_edge_w = min(35.0, max(-10.0, top_w["win_edge_pct"]))
                score_win = (
                    top_w["model_rating"] * 0.65
                    + top_w["model_win_prob_pct"] * 1.05
                    + capped_edge_w * 0.45
                    + rating_lead * 1.1
                    + (4.5 if weak_w else 0.0)
                    + (3.0 if pos_w else 0.0)
                )
                conf_w = max(
                    54,
                    min(
                        97,
                        round(
                            52
                            + top_w["model_win_prob_pct"] * 0.7
                            + max(0.0, capped_edge_w) * 0.6
                            + rating_lead
                            + (4 if weak_w else 0)
                            + (2 if pos_w else 0)
                        ),
                    ),
                )
                w_tip = {
                    **top_w,
                    "tip_id": f"{top_w['race_id']}:{top_w['runner_id']}:R_WIN",
                    "market": "R_WIN",
                    "bet_type": "r_win",
                    "bet_type_label": "To Win",
                    "selection_label": f"{top_w['horse_name']} (Win)",
                    "odds": top_w["win_odds"],
                    "odds_fractional": top_w["odds_fractional"],
                    "fair_odds": top_w["fair_win_odds"],
                    "fair_odds_fractional": top_w["fair_win_odds_fractional"],
                    "min_bet365_odds": top_w["fair_win_odds"],
                    "min_bet365_fractional": top_w["fair_win_odds_fractional"],
                    "model_prob": top_w["model_win_prob"],
                    "model_prob_pct": top_w["model_win_prob_pct"],
                    "edge_pct": top_w["win_edge_pct"],
                    "confidence_score": conf_w,
                    "kelly_stake": _kelly(top_w["model_win_prob"], top_w["win_odds"]),
                    "value_tag": "Value Win" if top_w["win_edge_pct"] >= 6.0 else "Strong Win",
                    "_sort_score": score_win,
                }
                win_tips.append(w_tip)

        # 2. Each-Way Value (mid-range price in >=5 runner EW races, solid top-3 rate & form)
        if bt_filter in ("ALL", "R_EW") and top_active["ew_eligible"]:
            ew_cands = [
                r
                for r in active_r[:5]
                if 4.0 <= r["win_odds"] <= 18.0
                and r["model_place_prob"] >= 0.34
                and r["ew_edge_pct"] >= -4.0
                and float((r.get("reason_stats") or {}).get("form_score") or 0.0) >= -0.10
            ]
            if ew_cands:
                non_dup_ew = [r for r in ew_cands if r["runner_id"] != win_picked_id]
                cand_pool_ew = non_dup_ew if (bt_filter == "ALL" and non_dup_ew) else ew_cands
                ew_pick = max(
                    cand_pool_ew,
                    key=lambda r: (
                        min(35.0, max(-10.0, r["ew_edge_pct"])) * 0.70
                        + r["model_place_prob_pct"] * 0.95
                        + (r["model_rating"] - 50.0) * 0.45
                        + (4.0 if (r.get("reason_stats") or {}).get("weak_field_edge") else 0.0)
                        + (2.5 if (r.get("reason_stats") or {}).get("news_sentiment") == "positive" else 0.0)
                    ),
                )
                rs_e = ew_pick.get("reason_stats") or {}
                weak_e = bool(rs_e.get("weak_field_edge"))
                pos_e = rs_e.get("news_sentiment") == "positive"
                ew_picked_id = ew_pick["runner_id"] if bt_filter == "ALL" else None
                comb_prob = round(0.5 * ew_pick["model_win_prob"] + 0.5 * ew_pick["model_place_prob"], 5)
                capped_edge_ew = min(35.0, max(-10.0, ew_pick["ew_edge_pct"]))
                conf_ew = max(
                    52,
                    min(
                        94,
                        round(
                            48
                            + ew_pick["model_place_prob_pct"] * 0.72
                            + max(0.0, capped_edge_ew) * 0.5
                            + (3 if weak_e else 0)
                            + (2 if pos_e else 0)
                        ),
                    ),
                )
                score_ew = (
                    capped_edge_ew * 0.70
                    + ew_pick["model_place_prob_pct"] * 0.95
                    + (ew_pick["model_rating"] - 50.0) * 0.45
                    + (4.0 if weak_e else 0.0)
                    + (2.5 if pos_e else 0.0)
                )
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

        # 3. Place Locks (high-hit frame contenders 1.75 - 9.5 win odds in >=5 runner fields)
        if bt_filter in ("ALL", "R_PLC") and top_active["ew_eligible"]:
            plc_cands = [
                r
                for r in active_r[:3]
                if 1.75 <= r["win_odds"] <= 9.5
                and r["model_place_prob"] >= 0.50
                and r["place_odds"] >= 1.20
                and r["place_edge_pct"] >= -6.0
            ]
            if plc_cands:
                non_dup_plc = [r for r in plc_cands if r["runner_id"] not in {win_picked_id, ew_picked_id}]
                cand_pool_plc = non_dup_plc if (bt_filter == "ALL" and non_dup_plc) else plc_cands
                plc_pick = max(
                    cand_pool_plc,
                    key=lambda r: (
                        r["model_place_prob_pct"] * 1.05
                        + min(35.0, max(-10.0, r["place_edge_pct"])) * 0.55
                        + r["model_rating"] * 0.35
                    ),
                )
                capped_edge_p = min(35.0, max(-10.0, plc_pick["place_edge_pct"]))
                conf_p = max(
                    58,
                    min(97, round(46 + plc_pick["model_place_prob_pct"] * 0.68 + max(0.0, capped_edge_p) * 0.45)),
                )
                score_p = plc_pick["model_place_prob_pct"] * 1.05 + capped_edge_p * 0.55 + plc_pick["model_rating"] * 0.35
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

    merged = win_tips + ew_tips + plc_tips
    merged.sort(key=lambda x: x["_sort_score"], reverse=True)
    if bt_filter == "ALL":
        deduped: list[dict[str, Any]] = []
        seen_runners: set[int] = set()
        for item in merged:
            rid_rn = int(item["runner_id"])
            if rid_rn in seen_runners:
                continue
            seen_runners.add(rid_rn)
            deduped.append(item)
        merged = deduped

    win_surviving = [x for x in merged if x["market"] == "R_WIN"]
    if win_surviving:
        win_surviving[0]["value_tag"] = "NAP"
    if len(win_surviving) > 1:
        win_surviving[1]["value_tag"] = "NB"

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
    struct = str(ev.get("structure") or "acca").lower()
    if struct == "single":
        struct_desc = (
            f"Single bet covering 1 race — relies solely on {legs[0]['horse_name']} "
            f"finishing {'in the places or winning' if each_way else 'first'}."
        )
        struct_why = "concentrated stake on your highest-conviction runner avoids multiple-leg variance."
    elif struct in ("double", "treble", "acca"):
        ew_note = " (or place on the E/W half)" if each_way else ""
        struct_desc = (
            f"{ev['structure_label']} across {distinct_courses} track(s) — all {len(legs)} selections roll together"
            f"{ew_note} to multiply your odds."
        )
        struct_why = (
            f"keeping every leg from a separate race eliminates conflicting outcomes and hits "
            f"at a {ev['prob_all_place_pct' if each_way else 'prob_all_win_pct']:.1f}% full-slip rate."
        )
    else:
        has_singles = struct in ("patent", "lucky15")
        min_note = "just 1 winner already pays a return" if has_singles else "2 winners already guarantee a return"
        struct_desc = (
            f"{ev['structure_label']} across {distinct_courses} track(s) covering {ev['base_lines']} combinations — "
            f"{min_note}{' (doubled with Each-Way cover)' if each_way else ''}."
        )
        struct_why = (
            f"combining singles/doubles/trebles protects you if 1 or 2 picks finish just short "
            f"({ev['prob_any_return_pct']:.1f}% chance of a return)."
        )

    place_txt = f" • All-place return: £{ev['all_place_return']:.2f}" if each_way else ""
    avg_win_pct = sum(float(l.get("model_win_prob") or 0.0) * 100.0 for l in legs) / len(legs)
    top_rs = top_leg.get("reason_stats") or {}
    weak_cnt = int(top_rs.get("rivals_weak_form_count") or 0)
    disp_f = str(top_rs.get("display_form") or "").strip()
    if top_rs.get("weak_field_edge") and weak_cnt > 0:
        anchor_why = (
            f"{top_leg['horse_name']} brings form ({disp_f or 'recent wins'}) into a race where "
            f"{weak_cnt} rivals lack recent form, giving the slip a dependable lead runner."
        )
    elif disp_f:
        anchor_why = (
            f"{top_leg['horse_name']} carries recent figures {disp_f} alongside an average "
            f"{avg_win_pct:.1f}% win chance across the {len(legs)} leg(s)."
        )
    else:
        anchor_why = f"having {top_leg['horse_name']} as a top-rated anchor steadies the overall multiple ({avg_win_pct:.1f}% avg win rate)."

    return [
        f"Bet Structure: {struct_desc} — why it matters: {struct_why}",
        (
            f"Stake & Realistic Payout: £{ev['unit_stake']:.2f}/line across {ev['total_bets']} bets "
            f"(£{ev['total_stake']:.2f} total). Max payout if all win: £{ev['max_return']:.2f}{place_txt} — "
            f"why it matters: {ev['prob_any_return_pct']:.1f}% estimated chance of at least one return at sensible odds."
        ),
        (
            f"Headline Pick & Form Logic: {top_leg['horse_name']} ({top_leg['off_time']} {top_leg['course']}) leads at "
            f"{top_leg['model_rating']:.0f}/100 ({top_leg['model_win_prob']*100:.1f}% Win / {top_leg['model_place_prob']*100:.1f}% Place) — "
            f"why it matters: {anchor_why}"
        ),
        (
            f"Selection Safeguards: Strictly 1 horse per race across {', '.join(dict.fromkeys(l['course'] for l in legs))}, "
            "capping outsider risk inside your tier and skipping runners already in your slip or setbacks in news — "
            "why it matters: keeps the multiple realistic instead of chasing extreme longshots."
        ),
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


RACING_RISK_ODDS_BANDS: dict[str, tuple[float, float]] = {
    "low": (1.20, 3.75),
    "medium": (1.75, 6.50),
    "high": (3.25, 11.00),
    "longshot": (5.50, 21.00),
}


def build_racing_suggestions(
    conn: sqlite3.Connection,
    user: dict[str, Any] | None = None,
    exclude_legs: list[dict[str, Any]] | None = None,
    region: str | None = None,
    day: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    race_type: str | None = None,
) -> dict[str, Any]:
    """Build 4 diversified Quick Racing Cards (NAP Single, EW Double, Win/Place Treble, Lucky 15) for a date range."""
    all_tips = find_racing_tips(
        conn,
        user=user,
        region=region,
        day=day,
        date_from=date_from,
        date_to=date_to,
        race_type=race_type,
        limit=320,
    )
    race_keys, runner_keys = _racing_exclusion_sets(exclude_legs)
    if race_keys or runner_keys:
        all_tips = [t for t in all_tips if not _is_tip_excluded(t, race_keys, runner_keys, scope="race")]

    day_norm = str(day or "").strip().lower()
    has_custom = bool(_clean_iso_date(date_from) or _clean_iso_date(date_to))
    is_default_today = (not has_custom) and day_norm in ("", "all", "today")
    nap_title = "Today's NAP Single" if is_default_today else "NAP Win Single"
    l15_base = "Daily Lucky 15" if is_default_today else "Lucky 15"

    win_pool = [t for t in all_tips if t["market"] == "R_WIN"]
    ew_pool = [t for t in all_tips if t["market"] == "R_EW"]
    plc_pool = [t for t in all_tips if t["market"] == "R_PLC"]

    runner_usage: dict[int, int] = {}

    def _pick_diversified(
        pool: list[dict[str, Any]],
        count: int,
        min_odds: float = 1.15,
        max_odds: float = 30.0,
        fallback_pool: list[dict[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        seen_races: set[int] = set()
        seen_runners: set[int] = set()
        out: list[dict[str, Any]] = []

        candidates = [
            t
            for t in pool
            if min_odds <= float(t.get("win_odds") or t.get("odds") or 0.0) <= max_odds
        ]
        if len({int(t["race_id"]) for t in candidates}) < count and fallback_pool:
            seen_ids = {int(t["runner_id"]) for t in candidates}
            for extra in fallback_pool:
                if int(extra["runner_id"]) not in seen_ids and min_odds <= float(extra.get("win_odds") or extra.get("odds") or 0.0) <= max_odds:
                    candidates.append(extra)
                    seen_ids.add(int(extra["runner_id"]))
        if len({int(t["race_id"]) for t in candidates}) < count:
            candidates = list(pool) + [t for t in (fallback_pool or []) if t not in pool]

        ranked = sorted(
            enumerate(candidates),
            key=lambda pair: (runner_usage.get(int(pair[1]["runner_id"]), 0), pair[0]),
        )
        for _, item in ranked:
            rid_rc = int(item["race_id"])
            rid_rn = int(item["runner_id"])
            if rid_rc in seen_races or rid_rn in seen_runners:
                continue
            seen_races.add(rid_rc)
            seen_runners.add(rid_rn)
            runner_usage[rid_rn] = runner_usage.get(rid_rn, 0) + 1
            out.append(_tip_to_racing_leg(item))
            if len(out) >= count:
                break
        return out

    cards: list[dict[str, Any]] = []

    # 1. NAP Win Single
    nap_legs = _pick_diversified(win_pool or all_tips, 1, min_odds=1.25, max_odds=7.0, fallback_pool=all_tips)
    if nap_legs:
        ev = evaluate_racing_multiple(nap_legs, structure="single", each_way=False, unit_stake=10.0)
        cards.append(
            {
                "id": "nap_single",
                "title": nap_title,
                "badge": "🏆 Top Rated Win",
                "subtitle": f"{nap_legs[0]['off_time']} {nap_legs[0]['course']} • Best rating & edge on card",
                "structure": "single",
                "each_way": False,
                "unit_stake": 10.0,
                "legs": nap_legs,
                "eval": ev,
                "bet_reasons": _build_racing_bet_reasons(nap_title, nap_legs, ev, False),
                "bet365_export": build_racing_bet365_export(nap_legs, "single", False, 10.0, nap_title),
            }
        )

    # 2. Each-Way Value Double (prefers horses not yet used in NAP)
    ew_double_legs = _pick_diversified(
        ew_pool if len(ew_pool) >= 2 else win_pool,
        2,
        min_odds=4.0,
        max_odds=14.0,
        fallback_pool=win_pool,
    )
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

    # 3. Win / Place Treble (high-hit anchors 1.40 - 6.00 win odds)
    treble_pool = plc_pool if len(plc_pool) >= 3 else win_pool
    treble_legs = _pick_diversified(treble_pool, 3, min_odds=1.40, max_odds=6.00, fallback_pool=win_pool)
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

    # 4. Lucky 15 (4 balanced runners 2.00 - 9.50, preferring fresh picks)
    l15_base_pool = sorted(
        win_pool + ew_pool,
        key=lambda x: (x["model_rating"], x["model_win_prob_pct"]),
        reverse=True,
    )
    l15_legs = _pick_diversified(l15_base_pool, 4, min_odds=2.00, max_odds=9.50, fallback_pool=all_tips)
    if len(l15_legs) >= 4:
        avg_odds = sum(l["win_odds"] for l in l15_legs) / 4.0
        ew_l15 = avg_odds >= 3.8 and all(l["ew_eligible"] for l in l15_legs)
        l15_full_title = l15_base + (" (E/W)" if ew_l15 else " (Win)")
        ev = evaluate_racing_multiple(l15_legs, structure="lucky15", each_way=ew_l15, unit_stake=1.0)
        cards.append(
            {
                "id": "daily_lucky15",
                "title": l15_full_title,
                "badge": "🍀 Lucky 15 (30 Bets)" if ew_l15 else "🍀 Lucky 15 (15 Bets)",
                "subtitle": "4 Singles, 6 Doubles, 4 Trebles & 4-Fold Acca across 4 races",
                "structure": "lucky15",
                "each_way": ew_l15,
                "unit_stake": 1.0,
                "legs": l15_legs,
                "eval": ev,
                "bet_reasons": _build_racing_bet_reasons(l15_base, l15_legs, ev, ew_l15),
                "bet365_export": build_racing_bet365_export(l15_legs, "lucky15", ew_l15, 1.0, l15_base),
            }
        )

    return {
        "cards": cards,
        "structures": RACING_MULTIPLES,
        "total_pool_tips": len(all_tips),
        "available_dates": get_available_racing_dates(conn),
    }


def _score_racing_candidate_for_risk(tip: dict[str, Any], risk_level: str) -> float:
    win_odds = float(tip.get("win_odds") or tip.get("odds") or 3.0)
    rating = float(tip.get("model_rating") or 50.0)
    win_p = float(tip.get("model_win_prob_pct") or 10.0)
    plc_p = float(tip.get("model_place_prob_pct") or 30.0)
    edge = max(-12.0, min(25.0, float(tip.get("edge_pct") or 0.0)))
    rs = tip.get("reason_stats") or {}
    form_bonus = 6.0 if rs.get("weak_field_edge") else 0.0
    news_bonus = 3.5 if rs.get("news_sentiment") == "positive" else 0.0
    if risk_level == "low":
        return plc_p * 1.25 + win_p * 1.05 + rating * 0.50 + form_bonus + news_bonus - max(0.0, win_odds - 3.3) * 6.0
    if risk_level == "high":
        return edge * 0.70 + min(win_odds, 10.5) * 1.8 + rating * 0.70 + plc_p * 0.45 + form_bonus + news_bonus - max(0.0, 3.25 - win_odds) * 8.0
    if risk_level == "longshot":
        return edge * 0.65 + min(win_odds, 18.0) * 1.6 + plc_p * 0.75 + form_bonus + news_bonus - max(0.0, 5.50 - win_odds) * 10.0
    return rating * 0.85 + win_p * 0.90 + plc_p * 0.65 + edge * 0.55 + form_bonus + news_bonus - max(0.0, win_odds - 5.2) * 3.5


def build_custom_racing_bets(
    conn: sqlite3.Connection,
    user: dict[str, Any] | None = None,
    criteria: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build 1-3 custom UK horse racing multiples within strict risk-tier odds bands."""
    crit = criteria or {}
    struct = str(crit.get("structure") or "lucky15").strip().lower()
    if struct not in RACING_MULTIPLES:
        struct = "lucky15"
    spec = RACING_MULTIPLES[struct]
    each_way = bool(crit.get("each_way"))
    unit_stake = round(max(0.1, float(crit.get("unit_stake") or 1.0)), 2)
    style = str(crit.get("style") or "ALL").strip().upper()
    risk_level = str(crit.get("risk_level") or "medium").strip().lower()
    if risk_level not in RACING_RISK_ODDS_BANDS:
        risk_level = "medium"

    if struct == "acca":
        req_legs = max(2, min(6, int(crit.get("legs_count") or 4)))
    else:
        req_legs = spec["min_legs"]

    num_bets = max(1, min(3, int(crit.get("num_bets") or 1)))
    region = (crit.get("region") or "ALL").strip()
    day = (crit.get("day") or "all").strip()
    date_from = crit.get("date_from")
    date_to = crit.get("date_to")
    race_type = (crit.get("race_type") or "ALL").strip()
    exclude_already = bool(crit.get("exclude_already_bet", True))
    exclude_scope = "runner" if crit.get("exclude_scope") == "runner" else "race"
    avail_dates = get_available_racing_dates(conn)

    # Fetch full race pool rather than only single-market deduped tips so every risk band has deep coverage
    raw_pool = find_racing_tips(
        conn,
        user=user,
        region=region,
        bet_type=style,
        day=day,
        race_type=race_type,
        limit=400,
        date_from=date_from,
        date_to=date_to,
    )
    if each_way:
        ew_filtered = [t for t in raw_pool if t.get("ew_eligible") and float(t.get("win_odds") or t.get("odds") or 0.0) >= 2.0]
        if ew_filtered:
            raw_pool = ew_filtered
    elif style == "ALL" and risk_level != "low":
        win_like = [t for t in raw_pool if t.get("market") in ("R_WIN", "R_EW")]
        if len({int(t["race_id"]) for t in win_like}) >= req_legs:
            raw_pool = win_like

    excl_legs = list(crit.get("excluded_legs") or []) if exclude_already else []
    avoid_legs = list(crit.get("avoid_legs") or [])
    race_keys, runner_keys = _racing_exclusion_sets(excl_legs)
    avoid_rk, avoid_rn = _racing_exclusion_sets(avoid_legs)

    eligible: list[dict[str, Any]] = []
    for t in raw_pool:
        if exclude_already and _is_tip_excluded(t, race_keys, runner_keys, scope=exclude_scope):
            continue
        if (avoid_rk or avoid_rn) and _is_tip_excluded(t, avoid_rk, avoid_rn, scope="race"):
            continue
        eligible.append(t)

    min_o, max_o = RACING_RISK_ODDS_BANDS[risk_level]
    in_band = [t for t in eligible if min_o <= float(t.get("win_odds") or t.get("odds") or 0.0) <= max_o]
    if len({int(t["race_id"]) for t in in_band}) < req_legs:
        fb_min, fb_max = (1.15, 9.0) if risk_level in ("low", "medium") else (2.50, 21.0)
        in_band = [t for t in eligible if fb_min <= float(t.get("win_odds") or t.get("odds") or 0.0) <= fb_max]
    if not in_band:
        in_band = eligible

    filtered: list[dict[str, Any]] = []
    for t in in_band:
        t_copy = dict(t)
        t_copy["_score"] = _score_racing_candidate_for_risk(t, risk_level)
        filtered.append(t_copy)
    filtered.sort(key=lambda x: x["_score"], reverse=True)

    if not filtered:
        return {
            "bets": [],
            "requested_bets": num_bets,
            "requested_legs": req_legs,
            "excluded_count": len(race_keys),
            "available_pool_count": 0,
            "available_dates": avail_dates,
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

        legs: list[dict[str, Any]] = []
        for p in picked:
            leg = _tip_to_racing_leg(p)
            if each_way and leg.get("ew_eligible") and leg.get("market") != "R_EW":
                leg["market"] = "R_EW"
                leg["bet_type"] = "r_ew"
                leg["bet_type_label"] = "Each-Way"
                leg["selection_label"] = f"{leg['horse_name']} (E/W)"
                leg["odds"] = leg["win_odds"]
                leg["odds_fractional"] = _fmt_uk_odds_text(leg["win_odds"])
                leg["model_prob"] = round(0.5 * (leg["model_win_prob"] + leg["model_place_prob"]), 5)
            legs.append(leg)

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
        "available_dates": avail_dates,
        "notice": notice,
    }
