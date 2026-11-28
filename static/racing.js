// AccaLab Horse Racing Frontend Module (UK/IRE & International Racecards, Tips, UK Multiples & Bet365 Handoff)

const RACING_SLIP_KEY = 'accalab_racing_slip_v1';
const RACING_MULTI_PREFS_KEY = 'accalab_racing_multi_prefs_v1';
const RACING_CUSTOM_ODDS_KEY = 'accalab_racing_custom_odds_v1';
const RACING_PLACED_KEY = 'accalab_racing_placed_v1';
const RACING_SUGGEST_KEY = 'accalab_racing_suggest_criteria_v1';

export const RACING_MULTIPLES_CLIENT = {
  single: { label: 'Single', short: 'Single', folds: [1], min_legs: 1, max_legs: 1 },
  double: { label: 'Double', short: 'Double', folds: [2], min_legs: 2, max_legs: 2 },
  treble: { label: 'Treble', short: 'Treble', folds: [3], min_legs: 3, max_legs: 3 },
  acca: { label: 'Accumulator', short: 'Acca', folds: null, min_legs: 2, max_legs: 6 },
  trixie: { label: 'Trixie (3 Picks • 4 Bets)', short: 'Trixie (4)', folds: [2, 3], min_legs: 3, max_legs: 3 },
  patent: { label: 'Patent (3 Picks • 7 Bets)', short: 'Patent (7)', folds: [1, 2, 3], min_legs: 3, max_legs: 3 },
  yankee: { label: 'Yankee (4 Picks • 11 Bets)', short: 'Yankee (11)', folds: [2, 3, 4], min_legs: 4, max_legs: 4 },
  lucky15: { label: 'Lucky 15 (4 Picks • 15 Bets)', short: 'Lucky 15 (15)', folds: [1, 2, 3, 4], min_legs: 4, max_legs: 4 },
};

const REGION_FILTER_OPTIONS = [
  ['ALL', '🌍 All Regions'],
  ['UK_IRE', '🇬🇧 UK & Ireland'],
  ['FR', '🇫🇷 France'],
  ['US', '🇺🇸 USA'],
  ['AU', '🇦🇺 Australia'],
  ['INTL', '🗺️ International'],
];

const RACE_ABBREV_RULES = [
  [/\bHcp\b/g, 'Handicap'],
  [/\bMdn\b/g, 'Maiden'],
  [/\bNh\b/g, 'NH'],
  [/\bEbf\b/g, 'EBF'],
  [/\bGbb\b/g, 'GBB'],
  [/\bGbbplus\b/gi, 'GBB Plus'],
  [/\bGbbplusrace\b/gi, 'GBB Plus Race'],
  [/\bAwc\b/g, 'AWC'],
  [/\bApp\b/g, 'Apprentice'],
  [/\bCond\b/g, 'Conditional'],
];

export function formatRaceTitle(name) {
  let out = String(name || '').trim();
  if (!out) return '';
  for (const [re, rep] of RACE_ABBREV_RULES) {
    out = out.replace(re, rep);
  }
  return out;
}

const UK_FRAC_TABLE = [
  [1, 5], [1, 4], [1, 3], [2, 5], [1, 2], [4, 7], [4, 6], [4, 5], [10, 11], [1, 1],
  [11, 10], [6, 5], [5, 4], [11, 8], [6, 4], [13, 8], [7, 4], [15, 8], [2, 1], [9, 4],
  [5, 2], [11, 4], [3, 1], [10, 3], [7, 2], [4, 1], [9, 2], [5, 1], [11, 2], [6, 1],
  [13, 2], [7, 1], [15, 2], [8, 1], [9, 1], [10, 1],
];

const roundC = (val, dec = 2) => {
  const f = 10 ** dec;
  return Math.round((Number(val) || 0) * f) / f;
};

function fmtOddsLocal(dec) {
  const val = Number(dec);
  if (!Number.isFinite(val) || val <= 1.01) return '—';
  if (val > 11.0) return `${Math.max(10, Math.round(val - 1.0))}/1`;
  let best = UK_FRAC_TABLE[0];
  let diffMin = Infinity;
  for (const fr of UK_FRAC_TABLE) {
    const diff = Math.abs(1.0 + fr[0] / fr[1] - val);
    if (diff < diffMin) {
      diffMin = diff;
      best = fr;
    }
  }
  return `${best[0]}/${best[1]}`;
}

export function ukPlaceTermsClient(runnersCount, isHandicap = false) {
  const n = Math.max(1, Number(runnersCount || 1));
  if (n < 5) return { places_paid: 1, place_fraction: 0.0, ew_eligible: false, label: 'Win Only (<5 runners)' };
  if (n <= 7) return { places_paid: 2, place_fraction: 0.25, ew_eligible: true, label: '1/4 odds, 1–2' };
  if (n <= 11) return { places_paid: 3, place_fraction: 0.2, ew_eligible: true, label: '1/5 odds, 1–3' };
  if (n <= 15) {
    return isHandicap
      ? { places_paid: 3, place_fraction: 0.25, ew_eligible: true, label: '1/4 odds, 1–3' }
      : { places_paid: 3, place_fraction: 0.2, ew_eligible: true, label: '1/5 odds, 1–3' };
  }
  return isHandicap
    ? { places_paid: 4, place_fraction: 0.25, ew_eligible: true, label: '1/4 odds, 1–4' }
    : { places_paid: 3, place_fraction: 0.2, ew_eligible: true, label: '1/5 odds, 1–3' };
}

function probAtLeastKClient(probs = [], k = 1) {
  if (k <= 0) return 1.0;
  const n = probs.length;
  if (k > n) return 0.0;
  let dp = new Array(n + 1).fill(0);
  dp[0] = 1.0;
  for (const rawP of probs) {
    const p = Math.max(0, Math.min(1, Number(rawP || 0)));
    const nxt = new Array(n + 1).fill(0);
    for (let c = 0; c <= n; c += 1) {
      nxt[c] += dp[c] * (1.0 - p);
      if (c + 1 <= n) nxt[c + 1] += dp[c] * p;
    }
    dp = nxt;
  }
  let sum = 0;
  for (let c = k; c <= n; c += 1) sum += dp[c];
  return sum;
}

function combinationsClient(arr, k) {
  const res = [];
  const walk = (start, path) => {
    if (path.length === k) {
      res.push([...path]);
      return;
    }
    for (let i = start; i <= arr.length - (k - path.length); i += 1) {
      path.push(arr[i]);
      walk(i + 1, path);
      path.pop();
    }
  };
  walk(0, []);
  return res;
}

function normalizeRacingLegClient(leg = {}) {
  const winOdds = Math.max(1.02, Number(leg.win_odds || leg.odds || 2.0));
  const ewElig = leg.ew_eligible !== undefined ? Boolean(leg.ew_eligible) : Number(leg.place_fraction || 0) > 0;
  const pf = ewElig ? Number(leg.place_fraction || 0) : 0;
  let plcOdds = Number(leg.place_odds || (pf > 0 ? 1.0 + (winOdds - 1.0) * pf : 1.0));
  if (String(leg.market || '').toUpperCase() === 'R_PLC' && leg.odds && !leg.place_odds) {
    plcOdds = Math.max(1.02, Number(leg.odds));
  }

  let winP = Number(leg.model_win_prob !== undefined ? leg.model_win_prob : leg.model_prob || 0.25);
  if (winP > 1) winP /= 100;
  winP = Math.max(0.004, Math.min(0.95, winP));

  let plcP = Number(leg.model_place_prob !== undefined ? leg.model_place_prob : Math.min(0.96, winP * 2.4));
  if (plcP > 1) plcP /= 100;
  plcP = Math.max(winP, Math.min(0.98, plcP));

  return {
    ...leg,
    win_odds: roundC(winOdds, 2),
    place_odds: roundC(plcOdds, 3),
    place_fraction: pf,
    ew_eligible: ewElig,
    model_win_prob: winP,
    model_place_prob: plcP,
  };
}

export function evaluateRacingMultipleClient(legs = [], structure = 'acca', eachWay = false, unitStake = 1.0) {
  let structKey = String(structure || 'acca').trim().toLowerCase();
  if (!RACING_MULTIPLES_CLIENT[structKey]) structKey = 'acca';
  const spec = RACING_MULTIPLES_CLIENT[structKey];
  const cleanUnit = roundC(Math.max(0.1, Number(unitStake || 1.0)), 2);
  const normLegs = (Array.isArray(legs) ? legs : []).map(normalizeRacingLegClient);
  const n = normLegs.length;

  if (!n) {
    return {
      structure: structKey,
      structure_label: spec.label,
      each_way: Boolean(eachWay),
      unit_stake: cleanUnit,
      leg_count: 0,
      base_lines: 0,
      total_bets: 0,
      total_stake: 0.0,
      max_return: 0.0,
      all_place_return: 0.0,
      expected_return: 0.0,
      expected_profit: 0.0,
      expected_value_pct: 0.0,
      prob_all_win_pct: 0.0,
      prob_all_place_pct: 0.0,
      prob_any_return_pct: 0.0,
      breakdown: [],
      warnings: ['Select at least one runner to evaluate.'],
    };
  }

  let folds = spec.folds ? [...spec.folds] : [Math.max(1, n)];
  if (structKey !== 'acca') {
    folds = folds.filter((f) => f <= n);
    if (!folds.length) folds = [n];
  }

  const warnings = [];
  if (n < spec.min_legs) {
    warnings.push(`${spec.label} normally uses ${spec.min_legs} picks (${n} currently selected).`);
  } else if (n > spec.max_legs) {
    warnings.push(`${spec.label} takes ${spec.max_legs} picks — currently evaluating all ${n} picks.`);
  }

  const byRace = {};
  let winOnlyCount = 0;
  for (const lg of normLegs) {
    const rk = String(lg.race_id || `${lg.race_date}|${lg.course}|${lg.off_time}`);
    if (!byRace[rk]) byRace[rk] = [];
    byRace[rk].push(String(lg.horse_name || 'Runner'));
    if (eachWay && !lg.ew_eligible) winOnlyCount += 1;
  }
  for (const horses of Object.values(byRace)) {
    if (horses.length > 1) {
      warnings.push(`Same-race conflict (${horses.join(', ')}): two horses cannot both win the same race in a multiple.`);
    }
  }
  if (winOnlyCount > 0) {
    warnings.push(`${winOnlyCount} leg(s) are in <5 runner races (Win Only under UK rules — Each-Way place payout reduced).`);
  }

  const allPlaceOnly = !eachWay && normLegs.every((l) => String(l.market || '').toUpperCase() === 'R_PLC');
  let baseLines = 0;
  let maxReturn = 0.0;
  let allPlaceReturn = 0.0;
  let expectedReturn = 0.0;
  const breakdown = [];
  const foldNames = { 1: 'Singles', 2: 'Doubles', 3: 'Trebles', 4: '4-Folds', 5: '5-Folds', 6: '6-Folds' };

  for (const fSize of folds) {
    const combos = combinationsClient(normLegs, fSize);
    const lineCnt = combos.length;
    baseLines += lineCnt;
    let foldMax = 0.0;
    let foldPlcOnly = 0.0;
    let foldExp = 0.0;

    for (const combo of combos) {
      let winO = 1.0;
      let winP = 1.0;
      let plcO = 1.0;
      let plcP = 1.0;
      let singlePlcO = 1.0;
      let singlePlcP = 1.0;
      for (const cLeg of combo) {
        winO *= cLeg.win_odds;
        winP *= cLeg.model_win_prob;
        plcO *= cLeg.place_odds;
        plcP *= cLeg.model_place_prob;
        if (String(cLeg.market || '').toUpperCase() === 'R_PLC') {
          singlePlcO *= cLeg.place_odds;
          singlePlcP *= cLeg.model_place_prob;
        } else {
          singlePlcO *= cLeg.win_odds;
          singlePlcP *= cLeg.model_win_prob;
        }
      }
      if (eachWay) {
        foldMax += cleanUnit * (winO + plcO);
        foldPlcOnly += cleanUnit * plcO;
        foldExp += cleanUnit * (winP * winO + plcP * plcO);
      } else if (allPlaceOnly) {
        foldMax += cleanUnit * plcO;
        foldPlcOnly += cleanUnit * plcO;
        foldExp += cleanUnit * plcP * plcO;
      } else {
        foldMax += cleanUnit * singlePlcO;
        foldExp += cleanUnit * singlePlcP * singlePlcO;
      }
    }

    foldMax = Math.min(1000000.0, foldMax);
    foldPlcOnly = Math.min(1000000.0, foldPlcOnly);
    maxReturn = Math.min(1000000.0, maxReturn + foldMax);
    allPlaceReturn = Math.min(1000000.0, allPlaceReturn + foldPlcOnly);
    expectedReturn += foldExp;
    breakdown.push({
      fold: fSize,
      label: foldNames[fSize] || `${fSize}-Folds`,
      lines: lineCnt * (eachWay ? 2 : 1),
      max_return: roundC(foldMax, 2),
      all_place_return: roundC(foldPlcOnly, 2),
      expected_return: roundC(foldExp, 2),
    });
  }

  const totalBets = baseLines * (eachWay ? 2 : 1);
  const totalStake = roundC(totalBets * cleanUnit, 2);
  const expectedProfit = roundC(expectedReturn - totalStake, 2);
  const evPct = totalStake > 0 ? roundC(((expectedReturn / totalStake) - 1.0) * 100.0, 2) : 0.0;

  let pAllWin = 1.0;
  let pAllPlc = 1.0;
  const hitProbs = [];
  for (const lg of normLegs) {
    pAllWin *= lg.model_win_prob;
    pAllPlc *= lg.model_place_prob;
    hitProbs.push(eachWay || String(lg.market || '').toUpperCase() === 'R_PLC' ? lg.model_place_prob : lg.model_win_prob);
  }
  const minFold = folds.length ? Math.min(...folds) : n;
  const probAny = probAtLeastKClient(hitProbs, minFold);

  return {
    structure: structKey,
    structure_label: spec.label,
    each_way: Boolean(eachWay),
    unit_stake: cleanUnit,
    leg_count: n,
    base_lines: baseLines,
    total_bets: totalBets,
    total_stake: totalStake,
    max_return: roundC(maxReturn, 2),
    all_place_return: roundC(allPlaceReturn, 2),
    expected_return: roundC(expectedReturn, 2),
    expected_profit: expectedProfit,
    expected_value_pct: evPct,
    prob_all_win_pct: roundC(pAllWin * 100.0, 2),
    prob_all_place_pct: roundC(pAllPlc * 100.0, 2),
    prob_any_return_pct: roundC(probAny * 100.0, 1),
    breakdown,
    warnings,
  };
}

let _racingSnapshot = null;

export function setRacingSnapshotForTest(snap) {
  _racingSnapshot = snap;
}

function getStorageSafe(key, fallback) {
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null');
    return raw !== null && raw !== undefined ? raw : fallback;
  } catch {
    return fallback;
  }
}

function setStorageSafe(key, val) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {}
}

const RACING_DATE_PRESETS = [
  ['all', 'All Upcoming'],
  ['today', 'Today'],
  ['tomorrow', 'Tomorrow'],
  ['next_2', 'Next 2 Days'],
  ['next_3', 'Next 3 Days'],
  ['custom', 'Custom Range'],
];

function cleanIsoDateClient(val) {
  const s = String(val || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return '';
  const iso = s.slice(0, 10);
  const dt = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso) return '';
  return iso;
}

function formatShortRacingDate(iso) {
  const clean = cleanIsoDateClient(iso);
  if (!clean) return String(iso || '');
  const dt = new Date(`${clean}T12:00:00Z`);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[dt.getUTCDay()]} ${dt.getUTCDate()} ${months[dt.getUTCMonth()]}`;
}

function ukNowInfo(nowDate = new Date()) {
  const year = nowDate.getUTCFullYear();
  const mar31 = new Date(Date.UTC(year, 2, 31, 1, 0, 0));
  const bstStart = new Date(mar31.getTime() - ((mar31.getUTCDay() + 7) % 7) * 86400000);
  const oct31 = new Date(Date.UTC(year, 9, 31, 1, 0, 0));
  const bstEnd = new Date(oct31.getTime() - ((oct31.getUTCDay() + 7) % 7) * 86400000);
  const isBst = nowDate >= bstStart && nowDate < bstEnd;
  const ukDt = new Date(nowDate.getTime() + (isBst ? 3600000 : 0));
  const iso = ukDt.toISOString();
  const tomDt = new Date(ukDt.getTime() + 86400000);
  const day2Dt = new Date(ukDt.getTime() + 2 * 86400000);
  return {
    todayIso: iso.slice(0, 10),
    tomorrowIso: tomDt.toISOString().slice(0, 10),
    dayPlus2Iso: day2Dt.toISOString().slice(0, 10),
    hhmm: iso.slice(11, 16),
  };
}

function isRaceUpcomingClient(race, nowDate = new Date()) {
  if (!race) return true;
  if (String(race.status || '').toLowerCase() === 'result') return false;
  const { todayIso, hhmm } = ukNowInfo(nowDate);
  const rDate = String(race.race_date || '').slice(0, 10);
  if (!rDate) return true;
  if (rDate > todayIso) return true;
  if (rDate < todayIso) return false;
  const offT = String(race.off_time || '').trim();
  if (!offT) return true;
  return offT > hhmm;
}

function normalizeCourseSlugClient(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

function applyCustomOddsToRunner(runner, customOddsMap = {}) {
  const rec = customOddsMap?.[String(runner.runner_id)];
  if (!rec || !rec.odds || Number(rec.odds) <= 1.01) return runner;
  const dec = roundC(Number(rec.odds), 2);
  const pf = Number(runner.place_fraction || 0);
  const ewElig = Boolean(runner.ew_eligible) && pf > 0;
  const plcOdds = ewElig ? roundC(1.0 + (dec - 1.0) * pf, 3) : 1.0;
  const pWin = Number(runner.model_win_prob || 0.1);
  const pPlc = Number(runner.model_place_prob || 0.3);
  const winEdge = roundC((pWin * dec - 1.0) * 100.0, 2);
  const plcEdge = ewElig ? roundC((pPlc * plcOdds - 1.0) * 100.0, 2) : winEdge;
  const ewEdge = ewElig ? roundC(0.5 * ((pWin * dec - 1.0) + (pPlc * plcOdds - 1.0)) * 100.0, 2) : winEdge;

  const isPlcTip = String(runner.market || '').toUpperCase() === 'R_PLC';
  return {
    ...runner,
    win_odds: dec,
    place_odds: plcOdds,
    odds: isPlcTip ? plcOdds : dec,
    odds_fractional: isPlcTip ? (ewElig ? fmtOddsLocal(plcOdds) : '—') : fmtOddsLocal(dec),
    place_odds_fractional: ewElig ? fmtOddsLocal(plcOdds) : '—',
    odds_source: 'user_manual',
    win_edge_pct: winEdge,
    ew_edge_pct: ewEdge,
    place_edge_pct: plcEdge,
    edge_pct: isPlcTip ? plcEdge : String(runner.market || '').toUpperCase() === 'R_EW' ? ewEdge : winEdge,
  };
}

function racingExclusionSetsClient(excludeLegs = []) {
  const raceKeys = new Set();
  const runnerKeys = new Set();
  for (const lg of excludeLegs || []) {
    if (!lg || typeof lg !== 'object') continue;
    const rid = lg.race_id;
    const slug = normalizeCourseSlugClient(lg.course || '');
    const rd = String(lg.race_date || '').slice(0, 10);
    const offT = String(lg.off_time || '');
    const rSig = rid ? `id:${rid}` : slug ? `${rd}:${slug}:${offT}` : '';
    if (rSig) raceKeys.add(rSig);
    const rnId = lg.runner_id;
    const hNm = String(lg.horse_name || '').trim().toLowerCase();
    if (rnId) runnerKeys.add(`rn:${rnId}`);
    if (rSig && hNm) runnerKeys.add(`${rSig}:${hNm}`);
  }
  return { raceKeys, runnerKeys };
}

function isRacingTipExcludedClient(tip, sets, scope = 'race') {
  const { raceKeys, runnerKeys } = sets;
  const slug = normalizeCourseSlugClient(tip.course || '');
  const sigId = tip.race_id ? `id:${tip.race_id}` : '';
  const sigTxt = `${tip.race_date || ''}:${slug}:${tip.off_time || ''}`;
  if (scope === 'race') {
    return (sigId && raceKeys.has(sigId)) || raceKeys.has(sigTxt);
  }
  const rnId = tip.runner_id;
  const hNm = String(tip.horse_name || '').trim().toLowerCase();
  if (rnId && runnerKeys.has(`rn:${rnId}`)) return true;
  if (sigId && runnerKeys.has(`${sigId}:${hNm}`)) return true;
  return runnerKeys.has(`${sigTxt}:${hNm}`);
}

function buildRacingBetReasonsClient(title, legs, ev, eachWay) {
  if (!legs?.length) return [];
  const distinctCourses = new Set(legs.map((l) => l.course)).size;
  const courseList = [...new Set(legs.map((l) => l.course))].join(', ');
  const topLeg = legs.reduce((a, b) => (Number(b.model_rating || 0) > Number(a.model_rating || 0) ? b : a), legs[0]);
  const struct = String(ev?.structure || 'acca').toLowerCase();
  let structDesc = '';
  let structWhy = '';
  if (struct === 'single') {
    structDesc = `Single bet covering 1 race — relies solely on ${legs[0].horse_name} finishing ${eachWay ? 'in the places or winning' : 'first'}.`;
    structWhy = 'concentrated stake on your highest-conviction runner avoids multiple-leg variance.';
  } else if (['double', 'treble', 'acca'].includes(struct)) {
    structDesc = `${ev.structure_label} across ${distinctCourses} track(s) — all ${legs.length} selections roll together${eachWay ? ' (or place on the E/W half)' : ''} to multiply your odds.`;
    const fullPct = eachWay ? Number(ev.prob_all_place_pct || 0) : Number(ev.prob_all_win_pct || 0);
    structWhy = `keeping every leg from a separate race eliminates conflicting outcomes and hits at a ${fullPct.toFixed(1)}% full-slip rate.`;
  } else {
    const hasSingles = ['patent', 'lucky15'].includes(struct);
    const minNote = hasSingles ? 'just 1 winner already pays a return' : '2 winners already guarantee a return';
    structDesc = `${ev.structure_label} across ${distinctCourses} track(s) covering ${ev.base_lines} combinations — ${minNote}${eachWay ? ' (doubled with Each-Way cover)' : ''}.`;
    structWhy = `combining singles/doubles/trebles protects you if 1 or 2 picks finish just short (${Number(ev.prob_any_return_pct || 0).toFixed(1)}% chance of a return).`;
  }
  const placeTxt = eachWay ? ` • All-place return: £${ev.all_place_return.toFixed(2)}` : '';
  const avgWinPct = legs.reduce((acc, l) => acc + Number(l.model_win_prob || 0) * 100.0, 0) / legs.length;
  const topRs = topLeg.reason_stats || {};
  const weakCnt = Number(topRs.rivals_weak_form_count || 0);
  const dispF = String(topRs.display_form || topLeg.display_form || '').trim();
  let anchorWhy = `having ${topLeg.horse_name} as a top-rated anchor steadies the overall multiple (${avgWinPct.toFixed(1)}% avg win rate).`;
  if (topRs.weak_field_edge && weakCnt > 0) {
    anchorWhy = `${topLeg.horse_name} brings form (${dispF || 'recent wins'}) into a race where ${weakCnt} rivals lack recent form, giving the slip a dependable lead runner.`;
  } else if (dispF) {
    anchorWhy = `${topLeg.horse_name} carries recent figures ${dispF} alongside an average ${avgWinPct.toFixed(1)}% win chance across the ${legs.length} leg(s).`;
  }

  return [
    `Bet Structure: ${structDesc} — why it matters: ${structWhy}`,
    `Stake & Realistic Payout: £${ev.unit_stake.toFixed(2)}/line across ${ev.total_bets} bets (£${ev.total_stake.toFixed(2)} total). Max payout if all win: £${ev.max_return.toFixed(2)}${placeTxt} — why it matters: ${ev.prob_any_return_pct.toFixed(1)}% estimated chance of at least one return at sensible odds.`,
    `Headline Pick & Form Logic: ${topLeg.horse_name} (${topLeg.off_time} ${topLeg.course}) leads at ${Number(topLeg.model_rating || 0).toFixed(0)}/100 (${(Number(topLeg.model_win_prob || 0) * 100).toFixed(1)}% Win / ${(Number(topLeg.model_place_prob || 0) * 100).toFixed(1)}% Place) — why it matters: ${anchorWhy}`,
    `Selection Safeguards: Strictly 1 horse per race across ${courseList}, capping outsider risk inside your tier and skipping runners already in your slip or setbacks in news — why it matters: keeps the multiple realistic instead of chasing extreme longshots.`,
  ];
}

export function buildRacingBet365ExportClient(legs = [], structure = 'acca', eachWay = false, unitStake = 1.0, title = 'AccaLab Racing Bet') {
  const ev = evaluateRacingMultipleClient(legs, structure, eachWay, unitStake);
  const exportedLegs = (legs || []).map((lg, idx) => {
    const horse = String(lg.horse_name || '').trim();
    const course = String(lg.course || '').trim();
    const offT = String(lg.off_time || '').trim();
    const q = horse || `${course} ${offT}`.trim() || 'Horse Racing';
    const oddsVal = roundC(Number(lg.odds || 2.0), 2);
    return {
      index: idx + 1,
      horse_name: horse,
      course,
      race_date: lg.race_date || '',
      off_time: offT,
      saddle_cloth: lg.saddle_cloth || 0,
      selection_label: lg.selection_label || horse,
      market: lg.market || 'R_WIN',
      odds: oddsVal,
      odds_fractional: lg.odds_fractional || fmtOddsLocal(oddsVal),
      place_terms_label: lg.place_terms_label || '',
      b365_search_url: `https://www.bet365.com/#/AX/K^${encodeURIComponent(q)}/`,
    };
  });
  const ewTag = eachWay ? 'Each-Way ' : '';
  const lines = [
    `🏇 ${title} — ${ewTag}${ev.structure_label}`,
    `Unit Stake: £${ev.unit_stake.toFixed(2)} × ${ev.total_bets} bets = £${ev.total_stake.toFixed(2)} total`,
    `Max Return: £${ev.max_return.toFixed(2)}${eachWay ? ` | All Place Return: £${ev.all_place_return.toFixed(2)}` : ''}`,
    `Expected Value: ${ev.expected_value_pct >= 0 ? '+' : ''}${ev.expected_value_pct.toFixed(1)}% | Hit Any Return: ${ev.prob_any_return_pct.toFixed(1)}%`,
    '',
    ...exportedLegs.map(
      (it) => `${it.index}. ${it.off_time} ${it.course} — #${it.saddle_cloth} ${it.horse_name} @ ${it.odds_fractional} (${it.place_terms_label || 'Win'})`
    ),
    '',
    `On Bet365 Slip: Select '${ev.structure_label.split(' (')[0]}'${eachWay ? ' & tick E/W box.' : '.'}`,
  ];
  return {
    title,
    structure: ev.structure,
    structure_label: ev.structure_label,
    each_way: Boolean(eachWay),
    launch_url: exportedLegs[0]?.b365_search_url || 'https://www.bet365.com/#/AS/B2/',
    racing_hub_url: 'https://www.bet365.com/#/AS/B2/',
    clipboard_text: lines.join('\n'),
    eval: ev,
    legs: exportedLegs,
  };
}

