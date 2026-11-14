// AccaLab Frontend PWA Application

const state = {
  activeTab: 'fixtures',
  activeDiv: 'ALL',
  search: '',
  activeUserId: Number(localStorage.getItem('accalab_user_id') || 0),
  authenticated: false,
  dashboard: null,
  favouriteTeams: [],
  preferredLeagues: ['E0', 'E1', 'E2', 'E3'],
  watchedIds: [],
  valMyPrefsOnly: false,
  newsMyClubsOnly: false,
  slip: JSON.parse(localStorage.getItem('accalab_slip') || '[]'),
  slipStake: Number(localStorage.getItem('accalab_slip_stake') || 10),
  activeRiskLevel: localStorage.getItem('accalab_risk_level') || 'high',
  charts: {},
};

const esc = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const fmtPct = (v) => `${Number(v || 0).toFixed(1)}%`;
const fmtGbp = (v) => `£${Number(v || 0).toFixed(2)}`;

const UK_FRACTIONAL_TABLE = [
  [1, 10], [1, 9], [1, 8], [1, 7], [1, 6], [1, 5], [2, 9], [1, 4], [2, 7], [3, 10],
  [1, 3], [4, 11], [2, 5], [4, 9], [1, 2], [8, 15], [4, 7], [8, 13], [4, 6], [8, 11],
  [4, 5], [5, 6], [10, 11], [1, 1], [11, 10], [6, 5], [5, 4], [13, 10], [11, 8],
  [7, 5], [6, 4], [8, 5], [13, 8], [7, 4], [9, 5], [15, 8], [2, 1], [9, 4], [5, 2],
  [11, 4], [3, 1], [10, 3], [7, 2], [4, 1], [9, 2], [5, 1], [11, 2], [6, 1], [13, 2],
  [7, 1], [15, 2], [8, 1], [9, 1], [10, 1],
];

function fmtOdds(dec) {
  const val = Number(dec);
  if (!Number.isFinite(val) || val <= 1.01) return '—';
  if (val > 11.0) return `${Math.max(10, Math.round(val - 1.0))}/1`;
  let best = UK_FRACTIONAL_TABLE[0];
  let bestDiff = Infinity;
  for (const frac of UK_FRACTIONAL_TABLE) {
    const diff = Math.abs(1.0 + frac[0] / frac[1] - val);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = frac;
    }
  }
  return `${best[0]}/${best[1]}`;
}

function parseOddsInput(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (s === 'evs' || s === 'evens' || s === 'evn') return 2.0;
  if (s.includes('/')) {
    const [a, b] = s.split('/', 2);
    const num = Number(a.trim());
    const den = Number(b.trim());
    if (Number.isFinite(num) && Number.isFinite(den) && num > 0 && den > 0) {
      const dec = 1.0 + num / den;
      return dec > 1.01 ? Math.round(dec * 10000) / 10000 : null;
    }
    return null;
  }
  const f = Number(s);
  return Number.isFinite(f) && f > 1.01 ? Math.round(f * 10000) / 10000 : null;
}

function showToast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `fixed bottom-20 lg:bottom-6 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-xl text-white text-sm font-medium shadow-xl z-50 ${isError ? 'bg-rose-600' : 'bg-emerald-600'
    }`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3400);
}

const GH_STATE_KEY = 'accalab_gh_state_v2';
let _staticSnapshot = null;

const cloneJson = (v) => JSON.parse(JSON.stringify(v));
const roundNum = (val, dec = 2) => {
  const f = 10 ** dec;
  return Math.round((Number(val) || 0) * f) / f;
};

function kellyStakeClient(modelProb, odds, bankroll, kellyFraction = 0.25, maxPct = 0.05) {
  if (!odds || odds <= 1.01 || !modelProb || modelProb <= 0) {
    return { kelly_pct: 0.0, suggested_stake: 0.0 };
  }
  const edge = modelProb * odds - 1.0;
  if (edge <= 0) {
    return { kelly_pct: 0.0, suggested_stake: 0.0 };
  }
  const fullKelly = edge / (odds - 1.0);
  const fracPct = Math.min(maxPct, Math.max(0.0, kellyFraction * fullKelly));
  return {
    kelly_pct: roundNum(fracPct * 100.0, 2),
    suggested_stake: roundNum((Number(bankroll) || 250) * fracPct, 2),
  };
}

function devigThreeWayClient(o1, o2, o3) {
  const inv = [1.0 / o1, 1.0 / o2, 1.0 / o3];
  const total = inv[0] + inv[1] + inv[2];
  return [inv[0] / total, inv[1] / total, inv[2] / total, (total - 1.0) * 100.0];
}

function devigTwoWayClient(o1, o2) {
  const inv1 = 1.0 / o1;
  const inv2 = 1.0 / o2;
  const total = inv1 + inv2;
  return [inv1 / total, inv2 / total, (total - 1.0) * 100.0];
}

function evaluateAccaClient(legs = [], stake = 10.0) {
  const cleanStake = Number.isFinite(Number(stake)) && Number(stake) > 0 ? Number(stake) : 10.0;
  if (!legs || !legs.length) {
    return {
      legs: [],
      leg_count: 0,
      stake: roundNum(cleanStake, 2),
      combined_odds: 1.0,
      combined_odds_fractional: fmtOdds(1.0),
      naive_prob_pct: 100.0,
      combined_model_prob: 1.0,
      combined_model_prob_pct: 100.0,
      fair_combined_odds: 1.0,
      expected_value_gbp: 0.0,
      expected_value_pct: 0.0,
      potential_return: 0.0,
      expected_profit: 0.0,
      compounded_margin_pct: 0.0,
      implied_prob_pct: 100.0,
      warnings: [],
    };
  }
  let combOdds = 1.0;
  let combProb = 1.0;
  const byFixture = {};
  const warnings = [];
  for (const leg of legs) {
    const o = Number(leg.odds || 1.0);
    let p = Number(leg.model_prob || 0.5);
    if (p > 1.0) p /= 100.0;
    combOdds *= o;
    combProb *= p;
    if (leg.fixture_id !== undefined && leg.fixture_id !== null) {
      if (!byFixture[leg.fixture_id]) byFixture[leg.fixture_id] = [];
      byFixture[leg.fixture_id].push(leg.market || '');
    }
  }
  for (const [fid, mkts] of Object.entries(byFixture)) {
    if (mkts.length > 1) {
      warnings.push(
        `Same-match correlation detected on fixture #${fid} (${mkts.join(', ')}): independent multiplication overstates joint probability.`
      );
    }
  }
  if (legs.length >= 5) {
    const marg = ((1.052 ** legs.length) - 1.0) * 100.0;
    warnings.push(
      `${legs.length}-fold accumulator compounds bookmaker margin (~${marg.toFixed(1)}% house edge). Consider 2–4 legs for steadier ROI.`
    );
  }
  const evPct = (combProb * combOdds - 1.0) * 100.0;
  const impliedProd = 1.0 / Math.max(combOdds, 1.01);
  const compoundedMarginPct = ((1.052 ** legs.length) - 1.0) * 100.0;
  const naiveProbPct = roundNum(combProb * 100.0, 2);
  const expectedProfit = roundNum(cleanStake * (combProb * combOdds - 1.0), 2);
  return {
    legs,
    leg_count: legs.length,
    stake: roundNum(cleanStake, 2),
    combined_odds: roundNum(combOdds, 2),
    combined_odds_fractional: fmtOdds(combOdds),
    naive_prob_pct: naiveProbPct,
    combined_model_prob: roundNum(combProb, 5),
    combined_model_prob_pct: naiveProbPct,
    fair_combined_odds: roundNum(1.0 / Math.max(combProb, 0.0001), 2),
    expected_value_gbp: expectedProfit,
    expected_value_pct: roundNum(evPct, 2),
    potential_return: roundNum(cleanStake * combOdds, 2),
    expected_profit: expectedProfit,
    compounded_margin_pct: roundNum(compoundedMarginPct, 1),
    implied_prob_pct: roundNum(impliedProd * 100.0, 2),
    warnings,
  };
}

const B365_TEAM_SEARCH_NAMES = {
  "Nott'm Forest": 'Nottingham Forest',
  'Sheffield Weds': 'Sheffield Wednesday',
  Peterboro: 'Peterborough',
  'Bristol Rvs': 'Bristol Rovers',
  'Milton Keynes Dons': 'MK Dons',
  'West Brom': 'West Bromwich Albion',
  'Sheffield United': 'Sheff Utd',
};

function b365SearchTeam(name) {
  const cleaned = String(name || '').trim();
  return B365_TEAM_SEARCH_NAMES[cleaned] || cleaned;
}

function isFixtureUpcomingClient(fix, nowDate = new Date()) {
  if (!fix) return true;
  const iso = nowDate.toISOString();
  const todayIso = iso.slice(0, 10);
  const nowHhmm = iso.slice(11, 16);
  const mdate = String(fix.match_date || '').trim();
  if (!mdate) return true;
  if (mdate > todayIso) return true;
  if (mdate < todayIso) return false;
  const ko = String(fix.kickoff_time || '').trim();
  if (!ko) return true;
  return ko > nowHhmm;
}

function encodeSlipTokenClient(payload) {
  const raw = JSON.stringify(payload);
  try {
    if (typeof TextEncoder !== 'undefined' && typeof btoa === 'function') {
      const bytes = new TextEncoder().encode(raw);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
  } catch (_) { }
  try {
    if (typeof btoa === 'function') {
      return btoa(unescape(encodeURIComponent(raw))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
  } catch (_) { }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(raw, 'utf8').toString('base64url');
  }
  return '';
}

function openInBet365Tab(url) {
  const win = window.open(url, 'accalab_bet365_tab');
  try {
    if (win && win.focus) win.focus();
  } catch (_) { }
  return win;
}

const B365_MARKET_NAMES = {
  '1X2_H': 'Full Time Result',
  '1X2_D': 'Full Time Result',
  '1X2_A': 'Full Time Result',
  OU_O25: 'Goals Over/Under',
  OU_U25: 'Goals Over/Under',
  BTTS_Y: 'Both Teams to Score',
  BTTS_N: 'Both Teams to Score',
};

function b365SelectionNameClient(leg) {
  const mkt = String(leg.market || '');
  if (mkt === '1X2_H') return String(leg.home_team || leg.selection_label || 'Home');
  if (mkt === '1X2_D') return 'Draw';
  if (mkt === '1X2_A') return String(leg.away_team || leg.selection_label || 'Away');
  if (mkt === 'OU_O25') return 'Over 2.5';
  if (mkt === 'OU_U25') return 'Under 2.5';
  if (mkt === 'BTTS_Y') return 'Yes';
  if (mkt === 'BTTS_N') return 'No';
  return String(leg.selection_label || mkt);
}

function buildBet365ExportClient(legs = [], stake = 10.0, title = 'AccaLab Suggested Bet', optionsOverride = '', leaguesMeta = {}) {
  const parsedStake = Number(stake);
  const cleanStake = Number.isFinite(parsedStake) && parsedStake >= 0.5 ? parsedStake : 10.0;
  const evalSummary = evaluateAccaClient(legs, cleanStake);
  const combFrac = fmtOdds(evalSummary.combined_odds);
  evalSummary.combined_odds_fractional = combFrac;
  const exportedLegs = [];
  const legOptionTokens = [];
  const compactLegs = [];

  for (const leg of legs) {
    const div = String(leg.div || '');
    const leagueName = leaguesMeta[div]?.name || leg.league_name || div || 'English Football';
    const home = String(leg.home_team || '').trim();
    const away = String(leg.away_team || '').trim();
    const b365Home = b365SearchTeam(home);
    const b365Away = b365SearchTeam(away);
    const mkt = String(leg.market || '1X2_H');
    const b365Market = B365_MARKET_NAMES[mkt] || 'Full Time Result';
    const b365Selection = b365SelectionNameClient(leg);
    const oddsVal = roundNum(Number(leg.odds || 1.0), 2);
    const oddsFrac = fmtOdds(oddsVal);
    const searchTerm = b365Home && b365Away ? `${b365Home} v ${b365Away}` : b365Home || b365Away || 'Football';
    const searchHash = `#/AX/K^${encodeURIComponent(searchTerm)}`;

    const optTok = String(leg.b365_options_id || '').trim();
    if (optTok) legOptionTokens.push(optTok);

    compactLegs.push({
      h: b365Home,
      a: b365Away,
      k: searchTerm,
      l: String(leg.selection_label || b365Selection),
      m: b365Market,
      s: b365Selection,
      o: oddsFrac,
      lg: leagueName,
    });

    exportedLegs.push({
      fixture_id: leg.fixture_id,
      div,
      league_name: leagueName,
      match_date: leg.match_date || '',
      kickoff_time: leg.kickoff_time || '',
      home_team: home,
      away_team: away,
      market: mkt,
      selection_label: leg.selection_label || b365Selection,
      odds: oddsVal,
      odds_fractional: oddsFrac,
      b365_market_name: b365Market,
      b365_selection_name: b365Selection,
      b365_search_query: searchTerm,
      b365_search_hash: searchHash,
      b365_path: `Soccer → United Kingdom → ${leagueName} → ${home} v ${away} → ${b365Market}`,
      b365_search_url: `https://www.bet365.com/${searchHash}`,
    });
  }

  const slipToken = encodeSlipTokenClient({
    t: title,
    st: roundNum(cleanStake, 2),
    od: combFrac,
    legs: compactLegs,
  });
  for (const item of exportedLegs) {
    item.b365_search_url = `https://www.bet365.com/?accalab_slip=${slipToken}${item.b365_search_hash}`;
  }

  const betType = legs.length > 1 ? 'combo' : 'single';
  const overrideClean = String(optionsOverride || '').trim();
  const resolvedOptions =
    overrideClean || (legOptionTokens.length === legs.length && legOptionTokens.length ? legOptionTokens.join(',') : '');
  const prefillTemplateUrl = `https://www.bet365.com/en/sports?options={eventId}-{marketId}-{selectionId}&type=${betType}&stake=${cleanStake.toFixed(2)}&currency=GBP`;

  let deepLinkUrl = null;
  let launchUrl = exportedLegs[0]?.b365_search_url || `https://www.bet365.com/?accalab_slip=${slipToken}#/HO/`;
  let mode = 'express_handoff';
  if (resolvedOptions) {
    const safeOpts = encodeURIComponent(resolvedOptions).replaceAll('%2C', ',').replaceAll('%2D', '-').replaceAll('%7E', '~');
    deepLinkUrl = `https://www.bet365.com/en/sports?options=${safeOpts}&type=${betType}&stake=${cleanStake.toFixed(2)}&currency=GBP`;
    launchUrl = deepLinkUrl;
    mode = 'direct_prefill';
  }

  const lines = [
    `${title} (${legs.length > 1 ? `Acca ${legs.length}-Fold` : 'Single'})`,
    `Stake: £${cleanStake.toFixed(2)} | Combined Odds: ${combFrac} | Potential Return: £${evalSummary.potential_return.toFixed(2)}`,
    `Model Hit Prob: ${evalSummary.combined_model_prob_pct}% | Expected Value: ${evalSummary.expected_value_pct >= 0 ? '+' : ''}${evalSummary.expected_value_pct.toFixed(1)}%`,
    '',
  ];
  exportedLegs.forEach((item, idx) => {
    lines.push(
      `${idx + 1}. ${item.home_team} v ${item.away_team} (${item.league_name}) — ${item.b365_market_name}: ${item.selection_label} @ ${fmtOdds(item.odds)}`
    );
  });

  return {
    title,
    mode,
    bet_type: betType,
    stake: roundNum(cleanStake, 2),
    slip_token: slipToken,
    launch_url: launchUrl,
    deep_link_url: deepLinkUrl,
    prefill_template_url: prefillTemplateUrl,
    clipboard_text: lines.join('\n'),
    eval: evalSummary,
    legs: exportedLegs,
  };
}

async function loadStaticSnapshot(forceReload = false) {
  if (_staticSnapshot && !forceReload) return _staticSnapshot;
  const suffix = forceReload ? `?t=${Date.now()}` : '';
  const res = await fetch(`./static/snapshot.json${suffix}`);
  if (!res.ok) throw new Error(`Unable to load static snapshot (HTTP ${res.status})`);
  _staticSnapshot = await res.json();
  return _staticSnapshot;
}

function createGuestUser() {
  return {
    id: 0,
    username: 'guest',
    display_name: 'Guest',
    email: '',
    avatar_color: '#10b981',
    bankroll: 250,
    kelly_fraction: 0.25,
    min_edge_pct: 4.0,
    telegram_chat_id: '',
    monthly_stake_limit: 200,
    show_on_leaderboard: 1,
    favourite_teams: [],
    preferred_leagues: ['E0', 'E1', 'E2', 'E3'],
    default_stake: 10,
    active_slip: [],
    is_guest: true,
  };
}

function getGhState(snap) {
  try {
    localStorage.removeItem('accalab_gh_state_v1');
  } catch { }
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(GH_STATE_KEY) || 'null');
  } catch {
    raw = null;
  }
  if (raw && Array.isArray(raw.users)) {
    return raw;
  }
  const users = cloneJson(snap.dashboard?.users || []);
  const passwordsByUserId = {};
  const watchedByUser = {};
  const activeU = snap.dashboard?.active_user;
  if (activeU && Number(activeU.id) > 0) {
    watchedByUser[activeU.id] = cloneJson(snap.dashboard?.watched_fixture_ids || []);
  }
  const betsByUser = {};
  for (const [uid, payload] of Object.entries(snap.bets_by_user || {})) {
    betsByUser[uid] = cloneJson(payload?.bets || []);
  }
  const savedAccasByUser = cloneJson(snap.saved_accas_by_user || {});
  const init = {
    users,
    passwordsByUserId,
    authenticatedUserId: null,
    watchedByUser,
    savedAccasByUser,
    betsByUser,
    customOddsByFixture: {},
    alertsRead: false,
    nextIds: {
      user: Math.max(0, ...users.map((u) => Number(u.id) || 0)) + 1,
      bet: 1,
      acca: 1,
    },
  };
  localStorage.setItem(GH_STATE_KEY, JSON.stringify(init));
  return init;
}

function saveGhState(gh) {
  localStorage.setItem(GH_STATE_KEY, JSON.stringify(gh));
}

function sanitizeStaticUser(u) {
  const copy = cloneJson(u);
  delete copy.password_hash;
  copy.favourite_teams = Array.isArray(copy.favourite_teams) ? copy.favourite_teams : [];
  copy.preferred_leagues = Array.isArray(copy.preferred_leagues) && copy.preferred_leagues.length
    ? copy.preferred_leagues
    : ['E0', 'E1', 'E2', 'E3'];
  copy.active_slip = Array.isArray(copy.active_slip) ? copy.active_slip : [];
  copy.default_stake = Number(copy.default_stake || 10);
  return copy;
}

function resolveStaticUser(gh, queryParams) {
  if (gh.authenticatedUserId) {
    const authed = gh.users.find((u) => Number(u.id) === Number(gh.authenticatedUserId));
    if (authed) return { ...authed, is_guest: false };
  }
  const reqId = Number(queryParams.get('user_id') || state.activeUserId);
  if (reqId > 0) {
    const picked = gh.users.find((u) => Number(u.id) === reqId);
    if (picked) return { ...picked, is_guest: false };
  }
  if (gh.users.length) {
    return { ...gh.users[0], is_guest: false };
  }
  return createGuestUser();
}

function computeStaticBestEdge(fix) {
  const cands = [
    ['1X2_H', `${fix.home_team} Win`, fix.prob_home, fix.b365h],
    ['1X2_D', 'Draw', fix.prob_draw, fix.b365d],
    ['1X2_A', `${fix.away_team} Win`, fix.prob_away, fix.b365a],
    ['OU_O25', 'Over 2.5', fix.prob_over25, fix.b365_over25],
    ['OU_U25', 'Under 2.5', fix.prob_under25, fix.b365_under25],
    ['BTTS_Y', 'BTTS Yes', fix.prob_btts_yes, fix.b365_btts_yes],
    ['BTTS_N', 'BTTS No', fix.prob_btts_no, fix.b365_btts_no],
  ];
  let best = { market: '', label: '', edge_pct: -999.0, odds: 0.0 };
  for (const [market, label, prob, odd] of cands) {
    if (odd && Number(odd) > 1.01) {
      const edge = (Number(prob) * Number(odd) - 1.0) * 100.0;
      if (edge > best.edge_pct) {
        best = { market, label, edge_pct: roundNum(edge, 1), odds: roundNum(odd, 2) };
      }
    }
  }
  return best;
}

function applyStaticCustomOdds(fix, customOddsMap) {
  const co = customOddsMap?.[String(fix.id)];
  if (!co) return fix;
  const merged = { ...fix, ...co, odds_source: 'user_manual' };
  merged.best_edge = computeStaticBestEdge(merged);
  return merged;
}

function computeStaticUserBetsData(gh, snap, user) {
  const leaguesMeta = snap.dashboard?.leagues || {};
  const rawBets = cloneJson(gh.betsByUser[user.id] || snap.bets_by_user?.[user.id]?.bets || []);
  const settled = rawBets.filter((b) => b.status === 'won' || b.status === 'lost');
  const wins = settled.filter((b) => b.status === 'won').length;
  const totStake = settled.reduce((acc, b) => acc + Number(b.stake || 0), 0);
  const totPnl = settled.reduce((acc, b) => acc + Number(b.pnl || 0), 0);
  const clvs = settled.map((b) => b.clv_pct).filter((v) => v !== null && v !== undefined);

  const byLeague = {};
  for (const b of settled) {
    const legs = b.legs || [];
    const share = 1.0 / Math.max(1, legs.length);
    for (const lg of legs) {
      const dv = lg.div;
      if (!byLeague[dv]) {
        byLeague[dv] = {
          div: dv,
          league_name: leaguesMeta[dv]?.name || dv,
          bets: 0,
          wins: 0,
          pnl: 0.0,
          staked: 0.0,
        };
      }
      byLeague[dv].bets += 1;
      if (b.status === 'won') byLeague[dv].wins += 1;
      byLeague[dv].pnl += Number(b.pnl || 0) * share;
      byLeague[dv].staked += Number(b.stake || 0) * share;
    }
  }
  const byLeagueArr = Object.values(byLeague).map((v) => ({
    ...v,
    pnl: roundNum(v.pnl, 2),
    staked: roundNum(v.staked, 2),
    roi_pct: v.staked > 0 ? roundNum((v.pnl / v.staked) * 100.0, 1) : 0.0,
  }));

  let running = 0.0;
  const pnlSeries = [...settled].reverse().map((b) => {
    running += Number(b.pnl || 0);
    return { label: String(b.placed_at || '').slice(0, 10), pnl: roundNum(running, 2) };
  });

  const monthPrefix = new Date().toISOString().slice(0, 7);
  const monthStaked = rawBets
    .filter((b) => String(b.placed_at || '').startsWith(monthPrefix))
    .reduce((acc, b) => acc + Number(b.stake || 0), 0);

  return {
    user: sanitizeStaticUser(user),
    bets: rawBets,
    stats: {
      total_bets: rawBets.length,
      settled_count: settled.length,
      pending_count: rawBets.filter((b) => b.status === 'pending').length,
      win_rate_pct: settled.length ? roundNum((100.0 * wins) / settled.length, 1) : 0.0,
      total_staked: roundNum(totStake, 2),
      total_pnl: roundNum(totPnl, 2),
      roi_pct: totStake > 0 ? roundNum((totPnl / totStake) * 100.0, 2) : 0.0,
      avg_clv_pct: clvs.length ? roundNum(clvs.reduce((a, b) => a + b, 0) / clvs.length, 2) : 0.0,
      month_staked: roundNum(monthStaked, 2),
    },
    by_league: byLeagueArr,
    pnl_series: pnlSeries,
  };
}

