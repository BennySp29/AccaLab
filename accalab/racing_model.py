"""Horse racing runner rating, softmax win probability, and Stern-Harville place probability engine."""

from __future__ import annotations

import json
import math
import re
import sqlite3
import statistics
from typing import Any

from accalab.db import utc_now_iso


def uk_place_terms(runners_count: int, is_handicap: bool) -> dict[str, Any]:
    """Return standard UK/IRE bookmaker Each-Way place terms for a race field size & type."""
    n = max(1, int(runners_count or 1))
    if n < 5:
        return {
            "places_paid": 1,
            "place_fraction": 0.0,
            "ew_eligible": False,
            "label": "Win Only (<5 runners)",
        }
    if n <= 7:
        return {
            "places_paid": 2,
            "place_fraction": 0.25,
            "ew_eligible": True,
            "label": "1/4 odds, 1–2",
        }
    if n <= 11:
        return {
            "places_paid": 3,
            "place_fraction": 0.20,
            "ew_eligible": True,
            "label": "1/5 odds, 1–3",
        }
    if n <= 15:
        if is_handicap:
            return {
                "places_paid": 3,
                "place_fraction": 0.25,
                "ew_eligible": True,
                "label": "1/4 odds, 1–3",
            }
        return {
            "places_paid": 3,
            "place_fraction": 0.20,
            "ew_eligible": True,
            "label": "1/5 odds, 1–3",
        }
    if is_handicap:
        return {
            "places_paid": 4,
            "place_fraction": 0.25,
            "ew_eligible": True,
            "label": "1/4 odds, 1–4",
        }
    return {
        "places_paid": 3,
        "place_fraction": 0.20,
        "ew_eligible": True,
        "label": "1/5 odds, 1–3",
    }


def _score_form_token(tok: str) -> float:
    t = tok.upper()
    if t == "1":
        return 1.00
    if t == "2":
        return 0.65
    if t == "3":
        return 0.42
    if t == "4":
        return 0.22
    if t == "5":
        return 0.08
    if t in ("6", "7", "8", "9"):
        return -0.12
    if t == "0":
        return -0.30
    return -0.35


def parse_form_figures(form_str: str, direction: str = "rtl") -> dict[str, Any]:
    """Parse UK ('321-41', rtl) or PMU ('2p3p6p(25)1p', ltr) form figures into most-recent-first metrics."""
    raw = str(form_str or "").strip()
    if not raw:
        return {
            "figures": [],
            "numeric_last": None,
            "form_score": -0.05,
            "recent_wins": 0,
            "recent_places": 0,
            "display_form": "",
        }

    figures: list[str] = []
    if direction == "ltr":
        cleaned = re.sub(r"\(\d{2,4}\)", "", raw)
        for m in re.finditer(r"([0-9]+|[A-Za-z])[phsamocPHSAMOC]?", cleaned):
            ch = m.group(1)
            if ch.isdigit() and int(ch) >= 10:
                figures.append("0")
            elif ch.isdigit() and ch == "0":
                figures.append("0")
            else:
                figures.append(ch[0].upper())
    else:
        # Standard UK form reads left-to-right chronologically; rightmost token is most recent.
        # Strip UK/AUS spell markers ('x'/'X') alongside '-' / '/' separators so layoffs aren't penalized as falls.
        cleaned = re.sub(r"[-/\\\s,xX]+", "", raw)
        tokens = [ch.upper() for ch in cleaned if ch.isalnum()]
        figures = list(reversed(tokens))

    if not figures:
        return {
            "figures": [],
            "numeric_last": None,
            "form_score": -0.05,
            "recent_wins": 0,
            "recent_places": 0,
            "display_form": raw[:12],
        }

    window = figures[:6]
    weighted = 0.0
    w_sum = 0.0
    wins = 0
    places = 0
    for idx, fig in enumerate(window):
        w = 0.72 ** idx
        weighted += w * _score_form_token(fig)
        w_sum += w
        if fig == "1":
            wins += 1
            places += 1
        elif fig in ("2", "3"):
            places += 1

    last_ch = figures[0]
    numeric_last: int | None = None
    if last_ch.isdigit():
        numeric_last = 10 if last_ch == "0" else int(last_ch)

    return {
        "figures": window,
        "numeric_last": numeric_last,
        "form_score": round(weighted / max(1e-6, w_sum), 4),
        "recent_wins": wins,
        "recent_places": places,
        "display_form": "-".join(window),
    }