function tipToLegClient(tip) {
  return {
    runner_id: tip.runner_id,
    race_id: tip.race_id,
    race_key: tip.race_key,
    region_code: tip.region_code,
    region_flag: tip.region_flag || '',
    course: tip.course,
    race_date: tip.race_date,
    off_time: tip.off_time,
    race_name: tip.race_name,
    race_type: tip.race_type,
    runners_count: tip.runners_count,
    places_paid: tip.places_paid,
    place_fraction: tip.place_fraction,
    ew_eligible: tip.ew_eligible,
    place_terms_label: tip.place_terms_label,
    saddle_cloth: tip.saddle_cloth,
    horse_name: tip.horse_name,
    jockey: tip.jockey || '',
    trainer: tip.trainer || '',
    market: tip.market,
    bet_type: tip.bet_type,
    bet_type_label: tip.bet_type_label,
    selection_label: tip.selection_label,
    odds: tip.odds,
    odds_fractional: tip.odds_fractional,
    win_odds: tip.win_odds,
    place_odds: tip.place_odds,
    odds_source: tip.odds_source,
    model_prob: tip.model_prob,
    model_win_prob: tip.model_win_prob,
    model_place_prob: tip.model_place_prob,
    edge_pct: tip.edge_pct,
    confidence_score: tip.confidence_score,
    model_rating: tip.model_rating,
    value_tag: tip.value_tag || '',
    reasons: [...(tip.reasons || [])],
    reason_stats: tip.reason_stats || {},
  };
}

const RACING_RISK_ODDS_BANDS = {
  low: [1.2, 3.75],
  medium: [1.75, 6.5],
  high: [3.25, 11.0],
  longshot: [5.5, 21.0],
};

function scoreRacingRiskClient(tip, riskLevel) {
  const winO = Number(tip.win_odds || tip.odds || 3.0);
  const rating = Number(tip.model_rating || 50);
  const winP = Number(tip.model_win_prob_pct || 10);
  const plcP = Number(tip.model_place_prob_pct || 30);
  const edge = Math.max(-12, Math.min(25, Number(tip.edge_pct || 0)));
  const rs = tip.reason_stats || {};
  const formBonus = rs.weak_field_edge ? 6.0 : 0.0;
  const newsBonus = rs.news_sentiment === 'positive' ? 3.5 : 0.0;
  if (riskLevel === 'low') return plcP * 1.25 + winP * 1.05 + rating * 0.5 + formBonus + newsBonus - Math.max(0, winO - 3.3) * 6.0;
  if (riskLevel === 'high') return edge * 0.7 + Math.min(winO, 10.5) * 1.8 + rating * 0.7 + plcP * 0.45 + formBonus + newsBonus - Math.max(0, 3.25 - winO) * 8.0;
  if (riskLevel === 'longshot') return edge * 0.65 + Math.min(winO, 18.0) * 1.6 + plcP * 0.75 + formBonus + newsBonus - Math.max(0, 5.5 - winO) * 10.0;
  return rating * 0.85 + winP * 0.9 + plcP * 0.65 + edge * 0.55 + formBonus + newsBonus - Math.max(0, winO - 5.2) * 3.5;
}

function filterRacesClient(
  races = [],
  { region = '', day = '', dateFrom = '', dateTo = '', raceType = '', search = '', includePast = false, fallbackToMatched = false } = {}
) {
  const { todayIso, tomorrowIso, dayPlus2Iso } = ukNowInfo();
  let list = [...races];
  const reg = String(region || '').trim().toUpperCase();
  const d = String(day || '').trim().toLowerCase();
  let dFrom = cleanIsoDateClient(dateFrom);
  let dTo = cleanIsoDateClient(dateTo);
  if (dFrom && dTo && dFrom > dTo) {
    [dFrom, dTo] = [dTo, dFrom];
  }
  const explicitDate = cleanIsoDateClient(d);
  const rt = String(raceType || '').trim().toLowerCase();
  const q = String(search || '').trim().toLowerCase();

  let matched = null;
  if (dFrom || dTo) {
    matched = list.filter((r) => {
      const rd = String(r.race_date || '').slice(0, 10);
      return (!dFrom || rd >= dFrom) && (!dTo || rd <= dTo);
    });
  } else if (d === 'today') {
    matched = list.filter((r) => r.race_date === todayIso);
  } else if (d === 'tomorrow') {
    matched = list.filter((r) => r.race_date === tomorrowIso);
  } else if (d === 'next_2' || d === '2d') {
    matched = list.filter((r) => r.race_date >= todayIso && r.race_date <= tomorrowIso);
  } else if (d === 'next_3' || d === '3d') {
    matched = list.filter((r) => r.race_date >= todayIso && r.race_date <= dayPlus2Iso);
  } else if (explicitDate) {
    matched = list.filter((r) => r.race_date === explicitDate);
  }

  if (matched !== null) {
    if (includePast) {
      list = matched;
    } else {
      const up = matched.filter((r) => isRaceUpcomingClient(r));
      list = up.length ? up : fallbackToMatched ? matched : [];
    }
  } else if (!includePast) {
    const up = list.filter((r) => isRaceUpcomingClient(r));
    if (up.length) list = up;
  }

  if (reg && reg !== 'ALL') {
    if (reg === 'UK_IRE' || reg === 'GB_IRE') {
      list = list.filter((r) => r.region_code === 'GB' || r.region_code === 'IRE');
    } else {
      list = list.filter((r) => r.region_code === reg);
    }
  }

  if (rt && rt !== 'all') {
    if (rt === 'jumps') {
      list = list.filter((r) => ['hurdle', 'chase', 'jumps', 'nh flat'].includes(String(r.race_type || '').toLowerCase()));
    } else {
      list = list.filter((r) => String(r.race_type || '').toLowerCase() === rt);
    }
  }

  if (q) {
    list = list.filter((r) => {
      const hay = `${r.course} ${r.race_name} ${r.country_name}`.toLowerCase();
      if (hay.includes(q)) return true;
      return (r.runners || []).some((rn) =>
        `${rn.horse_name} ${rn.jockey} ${rn.trainer}`.toLowerCase().includes(q)
      );
    });
  }
  return list;
}

function buildRacingSuggestionsClient(tipsPool = [], { day = 'all', dateFrom = '', dateTo = '' } = {}) {
  const allTips = [...(tipsPool || [])];
  const dayNorm = String(day || '').trim().toLowerCase();
  const hasCustom = Boolean(cleanIsoDateClient(dateFrom) || cleanIsoDateClient(dateTo));
  const isDefaultToday = !hasCustom && ['', 'all', 'today'].includes(dayNorm);
  const napTitle = isDefaultToday ? "Today's NAP Single" : 'NAP Win Single';
  const l15Base = isDefaultToday ? 'Daily Lucky 15' : 'Lucky 15';

  const winPool = allTips.filter((t) => t.market === 'R_WIN');
  const ewPool = allTips.filter((t) => t.market === 'R_EW');
  const plcPool = allTips.filter((t) => t.market === 'R_PLC');
  const runnerUsage = new Map();

  const pickDiversified = (pool, count, minOdds = 1.15, maxOdds = 30.0, fallbackPool = []) => {
    const seenRaces = new Set();
    const seenRunners = new Set();
    const out = [];

    const within = (t) => {
      const o = Number(t.win_odds || t.odds || 0);
      return o >= minOdds && o <= maxOdds;
    };

    let candidates = pool.filter(within);
    if (new Set(candidates.map((c) => Number(c.race_id))).size < count && fallbackPool.length) {
      const seenIds = new Set(candidates.map((c) => Number(c.runner_id)));
      for (const extra of fallbackPool) {
        if (!seenIds.has(Number(extra.runner_id)) && within(extra)) {
          candidates.push(extra);
          seenIds.add(Number(extra.runner_id));
        }
      }
    }
    if (new Set(candidates.map((c) => Number(c.race_id))).size < count) {
      const existing = new Set(candidates.map((c) => `${c.runner_id}:${c.market}`));
      candidates = [...pool];
      for (const ex of fallbackPool) {
        if (!existing.has(`${ex.runner_id}:${ex.market}`)) candidates.push(ex);
      }
    }

    const ranked = candidates
      .map((item, idx) => ({ item, idx }))
      .sort(
        (a, b) =>
          (runnerUsage.get(Number(a.item.runner_id)) || 0) - (runnerUsage.get(Number(b.item.runner_id)) || 0) ||
          a.idx - b.idx
      );

    for (const { item } of ranked) {
      const rId = Number(item.race_id);
      const rnId = Number(item.runner_id);
      if (seenRaces.has(rId) || seenRunners.has(rnId)) continue;
      seenRaces.add(rId);
      seenRunners.add(rnId);
      runnerUsage.set(rnId, (runnerUsage.get(rnId) || 0) + 1);
      out.push(tipToLegClient(item));
      if (out.length >= count) break;
    }
    return out;
  };

  const cards = [];

  const napLegs = pickDiversified(winPool.length ? winPool : allTips, 1, 1.25, 7.0, allTips);
  if (napLegs.length) {
    const ev = evaluateRacingMultipleClient(napLegs, 'single', false, 10.0);
    cards.push({
      id: 'nap_single',
      title: napTitle,
      badge: '🏆 Top Rated Win',
      subtitle: `${napLegs[0].off_time} ${napLegs[0].course} • Best rating & edge on card`,
      structure: 'single',
      each_way: false,
      unit_stake: 10.0,
      legs: napLegs,
      eval: ev,
      bet_reasons: buildRacingBetReasonsClient(napTitle, napLegs, ev, false),
      bet365_export: buildRacingBet365ExportClient(napLegs, 'single', false, 10.0, napTitle),
    });
  }

  const ewDoubleLegs = pickDiversified(ewPool.length >= 2 ? ewPool : winPool, 2, 4.0, 14.0, winPool);
  if (ewDoubleLegs.length >= 2) {
    const isEw = ewDoubleLegs.every((l) => Boolean(l.ew_eligible));
    const ev = evaluateRacingMultipleClient(ewDoubleLegs, 'double', isEw, 5.0);
    cards.push({
      id: 'ew_double',
      title: 'Each-Way Value Double',
      badge: isEw ? '⚖️ Each-Way Double' : '🏆 Win Double',
      subtitle: '2 value runners at generous odds with strong place equity',
      structure: 'double',
      each_way: isEw,
      unit_stake: 5.0,
      legs: ewDoubleLegs,
      eval: ev,
      bet_reasons: buildRacingBetReasonsClient('Each-Way Value Double', ewDoubleLegs, ev, isEw),
      bet365_export: buildRacingBet365ExportClient(ewDoubleLegs, 'double', isEw, 5.0, 'Each-Way Value Double'),
    });
  }

  const treblePool = plcPool.length >= 3 ? plcPool : winPool;
  const trebleLegs = pickDiversified(treblePool, 3, 1.4, 6.0, winPool);
  if (trebleLegs.length >= 3) {
    const ev = evaluateRacingMultipleClient(trebleLegs, 'treble', false, 5.0);
    cards.push({
      id: 'win_place_treble',
      title: 'Win / Place Treble',
      badge: '🎯 High-Hit Treble',
      subtitle: '3 distinct races anchored by strong Top-3 finishers',
      structure: 'treble',
      each_way: false,
      unit_stake: 5.0,
      legs: trebleLegs,
      eval: ev,
      bet_reasons: buildRacingBetReasonsClient('Win / Place Treble', trebleLegs, ev, false),
      bet365_export: buildRacingBet365ExportClient(trebleLegs, 'treble', false, 5.0, 'Win / Place Treble'),
    });
  }

  const l15BasePool = [...winPool, ...ewPool].sort(
    (a, b) => Number(b.model_rating || 0) - Number(a.model_rating || 0) || Number(b.model_win_prob_pct || 0) - Number(a.model_win_prob_pct || 0)
  );
  const l15Legs = pickDiversified(l15BasePool, 4, 2.0, 9.5, allTips);
  if (l15Legs.length >= 4) {
    const avgOdds = l15Legs.reduce((acc, l) => acc + Number(l.win_odds || 2), 0) / 4.0;
    const ewL15 = avgOdds >= 3.8 && l15Legs.every((l) => Boolean(l.ew_eligible));
    const l15Title = `${l15Base}${ewL15 ? ' (E/W)' : ' (Win)'}`;
    const ev = evaluateRacingMultipleClient(l15Legs, 'lucky15', ewL15, 1.0);
    cards.push({
      id: 'daily_lucky15',
      title: l15Title,
      badge: ewL15 ? '🍀 Lucky 15 (30 Bets)' : '🍀 Lucky 15 (15 Bets)',
      subtitle: '4 Singles, 6 Doubles, 4 Trebles & 4-Fold Acca across 4 races',
      structure: 'lucky15',
      each_way: ewL15,
      unit_stake: 1.0,
      legs: l15Legs,
      eval: ev,
      bet_reasons: buildRacingBetReasonsClient(l15Base, l15Legs, ev, ewL15),
      bet365_export: buildRacingBet365ExportClient(l15Legs, 'lucky15', ewL15, 1.0, l15Base),
    });
  }

  return {
    cards,
    structures: RACING_MULTIPLES_CLIENT,
    total_pool_tips: allTips.length,
  };
}

async function loadRacingSnapshot(forceReload = false) {
  if (_racingSnapshot && !forceReload) return _racingSnapshot;
  const suffix = forceReload ? `?t=${Date.now()}` : '';
  const res = await fetch(`./static/racing_snapshot.json${suffix}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Unable to load racing snapshot (HTTP ${res.status})`);
  _racingSnapshot = await res.json();
  return _racingSnapshot;
}

