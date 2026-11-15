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
  kickoffFilter: 'ALL',
  valDiv: '',
  valMinEdge: null,
  valOfficialOnly: false,
  b365ChecklistSource: 'suggest',
  liveScoresByMatch: {},
  liveScoresUpdatedAt: null,
  charts: {},
};

const esc = (s) => {
  const raw = s && typeof s === 'object' ? (s.name ?? s.label ?? s.title ?? '') : s;
  return String(raw ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
};

const getLeagueName = (div, meta = {}) =>
  meta?.[div]?.name ||
  (typeof meta?.[div] === 'string' ? meta[div] : '') ||
  ({ E0: 'Premier League', E1: 'Championship', E2: 'League One', E3: 'League Two' }[div] || div);

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

const KICKOFF_FILTER_OPTIONS = [
  ['ALL', 'All Dates'],
  ['TODAY', '⚡ Today'],
  ['SAT_3PM', '🕒 Sat 3pm'],
  ['WEEKEND', '📅 Weekend'],
  ['MIDWEEK', '🌙 Midweek'],
];

function matchesKickoffFilter(item, mode = state.kickoffFilter, nowDate = new Date()) {
  if (!mode || mode === 'ALL') return true;
  const mdate = String(item?.match_date || '').trim();
  if (!mdate) return true;
  const todayIso = nowDate.toISOString().slice(0, 10);
  if (mode === 'TODAY') return mdate === todayIso;
  const dt = new Date(`${mdate}T12:00:00Z`);
  if (Number.isNaN(dt.getTime())) return true;
  const dow = dt.getUTCDay(); // 0=Sun .. 6=Sat
  const ktime = String(item?.kickoff_time || '').trim();
  if (mode === 'SAT_3PM') {
    return dow === 6 && (!ktime || (ktime >= '14:45' && ktime <= '15:15'));
  }
  if (mode === 'WEEKEND') {
    return dow === 6 || dow === 0 || (dow === 5 && (!ktime || ktime >= '18:00'));
  }
  if (mode === 'MIDWEEK') {
    return dow >= 1 && dow <= 4;
  }
  return true;
}

function marketFamily(market) {
  const m = String(market || '');
  if (m.startsWith('1X2_')) return '1X2';
  if (m.startsWith('OU_')) return 'OU';
  if (m.startsWith('BTTS_')) return 'BTTS';
  return m;
}

const ESPN_TEAM_ALIASES_CLIENT = {
  'man utd': 'Man United',
  'manchester utd': 'Man United',
  'manchester united': 'Man United',
  'man city': 'Man City',
  'manchester city': 'Man City',
  spurs: 'Tottenham',
  'tottenham hotspur': 'Tottenham',
  'nottingham forest': "Nott'm Forest",
  'nottm forest': "Nott'm Forest",
  'newcastle united': 'Newcastle',
  'leeds united': 'Leeds',
  'brighton & hove albion': 'Brighton',
  'brighton and hove albion': 'Brighton',
  'afc bournemouth': 'Bournemouth',
  'coventry city': 'Coventry',
  'ipswich town': 'Ipswich',
  'sunderland afc': 'Sunderland',
  'birmingham city': 'Birmingham',
  'blackburn rovers': 'Blackburn',
  'bolton wanderers': 'Bolton',
  'cardiff city': 'Cardiff',
  'charlton athletic': 'Charlton',
  'derby county': 'Derby',
  'lincoln city': 'Lincoln',
  'norwich city': 'Norwich',
  'preston north end': 'Preston',
  'queens park rangers': 'QPR',
  'stoke city': 'Stoke',
  'swansea city': 'Swansea',
  'west bromwich albion': 'West Brom',
  'west ham united': 'West Ham',
  'wolverhampton wanderers': 'Wolves',
  wolverhampton: 'Wolves',
  'hull city': 'Hull',
  'sheffield utd': 'Sheffield United',
  'bradford city': 'Bradford',
  'burton albion': 'Burton',
  'cambridge united': 'Cambridge',
  'doncaster rovers': 'Doncaster',
  'huddersfield town': 'Huddersfield',
  'leicester city': 'Leicester',
  'luton town': 'Luton',
  'mansfield town': 'Mansfield',
  'mk dons': 'Milton Keynes Dons',
  'oxford united': 'Oxford',
  'peterborough united': 'Peterboro',
  peterborough: 'Peterboro',
  'plymouth argyle': 'Plymouth',
  'sheffield wednesday': 'Sheffield Weds',
  'sheffield weds': 'Sheffield Weds',
  'stockport county': 'Stockport',
  'wigan athletic': 'Wigan',
  'wycombe wanderers': 'Wycombe',
  'accrington stanley': 'Accrington',
  'bristol rovers': 'Bristol Rvs',
  'cheltenham town': 'Cheltenham',
  'colchester united': 'Colchester',
  'crewe alexandra': 'Crewe',
  'exeter city': 'Exeter',
  'grimsby town': 'Grimsby',
  'northampton town': 'Northampton',
  'oldham athletic': 'Oldham',
  'rotherham united': 'Rotherham',
  'salford city': 'Salford',
  'shrewsbury town': 'Shrewsbury',
  'swindon town': 'Swindon',
  'tranmere rovers': 'Tranmere',
  'york city': 'York',
  'harrogate town': 'Harrogate',
  'carlisle united': 'Carlisle',
  'forest green rovers': 'Forest Green',
};

function normalizeEspnTeamClient(name) {
  const cleaned = String(name || '').replace(/\s+/g, ' ').trim();
  const key = cleaned.toLowerCase();
  return ESPN_TEAM_ALIASES_CLIENT[key] || cleaned;
}

async function fetchLiveScoresForDates(dateList = []) {
  const dates = [...new Set(
    [
      new Date().toISOString().slice(0, 10),
      ...dateList.map((d) => String(d || '').slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
    ]
  )].slice(0, 6);
  const slugs = ['eng.1', 'eng.2', 'eng.3', 'eng.4'];
  let loaded = 0;

  await Promise.all(
    dates.flatMap((dStr) => {
      const yyyymmdd = dStr.replaceAll('-', '');
      return slugs.map(async (slug) => {
        try {
          const resp = await fetch(
            `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${yyyymmdd}`
          );
          if (!resp.ok) return;
          const data = await resp.json();
          for (const ev of data.events || []) {
            const comp = (ev.competitions || [{}])[0];
            let homeName = '';
            let awayName = '';
            let homeScore = null;
            let awayScore = null;
            for (const tm of comp.competitors || []) {
              const nm = normalizeEspnTeamClient(tm.team?.displayName || '');
              const sc = tm.score !== undefined && tm.score !== '' ? Number(tm.score) : null;
              if (tm.homeAway === 'home') {
                homeName = nm;
                homeScore = sc;
              } else if (tm.homeAway === 'away') {
                awayName = nm;
                awayScore = sc;
              }
            }
            if (!homeName || !awayName) continue;
            const st = comp.status?.type || {};
            const stateCode = st.state || 'pre'; // 'pre' | 'in' | 'post'
            const detail = st.shortDetail || st.description || '';
            const evDate = String(ev.date || '').slice(0, 10) || dStr;
            const entry = { homeName, awayName, homeGoals: homeScore, awayGoals: awayScore, state: stateCode, detail, date: evDate };
            state.liveScoresByMatch[`${evDate}:${homeName}:${awayName}`] = entry;
            state.liveScoresByMatch[`${dStr}:${homeName}:${awayName}`] = entry;
            state.liveScoresByMatch[`*:${homeName}:${awayName}`] = entry;
            loaded += 1;
          }
        } catch (_) { }
      });
    })
  );
  state.liveScoresUpdatedAt = new Date().toISOString();
  return loaded;
}

function evaluateLegLiveStatus(leg) {
  if (!leg) return null;
  const d = String(leg.match_date || '').slice(0, 10);
  const live =
    state.liveScoresByMatch[`${d}:${leg.home_team}:${leg.away_team}`] ||
    state.liveScoresByMatch[`*:${leg.home_team}:${leg.away_team}`];
  if (!live) return null;
  if (live.state === 'pre') {
    return {
      status: 'pre',
      html: `<span class="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 text-[10px] font-mono">🕒 ${esc(live.detail || leg.kickoff_time || 'Pre-match')}</span>`,
    };
  }
  const h = Number(live.homeGoals ?? 0);
  const a = Number(live.awayGoals ?? 0);
  const m = String(leg.market || '');
  let winning = null;
  if (m === '1X2_H') winning = h > a;
  else if (m === '1X2_D') winning = h === a;
  else if (m === '1X2_A') winning = a > h;
  else if (m === 'OU_O25') winning = h + a >= 3;
  else if (m === 'OU_U25') winning = h + a <= 2;
  else if (m === 'BTTS_Y') winning = h >= 1 && a >= 1;
  else if (m === 'BTTS_N') winning = !(h >= 1 && a >= 1);
  else if (m === 'COMBO_H_BTTS') winning = h > a && h >= 1 && a >= 1;
  else if (m === 'COMBO_H_O25') winning = h > a && h + a >= 3;
  else if (m === 'COMBO_O25_BTTS') winning = h + a >= 3 && h >= 1 && a >= 1;
  else if (m === 'COMBO_A_BTTS') winning = a > h && h >= 1 && a >= 1;
  else if (m === 'COMBO_A_O25') winning = a > h && h + a >= 3;
  else if (m === 'COMBO_H_WIN_NIL') winning = h > a && a === 0;
  else if (m === 'COMBO_A_WIN_NIL') winning = a > h && h === 0;

  const isFinal = live.state === 'post';
  const scoreTxt = `${h}-${a}${isFinal ? ' FT' : live.detail ? ` (${live.detail})` : ' Live'}`;
  if (winning === null) {
    return {
      status: live.state,
      html: `<span class="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-200 text-[10px] font-mono">⚽ ${esc(scoreTxt)}</span>`,
    };
  }
  if (isFinal) {
    return {
      status: winning ? 'won' : 'lost',
      html: winning
        ? `<span class="px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-400/50 text-emerald-300 text-[10px] font-bold">✅ Won • ${esc(scoreTxt)}</span>`
        : `<span class="px-1.5 py-0.5 rounded bg-rose-500/20 border border-rose-400/50 text-rose-300 text-[10px] font-bold">❌ Lost • ${esc(scoreTxt)}</span>`,
    };
  }
  return {
    status: winning ? 'winning' : 'losing',
    html: winning
      ? `<span class="px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-400/50 text-emerald-300 text-[10px] font-bold">🟢 Winning • ${esc(scoreTxt)}</span>`
      : `<span class="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-400/50 text-amber-200 text-[10px] font-bold">🔴 Behind • ${esc(scoreTxt)}</span>`,
  };
}

async function shareAccaSummary(legs = [], title = 'AccaLab Tips') {
  if (!legs || !legs.length) {
    showToast('Add at least one leg to share!', true);
    return;
  }
  const ev = evaluateAccaClient(legs, 10);
  const lines = [
    `⚽ ${title} (${legs.length}-Fold @ ${fmtOdds(ev.combined_odds)})`,
    `📊 Model Win Chance: ${ev.combined_model_prob_pct}% (${ev.expected_value_pct >= 0 ? '+' : ''}${ev.expected_value_pct}% Value)`,
    '',
    ...legs.map((l, i) => `${i + 1}. ${l.home_team} vs ${l.away_team} — ${l.selection_label} @ ${fmtOdds(l.odds)}`),
    '',
    'Built with AccaLab',
  ];
  const text = lines.join('\n');
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard?.writeText(text);
    showToast('📋 Copied tips — ready to paste into WhatsApp or group chat!');
  } catch (_) {
    showToast('Could not copy to clipboard', true);
  }
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
  const fixById = new Map(
    ((typeof _staticSnapshot !== 'undefined' && _staticSnapshot?.fixtures) || []).map((f) => [Number(f.id), f])
  );

  for (const leg of legs) {
    const fx = fixById.get(Number(leg.fixture_id));
    const div = String(leg.div || fx?.div || '');
    const leagueName = leaguesMeta[div]?.name || leg.league_name || fx?.league_name || (div ? getLeagueName(div, leaguesMeta) : '') || 'English Football';
    const matchDate = leg.match_date || fx?.match_date || '';
    const kickoffTime = leg.kickoff_time || fx?.kickoff_time || '';
    const home = String(leg.home_team || fx?.home_team || '').trim();
    const away = String(leg.away_team || fx?.away_team || '').trim();
    const b365Home = b365SearchTeam(home);
    const b365Away = b365SearchTeam(away);
    const mkt = String(leg.market || '1X2_H');
    const b365Market = B365_MARKET_NAMES[mkt] || (mkt.startsWith('COMBO_') ? 'Bet Builder / Bet Boost' : 'Full Time Result');
    const b365Selection = b365SelectionNameClient(leg);
    const oddsVal = roundNum(Number(leg.odds || 1.0), 2);
    const oddsFrac = fmtOdds(oddsVal);
    const searchTerm = b365Home && b365Away ? `${b365Home} v ${b365Away}` : b365Home || b365Away || 'Football';
    const searchHash = `#/AX/K^${encodeURIComponent(searchTerm)}/`;

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
      match_date: matchDate,
      kickoff_time: kickoffTime,
      home_team: home,
      away_team: away,
      b365_home: b365Home,
      b365_away: b365Away,
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

  const betType = legs.length > 1 ? 'combo' : 'single';
  const overrideClean = String(optionsOverride || '').trim();
  const resolvedOptions =
    overrideClean || (legOptionTokens.length === legs.length && legOptionTokens.length ? legOptionTokens.join(',') : '');
  const prefillTemplateUrl = `https://www.bet365.com/en/sports?options={eventId}-{marketId}-{selectionId}&type=${betType}&stake=${cleanStake.toFixed(2)}&currency=GBP`;

  let deepLinkUrl = null;
  let launchUrl = exportedLegs[0]?.b365_search_url || 'https://www.bet365.com/#/HO/';
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
  const res = await fetch(`./static/snapshot.json${suffix}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Unable to load static snapshot (HTTP ${res.status})`);
  _staticSnapshot = await res.json();
  return _staticSnapshot;
}

const SUPABASE_URL = 'https://xnvwpwygwhfgvcadlnaf.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_mWiD-10wVSFNVhK1tqODKQ_eR_3I1EF';
let _sbClient = null;

function getSupabaseClient() {
  if (_sbClient) return _sbClient;
  if (typeof window !== 'undefined' && window.supabase && typeof window.supabase.createClient === 'function') {
    const url = state.dashboard?.integrations?.supabase_url || SUPABASE_URL;
    const key = state.dashboard?.integrations?.supabase_anon_key || SUPABASE_ANON_KEY;
    if (url && key) {
      _sbClient = window.supabase.createClient(url, key, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          storageKey: 'accalab_supabase_auth',
        },
      });
    }
  }
  return _sbClient;
}

