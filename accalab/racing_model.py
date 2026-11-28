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
            "form_score": 0.05,
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


def _z_standardize(vals: list[float], floor_sd: float = 0.15) -> list[float]:
    if len(vals) <= 1:
        return [0.0 for _ in vals]
    mean_v = sum(vals) / len(vals)
    var = sum((v - mean_v) ** 2 for v in vals) / len(vals)
    sd = max(math.sqrt(var), floor_sd)
    return [max(-2.6, min(2.6, (v - mean_v) / sd)) for v in vals]


_RACE_CONTEXT_RE = re.compile(r"\b(trainer|winners?|champion|yard|stable|horse|racing|jumps?|flat)\b", re.I)
_TRACK_CONTEXT_RE = re.compile(
    r"\b(going|ground|heavy|soft|good|firm|abandon\w*|cancel\w*|inspection|waterlog\w*|frost|drought|course|meeting|festival|cup|stakes)\b",
    re.I,
)
_NEWS_CAUTION_RE = re.compile(
    r"\b(injur\w*|setback|doubt\w*|lame|colic|withdraw\w*|pulled up|struggl\w*|ban\w*|suspend\w*|miss\w*|sore|wind op)\b",
    re.I,
)
_NEWS_TRACK_ALERT_RE = re.compile(
    r"\b(drought|heavy|waterlog\w*|inspection|testing|abandon\w*|cancel\w*|frost)\b",
    re.I,
)
_NEWS_POSITIVE_RE = re.compile(
    r"\b(wins?|winner|record|champion|flying|healthy|fit|thriving|impressive|unbeaten|star|targets?|ready|peak|confident|success|prolific)\b",
    re.I,
)


