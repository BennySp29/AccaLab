"""Export a self-contained static PWA bundle and live JSON snapshot for GitHub Pages."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
from pathlib import Path
from typing import Any

from accalab.config import BASE_DIR
from accalab.db import utc_now_iso


def export_static_site() -> dict[str, Any]:
    """Generate root GitHub Pages files and pre-computed snapshot.json from the live SQLite database."""
    from accalab.web import create_app

    app = create_app()
    client = app.test_client()

    dashboard = client.get("/api/dashboard").get_json()
    fixtures_res = client.get("/api/fixtures").get_json()
    fixtures = fixtures_res.get("fixtures", []) if fixtures_res else []
    value_res = client.get("/api/value-bets?min_edge=-25").get_json()
    builders_res = client.get("/api/bet-builders?limit=40").get_json()
    presets_res = client.get("/api/acca/presets").get_json()
    suggest_res = client.get("/api/suggest-bet").get_json()
    leaderboard_res = client.get("/api/leaderboard").get_json()
    backtest_res = client.get("/api/backtest").get_json()
    news_res = client.get("/api/news").get_json()
    alerts_res = client.get("/api/alerts").get_json()

    bets_by_user: dict[str, Any] = {}
    saved_accas_by_user: dict[str, Any] = {}
    for usr in (dashboard or {}).get("users", []):
        uid = str(usr["id"])
        bets_by_user[uid] = client.get(f"/api/bets?user_id={uid}").get_json() or {"bets": []}
        saved_res = client.get(f"/api/user/saved-accas?user_id={uid}").get_json() or {}
        saved_accas_by_user[uid] = saved_res.get("saved_accas", [])

    fixture_details: dict[str, Any] = {}
    standings_by_div: dict[str, Any] = {}
    for fix in fixtures:
        fid = str(fix["id"])
        detail = client.get(f"/api/fixture/{fid}").get_json()
        if not detail:
            continue
        div = detail.get("fixture", {}).get("div")
        if div and div not in standings_by_div and detail.get("standings"):
            standings_by_div[div] = detail["standings"]
        detail.pop("standings", None)
        fixture_details[fid] = detail

    snapshot = {
        "generated_at": utc_now_iso(),
        "dashboard": dashboard or {},
        "fixtures": fixtures,
        "standings_by_div": standings_by_div,
        "fixture_details": fixture_details,
        "value_bets": (value_res or {}).get("opportunities", []),
        "bet_builders": (builders_res or {}).get("builders", []),
        "acca_presets": (presets_res or {}).get("presets", []),
        "suggest_bet": suggest_res or {},
        "leaderboard": leaderboard_res or {},
        "backtest": backtest_res or {},
        "news": (news_res or {}).get("news", []),
        "alerts": (alerts_res or {}).get("alerts", []),
        "bets_by_user": bets_by_user,
        "saved_accas_by_user": saved_accas_by_user,
    }

    pkg_dir = Path(__file__).resolve().parent
    pkg_static = pkg_dir / "static"
    pkg_templates = pkg_dir / "templates"
    root_static = BASE_DIR / "static"
    root_static.mkdir(parents=True, exist_ok=True)

    snapshot_payload = json.dumps(snapshot, separators=(",", ":"), ensure_ascii=False)
    for snap_path in (pkg_static / "snapshot.json", root_static / "snapshot.json"):
        snap_path.write_text(snapshot_payload, encoding="utf-8")

    # Separate lazy-loaded Horse Racing snapshot so Football snapshot.json remains compact & fast
    racing_overview = client.get("/api/racing/overview").get_json() or {}
    racing_cards_res = client.get("/api/racing/cards").get_json() or {}
    racing_tips_res = client.get("/api/racing/tips?limit=400").get_json() or {}
    racing_suggest_res = client.get("/api/racing/suggest-bet").get_json() or {}
    parent_redundant_keys = (
        "race_key", "region_code", "region_flag", "country_name", "course",
        "race_date", "off_time", "race_name", "race_type", "is_handicap",
        "distance_text", "going", "surface", "runners_count", "places_paid",
        "place_fraction", "ew_eligible", "place_terms_label",
    )
    derived_runner_keys = {
        "reasons", "reason_stats", "fair_win_odds", "fair_win_odds_fractional",
        "fair_place_odds", "fair_place_odds_fractional", "odds_fractional",
        "place_odds", "place_odds_fractional", "model_win_prob_pct",
        "model_place_prob_pct", "win_edge_pct", "ew_edge_pct",
        "place_edge_pct", "odds", "non_runner", "form_string",
    }

    def _compact_runner(rn: dict[str, Any], strip_parent: bool = True, keep_reasons: bool = False) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for k, v in rn.items():
            if k in derived_runner_keys:
                if keep_reasons and k in ("reasons", "reason_stats") and v:
                    out[k] = v
                continue
            if strip_parent and k in parent_redundant_keys:
                continue
            if v in (None, "", []):
                continue
            out[k] = v
        return out

    compact_races: list[dict[str, Any]] = []
    for rc in racing_cards_res.get("races", []):
        rc_copy = {k: v for k, v in rc.items() if k != "runners" and v not in (None, "")}
        rc_copy["runners"] = [_compact_runner(rn, strip_parent=True, keep_reasons=False) for rn in rc.get("runners", [])]
        compact_races.append(rc_copy)

    compact_tips = [_compact_runner(t, strip_parent=False, keep_reasons=True) for t in racing_tips_res.get("tips", [])]
    compact_suggest = dict(racing_suggest_res or {})
    if compact_suggest.get("cards"):
        compact_suggest["cards"] = [
            {
                **c,
                "legs": [_compact_runner(lg, strip_parent=False, keep_reasons=True) for lg in c.get("legs", [])],
            }
            for c in compact_suggest["cards"]
        ]

    racing_races = racing_cards_res.get("races", [])
    racing_tips = racing_tips_res.get("tips", [])
    racing_snapshot = {
        "generated_at": snapshot["generated_at"],
        "overview": racing_overview,
        "races": compact_races,
        "tips": compact_tips,
        "suggest_bet": compact_suggest,
        "news": racing_overview.get("news", []),
    }
    racing_payload = json.dumps(racing_snapshot, separators=(",", ":"), ensure_ascii=False)
    for r_snap_path in (pkg_static / "racing_snapshot.json", root_static / "racing_snapshot.json"):
        r_snap_path.write_text(racing_payload, encoding="utf-8")

    (BASE_DIR / ".nojekyll").write_text("", encoding="utf-8")

    template_html = (pkg_templates / "index.html").read_text(encoding="utf-8")
    app_js_text = (pkg_static / "app.js").read_text(encoding="utf-8")
    racing_js_path = pkg_static / "racing.js"
    racing_js_text = racing_js_path.read_text(encoding="utf-8") if racing_js_path.exists() else ""
    build_hash = hashlib.sha256(f"{template_html}\n{app_js_text}\n{racing_js_text}".encode("utf-8")).hexdigest()[:8]
    build_version = f"accalab-v3-{build_hash}"

    sw_text = (pkg_static / "sw.js").read_text(encoding="utf-8")
    stamped_sw = re.sub(
        r"const CACHE_NAME = '[^']+';",
        f"const CACHE_NAME = '{build_version}';",
        sw_text,
        count=1,
    )
    (pkg_static / "sw.js").write_text(stamped_sw, encoding="utf-8")
    (BASE_DIR / "sw.js").write_text(stamped_sw, encoding="utf-8")

    stamped_index = re.sub(
        r'src="\./static/app\.js(?:\?v=[^"]*)?"',
        f'src="./static/app.js?v={build_hash}"',
        template_html,
    )
    (BASE_DIR / "index.html").write_text(stamped_index, encoding="utf-8")

    shutil.copy2(pkg_static / "manifest.json", BASE_DIR / "manifest.json")
    stamped_app_js = re.sub(
        r"from\s+['\"]\.\/racing\.js(?:\?v=[^'\"]*)?['\"]",
        f"from './racing.js?v={build_hash}'",
        app_js_text,
    )
    (root_static / "app.js").write_text(stamped_app_js, encoding="utf-8")
    if racing_js_path.exists():
        shutil.copy2(racing_js_path, root_static / "racing.js")
    shutil.copy2(pkg_static / "accalab-bet365.user.js", root_static / "accalab-bet365.user.js")

    icon_bytes = client.get("/icon.svg").data
    (BASE_DIR / "icon.svg").write_bytes(icon_bytes)

    icon_180 = client.get("/apple-touch-icon.png").data
    (BASE_DIR / "apple-touch-icon.png").write_bytes(icon_180)
    icon_192 = client.get("/icon-192.png").data
    (BASE_DIR / "icon-192.png").write_bytes(icon_192)
    icon_512 = client.get("/icon-512.png").data
    (BASE_DIR / "icon-512.png").write_bytes(icon_512)

    return {
        "generated_at": snapshot["generated_at"],
        "build_version": build_version,
        "snapshot_bytes": len(snapshot_payload.encode("utf-8")),
        "racing_snapshot_bytes": len(racing_payload.encode("utf-8")),
        "fixtures": len(fixtures),
        "fixture_details": len(fixture_details),
        "value_bets": len(snapshot["value_bets"]),
        "racing_races": len(racing_races),
        "racing_tips": len(racing_tips),
        "files": [
            ".nojekyll",
            "index.html",
            "manifest.json",
            "sw.js",
            "icon.svg",
            "apple-touch-icon.png",
            "icon-192.png",
            "icon-512.png",
            "static/app.js",
            "static/racing.js",
            "static/accalab-bet365.user.js",
            "static/snapshot.json",
            "accalab/static/snapshot.json",
            "static/racing_snapshot.json",
            "accalab/static/racing_snapshot.json",
        ],
    }

