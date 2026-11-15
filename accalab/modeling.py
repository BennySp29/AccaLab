"""Dixon-Coles Poisson + Elo rating model, match predictions, AI summaries, and walk-forward backtester."""

from __future__ import annotations

import json
import math
import sqlite3
from collections import defaultdict
from datetime import datetime
from typing import Any

from accalab.config import CURRENT_SEASON, GEMINI_API_KEY, LEAGUES
from accalab.db import utc_now_iso


def _poisson_pmf(k: int, lam: float) -> float:
    if lam <= 0:
        return 1.0 if k == 0 else 0.0
    return math.exp(-lam) * (lam**k) / math.factorial(k)


def _tau(x: int, y: int, lam: float, mu: float, rho: float) -> float:
    if x == 0 and y == 0:
        val = 1.0 - lam * mu * rho
    elif x == 0 and y == 1:
        val = 1.0 + lam * rho
    elif x == 1 and y == 0:
        val = 1.0 + mu * rho
    elif x == 1 and y == 1:
        val = 1.0 - rho
    else:
        val = 1.0
    return max(val, 0.05)


def score_matrix(lam: float, mu: float, rho: float, max_goals: int = 7) -> list[list[float]]:
    """Build normalized (max_goals+1)x(max_goals+1) joint scoreline probability matrix."""
    px = [_poisson_pmf(x, lam) for x in range(max_goals + 1)]
    py = [_poisson_pmf(y, mu) for y in range(max_goals + 1)]
    mat: list[list[float]] = []
    total = 0.0
    for x in range(max_goals + 1):
        row: list[float] = []
        for y in range(max_goals + 1):
            p = px[x] * py[y] * _tau(x, y, lam, mu, rho)
            row.append(p)
            total += p
        mat.append(row)
    if total > 0:
        for x in range(max_goals + 1):
            for y in range(max_goals + 1):
                mat[x][y] /= total
    return mat


def extract_market_probs(mat: list[list[float]]) -> dict[str, Any]:
    """Derive 1X2, O/U 2.5, BTTS, and top scorelines from a scoreline matrix."""
    p_h = p_d = p_a = p_o25 = p_btts_y = 0.0
    scores: list[tuple[float, str]] = []
    n = len(mat)
    for x in range(n):
        for y in range(n):
            p = mat[x][y]
            if x > y:
                p_h += p
            elif x == y:
                p_d += p
            else:
                p_a += p
            if x + y >= 3:
                p_o25 += p
            if x >= 1 and y >= 1:
                p_btts_y += p
            scores.append((p, f"{x}-{y}"))

    scores.sort(reverse=True)
    top_scores = [{"score": s, "prob": round(p * 100.0, 2)} for p, s in scores[:6]]
    return {
        "prob_home": round(p_h, 5),
        "prob_draw": round(p_d, 5),
        "prob_away": round(p_a, 5),
        "prob_over25": round(p_o25, 5),
        "prob_under25": round(1.0 - p_o25, 5),
        "prob_btts_yes": round(p_btts_y, 5),
        "prob_btts_no": round(1.0 - p_btts_y, 5),
        "top_scorelines": top_scores,
    }


def compute_elo_ratings(
    matches: list[dict[str, Any]],
) -> tuple[dict[str, float], dict[str, float], dict[str, str]]:
    """Compute chronological Club Elo ratings across historical matches."""
    elo: dict[str, float] = {}
    history: dict[str, list[float]] = defaultdict(list)
    last_div: dict[str, str] = {}

    for m in matches:
        div = m["div"]
        h = m["home_team"]
        a = m["away_team"]
        fthg = m["fthg"]
        ftag = m["ftag"]
        if fthg is None or ftag is None:
            continue

        init_elo = LEAGUES.get(div, {}).get("init_elo", 1450.0)
        if h not in elo:
            elo[h] = init_elo
            history[h].append(init_elo)
        if a not in elo:
            elo[a] = init_elo
            history[a].append(init_elo)
        last_div[h] = div
        last_div[a] = div

        elo_diff = elo[h] + 65.0 - elo[a]
        exp_h = 1.0 / (1.0 + 10.0 ** (-elo_diff / 400.0))
        act_h = 1.0 if fthg > ftag else (0.5 if fthg == ftag else 0.0)
        gd = abs(fthg - ftag)
        gd_mult = 1.0 if gd == 0 else math.log(gd + 1.0) * (2.2 / (abs(elo_diff) * 0.001 + 2.2))

        delta = 24.0 * gd_mult * (act_h - exp_h)
        elo[h] += delta
        elo[a] -= delta
        history[h].append(elo[h])
        history[a].append(elo[a])

    elo_change5: dict[str, float] = {}
    for team, vals in history.items():
        if len(vals) >= 6:
            elo_change5[team] = round(vals[-1] - vals[-6], 1)
        elif len(vals) >= 2:
            elo_change5[team] = round(vals[-1] - vals[0], 1)
        else:
            elo_change5[team] = 0.0

    return elo, elo_change5, last_div


