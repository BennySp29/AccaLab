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

    (BASE_DIR / ".nojekyll").write_text("", encoding="utf-8")

    template_html = (pkg_templates / "index.html").read_text(encoding="utf-8")
    app_js_text = (pkg_static / "app.js").read_text(encoding="utf-8")
    build_hash = hashlib.sha256(f"{template_html}\n{app_js_text}".encode("utf-8")).hexdigest()[:8]
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
    shutil.copy2(pkg_static / "app.js", root_static / "app.js")
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
        "fixtures": len(fixtures),
        "fixture_details": len(fixture_details),
        "value_bets": len(snapshot["value_bets"]),
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
            "static/accalab-bet365.user.js",
            "static/snapshot.json",
            "accalab/static/snapshot.json",
        ],
    }

