"""Configuration, league metadata, and canonical team-name normalization for AccaLab."""

from __future__ import annotations

import os
import re
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "accalab.db"

load_dotenv(BASE_DIR / ".env")

API_FOOTBALL_KEY = os.getenv("API_FOOTBALL_KEY", "").strip()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_DEFAULT_CHAT_ID = os.getenv("TELEGRAM_DEFAULT_CHAT_ID", "").strip()
ACCALAB_INVITE_CODE = os.getenv("ACCALAB_INVITE_CODE", "ACCALAB2026").strip()
SECRET_KEY = os.getenv("SECRET_KEY", "accalab-local-dev-key").strip()
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://xnvwpwygwhfgvcadlnaf.supabase.co").strip()
SUPABASE_ANON_KEY = os.getenv(
    "SUPABASE_ANON_KEY", "sb_publishable_mWiD-10wVSFNVhK1tqODKQ_eR_3I1EF"
).strip()

SEASONS = ("2425", "2526", "2627")
CURRENT_SEASON = "2627"

LEAGUES = {
    "E0": {
        "code": "E0",
        "name": "Premier League",
        "short": "EPL",
        "tier": 1,
        "init_elo": 1650.0,
        "fixturedownload_slug": "epl-2026",
        "api_football_id": 39,
    },
    "E1": {
        "code": "E1",
        "name": "Championship",
        "short": "CH",
        "tier": 2,
        "init_elo": 1500.0,
        "fixturedownload_slug": "championship-2026",
        "api_football_id": 40,
    },
    "E2": {
        "code": "E2",
        "name": "League One",
        "short": "L1",
        "tier": 3,
        "init_elo": 1380.0,
        "fixturedownload_slug": "efl-league-one-2026",
        "api_football_id": 41,
    },
    "E3": {
        "code": "E3",
        "name": "League Two",
        "short": "L2",
        "tier": 4,
        "init_elo": 1280.0,
        "fixturedownload_slug": "efl-league-two-2026",
        "api_football_id": 42,
    },
}

NEWS_FEEDS = [
    ("BBC Sport", "https://feeds.bbci.co.uk/sport/football/rss.xml"),
    ("Sky Sports", "https://www.skysports.com/rss/12040"),
    ("The Guardian", "https://www.theguardian.com/football/rss"),
]

# Maps external feed / news names -> football-data.co.uk canonical team names
TEAM_ALIASES: dict[str, str] = {
    # Premier League (E0)
    "man utd": "Man United",
    "manchester utd": "Man United",
    "manchester united": "Man United",
    "man city": "Man City",
    "manchester city": "Man City",
    "spurs": "Tottenham",
    "tottenham hotspur": "Tottenham",
    "nottingham forest": "Nott'm Forest",
    "nottm forest": "Nott'm Forest",
    "newcastle united": "Newcastle",
    "leeds united": "Leeds",
    "brighton & hove albion": "Brighton",
    "brighton and hove albion": "Brighton",
    "afc bournemouth": "Bournemouth",
    "aston villa": "Aston Villa",
    "crystal palace": "Crystal Palace",
    "coventry city": "Coventry",
    "ipswich town": "Ipswich",
    "sunderland afc": "Sunderland",
    # Championship (E1)
    "birmingham city": "Birmingham",
    "blackburn rovers": "Blackburn",
    "bolton wanderers": "Bolton",
    "cardiff city": "Cardiff",
    "charlton athletic": "Charlton",
    "derby county": "Derby",
    "lincoln city": "Lincoln",
    "norwich city": "Norwich",
    "preston north end": "Preston",
    "queens park rangers": "QPR",
    "stoke city": "Stoke",
    "swansea city": "Swansea",
    "west bromwich albion": "West Brom",
    "west ham united": "West Ham",
    "wolverhampton wanderers": "Wolves",
    "wolverhampton": "Wolves",
    "hull city": "Hull",
    "sheffield united": "Sheffield United",
    "sheffield utd": "Sheffield United",
    "middlesbrough": "Middlesbrough",
    "portsmouth": "Portsmouth",
    "southampton": "Southampton",
    "bristol city": "Bristol City",
    "millwall": "Millwall",
    "watford": "Watford",
    "wrexham": "Wrexham",
    # League One (E2)
    "bradford city": "Bradford",
    "burton albion": "Burton",
    "cambridge united": "Cambridge",
    "doncaster rovers": "Doncaster",
    "huddersfield town": "Huddersfield",
    "leicester city": "Leicester",
    "luton town": "Luton",
    "mansfield town": "Mansfield",
    "mk dons": "Milton Keynes Dons",
    "oxford united": "Oxford",
    "peterborough united": "Peterboro",
    "peterborough": "Peterboro",
    "plymouth argyle": "Plymouth",
    "sheffield wednesday": "Sheffield Weds",
    "sheffield weds": "Sheffield Weds",
    "stockport county": "Stockport",
    "wigan athletic": "Wigan",
    "wycombe wanderers": "Wycombe",
    "barnsley": "Barnsley",
    "blackpool": "Blackpool",
    "leyton orient": "Leyton Orient",
    "notts county": "Notts County",
    "port vale": "Port Vale",
    "reading": "Reading",
    "stevenage": "Stevenage",
    # League Two (E3)
    "accrington stanley": "Accrington",
    "bristol rovers": "Bristol Rvs",
    "cheltenham town": "Cheltenham",
    "colchester united": "Colchester",
    "crewe alexandra": "Crewe",
    "exeter city": "Exeter",
    "grimsby town": "Grimsby",
    "northampton town": "Northampton",
    "oldham athletic": "Oldham",
    "rotherham united": "Rotherham",
    "salford city": "Salford",
    "shrewsbury town": "Shrewsbury",
    "swindon town": "Swindon",
    "tranmere rovers": "Tranmere",
    "york city": "York",
    "afc wimbledon": "AFC Wimbledon",
    "barrow": "Barrow",
    "barnet": "Barnet",
    "bromley": "Bromley",
    "chesterfield": "Chesterfield",
    "crawley town": "Crawley Town",
    "fleetwood town": "Fleetwood Town",
    "gillingham": "Gillingham",
    "harrogate town": "Harrogate",
    "newport county": "Newport County",
    "rochdale": "Rochdale",
    "walsall": "Walsall",
    "carlisle united": "Carlisle",
    "morecambe": "Morecambe",
    "forest green rovers": "Forest Green",
}