def fit_dixon_coles_params(
    matches: list[dict[str, Any]],
    ref_date_str: str,
    xi: float = 0.0035,
    l2_reg: float = 3.0,
) -> dict[str, Any]:
    """Fit time-decayed Dixon-Coles attack/defence, intercept, home advantage, and rho via regularized Newton steps."""
    if not matches:
        return {"attack": {}, "defence": {}, "intercept": 0.10, "home_adv": 0.22, "rho": -0.05, "avg_goals": 1.32}

    ref_dt = datetime.strptime(ref_date_str, "%Y-%m-%d").date()
    teams: set[str] = set()
    weighted_rows: list[tuple[str, str, int, int, float]] = []
    tot_w = 0.0
    tot_h_goals = 0.0
    tot_a_goals = 0.0

    for m in matches:
        if m["fthg"] is None or m["ftag"] is None:
            continue
        mdt = datetime.strptime(m["match_date"], "%Y-%m-%d").date()
        days_ago = max(0, (ref_dt - mdt).days)
        w = math.exp(-xi * days_ago)
        h = m["home_team"]
        a = m["away_team"]
        gh = int(m["fthg"])
        ga = int(m["ftag"])
        teams.add(h)
        teams.add(a)
        weighted_rows.append((h, a, gh, ga, w))
        tot_w += w
        tot_h_goals += w * gh
        tot_a_goals += w * ga

    if not weighted_rows or tot_w <= 0:
        return {"attack": {}, "defence": {}, "intercept": 0.10, "home_adv": 0.22, "rho": -0.05, "avg_goals": 1.32}

    avg_a = max(0.5, tot_a_goals / tot_w)
    avg_h = max(0.6, tot_h_goals / tot_w)
    avg_goals_per_team = 0.5 * (avg_h + avg_a)

    log_att = {t: 0.0 for t in teams}
    log_def = {t: 0.0 for t in teams}
    mu0 = math.log(avg_a)
    gamma = math.log(avg_h / avg_a)

    for _ in range(25):
        # Block 1: Update attack parameters (diagonal Hessian is exact when defence/mu0/gamma fixed)
        g_att = defaultdict(float)
        h_att = defaultdict(float)
        for h, a, gh, ga, w in weighted_rows:
            lam = math.exp(max(-3.0, min(2.5, mu0 + gamma + log_att[h] + log_def[a])))
            mu = math.exp(max(-3.0, min(2.5, mu0 + log_att[a] + log_def[h])))
            g_att[h] += w * (gh - lam)
            h_att[h] += w * lam
            g_att[a] += w * (ga - mu)
            h_att[a] += w * mu
        for t in teams:
            step_a = (g_att[t] - l2_reg * log_att[t]) / (h_att[t] + l2_reg)
            log_att[t] = max(-1.5, min(1.5, log_att[t] + 0.8 * step_a))
        mean_a = sum(log_att.values()) / len(teams)
        for t in teams:
            log_att[t] -= mean_a
        mu0 += mean_a

        # Block 2: Update defence parameters (diagonal Hessian is exact when attack/mu0/gamma fixed)
        g_def = defaultdict(float)
        h_def = defaultdict(float)
        for h, a, gh, ga, w in weighted_rows:
            lam = math.exp(max(-3.0, min(2.5, mu0 + gamma + log_att[h] + log_def[a])))
            mu = math.exp(max(-3.0, min(2.5, mu0 + log_att[a] + log_def[h])))
            g_def[a] += w * (gh - lam)
            h_def[a] += w * lam
            g_def[h] += w * (ga - mu)
            h_def[h] += w * mu
        for t in teams:
            step_d = (g_def[t] - l2_reg * log_def[t]) / (h_def[t] + l2_reg)
            log_def[t] = max(-1.5, min(1.5, log_def[t] + 0.8 * step_d))
        mean_d = sum(log_def.values()) / len(teams)
        for t in teams:
            log_def[t] -= mean_d
        mu0 += mean_d

        # Block 3: Update intercept mu0 and home advantage gamma
        g_mu0 = h_mu0 = g_gam = h_gam = 0.0
        for h, a, gh, ga, w in weighted_rows:
            lam = math.exp(max(-3.0, min(2.5, mu0 + gamma + log_att[h] + log_def[a])))
            mu = math.exp(max(-3.0, min(2.5, mu0 + log_att[a] + log_def[h])))
            eh = gh - lam
            ea = ga - mu
            g_mu0 += w * (eh + ea)
            h_mu0 += w * (lam + mu)
            g_gam += w * eh
            h_gam += w * lam
        if h_mu0 > 0:
            mu0 = max(-1.0, min(1.0, mu0 + 0.8 * (g_mu0 / h_mu0)))
        if h_gam > 0:
            gamma = max(-0.2, min(0.7, gamma + 0.8 * (g_gam / h_gam)))

    # Optimize Dixon-Coles low-score correlation rho via grid search
    low_score_rows: list[tuple[int, int, float, float, float]] = []
    for h, a, gh, ga, w in weighted_rows:
        if gh <= 1 and ga <= 1:
            lam = math.exp(mu0 + gamma + log_att[h] + log_def[a])
            mu = math.exp(mu0 + log_att[a] + log_def[h])
            low_score_rows.append((gh, ga, lam, mu, w))

    best_rho = -0.04
    best_ll = -1e18
    for step in range(-18, 19):
        candidate = step * 0.01
        ll = sum(w * math.log(_tau(gh, ga, lam, mu, candidate)) for gh, ga, lam, mu, w in low_score_rows)
        if ll > best_ll:
            best_ll = ll
            best_rho = candidate

    return {
        "attack": log_att,
        "defence": log_def,
        "intercept": mu0,
        "home_adv": gamma,
        "rho": round(best_rho, 4),
        "avg_goals": avg_goals_per_team,
    }