function buildStaticSuggestBet(gh, snap, user) {
  const base = cloneJson(snap.suggest_bet || { risk_levels: [], by_risk: {}, suggestions: [], by_id: {}, top_single: null });
  const favSet = new Set(user.favourite_teams || []);
  const prefLeagues = new Set(user.preferred_leagues || ['E0', 'E1', 'E2', 'E3']);
  const watchedSet = new Set(gh.watchedByUser[user.id] || []);
  const fixById = new Map((snap.fixtures || []).map((f) => [f.id, f]));
  const allFix = snap.fixtures || [];
  const hasUpcoming = allFix.some((f) => isFixtureUpcomingClient(f));
  const isItemUpcoming = (item) => {
    if (!hasUpcoming) return true;
    const fx = fixById.get(item.fixture_id);
    return fx ? isFixtureUpcomingClient(fx) : isFixtureUpcomingClient(item);
  };

  const upcomingOpps = (snap.value_bets || []).filter(isItemUpcoming);
  const toLeg = (o) => ({
    fixture_id: o.fixture_id,
    div: o.div,
    league_name: o.league_name,
    match_date: o.match_date,
    kickoff_time: fixById.get(o.fixture_id)?.kickoff_time || o.kickoff_time || '',
    home_team: o.home_team,
    away_team: o.away_team,
    market: o.market,
    selection_label: o.selection_label,
    odds: o.odds,
    odds_fractional: fmtOdds(o.odds),
    model_prob: roundNum(Number(o.model_prob_pct) / 100.0, 5),
    edge_pct: o.edge_pct,
    odds_source: o.odds_source,
  });

  if (hasUpcoming && upcomingOpps.length) {
    const refreshPkg = (pkg) => {
      if (!pkg || !Array.isArray(pkg.legs)) return pkg;
      if (pkg.legs.every(isItemUpcoming)) return pkg;
      const targetLen = pkg.legs.length;
      const kept = pkg.legs.filter(isItemUpcoming);
      const usedFids = new Set(kept.map((l) => l.fixture_id));
      for (const cand of upcomingOpps) {
        if (kept.length >= targetLen) break;
        if (usedFids.has(cand.fixture_id) || cand.odds < 1.25 || cand.odds > 5.5) continue;
        usedFids.add(cand.fixture_id);
        kept.push(toLeg(cand));
      }
      if (!kept.length) return pkg;
      const ev = evaluateAccaClient(kept, pkg.stake || 5);
      ev.combined_odds_fractional = fmtOdds(ev.combined_odds);
      pkg.legs = kept;
      pkg.eval = ev;
      pkg.bet365_export = buildBet365ExportClient(kept, pkg.stake || 5, pkg.title, '', snap.dashboard?.leagues);
      return pkg;
    };

    for (const tier of base.risk_levels || []) {
      tier.options = (tier.options || []).map(refreshPkg);
      if (tier.primary) tier.primary = base.by_id?.[tier.primary.id] ? refreshPkg(tier.primary) : tier.options[0];
      if (base.by_risk?.[tier.id]) base.by_risk[tier.id] = tier;
    }
    base.suggestions = (base.suggestions || []).map(refreshPkg);
    for (const [k, v] of Object.entries(base.by_id || {})) {
      base.by_id[k] = refreshPkg(v);
    }
    if (base.top_single) base.top_single = refreshPkg(base.top_single);
  }

  if (favSet.size || watchedSet.size || prefLeagues.size < 4) {
    const allVal = upcomingOpps.length ? upcomingOpps : snap.value_bets || [];
    let pool = allVal.filter((o) => favSet.has(o.home_team) || favSet.has(o.away_team) || watchedSet.has(o.fixture_id));
    if (!pool.length) pool = allVal.filter((o) => prefLeagues.has(o.div));
    if (!pool.length) pool = allVal;

    const picked = [];
    const seenFids = new Set();
    for (const o of pool) {
      if (o.odds < 1.25 || o.odds > 5.5 || seenFids.has(o.fixture_id)) continue;
      seenFids.add(o.fixture_id);
      picked.push(toLeg(o));
      if (picked.length === 3) break;
    }

    if (picked.length) {
      const stake = Number(user.default_stake || 10);
      const ev = evaluateAccaClient(picked, stake);
      ev.combined_odds_fractional = fmtOdds(ev.combined_odds);
      const myPkg = {
        id: 'med_clubs',
        risk_level: 'medium',
        title: 'My Clubs Special',
        badge: 'Personalised',
        subtitle: 'Tailored to your followed clubs, watchlist & preferred leagues',
        confidence_score: Math.min(95, Math.max(58, Math.round(62 + (picked[0]?.edge_pct || 4) * 1.5))),
        stake: roundNum(stake, 2),
        legs: picked,
        eval: ev,
        reasons: [
          `Matched to your profile (${favSet.size} followed clubs, ${watchedSet.size} watchlist matches).`,
          `Combined odds ${fmtOdds(ev.combined_odds)} with ${ev.combined_model_prob_pct}% model probability (${ev.expected_value_pct >= 0 ? '+' : ''}${ev.expected_value_pct}% EV).`,
          ...picked.map((l) => `${l.home_team} vs ${l.away_team}: ${l.selection_label} @ ${fmtOdds(l.odds)} (+${l.edge_pct}% EV).`),
        ].slice(0, 4),
        bet365_export: buildBet365ExportClient(picked, stake, 'My Clubs Special', '', snap.dashboard?.leagues),
      };
      if (base.by_risk?.medium) {
        base.by_risk.medium.options = (base.by_risk.medium.options || []).map((o) =>
          o.id === 'med_clubs' || o.id === 'my_clubs' ? myPkg : o
        );
      }
      base.risk_levels = (base.risk_levels || []).map((rl) =>
        rl.id === 'medium' && base.by_risk?.medium ? base.by_risk.medium : rl
      );
      base.by_id = { ...(base.by_id || {}), med_clubs: myPkg, my_clubs: myPkg };
    }
  }
  return base;
}

async function staticApi(path, opts = {}) {
  const [pathname, queryStr = ''] = path.split('?');
  const query = new URLSearchParams(queryStr);
  const method = String(opts.method || 'GET').toUpperCase();
  const bodyData = opts.body ? (typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body) : {};
  const isSyncRefresh = pathname === '/api/sync';
  const snap = await loadStaticSnapshot(isSyncRefresh);
  const gh = getGhState(snap);
  const activeUser = resolveStaticUser(gh, query);
  const leaguesMeta = snap.dashboard?.leagues || {};

  if (pathname === '/api/dashboard') {
    const favSet = new Set(activeUser.favourite_teams || []);
    const watchedIds = cloneJson(gh.watchedByUser[activeUser.id] || []);
    const watchedSet = new Set(watchedIds);
    const savedAccas = gh.savedAccasByUser[activeUser.id] || [];
    const allFixtures = (snap.fixtures || []).map((f) => applyStaticCustomOdds(f, gh.customOddsByFixture));
    const upcomingFix = allFixtures.filter((f) => isFixtureUpcomingClient(f));
    const fixtures = upcomingFix.length ? upcomingFix : allFixtures;
    const forYou = fixtures
      .filter((f) => favSet.has(f.home_team) || favSet.has(f.away_team) || watchedSet.has(f.id))
      .slice(0, 6)
      .map((f) => ({ ...f, is_watched: watchedSet.has(f.id) }));

    const betsData = computeStaticUserBetsData(gh, snap, activeUser);
    const baseCounts = cloneJson(snap.dashboard?.counts || {});
    baseCounts.unread_alerts = gh.alertsRead ? 0 : baseCounts.unread_alerts;
    baseCounts.saved_accas = savedAccas.length;
    baseCounts.watched_fixtures = watchedIds.length;
    baseCounts.upcoming_fixtures = fixtures.length;
    const dynamicLeagueCounts = {};
    for (const fx of fixtures) dynamicLeagueCounts[fx.div] = (dynamicLeagueCounts[fx.div] || 0) + 1;

    const opps = (snap.value_bets || [])
      .filter((o) => {
        const fx = allFixtures.find((f) => f.id === o.fixture_id);
        return upcomingFix.length ? (fx ? isFixtureUpcomingClient(fx) : isFixtureUpcomingClient(o)) : true;
      })
      .filter((o) => o.edge_pct >= Number(activeUser.min_edge_pct || 4.0));
    const sugg = buildStaticSuggestBet(gh, snap, activeUser);

    return {
      authenticated: Boolean(gh.authenticatedUserId && Number(gh.authenticatedUserId) === Number(activeUser.id) && Number(activeUser.id) > 0),
      active_user: sanitizeStaticUser(activeUser),
      users: gh.users.map(sanitizeStaticUser),
      watched_fixture_ids: watchedIds,
      favourite_teams: activeUser.favourite_teams || [],
      for_you_fixtures: forYou,
      all_teams_by_league: snap.dashboard?.all_teams_by_league || {},
      counts: baseCounts,
      leagues_counts: fixtures.length ? dynamicLeagueCounts : snap.dashboard?.leagues_counts || {},
      user_summary: {
        total_bets: betsData.stats.total_bets,
        pending_bets: betsData.stats.pending_count,
        settled_bets: betsData.stats.settled_count,
        total_pnl: betsData.stats.total_pnl,
        roi_pct: betsData.stats.roi_pct,
        avg_clv_pct: betsData.stats.avg_clv_pct,
      },
      top_value_bets: opps.slice(0, 6),
      featured_suggestion: sugg.top_single || snap.dashboard?.featured_suggestion || null,
      featured_by_risk: sugg.by_risk || snap.dashboard?.featured_by_risk || {},
      quota: snap.dashboard?.quota || {},
      integrations: snap.dashboard?.integrations || {},
      leagues: leaguesMeta,
    };
  }

  if (pathname === '/api/fixtures') {
    const div = (query.get('div') || '').trim();
    const search = (query.get('search') || '').trim().toLowerCase();
    const dateFilter = (query.get('date') || '').trim();
    const favSet = new Set(activeUser.favourite_teams || []);
    const watchedSet = new Set(gh.watchedByUser[activeUser.id] || []);

    const allMapped = (snap.fixtures || []).map((f) => applyStaticCustomOdds(f, gh.customOddsByFixture));
    const upcomingMapped = allMapped.filter((f) => isFixtureUpcomingClient(f));
    const baseRows = !dateFilter && upcomingMapped.length ? upcomingMapped : allMapped;

    const list = baseRows
      .filter((f) => {
        if (div && !['MY_TEAMS', 'WATCHLIST'].includes(div) && f.div !== div) return false;
        if (dateFilter && f.match_date !== dateFilter) return false;
        const isFav = favSet.has(f.home_team) || favSet.has(f.away_team);
        const isWatched = watchedSet.has(f.id);
        if (div === 'MY_TEAMS' && !isFav && !isWatched) return false;
        if (div === 'WATCHLIST' && !isWatched) return false;
        if (search && !f.home_team.toLowerCase().includes(search) && !f.away_team.toLowerCase().includes(search)) return false;
        return true;
      })
      .map((f) => ({
        ...f,
        is_watched: watchedSet.has(f.id),
        is_favourite_match: favSet.has(f.home_team) || favSet.has(f.away_team),
      }));
    return {
      fixtures: list,
      total: list.length,
      watched_fixture_ids: [...watchedSet],
      favourite_teams: [...favSet],
    };
  }

  const fixOddsMatch = pathname.match(/^\/api\/fixture\/(\d+)\/odds$/);
  if (fixOddsMatch && method === 'POST') {
    const fid = fixOddsMatch[1];
    const existing = cloneJson(gh.customOddsByFixture[fid] || {});
    for (const k of ['b365h', 'b365d', 'b365a', 'b365_over25', 'b365_under25', 'b365_btts_yes', 'b365_btts_no']) {
      const val = parseOddsInput(bodyData[k]);
      if (val && val > 1.01) existing[k] = val;
    }
    gh.customOddsByFixture[fid] = existing;
    saveGhState(gh);
    return { ok: true, fixture_id: Number(fid), odds_source: 'user_manual' };
  }

  const fixAiMatch = pathname.match(/^\/api\/fixture\/(\d+)\/ai-summary$/);
  if (fixAiMatch && method === 'POST') {
    const detail = snap.fixture_details?.[fixAiMatch[1]];
    if (!detail) throw new Error('Fixture not found');
    return {
      ai_summary: detail.fixture.ai_summary,
      ai_summary_source: detail.fixture.ai_summary_source || 'grounded_analyst_static',
      cached: true,
    };
  }

  const fixDetailMatch = pathname.match(/^\/api\/fixture\/(\d+)$/);
  if (fixDetailMatch) {
    const fid = fixDetailMatch[1];
    const base = snap.fixture_details?.[fid];
    if (!base) throw new Error('Fixture not found');
    const d = cloneJson(base);
    d.fixture = applyStaticCustomOdds(d.fixture, gh.customOddsByFixture);
    d.standings = cloneJson(snap.standings_by_div?.[d.fixture.div] || d.standings || []);

    const f = d.fixture;
    const [fh, fd, fa, over1x2] = f.b365h && f.b365d && f.b365a ? devigThreeWayClient(f.b365h, f.b365d, f.b365a) : [0, 0, 0, 0];
    const [fo, fu, overOu] = f.b365_over25 && f.b365_under25 ? devigTwoWayClient(f.b365_over25, f.b365_under25) : [0, 0, 0];
    const [fby, fbn] = f.b365_btts_yes && f.b365_btts_no ? devigTwoWayClient(f.b365_btts_yes, f.b365_btts_no) : [0, 0];

    d.overround_1x2_pct = roundNum(over1x2, 2);
    d.overround_ou25_pct = roundNum(overOu, 2);
    d.markets = [
      ['1X2_H', `${f.home_team} Win`, f.prob_home, f.b365h, fh],
      ['1X2_D', 'Draw', f.prob_draw, f.b365d, fd],
      ['1X2_A', `${f.away_team} Win`, f.prob_away, f.b365a, fa],
      ['OU_O25', 'Over 2.5 Goals', f.prob_over25, f.b365_over25, fo],
      ['OU_U25', 'Under 2.5 Goals', f.prob_under25, f.b365_under25, fu],
      ['BTTS_Y', 'BTTS Yes', f.prob_btts_yes, f.b365_btts_yes, fby],
      ['BTTS_N', 'BTTS No', f.prob_btts_no, f.b365_btts_no, fbn],
    ].map(([market, label, mProb, odd, fairB]) => {
      const edge = odd ? (mProb * odd - 1.0) * 100.0 : 0.0;
      const ks = kellyStakeClient(mProb, odd || 1.0, activeUser.bankroll, activeUser.kelly_fraction);
      return {
        market,
        label,
        model_prob_pct: roundNum(mProb * 100.0, 1),
        fair_odds: roundNum(1.0 / Math.max(mProb, 0.01), 2),
        b365_odds: odd ? roundNum(odd, 2) : null,
        implied_fair_pct: fairB ? roundNum(fairB * 100.0, 1) : null,
        edge_pct: roundNum(edge, 2),
        kelly_pct: ks.kelly_pct,
        suggested_stake: ks.suggested_stake,
      };
    });
    return d;
  }

  if (pathname === '/api/value-bets') {
    const div = (query.get('div') || '').trim();
    const minEdge = Number(query.get('min_edge') ?? 2.0);
    const officialOnly = query.get('official_only') === '1';
    const fixById = new Map((snap.fixtures || []).map((f) => [f.id, f]));
    const hasUpcoming = (snap.fixtures || []).some((f) => isFixtureUpcomingClient(f));
    const opps = (snap.value_bets || [])
      .filter((o) => {
        if (hasUpcoming) {
          const fx = fixById.get(o.fixture_id);
          if (!(fx ? isFixtureUpcomingClient(fx) : isFixtureUpcomingClient(o))) return false;
        }
        if (div && o.div !== div) return false;
        if (officialOnly && !['bet365_official', 'api_football_b365', 'user_manual'].includes(o.odds_source)) return false;
        if (officialOnly && o.odds_source === 'bet365_official' && String(o.market).startsWith('BTTS')) return false;
        return Number(o.edge_pct) >= minEdge;
      })
      .map((o) => {
        const ks = kellyStakeClient(Number(o.model_prob_pct) / 100.0, o.odds, activeUser.bankroll, activeUser.kelly_fraction);
        return { ...o, kelly_pct: ks.kelly_pct, suggested_stake: ks.suggested_stake };
      });
    return {
      opportunities: opps,
      total: opps.length,
      bankroll: activeUser.bankroll,
      kelly_fraction: activeUser.kelly_fraction,
    };
  }

  if (pathname === '/api/acca/presets') {
    return { presets: cloneJson(snap.acca_presets || []) };
  }

  if (pathname === '/api/acca/evaluate' && method === 'POST') {
    return evaluateAccaClient(bodyData.legs || [], bodyData.stake ?? 10.0);
  }

  if (pathname === '/api/suggest-bet') {
    return buildStaticSuggestBet(gh, snap, activeUser);
  }

  if (pathname === '/api/bet365/export' && method === 'POST') {
    return buildBet365ExportClient(
      bodyData.legs || [],
      bodyData.stake ?? 10.0,
      (bodyData.title || 'AccaLab Suggested Bet').trim(),
      bodyData.options_override || '',
      leaguesMeta
    );
  }

  if (pathname === '/api/bets') {
    if (method === 'GET') {
      return computeStaticUserBetsData(gh, snap, activeUser);
    }
    if (method === 'POST') {
      const legs = bodyData.legs || [];
      if (!legs.length) throw new Error('At least one leg is required');
      const stake = Number(bodyData.stake ?? 10.0);
      if (!Number.isFinite(stake) || stake <= 0) throw new Error('Stake must be positive');
      const targetUser = gh.users.find((u) => Number(u.id) === Number(bodyData.user_id)) || activeUser;
      if (!targetUser || Number(targetUser.id) === 0) {
        throw new Error('Please create your account or sign in first.');
      }
      const ev = evaluateAccaClient(legs, stake);
      const betId = gh.nextIds.bet++;
      const now = new Date().toISOString();
      if (!gh.betsByUser[targetUser.id]) {
        gh.betsByUser[targetUser.id] = cloneJson(snap.bets_by_user?.[targetUser.id]?.bets || []);
      }
      gh.betsByUser[targetUser.id].unshift({
        id: betId,
        user_id: targetUser.id,
        bet_type: legs.length > 1 ? 'acca' : 'single',
        stake: roundNum(stake, 2),
        combined_odds: ev.combined_odds,
        combined_model_prob: ev.combined_model_prob,
        expected_value_pct: ev.expected_value_pct,
        status: 'pending',
        pnl: 0.0,
        clv_pct: null,
        notes: (bodyData.notes || '').trim(),
        placed_at: now,
        settled_at: null,
        legs: legs.map((l) => ({
          bet_id: betId,
          fixture_id: l.fixture_id,
          div: l.div || 'E0',
          match_date: l.match_date || now.slice(0, 10),
          home_team: l.home_team || '',
          away_team: l.away_team || '',
          market: l.market || '1X2_H',
          selection_label: l.selection_label || l.market,
          odds_taken: Number(l.odds || 2.0),
          model_prob: Number(l.model_prob || 0.5),
          closing_odds: null,
          leg_status: 'pending',
        })),
      });
      saveGhState(gh);
      return { ok: true, bet_id: betId, auto_settled: 0 };
    }
  }

  if (pathname === '/api/bets/settle' && method === 'POST') {
    return { settled: 0 };
  }

  if (pathname === '/api/leaderboard') {
    const board = gh.users
      .filter((u) => Number(u.show_on_leaderboard ?? 1) === 1)
      .map((u) => {
        const bData = computeStaticUserBetsData(gh, snap, u);
        return {
          user_id: u.id,
          display_name: u.display_name,
          username: u.username,
          avatar_color: u.avatar_color,
          bets_settled: bData.stats.settled_count,
          win_rate_pct: bData.stats.win_rate_pct,
          total_staked: bData.stats.total_staked,
          total_pnl: bData.stats.total_pnl,
          roi_pct: bData.stats.roi_pct,
          avg_clv_pct: bData.stats.avg_clv_pct,
        };
      })
      .sort((a, b) => b.roi_pct - a.roi_pct || b.total_pnl - a.total_pnl);
    return { leaderboard: board, invite_code_hint: 'Ask admin for invite code' };
  }

  if (pathname === '/api/users' && method === 'POST') {
    const inv = (bodyData.invite_code || '').trim();
    if (inv && inv !== 'ACCALAB2026') {
      throw new Error('Invalid group invite code');
    }
    const displayName = (bodyData.display_name || '').trim();
    if (!displayName) throw new Error('Display name is required');
    const newId = gh.nextIds.user++;
    const newUser = sanitizeStaticUser({
      id: newId,
      username: displayName.toLowerCase().replaceAll(/[^a-z0-9]/g, '') || `friend${newId}`,
      display_name: displayName,
      email: '',
      avatar_color: bodyData.avatar_color || '#8b5cf6',
      bankroll: Number(bodyData.bankroll || 200),
      kelly_fraction: Number(bodyData.kelly_fraction || 0.25),
      min_edge_pct: Number(bodyData.min_edge_pct || 4.0),
      telegram_chat_id: (bodyData.telegram_chat_id || '').trim(),
      monthly_stake_limit: Number(bodyData.monthly_stake_limit || 150),
      show_on_leaderboard: bodyData.show_on_leaderboard === false ? 0 : 1,
      favourite_teams: [],
      preferred_leagues: ['E0', 'E1', 'E2', 'E3'],
      default_stake: 10.0,
      active_slip: [],
    });
    gh.users.push(newUser);
    gh.passwordsByUserId[newId] = String(bodyData.password || 'accalab');
    gh.authenticatedUserId = newId;
    saveGhState(gh);
    return { ok: true, user: newUser };
  }

  if (pathname === '/api/auth/me') {
    return {
      authenticated: Boolean(gh.authenticatedUserId && Number(gh.authenticatedUserId) === Number(activeUser.id) && Number(activeUser.id) > 0),
      user: sanitizeStaticUser(activeUser),
      all_teams: snap.dashboard?.all_teams_by_league || {},
    };
  }

  if (pathname === '/api/auth/register' && method === 'POST') {
    const inv = (bodyData.invite_code || '').trim();
    if (inv && inv !== 'ACCALAB2026') {
      throw new Error('Invalid group invite code');
    }
    const displayName = (bodyData.display_name || '').trim();
    const rawUname = (bodyData.username || displayName).trim().toLowerCase();
    const username = rawUname.replaceAll(/[^a-z0-9_-]/g, '');
    const password = String(bodyData.password || '');
    if (!displayName || !username) throw new Error('Display name and username are required');
    if (password.length < 4) throw new Error('Password must be at least 4 characters');
    if (gh.users.some((u) => String(u.username).toLowerCase() === username)) {
      throw new Error(`Username '${username}' is already taken`);
    }
    const newId = gh.nextIds.user++;
    const newUser = sanitizeStaticUser({
      id: newId,
      username,
      display_name: displayName,
      email: (bodyData.email || '').trim().toLowerCase(),
      avatar_color: bodyData.avatar_color || '#8b5cf6',
      bankroll: Number(bodyData.bankroll || 200),
      kelly_fraction: Number(bodyData.kelly_fraction || 0.25),
      min_edge_pct: Number(bodyData.min_edge_pct || 4.0),
      telegram_chat_id: (bodyData.telegram_chat_id || '').trim(),
      monthly_stake_limit: Number(bodyData.monthly_stake_limit || 150),
      show_on_leaderboard: bodyData.show_on_leaderboard === false ? 0 : 1,
      favourite_teams: Array.isArray(bodyData.favourite_teams) ? bodyData.favourite_teams : [],
      preferred_leagues:
        Array.isArray(bodyData.preferred_leagues) && bodyData.preferred_leagues.length
          ? bodyData.preferred_leagues
          : ['E0', 'E1', 'E2', 'E3'],
      default_stake: Number(bodyData.default_stake || 10.0),
      active_slip: [],
    });
    gh.users.push(newUser);
    gh.passwordsByUserId[newId] = password;
    gh.authenticatedUserId = newId;
    saveGhState(gh);
    return { ok: true, user: newUser };
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const ident = (bodyData.username || '').trim().toLowerCase();
    const password = String(bodyData.password || '');
    const match = gh.users.find(
      (u) =>
        String(u.username || '').toLowerCase() === ident ||
        String(u.email || '').toLowerCase() === ident ||
        String(u.display_name || '').toLowerCase() === ident
    );
    const expectedPw = match ? gh.passwordsByUserId[match.id] : null;
    if (!match || !expectedPw || password !== expectedPw) {
      throw new Error('Invalid username or password');
    }
    gh.authenticatedUserId = match.id;
    saveGhState(gh);
    return { ok: true, user: sanitizeStaticUser(match) };
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    gh.authenticatedUserId = null;
    saveGhState(gh);
    return { ok: true };
  }

  if (pathname === '/api/auth/password' && method === 'POST') {
    if (!activeUser || Number(activeUser.id) === 0) {
      throw new Error('Please create your account or sign in first.');
    }
    const curr = String(bodyData.current_password || '');
    const newPw = String(bodyData.new_password || '');
    if (newPw.length < 4) throw new Error('New password must be at least 4 characters');
    if (!gh.passwordsByUserId[activeUser.id] || curr !== gh.passwordsByUserId[activeUser.id]) {
      throw new Error('Current password is incorrect');
    }
    gh.passwordsByUserId[activeUser.id] = newPw;
    saveGhState(gh);
    return { ok: true };
  }

  if (pathname === '/api/user/preferences' && method === 'POST') {
    const target = gh.users.find((u) => Number(u.id) === Number(activeUser.id));
    if (!target || Number(target.id) === 0) {
      throw new Error('Please create your account or sign in first.');
    }
    if (Array.isArray(bodyData.favourite_teams)) {
      target.favourite_teams = bodyData.favourite_teams.filter((t) => String(t).trim());
    } else if (bodyData.toggle_team) {
      const tName = String(bodyData.toggle_team).trim();
      const curFavs = target.favourite_teams || [];
      target.favourite_teams = curFavs.includes(tName)
        ? curFavs.filter((t) => t !== tName)
        : [...curFavs, tName];
    }
    if (Array.isArray(bodyData.preferred_leagues) && bodyData.preferred_leagues.length) {
      target.preferred_leagues = bodyData.preferred_leagues;
    }
    if (bodyData.display_name) target.display_name = String(bodyData.display_name).trim();
    if (bodyData.avatar_color) target.avatar_color = bodyData.avatar_color;
    if (bodyData.bankroll !== undefined) target.bankroll = Number(bodyData.bankroll);
    if (bodyData.kelly_fraction !== undefined) target.kelly_fraction = Number(bodyData.kelly_fraction);
    if (bodyData.min_edge_pct !== undefined) target.min_edge_pct = Number(bodyData.min_edge_pct);
    if (bodyData.monthly_stake_limit !== undefined) target.monthly_stake_limit = Number(bodyData.monthly_stake_limit);
    if (bodyData.telegram_chat_id !== undefined) target.telegram_chat_id = String(bodyData.telegram_chat_id || '').trim();
    if (bodyData.default_stake !== undefined) target.default_stake = Number(bodyData.default_stake);
    saveGhState(gh);
    return { ok: true, user: sanitizeStaticUser(target) };
  }

  if (pathname === '/api/user/watchlist') {
    const ids = gh.watchedByUser[activeUser.id] || [];
    const watchedSet = new Set(ids);
    const list = (snap.fixtures || [])
      .filter((f) => watchedSet.has(f.id))
      .map((f) => ({
        fixture_id: f.id,
        note: '',
        div: f.div,
        match_date: f.match_date,
        kickoff_time: f.kickoff_time,
        home_team: f.home_team,
        away_team: f.away_team,
        b365h: f.b365h,
        b365d: f.b365d,
        b365a: f.b365a,
        odds_source: f.odds_source,
      }));
    return { watchlist: list, fixture_ids: ids };
  }

  if (pathname === '/api/user/watchlist/toggle' && method === 'POST') {
    if (!activeUser || Number(activeUser.id) === 0) {
      throw new Error('Please create your account or sign in first.');
    }
    const fid = Number(bodyData.fixture_id);
    if (!fid) throw new Error('Valid fixture_id is required');
    const cur = gh.watchedByUser[activeUser.id] || [];
    let watched = false;
    if (cur.includes(fid)) {
      gh.watchedByUser[activeUser.id] = cur.filter((x) => x !== fid);
    } else {
      gh.watchedByUser[activeUser.id] = [...cur, fid];
      watched = true;
    }
    saveGhState(gh);
    return { ok: true, watched, watched_fixture_ids: gh.watchedByUser[activeUser.id] };
  }

  if (pathname === '/api/user/slip' && method === 'PUT') {
    const target = gh.users.find((u) => Number(u.id) === Number(activeUser.id));
    const legs = Array.isArray(bodyData.legs) ? bodyData.legs : [];
    const stake = Math.max(1.0, Number(bodyData.stake || 10.0));
    if (!target || Number(target.id) === 0) {
      return { ok: true, leg_count: legs.length, default_stake: stake };
    }
    target.active_slip = legs;
    target.default_stake = stake;
    saveGhState(gh);
    return { ok: true, leg_count: target.active_slip.length, default_stake: target.default_stake };
  }

  if (pathname === '/api/user/saved-accas') {
    const cur = gh.savedAccasByUser[activeUser.id] || [];
    if (method === 'GET') {
      return { saved_accas: cloneJson(cur) };
    }
    if (method === 'POST') {
      if (!activeUser || Number(activeUser.id) === 0) {
        throw new Error('Please create your account or sign in first.');
      }
      const legs = bodyData.legs || [];
      if (!legs.length) throw new Error('Cannot save an empty accumulator');
      const stake = Math.max(1.0, Number(bodyData.stake || 10.0));
      const ev = evaluateAccaClient(legs, stake);
      const saved = {
        id: gh.nextIds.acca++,
        user_id: activeUser.id,
        name: (bodyData.name || '').trim() || `Draft Acca (${legs.length} legs)`,
        stake,
        legs: cloneJson(legs),
        combined_odds: ev.combined_odds,
        combined_prob: ev.combined_model_prob,
        ev_pct: ev.expected_value_pct,
        created_at: new Date().toISOString(),
      };
      gh.savedAccasByUser[activeUser.id] = [saved, ...cur];
      saveGhState(gh);
      return { ok: true, saved_acca: saved };
    }
  }

  const delAccaMatch = pathname.match(/^\/api\/user\/saved-accas\/(\d+)$/);
  if (delAccaMatch && method === 'DELETE') {
    if (!activeUser || Number(activeUser.id) === 0) {
      throw new Error('Please create your account or sign in first.');
    }
    const accaId = Number(delAccaMatch[1]);
    const cur = gh.savedAccasByUser[activeUser.id] || [];
    const next = cur.filter((a) => Number(a.id) !== accaId);
    if (next.length === cur.length) throw new Error('Saved acca not found');
    gh.savedAccasByUser[activeUser.id] = next;
    saveGhState(gh);
    return { ok: true };
  }

  if (pathname === '/api/backtest') {
    return cloneJson(snap.backtest || { results: [], top_elo_teams: [] });
  }

  if (pathname === '/api/news') {
    const team = (query.get('team') || '').trim().toLowerCase();
    const items = (snap.news || []).filter(
      (n) =>
        !team ||
        (n.matched_teams || []).some((t) => t.toLowerCase().includes(team)) ||
        String(n.title || '').toLowerCase().includes(team)
    );
    return { news: items };
  }

  if (pathname === '/api/alerts') {
    const alerts = (snap.alerts || []).map((a) => (gh.alertsRead ? { ...a, is_read: 1 } : a));
    return { alerts };
  }

  if (pathname === '/api/alerts/mark-read' && method === 'POST') {
    gh.alertsRead = true;
    saveGhState(gh);
    return { ok: true };
  }

  if (pathname === '/api/alerts/test-telegram' && method === 'POST') {
    return { ok: true, message: 'Telegram test alerts require running the local or cloud Flask server with TELEGRAM_BOT_TOKEN.' };
  }

  if (pathname === '/api/sync' && method === 'POST') {
    return {
      ok: true,
      summary: { cached: true, counts: cloneJson(snap.dashboard?.counts || {}) },
      quota: cloneJson(snap.dashboard?.quota || {}),
    };
  }

  throw new Error(`Unsupported static route: ${pathname}`);
}