def compute_place_probabilities(win_probs: list[float], places_paid: int) -> list[float]:
    """Compute top-K finishing probabilities via Stern-adjusted Harville (gamma=0.85)."""
    n = len(win_probs)
    if n == 0:
        return []
    if places_paid <= 1:
        return [round(max(0.004, min(0.99, p)), 5) for p in win_probs]
    if places_paid >= n:
        return [0.99] * n

    p_sum = sum(max(1e-6, p) for p in win_probs)
    p = [max(1e-6, val) / p_sum for val in win_probs]

    gamma = 0.85
    q_raw = [pi ** gamma for pi in p]
    q_sum = sum(q_raw)
    q = [qi / q_sum for qi in q_raw]

    p2 = [0.0] * n
    for i in range(n):
        acc = 0.0
        qi = q[i]
        for j in range(n):
            if j != i:
                acc += p[j] * (qi / max(1e-9, 1.0 - q[j]))
        p2[i] = acc

    place_probs = [p[i] + p2[i] for i in range(n)]

    if places_paid >= 3:
        p3 = [0.0] * n
        if n <= 24:
            for a in range(n):
                pa = p[a]
                den1 = max(1e-9, 1.0 - q[a])
                for b in range(n):
                    if b == a:
                        continue
                    pab = pa * (q[b] / den1)
                    den2 = max(1e-9, 1.0 - q[a] - q[b])
                    for c in range(n):
                        if c == a or c == b:
                            continue
                        p3[c] += pab * (q[c] / den2)
        else:
            rem = [max(1e-6, 1.0 - place_probs[i]) * q[i] for i in range(n)]
            r_sum = sum(rem) or 1.0
            p3 = [r / r_sum for r in rem]
        place_probs = [place_probs[i] + p3[i] for i in range(n)]

    for _slot in range(3, places_paid):
        rem = [max(1e-6, 1.0 - place_probs[i]) * q[i] for i in range(n)]
        r_sum = sum(rem) or 1.0
        place_probs = [place_probs[i] + (rem[i] / r_sum) for i in range(n)]

    # Clamp each horse to [win_prob, 0.96] and gently balance remaining headroom so sum ~= places_paid
    capped = [min(0.96, max(p[i], place_probs[i])) for i in range(n)]
    target_sum = float(min(places_paid, n))
    for _ in range(4):
        cur_sum = sum(capped)
        if abs(cur_sum - target_sum) < 1e-4:
            break
        diff = target_sum - cur_sum
        if diff > 0:
            weights = [max(0.0, 0.96 - capped[i]) for i in range(n)]
        else:
            weights = [max(0.0, capped[i] - p[i]) for i in range(n)]
        w_tot = sum(weights)
        if w_tot <= 1e-6:
            break
        for i in range(n):
            capped[i] = min(0.96, max(p[i], capped[i] + diff * (weights[i] / w_tot)))

    return [round(val, 5) for val in capped]


def _z_standardize(vals: list[float]) -> list[float]:
    if len(vals) <= 1:
        return [0.0 for _ in vals]
    mean_v = sum(vals) / len(vals)
    var = sum((v - mean_v) ** 2 for v in vals) / len(vals)
    sd = math.sqrt(var)
    if sd < 1e-6:
        return [0.0 for _ in vals]
    return [max(-2.6, min(2.6, (v - mean_v) / sd)) for v in vals]