def compute_team_season_stats(matches: list[dict[str, Any]], season: str) -> dict[str, dict[str, Any]]:
    """Calculate current-season table points, GF/GA, shot averages, and last-6 form."""
    stats: dict[str, dict[str, Any]] = {}

    def _ensure(t: str, div: str) -> dict[str, Any]:
        if t not in stats:
            stats[t] = {
                "div": div,
                "played": 0,
                "points": 0,
                "gf": 0,
                "ga": 0,
                "shots_for": 0,
                "shots_against": 0,
                "shot_games": 0,
                "sot_for": 0,
                "sot_against": 0,
                "form": [],
            }
        return stats[t]

    for m in matches:
        if m["season"] != season or m["fthg"] is None or m["ftag"] is None:
            continue
        div = m["div"]
        h = m["home_team"]
        a = m["away_team"]
        gh = int(m["fthg"])
        ga = int(m["ftag"])

        hs = _ensure(h, div)
        as_ = _ensure(a, div)
        hs["played"] += 1
        as_["played"] += 1
        hs["gf"] += gh
        hs["ga"] += ga
        as_["gf"] += ga
        as_["ga"] += gh

        if gh > ga:
            hs["points"] += 3
            hs["form"].append("W")
            as_["form"].append("L")
        elif gh == ga:
            hs["points"] += 1
            as_["points"] += 1
            hs["form"].append("D")
            as_["form"].append("D")
        else:
            as_["points"] += 3
            hs["form"].append("L")
            as_["form"].append("W")

        if m["hs"] is not None and m["as_shots"] is not None:
            hs["shots_for"] += int(m["hs"])
            hs["shots_against"] += int(m["as_shots"])
            hs["shot_games"] += 1
            as_["shots_for"] += int(m["as_shots"])
            as_["shots_against"] += int(m["hs"])
            as_["shot_games"] += 1

        if m["hst"] is not None and m["ast"] is not None:
            hs["sot_for"] += int(m["hst"])
            hs["sot_against"] += int(m["ast"])
            as_["sot_for"] += int(m["ast"])
            as_["sot_against"] += int(m["hst"])

    return stats


def _predict_lambdas(
    home: str,
    away: str,
    dc_model: dict[str, Any],
    elo_map: dict[str, float],
    div: str,
) -> tuple[float, float]:
    """Blend Dixon-Coles goal expectations (80%) with Elo strength expectation (20%)."""
    avg_g = dc_model.get("avg_goals", 1.32)
    att = dc_model["attack"]
    defn = dc_model["defence"]
    mu0 = dc_model.get("intercept", 0.10)
    gamma = dc_model["home_adv"]

    a_h = att.get(home, 0.0)
    d_h = defn.get(home, 0.0)
    a_a = att.get(away, 0.0)
    d_a = defn.get(away, 0.0)

    lam_dc = max(0.35, min(4.2, math.exp(mu0 + gamma + a_h + d_a)))
    mu_dc = max(0.30, min(3.8, math.exp(mu0 + a_a + d_h)))

    init_elo = LEAGUES.get(div, {}).get("init_elo", 1450.0)
    elo_h = elo_map.get(home, init_elo)
    elo_a = elo_map.get(away, init_elo)
    elo_diff = max(-450.0, min(450.0, elo_h + 65.0 - elo_a))

    lam_elo = max(0.40, min(3.6, avg_g * math.exp(elo_diff / 850.0)))
    mu_elo = max(0.35, min(3.4, avg_g * math.exp(-elo_diff / 850.0)))

    lam = 0.80 * lam_dc + 0.20 * lam_elo
    mu = 0.80 * mu_dc + 0.20 * mu_elo
    return lam, mu


def _estimate_market_odds(probs: dict[str, Any], elo_h: float = 1500.0, elo_a: float = 1500.0) -> dict[str, float]:
    """Generate calibrated Bet365-margin (~5.2%) market estimates when live odds are unavailable."""
    # Blend model probabilities (68%) with English league base rates (32%) instead of double-counting Elo
    mh = max(0.06, min(0.86, 0.68 * probs["prob_home"] + 0.32 * 0.44))
    md = max(0.12, min(0.36, 0.68 * probs["prob_draw"] + 0.32 * 0.27))
    ma = max(0.06, min(0.86, 0.68 * probs["prob_away"] + 0.32 * 0.29))
    tot = mh + md + ma
    mh, md, ma = mh / tot, md / tot, ma / tot

    margin_1x2 = 1.053
    margin_2way = 1.052

    o25 = max(0.18, min(0.82, probs["prob_over25"]))
    u25 = 1.0 - o25
    by = max(0.18, min(0.82, probs["prob_btts_yes"]))
    bn = 1.0 - by

    return {
        "b365h": round(max(1.08, 1.0 / (mh * margin_1x2)), 2),
        "b365d": round(max(1.80, 1.0 / (md * margin_1x2)), 2),
        "b365a": round(max(1.08, 1.0 / (ma * margin_1x2)), 2),
        "b365_over25": round(max(1.12, 1.0 / (o25 * margin_2way)), 2),
        "b365_under25": round(max(1.12, 1.0 / (u25 * margin_2way)), 2),
        "b365_btts_yes": round(max(1.15, 1.0 / (by * margin_2way)), 2),
        "b365_btts_no": round(max(1.15, 1.0 / (bn * margin_2way)), 2),
    }