async function api(path, opts = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const url = path.startsWith('/api/') ? `${path}${sep}user_id=${state.activeUserId}` : path;
  const forceStatic =
    typeof window !== 'undefined' &&
    (window.location.hostname.endsWith('github.io') ||
      window.location.protocol === 'file:' ||
      window.__ACCALAB_STATIC__ === true);

  if (forceStatic && path.startsWith('/api/')) {
    return staticApi(url, opts);
  }

  try {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', 'X-User-Id': String(state.activeUserId) },
      ...opts,
    });
    const ct = res.headers.get('content-type') || '';
    if ((res.status === 404 || res.status === 405) && !ct.includes('application/json') && path.startsWith('/api/')) {
      window.__ACCALAB_STATIC__ = true;
      return staticApi(url, opts);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } catch (err) {
    if (path.startsWith('/api/') && err instanceof TypeError) {
      window.__ACCALAB_STATIC__ = true;
      return staticApi(url, opts);
    }
    throw err;
  }
}

function saveSlip(syncServer = true) {
  localStorage.setItem('accalab_slip', JSON.stringify(state.slip));
  localStorage.setItem('accalab_slip_stake', String(state.slipStake));
  document.getElementById('slip-count-badge').textContent = String(state.slip.length);
  if (syncServer && state.dashboard) {
    api('/api/user/slip', {
      method: 'PUT',
      body: JSON.stringify({ legs: state.slip, stake: state.slipStake }),
    }).catch(() => { });
  }
}

async function toggleWatchFixture(fixtureId) {
  if (!state.activeUserId || Number(state.activeUserId) === 0) {
    showToast('Create your account first to save watchlist matches!');
    openAuthModal('register');
    return;
  }
  try {
    const res = await api('/api/user/watchlist/toggle', {
      method: 'POST',
      body: JSON.stringify({ fixture_id: fixtureId }),
    });
    state.watchedIds = res.watched_fixture_ids || [];
    showToast(res.watched ? 'Match added to your Watchlist ★' : 'Removed from Watchlist');
    await loadDashboard(false);
    renderActiveTab();
  } catch (err) {
    showToast(err.message, true);
    if (Number(state.activeUserId) === 0) openAuthModal('register');
  }
}

async function toggleFavouriteTeam(teamName) {
  if (!state.activeUserId || Number(state.activeUserId) === 0) {
    showToast('Create your account first to save favourite clubs!');
    openAuthModal('register');
    return;
  }
  try {
    const res = await api('/api/user/preferences', {
      method: 'POST',
      body: JSON.stringify({ toggle_team: teamName }),
    });
    state.favouriteTeams = res.user.favourite_teams || [];
    const added = state.favouriteTeams.includes(teamName);
    showToast(added ? `Following ${teamName} ★` : `Unfollowed ${teamName}`);
    await loadDashboard(false);
    renderActiveTab();
  } catch (err) {
    showToast(err.message, true);
    if (Number(state.activeUserId) === 0) openAuthModal('register');
  }
}

function isInSlip(fixtureId, market) {
  return state.slip.some((l) => Number(l.fixture_id) === Number(fixtureId) && l.market === market);
}

function addLegToSlip(leg) {
  const dup = state.slip.find((l) => l.fixture_id === leg.fixture_id && l.market === leg.market);
  if (dup) {
    showToast('Selection already on your Bet Slip');
    return;
  }
  state.slip.push(leg);
  saveSlip();
  renderSlip();
  if (state.activeTab === 'fixtures') renderFixturesTab();
  showToast(`Added ${leg.selection_label} @ ${fmtOdds(leg.odds)}`);
}

function removeLegFromSlip(idx) {
  state.slip.splice(idx, 1);
  saveSlip();
  renderSlip();
  if (state.activeTab === 'acca') renderAccaTab();
  if (state.activeTab === 'fixtures') renderFixturesTab();
}

