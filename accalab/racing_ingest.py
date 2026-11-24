"""Card-free, zero-key horse racing ingestion: Entain/TAB NZ JSON (UK/IRE/Global) + PMU JSON + BBC RSS."""

from __future__ import annotations

import email.utils
import html
import re
import sqlite3
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx

from accalab.config import RACING_NEWS_FEEDS, RACING_REGIONS
from accalab.db import utc_now_iso

HEADERS = {"User-Agent": "AccaLab/0.2 (Personal Racing & Football Analytics App)"}
ENTAIN_HEADERS = {
    "User-Agent": "AccaLab/0.2 (Personal Racing & Football Analytics App)",
    "From": "accalab@example.com",
    "X-Partner": "AccaLab",
}

COUNTRY_REGION_MAP: dict[str, str] = {
    "GBR": "GB",
    "GB": "GB",
    "UK": "GB",
    "IRL": "IRE",
    "IRE": "IRE",
    "IE": "IRE",
    "FRA": "FR",
    "FR": "FR",
    "USA": "US",
    "US": "US",
    "AUS": "AU",
    "AU": "AU",
    "HK": "INTL",
    "HKG": "INTL",
    "JPN": "INTL",
    "NZ": "INTL",
    "NZL": "INTL",
    "ZAF": "INTL",
    "RSA": "INTL",
    "ARE": "INTL",
    "UAE": "INTL",
    "GER": "INTL",
    "DEU": "INTL",
    "ITY": "INTL",
    "ITA": "INTL",
    "CAN": "INTL",
    "CHL": "INTL",
    "ARG": "INTL",
    "SWE": "INTL",
    "NOR": "INTL",
    "CHE": "INTL",
    "ESP": "INTL",
    "MAR": "INTL",
}

ENTAIN_ALLOWED_COUNTRIES: frozenset[str] = frozenset(
    {"UK", "GB", "GBR", "IRE", "IRL", "IE", "FR", "FRA", "USA", "US", "AUS", "AU", "HK", "HKG", "NZ", "NZL", "JPN"}
)

COUNTRY_DISPLAY_NAMES: dict[str, str] = {
    "GBR": "Great Britain",
    "GB": "Great Britain",
    "UK": "Great Britain",
    "IRL": "Ireland",
    "IRE": "Ireland",
    "IE": "Ireland",
    "FRA": "France",
    "FR": "France",
    "USA": "United States",
    "US": "United States",
    "AUS": "Australia",
    "AU": "Australia",
    "HK": "Hong Kong",
    "HKG": "Hong Kong",
    "JPN": "Japan",
    "NZ": "New Zealand",
    "NZL": "New Zealand",
    "ZAF": "South Africa",
    "ARE": "UAE",
    "GER": "Germany",
    "DEU": "Germany",
    "ITY": "Italy",
    "ITA": "Italy",
    "CAN": "Canada",
    "CHL": "Chile",
    "ARG": "Argentina",
    "SWE": "Sweden",
    "CHE": "Switzerland",
}

PMU_GOING_MAP: dict[str, str] = {
    "PSF STANDARD": "Standard (AW)",
    "STANDARD": "Standard (AW)",
    "STANDARD_TO_SLOW": "Standard to Slow (AW)",
    "PSF STANDARD A LENT": "Standard to Slow (AW)",
    "PSF RAPIDE": "Fast (AW)",
    "FIBRESAND": "Fibresand (AW)",
    "POLYTRACK": "Polytrack (AW)",
    "SYNTHETIC": "Standard (AW)",
    "TAPETA": "Standard (AW)",
    "FAST": "Fast",
    "FIRM": "Firm",
    "GOOD3": "Good to Firm",
    "GOOD4": "Good",
    "GOOD": "Good",
    "TRES_LEGER": "Firm",
    "LEGER": "Good to Firm",
    "BON_LEGER": "Good to Firm",
    "BON LEGER": "Good to Firm",
    "BON": "Good",
    "BON_SOUPLE": "Good to Soft",
    "BON SOUPLE": "Good to Soft",
    "SOUPLE": "Good to Soft",
    "SOFT5": "Good to Soft",
    "SOFT6": "Soft",
    "SOFT7": "Soft",
    "TRES_SOUPLE": "Soft",
    "TRES SOUPLE": "Soft",
    "COLLANT": "Soft (Sticky)",
    "HEAVY": "Heavy",
    "HEAVY8": "Heavy",
    "HEAVY9": "Heavy",
    "HEAVY10": "Heavy",
    "LOURD": "Heavy",
    "TRES_LOURD": "Heavy",
}

PMU_HEADGEAR_MAP: dict[str, str] = {
    "SANS_OEILLERES": "",
    "OEILLERES_CLASSIQUE": "Blinkers",
    "OEILLERES_AUSTRALIENNES": "Cheekpieces",
    "BONNET": "Hood",
    "BONNET_OEILLERES": "Hood & Blinkers",
    "OEILLERES_PLEINES": "Visor",
}

PMU_DISCIPLINE_MAP: dict[str, str] = {
    "PLAT": "Flat",
    "GALOP": "Flat",
    "HAIES": "Hurdle",
    "STEEPLE_CHASE": "Chase",
    "STEEPLECHASE": "Chase",
    "CROSS_COUNTRY": "Chase",
    "OBSTACLE": "Jumps",
}


def _strip_html(raw: str) -> str:
    txt = html.unescape(raw or "")
    txt = re.sub(r"<[^>]+>", " ", txt)
    return re.sub(r"\s+", " ", txt).strip()


def _is_uk_bst(dt_utc: datetime) -> bool:
    year = dt_utc.year
    mar31 = datetime(year, 3, 31, 1, 0, tzinfo=timezone.utc)
    bst_start = mar31 - timedelta(days=(mar31.weekday() + 1) % 7)
    oct31 = datetime(year, 10, 31, 1, 0, tzinfo=timezone.utc)
    bst_end = oct31 - timedelta(days=(oct31.weekday() + 1) % 7)
    return bst_start <= dt_utc < bst_end


def _uk_now() -> datetime:
    dt_utc = datetime.now(timezone.utc)
    return dt_utc + (timedelta(hours=1) if _is_uk_bst(dt_utc) else timedelta(0))


def _epoch_ms_to_utc_and_uk(ms_val: Any, fallback_date: str) -> tuple[str, str, str]:
    """Convert Unix epoch ms into (uk_date_YYYY-MM-DD, uk_hhmm, utc_iso)."""
    try:
        ts_sec = float(ms_val) / 1000.0
        dt_utc = datetime.fromtimestamp(ts_sec, tz=timezone.utc)
        offset = timedelta(hours=1) if _is_uk_bst(dt_utc) else timedelta(0)
        dt_uk = dt_utc + offset
        return (
            dt_uk.strftime("%Y-%m-%d"),
            dt_uk.strftime("%H:%M"),
            dt_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
        )
    except (TypeError, ValueError, OSError):
        return fallback_date, "12:00", ""