function mapCloudProfile(p) {
  if (!p) return null;
  return sanitizeStaticUser({
    id: Number(p.id),
    auth_user_id: p.auth_user_id,
    username: p.username,
    display_name: p.display_name,
    email: p.email || '',
    avatar_color: p.avatar_color || '#10b981',
    bankroll: Number(p.bankroll ?? 250),
    kelly_fraction: Number(p.kelly_fraction ?? 0.25),
    min_edge_pct: Number(p.min_edge_pct ?? 4.0),
    telegram_chat_id: p.telegram_chat_id || '',
    monthly_stake_limit: Number(p.monthly_stake_limit ?? 200),
    show_on_leaderboard: Number(p.show_on_leaderboard ?? 1),
    favourite_teams: Array.isArray(p.favourite_teams) ? p.favourite_teams : [],
    preferred_leagues:
      Array.isArray(p.preferred_leagues) && p.preferred_leagues.length
        ? p.preferred_leagues
        : ['E0', 'E1', 'E2', 'E3'],
    default_stake: Number(p.default_stake ?? 10),
    active_slip: Array.isArray(p.active_slip) ? p.active_slip : [],
    is_guest: false,
  });
}

async function syncCloudUserToGhState(sb, gh) {
  if (!sb) return null;
  const [{ data: sessData }, { data: lbData }] = await Promise.all([
    sb.auth.getSession(),
    sb.rpc('get_leaderboard'),
  ]);
  gh.cloudLeaderboard = Array.isArray(lbData) ? lbData : [];

  const session = sessData?.session;
  if (!session?.user) {
    gh.authenticatedUserId = null;
    gh.authenticatedAuthUuid = null;
    gh.users = [];
    saveGhState(gh);
    return null;
  }

  const uid = session.user.id;
  let { data: prof } = await sb
    .from('profiles')
    .select('*')
    .eq('auth_user_id', uid)
    .maybeSingle();

  if (!prof) {
    const meta = session.user.user_metadata || {};
    const fallbackName = String(meta.display_name || meta.username || session.user.email?.split('@')[0] || 'Member');
    const fallbackUname =
      String(meta.username || fallbackName)
        .toLowerCase()
        .replaceAll(/[^a-z0-9_-]/g, '') || `user_${uid.slice(0, 8)}`;
    const { data: createdProf } = await sb
      .from('profiles')
      .upsert(
        {
          auth_user_id: uid,
          username: fallbackUname,
          display_name: fallbackName,
          email: meta.contact_email || '',
          avatar_color: meta.avatar_color || '#10b981',
          bankroll: Number(meta.bankroll || 250),
          kelly_fraction: Number(meta.kelly_fraction || 0.25),
          min_edge_pct: Number(meta.min_edge_pct || 4.0),
          telegram_chat_id: meta.telegram_chat_id || '',
          monthly_stake_limit: Number(meta.monthly_stake_limit || 200),
          favourite_teams: Array.isArray(meta.favourite_teams) ? meta.favourite_teams : [],
          preferred_leagues:
            Array.isArray(meta.preferred_leagues) && meta.preferred_leagues.length
              ? meta.preferred_leagues
              : ['E0', 'E1', 'E2', 'E3'],
          default_stake: Number(meta.default_stake || 10),
        },
        { onConflict: 'auth_user_id' }
      )
      .select('*')
      .maybeSingle();
    prof = createdProf;
  }

  if (!prof) return null;

  const [watchRes, accaRes, betsRes] = await Promise.all([
    sb.from('saved_fixtures').select('fixture_id').eq('auth_user_id', uid),
    sb.from('saved_accas').select('*').eq('auth_user_id', uid).order('created_at', { ascending: false }),
    sb.from('bets').select('*').eq('auth_user_id', uid).order('placed_at', { ascending: false }),
  ]);

  const user = mapCloudProfile(prof);
  gh.users = [user];
  gh.authenticatedUserId = user.id;
  gh.authenticatedAuthUuid = uid;
  gh.watchedByUser[user.id] = (watchRes.data || []).map((r) => Number(r.fixture_id));
  gh.savedAccasByUser[user.id] = (accaRes.data || []).map((r) => ({
    ...r,
    id: Number(r.id),
    stake: Number(r.stake),
    combined_odds: Number(r.combined_odds),
    combined_prob: Number(r.combined_prob),
    ev_pct: Number(r.ev_pct),
    legs: Array.isArray(r.legs) ? r.legs : [],
  }));
  gh.betsByUser[user.id] = (betsRes.data || []).map((b) => ({
    ...b,
    id: Number(b.id),
    stake: Number(b.stake),
    combined_odds: Number(b.combined_odds),
    combined_model_prob: Number(b.combined_model_prob),
    expected_value_pct: Number(b.expected_value_pct),
    pnl: Number(b.pnl || 0),
    legs: Array.isArray(b.legs) ? b.legs : [],
  }));
  state.activeUserId = user.id;
  saveGhState(gh);
  return user;
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
  const sb = getSupabaseClient();
  const cloudSyncPaths = new Set([
    '/api/dashboard',
    '/api/auth/me',
    '/api/bets',
    '/api/leaderboard',
    '/api/user/watchlist',
    '/api/user/saved-accas',
  ]);
  if (sb && method === 'GET' && cloudSyncPaths.has(pathname)) {
    await syncCloudUserToGhState(sb, gh).catch(() => null);
  }
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
      integrations: {
        ...(snap.dashboard?.integrations || {}),
        supabase_configured: Boolean(SUPABASE_URL && SUPABASE_ANON_KEY),
        supabase_url: SUPABASE_URL,
        supabase_anon_key: SUPABASE_ANON_KEY,
      },
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
        if (officialOnly && !['bet365_official', 'api_football_b365', 'live_sportsbook', 'user_manual'].includes(o.odds_source)) return false;
        if (officialOnly && ['bet365_official', 'live_sportsbook'].includes(o.odds_source) && String(o.market).startsWith('BTTS')) return false;
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
      if (!targetUser || Number(targetUser.id) === 0 || (sb && !gh.authenticatedAuthUuid)) {
        throw new Error('Please create your account or sign in first.');
      }
      const ev = evaluateAccaClient(legs, stake);
      const now = new Date().toISOString();
      const fixById = new Map((snap.fixtures || []).map((f) => [Number(f.id), f]));
      const betLegs = legs.map((l) => {
        const fx = fixById.get(Number(l.fixture_id));
        return {
          fixture_id: l.fixture_id,
          div: l.div || fx?.div || 'E0',
          match_date: l.match_date || fx?.match_date || now.slice(0, 10),
          home_team: l.home_team || fx?.home_team || '',
          away_team: l.away_team || fx?.away_team || '',
          market: l.market || '1X2_H',
          selection_label: l.selection_label || l.market,
          odds_taken: Number(l.odds || 2.0),
          model_prob: Number(l.model_prob || 0.5),
          closing_odds: null,
          leg_status: 'pending',
        };
      });

      if (sb) {
        const { data: betRow, error: betErr } = await sb
          .from('bets')
          .insert({
            auth_user_id: gh.authenticatedAuthUuid,
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
            legs: betLegs,
          })
          .select('*')
          .single();
        if (betErr) throw new Error(betErr.message);
        if (!gh.betsByUser[targetUser.id]) gh.betsByUser[targetUser.id] = [];
        gh.betsByUser[targetUser.id].unshift({
          ...betRow,
          id: Number(betRow.id),
          stake: Number(betRow.stake),
          combined_odds: Number(betRow.combined_odds),
          combined_model_prob: Number(betRow.combined_model_prob),
          expected_value_pct: Number(betRow.expected_value_pct),
          pnl: Number(betRow.pnl || 0),
          legs: Array.isArray(betRow.legs) ? betRow.legs : betLegs,
        });
        saveGhState(gh);
        return { ok: true, bet_id: Number(betRow.id), auto_settled: 0 };
      }

      const betId = gh.nextIds.bet++;
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
        legs: betLegs.map((l) => ({ ...l, bet_id: betId })),
      });
      saveGhState(gh);
      return { ok: true, bet_id: betId, auto_settled: 0 };
    }
  }

  if (pathname === '/api/bets/settle' && method === 'POST') {
    return { settled: 0 };
  }

  if (pathname === '/api/leaderboard') {
    if (sb) {
      return { leaderboard: gh.cloudLeaderboard || [], invite_code_hint: 'Ask admin for invite code' };
    }
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
    if (password.length < 6) throw new Error('Password must be at least 6 characters');

    const favTeams = Array.isArray(bodyData.favourite_teams) ? bodyData.favourite_teams : [];
    const prefLeagues =
      Array.isArray(bodyData.preferred_leagues) && bodyData.preferred_leagues.length
        ? bodyData.preferred_leagues
        : ['E0', 'E1', 'E2', 'E3'];

    if (sb) {
      const contactEmail = (bodyData.email || '').trim().toLowerCase();
      const authEmail = contactEmail || `${username}@users.accalab.app`;
      const { data: signUpData, error: signUpErr } = await sb.auth.signUp({
        email: authEmail,
        password,
        options: {
          data: {
            username,
            display_name: displayName,
            contact_email: contactEmail,
            avatar_color: bodyData.avatar_color || '#10b981',
            bankroll: Number(bodyData.bankroll || 250),
            kelly_fraction: Number(bodyData.kelly_fraction || 0.25),
            min_edge_pct: Number(bodyData.min_edge_pct || 4.0),
            telegram_chat_id: (bodyData.telegram_chat_id || '').trim(),
            monthly_stake_limit: Number(bodyData.monthly_stake_limit || 200),
            favourite_teams: favTeams,
            preferred_leagues: prefLeagues,
            default_stake: Number(bodyData.default_stake || 10.0),
          },
        },
      });
      if (signUpErr) {
        const msg = String(signUpErr.message || '');
        if (msg.toLowerCase().includes('already registered')) {
          throw new Error(`Account for '${contactEmail || username}' is already registered — sign in instead.`);
        }
        throw new Error(msg);
      }
      if (!signUpData?.session) {
        const { error: signInErr } = await sb.auth.signInWithPassword({ email: authEmail, password });
        if (signInErr) throw new Error(signInErr.message);
      }
      const cloudUser = await syncCloudUserToGhState(sb, gh);
      if (!cloudUser) throw new Error('Account created, please sign in to finish loading your cloud profile.');
      return { ok: true, user: cloudUser };
    }

    if (gh.users.some((u) => String(u.username).toLowerCase() === username)) {
      throw new Error(`Username '${username}' is already taken`);
    }
    const newId = gh.nextIds.user++;
    const newUser = sanitizeStaticUser({
      id: newId,
      username,
      display_name: displayName,
      email: (bodyData.email || '').trim().toLowerCase(),
      avatar_color: bodyData.avatar_color || '#10b981',
      bankroll: Number(bodyData.bankroll || 250),
      kelly_fraction: Number(bodyData.kelly_fraction || 0.25),
      min_edge_pct: Number(bodyData.min_edge_pct || 4.0),
      telegram_chat_id: (bodyData.telegram_chat_id || '').trim(),
      monthly_stake_limit: Number(bodyData.monthly_stake_limit || 200),
      show_on_leaderboard: bodyData.show_on_leaderboard === false ? 0 : 1,
      favourite_teams: favTeams,
      preferred_leagues: prefLeagues,
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
    if (!ident || !password) throw new Error('Username and password are required');

    if (sb) {
      let loginEmail = '';
      const { data: resolvedEmail } = await sb.rpc('resolve_login_email', { p_identifier: ident });
      if (typeof resolvedEmail === 'string' && resolvedEmail.includes('@')) {
        loginEmail = resolvedEmail;
      } else if (ident.includes('@')) {
        loginEmail = ident;
      } else {
        loginEmail = `${ident.replaceAll(/[^a-z0-9_-]/g, '')}@users.accalab.app`;
      }
      const { error: loginErr } = await sb.auth.signInWithPassword({ email: loginEmail, password });
      if (loginErr) throw new Error('Invalid username or password');
      const cloudUser = await syncCloudUserToGhState(sb, gh);
      if (!cloudUser) throw new Error('Unable to load cloud profile after sign in');
      return { ok: true, user: cloudUser };
    }

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
    if (sb) {
      await sb.auth.signOut().catch(() => { });
      gh.users = [];
    }
    gh.authenticatedUserId = null;
    gh.authenticatedAuthUuid = null;
    state.activeUserId = 0;
    state.authenticated = false;
    localStorage.removeItem('accalab_user_id');
    saveGhState(gh);
    return { ok: true };
  }

  if (pathname === '/api/auth/password' && method === 'POST') {
    if (!activeUser || Number(activeUser.id) === 0 || (sb && !gh.authenticatedAuthUuid)) {
      throw new Error('Please create your account or sign in first.');
    }
    const curr = String(bodyData.current_password || '');
    const newPw = String(bodyData.new_password || '');
    if (newPw.length < 6) throw new Error('New password must be at least 6 characters');
    if (sb) {
      const { data: userData } = await sb.auth.getUser();
      const emailForVerify = userData?.user?.email;
      if (curr && emailForVerify) {
        const { error: reauthErr } = await sb.auth.signInWithPassword({ email: emailForVerify, password: curr });
        if (reauthErr) throw new Error('Current password is incorrect');
      }
      const { error: pwErr } = await sb.auth.updateUser({ password: newPw });
      if (pwErr) throw new Error(pwErr.message);
      return { ok: true };
    }
    if (!gh.passwordsByUserId[activeUser.id] || curr !== gh.passwordsByUserId[activeUser.id]) {
      throw new Error('Current password is incorrect');
    }
    gh.passwordsByUserId[activeUser.id] = newPw;
    saveGhState(gh);
    return { ok: true };
  }

  if (pathname === '/api/user/preferences' && method === 'POST') {
    const target = gh.users.find((u) => Number(u.id) === Number(activeUser.id));
    if (!target || Number(target.id) === 0 || (sb && !gh.authenticatedAuthUuid)) {
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

    if (sb) {
      const { data: updatedProf, error: updErr } = await sb
        .from('profiles')
        .update({
          display_name: target.display_name,
          avatar_color: target.avatar_color,
          bankroll: target.bankroll,
          kelly_fraction: target.kelly_fraction,
          min_edge_pct: target.min_edge_pct,
          monthly_stake_limit: target.monthly_stake_limit,
          telegram_chat_id: target.telegram_chat_id,
          favourite_teams: target.favourite_teams,
          preferred_leagues: target.preferred_leagues,
          default_stake: target.default_stake,
        })
        .eq('auth_user_id', gh.authenticatedAuthUuid)
        .select('*')
        .single();
      if (updErr) throw new Error(updErr.message);
      const mapped = mapCloudProfile(updatedProf);
      gh.users = [mapped];
      saveGhState(gh);
      return { ok: true, user: mapped };
    }

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
    if (!activeUser || Number(activeUser.id) === 0 || (sb && !gh.authenticatedAuthUuid)) {
      throw new Error('Please create your account or sign in first.');
    }
    const fid = Number(bodyData.fixture_id);
    if (!fid) throw new Error('Valid fixture_id is required');
    const cur = gh.watchedByUser[activeUser.id] || [];
    let watched = false;
    if (sb) {
      if (cur.includes(fid)) {
        const { error } = await sb
          .from('saved_fixtures')
          .delete()
          .eq('auth_user_id', gh.authenticatedAuthUuid)
          .eq('fixture_id', fid);
        if (error) throw new Error(error.message);
        gh.watchedByUser[activeUser.id] = cur.filter((x) => x !== fid);
      } else {
        const { error } = await sb
          .from('saved_fixtures')
          .insert({
            auth_user_id: gh.authenticatedAuthUuid,
            fixture_id: fid,
            note: (bodyData.note || '').trim(),
          });
        if (error) throw new Error(error.message);
        gh.watchedByUser[activeUser.id] = [...cur, fid];
        watched = true;
      }
      saveGhState(gh);
      return { ok: true, watched, watched_fixture_ids: gh.watchedByUser[activeUser.id] };
    }
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
    if (!target || Number(target.id) === 0 || (sb && !gh.authenticatedAuthUuid)) {
      throw new Error('Please create your account or sign in first.');
    }
    const legs = Array.isArray(bodyData.legs) ? bodyData.legs : [];
    const stake = Math.max(1.0, Number(bodyData.stake || 10.0));
    if (sb) {
      const { error } = await sb
        .from('profiles')
        .update({ active_slip: legs, default_stake: stake })
        .eq('auth_user_id', gh.authenticatedAuthUuid);
      if (error) throw new Error(error.message);
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
      if (!activeUser || Number(activeUser.id) === 0 || (sb && !gh.authenticatedAuthUuid)) {
        throw new Error('Please create your account or sign in first.');
      }
      const legs = bodyData.legs || [];
      if (!legs.length) throw new Error('Cannot save an empty accumulator');
      const stake = Math.max(1.0, Number(bodyData.stake || 10.0));
      const ev = evaluateAccaClient(legs, stake);
      const name = (bodyData.name || '').trim() || `Draft Acca (${legs.length} legs)`;

      if (sb) {
        const { data: row, error } = await sb
          .from('saved_accas')
          .insert({
            auth_user_id: gh.authenticatedAuthUuid,
            user_id: activeUser.id,
            name,
            stake,
            legs: cloneJson(legs),
            combined_odds: ev.combined_odds,
            combined_prob: ev.combined_model_prob,
            ev_pct: ev.expected_value_pct,
          })
          .select('*')
          .single();
        if (error) throw new Error(error.message);
        const saved = {
          ...row,
          id: Number(row.id),
          user_id: Number(row.user_id || activeUser.id),
          stake: Number(row.stake),
          combined_odds: Number(row.combined_odds),
          combined_prob: Number(row.combined_prob),
          ev_pct: Number(row.ev_pct),
          legs: Array.isArray(row.legs) ? row.legs : cloneJson(legs),
        };
        gh.savedAccasByUser[activeUser.id] = [saved, ...cur];
        saveGhState(gh);
        return { ok: true, saved_acca: saved };
      }

      const saved = {
        id: gh.nextIds.acca++,
        user_id: activeUser.id,
        name,
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
    if (!activeUser || Number(activeUser.id) === 0 || (sb && !gh.authenticatedAuthUuid)) {
      throw new Error('Please create your account or sign in first.');
    }
    const accaId = Number(delAccaMatch[1]);
    if (sb) {
      const { error } = await sb
        .from('saved_accas')
        .delete()
        .eq('id', accaId)
        .eq('auth_user_id', gh.authenticatedAuthUuid);
      if (error) throw new Error(error.message);
    }
    const cur = gh.savedAccasByUser[activeUser.id] || [];
    const next = cur.filter((a) => Number(a.id) !== accaId);
    if (!sb && next.length === cur.length) throw new Error('Saved acca not found');
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
  const [pathname] = path.split('?');
  const sep = path.includes('?') ? '&' : '?';
  const url = path.startsWith('/api/') ? `${path}${sep}user_id=${state.activeUserId}` : path;
  const forceStatic =
    typeof window !== 'undefined' &&
    (window.location.hostname.endsWith('github.io') ||
      window.location.protocol === 'file:' ||
      window.__ACCALAB_STATIC__ === true);
  const cloudHandledPaths = new Set([
    '/api/bets',
    '/api/leaderboard',
    '/api/dashboard',
    '/api/fixtures',
    '/api/value-bets',
    '/api/suggest-bet',
  ]);
  const useCloudClient =
    Boolean(getSupabaseClient()) &&
    (pathname.startsWith('/api/auth/') ||
      pathname.startsWith('/api/user/') ||
      cloudHandledPaths.has(pathname));

  if ((forceStatic || useCloudClient) && path.startsWith('/api/')) {
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

function syncModalSlipButtons() {
  document.querySelectorAll('.modal-add-leg').forEach((btn) => {
    try {
      const leg = JSON.parse(btn.dataset.modalLeg || '{}');
      const active = isInSlip(leg.fixture_id, leg.market);
      const compact = btn.dataset.compact === '1';
      btn.textContent = active ? '✓ In Slip' : '+ Slip';
      btn.className = `modal-add-leg ${compact ? 'px-2 py-1' : 'px-2.5 py-1'} rounded font-semibold transition ${
        active
          ? 'bg-emerald-500/25 border border-emerald-400 text-emerald-200'
          : 'bg-emerald-600/80 hover:bg-emerald-500 text-white'
      }`;
    } catch (_) { }
  });
  const boostSel = document.getElementById('boost-market-select');
  if (boostSel && document.getElementById('boost-odds-input')?.value?.trim()) {
    boostSel.dispatchEvent(new Event('change'));
  }
}

function addLegToSlip(leg) {
  const dupIdx = state.slip.findIndex((l) => Number(l.fixture_id) === Number(leg.fixture_id) && l.market === leg.market);
  if (dupIdx !== -1) {
    state.slip.splice(dupIdx, 1);
    saveSlip();
    renderSlip();
    syncModalSlipButtons();
    if (state.activeTab === 'fixtures') renderFixturesTab();
    else if (state.activeTab === 'value') renderValueTab();
    else if (state.activeTab === 'acca') renderAccaTab();
    showToast(`Removed ${leg.selection_label} from Bet Slip`);
    return false;
  }

  const fam = marketFamily(leg.market);
  const conflictIdx = fam
    ? state.slip.findIndex((l) => Number(l.fixture_id) === Number(leg.fixture_id) && marketFamily(l.market) === fam)
    : -1;
  if (conflictIdx !== -1) {
    state.slip[conflictIdx] = leg;
    saveSlip();
    renderSlip();
    syncModalSlipButtons();
    if (state.activeTab === 'fixtures') renderFixturesTab();
    else if (state.activeTab === 'value') renderValueTab();
    else if (state.activeTab === 'acca') renderAccaTab();
    showToast(`Swapped to ${leg.selection_label} @ ${fmtOdds(leg.odds)}`);
    return true;
  }

  state.slip.push(leg);
  saveSlip();
  renderSlip();
  syncModalSlipButtons();
  if (state.activeTab === 'fixtures') renderFixturesTab();
  else if (state.activeTab === 'value') renderValueTab();
  else if (state.activeTab === 'acca') renderAccaTab();
  showToast(`Added ${leg.selection_label} @ ${fmtOdds(leg.odds)}`);
  return true;
}

function removeLegFromSlip(idx) {
  state.slip.splice(idx, 1);
  saveSlip();
  renderSlip();
  syncModalSlipButtons();
  if (state.activeTab === 'acca') renderAccaTab();
  else if (state.activeTab === 'fixtures') renderFixturesTab();
  else if (state.activeTab === 'value') renderValueTab();
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
    .map((leg, idx) => {
      const liveSt = evaluateLegLiveStatus(leg);
      const koMeta = leg.match_date ? `<span class="text-[10px] text-slate-500 font-mono">${esc(leg.match_date)}${leg.kickoff_time ? ` ${esc(leg.kickoff_time)}` : ''}</span>` : '';
      return `
      <div class="p-3 rounded-xl bg-card border border-slate-700/80 flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="text-xs text-slate-400 truncate">${esc(leg.home_team)} vs ${esc(leg.away_team)}</div>
          <div class="text-sm font-semibold text-white mt-0.5">${esc(leg.selection_label)}</div>
          <div class="text-xs text-emerald-400 mt-0.5">Odds: <b class="font-mono">${fmtOdds(leg.odds)}</b> • Model ${(Number(leg.model_prob) * (leg.model_prob > 1 ? 1 : 100)).toFixed(1)}%</div>
          <div class="mt-1 flex flex-wrap items-center gap-1.5">${liveSt ? liveSt.html : koMeta}</div>
        </div>
        <button data-rm-leg="${idx}" class="text-xs px-2 py-1 rounded bg-slate-800 hover:bg-rose-600/30 text-slate-300 shrink-0">✕</button>
      </div>`;
    })
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
      <div class="text-slate-400 text-right">Win Chance: <b class="text-white">${evalData.combined_model_prob_pct}%</b></div>
      <div class="text-slate-400">Value Rating: <b class="${evCls}">${evalData.expected_value_pct >= 0 ? '+' : ''}${evalData.expected_value_pct}%</b></div>
      <div class="text-slate-400 text-right">Legs: <b class="text-white">${state.slip.length}</b></div>
    </div>
    <input id="slip-notes-input" type="text" placeholder="Optional acca name (e.g. Saturday acca)" class="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white" />
    <div class="flex gap-1.5">
      <button id="slip-clear-btn" class="px-2.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-300">Clear</button>
      <button id="slip-live-btn" type="button" class="px-2.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 text-xs font-semibold">📡 Live Scores</button>
      <button id="slip-share-btn" type="button" class="px-2.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-emerald-300 text-xs font-semibold">📤 Share</button>
      <button id="slip-save-draft-btn" class="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold">💾 Save</button>
    </div>
    <button id="slip-export-b365-btn" class="w-full py-2.5 rounded-xl btn-bet365 text-xs font-extrabold tracking-wide flex items-center justify-center gap-2">
      <span>📋 Build on Bet365 (Quick Checklist)</span>
    </button>
  `;

  document.getElementById('slip-clear-btn').addEventListener('click', () => {
    state.slip = [];
    saveSlip();
    renderSlip();
    syncModalSlipButtons();
    if (state.activeTab === 'fixtures') renderFixturesTab();
    else if (state.activeTab === 'value') renderValueTab();
    else if (state.activeTab === 'acca') renderAccaTab();
  });
  document.getElementById('slip-live-btn').addEventListener('click', async () => {
    showToast('Checking live matchday scores...');
    await fetchLiveScoresForDates(state.slip.map((l) => l.match_date));
    renderSlip();
    if (state.activeTab === 'acca') renderAccaTab();
  });
  document.getElementById('slip-share-btn').addEventListener('click', () => {
    const customName = document.getElementById('slip-notes-input').value.trim();
    shareAccaSummary(state.slip, customName || 'AccaLab Tip Slip');
  });
  document.getElementById('slip-export-b365-btn').addEventListener('click', () => {
    const customName = document.getElementById('slip-notes-input').value.trim();
    exportToBet365(state.slip, state.slipStake, customName || 'AccaLab Custom Slip', '', 'slip');
  });
  document.getElementById('slip-save-draft-btn').addEventListener('click', async () => {
    if (!state.activeUserId || Number(state.activeUserId) === 0) {
      showToast('Create your account first to save accumulators!');
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
      showToast(`Saved "${res.saved_acca.name}" to your account!`);
      if (state.activeTab === 'acca') renderAccaTab();
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

function oddsBadge(source) {
  if (source === 'bet365_official' || source === 'api_football_b365') {
    return `<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">Bet365 Official</span>`;
  }
  if (source === 'live_sportsbook') {
    return `<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-teal-500/20 text-teal-300 border border-teal-500/30">Live Market</span>`;
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
      authStatusEl.textContent = 'Signed in • Cloud Synced ☁️';
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
        `<option value="${u.id}" ${u.id === state.activeUserId ? 'selected' : ''}>${esc(u.display_name)}</option>`
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

  const badge = document.getElementById('sidebar-alert-badge');
  if (d.counts.unread_alerts > 0) {
    badge.textContent = String(d.counts.unread_alerts);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  document.getElementById('kpi-strip').innerHTML = `
    <span class="px-2.5 py-1 rounded-full bg-card border border-slate-700/80">⚽ Upcoming: <b class="text-white font-mono">${d.counts.upcoming_fixtures}</b></span>
    <span class="px-2.5 py-1 rounded-full bg-card border border-slate-700/80">💎 Top Tips: <b class="text-emerald-400 font-mono">${d.top_value_bets.length}</b></span>
    <span class="px-2.5 py-1 rounded-full bg-card border border-slate-700/80">★ Followed Clubs: <b class="text-amber-300 font-mono">${state.favouriteTeams.length}</b></span>
  `;
}

// 1. MATCH PREVIEWS TAB
async function renderFixturesTab() {
  const activeEl = document.activeElement;
  const preserveSearchFocus = activeEl?.id === 'fixture-search' || Boolean(window._restoreSearchFocus);
  const searchSelStart = activeEl?.id === 'fixture-search' ? activeEl.selectionStart : null;
  const searchSelEnd = activeEl?.id === 'fixture-search' ? activeEl.selectionEnd : null;
  window._restoreSearchFocus = false;

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
                <div class="text-[11px] text-slate-400 mt-0.5">${best.edge_pct >= 3 ? `💎 ${esc(best.label)} (+${best.edge_pct}%)` : `Home ${(f.prob_home * 100).toFixed(0)}% • Draw ${(f.prob_draw * 100).toFixed(0)}% • Away ${(f.prob_away * 100).toFixed(0)}%`}</div>
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
      <div class="hidden lg:block bg-gradient-to-br from-emerald-500/15 via-panel to-cyan-500/10 border border-emerald-500/35 rounded-2xl p-4 md:p-5 space-y-3 shadow-lg shadow-emerald-950/30">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <span class="px-2.5 py-0.5 rounded-full text-[11px] font-extrabold bg-emerald-500 text-slate-950">✨ Today&apos;s Top Tip</span>
            <span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold font-mono bg-card border border-emerald-500/40 text-emerald-300">${fs.confidence_score}% Confidence</span>
            <span class="px-2.5 py-0.5 rounded-full text-[11px] font-bold font-mono bg-card border border-slate-700 text-amber-300">${fs.eval?.expected_value_pct >= 0 ? '+' : ''}${fs.eval?.expected_value_pct ?? 0}% Value</span>
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
        : `${esc(fs.title)} <span class="text-emerald-400 font-mono">@ ${fmtOdds(fs.eval?.combined_odds)}</span>`
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
            <button type="button" id="feat-export-b365" class="px-4 py-2 rounded-xl btn-bet365 text-xs font-extrabold">📋 Build on Bet365</button>
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
        <p class="text-xs text-slate-400 mt-0.5">Win probabilities, score predictions &amp; smart picks across the Premier League to League Two</p>
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

    <div class="flex flex-wrap items-center gap-1.5">
      <span class="text-[11px] font-semibold text-slate-400 mr-1">Kickoff:</span>
      ${KICKOFF_FILTER_OPTIONS.map(
        ([kCode, kLabel]) => `
        <button type="button" data-ko-filter="${kCode}" class="px-2.5 py-1 rounded-full text-[11px] font-semibold border transition ${state.kickoffFilter === kCode
            ? 'bg-cyan-500/20 text-cyan-200 border-cyan-400/60'
            : 'bg-panel text-slate-400 border-slate-800 hover:text-white'
          }">${kLabel}</button>`
      ).join('')}
    </div>

    ${featuredHtml}
    ${forYouHtml}

    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      ${(() => {
        const filteredFixtures = (data.fixtures || []).filter((f) => matchesKickoffFilter(f, state.kickoffFilter));
        return filteredFixtures.length
          ? filteredFixtures
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
                  </div>
                  <div class="mt-1">${formBadges(f.home_form)}</div>
                </div>
                <div class="text-xs font-bold text-slate-500 px-2">vs</div>
                <div class="min-w-0 text-right">
                  <div class="font-bold text-white truncate flex items-center justify-end gap-1">
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
                <button data-add-leg='${esc(JSON.stringify({ fixture_id: f.id, div: f.div, league_name: f.league_name, match_date: f.match_date, kickoff_time: f.kickoff_time || '', home_team: f.home_team, away_team: f.away_team, market: "1X2_H", selection_label: `${f.home_team} Win`, odds: f.b365h, model_prob: f.prob_home }))}' class="${oddsBtnCls(inH)}">
                  <div class="text-[10px] ${inH ? 'text-emerald-300 font-semibold' : 'text-slate-400'}">${inH ? '✓ Home' : 'Home'}</div>
                  <div class="font-bold font-mono text-white">${f.b365h ? fmtOdds(f.b365h) : '—'}</div>
                </button>
                <button data-add-leg='${esc(JSON.stringify({ fixture_id: f.id, div: f.div, league_name: f.league_name, match_date: f.match_date, kickoff_time: f.kickoff_time || '', home_team: f.home_team, away_team: f.away_team, market: "1X2_D", selection_label: "Draw", odds: f.b365d, model_prob: f.prob_draw }))}' class="${oddsBtnCls(inD)}">
                  <div class="text-[10px] ${inD ? 'text-emerald-300 font-semibold' : 'text-slate-400'}">${inD ? '✓ Draw' : 'Draw'}</div>
                  <div class="font-bold font-mono text-white">${f.b365d ? fmtOdds(f.b365d) : '—'}</div>
                </button>
                <button data-add-leg='${esc(JSON.stringify({ fixture_id: f.id, div: f.div, league_name: f.league_name, match_date: f.match_date, kickoff_time: f.kickoff_time || '', home_team: f.home_team, away_team: f.away_team, market: "1X2_A", selection_label: `${f.away_team} Win`, odds: f.b365a, model_prob: f.prob_away }))}' class="${oddsBtnCls(inA)}">
                  <div class="text-[10px] ${inA ? 'text-emerald-300 font-semibold' : 'text-slate-400'}">${inA ? '✓ Away' : 'Away'}</div>
                  <div class="font-bold font-mono text-white">${f.b365a ? fmtOdds(f.b365a) : '—'}</div>
                </button>
              </div>
            </div>

            <div class="pt-2 border-t border-slate-800/80 flex items-center justify-between gap-2 text-xs">
              <div class="${hasEdge ? 'text-emerald-400 font-semibold' : 'text-slate-400'}">
                ${hasEdge ? `💎 Top Pick: ${esc(best.label)} (+${best.edge_pct}% value)` : `Expected Goals ${f.lambda_home.toFixed(1)}–${f.mu_away.toFixed(1)} • Over 2.5: ${(f.prob_over25 * 100).toFixed(0)}%`}
              </div>
              <button data-open-preview="${f.id}" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-emerald-600 text-white font-medium transition">Preview →</button>
            </div>
          </div>`;
        })
        .join('')
      : `<div class="col-span-2 text-center py-12 text-slate-400 space-y-2"><div>No fixtures match your filter.</div>${state.kickoffFilter !== 'ALL' ? `<button id="reset-ko-filter-btn" type="button" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-cyan-300 font-semibold">Show All Kickoff Dates</button>` : ''}</div>`;
      })()}
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
      exportToBet365(fs.legs, fs.stake, fs.title, '', 'fixtures')
    );
    document.getElementById('feat-load-slip')?.addEventListener('click', () => {
      state.slip = fs.legs.map((l) => ({ ...l }));
      state.slipStake = Number(fs.stake || state.slipStake || 10);
      saveSlip();
      renderSlip();
      renderFixturesTab();
      closeAllOverlays('slip-drawer');
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
  document.querySelectorAll('[data-ko-filter]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.kickoffFilter = btn.dataset.koFilter;
      renderFixturesTab();
    })
  );
  document.getElementById('reset-ko-filter-btn')?.addEventListener('click', () => {
    state.kickoffFilter = 'ALL';
    renderFixturesTab();
  });
  const searchInpEl = document.getElementById('fixture-search');
  searchInpEl?.addEventListener('input', (e) => {
    state.search = e.target.value;
    clearTimeout(window._searchTimer);
    window._searchTimer = setTimeout(() => {
      window._restoreSearchFocus = document.activeElement?.id === 'fixture-search';
      renderFixturesTab();
    }, 250);
  });
  if (preserveSearchFocus && searchInpEl) {
    searchInpEl.focus();
    const pos = searchSelStart !== null ? searchSelStart : searchInpEl.value.length;
    try {
      searchInpEl.setSelectionRange(pos, searchSelEnd !== null ? searchSelEnd : pos);
    } catch (_) { }
  }
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

function buildMatchInsightsHtml(f, d, customSummary = '', customSource = '') {
  const outcomes = [
    { label: `${f.home_team} win`, prob: Number(f.prob_home || 0) },
    { label: 'Draw', prob: Number(f.prob_draw || 0) },
    { label: `${f.away_team} win`, prob: Number(f.prob_away || 0) },
  ].sort((a, b) => b.prob - a.prob);
  const topOutcome = outcomes[0];

  let topScore = '1–1';
  let topScorePct = 0;
  if (Array.isArray(d.score_heatmap)) {
    d.score_heatmap.forEach((row, hg) => {
      if (!Array.isArray(row)) return;
      row.forEach((val, ag) => {
        if (Number(val) > topScorePct) {
          topScorePct = Number(val);
          topScore = `${hg}–${ag}`;
        }
      });
    });
  }

  const pricedMarkets = (d.markets || [])
    .filter((m) => m.b365_odds && Number(m.b365_odds) > 1.01)
    .slice()
    .sort((a, b) => Number(b.edge_pct || 0) - Number(a.edge_pct || 0));
  const bestMarket = pricedMarkets[0];
  const bestAngleText = bestMarket
    ? bestMarket.edge_pct >= 1
      ? `<b class="text-emerald-300">${esc(bestMarket.label)}</b> at <span class="font-mono text-white">${fmtOdds(bestMarket.b365_odds)}</span> (<span class="text-emerald-300">+${Number(bestMarket.edge_pct).toFixed(1)}% edge</span> vs ${Number(bestMarket.model_prob_pct).toFixed(0)}% win chance)`
      : `No strong value edge — closest line is <b class="text-white">${esc(bestMarket.label)}</b> at <span class="font-mono text-white">${fmtOdds(bestMarket.b365_odds)}</span>`
    : 'Awaiting bookmaker odds for edge comparison';

  const lam = Number(f.lambda_home || 0);
  const mu = Number(f.mu_away || 0);
  const totalXg = lam + mu;
  const o25Pct = Math.round(Number(f.prob_over25 || 0) * 100);
  const bttsPct = Math.round(Number(f.prob_btts_yes || 0) * 100);

  const hs = d.home_split || { w: 0, d: 0, l: 0 };
  const as = d.away_split || { w: 0, d: 0, l: 0 };
  const lastH2h = Array.isArray(d.h2h) && d.h2h.length ? d.h2h[0] : null;
  const h2hSummary = lastH2h
    ? ` • Last H2H: ${esc(lastH2h.home_team)} ${lastH2h.fthg}–${lastH2h.ftag} ${esc(lastH2h.away_team)}`
    : '';

  const aiSource = customSource || f.ai_summary_source || '';
  const aiText = (customSummary || (aiSource === 'gemini_flash' ? f.ai_summary : '') || '').trim();
  const extraBlock =
    aiSource === 'gemini_flash' && aiText
      ? `<p class="mt-2 pt-2 border-t border-slate-800/80 text-xs text-slate-300 leading-relaxed">${esc(aiText)}</p>`
      : '';

  return `
    <ul class="space-y-2 text-sm text-slate-200 leading-relaxed">
      <li class="flex items-start gap-2.5">
        <span class="shrink-0">🎯</span>
        <span><b class="text-white">Lean:</b> ${esc(topOutcome.label)} (${Math.round(topOutcome.prob * 100)}% chance) • Most likely score <span class="font-mono text-emerald-300">${topScore}</span>${topScorePct ? ` (${topScorePct.toFixed(1)}%)` : ''}</span>
      </li>
      <li class="flex items-start gap-2.5">
        <span class="shrink-0">💎</span>
        <span><b class="text-white">Best Angle:</b> ${bestAngleText}</span>
      </li>
      <li class="flex items-start gap-2.5">
        <span class="shrink-0">⚽</span>
        <span><b class="text-white">Goals &amp; Tempo:</b> Projected ${lam.toFixed(2)}–${mu.toFixed(2)} xG (${totalXg.toFixed(1)} total) • Over 2.5 <b class="text-white">${o25Pct}%</b> • BTTS Yes <b class="text-white">${bttsPct}%</b></span>
      </li>
      <li class="flex items-start gap-2.5">
        <span class="shrink-0">📈</span>
        <span><b class="text-white">Form &amp; History:</b> ${esc(f.home_team)} home ${hs.w}W-${hs.d}D-${hs.l}L vs ${esc(f.away_team)} away ${as.w}W-${as.d}D-${as.l}L${h2hSummary}</span>
      </li>
    </ul>
    ${extraBlock}
  `;
}

function computeMatchComboMarkets(f) {
  const lam = Math.max(0.25, Number(f.lambda_home || 1.35));
  const mu = Math.max(0.25, Number(f.mu_away || 1.15));
  const rho = Number(f.rho ?? -0.04);
  const maxGoals = 7;

  const poissonVec = (rate) => {
    const out = [Math.exp(-rate)];
    let fact = 1;
    let pow = 1;
    for (let k = 1; k <= maxGoals; k += 1) {
      fact *= k;
      pow *= rate;
      out.push(Math.exp(-rate) * (pow / fact));
    }
    return out;
  };
  const tau = (x, y) => {
    let val = 1.0;
    if (x === 0 && y === 0) val = 1.0 - lam * mu * rho;
    else if (x === 0 && y === 1) val = 1.0 + lam * rho;
    else if (x === 1 && y === 0) val = 1.0 + mu * rho;
    else if (x === 1 && y === 1) val = 1.0 - rho;
    return Math.max(val, 0.05);
  };

  const px = poissonVec(lam);
  const py = poissonVec(mu);
  let total = 0;
  const sums = {
    COMBO_H_BTTS: 0,
    COMBO_H_O25: 0,
    COMBO_O25_BTTS: 0,
    COMBO_A_BTTS: 0,
    COMBO_A_O25: 0,
    COMBO_H_WIN_NIL: 0,
    COMBO_A_WIN_NIL: 0,
  };

  for (let x = 0; x <= maxGoals; x += 1) {
    for (let y = 0; y <= maxGoals; y += 1) {
      const p = px[x] * py[y] * tau(x, y);
      total += p;
      const btts = x >= 1 && y >= 1;
      const o25 = x + y >= 3;
      if (x > y && btts) sums.COMBO_H_BTTS += p;
      if (x > y && o25) sums.COMBO_H_O25 += p;
      if (o25 && btts) sums.COMBO_O25_BTTS += p;
      if (y > x && btts) sums.COMBO_A_BTTS += p;
      if (y > x && o25) sums.COMBO_A_O25 += p;
      if (x > y && y === 0) sums.COMBO_H_WIN_NIL += p;
      if (y > x && x === 0) sums.COMBO_A_WIN_NIL += p;
    }
  }

  const norm = total > 0 ? total : 1.0;
  const defs = [
    ['COMBO_H_O25', `${f.home_team} to Win & Over 2.5 Goals`],
    ['COMBO_H_BTTS', `${f.home_team} to Win & BTTS Yes`],
    ['COMBO_O25_BTTS', 'Over 2.5 Goals & BTTS Yes'],
    ['COMBO_H_WIN_NIL', `${f.home_team} to Win to Nil`],
    ['COMBO_A_O25', `${f.away_team} to Win & Over 2.5 Goals`],
    ['COMBO_A_BTTS', `${f.away_team} to Win & BTTS Yes`],
    ['COMBO_A_WIN_NIL', `${f.away_team} to Win to Nil`],
  ];

  return defs
    .map(([market, label]) => {
      const prob = Math.max(0.005, Math.min(0.95, sums[market] / norm));
      const prob_pct = roundNum(prob * 100.0, 1);
      const fair_odds = roundNum(1.0 / prob, 2);
      return { market, label, prob, prob_pct, fair_odds };
    })
    .sort((a, b) => b.prob - a.prob);
}

async function openMatchPreview(fixtureId) {
  closeAllOverlays('preview-modal');
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
  const comboMarkets = computeMatchComboMarkets(f);
  const boostCandidates = [
    ...comboMarkets,
    ...(d.markets || []).map((m) => ({
      market: m.market,
      label: m.label,
      prob: Math.max(0.005, Number(m.model_prob_pct || 0) / 100.0),
      prob_pct: Number(m.model_prob_pct || 0),
      fair_odds: Number(m.fair_odds || 2.0),
    })),
  ];
  const boostByMarket = new Map(boostCandidates.map((item) => [item.market, item]));

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

    <!-- Match Insights -->
    <div class="p-4 rounded-xl bg-card border border-emerald-500/30 space-y-3">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-bold uppercase tracking-wider text-emerald-400">✨ Match Insights</span>
        <button id="regen-summary-btn" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200">↻ Refresh</button>
      </div>
      <div id="ai-summary-text">${buildMatchInsightsHtml(f, d)}</div>
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
        <h3 class="text-sm font-bold text-white">Win Chances vs Bookmaker Odds ${oddsBadge(f.odds_source)}</h3>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-xs text-left">
          <thead class="text-slate-400 border-b border-slate-800">
            <tr>
              <th class="py-2 pr-2">Market</th>
              <th class="py-2 px-2 text-right">Win Chance</th>
              <th class="py-2 px-2 text-right">Fair Odds</th>
              <th class="py-2 px-2 text-right">Bookie Odds</th>
              <th class="py-2 px-2 text-right">Value</th>
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
                <td class="py-2 pl-2 text-right">
                  ${m.b365_odds
            ? (() => {
                const active = isInSlip(f.id, m.market);
                return `<button data-modal-leg='${esc(JSON.stringify({ fixture_id: f.id, div: f.div, league_name: f.league_name, match_date: f.match_date, kickoff_time: f.kickoff_time || '', home_team: f.home_team, away_team: f.away_team, market: m.market, selection_label: m.label, odds: m.b365_odds, model_prob: m.model_prob_pct / 100 }))}' class="modal-add-leg px-2.5 py-1 rounded font-semibold transition ${active ? 'bg-emerald-500/25 border border-emerald-400 text-emerald-200' : 'bg-emerald-600/80 hover:bg-emerald-500 text-white'}">${active ? '✓ In Slip' : '+ Slip'}</button>`;
              })()
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

    <!-- Bet365 Bet Boosts & Same-Game Combos -->
    <div class="p-4 rounded-xl bg-card border border-amber-500/30 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 class="text-sm font-bold text-white">⚡ Bet365 Bet Boosts &amp; Same-Game Combos</h3>
          <p class="text-[11px] text-slate-400">Model win chances for popular Bet Builders &amp; instant check to see if a Bet365 Boost is worth backing</p>
        </div>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        ${comboMarkets
          .slice(0, 4)
          .map((c) => {
            const recBadge =
              c.prob_pct >= 30
                ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">🔥 Strong Combo</span>'
                : c.prob_pct >= 20
                  ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/40">👍 Worth a Look</span>'
                  : '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-700/60 text-slate-300 border border-slate-600">🎲 Longshot</span>';
            return `
          <div class="p-3 rounded-xl bg-panel border border-slate-800 flex flex-col justify-between gap-2">
            <div class="flex items-start justify-between gap-2">
              <div class="text-xs font-semibold text-white leading-snug">${esc(c.label)}</div>
              ${recBadge}
            </div>
            <div class="flex items-center justify-between gap-2 text-[11px]">
              <div class="text-slate-300">Chance <b class="text-white">${c.prob_pct}%</b> • Min Boost <b class="font-mono text-amber-300">${fmtOdds(c.fair_odds)}</b></div>
              <div class="flex items-center gap-1.5 shrink-0">
                <button type="button" data-pick-boost="${esc(c.market)}" class="boost-prefill-btn px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-amber-300 font-semibold">Check</button>
                <button type="button" data-compact="1" data-modal-leg='${esc(JSON.stringify({ fixture_id: f.id, div: f.div, league_name: f.league_name, match_date: f.match_date, kickoff_time: f.kickoff_time || '', home_team: f.home_team, away_team: f.away_team, market: c.market, selection_label: c.label, odds: c.fair_odds, model_prob: c.prob }))}' class="modal-add-leg px-2 py-1 rounded font-semibold transition ${isInSlip(f.id, c.market) ? 'bg-emerald-500/25 border border-emerald-400 text-emerald-200' : 'bg-emerald-600/80 hover:bg-emerald-500 text-white'}">${isInSlip(f.id, c.market) ? '✓ In Slip' : '+ Slip'}</button>
              </div>
            </div>
          </div>`;
          })
          .join('')}
      </div>
      <div class="p-3 rounded-xl bg-slate-950/70 border border-slate-800 space-y-2">
        <div class="text-xs font-semibold text-amber-300">Bet Boost Checker — Test any Bet365 Boosted Price</div>
        <div class="grid grid-cols-1 md:grid-cols-12 gap-2 text-xs">
          <select id="boost-market-select" class="md:col-span-6 bg-panel border border-slate-700 rounded-lg px-2.5 py-1.5 text-white">
            <optgroup label="Pre-Made Same-Game Combos">
              ${comboMarkets
                .map((c) => `<option value="${esc(c.market)}">${esc(c.label)} (${c.prob_pct}% • Min ${fmtOdds(c.fair_odds)})</option>`)
                .join('')}
            </optgroup>
            <optgroup label="Single Match Markets">
              ${(d.markets || [])
                .map((m) => `<option value="${esc(m.market)}">${esc(m.label)} (${m.model_prob_pct}% • Min ${fmtOdds(m.fair_odds)})</option>`)
                .join('')}
            </optgroup>
          </select>
          <input id="boost-odds-input" type="text" placeholder="Boosted Odds e.g. 3/1 or 4.50" class="md:col-span-3 bg-panel border border-slate-700 rounded-lg px-2.5 py-1.5 text-white font-mono" />
          <button id="boost-add-btn" type="button" disabled class="md:col-span-3 px-3 py-1.5 rounded-lg bg-slate-700 text-slate-300 font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition">+ Add Boost to Slip</button>
        </div>
        <div id="boost-verdict" class="text-xs text-slate-400"></div>
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
        <h4 class="font-bold text-white text-sm mb-2">Most Likely Scorelines (Home goals ↓ vs Away goals →)</h4>
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
    if (!state.activeUserId || Number(state.activeUserId) === 0) {
      await toggleWatchFixture(fixtureId);
      return;
    }
    await toggleWatchFixture(fixtureId);
    openMatchPreview(fixtureId);
  });
  body.querySelectorAll('[data-modal-fav]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!state.activeUserId || Number(state.activeUserId) === 0) {
        await toggleFavouriteTeam(btn.dataset.modalFav);
        return;
      }
      await toggleFavouriteTeam(btn.dataset.modalFav);
      openMatchPreview(fixtureId);
    })
  );

  body.querySelectorAll('.modal-add-leg').forEach((btn) =>
    btn.addEventListener('click', () => addLegToSlip(JSON.parse(btn.dataset.modalLeg)))
  );

  const boostSelect = document.getElementById('boost-market-select');
  const boostInput = document.getElementById('boost-odds-input');
  const boostAddBtn = document.getElementById('boost-add-btn');
  const boostVerdict = document.getElementById('boost-verdict');
  const evaluateBoostChecker = () => {
    const item = boostByMarket.get(boostSelect?.value || '');
    if (!item || !boostVerdict || !boostAddBtn) return;
    const raw = String(boostInput?.value || '').trim();
    const dec = parseOddsInput(raw);
    if (!raw) {
      boostAddBtn.disabled = true;
      boostAddBtn.textContent = '+ Add Boost to Slip';
      boostAddBtn.className = 'md:col-span-3 px-3 py-1.5 rounded-lg bg-slate-700 text-slate-300 font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition';
      boostVerdict.innerHTML = `Enter Bet365&apos;s boosted price above — needs <b class="text-white">&gt; ${fmtOdds(item.fair_odds)}</b> (${item.fair_odds.toFixed(2)}) for positive value (<b class="text-white">${item.prob_pct}%</b> win chance).`;
      return;
    }
    if (!dec) {
      boostAddBtn.disabled = true;
      boostAddBtn.textContent = '+ Add Boost to Slip';
      boostAddBtn.className = 'md:col-span-3 px-3 py-1.5 rounded-lg bg-slate-700 text-slate-300 font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition';
      boostVerdict.innerHTML = `<span class="text-amber-300">Enter valid fractional or decimal odds (e.g. 3/1, 7/2, evens, or 4.50).</span>`;
      return;
    }
    const edgePct = (item.prob * dec - 1.0) * 100.0;
    const impliedPct = (1.0 / dec) * 100.0;
    boostAddBtn.disabled = false;
    const boostActive = isInSlip(f.id, item.market);
    if (boostActive) {
      boostAddBtn.textContent = '✓ In Slip';
      boostAddBtn.className = 'md:col-span-3 px-3 py-1.5 rounded-lg bg-emerald-500/25 border border-emerald-400 text-emerald-200 font-semibold transition';
    } else if (edgePct > 0) {
      boostAddBtn.textContent = '+ Add Boost to Slip';
      boostAddBtn.className = 'md:col-span-3 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold transition';
    } else {
      boostAddBtn.textContent = '+ Add Boost to Slip';
      boostAddBtn.className = 'md:col-span-3 px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white font-semibold transition';
    }
    if (edgePct > 0) {
      boostVerdict.innerHTML = `<span class="text-emerald-300 font-bold">🟢 BET ON IT (+${edgePct.toFixed(1)}% Edge — Beats fair odds of ${fmtOdds(item.fair_odds)})</span> <span class="text-slate-300">• Our model gives ${item.prob_pct}% vs ${impliedPct.toFixed(1)}% implied by ${fmtOdds(dec)}.</span>`;
    } else {
      boostVerdict.innerHTML = `<span class="text-rose-300 font-bold">🔴 SKIP IT (${edgePct.toFixed(1)}% Value — Boost is below fair odds of ${fmtOdds(item.fair_odds)})</span> <span class="text-slate-300">• Model gives ${item.prob_pct}% vs ${impliedPct.toFixed(1)}% implied by ${fmtOdds(dec)}.</span>`;
    }
  };
  boostSelect?.addEventListener('change', evaluateBoostChecker);
  boostInput?.addEventListener('input', evaluateBoostChecker);
  boostAddBtn?.addEventListener('click', () => {
    const item = boostByMarket.get(boostSelect?.value || '');
    const dec = parseOddsInput(boostInput?.value || '');
    if (!item || !dec) return;
    addLegToSlip({
      fixture_id: f.id,
      div: f.div,
      league_name: f.league_name,
      match_date: f.match_date,
      kickoff_time: f.kickoff_time || '',
      home_team: f.home_team,
      away_team: f.away_team,
      market: item.market,
      selection_label: `${item.label} (⚡ Boost)`,
      odds: roundNum(dec, 2),
      model_prob: item.prob,
    });
    evaluateBoostChecker();
  });
  body.querySelectorAll('.boost-prefill-btn').forEach((btn) =>
    btn.addEventListener('click', () => {
      if (boostSelect) boostSelect.value = btn.dataset.pickBoost || '';
      evaluateBoostChecker();
      boostInput?.focus();
    })
  );
  evaluateBoostChecker();
  syncModalSlipButtons();

  document.getElementById('regen-summary-btn').addEventListener('click', async () => {
    const res = await api(`/api/fixture/${fixtureId}/ai-summary`, { method: 'POST', body: '{}' });
    document.getElementById('ai-summary-text').innerHTML = buildMatchInsightsHtml(f, d, res.ai_summary, res.ai_summary_source);
    showToast('Match insights refreshed');
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
  const rawUserEdge = Math.round(Number(state.dashboard?.active_user?.min_edge_pct || 3));
  const defaultEdge = rawUserEdge >= 8 ? '8' : rawUserEdge >= 5 ? '5' : rawUserEdge <= 2 ? '2' : '3';
  const minEdge = state.valMinEdge || defaultEdge;
  const officialOnly = state.valOfficialOnly ? '1' : '0';
  const div = state.valDiv || '';

  const q = new URLSearchParams({ min_edge: minEdge, official_only: officialOnly });
  if (div) q.set('div', div);
  const data = await api(`/api/value-bets?${q.toString()}`);

  const baseOpps = state.valMyPrefsOnly
    ? (data.opportunities || []).filter(
      (o) =>
        state.preferredLeagues.includes(o.div) ||
        state.favouriteTeams.includes(o.home_team) ||
        state.favouriteTeams.includes(o.away_team)
    )
    : data.opportunities || [];
  const opps = baseOpps.filter((o) => matchesKickoffFilter(o, state.kickoffFilter));

  main.innerHTML = `
    <div class="flex flex-col md:flex-row md:items-center justify-between gap-3">
      <div>
        <h2 class="text-xl font-bold text-white">💎 Top Match Tips</h2>
        <p class="text-xs text-slate-400">Tips where our match model gives a higher win chance than the bookmaker&apos;s odds imply</p>
      </div>
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <select id="val-div-filter" class="bg-panel border border-slate-700 rounded-lg px-2.5 py-1.5 text-white">
          <option value="">All Leagues</option>
          <option value="E0" ${div === 'E0' ? 'selected' : ''}>Premier League</option>
          <option value="E1" ${div === 'E1' ? 'selected' : ''}>Championship</option>
          <option value="E2" ${div === 'E2' ? 'selected' : ''}>League One</option>
          <option value="E3" ${div === 'E3' ? 'selected' : ''}>League Two</option>
        </select>
        <select id="val-ko-filter" class="bg-panel border border-slate-700 rounded-lg px-2.5 py-1.5 text-white">
          ${KICKOFF_FILTER_OPTIONS.map(([kCode, kLabel]) => `<option value="${kCode}" ${state.kickoffFilter === kCode ? 'selected' : ''}>${kLabel}</option>`).join('')}
        </select>
        <select id="val-min-edge" class="bg-panel border border-slate-700 rounded-lg px-2.5 py-1.5 text-white">
          <option value="2" ${minEdge === '2' ? 'selected' : ''}>All Value Tips (+2%+)</option>
          <option value="3" ${minEdge === '3' ? 'selected' : ''}>Good Value (+3%+)</option>
          <option value="5" ${minEdge === '5' ? 'selected' : ''}>Strong Value (+5%+)</option>
          <option value="8" ${minEdge === '8' ? 'selected' : ''}>Best Value Only (+8%+)</option>
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
            <th class="p-3">Match</th>
            <th class="p-3">Tip</th>
            <th class="p-3 text-right">Odds</th>
            <th class="p-3 text-right">Win Chance (Fair)</th>
            <th class="p-3 text-right">Value</th>
            <th class="p-3">Confidence</th>
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
                  <button type="button" data-open-preview="${o.fixture_id}" class="font-semibold text-white hover:text-emerald-300 text-left flex items-center gap-1.5 transition">
                    ${isFav ? '<span class="text-amber-300" title="Followed club">★</span>' : ''}
                    <span>${esc(o.home_team)} vs ${esc(o.away_team)}</span>
                  </button>
                  <div class="text-[11px] text-slate-400">${esc(o.league_name)} • ${esc(o.match_date)}${o.kickoff_time ? ` ${esc(o.kickoff_time)}` : ''}</div>
                </td>
                <td class="p-3 font-medium text-emerald-300">${esc(o.selection_label)}</td>
                <td class="p-3 text-right font-mono font-bold text-white">${fmtOdds(o.odds)}</td>
                <td class="p-3 text-right">${o.model_prob_pct}% <span class="text-slate-400 font-mono">(${fmtOdds(o.fair_odds)})</span></td>
                <td class="p-3 text-right font-bold text-emerald-400">+${o.edge_pct}%</td>
                <td class="p-3 space-y-1">
                  <div>${oddsBadge(o.odds_source)}</div>
                  <div class="text-[10px] text-slate-400">${esc(o.trust_badge)}</div>
                </td>
                <td class="p-3 text-right">
                  ${(() => {
                    const active = isInSlip(o.fixture_id, o.market);
                    return `<button data-val-leg='${esc(JSON.stringify({ fixture_id: o.fixture_id, div: o.div, league_name: o.league_name, match_date: o.match_date, kickoff_time: o.kickoff_time || '', home_team: o.home_team, away_team: o.away_team, market: o.market, selection_label: o.selection_label, odds: o.odds, model_prob: o.model_prob_pct / 100 }))}' class="val-add-leg px-3 py-1.5 rounded-lg font-semibold transition ${active ? 'bg-emerald-500/25 border border-emerald-400 text-emerald-200' : 'bg-emerald-600 hover:bg-emerald-500 text-white'}">${active ? '✓ In Slip' : '+ Slip'}</button>`;
                  })()}
                </td>
              </tr>`;
        })
        .join('')
      : `<tr><td colspan="7" class="p-8 text-center text-slate-400">No tips match this filter right now — try switching to &ldquo;All Value Tips (+2%+)&rdquo;.</td></tr>`
    }
        </tbody>
      </table>
    </div>
  `;

  document.getElementById('val-div-filter')?.addEventListener('change', (e) => {
    state.valDiv = e.target.value;
    renderValueTab();
  });
  document.getElementById('val-min-edge')?.addEventListener('change', (e) => {
    state.valMinEdge = e.target.value;
    renderValueTab();
  });
  document.getElementById('val-official-only')?.addEventListener('change', (e) => {
    state.valOfficialOnly = Boolean(e.target.checked);
    renderValueTab();
  });
  document.getElementById('val-ko-filter')?.addEventListener('change', (e) => {
    state.kickoffFilter = e.target.value;
    renderValueTab();
  });
  document.getElementById('val-my-prefs')?.addEventListener('change', (e) => {
    state.valMyPrefsOnly = e.target.checked;
    renderValueTab();
  });
  document.querySelectorAll('[data-open-preview]').forEach((btn) =>
    btn.addEventListener('click', () => openMatchPreview(Number(btn.dataset.openPreview)))
  );
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
      <p class="text-xs text-slate-400">Ready-made accumulators built from separate matches with strong win chances.</p>
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
              <button type="button" data-share-acca='${esc(JSON.stringify({ legs: p.legs, title: p.title }))}' class="share-acca-btn px-2.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-emerald-300 font-semibold" title="Share tips">📤</button>
              <button data-export-preset='${esc(JSON.stringify({ legs: p.legs, title: p.title }))}' class="export-preset-btn px-3 py-2 rounded-xl btn-bet365 font-extrabold">🚀 Bet365</button>
            </div>
          </div>
        </div>`
      )
      .join('')}
    </div>

    <!-- Saved Draft Accas -->
    <div class="bg-panel border border-slate-800 rounded-2xl p-5 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 class="font-bold text-white text-base">💾 Saved Draft Accas (${savedAccas.length})</h3>
          <span class="text-xs text-slate-400">Saved to your account across devices</span>
        </div>
        ${savedAccas.length ? `<button id="acca-live-scores-btn" type="button" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 text-xs font-semibold">📡 Check Live Scores</button>` : ''}
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
                    <div class="text-[11px] text-slate-400 mt-1">${(a.legs || []).length} legs • Combined <b class="text-emerald-400 font-mono">${fmtOdds(a.combined_odds)}</b> • Saved ${esc((a.created_at || '').slice(0, 10))}</div>
                    <div class="mt-2 space-y-1.5">
                      ${(a.legs || [])
              .map(
                (l) => {
                  const lst = evaluateLegLiveStatus(l);
                  return `<div class="text-[11px] text-slate-300 flex items-center justify-between gap-2"><span class="truncate">${esc(l.selection_label)} (${esc(l.home_team)} vs ${esc(l.away_team)})</span><span class="flex items-center gap-1.5 shrink-0">${lst ? lst.html : ''}<span class="font-mono text-slate-400">@ ${fmtOdds(l.odds)}</span></span></div>`;
                }
              )
              .join('')}
                    </div>
                  </div>
                  <div class="flex gap-2 pt-2 border-t border-slate-800">
                    <button type="button" data-load-saved='${esc(JSON.stringify({ legs: a.legs, stake: a.stake }))}' class="flex-1 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold">Load</button>
                    <button type="button" data-share-acca='${esc(JSON.stringify({ legs: a.legs, title: a.name }))}' class="share-acca-btn px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-emerald-300 font-semibold" title="Share tips">📤</button>
                    <button type="button" data-export-saved='${esc(JSON.stringify({ legs: a.legs, stake: a.stake, title: a.name }))}' class="px-3 py-1.5 rounded-lg btn-bet365 font-extrabold">🚀 Bet365</button>
                    <button type="button" data-del-saved="${a.id}" class="px-3 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 border border-rose-500/30 text-rose-300 font-semibold">Delete</button>
                  </div>
                </div>`
        )
        .join('')}
            </div>`
      : '<p class="text-xs text-slate-400">No saved accas yet. Add legs to your Tip Slip drawer and click <b>Save Acca</b>.</p>'
    }
    </div>

    <div class="bg-panel border border-slate-800 rounded-2xl p-5">
      <h3 class="font-bold text-white text-base mb-2">Your Current Slip Summary</h3>
      ${slipEval
      ? `
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mb-3">
          <div class="p-3 rounded-xl bg-card border border-slate-800"><div class="text-slate-400">Legs</div><div class="text-lg font-bold text-white">${slipEval.leg_count}</div></div>
          <div class="p-3 rounded-xl bg-card border border-slate-800"><div class="text-slate-400">Combined Odds</div><div class="text-lg font-bold font-mono text-emerald-400">${fmtOdds(slipEval.combined_odds)}</div></div>
          <div class="p-3 rounded-xl bg-card border border-slate-800"><div class="text-slate-400">Fair Odds</div><div class="text-lg font-bold font-mono text-white">${fmtOdds(slipEval.fair_combined_odds)}</div></div>
          <div class="p-3 rounded-xl bg-card border border-slate-800"><div class="text-slate-400">Win Chance</div><div class="text-lg font-bold text-emerald-300">${slipEval.combined_model_prob_pct}%</div></div>
        </div>
        <button id="open-slip-inline" class="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold">Open Acca Slip</button>
      `
      : '<p class="text-xs text-slate-400">Load any preset above or add legs from Matches &amp; Previews / Top Match Tips.</p>'
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
      exportToBet365(payload.legs || [], state.slipStake, payload.title || 'AccaLab Preset', '', 'acca');
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
      closeAllOverlays('slip-drawer');
      document.getElementById('slip-drawer').classList.remove('hidden');
      showToast('Loaded saved draft into Bet Slip!');
    })
  );
  document.querySelectorAll('[data-export-saved]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const payload = JSON.parse(btn.dataset.exportSaved);
      exportToBet365(payload.legs || [], Number(payload.stake || state.slipStake || 10), payload.title || 'Saved Acca', '', 'acca');
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
        if (!state.authenticated) openAuthModal('register');
      }
    })
  );
  document.getElementById('open-slip-inline')?.addEventListener('click', () => {
    closeAllOverlays('slip-drawer');
    renderSlip();
    document.getElementById('slip-drawer').classList.remove('hidden');
  });
  document.querySelectorAll('.share-acca-btn').forEach((btn) =>
    btn.addEventListener('click', () => {
      const payload = JSON.parse(btn.dataset.shareAcca || '{}');
      shareAccaSummary(payload.legs || [], payload.title || 'AccaLab Tips');
    })
  );
  document.getElementById('acca-live-scores-btn')?.addEventListener('click', async () => {
    const dates = savedAccas.flatMap((a) => (a.legs || []).map((l) => l.match_date));
    showToast('Checking live matchday scores...');
    await fetchLiveScoresForDates(dates);
    renderAccaTab();
    renderSlip();
  });
}

// 4. BET TRACKER & CLV TAB
async function renderTrackerTab() {
  const main = document.getElementById('main-content');
  const data = await api('/api/bets');
  const st = data.stats;

  const protectedBannerHtml = !state.authenticated
    ? `
      <div class="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/40 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div class="text-sm font-bold text-amber-300">🔒 Protected Cloud Tracker</div>
          <p class="text-xs text-slate-300 mt-0.5">Sign in or create your personal account to log bets and sync your P&amp;L across all devices.</p>
        </div>
        <div class="flex items-center gap-2">
          <button id="tracker-signin-btn" type="button" class="px-3 py-1.5 rounded-xl bg-surface border border-slate-700 hover:border-emerald-400 text-xs font-semibold text-white">Sign In</button>
          <button id="tracker-signup-btn" type="button" class="px-3.5 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-xs font-bold text-slate-950">Create Account</button>
        </div>
      </div>`
    : '';

  main.innerHTML = `
    ${renderMobileMoreSubnav()}
    ${protectedBannerHtml}
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-xl font-bold text-white">📈 My Bets &amp; Profit/Loss</h2>
        <p class="text-xs text-slate-400">Profile: <b>${esc(data.user.display_name)}</b> • Monthly Limit: ${fmtGbp(st.month_staked)} / ${fmtGbp(data.user.monthly_stake_limit)}</p>
      </div>
      <button id="settle-bets-btn" class="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-white font-semibold">↻ Check Results &amp; Settle</button>
    </div>

    <div class="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
      <div class="p-3.5 rounded-2xl bg-panel border border-slate-800"><div class="text-slate-400">Total P&amp;L</div><div class="text-xl font-bold ${st.total_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${st.total_pnl >= 0 ? '+' : ''}${fmtGbp(st.total_pnl)}</div></div>
      <div class="p-3.5 rounded-2xl bg-panel border border-slate-800"><div class="text-slate-400">ROI</div><div class="text-xl font-bold ${st.roi_pct >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${st.roi_pct >= 0 ? '+' : ''}${st.roi_pct}%</div></div>
      <div class="p-3.5 rounded-2xl bg-panel border border-slate-800"><div class="text-slate-400">Beat Closing Odds</div><div class="text-xl font-bold ${st.avg_clv_pct >= 0 ? 'text-emerald-400' : 'text-amber-300'}">${st.avg_clv_pct >= 0 ? '+' : ''}${st.avg_clv_pct}%</div></div>
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
            <th class="p-3">Date</th><th class="p-3">Type / Legs</th><th class="p-3 text-right">Odds</th><th class="p-3 text-right">Stake</th><th class="p-3 text-right">vs Closing Odds</th><th class="p-3 text-right">Status / P&amp;L</th>
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

  bindMobileMoreSubnav();
  document.getElementById('tracker-signin-btn')?.addEventListener('click', () => openAuthModal('login'));
  document.getElementById('tracker-signup-btn')?.addEventListener('click', () => openAuthModal('register'));

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

function renderMobileMoreSubnav() {
  return '';
}

function bindMobileMoreSubnav() {
  document.querySelectorAll('[data-mob-subtab]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.activeTab = btn.dataset.mobSubtab;
      renderActiveTab();
    })
  );
}

// 5. MODEL & BACKTEST LAB TAB
async function renderBacktestTab() {
  const main = document.getElementById('main-content');
  const data = await api('/api/backtest');
  const firstCalib = data.results.find((r) => r.calibration?.length)?.calibration || [];

  main.innerHTML = `
    ${renderMobileMoreSubnav()}
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

  bindMobileMoreSubnav();
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
    ${renderMobileMoreSubnav()}
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

  bindMobileMoreSubnav();
  document.getElementById('create-friend-btn').addEventListener('click', async () => {
    if (getSupabaseClient()) {
      const fName = document.getElementById('new-friend-name').value.trim();
      const fCode = document.getElementById('new-friend-code').value.trim();
      const fBank = document.getElementById('new-friend-bankroll').value;
      openAuthModal('register');
      if (fName && document.getElementById('reg-display')) document.getElementById('reg-display').value = fName;
      if (fCode && document.getElementById('reg-invite')) document.getElementById('reg-invite').value = fCode;
      if (fBank && document.getElementById('reg-bankroll')) document.getElementById('reg-bankroll').value = fBank;
      showToast('Enter a username & password to create their cloud account!');
      return;
    }
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
    ${renderMobileMoreSubnav()}
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-xl font-bold text-white">⭐ Clubs, News &amp; Settings</h2>
        <p class="text-xs text-slate-400">Personalised clubs, account controls, tip filter &amp; optional Telegram alerts</p>
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
            <span class="text-slate-200 font-medium">${esc(getLeagueName(div, leagueMeta))}</span>
          </label>`
      )
      .join('')}
      </div>

      <div id="set-team-picker" class="max-h-52 overflow-y-auto p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2.5"></div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <!-- Profile & Alert Settings -->
      <div class="bg-panel border border-slate-800 rounded-2xl p-4 space-y-3">
        <h3 class="text-sm font-bold text-white">Profile Settings (${esc(u.display_name)})</h3>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <label>Display Name<input id="set-display-name" type="text" value="${esc(u.display_name)}" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white"/></label>
          <label>Tip Filter
            <select id="set-min-edge" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white">
              <option value="2" ${Number(u.min_edge_pct) <= 2 ? 'selected' : ''}>More Tips (+2% value)</option>
              <option value="3" ${Number(u.min_edge_pct) > 2 && Number(u.min_edge_pct) < 5 ? 'selected' : ''}>Balanced (+3% value)</option>
              <option value="5" ${Number(u.min_edge_pct) >= 5 ? 'selected' : ''}>Strict — Best Only (+5% value)</option>
            </select>
          </label>
          <label class="sm:col-span-2">Telegram Chat ID (optional)<input id="set-tg-chat" type="text" value="${esc(u.telegram_chat_id || '')}" placeholder="e.g. 123456789" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white"/></label>
        </div>
        <div class="flex flex-wrap gap-2">
          <button id="save-settings-btn" class="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold">Save Settings</button>
          <button id="test-tg-btn" class="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold">Send Test Telegram Alert</button>
        </div>

        <details class="pt-2 border-t border-slate-800 text-xs">
          <summary class="cursor-pointer text-slate-400 hover:text-white font-semibold">Advanced Data Feed &amp; Sync Status</summary>
          <div class="pt-3 space-y-2">
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
        </details>
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
              <div class="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">${esc(getLeagueName(div, leagueMeta))}</div>
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
        if (!state.authenticated) openAuthModal('register');
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
      await api('/api/user/preferences', {
        method: 'POST',
        body: JSON.stringify({
          display_name: document.getElementById('set-display-name').value.trim() || u.display_name,
          default_stake: u.default_stake || 10,
          bankroll: u.bankroll ?? 250,
          kelly_fraction: u.kelly_fraction ?? 0.25,
          min_edge_pct: document.getElementById('set-min-edge').value,
          monthly_stake_limit: u.monthly_stake_limit ?? 200,
          telegram_chat_id: document.getElementById('set-tg-chat').value,
        }),
      });
      state.valMinEdge = String(document.getElementById('set-min-edge').value);
      await loadDashboard(false);
      renderSettingsTab();
      showToast('Settings saved!');
    } catch (err) {
      showToast(err.message, true);
      if (!state.authenticated) openAuthModal('register');
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

  bindMobileMoreSubnav();
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
  const isMoreGroup = ['tracker', 'settings', 'leaderboard', 'backtest'].includes(state.activeTab);
  document.querySelectorAll('.nav-btn-mob').forEach((btn) => {
    const active = btn.dataset.tab === state.activeTab || (btn.dataset.tab === 'settings' && isMoreGroup);
    btn.className = `nav-btn-mob flex flex-col items-center py-1 px-1 text-[11px] ${active ? 'text-emerald-400 font-semibold' : 'text-slate-400'}`;
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
            <input id="pw-new" type="password" required minlength="6" placeholder="New password (min 6)" class="px-3 py-2 rounded-lg bg-surface border border-slate-700 text-xs text-white" />
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
        <b class="text-emerald-300">Welcome to AccaLab!</b> Set up your personal account below to save your favourite English clubs, watchlist matches and custom accas.
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
          <input id="reg-password" type="password" required minlength="6" placeholder="Min 6 chars" class="w-full px-3 py-2 rounded-lg bg-surface border border-slate-700 text-xs text-white" />
        </div>
        <details class="sm:col-span-2 text-xs text-slate-400 rounded-xl bg-surface/60 border border-slate-800 p-3">
          <summary class="cursor-pointer hover:text-white font-semibold">Optional: Tip Filter &amp; Profile Colour</summary>
          <div class="grid grid-cols-2 gap-2.5 mt-3">
            <div>
              <label class="block text-xs text-slate-400 mb-1">Tip Filter</label>
              <select id="reg-min-edge" class="w-full px-2.5 py-2 rounded-lg bg-surface border border-slate-700 text-xs text-white">
                <option value="2">More Tips (+2%)</option>
                <option value="3" selected>Balanced (+3%)</option>
                <option value="5">Strict (+5%)</option>
              </select>
            </div>
            <div>
              <label class="block text-xs text-slate-400 mb-1">Avatar Colour</label>
              <input id="reg-color" type="color" value="#10b981" class="w-full h-[34px] rounded-lg bg-surface border border-slate-700 p-0.5 cursor-pointer" />
            </div>
          </div>
        </details>
      </div>

      <div>
        <div class="text-xs text-slate-400 mb-1.5">Preferred English Leagues</div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
          ${['E0', 'E1', 'E2', 'E3'].map((div) => `
            <label class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface border border-slate-700 text-xs text-slate-200 cursor-pointer">
              <input type="checkbox" class="reg-league-cb accent-emerald-500" value="${div}" checked />
              <span>${esc(getLeagueName(div, leagueMeta))}</span>
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
          <div class="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">${esc(getLeagueName(div, leagueMeta))}</div>
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
          invite_code: 'ACCALAB2026',
          bankroll: 250,
          default_stake: 10,
          kelly_fraction: 0.25,
          min_edge_pct: Number(document.getElementById('reg-min-edge')?.value || 3.0),
          avatar_color: document.getElementById('reg-color')?.value || '#10b981',
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
  closeAllOverlays('auth-modal');
  const users = state.dashboard?.users || [];
  const resolvedMode = initialMode || (users.length ? 'login' : 'register');
  renderAuthModalBody(resolvedMode);
  document.getElementById('auth-modal').classList.remove('hidden');
}

function buildBet365Bookmarklet(slipToken = '') {
  const fnSrc = `(function(fallbackTok){try{var q=new URLSearchParams(location.search||'').get('accalab_slip')||fallbackTok||'';if(q){sessionStorage.setItem('accalab_b365_slip_bm',q)}var tok=sessionStorage.getItem('accalab_b365_slip_bm')||q;if(!tok){alert('Open a slip from AccaLab first.');return}var b=tok.replace(/-/g,'+').replace(/_/g,'/');while(b.length%4)b+='=';var u=Uint8Array.from(atob(b),function(c){return c.charCodeAt(0)});var slip=JSON.parse(new TextDecoder().decode(u));var i=0;var old=document.getElementById('accalab-bm-bar');if(old)old.remove();var w=document.createElement('div');w.id='accalab-bm-bar';w.style.cssText='position:fixed;left:12px;bottom:12px;z-index:2147483647;width:320px;max-width:calc(100vw - 24px);background:#0f172a;color:#fff;border:1px solid #10b981;border-radius:12px;padding:10px;font:12px/1.4 system-ui,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.6)';function draw(){w.replaceChildren();var l=slip.legs[i];var h=document.createElement('div');h.style.cssText='font-weight:800;color:#34d399;margin-bottom:4px';h.textContent='AccaLab ('+(i+1)+'/'+slip.legs.length+') @ '+(slip.od||'');var m=document.createElement('div');m.style.cssText='font-weight:700';m.textContent=l.h+' v '+l.a;var s=document.createElement('div');s.style.cssText='color:#38bdf8;margin:3px 0 8px';s.textContent=l.m+': '+(l.s||l.l)+' @ '+l.o;var r=document.createElement('div');r.style.cssText='display:flex;gap:6px';var go=document.createElement('button');go.textContent='Open Match';go.style.cssText='flex:1;padding:6px;border-radius:8px;border:0;background:#10b981;color:#064e3b;font-weight:800;cursor:pointer';go.onclick=function(){location.hash='#/AX/K^'+encodeURIComponent(l.k||(l.h+' v '+l.a))};var nx=document.createElement('button');nx.textContent=i<slip.legs.length-1?'Next ->':'Done';nx.style.cssText='padding:6px 10px;border-radius:8px;border:1px solid #34d399;background:#065f46;color:#fff;font-weight:700;cursor:pointer';nx.onclick=function(){if(i<slip.legs.length-1){i++;draw();location.hash='#/AX/K^'+encodeURIComponent(slip.legs[i].k||(slip.legs[i].h+' v '+slip.legs[i].a))}else{w.remove()}};r.append(go,nx);w.append(h,m,s,r)}draw();document.body.appendChild(w)}catch(e){alert('AccaLab Companion error: '+e.message)}})('${String(slipToken || '').replace(/'/g, '')}');`;
  return `javascript:${encodeURIComponent(fnSrc)}`;
}

function sortBet365ChecklistLegs(expLegs = [], sortMode = 'coupon') {
  const indexed = expLegs.map((leg, origIdx) => ({ leg, origIdx }));
  if (sortMode === 'slip' || expLegs.length <= 1) {
    return indexed.map((item) => ({ ...item, groupKey: '', groupLabel: '' }));
  }

  const mktRank = { '1X2': 0, OU: 1, BTTS: 2 };
  const mktNames = {
    '1X2': 'Full Time Result',
    OU: 'Goals Over/Under',
    BTTS: 'Both Teams to Score',
  };
  const divRank = { E0: 0, E1: 1, E2: 2, E3: 3 };

  return indexed
    .map((item) => {
      const fam = marketFamily(item.leg.market);
      const mRank = mktRank[fam] ?? 3;
      const mLabel = mktNames[fam] || 'Bet Builder / Boosts';
      const divCode = String(item.leg.div || '');
      const lRank = divRank[divCode] ?? 4;
      const leagueLabel = item.leg.league_name || (divCode ? getLeagueName(divCode) : 'English Football');
      return {
        ...item,
        mRank,
        lRank,
        dateKey: String(item.leg.match_date || '9999-99-99'),
        timeKey: String(item.leg.kickoff_time || '99:99'),
        homeKey: String(item.leg.home_team || ''),
        groupKey: `${mRank}|${divCode || leagueLabel}`,
        groupLabel: `⚽ ${mLabel} • ${leagueLabel}`,
      };
    })
    .sort(
      (a, b) =>
        a.mRank - b.mRank ||
        a.lRank - b.lRank ||
        a.dateKey.localeCompare(b.dateKey) ||
        a.timeKey.localeCompare(b.timeKey) ||
        a.homeKey.localeCompare(b.homeKey) ||
        a.origIdx - b.origIdx
    );
}

function renderB365CouponBox(leg) {
  const mkt = String(leg?.market || '');
  const oddsTxt = fmtOdds(leg?.odds);
  const marketName = leg?.b365_market_name || B365_MARKET_NAMES[mkt] || (mkt.startsWith('COMBO_') ? 'Bet Builder / Bet Boost' : 'Full Time Result');
  const activeCls = 'bg-emerald-500 text-slate-950 font-extrabold ring-2 ring-amber-300 shadow-sm';
  const mutedCls = 'bg-slate-900/90 text-slate-500 border border-slate-800/80';

  const cell = (title, sub, active) => `
    <div class="p-2 rounded-lg text-center transition ${active ? activeCls : mutedCls}">
      <div class="flex items-center justify-center gap-1 text-[10px] uppercase tracking-wider">
        <span class="truncate font-bold">${esc(title)}</span>
        ${active ? '<span class="px-1 py-0.2 rounded bg-amber-300 text-slate-950 text-[9px] font-black leading-tight">TAP</span>' : ''}
      </div>
      <div class="text-xs font-mono mt-0.5 truncate">${active ? `@ ${esc(oddsTxt)}` : esc(sub || '—')}</div>
    </div>`;

  let gridHtml = '';
  if (mkt === '1X2_H' || mkt === '1X2_D' || mkt === '1X2_A') {
    gridHtml = `
      <div class="grid grid-cols-3 gap-1.5">
        ${cell(`1: ${leg.home_team || 'Home'}`, 'Home', mkt === '1X2_H')}
        ${cell('X: Draw', 'Draw', mkt === '1X2_D')}
        ${cell(`2: ${leg.away_team || 'Away'}`, 'Away', mkt === '1X2_A')}
      </div>`;
  } else if (mkt === 'OU_O25' || mkt === 'OU_U25') {
    gridHtml = `
      <div class="grid grid-cols-2 gap-1.5">
        ${cell('Over 2.5', '3+ Goals', mkt === 'OU_O25')}
        ${cell('Under 2.5', '0–2 Goals', mkt === 'OU_U25')}
      </div>`;
  } else if (mkt === 'BTTS_Y' || mkt === 'BTTS_N') {
    gridHtml = `
      <div class="grid grid-cols-2 gap-1.5">
        ${cell('Yes', 'Both score', mkt === 'BTTS_Y')}
        ${cell('No', 'Clean sheet', mkt === 'BTTS_N')}
      </div>`;
  } else {
    gridHtml = `
      <div class="p-2.5 rounded-lg flex items-center justify-between gap-2 ${activeCls}">
        <div class="flex items-center gap-1.5 min-w-0 text-xs">
          <span class="px-1.5 py-0.5 rounded bg-amber-300 text-slate-950 text-[9px] font-black uppercase shrink-0">TAP</span>
          <span class="truncate">${esc(leg?.b365_selection_name || leg?.selection_label || mkt)}</span>
        </div>
        <span class="text-xs font-mono shrink-0">@ ${esc(oddsTxt)}</span>
      </div>`;
  }

  return `
    <div class="p-2.5 rounded-xl bg-slatebg/90 border border-slate-800 space-y-1.5">
      <div class="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-slate-400 font-bold">
        <span>Bet365 Tab: <span class="text-cyan-300">${esc(marketName)}</span></span>
        <span class="font-mono text-emerald-400">Tap highlighted box</span>
      </div>
      ${gridHtml}
    </div>`;
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
  let sortMode = expLegs.length > 1 ? 'coupon' : 'slip';

  titleEl.textContent = '📋 Bet365 Quick-Build Checklist';
  subEl.textContent =
    expLegs.length > 1
      ? 'Sorted by Bet365 coupon & league so you can tap every leg quickly'
      : 'Tap this selection on Bet365 and enter your stake';

  const ev = exp.eval || {};

  const renderHandoff = () => {
    const doneCount = completedLegs.size;
    const totalCount = expLegs.length;
    const pctDone = totalCount ? Math.round((doneCount / totalCount) * 100) : 0;
    const allDone = totalCount > 0 && doneCount === totalCount;
    const orderedEntries = sortBet365ChecklistLegs(expLegs, sortMode);

    let lastGroupKey = '';
    const cardsHtml = orderedEntries
      .map((entry) => {
        const l = entry.leg;
        const origIdx = entry.origIdx;
        const isDone = completedLegs.has(origIdx);
        const isCur = !isDone && origIdx === activeLegIdx;
        const copyTeam = l.b365_home || b365SearchTeam(l.home_team) || l.home_team || '';
        const dateTime = [l.match_date, l.kickoff_time].filter(Boolean).join(' • ');

        let groupHeader = '';
        if (sortMode === 'coupon' && entry.groupKey && entry.groupKey !== lastGroupKey) {
          lastGroupKey = entry.groupKey;
          groupHeader = `<div class="pt-1.5 pb-0.5 text-[11px] font-bold uppercase tracking-wider text-cyan-300">${esc(entry.groupLabel)}</div>`;
        }

        const cardCls = isDone
          ? 'bg-card/50 border-emerald-500/30 opacity-65'
          : isCur
            ? 'bg-emerald-500/10 border-emerald-400/70 shadow-sm shadow-emerald-950/30'
            : 'bg-card border-slate-800';

        return `
          ${groupHeader}
          <div class="p-3.5 rounded-2xl border space-y-2.5 text-xs transition ${cardCls}">
            <div class="flex flex-wrap items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="text-sm font-extrabold text-white truncate">${esc(l.home_team)} v ${esc(l.away_team)}</div>
                <div class="flex flex-wrap items-center gap-1.5 mt-0.5 text-[11px] text-slate-400">
                  <span class="px-1.5 py-0.5 rounded bg-slate-800 text-slate-200 font-semibold">${esc(l.league_name || 'English Football')}</span>
                  ${dateTime ? `<span class="font-mono">${esc(dateTime)}</span>` : ''}
                </div>
              </div>
              <button type="button" data-b365-done-idx="${origIdx}" class="px-3 py-1.5 rounded-xl font-bold border transition shrink-0 ${
                isDone
                  ? 'bg-emerald-500/20 border-emerald-400 text-emerald-200'
                  : 'bg-slate-800 hover:bg-emerald-600/30 border-slate-600 text-white'
              }">
                ${isDone ? '✅ Added on Bet365' : '⬜ Tap when added'}
              </button>
            </div>

            ${renderB365CouponBox(l)}

            <div class="flex flex-wrap items-center justify-between gap-2 pt-0.5">
              <button type="button" data-b365-copy-team="${esc(copyTeam)}" class="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 font-semibold">
                🔍 Copy &ldquo;${esc(copyTeam)}&rdquo;
              </button>
              <button type="button" data-b365-open-idx="${origIdx}" class="px-3 py-1.5 rounded-lg bg-emerald-600/85 hover:bg-emerald-500 text-white font-semibold">
                Open Match ↗
              </button>
            </div>
          </div>`;
      })
      .join('');

    body.innerHTML = `
      <div class="p-3.5 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 space-y-2.5 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div class="font-extrabold ${allDone ? 'text-emerald-300' : 'text-white'}">
              ${allDone ? '🎉 All legs added! Check your Bet365 betslip &amp; enter your stake' : `${doneCount} / ${totalCount} Ticked on Bet365`}
            </div>
            <div class="text-[11px] text-slate-300 mt-0.5">${esc(exp.title || title)}</div>
          </div>
          <div class="flex flex-wrap items-center gap-1.5">
            <button id="b365-open-main-btn" type="button" class="px-3 py-1.5 rounded-xl btn-bet365 text-xs font-extrabold">
              Open Bet365 ↗
            </button>
            <button id="b365-copy-btn" type="button" class="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold">
              📋 Copy Slip Text
            </button>
          </div>
        </div>
        <div class="h-2 rounded-full bg-slate-900 overflow-hidden">
          <div class="h-full bg-emerald-400 transition-all duration-300" style="width:${pctDone}%"></div>
        </div>
      </div>

      <div class="grid grid-cols-3 gap-2.5 text-xs">
        <div class="p-3 rounded-xl bg-card border border-slate-800"><div class="text-slate-400">Legs</div><div class="text-base font-bold font-mono text-white">${totalCount}</div></div>
        <div class="p-3 rounded-xl bg-card border border-slate-800"><div class="text-slate-400">Combined Odds</div><div class="text-base font-bold font-mono text-emerald-400">${fmtOdds(ev.combined_odds)}</div></div>
        <div class="p-3 rounded-xl bg-card border border-slate-800"><div class="text-slate-400">Win Chance</div><div class="text-base font-bold font-mono text-white">${Number(ev.combined_model_prob_pct || 0).toFixed(1)}%</div></div>
      </div>

      ${totalCount > 1
        ? `<div class="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Checklist Order</span>
            <div class="flex gap-1.5">
              <button type="button" data-b365-sort="coupon" class="px-2.5 py-1 rounded-full font-semibold border transition ${
                sortMode === 'coupon'
                  ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                  : 'bg-panel border-slate-700 text-slate-400 hover:text-white'
              }">🗂️ Bet365 Coupon Order</button>
              <button type="button" data-b365-sort="slip" class="px-2.5 py-1 rounded-full font-semibold border transition ${
                sortMode === 'slip'
                  ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                  : 'bg-panel border-slate-700 text-slate-400 hover:text-white'
              }">🔢 Original Order</button>
            </div>
          </div>`
        : ''
      }

      <div class="space-y-2.5">
        ${cardsHtml}
      </div>

      <div class="flex flex-wrap gap-2 pt-2 border-t border-slate-800">
        <button id="b365-back-suggest-btn" type="button" class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 font-semibold">${
          state.b365ChecklistSource === 'suggest'
            ? '← Back to Suggestions'
            : state.b365ChecklistSource === 'slip'
              ? '← Back to Bet Slip'
              : '✕ Close Checklist'
        }</button>
        <button id="b365-share-btn" type="button" class="flex-1 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs text-white font-semibold">📤 Share Slip</button>
        ${doneCount > 0 ? '<button id="b365-reset-ticks-btn" type="button" class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-emerald-300 font-semibold">✓ Reset Ticks</button>' : ''}
      </div>
    `;

    document.getElementById('b365-open-main-btn')?.addEventListener('click', () => {
      openInBet365Tab('https://www.bet365.com/#/HO/');
    });

    document.getElementById('b365-copy-btn')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(exp.clipboard_text || '').catch(() => { });
      showToast('Copied formatted slip to clipboard!');
    });

    body.querySelectorAll('[data-b365-sort]').forEach((btn) =>
      btn.addEventListener('click', () => {
        sortMode = btn.dataset.b365Sort;
        renderHandoff();
      })
    );

    body.querySelectorAll('[data-b365-done-idx]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.b365DoneIdx);
        if (completedLegs.has(i)) {
          completedLegs.delete(i);
          activeLegIdx = i;
        } else {
          completedLegs.add(i);
          const nextPending = expLegs.findIndex((_, idx) => !completedLegs.has(idx));
          if (nextPending !== -1) activeLegIdx = nextPending;
        }
        renderHandoff();
      })
    );

    body.querySelectorAll('[data-b365-copy-team]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const team = btn.dataset.b365CopyTeam || '';
        if (!team) return;
        navigator.clipboard?.writeText(team).catch(() => { });
        showToast(`Copied "${team}" — paste into Bet365 search!`);
      })
    );

    body.querySelectorAll('[data-b365-open-idx]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.b365OpenIdx);
        activeLegIdx = i;
        openInBet365Tab(expLegs[i]?.b365_search_url || exp.launch_url);
        renderHandoff();
      })
    );

    document.getElementById('b365-share-btn')?.addEventListener('click', () => {
      shareAccaSummary(legs, title || exp.title || 'AccaLab Tips');
    });

    document.getElementById('b365-reset-ticks-btn')?.addEventListener('click', () => {
      completedLegs.clear();
      activeLegIdx = 0;
      renderHandoff();
    });

    document.getElementById('b365-back-suggest-btn')?.addEventListener('click', () => {
      if (state.b365ChecklistSource === 'suggest') {
        openSuggestModal(state.activeRiskLevel || 'high');
      } else if (state.b365ChecklistSource === 'slip') {
        modal.classList.add('hidden');
        closeAllOverlays('slip-drawer');
        renderSlip();
        document.getElementById('slip-drawer')?.classList.remove('hidden');
      } else {
        modal.classList.add('hidden');
      }
    });
  };

  renderHandoff();
  modal.classList.remove('hidden');
}