async function renderSlip() {
  const body = document.getElementById('slip-body');
  const footer = document.getElementById('slip-footer');
  if (!state.slip.length) {
    body.innerHTML = `<div class="text-center py-10 text-slate-400 text-sm">Your slip is empty.<br/>Click any odds button or Value pick to add legs.</div>`;
    footer.innerHTML = '';
    return;
  }
  const evalData = await api('/api/acca/evaluate', {
    method: 'POST',
    body: JSON.stringify({ legs: state.slip, stake: state.slipStake }),
  });

  body.innerHTML = state.slip
    .map(
      (leg, idx) => `
      <div class="p-3 rounded-xl bg-card border border-slate-700/80 flex items-start justify-between gap-2">
        <div>
          <div class="text-xs text-slate-400">${esc(leg.home_team)} vs ${esc(leg.away_team)}</div>
          <div class="text-sm font-semibold text-white mt-0.5">${esc(leg.selection_label)}</div>
          <div class="text-xs text-emerald-400 mt-0.5">Odds: <b class="font-mono">${fmtOdds(leg.odds)}</b> • Model ${(Number(leg.model_prob) * (leg.model_prob > 1 ? 1 : 100)).toFixed(1)}%</div>
        </div>
        <button data-rm-leg="${idx}" class="text-xs px-2 py-1 rounded bg-slate-800 hover:bg-rose-600/30 text-slate-300">✕</button>
      </div>`
    )
    .join('') +
    (evalData.warnings?.length
      ? evalData.warnings
        .map(
          (w) =>
            `<div class="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/40 text-amber-300 text-xs">⚠️ ${esc(w)}</div>`
        )
        .join('')
      : '');

  body.querySelectorAll('[data-rm-leg]').forEach((btn) =>
    btn.addEventListener('click', () => removeLegFromSlip(Number(btn.dataset.rmLeg)))
  );

  const evCls = evalData.expected_value_pct >= 0 ? 'text-emerald-400' : 'text-rose-400';
  footer.innerHTML = `
    <div class="grid grid-cols-2 gap-2 text-xs">
      <div class="text-slate-400">Combined Odds: <b class="text-white font-mono">${fmtOdds(evalData.combined_odds)}</b></div>
      <div class="text-slate-400 text-right">Win Prob: <b class="text-white">${evalData.combined_model_prob_pct}%</b></div>
      <div class="text-slate-400">Expected Value: <b class="${evCls}">${evalData.expected_value_pct >= 0 ? '+' : ''}${evalData.expected_value_pct}%</b></div>
      <div class="text-slate-400 text-right">Est. House Margin: <b class="text-amber-300">${evalData.compounded_margin_pct}%</b></div>
    </div>
    <div class="flex items-center gap-2">
      <label class="text-xs text-slate-400">Stake (£)</label>
      <input id="slip-stake-input" type="number" min="1" step="1" value="${state.slipStake}" class="w-24 bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-sm text-white" />
      <div class="flex-1 text-right text-xs text-slate-300">Returns: <b class="text-emerald-400">${fmtGbp(evalData.potential_return)}</b></div>
    </div>
    <input id="slip-notes-input" type="text" placeholder="Optional note (e.g. Saturday acca)" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white" />
    <div class="flex gap-2">
      <button id="slip-clear-btn" class="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-300">Clear</button>
      <button id="slip-save-draft-btn" class="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold">Save Draft</button>
      <button id="slip-place-btn" class="flex-1 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold">Log Bet</button>
    </div>
    <button id="slip-export-b365-btn" class="w-full py-2.5 rounded-xl btn-bet365 text-xs font-extrabold tracking-wide flex items-center justify-center gap-2">
      <span>🚀 1-Touch Export to Bet365</span>
    </button>
  `;

  document.getElementById('slip-stake-input').addEventListener('change', (e) => {
    state.slipStake = Math.max(1, Number(e.target.value || 10));
    saveSlip();
    renderSlip();
  });
  document.getElementById('slip-clear-btn').addEventListener('click', () => {
    state.slip = [];
    saveSlip();
    renderSlip();
    if (state.activeTab === 'fixtures') renderFixturesTab();
  });
  document.getElementById('slip-export-b365-btn').addEventListener('click', () => {
    const customName = document.getElementById('slip-notes-input').value.trim();
    exportToBet365(state.slip, state.slipStake, customName || 'AccaLab Custom Slip');
  });
  document.getElementById('slip-save-draft-btn').addEventListener('click', async () => {
    if (!state.activeUserId || Number(state.activeUserId) === 0) {
      showToast('Create your account first to save accumulator drafts!');
      openAuthModal('register');
      return;
    }
    try {
      const customName = document.getElementById('slip-notes-input').value.trim();
      const res = await api('/api/user/saved-accas', {
        method: 'POST',
        body: JSON.stringify({
          name: customName || `Saved ${state.slip.length}-Fold (${fmtOdds(evalData.combined_odds)})`,
          stake: state.slipStake,
          legs: state.slip,
        }),
      });
      showToast(`Saved draft "${res.saved_acca.name}" to your account!`);
      if (state.activeTab === 'acca') renderAccaTab();
    } catch (err) {
      showToast(err.message, true);
    }
  });
  document.getElementById('slip-place-btn').addEventListener('click', async () => {
    if (!state.activeUserId || Number(state.activeUserId) === 0) {
      showToast('Create your account first to log bets to your tracker!');
      openAuthModal('register');
      return;
    }
    try {
      const notes = document.getElementById('slip-notes-input').value;
      await api('/api/bets', {
        method: 'POST',
        body: JSON.stringify({ user_id: state.activeUserId, stake: state.slipStake, legs: state.slip, notes }),
      });
      state.slip = [];
      saveSlip();
      renderSlip();
      document.getElementById('slip-drawer').classList.add('hidden');
      showToast('Bet logged to your tracker!');
      loadDashboard(false);
      if (state.activeTab === 'tracker') renderActiveTab();
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

function oddsBadge(source) {
  if (source === 'bet365_official' || source === 'api_football_b365') {
    return `<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">Bet365 Official</span>`;
  }
  if (source === 'user_manual') {
    return `<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-sky-500/20 text-sky-300 border border-sky-500/30">Bet365 Manual</span>`;
  }
  return `<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-700/60 text-slate-300 border border-slate-600">Est. Market</span>`;
}

function formBadges(formStr) {
  if (!formStr) return '<span class="text-slate-500">—</span>';
  return formStr
    .split('')
    .map((ch) => {
      const cls =
        ch === 'W'
          ? 'bg-emerald-500/25 text-emerald-300 border-emerald-500/40'
          : ch === 'D'
            ? 'bg-amber-500/25 text-amber-300 border-amber-500/40'
            : 'bg-rose-500/25 text-rose-300 border-rose-500/40';
      return `<span class="inline-block w-5 h-5 leading-5 text-center rounded text-[10px] font-bold border ${cls}">${esc(ch)}</span>`;
    })
    .join(' ');
}

async function loadDashboard(syncSlipFromServer = true) {
  const d = await api('/api/dashboard');
  state.dashboard = d;
  state.authenticated = Boolean(d.authenticated);
  const activeU = d.active_user || null;
  const hasRealUser = Boolean(activeU && Number(activeU.id) > 0);
  if (hasRealUser) {
    state.activeUserId = Number(activeU.id);
    localStorage.setItem('accalab_user_id', String(state.activeUserId));
    state.favouriteTeams = activeU.favourite_teams || [];
    state.preferredLeagues = activeU.preferred_leagues || ['E0', 'E1', 'E2', 'E3'];
    if (syncSlipFromServer) {
      state.slip = Array.isArray(activeU.active_slip) ? activeU.active_slip : [];
      state.slipStake = Number(activeU.default_stake || 10);
    }
  } else {
    state.activeUserId = 0;
    localStorage.removeItem('accalab_user_id');
    state.favouriteTeams = [];
    state.preferredLeagues = ['E0', 'E1', 'E2', 'E3'];
  }
  state.watchedIds = d.watched_fixture_ids || [];

  const avatarEl = document.getElementById('sidebar-avatar');
  if (avatarEl && activeU) {
    avatarEl.style.backgroundColor = activeU.avatar_color || '#10b981';
    avatarEl.textContent = (activeU.display_name || activeU.username || 'G')
      .trim()
      .slice(0, 2)
      .toUpperCase();
  }
  const usernameEl = document.getElementById('sidebar-username');
  if (usernameEl && activeU) {
    usernameEl.textContent = activeU.display_name || activeU.username || 'Guest';
  }
  const authStatusEl = document.getElementById('sidebar-auth-status');
  if (authStatusEl) {
    if (!hasRealUser) {
      authStatusEl.textContent = 'No account yet • Click to set up';
      authStatusEl.className = 'text-[11px] truncate text-amber-300';
    } else if (state.authenticated) {
      authStatusEl.textContent = 'Signed in • Saved to profile';
      authStatusEl.className = 'text-[11px] truncate text-emerald-400';
    } else {
      authStatusEl.textContent = 'Member profile • Sign in';
      authStatusEl.className = 'text-[11px] truncate text-amber-300';
    }
  }

  const openAuthSidebarBtn = document.getElementById('open-auth-modal-btn');
  if (openAuthSidebarBtn) {
    openAuthSidebarBtn.textContent = hasRealUser ? 'Account' : 'Set Up Account';
  }
  const openAuthMobileBtn = document.getElementById('open-auth-modal-mobile-btn');
  if (openAuthMobileBtn) {
    openAuthMobileBtn.textContent = hasRealUser ? 'Account' : 'Set Up Account';
  }

  const members = d.users || [];
  const optionsHtml = members
    .map(
      (u) =>
        `<option value="${u.id}" ${u.id === state.activeUserId ? 'selected' : ''}>${esc(u.display_name)} (${fmtGbp(u.bankroll)})</option>`
    )
    .join('');
  const switcherWrap = document.getElementById('user-switcher-wrap');
  if (switcherWrap) {
    switcherWrap.classList.toggle('hidden', members.length <= 1);
  }
  const switcherEl = document.getElementById('user-switcher');
  if (switcherEl) switcherEl.innerHTML = optionsHtml;
  const mobileSwitcherEl = document.getElementById('user-switcher-mobile');
  if (mobileSwitcherEl) {
    mobileSwitcherEl.innerHTML = optionsHtml;
    mobileSwitcherEl.classList.toggle('hidden', members.length <= 1);
  }
  document.getElementById('sidebar-bankroll').textContent = fmtGbp(activeU?.bankroll ?? 250);

  const badge = document.getElementById('sidebar-alert-badge');
  if (d.counts.unread_alerts > 0) {
    badge.textContent = String(d.counts.unread_alerts);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  const pnlColor = d.user_summary.total_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400';
  const q = d.quota || {};
  const cacheLabel = q.cache_active ? `Cached (${q.cache_ttl_minutes || 30}m)` : 'Live Sync';
  const afBudgetPill = d.integrations?.api_football_configured
    ? `<span class="px-2.5 py-1 rounded-full bg-card border border-slate-700/80">API Odds: <b class="text-cyan-300 font-mono">${q.api_football?.remaining ?? 100}/100</b></span>`
    : `<span class="px-2.5 py-1 rounded-full bg-card border border-emerald-500/30 text-emerald-300" title="Core feeds are unlimited with a 30-minute smart cache">${cacheLabel} • Unlimited Feeds</span>`;
  document.getElementById('kpi-strip').innerHTML = `
    <span class="px-2.5 py-1 rounded-full bg-card border border-slate-700/80">Matches DB: <b class="text-white font-mono">${d.counts.historical_matches.toLocaleString()}</b></span>
    <span class="px-2.5 py-1 rounded-full bg-card border border-slate-700/80">Upcoming: <b class="text-white font-mono">${d.counts.upcoming_fixtures}</b> (${d.counts.official_b365_fixtures} Bet365)</span>
    <span class="px-2.5 py-1 rounded-full bg-card border border-slate-700/80">Value Picks: <b class="text-emerald-400 font-mono">${d.top_value_bets.length}+</b></span>
    ${afBudgetPill}
    <span class="px-2.5 py-1 rounded-full bg-card border border-slate-700/80">Your P&amp;L: <b class="font-mono ${pnlColor}">${d.user_summary.total_pnl >= 0 ? '+' : ''}${fmtGbp(d.user_summary.total_pnl)}</b></span>
  `;
}

// 1. MATCH PREVIEWS TAB
async function renderFixturesTab() {
  const main = document.getElementById('main-content');
  const q = new URLSearchParams();
  if (state.activeDiv !== 'ALL') q.set('div', state.activeDiv);
  if (state.search) q.set('search', state.search);
  const data = await api(`/api/fixtures?${q.toString()}`);

  const divTabs = [
    ['ALL', 'All Leagues'],
    ['MY_TEAMS', '★ My Teams & Watchlist'],
    ['WATCHLIST', '🔖 Watchlist'],
    ['E0', 'Premier League'],
    ['E1', 'Championship'],
    ['E2', 'League One'],
    ['E3', 'League Two'],
  ];

  const forYou = state.dashboard?.for_you_fixtures || [];
  const forYouHtml =
    forYou.length && state.activeDiv !== 'MY_TEAMS' && state.activeDiv !== 'WATCHLIST'
      ? `
      <div class="bg-gradient-to-r from-amber-500/10 via-emerald-500/10 to-panel border border-amber-500/30 rounded-2xl p-4 space-y-2.5">
        <div class="flex items-center justify-between gap-2">
          <div class="text-xs font-bold uppercase tracking-wider text-amber-300">★ Personalised For You (${forYou.length})</div>
          <button type="button" id="for-you-view-all" class="text-[11px] font-semibold text-emerald-400 hover:underline">Filter My Feed →</button>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
          ${forYou
        .slice(0, 3)
        .map((f) => {
          const best = f.best_edge || {};
          return `
            <div class="p-3 rounded-xl bg-surface/90 border border-slate-800 flex items-center justify-between gap-2">
              <div class="min-w-0">
                <div class="text-[10px] text-emerald-400 font-semibold">${esc(f.league_name)} • ${esc(f.match_date)}</div>
                <div class="text-xs font-bold text-white truncate mt-0.5">${esc(f.home_team)} vs ${esc(f.away_team)}</div>
                <div class="text-[11px] text-slate-400 mt-0.5">${best.edge_pct >= 3 ? `💎 ${esc(best.label)} (+${best.edge_pct}%)` : `P(H/D/A) ${(f.prob_home * 100).toFixed(0)}% / ${(f.prob_draw * 100).toFixed(0)}% / ${(f.prob_away * 100).toFixed(0)}%`}</div>
              </div>
              <button data-open-preview="${f.id}" class="shrink-0 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-emerald-600 text-[11px] font-semibold text-white">Open</button>
            </div>`;
        })
        .join('')}
        </div>
      </div>`
      : '';

  const riskMap = state.dashboard?.featured_by_risk || {};
  const activeRisk = riskMap[state.activeRiskLevel] ? state.activeRiskLevel : 'high';
  const riskTier = riskMap[activeRisk] || null;
  const fs = riskTier?.primary || state.dashboard?.featured_suggestion;
  const riskPillSpecs = [
    ['low', '🟢 Low (1/1–2/1)'],
    ['medium', '🟡 Medium (3/1–7/1)'],
    ['high', '🟠 High (12/1–35/1)'],
    ['longshot', '🔥 Longshot (40/1+)'],
  ];
  const featuredHtml =
    fs && fs.legs?.length
      ? `
      <div class="bg-gradient-to-br from-emerald-500/15 via-panel to-cyan-500/10 border border-emerald-500/35 rounded-2xl p-4 md:p-5 space-y-3 shadow-lg shadow-emerald-950/30">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <span class="px-2.5 py-0.5 rounded-full text-[11px] font-extrabold bg-emerald-500 text-slate-950">✨ Today&apos;s Suggested Bet</span>
            <span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold font-mono bg-card border border-emerald-500/40 text-emerald-300">${fs.confidence_score}% Confidence</span>
            <span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold font-mono bg-card border border-slate-700 text-amber-300">${fs.eval?.expected_value_pct >= 0 ? '+' : ''}${fs.eval?.expected_value_pct ?? 0}% EV</span>
            <span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold font-mono bg-card border border-cyan-500/40 text-cyan-300">${fs.legs.length} ${fs.legs.length === 1 ? 'Leg' : 'Legs'}</span>
          </div>
          ${Object.keys(riskMap).length
        ? `<div class="flex flex-wrap gap-1.5">
                  ${riskPillSpecs
          .map(
            ([rid, rlabel]) => `
                    <button type="button" data-spot-risk="${rid}" class="px-2.5 py-1 rounded-full text-[11px] font-bold border transition ${activeRisk === rid
                ? 'bg-emerald-500 text-slate-950 border-emerald-400 shadow-sm shadow-emerald-500/30'
                : 'bg-surface/90 text-slate-300 border-slate-700 hover:border-slate-500'
              }">${rlabel}</button>`
          )
          .join('')}
                </div>`
        : ''
      }
        </div>
        <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div class="space-y-1 min-w-0">
            <div class="text-base md:text-lg font-extrabold text-white truncate">
              ${fs.legs.length === 1
        ? `${esc(fs.legs[0].selection_label)} <span class="text-emerald-400 font-mono">@ ${fmtOdds(fs.eval?.combined_odds || fs.legs[0].odds)}</span> <span class="text-xs font-medium text-slate-300 ml-1">(${esc(fs.legs[0].home_team)} vs ${esc(fs.legs[0].away_team)})</span>`
        : `${esc(fs.title)} <span class="text-emerald-400 font-mono">@ ${fmtOdds(fs.eval?.combined_odds)}</span> <span class="text-xs font-semibold text-cyan-300 ml-1">• £${Number(fs.stake).toFixed(0)} → ${fmtGbp(fs.eval?.potential_return)}</span>`
      }
            </div>
            <div class="text-xs text-slate-300 truncate">
              ${fs.legs.length === 1
        ? esc((fs.reasons && fs.reasons[0]) || fs.subtitle)
        : fs.legs.map((l) => `${l.selection_label} (${fmtOdds(l.odds)})`).join(' • ')
      }
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2 shrink-0">
            <button type="button" id="feat-export-b365" class="px-4 py-2 rounded-xl btn-bet365 text-xs font-extrabold">🚀 1-Touch Export to Bet365</button>
            <button type="button" id="feat-load-slip" class="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-white">🧾 Add to Slip</button>
            <button type="button" id="feat-open-suggest" class="px-3.5 py-2 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-xs font-semibold text-cyan-200">🎛️ Customize Risk &amp; Picks</button>
          </div>
        </div>
      </div>`
      : '';

  main.innerHTML = `
    <div class="flex flex-col md:flex-row md:items-center justify-between gap-3">
      <div>
        <h2 class="text-xl font-extrabold tracking-tight text-white">Upcoming English Match Previews</h2>
        <p class="text-xs text-slate-400 mt-0.5">Dixon-Coles Poisson + Elo probabilities vs Bet365 &amp; market prices across EPL–League Two</p>
      </div>
      <input id="fixture-search" type="search" value="${esc(state.search)}" placeholder="Search club..." class="w-full md:w-64 bg-panel border border-slate-700/80 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500" />
    </div>

    <div class="flex flex-wrap gap-2">
      ${divTabs
      .map(
        ([code, label]) => `
        <button data-div="${code}" class="div-pill px-3 py-1.5 rounded-xl text-xs font-semibold border transition ${state.activeDiv === code
            ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
            : 'bg-panel text-slate-300 border-slate-700/80 hover:bg-slate-800'
          }">${label}</button>`
      )
      .join('')}
    </div>

    ${featuredHtml}
    ${forYouHtml}

    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      ${data.fixtures.length
      ? data.fixtures
        .map((f) => {
          const best = f.best_edge || {};
          const hasEdge = best.edge_pct >= 3.0;
          const isWatched = Boolean(f.is_watched || state.watchedIds.includes(f.id));
          const homeFav = state.favouriteTeams.includes(f.home_team);
          const awayFav = state.favouriteTeams.includes(f.away_team);
          const isFavMatch = Boolean(f.is_favourite_match || homeFav || awayFav);
          const inH = isInSlip(f.id, '1X2_H');
          const inD = isInSlip(f.id, '1X2_D');
          const inA = isInSlip(f.id, '1X2_A');
          const oddsBtnCls = (on) =>
            on
              ? 'quick-leg py-1.5 rounded-xl bg-emerald-500/20 border border-emerald-400 text-emerald-100 ring-1 ring-emerald-400/40 transition'
              : 'quick-leg py-1.5 rounded-xl bg-card hover:bg-surface border border-slate-700/80 transition';
          return `
          <div class="bg-panel card-hover border ${isFavMatch ? 'border-amber-500/45' : 'border-slate-800/90'} hover:border-emerald-500/40 rounded-2xl p-4 flex flex-col justify-between gap-3">
            <div>
              <div class="flex items-center justify-between gap-2 text-xs">
                <span class="font-semibold text-emerald-400 truncate">${esc(f.league_name)} • ${esc(f.match_date)} ${esc(f.kickoff_time || '')}</span>
                <div class="flex items-center gap-1.5 shrink-0">
                  <button data-watch-fid="${f.id}" title="Save to Watchlist" class="px-2 py-0.5 rounded-full text-[10px] font-semibold border transition ${isWatched
              ? 'bg-amber-500/20 border-amber-400/60 text-amber-200'
              : 'bg-surface border-slate-700 text-slate-400 hover:text-white'
            }">${isWatched ? '🔖 Saved' : '☆ Watch'}</button>
                  ${oddsBadge(f.odds_source)}
                </div>
              </div>
              <div class="mt-2.5 flex items-center justify-between gap-2">
                <div class="min-w-0">
                  <div class="font-bold text-white truncate flex items-center gap-1">
                    <button data-fav-team="${esc(f.home_team)}" title="Follow ${esc(f.home_team)}" class="text-xs leading-none ${homeFav ? 'text-amber-300' : 'text-slate-600 hover:text-amber-300'}">${homeFav ? '★' : '☆'}</button>
                    <span class="truncate">${esc(f.home_team)}</span>
                    <span class="text-xs font-normal font-mono text-slate-400">(${Math.round(f.home_elo || 1500)})</span>
                  </div>
                  <div class="mt-1">${formBadges(f.home_form)}</div>
                </div>
                <div class="text-xs font-bold text-slate-500 px-2">vs</div>
                <div class="min-w-0 text-right">
                  <div class="font-bold text-white truncate flex items-center justify-end gap-1">
                    <span class="text-xs font-normal font-mono text-slate-400">(${Math.round(f.away_elo || 1500)})</span>
                    <span class="truncate">${esc(f.away_team)}</span>
                    <button data-fav-team="${esc(f.away_team)}" title="Follow ${esc(f.away_team)}" class="text-xs leading-none ${awayFav ? 'text-amber-300' : 'text-slate-600 hover:text-amber-300'}">${awayFav ? '★' : '☆'}</button>
                  </div>
                  <div class="mt-1 flex justify-end gap-1">${formBadges(f.away_form)}</div>
                </div>
              </div>

              <!-- Probability Bar -->
              <div class="mt-3">
                <div class="flex justify-between text-[11px] text-slate-400 mb-1 font-mono">
                  <span>H ${(f.prob_home * 100).toFixed(0)}%</span>
                  <span>D ${(f.prob_draw * 100).toFixed(0)}%</span>
                  <span>A ${(f.prob_away * 100).toFixed(0)}%</span>
                </div>
                <div class="h-2 rounded-full overflow-hidden flex bg-slate-800">
                  <div style="width:${f.prob_home * 100}%" class="bg-emerald-500"></div>
                  <div style="width:${f.prob_draw * 100}%" class="bg-amber-400"></div>
                  <div style="width:${f.prob_away * 100}%" class="bg-cyan-500"></div>
                </div>
              </div>

              <!-- Quick Bet365 / Market Buttons -->
              <div class="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                <button data-add-leg='${esc(JSON.stringify({ fixture_id: f.id, div: f.div, match_date: f.match_date, home_team: f.home_team, away_team: f.away_team, market: "1X2_H", selection_label: `${f.home_team} Win`, odds: f.b365h, model_prob: f.prob_home }))}' class="${oddsBtnCls(inH)}">
                  <div class="text-[10px] ${inH ? 'text-emerald-300 font-semibold' : 'text-slate-400'}">${inH ? '✓ Home' : 'Home'}</div>
                  <div class="font-bold font-mono text-white">${f.b365h ? fmtOdds(f.b365h) : '—'}</div>
                </button>
                <button data-add-leg='${esc(JSON.stringify({ fixture_id: f.id, div: f.div, match_date: f.match_date, home_team: f.home_team, away_team: f.away_team, market: "1X2_D", selection_label: "Draw", odds: f.b365d, model_prob: f.prob_draw }))}' class="${oddsBtnCls(inD)}">
                  <div class="text-[10px] ${inD ? 'text-emerald-300 font-semibold' : 'text-slate-400'}">${inD ? '✓ Draw' : 'Draw'}</div>
                  <div class="font-bold font-mono text-white">${f.b365d ? fmtOdds(f.b365d) : '—'}</div>
                </button>
                <button data-add-leg='${esc(JSON.stringify({ fixture_id: f.id, div: f.div, match_date: f.match_date, home_team: f.home_team, away_team: f.away_team, market: "1X2_A", selection_label: `${f.away_team} Win`, odds: f.b365a, model_prob: f.prob_away }))}' class="${oddsBtnCls(inA)}">
                  <div class="text-[10px] ${inA ? 'text-emerald-300 font-semibold' : 'text-slate-400'}">${inA ? '✓ Away' : 'Away'}</div>
                  <div class="font-bold font-mono text-white">${f.b365a ? fmtOdds(f.b365a) : '—'}</div>
                </button>
              </div>
            </div>

            <div class="pt-2 border-t border-slate-800/80 flex items-center justify-between gap-2 text-xs">
              <div class="${hasEdge ? 'text-emerald-400 font-semibold' : 'text-slate-400'}">
                ${hasEdge ? `💎 Best Edge: ${esc(best.label)} (+${best.edge_pct}%)` : `xG ${f.lambda_home.toFixed(2)} – ${f.mu_away.toFixed(2)} • O2.5 ${(f.prob_over25 * 100).toFixed(0)}%`}
              </div>
              <button data-open-preview="${f.id}" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-emerald-600 text-white font-medium transition">Preview →</button>
            </div>
          </div>`;
        })
        .join('')
      : `<div class="col-span-2 text-center py-12 text-slate-400">No fixtures match your filter.</div>`
    }
    </div>
  `;

  document.querySelectorAll('[data-spot-risk]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.activeRiskLevel = btn.dataset.spotRisk;
      localStorage.setItem('accalab_risk_level', state.activeRiskLevel);
      renderFixturesTab();
    })
  );

  if (fs && fs.legs?.length) {
    document.getElementById('feat-export-b365')?.addEventListener('click', () =>
      exportToBet365(fs.legs, fs.stake, fs.title)
    );
    document.getElementById('feat-load-slip')?.addEventListener('click', () => {
      state.slip = fs.legs.map((l) => ({ ...l }));
      state.slipStake = Number(fs.stake || state.slipStake || 10);
      saveSlip();
      renderSlip();
      renderFixturesTab();
      document.getElementById('slip-drawer').classList.remove('hidden');
      showToast('Suggested bet added to your Bet Slip!');
    });
    document.getElementById('feat-open-suggest')?.addEventListener('click', () => openSuggestModal(activeRisk));
  }

  document.getElementById('for-you-view-all')?.addEventListener('click', () => {
    state.activeDiv = 'MY_TEAMS';
    renderFixturesTab();
  });
  document.querySelectorAll('.div-pill').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.activeDiv = btn.dataset.div;
      renderFixturesTab();
    })
  );
  document.getElementById('fixture-search').addEventListener('input', (e) => {
    state.search = e.target.value;
    clearTimeout(window._searchTimer);
    window._searchTimer = setTimeout(renderFixturesTab, 250);
  });
  document.querySelectorAll('[data-watch-fid]').forEach((btn) =>
    btn.addEventListener('click', () => toggleWatchFixture(Number(btn.dataset.watchFid)))
  );
  document.querySelectorAll('[data-fav-team]').forEach((btn) =>
    btn.addEventListener('click', () => toggleFavouriteTeam(btn.dataset.favTeam))
  );
  document.querySelectorAll('.quick-leg').forEach((btn) =>
    btn.addEventListener('click', () => {
      const leg = JSON.parse(btn.dataset.addLeg);
      if (leg.odds) addLegToSlip(leg);
    })
  );
  document.querySelectorAll('[data-open-preview]').forEach((btn) =>
    btn.addEventListener('click', () => openMatchPreview(Number(btn.dataset.openPreview)))
  );
}

async function openMatchPreview(fixtureId) {
  const modal = document.getElementById('preview-modal');
  const body = document.getElementById('preview-modal-body');
  modal.classList.remove('hidden');
  body.innerHTML = '<div class="text-slate-400 text-sm">Loading match intelligence...</div>';

  const d = await api(`/api/fixture/${fixtureId}`);
  const f = d.fixture;
  document.getElementById('modal-league-tag').textContent = `${f.league_name} • ${f.match_date} ${f.kickoff_time || ''} • ${f.venue || ''}`;
  document.getElementById('modal-match-title').textContent = `${f.home_team} vs ${f.away_team}`;

  const isWatched = state.watchedIds.includes(f.id);
  const homeFav = state.favouriteTeams.includes(f.home_team);
  const awayFav = state.favouriteTeams.includes(f.away_team);

  const heatmapRows = d.score_heatmap
    .map(
      (row, hGoals) => `
      <tr>
        <th class="p-1.5 text-slate-400 text-[11px] font-semibold">${hGoals}</th>
        ${row
          .map((val) => {
            const intensity = Math.min(0.85, val / 16.0);
            return `<td class="p-1.5 text-center rounded text-[11px] font-mono border border-slate-800" style="background:rgba(16,185,129,${intensity.toFixed(2)})">${val.toFixed(1)}%</td>`;
          })
          .join('')}
      </tr>`
    )
    .join('');

  const standingsRows = d.standings
    .filter((t) => t.team_name === f.home_team || t.team_name === f.away_team || t.pos <= 6)
    .slice(0, 10)
    .map(
      (t) => `
      <tr class="${t.team_name === f.home_team || t.team_name === f.away_team ? 'bg-emerald-500/15 font-semibold text-white' : 'text-slate-300'} border-b border-slate-800/70">
        <td class="py-1.5 px-2">${t.pos}</td>
        <td class="py-1.5 px-2">${esc(t.team_name)}</td>
        <td class="py-1.5 px-2 text-center">${t.matches_played}</td>
        <td class="py-1.5 px-2 text-center">${t.gd >= 0 ? '+' : ''}${t.gd}</td>
        <td class="py-1.5 px-2 text-center font-bold">${t.points}</td>
        <td class="py-1.5 px-2 text-right font-mono">${Math.round(t.elo)}</td>
      </tr>`
    )
    .join('');

  body.innerHTML = `
    <!-- Quick Personalisation Actions -->
    <div class="flex flex-wrap items-center gap-2 text-xs">
      <button id="modal-watch-btn" type="button" class="px-3 py-1.5 rounded-lg border font-semibold transition ${isWatched
      ? 'bg-amber-500/20 border-amber-400 text-amber-200'
      : 'bg-card border-slate-700 text-slate-300 hover:border-slate-500'
    }">${isWatched ? '🔖 In Watchlist' : '☆ Watch Match'}</button>
      <button type="button" data-modal-fav="${esc(f.home_team)}" class="px-3 py-1.5 rounded-lg border font-semibold transition ${homeFav
      ? 'bg-amber-500/20 border-amber-400 text-amber-200'
      : 'bg-card border-slate-700 text-slate-300 hover:border-slate-500'
    }">${homeFav ? '★ Following' : '☆ Follow'} ${esc(f.home_team)}</button>
      <button type="button" data-modal-fav="${esc(f.away_team)}" class="px-3 py-1.5 rounded-lg border font-semibold transition ${awayFav
      ? 'bg-amber-500/20 border-amber-400 text-amber-200'
      : 'bg-card border-slate-700 text-slate-300 hover:border-slate-500'
    }">${awayFav ? '★ Following' : '☆ Follow'} ${esc(f.away_team)}</button>
    </div>

    <!-- AI & Analyst Summary -->
    <div class="p-4 rounded-xl bg-card border border-emerald-500/30 space-y-2">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-bold uppercase tracking-wider text-emerald-400">✨ Grounded Match Summary (${esc(f.ai_summary_source)})</span>
        <button id="regen-summary-btn" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200">↻ Refresh AI Summary</button>
      </div>
      <p id="ai-summary-text" class="text-sm text-slate-200 leading-relaxed">${esc(f.ai_summary)}</p>
      <div class="flex flex-wrap gap-2 pt-1">
        ${(f.tipster_consensus?.signals || [])
      .map(
        (s) =>
          `<span class="px-2.5 py-1 rounded-lg bg-slate-900 border border-slate-700 text-[11px]"><b class="text-slate-300">${esc(s.name)}:</b> <span class="text-emerald-300">${esc(s.pick)}</span> <span class="text-slate-400">(${esc(s.detail)})</span></span>`
      )
      .join('')}
      </div>
    </div>

    <!-- Model vs Bet365 Markets -->
    <div>
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-sm font-bold text-white">Model vs Bet365 / Market Prices ${oddsBadge(f.odds_source)}</h3>
        <span class="text-xs text-slate-400">Overround: 1X2 ${d.overround_1x2_pct}% | O/U ${d.overround_ou25_pct}%</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-xs text-left">
          <thead class="text-slate-400 border-b border-slate-800">
            <tr>
              <th class="py-2 pr-2">Selection</th>
              <th class="py-2 px-2 text-right">Model %</th>
              <th class="py-2 px-2 text-right">Fair Odds</th>
              <th class="py-2 px-2 text-right">Bet365</th>
              <th class="py-2 px-2 text-right">Edge %</th>
              <th class="py-2 px-2 text-right">¼ Kelly</th>
              <th class="py-2 pl-2 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            ${d.markets
      .map((m) => {
        const edgeCls = m.edge_pct >= 3 ? 'text-emerald-400 font-bold' : m.edge_pct >= 0 ? 'text-amber-300' : 'text-slate-400';
        return `
              <tr class="border-b border-slate-800/60">
                <td class="py-2 pr-2 font-medium text-white">${esc(m.label)}</td>
                <td class="py-2 px-2 text-right">${m.model_prob_pct}%</td>
                <td class="py-2 px-2 text-right font-mono">${fmtOdds(m.fair_odds)}</td>
                <td class="py-2 px-2 text-right font-mono font-bold text-white">${m.b365_odds ? fmtOdds(m.b365_odds) : '—'}</td>
                <td class="py-2 px-2 text-right ${edgeCls}">${m.edge_pct >= 0 ? '+' : ''}${m.edge_pct}%</td>
                <td class="py-2 px-2 text-right text-slate-300">${m.suggested_stake > 0 ? fmtGbp(m.suggested_stake) : '—'}</td>
                <td class="py-2 pl-2 text-right">
                  ${m.b365_odds
            ? `<button data-modal-leg='${esc(JSON.stringify({ fixture_id: f.id, div: f.div, match_date: f.match_date, home_team: f.home_team, away_team: f.away_team, market: m.market, selection_label: m.label, odds: m.b365_odds, model_prob: m.model_prob_pct / 100 }))}' class="modal-add-leg px-2.5 py-1 rounded bg-emerald-600/80 hover:bg-emerald-500 text-white">+ Slip</button>`
            : ''
          }
                </td>
              </tr>`;
      })
      .join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Team Splits & Score Matrix -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div class="p-4 rounded-xl bg-card border border-slate-800 space-y-2 text-xs">
        <h4 class="font-bold text-white text-sm">Home/Away Form &amp; Shot Metrics</h4>
        <div class="grid grid-cols-2 gap-3 pt-1">
          <div>
            <div class="font-semibold text-emerald-400">${esc(f.home_team)} (Home)</div>
            <div class="text-slate-300 mt-1">Last 6 Home: ${d.home_split.w}W-${d.home_split.d}D-${d.home_split.l}L</div>
            <div class="text-slate-400">GF/GA: ${d.home_split.avg_gf} / ${d.home_split.avg_ga} per game</div>
            <div class="text-slate-400">Season SoT/g: ${d.home_rating.sot_for_pg ?? '—'} vs ${d.home_rating.sot_against_pg ?? '—'}</div>
          </div>
          <div>
            <div class="font-semibold text-sky-400">${esc(f.away_team)} (Away)</div>
            <div class="text-slate-300 mt-1">Last 6 Away: ${d.away_split.w}W-${d.away_split.d}D-${d.away_split.l}L</div>
            <div class="text-slate-400">GF/GA: ${d.away_split.avg_gf} / ${d.away_split.avg_ga} per game</div>
            <div class="text-slate-400">Season SoT/g: ${d.away_rating.sot_for_pg ?? '—'} vs ${d.away_rating.sot_against_pg ?? '—'}</div>
          </div>
        </div>
        <div class="pt-2 border-t border-slate-800">
          <div class="font-semibold text-slate-300 mb-1">Recent Head-to-Head</div>
          ${d.h2h.length
      ? d.h2h
        .map(
          (h) =>
            `<div class="text-slate-400 flex justify-between"><span>${esc(h.match_date)}</span><span class="text-slate-200">${esc(h.home_team)} ${h.fthg}–${h.ftag} ${esc(h.away_team)}</span></div>`
        )
        .join('')
      : '<div class="text-slate-500">No league H2H in 24/25–26/27 dataset.</div>'
    }
        </div>
      </div>

      <div class="p-4 rounded-xl bg-card border border-slate-800">
        <h4 class="font-bold text-white text-sm mb-2">Dixon-Coles Scoreline Matrix (Home rows × Away cols)</h4>
        <table class="w-full">
          <thead>
            <tr class="text-[11px] text-slate-400"><th></th><th>0</th><th>1</th><th>2</th><th>3</th><th>4</th></tr>
          </thead>
          <tbody>${heatmapRows}</tbody>
        </table>
      </div>
    </div>

    <!-- Update Bet365 Live Odds Manually + Matched News + Table -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div class="p-4 rounded-xl bg-card border border-slate-800 space-y-3">
        <h4 class="font-bold text-white text-sm">Update Live Bet365 Odds (Fractional e.g. 6/4 or Decimal)</h4>
        <div class="grid grid-cols-3 gap-2 text-xs">
          <label>Home <input id="edit-b365h" type="text" placeholder="e.g. 6/4" value="${f.b365h ? fmtOdds(f.b365h) : ''}" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-white font-mono"/></label>
          <label>Draw <input id="edit-b365d" type="text" placeholder="e.g. 9/4" value="${f.b365d ? fmtOdds(f.b365d) : ''}" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-white font-mono"/></label>
          <label>Away <input id="edit-b365a" type="text" placeholder="e.g. 5/2" value="${f.b365a ? fmtOdds(f.b365a) : ''}" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-white font-mono"/></label>
          <label>O2.5 <input id="edit-b365o25" type="text" placeholder="e.g. 4/5" value="${f.b365_over25 ? fmtOdds(f.b365_over25) : ''}" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-white font-mono"/></label>
          <label>U2.5 <input id="edit-b365u25" type="text" placeholder="e.g. 1/1" value="${f.b365_under25 ? fmtOdds(f.b365_under25) : ''}" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-white font-mono"/></label>
          <label>BTTS Y <input id="edit-b365by" type="text" placeholder="e.g. 4/6" value="${f.b365_btts_yes ? fmtOdds(f.b365_btts_yes) : ''}" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-white font-mono"/></label>
        </div>
        <button id="save-odds-btn" class="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold">Save Bet365 Odds &amp; Recalculate Edge</button>

        <div class="pt-2 border-t border-slate-800 space-y-1.5">
          <h5 class="font-semibold text-white text-xs">Club News (BBC / Sky / Guardian RSS)</h5>
          ${d.matched_news.length
      ? d.matched_news
        .map(
          (n) =>
            `<a href="${esc(n.url)}" target="_blank" rel="noopener" class="block text-xs text-emerald-300 hover:underline">[${esc(n.source)}] ${esc(n.title)}</a>`
        )
        .join('')
      : '<div class="text-xs text-slate-500">No club headlines matched in latest RSS window.</div>'
    }
        </div>
      </div>

      <div class="p-4 rounded-xl bg-card border border-slate-800">
        <h4 class="font-bold text-white text-sm mb-2">${esc(f.league_name)} Standings Snapshot</h4>
        <table class="w-full text-xs">
          <thead class="text-slate-400 border-b border-slate-800">
            <tr><th class="py-1 px-2 text-left">#</th><th class="py-1 px-2 text-left">Team</th><th class="py-1 px-2">P</th><th class="py-1 px-2">GD</th><th class="py-1 px-2">Pts</th><th class="py-1 px-2 text-right">Elo</th></tr>
          </thead>
          <tbody>${standingsRows}</tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('modal-watch-btn').addEventListener('click', async () => {
    await toggleWatchFixture(fixtureId);
    openMatchPreview(fixtureId);
  });
  body.querySelectorAll('[data-modal-fav]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await toggleFavouriteTeam(btn.dataset.modalFav);
      openMatchPreview(fixtureId);
    })
  );

  body.querySelectorAll('.modal-add-leg').forEach((btn) =>
    btn.addEventListener('click', () => addLegToSlip(JSON.parse(btn.dataset.modalLeg)))
  );

  document.getElementById('regen-summary-btn').addEventListener('click', async () => {
    const res = await api(`/api/fixture/${fixtureId}/ai-summary`, { method: 'POST', body: '{}' });
    document.getElementById('ai-summary-text').textContent = res.ai_summary;
    showToast(`Summary refreshed (${res.ai_summary_source})`);
  });

  document.getElementById('save-odds-btn').addEventListener('click', async () => {
    await api(`/api/fixture/${fixtureId}/odds`, {
      method: 'POST',
      body: JSON.stringify({
        b365h: document.getElementById('edit-b365h').value,
        b365d: document.getElementById('edit-b365d').value,
        b365a: document.getElementById('edit-b365a').value,
        b365_over25: document.getElementById('edit-b365o25').value,
        b365_under25: document.getElementById('edit-b365u25').value,
        b365_btts_yes: document.getElementById('edit-b365by').value,
      }),
    });
    showToast('Bet365 odds updated!');
    openMatchPreview(fixtureId);
    if (state.activeTab === 'fixtures' || state.activeTab === 'value') renderActiveTab();
  });
}

