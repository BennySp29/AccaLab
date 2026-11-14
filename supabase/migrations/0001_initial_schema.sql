-- AccaLab Supabase / PostgreSQL Schema & Row-Level Security Policies
-- Mirrors local SQLite tables for cloud deployment with Supabase Auth + GitHub Actions jobs.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    avatar_color TEXT NOT NULL DEFAULT '#10b981',
    bankroll NUMERIC(10, 2) NOT NULL DEFAULT 250.00,
    kelly_fraction NUMERIC(4, 2) NOT NULL DEFAULT 0.25,
    min_edge_pct NUMERIC(5, 2) NOT NULL DEFAULT 4.00,
    telegram_chat_id TEXT DEFAULT '',
    monthly_stake_limit NUMERIC(10, 2) NOT NULL DEFAULT 200.00,
    show_on_leaderboard BOOLEAN NOT NULL DEFAULT TRUE,
    favourite_teams_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    preferred_leagues_json JSONB NOT NULL DEFAULT '["E0","E1","E2","E3"]'::jsonb,
    default_stake NUMERIC(10, 2) NOT NULL DEFAULT 10.00,
    active_slip_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.historical_matches (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    season TEXT NOT NULL,
    div TEXT NOT NULL,
    match_date DATE NOT NULL,
    kickoff_time TEXT DEFAULT '',
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    fthg SMALLINT,
    ftag SMALLINT,
    ftr CHAR(1),
    hthg SMALLINT,
    htag SMALLINT,
    hs SMALLINT,
    as_shots SMALLINT,
    hst SMALLINT,
    ast SMALLINT,
    hc SMALLINT,
    ac SMALLINT,
    hy SMALLINT,
    ay SMALLINT,
    hr SMALLINT,
    ar SMALLINT,
    referee TEXT DEFAULT '',
    b365h NUMERIC(6, 3),
    b365d NUMERIC(6, 3),
    b365a NUMERIC(6, 3),
    b365_over25 NUMERIC(6, 3),
    b365_under25 NUMERIC(6, 3),
    b365ch NUMERIC(6, 3),
    b365cd NUMERIC(6, 3),
    b365ca NUMERIC(6, 3),
    b365c_over25 NUMERIC(6, 3),
    b365c_under25 NUMERIC(6, 3),
    avg_h NUMERIC(6, 3),
    avg_d NUMERIC(6, 3),
    avg_a NUMERIC(6, 3),
    UNIQUE (season, div, match_date, home_team, away_team)
);

CREATE TABLE IF NOT EXISTS public.upcoming_fixtures (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    div TEXT NOT NULL,
    round_number INTEGER,
    match_date DATE NOT NULL,
    kickoff_time TEXT DEFAULT '',
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    venue TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'scheduled',
    b365h NUMERIC(6, 3),
    b365d NUMERIC(6, 3),
    b365a NUMERIC(6, 3),
    b365_over25 NUMERIC(6, 3),
    b365_under25 NUMERIC(6, 3),
    b365_btts_yes NUMERIC(6, 3),
    b365_btts_no NUMERIC(6, 3),
    b365_open_h NUMERIC(6, 3),
    b365_open_d NUMERIC(6, 3),
    b365_open_a NUMERIC(6, 3),
    odds_source TEXT NOT NULL DEFAULT 'market_estimate',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (div, match_date, home_team, away_team)
);