def _build_connection_strength_maps(conn: sqlite3.Connection) -> tuple[dict[str, float], dict[str, float]]:
    """Build Empirical Bayes strike-rate strength maps for trainers and jockeys across loaded cards."""
    rows = conn.execute(
        """
        SELECT trainer, jockey, career_runs, career_wins, career_places
        FROM racing_runners
        WHERE non_runner = 0
        """
    ).fetchall()

    def _agg(field: str) -> dict[str, float]:
        stats: dict[str, list[float]] = {}
        for r in rows:
            nm = str(r[field] or "").strip()
            if not nm:
                continue
            runs = max(1, int(r["career_runs"] or 0))
            wins = int(r["career_wins"] or 0)
            plcs = int(r["career_places"] or 0)
            entry = stats.setdefault(nm, [0.0, 0.0, 0.0])
            entry[0] += runs
            entry[1] += wins
            entry[2] += plcs
        scores: dict[str, float] = {}
        for nm, (runs, wins, plcs) in stats.items():
            scores[nm] = (wins + 1.5 * 0.14 + 0.35 * (plcs + 0.35)) / (runs + 12.0)
        if not scores:
            return {}
        avg = sum(scores.values()) / len(scores)
        return {nm: val - avg for nm, val in scores.items()}

    return _agg("trainer"), _agg("jockey")


def _fmt_uk_odds_text(dec: float | None) -> str:
    if not dec or dec <= 1.01:
        return "—"
    table = (
        (1, 2), (4, 7), (4, 6), (4, 5), (10, 11), (1, 1), (11, 10), (6, 5), (5, 4), (11, 8),
        (6, 4), (13, 8), (7, 4), (15, 8), (2, 1), (9, 4), (5, 2), (11, 4), (3, 1), (10, 3),
        (7, 2), (4, 1), (9, 2), (5, 1), (11, 2), (6, 1), (13, 2), (7, 1), (15, 2), (8, 1),
        (9, 1), (10, 1),
    )
    if dec > 11.0:
        return f"{max(10, round(dec - 1.0))}/1"
    best = min(table, key=lambda fr: abs(1.0 + fr[0] / fr[1] - dec))
    return f"{best[0]}/{best[1]}"


def _build_runner_reasons(
    race: dict[str, Any],
    runner: dict[str, Any],
    parsed_form: dict[str, Any],
    terms: dict[str, Any],
    ref_odds: float,
    odds_source: str,
    win_prob: float,
    place_prob: float,
    win_edge_pct: float,
    ew_edge_pct: float,
    matched_news: dict[str, Any] | None,
) -> tuple[list[str], dict[str, Any]]:
    rating = float(runner["model_rating"])
    or_val = runner.get("official_rating")
    w_disp = runner.get("weight_display") or ""
    disp_form = parsed_form.get("display_form") or ("Debutant" if runner.get("is_debutant") else "Unexposed")
    runs = int(runner.get("career_runs") or 0)
    wins = int(runner.get("career_wins") or 0)
    plcs = int(runner.get("career_places") or 0)

    or_txt = f"OR {or_val}" if or_val else "Unrated"
    w_txt = f" • {w_disp}" if w_disp else ""
    career_txt = f"{wins}W / {plcs}P in {runs} runs" if runs > 0 else "Lightly raced / unexposed"
    b1 = f"Form & Class: Rated {rating:.0f}/100 ({or_txt}{w_txt}) • Recent {disp_form} • {career_txt}."

    dist = race.get("distance_text") or "distance"
    going = race.get("going") or race.get("surface") or "prevailing ground"
    draw_txt = f" • Stall {runner['draw']}" if runner.get("draw") else ""
    hg_txt = f" • {runner['headgear']}" if runner.get("headgear") else ""
    fresh_txt = f" • {runner['days_since_run']}d since last run" if runner.get("days_since_run") else ""
    b2 = (
        f"Conditions & Draw: {race['course']} {dist} ({race['race_type']}) on {going}"
        f"{draw_txt}{hg_txt}{fresh_txt} ({terms['places_paid']} of {race['runners_count']} places: {terms['label']})."
    )

    fair_win = 1.0 / max(0.005, win_prob)
    fair_plc = 1.0 / max(0.01, place_prob)
    src_lbl = "live market" if odds_source in ("live_fixed", "pmu_tote", "user_manual") else "model tissue"
    ew_note = (
        f"EW fair min > {_fmt_uk_odds_text(fair_win)} ({terms['label']}, EW edge {ew_edge_pct:+.1f}%)"
        if terms["ew_eligible"]
        else "Win-only field (<5 runners)"
    )
    b3 = (
        f"Win/Place Value Math: {win_prob * 100:.1f}% Win (fair {_fmt_uk_odds_text(fair_win)}) & "
        f"{place_prob * 100:.1f}% Place (fair {_fmt_uk_odds_text(fair_plc)}) vs {_fmt_uk_odds_text(ref_odds)} {src_lbl} "
        f"({win_edge_pct:+.1f}% Win edge) • {ew_note}."
    )

    tr = runner.get("trainer") or "Yard"
    jk = runner.get("jockey") or "Jockey TBA"
    if matched_news:
        b4 = f"Connections & News: {jk} rides for {tr} • [{matched_news['source']}] {matched_news['title']}."
    else:
        b4 = f"Connections: {jk} booked for trainer {tr} in {race['runners_count']}-runner {race['race_type']} field."

    career_record = f"{wins}-{plcs}-{runs}" if runs > 0 else "Unraced"
    stats = {
        "model_rating": round(rating, 1),
        "official_rating": or_val,
        "weight_display": w_disp,
        "display_form": disp_form,
        "win_prob_pct": round(win_prob * 100.0, 1),
        "place_prob_pct": round(place_prob * 100.0, 1),
        "fair_win_odds": round(fair_win, 2),
        "fair_place_odds": round(fair_plc, 2),
        "place_terms_label": terms["label"],
        "career_record": career_record,
        "runners_count": int(race["runners_count"]),
    }
    return [b1, b2, b3, b4], stats