def _build_tipster_consensus(
    home_row: dict[str, Any],
    away_row: dict[str, Any],
    probs: dict[str, Any],
    fixture: dict[str, Any],
) -> dict[str, Any]:
    """Synthesize multi-angle consensus signals (Model, Elo, Shot Dominance, Goals, Market Move)."""
    signals: list[dict[str, str]] = []

    # 1. Model lean
    best_1x2 = max(
        [("Home Win", probs["prob_home"]), ("Draw", probs["prob_draw"]), ("Away Win", probs["prob_away"])],
        key=lambda x: x[1],
    )
    signals.append({"name": "Dixon-Coles Model", "pick": best_1x2[0], "detail": f"{best_1x2[1]*100:.1f}% prob"})

    # 2. Club Elo gap
    elo_gap = (home_row.get("elo") or 1500.0) - (away_row.get("elo") or 1500.0)
    if elo_gap > 45:
        signals.append({"name": "Elo Power Gap", "pick": f"{fixture['home_team']} (+{elo_gap:.0f})", "detail": "Stronger rating"})
    elif elo_gap < -45:
        signals.append({"name": "Elo Power Gap", "pick": f"{fixture['away_team']} (+{-elo_gap:.0f})", "detail": "Stronger rating"})
    else:
        signals.append({"name": "Elo Power Gap", "pick": "Balanced", "detail": f"Gap {elo_gap:+.0f}"})

    # 3. Shot-on-target dominance
    h_sot_diff = (home_row.get("sot_for_pg") or 0.0) - (home_row.get("sot_against_pg") or 0.0)
    a_sot_diff = (away_row.get("sot_for_pg") or 0.0) - (away_row.get("sot_against_pg") or 0.0)
    if h_sot_diff - a_sot_diff > 0.7:
        signals.append({"name": "Shots on Target", "pick": fixture["home_team"], "detail": f"SoT diff {h_sot_diff:+.1f} vs {a_sot_diff:+.1f}"})
    elif a_sot_diff - h_sot_diff > 0.7:
        signals.append({"name": "Shots on Target", "pick": fixture["away_team"], "detail": f"SoT diff {a_sot_diff:+.1f} vs {h_sot_diff:+.1f}"})
    else:
        signals.append({"name": "Shots on Target", "pick": "Even", "detail": f"{h_sot_diff:+.1f} vs {a_sot_diff:+.1f}/g"})

    # 4. Goals / BTTS trend
    if probs["prob_over25"] >= 0.56:
        signals.append({"name": "Goals Tempo", "pick": "Over 2.5", "detail": f"{probs['prob_over25']*100:.1f}% model"})
    elif probs["prob_under25"] >= 0.56:
        signals.append({"name": "Goals Tempo", "pick": "Under 2.5", "detail": f"{probs['prob_under25']*100:.1f}% model"})
    else:
        signals.append({"name": "Goals Tempo", "pick": "Neutral", "detail": f"O2.5 {probs['prob_over25']*100:.1f}%"})

    # 5. Bet365 steam signal
    oh, ch = fixture.get("b365_open_h"), fixture.get("b365h")
    oa, ca = fixture.get("b365_open_a"), fixture.get("b365a")
    if oh and ch and abs(oh - ch) / oh >= 0.05:
        direction = "Shortened" if ch < oh else "Drifted"
        signals.append({"name": "Bet365 Move", "pick": f"Home {direction}", "detail": f"{oh:.2f} -> {ch:.2f}"})
    elif oa and ca and abs(oa - ca) / oa >= 0.05:
        direction = "Shortened" if ca < oa else "Drifted"
        signals.append({"name": "Bet365 Move", "pick": f"Away {direction}", "detail": f"{oa:.2f} -> {ca:.2f}"})

    return {"signals": signals}