def _iso_utc_to_uk(iso_str: Any, fallback_date: str) -> tuple[str, str, str]:
    """Convert ISO-8601 UTC timestamp string ('2026-11-25T12:16:00Z') into (uk_date, uk_hhmm, utc_iso)."""
    raw = str(iso_str or "").strip()
    if not raw:
        return fallback_date, "12:00", ""
    try:
        dt_utc = datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)
        offset = timedelta(hours=1) if _is_uk_bst(dt_utc) else timedelta(0)
        dt_uk = dt_utc + offset
        return (
            dt_uk.strftime("%Y-%m-%d"),
            dt_uk.strftime("%H:%M"),
            dt_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
        )
    except ValueError:
        return fallback_date, "12:00", ""


def normalize_course_slug(name: str) -> str:
    """Return canonical lowercase alphanumeric slug for deduplicating racecourses."""
    cleaned = str(name or "").strip().lower()
    cleaned = re.sub(r"\([^)]*\)", " ", cleaned)
    cleaned = re.sub(
        r"\b(australie|japon|hong kong|etats-unis|usa|uk|ireland|france|allemagne|italie)\b",
        " ",
        cleaned,
    )
    return re.sub(r"[^a-z0-9]+", "", cleaned)


def _format_display_name(raw: str, is_course: bool = False) -> str:
    """Clean ALL-CAPS racing strings into readable title-case without mangling apostrophes or initials."""
    s = re.sub(r"\s+", " ", str(raw or "").strip())
    if not s:
        return ""
    if is_course:
        s = re.sub(
            r"\s+(AUSTRALIE|JAPON|HONG KONG|ETATS-UNIS)\s*$",
            "",
            s,
            flags=re.IGNORECASE,
        ).strip()
        s = re.sub(r"\s*\((HONG KONG|AW|UK|IRE)\)\s*$", r" (\1)", s, flags=re.IGNORECASE)
    s = re.sub(r"\.(?=[A-Za-z])", ". ", s)
    if s == s.upper() or s == s.lower():
        words = s.split(" ")
        formatted = []
        for idx, w in enumerate(words):
            if w in ("(AW)", "(UK)", "(IRE)", "(FR)", "(USA)", "(HK)", "(S)", "II", "III", "IV"):
                formatted.append(w.upper())
            elif len(w) <= 2 and w.endswith("."):
                formatted.append(w.upper())
            elif idx > 0 and w.lower() in ("of", "the", "and", "du", "de", "la", "des", "le", "les", "et", "in", "on", "at"):
                formatted.append(w.lower())
            else:
                parts = re.split(r"([-'])", w.lower())
                out_w = ""
                for p_idx, part in enumerate(parts):
                    if part in ("-", "'"):
                        out_w += part
                    elif p_idx >= 2 and parts[p_idx - 1] == "'" and part == "s":
                        out_w += "s"
                    elif part:
                        out_w += part[0].upper() + part[1:]
                formatted.append(out_w)
        s = " ".join(formatted)
    return re.sub(r"\s+", " ", s).strip()