// 2. VALUE FINDER TAB
async function renderValueTab() {
  const main = document.getElementById('main-content');
  const minEdge = document.getElementById('val-min-edge')?.value || '3';
  const officialOnly = document.getElementById('val-official-only')?.checked ? '1' : '0';
  const div = document.getElementById('val-div-filter')?.value || '';

  const q = new URLSearchParams({ min_edge: minEdge, official_only: officialOnly });
  if (div) q.set('div', div);
  const data = await api(`/api/value-bets?${q.toString()}`);

  const opps = state.valMyPrefsOnly
    ? (data.opportunities || []).filter(
      (o) =>
        state.preferredLeagues.includes(o.div) ||
        state.favouriteTeams.includes(o.home_team) ||
        state.favouriteTeams.includes(o.away_team)
    )
    : data.opportunities || [];

  main.innerHTML = `
    <div class="flex flex-col md:flex-row md:items-center justify-between gap-3">
      <div>
        <h2 class="text-xl font-bold text-white">💎 Value Bet Finder</h2>
        <p class="text-xs text-slate-400">Edge = (Model Prob × Bet365 Odds) − 1 • Staked with your ¼ Kelly rule (Bankroll ${fmtGbp(data.bankroll)})</p>
      </div>
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <select id="val-div-filter" class="bg-panel border border-slate-700 rounded-lg px-2.5 py-1.5 text-white">
          <option value="">All Leagues</option>
          <option value="E0" ${div === 'E0' ? 'selected' : ''}>Premier League</option>
          <option value="E1" ${div === 'E1' ? 'selected' : ''}>Championship</option>
          <option value="E2" ${div === 'E2' ? 'selected' : ''}>League One</option>
          <option value="E3" ${div === 'E3' ? 'selected' : ''}>League Two</option>
        </select>
        <select id="val-min-edge" class="bg-panel border border-slate-700 rounded-lg px-2.5 py-1.5 text-white">
          <option value="2" ${minEdge === '2' ? 'selected' : ''}>Min Edge +2%</option>
          <option value="3" ${minEdge === '3' ? 'selected' : ''}>Min Edge +3%</option>
          <option value="5" ${minEdge === '5' ? 'selected' : ''}>Min Edge +5%</option>
          <option value="8" ${minEdge === '8' ? 'selected' : ''}>Min Edge +8%</option>
        </select>
        <label class="flex items-center gap-1.5 bg-panel border border-slate-700 rounded-lg px-2.5 py-1.5 cursor-pointer">
          <input id="val-official-only" type="checkbox" ${officialOnly === '1' ? 'checked' : ''} class="accent-emerald-500" />
          <span>Official Bet365 Only</span>
        </label>
        <label class="flex items-center gap-1.5 bg-panel border border-amber-500/40 rounded-lg px-2.5 py-1.5 cursor-pointer text-amber-200">
          <input id="val-my-prefs" type="checkbox" ${state.valMyPrefsOnly ? 'checked' : ''} class="accent-amber-400" />
          <span>★ My Leagues &amp; Teams</span>
        </label>
      </div>
    </div>

    <div class="bg-panel border border-slate-800 rounded-2xl overflow-x-auto">
      <table class="w-full text-xs text-left">
        <thead class="text-slate-400 border-b border-slate-800 bg-slate-900/60">
          <tr>
            <th class="p-3">Fixture</th>
            <th class="p-3">Selection</th>
            <th class="p-3 text-right">Bet365</th>
            <th class="p-3 text-right">Model % (Fair)</th>
            <th class="p-3 text-right">Edge</th>
            <th class="p-3 text-right">Suggested Stake</th>
            <th class="p-3">Source / Trust</th>
            <th class="p-3 text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          ${opps.length
      ? opps
        .map((o) => {
          const isFav =
            state.favouriteTeams.includes(o.home_team) ||
            state.favouriteTeams.includes(o.away_team);
          return `
              <tr class="border-b border-slate-800/70 hover:bg-slate-800/30 ${isFav ? 'bg-amber-500/5' : ''}">
                <td class="p-3">
                  <div class="font-semibold text-white flex items-center gap-1.5">
                    ${isFav ? '<span class="text-amber-300" title="Followed club">★</span>' : ''}
                    <span>${esc(o.home_team)} vs ${esc(o.away_team)}</span>
                  </div>
                  <div class="text-[11px] text-slate-400">${esc(o.league_name)} • ${esc(o.match_date)}</div>
                </td>
                <td class="p-3 font-medium text-emerald-300">${esc(o.selection_label)}</td>
                <td class="p-3 text-right font-mono font-bold text-white">${fmtOdds(o.odds)}</td>
                <td class="p-3 text-right">${o.model_prob_pct}% <span class="text-slate-400 font-mono">(${fmtOdds(o.fair_odds)})</span></td>
                <td class="p-3 text-right font-bold text-emerald-400">+${o.edge_pct}%</td>
                <td class="p-3 text-right font-semibold text-white">${fmtGbp(o.suggested_stake)} <span class="text-slate-400">(${o.kelly_pct}%)</span></td>
                <td class="p-3 space-y-1">
                  <div>${oddsBadge(o.odds_source)}</div>
                  <div class="text-[10px] text-slate-400">${esc(o.trust_badge)}${o.backtest_roi_pct !== null ? ` (${o.backtest_roi_pct > 0 ? '+' : ''}${o.backtest_roi_pct}% ROI)` : ''}</div>
                </td>
                <td class="p-3 text-right">
                  <button data-val-leg='${esc(JSON.stringify({ fixture_id: o.fixture_id, div: o.div, match_date: o.match_date, home_team: o.home_team, away_team: o.away_team, market: o.market, selection_label: o.selection_label, odds: o.odds, model_prob: o.model_prob_pct / 100 }))}' class="val-add-leg px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold">+ Slip</button>
                </td>
              </tr>`;
        })
        .join('')
      : `<tr><td colspan="8" class="p-8 text-center text-slate-400">No selections exceed +${minEdge}% edge under the current filter.</td></tr>`
    }
        </tbody>
      </table>
    </div>
  `;

  ['val-div-filter', 'val-min-edge', 'val-official-only'].forEach((id) =>
    document.getElementById(id).addEventListener('change', renderValueTab)
  );
  document.getElementById('val-my-prefs').addEventListener('change', (e) => {
    state.valMyPrefsOnly = e.target.checked;
    renderValueTab();
  });
  document.querySelectorAll('.val-add-leg').forEach((btn) =>
    btn.addEventListener('click', () => addLegToSlip(JSON.parse(btn.dataset.valLeg)))
  );
}

// 3. ACCA BUILDER TAB
async function renderAccaTab() {
  const main = document.getElementById('main-content');
  const [data, savedRes] = await Promise.all([api('/api/acca/presets'), api('/api/user/saved-accas')]);
  const savedAccas = savedRes.saved_accas || [];
  const slipEval = state.slip.length
    ? await api('/api/acca/evaluate', { method: 'POST', body: JSON.stringify({ legs: state.slip, stake: state.slipStake }) })
    : null;

  main.innerHTML = `
    <div>
      <h2 class="text-xl font-bold text-white">🧮 Smart Acca Builder</h2>
      <p class="text-xs text-slate-400">Builds uncorrelated accumulators and warns when legs compound bookmaker margin or share a fixture.</p>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
      ${data.presets
      .map(
        (p) => `
        <div class="bg-panel card-hover border border-slate-800 rounded-2xl p-4 flex flex-col justify-between gap-3">
          <div>
            <div class="flex justify-between items-start gap-2">
              <h3 class="font-bold text-white text-base">${esc(p.title)}</h3>
              <span class="px-2 py-0.5 rounded-full text-xs font-bold ${p.expected_value_pct >= 0 ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}">${p.expected_value_pct >= 0 ? '+' : ''}${p.expected_value_pct}% EV</span>
            </div>
            <p class="text-xs text-slate-400 mt-1">${esc(p.subtitle)}</p>
            <div class="mt-3 space-y-2">
              ${p.legs
            .map(
              (l) => `
                <div class="p-2 rounded-lg bg-card border border-slate-700/70 text-xs flex justify-between gap-2">
                  <div>
                    <div class="text-slate-400">${esc(l.home_team)} vs ${esc(l.away_team)}</div>
                    <div class="font-semibold text-white">${esc(l.selection_label)}</div>
                  </div>
                  <div class="text-right font-mono">
                    <div class="text-emerald-400 font-bold">${fmtOdds(l.odds)}</div>
                    <div class="text-[10px] text-slate-400">${(l.model_prob * 100).toFixed(0)}%</div>
                  </div>
                </div>`
            )
            .join('')}
            </div>
          </div>
          <div class="pt-3 border-t border-slate-800 space-y-2 text-xs">
            <div class="flex justify-between">
              <span class="text-slate-400">Combined Odds: <b class="text-white font-mono">${fmtOdds(p.combined_odds)}</b></span>
              <span class="text-slate-400">Hit Prob: <b class="text-white font-mono">${p.combined_model_prob_pct}%</b></span>
            </div>
            <div class="flex gap-2">
              <button data-load-preset='${esc(JSON.stringify(p.legs))}' class="load-preset-btn flex-1 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold">Load Slip</button>
              <button data-export-preset='${esc(JSON.stringify({ legs: p.legs, title: p.title }))}' class="export-preset-btn px-3 py-2 rounded-xl btn-bet365 font-extrabold">🚀 Bet365</button>
            </div>
          </div>
        </div>`
      )
      .join('')}
    </div>

    <!-- Saved Draft Accas -->
    <div class="bg-panel border border-slate-800 rounded-2xl p-5 space-y-3">
      <div class="flex items-center justify-between gap-2">
        <h3 class="font-bold text-white text-base">💾 Saved Draft Accas (${savedAccas.length})</h3>
        <span class="text-xs text-slate-400">Saved to your account across devices</span>
      </div>
      ${savedAccas.length
      ? `<div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              ${savedAccas
        .map(
          (a) => `
                <div class="p-3.5 rounded-xl bg-card card-hover border border-slate-800 flex flex-col justify-between gap-2.5 text-xs">
                  <div>
                    <div class="flex items-center justify-between gap-2">
                      <span class="font-bold text-white truncate">${esc(a.name)}</span>
                      <span class="px-2 py-0.5 rounded-full font-bold ${a.ev_pct >= 0 ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}">${a.ev_pct >= 0 ? '+' : ''}${Number(a.ev_pct).toFixed(1)}% EV</span>
                    </div>
                    <div class="text-[11px] text-slate-400 mt-1">${(a.legs || []).length} legs • Combined <b class="text-emerald-400 font-mono">${fmtOdds(a.combined_odds)}</b> • Stake ${fmtGbp(a.stake)} • Saved ${esc((a.created_at || '').slice(0, 10))}</div>
                    <div class="mt-2 space-y-1">
                      ${(a.legs || [])
              .map(
                (l) => `<div class="text-[11px] text-slate-300 flex justify-between gap-2"><span class="truncate">${esc(l.selection_label)} (${esc(l.home_team)} vs ${esc(l.away_team)})</span><span class="font-mono text-slate-400">@ ${fmtOdds(l.odds)}</span></div>`
              )
              .join('')}
                    </div>
                  </div>
                  <div class="flex gap-2 pt-2 border-t border-slate-800">
                    <button type="button" data-load-saved='${esc(JSON.stringify({ legs: a.legs, stake: a.stake }))}' class="flex-1 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold">Load</button>
                    <button type="button" data-export-saved='${esc(JSON.stringify({ legs: a.legs, stake: a.stake, title: a.name }))}' class="px-3 py-1.5 rounded-lg btn-bet365 font-extrabold">🚀 Bet365</button>
                    <button type="button" data-del-saved="${a.id}" class="px-3 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 border border-rose-500/30 text-rose-300 font-semibold">Delete</button>
                  </div>
                </div>`
        )
        .join('')}
            </div>`
      : '<p class="text-xs text-slate-400">No saved drafts yet. Add legs to your Bet Slip drawer and click <b>Save Draft</b>.</p>'
    }
    </div>

    <div class="bg-panel border border-slate-800 rounded-2xl p-5">
      <h3 class="font-bold text-white text-base mb-2">Current Custom Slip Diagnostics</h3>
      ${slipEval
      ? `
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mb-3">
          <div class="p-3 rounded-xl bg-card border border-slate-800"><div class="text-slate-400">Legs</div><div class="text-lg font-bold text-white">${slipEval.leg_count}</div></div>
          <div class="p-3 rounded-xl bg-card border border-slate-800"><div class="text-slate-400">Combined Odds</div><div class="text-lg font-bold font-mono text-emerald-400">${fmtOdds(slipEval.combined_odds)}</div></div>
          <div class="p-3 rounded-xl bg-card border border-slate-800"><div class="text-slate-400">Model Fair Odds</div><div class="text-lg font-bold font-mono text-white">${fmtOdds(slipEval.fair_combined_odds)}</div></div>
          <div class="p-3 rounded-xl bg-card border border-slate-800"><div class="text-slate-400">Compounded Margin</div><div class="text-lg font-bold text-amber-300">${slipEval.compounded_margin_pct}%</div></div>
        </div>
        <button id="open-slip-inline" class="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold">Open Slip to Place Bet</button>
      `
      : '<p class="text-xs text-slate-400">Load any preset above or add legs from Match Previews / Value Finder.</p>'
    }
    </div>
  `;

  document.querySelectorAll('.load-preset-btn').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.slip = JSON.parse(btn.dataset.loadPreset);
      saveSlip();
      renderSlip();
      renderAccaTab();
      document.getElementById('slip-drawer').classList.remove('hidden');
      showToast('Loaded accumulator preset into slip!');
    })
  );
  document.querySelectorAll('.export-preset-btn').forEach((btn) =>
    btn.addEventListener('click', () => {
      const payload = JSON.parse(btn.dataset.exportPreset);
      exportToBet365(payload.legs || [], state.slipStake, payload.title || 'AccaLab Preset');
    })
  );
  document.querySelectorAll('[data-load-saved]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const payload = JSON.parse(btn.dataset.loadSaved);
      state.slip = payload.legs || [];
      state.slipStake = Number(payload.stake || state.slipStake || 10);
      saveSlip();
      renderSlip();
      renderAccaTab();
      document.getElementById('slip-drawer').classList.remove('hidden');
      showToast('Loaded saved draft into Bet Slip!');
    })
  );
  document.querySelectorAll('[data-export-saved]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const payload = JSON.parse(btn.dataset.exportSaved);
      exportToBet365(payload.legs || [], Number(payload.stake || state.slipStake || 10), payload.title || 'Saved Acca');
    })
  );
  document.querySelectorAll('[data-del-saved]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/user/saved-accas/${btn.dataset.delSaved}`, { method: 'DELETE' });
        showToast('Saved draft removed');
        await loadDashboard(false);
        renderAccaTab();
      } catch (err) {
        showToast(err.message, true);
      }
    })
  );
  document.getElementById('open-slip-inline')?.addEventListener('click', () => {
    renderSlip();
    document.getElementById('slip-drawer').classList.remove('hidden');
  });
}

