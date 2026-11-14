"""Live data ingestion for AccaLab: football-data.co.uk CSVs, fixturedownload.com, API-Football, and RSS news."""

from __future__ import annotations

import csv
import email.utils
import html
import io
import json
import re
import sqlite3
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx

from accalab.config import (
    API_FOOTBALL_KEY,
    LEAGUES,
    NEWS_FEEDS,
    SEASONS,
    TEAM_ALIASES,
    normalize_team_name,
)
from accalab.db import (
    get_api_football_calls_today,
    get_last_provider_call_iso,
    is_within_cache_window,
    utc_now_iso,
)

HEADERS = {"User-Agent": "AccaLab/0.1 (Personal Football Analytics App)"}


def _to_int(val: Any) -> int | None:
    if val is None:
        return None
    s = str(val).strip()
    if not s:
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


def _to_float(val: Any) -> float | None:
    if val is None:
        return None
    s = str(val).strip()
    if not s:
        return None
    try:
        f = float(s)
        return f if f > 1.0 else None
    except ValueError:
        return None


def _parse_uk_date(raw: str) -> str | None:
    s = (raw or "").strip()
    if not s:
        return None
    for fmt in ("%d/%m/%Y", "%d/%m/%y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _strip_html(raw: str) -> str:
    if not raw:
        return ""
    text = re.sub(r"<[^>]+>", " ", html.unescape(raw))
    return re.sub(r"\s+", " ", text).strip()


def ingest_football_data_csvs(conn: sqlite3.Connection, client: httpx.Client | None = None) -> dict[str, Any]:
    """Fetch 2425, 2526, and 2627 CSVs for E0-E3 from football-data.co.uk."""
    own_client = client is None
    if own_client:
        client = httpx.Client(headers=HEADERS, follow_redirects=True, timeout=20.0)

    total_upserted = 0
    errors: list[str] = []

    try:
        for season in SEASONS:
            for div in LEAGUES:
                url = f"https://www.football-data.co.uk/mmz4281/{season}/{div}.csv"
                try:
                    resp = client.get(url)
                    if resp.status_code != 200 or "HomeTeam" not in resp.text:
                        errors.append(f"{season}/{div}: HTTP {resp.status_code}")
                        continue
                    text = resp.text.lstrip("\ufeff")
                    reader = csv.DictReader(io.StringIO(text))
                    batch: list[tuple[Any, ...]] = []
                    for row in reader:
                        match_date = _parse_uk_date(row.get("Date", ""))
                        home = normalize_team_name(row.get("HomeTeam", ""))
                        away = normalize_team_name(row.get("AwayTeam", ""))
                        fthg = _to_int(row.get("FTHG"))
                        ftag = _to_int(row.get("FTAG"))
                        if not match_date or not home or not away or fthg is None or ftag is None:
                            continue
                        ftr = (row.get("FTR") or "").strip() or (
                            "H" if fthg > ftag else ("A" if ftag > fthg else "D")
                        )
                        batch.append(
                            (
                                season,
                                div,
                                match_date,
                                (row.get("Time") or "").strip(),
                                home,
                                away,
                                fthg,
                                ftag,
                                ftr,
                                _to_int(row.get("HTHG")),
                                _to_int(row.get("HTAG")),
                                _to_int(row.get("HS")),
                                _to_int(row.get("AS")),
                                _to_int(row.get("HST")),
                                _to_int(row.get("AST")),
                                _to_int(row.get("HC")),
                                _to_int(row.get("AC")),
                                _to_int(row.get("HY")),
                                _to_int(row.get("AY")),
                                _to_int(row.get("HR")),
                                _to_int(row.get("AR")),
                                (row.get("Referee") or "").strip(),
                                _to_float(row.get("B365H")),
                                _to_float(row.get("B365D")),
                                _to_float(row.get("B365A")),
                                _to_float(row.get("B365>2.5")),
                                _to_float(row.get("B365<2.5")),
                                _to_float(row.get("B365CH")),
                                _to_float(row.get("B365CD")),
                                _to_float(row.get("B365CA")),
                                _to_float(row.get("B365C>2.5")),
                                _to_float(row.get("B365C<2.5")),
                                _to_float(row.get("AvgH")),
                                _to_float(row.get("AvgD")),
                                _to_float(row.get("AvgA")),
                            )
                        )
                    if batch:
                        conn.executemany(
                            """
                            INSERT INTO historical_matches (
                                season, div, match_date, kickoff_time, home_team, away_team,
                                fthg, ftag, ftr, hthg, htag, hs, as_shots, hst, ast, hc, ac,
                                hy, ay, hr, ar, referee,
                                b365h, b365d, b365a, b365_over25, b365_under25,
                                b365ch, b365cd, b365ca, b365c_over25, b365c_under25,
                                avg_h, avg_d, avg_a
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(season, div, match_date, home_team, away_team) DO UPDATE SET
                                kickoff_time = excluded.kickoff_time,
                                fthg = excluded.fthg,
                                ftag = excluded.ftag,
                                ftr = excluded.ftr,
                                hthg = excluded.hthg,
                                htag = excluded.htag,
                                hs = excluded.hs,
                                as_shots = excluded.as_shots,
                                hst = excluded.hst,
                                ast = excluded.ast,
                                hc = excluded.hc,
                                ac = excluded.ac,
                                hy = excluded.hy,
                                ay = excluded.ay,
                                hr = excluded.hr,
                                ar = excluded.ar,
                                referee = excluded.referee,
                                b365h = COALESCE(excluded.b365h, historical_matches.b365h),
                                b365d = COALESCE(excluded.b365d, historical_matches.b365d),
                                b365a = COALESCE(excluded.b365a, historical_matches.b365a),
                                b365_over25 = COALESCE(excluded.b365_over25, historical_matches.b365_over25),
                                b365_under25 = COALESCE(excluded.b365_under25, historical_matches.b365_under25),
                                b365ch = COALESCE(excluded.b365ch, historical_matches.b365ch),
                                b365cd = COALESCE(excluded.b365cd, historical_matches.b365cd),
                                b365ca = COALESCE(excluded.b365ca, historical_matches.b365ca),
                                b365c_over25 = COALESCE(excluded.b365c_over25, historical_matches.b365c_over25),
                                b365c_under25 = COALESCE(excluded.b365c_under25, historical_matches.b365c_under25),
                                avg_h = COALESCE(excluded.avg_h, historical_matches.avg_h),
                                avg_d = COALESCE(excluded.avg_d, historical_matches.avg_d),
                                avg_a = COALESCE(excluded.avg_a, historical_matches.avg_a)
                            """,
                            batch,
                        )
                        total_upserted += len(batch)
                except Exception as exc:
                    errors.append(f"{season}/{div}: {exc}")
    finally:
        if own_client:
            client.close()

    return {"historical_upserted": total_upserted, "errors": errors}


def _enrich_from_api_football(conn: sqlite3.Connection, client: httpx.Client) -> dict[str, Any]:
    """Optional Bet365 odds enrichment when API_FOOTBALL_KEY is configured (<90 calls/day guard)."""
    if not API_FOOTBALL_KEY:
        return {"used": False, "updated": 0, "reason": "API_FOOTBALL_KEY not configured"}

    calls_today = get_api_football_calls_today(conn)
    if calls_today >= 90:
        return {"used": False, "updated": 0, "reason": f"Daily quota guard reached ({calls_today}/100)"}

    headers = {"x-apisports-key": API_FOOTBALL_KEY}
    updated = 0
    cached_divisions = 0
    calls_made = 0
    now = utc_now_iso()

    # Collect upcoming dates across our fixtures
    upcoming_rows = conn.execute(
        "SELECT id, div, match_date, home_team, away_team FROM upcoming_fixtures WHERE status = 'scheduled'"
    ).fetchall()
    if not upcoming_rows:
        return {"used": False, "updated": 0, "cached_divisions": 0, "reason": "No scheduled fixtures"}

    lookup: dict[tuple[str, str, str], int] = {
        (r["div"], r["home_team"], r["away_team"]): r["id"] for r in upcoming_rows
    }

    for div, meta in LEAGUES.items():
        ep_prefix = f"/odds?league={meta['api_football_id']}"
        last_call = get_last_provider_call_iso(conn, "api_football", endpoint_prefix=ep_prefix, status_code=200)
        if is_within_cache_window(last_call, minutes=360):
            cached_divisions += 1
            continue
        if get_api_football_calls_today(conn) >= 90:
            break
        try:
            resp = client.get(
                "https://v3.football.api-sports.io/odds",
                params={"league": meta["api_football_id"], "season": 2026, "bookmaker": 8},
                headers=headers,
            )
            calls_made += 1
            conn.execute(
                "INSERT INTO api_usage_log (provider, endpoint, status_code, called_at) VALUES (?, ?, ?, ?)",
                ("api_football", f"/odds?league={meta['api_football_id']}&bookmaker=8", resp.status_code, now),
            )
            if resp.status_code != 200:
                continue
            payload = resp.json()
            for item in payload.get("response", []):
                teams = item.get("fixture", {}) or {}
                # Note: API-Football /odds returns fixture id + bookmakers; match via /fixtures if needed
                bks = item.get("bookmakers", [])
                if not bks:
                    continue
                # Extract bets when fixture teams are included or via nested fields
                league_teams = item.get("teams") or {}
                h_name = normalize_team_name((league_teams.get("home") or {}).get("name", ""))
                a_name = normalize_team_name((league_teams.get("away") or {}).get("name", ""))
                fid = lookup.get((div, h_name, a_name))
                if not fid:
                    continue
                bets = bks[0].get("bets", [])
                odds_map: dict[str, float] = {}
                for b in bets:
                    bname = (b.get("name") or "").lower()
                    vals = {str(v.get("value")): _to_float(v.get("odd")) for v in b.get("values", [])}
                    if "match winner" in bname:
                        if vals.get("Home"):
                            odds_map["b365h"] = vals["Home"]
                        if vals.get("Draw"):
                            odds_map["b365d"] = vals["Draw"]
                        if vals.get("Away"):
                            odds_map["b365a"] = vals["Away"]
                    elif "goals over/under" in bname:
                        if vals.get("Over 2.5"):
                            odds_map["b365_over25"] = vals["Over 2.5"]
                        if vals.get("Under 2.5"):
                            odds_map["b365_under25"] = vals["Under 2.5"]
                    elif "both teams score" in bname:
                        if vals.get("Yes"):
                            odds_map["b365_btts_yes"] = vals["Yes"]
                        if vals.get("No"):
                            odds_map["b365_btts_no"] = vals["No"]
                if odds_map:
                    conn.execute(
                        """
                        UPDATE upcoming_fixtures SET
                            b365h = COALESCE(?, b365h),
                            b365d = COALESCE(?, b365d),
                            b365a = COALESCE(?, b365a),
                            b365_over25 = COALESCE(?, b365_over25),
                            b365_under25 = COALESCE(?, b365_under25),
                            b365_btts_yes = COALESCE(?, b365_btts_yes),
                            b365_btts_no = COALESCE(?, b365_btts_no),
                            odds_source = 'api_football_b365',
                            updated_at = ?
                        WHERE id = ?
                        """,
                        (
                            odds_map.get("b365h"),
                            odds_map.get("b365d"),
                            odds_map.get("b365a"),
                            odds_map.get("b365_over25"),
                            odds_map.get("b365_under25"),
                            odds_map.get("b365_btts_yes"),
                            odds_map.get("b365_btts_no"),
                            now,
                            fid,
                        ),
                    )
                    updated += 1
        except Exception:
            continue

    return {"used": calls_made > 0 or updated > 0, "updated": updated, "cached_divisions": cached_divisions}


def ingest_upcoming_fixtures(conn: sqlite3.Connection, client: httpx.Client | None = None) -> dict[str, Any]:
    """Ingest official Bet365 fixtures.csv plus 2026/27 schedules from fixturedownload.com."""
    own_client = client is None
    if own_client:
        client = httpx.Client(headers=HEADERS, follow_redirects=True, timeout=20.0)

    now = utc_now_iso()
    today_dt = datetime.now(timezone.utc).date()
    today_iso = today_dt.isoformat()
    official_count = 0
    schedule_count = 0
    errors: list[str] = []

    try:
        # Mark past scheduled fixtures that already appear in historical_matches as completed
        conn.execute(
            """
            UPDATE upcoming_fixtures
            SET status = 'completed'
            WHERE EXISTS (
                SELECT 1 FROM historical_matches h
                WHERE h.div = upcoming_fixtures.div
                  AND h.match_date = upcoming_fixtures.match_date
                  AND h.home_team = upcoming_fixtures.home_team
                  AND h.away_team = upcoming_fixtures.away_team
            )
            """
        )

        # 1. Fetch official football-data.co.uk/fixtures.csv (live Bet365 odds)
        try:
            rf = client.get("https://www.football-data.co.uk/fixtures.csv")
            if rf.status_code == 200 and "HomeTeam" in rf.text:
                reader = csv.DictReader(io.StringIO(rf.text.lstrip("\ufeff")))
                for row in reader:
                    div = (row.get("Div") or "").strip()
                    if div not in LEAGUES:
                        continue
                    match_date = _parse_uk_date(row.get("Date", ""))
                    home = normalize_team_name(row.get("HomeTeam", ""))
                    away = normalize_team_name(row.get("AwayTeam", ""))
                    if not match_date or not home or not away:
                        continue
                    b365h = _to_float(row.get("B365H"))
                    b365d = _to_float(row.get("B365D"))
                    b365a = _to_float(row.get("B365A"))
                    b365_o25 = _to_float(row.get("B365>2.5"))
                    b365_u25 = _to_float(row.get("B365<2.5"))
                    src = "bet365_official" if (b365h and b365d and b365a) else "market_estimate"
                    conn.execute(
                        """
                        INSERT INTO upcoming_fixtures (
                            div, match_date, kickoff_time, home_team, away_team, status,
                            b365h, b365d, b365a, b365_over25, b365_under25,
                            b365_open_h, b365_open_d, b365_open_a, odds_source, updated_at
                        ) VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(div, match_date, home_team, away_team) DO UPDATE SET
                            kickoff_time = COALESCE(NULLIF(excluded.kickoff_time, ''), upcoming_fixtures.kickoff_time),
                            b365h = CASE
                                WHEN upcoming_fixtures.odds_source = 'user_manual' THEN upcoming_fixtures.b365h
                                ELSE COALESCE(excluded.b365h, upcoming_fixtures.b365h)
                            END,
                            b365d = CASE
                                WHEN upcoming_fixtures.odds_source = 'user_manual' THEN upcoming_fixtures.b365d
                                ELSE COALESCE(excluded.b365d, upcoming_fixtures.b365d)
                            END,
                            b365a = CASE
                                WHEN upcoming_fixtures.odds_source = 'user_manual' THEN upcoming_fixtures.b365a
                                ELSE COALESCE(excluded.b365a, upcoming_fixtures.b365a)
                            END,
                            b365_over25 = CASE
                                WHEN upcoming_fixtures.odds_source = 'user_manual' THEN upcoming_fixtures.b365_over25
                                ELSE COALESCE(excluded.b365_over25, upcoming_fixtures.b365_over25)
                            END,
                            b365_under25 = CASE
                                WHEN upcoming_fixtures.odds_source = 'user_manual' THEN upcoming_fixtures.b365_under25
                                ELSE COALESCE(excluded.b365_under25, upcoming_fixtures.b365_under25)
                            END,
                            b365_open_h = COALESCE(upcoming_fixtures.b365_open_h, excluded.b365h),
                            b365_open_d = COALESCE(upcoming_fixtures.b365_open_d, excluded.b365d),
                            b365_open_a = COALESCE(upcoming_fixtures.b365_open_a, excluded.b365a),
                            odds_source = CASE
                                WHEN upcoming_fixtures.odds_source = 'user_manual' THEN 'user_manual'
                                WHEN excluded.b365h IS NOT NULL THEN 'bet365_official'
                                ELSE upcoming_fixtures.odds_source
                            END,
                            updated_at = excluded.updated_at
                        """,
                        (
                            div,
                            match_date,
                            (row.get("Time") or "").strip(),
                            home,
                            away,
                            b365h,
                            b365d,
                            b365a,
                            b365_o25,
                            b365_u25,
                            b365h,
                            b365d,
                            b365a,
                            src,
                            now,
                        ),
                    )
                    official_count += 1
        except Exception as exc:
            errors.append(f"fixtures.csv: {exc}")

        # 2. Fetch full 2026/27 schedules from fixturedownload.com so all 4 divisions have upcoming fixtures
        for div, meta in LEAGUES.items():
            slug = meta["fixturedownload_slug"]
            try:
                rj = client.get(f"https://fixturedownload.com/feed/json/{slug}")
                if rj.status_code != 200:
                    errors.append(f"fixturedownload/{slug}: HTTP {rj.status_code}")
                    continue
                items = rj.json()
                candidates: list[tuple[str, str, dict[str, Any]]] = []
                for item in items:
                    if item.get("HomeTeamScore") is not None:
                        continue
                    raw_dt = (item.get("DateUtc") or "").strip()
                    if not raw_dt:
                        continue
                    try:
                        dt = datetime.strptime(raw_dt, "%Y-%m-%d %H:%M:%SZ")
                    except ValueError:
                        continue
                    mdate = dt.strftime("%Y-%m-%d")
                    mtime = dt.strftime("%H:%M")
                    if mdate < today_iso:
                        continue
                    candidates.append((mdate, mtime, item))

                # Keep fixtures within next 14 days; if none (e.g. international break), take next 21 days
                window_14 = (today_dt + timedelta(days=14)).isoformat()
                window_21 = (today_dt + timedelta(days=21)).isoformat()
                filtered = [c for c in candidates if c[0] <= window_14]
                if not filtered:
                    filtered = [c for c in candidates if c[0] <= window_21]
                if not filtered and candidates:
                    filtered = candidates[:12]

                for mdate, mtime, item in filtered:
                    home = normalize_team_name(item.get("HomeTeam", ""))
                    away = normalize_team_name(item.get("AwayTeam", ""))
                    if not home or not away:
                        continue
                    # Skip if already completed in historical_matches
                    done = conn.execute(
                        """
                        SELECT 1 FROM historical_matches
                        WHERE div = ? AND match_date = ? AND home_team = ? AND away_team = ?
                        """,
                        (div, mdate, home, away),
                    ).fetchone()
                    if done:
                        continue
                    conn.execute(
                        """
                        INSERT INTO upcoming_fixtures (
                            div, round_number, match_date, kickoff_time, home_team, away_team,
                            venue, status, odds_source, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', 'market_estimate', ?)
                        ON CONFLICT(div, match_date, home_team, away_team) DO UPDATE SET
                            round_number = COALESCE(excluded.round_number, upcoming_fixtures.round_number),
                            venue = COALESCE(NULLIF(excluded.venue, ''), upcoming_fixtures.venue),
                            kickoff_time = COALESCE(NULLIF(upcoming_fixtures.kickoff_time, ''), excluded.kickoff_time),
                            updated_at = excluded.updated_at
                        """,
                        (
                            div,
                            _to_int(item.get("RoundNumber")),
                            mdate,
                            mtime,
                            home,
                            away,
                            (item.get("Location") or "").strip(),
                            now,
                        ),
                    )
                    schedule_count += 1
            except Exception as exc:
                errors.append(f"fixturedownload/{slug}: {exc}")

        api_info = _enrich_from_api_football(conn, client)
    finally:
        if own_client:
            client.close()

    return {
        "official_fixtures_upserted": official_count,
        "schedule_fixtures_upserted": schedule_count,
        "api_football": api_info,
        "errors": errors,
    }


def ingest_news_feeds(conn: sqlite3.Connection, client: httpx.Client | None = None) -> dict[str, Any]:
    """Fetch BBC, Sky Sports, and Guardian Football RSS feeds and match club mentions."""
    own_client = client is None
    if own_client:
        client = httpx.Client(headers=HEADERS, follow_redirects=True, timeout=15.0)

    # Build searchable pattern map: phrase -> canonical team name
    known_teams = {
        r["team_name"] for r in conn.execute("SELECT DISTINCT team_name FROM team_ratings").fetchall()
    }
    if not known_teams:
        known_teams = {
            r["home_team"] for r in conn.execute("SELECT DISTINCT home_team FROM historical_matches").fetchall()
        } | set(TEAM_ALIASES.values())

    phrase_to_team: dict[str, str] = {}
    for canonical in known_teams:
        if len(canonical) >= 4:
            phrase_to_team[canonical.lower()] = canonical
    for alias, canonical in TEAM_ALIASES.items():
        if len(alias) >= 4:
            phrase_to_team[alias.lower()] = canonical

    patterns: list[tuple[re.Pattern[str], str]] = [
        (re.compile(r"\b" + re.escape(phrase) + r"\b", re.IGNORECASE), canonical)
        for phrase, canonical in sorted(phrase_to_team.items(), key=lambda x: -len(x[0]))
    ]

    now = utc_now_iso()
    saved = 0
    errors: list[str] = []

    try:
        for source_name, url in NEWS_FEEDS:
            try:
                resp = client.get(url)
                if resp.status_code != 200:
                    errors.append(f"{source_name}: HTTP {resp.status_code}")
                    continue
                root = ET.fromstring(resp.text)
                items = root.findall(".//item")[:40]
                for item in items:
                    title = _strip_html(item.findtext("title") or "")
                    summary = _strip_html(item.findtext("description") or "")
                    link = (item.findtext("link") or "").strip()
                    pub_raw = (item.findtext("pubDate") or "").strip()
                    if not title or not link:
                        continue
                    try:
                        pub_dt = email.utils.parsedate_to_datetime(pub_raw)
                        pub_iso = pub_dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                    except Exception:
                        pub_iso = now

                    haystack = f"{title} {summary}"
                    matched: list[str] = []
                    seen: set[str] = set()
                    for pat, team in patterns:
                        if pat.search(haystack) and team not in seen:
                            seen.add(team)
                            matched.append(team)

                    conn.execute(
                        """
                        INSERT INTO news_items (title, summary, url, source, published_at, matched_teams_json, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(url) DO UPDATE SET
                            title = excluded.title,
                            summary = excluded.summary,
                            matched_teams_json = excluded.matched_teams_json
                        """,
                        (title, summary[:500], link, source_name, pub_iso, json.dumps(matched), now),
                    )
                    saved += 1
            except Exception as exc:
                errors.append(f"{source_name}: {exc}")
    finally:
        if own_client:
            client.close()

    return {"news_upserted": saved, "errors": errors}