def meters_to_uk_distance(meters: Any) -> str:
    """Convert race distance in meters to standard UK furlongs/miles string (e.g. 6f, 1m 2f, 2m 4½f)."""
    try:
        m = int(round(float(meters)))
    except (TypeError, ValueError):
        return ""
    if m <= 0:
        return ""
    total_furlongs = m / 201.168
    miles = int(total_furlongs // 8)
    rem_f = total_furlongs - miles * 8
    half_steps = round(rem_f * 2.0) / 2.0
    if half_steps >= 8.0:
        miles += 1
        half_steps -= 8.0

    whole_f = int(half_steps)
    has_half = abs(half_steps - whole_f - 0.5) < 0.01
    f_str = ""
    if whole_f > 0 and has_half:
        f_str = f"{whole_f}½f"
    elif whole_f > 0:
        f_str = f"{whole_f}f"
    elif has_half:
        f_str = "½f"

    if miles > 0 and f_str:
        return f"{miles}m {f_str}"
    if miles > 0:
        return f"{miles}m"
    return f_str or f"{m}m"


def lbs_to_stone_display(lbs: Any) -> str:
    """Convert weight in pounds (e.g. 134) into UK racing display ('9st 8lb')."""
    try:
        val = int(round(float(lbs)))
    except (TypeError, ValueError):
        return ""
    if val <= 0:
        return ""
    return f"{val // 14}st {val % 14}lb"


def parse_weight_to_lbs(weight_val: Any, lbs_val: Any = None) -> tuple[int | None, str]:
    """Parse stone-lbs ('9-2', '9st 2lb') or integer pounds into (weight_lbs, weight_display)."""
    if lbs_val is not None:
        try:
            lbs_int = int(round(float(lbs_val)))
            if 70 <= lbs_int <= 210:
                return lbs_int, lbs_to_stone_display(lbs_int)
        except (TypeError, ValueError):
            pass
    raw = str(weight_val or "").strip()
    if not raw:
        return None, ""
    m = re.match(r"^(\d{1,2})\s*(?:-|st\s*)(\d{1,2})\s*(?:lb)?$", raw, re.IGNORECASE)
    if m:
        lbs_int = int(m.group(1)) * 14 + int(m.group(2))
        return lbs_int, lbs_to_stone_display(lbs_int)
    try:
        val = int(round(float(raw)))
        if 70 <= val <= 210:
            return val, lbs_to_stone_display(val)
    except ValueError:
        pass
    return None, raw


def map_country_to_region(code: Any) -> str:
    """Normalize country code into AccaLab region code (GB, IRE, FR, US, AU, INTL)."""
    c = str(code or "").strip().upper()
    return COUNTRY_REGION_MAP.get(c, "INTL")


def translate_pmu_going(raw: Any) -> str:
    """Translate PMU or Entain track condition label into readable UK terminology."""
    s = str(raw or "").strip().upper()
    if not s:
        return ""
    if s in PMU_GOING_MAP:
        return PMU_GOING_MAP[s]
    s_clean = s.replace("-", "_").replace("  ", " ")
    if s_clean in PMU_GOING_MAP:
        return PMU_GOING_MAP[s_clean]
    if "SYNTH" in s or "PSF" in s or "POLY" in s or "TAPETA" in s:
        return "Standard (AW)"
    if "SOUPLE" in s or "SOFT" in s:
        return "Soft" if ("TRES" in s or "6" in s or "7" in s) else "Good to Soft"
    if "LOURD" in s or "HEAVY" in s:
        return "Heavy"
    if "FIRM" in s or "LEGER" in s:
        return "Good to Firm"
    if "BON" in s or "GOOD" in s:
        return "Good"
    return _format_display_name(raw)


def translate_pmu_discipline(raw: Any) -> str:
    """Map PMU discipline code into Flat / Hurdle / Chase / Jumps."""
    s = str(raw or "").strip().upper()
    return PMU_DISCIPLINE_MAP.get(s, _format_display_name(s) or "Flat")


def translate_pmu_headgear(raw: Any) -> str:
    """Map PMU oeilleres code to UK headgear label."""
    s = str(raw or "").strip().upper()
    if s in PMU_HEADGEAR_MAP:
        return PMU_HEADGEAR_MAP[s]
    if "BLINKER" in s or "AUSTRALIEN" in s:
        return "Cheekpieces" if "AUSTRALIEN" in s else "Blinkers"
    if "BONNET" in s:
        return "Hood"
    if "VISOR" in s:
        return "Visor"
    return ""


def _infer_uk_race_type(desc: str, distance_m: int) -> str:
    low = desc.lower()
    if "hurdle" in low:
        return "Hurdle"
    if "steeplechase" in low or "chase" in low or "cross country" in low or "hunters'" in low:
        return "Chase"
    if "nh flat" in low or "bumper" in low or "national hunt flat" in low:
        return "NH Flat"
    if distance_m >= 3200 and ("novices'" in low or "maiden hurdle" in low or "mares'" in low):
        return "Hurdle"
    return "Flat"


def _safe_int(val: Any) -> int | None:
    if val is None or val == "":
        return None
    try:
        return int(float(str(val).strip()))
    except (TypeError, ValueError):
        return None


def _safe_float(val: Any) -> float | None:
    if val is None or val == "":
        return None
    try:
        f = float(str(val).strip())
        return f if f > 1.01 else None
    except (TypeError, ValueError):
        return None


def _hhmm_to_minutes(hhmm: str) -> int | None:
    m = re.match(r"^(\d{1,2}):(\d{2})$", str(hhmm or "").strip())
    if not m:
        return None
    return int(m.group(1)) * 60 + int(m.group(2))


def _is_trot_race(course_obj: dict[str, Any]) -> bool:
    disc = str(course_obj.get("discipline") or "").strip().upper()
    spec = str(course_obj.get("specialite") or "").strip().upper()
    return (
        disc in {"ATTELE", "MONTE", "TROT_ATTELE", "TROT_MONTE", "TROT"}
        or disc.startswith("TROT")
        or spec in {"ATTELE", "MONTE", "TROT"}
        or spec.startswith("TROT")
    )


def _upsert_race_and_runners(
    conn: sqlite3.Connection,
    race_payload: dict[str, Any],
    runners_payload: list[dict[str, Any]],
) -> tuple[int, int]:
    """Upsert a race row and its runner rows, preserving user_manual odds."""
    now = race_payload["updated_at"]
    conn.execute(
        """
        INSERT INTO racing_races (
            race_key, source, external_id, region_code, country_name, course,
            race_date, off_time, off_timestamp_utc, race_name, race_type, race_class,
            is_handicap, distance_text, distance_meters, going, surface, prize_text,
            runners_count, places_paid, place_fraction, status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(race_key) DO UPDATE SET
            source = excluded.source,
            external_id = excluded.external_id,
            region_code = excluded.region_code,
            country_name = excluded.country_name,
            course = excluded.course,
            race_date = excluded.race_date,
            off_time = excluded.off_time,
            off_timestamp_utc = COALESCE(NULLIF(excluded.off_timestamp_utc, ''), racing_races.off_timestamp_utc),
            race_name = excluded.race_name,
            race_type = excluded.race_type,
            race_class = COALESCE(NULLIF(excluded.race_class, ''), racing_races.race_class),
            is_handicap = excluded.is_handicap,
            distance_text = COALESCE(NULLIF(excluded.distance_text, ''), racing_races.distance_text),
            distance_meters = CASE WHEN excluded.distance_meters > 0 THEN excluded.distance_meters ELSE racing_races.distance_meters END,
            going = COALESCE(NULLIF(excluded.going, ''), racing_races.going),
            surface = COALESCE(NULLIF(excluded.surface, ''), racing_races.surface),
            prize_text = COALESCE(NULLIF(excluded.prize_text, ''), racing_races.prize_text),
            runners_count = excluded.runners_count,
            status = excluded.status,
            updated_at = excluded.updated_at
        """,
        (
            race_payload["race_key"],
            race_payload["source"],
            race_payload.get("external_id", ""),
            race_payload["region_code"],
            race_payload.get("country_name", ""),
            race_payload["course"],
            race_payload["race_date"],
            race_payload["off_time"],
            race_payload.get("off_timestamp_utc", ""),
            race_payload["race_name"],
            race_payload.get("race_type", "Flat"),
            race_payload.get("race_class", ""),
            int(bool(race_payload.get("is_handicap"))),
            race_payload.get("distance_text", ""),
            int(race_payload.get("distance_meters") or 0),
            race_payload.get("going", ""),
            race_payload.get("surface", ""),
            race_payload.get("prize_text", ""),
            int(race_payload.get("runners_count") or len(runners_payload)),
            int(race_payload.get("places_paid") or 3),
            float(race_payload.get("place_fraction") or 0.2),
            race_payload.get("status", "scheduled"),
            now,
        ),
    )
    race_id = int(
        conn.execute("SELECT id FROM racing_races WHERE race_key = ?", (race_payload["race_key"],)).fetchone()["id"]
    )

    upserted_runners = 0
    for r in runners_payload:
        mkt_odds = r.get("market_odds")
        odds_src = r.get("odds_source") or ("live_fixed" if mkt_odds else "model_tissue")
        conn.execute(
            """
            INSERT INTO racing_runners (
                race_id, runner_key, saddle_cloth, draw, horse_name, age, sex,
                weight_lbs, weight_display, official_rating, jockey, trainer, owner,
                form_string, form_direction, days_since_run, headgear,
                career_runs, career_wins, career_places, career_earnings,
                silk_url, is_debutant, non_runner, finish_pos,
                market_odds, odds_source, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(race_id, runner_key) DO UPDATE SET
                saddle_cloth = excluded.saddle_cloth,
                draw = COALESCE(excluded.draw, racing_runners.draw),
                horse_name = excluded.horse_name,
                age = COALESCE(excluded.age, racing_runners.age),
                sex = COALESCE(NULLIF(excluded.sex, ''), racing_runners.sex),
                weight_lbs = COALESCE(excluded.weight_lbs, racing_runners.weight_lbs),
                weight_display = COALESCE(NULLIF(excluded.weight_display, ''), racing_runners.weight_display),
                official_rating = COALESCE(excluded.official_rating, racing_runners.official_rating),
                jockey = COALESCE(NULLIF(excluded.jockey, ''), racing_runners.jockey),
                trainer = COALESCE(NULLIF(excluded.trainer, ''), racing_runners.trainer),
                owner = COALESCE(NULLIF(excluded.owner, ''), racing_runners.owner),
                form_string = COALESCE(NULLIF(excluded.form_string, ''), racing_runners.form_string),
                form_direction = excluded.form_direction,
                days_since_run = COALESCE(excluded.days_since_run, racing_runners.days_since_run),
                headgear = excluded.headgear,
                career_runs = CASE WHEN excluded.career_runs > 0 THEN excluded.career_runs ELSE racing_runners.career_runs END,
                career_wins = CASE WHEN excluded.career_wins > 0 THEN excluded.career_wins ELSE racing_runners.career_wins END,
                career_places = CASE WHEN excluded.career_places > 0 THEN excluded.career_places ELSE racing_runners.career_places END,
                career_earnings = CASE WHEN excluded.career_earnings > 0 THEN excluded.career_earnings ELSE racing_runners.career_earnings END,
                silk_url = COALESCE(NULLIF(excluded.silk_url, ''), racing_runners.silk_url),
                is_debutant = excluded.is_debutant,
                non_runner = excluded.non_runner,
                finish_pos = COALESCE(excluded.finish_pos, racing_runners.finish_pos),
                market_odds = CASE
                    WHEN racing_runners.odds_source = 'user_manual' THEN racing_runners.market_odds
                    WHEN excluded.market_odds IS NOT NULL AND excluded.market_odds > 1.01 THEN excluded.market_odds
                    WHEN racing_runners.odds_source = 'model_tissue' THEN NULL
                    ELSE racing_runners.market_odds
                END,
                odds_source = CASE
                    WHEN racing_runners.odds_source = 'user_manual' THEN 'user_manual'
                    WHEN excluded.market_odds IS NOT NULL AND excluded.market_odds > 1.01 THEN excluded.odds_source
                    WHEN racing_runners.odds_source = 'model_tissue' THEN 'model_tissue'
                    ELSE racing_runners.odds_source
                END,
                updated_at = excluded.updated_at
            """,
            (
                race_id,
                r["runner_key"],
                int(r.get("saddle_cloth") or 0),
                r.get("draw"),
                r["horse_name"],
                r.get("age"),
                r.get("sex", ""),
                r.get("weight_lbs"),
                r.get("weight_display", ""),
                r.get("official_rating"),
                r.get("jockey", ""),
                r.get("trainer", ""),
                r.get("owner", ""),
                r.get("form_string", ""),
                r.get("form_direction", "rtl"),
                r.get("days_since_run"),
                r.get("headgear", ""),
                int(r.get("career_runs") or 0),
                int(r.get("career_wins") or 0),
                int(r.get("career_places") or 0),
                float(r.get("career_earnings") or 0.0),
                r.get("silk_url", ""),
                int(bool(r.get("is_debutant"))),
                int(bool(r.get("non_runner"))),
                r.get("finish_pos"),
                mkt_odds,
                odds_src,
                now,
            ),
        )
        upserted_runners += 1

    return 1, upserted_runners


def _find_existing_race_match(
    conn: sqlite3.Connection,
    race_date: str,
    course_slug: str,
    off_time: str,
) -> sqlite3.Row | None:
    """Find an already-ingested race at the same course & date within +/-10 minutes (preferring Entain)."""
    if not course_slug or not race_date:
        return None
    target_mins = _hhmm_to_minutes(off_time)
    rows = conn.execute(
        """
        SELECT id, course, off_time, source
        FROM racing_races
        WHERE race_date = ?
        ORDER BY CASE WHEN source = 'entain_public' THEN 0 ELSE 1 END, id ASC
        """,
        (race_date,),
    ).fetchall()
    for row in rows:
        if normalize_course_slug(row["course"]) != course_slug:
            continue
        row_mins = _hhmm_to_minutes(row["off_time"])
        if target_mins is not None and row_mins is not None:
            if abs(target_mins - row_mins) <= 10:
                return row
        elif row["off_time"] == off_time:
            return row
    return None


def _enrich_existing_race_from_pmu(
    conn: sqlite3.Connection,
    existing_race_id: int,
    participants: list[dict[str, Any]],
) -> int:
    """Enrich Entain UK/IRE/FR runners with PMU OR ratings, career runs/wins/places, and fallback tote odds."""
    rows = conn.execute(
        "SELECT id, horse_name, saddle_cloth, official_rating, career_runs, odds_source FROM racing_runners WHERE race_id = ?",
        (existing_race_id,),
    ).fetchall()
    if not rows:
        return 0
    by_name = {re.sub(r"[^a-z0-9]", "", r["horse_name"].lower()): r for r in rows}
    by_cloth = {int(r["saddle_cloth"]): r for r in rows if int(r["saddle_cloth"] or 0) > 0}

    updated = 0
    for p in participants:
        nm_key = re.sub(r"[^a-z0-9]", "", str(p.get("nom") or "").lower())
        cloth = _safe_int(p.get("numPmu"))
        match = by_name.get(nm_key) or (by_cloth.get(cloth) if cloth else None)
        if not match:
            continue

        val_h = p.get("handicapValeur")
        or_int = match["official_rating"]
        if or_int is None and val_h is not None:
            try:
                vf = float(val_h)
                if vf > 0:
                    or_int = int(round(vf * 2.20462))
            except (TypeError, ValueError):
                pass

        c_runs = int(_safe_int(p.get("nombreCourses")) or match["career_runs"] or 0)
        c_wins = int(_safe_int(p.get("nombreVictoires")) or 0)
        c_plcs = int(_safe_int(p.get("nombrePlaces")) or 0)

        dir_rap = (p.get("dernierRapportDirect") or {}).get("rapport")
        ref_rap = (p.get("dernierRapportReference") or {}).get("rapport")
        pmu_odds = _safe_float(dir_rap) or _safe_float(ref_rap)

        if match["odds_source"] == "model_tissue" and pmu_odds:
            conn.execute(
                """
                UPDATE racing_runners SET
                    official_rating = COALESCE(?, official_rating),
                    career_runs = CASE WHEN ? > 0 THEN ? ELSE career_runs END,
                    career_wins = CASE WHEN ? > 0 THEN ? ELSE career_wins END,
                    career_places = CASE WHEN ? > 0 THEN ? ELSE career_places END,
                    market_odds = ?, odds_source = 'pmu_tote'
                WHERE id = ?
                """,
                (or_int, c_runs, c_runs, c_wins, c_wins, c_plcs, c_plcs, round(pmu_odds, 2), match["id"]),
            )
        else:
            conn.execute(
                """
                UPDATE racing_runners SET
                    official_rating = COALESCE(?, official_rating),
                    career_runs = CASE WHEN ? > 0 THEN ? ELSE career_runs END,
                    career_wins = CASE WHEN ? > 0 THEN ? ELSE career_wins END,
                    career_places = CASE WHEN ? > 0 THEN ? ELSE career_places END
                WHERE id = ?
                """,
                (or_int, c_runs, c_runs, c_wins, c_wins, c_plcs, c_plcs, match["id"]),
            )
        updated += 1
    return updated


def ingest_entain_public_cards(
    conn: sqlite3.Connection,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    """Fetch ALL daily UK & IRE plus top FR/US/AU/INTL thoroughbred cards & live fixed odds via TAB/Entain JSON."""
    now_uk = _uk_now()
    today_uk = now_uk.date().isoformat()
    target_days = tuple((now_uk.date() + timedelta(days=i)).isoformat() for i in range(3))
    d_from = (now_uk.date() - timedelta(days=1)).isoformat()
    d_to = (now_uk.date() + timedelta(days=3)).isoformat()

    own_client = client is None
    if own_client:
        client = httpx.Client(headers=ENTAIN_HEADERS, follow_redirects=True, timeout=14.0)

    errors: list[str] = []
    meetings_raw: list[dict[str, Any]] = []
    try:
        resp = client.get(
            "https://api.tab.co.nz/affiliates/v1/racing/meetings",
            params={"date_from": d_from, "date_to": d_to},
            headers=ENTAIN_HEADERS,
            timeout=15.0,
        )
        if resp.status_code != 200:
            errors.append(f"TAB/Entain meetings: HTTP {resp.status_code}")
            return {"meetings_processed": 0, "races_upserted": 0, "runners_upserted": 0, "errors": errors}
        meetings_raw = ((resp.json() or {}).get("data") or {}).get("meetings") or []
    except Exception as exc:
        errors.append(f"TAB/Entain meetings: {exc}")
        return {"meetings_processed": 0, "races_upserted": 0, "runners_upserted": 0, "errors": errors}
    finally:
        if own_client:
            client.close()

    # Group eligible thoroughbred races by UK local (race_date, course_slug, region_code)
    grouped: dict[tuple[str, str, str], dict[str, Any]] = {}
    for m in meetings_raw:
        if str(m.get("category") or "").upper() != "T":
            continue
        raw_country = str(m.get("country") or "").strip().upper()
        if raw_country not in ENTAIN_ALLOWED_COUNTRIES:
            continue
        reg_code = map_country_to_region(raw_country)
        course_name = _format_display_name(str(m.get("name") or ""), is_course=True)
        course_slug = normalize_course_slug(course_name)
        if not course_slug:
            continue
        for r_sum in m.get("races") or []:
            ev_id = str(r_sum.get("id") or "").strip()
            if not ev_id:
                continue
            r_date, off_time, off_utc = _iso_utc_to_uk(r_sum.get("start_time"), today_uk)
            if r_date not in target_days:
                continue
            g_key = (r_date, course_slug, reg_code)
            bucket = grouped.setdefault(
                g_key,
                {
                    "race_date": r_date,
                    "course_slug": course_slug,
                    "course_name": course_name,
                    "region_code": reg_code,
                    "country_name": COUNTRY_DISPLAY_NAMES.get(raw_country) or RACING_REGIONS.get(reg_code, {}).get("name", "International"),
                    "races": {},
                },
            )
            bucket["races"][ev_id] = {
                "event_id": ev_id,
                "race_date": r_date,
                "off_time": off_time,
                "off_utc": off_utc,
                "summary": r_sum,
            }

    # Select ALL UK & Ireland meetings + bounded major international meetings per day
    intl_limits = {"FR": 2, "US": 2, "AU": 2, "INTL": 1}
    selected_meetings: list[dict[str, Any]] = []
    for day_key in target_days:
        day_buckets = [b for b in grouped.values() if b["race_date"] == day_key]
        day_buckets.sort(key=lambda b: len(b["races"]), reverse=True)
        counts_by_reg: dict[str, int] = {}
        for b in day_buckets:
            rc = b["region_code"]
            if rc in ("GB", "IRE"):
                selected_meetings.append(b)
            else:
                lim = intl_limits.get(rc, 1)
                if counts_by_reg.get(rc, 0) < lim:
                    selected_meetings.append(b)
                    counts_by_reg[rc] = counts_by_reg.get(rc, 0) + 1

    # Fetch event details in parallel (max 4 workers) and keep SQLite writes strictly on the main thread
    tasks: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for mt in selected_meetings:
        for race_entry in mt["races"].values():
            tasks.append((mt, race_entry))

    def _fetch_event(ev_id: str) -> tuple[str, dict[str, Any] | None, str | None]:
        with httpx.Client(headers=ENTAIN_HEADERS, follow_redirects=True, timeout=12.0) as local_cl:
            try:
                r = local_cl.get(f"https://api.tab.co.nz/affiliates/v1/racing/events/{ev_id}")
                if r.status_code != 200:
                    return ev_id, None, f"HTTP {r.status_code}"
                return ev_id, (r.json() or {}).get("data") or {}, None
            except Exception as exc:
                return ev_id, None, str(exc)

    event_payloads: dict[str, dict[str, Any]] = {}
    if tasks:
        with ThreadPoolExecutor(max_workers=4) as pool:
            futs = [pool.submit(_fetch_event, r_entry["event_id"]) for _, r_entry in tasks]
            for fut in as_completed(futs):
                ev_id, data_obj, err = fut.result()
                if err:
                    errors.append(f"TAB event {ev_id[:8]}: {err}")
                elif data_obj:
                    event_payloads[ev_id] = data_obj

    now = utc_now_iso()
    races_saved = 0
    runners_saved = 0

    for mt, r_entry in tasks:
        ev_id = r_entry["event_id"]
        data = event_payloads.get(ev_id)
        if not data:
            continue
        race_info = data.get("race") or {}
        runners_raw = data.get("runners") or []
        if not runners_raw:
            continue

        r_sum = r_entry["summary"]
        dist_m = _safe_int(race_info.get("distance") or r_sum.get("distance")) or 0
        dist_text = meters_to_uk_distance(dist_m)
        raw_desc = str(race_info.get("description") or race_info.get("name") or r_sum.get("name") or "").strip()
        race_name = raw_desc or f"{mt['course_name']} {r_entry['off_time']}"
        race_type = _infer_uk_race_type(race_name, dist_m)
        low_nm = race_name.lower()
        is_handicap = 1 if ("handicap" in low_nm or " hcp" in low_nm or "h'cap" in low_nm) else 0

        raw_cond = str(race_info.get("track_condition") or r_sum.get("track_condition") or "").strip()
        going = translate_pmu_going(raw_cond)
        cond_up = raw_cond.upper()
        surface = "All Weather" if any(tok in cond_up for tok in ("SYNTH", "POLY", "TAPETA", "PSF", "FIBRE")) else "Turf"

        prizes = race_info.get("prize_monies") or {}
        tot_prize = _safe_int(prizes.get("total_value"))
        prize_text = f"£{tot_prize:,}" if tot_prize and tot_prize > 0 else ""

        status_raw = str(race_info.get("status") or r_sum.get("status") or "").strip().lower()
        race_status = "result" if status_raw == "final" else "scheduled"

        runner_rows: list[dict[str, Any]] = []
        active_count = 0
        for idx_r, rn in enumerate(runners_raw, start=1):
            horse = _format_display_name(str(rn.get("name") or ""))
            if not horse:
                continue
            cloth = _safe_int(rn.get("runner_number")) or idx_r
            is_nr = 1 if rn.get("is_scratched") else 0
            if not is_nr:
                active_count += 1

            barrier = _safe_int(rn.get("barrier"))
            draw = barrier if barrier and barrier > 0 else None

            w_obj = rn.get("weight") or {}
            w_kg = None
            for w_k in ("allocated", "total"):
                try:
                    if w_obj.get(w_k):
                        w_kg = float(w_obj[w_k])
                        if w_kg > 0:
                            break
                except (TypeError, ValueError):
                    pass
            w_lbs = int(round(w_kg * 2.20462)) if w_kg and 30.0 <= w_kg <= 95.0 else None
            w_disp = lbs_to_stone_display(w_lbs) if w_lbs else ""

            odds_obj = rn.get("odds") or {}
            live_win = _safe_float(odds_obj.get("fixed_win"))
            form_str = str(rn.get("last_twenty_starts") or rn.get("last_six_starts") or "").strip()
            is_deb = 1 if not form_str else 0
            silk = str(rn.get("silk_url_64x64") or rn.get("alt_silk_url_64x64") or "").strip()

            try:
                earn = float(rn.get("prize_money") or 0.0)
            except (TypeError, ValueError):
                earn = 0.0

            r_key = str(rn.get("entrant_id") or rn.get("competitor_id") or f"{cloth}:{re.sub(r'[^a-z0-9]', '', horse.lower())}")
            runner_rows.append(
                {
                    "runner_key": r_key,
                    "saddle_cloth": cloth,
                    "draw": draw,
                    "horse_name": horse,
                    "age": _safe_int(rn.get("age")),
                    "sex": str(rn.get("sex") or "").strip()[:6],
                    "weight_lbs": w_lbs,
                    "weight_display": w_disp,
                    "official_rating": _safe_int(rn.get("handicap_rating")),
                    "jockey": _format_display_name(str(rn.get("jockey") or "")),
                    "trainer": _format_display_name(str(rn.get("trainer_name") or "")),
                    "owner": str(rn.get("owners") or "").strip()[:120],
                    "form_string": form_str,
                    "form_direction": "rtl",
                    "days_since_run": None,
                    "headgear": str(rn.get("gear") or "").strip(),
                    "career_runs": 0,
                    "career_wins": 0,
                    "career_places": 0,
                    "career_earnings": earn,
                    "silk_url": silk,
                    "is_debutant": is_deb,
                    "non_runner": is_nr,
                    "finish_pos": None,
                    "market_odds": round(live_win, 2) if live_win else None,
                    "odds_source": "live_fixed" if live_win else "model_tissue",
                }
            )

        if not runner_rows:
            continue
        race_num = _safe_int(race_info.get("race_number") or r_sum.get("race_number")) or 1
        race_key = f"ent:{r_entry['race_date']}:{mt['course_slug']}:{r_entry['off_time']}:r{race_num}"
        race_payload = {
            "race_key": race_key,
            "source": "entain_public",
            "external_id": ev_id,
            "region_code": mt["region_code"],
            "country_name": mt["country_name"],
            "course": mt["course_name"],
            "race_date": r_entry["race_date"],
            "off_time": r_entry["off_time"],
            "off_timestamp_utc": r_entry["off_utc"],
            "race_name": race_name,
            "race_type": race_type,
            "race_class": str(race_info.get("class_name") or race_info.get("group") or "").strip(),
            "is_handicap": is_handicap,
            "distance_text": dist_text,
            "distance_meters": dist_m,
            "going": going,
            "surface": surface,
            "prize_text": prize_text,
            "runners_count": active_count or len(runner_rows),
            "status": race_status,
            "updated_at": now,
        }
        rc_inc, rn_inc = _upsert_race_and_runners(conn, race_payload, runner_rows)
        races_saved += rc_inc
        runners_saved += rn_inc

    conn.execute(
        "INSERT INTO api_usage_log (provider, endpoint, status_code, called_at) VALUES (?, ?, ?, ?)",
        ("entain_public", f"/affiliates/v1/racing ({len(selected_meetings)}m)", 200, utc_now_iso()),
    )
    return {
        "meetings_processed": len(selected_meetings),
        "races_upserted": races_saved,
        "runners_upserted": runners_saved,
        "errors": errors,
    }


def ingest_pmu_public_cards(
    conn: sqlite3.Connection,
    client: httpx.Client | None = None,
    days_offsets: tuple[int, ...] = (0, 1, 2),
    max_meetings_per_day: int = 6,
) -> dict[str, Any]:
    """Fetch PMU public thoroughbred racecards to enrich Entain UK/FR cards (OR/career stats) & add extra cards."""
    own_client = client is None
    if own_client:
        client = httpx.Client(headers=HEADERS, follow_redirects=True, timeout=12.0)

    region_priority = {"GB": 0, "IRE": 1, "FR": 2, "US": 3, "AU": 4, "INTL": 5}
    races_saved = 0
    runners_saved = 0
    enriched_runners = 0
    meetings_processed = 0
    errors: list[str] = []
    now = utc_now_iso()
    today_d = _uk_now().date()

    try:
        for delta in days_offsets:
            dt = today_d + timedelta(days=delta)
            ddmmyyyy = dt.strftime("%d%m%Y")
            iso_date = dt.isoformat()
            prog_url = f"https://offline.turfinfo.api.pmu.fr/rest/client/61/programme/{ddmmyyyy}"
            try:
                resp = client.get(prog_url, timeout=12.0)
                if resp.status_code != 200:
                    errors.append(f"PMU {iso_date}: HTTP {resp.status_code}")
                    continue
                data = resp.json() if resp.text else {}
            except Exception as exc:
                errors.append(f"PMU {iso_date}: {exc}")
                continue

            reunions = (data.get("programme") or {}).get("reunions") or []
            pmu_allowed = {"GBR", "GB", "IRL", "IRE", "FRA", "FR", "USA", "US", "AUS", "AU", "HKG"}
            entain_courses_for_date = {
                normalize_course_slug(r["course"])
                for r in conn.execute(
                    "SELECT DISTINCT course FROM racing_races WHERE source = 'entain_public' AND race_date = ?",
                    (iso_date,),
                ).fetchall()
            }
            filtered_reunions: list[tuple[int, str, dict[str, Any], list[dict[str, Any]]]] = []
            for reu in reunions:
                tb_courses = [c for c in (reu.get("courses") or []) if not _is_trot_race(c)]
                if not tb_courses:
                    continue
                pays_code = ((reu.get("pays") or {}).get("code") or "").upper()
                if pays_code not in pmu_allowed:
                    continue
                reg_code = map_country_to_region(pays_code)
                prio = region_priority.get(reg_code, 9)
                filtered_reunions.append((prio, pays_code, reu, tb_courses))

            filtered_reunions.sort(key=lambda x: (x[0], -len(x[3])))
            for _, pays_code, reu, tb_courses in filtered_reunions[:max_meetings_per_day]:
                meetings_processed += 1
                num_reunion = reu.get("numOfficiel")
                hippo = reu.get("hippodrome") or {}
                raw_course = hippo.get("libelleCourt") or hippo.get("libelleLong") or f"Meeting {num_reunion}"
                course_name = _format_display_name(raw_course, is_course=True)
                course_slug = normalize_course_slug(course_name)
                reg_code = map_country_to_region(pays_code)
                country_name = (
                    COUNTRY_DISPLAY_NAMES.get(pays_code)
                    or RACING_REGIONS.get(reg_code, {}).get("name")
                    or pays_code
                    or "International"
                )

                for c_obj in tb_courses:
                    num_ordre = c_obj.get("numOrdre")
                    race_date, off_time, off_utc = _epoch_ms_to_utc_and_uk(c_obj.get("heureDepart"), iso_date)
                    p_url = f"https://offline.turfinfo.api.pmu.fr/rest/client/61/programme/{ddmmyyyy}/R{num_reunion}/C{num_ordre}/participants"
                    try:
                        time.sleep(0.05)
                        pr = client.get(p_url, timeout=10.0)
                        if pr.status_code != 200:
                            continue
                        participants = (pr.json() or {}).get("participants") or []
                    except Exception as exc:
                        errors.append(f"PMU R{num_reunion}C{num_ordre}: {exc}")
                        continue

                    if not participants:
                        continue

                    existing = _find_existing_race_match(conn, race_date, course_slug, off_time)
                    if existing and existing["source"] == "entain_public":
                        enriched_runners += _enrich_existing_race_from_pmu(conn, int(existing["id"]), participants)
                        continue
                    if course_slug in entain_courses_for_date:
                        continue

                    disc = translate_pmu_discipline(c_obj.get("discipline") or c_obj.get("specialite") or "PLAT")
                    race_name = _format_display_name(str(c_obj.get("libelle") or c_obj.get("libelleCourt") or f"{course_name} {off_time}"))
                    cat_part = str(c_obj.get("categorieParticularite") or "").upper()
                    is_handicap = 1 if ("HANDICAP" in cat_part or "HANDICAP" in race_name.upper()) else 0

                    dist_m = _safe_int(c_obj.get("distance")) or 0
                    dist_text = meters_to_uk_distance(dist_m)
                    pen_raw = (c_obj.get("penetrometre") or {}).get("intitule") or c_obj.get("terrain") or ""
                    going = translate_pmu_going(pen_raw)
                    type_piste = str(c_obj.get("typePiste") or "").upper()
                    if "PSF" in str(pen_raw).upper() or "POLY" in str(pen_raw).upper() or "ALL" in going.upper():
                        surface = "All Weather"
                    elif type_piste == "SABLE" or "FIBRE" in type_piste:
                        surface = "All Weather"
                    else:
                        surface = "Turf"

                    prize_val = _safe_int(c_obj.get("montantPrix"))
                    prize_text = f"£{round(prize_val * 0.85):,}" if prize_val and prize_val > 0 else ""

                    raw_statut = str(c_obj.get("statut") or "").upper()
                    race_status = "result" if raw_statut.startswith("ARRIVEE") else "scheduled"

                    runner_rows: list[dict[str, Any]] = []
                    active_count = 0
                    for idx_p, p in enumerate(participants, start=1):
                        horse_name = _format_display_name(str(p.get("nom") or ""))
                        if not horse_name:
                            continue
                        cloth = _safe_int(p.get("numPmu")) or idx_p
                        is_nr = 1 if str(p.get("statut") or "").upper() == "NON_PARTANT" else 0
                        if not is_nr:
                            active_count += 1

                        poids_h = p.get("handicapPoids")
                        w_lbs = None
                        w_disp = ""
                        if poids_h is not None:
                            try:
                                kg = float(poids_h) / 10.0
                                if 30.0 <= kg <= 90.0:
                                    w_lbs = int(round(kg * 2.20462))
                                    w_disp = lbs_to_stone_display(w_lbs)
                            except (TypeError, ValueError):
                                pass

                        val_h = p.get("handicapValeur")
                        or_int = None
                        if val_h is not None:
                            try:
                                vf = float(val_h)
                                if vf > 0:
                                    or_int = int(round(vf * 2.20462))
                            except (TypeError, ValueError):
                                pass

                        dir_rap = (p.get("dernierRapportDirect") or {}).get("rapport")
                        ref_rap = (p.get("dernierRapportReference") or {}).get("rapport")
                        live_odds = _safe_float(dir_rap) or _safe_float(ref_rap)

                        gains_obj = p.get("gainsParticipant") or {}
                        earnings_eur = float(gains_obj.get("gainsCarriere") or 0.0) / 100.0
                        form_str = str(p.get("musique") or "").strip()
                        c_runs = _safe_int(p.get("nombreCourses")) or 0
                        is_deb = 1 if (bool(p.get("indicateurInedit")) or (c_runs == 0 and not form_str)) else 0
                        fin_pos = _safe_int(p.get("ordreArrivee"))
                        if fin_pos is not None and fin_pos <= 0:
                            fin_pos = None

                        r_id_pmu = p.get("idCheval")
                        r_key = str(r_id_pmu) if r_id_pmu else f"{cloth}:{re.sub(r'[^a-z0-9]', '', horse_name.lower())}"
                        sex_raw = str(p.get("sexe") or "").strip().upper()
                        sex_map = {"HONGRES": "G", "HONGRE": "G", "MALES": "C", "MALE": "C", "FEMELLES": "F", "FEMELLE": "F"}

                        runner_rows.append(
                            {
                                "runner_key": r_key,
                                "saddle_cloth": cloth,
                                "draw": _safe_int(p.get("placeCorde")),
                                "horse_name": horse_name,
                                "age": _safe_int(p.get("age")),
                                "sex": sex_map.get(sex_raw, sex_raw[:6]),
                                "weight_lbs": w_lbs,
                                "weight_display": w_disp,
                                "official_rating": or_int,
                                "jockey": _format_display_name(str(p.get("driver") or "")),
                                "trainer": _format_display_name(str(p.get("entraineur") or "")),
                                "owner": _format_display_name(str(p.get("proprietaire") or "")),
                                "form_string": form_str,
                                "form_direction": "ltr",
                                "days_since_run": None,
                                "headgear": translate_pmu_headgear(p.get("oeilleres")),
                                "career_runs": c_runs,
                                "career_wins": _safe_int(p.get("nombreVictoires")) or 0,
                                "career_places": _safe_int(p.get("nombrePlaces")) or 0,
                                "career_earnings": round(earnings_eur, 2),
                                "silk_url": str(p.get("urlCasaque") or "").strip(),
                                "is_debutant": is_deb,
                                "non_runner": is_nr,
                                "finish_pos": fin_pos,
                                "market_odds": round(live_odds, 2) if live_odds else None,
                                "odds_source": "pmu_tote" if live_odds else "model_tissue",
                            }
                        )

                    if not runner_rows:
                        continue
                    race_key = f"pmu:{race_date}:{course_slug}:{off_time}:c{num_ordre}"
                    race_payload = {
                        "race_key": race_key,
                        "source": "pmu_public",
                        "external_id": f"{ddmmyyyy}-R{num_reunion}-C{num_ordre}",
                        "region_code": reg_code,
                        "country_name": country_name,
                        "course": course_name,
                        "race_date": race_date,
                        "off_time": off_time,
                        "off_timestamp_utc": off_utc,
                        "race_name": race_name,
                        "race_type": disc,
                        "race_class": _format_display_name(cat_part.replace("_", " ")),
                        "is_handicap": is_handicap,
                        "distance_text": dist_text,
                        "distance_meters": dist_m,
                        "going": going,
                        "surface": surface,
                        "prize_text": prize_text,
                        "runners_count": active_count or len(runner_rows),
                        "status": race_status,
                        "updated_at": now,
                    }
                    rc_inc, rn_inc = _upsert_race_and_runners(conn, race_payload, runner_rows)
                    races_saved += rc_inc
                    runners_saved += rn_inc

        conn.execute(
            "INSERT INTO api_usage_log (provider, endpoint, status_code, called_at) VALUES (?, ?, ?, ?)",
            ("pmu_public", f"/programme/3d ({meetings_processed}m)", 200, utc_now_iso()),
        )
    finally:
        if own_client:
            client.close()

    return {
        "meetings_processed": meetings_processed,
        "races_upserted": races_saved,
        "runners_upserted": runners_saved,
        "enriched_runners": enriched_runners,
        "errors": errors,
    }


def ingest_racing_news(
    conn: sqlite3.Connection,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    """Fetch latest horse racing headlines from BBC Sport RSS using stdlib ElementTree."""
    own_client = client is None
    if own_client:
        client = httpx.Client(headers=HEADERS, follow_redirects=True, timeout=12.0)

    now = utc_now_iso()
    saved = 0
    errors: list[str] = []

    try:
        for source_name, url in RACING_NEWS_FEEDS:
            try:
                resp = client.get(url, timeout=12.0)
                if resp.status_code != 200:
                    errors.append(f"{source_name}: HTTP {resp.status_code}")
                    continue
                root = ET.fromstring(resp.text)
                for item in root.findall(".//item")[:40]:
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

                    conn.execute(
                        """
                        INSERT INTO racing_news (title, summary, url, source, published_at, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT(url) DO UPDATE SET
                            title = excluded.title,
                            summary = excluded.summary
                        """,
                        (title, summary[:450], link, source_name, pub_iso, now),
                    )
                    saved += 1
            except Exception as exc:
                errors.append(f"{source_name}: {exc}")
    finally:
        if own_client:
            client.close()

    return {"news_upserted": saved, "errors": errors}


def ingest_racing_data(
    conn: sqlite3.Connection,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    """Run card-free racing ingestion: TAB/Entain Public JSON -> PMU Enrichment -> BBC Racing RSS -> safe prune."""
    own_client = client is None
    if own_client:
        client = httpx.Client(headers=HEADERS, follow_redirects=True, timeout=15.0)

    try:
        conn.execute("DELETE FROM racing_races WHERE source = 'the_racing_api'")
        entain_res = ingest_entain_public_cards(conn, client=client)
        if entain_res.get("races_upserted", 0) > 0:
            entain_pairs = {
                (r["race_date"], normalize_course_slug(r["course"]))
                for r in conn.execute("SELECT race_date, course FROM racing_races WHERE source = 'entain_public'").fetchall()
            }
            for pmu_r in conn.execute(
                "SELECT id, race_date, course, country_name FROM racing_races WHERE source = 'pmu_public'"
            ).fetchall():
                if (pmu_r["race_date"], normalize_course_slug(pmu_r["course"])) in entain_pairs or pmu_r["country_name"] in (
                    "Chile", "Argentina", "Uruguay", "Brazil", "Morocco", "Switzerland", "Sweden"
                ):
                    conn.execute("DELETE FROM racing_races WHERE id = ?", (pmu_r["id"],))
        pmu_res = ingest_pmu_public_cards(conn, client=client)
        news_res = ingest_racing_news(conn, client=client)

        today_uk = _uk_now().date()
        today_iso = today_uk.isoformat()
        yesterday_iso = (today_uk - timedelta(days=1)).isoformat()
        fresh_cnt = conn.execute(
            "SELECT COUNT(*) AS c FROM racing_races WHERE race_date >= ?",
            (today_iso,),
        ).fetchone()["c"]
        pruned = 0
        if int(fresh_cnt or 0) > 0:
            cur = conn.execute("DELETE FROM racing_races WHERE race_date < ?", (yesterday_iso,))
            pruned = cur.rowcount

        return {
            "entain_public": entain_res,
            "pmu_public": pmu_res,
            "racing_news": news_res,
            "pruned_old_races": pruned,
        }
    finally:
        if own_client:
            client.close()