def generate_grounded_summary(
    fixture: dict[str, Any],
    home_row: dict[str, Any],
    away_row: dict[str, Any],
    probs: dict[str, Any],
    lam: float,
    mu: float,
    h2h_rows: list[dict[str, Any]],
    news_rows: list[dict[str, Any]],
    use_gemini: bool = False,
) -> tuple[str, str]:
    """Generate a data-grounded preview summary (uses Gemini Flash when key present & requested)."""
    h_name = fixture["home_team"]
    a_name = fixture["away_team"]
    league_name = LEAGUES.get(fixture["div"], {}).get("name", fixture["div"])

    h_form = home_row.get("form_last6") or "N/A"
    a_form = away_row.get("form_last6") or "N/A"
    h_elo = home_row.get("elo") or 1500.0
    a_elo = away_row.get("elo") or 1500.0

    h2h_text = (
        "; ".join(f"{r['match_date']}: {r['home_team']} {r['fthg']}-{r['ftag']} {r['away_team']}" for r in h2h_rows[:3])
        if h2h_rows
        else "No recent league H2H in 24/25–26/27 dataset."
    )
    news_text = (
        " | ".join(f"[{n['source']}] {n['title']}" for n in news_rows[:3])
        if news_rows
        else "No club-specific headlines in current BBC/Sky/Guardian RSS feeds."
    )

    if use_gemini and GEMINI_API_KEY:
        try:
            from google import genai  # type: ignore

            client = genai.Client(api_key=GEMINI_API_KEY)
            prompt = (
                f"Write a concise 3-4 sentence football betting analysis for {h_name} vs {a_name} ({league_name}, {fixture['match_date']}). "
                f"Use ONLY the verified facts below and cite sources in square brackets when referencing news.\n"
                f"- Expected Goals (xG model): {h_name} {lam:.2f} vs {a_name} {mu:.2f}\n"
                f"- Model Probabilities: Home {probs['prob_home']*100:.1f}%, Draw {probs['prob_draw']*100:.1f}%, Away {probs['prob_away']*100:.1f}%, "
                f"Over 2.5 {probs['prob_over25']*100:.1f}%, BTTS Yes {probs['prob_btts_yes']*100:.1f}%\n"
                f"- Bet365 Odds: H {fixture.get('b365h')}, D {fixture.get('b365d')}, A {fixture.get('b365a')} (source: {fixture.get('odds_source')})\n"
                f"- {h_name}: Elo {h_elo:.0f}, Last 6 {h_form}, SoT/g {home_row.get('sot_for_pg', 0):.1f} for / {home_row.get('sot_against_pg', 0):.1f} against\n"
                f"- {a_name}: Elo {a_elo:.0f}, Last 6 {a_form}, SoT/g {away_row.get('sot_for_pg', 0):.1f} for / {away_row.get('sot_against_pg', 0):.1f} against\n"
                f"- Recent H2H: {h2h_text}\n"
                f"- News RSS: {news_text}\n"
                f"Highlight the strongest statistical edge and any caution."
            )
            resp = client.models.generate_content(model="gemini-2.5-flash", contents=prompt)
            text = (resp.text or "").strip()
            if text:
                return text, "gemini_flash"
        except Exception:
            pass

    # Deterministic data-grounded analyst narrative
    top_score = probs["top_scorelines"][0]["score"] if probs["top_scorelines"] else "1-1"
    fav_label = (
        f"{h_name} ({probs['prob_home']*100:.1f}%)"
        if probs["prob_home"] >= max(probs["prob_draw"], probs["prob_away"])
        else (
            f"{a_name} ({probs['prob_away']*100:.1f}%)"
            if probs["prob_away"] >= probs["prob_draw"]
            else f"Draw ({probs['prob_draw']*100:.1f}%)"
        )
    )
    parts = [
        f"Model lean: {fav_label} in this {league_name} fixture, projecting {lam:.2f}–{mu:.2f} xG with {top_score} as the likeliest score.",
        f"Goals outlook: Over 2.5 at {probs['prob_over25']*100:.1f}% and BTTS Yes at {probs['prob_btts_yes']*100:.1f}% ({h_name} {home_row.get('sot_for_pg', 0):.1f} vs {a_name} {away_row.get('sot_for_pg', 0):.1f} shots on target/game).",
        f"Recent form: {h_name} {h_form} vs {a_name} {a_form}. H2H: {h2h_text}",
    ]
    if news_rows:
        parts.append(f"Team news: {news_text}")
    return " ".join(parts), "analyst_engine"