// 4. BET TRACKER & CLV TAB
async function renderTrackerTab() {
  const main = document.getElementById('main-content');
  const data = await api('/api/bets');
  const st = data.stats;

  main.innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-xl font-bold text-white">📈 Bet Tracker &amp; Closing-Line Value (CLV)</h2>
        <p class="text-xs text-slate-400">Profile: <b>${esc(data.user.display_name)}</b> • Monthly Limit: ${fmtGbp(st.month_staked)} / ${fmtGbp(data.user.monthly_stake_limit)}</p>
      </div>
      <button id="settle-bets-btn" class="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-white font-semibold">↻ Check Results &amp; Settle</button>
    </div>

    <div class="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
      <div class="p-3.5 rounded-2xl bg-panel border border-slate-800"><div class="text-slate-400">Total P&amp;L</div><div class="text-xl font-bold ${st.total_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${st.total_pnl >= 0 ? '+' : ''}${fmtGbp(st.total_pnl)}</div></div>
      <div class="p-3.5 rounded-2xl bg-panel border border-slate-800"><div class="text-slate-400">ROI</div><div class="text-xl font-bold ${st.roi_pct >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${st.roi_pct >= 0 ? '+' : ''}${st.roi_pct}%</div></div>
      <div class="p-3.5 rounded-2xl bg-panel border border-slate-800"><div class="text-slate-400">Avg CLV vs Close</div><div class="text-xl font-bold ${st.avg_clv_pct >= 0 ? 'text-emerald-400' : 'text-amber-300'}">${st.avg_clv_pct >= 0 ? '+' : ''}${st.avg_clv_pct}%</div></div>
      <div class="p-3.5 rounded-2xl bg-panel border border-slate-800"><div class="text-slate-400">Strike Rate</div><div class="text-xl font-bold text-white">${st.win_rate_pct}%</div></div>
      <div class="p-3.5 rounded-2xl bg-panel border border-slate-800"><div class="text-slate-400">Settled / Pending</div><div class="text-xl font-bold text-white">${st.settled_count} / ${st.pending_count}</div></div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div class="lg:col-span-2 bg-panel border border-slate-800 rounded-2xl p-4">
        <h3 class="text-sm font-bold text-white mb-2">Cumulative P&amp;L (£)</h3>
        <div class="h-56"><canvas id="pnl-chart"></canvas></div>
      </div>
      <div class="bg-panel border border-slate-800 rounded-2xl p-4">
        <h3 class="text-sm font-bold text-white mb-2">P&amp;L by League</h3>
        <div class="space-y-2 text-xs">
          ${data.by_league.length
      ? data.by_league
        .map(
          (l) => `
              <div class="p-2.5 rounded-xl bg-card border border-slate-800 flex justify-between">
                <div><div class="font-semibold text-white">${esc(l.league_name)}</div><div class="text-slate-400">${l.bets} legs • ${fmtGbp(l.staked)} staked</div></div>
                <div class="text-right font-bold ${l.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${l.pnl >= 0 ? '+' : ''}${fmtGbp(l.pnl)}<div class="text-[10px]">${l.roi_pct}% ROI</div></div>
              </div>`
        )
        .join('')
      : '<div class="text-slate-500">No settled bets yet.</div>'
    }
        </div>
      </div>
    </div>

    <div class="bg-panel border border-slate-800 rounded-2xl overflow-x-auto">
      <table class="w-full text-xs text-left">
        <thead class="text-slate-400 border-b border-slate-800 bg-slate-900/60">
          <tr>
            <th class="p-3">Date</th><th class="p-3">Type / Legs</th><th class="p-3 text-right">Odds</th><th class="p-3 text-right">Stake</th><th class="p-3 text-right">CLV</th><th class="p-3 text-right">Status / P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          ${data.bets.length
      ? data.bets
        .map((b) => {
          const stCls =
            b.status === 'won'
              ? 'text-emerald-400'
              : b.status === 'lost'
                ? 'text-rose-400'
                : 'text-amber-300';
          return `
              <tr class="border-b border-slate-800/70">
                <td class="p-3 text-slate-400">${esc(b.placed_at.slice(0, 10))}</td>
                <td class="p-3">
                  <span class="uppercase text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 mr-1">${esc(b.bet_type)}</span>
                  ${b.legs.map((l) => `<span class="text-white">${esc(l.home_team)} v ${esc(l.away_team)} (${esc(l.selection_label)})</span>`).join('<br/>')}
                </td>
                <td class="p-3 text-right font-mono">${fmtOdds(b.combined_odds)}</td>
                <td class="p-3 text-right">${fmtGbp(b.stake)}</td>
                <td class="p-3 text-right ${b.clv_pct >= 0 ? 'text-emerald-400' : 'text-slate-400'}">${b.clv_pct !== null ? `${b.clv_pct >= 0 ? '+' : ''}${b.clv_pct}%` : '—'}</td>
                <td class="p-3 text-right font-bold ${stCls}">${b.status.toUpperCase()} (${b.pnl >= 0 ? '+' : ''}${fmtGbp(b.pnl)})</td>
              </tr>`;
        })
        .join('')
      : `<tr><td colspan="6" class="p-6 text-center text-slate-400">No bets logged yet for this user.</td></tr>`
    }
        </tbody>
      </table>
    </div>
  `;

  document.getElementById('settle-bets-btn').addEventListener('click', async () => {
    const res = await api('/api/bets/settle', { method: 'POST', body: '{}' });
    showToast(`Checked results: ${res.settled} bets newly settled.`);
    renderTrackerTab();
    loadDashboard();
  });

  if (state.charts.pnl) state.charts.pnl.destroy();
  const ctx = document.getElementById('pnl-chart').getContext('2d');
  state.charts.pnl = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.pnl_series.map((p) => p.label),
      datasets: [
        {
          label: 'Cumulative P&L (£)',
          data: data.pnl_series.map((p) => p.pnl),
          borderColor: '#10b981',
          backgroundColor: 'rgba(16,185,129,0.15)',
          fill: true,
          tension: 0.25,
        },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
  });
}

// 5. MODEL & BACKTEST LAB TAB
async function renderBacktestTab() {
  const main = document.getElementById('main-content');
  const data = await api('/api/backtest');
  const firstCalib = data.results.find((r) => r.calibration?.length)?.calibration || [];

  main.innerHTML = `
    <div>
      <h2 class="text-xl font-bold text-white">🔬 Walk-Forward Backtest &amp; Calibration Lab</h2>
      <p class="text-xs text-slate-400">Strictly out-of-sample evaluation across 2026/27 played fixtures vs Bet365 closing odds (Value threshold ≥ 3% edge)</p>
    </div>

    <div class="bg-panel border border-slate-800 rounded-2xl overflow-x-auto">
      <table class="w-full text-xs text-left">
        <thead class="text-slate-400 border-b border-slate-800 bg-slate-900/60">
          <tr>
            <th class="p-3">League</th><th class="p-3">Market</th><th class="p-3 text-right">Tested</th>
            <th class="p-3 text-right">Brier</th><th class="p-3 text-right">Log Loss</th>
            <th class="p-3 text-right">Value Bets</th><th class="p-3 text-right">Win %</th>
            <th class="p-3 text-right">Flat ROI</th><th class="p-3 text-right">¼ Kelly ROI</th><th class="p-3 text-right">Avg CLV</th>
          </tr>
        </thead>
        <tbody>
          ${data.results
      .map(
        (r) => `
            <tr class="border-b border-slate-800/70">
              <td class="p-3 font-semibold text-white">${esc(r.league_name)}</td>
              <td class="p-3 text-emerald-300">${esc(r.market)}</td>
              <td class="p-3 text-right">${r.matches_tested}</td>
              <td class="p-3 text-right font-mono">${r.brier_score.toFixed(4)}</td>
              <td class="p-3 text-right font-mono">${r.log_loss.toFixed(4)}</td>
              <td class="p-3 text-right">${r.value_bets_count}</td>
              <td class="p-3 text-right">${r.win_rate_pct}%</td>
              <td class="p-3 text-right font-bold ${r.flat_roi_pct >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${r.flat_roi_pct >= 0 ? '+' : ''}${r.flat_roi_pct}%</td>
              <td class="p-3 text-right font-bold ${r.kelly_roi_pct >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${r.kelly_roi_pct >= 0 ? '+' : ''}${r.kelly_roi_pct}%</td>
              <td class="p-3 text-right ${r.avg_clv_pct >= 0 ? 'text-emerald-400' : 'text-amber-300'}">${r.avg_clv_pct >= 0 ? '+' : ''}${r.avg_clv_pct}%</td>
            </tr>`
      )
      .join('')}
        </tbody>
      </table>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div class="bg-panel border border-slate-800 rounded-2xl p-4">
        <h3 class="text-sm font-bold text-white mb-2">Model Probability Calibration (Predicted vs Actual %)</h3>
        <div class="h-60"><canvas id="calib-chart"></canvas></div>
      </div>
      <div class="bg-panel border border-slate-800 rounded-2xl p-4">
        <h3 class="text-sm font-bold text-white mb-2">Top Club Elo Power Rankings (EPL → L2)</h3>
        <div class="max-h-60 overflow-y-auto scrollbar-thin">
          <table class="w-full text-xs">
            <thead class="text-slate-400 border-b border-slate-800"><tr><th class="py-1 text-left">Club</th><th class="py-1">Div</th><th class="py-1 text-right">Elo</th><th class="py-1 text-right">Last 5</th><th class="py-1 text-right">Form</th></tr></thead>
            <tbody>
              ${data.top_elo_teams
      .map(
        (t) => `
                <tr class="border-b border-slate-800/60">
                  <td class="py-1.5 font-medium text-white">${esc(t.team_name)}</td>
                  <td class="py-1.5 text-center text-slate-400">${esc(t.div)}</td>
                  <td class="py-1.5 text-right font-mono text-emerald-400">${Math.round(t.elo)}</td>
                  <td class="py-1.5 text-right ${t.elo_change_last5 >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${t.elo_change_last5 >= 0 ? '+' : ''}${t.elo_change_last5}</td>
                  <td class="py-1.5 text-right font-mono">${esc(t.form_last6)}</td>
                </tr>`
      )
      .join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  if (state.charts.calib) state.charts.calib.destroy();
  const ctx = document.getElementById('calib-chart').getContext('2d');
  state.charts.calib = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: firstCalib.map((c) => c.bucket),
      datasets: [
        { label: 'Predicted %', data: firstCalib.map((c) => c.pred_pct), backgroundColor: 'rgba(56,189,248,0.6)' },
        { label: 'Actual Hit %', data: firstCalib.map((c) => c.actual_pct), backgroundColor: 'rgba(16,185,129,0.75)' },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false },
  });
}