def score_and_predict_races(conn: sqlite3.Connection) -> dict[str, Any]:
    """Score every loaded horse race, fit softmax Win + Stern-Harville Place probs, and compute edges."""
    races = [dict(r) for r in conn.execute("SELECT * FROM racing_races ORDER BY race_date ASC, off_time ASC").fetchall()]
    if not races:
        return {"races_scored": 0, "runners_scored": 0}

    trainer_map, jockey_map = _build_connection_strength_maps(conn)
    news_rows = [dict(r) for r in conn.execute("SELECT * FROM racing_news ORDER BY published_at DESC LIMIT 25").fetchall()]
    now = utc_now_iso()
    races_scored = 0
    runners_scored = 0

    for race in races:
        all_runners = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM racing_runners WHERE race_id = ? ORDER BY saddle_cloth ASC, id ASC",
                (race["id"],),
            ).fetchall()
        ]
        if not all_runners:
            continue

        active = [r for r in all_runners if not r["non_runner"]]
        for nr in all_runners:
            if nr["non_runner"]:
                conn.execute(
                    """
                    UPDATE racing_runners SET
                        model_rating = 0.0, model_win_prob = 0.0, model_place_prob = 0.0,
                        fair_win_odds = 0.0, fair_place_odds = 0.0,
                        win_edge_pct = -100.0, ew_edge_pct = -100.0,
                        reasons_json = ?, reason_stats_json = '{}', updated_at = ?
                    WHERE id = ?
                    """,
                    (json.dumps(["Non-Runner: declared withdrawn from this race."]), now, nr["id"]),
                )

        n = len(active)
        if n == 0:
            continue

        terms = uk_place_terms(n, bool(race["is_handicap"]))
        conn.execute(
            "UPDATE racing_races SET runners_count = ?, places_paid = ?, place_fraction = ? WHERE id = ?",
            (n, terms["places_paid"], terms["place_fraction"], race["id"]),
        )
        race["runners_count"] = n

        parsed_forms = [parse_form_figures(r.get("form_string") or "", r.get("form_direction") or "rtl") for r in active]
        form_raw = [pf["form_score"] for pf in parsed_forms]

        # Class & Weight signal
        weights = [float(r["weight_lbs"]) for r in active if r.get("weight_lbs")]
        med_weight = statistics.median(weights) if weights else None
        or_vals = [float(r["official_rating"]) for r in active if r.get("official_rating")]
        use_or = len(or_vals) >= max(2, int(math.ceil(n * 0.5)))
        med_or = statistics.median(or_vals) if or_vals else None

        rating_weight_raw: list[float] = []
        for r in active:
            if use_or and med_or is not None:
                base_r = float(r["official_rating"]) if r.get("official_rating") else med_or
                if med_weight is not None and r.get("weight_lbs"):
                    slope = 0.65 if race["is_handicap"] else 0.30
                    base_r -= slope * (float(r["weight_lbs"]) - med_weight)
                rating_weight_raw.append(base_r)
            else:
                runs_c = max(1, int(r.get("career_runs") or 0))
                earn = float(r.get("career_earnings") or 0.0)
                earn_metric = math.log1p(earn / runs_c) if earn > 0 else 0.0
                if med_weight is not None and r.get("weight_lbs") and not earn_metric:
                    earn_metric = -0.05 * (float(r["weight_lbs"]) - med_weight)
                rating_weight_raw.append(earn_metric)

        # Empirical Bayes Career strike & place rate
        career_raw: list[float] = []
        for r in active:
            runs_c = int(r.get("career_runs") or 0)
            wins_c = int(r.get("career_wins") or 0)
            plcs_c = int(r.get("career_places") or 0)
            eb_win = (wins_c + 0.6) / (runs_c + 6.0)
            eb_plc = (plcs_c + 1.2) / (runs_c + 6.0)
            career_raw.append(eb_win + 0.45 * eb_plc)

        # Connections (Trainer + Jockey)
        conn_raw: list[float] = []
        for r in active:
            tr = trainer_map.get(str(r.get("trainer") or "").strip(), 0.0)
            jk = jockey_map.get(str(r.get("jockey") or "").strip(), 0.0)
            deb_adj = -0.04 if r.get("is_debutant") else 0.0
            conn_raw.append(0.55 * tr + 0.45 * jk + deb_adj)

        # Conditions, freshness & draw
        cond_raw: list[float] = []
        for r in active:
            val = 0.0
            dsr = r.get("days_since_run")
            if dsr is not None:
                if 10 <= dsr <= 45:
                    val += 0.35
                elif dsr > 180:
                    val -= 0.35
            if race["race_type"] == "Flat" and n >= 10 and r.get("draw"):
                draw_num = float(r["draw"])
                mid = (n + 1) / 2.0
                val -= 0.03 * ((draw_num - mid) / max(1.0, n / 2.0)) * 5.0
            if r.get("headgear"):
                val += 0.12
            cond_raw.append(val)

        z_form = _z_standardize(form_raw)
        z_rw = _z_standardize(rating_weight_raw)
        z_car = _z_standardize(career_raw)
        z_conn = _z_standardize(conn_raw)
        z_cond = _z_standardize(cond_raw)

        comp_scores = [
            0.35 * z_form[i] + 0.27 * z_rw[i] + 0.19 * z_car[i] + 0.11 * z_conn[i] + 0.08 * z_cond[i]
            for i in range(n)
        ]

        temp = 0.72 if n <= 7 else (0.78 if n <= 13 else 0.84)
        max_sc = max(comp_scores)
        exp_vals = [math.exp((sc - max_sc) / temp) for sc in comp_scores]
        exp_sum = sum(exp_vals) or 1.0
        fundamental_probs = [ev / exp_sum for ev in exp_vals]

        # Check live market coverage
        live_sources = {"live_fixed", "pmu_tote", "user_manual"}
        live_entries = [
            r.get("market_odds")
            for r in active
            if r.get("odds_source") in live_sources and r.get("market_odds") and float(r["market_odds"]) > 1.01
        ]
        has_market_blend = len(live_entries) >= max(2, int(math.ceil(n * 0.70)))
        if has_market_blend:
            raw_mkt_inv = [
                (1.0 / float(r["market_odds"]))
                if (r.get("odds_source") in live_sources and r.get("market_odds") and float(r["market_odds"]) > 1.01)
                else fundamental_probs[i]
                for i, r in enumerate(active)
            ]
            mkt_sum = sum(raw_mkt_inv) or 1.0
            mkt_probs = [v / mkt_sum for v in raw_mkt_inv]
            blended = [0.70 * fundamental_probs[i] + 0.30 * mkt_probs[i] for i in range(n)]
        else:
            blended = list(fundamental_probs)

        clamped = [max(0.004, min(0.88, p)) for p in blended]
        norm_sum = sum(clamped) or 1.0
        win_probs = [round(p / norm_sum, 5) for p in clamped]
        place_probs = compute_place_probabilities(win_probs, terms["places_paid"])

        top_comp = max(comp_scores)
        matched_news = None
        course_low = race["course"].lower()
        for nw in news_rows:
            if course_low and course_low in f"{nw['title']} {nw['summary']}".lower():
                matched_news = nw
                break
        if not matched_news and news_rows:
            for nw in news_rows:
                hay = f"{nw['title']} {nw['summary']}".lower()
                if any(r["horse_name"].lower() in hay for r in active):
                    matched_news = nw
                    break

        tissue_overround = min(1.22, 1.0 + 0.012 * n)
        for i, r in enumerate(active):
            p_win = win_probs[i]
            p_plc = place_probs[i]
            comp = comp_scores[i]
            rating = 40.0 + 54.0 * (1.0 / (1.0 + math.exp(-0.95 * comp)))
            if comp == top_comp:
                rating += 4.0
            rating = round(max(40.0, min(98.0, rating)), 1)
            r["model_rating"] = rating

            fair_win = round(1.0 / max(0.004, p_win), 2)
            fair_plc = round(1.0 / max(0.01, p_plc), 2)

            existing_src = str(r.get("odds_source") or "model_tissue")
            existing_odds = r.get("market_odds")
            if existing_src in live_sources and existing_odds and float(existing_odds) > 1.01:
                ref_odds = round(float(existing_odds), 2)
                final_src = existing_src
            else:
                tissue_p = 0.72 * p_win + 0.28 * (1.0 / n)
                ref_odds = round(max(1.12, 1.0 / max(0.004, tissue_p * tissue_overround)), 2)
                final_src = "model_tissue"

            win_edge = (p_win * ref_odds - 1.0) * 100.0
            if terms["ew_eligible"] and terms["place_fraction"] > 0:
                plc_odds = 1.0 + (ref_odds - 1.0) * terms["place_fraction"]
                ew_edge = 0.5 * ((p_win * ref_odds - 1.0) + (p_plc * plc_odds - 1.0)) * 100.0
            else:
                ew_edge = win_edge

            reasons, reason_stats = _build_runner_reasons(
                race=race,
                runner=r,
                parsed_form=parsed_forms[i],
                terms=terms,
                ref_odds=ref_odds,
                odds_source=final_src,
                win_prob=p_win,
                place_prob=p_plc,
                win_edge_pct=win_edge,
                ew_edge_pct=ew_edge,
                matched_news=matched_news,
            )

            conn.execute(
                """
                UPDATE racing_runners SET
                    market_odds = ?, odds_source = ?,
                    model_rating = ?, model_win_prob = ?, model_place_prob = ?,
                    fair_win_odds = ?, fair_place_odds = ?,
                    win_edge_pct = ?, ew_edge_pct = ?,
                    reasons_json = ?, reason_stats_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    ref_odds,
                    final_src,
                    rating,
                    p_win,
                    p_plc,
                    fair_win,
                    fair_plc,
                    round(win_edge, 2),
                    round(ew_edge, 2),
                    json.dumps(reasons),
                    json.dumps(reason_stats),
                    now,
                    r["id"],
                ),
            )
            runners_scored += 1
        races_scored += 1

    return {"races_scored": races_scored, "runners_scored": runners_scored}