def run_model_and_predictions(conn: sqlite3.Connection) -> dict[str, Any]:
    """Fit Elo + Dixon-Coles models per league, update team_ratings, and predict upcoming fixtures."""
    now = utc_now_iso()
    rows = conn.execute(
        "SELECT * FROM historical_matches ORDER BY match_date ASC, id ASC"
    ).fetchall()
    matches = [dict(r) for r in rows]
    if not matches:
        return {"teams_rated": 0, "fixtures_predicted": 0}

    elo_map, elo_change5, last_div = compute_elo_ratings(matches)
    season_stats = compute_team_season_stats(matches, CURRENT_SEASON)
    latest_date = matches[-1]["match_date"]

    # Fit Dixon-Coles per division on 2526 + 2627 matches
    dc_models: dict[str, dict[str, Any]] = {}
    recent_matches = [m for m in matches if m["season"] in ("2526", "2627")]
    for div in LEAGUES:
        div_matches = [m for m in recent_matches if m["div"] == div]
        dc_models[div] = fit_dixon_coles_params(div_matches, latest_date)

    # Upsert team_ratings for all teams active in 2627 (or all seen)
    teams_rated = 0
    for team, st in season_stats.items():
        div = st["div"]
        dc = dc_models.get(div, {})
        sg = max(1, st["shot_games"])
        conn.execute(
            """
            INSERT INTO team_ratings (
                team_name, div, elo, elo_change_last5, dc_attack, dc_defence,
                matches_played, points, gf, ga, shots_for_pg, shots_against_pg,
                sot_for_pg, sot_against_pg, form_last6, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(team_name) DO UPDATE SET
                div = excluded.div,
                elo = excluded.elo,
                elo_change_last5 = excluded.elo_change_last5,
                dc_attack = excluded.dc_attack,
                dc_defence = excluded.dc_defence,
                matches_played = excluded.matches_played,
                points = excluded.points,
                gf = excluded.gf,
                ga = excluded.ga,
                shots_for_pg = excluded.shots_for_pg,
                shots_against_pg = excluded.shots_against_pg,
                sot_for_pg = excluded.sot_for_pg,
                sot_against_pg = excluded.sot_against_pg,
                form_last6 = excluded.form_last6,
                updated_at = excluded.updated_at
            """,
            (
                team,
                div,
                round(elo_map.get(team, LEAGUES[div]["init_elo"]), 1),
                elo_change5.get(team, 0.0),
                round(dc.get("attack", {}).get(team, 0.0), 5),
                round(dc.get("defence", {}).get(team, 0.0), 5),
                st["played"],
                st["points"],
                st["gf"],
                st["ga"],
                round(st["shots_for"] / sg, 2),
                round(st["shots_against"] / sg, 2),
                round(st["sot_for"] / sg, 2),
                round(st["sot_against"] / sg, 2),
                "".join(st["form"][-6:]),
                now,
            ),
        )
        teams_rated += 1

    ratings_lookup = {
        r["team_name"]: dict(r)
        for r in conn.execute("SELECT * FROM team_ratings").fetchall()
    }
    news_all = [
        dict(r)
        for r in conn.execute("SELECT * FROM news_items ORDER BY published_at DESC LIMIT 120").fetchall()
    ]

    upcoming = [
        dict(r)
        for r in conn.execute(
            "SELECT * FROM upcoming_fixtures WHERE status = 'scheduled' ORDER BY match_date ASC, kickoff_time ASC"
        ).fetchall()
    ]

    predicted = 0
    for fix in upcoming:
        div = fix["div"]
        dc = dc_models.get(div) or {"attack": {}, "defence": {}, "home_adv": 0.22, "rho": -0.04, "avg_goals": 1.32}
        lam, mu = _predict_lambdas(fix["home_team"], fix["away_team"], dc, elo_map, div)
        mat = score_matrix(lam, mu, dc["rho"])
        probs = extract_market_probs(mat)

        # Fill estimated odds only for missing markets (never overwrite official Bet365 / manual odds)
        est = _estimate_market_odds(
            probs,
            elo_map.get(fix["home_team"], 1500.0),
            elo_map.get(fix["away_team"], 1500.0),
        )
        is_est_row = fix["odds_source"] == "market_estimate"
        b365h = est["b365h"] if is_est_row else (fix["b365h"] or est["b365h"])
        b365d = est["b365d"] if is_est_row else (fix["b365d"] or est["b365d"])
        b365a = est["b365a"] if is_est_row else (fix["b365a"] or est["b365a"])
        b365_o25 = est["b365_over25"] if is_est_row else (fix["b365_over25"] or est["b365_over25"])
        b365_u25 = est["b365_under25"] if is_est_row else (fix["b365_under25"] or est["b365_under25"])
        # fixtures.csv / live_sportsbook do not carry BTTS prices, so keep BTTS fresh unless set via API/manual
        refresh_btts = fix["odds_source"] in ("market_estimate", "bet365_official", "live_sportsbook")
        b365_by = est["b365_btts_yes"] if refresh_btts else (fix["b365_btts_yes"] or est["b365_btts_yes"])
        b365_bn = est["b365_btts_no"] if refresh_btts else (fix["b365_btts_no"] or est["b365_btts_no"])

        conn.execute(
            """
            UPDATE upcoming_fixtures SET
                b365h = ?, b365d = ?, b365a = ?,
                b365_over25 = ?, b365_under25 = ?,
                b365_btts_yes = ?, b365_btts_no = ?
            WHERE id = ?
            """,
            (b365h, b365d, b365a, b365_o25, b365_u25, b365_by, b365_bn, fix["id"]),
        )
        fix.update(
            {
                "b365h": b365h,
                "b365d": b365d,
                "b365a": b365a,
                "b365_over25": b365_o25,
                "b365_under25": b365_u25,
                "b365_btts_yes": b365_by,
                "b365_btts_no": b365_bn,
            }
        )

        h_row = ratings_lookup.get(fix["home_team"], {"elo": 1500.0, "form_last6": "", "sot_for_pg": 0.0, "sot_against_pg": 0.0})
        a_row = ratings_lookup.get(fix["away_team"], {"elo": 1500.0, "form_last6": "", "sot_for_pg": 0.0, "sot_against_pg": 0.0})

        h2h = [
            m
            for m in reversed(matches)
            if {m["home_team"], m["away_team"]} == {fix["home_team"], fix["away_team"]}
        ][:5]
        matched_news = [
            n
            for n in news_all
            if fix["home_team"] in json.loads(n["matched_teams_json"])
            or fix["away_team"] in json.loads(n["matched_teams_json"])
        ]

        consensus = _build_tipster_consensus(h_row, a_row, probs, fix)
        existing_pred = conn.execute(
            "SELECT ai_summary, ai_summary_source FROM predictions WHERE fixture_id = ?",
            (fix["id"],),
        ).fetchone()

        if existing_pred and existing_pred["ai_summary_source"] == "gemini_flash":
            summary_text = existing_pred["ai_summary"]
            summary_src = "gemini_flash"
        else:
            summary_text, summary_src = generate_grounded_summary(
                fix, h_row, a_row, probs, lam, mu, h2h, matched_news, use_gemini=False
            )

        conn.execute(
            """
            INSERT INTO predictions (
                fixture_id, lambda_home, mu_away, rho,
                prob_home, prob_draw, prob_away,
                prob_over25, prob_under25, prob_btts_yes, prob_btts_no,
                top_scorelines_json, tipster_consensus_json,
                ai_summary, ai_summary_source, model_version, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dc-elo-v1', ?)
            ON CONFLICT(fixture_id) DO UPDATE SET
                lambda_home = excluded.lambda_home,
                mu_away = excluded.mu_away,
                rho = excluded.rho,
                prob_home = excluded.prob_home,
                prob_draw = excluded.prob_draw,
                prob_away = excluded.prob_away,
                prob_over25 = excluded.prob_over25,
                prob_under25 = excluded.prob_under25,
                prob_btts_yes = excluded.prob_btts_yes,
                prob_btts_no = excluded.prob_btts_no,
                top_scorelines_json = excluded.top_scorelines_json,
                tipster_consensus_json = excluded.tipster_consensus_json,
                ai_summary = excluded.ai_summary,
                ai_summary_source = excluded.ai_summary_source,
                updated_at = excluded.updated_at
            """,
            (
                fix["id"],
                round(lam, 4),
                round(mu, 4),
                dc["rho"],
                probs["prob_home"],
                probs["prob_draw"],
                probs["prob_away"],
                probs["prob_over25"],
                probs["prob_under25"],
                probs["prob_btts_yes"],
                probs["prob_btts_no"],
                json.dumps(probs["top_scorelines"]),
                json.dumps(consensus),
                summary_text,
                summary_src,
                now,
            ),
        )
        predicted += 1

    return {"teams_rated": teams_rated, "fixtures_predicted": predicted}