async function exportToBet365(legs, stake = state.slipStake, title = 'AccaLab Suggested Bet', optionsOverride = '', source = 'slip') {
  if (!legs || !legs.length) {
    showToast('Add at least one selection first', true);
    return;
  }
  state.b365ChecklistSource = source || 'slip';
  try {
    const exp = await api('/api/bet365/export', {
      method: 'POST',
      body: JSON.stringify({ legs, stake, title, options_override: optionsOverride }),
    });
    state.slip = legs.map((l) => ({ ...l }));
    state.slipStake = Number(exp.stake || stake || 10);
    saveSlip();
    renderSlip();
    if (state.activeTab === 'fixtures') renderFixturesTab();
    closeAllOverlays('suggest-modal');
    if (exp.mode === 'direct_prefill') {
      openInBet365Tab(exp.launch_url);
    }
    renderBet365HandoffModal(exp, legs, exp.stake, title);
    showToast(
      exp.mode === 'direct_prefill'
        ? 'Launched Bet365 direct betslip!'
        : 'Bet365 checklist ready — tap each pick as you add it on Bet365!'
    );
  } catch (err) {
    showToast(err.message, true);
  }
}

async function openSuggestModal(initialRiskOrKey = state.activeRiskLevel || 'high') {
  closeAllOverlays('suggest-modal');
  const modal = document.getElementById('suggest-modal');
  const titleEl = document.getElementById('suggest-modal-title');
  const subEl = document.getElementById('suggest-modal-subtitle');
  const body = document.getElementById('suggest-modal-body');
  if (!modal || !body) return;

  titleEl.textContent = '✨ Smart Tip Assistant & Bet365 Export';
  subEl.textContent = 'Pick your risk level — from steady 1/1–2/1 builders to 40/1+ longshots';
  modal.classList.remove('hidden');
  body.innerHTML = '<div class="text-sm text-slate-400 py-8 text-center">Analyzing upcoming fixtures, Bet365 odds &amp; team news...</div>';

  try {
    const [res, valRes] = await Promise.all([
      api('/api/suggest-bet'),
      api('/api/value-bets?min_edge=1').catch(() => ({ opportunities: [] })),
    ]);
    const suggestions = res.suggestions || [];
    const riskLevels = res.risk_levels || [];
    const byRisk = res.by_risk || {};
    const candidatePool = (valRes.opportunities || []).map((o) => ({
      fixture_id: o.fixture_id,
      div: o.div,
      league_name: o.league_name,
      match_date: o.match_date,
      kickoff_time: o.kickoff_time || '',
      home_team: o.home_team,
      away_team: o.away_team,
      market: o.market,
      selection_label: o.selection_label,
      odds: Number(o.odds),
      odds_fractional: fmtOdds(o.odds),
      model_prob: roundNum(Number(o.model_prob_pct) / 100.0, 5),
      edge_pct: Number(o.edge_pct || 0),
      odds_source: o.odds_source,
    }));
    const lockedKeys = new Set();
    const skippedSwapKeys = new Set();
    const legKey = (l) => `${Number(l.fixture_id)}:${l.market}`;

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

    const swapLegAt = (pkg, swapIdx) => {
      if (!pkg?.legs?.[swapIdx]) return false;
      const oldLeg = pkg.legs[swapIdx];
      skippedSwapKeys.add(legKey(oldLeg));
      const usedFixtures = new Set(pkg.legs.map((l, idx) => (idx === swapIdx ? null : Number(l.fixture_id))));
      const findBest = (allowSkipped) =>
        candidatePool
          .filter((c) => {
            if (usedFixtures.has(Number(c.fixture_id))) return false;
            if (legKey(c) === legKey(oldLeg)) return false;
            if (!allowSkipped && skippedSwapKeys.has(legKey(c))) return false;
            return c.odds >= 1.2 && c.odds <= 8.0;
          })
          .sort((a, b) => {
            const distA = Math.abs(Math.log(Math.max(a.odds, 1.05) / Math.max(oldLeg.odds, 1.05))) - Math.min(a.edge_pct, 25) * 0.015;
            const distB = Math.abs(Math.log(Math.max(b.odds, 1.05) / Math.max(oldLeg.odds, 1.05))) - Math.min(b.edge_pct, 25) * 0.015;
            return distA - distB;
          })[0];

      let replacement = findBest(false);
      if (!replacement) {
        skippedSwapKeys.clear();
        replacement = findBest(true);
      }
      if (!replacement) return false;
      pkg.legs[swapIdx] = { ...replacement };
      pkg.eval = evaluateAccaClient(pkg.legs, currentStake);
      return true;
    };

    const renderPkg = () => {
      const tier = byRisk[activeRisk] || riskLevels[0] || {};
      const tierOptions = tier.options || suggestions;
      const s = res.by_id?.[activeKey] || tier.primary || tierOptions[0] || suggestions[0];
      const ev = s.eval || {};
      const evPos = Number(ev.expected_value_pct || 0) >= 0;
      const combinedDec = Number(ev.combined_odds || 1);
      const stakeNum = Math.max(0.5, Number(currentStake || getPkgStake(s, tier)));

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
            <div class="flex items-center gap-1.5">
              ${(s.legs || []).length > 1 ? `<button id="sug-reroll-btn" type="button" class="px-2.5 py-1 rounded-full bg-slate-800 hover:bg-slate-700 border border-slate-700 text-cyan-300 text-xs font-bold transition">🔄 Re-Roll Unlocked</button>` : ''}
              <div class="px-3 py-1 rounded-full bg-emerald-500/20 border border-emerald-400/50 text-emerald-300 text-xs font-extrabold font-mono">
                ${s.confidence_score}% Confidence
              </div>
            </div>
          </div>

          <div class="grid grid-cols-3 gap-2 text-xs">
            <div class="p-2.5 rounded-xl bg-panel border border-slate-800"><div class="text-slate-400">Combined Odds</div><div class="text-sm font-bold font-mono text-emerald-400">${esc(fmtOdds(combinedDec))}</div></div>
            <div class="p-2.5 rounded-xl bg-panel border border-slate-800"><div class="text-slate-400">Win Chance</div><div class="text-sm font-bold font-mono text-white">${Number(ev.combined_model_prob_pct || 0).toFixed(1)}%</div></div>
            <div class="p-2.5 rounded-xl bg-panel border border-slate-800"><div class="text-slate-400">Value Rating</div><div class="text-sm font-bold font-mono ${evPos ? 'text-emerald-400' : 'text-amber-300'}">${evPos ? '+' : ''}${Number(ev.expected_value_pct || 0).toFixed(1)}%</div></div>
          </div>

          <div class="space-y-2">
            ${(s.legs || [])
          .map(
            (l, i) => {
              const isLocked = lockedKeys.has(legKey(l));
              return `
              <div class="p-3 rounded-xl bg-surface/80 border ${isLocked ? 'border-amber-400/60' : 'border-slate-700/80'} flex items-center justify-between gap-2 text-xs">
                <div class="min-w-0">
                  <div class="text-[11px] text-emerald-400 font-semibold">${esc(l.league_name)} • ${esc(l.match_date)}</div>
                  <div class="font-bold text-white truncate mt-0.5">${i + 1}. ${esc(l.selection_label)}</div>
                  <div class="text-[11px] text-slate-400 truncate">${esc(l.home_team)} vs ${esc(l.away_team)}</div>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <div class="text-right font-mono">
                    <div class="text-sm font-extrabold text-emerald-400">@ ${esc(fmtOdds(l.odds))}</div>
                    <div class="text-[10px] text-slate-400">${(Number(l.model_prob) * 100).toFixed(0)}% (${Number(l.edge_pct) >= 0 ? '+' : ''}${Number(l.edge_pct).toFixed(1)}% EV)</div>
                  </div>
                  <div class="flex flex-col gap-1">
                    <button type="button" data-lock-leg="${i}" title="${isLocked ? 'Unlock leg' : 'Lock leg'}" class="px-2 py-0.5 rounded text-[10px] font-semibold border transition ${isLocked ? 'bg-amber-500/20 border-amber-400 text-amber-200' : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white'}">${isLocked ? '🔒 Locked' : '🔓 Lock'}</button>
                    <button type="button" data-swap-leg="${i}" title="Swap this leg" class="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-800 hover:bg-cyan-600/30 border border-slate-700 text-cyan-300 transition">🔄 Swap</button>
                  </div>
                </div>
              </div>`;
            }
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
            <button id="sug-export-b365-btn" type="button" class="flex-1 py-2.5 px-4 rounded-xl btn-bet365 text-xs font-extrabold">📋 Build on Bet365</button>
            <button id="sug-load-slip-btn" type="button" class="px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold">🧾 Load to Slip</button>
            <button id="sug-share-btn" type="button" class="px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-emerald-300 text-xs font-semibold">📤 Share</button>
            <button id="sug-save-draft-btn" type="button" class="px-3 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold">💾 Save</button>
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

      body.querySelectorAll('[data-lock-leg]').forEach((btn) =>
        btn.addEventListener('click', () => {
          const idx = Number(btn.dataset.lockLeg);
          const leg = s.legs?.[idx];
          if (!leg) return;
          const k = legKey(leg);
          if (lockedKeys.has(k)) lockedKeys.delete(k);
          else lockedKeys.add(k);
          renderPkg();
        })
      );

      body.querySelectorAll('[data-swap-leg]').forEach((btn) =>
        btn.addEventListener('click', () => {
          const idx = Number(btn.dataset.swapLeg);
          const leg = s.legs?.[idx];
          if (!leg) return;
          lockedKeys.delete(legKey(leg));
          if (swapLegAt(s, idx)) {
            renderPkg();
            showToast(`Swapped leg ${idx + 1} to ${s.legs[idx].selection_label}`);
          } else {
            showToast('No alternative matches available for swap right now', true);
          }
        })
      );

      document.getElementById('sug-reroll-btn')?.addEventListener('click', () => {
        let changed = 0;
        for (let i = 0; i < (s.legs || []).length; i += 1) {
          if (!lockedKeys.has(legKey(s.legs[i]))) {
            if (swapLegAt(s, i)) changed += 1;
          }
        }
        if (changed > 0) {
          renderPkg();
          showToast(`Re-rolled ${changed} unlocked ${changed === 1 ? 'leg' : 'legs'}!`);
        } else {
          showToast('Unlock at least one leg to re-roll', true);
        }
      });

      document.getElementById('sug-share-btn')?.addEventListener('click', () =>
        shareAccaSummary(s.legs, s.title)
      );

      document.getElementById('sug-export-b365-btn').addEventListener('click', () =>
        exportToBet365(s.legs, currentStake, s.title, '', 'suggest')
      );
      document.getElementById('sug-load-slip-btn').addEventListener('click', () => {
        state.slip = s.legs.map((l) => ({ ...l }));
        state.slipStake = Number(currentStake || state.slipStake || 10);
        saveSlip();
        renderSlip();
        closeAllOverlays('slip-drawer');
        document.getElementById('slip-drawer').classList.remove('hidden');
        if (state.activeTab === 'fixtures') renderFixturesTab();
        showToast(`Loaded "${s.title}" into your Tip Slip!`);
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

function closeAllOverlays(exceptId = '') {
  for (const id of ['preview-modal', 'suggest-modal', 'slip-drawer', 'auth-modal']) {
    if (id !== exceptId) {
      document.getElementById(id)?.classList.add('hidden');
    }
  }
}

function bindGlobalEvents() {
  document.querySelectorAll('[data-tab]').forEach((btn) =>
    btn.addEventListener('click', () => {
      closeAllOverlays();
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
  document.getElementById('open-suggest-mobile-btn')?.addEventListener('click', () => openSuggestModal(state.activeRiskLevel || 'high'));
  document.getElementById('close-suggest-modal')?.addEventListener('click', () =>
    document.getElementById('suggest-modal').classList.add('hidden')
  );

  document.getElementById('sync-btn-sidebar').addEventListener('click', () => triggerSync(false, false));
  document.getElementById('close-preview-modal').addEventListener('click', () =>
    document.getElementById('preview-modal').classList.add('hidden')
  );
  document.getElementById('open-slip-btn').addEventListener('click', () => {
    closeAllOverlays('slip-drawer');
    renderSlip();
    document.getElementById('slip-drawer').classList.remove('hidden');
  });
  document.getElementById('close-slip-btn').addEventListener('click', () =>
    document.getElementById('slip-drawer').classList.add('hidden')
  );

  for (const modalId of ['preview-modal', 'suggest-modal', 'auth-modal']) {
    const modalEl = document.getElementById(modalId);
    modalEl?.addEventListener('click', (e) => {
      if (e.target === modalEl) {
        modalEl.classList.add('hidden');
      }
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllOverlays();
    }
  });
}

function initPwaAutoUpdater() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || refreshing) return;
    refreshing = true;
    window.location.reload();
  });
  navigator.serviceWorker
    .register('./sw.js', { updateViaCache: 'none' })
    .then((reg) => {
      reg.update().catch(() => { });
      if (reg.waiting) {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      }
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            newWorker.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          reg.update().catch(() => { });
        }
      });
      setInterval(() => {
        reg.update().catch(() => { });
      }, 15 * 60 * 1000);
    })
    .catch(() => { });
}

async function boot() {
  initPwaAutoUpdater();
  bindGlobalEvents();
  await loadDashboard(true);
  saveSlip(false);
  await renderActiveTab();
  if (!(state.dashboard?.users || []).length) {
    openAuthModal('register');
  }
}

boot();