function escapeRegExpClient(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const RACE_CONTEXT_RE = /\b(trainer|winners?|champion|yard|stable|horse|racing|jumps?|flat)\b/i;
const TRACK_CONTEXT_RE = /\b(going|ground|heavy|soft|good|firm|abandon\w*|cancel\w*|inspection|waterlog\w*|frost|drought|course|meeting|festival|cup|stakes)\b/i;
const NEWS_CAUTION_RE = /\b(injur\w*|setback|doubt\w*|lame|colic|withdraw\w*|pulled up|struggl\w*|ban\w*|suspend\w*|miss\w*|sore|wind op)\b/i;
const NEWS_TRACK_ALERT_RE = /\b(drought|heavy|waterlog\w*|inspection|testing|abandon\w*|cancel\w*|frost)\b/i;
const NEWS_POSITIVE_RE = /\b(wins?|winner|record|champion|flying|healthy|fit|thriving|impressive|unbeaten|star|targets?|ready|peak|confident|success|prolific)\b/i;

function classifyRacingNewsClient(runner, newsList = []) {
  if (!Array.isArray(newsList) || !newsList.length || !runner) return null;
  const horse = String(runner.horse_name || '').trim();
  const trainer = String(runner.trainer || '').trim();
  const course = String(runner.course || '').trim();

  let matched = null;
  let matchType = '';

  if (horse.length >= 5) {
    const pat = new RegExp(`\\b${escapeRegExpClient(horse)}\\b`, 'i');
    for (const nw of newsList) {
      const hay = `${nw.title || ''} ${nw.summary || ''}`;
      if (pat.test(hay)) {
        matched = nw;
        matchType = 'horse';
        break;
      }
    }
  }
  if (!matched && trainer) {
    const patFull = trainer.length >= 5 ? new RegExp(`\\b${escapeRegExpClient(trainer)}\\b`, 'i') : null;
    const toks = trainer.split(/[\s-]+/).filter((t) => t.length >= 6);
    const surname = toks.length ? toks[toks.length - 1] : '';
    const patSur = surname ? new RegExp(`\\b${escapeRegExpClient(surname)}\\b`, 'i') : null;
    for (const nw of newsList) {
      const hay = `${nw.title || ''} ${nw.summary || ''}`;
      if (patFull && patFull.test(hay)) {
        matched = nw;
        matchType = 'trainer';
        break;
      }
      if (patSur && patSur.test(hay) && RACE_CONTEXT_RE.test(hay)) {
        matched = nw;
        matchType = 'trainer';
        break;
      }
    }
  }
  if (!matched && course.length >= 4) {
    const patCr = new RegExp(`\\b${escapeRegExpClient(course)}\\b`, 'i');
    for (const nw of newsList) {
      const hay = `${nw.title || ''} ${nw.summary || ''}`;
      if (patCr.test(hay) && TRACK_CONTEXT_RE.test(hay)) {
        matched = nw;
        matchType = 'course';
        break;
      }
    }
  }
  if (!matched) return null;

  const hay = `${matched.title || ''} ${matched.summary || ''}`;
  let sentiment = 'neutral';
  if (NEWS_CAUTION_RE.test(hay)) sentiment = 'caution';
  else if (matchType === 'course' && NEWS_TRACK_ALERT_RE.test(hay)) sentiment = 'track_alert';
  else if (NEWS_POSITIVE_RE.test(hay)) sentiment = 'positive';

  return {
    source: matched.source || 'Racing Feed',
    title: matched.title || '',
    match_type: matchType,
    sentiment,
  };
}

function scoreFormTokenClient(tok) {
  const t = String(tok || '').toUpperCase();
  if (t === '1') return 1.0;
  if (t === '2') return 0.65;
  if (t === '3') return 0.42;
  if (t === '4') return 0.22;
  if (t === '5') return 0.08;
  if (['6', '7', '8', '9'].includes(t)) return -0.12;
  if (t === '0') return -0.3;
  return -0.35;
}

function parseFormClient(dispForm, isDebutant) {
  const disp = String(dispForm || '').trim();
  const figs = disp && disp !== 'Debutant' && disp !== 'Unexposed'
    ? disp.split('-').map((x) => x.trim().toUpperCase()).filter(Boolean)
    : [];
  if (!figs.length) {
    return { figs: [], disp: '', formScore: isDebutant ? 0.05 : 0.05, recentWins: 0, recentPlaces: 0 };
  }
  const win = figs.slice(0, 6);
  let weighted = 0;
  let wSum = 0;
  let wins = 0;
  let places = 0;
  win.forEach((f, idx) => {
    const w = 0.72 ** idx;
    weighted += w * scoreFormTokenClient(f);
    wSum += w;
    if (f === '1') { wins += 1; places += 1; }
    else if (f === '2' || f === '3') places += 1;
  });
  return {
    figs: win,
    disp: win.join('-'),
    formScore: weighted / Math.max(1e-6, wSum),
    recentWins: wins,
    recentPlaces: places,
  };
}

function buildConnStatsClient(rawRaces = []) {
  const trAcc = new Map();
  const jkAcc = new Map();
  const bump = (map, nm, rn) => {
    const key = String(nm || '').trim();
    if (!key) return;
    const rawRuns = Number(rn.career_runs || 0);
    const ebRuns = Math.max(1, rawRuns);
    const wins = Number(rn.career_wins || 0);
    const plcs = Number(rn.career_places || 0);
    const cur = map.get(key) || { ebRuns: 0, rawRuns: 0, wins: 0, places: 0 };
    cur.ebRuns += ebRuns;
    cur.rawRuns += rawRuns;
    cur.wins += wins;
    cur.places += plcs;
    map.set(key, cur);
  };
  for (const rc of rawRaces) {
    for (const rn of rc.runners || []) {
      bump(trAcc, rn.trainer, rn);
      bump(jkAcc, rn.jockey, rn);
    }
  }
  const finalize = (map) => {
    const meta = {};
    const scores = {};
    let tot = 0;
    let cnt = 0;
    for (const [nm, st] of map.entries()) {
      const sc = (st.wins + 1.5 * 0.14 + 0.35 * (st.places + 0.35)) / (st.ebRuns + 12.0);
      scores[nm] = sc;
      tot += sc;
      cnt += 1;
      meta[nm] = {
        runs: Math.round(st.rawRuns),
        wins: Math.round(st.wins),
        places: Math.round(st.places),
        win_pct: st.rawRuns > 0 ? roundC((100.0 * st.wins) / st.rawRuns, 1) : 0.0,
        place_pct: st.rawRuns > 0 ? roundC((100.0 * st.places) / st.rawRuns, 1) : 0.0,
      };
    }
    const avg = cnt > 0 ? tot / cnt : 0;
    for (const nm of Object.keys(scores)) scores[nm] -= avg;
    return { scores, meta };
  };
  const tr = finalize(trAcc);
  const jk = finalize(jkAcc);
  return { trainerScores: tr.scores, jockeyScores: jk.scores, trainerMeta: tr.meta, jockeyMeta: jk.meta };
}

function describeRecentFormClient(horseName, dispForm, runs, wins, plcs, isDebutant, fieldCtx = {}) {
  const n = Number(fieldCtx.n || 1);
  const formRank = Number(fieldCtx.formRank || 1);
  const rivalsWeak = Number(fieldCtx.rivalsWeakCount || 0);
  const rivalsLtoWin = Number(fieldCtx.rivalsLtoWinners || 0);
  const weakFieldEdge = Boolean(fieldCtx.weakFieldEdge);
  const formLeader = String(fieldCtx.formLeaderName || 'the form leader');
  const modelRank = Number(fieldCtx.modelRank || 1);
  const trainer = String(fieldCtx.trainer || 'the yard');
  const refOddsTxt = String(fieldCtx.refOddsTxt || '');
  const orVal = fieldCtx.officialRating;

  const parsed = parseFormClient(dispForm, isDebutant);
  const figs = parsed.figs;
  const disp = parsed.disp;
  if (isDebutant || (!figs.length && runs === 0)) {
    const expRivals = Number(fieldCtx.experiencedRivals ?? Math.max(0, n - 1));
    const oddsNote = refOddsTxt && refOddsTxt !== '—' ? ` and ${refOddsTxt} market support` : '';
    return `Unraced debutant with no public form yet against ${expRivals} experienced rival(s) — why it matters: ${horseName}'s chance relies on ${trainer}'s debut readiness${oddsNote} rather than proven racecourse figures.`;
  }
  const last = figs[0] || '';
  let lead = 'Finished outside the frame last time out';
  if (last === '1') lead = 'Won last time out';
  else if (last === '2') lead = 'Finished 2nd last time out';
  else if (last === '3') lead = 'Placed 3rd last time out';
  else if (last === '4') lead = 'Finished 4th last time out';
  else if (['F', 'U', 'P', 'R', 'B'].includes(last)) lead = 'Failed to complete last time out';

  const seqTxt = disp ? ` (recent figures: ${disp})` : '';
  const careerTxt = runs > 0 ? ` • ${wins} win${wins !== 1 ? 's' : ''} & ${plcs} place${plcs !== 1 ? 's' : ''} in ${runs} career starts` : '';
  const fieldTxt = n > 1 ? ` • Ranks #${formRank} of ${n} on form (${rivalsWeak} of ${Math.max(1, n - 1)} rivals are out of form)` : '';

  let why = `${horseName} holds #${formRank} recent form rank of ${n} (${disp || 'steady'}) with ${rivalsLtoWin} rival recent winner(s) in opposition.`;
  if (weakFieldEdge && n > 1) {
    why = `${horseName} brings proven form (#${formRank} in field) into a race where ${rivalsWeak} of ${n - 1} rivals have struggled for recent finishes, giving it a clear fitness and consistency edge.`;
  } else if (parsed.formScore >= 0.30) {
    why = `${horseName} ranks #${formRank} of ${n} on recent form (${parsed.recentPlaces} top-3 finishes in last ${figs.length}) against ${rivalsLtoWin} last-time-out winner(s), showing reliable current wellbeing.`;
  } else if (modelRank <= 3 && parsed.formScore < 0.20 && n > 1) {
    const hint = orVal ? `OR ${orVal}` : `${refOddsTxt} market strength`;
    why = `although ${horseName}'s recent figures (${disp || 'mixed'}) are patchy, ${rivalsWeak} of ${n - 1} rivals also lack solid form and ${horseName}'s #${modelRank} model rating (${hint}) gives scope to bounce back.`;
  } else if (formLeader !== horseName && n > 1) {
    why = `${horseName} trails #1-form contender ${formLeader} on recent figures (${disp || 'unexposed'}), so it needs improvement on recent runs to overturn the form principals.`;
  }
  return `${lead}${seqTxt}${careerTxt}${fieldTxt} — why it matters: ${why}`;
}

function buildRunnerReasonsClient(rn, newsList = [], fieldCtx = {}) {
  const horse = String(rn.horse_name || 'Runner');
  const rating = Number(rn.model_rating || 50);
  const orVal = rn.official_rating;
  const wDisp = rn.weight_display || '';
  const dispForm = rn.display_form || (rn.is_debutant ? 'Debutant' : 'Unexposed');
  const runs = Number(rn.career_runs || 0);
  const wins = Number(rn.career_wins || 0);
  const plcs = Number(rn.career_places || 0);
  const n = Number(fieldCtx.n || rn.runners_count || 1);
  const modelRank = Number(fieldCtx.modelRank || 1);
  const connRank = Number(fieldCtx.connRank || 1);
  const orDiff = fieldCtx.orDiff ?? null;
  const wtDiff = fieldCtx.weightDiffLbs ?? null;
  const rivalName = String(fieldCtx.rivalName || 'the main rival');
  const rivalWinPct = Number(fieldCtx.rivalWinPct || 0);
  const tr = rn.trainer || 'Yard';
  const jk = rn.jockey || 'Jockey TBA';
  const winO = Number(rn.win_odds || rn.odds || 4.0);
  const refOddsTxt = fmtOddsLocal(winO);

  const b1 = `Recent Form: ${describeRecentFormClient(horse, dispForm, runs, wins, plcs, Boolean(rn.is_debutant), {
    ...fieldCtx,
    n,
    trainer: tr,
    refOddsTxt,
    officialRating: orVal,
  })}`;

  const dist = rn.distance_text || 'distance';
  const going = rn.going || rn.surface || 'prevailing ground';
  const setupParts = [`${rn.course || 'Track'} ${dist} (${rn.race_type || 'Flat'}) on ${going}`];
  if (orVal) {
    const orDiffTxt = orDiff !== null && orDiff !== 0 ? ` (${orDiff > 0 ? '+' : ''}${orDiff} vs median)` : '';
    setupParts.push(`Official Rating ${orVal}${orDiffTxt}`);
  }
  if (wDisp) {
    const wtDiffTxt = wtDiff !== null && wtDiff !== 0 ? ` (${wtDiff > 0 ? '+' : ''}${wtDiff}lb vs median)` : '';
    setupParts.push(`carrying ${wDisp}${wtDiffTxt}`);
  }
  if (rn.draw) setupParts.push(`Stall ${rn.draw}`);
  if (rn.headgear) setupParts.push(`gear: ${rn.headgear}`);
  if (rn.days_since_run !== undefined && rn.days_since_run !== null) setupParts.push(`${rn.days_since_run}d since last run`);
  const ewClause = rn.ew_eligible
    ? `Each-Way safety net pays ${rn.places_paid || 3} of ${n} places (${rn.place_terms_label || ''}).`
    : `Win-only terms apply (${n} runners).`;

  const setupWhys = [];
  if (orDiff !== null && orDiff >= 3) setupWhys.push(`${horse} sits ${orDiff}lb clear of the median official rating`);
  else if (orDiff !== null && orDiff <= -4) setupWhys.push(`${horse} sits ${Math.abs(orDiff)}lb below median rating and relies on handicap weight relief`);
  else if (wtDiff !== null && wtDiff <= -3) setupWhys.push(`${horse} receives ${Math.abs(wtDiff)}lb in weight from the median rival`);
  else if (wtDiff !== null && wtDiff >= 4) setupWhys.push(`${horse} concedes ${wtDiff}lb to the field average due to class`);

  const dsr = rn.days_since_run;
  if (dsr !== undefined && dsr !== null) {
    if (dsr >= 10 && dsr <= 45) setupWhys.push(`arrives race-fit off a tidy ${dsr}-day turnaround`);
    else if (dsr > 180) setupWhys.push(`faces a fitness test returning from a ${dsr}-day break`);
    else if (dsr < 10) setupWhys.push(`turns out quickly just ${dsr} days after running`);
  }
  if (rn.draw && String(rn.race_type || 'Flat') === 'Flat' && n >= 10) {
    if (Number(rn.draw) <= Math.max(3, Math.floor(n / 4))) setupWhys.push(`draws well inside from Stall ${rn.draw} of ${n}`);
    else if (Number(rn.draw) >= n - Math.max(2, Math.floor(n / 4))) setupWhys.push(`has work to do from a wide Stall ${rn.draw} of ${n}`);
  }
  if (!setupWhys.length) setupWhys.push(`${horse} is matched fairly to the ${dist} ${going} conditions`);
  const pWin = Number(rn.model_win_prob || 0.1);
  const pPlc = Number(rn.model_place_prob || 0.3);
  const plcCushion = rn.ew_eligible
    ? `with ${rn.places_paid || 3} places paid (${Math.round(pPlc * 100)}% top-${rn.places_paid || 3} chance for ${horse})`
    : 'in a win-only race leaving zero cushion for 2nd';
  const b2 = `Today's Race Setup: ${setupParts.join(', ')}. ${ewClause} — why it matters: ${setupWhys.join(', ')}, ${plcCushion}.`;

  const fairWin = Number(rn.fair_win_odds || (1.0 / Math.max(0.005, pWin)));
  const fairPlc = Number(rn.fair_place_odds || (1.0 / Math.max(0.01, pPlc)));
  const mktImpPct = 100.0 / Math.max(1.02, winO);
  const srcLbl = ['live_fixed', 'pmu_tote', 'user_manual'].includes(rn.odds_source) ? 'live market' : 'model tissue';
  const winEdge = Number(rn.win_edge_pct || 0);
  const ewEdge = Number(rn.ew_edge_pct || 0);
  let valWhy = `${horse} sits ranked #${modelRank} of ${n} close to fair odds (${fmtOddsLocal(fairWin)}), so the bet leans on race-day conditions rather than a mispriced line.`;
  if (winEdge >= 5.0) {
    valWhy = `${horse}'s ${refOddsTxt} price implies only a ${mktImpPct.toFixed(1)}% chance vs our ${(pWin * 100).toFixed(1)}% model estimate, giving +${winEdge.toFixed(1)}% positive win value.`;
  } else if (rn.ew_eligible && ewEdge >= 3.0) {
    const plcO = 1.0 + (winO - 1.0) * Number(rn.place_fraction || 0.2);
    valWhy = `with a ${(pPlc * 100).toFixed(1)}% top-${rn.places_paid || 3} probability at ${fmtOddsLocal(plcO)} place odds, ${horse} gets cushioned each-way return equity (${ewEdge >= 0 ? '+' : ''}${ewEdge.toFixed(1)}% E/W edge).`;
  } else if (modelRank === 1) {
    const leadDiff = pWin * 100.0 - rivalWinPct;
    valWhy = `${horse} heads the ${rn.course || 'race'} field at ${(pWin * 100).toFixed(1)}% (${leadDiff >= 0 ? '+' : ''}${leadDiff.toFixed(1)}% clear of ${rivalName}), making this a reliability pick priced close to fair ${refOddsTxt}.`;
  } else if (winEdge < -5.0) {
    valWhy = `${refOddsTxt} implies ${mktImpPct.toFixed(1)}% against our ${(pWin * 100).toFixed(1)}% estimate (fair ${fmtOddsLocal(fairWin)}), so ${horse} trails #1-rated ${rivalName} on pure price value.`;
  }
  const b3 = `Price & Value: Ranked #${modelRank} of ${n} (${rating.toFixed(0)}/100) with ${(pWin * 100).toFixed(1)}% Win chance (fair ${fmtOddsLocal(fairWin)}) and ${(pPlc * 100).toFixed(1)}% top-${rn.places_paid || 3} finish (fair ${fmtOddsLocal(fairPlc)}) vs ${refOddsTxt} ${srcLbl} (${winEdge >= 0 ? '+' : ''}${winEdge.toFixed(1)}% edge) — why it matters: ${valWhy}`;

  const trMeta = fieldCtx.trainerMeta?.[tr] || {};
  const jkMeta = fieldCtx.jockeyMeta?.[jk] || {};
  const connSnips = [];
  if (Number(trMeta.runs || 0) >= 3) connSnips.push(`yard record ${trMeta.wins}W/${trMeta.places}P from ${trMeta.runs} starts (${Math.round(trMeta.place_pct)}% place rate)`);
  if (Number(jkMeta.runs || 0) >= 3) connSnips.push(`rider ${Math.round(jkMeta.win_pct)}% win / ${Math.round(jkMeta.place_pct)}% place strike rate`);
  const connFact = connSnips.length ? ` (${connSnips.join('; ')})` : '';
  let connWhy = `${jk} takes the ride for ${tr} (#${connRank} of ${n} connections here), offering steady tactical support for ${horse}'s ${Math.round(pPlc * 100)}% frame chance.`;
  if (connRank <= Math.max(2, Math.floor(n / 4))) {
    connWhy = `${tr} & ${jk} rank #${connRank} of ${n} on yard/rider strike rate in this ${rn.course || ''} field, reinforcing ${horse}'s ${Math.round(pWin * 100)}% win profile.`;
  } else if (connRank >= Math.max(4, n - Math.max(1, Math.floor(n / 4)))) {
    connWhy = `the ${tr}/${jk} partnership sits #${connRank} of ${n} in this race on strike rate, putting greater emphasis on ${horse}'s own form and handicap mark.`;
  }
  const b4 = `Stable & Jockey: ${jk} rides for ${tr} in this ${n}-runner ${rn.race_type || 'Flat'}${connFact} — why it matters: ${connWhy}`;

  const matchedNews = classifyRacingNewsClient(rn, newsList);
  let b5 = '';
  if (matchedNews) {
    const mType = matchedNews.match_type || 'course';
    const targetLbl = mType === 'horse' ? horse : mType === 'trainer' ? tr : (rn.course || 'track');
    let newsWhy = `places ${targetLbl} in active racing focus ahead of the ${rn.off_time || ''} ${rn.course || ''}.`;
    if (matchedNews.sentiment === 'positive') newsWhy = `upbeat form and yard news around ${targetLbl} supports ${horse}'s readiness in the ${rn.off_time || ''} ${rn.course || ''}.`;
    else if (matchedNews.sentiment === 'caution') newsWhy = `flagged fitness or setback caution around ${targetLbl} adds risk to ${horse}'s chances and kept it out of headline tips.`;
    else if (matchedNews.sentiment === 'track_alert') newsWhy = `live ${rn.course || ''} ground/meeting conditions directly impact stamina over ${dist} on ${going}.`;
    b5 = `Racing News: [${matchedNews.source}] ${matchedNews.title} — why it matters: ${newsWhy}`;
  } else if (rn.reason_stats?.news_headline) {
    b5 = `Racing News: ${rn.reason_stats.news_headline} — why it matters: tracked ahead of ${horse}'s run in the ${rn.off_time || ''} ${rn.course || ''}.`;
  } else {
    const turnNote = dsr !== undefined && dsr !== null ? `${dsr}d turnaround on ${going}` : `${going} setup`;
    b5 = `Racing News: No withdrawals, going alerts, or setbacks flagged for ${horse} or ${tr} ahead of the ${rn.off_time || ''} ${rn.course || ''} — why it matters: ${horse} comes in with a clean bill of health for this #${modelRank}-rated ${turnNote}.`;
  }

  return [b1, b2, b3, b4, b5];
}

function hydrateCompactRunner(rn, rc = null, newsList = [], fieldCtx = {}) {
  const parent = rc
    ? {
        race_id: rc.id,
        race_key: rc.race_key,
        region_code: rc.region_code,
        region_flag: rc.region_flag,
        country_name: rc.country_name,
        course: rc.course,
        race_date: rc.race_date,
        off_time: rc.off_time,
        race_name: rc.race_name,
        race_type: rc.race_type,
        is_handicap: rc.is_handicap,
        distance_text: rc.distance_text || '',
        going: rc.going || '',
        surface: rc.surface || '',
        runners_count: rc.runners_count,
        places_paid: rc.places_paid,
        place_fraction: rc.place_fraction,
        ew_eligible: rc.ew_eligible,
        place_terms_label: rc.place_terms_label,
      }
    : {};
  const m = { ...parent, ...rn };
  const pWin = Math.max(0.004, Math.min(0.95, Number(m.model_win_prob || 0.1)));
  const pPlc = Math.max(pWin, Math.min(0.98, Number(m.model_place_prob || 0.3)));
  const fairWin = roundC(m.fair_win_odds || 1.0 / pWin, 2);
  const fairPlc = roundC(m.fair_place_odds || 1.0 / pPlc, 2);
  const pf = Number(m.place_fraction || 0);
  const ewElig = m.ew_eligible !== undefined ? Boolean(m.ew_eligible) : Number(m.places_paid || 1) >= 2 && pf > 0;
  const winOdds = roundC(Number(m.win_odds || m.odds || fairWin), 2);
  const plcOdds = ewElig ? roundC(Number(m.place_odds || 1.0 + (winOdds - 1.0) * pf), 3) : 1.0;

  const isPlc = String(m.market || '').toUpperCase() === 'R_PLC';
  const isEw = String(m.market || '').toUpperCase() === 'R_EW';
  const winEdge = roundC((pWin * winOdds - 1.0) * 100.0, 2);
  const plcEdge = ewElig ? roundC((pPlc * plcOdds - 1.0) * 100.0, 2) : winEdge;
  const ewEdge = ewElig ? roundC(0.5 * ((pWin * winOdds - 1.0) + (pPlc * plcOdds - 1.0)) * 100.0, 2) : winEdge;

  m.non_runner = Boolean(m.non_runner);
  m.is_debutant = Boolean(m.is_debutant);
  m.ew_eligible = ewElig;
  m.form_string = m.form_string || m.display_form || '';
  m.model_win_prob = pWin;
  m.model_place_prob = pPlc;
  m.model_win_prob_pct = roundC(pWin * 100.0, 1);
  m.model_place_prob_pct = roundC(pPlc * 100.0, 1);
  m.fair_win_odds = fairWin;
  m.fair_win_odds_fractional = fmtOddsLocal(fairWin);
  m.fair_place_odds = fairPlc;
  m.fair_place_odds_fractional = fmtOddsLocal(fairPlc);
  m.win_odds = winOdds;
  m.place_odds = plcOdds;
  m.odds_fractional = isPlc ? (ewElig ? fmtOddsLocal(plcOdds) : '—') : fmtOddsLocal(winOdds);
  m.place_odds_fractional = ewElig ? fmtOddsLocal(plcOdds) : '—';
  m.odds = isPlc ? plcOdds : winOdds;
  m.win_edge_pct = winEdge;
  m.place_edge_pct = plcEdge;
  m.ew_edge_pct = ewEdge;
  m.edge_pct = isPlc ? plcEdge : isEw ? ewEdge : winEdge;
  if (isPlc) m.model_prob = pPlc;
  else if (isEw) m.model_prob = roundC(0.5 * (pWin + pPlc), 5);
  else if (m.model_prob === undefined) m.model_prob = pWin;
  m.model_prob_pct = roundC(Number(m.model_prob || pWin) * 100.0, 1);
  if (m.fair_odds === undefined) m.fair_odds = isPlc ? fairPlc : fairWin;
  if (m.fair_odds_fractional === undefined) m.fair_odds_fractional = fmtOddsLocal(m.fair_odds);
  if (m.min_bet365_odds === undefined) m.min_bet365_odds = isPlc ? fairPlc : fairWin;
  if (m.min_bet365_fractional === undefined) m.min_bet365_fractional = fmtOddsLocal(m.min_bet365_odds);

  if (!Array.isArray(m.reasons) || !m.reasons.length) {
    m.reasons = buildRunnerReasonsClient(m, newsList, fieldCtx);
  }
  if (!m.reason_stats) {
    m.reason_stats = {
      model_rating: m.model_rating,
      model_rank: fieldCtx.modelRank ?? null,
      official_rating: m.official_rating ?? null,
      weight_display: m.weight_display || '',
      display_form: m.display_form || '',
      form_rank: fieldCtx.formRank ?? null,
      rivals_weak_form_count: fieldCtx.rivalsWeakCount ?? 0,
      weak_field_edge: Boolean(fieldCtx.weakFieldEdge),
      conn_rank: fieldCtx.connRank ?? null,
      win_prob_pct: m.model_win_prob_pct,
      place_prob_pct: m.model_place_prob_pct,
      fair_win_odds: fairWin,
      fair_place_odds: fairPlc,
      place_terms_label: m.place_terms_label || '',
      runners_count: m.runners_count,
    };
  }
  return m;
}

function hydrateRaceRunnersClient(rc, newsList = [], connStats = {}, customOdds = {}) {
  const rawRunners = rc.runners || [];
  const n = rawRunners.length;
  if (!n) return [];

  const parsedForms = rawRunners.map((rn) => parseFormClient(rn.display_form || rn.form_string || '', Boolean(rn.is_debutant)));
  const formScores = parsedForms.map((pf) => pf.formScore);
  const expTotal = rawRunners.filter((rn) => !rn.is_debutant && Number(rn.career_runs || 0) > 0).length;

  const orNums = rawRunners.map((rn) => Number(rn.official_rating)).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const medOr = orNums.length >= Math.max(2, Math.ceil(n * 0.5)) ? orNums[Math.floor(orNums.length / 2)] : null;
  const wtNums = rawRunners.map((rn) => Number(rn.weight_lbs)).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const medWt = wtNums.length ? wtNums[Math.floor(wtNums.length / 2)] : null;

  const modelOrder = rawRunners.map((_, i) => i).sort(
    (a, b) => Number(rawRunners[b].model_win_prob || 0) - Number(rawRunners[a].model_win_prob || 0) ||
              Number(rawRunners[b].model_rating || 0) - Number(rawRunners[a].model_rating || 0)
  );
  const modelRankMap = {};
  modelOrder.forEach((idx, pos) => { modelRankMap[idx] = pos + 1; });
  const formOrder = rawRunners.map((_, i) => i).sort((a, b) => formScores[b] - formScores[a]);
  const formRankMap = {};
  formOrder.forEach((idx, pos) => { formRankMap[idx] = pos + 1; });

  const connScores = rawRunners.map((rn) => {
    const tr = connStats.trainerScores?.[String(rn.trainer || '').trim()] || 0;
    const jk = connStats.jockeyScores?.[String(rn.jockey || '').trim()] || 0;
    return 0.55 * tr + 0.45 * jk - (rn.is_debutant ? 0.04 : 0);
  });
  const connOrder = rawRunners.map((_, i) => i).sort((a, b) => connScores[b] - connScores[a]);
  const connRankMap = {};
  connOrder.forEach((idx, pos) => { connRankMap[idx] = pos + 1; });

  const leaderIdx = modelOrder[0];
  const runnerUpIdx = n > 1 ? modelOrder[1] : modelOrder[0];
  const formLeaderName = String(rawRunners[formOrder[0]]?.horse_name || '');

  return rawRunners.map((rn, i) => {
    const rivalsForms = formScores.filter((_, j) => j !== i);
    const fieldFormAvg = rivalsForms.length ? rivalsForms.reduce((a, b) => a + b, 0) / rivalsForms.length : 0;
    const rivalsWeakCount = rivalsForms.filter((v) => v < 0.05).length;
    const rivalsLtoWinners = parsedForms.filter((pf, j) => j !== i && pf.figs[0] === '1').length;
    const weakFieldEdge = n >= 4 && formScores[i] >= 0.32 && (fieldFormAvg <= 0.06 || rivalsWeakCount >= Math.ceil(0.6 * (n - 1)));
    const rivalIdx = modelRankMap[i] === 1 ? runnerUpIdx : leaderIdx;
    const fieldCtx = {
      n,
      modelRank: modelRankMap[i],
      formRank: formRankMap[i],
      connRank: connRankMap[i],
      rivalsWeakCount,
      rivalsLtoWinners,
      weakFieldEdge,
      experiencedRivals: Math.max(0, expTotal - (rn.is_debutant ? 0 : 1)),
      formLeaderName,
      rivalName: String(rawRunners[rivalIdx]?.horse_name || 'the main rival'),
      rivalWinPct: roundC(Number(rawRunners[rivalIdx]?.model_win_prob || 0) * 100.0, 1),
      orDiff: medOr !== null && rn.official_rating ? Math.round(Number(rn.official_rating) - medOr) : null,
      weightDiffLbs: medWt !== null && rn.weight_lbs ? Math.round(Number(rn.weight_lbs) - medWt) : null,
      trainerMeta: connStats.trainerMeta || {},
      jockeyMeta: connStats.jockeyMeta || {},
    };
    return applyCustomOddsToRunner(hydrateCompactRunner(rn, rc, newsList, fieldCtx), customOdds);
  });
}

export async function racingStaticApi(path, opts = {}) {
  const [pathname, queryStr = ''] = path.split('?');
  const query = new URLSearchParams(queryStr);
  const method = String(opts.method || 'GET').toUpperCase();
  const body = opts.body ? (typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body) : {};
  const snap = await loadRacingSnapshot(false);
  const customOdds = getStorageSafe(RACING_CUSTOM_ODDS_KEY, {});
  const newsList = snap.news || snap.overview?.news || [];
  const connStats = buildConnStatsClient(snap.races || []);

  const allRaces = (snap.races || []).map((rc) => {
    const runners = hydrateRaceRunnersClient(rc, newsList, connStats, customOdds);
    const sorted = [...runners].sort((a, b) => b.model_rating - a.model_rating || a.saddle_cloth - b.saddle_cloth);
    const top = sorted[0];
    return {
      ...rc,
      is_upcoming: isRaceUpcomingClient(rc),
      runners: sorted,
      top_pick: top
        ? {
            runner_id: top.runner_id,
            horse_name: top.horse_name,
            model_rating: top.model_rating,
            model_win_prob_pct: top.model_win_prob_pct,
            odds: top.win_odds,
            odds_fractional: fmtOddsLocal(top.win_odds),
            win_edge_pct: top.win_edge_pct,
          }
        : rc.top_pick,
    };
  });

  const allTips = (snap.tips || []).map((t) => applyCustomOddsToRunner(hydrateCompactRunner(t, null, newsList), customOdds));
  const upcomingRacesAll = allRaces.filter((r) => isRaceUpcomingClient(r));
  const availableDates = [
    ...new Set((upcomingRacesAll.length ? upcomingRacesAll : allRaces).map((r) => r.race_date).filter(Boolean)),
  ].sort();

  if (pathname === '/api/racing/overview') {
    const active = upcomingRacesAll.length ? upcomingRacesAll : allRaces;
    const byRegion = {};
    const meetings = new Set();
    let liveCount = 0;
    for (const rc of active) {
      byRegion[rc.region_code] = (byRegion[rc.region_code] || 0) + 1;
      meetings.add(`${rc.race_date}|${rc.course}`);
      if ((rc.runners || []).some((r) => ['live_fixed', 'pmu_tote', 'user_manual'].includes(r.odds_source))) {
        liveCount += 1;
      }
    }
    return {
      ...(snap.overview || {}),
      counts: {
        ...(snap.overview?.counts || {}),
        races_total: allRaces.length,
        upcoming_races: upcomingRacesAll.length,
        active_races: active.length,
        meetings_count: meetings.size,
        live_odds_races: liveCount,
      },
      by_region: byRegion,
      available_dates: availableDates,
      news: snap.news || snap.overview?.news || [],
      generated_at: snap.generated_at,
    };
  }

  if (pathname === '/api/racing/cards') {
    const filteredRaces = filterRacesClient(allRaces, {
      region: query.get('region') || '',
      day: query.get('day') || '',
      dateFrom: query.get('date_from') || '',
      dateTo: query.get('date_to') || '',
      raceType: query.get('race_type') || '',
      search: query.get('search') || '',
      includePast: query.get('include_past') === '1',
      fallbackToMatched: true,
    });
    const mMap = new Map();
    for (const rc of filteredRaces) {
      const k = `${rc.race_date}|${rc.course}|${rc.region_code}`;
      if (!mMap.has(k)) {
        mMap.set(k, {
          race_date: rc.race_date,
          course: rc.course,
          region_code: rc.region_code,
          region_flag: rc.region_flag,
          country_name: rc.country_name,
          going: rc.going,
          surface: rc.surface,
          race_count: 0,
          races: [],
        });
      }
      const m = mMap.get(k);
      m.race_count += 1;
      m.races.push({
        id: rc.id,
        off_time: rc.off_time,
        race_name: rc.race_name,
        race_type: rc.race_type,
        distance_text: rc.distance_text,
        going: rc.going,
        runners_count: rc.runners_count,
        places_paid: rc.places_paid,
        place_terms_label: rc.place_terms_label,
        status: rc.status,
        is_upcoming: rc.is_upcoming,
        has_live_odds: rc.has_live_odds,
        top_horse: rc.top_pick?.horse_name || '',
        top_odds_fractional: rc.top_pick?.odds_fractional || '',
      });
    }
    return {
      meetings: [...mMap.values()],
      races: filteredRaces,
      total_races: filteredRaces.length,
      regions: snap.overview?.regions || {},
      available_dates: availableDates,
    };
  }

  if (pathname.startsWith('/api/racing/race/')) {
    const rid = Number(pathname.split('/').pop());
    const rc = allRaces.find((r) => Number(r.id) === rid);
    if (!rc) throw new Error('Race not found');
    return { race: rc, runners: rc.runners || [], non_runners: [], news: snap.news || [] };
  }

  if (pathname.startsWith('/api/racing/runner/') && pathname.endsWith('/odds') && method === 'POST') {
    const parts = pathname.split('/');
    const runnerId = Number(parts[parts.length - 2]);
    let found = null;
    for (const rc of allRaces) {
      const hit = (rc.runners || []).find((x) => Number(x.runner_id) === runnerId);
      if (hit) {
        found = hit;
        break;
      }
    }
    if (!found) throw new Error('Runner not found');
    const dec = parseOddsShared(body.odds);
    if (!dec) throw new Error('Enter valid fractional or decimal odds (e.g. 5/1 or 6.00)');
    customOdds[String(runnerId)] = { odds: dec, updated_at: new Date().toISOString() };
    setStorageSafe(RACING_CUSTOM_ODDS_KEY, customOdds);
    return { ok: true, runner: applyCustomOddsToRunner(found, customOdds) };
  }

  if (pathname === '/api/racing/tips') {
    const region = (query.get('region') || '').trim().toUpperCase();
    const betType = (query.get('bet_type') || '').trim().toUpperCase();
    const day = (query.get('day') || '').trim().toLowerCase();
    const dateFrom = (query.get('date_from') || '').trim();
    const dateTo = (query.get('date_to') || '').trim();
    const raceType = (query.get('race_type') || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(400, Number(query.get('limit') || 60)));

    const matchingRaceIds = new Set(
      filterRacesClient(allRaces, {
        region,
        day,
        dateFrom,
        dateTo,
        raceType,
        includePast: false,
        fallbackToMatched: false,
      }).map((r) => Number(r.id))
    );
    let tips = allTips.filter((t) => matchingRaceIds.has(Number(t.race_id)));
    if (betType && betType !== 'ALL') {
      const btNorm = betType === 'WIN' ? 'R_WIN' : betType === 'EW' ? 'R_EW' : betType === 'PLC' ? 'R_PLC' : betType;
      tips = tips.filter((t) => t.market === btNorm);
    }
    return { tips: tips.slice(0, limit), total: tips.length, available_dates: availableDates };
  }

  if (pathname === '/api/racing/evaluate-multiple' && method === 'POST') {
    return evaluateRacingMultipleClient(body.legs || [], body.structure || 'acca', Boolean(body.each_way), Number(body.unit_stake || 1));
  }

  if (pathname === '/api/racing/bet365/export' && method === 'POST') {
    return buildRacingBet365ExportClient(body.legs || [], body.structure || 'acca', Boolean(body.each_way), Number(body.unit_stake || 1), body.title || 'AccaLab Racing Bet');
  }

  if (pathname === '/api/racing/suggest-bet') {
    const region = (query.get('region') || '').trim().toUpperCase();
    const day = (query.get('day') || '').trim().toLowerCase();
    const dateFrom = (query.get('date_from') || '').trim();
    const dateTo = (query.get('date_to') || '').trim();
    const raceType = (query.get('race_type') || '').trim().toLowerCase();
    const matchingRaceIds = new Set(
      filterRacesClient(allRaces, {
        region,
        day,
        dateFrom,
        dateTo,
        raceType,
        includePast: false,
        fallbackToMatched: false,
      }).map((r) => Number(r.id))
    );
    const filteredTips = allTips.filter((t) => matchingRaceIds.has(Number(t.race_id)));
    const built = buildRacingSuggestionsClient(filteredTips, { day, dateFrom, dateTo });
    return {
      ...built,
      available_dates: availableDates,
    };
  }

  if (pathname === '/api/racing/suggest-bet/build' && method === 'POST') {
    let struct = String(body.structure || 'lucky15').trim().toLowerCase();
    if (!RACING_MULTIPLES_CLIENT[struct]) struct = 'lucky15';
    const spec = RACING_MULTIPLES_CLIENT[struct];
    const eachWay = Boolean(body.each_way);
    const unitStake = roundC(Math.max(0.1, Number(body.unit_stake || 1.0)), 2);
    const style = String(body.style || 'ALL').trim().toUpperCase();
    const riskLevel = ['low', 'medium', 'high', 'longshot'].includes(String(body.risk_level || 'medium').toLowerCase())
      ? String(body.risk_level).toLowerCase()
      : 'medium';
    const reqLegs = struct === 'acca' ? Math.max(2, Math.min(6, Number(body.legs_count || 4))) : spec.min_legs;
    const numBets = Math.max(1, Math.min(3, Number(body.num_bets || 1)));
    const excludeAlready = body.exclude_already_bet !== undefined ? Boolean(body.exclude_already_bet) : true;
    const excludeScope = body.exclude_scope === 'runner' ? 'runner' : 'race';

    const raceIds = new Set(
      filterRacesClient(allRaces, {
        region: body.region || 'ALL',
        day: body.day || 'all',
        dateFrom: body.date_from || '',
        dateTo: body.date_to || '',
        raceType: body.race_type || 'ALL',
        includePast: false,
        fallbackToMatched: false,
      }).map((r) => Number(r.id))
    );
    let pool = allTips.filter((t) => raceIds.has(Number(t.race_id)));
    if (style && style !== 'ALL') {
      const bt = style === 'WIN' ? 'R_WIN' : style === 'EW' ? 'R_EW' : style === 'PLC' ? 'R_PLC' : style;
      pool = pool.filter((t) => t.market === bt);
    }
    if (eachWay) {
      const ewPool = pool.filter((t) => t.ew_eligible && Number(t.win_odds || t.odds) >= 2.0);
      if (ewPool.length) pool = ewPool;
    } else if (style === 'ALL' && riskLevel !== 'low') {
      const winLike = pool.filter((t) => t.market === 'R_WIN' || t.market === 'R_EW');
      if (new Set(winLike.map((t) => Number(t.race_id))).size >= reqLegs) pool = winLike;
    }

    const exclSets = racingExclusionSetsClient(excludeAlready ? body.excluded_legs || [] : []);
    const avoidSets = racingExclusionSetsClient(body.avoid_legs || []);
    const avoidHas = Boolean((body.avoid_legs || []).length);

    const eligible = pool.filter((t) => {
      if (excludeAlready && isRacingTipExcludedClient(t, exclSets, excludeScope)) return false;
      if (avoidHas && isRacingTipExcludedClient(t, avoidSets, 'race')) return false;
      return true;
    });

    const [minO, maxO] = RACING_RISK_ODDS_BANDS[riskLevel] || RACING_RISK_ODDS_BANDS.medium;
    let inBand = eligible.filter((t) => {
      const o = Number(t.win_odds || t.odds || 0);
      return o >= minO && o <= maxO;
    });
    if (new Set(inBand.map((t) => Number(t.race_id))).size < reqLegs) {
      const [fbMin, fbMax] = riskLevel === 'low' || riskLevel === 'medium' ? [1.15, 9.0] : [2.5, 21.0];
      inBand = eligible.filter((t) => {
        const o = Number(t.win_odds || t.odds || 0);
        return o >= fbMin && o <= fbMax;
      });
    }
    if (!inBand.length) inBand = eligible;

    const filtered = inBand
      .map((t) => ({ ...t, _score: scoreRacingRiskClient(t, riskLevel) }))
      .sort((a, b) => b._score - a._score);

    if (!filtered.length) {
      return {
        bets: [],
        requested_bets: numBets,
        requested_legs: reqLegs,
        excluded_count: exclSets.raceKeys.size,
        available_pool_count: 0,
        available_dates: availableDates,
        notice: 'No matching runners found for these criteria — try widening regions, dates, or exclusions.',
      };
    }

    const usedGlobal = new Set();
    const builtBets = [];
    let notice = '';
    const riskNames = { low: 'Low Risk', medium: 'Balanced', high: 'High Risk', longshot: 'Longshot' };
    const styleNames = { ALL: 'Mixed', R_WIN: 'Win', R_EW: 'Each-Way Value', R_PLC: 'Place Locks' };
    const structShort = spec.label.split(' (')[0];

    for (let bIdx = 0; bIdx < numBets; bIdx += 1) {
      const picked = [];
      const usedThis = new Set();
      for (const t of filtered) {
        const rid = Number(t.race_id);
        if (usedThis.has(rid) || usedGlobal.has(rid)) continue;
        usedThis.add(rid);
        picked.push(t);
        if (picked.length >= reqLegs) break;
      }
      if (picked.length < reqLegs) {
        if (bIdx === 0 && picked.length) {
          notice = `Only ${picked.length} distinct races matched your filters (requested ${reqLegs} picks).`;
        } else if (bIdx > 0) {
          notice = `Built ${builtBets.length} of ${numBets} requested bets — not enough unused races left.`;
          break;
        }
      }
      if (!picked.length) break;
      for (const p of picked) usedGlobal.add(Number(p.race_id));
      const legs = picked.map((p) => {
        const lg = tipToLegClient(p);
        if (eachWay && lg.ew_eligible && lg.market !== 'R_EW') {
          lg.market = 'R_EW';
          lg.bet_type = 'r_ew';
          lg.bet_type_label = 'Each-Way';
          lg.selection_label = `${lg.horse_name} (E/W)`;
          lg.odds = lg.win_odds;
          lg.odds_fractional = fmtOddsLocal(lg.win_odds);
          lg.model_prob = roundC(0.5 * (Number(lg.model_win_prob || 0) + Number(lg.model_place_prob || 0)), 5);
        }
        return lg;
      });
      const ewTag = eachWay ? 'Each-Way ' : '';
      const title = `${ewTag}${styleNames[style] || 'Racing'} ${structShort}${numBets > 1 ? ` #${bIdx + 1}` : ''}`;
      const ev = evaluateRacingMultipleClient(legs, struct, eachWay, unitStake);
      builtBets.push({
        id: `r_custom_${bIdx + 1}`,
        title,
        badge: `${riskNames[riskLevel]} • ${ewTag}${structShort}`,
        subtitle: `${riskNames[riskLevel]} • ${legs.length} races • £${unitStake.toFixed(2)}/line`,
        structure: struct,
        each_way: eachWay,
        unit_stake: unitStake,
        legs,
        eval: ev,
        bet_reasons: buildRacingBetReasonsClient(title, legs, ev, eachWay),
        bet365_export: buildRacingBet365ExportClient(legs, struct, eachWay, unitStake, title),
      });
    }

    return {
      bets: builtBets,
      requested_bets: numBets,
      requested_legs: reqLegs,
      excluded_count: exclSets.raceKeys.size,
      available_pool_count: filtered.length,
      available_dates: availableDates,
      notice,
    };
  }

  throw new Error(`Unsupported racing static route: ${pathname}`);
}

function parseOddsShared(raw) {
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
      return dec > 1.01 ? roundC(dec, 4) : null;
    }
    return null;
  }
  const f = Number(s);
  return Number.isFinite(f) && f > 1.01 ? roundC(f, 4) : null;
}