def run_walk_forward_backtest(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """Evaluate Dixon-Coles + Elo walk-forward against 2026/27 Bet365 closing odds."""
    now = utc_now_iso()
    rows = conn.execute(
        "SELECT * FROM historical_matches ORDER BY match_date ASC, id ASC"
    ).fetchall()
    all_matches = [dict(r) for r in rows]
    if not all_matches:
        return []

    results_summary: list[dict[str, Any]] = []

    for div in LEAGUES:
        div_matches = [m for m in all_matches if m["div"] == div]
        test_matches = [m for m in div_matches if m["season"] == CURRENT_SEASON]
        if len(test_matches) < 10:
            continue

        # Group test matches by weekly batch date so walk-forward refits chronologically
        distinct_dates = sorted({m["match_date"] for m in test_matches})
        # Refit every 7 dates for fast execution while remaining strictly out-of-sample
        dc_cache: dict[str, Any] | None = None
        elo_cache: dict[str, float] = {}
        last_fit_idx = -99

        brier_1x2 = 0.0
        logloss_1x2 = 0.0
        n_1x2 = 0
        vb_1x2_cnt = 0
        vb_1x2_wins = 0
        vb_1x2_flat_pnl = 0.0
        vb_1x2_kelly_stake = 0.0
        vb_1x2_kelly_pnl = 0.0
        clv_1x2_vals: list[float] = []
        bins_1x2 = [{"pred_sum": 0.0, "actual_sum": 0.0, "count": 0} for _ in range(5)]

        brier_ou = 0.0
        logloss_ou = 0.0
        n_ou = 0
        vb_ou_cnt = 0
        vb_ou_wins = 0
        vb_ou_flat_pnl = 0.0
        vb_ou_kelly_stake = 0.0
        vb_ou_kelly_pnl = 0.0
        clv_ou_vals: list[float] = []
        bins_ou = [{"pred_sum": 0.0, "actual_sum": 0.0, "count": 0} for _ in range(5)]

        date_to_idx = {d: i for i, d in enumerate(distinct_dates)}

        for m in test_matches:
            d = m["match_date"]
            idx = date_to_idx[d]
            if dc_cache is None or idx - last_fit_idx >= 4:
                prior = [x for x in div_matches if x["match_date"] < d]
                if len(prior) < 30:
                    continue
                elo_cache, _, _ = compute_elo_ratings(
                    [x for x in all_matches if x["match_date"] < d]
                )
                dc_cache = fit_dixon_coles_params(prior[-760:], d)
                last_fit_idx = idx

            lam, mu = _predict_lambdas(m["home_team"], m["away_team"], dc_cache, elo_cache, div)
            probs = extract_market_probs(score_matrix(lam, mu, dc_cache["rho"]))

            # 1X2 evaluation vs Bet365 closing (or opening fallback)
            oh, od, oa = m.get("b365h"), m.get("b365d"), m.get("b365a")
            ch, cd, ca = m.get("b365ch") or oh, m.get("b365cd") or od, m.get("b365ca") or oa
            if ch and cd and ca:
                actual = [1.0 if m["ftr"] == "H" else 0.0, 1.0 if m["ftr"] == "D" else 0.0, 1.0 if m["ftr"] == "A" else 0.0]
                ps = [probs["prob_home"], probs["prob_draw"], probs["prob_away"]]
                brier_1x2 += sum((p - a) ** 2 for p, a in zip(ps, actual)) / 3.0
                actual_idx = 0 if m["ftr"] == "H" else (1 if m["ftr"] == "D" else 2)
                logloss_1x2 += -math.log(max(ps[actual_idx], 1e-6))
                n_1x2 += 1

                for p, a in zip(ps, actual):
                    b_idx = min(4, int(p * 5))
                    bins_1x2[b_idx]["pred_sum"] += p
                    bins_1x2[b_idx]["actual_sum"] += a
                    bins_1x2[b_idx]["count"] += 1

                # Simulate value betting at opening (or closing) odds with edge >= 3%
                open_odds = [oh or ch, od or cd, oa or ca]
                close_odds = [ch, cd, ca]
                for idx_o in range(3):
                    odd_taken = open_odds[idx_o]
                    odd_close = close_odds[idx_o]
                    p = ps[idx_o]
                    edge = p * odd_taken - 1.0
                    if edge >= 0.03 and odd_taken <= 6.5:
                        vb_1x2_cnt += 1
                        won = actual[idx_o] == 1.0
                        if won:
                            vb_1x2_wins += 1
                        vb_1x2_flat_pnl += (odd_taken - 1.0) if won else -1.0
                        k_stake = min(0.05, 0.25 * edge / max(odd_taken - 1.0, 0.1))
                        vb_1x2_kelly_stake += k_stake
                        vb_1x2_kelly_pnl += k_stake * ((odd_taken - 1.0) if won else -1.0)
                        if odd_close and odd_close > 1.0:
                            clv_1x2_vals.append((odd_taken / odd_close - 1.0) * 100.0)

            # O/U 2.5 evaluation
            oo25, ou25 = m.get("b365_over25"), m.get("b365_under25")
            co25, cu25 = m.get("b365c_over25") or oo25, m.get("b365c_under25") or ou25
            if co25 and cu25:
                tot_g = int(m["fthg"]) + int(m["ftag"])
                act_o = 1.0 if tot_g >= 3 else 0.0
                po = probs["prob_over25"]
                pu = probs["prob_under25"]
                brier_ou += (po - act_o) ** 2
                logloss_ou += -math.log(max(po if act_o == 1.0 else pu, 1e-6))
                n_ou += 1

                b_idx = min(4, int(po * 5))
                bins_ou[b_idx]["pred_sum"] += po
                bins_ou[b_idx]["actual_sum"] += act_o
                bins_ou[b_idx]["count"] += 1

                for p, won_bool, odd_taken, odd_close in [
                    (po, tot_g >= 3, oo25 or co25, co25),
                    (pu, tot_g <= 2, ou25 or cu25, cu25),
                ]:
                    edge = p * odd_taken - 1.0
                    if edge >= 0.03:
                        vb_ou_cnt += 1
                        if won_bool:
                            vb_ou_wins += 1
                        vb_ou_flat_pnl += (odd_taken - 1.0) if won_bool else -1.0
                        k_stake = min(0.05, 0.25 * edge / max(odd_taken - 1.0, 0.1))
                        vb_ou_kelly_stake += k_stake
                        vb_ou_kelly_pnl += k_stake * ((odd_taken - 1.0) if won_bool else -1.0)
                        if odd_close and odd_close > 1.0:
                            clv_ou_vals.append((odd_taken / odd_close - 1.0) * 100.0)

        def _save_bt(
            market: str,
            n_m: int,
            brier_sum: float,
            ll_sum: float,
            vb_cnt: int,
            vb_wins: int,
            flat_pnl: float,
            kelly_stake: float,
            kelly_pnl: float,
            clvs: list[float],
            bins: list[dict[str, Any]],
        ) -> None:
            if n_m == 0:
                return
            calib = []
            for i, b in enumerate(bins):
                if b["count"] > 0:
                    calib.append(
                        {
                            "bucket": f"{i*20}-{(i+1)*20}%",
                            "pred_pct": round(100.0 * b["pred_sum"] / b["count"], 1),
                            "actual_pct": round(100.0 * b["actual_sum"] / b["count"], 1),
                            "count": b["count"],
                        }
                    )
            row_data = {
                "div": div,
                "market": market,
                "matches_tested": n_m,
                "brier_score": round(brier_sum / n_m, 4),
                "log_loss": round(ll_sum / n_m, 4),
                "value_bets_count": vb_cnt,
                "win_rate_pct": round(100.0 * vb_wins / max(1, vb_cnt), 1),
                "flat_roi_pct": round(100.0 * flat_pnl / max(1, vb_cnt), 2),
                "kelly_roi_pct": round(100.0 * kelly_pnl / max(1e-6, kelly_stake), 2) if kelly_stake > 0 else 0.0,
                "avg_clv_pct": round(sum(clvs) / max(1, len(clvs)), 2) if clvs else 0.0,
                "calibration": calib,
            }
            conn.execute(
                """
                INSERT INTO backtest_results (
                    div, market, matches_tested, brier_score, log_loss, value_bets_count,
                    win_rate_pct, flat_roi_pct, kelly_roi_pct, avg_clv_pct, calibration_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(div, market) DO UPDATE SET
                    matches_tested = excluded.matches_tested,
                    brier_score = excluded.brier_score,
                    log_loss = excluded.log_loss,
                    value_bets_count = excluded.value_bets_count,
                    win_rate_pct = excluded.win_rate_pct,
                    flat_roi_pct = excluded.flat_roi_pct,
                    kelly_roi_pct = excluded.kelly_roi_pct,
                    avg_clv_pct = excluded.avg_clv_pct,
                    calibration_json = excluded.calibration_json,
                    updated_at = excluded.updated_at
                """,
                (
                    div,
                    market,
                    row_data["matches_tested"],
                    row_data["brier_score"],
                    row_data["log_loss"],
                    row_data["value_bets_count"],
                    row_data["win_rate_pct"],
                    row_data["flat_roi_pct"],
                    row_data["kelly_roi_pct"],
                    row_data["avg_clv_pct"],
                    json.dumps(calib),
                    now,
                ),
            )
            results_summary.append(row_data)

        _save_bt("1X2", n_1x2, brier_1x2, logloss_1x2, vb_1x2_cnt, vb_1x2_wins, vb_1x2_flat_pnl, vb_1x2_kelly_stake, vb_1x2_kelly_pnl, clv_1x2_vals, bins_1x2)
        _save_bt("O/U 2.5", n_ou, brier_ou, logloss_ou, vb_ou_cnt, vb_ou_wins, vb_ou_flat_pnl, vb_ou_kelly_stake, vb_ou_kelly_pnl, clv_ou_vals, bins_ou)

    return results_summary