// 6. FRIENDS LEADERBOARD TAB
async function renderLeaderboardTab() {
  const main = document.getElementById('main-content');
  const data = await api('/api/leaderboard');

  main.innerHTML = `
    <div>
      <h2 class="text-xl font-bold text-white">🏆 Friends Group Leaderboard</h2>
      <p class="text-xs text-slate-400">Opt-in comparison sorted by ROI% and Closing Line Value.</p>
    </div>

    <div class="bg-panel border border-slate-800 rounded-2xl overflow-x-auto">
      <table class="w-full text-xs text-left">
        <thead class="text-slate-400 border-b border-slate-800 bg-slate-900/60">
          <tr><th class="p-3">#</th><th class="p-3">Member</th><th class="p-3 text-right">Settled Bets</th><th class="p-3 text-right">Win %</th><th class="p-3 text-right">P&amp;L</th><th class="p-3 text-right">ROI</th><th class="p-3 text-right">Avg CLV</th></tr>
        </thead>
        <tbody>
          ${data.leaderboard.length
      ? data.leaderboard
        .map(
          (m, idx) => `
            <tr class="border-b border-slate-800/70">
              <td class="p-3 font-bold text-slate-400">${idx + 1}</td>
              <td class="p-3 font-semibold text-white flex items-center gap-2">
                <span class="w-2.5 h-2.5 rounded-full" style="background:${esc(m.avatar_color)}"></span>
                ${esc(m.display_name)}
              </td>
              <td class="p-3 text-right">${m.bets_settled}</td>
              <td class="p-3 text-right">${m.win_rate_pct}%</td>
              <td class="p-3 text-right font-bold ${m.total_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${m.total_pnl >= 0 ? '+' : ''}${fmtGbp(m.total_pnl)}</td>
              <td class="p-3 text-right font-bold ${m.roi_pct >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${m.roi_pct >= 0 ? '+' : ''}${m.roi_pct}%</td>
              <td class="p-3 text-right">${m.avg_clv_pct >= 0 ? '+' : ''}${m.avg_clv_pct}%</td>
            </tr>`
        )
        .join('')
      : `<tr><td colspan="7" class="p-6 text-center text-slate-400">No members on the leaderboard yet — create your account and log a bet to appear here.</td></tr>`
    }
        </tbody>
      </table>
    </div>

    <div class="bg-panel border border-slate-800 rounded-2xl p-5 max-w-lg space-y-3">
      <h3 class="text-sm font-bold text-white">Invite a Friend</h3>
      <p class="text-xs text-slate-400">Optional group invite code (default <code>ACCALAB2026</code>).</p>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
        <input id="new-friend-name" type="text" placeholder="Friend's Name" class="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white" />
        <input id="new-friend-code" type="text" placeholder="Invite Code" class="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white" />
        <input id="new-friend-bankroll" type="number" value="200" placeholder="Bankroll (£)" class="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white" />
        <button id="create-friend-btn" class="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold">Add Friend Profile</button>
      </div>
    </div>
  `;

  document.getElementById('create-friend-btn').addEventListener('click', async () => {
    try {
      const res = await api('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          display_name: document.getElementById('new-friend-name').value,
          invite_code: document.getElementById('new-friend-code').value,
          bankroll: document.getElementById('new-friend-bankroll').value,
        }),
      });
      state.activeUserId = res.user.id;
      localStorage.setItem('accalab_user_id', String(res.user.id));
      await loadDashboard();
      renderLeaderboardTab();
      showToast(`Added ${res.user.display_name}!`);
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

// 7. ALERTS, NEWS & SETTINGS TAB
async function renderSettingsTab() {
  const main = document.getElementById('main-content');
  const [alertsRes, newsRes] = await Promise.all([api('/api/alerts'), api('/api/news')]);
  const d = state.dashboard;
  const u = d.active_user;
  const allTeamsByLeague = d.all_teams_by_league || {};
  const leagueMeta = d.leagues || {
    E0: 'Premier League',
    E1: 'Championship',
    E2: 'League One',
    E3: 'League Two',
  };

  const filteredNews = state.newsMyClubsOnly
    ? (newsRes.news || []).filter(
      (n) =>
        (n.matched_teams || []).some((t) => state.favouriteTeams.includes(t)) ||
        state.favouriteTeams.some((ft) =>
          String(n.title || '').toLowerCase().includes(ft.toLowerCase())
        )
    )
    : newsRes.news || [];

  main.innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-xl font-bold text-white">🔔 Alerts, News &amp; Settings</h2>
        <p class="text-xs text-slate-400">Personalised clubs, account controls, Telegram notifications, and profile bankroll limits</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button id="settings-auth-btn" class="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-white font-semibold">${state.authenticated ? 'Account / Password' : 'Sign In / Create Account'}</button>
        ${state.authenticated ? '<button id="settings-logout-btn" class="px-3 py-1.5 rounded-xl bg-rose-500/20 border border-rose-500/40 hover:bg-rose-500/30 text-xs text-rose-300 font-semibold">Log Out</button>' : ''}
        <button id="mark-alerts-read" class="px-3 py-1.5 rounded-xl bg-slate-800 text-xs text-slate-200">Mark Alerts Read</button>
        <button id="run-full-sync-btn" class="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs text-white font-semibold">↻ Sync Live Data + Backtest</button>
      </div>
    </div>

    <!-- Favourite Clubs & Preferred Leagues Picker -->
    <div class="bg-panel border border-amber-500/30 rounded-2xl p-4 space-y-3">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h3 class="text-sm font-bold text-amber-300">★ My Favourite Clubs &amp; Preferred Leagues</h3>
          <p class="text-xs text-slate-400">Following <b class="text-white">${state.favouriteTeams.length}</b> club(s) — saved automatically to ${esc(u.display_name)}&apos;s account</p>
        </div>
        <input id="set-team-search" type="search" placeholder="Filter EFL / EPL clubs..." class="px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-white w-full sm:w-56" />
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        ${['E0', 'E1', 'E2', 'E3']
      .map(
        (div) => `
          <label class="flex items-center gap-2 px-3 py-2 rounded-xl bg-card border border-slate-800 cursor-pointer">
            <input type="checkbox" class="set-league-cb accent-emerald-500" value="${div}" ${state.preferredLeagues.includes(div) ? 'checked' : ''} />
            <span class="text-slate-200 font-medium">${esc(leagueMeta[div] || div)}</span>
          </label>`
      )
      .join('')}
      </div>

      <div id="set-team-picker" class="max-h-52 overflow-y-auto p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2.5"></div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <!-- Risk & Telegram Settings -->
      <div class="bg-panel border border-slate-800 rounded-2xl p-4 space-y-3">
        <h3 class="text-sm font-bold text-white">Profile Settings (${esc(u.display_name)})</h3>
        <div class="grid grid-cols-2 gap-3 text-xs">
          <label>Display Name<input id="set-display-name" type="text" value="${esc(u.display_name)}" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white"/></label>
          <label>Default Slip Stake (£)<input id="set-default-stake" type="number" step="1" min="1" value="${u.default_stake || 10}" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white"/></label>
          <label>Bankroll (£)<input id="set-bankroll" type="number" step="5" value="${u.bankroll}" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white"/></label>
          <label>Kelly Fraction<input id="set-kelly" type="number" step="0.05" min="0.05" max="1" value="${u.kelly_fraction}" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white"/></label>
          <label>Min Value Edge (%)<input id="set-min-edge" type="number" step="0.5" value="${u.min_edge_pct}" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white"/></label>
          <label>Monthly Stake Limit (£)<input id="set-limit" type="number" step="10" value="${u.monthly_stake_limit}" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white"/></label>
          <label class="col-span-2">Telegram Chat ID (optional)<input id="set-tg-chat" type="text" value="${esc(u.telegram_chat_id || '')}" placeholder="e.g. 123456789" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white"/></label>
        </div>
        <div class="flex flex-wrap gap-2">
          <button id="save-settings-btn" class="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold">Save Settings</button>
          <button id="test-tg-btn" class="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold">Send Test Telegram Alert</button>
        </div>

        <div class="pt-3 border-t border-slate-800 space-y-2 text-xs">
          <div class="font-bold text-cyan-300 uppercase tracking-wide text-[11px]">🛡️ API Quota Protection &amp; Smart Cache Health</div>
          <div class="flex justify-between"><span class="text-slate-400">Core Football &amp; News Feeds:</span><b class="text-emerald-400">Unlimited (Football-Data + RSS)</b></div>
          <div class="flex justify-between"><span class="text-slate-400">30-Min Sync Cache:</span><b class="${d.quota?.cache_active ? 'text-emerald-400' : 'text-slate-300'}">${d.quota?.cache_active ? 'Active (zero wasted calls)' : 'Ready for refresh'}</b></div>
          <div class="flex justify-between"><span class="text-slate-400">API-Football Budget (6h Cache):</span><b class="font-mono text-white">${d.quota?.api_football?.used_today ?? d.counts.api_football_calls_today} / ${d.quota?.api_football?.daily_limit ?? 100} used (${d.quota?.api_football?.remaining ?? 100} left)</b></div>
          <div class="flex justify-between"><span class="text-slate-400">Gemini AI Summary Guard:</span><b class="font-mono text-white">${d.quota?.gemini_ai?.used_today ?? 0} / ${d.quota?.gemini_ai?.daily_limit ?? 60} (${d.integrations.gemini_configured ? 'Active' : 'Built-in Engine'})</b></div>
          <div class="pt-1 flex justify-between items-center gap-2">
            <span class="text-[11px] text-slate-500">Last sync: ${esc(d.quota?.last_sync_at || 'Startup / manual')}</span>
            <button id="force-full-sync-btn" type="button" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] font-semibold text-cyan-300">⚡ Force Refresh</button>
          </div>
        </div>
      </div>

      <!-- Alerts Feed -->
      <div class="bg-panel border border-slate-800 rounded-2xl p-4 space-y-2 max-h-96 overflow-y-auto scrollbar-thin">
        <h3 class="text-sm font-bold text-white">Value &amp; System Alerts</h3>
        ${alertsRes.alerts.length
      ? alertsRes.alerts
        .map(
          (a) => `
            <div class="p-3 rounded-xl bg-card border ${a.is_read ? 'border-slate-800' : 'border-emerald-500/40'} text-xs">
              <div class="font-bold text-emerald-300">${esc(a.title)}</div>
              <div class="text-slate-300 mt-1">${esc(a.message)}</div>
              <div class="text-[10px] text-slate-500 mt-1">${esc(a.created_at)}</div>
            </div>`
        )
        .join('')
      : '<div class="text-xs text-slate-500">No alerts generated yet.</div>'
    }
      </div>
    </div>

    <!-- Latest News RSS Feed -->
    <div class="bg-panel border border-slate-800 rounded-2xl p-4 space-y-2.5">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-sm font-bold text-white">Latest Football News (BBC Sport / Sky Sports / Guardian)</h3>
        <label class="flex items-center gap-1.5 text-xs text-amber-200 cursor-pointer">
          <input id="news-my-clubs" type="checkbox" ${state.newsMyClubsOnly ? 'checked' : ''} class="accent-amber-400" />
          <span>★ My Clubs Only</span>
        </label>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-2.5 text-xs">
        ${filteredNews.length
      ? filteredNews
        .slice(0, 12)
        .map(
          (n) => `
                <a href="${esc(n.url)}" target="_blank" rel="noopener" class="p-3 rounded-xl bg-card border border-slate-800 hover:border-slate-600 block">
                  <div class="flex justify-between text-[10px] text-emerald-400 font-semibold"><span>${esc(n.source)}</span><span>${esc((n.matched_teams || []).join(', '))}</span></div>
                  <div class="font-semibold text-white mt-1">${esc(n.title)}</div>
                </a>`
        )
        .join('')
      : '<div class="col-span-2 text-xs text-slate-400 py-4 text-center">No RSS headlines match your followed clubs yet — follow more clubs above or uncheck "My Clubs Only".</div>'
    }
      </div>
    </div>
  `;

  const renderSettingsTeams = (q = '') => {
    const query = q.trim().toLowerCase();
    const picker = document.getElementById('set-team-picker');
    picker.innerHTML =
      ['E0', 'E1', 'E2', 'E3']
        .map((div) => {
          const teams = (allTeamsByLeague[div] || []).filter(
            (t) => !query || t.toLowerCase().includes(query)
          );
          if (!teams.length) return '';
          return `
            <div>
              <div class="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">${esc(leagueMeta[div] || div)}</div>
              <div class="flex flex-wrap gap-1.5">
                ${teams
              .map((t) => {
                const on = state.favouriteTeams.includes(t);
                return `<button type="button" data-pref-team="${esc(t)}" class="px-2.5 py-1 rounded-full text-[11px] border transition ${on
                    ? 'bg-amber-500/20 border-amber-400 text-amber-200 font-semibold'
                    : 'bg-card border-slate-700 text-slate-300 hover:border-slate-500'
                  }">${on ? '★ ' : ''}${esc(t)}</button>`;
              })
              .join('')}
              </div>
            </div>`;
        })
        .join('') || '<div class="text-xs text-slate-500 py-2 text-center">No matching clubs found.</div>';

    picker.querySelectorAll('[data-pref-team]').forEach((btn) =>
      btn.addEventListener('click', () => toggleFavouriteTeam(btn.dataset.prefTeam))
    );
  };
  renderSettingsTeams();

  document.getElementById('set-team-search').addEventListener('input', (e) => renderSettingsTeams(e.target.value));
  document.querySelectorAll('.set-league-cb').forEach((cb) =>
    cb.addEventListener('change', async () => {
      const selected = Array.from(document.querySelectorAll('.set-league-cb:checked')).map((c) => c.value);
      try {
        await api('/api/user/preferences', {
          method: 'POST',
          body: JSON.stringify({ preferred_leagues: selected }),
        });
        await loadDashboard(false);
        showToast('Preferred leagues saved');
      } catch (err) {
        showToast(err.message, true);
      }
    })
  );

  document.getElementById('settings-auth-btn').addEventListener('click', () => openAuthModal());
  document.getElementById('settings-logout-btn')?.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST', body: '{}' });
    showToast('Logged out');
    await loadDashboard(true);
    saveSlip(false);
    renderSettingsTab();
  });

  document.getElementById('save-settings-btn').addEventListener('click', async () => {
    try {
      const newStake = Number(document.getElementById('set-default-stake').value || 10);
      await api('/api/user/preferences', {
        method: 'POST',
        body: JSON.stringify({
          display_name: document.getElementById('set-display-name').value.trim() || u.display_name,
          default_stake: newStake,
          bankroll: document.getElementById('set-bankroll').value,
          kelly_fraction: document.getElementById('set-kelly').value,
          min_edge_pct: document.getElementById('set-min-edge').value,
          monthly_stake_limit: document.getElementById('set-limit').value,
          telegram_chat_id: document.getElementById('set-tg-chat').value,
        }),
      });
      state.slipStake = newStake;
      saveSlip(false);
      await loadDashboard(false);
      renderSettingsTab();
      showToast('Settings saved!');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('test-tg-btn').addEventListener('click', async () => {
    try {
      const res = await api('/api/alerts/test-telegram', {
        method: 'POST',
        body: JSON.stringify({ chat_id: document.getElementById('set-tg-chat').value }),
      });
      showToast(res.message);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('news-my-clubs').addEventListener('change', (e) => {
    state.newsMyClubsOnly = e.target.checked;
    renderSettingsTab();
  });

  document.getElementById('mark-alerts-read').addEventListener('click', async () => {
    await api('/api/alerts/mark-read', { method: 'POST', body: '{}' });
    await loadDashboard(false);
    renderSettingsTab();
  });

  document.getElementById('run-full-sync-btn').addEventListener('click', () => triggerSync(true, false));
  document.getElementById('force-full-sync-btn')?.addEventListener('click', () => triggerSync(true, true));
}

async function triggerSync(withBacktest = false, force = false) {
  showToast(force ? 'Forcing live refresh & refitting models...' : 'Checking smart cache & syncing live data...');
  try {
    const res = await api('/api/sync', { method: 'POST', body: JSON.stringify({ run_backtest: withBacktest, force }) });
    await loadDashboard();
    renderActiveTab();
    if (res.summary.cached) {
      showToast('Data fresh from 30m Smart Cache — bets settled & zero API quota spent!');
    } else {
      showToast(`Synced ${res.summary.counts.historical_matches} matches & ${res.summary.counts.upcoming_fixtures} upcoming fixtures!`);
    }
  } catch (err) {
    showToast(`Sync error: ${err.message}`, true);
  }
}

async function renderActiveTab() {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    const active = btn.dataset.tab === state.activeTab;
    btn.className = `nav-btn w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-medium ${active ? 'bg-emerald-500/15 text-emerald-400' : 'text-slate-300 hover:bg-slate-800/70'
      }`;
  });
  document.querySelectorAll('.nav-btn-mob').forEach((btn) => {
    const active = btn.dataset.tab === state.activeTab;
    btn.className = `nav-btn-mob flex flex-col items-center text-[11px] ${active ? 'text-emerald-400 font-semibold' : 'text-slate-400'}`;
  });

  if (state.activeTab === 'fixtures') return renderFixturesTab();
  if (state.activeTab === 'value') return renderValueTab();
  if (state.activeTab === 'acca') return renderAccaTab();
  if (state.activeTab === 'tracker') return renderTrackerTab();
  if (state.activeTab === 'backtest') return renderBacktestTab();
  if (state.activeTab === 'leaderboard') return renderLeaderboardTab();
  if (state.activeTab === 'settings') return renderSettingsTab();
}

function renderAuthModalBody(mode = 'login') {
  const loginTab = document.getElementById('auth-tab-login');
  const regTab = document.getElementById('auth-tab-register');
  const body = document.getElementById('auth-modal-body');
  if (!loginTab || !regTab || !body) return;

  const activeCls = 'flex-1 py-2 text-xs font-bold rounded-lg bg-emerald-500 text-slate-950 transition';
  const inactiveCls = 'flex-1 py-2 text-xs font-bold rounded-lg bg-surface border border-slate-700 text-slate-300 hover:text-white transition';
  loginTab.className = mode === 'login' ? activeCls : inactiveCls;
  regTab.className = mode === 'register' ? activeCls : inactiveCls;

  const d = state.dashboard || {};
  const u = d.active_user || {};
  const users = d.users || [];

  if (mode === 'login') {
    body.innerHTML = `
      ${state.authenticated ? `
        <div class="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 mb-4 flex items-center justify-between gap-3">
          <div>
            <div class="text-xs font-bold text-emerald-400">Signed in as ${esc(u.display_name || u.username)}</div>
            <div class="text-[11px] text-slate-300 mt-0.5">@${esc(u.username || '')} • ${state.favouriteTeams.length} followed clubs • ${state.watchedIds.length} saved fixtures</div>
          </div>
          <button id="auth-logout-btn" type="button" class="px-3 py-1.5 rounded-lg bg-rose-500/20 border border-rose-500/40 hover:bg-rose-500/30 text-rose-300 text-xs font-bold">Log Out</button>
        </div>
      ` : ''}

      ${!users.length ? `
        <div class="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div class="text-xs font-bold text-emerald-300">Ready to set up your personal AccaLab account?</div>
            <div class="text-[11px] text-slate-300 mt-0.5">No accounts are registered yet — create yours in seconds.</div>
          </div>
          <button id="switch-to-reg-btn" type="button" class="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-extrabold shrink-0">Create Account →</button>
        </div>
      ` : ''}

      <form id="auth-login-form" class="space-y-3">
        <div>
          <label class="block text-xs text-slate-400 mb-1">Username or Email</label>
          <input id="login-username" type="text" required placeholder="Your username or email" class="w-full px-3 py-2 rounded-lg bg-surface border border-slate-700 text-sm text-white" />
        </div>
        <div>
          <label class="block text-xs text-slate-400 mb-1">Password</label>
          <input id="login-password" type="password" required placeholder="••••••••" class="w-full px-3 py-2 rounded-lg bg-surface border border-slate-700 text-sm text-white" />
        </div>
        <button type="submit" class="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm">Log In to My Account</button>
      </form>

      ${users.length && !state.authenticated ? `
        <div class="mt-3 text-center text-[11px] text-slate-400">
          New to this group? <button id="switch-to-reg-link" type="button" class="text-emerald-400 hover:text-emerald-300 font-semibold underline">Create a personal account</button>
        </div>
      ` : ''}

      ${state.authenticated ? `
        <form id="auth-pw-form" class="mt-4 pt-4 border-t border-slate-800 space-y-2.5">
          <div class="text-xs font-bold text-slate-200">Change Password</div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input id="pw-current" type="password" required placeholder="Current password" class="px-3 py-2 rounded-lg bg-surface border border-slate-700 text-xs text-white" />
            <input id="pw-new" type="password" required minlength="4" placeholder="New password (min 4)" class="px-3 py-2 rounded-lg bg-surface border border-slate-700 text-xs text-white" />
          </div>
          <button type="submit" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white">Update Password</button>
        </form>
      ` : ''}
    `;

    document.getElementById('switch-to-reg-btn')?.addEventListener('click', () => renderAuthModalBody('register'));
    document.getElementById('switch-to-reg-link')?.addEventListener('click', () => renderAuthModalBody('register'));

    document.getElementById('auth-login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const res = await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({
            username: document.getElementById('login-username').value.trim(),
            password: document.getElementById('login-password').value,
          }),
        });
        state.activeUserId = res.user.id;
        localStorage.setItem('accalab_user_id', String(state.activeUserId));
        document.getElementById('auth-modal').classList.add('hidden');
        await loadDashboard(true);
        saveSlip(false);
        await renderActiveTab();
        showToast(`Welcome back, ${res.user.display_name}!`);
      } catch (err) {
        showToast(err.message, true);
      }
    });

    const logoutBtn = document.getElementById('auth-logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        try {
          await api('/api/auth/logout', { method: 'POST', body: '{}' });
          showToast('Logged out');
          await loadDashboard(true);
          saveSlip(false);
          renderAuthModalBody('login');
          await renderActiveTab();
        } catch (err) {
          showToast(err.message, true);
        }
      });
    }

    const pwForm = document.getElementById('auth-pw-form');
    if (pwForm) {
      pwForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api('/api/auth/password', {
            method: 'POST',
            body: JSON.stringify({
              current_password: document.getElementById('pw-current').value,
              new_password: document.getElementById('pw-new').value,
            }),
          });
          pwForm.reset();
          showToast('Password updated');
        } catch (err) {
          showToast(err.message, true);
        }
      });
    }
    return;
  }

  const allTeamsByLeague = d.all_teams_by_league || {};
  const leagueMeta = d.leagues || {
    E0: 'Premier League',
    E1: 'Championship',
    E2: 'League One',
    E3: 'League Two',
  };
  const selectedTeams = new Set();

  body.innerHTML = `
    ${!users.length ? `
      <div class="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-slate-200">
        <b class="text-emerald-300">Welcome to AccaLab!</b> Set up your personal account below to save your bankroll, default stake, favourite English clubs, watchlist and tracked bets.
      </div>
    ` : ''}
    <form id="auth-register-form" class="space-y-3">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <div>
          <label class="block text-xs text-slate-400 mb-1">Display Name *</label>
          <input id="reg-display" type="text" required placeholder="e.g. Ben" class="w-full px-3 py-2 rounded-lg bg-surface border border-slate-700 text-xs text-white" />
        </div>
        <div>
          <label class="block text-xs text-slate-400 mb-1">Username *</label>
          <input id="reg-username" type="text" required placeholder="e.g. ben29" class="w-full px-3 py-2 rounded-lg bg-surface border border-slate-700 text-xs text-white" />
        </div>
        <div>
          <label class="block text-xs text-slate-400 mb-1">Email (optional)</label>
          <input id="reg-email" type="email" placeholder="you@example.com" class="w-full px-3 py-2 rounded-lg bg-surface border border-slate-700 text-xs text-white" />
        </div>
        <div>
          <label class="block text-xs text-slate-400 mb-1">Password *</label>
          <input id="reg-password" type="password" required minlength="4" placeholder="Min 4 chars" class="w-full px-3 py-2 rounded-lg bg-surface border border-slate-700 text-xs text-white" />
        </div>
        <div>
          <label class="block text-xs text-slate-400 mb-1">Starting Bankroll (£)</label>
          <input id="reg-bankroll" type="number" min="10" step="10" value="250" class="w-full px-3 py-2 rounded-lg bg-surface border border-slate-700 text-xs text-white" />
        </div>
        <div>
          <label class="block text-xs text-slate-400 mb-1">Default Stake (£)</label>
          <input id="reg-default-stake" type="number" min="1" step="1" value="10" class="w-full px-3 py-2 rounded-lg bg-surface border border-slate-700 text-xs text-white" />
        </div>
        <div>
          <label class="block text-xs text-slate-400 mb-1">Risk Profile (Kelly)</label>
          <select id="reg-kelly" class="w-full px-3 py-2 rounded-lg bg-surface border border-slate-700 text-xs text-white">
            <option value="0.125">Conservative (1/8 Kelly)</option>
            <option value="0.25" selected>Balanced (1/4 Kelly)</option>
            <option value="0.5">Aggressive (1/2 Kelly)</option>
          </select>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="block text-xs text-slate-400 mb-1">Min Edge %</label>
            <input id="reg-min-edge" type="number" step="0.5" min="0" value="3.0" class="w-full px-3 py-2 rounded-lg bg-surface border border-slate-700 text-xs text-white" />
          </div>
          <div>
            <label class="block text-xs text-slate-400 mb-1">Avatar Colour</label>
            <input id="reg-color" type="color" value="#10b981" class="w-full h-[34px] rounded-lg bg-surface border border-slate-700 p-0.5 cursor-pointer" />
          </div>
        </div>
        <div class="sm:col-span-2">
          <label class="block text-xs text-slate-400 mb-1">Group Invite Code (optional)</label>
          <input id="reg-invite" type="text" value="ACCALAB2026" placeholder="ACCALAB2026" class="w-full px-3 py-2 rounded-lg bg-surface border border-slate-700 text-xs text-white" />
        </div>
      </div>

      <div>
        <div class="text-xs text-slate-400 mb-1.5">Preferred English Leagues</div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
          ${['E0', 'E1', 'E2', 'E3'].map((div) => `
            <label class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface border border-slate-700 text-xs text-slate-200 cursor-pointer">
              <input type="checkbox" class="reg-league-cb accent-emerald-500" value="${div}" checked />
              <span>${esc(leagueMeta[div] || div)}</span>
            </label>
          `).join('')}
        </div>
      </div>

      <div>
        <div class="flex items-center justify-between gap-2 mb-1.5">
          <span class="text-xs text-slate-400">Pick Favourite Clubs (<span id="reg-team-count" class="text-emerald-400 font-bold">0</span> selected)</span>
          <input id="reg-team-search" type="search" placeholder="Filter clubs..." class="px-2.5 py-1 rounded-lg bg-surface border border-slate-700 text-xs text-white w-40" />
        </div>
        <div id="reg-team-picker" class="max-h-40 overflow-y-auto p-2 rounded-xl bg-surface border border-slate-800 space-y-2"></div>
      </div>

      <button type="submit" class="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm">Create My Account &amp; Start</button>
    </form>
  `;

  const renderTeamPicker = (q = '') => {
    const query = q.trim().toLowerCase();
    const picker = document.getElementById('reg-team-picker');
    picker.innerHTML = ['E0', 'E1', 'E2', 'E3'].map((div) => {
      const teams = (allTeamsByLeague[div] || []).filter((t) => !query || t.toLowerCase().includes(query));
      if (!teams.length) return '';
      return `
        <div>
          <div class="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">${esc(leagueMeta[div] || div)}</div>
          <div class="flex flex-wrap gap-1">
            ${teams.map((t) => {
        const on = selectedTeams.has(t);
        return `<button type="button" data-reg-team="${esc(t)}" class="px-2 py-0.5 rounded-full text-[11px] border transition ${on
            ? 'bg-amber-500/20 border-amber-400 text-amber-200 font-semibold'
            : 'bg-card border-slate-700 text-slate-300 hover:border-slate-500'
          }">${on ? '★ ' : ''}${esc(t)}</button>`;
      }).join('')}
          </div>
        </div>
      `;
    }).join('') || '<div class="text-xs text-slate-500 py-2 text-center">No matching clubs.</div>';

    picker.querySelectorAll('[data-reg-team]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const team = btn.dataset.regTeam;
        if (selectedTeams.has(team)) selectedTeams.delete(team);
        else selectedTeams.add(team);
        document.getElementById('reg-team-count').textContent = String(selectedTeams.size);
        renderTeamPicker(document.getElementById('reg-team-search').value);
      })
    );
  };
  renderTeamPicker();
  document.getElementById('reg-team-search').addEventListener('input', (e) => renderTeamPicker(e.target.value));

  document.getElementById('auth-register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const preferred_leagues = Array.from(document.querySelectorAll('.reg-league-cb:checked')).map((c) => c.value);
    try {
      const res = await api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          display_name: document.getElementById('reg-display').value.trim(),
          username: document.getElementById('reg-username').value.trim(),
          email: document.getElementById('reg-email').value.trim(),
          password: document.getElementById('reg-password').value,
          invite_code: document.getElementById('reg-invite').value.trim(),
          bankroll: Number(document.getElementById('reg-bankroll').value || 250),
          default_stake: Number(document.getElementById('reg-default-stake')?.value || 10),
          kelly_fraction: Number(document.getElementById('reg-kelly').value || 0.25),
          min_edge_pct: Number(document.getElementById('reg-min-edge').value || 3.0),
          avatar_color: document.getElementById('reg-color').value || '#10b981',
          preferred_leagues: preferred_leagues.length ? preferred_leagues : ['E0', 'E1', 'E2', 'E3'],
          favourite_teams: Array.from(selectedTeams),
        }),
      });
      state.activeUserId = res.user.id;
      localStorage.setItem('accalab_user_id', String(state.activeUserId));
      document.getElementById('auth-modal').classList.add('hidden');
      await loadDashboard(true);
      saveSlip(false);
      await renderActiveTab();
      showToast(`Account created! Welcome to AccaLab, ${res.user.display_name}`);
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

function openAuthModal(initialMode) {
  const users = state.dashboard?.users || [];
  const resolvedMode = initialMode || (users.length ? 'login' : 'register');
  renderAuthModalBody(resolvedMode);
  document.getElementById('auth-modal').classList.remove('hidden');
}

function buildBet365Bookmarklet(slipToken = '') {
  const fnSrc = `(function(fallbackTok){try{var q=new URLSearchParams(location.search||'').get('accalab_slip')||fallbackTok||'';if(q){sessionStorage.setItem('accalab_b365_slip_bm',q)}var tok=sessionStorage.getItem('accalab_b365_slip_bm')||q;if(!tok){alert('Open a slip from AccaLab first.');return}var b=tok.replace(/-/g,'+').replace(/_/g,'/');while(b.length%4)b+='=';var u=Uint8Array.from(atob(b),function(c){return c.charCodeAt(0)});var slip=JSON.parse(new TextDecoder().decode(u));var i=0;var old=document.getElementById('accalab-bm-bar');if(old)old.remove();var w=document.createElement('div');w.id='accalab-bm-bar';w.style.cssText='position:fixed;left:12px;bottom:12px;z-index:2147483647;width:320px;max-width:calc(100vw - 24px);background:#0f172a;color:#fff;border:1px solid #10b981;border-radius:12px;padding:10px;font:12px/1.4 system-ui,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.6)';function draw(){w.replaceChildren();var l=slip.legs[i];var h=document.createElement('div');h.style.cssText='font-weight:800;color:#34d399;margin-bottom:4px';h.textContent='AccaLab ('+(i+1)+'/'+slip.legs.length+') @ '+(slip.od||'');var m=document.createElement('div');m.style.cssText='font-weight:700';m.textContent=l.h+' v '+l.a;var s=document.createElement('div');s.style.cssText='color:#38bdf8;margin:3px 0 8px';s.textContent=l.m+': '+(l.s||l.l)+' @ '+l.o;var r=document.createElement('div');r.style.cssText='display:flex;gap:6px';var go=document.createElement('button');go.textContent='Open Match';go.style.cssText='flex:1;padding:6px;border-radius:8px;border:0;background:#10b981;color:#064e3b;font-weight:800;cursor:pointer';go.onclick=function(){location.hash='#/AX/K^'+encodeURIComponent(l.k||(l.h+' v '+l.a))};var nx=document.createElement('button');nx.textContent=i<slip.legs.length-1?'Next ->':'Done';nx.style.cssText='padding:6px 10px;border-radius:8px;border:1px solid #34d399;background:#065f46;color:#fff;font-weight:700;cursor:pointer';nx.onclick=function(){if(i<slip.legs.length-1){i++;draw();location.hash='#/AX/K^'+encodeURIComponent(slip.legs[i].k||(slip.legs[i].h+' v '+slip.legs[i].a))}else{w.remove()}};r.append(go,nx);w.append(h,m,s,r)}draw();document.body.appendChild(w)}catch(e){alert('AccaLab Companion error: '+e.message)}})('${String(slipToken || '').replace(/'/g, '')}');`;
  return `javascript:${encodeURIComponent(fnSrc)}`;
}