MARKET_LABELS = {
    "1X2_H": "Home Win",
    "1X2_D": "Draw",
    "1X2_A": "Away Win",
    "OU_O15": "Over 1.5 Goals",
    "OU_U15": "Under 1.5 Goals",
    "OU_O25": "Over 2.5 Goals",
    "OU_U25": "Under 2.5 Goals",
    "OU_O35": "Over 3.5 Goals",
    "OU_U35": "Under 3.5 Goals",
    "BTTS_Y": "BTTS Yes",
    "BTTS_N": "BTTS No",
}

MARKET_BET_TYPES: dict[str, dict[str, str]] = {
    "1X2_H": {"key": "to_win", "label": "To Win"},
    "1X2_A": {"key": "to_win", "label": "To Win"},
    "1X2_D": {"key": "draw", "label": "Draw"},
    "BTTS_Y": {"key": "btts", "label": "BTTS"},
    "BTTS_N": {"key": "btts", "label": "BTTS"},
    "OU_O15": {"key": "goals", "label": "Goals"},
    "OU_U15": {"key": "goals", "label": "Goals"},
    "OU_O25": {"key": "goals", "label": "Goals"},
    "OU_U25": {"key": "goals", "label": "Goals"},
    "OU_O35": {"key": "goals", "label": "Goals"},
    "OU_U35": {"key": "goals", "label": "Goals"},
}

ALL_MARKET_CODES: frozenset[str] = frozenset(MARKET_LABELS.keys())

BET_TYPE_FILTER_GROUPS: dict[str, frozenset[str]] = {
    "ALL": ALL_MARKET_CODES,
    "TO_WIN": frozenset({"1X2_H", "1X2_A"}),
    "DRAW": frozenset({"1X2_D"}),
    "1X2": frozenset({"1X2_H", "1X2_D", "1X2_A"}),
    "BTTS": frozenset({"BTTS_Y", "BTTS_N"}),
    "BTTS_Y": frozenset({"BTTS_Y"}),
    "BTTS_N": frozenset({"BTTS_N"}),
    "GOALS": frozenset({"OU_O15", "OU_U15", "OU_O25", "OU_U25", "OU_O35", "OU_U35"}),
}


def market_bet_type(market_code: str) -> dict[str, str]:
    """Return canonical bet-type metadata ({key, label}) for a market code."""
    code = str(market_code or "").strip()
    if code in MARKET_BET_TYPES:
        return dict(MARKET_BET_TYPES[code])
    if code.startswith("COMBO_"):
        return {"key": "combo", "label": "Bet Builder"}
    return {"key": "other", "label": code or "Other"}


def expand_bet_type_filters(filters: list[str] | str | None) -> set[str]:
    """Expand high-level bet-type group keys or single market codes into exact market codes."""
    if not filters:
        return set(ALL_MARKET_CODES)
    raw = [filters] if isinstance(filters, str) else list(filters)
    cleaned = [str(f).strip() for f in raw if str(f).strip()]
    if not cleaned or "ALL" in [c.upper() for c in cleaned]:
        return set(ALL_MARKET_CODES)
    out: set[str] = set()
    for token in cleaned:
        upper = token.upper()
        if upper in BET_TYPE_FILTER_GROUPS:
            out.update(BET_TYPE_FILTER_GROUPS[upper])
        elif upper in MARKET_LABELS:
            out.add(upper)
    return out or set(ALL_MARKET_CODES)


def normalize_team_name(name: str) -> str:
    """Normalize an external club name to football-data.co.uk canonical naming."""
    cleaned = re.sub(r"\s+", " ", (name or "").strip())
    key = cleaned.lower()
    if key in TEAM_ALIASES:
        return TEAM_ALIASES[key]
    return cleaned