export function initRacingModule(ctx) {
  const {
    esc,
    fmtOdds,
    parseOddsInput,
    fmtGbp,
    roundNum,
    showToast,
    renderReasoningDropdownHtml,
    closeAllOverlays,
    openInBet365Tab,
    state,
    api,
    renderActiveTab,
    onSlipUpdated,
  } = ctx;

  const savedMultiPrefs = getStorageSafe(RACING_MULTI_PREFS_KEY, {});
  const savedSuggest = getStorageSafe(RACING_SUGGEST_KEY, {});

  const normalizedSavedDay = (() => {
    const rawDay = String(savedSuggest.day || '').trim().toLowerCase();
    return ['all', 'today', 'tomorrow', 'next_2', 'next_3', 'custom'].includes(rawDay) ? rawDay : 'all';
  })();

  const rState = {
    overview: null,
    region: 'ALL',
    day: 'all',
    dateFrom: '',
    dateTo: '',
    availableDates: [],
    raceType: 'all',
    search: '',
    selectedRaceId: null,
    tipType: 'ALL',
    slip: getStorageSafe(RACING_SLIP_KEY, []),
    structure: RACING_MULTIPLES_CLIENT[savedMultiPrefs.structure] ? savedMultiPrefs.structure : 'lucky15',
    eachWay: savedMultiPrefs.eachWay !== undefined ? Boolean(savedMultiPrefs.eachWay) : true,
    unitStake: Math.max(0.1, Number(savedMultiPrefs.unitStake || 1.0)),
    expandedRunnerKeys: new Set(),
    expandedTipKeys: new Set(),
    expandedCardKeys: new Set(),
    suggest: {
      mode: savedSuggest.mode === 'quick' ? 'quick' : 'custom',
      structure: RACING_MULTIPLES_CLIENT[savedSuggest.structure] ? savedSuggest.structure : 'lucky15',
      eachWay: savedSuggest.eachWay !== undefined ? Boolean(savedSuggest.eachWay) : true,
      unitStake: Math.max(0.1, Number(savedSuggest.unitStake || 1.0)),
      style: savedSuggest.style || 'ALL',
      riskLevel: savedSuggest.riskLevel || 'medium',
      legsCount: Math.max(2, Math.min(6, Number(savedSuggest.legsCount || 4))),
      numBets: Math.max(1, Math.min(3, Number(savedSuggest.numBets || 1))),
      region: savedSuggest.region || 'ALL',
      day: normalizedSavedDay,
      dateFrom: cleanIsoDateClient(savedSuggest.dateFrom || ''),
      dateTo: cleanIsoDateClient(savedSuggest.dateTo || ''),
      raceType: savedSuggest.raceType || 'ALL',
      excludeAlreadyBet: savedSuggest.excludeAlreadyBet !== undefined ? Boolean(savedSuggest.excludeAlreadyBet) : true,
      excludeScope: savedSuggest.excludeScope === 'runner' ? 'runner' : 'race',
      manageOpen: false,
      builtBets: [],
      notice: '',
      excludedCount: 0,
      availablePoolCount: 0,
    },
  };

  function persistMultiPrefs() {
    setStorageSafe(RACING_MULTI_PREFS_KEY, {
      structure: rState.structure,
      eachWay: rState.eachWay,
      unitStake: rState.unitStake,
    });
  }

  function persistSuggestPrefs() {
    const s = rState.suggest;
    setStorageSafe(RACING_SUGGEST_KEY, {
      mode: s.mode,
      structure: s.structure,
      eachWay: s.eachWay,
      unitStake: s.unitStake,
      style: s.style,
      riskLevel: s.riskLevel,
      legsCount: s.legsCount,
      numBets: s.numBets,
      region: s.region,
      day: s.day,
      dateFrom: s.dateFrom,
      dateTo: s.dateTo,
      raceType: s.raceType,
      excludeAlreadyBet: s.excludeAlreadyBet,
      excludeScope: s.excludeScope,
    });
  }

  function getRacingDateBounds() {
    const dates = [...(rState.availableDates || [])].filter(Boolean).sort();
    const { todayIso, dayPlus2Iso } = ukNowInfo();
    return {
      dates,
      minDate: dates[0] || todayIso,
      maxDate: dates[dates.length - 1] || dayPlus2Iso,
    };
  }

  function ensureCustomDateBounds(targetObj) {
    const { minDate, maxDate } = getRacingDateBounds();
    if (!cleanIsoDateClient(targetObj.dateFrom)) targetObj.dateFrom = minDate;
    if (!cleanIsoDateClient(targetObj.dateTo)) targetObj.dateTo = maxDate;
    if (targetObj.dateFrom > targetObj.dateTo) {
      const tmp = targetObj.dateFrom;
      targetObj.dateFrom = targetObj.dateTo;
      targetObj.dateTo = tmp;
    }
  }

  function appendDateRangeParams(params, day, dateFrom, dateTo) {
    const dNorm = String(day || 'all').trim().toLowerCase();
    if (dNorm && dNorm !== 'all') {
      params.set('day', dNorm);
    }
    if (dNorm === 'custom') {
      const df = cleanIsoDateClient(dateFrom);
      const dt = cleanIsoDateClient(dateTo);
      if (df) params.set('date_from', df);
      if (dt) params.set('date_to', dt);
    }
  }

  function updateAvailableDatesFromPayload(payload) {
    if (Array.isArray(payload?.available_dates) && payload.available_dates.length) {
      rState.availableDates = [...payload.available_dates].filter(Boolean).sort();
    }
  }

  function formatDateSpanHint(dates = []) {
    if (!dates.length) return '';
    if (dates.length === 1) return formatShortRacingDate(dates[0]);
    return `${formatShortRacingDate(dates[0])} – ${formatShortRacingDate(dates[dates.length - 1])}`;
  }

  function saveRacingSlip() {
    setStorageSafe(RACING_SLIP_KEY, rState.slip);
    const navBadge = document.getElementById('racing-nav-slip-badge');
    if (navBadge) {
      navBadge.textContent = String(rState.slip.length);
      navBadge.classList.toggle('hidden', rState.slip.length === 0);
    }
    onSlipUpdated?.(rState.slip.length);
  }

  function autoAdjustStructureForSlipCount() {
    const n = rState.slip.length;
    if (n === 1) rState.structure = 'single';
    else if (n === 2 && !['double', 'acca'].includes(rState.structure)) rState.structure = 'double';
    else if (n === 3 && !['treble', 'trixie', 'patent', 'acca'].includes(rState.structure)) rState.structure = 'trixie';
    else if (n === 4 && !['yankee', 'lucky15', 'acca'].includes(rState.structure)) rState.structure = 'lucky15';
    else if (n >= 5) rState.structure = 'acca';
    persistMultiPrefs();
  }

  function loadPlacedRacingBets() {
    const { todayIso } = ukNowInfo();
    const scope = `u_${Number(state.activeUserId || 0)}`;
    const raw = getStorageSafe(RACING_PLACED_KEY, {});
    const list = Array.isArray(raw[scope]) ? raw[scope] : [];
    const active = list.filter(
      (b) => Array.isArray(b.legs) && b.legs.some((l) => !l.race_date || String(l.race_date).slice(0, 10) >= todayIso)
    );
    if (active.length !== list.length) {
      raw[scope] = active;
      setStorageSafe(RACING_PLACED_KEY, raw);
    }
    return active;
  }

  function savePlacedRacingBets(list) {
    const scope = `u_${Number(state.activeUserId || 0)}`;
    const raw = getStorageSafe(RACING_PLACED_KEY, {});
    raw[scope] = Array.isArray(list) ? list : [];
    setStorageSafe(RACING_PLACED_KEY, raw);
  }

  function placedSignature(legs = []) {
    return (legs || [])
      .map((l) => `${l.race_id || l.course}:${l.runner_id || l.horse_name}:${l.market || 'R_WIN'}`)
      .sort()
      .join('|');
  }

  function findPlacedByLegs(legs = []) {
    const sig = placedSignature(legs);
    if (!sig) return null;
    return loadPlacedRacingBets().find((b) => placedSignature(b.legs) === sig) || null;
  }

  function markPlaced(legs = [], title = 'Racing Bet', stake = 1.0) {
    if (!legs?.length) return null;
    const sig = placedSignature(legs);
    const existing = loadPlacedRacingBets();
    const dup = existing.find((b) => placedSignature(b.legs) === sig);
    if (dup) return dup;
    const entry = {
      id: `rp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title,
      stake: roundNum(stake, 2),
      placed_at: new Date().toISOString(),
      legs: legs.map((l) => tipToLegClient(l)),
    };
    savePlacedRacingBets([entry, ...existing]);
    return entry;
  }

  function unmarkPlacedById(placedId) {
    savePlacedRacingBets(loadPlacedRacingBets().filter((b) => b.id !== placedId));
  }

  function unmarkPlacedByLegs(legs = []) {
    const sig = placedSignature(legs);
    savePlacedRacingBets(loadPlacedRacingBets().filter((b) => placedSignature(b.legs) !== sig));
  }

  function collectExcludedRacingLegs() {
    const out = [];
    for (const pb of loadPlacedRacingBets()) {
      for (const lg of pb.legs || []) out.push({ ...lg, placedId: pb.id, betTitle: pb.title, source: 'placed' });
    }
    for (const lg of rState.slip || []) out.push({ ...lg, source: 'slip' });
    return out;
  }

  function isInRacingSlip(runnerId, market = null) {
    return rState.slip.some(
      (l) => Number(l.runner_id) === Number(runnerId) && (!market || String(l.market) === String(market))
    );
  }

  function makeLegFromRunner(runner, race, market = 'R_WIN') {
    const mkt = String(market || 'R_WIN').toUpperCase();
    const isPlc = mkt === 'R_PLC';
    const isEw = mkt === 'R_EW';
    const winOdds = Number(runner.win_odds || runner.odds || 4.0);
    const plcOdds = Number(runner.place_odds || (runner.ew_eligible ? 1 + (winOdds - 1) * Number(runner.place_fraction || 0.2) : 1.0));
    const odds = isPlc ? plcOdds : winOdds;
    const prob = isPlc
      ? Number(runner.model_place_prob || 0.35)
      : isEw
        ? 0.5 * Number(runner.model_win_prob || 0.15) + 0.5 * Number(runner.model_place_prob || 0.35)
        : Number(runner.model_win_prob || 0.15);
    const btLabel = isPlc ? 'To Place' : isEw ? 'Each-Way' : 'To Win';
    const selLabel = isPlc
      ? `${runner.horse_name} (Place ${runner.places_paid})`
      : isEw
        ? `${runner.horse_name} (E/W)`
        : `${runner.horse_name} (Win)`;
    return tipToLegClient({
      ...runner,
      race_id: runner.race_id || race?.id,
      course: runner.course || race?.course,
      race_date: runner.race_date || race?.race_date,
      off_time: runner.off_time || race?.off_time,
      race_name: runner.race_name || race?.race_name,
      race_type: runner.race_type || race?.race_type,
      market: mkt,
      bet_type: mkt.toLowerCase(),
      bet_type_label: btLabel,
      selection_label: selLabel,
      odds: roundNum(odds, 2),
      odds_fractional: fmtOdds(odds),
      model_prob: roundNum(prob, 5),
      edge_pct: isPlc ? runner.place_edge_pct : isEw ? runner.ew_edge_pct : runner.win_edge_pct,
    });
  }

  function addLegToRacingSlip(leg) {
    const exactIdx = rState.slip.findIndex(
      (l) => Number(l.runner_id) === Number(leg.runner_id) && String(l.market) === String(leg.market)
    );
    if (exactIdx !== -1) {
      rState.slip.splice(exactIdx, 1);
      autoAdjustStructureForSlipCount();
      saveRacingSlip();
      showToast(`Removed ${leg.selection_label} from Racing Slip`);
      return false;
    }

    const raceIdx = rState.slip.findIndex((l) => Number(l.race_id) === Number(leg.race_id));
    if (raceIdx !== -1) {
      rState.slip[raceIdx] = leg;
      saveRacingSlip();
      showToast(`Swapped race pick to ${leg.selection_label} @ ${fmtOdds(leg.odds)}`);
      return true;
    }

    rState.slip.push(leg);
    if (leg.market === 'R_EW') rState.eachWay = true;
    autoAdjustStructureForSlipCount();
    saveRacingSlip();
    showToast(`Added ${leg.selection_label} (${leg.off_time} ${leg.course}) to Racing Slip`);
    return true;
  }

  function oddsSourceBadge(src) {
    if (src === 'user_manual') {
      return '<span class="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-[10px] font-semibold">Bet365 Manual</span>';
    }
    if (src === 'live_fixed') {
      return '<span class="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-[10px] font-semibold">Live Odds</span>';
    }
    if (src === 'pmu_tote') {
      return '<span class="px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/35 text-[10px] font-semibold">Live Tote</span>';
    }
    return '<span class="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700 text-[10px] font-semibold">Est. Odds</span>';
  }

  function formPillsHtml(dispForm = '') {
    const raw = String(dispForm || '').trim();
    if (!raw) return '<span class="text-[10px] text-slate-500">Unraced / No form</span>';
    return raw
      .split('-')
      .slice(0, 6)
      .map((ch) => {
        const c = ch.trim().toUpperCase();
        const cls =
          c === '1'
            ? 'bg-emerald-500/25 text-emerald-300 border-emerald-400/50'
            : c === '2' || c === '3'
              ? 'bg-amber-500/20 text-amber-300 border-amber-400/40'
              : c === '4' || c === '5'
                ? 'bg-slate-800 text-slate-300 border-slate-700'
                : 'bg-rose-500/15 text-rose-300 border-rose-500/30';
        return `<span class="inline-block min-w-[18px] px-1 h-5 leading-5 text-center rounded text-[10px] font-mono font-bold border ${cls}">${esc(c)}</span>`;
      })
      .join(' ');
  }

  function betTypeBadgeHtml(market) {
    const m = String(market || '').toUpperCase();
    if (m === 'R_EW') {
      return '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-300 border border-amber-400/40 shrink-0">⚖️ Each-Way</span>';
    }
    if (m === 'R_PLC') {
      return '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-cyan-500/15 text-cyan-300 border border-cyan-400/40 shrink-0">🎯 To Place</span>';
    }
    return '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-400/40 shrink-0">🏆 To Win</span>';
  }

  function valueTagBadgeHtml(tag) {
    const t = String(tag || '').trim();
    if (!t) return '';
    const cls =
      t === 'NAP'
        ? 'bg-gradient-to-r from-amber-500/25 to-emerald-500/25 text-amber-200 border-amber-400/60'
        : t === 'NB'
          ? 'bg-cyan-500/20 text-cyan-200 border-cyan-400/50'
          : 'bg-slate-800 text-slate-200 border-slate-700';
    return `<span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold border ${cls}">${esc(t)}</span>`;
  }

  function renderRacingDateControlsHtml({
    attrName = 'data-r-day',
    idPrefix = 'rc-date',
    day = 'all',
    dateFrom = '',
    dateTo = '',
    availableDates = [],
    compact = false,
  }) {
    const { dates, minDate, maxDate } = getRacingDateBounds();
    const spanDates = availableDates.length ? availableDates : dates;
    const spanHint = formatDateSpanHint(spanDates);
    const activeDay = String(day || 'all').toLowerCase();
    const curFrom = cleanIsoDateClient(dateFrom) || minDate;
    const curTo = cleanIsoDateClient(dateTo) || maxDate;

    return `
      <div class="space-y-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-1 rounded-xl bg-slate-950 border border-slate-800 p-1">
            ${RACING_DATE_PRESETS.map(
              ([dCode, dLbl]) => `
              <button type="button" ${attrName}="${dCode}" class="px-2.5 py-1 rounded-lg font-semibold transition ${
                activeDay === dCode
                  ? 'bg-emerald-500 text-slate-950 font-extrabold shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }">${dLbl}</button>`
            ).join('')}
          </div>
          ${spanHint && !compact ? `<span class="text-[11px] text-slate-400 font-medium">Available: <b class="text-slate-200">${esc(spanHint)}</b></span>` : ''}
        </div>
        ${activeDay === 'custom'
          ? `<div class="flex flex-wrap items-center gap-2 p-2.5 rounded-xl bg-slate-950/70 border border-slate-800 text-xs">
              <label class="flex items-center gap-1.5 text-slate-300 font-semibold">
                <span>From:</span>
                <input id="${idPrefix}-from" type="date" value="${esc(curFrom)}" min="${esc(minDate)}" max="${esc(maxDate)}" class="bg-panel border border-slate-700 rounded-lg px-2 py-1 text-white font-mono" />
              </label>
              <label class="flex items-center gap-1.5 text-slate-300 font-semibold">
                <span>To:</span>
                <input id="${idPrefix}-to" type="date" value="${esc(curTo)}" min="${esc(minDate)}" max="${esc(maxDate)}" class="bg-panel border-slate-700 rounded-lg px-2 py-1 text-white font-mono border" />
              </label>
              <button id="${idPrefix}-reset" type="button" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-cyan-300 font-semibold">Reset</button>
              ${spanHint && compact ? `<span class="text-[11px] text-slate-400 ml-auto">${esc(spanHint)}</span>` : ''}
            </div>`
          : ''}
      </div>
    `;
  }

  function bindRacingDateControls(rootEl, { attrName, idPrefix, targetObj, onUpdate }) {
    if (!rootEl) return;
    rootEl.querySelectorAll(`[${attrName}]`).forEach((btn) =>
      btn.addEventListener('click', () => {
        const nextDay = btn.getAttribute(attrName) || 'all';
        targetObj.day = nextDay;
        if (nextDay === 'custom') {
          ensureCustomDateBounds(targetObj);
        }
        onUpdate();
      })
    );
    const fromEl = document.getElementById(`${idPrefix}-from`);
    const toEl = document.getElementById(`${idPrefix}-to`);
    const resetEl = document.getElementById(`${idPrefix}-reset`);
    fromEl?.addEventListener('change', (e) => {
      targetObj.dateFrom = cleanIsoDateClient(e.target.value);
      if (targetObj.dateFrom && targetObj.dateTo && targetObj.dateFrom > targetObj.dateTo) {
        targetObj.dateTo = targetObj.dateFrom;
      }
      onUpdate();
    });
    toEl?.addEventListener('change', (e) => {
      targetObj.dateTo = cleanIsoDateClient(e.target.value);
      if (targetObj.dateFrom && targetObj.dateTo && targetObj.dateTo < targetObj.dateFrom) {
        targetObj.dateFrom = targetObj.dateTo;
      }
      onUpdate();
    });
    resetEl?.addEventListener('click', () => {
      targetObj.day = 'all';
      targetObj.dateFrom = '';
      targetObj.dateTo = '';
      onUpdate();
    });
  }

  async function refreshOverview() {
    try {
      rState.overview = await api('/api/racing/overview');
      updateAvailableDatesFromPayload(rState.overview);
      const kpiEl = document.getElementById('kpi-strip');
      if (kpiEl && state.activeSport === 'racing' && rState.overview) {
        const c = rState.overview.counts || {};
        kpiEl.innerHTML = `
          <span class="px-2.5 py-1 rounded-full bg-card border border-slate-700/80">🏇 Active Races: <b class="text-white font-mono">${c.active_races || 0}</b></span>
          <span class="px-2.5 py-1 rounded-full bg-card border border-slate-700/80">🏟️ Meetings: <b class="text-emerald-400 font-mono">${c.meetings_count || 0}</b></span>
          <span class="px-2.5 py-1 rounded-full bg-card border border-slate-700/80">🐎 Runners Rated: <b class="text-cyan-300 font-mono">${c.runners_count || 0}</b></span>
          <span class="px-2.5 py-1 rounded-full bg-card border border-slate-700/80">🎟️ Slip Picks: <b class="text-amber-300 font-mono">${rState.slip.length}</b></span>
        `;
      }
      return rState.overview;
    } catch {
      return null;
    }
  }

  function renderRacecardInspectorHtml(race) {
    if (!race) {
      return '<div class="p-6 rounded-2xl bg-card border border-slate-800 text-xs text-slate-400 text-center">Select a race above to view all runners &amp; model ratings.</div>';
    }
    const runners = race.runners || [];
    const sorted = [...runners].sort((a, b) => b.model_rating - a.model_rating || a.saddle_cloth - b.saddle_cloth);
    return `
      <div class="bg-card border border-emerald-500/35 rounded-2xl overflow-hidden shadow-lg">
        <div class="p-4 border-b border-slate-800/90 bg-gradient-to-r from-emerald-500/10 via-panel to-cyan-500/10 flex flex-col md:flex-row md:items-center justify-between gap-2.5">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <span class="px-2.5 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-400/40 text-emerald-200 font-bold">${esc(race.region_flag || '🏇')} ${esc(race.course)}</span>
              <span class="font-mono font-extrabold text-amber-300 text-sm">${esc(race.off_time)}</span>
              <span class="text-slate-400">${esc(race.race_date)}</span>
              <span class="px-2 py-0.5 rounded bg-slate-800 text-slate-200 font-semibold">${esc(race.race_type)}</span>
              ${race.is_handicap ? '<span class="px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-200 border border-indigo-500/30 font-semibold">Handicap</span>' : ''}
            </div>
            <h3 class="text-base md:text-lg font-extrabold text-white mt-1.5 break-words leading-snug">${esc(formatRaceTitle(race.race_name))}</h3>
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-300 mt-1.5">
              ${race.distance_text ? `<span>📏 Distance: <b class="text-white">${esc(race.distance_text)}</b></span>` : ''}
              ${race.going || race.surface ? `<span>🌱 Ground: <b class="text-white">${esc(race.going || race.surface)}</b></span>` : ''}
              <span>🐎 Field: <b class="text-white">${runners.length}</b> runners${race.non_runners_count ? ` (${race.non_runners_count} NR)` : ''}</span>
              <span>🎯 Place Terms: <b class="text-cyan-300">${esc(race.place_terms_label)}</b></span>
              ${race.prize_text ? `<span>🏆 Prize: <b class="text-amber-300">${esc(race.prize_text)}</b></span>` : ''}
            </div>
          </div>
          <a href="https://www.bet365.com/#/AS/B2/" target="_blank" rel="noopener" class="px-3.5 py-2 rounded-xl btn-bet365 text-xs font-extrabold self-start shrink-0">Bet365 Racing →</a>
        </div>

        <div class="divide-y divide-slate-800/80">
          ${sorted
            .map((rn, idx) => {
              const whyOpen = rState.expandedRunnerKeys.has(String(rn.runner_id));
              const inWin = isInRacingSlip(rn.runner_id, 'R_WIN');
              const inEw = isInRacingSlip(rn.runner_id, 'R_EW');
              const inPlc = isInRacingSlip(rn.runner_id, 'R_PLC');
              const ratingWidth = Math.max(15, Math.min(100, Math.round(rn.model_rating)));
              const winEdgePos = Number(rn.win_edge_pct || 0) >= 0;
              return `
                <div class="p-3.5 md:p-4 hover:bg-panel/60 transition ${idx === 0 ? 'bg-emerald-500/[0.04]' : ''}">
                  <div class="flex items-start gap-3 min-w-0">
                    <div class="flex flex-col items-center shrink-0 w-9">
                      <span class="w-8 h-8 rounded-lg bg-slate-900 border border-slate-700 flex items-center justify-center font-mono text-xs font-extrabold text-white">${rn.saddle_cloth || idx + 1}</span>
                      ${rn.draw ? `<span class="text-[10px] text-slate-500 font-mono mt-0.5">Draw ${rn.draw}</span>` : ''}
                    </div>
                    ${rn.silk_url ? `<img src="${esc(rn.silk_url)}" alt="" onerror="this.style.display='none'" class="w-8 h-8 rounded object-contain bg-slate-900/60 p-0.5 shrink-0" />` : ''}
                    <div class="min-w-0 flex-1 space-y-1.5">
                      <div class="flex flex-wrap items-start justify-between gap-2">
                        <div class="flex flex-wrap items-center gap-2 min-w-0">
                          <span class="font-extrabold text-white text-sm md:text-base break-words leading-snug">${esc(rn.horse_name)}</span>
                          ${idx === 0 ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-500/20 text-emerald-300 border border-emerald-400/50">★ Top Pick</span>' : ''}
                          ${rn.finish_pos ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-200 border border-amber-400/50">Finished #${rn.finish_pos}</span>` : ''}
                          ${rn.headgear ? `<span class="px-1.5 py-0.5 rounded bg-slate-800 text-amber-200 text-[10px]">${esc(rn.headgear)}</span>` : ''}
                        </div>
                        <div class="flex items-center gap-1.5 shrink-0">
                          <span class="px-2.5 py-0.5 rounded-lg bg-slate-900 border border-slate-700 font-mono font-extrabold text-sm text-amber-300">${esc(rn.odds_fractional)}</span>
                          <span class="text-[11px] font-bold font-mono ${winEdgePos ? 'text-emerald-400' : 'text-slate-400'}">${winEdgePos ? '+' : ''}${Number(rn.win_edge_pct).toFixed(1)}%</span>
                          ${oddsSourceBadge(rn.odds_source)}
                        </div>
                      </div>

                      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                        ${rn.jockey ? `<span>Jockey: <b class="text-slate-200 break-words">${esc(rn.jockey)}</b></span>` : ''}
                        ${rn.trainer ? `<span>Trainer: <b class="text-slate-200 break-words">${esc(rn.trainer)}</b></span>` : ''}
                        ${rn.age ? `<span>Age <b class="text-slate-200">${rn.age}</b>${rn.sex ? ` (${esc(rn.sex)})` : ''}</span>` : ''}
                        ${rn.weight_display ? `<span>Weight <b class="text-slate-200">${esc(rn.weight_display)}</b></span>` : ''}
                        ${rn.official_rating ? `<span>Official Rating <b class="text-cyan-300 font-mono">${rn.official_rating}</b></span>` : ''}
                      </div>

                      <div class="flex flex-wrap items-center gap-2 pt-0.5">
                        <span class="text-[10px] text-slate-500 uppercase font-semibold">Form:</span>
                        <div class="flex flex-wrap gap-1">${formPillsHtml(rn.display_form)}</div>
                        ${rn.career_runs ? `<span class="text-[10px] text-slate-400">• ${rn.career_wins}W-${rn.career_places}P in ${rn.career_runs} runs</span>` : ''}
                      </div>
                    </div>
                  </div>

                  <div class="mt-3 pt-2.5 border-t border-slate-800/70 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                    <div class="flex flex-wrap items-center gap-3 text-[11px]">
                      <div class="w-24">
                        <div class="flex justify-between text-[10px] font-mono">
                          <span class="text-slate-400">Score</span>
                          <b class="text-emerald-300">${Number(rn.model_rating).toFixed(0)}</b>
                        </div>
                        <div class="h-1.5 rounded-full bg-slate-800 overflow-hidden mt-1">
                          <div class="h-full rounded-full bg-gradient-to-r from-emerald-500 to-cyan-400" style="width:${ratingWidth}%"></div>
                        </div>
                      </div>
                      <div class="font-mono">
                        <span class="text-white">Win <b>${rn.model_win_prob_pct}%</b> <span class="text-slate-400">(${esc(rn.fair_win_odds_fractional)})</span></span>
                        <span class="text-slate-600 mx-1.5">•</span>
                        <span class="text-cyan-300">Place ${rn.model_place_prob_pct}% <span class="text-slate-400">(${esc(rn.fair_place_odds_fractional)})</span></span>
                      </div>
                    </div>

                    <div class="flex flex-wrap items-center gap-1.5">
                      <button type="button" data-r-why-runner="${rn.runner_id}" class="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] font-semibold text-cyan-300 transition">${whyOpen ? '▲ Hide Why' : '💡 Why?'}</button>
                      <button type="button" data-r-check-runner="${rn.runner_id}" data-r-check-race="${race.id}" class="px-2.5 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-400/40 text-[11px] font-bold text-amber-200 transition" title="Enter live Bet365 odds & check Extra Place value">⚡ Price</button>
                      <button type="button" data-r-add-runner="${rn.runner_id}" data-r-add-race="${race.id}" data-r-mkt="R_WIN" class="px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition ${inWin ? 'bg-emerald-500 text-slate-950 border-emerald-400' : 'bg-emerald-600/20 hover:bg-emerald-500/30 border-emerald-500/40 text-emerald-200'}">${inWin ? '✓ Win' : '+ Win'}</button>
                      ${rn.ew_eligible ? `<button type="button" data-r-add-runner="${rn.runner_id}" data-r-add-race="${race.id}" data-r-mkt="R_EW" class="px-2.5 py-1.5 rounded-lg text-[11px] font-bold border transition ${inEw ? 'bg-amber-400 text-slate-950 border-amber-300' : 'bg-amber-500/15 hover:bg-amber-500/25 border-amber-400/40 text-amber-200'}">${inEw ? '✓ Each-Way' : '+ Each-Way'}</button>` : ''}
                      ${rn.ew_eligible ? `<button type="button" data-r-add-runner="${rn.runner_id}" data-r-add-race="${race.id}" data-r-mkt="R_PLC" class="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border transition ${inPlc ? 'bg-cyan-400 text-slate-950 border-cyan-300' : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200'}">${inPlc ? '✓ Place' : '+ Place'}</button>` : ''}
                    </div>
                  </div>
                  ${whyOpen ? renderReasoningDropdownHtml(rn.reasons, rn.reason_stats, { sport: 'racing', title: `Why AccaLab rates #${rn.saddle_cloth} ${rn.horse_name}`, fallbackText: 'Rated using form progression, official rating/weight adjustment, trainer/jockey record, and fair place odds.' }) : ''}
                </div>`;
            })
            .join('')}
        </div>
      </div>
    `;
  }

  function buildBet365RacingModalHtml(exp, legs, structure, eachWay, unitStake, title) {
    const ev = exp.eval || evaluateRacingMultipleClient(legs, structure, eachWay, unitStake);
    const placedRec = findPlacedByLegs(legs);
    return `
      <div class="space-y-4 text-xs">
        <div class="p-3.5 rounded-xl bg-gradient-to-r from-emerald-500/15 to-amber-500/10 border border-emerald-500/35 flex flex-wrap items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="text-sm font-extrabold text-white break-words leading-snug">${esc(title)}</div>
            <div class="text-[11px] text-slate-300 mt-0.5">${eachWay ? 'Each-Way ' : ''}${esc(ev.structure_label)} • ${ev.total_bets} bets @ £${ev.unit_stake.toFixed(2)} = <b class="text-white">£${ev.total_stake.toFixed(2)}</b></div>
          </div>
          <div class="text-right font-mono shrink-0">
            <div class="text-emerald-300 font-extrabold text-sm">Max £${ev.max_return.toFixed(2)}</div>
            ${eachWay ? `<div class="text-[11px] text-amber-200">All Place: £${ev.all_place_return.toFixed(2)}</div>` : ''}
          </div>
        </div>

        <div class="space-y-2">
          <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Bet365 Selection Checklist (${exp.legs.length} Runners)</div>
          ${(exp.legs || [])
            .map(
              (lg) => `
              <div class="p-2.5 rounded-xl bg-card border border-slate-800 flex flex-wrap items-center justify-between gap-2">
                <div class="min-w-0 flex-1">
                  <div class="font-bold text-white break-words leading-snug">${lg.index}. #${lg.saddle_cloth} ${esc(lg.horse_name)} <span class="text-amber-300 font-mono">@ ${esc(lg.odds_fractional)}</span></div>
                  <div class="text-[11px] text-slate-400 break-words">${esc(lg.off_time)} ${esc(lg.course)} • ${esc(lg.place_terms_label || 'Win')}</div>
                </div>
                <a href="${esc(lg.b365_search_url)}" target="_blank" rel="noopener" class="px-2.5 py-1.5 rounded-lg bg-emerald-600/25 hover:bg-emerald-500/35 border border-emerald-500/40 text-emerald-200 font-semibold shrink-0">Find Horse on Bet365 →</a>
              </div>`
            )
            .join('')}
        </div>

        <div class="p-3 rounded-xl bg-slate-950 border border-slate-800 text-[11px] text-slate-300">
          On Bet365 Horse Racing slip: add all <b>${exp.legs.length} runners</b> above, expand <b>Multiples</b>, select <b class="text-amber-300">${esc(ev.structure_label.split(' (')[0])}</b>${eachWay ? ', and tick the <b class="text-amber-300">Each-Way (E/W)</b> box' : ''}.
        </div>

        <div class="flex flex-wrap gap-2">
          <button id="r-b365-copy-btn" type="button" class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold">📋 Copy Summary</button>
          <button id="r-b365-placed-btn" type="button" class="px-3 py-2 rounded-xl border font-bold ${placedRec ? 'bg-emerald-500/20 border-emerald-400 text-emerald-200' : 'bg-slate-800 hover:bg-emerald-600/25 border-slate-700 text-emerald-300'}">${placedRec ? '✅ Marked Placed' : '✅ Mark Placed'}</button>
          <button id="r-b365-launch-btn" type="button" class="flex-1 py-2 px-4 rounded-xl btn-bet365 font-extrabold">🐎 Open Bet365 Horse Racing →</button>
        </div>
      </div>
    `;
  }

  function openRacingBet365Modal(legs, structure, eachWay, unitStake, title) {
    closeAllOverlays('suggest-modal');
    const modal = document.getElementById('suggest-modal');
    const titleEl = document.getElementById('suggest-modal-title');
    const subEl = document.getElementById('suggest-modal-subtitle');
    const body = document.getElementById('suggest-modal-body');
    if (!modal || !body) return;

    const exp = buildRacingBet365ExportClient(legs, structure, eachWay, unitStake, title);
    titleEl.textContent = `📋 Bet365 Racing Handoff — ${title}`;
    subEl.textContent = `${eachWay ? 'Each-Way ' : ''}${exp.structure_label} • £${exp.eval.total_stake.toFixed(2)} total stake`;
    modal.classList.remove('hidden');
    body.innerHTML = buildBet365RacingModalHtml(exp, legs, structure, eachWay, unitStake, title);

    document.getElementById('r-b365-copy-btn')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard?.writeText(exp.clipboard_text);
        showToast('Copied Bet365 racing slip summary!');
      } catch {
        showToast('Unable to copy to clipboard', true);
      }
    });
    document.getElementById('r-b365-placed-btn')?.addEventListener('click', () => {
      if (findPlacedByLegs(legs)) {
        unmarkPlacedByLegs(legs);
        showToast('Removed from placed racing bets');
      } else {
        markPlaced(legs, title, exp.eval.total_stake);
        showToast('Marked placed — this race/selection will be excluded in Suggest a Bet!');
      }
      openRacingBet365Modal(legs, structure, eachWay, unitStake, title);
    });
    document.getElementById('r-b365-launch-btn')?.addEventListener('click', () => {
      openInBet365Tab(exp.racing_hub_url || exp.launch_url);
    });
  }

  async function renderRacingCardsTab() {
    const main = document.getElementById('main-content');
    main.innerHTML = '<div class="text-slate-400 text-sm py-8 text-center">Loading daily racecards &amp; runner ratings...</div>';

    const q = new URLSearchParams();
    if (rState.region !== 'ALL') q.set('region', rState.region);
    appendDateRangeParams(q, rState.day, rState.dateFrom, rState.dateTo);
    if (rState.raceType !== 'all') q.set('race_type', rState.raceType);
    if (rState.search) q.set('search', rState.search);

    const [cardsRes, overview] = await Promise.all([
      api(`/api/racing/cards${q.toString() ? `?${q.toString()}` : ''}`),
      refreshOverview(),
    ]);
    updateAvailableDatesFromPayload(cardsRes);

    const rawMeetings = cardsRes.meetings || [];
    const regionOrder = (rc) => (rc === 'GB' || rc === 'IRE' ? 0 : rc === 'FR' ? 1 : 2);
    const meetings = [...rawMeetings].sort(
      (a, b) =>
        regionOrder(a.region_code) - regionOrder(b.region_code) ||
        String(a.race_date).localeCompare(String(b.race_date)) ||
        String(a.course).localeCompare(String(b.course))
    );
    const races = cardsRes.races || [];
    const raceMap = new Map(races.map((r) => [Number(r.id), r]));
    if (!raceMap.has(Number(rState.selectedRaceId))) {
      const firstId = meetings[0]?.races?.[0]?.id || races[0]?.id || 0;
      rState.selectedRaceId = Number(firstId) || null;
    }
    const activeRace = rState.selectedRaceId ? raceMap.get(Number(rState.selectedRaceId)) : null;
    const activeMeeting =
      meetings.find((mt) => (mt.races || []).some((rc) => Number(rc.id) === Number(rState.selectedRaceId))) ||
      meetings[0] ||
      null;
    const news = overview?.news || [];

    main.innerHTML = `
      <div>
        <h2 class="text-xl font-bold text-white">🏇 Daily Racecards &amp; Top Picks</h2>
        <p class="text-xs text-slate-400">UK, Ireland &amp; International racecards • Win &amp; Place probabilities</p>
      </div>

      <div class="bg-panel border border-slate-800/80 rounded-2xl p-3.5 space-y-3 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap gap-1.5">
            ${REGION_FILTER_OPTIONS.map(
              ([code, label]) => `
              <button type="button" data-r-region="${code}" class="px-2.5 py-1.5 rounded-xl font-bold border transition ${
                rState.region === code
                  ? 'bg-emerald-500 text-slate-950 border-emerald-400'
                  : 'bg-card border-slate-800 text-slate-300 hover:text-white'
              }">${label}</button>`
            ).join('')}
          </div>
          <div class="flex rounded-xl bg-slate-950 border border-slate-800 p-0.5">
            ${[
              ['all', 'All Codes'],
              ['flat', 'Flat'],
              ['jumps', 'Jumps'],
            ]
              .map(
                ([tCode, tLbl]) => `
                <button type="button" data-r-type="${tCode}" class="px-2.5 py-1 rounded-lg font-semibold transition ${
                  rState.raceType === tCode ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400 hover:text-white'
                }">${tLbl}</button>`
              )
              .join('')}
          </div>
        </div>
        ${renderRacingDateControlsHtml({
          attrName: 'data-r-day',
          idPrefix: 'rc-date',
          day: rState.day,
          dateFrom: rState.dateFrom,
          dateTo: rState.dateTo,
          availableDates: rState.availableDates,
        })}
        <div class="flex items-center gap-2">
          <input id="rc-search-input" type="search" value="${esc(rState.search)}" placeholder="Search course, horse name, jockey or trainer..." class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-emerald-400" />
          <span class="text-slate-400 shrink-0 font-mono">${races.length} races</span>
        </div>
      </div>

      ${meetings.length && activeMeeting
        ? `<div class="space-y-3">
            <div class="bg-panel border border-slate-800/90 rounded-2xl p-3.5 space-y-2.5">
              <div class="flex items-center justify-between gap-2 text-xs">
                <span class="font-bold uppercase tracking-wider text-slate-400 text-[11px]">1. Choose a Meeting (${meetings.length})</span>
                <span class="text-[11px] text-emerald-400 font-semibold">${esc(activeMeeting.course)} selected</span>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                ${meetings
                  .map((mt) => {
                    const isMtActive = mt.course === activeMeeting.course && mt.race_date === activeMeeting.race_date;
                    const firstRaceId = mt.races?.[0]?.id || 0;
                    return `
                      <button type="button" data-r-select-meeting="${firstRaceId}" class="p-2.5 rounded-xl text-left border transition ${
                        isMtActive
                          ? 'bg-emerald-500/20 border-emerald-400 text-white shadow-sm shadow-emerald-500/20'
                          : 'bg-card border-slate-800 text-slate-300 hover:border-slate-600'
                      }">
                        <div class="text-xs font-extrabold text-white break-words leading-snug">${esc(mt.region_flag || '🏇')} ${esc(mt.course)} <span class="text-[10px] font-normal text-slate-400">(${esc(mt.country_name)})</span></div>
                        <div class="text-[11px] text-slate-400 mt-0.5 break-words">${esc(mt.race_date)}${mt.going || mt.surface ? ` • ${esc(mt.going || mt.surface)}` : ''} • ${mt.race_count} races</div>
                      </button>`;
                  })
                  .join('')}
              </div>
            </div>

            <div class="bg-panel border border-slate-800/90 rounded-2xl p-3.5 space-y-2.5">
              <div class="flex items-center justify-between gap-2 text-xs">
                <span class="font-bold uppercase tracking-wider text-slate-400 text-[11px]">2. Races at ${esc(activeMeeting.region_flag || '🏇')} ${esc(activeMeeting.course)} (${(activeMeeting.races || []).length})</span>
                <span class="text-[11px] text-slate-400">${esc(activeMeeting.race_date)}</span>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                ${(activeMeeting.races || [])
                  .map((rc) => {
                    const sel = Number(rc.id) === Number(rState.selectedRaceId);
                    return `
                      <button type="button" data-r-select-race="${rc.id}" class="p-2.5 rounded-xl text-left border transition ${
                        sel
                          ? 'bg-emerald-500/20 border-emerald-400 text-white shadow-sm shadow-emerald-500/20'
                          : 'bg-card border-slate-800 text-slate-300 hover:border-slate-600'
                      }">
                        <div class="flex items-center justify-between gap-2">
                          <span class="font-mono text-xs font-extrabold ${sel ? 'text-emerald-300' : 'text-amber-300'}">${esc(rc.off_time)}</span>
                          <span class="text-[10px] text-slate-400">${esc(rc.distance_text || rc.race_type || '')}${rc.runners_count ? ` • ${rc.runners_count} run` : ''}</span>
                        </div>
                        <div class="text-[11px] font-semibold text-white break-words leading-snug mt-0.5">${esc(formatRaceTitle(rc.race_name))}</div>
                        <div class="text-[11px] text-slate-300 break-words leading-snug mt-0.5">Top Pick: <b class="text-emerald-300">${esc(rc.top_horse)}</b> <span class="font-mono text-amber-300">(${esc(rc.top_odds_fractional)})</span></div>
                      </button>`;
                  })
                  .join('')}
              </div>
            </div>
          </div>`
        : '<div class="p-8 rounded-2xl bg-card border border-slate-800 text-sm text-slate-400 text-center">No thoroughbred races match your current filters. Try switching region or date above, or click Smart Sync.</div>'
      }

      <div id="rc-inspector-wrap">${renderRacecardInspectorHtml(activeRace)}</div>

      ${news.length
        ? `<div class="bg-panel border border-slate-800 rounded-2xl p-4 space-y-2.5">
            <h3 class="text-sm font-bold text-white">📰 Latest Horse Racing News (BBC Sport Racing)</h3>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-2.5 text-xs">
              ${news
                .slice(0, 6)
                .map(
                  (n) => `
                  <a href="${esc(n.url)}" target="_blank" rel="noopener" class="p-3 rounded-xl bg-card border border-slate-800 hover:border-slate-600 block">
                    <div class="text-[10px] text-emerald-400 font-semibold">${esc(n.source)}</div>
                    <div class="font-semibold text-white mt-0.5 break-words leading-snug">${esc(n.title)}</div>
                  </a>`
                )
                .join('')}
            </div>
          </div>`
        : ''}
    `;

    main.querySelectorAll('[data-r-region]').forEach((btn) =>
      btn.addEventListener('click', () => {
        rState.region = btn.dataset.rRegion;
        renderRacingCardsTab();
      })
    );
    bindRacingDateControls(main, {
      attrName: 'data-r-day',
      idPrefix: 'rc-date',
      targetObj: rState,
      onUpdate: renderRacingCardsTab,
    });
    main.querySelectorAll('[data-r-type]').forEach((btn) =>
      btn.addEventListener('click', () => {
        rState.raceType = btn.dataset.rType;
        renderRacingCardsTab();
      })
    );
    const searchEl = document.getElementById('rc-search-input');
    let searchTimer = null;
    searchEl?.addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        rState.search = e.target.value;
        renderRacingCardsTab();
      }, 240);
    });
    main.querySelectorAll('[data-r-select-meeting]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const rid = Number(btn.dataset.rSelectMeeting);
        if (rid) {
          rState.selectedRaceId = rid;
          renderRacingCardsTab();
        }
      })
    );
    main.querySelectorAll('[data-r-select-race]').forEach((btn) =>
      btn.addEventListener('click', () => {
        rState.selectedRaceId = Number(btn.dataset.rSelectRace);
        const selRace = raceMap.get(rState.selectedRaceId);
        if (selRace) {
          renderRacingCardsTab();
          setTimeout(() => {
            document.getElementById('rc-inspector-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }, 40);
        }
      })
    );
    main.querySelectorAll('[data-r-why-runner]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const key = String(btn.dataset.rWhyRunner);
        if (rState.expandedRunnerKeys.has(key)) rState.expandedRunnerKeys.delete(key);
        else rState.expandedRunnerKeys.add(key);
        renderRacingCardsTab();
      })
    );
    main.querySelectorAll('[data-r-check-runner]').forEach((btn) =>
      btn.addEventListener('click', () =>
        openRacingPriceCheckerModal(Number(btn.dataset.rCheckRace), Number(btn.dataset.rCheckRunner))
      )
    );
    main.querySelectorAll('[data-r-add-runner]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const rid = Number(btn.dataset.rAddRace);
        const rnId = Number(btn.dataset.rAddRunner);
        const mkt = btn.dataset.rMkt || 'R_WIN';
        const rc = raceMap.get(rid);
        const rn = rc?.runners?.find((x) => Number(x.runner_id) === rnId);
        if (!rc || !rn) return;
        addLegToRacingSlip(makeLegFromRunner(rn, rc, mkt));
        renderRacingCardsTab();
      })
    );
  }

  async function renderRacingTipsTab() {
    const main = document.getElementById('main-content');
    main.innerHTML = '<div class="text-slate-400 text-sm py-8 text-center">Scoring racing value tips &amp; place locks...</div>';

    const q = new URLSearchParams({ limit: '160' });
    if (rState.region !== 'ALL') q.set('region', rState.region);
    appendDateRangeParams(q, rState.day, rState.dateFrom, rState.dateTo);
    if (rState.raceType !== 'all') q.set('race_type', rState.raceType);
    if (rState.tipType !== 'ALL') q.set('bet_type', rState.tipType);

    const [tipsRes] = await Promise.all([api(`/api/racing/tips?${q.toString()}`), refreshOverview()]);
    updateAvailableDatesFromPayload(tipsRes);
    const tips = tipsRes.tips || [];
    const tipByKey = new Map(tips.map((t) => [String(t.tip_id), t]));
    const exclSets = racingExclusionSetsClient(collectExcludedRacingLegs());

    main.innerHTML = `
      <div>
        <h2 class="text-xl font-bold text-white">💎 Top Racing Tips</h2>
        <p class="text-xs text-slate-400">Ranked Win, Each-Way &amp; Place picks • Filter by Date Range, Region &amp; Bet Type</p>
      </div>

      <div class="bg-panel border border-slate-800/80 rounded-2xl p-3.5 space-y-3 text-xs">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap gap-1.5">
            ${[
              ['ALL', '🔥 All Tips'],
              ['R_WIN', '🏆 Win Tips'],
              ['R_EW', '⚖️ Each-Way Value'],
              ['R_PLC', '🎯 Place Locks'],
            ]
              .map(
                ([bt, lbl]) => `
                <button type="button" data-rt-type="${bt}" class="px-3 py-1.5 rounded-xl font-extrabold border transition ${
                  rState.tipType === bt
                    ? 'bg-emerald-500 text-slate-950 border-emerald-400'
                    : 'bg-card border-slate-700 text-slate-300 hover:text-white'
                }">${lbl}</button>`
              )
              .join('')}
          </div>
          <div class="flex flex-wrap gap-1.5">
            ${REGION_FILTER_OPTIONS.map(
              ([code, label]) => `
              <button type="button" data-rt-region="${code}" class="px-2.5 py-1 rounded-full font-semibold border transition ${
                rState.region === code
                  ? 'bg-emerald-500/20 text-emerald-200 border-emerald-400/70'
                  : 'bg-card text-slate-400 border-slate-800 hover:text-white'
              }">${label}</button>`
            ).join('')}
          </div>
        </div>
        ${renderRacingDateControlsHtml({
          attrName: 'data-rt-day',
          idPrefix: 'rt-date',
          day: rState.day,
          dateFrom: rState.dateFrom,
          dateTo: rState.dateTo,
          availableDates: rState.availableDates,
        })}
      </div>

      ${tips.length
        ? `<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            ${tips
              .map((t) => {
                const isWhy = rState.expandedTipKeys.has(String(t.tip_id));
                const inSlip = isInRacingSlip(t.runner_id, t.market);
                const alreadyBacked = isRacingTipExcludedClient(t, exclSets, 'race');
                const edgeVal = Number(t.edge_pct || 0);
                const leg = tipToLegClient(t);
                const isPlaced = Boolean(findPlacedByLegs([leg]));
                return `
                  <div class="p-4 rounded-2xl bg-card border ${isPlaced ? 'border-emerald-500/60' : 'border-slate-800'} space-y-3 card-hover text-xs">
                    <div class="flex items-start justify-between gap-2">
                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                          <span>${esc(t.region_flag || '🏇')}</span>
                          <b class="text-white break-words">${esc(t.course)}</b>
                          <span class="font-mono text-amber-300 font-bold">${esc(t.off_time)}</span>
                          <span>• ${esc(formatShortRacingDate(t.race_date))}</span>
                          <span>• ${esc(t.race_type)}</span>
                        </div>
                        <div class="text-base font-extrabold text-white mt-0.5 break-words leading-snug">#${t.saddle_cloth} ${esc(t.horse_name)}</div>
                        <div class="text-[11px] text-slate-400 break-words leading-snug mt-0.5">${esc(formatRaceTitle(t.race_name))}</div>
                      </div>
                      <div class="flex flex-col items-end gap-1 shrink-0">
                        ${valueTagBadgeHtml(t.value_tag)}
                        ${betTypeBadgeHtml(t.market)}
                      </div>
                    </div>

                    <div class="flex flex-wrap items-center gap-2 text-[11px]">
                      <span class="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 font-mono text-emerald-300 font-bold">Score ${Number(t.model_rating).toFixed(0)}/100</span>
                      <span class="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-cyan-300">${esc(t.place_terms_label)}</span>
                      ${alreadyBacked && !isPlaced ? '<span class="px-2 py-0.5 rounded bg-slate-800 text-slate-300">Already Backed/In Slip</span>' : ''}
                      ${isPlaced ? '<span class="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-bold">✅ Placed</span>' : ''}
                    </div>

                    <div class="grid grid-cols-3 gap-2 p-2.5 rounded-xl bg-panel border border-slate-800 text-center">
                      <div>
                        <div class="text-[10px] text-slate-400">${t.odds_source === 'model_tissue' ? 'Est. Odds' : 'Live Odds'}</div>
                        <div class="font-mono font-extrabold text-sm text-amber-300">${esc(t.odds_fractional)}</div>
                      </div>
                      <div>
                        <div class="text-[10px] text-slate-400">${t.market === 'R_PLC' ? 'Place Chance' : 'Win Chance'}</div>
                        <div class="font-mono font-bold text-sm text-white">${t.model_prob_pct}%</div>
                      </div>
                      <div>
                        <div class="text-[10px] text-slate-400">Min Bet365 Price</div>
                        <div class="font-mono font-bold text-sm ${edgeVal >= 0 ? 'text-emerald-400' : 'text-cyan-300'}">&gt; ${esc(t.min_bet365_fractional)}</div>
                      </div>
                    </div>

                    <div class="flex flex-wrap items-center justify-between gap-1.5 text-[11px] text-slate-400">
                      <span class="break-words">Jockey: <b class="text-slate-200">${esc(t.jockey || 'TBA')}</b> • Trainer: <b class="text-slate-200">${esc(t.trainer || 'TBA')}</b></span>
                      ${oddsSourceBadge(t.odds_source)}
                    </div>

                    <div class="flex flex-wrap items-center gap-1.5 pt-1">
                      <button type="button" data-rt-why="${esc(t.tip_id)}" class="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-cyan-300 font-semibold">${isWhy ? '▲ Hide Why' : '💡 Why?'}</button>
                      <button type="button" data-rt-check="${esc(t.tip_id)}" class="px-2.5 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-400/40 text-amber-200 font-bold">⚡ Price</button>
                      <button type="button" data-rt-slip="${esc(t.tip_id)}" class="px-3 py-1.5 rounded-lg font-bold border transition ${inSlip ? 'bg-emerald-500 text-slate-950 border-emerald-400' : 'bg-emerald-600/20 hover:bg-emerald-500/30 border-emerald-500/40 text-emerald-200'}">${inSlip ? '✓ In Slip' : '+ Slip'}</button>
                      <button type="button" data-rt-b365="${esc(t.tip_id)}" class="flex-1 py-1.5 px-3 rounded-lg btn-bet365 font-extrabold">📋 Bet365</button>
                      <button type="button" data-rt-card="${t.race_id}" class="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold">Racecard →</button>
                    </div>

                    ${isWhy ? renderReasoningDropdownHtml(t.reasons, t.reason_stats, { sport: 'racing', title: `Why AccaLab picked ${t.horse_name} (${t.bet_type_label})`, fallbackText: 'Ranked on form, official rating/weight adjustment, trainer/jockey record, and fair price.' }) : ''}
                  </div>`;
              })
              .join('')}
          </div>`
        : `<div class="p-8 rounded-2xl bg-card border border-slate-800 text-sm text-slate-400 text-center space-y-3">
            <div>No tips match the current filters — widen Date Range, Region, or Bet Type above.</div>
            ${rState.day !== 'all' ? '<button id="rt-empty-reset-date" type="button" class="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-bold text-cyan-300">Show All Upcoming Dates</button>' : ''}
          </div>`
      }
    `;

    bindRacingDateControls(main, {
      attrName: 'data-rt-day',
      idPrefix: 'rt-date',
      targetObj: rState,
      onUpdate: renderRacingTipsTab,
    });
    document.getElementById('rt-empty-reset-date')?.addEventListener('click', () => {
      rState.day = 'all';
      rState.dateFrom = '';
      rState.dateTo = '';
      renderRacingTipsTab();
    });
    main.querySelectorAll('[data-rt-type]').forEach((btn) =>
      btn.addEventListener('click', () => {
        rState.tipType = btn.dataset.rtType;
        renderRacingTipsTab();
      })
    );
    main.querySelectorAll('[data-rt-region]').forEach((btn) =>
      btn.addEventListener('click', () => {
        rState.region = btn.dataset.rtRegion;
        renderRacingTipsTab();
      })
    );
    main.querySelectorAll('[data-rt-why]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const k = String(btn.dataset.rtWhy);
        if (rState.expandedTipKeys.has(k)) rState.expandedTipKeys.delete(k);
        else rState.expandedTipKeys.add(k);
        renderRacingTipsTab();
      })
    );
    main.querySelectorAll('[data-rt-check]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const t = tipByKey.get(String(btn.dataset.rtCheck));
        if (t) openRacingPriceCheckerModal(t.race_id, t.runner_id);
      })
    );
    main.querySelectorAll('[data-rt-slip]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const t = tipByKey.get(String(btn.dataset.rtSlip));
        if (!t) return;
        addLegToRacingSlip(tipToLegClient(t));
        renderRacingTipsTab();
      })
    );
    main.querySelectorAll('[data-rt-b365]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const t = tipByKey.get(String(btn.dataset.rtB365));
        if (!t) return;
        openRacingBet365Modal([tipToLegClient(t)], 'single', t.market === 'R_EW', 10.0, `${t.horse_name} (${t.bet_type_label})`);
      })
    );
    main.querySelectorAll('[data-rt-card]').forEach((btn) =>
      btn.addEventListener('click', () => {
        rState.selectedRaceId = Number(btn.dataset.rtCard);
        state.activeTab = 'racing_cards';
        renderActiveTab();
      })
    );
  }

  async function renderRacingMultiplesTab() {
    const main = document.getElementById('main-content');
    await refreshOverview();
    const ev = evaluateRacingMultipleClient(rState.slip, rState.structure, rState.eachWay, rState.unitStake);
    const placedRec = rState.slip.length ? findPlacedByLegs(rState.slip) : null;
    const evCls = ev.expected_value_pct >= 0 ? 'text-emerald-400' : 'text-amber-300';

    main.innerHTML = `
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <h2 class="text-xl font-bold text-white">🎟️ Racing Multiples &amp; Lucky 15 Builder</h2>
          <p class="text-xs text-slate-400">Build Singles, Doubles, Trebles, Trixies, Patents, Yankees &amp; Lucky 15s (Win or Each-Way)</p>
        </div>
        <div class="flex flex-wrap gap-2 text-xs">
          <button id="rm-load-lucky15" type="button" class="px-3 py-1.5 rounded-xl bg-emerald-600/25 hover:bg-emerald-500/35 border border-emerald-500/40 text-emerald-200 font-bold">🍀 Auto-Load Daily Lucky 15</button>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div class="lg:col-span-7 space-y-3">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-bold text-white">Selected Runners (${rState.slip.length})</h3>
            ${rState.slip.length ? '<button id="rm-clear-btn" type="button" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-300">Clear Slip</button>' : ''}
          </div>

          ${rState.slip.length
            ? rState.slip
                .map(
                  (lg, idx) => `
                  <div class="p-3.5 rounded-2xl bg-card border border-slate-800 space-y-2 text-xs">
                    <div class="flex items-start justify-between gap-2">
                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="text-sm font-extrabold text-white break-words leading-snug">${idx + 1}. #${lg.saddle_cloth || idx + 1} ${esc(lg.horse_name)}</span>
                          ${betTypeBadgeHtml(lg.market)}
                        </div>
                        <div class="text-[11px] text-slate-400 mt-0.5 break-words">${esc(lg.region_flag || '🏇')} ${esc(lg.off_time)} ${esc(lg.course)} • ${esc(lg.place_terms_label || 'Win')}</div>
                      </div>
                      <button type="button" data-rm-remove="${idx}" class="px-2 py-1 rounded-lg bg-slate-800 hover:bg-rose-600/30 text-slate-300 shrink-0">✕</button>
                    </div>
                    <div class="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-800/80">
                      <div class="flex items-center gap-1.5">
                        <span class="text-slate-400">Bet365 Odds:</span>
                        <input type="text" data-rm-odds-input="${idx}" value="${esc(fmtOdds(lg.win_odds || lg.odds))}" class="w-16 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-center font-mono text-white" />
                        <button type="button" data-rm-odds-save="${idx}" class="px-2 py-1 rounded-lg bg-slate-800 hover:bg-emerald-600/30 text-emerald-300 font-semibold">Set</button>
                      </div>
                      <div class="font-mono text-[11px] text-slate-300">
                        Win <b class="text-white">${(Number(lg.model_win_prob || 0) * 100).toFixed(1)}%</b> • Place <b class="text-cyan-300">${(Number(lg.model_place_prob || 0) * 100).toFixed(1)}%</b>
                      </div>
                    </div>
                  </div>`
                )
                .join('')
            : `<div class="p-8 rounded-2xl bg-panel border border-dashed border-slate-700 text-center space-y-3">
                <div class="text-sm text-slate-300 font-semibold">Your Racing Slip is empty.</div>
                <div class="text-xs text-slate-400">Pick horses from Daily Races / Top Racing Tips, or click <b>Auto-Load Daily Lucky 15</b> above!</div>
                <div class="flex justify-center gap-2 pt-1">
                  <button id="rm-go-cards" type="button" class="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-white font-semibold">Browse Racecards →</button>
                  <button id="rm-go-tips" type="button" class="px-3 py-1.5 rounded-xl bg-emerald-600/25 border border-emerald-500/40 text-xs text-emerald-200 font-bold">View Racing Tips →</button>
                </div>
              </div>`
          }
        </div>

        <div class="lg:col-span-5">
          <div class="p-4 rounded-2xl bg-panel border border-emerald-500/35 space-y-4 text-xs sticky top-20">
            <div>
              <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">Bet Structure</div>
              <div class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-2 gap-1.5">
                ${Object.entries(RACING_MULTIPLES_CLIENT)
                  .map(([k, spec]) => {
                    const active = rState.structure === k;
                    const fit = rState.slip.length >= spec.min_legs && rState.slip.length <= spec.max_legs;
                    return `
                      <button type="button" data-rm-struct="${k}" class="px-2.5 py-2 rounded-xl text-left border transition ${
                        active
                          ? 'bg-emerald-500/20 border-emerald-400 text-white font-bold'
                          : fit
                            ? 'bg-card border-slate-700 text-slate-200 hover:border-slate-500'
                            : 'bg-slate-950/60 border-slate-800/80 text-slate-500 hover:text-slate-300'
                      }">
                        <div class="text-[11px]">${esc(spec.short)}</div>
                        <div class="text-[9px] text-slate-400">${spec.min_legs === spec.max_legs ? `${spec.min_legs} pick${spec.min_legs > 1 ? 's' : ''}` : `${spec.min_legs}-${spec.max_legs} picks`}</div>
                      </button>`;
                  })
                  .join('')}
              </div>
            </div>

            <div class="grid grid-cols-2 gap-2.5 pt-2 border-t border-slate-800">
              <div>
                <label class="text-[11px] font-bold text-slate-400">Unit Stake (£/bet)</label>
                <input id="rm-unit-stake" type="number" step="0.5" min="0.1" value="${rState.unitStake}" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white font-mono" />
              </div>
              <div>
                <div class="text-[11px] font-bold text-slate-400 mb-1">Each-Way Option</div>
                <label class="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-slate-950 border ${rState.eachWay ? 'border-amber-400/60 bg-amber-500/10' : 'border-slate-700'} cursor-pointer">
                  <span class="font-bold ${rState.eachWay ? 'text-amber-200' : 'text-slate-300'} leading-tight">Each-Way <span class="text-[10px] font-normal text-slate-400">(Win + Place)</span></span>
                  <input id="rm-ew-toggle" type="checkbox" ${rState.eachWay ? 'checked' : ''} class="accent-amber-400 shrink-0" />
                </label>
              </div>
            </div>

            <div class="flex flex-wrap gap-1.5">
              ${[0.5, 1, 2, 5, 10]
                .map(
                  (amt) => `<button type="button" data-rm-stake-chip="${amt}" class="px-2.5 py-1 rounded-lg border font-mono text-[11px] ${Number(rState.unitStake) === amt ? 'bg-emerald-500/20 border-emerald-400 text-emerald-200 font-bold' : 'bg-card border-slate-800 text-slate-300'}">£${amt}</button>`
                )
                .join('')}
            </div>

            <div class="p-3.5 rounded-xl bg-slate-950/90 border border-slate-800 space-y-2">
              <div class="flex justify-between"><span class="text-slate-400">Total Bets:</span><b class="font-mono text-white">${ev.total_bets} × £${ev.unit_stake.toFixed(2)} = £${ev.total_stake.toFixed(2)}</b></div>
              <div class="flex justify-between"><span class="text-slate-400">Max Return (All Win):</span><b class="font-mono text-emerald-400 text-sm">£${ev.max_return.toFixed(2)}</b></div>
              ${rState.eachWay ? `<div class="flex justify-between"><span class="text-slate-400">All Place Return:</span><b class="font-mono text-amber-300">£${ev.all_place_return.toFixed(2)}</b></div>` : ''}
              <div class="flex justify-between"><span class="text-slate-400">Chance Any Return:</span><b class="font-mono text-cyan-300">${ev.prob_any_return_pct}%</b></div>
              <div class="flex justify-between"><span class="text-slate-400">Value Rating:</span><b class="font-mono ${evCls}">${ev.expected_value_pct >= 0 ? '+' : ''}${ev.expected_value_pct}% (£${ev.expected_profit >= 0 ? '+' : ''}${ev.expected_profit.toFixed(2)})</b></div>
            </div>

            ${ev.breakdown.length > 1
              ? `<div class="space-y-1 text-[11px] pt-1">
                  <div class="font-bold text-slate-400 uppercase tracking-wider text-[10px]">Fold Breakdown</div>
                  ${ev.breakdown
                    .map(
                      (b) => `
                      <div class="flex justify-between text-slate-300 font-mono">
                        <span>${esc(b.label)} (${b.lines} bets)</span>
                        <span>Max £${b.max_return.toFixed(2)}${rState.eachWay ? ` / Plc £${b.all_place_return.toFixed(2)}` : ''}</span>
                      </div>`
                    )
                    .join('')}
                </div>`
              : ''}

            ${ev.warnings.length
              ? ev.warnings
                  .map((w) => `<div class="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/40 text-amber-200 text-[11px]">⚠️ ${esc(w)}</div>`)
                  .join('')
              : ''}

            <div class="flex flex-wrap gap-2 pt-1">
              <button id="rm-placed-btn" type="button" ${!rState.slip.length ? 'disabled' : ''} class="px-3 py-2 rounded-xl border font-bold disabled:opacity-40 ${placedRec ? 'bg-emerald-500/20 border-emerald-400 text-emerald-200' : 'bg-slate-800 hover:bg-emerald-600/25 border-slate-700 text-emerald-300'}">${placedRec ? '✅ Placed' : '✅ Mark Placed'}</button>
              <button id="rm-share-btn" type="button" ${!rState.slip.length ? 'disabled' : ''} class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold disabled:opacity-40">📤 Copy</button>
              <button id="rm-b365-btn" type="button" ${!rState.slip.length ? 'disabled' : ''} class="flex-1 py-2 px-4 rounded-xl btn-bet365 font-extrabold disabled:opacity-40">📋 Build on Bet365</button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('rm-go-cards')?.addEventListener('click', () => {
      state.activeTab = 'racing_cards';
      renderActiveTab();
    });
    document.getElementById('rm-go-tips')?.addEventListener('click', () => {
      state.activeTab = 'racing_tips';
      renderActiveTab();
    });
    document.getElementById('rm-load-lucky15')?.addEventListener('click', async () => {
      try {
        const res = await api('/api/racing/suggest-bet');
        const l15 = (res.cards || []).find((c) => c.structure === 'lucky15') || (res.cards || [])[0];
        if (!l15?.legs?.length) {
          showToast('Not enough distinct races available for a Lucky 15 yet', true);
          return;
        }
        rState.slip = [...l15.legs];
        rState.structure = l15.structure;
        rState.eachWay = Boolean(l15.each_way);
        rState.unitStake = Number(l15.unit_stake || 1.0);
        persistMultiPrefs();
        saveRacingSlip();
        renderRacingMultiplesTab();
        showToast(`Loaded ${l15.title} (${l15.legs.length} picks)`);
      } catch (err) {
        showToast(err.message, true);
      }
    });
    document.getElementById('rm-clear-btn')?.addEventListener('click', () => {
      rState.slip = [];
      saveRacingSlip();
      renderRacingMultiplesTab();
    });
    main.querySelectorAll('[data-rm-remove]').forEach((btn) =>
      btn.addEventListener('click', () => {
        rState.slip.splice(Number(btn.dataset.rmRemove), 1);
        autoAdjustStructureForSlipCount();
        saveRacingSlip();
        renderRacingMultiplesTab();
      })
    );
    const applySlipOdds = (idx) => {
      const inp = main.querySelector(`[data-rm-odds-input="${idx}"]`);
      const dec = parseOddsInput(inp?.value || '');
      if (!dec) {
        showToast('Enter valid fractional or decimal odds (e.g. 5/1 or 6.00)', true);
        return;
      }
      const lg = rState.slip[idx];
      if (!lg) return;
      const pf = Number(lg.place_fraction || 0);
      lg.win_odds = roundNum(dec, 2);
      lg.place_odds = lg.ew_eligible && pf > 0 ? roundNum(1 + (dec - 1) * pf, 3) : 1.0;
      lg.odds = lg.market === 'R_PLC' ? lg.place_odds : lg.win_odds;
      lg.odds_fractional = fmtOdds(lg.odds);
      saveRacingSlip();
      renderRacingMultiplesTab();
      showToast(`Updated ${lg.horse_name} odds to ${fmtOdds(dec)}`);
    };
    main.querySelectorAll('[data-rm-odds-save]').forEach((btn) =>
      btn.addEventListener('click', () => applySlipOdds(Number(btn.dataset.rmOddsSave)))
    );
    main.querySelectorAll('[data-rm-odds-input]').forEach((inp) =>
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          applySlipOdds(Number(inp.dataset.rmOddsInput));
        }
      })
    );
    main.querySelectorAll('[data-rm-struct]').forEach((btn) =>
      btn.addEventListener('click', () => {
        rState.structure = btn.dataset.rmStruct;
        persistMultiPrefs();
        renderRacingMultiplesTab();
      })
    );
    document.getElementById('rm-unit-stake')?.addEventListener('change', (e) => {
      rState.unitStake = Math.max(0.1, Number(e.target.value || 1.0));
      persistMultiPrefs();
      renderRacingMultiplesTab();
    });
    main.querySelectorAll('[data-rm-stake-chip]').forEach((btn) =>
      btn.addEventListener('click', () => {
        rState.unitStake = Number(btn.dataset.rmStakeChip);
        persistMultiPrefs();
        renderRacingMultiplesTab();
      })
    );
    document.getElementById('rm-ew-toggle')?.addEventListener('change', (e) => {
      rState.eachWay = e.target.checked;
      persistMultiPrefs();
      renderRacingMultiplesTab();
    });
    document.getElementById('rm-placed-btn')?.addEventListener('click', () => {
      if (!rState.slip.length) return;
      if (findPlacedByLegs(rState.slip)) {
        unmarkPlacedByLegs(rState.slip);
        showToast('Removed from placed racing bets');
      } else {
        markPlaced(rState.slip, `${rState.eachWay ? 'Each-Way ' : ''}${ev.structure_label}`, ev.total_stake);
        showToast('Marked placed — these races will be excluded in Suggest a Bet!');
      }
      renderRacingMultiplesTab();
    });
    document.getElementById('rm-share-btn')?.addEventListener('click', async () => {
      const exp = buildRacingBet365ExportClient(rState.slip, rState.structure, rState.eachWay, rState.unitStake, 'My AccaLab Racing Bet');
      try {
        await navigator.clipboard?.writeText(exp.clipboard_text);
        showToast('Copied racing multiple summary to clipboard!');
      } catch {
        showToast('Unable to copy summary', true);
      }
    });
    document.getElementById('rm-b365-btn')?.addEventListener('click', () => {
      if (!rState.slip.length) return;
      openRacingBet365Modal(rState.slip, rState.structure, rState.eachWay, rState.unitStake, 'AccaLab Racing Multiple');
    });
  }

  function previewMultipleLines(structure, eachWay) {
    const baseMap = { single: 1, double: 1, treble: 1, acca: 1, trixie: 4, patent: 7, yankee: 11, lucky15: 15 };
    const base = baseMap[String(structure || 'lucky15').toLowerCase()] || 1;
    return base * (eachWay ? 2 : 1);
  }

  async function openRacingSuggestModal() {
    closeAllOverlays('suggest-modal');
    const modal = document.getElementById('suggest-modal');
    const titleEl = document.getElementById('suggest-modal-title');
    const subEl = document.getElementById('suggest-modal-subtitle');
    const body = document.getElementById('suggest-modal-body');
    if (!modal || !body) return;

    titleEl.textContent = '✨ Suggest a Horse Racing Bet';
    subEl.textContent = 'Custom UK Multiples (Lucky 15, Yankee, Trixie, Patent) & Curated Racing Cards by Date Range';
    modal.classList.remove('hidden');
    body.innerHTML = '<div class="text-sm text-slate-400 py-8 text-center">Analysing upcoming racecards...</div>';

    if (!rState.availableDates.length) {
      await refreshOverview();
    }

    const sb = rState.suggest;
    const renderModalContent = async () => {
      const excludedList = sb.excludeAlreadyBet ? collectExcludedRacingLegs() : [];
      if (sb.mode === 'quick') {
        const q = new URLSearchParams();
        if (sb.region && sb.region !== 'ALL') q.set('region', sb.region);
        appendDateRangeParams(q, sb.day, sb.dateFrom, sb.dateTo);
        const res = await api(`/api/racing/suggest-bet${q.toString() ? `?${q.toString()}` : ''}`);
        updateAvailableDatesFromPayload(res);
        const cards = res.cards || [];
        body.innerHTML = `
          <div class="flex flex-wrap gap-2 border-b border-slate-800 pb-3 text-xs">
            <button type="button" data-rs-mode="custom" class="px-3.5 py-2 rounded-xl bg-card border border-slate-700 text-slate-300 font-bold">🛠️ Custom Racing Builder</button>
            <button type="button" data-rs-mode="quick" class="px-3.5 py-2 rounded-xl bg-emerald-500 text-slate-950 font-extrabold">⚡ Quick Racing Cards (${cards.length})</button>
          </div>

          <div class="p-3 rounded-2xl bg-panel border border-slate-800 space-y-2.5 text-xs">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Filter Cards by Date &amp; Region</span>
              <select id="rq-region" class="bg-card border border-slate-700 rounded-xl px-2.5 py-1.5 text-white text-xs">
                <option value="ALL" ${sb.region === 'ALL' ? 'selected' : ''}>🌍 All Regions</option>
                <option value="UK_IRE" ${sb.region === 'UK_IRE' ? 'selected' : ''}>🇬🇧 UK &amp; Ireland</option>
                <option value="FR" ${sb.region === 'FR' ? 'selected' : ''}>🇫🇷 France</option>
                <option value="US" ${sb.region === 'US' ? 'selected' : ''}>🇺🇸 USA</option>
                <option value="AU" ${sb.region === 'AU' ? 'selected' : ''}>🇦🇺 Australia</option>
              </select>
            </div>
            ${renderRacingDateControlsHtml({
              attrName: 'data-rq-day',
              idPrefix: 'rq-date',
              day: sb.day,
              dateFrom: sb.dateFrom,
              dateTo: sb.dateTo,
              availableDates: rState.availableDates,
              compact: true,
            })}
          </div>

          ${cards.length
            ? `<div class="space-y-4">
                ${cards
                  .map((card, cIdx) => {
                    const ev = card.eval;
                    const placed = findPlacedByLegs(card.legs);
                    const whyOpen = rState.expandedCardKeys.has(card.id);
                    return `
                      <div class="p-4 rounded-2xl bg-card border ${placed ? 'border-emerald-500/60' : 'border-slate-800'} space-y-3 text-xs">
                        <div class="flex flex-wrap items-start justify-between gap-2">
                          <div class="min-w-0 flex-1">
                            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-400/40">${esc(card.badge)}</span>
                            <h3 class="text-base font-extrabold text-white mt-1 break-words leading-snug">${esc(card.title)}</h3>
                            <p class="text-[11px] text-slate-400">${esc(card.subtitle)}</p>
                          </div>
                          <div class="text-right font-mono shrink-0">
                            <div class="text-amber-300 font-extrabold text-sm">Max £${ev.max_return.toFixed(2)}</div>
                            <div class="text-[11px] text-slate-400">${ev.total_bets} bets • £${ev.total_stake.toFixed(2)} stake</div>
                          </div>
                        </div>
                        <div class="space-y-1.5">
                          ${card.legs
                            .map(
                              (l) => `
                              <div class="p-2 rounded-xl bg-panel border border-slate-800/90 flex items-center justify-between gap-2">
                                <div class="min-w-0 flex-1 break-words leading-snug">
                                  <span class="font-bold text-white">#${l.saddle_cloth} ${esc(l.horse_name)}</span>
                                  <span class="text-slate-400"> • ${esc(l.off_time)} ${esc(l.course)} • ${esc(formatShortRacingDate(l.race_date))}</span>
                                </div>
                                <span class="font-mono font-bold text-amber-300 shrink-0">${esc(l.odds_fractional)}</span>
                              </div>`
                            )
                            .join('')}
                        </div>
                        <div class="flex flex-wrap gap-2 pt-1">
                          <button type="button" data-rq-why="${esc(card.id)}" class="px-2.5 py-1.5 rounded-lg bg-slate-800 text-cyan-300 font-semibold">${whyOpen ? '▲ Hide Why' : '💡 Why?'}</button>
                          <button type="button" data-rq-load="${cIdx}" class="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold">🎟️ Load to Slip</button>
                          <button type="button" data-rq-b365="${cIdx}" class="flex-1 py-1.5 px-3 rounded-lg btn-bet365 font-extrabold">📋 Build on Bet365</button>
                        </div>
                        ${whyOpen ? renderReasoningDropdownHtml(card.bet_reasons, null, { sport: 'racing', title: `Why AccaLab picked ${card.title}` }) : ''}
                      </div>`;
                  })
                  .join('')}
              </div>`
            : `<div class="p-6 rounded-2xl bg-card border border-slate-800 text-center text-xs text-slate-400 space-y-2.5">
                <div>No quick cards available for the selected date range or region.</div>
                ${(sb.day !== 'all' || sb.region !== 'ALL') ? '<button id="rq-empty-reset" type="button" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-cyan-300 font-bold">Reset Date &amp; Region Filters</button>' : ''}
              </div>`
          }
        `;
        bindRacingDateControls(body, {
          attrName: 'data-rq-day',
          idPrefix: 'rq-date',
          targetObj: sb,
          onUpdate: () => {
            persistSuggestPrefs();
            renderModalContent();
          },
        });
        document.getElementById('rq-region')?.addEventListener('change', (e) => {
          sb.region = e.target.value;
          persistSuggestPrefs();
          renderModalContent();
        });
        document.getElementById('rq-empty-reset')?.addEventListener('click', () => {
          sb.day = 'all';
          sb.dateFrom = '';
          sb.dateTo = '';
          sb.region = 'ALL';
          persistSuggestPrefs();
          renderModalContent();
        });
        body.querySelectorAll('[data-rs-mode]').forEach((btn) =>
          btn.addEventListener('click', () => {
            sb.mode = btn.dataset.rsMode;
            persistSuggestPrefs();
            renderModalContent();
          })
        );
        body.querySelectorAll('[data-rq-why]').forEach((btn) =>
          btn.addEventListener('click', () => {
            const k = btn.dataset.rqWhy;
            if (rState.expandedCardKeys.has(k)) rState.expandedCardKeys.delete(k);
            else rState.expandedCardKeys.add(k);
            renderModalContent();
          })
        );
        body.querySelectorAll('[data-rq-load]').forEach((btn) =>
          btn.addEventListener('click', () => {
            const card = cards[Number(btn.dataset.rqLoad)];
            if (!card) return;
            rState.slip = [...card.legs];
            rState.structure = card.structure;
            rState.eachWay = Boolean(card.each_way);
            rState.unitStake = Number(card.unit_stake || 1);
            persistMultiPrefs();
            saveRacingSlip();
            closeAllOverlays();
            state.activeTab = 'racing_multiples';
            renderActiveTab();
            showToast(`Loaded ${card.title} into Multiples workbench`);
          })
        );
        body.querySelectorAll('[data-rq-b365]').forEach((btn) =>
          btn.addEventListener('click', () => {
            const card = cards[Number(btn.dataset.rqB365)];
            if (!card) return;
            openRacingBet365Modal(card.legs, card.structure, card.each_way, card.unit_stake, card.title);
          })
        );
        return;
      }

      const spec = RACING_MULTIPLES_CLIENT[sb.structure] || RACING_MULTIPLES_CLIENT.lucky15;
      const linesPerBet = previewMultipleLines(sb.structure, sb.eachWay);
      const totalPerBet = linesPerBet * Number(sb.unitStake || 1);
      const cleanStructName = spec.short.split(' (')[0];
      const { dates: availDates, minDate, maxDate } = getRacingDateBounds();
      const sbDayNorm = String(sb.day || 'all').toLowerCase();
      const rsFromVal = cleanIsoDateClient(sb.dateFrom) || minDate;
      const rsToVal = cleanIsoDateClient(sb.dateTo) || maxDate;
      body.innerHTML = `
        <div class="flex flex-wrap gap-2 border-b border-slate-800 pb-3 text-xs">
          <button type="button" data-rs-mode="custom" class="px-3.5 py-2 rounded-xl bg-emerald-500 text-slate-950 font-extrabold">🛠️ Custom Racing Builder</button>
          <button type="button" data-rs-mode="quick" class="px-3.5 py-2 rounded-xl bg-card border border-slate-700 text-slate-300 font-bold">⚡ Quick Racing Cards</button>
        </div>

        <div class="p-4 rounded-2xl bg-card border border-slate-800 space-y-3 text-xs">
          <div>
            <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">1. Bet Structure</div>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              ${Object.entries(RACING_MULTIPLES_CLIENT)
                .map(
                  ([k, sp]) => `
                  <button type="button" data-rs-struct="${k}" class="px-2.5 py-1.5 rounded-xl border text-left transition ${
                    sb.structure === k
                      ? 'bg-emerald-500/20 border-emerald-400 text-white font-bold'
                      : 'bg-panel border-slate-800 text-slate-300 hover:border-slate-600'
                  }">${esc(sp.short)}</button>`
                )
                .join('')}
            </div>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <label class="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-panel border ${sb.eachWay ? 'border-amber-400/60 bg-amber-500/10' : 'border-slate-700'} cursor-pointer">
              <span class="font-bold ${sb.eachWay ? 'text-amber-200' : 'text-slate-300'} leading-tight">Each-Way <span class="text-[10px] font-normal text-slate-400">(Win + Place)</span></span>
              <input id="rs-ew" type="checkbox" ${sb.eachWay ? 'checked' : ''} class="accent-amber-400 shrink-0" />
            </label>
            <label>
              <span class="text-[11px] text-slate-400">Unit Stake (£/bet)</span>
              <input id="rs-unit" type="number" step="0.5" min="0.1" value="${sb.unitStake}" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-1.5 text-white font-mono" />
            </label>
            <label>
              <span class="text-[11px] text-slate-400">Selection Style</span>
              <select id="rs-style" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-1.5 text-white">
                <option value="ALL" ${sb.style === 'ALL' ? 'selected' : ''}>🎲 Mixed (Best Overall)</option>
                <option value="R_WIN" ${sb.style === 'R_WIN' ? 'selected' : ''}>🏆 To Win Contenders</option>
                <option value="R_EW" ${sb.style === 'R_EW' ? 'selected' : ''}>⚖️ Each-Way Value</option>
                <option value="R_PLC" ${sb.style === 'R_PLC' ? 'selected' : ''}>🎯 Place Locks</option>
              </select>
            </label>
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <label>
              <span class="text-[11px] text-slate-400">Risk Profile</span>
              <select id="rs-risk" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-1.5 text-white">
                <option value="low" ${sb.riskLevel === 'low' ? 'selected' : ''}>🛡️ Low Risk</option>
                <option value="medium" ${sb.riskLevel === 'medium' ? 'selected' : ''}>⚖️ Balanced</option>
                <option value="high" ${sb.riskLevel === 'high' ? 'selected' : ''}>🔥 Value Shot</option>
                <option value="longshot" ${sb.riskLevel === 'longshot' ? 'selected' : ''}>🚀 Longshot EW</option>
              </select>
            </label>
            <label>
              <span class="text-[11px] text-slate-400">Region</span>
              <select id="rs-region" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-1.5 text-white">
                <option value="ALL" ${sb.region === 'ALL' ? 'selected' : ''}>All Regions</option>
                <option value="UK_IRE" ${sb.region === 'UK_IRE' ? 'selected' : ''}>🇬🇧 UK &amp; Ireland</option>
                <option value="FR" ${sb.region === 'FR' ? 'selected' : ''}>🇫🇷 France</option>
                <option value="US" ${sb.region === 'US' ? 'selected' : ''}>🇺🇸 USA</option>
                <option value="AU" ${sb.region === 'AU' ? 'selected' : ''}>🇦🇺 Australia</option>
              </select>
            </label>
            <label>
              <span class="text-[11px] text-slate-400">Date Range</span>
              <select id="rs-day" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-1.5 text-white">
                ${RACING_DATE_PRESETS.map(
                  ([dCode, dLbl]) => `<option value="${dCode}" ${sbDayNorm === dCode ? 'selected' : ''}>${dLbl}</option>`
                ).join('')}
              </select>
            </label>
            <label>
              <span class="text-[11px] text-slate-400">${sb.structure === 'acca' ? 'Legs (Acca)' : 'No. of Bets'}</span>
              ${sb.structure === 'acca'
                ? `<select id="rs-legs" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-1.5 text-white">
                    ${[2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${sb.legsCount === n ? 'selected' : ''}>${n}-Fold</option>`).join('')}
                  </select>`
                : `<select id="rs-numbets" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-1.5 text-white">
                    ${[1, 2, 3].map((n) => `<option value="${n}" ${sb.numBets === n ? 'selected' : ''}>${n} Bet${n > 1 ? 's' : ''}</option>`).join('')}
                  </select>`
              }
            </label>
          </div>

          ${sbDayNorm === 'custom'
            ? `<div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5 p-2.5 rounded-xl bg-slate-950/70 border border-slate-800">
                <label>
                  <span class="text-[11px] text-slate-300 font-semibold">From Date</span>
                  <input id="rs-date-from" type="date" value="${esc(rsFromVal)}" min="${esc(minDate)}" max="${esc(maxDate)}" class="mt-1 w-full bg-panel border border-slate-700 rounded-xl px-2.5 py-1.5 text-white font-mono" />
                </label>
                <label>
                  <span class="text-[11px] text-slate-300 font-semibold">To Date${availDates.length ? ` <span class="text-[10px] font-normal text-slate-400">(${esc(formatDateSpanHint(availDates))})</span>` : ''}</span>
                  <input id="rs-date-to" type="date" value="${esc(rsToVal)}" min="${esc(minDate)}" max="${esc(maxDate)}" class="mt-1 w-full bg-panel border border-slate-700 rounded-xl px-2.5 py-1.5 text-white font-mono" />
                </label>
              </div>`
            : ''}

          <div class="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/80">
            <div class="flex flex-wrap items-center gap-2">
              <label class="flex items-center gap-2 cursor-pointer text-slate-200">
                <input id="rs-excl" type="checkbox" ${sb.excludeAlreadyBet ? 'checked' : ''} class="accent-emerald-500" />
                <span>Exclude races already in Slip / Placed (<b>${excludedList.length}</b>)</span>
              </label>
              ${excludedList.length ? `<button id="rs-manage-excl" type="button" class="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[11px] text-cyan-300 font-semibold">${sb.manageOpen ? 'Hide' : 'Manage'}</button>` : ''}
            </div>
            <button id="rs-build-btn" type="button" class="px-5 py-2 rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 text-slate-950 font-extrabold shadow-lg shadow-emerald-500/20">⚡ Build ${sb.eachWay ? 'Each-Way ' : ''}${esc(cleanStructName)} (${linesPerBet} ${linesPerBet === 1 ? 'bet' : 'bets'} • £${totalPerBet.toFixed(2)})</button>
          </div>
          ${sb.manageOpen && excludedList.length
            ? `<div class="p-2.5 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5 max-h-36 overflow-y-auto">
                ${loadPlacedRacingBets()
                  .map(
                    (pb) => `
                    <div class="flex items-start justify-between gap-2 text-[11px]">
                      <span class="text-slate-300 break-words leading-snug">✅ ${esc(pb.title)} (${(pb.legs || []).map((l) => esc(l.horse_name)).join(', ')})</span>
                      <button type="button" data-rs-unmark="${esc(pb.id)}" class="px-2 py-0.5 rounded bg-slate-800 hover:bg-rose-600/30 text-rose-300 shrink-0">Remove</button>
                    </div>`
                  )
                  .join('')}
              </div>`
            : ''}
        </div>

        ${sb.notice ? `<div class="p-3 rounded-xl bg-amber-500/10 border border-amber-500/40 text-amber-200 text-xs">${esc(sb.notice)}</div>` : ''}

        <div id="rs-results" class="space-y-4">
          ${(sb.builtBets || [])
            .map((bet, bIdx) => {
              const ev = bet.eval;
              const placed = findPlacedByLegs(bet.legs);
              const whyBetOpen = rState.expandedCardKeys.has(bet.id);
              return `
                <div class="p-4 rounded-2xl bg-card border ${placed ? 'border-emerald-500/60' : 'border-emerald-500/35'} space-y-3 text-xs">
                  <div class="flex flex-wrap items-start justify-between gap-2">
                    <div class="min-w-0 flex-1">
                      <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-400/40">${esc(bet.badge)}</span>
                      <h4 class="text-base font-extrabold text-white mt-1 break-words leading-snug">${esc(bet.title)}</h4>
                      <p class="text-[11px] text-slate-400">${esc(bet.subtitle)} • Total stake <b class="text-white">£${ev.total_stake.toFixed(2)}</b> (${ev.total_bets} bets)</p>
                    </div>
                    <div class="text-right font-mono shrink-0">
                      <div class="text-emerald-300 font-extrabold text-sm">Max £${ev.max_return.toFixed(2)}</div>
                      ${bet.each_way ? `<div class="text-[11px] text-amber-200">All Place: £${ev.all_place_return.toFixed(2)}</div>` : ''}
                      <div class="text-[11px] text-cyan-300">${ev.prob_any_return_pct}% any return</div>
                    </div>
                  </div>
                  <div class="space-y-1.5">
                    ${bet.legs
                      .map((l, lIdx) => {
                        const rWhyKey = `${bet.id}:${l.runner_id}`;
                        const rWhyOpen = rState.expandedCardKeys.has(rWhyKey);
                        return `
                          <div class="p-2.5 rounded-xl bg-panel border border-slate-800 space-y-1.5">
                            <div class="flex flex-wrap items-center justify-between gap-2">
                              <div class="min-w-0 flex-1">
                                <div class="font-bold text-white break-words leading-snug">${lIdx + 1}. #${l.saddle_cloth} ${esc(l.horse_name)} <span class="text-slate-400 font-normal">(${esc(l.off_time)} ${esc(l.course)} • ${esc(formatShortRacingDate(l.race_date))})</span></div>
                                <div class="text-[11px] text-slate-400">${esc(l.place_terms_label)} • Win ${(Number(l.model_win_prob || 0) * 100).toFixed(1)}% / Place ${(Number(l.model_place_prob || 0) * 100).toFixed(1)}%</div>
                              </div>
                              <div class="flex items-center gap-1.5 shrink-0">
                                <span class="font-mono font-bold text-amber-300">${esc(l.odds_fractional)}</span>
                                <button type="button" data-rs-leg-why="${esc(rWhyKey)}" class="px-2 py-0.5 rounded bg-slate-800 text-cyan-300 text-[10px] font-semibold">${rWhyOpen ? '▲' : '💡 Why?'}</button>
                              </div>
                            </div>
                            ${rWhyOpen ? renderReasoningDropdownHtml(l.reasons, l.reason_stats, { sport: 'racing', title: `Why ${l.horse_name}` }) : ''}
                          </div>`;
                      })
                      .join('')}
                  </div>
                  <div class="flex flex-wrap gap-2 pt-1">
                    <button type="button" data-rs-bet-why="${esc(bet.id)}" class="px-2.5 py-1.5 rounded-lg bg-slate-800 text-cyan-300 font-semibold">${whyBetOpen ? '▲ Hide Summary Why' : '💡 Bet Summary Why?'}</button>
                    <button type="button" data-rs-place="${bIdx}" class="px-2.5 py-1.5 rounded-lg border font-bold ${placed ? 'bg-emerald-500/20 border-emerald-400 text-emerald-200' : 'bg-slate-800 border-slate-700 text-emerald-300'}">${placed ? '✅ Placed' : '✅ Mark Placed'}</button>
                    <button type="button" data-rs-load="${bIdx}" class="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold">🎟️ Load to Multiples</button>
                    <button type="button" data-rs-b365="${bIdx}" class="flex-1 py-1.5 px-3 rounded-lg btn-bet365 font-extrabold">📋 Build on Bet365</button>
                  </div>
                  ${whyBetOpen ? renderReasoningDropdownHtml(bet.bet_reasons, null, { sport: 'racing', title: `Why AccaLab built ${bet.title}` }) : ''}
                </div>`;
            })
            .join('')}
        </div>
      `;

      body.querySelectorAll('[data-rs-mode]').forEach((btn) =>
        btn.addEventListener('click', () => {
          sb.mode = btn.dataset.rsMode;
          persistSuggestPrefs();
          renderModalContent();
        })
      );
      body.querySelectorAll('[data-rs-struct]').forEach((btn) =>
        btn.addEventListener('click', () => {
          sb.structure = btn.dataset.rsStruct;
          persistSuggestPrefs();
          renderModalContent();
        })
      );
      document.getElementById('rs-ew')?.addEventListener('change', (e) => {
        sb.eachWay = e.target.checked;
        persistSuggestPrefs();
        renderModalContent();
      });
      document.getElementById('rs-unit')?.addEventListener('change', (e) => {
        sb.unitStake = Math.max(0.1, Number(e.target.value || 1));
        persistSuggestPrefs();
        renderModalContent();
      });
      document.getElementById('rs-style')?.addEventListener('change', (e) => {
        sb.style = e.target.value;
        persistSuggestPrefs();
      });
      document.getElementById('rs-risk')?.addEventListener('change', (e) => {
        sb.riskLevel = e.target.value;
        persistSuggestPrefs();
      });
      document.getElementById('rs-region')?.addEventListener('change', (e) => {
        sb.region = e.target.value;
        persistSuggestPrefs();
      });
      document.getElementById('rs-day')?.addEventListener('change', (e) => {
        sb.day = e.target.value;
        if (sb.day === 'custom') ensureCustomDateBounds(sb);
        persistSuggestPrefs();
        renderModalContent();
      });
      document.getElementById('rs-date-from')?.addEventListener('change', (e) => {
        sb.dateFrom = cleanIsoDateClient(e.target.value);
        if (sb.dateFrom && sb.dateTo && sb.dateFrom > sb.dateTo) sb.dateTo = sb.dateFrom;
        persistSuggestPrefs();
        renderModalContent();
      });
      document.getElementById('rs-date-to')?.addEventListener('change', (e) => {
        sb.dateTo = cleanIsoDateClient(e.target.value);
        if (sb.dateFrom && sb.dateTo && sb.dateTo < sb.dateFrom) sb.dateFrom = sb.dateTo;
        persistSuggestPrefs();
        renderModalContent();
      });
      document.getElementById('rs-legs')?.addEventListener('change', (e) => {
        sb.legsCount = Number(e.target.value || 4);
        persistSuggestPrefs();
      });
      document.getElementById('rs-numbets')?.addEventListener('change', (e) => {
        sb.numBets = Number(e.target.value || 1);
        persistSuggestPrefs();
      });
      document.getElementById('rs-excl')?.addEventListener('change', (e) => {
        sb.excludeAlreadyBet = e.target.checked;
        persistSuggestPrefs();
        renderModalContent();
      });
      document.getElementById('rs-manage-excl')?.addEventListener('click', () => {
        sb.manageOpen = !sb.manageOpen;
        renderModalContent();
      });
      body.querySelectorAll('[data-rs-unmark]').forEach((btn) =>
        btn.addEventListener('click', () => {
          unmarkPlacedById(btn.dataset.rsUnmark);
          showToast('Removed placed racing bet from exclusions');
          renderModalContent();
        })
      );
      body.querySelectorAll('[data-rs-leg-why], [data-rs-bet-why]').forEach((btn) =>
        btn.addEventListener('click', () => {
          const k = btn.dataset.rsLegWhy || btn.dataset.rsBetWhy;
          if (rState.expandedCardKeys.has(k)) rState.expandedCardKeys.delete(k);
          else rState.expandedCardKeys.add(k);
          renderModalContent();
        })
      );
      body.querySelectorAll('[data-rs-place]').forEach((btn) =>
        btn.addEventListener('click', () => {
          const bet = sb.builtBets[Number(btn.dataset.rsPlace)];
          if (!bet) return;
          if (findPlacedByLegs(bet.legs)) unmarkPlacedByLegs(bet.legs);
          else markPlaced(bet.legs, bet.title, bet.eval.total_stake);
          renderModalContent();
        })
      );
      body.querySelectorAll('[data-rs-load]').forEach((btn) =>
        btn.addEventListener('click', () => {
          const bet = sb.builtBets[Number(btn.dataset.rsLoad)];
          if (!bet) return;
          rState.slip = [...bet.legs];
          rState.structure = bet.structure;
          rState.eachWay = Boolean(bet.each_way);
          rState.unitStake = Number(bet.unit_stake || 1);
          persistMultiPrefs();
          saveRacingSlip();
          closeAllOverlays();
          state.activeTab = 'racing_multiples';
          renderActiveTab();
          showToast(`Loaded ${bet.title} into Multiples workbench`);
        })
      );
      body.querySelectorAll('[data-rs-b365]').forEach((btn) =>
        btn.addEventListener('click', () => {
          const bet = sb.builtBets[Number(btn.dataset.rsB365)];
          if (!bet) return;
          openRacingBet365Modal(bet.legs, bet.structure, bet.each_way, bet.unit_stake, bet.title);
        })
      );
      document.getElementById('rs-build-btn')?.addEventListener('click', async () => {
        const resEl = document.getElementById('rs-results');
        if (resEl) resEl.innerHTML = '<div class="text-xs text-slate-400 py-4 text-center">Building optimal racing combinations...</div>';
        const res = await api('/api/racing/suggest-bet/build', {
          method: 'POST',
          body: JSON.stringify({
            structure: sb.structure,
            each_way: sb.eachWay,
            unit_stake: sb.unitStake,
            style: sb.style,
            risk_level: sb.riskLevel,
            legs_count: sb.legsCount,
            num_bets: sb.numBets,
            region: sb.region,
            day: sbDayNorm,
            date_from: sbDayNorm === 'custom' ? rsFromVal : '',
            date_to: sbDayNorm === 'custom' ? rsToVal : '',
            race_type: sb.raceType,
            exclude_already_bet: sb.excludeAlreadyBet,
            exclude_scope: sb.excludeScope,
            excluded_legs: sb.excludeAlreadyBet ? collectExcludedRacingLegs() : [],
          }),
        });
        updateAvailableDatesFromPayload(res);
        sb.builtBets = res.bets || [];
        sb.notice = res.notice || '';
        renderModalContent();
      });
    };

    await renderModalContent();
    if (!sb.builtBets.length && sb.mode === 'custom') {
      document.getElementById('rs-build-btn')?.click();
    }
  }

  async function openRacingPriceCheckerModal(initialRaceId = null, initialRunnerId = null) {
    closeAllOverlays('suggest-modal');
    const modal = document.getElementById('suggest-modal');
    const titleEl = document.getElementById('suggest-modal-title');
    const subEl = document.getElementById('suggest-modal-subtitle');
    const body = document.getElementById('suggest-modal-body');
    if (!modal || !body) return;

    titleEl.textContent = '⚡ Racing Live Price & Extra Place Checker';
    subEl.textContent = 'Enter Bet365’s live Win price & place terms to calculate instant Win, Place & Each-Way value';
    modal.classList.remove('hidden');
    body.innerHTML = '<div class="text-sm text-slate-400 py-8 text-center">Loading upcoming racecards...</div>';

    const cardsRes = await api('/api/racing/cards');
    const races = cardsRes.races || [];
    if (!races.length) {
      body.innerHTML = '<div class="text-xs text-slate-400 py-6 text-center">No upcoming races loaded yet — run Smart Sync first.</div>';
      return;
    }

    let selRaceId = Number(initialRaceId || rState.selectedRaceId || races[0].id);
    if (!races.some((r) => Number(r.id) === selRaceId)) selRaceId = Number(races[0].id);
    let selRunnerId = Number(initialRunnerId || 0);
    let enteredOdds = '';
    let extraTermsMode = 'standard';

    const computeVerdict = (race, runner, dec, mode) => {
      const pWin = Number(runner.model_win_prob || 0.1);
      const basePlc = Number(runner.model_place_prob || 0.25);
      const stdPlaces = Number(race.places_paid || 3);
      let placesPaid = stdPlaces;
      let pf = Number(race.place_fraction || 0.2);
      if (mode === 'ep4_5') {
        placesPaid = 4;
        pf = 0.2;
      } else if (mode === 'ep5_5') {
        placesPaid = 5;
        pf = 0.2;
      } else if (mode === 'ep4_4') {
        placesPaid = 4;
        pf = 0.25;
      }
      // Adjust place prob conservatively when bookmaker pays extra place(s)
      const pPlcAdj = placesPaid > stdPlaces ? Math.min(0.95, basePlc * (1.0 + 0.14 * (placesPaid - stdPlaces))) : basePlc;
      const winEv = (pWin * dec - 1.0) * 100.0;
      const plcOdds = pf > 0 ? 1.0 + (dec - 1.0) * pf : 1.0;
      const plcEv = pf > 0 ? (pPlcAdj * plcOdds - 1.0) * 100.0 : winEv;
      const ewEv = pf > 0 ? 0.5 * (winEv + plcEv) : winEv;

      let badge = '🔴 Poor Value — Skip';
      let badgeCls = 'text-rose-300';
      if (winEv >= 6) {
        badge = '✅ Strong Back Win';
        badgeCls = 'text-emerald-300';
      } else if (ewEv >= 5 && pf > 0) {
        badge = '✅ Strong Each-Way Value';
        badgeCls = 'text-emerald-300';
      } else if (winEv >= 0 || (ewEv >= 0 && pf > 0)) {
        badge = '🟡 Fair / Slight Edge';
        badgeCls = 'text-amber-300';
      }
      return { winEv, plcEv, ewEv, plcOdds, pPlcAdj, placesPaid, pf, badge, badgeCls };
    };

    const render = () => {
      const race = races.find((r) => Number(r.id) === Number(selRaceId)) || races[0];
      const runners = race.runners || [];
      if (!runners.some((rn) => Number(rn.runner_id) === Number(selRunnerId))) {
        selRunnerId = Number(runners[0]?.runner_id || 0);
      }
      const runner = runners.find((rn) => Number(rn.runner_id) === Number(selRunnerId)) || runners[0];
      const activeOdds = parseOddsInput(enteredOdds) || Number(runner.win_odds || 4.0);
      const v = computeVerdict(race, runner, activeOdds, extraTermsMode);

      body.innerHTML = `
        <div class="space-y-3 text-xs">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <label>
              <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Race</span>
              <select id="rcp-race" class="mt-1 w-full bg-panel border border-slate-700 rounded-xl px-3 py-2 text-white">
                ${races.map((r) => `<option value="${r.id}" ${Number(r.id) === Number(race.id) ? 'selected' : ''}>${esc(r.off_time)} ${esc(r.course)} (${esc(r.race_date)})</option>`).join('')}
              </select>
            </label>
            <label>
              <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Runner</span>
              <select id="rcp-runner" class="mt-1 w-full bg-panel border border-slate-700 rounded-xl px-3 py-2 text-white">
                ${runners.map((rn) => `<option value="${rn.runner_id}" ${Number(rn.runner_id) === Number(runner.runner_id) ? 'selected' : ''}>#${rn.saddle_cloth} ${esc(rn.horse_name)} (${rn.model_win_prob_pct}% • Est. ${esc(rn.odds_fractional)})</option>`).join('')}
              </select>
            </label>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <label>
              <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Bet365 Live Win Price</span>
              <input id="rcp-odds" type="text" value="${esc(enteredOdds || fmtOdds(runner.win_odds))}" placeholder="e.g. 5/1, 11/2 or 6.50" class="mt-1 w-full bg-panel border border-slate-700 rounded-xl px-3 py-2 text-white font-mono" />
            </label>
            <label>
              <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400">Place Terms</span>
              <select id="rcp-terms" class="mt-1 w-full bg-panel border border-slate-700 rounded-xl px-3 py-2 text-white">
                <option value="standard" ${extraTermsMode === 'standard' ? 'selected' : ''}>Race Standard (${esc(race.place_terms_label)})</option>
                <option value="ep4_5" ${extraTermsMode === 'ep4_5' ? 'selected' : ''}>Bet365 Extra Place: 1/5 Odds (4 Places)</option>
                <option value="ep5_5" ${extraTermsMode === 'ep5_5' ? 'selected' : ''}>Bet365 Extra Place: 1/5 Odds (5 Places)</option>
                <option value="ep4_4" ${extraTermsMode === 'ep4_4' ? 'selected' : ''}>Enhanced Terms: 1/4 Odds (4 Places)</option>
              </select>
            </label>
          </div>

          <div class="flex flex-wrap gap-1.5">
            ${['2/1', '5/2', '3/1', '7/2', '4/1', '5/1', '6/1', '8/1', '10/1', '12/1']
              .map(
                (p) => `<button type="button" data-rcp-chip="${p}" class="px-2 py-1 rounded-lg bg-panel hover:bg-amber-500/20 border border-slate-700 text-amber-200 font-mono text-[11px] font-bold">${p}</button>`
              )
              .join('')}
          </div>

          <div class="p-4 rounded-2xl bg-slate-950/90 border border-slate-800 space-y-2.5">
            <div class="flex items-center justify-between">
              <span class="text-sm font-extrabold ${v.badgeCls}">${v.badge}</span>
              <span class="font-mono text-slate-300">Price: <b class="text-amber-300">${fmtOdds(activeOdds)}</b> (${activeOdds.toFixed(2)})</span>
            </div>
            <div class="grid grid-cols-3 gap-2 text-center pt-1">
              <div class="p-2 rounded-xl bg-panel border border-slate-800">
                <div class="text-[10px] text-slate-400">Win Value</div>
                <div class="font-mono font-extrabold text-sm ${v.winEv >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${v.winEv >= 0 ? '+' : ''}${v.winEv.toFixed(1)}%</div>
                <div class="text-[10px] text-slate-500">Fair ${esc(runner.fair_win_odds_fractional)}</div>
              </div>
              <div class="p-2 rounded-xl bg-panel border border-slate-800">
                <div class="text-[10px] text-slate-400">Place Value (${v.placesPaid} plc)</div>
                <div class="font-mono font-extrabold text-sm ${v.plcEv >= 0 ? 'text-emerald-400' : 'text-amber-300'}">${v.plcEv >= 0 ? '+' : ''}${v.plcEv.toFixed(1)}%</div>
                <div class="text-[10px] text-slate-500">Place @ ${fmtOdds(v.plcOdds)}</div>
              </div>
              <div class="p-2 rounded-xl bg-panel border border-slate-800">
                <div class="text-[10px] text-slate-400">Each-Way Value</div>
                <div class="font-mono font-extrabold text-sm ${v.ewEv >= 0 ? 'text-emerald-400' : 'text-amber-300'}">${v.ewEv >= 0 ? '+' : ''}${v.ewEv.toFixed(1)}%</div>
                <div class="text-[10px] text-slate-500">Place ${(v.pPlcAdj * 100).toFixed(1)}%</div>
              </div>
            </div>
          </div>

          <div class="flex flex-wrap gap-2">
            <button id="rcp-save-price" type="button" class="px-3.5 py-2 rounded-xl bg-emerald-600/25 hover:bg-emerald-500/35 border border-emerald-500/40 text-emerald-200 font-bold">💾 Save Live Price</button>
            <button id="rcp-add-win" type="button" class="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold">+ Add Win</button>
            <button id="rcp-add-ew" type="button" class="flex-1 py-2 px-4 rounded-xl btn-bet365 font-extrabold">+ Add Each-Way to Slip</button>
          </div>
        </div>
      `;

      document.getElementById('rcp-race')?.addEventListener('change', (e) => {
        selRaceId = Number(e.target.value);
        enteredOdds = '';
        render();
      });
      document.getElementById('rcp-runner')?.addEventListener('change', (e) => {
        selRunnerId = Number(e.target.value);
        enteredOdds = '';
        render();
      });
      document.getElementById('rcp-terms')?.addEventListener('change', (e) => {
        extraTermsMode = e.target.value;
        render();
      });
      document.getElementById('rcp-odds')?.addEventListener('input', (e) => {
        enteredOdds = e.target.value;
      });
      document.getElementById('rcp-odds')?.addEventListener('change', render);
      body.querySelectorAll('[data-rcp-chip]').forEach((btn) =>
        btn.addEventListener('click', () => {
          enteredOdds = btn.dataset.rcpChip;
          render();
        })
      );
      document.getElementById('rcp-save-price')?.addEventListener('click', async () => {
        const val = document.getElementById('rcp-odds')?.value?.trim() || enteredOdds;
        try {
          await api(`/api/racing/runner/${runner.runner_id}/odds`, {
            method: 'POST',
            body: JSON.stringify({ odds: val }),
          });
          showToast(`Saved ${runner.horse_name} live Bet365 price!`);
          renderActiveTab();
          openRacingPriceCheckerModal(race.id, runner.runner_id);
        } catch (err) {
          showToast(err.message, true);
        }
      });
      const pushCheckerLeg = (mkt) => {
        const leg = makeLegFromRunner(
          {
            ...runner,
            win_odds: roundNum(activeOdds, 2),
            place_odds: roundNum(v.plcOdds, 3),
            place_fraction: v.pf,
            places_paid: v.placesPaid,
            ew_eligible: v.pf > 0,
            model_place_prob: roundNum(v.pPlcAdj, 5),
          },
          race,
          mkt
        );
        addLegToRacingSlip(leg);
        closeAllOverlays();
        state.activeTab = 'racing_multiples';
        renderActiveTab();
      };
      document.getElementById('rcp-add-win')?.addEventListener('click', () => pushCheckerLeg('R_WIN'));
      document.getElementById('rcp-add-ew')?.addEventListener('click', () => pushCheckerLeg(v.pf > 0 ? 'R_EW' : 'R_WIN'));
    };

    render();
  }

  return {
    renderRacingCardsTab,
    renderRacingTipsTab,
    renderRacingMultiplesTab,
    openSuggestModal: openRacingSuggestModal,
    openPriceCheckerModal: openRacingPriceCheckerModal,
    refreshOverview,
    staticApi: racingStaticApi,
    getSlipCount: () => rState.slip.length,
    syncBadges: () => saveRacingSlip(),
  };
}