def _classify_racing_news(
    race: dict[str, Any],
    runner: dict[str, Any],
    news_rows: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """Match racing news headlines cleanly to horse, trainer, or track conditions and classify sentiment."""
    if not news_rows:
        return None
    horse = str(runner.get("horse_name") or "").strip()
    trainer = str(runner.get("trainer") or "").strip()
    course = str(race.get("course") or "").strip()

    matched_nw: dict[str, Any] | None = None
    match_type = ""

    if len(horse) >= 5:
        pat = re.compile(rf"\b{re.escape(horse)}\b", re.I)
        for nw in news_rows:
            hay = f"{nw.get('title', '')} {nw.get('summary', '')}"
            if pat.search(hay):
                matched_nw = nw
                match_type = "horse"
                break

    if matched_nw is None and trainer:
        pat_full = re.compile(rf"\b{re.escape(trainer)}\b", re.I) if len(trainer) >= 5 else None
        surname_toks = [tok for tok in re.split(r"[\s\-]+", trainer) if len(tok) >= 6]
        surname = surname_toks[-1] if surname_toks else ""
        pat_sur = re.compile(rf"\b{re.escape(surname)}\b", re.I) if surname else None
        for nw in news_rows:
            hay = f"{nw.get('title', '')} {nw.get('summary', '')}"
            if pat_full and pat_full.search(hay):
                matched_nw = nw
                match_type = "trainer"
                break
            if pat_sur and pat_sur.search(hay) and _RACE_CONTEXT_RE.search(hay):
                matched_nw = nw
                match_type = "trainer"
                break

    if matched_nw is None and len(course) >= 4:
        pat_cr = re.compile(rf"\b{re.escape(course)}\b", re.I)
        for nw in news_rows:
            hay = f"{nw.get('title', '')} {nw.get('summary', '')}"
            if pat_cr.search(hay) and _TRACK_CONTEXT_RE.search(hay):
                matched_nw = nw
                match_type = "course"
                break

    if matched_nw is None:
        return None

    hay = f"{matched_nw.get('title', '')} {matched_nw.get('summary', '')}"
    if _NEWS_CAUTION_RE.search(hay):
        sentiment = "caution"
    elif match_type == "course" and _NEWS_TRACK_ALERT_RE.search(hay):
        sentiment = "track_alert"
    elif _NEWS_POSITIVE_RE.search(hay):
        sentiment = "positive"
    else:
        sentiment = "neutral"

    return {
        "source": matched_nw.get("source") or "Racing Feed",
        "title": matched_nw.get("title") or "",
        "match_type": match_type,
        "sentiment": sentiment,
    }


_match_racing_news = _classify_racing_news


def _describe_recent_form(
    horse_name: str,
    parsed_form: dict[str, Any],
    runs: int,
    wins: int,
    plcs: int,
    is_debutant: bool,
    field_ctx: dict[str, Any] | None = None,
) -> str:
    ctx = field_ctx or {}
    n = int(ctx.get("n") or 1)
    form_rank = int(ctx.get("form_rank") or 1)
    rivals_weak = int(ctx.get("rivals_weak_form_count") or 0)
    rivals_lto_win = int(ctx.get("rivals_lto_winners") or 0)
    weak_field_edge = bool(ctx.get("weak_field_edge"))
    form_leader = str(ctx.get("form_leader_name") or "the form leader")
    model_rank = int(ctx.get("model_rank") or 1)
    trainer = str(ctx.get("trainer") or "the yard")
    ref_odds_txt = str(ctx.get("ref_odds_txt") or "")
    or_val = ctx.get("official_rating")

    figs = parsed_form.get("figures") or []
    disp = parsed_form.get("display_form") or ""
    f_score = float(parsed_form.get("form_score") or 0.0)
    rec_places = int(parsed_form.get("recent_places") or 0)

    if is_debutant or (not figs and runs == 0):
        exp_rivals = int(ctx.get("experienced_rivals") or max(0, n - 1))
        odds_note = f" and {ref_odds_txt} market support" if ref_odds_txt and ref_odds_txt != "—" else ""
        return (
            f"Unraced debutant with no public form yet against {exp_rivals} experienced rival(s) — "
            f"why it matters: {horse_name}'s chance relies on {trainer}'s debut readiness{odds_note} rather than proven racecourse figures."
        )

    last = figs[0] if figs else ""
    if last == "1":
        lead = "Won last time out"
    elif last == "2":
        lead = "Finished 2nd last time out"
    elif last == "3":
        lead = "Placed 3rd last time out"
    elif last == "4":
        lead = "Finished 4th last time out"
    elif last in ("F", "U", "P", "R", "B"):
        lead = "Failed to complete last time out"
    else:
        lead = "Finished outside the frame last time out"

    seq_txt = f" (recent figures: {disp})" if disp else ""
    career_txt = (
        f" • {wins} win{'s' if wins != 1 else ''} & {plcs} place{'s' if plcs != 1 else ''} in {runs} career starts"
        if runs > 0
        else ""
    )
    field_txt = (
        f" • Ranks #{form_rank} of {n} on form ({rivals_weak} of {max(1, n - 1)} rivals are out of form)"
        if n > 1
        else ""
    )

    if weak_field_edge and n > 1:
        why = (
            f"{horse_name} brings proven form (#{form_rank} in field) into a race where {rivals_weak} of {n - 1} rivals "
            f"have struggled for recent finishes, giving it a clear fitness and consistency edge."
        )
    elif f_score >= 0.30:
        why = (
            f"{horse_name} ranks #{form_rank} of {n} on recent form ({rec_places} top-3 finishes in last {len(figs)}) "
            f"against {rivals_lto_win} last-time-out winner(s), showing reliable current wellbeing."
        )
    elif model_rank <= 3 and f_score < 0.20 and n > 1:
        anchor_hint = f"OR {or_val}" if or_val else f"{ref_odds_txt} market strength"
        why = (
            f"although {horse_name}'s recent figures ({disp or 'mixed'}) are patchy, {rivals_weak} of {n - 1} rivals also lack solid form "
            f"and {horse_name}'s #{model_rank} model rating ({anchor_hint}) gives scope to bounce back."
        )
    elif form_leader != horse_name and n > 1:
        why = (
            f"{horse_name} trails #{1}-form contender {form_leader} on recent figures ({disp or 'unexposed'}), "
            f"so it needs improvement on recent runs to overturn the form principals."
        )
    else:
        why = (
            f"{horse_name} holds #{form_rank} recent form rank of {n} ({disp or 'steady'}) "
            f"with {rivals_lto_win} rival recent winner(s) in opposition."
        )

    return f"{lead}{seq_txt}{career_txt}{field_txt} — why it matters: {why}"


def _build_connection_strength_maps(
    conn: sqlite3.Connection,
) -> tuple[dict[str, float], dict[str, float], dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    """Build Empirical Bayes strike-rate scores and sample stats for trainers and jockeys."""
    rows = conn.execute(
        """
        SELECT trainer, jockey, career_runs, career_wins, career_places
        FROM racing_runners
        WHERE non_runner = 0
        """
    ).fetchall()

    def _agg(field: str) -> tuple[dict[str, float], dict[str, dict[str, Any]]]:
        stats: dict[str, list[float]] = {}
        for r in rows:
            nm = str(r[field] or "").strip()
            if not nm:
                continue
            raw_runs = int(r["career_runs"] or 0)
            eb_runs = max(1, raw_runs)
            wins = int(r["career_wins"] or 0)
            plcs = int(r["career_places"] or 0)
            entry = stats.setdefault(nm, [0.0, 0.0, 0.0, 0.0])
            entry[0] += eb_runs
            entry[1] += wins
            entry[2] += plcs
            entry[3] += raw_runs
        scores: dict[str, float] = {}
        meta: dict[str, dict[str, Any]] = {}
        for nm, (eb_runs, wins, plcs, raw_runs) in stats.items():
            scores[nm] = (wins + 1.5 * 0.14 + 0.35 * (plcs + 0.35)) / (eb_runs + 12.0)
            disp_runs = int(round(raw_runs))
            meta[nm] = {
                "runs": disp_runs,
                "wins": int(round(wins)),
                "places": int(round(plcs)),
                "win_pct": round(100.0 * wins / max(1, disp_runs), 1) if disp_runs > 0 else 0.0,
                "place_pct": round(100.0 * plcs / max(1, disp_runs), 1) if disp_runs > 0 else 0.0,
            }
        if not scores:
            return {}, meta
        avg = sum(scores.values()) / len(scores)
        return {nm: val - avg for nm, val in scores.items()}, meta

    tr_scores, tr_meta = _agg("trainer")
    jk_scores, jk_meta = _agg("jockey")
    return tr_scores, jk_scores, tr_meta, jk_meta


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
    field_ctx: dict[str, Any] | None = None,
) -> tuple[list[str], dict[str, Any]]:
    ctx = field_ctx or {}
    horse = str(runner.get("horse_name") or "Runner")
    rating = float(runner["model_rating"])
    or_val = runner.get("official_rating")
    w_disp = runner.get("weight_display") or ""
    disp_form = parsed_form.get("display_form") or ("Debutant" if runner.get("is_debutant") else "Unexposed")
    runs = int(runner.get("career_runs") or 0)
    wins = int(runner.get("career_wins") or 0)
    plcs = int(runner.get("career_places") or 0)
    n = int(ctx.get("n") or race.get("runners_count") or 1)
    model_rank = int(ctx.get("model_rank") or 1)
    form_rank = int(ctx.get("form_rank") or 1)
    conn_rank = int(ctx.get("conn_rank") or 1)
    or_diff = ctx.get("or_diff")
    weight_diff_lbs = ctx.get("weight_diff_lbs")
    rival_name = str(ctx.get("rival_name") or "the main rival")
    rival_win_pct = float(ctx.get("rival_win_pct") or 0.0)
    tr = runner.get("trainer") or "Yard"
    jk = runner.get("jockey") or "Jockey TBA"
    ref_odds_txt = _fmt_uk_odds_text(ref_odds)

    form_ctx = {
        **ctx,
        "n": n,
        "trainer": tr,
        "ref_odds_txt": ref_odds_txt,
        "official_rating": or_val,
    }
    b1 = f"Recent Form: {_describe_recent_form(horse, parsed_form, runs, wins, plcs, bool(runner.get('is_debutant')), field_ctx=form_ctx)}"

    dist = race.get("distance_text") or "distance"
    going = race.get("going") or race.get("surface") or "prevailing ground"
    setup_parts = [f"{race['course']} {dist} ({race['race_type']}) on {going}"]
    if or_val:
        or_diff_txt = f" ({or_diff:+d} vs median)" if or_diff is not None and or_diff != 0 else ""
        setup_parts.append(f"Official Rating {or_val}{or_diff_txt}")
    if w_disp:
        wt_diff_txt = f" ({weight_diff_lbs:+d}lb vs median)" if weight_diff_lbs is not None and weight_diff_lbs != 0 else ""
        setup_parts.append(f"carrying {w_disp}{wt_diff_txt}")
    if runner.get("draw"):
        setup_parts.append(f"Stall {runner['draw']}")
    if runner.get("headgear"):
        setup_parts.append(f"gear: {runner['headgear']}")
    if runner.get("days_since_run") is not None:
        setup_parts.append(f"{runner['days_since_run']}d since last run")
    ew_clause = (
        f"Each-Way safety net pays {terms['places_paid']} of {n} places ({terms['label']})."
        if terms["ew_eligible"]
        else f"Win-only terms apply ({n} runners)."
    )

    setup_whys: list[str] = []
    if or_diff is not None and or_diff >= 3:
        setup_whys.append(f"{horse} sits {or_diff}lb clear of the median official rating")
    elif or_diff is not None and or_diff <= -4:
        setup_whys.append(f"{horse} sits {abs(or_diff)}lb below median rating and relies on handicap weight relief")
    elif weight_diff_lbs is not None and weight_diff_lbs <= -3:
        setup_whys.append(f"{horse} receives {abs(weight_diff_lbs)}lb in weight from the median rival")
    elif weight_diff_lbs is not None and weight_diff_lbs >= 4:
        setup_whys.append(f"{horse} concedes {weight_diff_lbs}lb to the field average due to class")

    dsr = runner.get("days_since_run")
    if dsr is not None:
        if 10 <= dsr <= 45:
            setup_whys.append(f"arrives race-fit off a tidy {dsr}-day turnaround")
        elif dsr > 180:
            setup_whys.append(f"faces a fitness test returning from a {dsr}-day break")
        elif dsr < 10:
            setup_whys.append(f"turns out quickly just {dsr} days after running")

    draw_num = runner.get("draw")
    if draw_num and race.get("race_type") == "Flat" and n >= 10:
        if int(draw_num) <= max(3, n // 4):
            setup_whys.append(f"draws well inside from Stall {draw_num} of {n}")
        elif int(draw_num) >= n - max(2, n // 4):
            setup_whys.append(f"has work to do from a wide Stall {draw_num} of {n}")

    if not setup_whys:
        setup_whys.append(f"{horse} is matched fairly to the {dist} {going} conditions")
    plc_cushion = (
        f"with {terms['places_paid']} places paid ({place_prob * 100:.0f}% top-{terms['places_paid']} chance for {horse})"
        if terms["ew_eligible"]
        else "in a win-only race leaving zero cushion for 2nd"
    )
    b2 = (
        f"Today's Race Setup: {', '.join(setup_parts)}. {ew_clause} — "
        f"why it matters: {', '.join(setup_whys)}, {plc_cushion}."
    )

    fair_win = 1.0 / max(0.005, win_prob)
    fair_plc = 1.0 / max(0.01, place_prob)
    mkt_imp_pct = 100.0 / max(1.02, ref_odds)
    src_lbl = "live market" if odds_source in ("live_fixed", "pmu_tote", "user_manual") else "model tissue"
    if win_edge_pct >= 5.0:
        val_why = (
            f"{horse}'s {ref_odds_txt} price implies only a {mkt_imp_pct:.1f}% chance vs our {win_prob * 100:.1f}% model estimate, "
            f"giving +{win_edge_pct:.1f}% positive win value."
        )
    elif terms["ew_eligible"] and ew_edge_pct >= 3.0:
        plc_o = 1.0 + (ref_odds - 1.0) * terms["place_fraction"]
        val_why = (
            f"with a {place_prob * 100:.1f}% top-{terms['places_paid']} probability at {_fmt_uk_odds_text(plc_o)} place odds, "
            f"{horse} gets cushioned each-way return equity ({ew_edge_pct:+.1f}% E/W edge)."
        )
    elif model_rank == 1:
        lead_diff = win_prob * 100.0 - rival_win_pct
        val_why = (
            f"{horse} heads the {race['course']} field at {win_prob * 100:.1f}% ({lead_diff:+.1f}% clear of {rival_name}), "
            f"making this a reliability pick priced close to fair {ref_odds_txt}."
        )
    elif win_edge_pct < -5.0:
        val_why = (
            f"{ref_odds_txt} implies {mkt_imp_pct:.1f}% against our {win_prob * 100:.1f}% estimate (fair {_fmt_uk_odds_text(fair_win)}), "
            f"so {horse} trails #{1}-rated {rival_name} on pure price value."
        )
    else:
        val_why = (
            f"{horse} sits ranked #{model_rank} of {n} close to fair odds ({_fmt_uk_odds_text(fair_win)}), "
            f"so the bet leans on race-day conditions rather than a mispriced line."
        )
    b3 = (
        f"Price & Value: Ranked #{model_rank} of {n} ({rating:.0f}/100) with {win_prob * 100:.1f}% Win chance (fair {_fmt_uk_odds_text(fair_win)}) "
        f"and {place_prob * 100:.1f}% top-{terms['places_paid']} finish (fair {_fmt_uk_odds_text(fair_plc)}) "
        f"vs {ref_odds_txt} {src_lbl} ({win_edge_pct:+.1f}% edge) — why it matters: {val_why}"
    )

    tr_meta = (ctx.get("trainer_meta") or {}).get(tr) or {}
    jk_meta = (ctx.get("jockey_meta") or {}).get(jk) or {}
    conn_snippets: list[str] = []
    if int(tr_meta.get("runs") or 0) >= 3:
        conn_snippets.append(
            f"yard record {tr_meta['wins']}W/{tr_meta['places']}P from {tr_meta['runs']} starts ({tr_meta['place_pct']:.0f}% place rate)"
        )
    if int(jk_meta.get("runs") or 0) >= 3:
        conn_snippets.append(f"rider {jk_meta['win_pct']:.0f}% win / {jk_meta['place_pct']:.0f}% place strike rate")
    conn_fact = f" ({'; '.join(conn_snippets)})" if conn_snippets else ""
    if conn_rank <= max(2, n // 4):
        conn_why = (
            f"{tr} & {jk} rank #{conn_rank} of {n} on yard/rider strike rate in this {race['course']} field, "
            f"reinforcing {horse}'s {win_prob * 100:.0f}% win profile."
        )
    elif conn_rank >= max(4, n - max(1, n // 4)):
        conn_why = (
            f"the {tr}/{jk} partnership sits #{conn_rank} of {n} in this race on strike rate, "
            f"putting greater emphasis on {horse}'s own form and handicap mark."
        )
    else:
        conn_why = (
            f"{jk} takes the ride for {tr} (#{conn_rank} of {n} connections here), "
            f"offering steady tactical support for {horse}'s {place_prob * 100:.0f}% frame chance."
        )
    b4 = (
        f"Stable & Jockey: {jk} rides for {tr} in this {n}-runner {race['race_type']}{conn_fact} — "
        f"why it matters: {conn_why}"
    )

    news_sentiment = "none"
    if matched_news:
        news_sentiment = str(matched_news.get("sentiment") or "neutral")
        m_type = str(matched_news.get("match_type") or "course")
        target_lbl = horse if m_type == "horse" else (tr if m_type == "trainer" else race["course"])
        if news_sentiment == "positive":
            news_why = (
                f"upbeat form and yard news around {target_lbl} supports {horse}'s readiness "
                f"in the {race['off_time']} {race['course']}."
            )
        elif news_sentiment == "caution":
            news_why = (
                f"flagged fitness or setback caution around {target_lbl} adds risk to {horse}'s chances "
                f"and kept it out of headline tips."
            )
        elif news_sentiment == "track_alert":
            news_why = (
                f"live {race['course']} ground/meeting conditions directly impact stamina over {dist} on {going}."
            )
        else:
            news_why = (
                f"places {target_lbl} in active racing focus ahead of the {race['off_time']} {race['course']}."
            )
        b5 = f"Racing News: [{matched_news['source']}] {matched_news['title']} — why it matters: {news_why}"
    else:
        turn_note = (
            f"{dsr}d turnaround on {going}"
            if dsr is not None
            else f"{going} setup"
        )
        b5 = (
            f"Racing News: No withdrawals, going alerts, or setbacks flagged for {horse} or {tr} "
            f"ahead of the {race['off_time']} {race['course']} — "
            f"why it matters: {horse} comes in with a clean bill of health for this #{model_rank}-rated {turn_note}."
        )

    career_record = f"{wins}-{plcs}-{runs}" if runs > 0 else "Unraced"
    stats: dict[str, Any] = {
        "model_rating": round(rating, 1),
        "model_rank": model_rank,
        "official_rating": or_val,
        "weight_display": w_disp,
        "display_form": disp_form,
        "form_score": round(float(parsed_form.get("form_score") or 0.0), 4),
        "form_rank": form_rank,
        "rivals_weak_form_count": int(ctx.get("rivals_weak_form_count") or 0),
        "weak_field_edge": bool(ctx.get("weak_field_edge")),
        "conn_rank": conn_rank,
        "news_sentiment": news_sentiment,
        "win_prob_pct": round(win_prob * 100.0, 1),
        "place_prob_pct": round(place_prob * 100.0, 1),
        "fair_win_odds": round(fair_win, 2),
        "fair_place_odds": round(fair_plc, 2),
        "place_terms_label": terms["label"],
        "career_record": career_record,
        "runners_count": n,
        "course": race["course"],
        "distance_text": dist,
        "going": going,
        "race_type": race["race_type"],
        "jockey": jk,
        "trainer": tr,
    }
    if or_diff is not None:
        stats["or_diff"] = or_diff
    if weight_diff_lbs is not None:
        stats["weight_diff_lbs"] = weight_diff_lbs
    if runner.get("draw"):
        stats["draw"] = runner["draw"]
    if runner.get("headgear"):
        stats["headgear"] = runner["headgear"]
    if dsr is not None:
        stats["days_since_run"] = dsr
    if matched_news:
        stats["news_headline"] = f"[{matched_news['source']}] {matched_news['title']}"
        stats["news_source"] = matched_news["source"]
        stats["news_match_type"] = matched_news["match_type"]
    return [b1, b2, b3, b4, b5], stats


def score_and_predict_races(conn: sqlite3.Connection) -> dict[str, Any]:
    """Score every loaded horse race, apply Bayesian market pooling, Stern-Harville Place probs, and clear reasons."""
    races = [dict(r) for r in conn.execute("SELECT * FROM racing_races ORDER BY race_date ASC, off_time ASC").fetchall()]
    if not races:
        return {"races_scored": 0, "runners_scored": 0}

    trainer_map, jockey_map, trainer_meta, jockey_meta = _build_connection_strength_maps(conn)
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
                    (json.dumps(["Non-Runner: Declared withdrawn from this race — excluded from betting calculations."]), now, nr["id"]),
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
        matched_news_list = [_classify_racing_news(race, r, news_rows) for r in active]

        form_ctx_list: list[dict[str, Any]] = []
        exp_runners_total = sum(1 for r in active if not r.get("is_debutant") and int(r.get("career_runs") or 0) > 0)
        for idx_r, r in enumerate(active):
            rivals_forms = [form_raw[j] for j in range(n) if j != idx_r]
            field_form_avg = sum(rivals_forms) / len(rivals_forms) if rivals_forms else 0.0
            rivals_weak = sum(1 for v in rivals_forms if v < 0.05)
            rivals_lto_win = sum(1 for j in range(n) if j != idx_r and (parsed_forms[j]["figures"][:1] == ["1"]))
            weak_field_edge = bool(
                n >= 4
                and form_raw[idx_r] >= 0.32
                and (field_form_avg <= 0.06 or rivals_weak >= math.ceil(0.60 * (n - 1)))
            )
            form_ctx_list.append(
                {
                    "field_form_avg": round(field_form_avg, 3),
                    "rivals_weak_form_count": rivals_weak,
                    "rivals_lto_winners": rivals_lto_win,
                    "weak_field_edge": weak_field_edge,
                    "experienced_rivals": max(0, exp_runners_total - (0 if r.get("is_debutant") else 1)),
                }
            )

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

        # Connections (Trainer + Jockey) with yard news signal
        conn_raw: list[float] = []
        for idx_r, r in enumerate(active):
            tr = trainer_map.get(str(r.get("trainer") or "").strip(), 0.0)
            jk = jockey_map.get(str(r.get("jockey") or "").strip(), 0.0)
            deb_adj = -0.04 if r.get("is_debutant") else 0.0
            nw = matched_news_list[idx_r]
            nw_tr_adj = 0.0
            if nw and nw.get("match_type") == "trainer":
                if nw.get("sentiment") == "positive":
                    nw_tr_adj = 0.12
                elif nw.get("sentiment") == "caution":
                    nw_tr_adj = -0.10
            conn_raw.append(0.55 * tr + 0.45 * jk + deb_adj + nw_tr_adj)

        # Conditions, freshness, draw, runner news & weak-field form advantage
        cond_raw: list[float] = []
        for idx_r, r in enumerate(active):
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
            if r.get("headgear") and parsed_forms[idx_r]["form_score"] > 0.15:
                val += 0.04
            if form_ctx_list[idx_r]["weak_field_edge"]:
                val += 0.18
            nw = matched_news_list[idx_r]
            if nw and nw.get("match_type") == "horse":
                if nw.get("sentiment") == "positive":
                    val += 0.22
                elif nw.get("sentiment") == "caution":
                    val -= 0.28
            cond_raw.append(val)

        z_form = _z_standardize(form_raw, floor_sd=0.22)
        z_rw = _z_standardize(rating_weight_raw, floor_sd=2.5 if use_or else 0.25)
        z_car = _z_standardize(career_raw, floor_sd=0.06)
        z_conn = _z_standardize(conn_raw, floor_sd=0.04)
        z_cond = _z_standardize(cond_raw, floor_sd=0.20)

        comp_scores = [
            0.35 * z_form[i] + 0.27 * z_rw[i] + 0.19 * z_car[i] + 0.11 * z_conn[i] + 0.08 * z_cond[i]
            for i in range(n)
        ]

        temp = 0.72 if n <= 7 else (0.78 if n <= 13 else 0.84)
        max_sc = max(comp_scores)
        exp_vals = [math.exp((sc - max_sc) / temp) for sc in comp_scores]
        exp_sum = sum(exp_vals) or 1.0
        fundamental_probs = [ev / exp_sum for ev in exp_vals]

        # Bayesian log-linear pooling with live devigged market probabilities & plausible edge guardrail
        live_sources = {"live_fixed", "pmu_tote", "user_manual"}
        has_live_flag = [
            bool(r.get("odds_source") in live_sources and r.get("market_odds") and float(r["market_odds"]) > 1.01)
            for r in active
        ]
        live_count = sum(1 for x in has_live_flag if x)
        has_market_blend = live_count >= max(2, int(math.ceil(n * 0.70)))
        if has_market_blend:
            raw_mkt_inv = [
                (1.0 / min(151.0, max(1.04, float(r["market_odds"]))))
                if has_live_flag[i]
                else fundamental_probs[i]
                for i, r in enumerate(active)
            ]
            mkt_sum = sum(raw_mkt_inv) or 1.0
            mkt_probs = [v / mkt_sum for v in raw_mkt_inv]
            w_mkt = 0.72 if use_or else 0.84
            geo = [
                (max(1e-4, fundamental_probs[i]) ** (1.0 - w_mkt)) * (max(1e-4, mkt_probs[i]) ** w_mkt)
                for i in range(n)
            ]
            geo_sum = sum(geo) or 1.0
            pooled = [g / geo_sum for g in geo]
            guarded: list[float] = []
            for i in range(n):
                p_val = pooled[i]
                if has_live_flag[i]:
                    lo_p = 0.58 * mkt_probs[i]
                    hi_p = min(0.88, 1.42 * mkt_probs[i] + 0.015)
                    p_val = max(lo_p, min(hi_p, p_val))
                guarded.append(max(0.004, min(0.88, p_val)))
            norm_sum = sum(guarded) or 1.0
            win_probs = [round(p / norm_sum, 5) for p in guarded]
        else:
            clamped = [max(0.004, min(0.88, p)) for p in fundamental_probs]
            norm_sum = sum(clamped) or 1.0
            win_probs = [round(p / norm_sum, 5) for p in clamped]

        place_probs = compute_place_probabilities(win_probs, terms["places_paid"])

        max_win_p = max(win_probs) if win_probs else 0.0
        for i, r in enumerate(active):
            p_win = win_probs[i]
            comp = comp_scores[i]
            rel_log = math.log(max(0.004, p_win) / (1.0 / max(1, n)))
            sig = 0.82 * rel_log + 0.22 * comp
            rating = 65.0 + 27.0 * math.tanh(0.70 * sig) + (2.5 if p_win == max_win_p else 0.0)
            r["model_rating"] = round(max(41.0, min(97.0, rating)), 1)

        model_order = sorted(range(n), key=lambda idx: (win_probs[idx], active[idx]["model_rating"]), reverse=True)
        model_rank_map = {idx: pos + 1 for pos, idx in enumerate(model_order)}
        form_order = sorted(range(n), key=lambda idx: form_raw[idx], reverse=True)
        form_rank_map = {idx: pos + 1 for pos, idx in enumerate(form_order)}
        conn_order = sorted(range(n), key=lambda idx: conn_raw[idx], reverse=True)
        conn_rank_map = {idx: pos + 1 for pos, idx in enumerate(conn_order)}
        leader_idx = model_order[0]
        runner_up_idx = model_order[1] if n > 1 else model_order[0]
        form_leader_name = str(active[form_order[0]].get("horse_name") or "")

        tissue_overround = min(1.22, 1.0 + 0.012 * n)
        for i, r in enumerate(active):
            p_win = win_probs[i]
            p_plc = place_probs[i]
            rating = float(r["model_rating"])
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

            rival_idx = runner_up_idx if model_rank_map[i] == 1 else leader_idx
            or_diff = round(float(r["official_rating"]) - med_or) if (use_or and med_or is not None and r.get("official_rating")) else None
            wt_diff = round(float(r["weight_lbs"]) - med_weight) if (med_weight is not None and r.get("weight_lbs")) else None
            field_ctx = {
                **form_ctx_list[i],
                "n": n,
                "model_rank": model_rank_map[i],
                "form_rank": form_rank_map[i],
                "conn_rank": conn_rank_map[i],
                "form_leader_name": form_leader_name,
                "rival_name": str(active[rival_idx].get("horse_name") or "the main rival"),
                "rival_win_pct": round(win_probs[rival_idx] * 100.0, 1),
                "or_diff": or_diff,
                "weight_diff_lbs": wt_diff,
                "trainer_meta": trainer_meta,
                "jockey_meta": jockey_meta,
            }

            matched_news = matched_news_list[i]
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
                field_ctx=field_ctx,
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