CREATE TABLE IF NOT EXISTS public.team_ratings (
    team_name TEXT PRIMARY KEY,
    div TEXT NOT NULL,
    elo NUMERIC(8, 2) NOT NULL DEFAULT 1500.00,
    elo_change_last5 NUMERIC(6, 2) NOT NULL DEFAULT 0.00,
    dc_attack NUMERIC(8, 5) NOT NULL DEFAULT 0.0,
    dc_defence NUMERIC(8, 5) NOT NULL DEFAULT 0.0,
    matches_played INTEGER NOT NULL DEFAULT 0,
    points INTEGER NOT NULL DEFAULT 0,
    gf INTEGER NOT NULL DEFAULT 0,
    ga INTEGER NOT NULL DEFAULT 0,
    shots_for_pg NUMERIC(5, 2) NOT NULL DEFAULT 0.0,
    shots_against_pg NUMERIC(5, 2) NOT NULL DEFAULT 0.0,
    sot_for_pg NUMERIC(5, 2) NOT NULL DEFAULT 0.0,
    sot_against_pg NUMERIC(5, 2) NOT NULL DEFAULT 0.0,
    form_last6 TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.predictions (
    fixture_id BIGINT PRIMARY KEY REFERENCES public.upcoming_fixtures(id) ON DELETE CASCADE,
    lambda_home NUMERIC(7, 4) NOT NULL,
    mu_away NUMERIC(7, 4) NOT NULL,
    rho NUMERIC(6, 4) NOT NULL,
    prob_home NUMERIC(6, 4) NOT NULL,
    prob_draw NUMERIC(6, 4) NOT NULL,
    prob_away NUMERIC(6, 4) NOT NULL,
    prob_over25 NUMERIC(6, 4) NOT NULL,
    prob_under25 NUMERIC(6, 4) NOT NULL,
    prob_btts_yes NUMERIC(6, 4) NOT NULL,
    prob_btts_no NUMERIC(6, 4) NOT NULL,
    top_scorelines_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    tipster_consensus_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    ai_summary TEXT NOT NULL DEFAULT '',
    ai_summary_source TEXT NOT NULL DEFAULT 'analyst_engine',
    model_version TEXT NOT NULL DEFAULT 'dc-elo-v1',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.news_items (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    published_at TIMESTAMPTZ NOT NULL,
    matched_teams_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.bets (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    bet_type TEXT NOT NULL DEFAULT 'single',
    stake NUMERIC(10, 2) NOT NULL,
    combined_odds NUMERIC(10, 3) NOT NULL,
    combined_model_prob NUMERIC(7, 5) NOT NULL,
    expected_value_pct NUMERIC(7, 2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    pnl NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    clv_pct NUMERIC(7, 2),
    notes TEXT NOT NULL DEFAULT '',
    placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.bet_legs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    bet_id BIGINT NOT NULL REFERENCES public.bets(id) ON DELETE CASCADE,
    fixture_id BIGINT REFERENCES public.upcoming_fixtures(id) ON DELETE SET NULL,
    div TEXT NOT NULL,
    match_date DATE NOT NULL,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    market TEXT NOT NULL,
    selection_label TEXT NOT NULL,
    odds_taken NUMERIC(8, 3) NOT NULL,
    closing_odds NUMERIC(8, 3),
    model_prob NUMERIC(7, 5) NOT NULL,
    leg_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS public.alerts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
    alert_type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    fixture_id BIGINT REFERENCES public.upcoming_fixtures(id) ON DELETE SET NULL,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    sent_telegram BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.backtest_results (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    div TEXT NOT NULL,
    market TEXT NOT NULL,
    matches_tested INTEGER NOT NULL,
    brier_score NUMERIC(7, 5) NOT NULL,
    log_loss NUMERIC(7, 5) NOT NULL,
    value_bets_count INTEGER NOT NULL,
    win_rate_pct NUMERIC(6, 2) NOT NULL,
    flat_roi_pct NUMERIC(7, 2) NOT NULL,
    kelly_roi_pct NUMERIC(7, 2) NOT NULL,
    avg_clv_pct NUMERIC(7, 2) NOT NULL,
    calibration_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (div, market)
);

CREATE TABLE IF NOT EXISTS public.saved_fixtures (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    fixture_id BIGINT NOT NULL REFERENCES public.upcoming_fixtures(id) ON DELETE CASCADE,
    note TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, fixture_id)
);

CREATE TABLE IF NOT EXISTS public.saved_accas (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    stake NUMERIC(10, 2) NOT NULL DEFAULT 10.00,
    legs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    combined_odds NUMERIC(10, 3) NOT NULL,
    combined_prob NUMERIC(7, 5) NOT NULL,
    ev_pct NUMERIC(7, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable Row-Level Security (RLS)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bet_legs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_fixtures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_accas ENABLE ROW LEVEL SECURITY;

-- Profiles: users can edit their own profile; read opt-in leaderboard profiles
CREATE POLICY "profiles_read_own_or_leaderboard" ON public.profiles
    FOR SELECT USING (auth.uid() = id OR show_on_leaderboard = TRUE);

CREATE POLICY "profiles_update_own" ON public.profiles
    FOR UPDATE USING (auth.uid() = id);

-- Bets: users only see and manage their own bets
CREATE POLICY "bets_own_all" ON public.bets
    FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "bet_legs_own_all" ON public.bet_legs
    FOR ALL USING (
        EXISTS (SELECT 1 FROM public.bets b WHERE b.id = bet_legs.bet_id AND b.user_id = auth.uid())
    );

-- Alerts: users only see their own or broadcast alerts
CREATE POLICY "alerts_own_read_update" ON public.alerts
    FOR SELECT USING (user_id IS NULL OR auth.uid() = user_id);

-- Watchlist & Saved Accas: private per user
CREATE POLICY "saved_fixtures_own_all" ON public.saved_fixtures
    FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "saved_accas_own_all" ON public.saved_accas
    FOR ALL USING (auth.uid() = user_id);