function renderBet365HandoffModal(exp, legs, stake, title) {
  const modal = document.getElementById('suggest-modal');
  const titleEl = document.getElementById('suggest-modal-title');
  const subEl = document.getElementById('suggest-modal-subtitle');
  const body = document.getElementById('suggest-modal-body');
  if (!modal || !body) return;

  const expLegs = exp.legs || [];
  let activeLegIdx = 0;
  const completedLegs = new Set();

  titleEl.textContent = '🚀 Bet365 Slip Builder Handoff';
  subEl.textContent =
    exp.mode === 'direct_prefill'
      ? 'Direct Bet365 betslip deep-link launched — review or log once placed'
      : 'Same-tab Bet365 builder: step through each leg below so Bet365 keeps adding to your slip';

  const ev = exp.eval || {};

  const renderHandoff = () => {
    const curLeg = expLegs[activeLegIdx] || {};
    const hasNext = activeLegIdx < expLegs.length - 1;
    const isMulti = expLegs.length > 1;

    body.innerHTML = `
      <div class="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 space-y-2.5 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div class="font-bold text-emerald-300">
              ${exp.mode === 'direct_prefill' ? 'Direct Slip Deep-Link Active' : `Step ${activeLegIdx + 1} of ${expLegs.length} Opened in Bet365 Tab`}
            </div>
            <div class="text-slate-300 mt-0.5">${esc(exp.title)} (${exp.bet_type === 'combo' ? `${expLegs.length}-Fold Acca` : 'Single'})</div>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button id="b365-reopen-cur-btn" type="button" class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold">
              ${isMulti ? `Open Leg ${activeLegIdx + 1} ↗` : 'Open Match in Bet365 ↗'}
            </button>
            ${hasNext
        ? `<button id="b365-next-leg-btn" type="button" class="px-3.5 py-2 rounded-xl btn-bet365 text-xs font-extrabold">
                    ✓ Added — Next: Send Leg ${activeLegIdx + 2} to Same Tab →
                  </button>`
        : ''
      }
          </div>
        </div>

        ${expLegs.length
        ? `<div class="p-2.5 rounded-lg bg-slatebg/80 border border-emerald-500/20 flex flex-wrap items-center justify-between gap-2">
                <div class="min-w-0">
                  <div class="text-[10px] uppercase tracking-wider text-emerald-400 font-bold">What to tap on Bet365 right now</div>
                  <div class="text-white font-bold mt-0.5">${esc(curLeg.home_team)} v ${esc(curLeg.away_team)} → <span class="text-cyan-300">${esc(curLeg.b365_market_name)}</span>: <span class="text-emerald-300">${esc(curLeg.b365_selection_name || curLeg.selection_label)} @ ${fmtOdds(curLeg.odds)}</span></div>
                </div>
                <span class="text-[10px] font-mono text-amber-300 shrink-0">Bet365 keeps your slip across legs</span>
              </div>`
        : ''
      }
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
        <div class="p-3 rounded-xl bg-card border border-slate-800"><div class="text-slate-400">Stake</div><div class="text-base font-bold font-mono text-white">${fmtGbp(exp.stake)}</div></div>
        <div class="p-3 rounded-xl bg-card border border-slate-800"><div class="text-slate-400">Combined Odds</div><div class="text-base font-bold font-mono text-emerald-400">${fmtOdds(ev.combined_odds)}</div></div>
        <div class="p-3 rounded-xl bg-card border border-slate-800"><div class="text-slate-400">Potential Return</div><div class="text-base font-bold font-mono text-white">${fmtGbp(ev.potential_return || 0)}</div></div>
        <div class="p-3 rounded-xl bg-card border border-slate-800"><div class="text-slate-400">Model EV</div><div class="text-base font-bold font-mono ${Number(ev.expected_value_pct) >= 0 ? 'text-emerald-400' : 'text-amber-300'}">${Number(ev.expected_value_pct) >= 0 ? '+' : ''}${Number(ev.expected_value_pct || 0).toFixed(1)}%</div></div>
      </div>

      <div class="space-y-2">
        <div class="flex items-center justify-between text-xs">
          <span class="font-bold uppercase tracking-wider text-slate-400">Same-Tab Match Queue (${completedLegs.size}/${expLegs.length} Added)</span>
          <span class="text-[11px] text-slate-400">Uses <code class="text-cyan-300">Home v Away</code> search</span>
        </div>
        ${expLegs
        .map((l, idx) => {
          const isCur = idx === activeLegIdx;
          const isDone = completedLegs.has(idx);
          return `
          <div class="p-3 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs transition ${isCur
              ? 'bg-emerald-500/10 border-emerald-400/70'
              : isDone
                ? 'bg-card/60 border-slate-800 opacity-80'
                : 'bg-card border-slate-800'
            }">
            <div class="min-w-0">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="font-bold text-white">${idx + 1}. ${esc(l.selection_label)}</span>
                <span class="text-emerald-400 font-mono font-bold">@ ${fmtOdds(l.odds)}</span>
                ${isDone
              ? '<span class="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px] font-bold">Done ✓</span>'
              : isCur
                ? '<span class="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-bold">Active in Bet365</span>'
                : '<span class="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 text-[10px]">Queued</span>'
            }
              </div>
              <div class="text-[11px] text-cyan-300 mt-0.5 truncate">${esc(l.b365_path)}</div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <button type="button" data-b365-done-idx="${idx}" class="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold">
                ${isDone ? 'Undo' : '✓ Done'}
              </button>
              <button type="button" data-b365-open-idx="${idx}" class="px-3 py-1.5 rounded-lg bg-emerald-600/85 hover:bg-emerald-500 text-white font-semibold">
                Open Match ↗
              </button>
            </div>
          </div>`;
        })
        .join('')}
      </div>

      <div class="p-3 rounded-xl bg-surface border border-slate-800 space-y-2 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="font-semibold text-emerald-300">⚡ Bet365 In-Page Slip Companion (No Tab Switching)</div>
          <div class="flex flex-wrap gap-1.5">
            <a href="./static/accalab-bet365.user.js" target="_blank" rel="noopener" class="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold">
              Install Companion Userscript ↗
            </a>
            <button id="b365-copy-bookmarklet-btn" type="button" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 text-[11px] font-bold">
              📋 Copy Overlay Bookmarklet
            </button>
          </div>
        </div>
        <p class="text-[11px] text-slate-400">
          Why Bet365 doesn’t auto-fill multi-legs from a plain link alone: Bet365 locks betslip URL parameters behind internal partner IDs. Installing the Companion Userscript (Tampermonkey / iOS Userscripts) or running the Bookmarklet inside Bet365 floats this exact slip bar + Next Leg button right on top of Bet365 and highlights every match and selection on screen.
        </p>
      </div>

      <div class="p-3 rounded-xl bg-surface border border-slate-800 space-y-2 text-xs">
        <div class="font-semibold text-slate-200">Optional: Bet365 Direct Betslip Options ID</div>
        <div class="flex gap-2">
          <input id="b365-options-input" type="text" placeholder="e.g. 9047433-399573237-1189243230" class="flex-1 px-3 py-1.5 rounded-lg bg-slatebg border border-slate-700 text-xs font-mono text-white" />
          <button id="b365-apply-options-btn" type="button" class="px-3 py-1.5 rounded-lg btn-bet365 text-xs font-bold">Launch Prefill ↗</button>
        </div>
      </div>

      <div class="flex flex-wrap gap-2 pt-2 border-t border-slate-800">
        <button id="b365-back-suggest-btn" type="button" class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 font-semibold">← Back to Suggestions</button>
        <button id="b365-copy-btn" type="button" class="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs text-white font-semibold">📋 Copy Slip Summary</button>
        <button id="b365-log-bet-btn" type="button" class="flex-1 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs text-white font-extrabold">✅ Bet Placed on Bet365 — Log to Tracker</button>
      </div>
    `;

    document.getElementById('b365-reopen-cur-btn')?.addEventListener('click', () => {
      const targetUrl = expLegs[activeLegIdx]?.b365_search_url || exp.launch_url;
      openInBet365Tab(targetUrl);
    });

    document.getElementById('b365-next-leg-btn')?.addEventListener('click', () => {
      completedLegs.add(activeLegIdx);
      if (activeLegIdx < expLegs.length - 1) activeLegIdx += 1;
      const nextUrl = expLegs[activeLegIdx]?.b365_search_url || exp.launch_url;
      openInBet365Tab(nextUrl);
      renderHandoff();
    });

    body.querySelectorAll('[data-b365-open-idx]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.b365OpenIdx);
        activeLegIdx = i;
        openInBet365Tab(expLegs[i]?.b365_search_url || exp.launch_url);
        renderHandoff();
      })
    );

    body.querySelectorAll('[data-b365-done-idx]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.b365DoneIdx);
        if (completedLegs.has(i)) completedLegs.delete(i);
        else completedLegs.add(i);
        renderHandoff();
      })
    );

    document.getElementById('b365-copy-bookmarklet-btn')?.addEventListener('click', () => {
      const bm = buildBet365Bookmarklet(exp.slip_token || '');
      navigator.clipboard?.writeText(bm).catch(() => { });
      showToast('Copied Bookmarklet! Paste into a browser bookmark URL & tap it on Bet365.');
    });

    document.getElementById('b365-apply-options-btn')?.addEventListener('click', async () => {
      const opts = document.getElementById('b365-options-input').value.trim();
      if (!opts) return showToast('Enter a Bet365 options string first', true);
      exportToBet365(legs, stake, title, opts);
    });

    document.getElementById('b365-copy-btn')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(exp.clipboard_text).catch(() => { });
      showToast('Copied formatted slip to clipboard!');
    });

    document.getElementById('b365-back-suggest-btn')?.addEventListener('click', () => openSuggestModal(state.activeRiskLevel || 'high'));

    document.getElementById('b365-log-bet-btn')?.addEventListener('click', async () => {
      try {
        await api('/api/bets', {
          method: 'POST',
          body: JSON.stringify({
            user_id: state.activeUserId,
            stake,
            legs,
            notes: `${title} (Bet365)`,
          }),
        });
        state.slip = [];
        saveSlip();
        renderSlip();
        modal.classList.add('hidden');
        document.getElementById('slip-drawer').classList.add('hidden');
        await loadDashboard(false);
        renderActiveTab();
        showToast('Bet placed & logged to your tracker!');
      } catch (err) {
        showToast(err.message, true);
      }
    });
  };

  renderHandoff();
  modal.classList.remove('hidden');
}

async function exportToBet365(legs, stake = state.slipStake, title = 'AccaLab Suggested Bet', optionsOverride = '') {
  if (!legs || !legs.length) {
    showToast('Add at least one selection first', true);
    return;
  }
  try {
    const exp = await api('/api/bet365/export', {
      method: 'POST',
      body: JSON.stringify({ legs, stake, title, options_override: optionsOverride }),
    });
    navigator.clipboard?.writeText(exp.clipboard_text).catch(() => { });
    state.slip = legs.map((l) => ({ ...l }));
    state.slipStake = Number(exp.stake || stake || 10);
    saveSlip();
    renderSlip();
    if (state.activeTab === 'fixtures') renderFixturesTab();
    openInBet365Tab(exp.launch_url);
    renderBet365HandoffModal(exp, legs, exp.stake, title);
    showToast(exp.mode === 'direct_prefill' ? 'Launched Bet365 direct betslip!' : 'Opened Leg 1 on Bet365 & loaded slip stepper!');
  } catch (err) {
    showToast(err.message, true);
  }
}

async function openSuggestModal(initialRiskOrKey = state.activeRiskLevel || 'high') {
  const modal = document.getElementById('suggest-modal');
  const titleEl = document.getElementById('suggest-modal-title');
  const subEl = document.getElementById('suggest-modal-subtitle');
  const body = document.getElementById('suggest-modal-body');
  if (!modal || !body) return;

  titleEl.textContent = '✨ Smart Bet Assistant & Bet365 Export';
  subEl.textContent = 'Pick your risk appetite — from steady 1/1–2/1 builders to small-stake 40/1+ longshots';
  modal.classList.remove('hidden');
  body.innerHTML = '<div class="text-sm text-slate-400 py-8 text-center">Analyzing upcoming fixtures, Bet365 odds &amp; team news...</div>';

  try {
    const res = await api('/api/suggest-bet');
    const suggestions = res.suggestions || [];
    const riskLevels = res.risk_levels || [];
    const byRisk = res.by_risk || {};
    if (!suggestions.length && !riskLevels.length) {
      body.innerHTML = '<div class="text-sm text-slate-400 py-6 text-center">No scheduled fixtures available yet — click Sync Live Data first.</div>';
      return;
    }

    let activeRisk = state.activeRiskLevel || 'high';
    let activeKey = null;

    if (byRisk[initialRiskOrKey]) {
      activeRisk = initialRiskOrKey;
      activeKey = byRisk[activeRisk]?.primary?.id || byRisk[activeRisk]?.options?.[0]?.id;
    } else if (res.by_id?.[initialRiskOrKey]) {
      const matched = res.by_id[initialRiskOrKey];
      activeKey = matched.id;
      activeRisk = matched.risk_level || activeRisk;
    }

    if (!byRisk[activeRisk] && riskLevels.length) {
      activeRisk = riskLevels[0].id;
    }
    if (!activeKey || !res.by_id?.[activeKey]) {
      activeKey = byRisk[activeRisk]?.primary?.id || byRisk[activeRisk]?.options?.[0]?.id || suggestions[0]?.id;
    }

    const getPkgStake = (pkg, tier) => Number(pkg?.stake || tier?.default_stake || state.slipStake || 5);
    let currentStake = getPkgStake(res.by_id?.[activeKey], byRisk[activeRisk]);

    const persistRisk = (riskId) => {
      state.activeRiskLevel = riskId;
      try {
        localStorage.setItem('accalab_risk_level', riskId);
      } catch (_) { }
      if (state.activeTab === 'fixtures') renderFixturesTab();
    };

    const renderPkg = () => {
      const tier = byRisk[activeRisk] || riskLevels[0] || {};
      const tierOptions = tier.options || suggestions;
      const s = res.by_id?.[activeKey] || tier.primary || tierOptions[0] || suggestions[0];
      const ev = s.eval || {};
      const evPos = Number(ev.expected_value_pct || 0) >= 0;
      const combinedDec = Number(ev.combined_odds || 1);
      const stakeNum = Math.max(0.5, Number(currentStake || getPkgStake(s, tier)));
      const tunedReturn = Math.round(stakeNum * combinedDec * 100) / 100;
      const tunedProfit = Math.round((tunedReturn - stakeNum) * 100) / 100;
      const quickStakes = [1, 2, 5, 10, 20];

      body.innerHTML = `
        <div class="space-y-1.5">
          <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400">1. Choose Your Risk Level</div>
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
            ${riskLevels
          .map((rl) => {
            const isActive = rl.id === activeRisk;
            const pOdds = rl.primary?.eval?.combined_odds;
            return `
              <button type="button" data-risk-tier="${esc(rl.id)}" class="p-2.5 rounded-xl text-left border transition ${isActive
                ? 'bg-emerald-500/20 border-emerald-400 text-white shadow-sm shadow-emerald-500/20'
                : 'bg-card border-slate-800 text-slate-300 hover:border-slate-600'
              }">
                <div class="flex items-center justify-between gap-1">
                  <span class="text-xs font-extrabold">${esc(rl.emoji || '')} ${esc(rl.short_label || rl.label)}</span>
                  ${pOdds ? `<span class="text-[11px] font-mono font-bold ${isActive ? 'text-emerald-300' : 'text-emerald-400'}">${esc(fmtOdds(pOdds))}</span>` : ''}
                </div>
                <div class="text-[10px] font-semibold mt-0.5 ${isActive ? 'text-emerald-200' : 'text-slate-400'}">${esc(rl.target_odds_label || '')}</div>
                <div class="text-[10px] text-slate-400 truncate mt-0.5">Default £${Number(rl.default_stake || 5).toFixed(0)} stake</div>
              </button>`;
          })
          .join('')}
          </div>
        </div>

        <div class="space-y-1.5">
          <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400">2. Pick Angle Within ${esc(tier.short_label || activeRisk)}</div>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
            ${tierOptions
          .map(
            (item) => `
              <button type="button" data-sug-tab="${esc(item.id)}" class="px-3 py-2 rounded-xl text-left border transition ${item.id === s.id
                ? 'bg-indigo-500/20 border-indigo-400 text-white'
                : 'bg-card border-slate-800 text-slate-300 hover:border-slate-600'
              }">
                <div class="flex items-center justify-between gap-1">
                  <span class="text-[10px] font-bold uppercase tracking-wider ${item.id === s.id ? 'text-indigo-300' : 'text-slate-400'}">${esc(item.badge)}</span>
                  <span class="text-[11px] font-mono font-bold text-emerald-400">${esc(fmtOdds(item.eval?.combined_odds || 1))}</span>
                </div>
                <div class="text-xs font-bold truncate mt-0.5">${esc(item.title)}</div>
              </button>`
          )
          .join('')}
          </div>
        </div>

        <div class="p-4 rounded-2xl bg-card border border-slate-800 space-y-3">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 class="text-base font-extrabold text-white">${esc(s.title)}</h3>
              <p class="text-xs text-slate-400 mt-0.5">${esc(s.subtitle)}</p>
            </div>
            <div class="px-3 py-1 rounded-full bg-emerald-500/20 border border-emerald-400/50 text-emerald-300 text-xs font-extrabold font-mono">
              ${s.confidence_score}% Confidence
            </div>
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div class="p-2.5 rounded-xl bg-panel border border-slate-800"><div class="text-slate-400">Combined Odds</div><div class="text-sm font-bold font-mono text-emerald-400">${esc(fmtOdds(combinedDec))}</div></div>
            <div class="p-2.5 rounded-xl bg-panel border border-slate-800"><div class="text-slate-400">Model Hit Prob</div><div class="text-sm font-bold font-mono text-white">${Number(ev.combined_model_prob_pct || 0).toFixed(1)}%</div></div>
            <div class="p-2.5 rounded-xl bg-panel border border-slate-800"><div class="text-slate-400">Expected Value</div><div class="text-sm font-bold font-mono ${evPos ? 'text-emerald-400' : 'text-amber-300'}">${evPos ? '+' : ''}${Number(ev.expected_value_pct || 0).toFixed(1)}%</div></div>
            <div class="p-2.5 rounded-xl bg-panel border border-slate-800">
              <div class="text-slate-400">Potential Return</div>
              <div id="sug-return-val" class="text-sm font-bold font-mono text-white">${fmtGbp(tunedReturn)}</div>
              <div id="sug-profit-val" class="text-[10px] font-mono text-emerald-400">+${fmtGbp(tunedProfit)} profit</div>
            </div>
          </div>

          <div class="p-3 rounded-xl bg-panel border border-slate-800 flex flex-wrap items-center justify-between gap-2">
            <div class="text-xs font-semibold text-slate-300">Stake Tuner</div>
            <div class="flex flex-wrap items-center gap-1.5">
              ${quickStakes
          .map(
            (amt) => `
                <button type="button" data-sug-stake="${amt}" class="px-2.5 py-1 rounded-lg text-xs font-mono font-bold border transition ${Math.abs(stakeNum - amt) < 0.01
                ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300'
                : 'bg-surface border-slate-700 text-slate-300 hover:border-slate-500'
              }">£${amt}</button>`
          )
          .join('')}
              <div class="flex items-center gap-1 ml-1">
                <span class="text-xs text-slate-400">£</span>
                <input id="sug-stake-input" type="number" min="0.5" step="0.5" value="${stakeNum}" class="w-16 px-2 py-1 rounded-lg bg-surface border border-slate-700 text-xs font-mono text-white focus:outline-none focus:border-emerald-400" />
              </div>
            </div>
          </div>

          <div class="space-y-2">
            ${(s.legs || [])
          .map(
            (l, i) => `
              <div class="p-3 rounded-xl bg-surface/80 border border-slate-700/80 flex items-center justify-between gap-2 text-xs">
                <div class="min-w-0">
                  <div class="text-[11px] text-emerald-400 font-semibold">${esc(l.league_name)} • ${esc(l.match_date)}</div>
                  <div class="font-bold text-white truncate mt-0.5">${i + 1}. ${esc(l.selection_label)}</div>
                  <div class="text-[11px] text-slate-400 truncate">${esc(l.home_team)} vs ${esc(l.away_team)}</div>
                </div>
                <div class="text-right font-mono shrink-0">
                  <div class="text-sm font-extrabold text-emerald-400">@ ${esc(fmtOdds(l.odds))}</div>
                  <div class="text-[10px] text-slate-400">${(Number(l.model_prob) * 100).toFixed(0)}% (${Number(l.edge_pct) >= 0 ? '+' : ''}${Number(l.edge_pct).toFixed(1)}% EV)</div>
                </div>
              </div>`
          )
          .join('')}
          </div>

          <div class="p-3 rounded-xl bg-panel border border-slate-800 space-y-1.5">
            <div class="text-[11px] font-bold uppercase tracking-wider text-cyan-300">Why AccaLab Picked This</div>
            <ul class="space-y-1 text-xs text-slate-300 list-disc pl-4">
              ${(s.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('')}
            </ul>
          </div>

          <div class="flex flex-wrap gap-2 pt-1">
            <button id="sug-export-b365-btn" type="button" class="flex-1 py-2.5 px-4 rounded-xl btn-bet365 text-xs font-extrabold">🚀 1-Touch Export to Bet365 (£${stakeNum % 1 === 0 ? stakeNum.toFixed(0) : stakeNum.toFixed(2)})</button>
            <button id="sug-load-slip-btn" type="button" class="px-3.5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold">🧾 Load to Slip</button>
            <button id="sug-save-draft-btn" type="button" class="px-3.5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold">💾 Save Draft</button>
          </div>
        </div>
      `;

      body.querySelectorAll('[data-risk-tier]').forEach((btn) =>
        btn.addEventListener('click', () => {
          activeRisk = btn.dataset.riskTier;
          const nextTier = byRisk[activeRisk];
          const nextPkg = nextTier?.primary || nextTier?.options?.[0];
          if (nextPkg) activeKey = nextPkg.id;
          currentStake = getPkgStake(res.by_id?.[activeKey], nextTier);
          persistRisk(activeRisk);
          renderPkg();
        })
      );

      body.querySelectorAll('[data-sug-tab]').forEach((btn) =>
        btn.addEventListener('click', () => {
          activeKey = btn.dataset.sugTab;
          currentStake = getPkgStake(res.by_id?.[activeKey], byRisk[activeRisk]);
          renderPkg();
        })
      );

      body.querySelectorAll('[data-sug-stake]').forEach((btn) =>
        btn.addEventListener('click', () => {
          currentStake = Number(btn.dataset.sugStake);
          renderPkg();
        })
      );

      const stakeInput = document.getElementById('sug-stake-input');
      if (stakeInput) {
        stakeInput.addEventListener('input', () => {
          const parsed = Number(stakeInput.value);
          if (!Number.isFinite(parsed) || parsed <= 0) return;
          currentStake = parsed;
          const nextRet = Math.round(currentStake * combinedDec * 100) / 100;
          const nextProf = Math.round((nextRet - currentStake) * 100) / 100;
          const retEl = document.getElementById('sug-return-val');
          const profEl = document.getElementById('sug-profit-val');
          const expBtn = document.getElementById('sug-export-b365-btn');
          if (retEl) retEl.textContent = fmtGbp(nextRet);
          if (profEl) profEl.textContent = `+${fmtGbp(nextProf)} profit`;
          if (expBtn) expBtn.textContent = `🚀 1-Touch Export to Bet365 (£${currentStake % 1 === 0 ? currentStake.toFixed(0) : currentStake.toFixed(2)})`;
          body.querySelectorAll('[data-sug-stake]').forEach((b) => {
            const match = Math.abs(Number(b.dataset.sugStake) - currentStake) < 0.01;
            b.className = `px-2.5 py-1 rounded-lg text-xs font-mono font-bold border transition ${match
                ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300'
                : 'bg-surface border-slate-700 text-slate-300 hover:border-slate-500'
              }`;
          });
        });
      }

      document.getElementById('sug-export-b365-btn').addEventListener('click', () =>
        exportToBet365(s.legs, currentStake, s.title)
      );
      document.getElementById('sug-load-slip-btn').addEventListener('click', () => {
        state.slip = s.legs.map((l) => ({ ...l }));
        state.slipStake = Number(currentStake || state.slipStake || 10);
        saveSlip();
        renderSlip();
        modal.classList.add('hidden');
        document.getElementById('slip-drawer').classList.remove('hidden');
        if (state.activeTab === 'fixtures') renderFixturesTab();
        showToast(`Loaded "${s.title}" (£${state.slipStake}) into your Bet Slip!`);
      });
      document.getElementById('sug-save-draft-btn').addEventListener('click', async () => {
        if (!state.activeUserId || Number(state.activeUserId) === 0) {
          showToast('Create your account first to save accumulator drafts!');
          openAuthModal('register');
          return;
        }
        try {
          const saved = await api('/api/user/saved-accas', {
            method: 'POST',
            body: JSON.stringify({ name: s.title, stake: currentStake, legs: s.legs }),
          });
          await loadDashboard(false);
          if (state.activeTab === 'acca') renderAccaTab();
          showToast(`Saved "${saved.saved_acca.name}" to your drafts!`);
        } catch (err) {
          showToast(err.message, true);
        }
      });
    };

    renderPkg();
  } catch (err) {
    body.innerHTML = `<div class="text-sm text-rose-400 py-6 text-center">${esc(err.message)}</div>`;
  }
}

function bindGlobalEvents() {
  document.querySelectorAll('[data-tab]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.activeTab = btn.dataset.tab;
      renderActiveTab();
    })
  );

  const onUserChange = async (e) => {
    const targetId = Number(e.target.value);
    if (state.authenticated) {
      await api('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => { });
    }
    state.activeUserId = targetId;
    localStorage.setItem('accalab_user_id', String(state.activeUserId));
    await loadDashboard(true);
    saveSlip(false);
    renderActiveTab();
  };
  document.getElementById('user-switcher').addEventListener('change', onUserChange);
  document.getElementById('user-switcher-mobile').addEventListener('change', onUserChange);

  const openAuthSidebar = document.getElementById('open-auth-modal-btn');
  if (openAuthSidebar) {
    openAuthSidebar.addEventListener('click', () => openAuthModal());
  }
  const openAuthMobile = document.getElementById('open-auth-modal-mobile-btn');
  if (openAuthMobile) {
    openAuthMobile.addEventListener('click', () => openAuthModal());
  }
  const closeAuth = document.getElementById('close-auth-modal');
  if (closeAuth) {
    closeAuth.addEventListener('click', () => document.getElementById('auth-modal').classList.add('hidden'));
  }
  const authTabLogin = document.getElementById('auth-tab-login');
  if (authTabLogin) {
    authTabLogin.addEventListener('click', () => renderAuthModalBody('login'));
  }
  const authTabReg = document.getElementById('auth-tab-register');
  if (authTabReg) {
    authTabReg.addEventListener('click', () => renderAuthModalBody('register'));
  }

  document.getElementById('open-suggest-btn')?.addEventListener('click', () => openSuggestModal(state.activeRiskLevel || 'high'));
  document.getElementById('open-suggest-sidebar-btn')?.addEventListener('click', () => openSuggestModal(state.activeRiskLevel || 'high'));
  document.getElementById('close-suggest-modal')?.addEventListener('click', () =>
    document.getElementById('suggest-modal').classList.add('hidden')
  );

  document.getElementById('sync-btn-sidebar').addEventListener('click', () => triggerSync(false, false));
  document.getElementById('close-preview-modal').addEventListener('click', () =>
    document.getElementById('preview-modal').classList.add('hidden')
  );
  document.getElementById('open-slip-btn').addEventListener('click', () => {
    renderSlip();
    document.getElementById('slip-drawer').classList.remove('hidden');
  });
  document.getElementById('close-slip-btn').addEventListener('click', () =>
    document.getElementById('slip-drawer').classList.add('hidden')
  );
}

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { });
  }
  bindGlobalEvents();
  await loadDashboard(true);
  saveSlip(false);
  await renderActiveTab();
  if (!(state.dashboard?.users || []).length) {
    openAuthModal('register');
  }
}

boot();
