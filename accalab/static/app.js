// AccaLab Frontend PWA Application

const state = {
  activeTab: 'fixtures',
  activeDiv: 'ALL',
  search: '',
  activeUserId: Number(localStorage.getItem('accalab_user_id') || 1),
  authenticated: false,
  dashboard: null,
  favouriteTeams: [],
  preferredLeagues: ['E0', 'E1', 'E2', 'E3'],
  watchedIds: [],
  valMyPrefsOnly: false,
  newsMyClubsOnly: false,
  slip: JSON.parse(localStorage.getItem('accalab_slip') || '[]'),
  slipStake: Number(localStorage.getItem('accalab_slip_stake') || 10),
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

function showToast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `fixed bottom-20 lg:bottom-6 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-xl text-white text-sm font-medium shadow-xl z-50 ${
    isError ? 'bg-rose-600' : 'bg-emerald-600'
  }`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3400);
}

async function api(path, opts = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const url = path.startsWith('/api/') ? `${path}${sep}user_id=${state.activeUserId}` : path;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', 'X-User-Id': String(state.activeUserId) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function saveSlip(syncServer = true) {
  localStorage.setItem('accalab_slip', JSON.stringify(state.slip));
  localStorage.setItem('accalab_slip_stake', String(state.slipStake));
  document.getElementById('slip-count-badge').textContent = String(state.slip.length);
  if (syncServer && state.dashboard) {
    api('/api/user/slip', {
      method: 'PUT',
      body: JSON.stringify({ legs: state.slip, stake: state.slipStake }),
    }).catch(() => {});
  }
}

async function toggleWatchFixture(fixtureId) {
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
  }
}

async function toggleFavouriteTeam(teamName) {
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
  }
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
  showToast(`Added ${leg.selection_label} @ ${Number(leg.odds).toFixed(2)}`);
}

function removeLegFromSlip(idx) {
  state.slip.splice(idx, 1);
  saveSlip();
  renderSlip();
  if (state.activeTab === 'acca') renderAccaTab();
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
          <div class="text-xs text-emerald-400 mt-0.5">Odds: <b>${Number(leg.odds).toFixed(2)}</b> • Model ${(Number(leg.model_prob) * (leg.model_prob > 1 ? 1 : 100)).toFixed(1)}%</div>
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
      <div class="text-slate-400">Combined Odds: <b class="text-white">${evalData.combined_odds.toFixed(2)}</b></div>
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
  });
  document.getElementById('slip-save-draft-btn').addEventListener('click', async () => {
    const customName = document.getElementById('slip-notes-input').value.trim();
    const res = await api('/api/user/saved-accas', {
      method: 'POST',
      body: JSON.stringify({
        name: customName || `Saved ${state.slip.length}-Fold (${evalData.combined_odds.toFixed(2)})`,
        stake: state.slipStake,
        legs: state.slip,
      }),
    });
    showToast(`Saved draft "${res.saved_acca.name}" to your account!`);
    if (state.activeTab === 'acca') renderAccaTab();
  });
  document.getElementById('slip-place-btn').addEventListener('click', async () => {
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
  if (d.active_user) {
    state.activeUserId = d.active_user.id;
    localStorage.setItem('accalab_user_id', String(state.activeUserId));
    state.favouriteTeams = d.active_user.favourite_teams || [];
    state.preferredLeagues = d.active_user.preferred_leagues || ['E0', 'E1', 'E2', 'E3'];
    if (syncSlipFromServer) {
      state.slip = Array.isArray(d.active_user.active_slip) ? d.active_user.active_slip : [];
      state.slipStake = Number(d.active_user.default_stake || 10);
    }
  } else if (!d.users.find((u) => u.id === state.activeUserId) && d.users.length) {
    state.activeUserId = d.users[0].id;
    localStorage.setItem('accalab_user_id', String(state.activeUserId));
  }
  state.watchedIds = d.watched_fixture_ids || [];

  const avatarEl = document.getElementById('sidebar-avatar');
  if (avatarEl && d.active_user) {
    avatarEl.style.backgroundColor = d.active_user.avatar_color || '#10b981';
    avatarEl.textContent = (d.active_user.display_name || d.active_user.username || '?')
      .trim()
      .slice(0, 2)
      .toUpperCase();
  }
  const usernameEl = document.getElementById('sidebar-username');
  if (usernameEl && d.active_user) {
    usernameEl.textContent = d.active_user.display_name || d.active_user.username;
  }
  const authStatusEl = document.getElementById('sidebar-auth-status');
  if (authStatusEl) {
    authStatusEl.textContent = d.authenticated
      ? `Signed in • ${(d.favourite_teams || []).length} clubs`
      : 'Demo mode • Sign in';
    authStatusEl.className = `text-[11px] truncate ${
      d.authenticated ? 'text-emerald-400' : 'text-amber-300'
    }`;
  }

  const optionsHtml = d.users
    .map(
      (u) =>
        `<option value="${u.id}" ${u.id === state.activeUserId ? 'selected' : ''}>${esc(u.display_name)} (${fmtGbp(u.bankroll)})</option>`
    )
    .join('');
  document.getElementById('user-switcher').innerHTML = optionsHtml;
  document.getElementById('user-switcher-mobile').innerHTML = optionsHtml;
  document.getElementById('sidebar-bankroll').textContent = fmtGbp(d.active_user.bankroll);

  const badge = document.getElementById('sidebar-alert-badge');
  if (d.counts.unread_alerts > 0) {
    badge.textContent = String(d.counts.unread_alerts);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  const pnlColor = d.user_summary.total_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400';
  document.getElementById('kpi-strip').innerHTML = `
    <span class="px-2.5 py-1 rounded-full bg-card border border-slate-700">Matches DB: <b class="text-white">${d.counts.historical_matches.toLocaleString()}</b></span>
    <span class="px-2.5 py-1 rounded-full bg-card border border-slate-700">Upcoming: <b class="text-white">${d.counts.upcoming_fixtures}</b> (${d.counts.official_b365_fixtures} Bet365)</span>
    <span class="px-2.5 py-1 rounded-full bg-card border border-slate-700">Value Picks: <b class="text-emerald-400">${d.top_value_bets.length}+</b></span>
    <span class="px-2.5 py-1 rounded-full bg-card border border-slate-700">Saved: <b class="text-amber-300">${d.counts.watched_fixtures || 0}</b> ★ / <b class="text-sky-300">${d.counts.saved_accas || 0}</b> accas</span>
    <span class="px-2.5 py-1 rounded-full bg-card border border-slate-700">Your P&amp;L: <b class="${pnlColor}">${d.user_summary.total_pnl >= 0 ? '+' : ''}${fmtGbp(d.user_summary.total_pnl)}</b></span>
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

  main.innerHTML = `
    <div class="flex flex-col md:flex-row md:items-center justify-between gap-3">
      <div>
        <h2 class="text-xl font-bold text-white">Upcoming English Match Previews</h2>
        <p class="text-xs text-slate-400 mt-0.5">Dixon-Coles Poisson + Elo probabilities vs Bet365 &amp; market prices across EPL–League Two</p>
      </div>
      <input id="fixture-search" type="search" value="${esc(state.search)}" placeholder="Search club..." class="w-full md:w-64 bg-panel border border-slate-700 rounded-xl px-3 py-2 text-sm text-white" />
    </div>

    <div class="flex flex-wrap gap-2">
      ${divTabs
        .map(
          ([code, label]) => `
        <button data-div="${code}" class="div-pill px-3 py-1.5 rounded-xl text-xs font-semibold border transition ${
          state.activeDiv === code
            ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
            : 'bg-panel text-slate-300 border-slate-700 hover:bg-slate-800'
        }">${label}</button>`
        )
        .join('')}
    </div>

    ${forYouHtml}

    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      ${
        data.fixtures.length
          ? data.fixtures
              .map((f) => {
                const best = f.best_edge || {};
                const hasEdge = best.edge_pct >= 3.0;
                const isWatched = Boolean(f.is_watched || state.watchedIds.includes(f.id));
                const homeFav = state.favouriteTeams.includes(f.home_team);
                const awayFav = state.favouriteTeams.includes(f.away_team);
                const isFavMatch = Boolean(f.is_favourite_match || homeFav || awayFav);
                return `
          <div class="bg-panel border ${isFavMatch ? 'border-amber-500/40' : 'border-slate-800'} hover:border-slate-600 rounded-2xl p-4 flex flex-col justify-between gap-3 transition">
            <div>
              <div class="flex items-center justify-between gap-2 text-xs">
                <span class="font-semibold text-emerald-400 truncate">${esc(f.league_name)} • ${esc(f.match_date)} ${esc(f.kickoff_time || '')}</span>
                <div class="flex items-center gap-1.5 shrink-0">
                  <button data-watch-fid="${f.id}" title="Save to Watchlist" class="px-2 py-0.5 rounded-full text-[10px] font-semibold border transition ${
                    isWatched
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
                    <span class="text-xs font-normal text-slate-400">(${Math.round(f.home_elo || 1500)})</span>
                  </div>
                  <div class="mt-1">${formBadges(f.home_form)}</div>
                </div>
                <div class="text-xs font-bold text-slate-500 px-2">vs</div>
                <div class="min-w-0 text-right">
                  <div class="font-bold text-white truncate flex items-center justify-end gap-1">
                    <span class="text-xs font-normal text-slate-400">(${Math.round(f.away_elo || 1500)})</span>
                    <span class="truncate">${esc(f.away_team)}</span>
                    <button data-fav-team="${esc(f.away_team)}" title="Follow ${esc(f.away_team)}" class="text-xs leading-none ${awayFav ? 'text-amber-300' : 'text-slate-600 hover:text-amber-300'}">${awayFav ? '★' : '☆'}</button>
                  </div>
                  <div class="mt-1 flex justify-end gap-1">${formBadges(f.away_form)}</div>
                </div>
              </div>

              <!-- Probability Bar -->
              <div class="mt-3">
                <div class="flex justify-between text-[11px] text-slate-400 mb-1">
                  <span>H ${(f.prob_home * 100).toFixed(0)}%</span>
                  <span>D ${(f.prob_draw * 100).toFixed(0)}%</span>
                  <span>A ${(f.prob_away * 100).toFixed(0)}%</span>
                </div>
                <div class="h-2 rounded-full overflow-hidden flex bg-slate-800">
                  <div style="width:${f.prob_home * 100}%" class="bg-emerald-500"></div>
                  <div style="width:${f.prob_draw * 100}%" class="bg-amber-400"></div>
                  <div style="width:${f.prob_away * 100}%" class="bg-sky-500"></div>
                </div>
              </div>

              <!-- Quick Bet365 / Market Buttons -->
              <div class="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                <button data-add-leg='${esc(JSON.stringify({ fixture_id: f.id, div: f.div, match_date: f.match_date, home_team: f.home_team, away_team: f.away_team, market: "1X2_H", selection_label: `${f.home_team} Win`, odds: f.b365h, model_prob: f.prob_home }))}' class="quick-leg py-1.5 rounded-lg bg-card hover:bg-slate-700 border border-slate-700">
                  <div class="text-[10px] text-slate-400">Home</div>
                  <div class="font-bold text-white">${f.b365h ? Number(f.b365h).toFixed(2) : '—'}</div>
                </button>
                <button data-add-leg='${esc(JSON.stringify({ fixture_id: f.id, div: f.div, match_date: f.match_date, home_team: f.home_team, away_team: f.away_team, market: "1X2_D", selection_label: "Draw", odds: f.b365d, model_prob: f.prob_draw }))}' class="quick-leg py-1.5 rounded-lg bg-card hover:bg-slate-700 border border-slate-700">
                  <div class="text-[10px] text-slate-400">Draw</div>
                  <div class="font-bold text-white">${f.b365d ? Number(f.b365d).toFixed(2) : '—'}</div>
                </button>
                <button data-add-leg='${esc(JSON.stringify({ fixture_id: f.id, div: f.div, match_date: f.match_date, home_team: f.home_team, away_team: f.away_team, market: "1X2_A", selection_label: `${f.away_team} Win`, odds: f.b365a, model_prob: f.prob_away }))}' class="quick-leg py-1.5 rounded-lg bg-card hover:bg-slate-700 border border-slate-700">
                  <div class="text-[10px] text-slate-400">Away</div>
                  <div class="font-bold text-white">${f.b365a ? Number(f.b365a).toFixed(2) : '—'}</div>
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
      <button id="modal-watch-btn" type="button" class="px-3 py-1.5 rounded-lg border font-semibold transition ${
        isWatched
          ? 'bg-amber-500/20 border-amber-400 text-amber-200'
          : 'bg-card border-slate-700 text-slate-300 hover:border-slate-500'
      }">${isWatched ? '🔖 In Watchlist' : '☆ Watch Match'}</button>
      <button type="button" data-modal-fav="${esc(f.home_team)}" class="px-3 py-1.5 rounded-lg border font-semibold transition ${
        homeFav
          ? 'bg-amber-500/20 border-amber-400 text-amber-200'
          : 'bg-card border-slate-700 text-slate-300 hover:border-slate-500'
      }">${homeFav ? '★ Following' : '☆ Follow'} ${esc(f.home_team)}</button>
      <button type="button" data-modal-fav="${esc(f.away_team)}" class="px-3 py-1.5 rounded-lg border font-semibold transition ${
        awayFav
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
                <td class="py-2 px-2 text-right font-mono">${m.fair_odds.toFixed(2)}</td>
                <td class="py-2 px-2 text-right font-mono font-bold text-white">${m.b365_odds ? m.b365_odds.toFixed(2) : '—'}</td>
                <td class="py-2 px-2 text-right ${edgeCls}">${m.edge_pct >= 0 ? '+' : ''}${m.edge_pct}%</td>
                <td class="py-2 px-2 text-right text-slate-300">${m.suggested_stake > 0 ? fmtGbp(m.suggested_stake) : '—'}</td>
                <td class="py-2 pl-2 text-right">
                  ${
                    m.b365_odds
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
          ${
            d.h2h.length
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
        <h4 class="font-bold text-white text-sm">Update Live Bet365 Odds</h4>
        <div class="grid grid-cols-3 gap-2 text-xs">
          <label>Home <input id="edit-b365h" type="number" step="0.01" value="${f.b365h || ''}" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-white"/></label>
          <label>Draw <input id="edit-b365d" type="number" step="0.01" value="${f.b365d || ''}" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-white"/></label>
          <label>Away <input id="edit-b365a" type="number" step="0.01" value="${f.b365a || ''}" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-white"/></label>
          <label>O2.5 <input id="edit-b365o25" type="number" step="0.01" value="${f.b365_over25 || ''}" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-white"/></label>
          <label>U2.5 <input id="edit-b365u25" type="number" step="0.01" value="${f.b365_under25 || ''}" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-white"/></label>
          <label>BTTS Y <input id="edit-b365by" type="number" step="0.01" value="${f.b365_btts_yes || ''}" class="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-white"/></label>
        </div>
        <button id="save-odds-btn" class="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold">Save Bet365 Odds &amp; Recalculate Edge</button>

        <div class="pt-2 border-t border-slate-800 space-y-1.5">
          <h5 class="font-semibold text-white text-xs">Club News (BBC / Sky / Guardian RSS)</h5>
          ${
            d.matched_news.length
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
          ${
            opps.length
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
                <td class="p-3 text-right font-mono font-bold text-white">${o.odds.toFixed(2)}</td>
                <td class="p-3 text-right">${o.model_prob_pct}% <span class="text-slate-400">(${o.fair_odds.toFixed(2)})</span></td>
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
        <div class="bg-panel border border-slate-800 rounded-2xl p-4 flex flex-col justify-between gap-3">
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
                    <div class="text-emerald-400 font-bold">${l.odds.toFixed(2)}</div>
                    <div class="text-[10px] text-slate-400">${(l.model_prob * 100).toFixed(0)}%</div>
                  </div>
                </div>`
                )
                .join('')}
            </div>
          </div>
          <div class="pt-3 border-t border-slate-800 space-y-2 text-xs">
            <div class="flex justify-between">
              <span class="text-slate-400">Combined Odds: <b class="text-white">${p.combined_odds.toFixed(2)}</b></span>
              <span class="text-slate-400">Hit Prob: <b class="text-white">${p.combined_model_prob_pct}%</b></span>
            </div>
            <button data-load-preset='${esc(JSON.stringify(p.legs))}' class="load-preset-btn w-full py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold">Load into Bet Slip</button>
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
      ${
        savedAccas.length
          ? `<div class="grid grid-cols-1 md:grid-cols-2 gap-3">
              ${savedAccas
                .map(
                  (a) => `
                <div class="p-3.5 rounded-xl bg-card border border-slate-800 flex flex-col justify-between gap-2.5 text-xs">
                  <div>
                    <div class="flex items-center justify-between gap-2">
                      <span class="font-bold text-white truncate">${esc(a.name)}</span>
                      <span class="px-2 py-0.5 rounded-full font-bold ${a.ev_pct >= 0 ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'}">${a.ev_pct >= 0 ? '+' : ''}${Number(a.ev_pct).toFixed(1)}% EV</span>
                    </div>
                    <div class="text-[11px] text-slate-400 mt-1">${(a.legs || []).length} legs • Combined <b class="text-emerald-400">${Number(a.combined_odds).toFixed(2)}</b> • Stake ${fmtGbp(a.stake)} • Saved ${esc((a.created_at || '').slice(0, 10))}</div>
                    <div class="mt-2 space-y-1">
                      ${(a.legs || [])
                        .map(
                          (l) => `<div class="text-[11px] text-slate-300 flex justify-between gap-2"><span class="truncate">${esc(l.selection_label)} (${esc(l.home_team)} vs ${esc(l.away_team)})</span><span class="font-mono text-slate-400">@ ${Number(l.odds || 0).toFixed(2)}</span></div>`
                        )
                        .join('')}
                    </div>
                  </div>
                  <div class="flex gap-2 pt-2 border-t border-slate-800">
                    <button type="button" data-load-saved='${esc(JSON.stringify({ legs: a.legs, stake: a.stake }))}' class="flex-1 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold">Load to Slip</button>
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
      ${
        slipEval
          ? `
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mb-3">
          <div class="p-3 rounded-xl bg-card border border-slate-800"><div class="text-slate-400">Legs</div><div class="text-lg font-bold text-white">${slipEval.leg_count}</div></div>
          <div class="p-3 rounded-xl bg-card border border-slate-800"><div class="text-slate-400">Combined Odds</div><div class="text-lg font-bold text-emerald-400">${slipEval.combined_odds.toFixed(2)}</div></div>
          <div class="p-3 rounded-xl bg-card border border-slate-800"><div class="text-slate-400">Model Fair Odds</div><div class="text-lg font-bold text-white">${slipEval.fair_combined_odds.toFixed(2)}</div></div>
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
          ${
            data.by_league.length
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
          ${
            data.bets.length
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
                <td class="p-3 text-right font-mono">${b.combined_odds.toFixed(2)}</td>
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
          ${data.leaderboard
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
            .join('')}
        </tbody>
      </table>
    </div>

    <div class="bg-panel border border-slate-800 rounded-2xl p-5 max-w-lg space-y-3">
      <h3 class="text-sm font-bold text-white">Invite a Friend</h3>
      <p class="text-xs text-slate-400">Default invite code in <code>.env</code> is <code>ACCALAB2026</code>.</p>
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

        <div class="pt-3 border-t border-slate-800 space-y-1.5 text-xs">
          <div class="flex justify-between"><span class="text-slate-400">API-Football Daily Budget:</span><b class="text-white">${d.counts.api_football_calls_today} / 100 calls today</b></div>
          <div class="flex justify-between"><span class="text-slate-400">API-Football Key:</span><b class="${d.integrations.api_football_configured ? 'text-emerald-400' : 'text-amber-300'}">${d.integrations.api_football_configured ? 'Configured' : 'Not set (using free CSVs)'}</b></div>
          <div class="flex justify-between"><span class="text-slate-400">Gemini Flash API:</span><b class="${d.integrations.gemini_configured ? 'text-emerald-400' : 'text-amber-300'}">${d.integrations.gemini_configured ? 'Configured' : 'Not set (using built-in analyst)'}</b></div>
        </div>
      </div>

      <!-- Alerts Feed -->
      <div class="bg-panel border border-slate-800 rounded-2xl p-4 space-y-2 max-h-96 overflow-y-auto scrollbar-thin">
        <h3 class="text-sm font-bold text-white">Value &amp; System Alerts</h3>
        ${
          alertsRes.alerts.length
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
        ${
          filteredNews.length
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
                    return `<button type="button" data-pref-team="${esc(t)}" class="px-2.5 py-1 rounded-full text-[11px] border transition ${
                      on
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

  document.getElementById('settings-auth-btn').addEventListener('click', () => openAuthModal('login'));
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

  document.getElementById('run-full-sync-btn').addEventListener('click', () => triggerSync(true));
}

async function triggerSync(withBacktest = false) {
  showToast('Syncing live football data & refitting models...');
  try {
    const res = await api('/api/sync', { method: 'POST', body: JSON.stringify({ run_backtest: withBacktest }) });
    await loadDashboard();
    renderActiveTab();
    showToast(`Synced ${res.summary.counts.historical_matches} matches & ${res.summary.counts.upcoming_fixtures} upcoming fixtures!`);
  } catch (err) {
    showToast(`Sync error: ${err.message}`, true);
  }
}

async function renderActiveTab() {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    const active = btn.dataset.tab === state.activeTab;
    btn.className = `nav-btn w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-medium ${
      active ? 'bg-emerald-500/15 text-emerald-400' : 'text-slate-300 hover:bg-slate-800/70'
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

      <form id="auth-login-form" class="space-y-3">
        <div>
          <label class="block text-xs text-slate-400 mb-1">Username or Email</label>
          <input id="login-username" type="text" required placeholder="e.g. admin" class="w-full px-3 py-2 rounded-lg bg-surface border border-slate-700 text-sm text-white" />
        </div>
        <div>
          <label class="block text-xs text-slate-400 mb-1">Password</label>
          <input id="login-password" type="password" required placeholder="••••••••" class="w-full px-3 py-2 rounded-lg bg-surface border border-slate-700 text-sm text-white" />
        </div>
        <button type="submit" class="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm">Log In to My Account</button>
      </form>

      ${users.length ? `
        <div class="mt-4 pt-4 border-t border-slate-800">
          <div class="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-2">Quick Demo Sign-In (password: accalab)</div>
          <div class="flex flex-wrap gap-1.5">
            ${users.map((usr) => `
              <button type="button" data-quick-login="${esc(usr.username)}" class="px-2.5 py-1.5 rounded-lg bg-surface border border-slate-700 hover:border-emerald-500/50 text-xs text-slate-200 flex items-center gap-1.5">
                <span class="w-2 h-2 rounded-full" style="background:${esc(usr.avatar_color || '#10b981')}"></span>
                ${esc(usr.display_name)}
              </button>
            `).join('')}
          </div>
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

    body.querySelectorAll('[data-quick-login]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        try {
          const res = await api('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username: btn.dataset.quickLogin, password: 'accalab' }),
          });
          state.activeUserId = res.user.id;
          localStorage.setItem('accalab_user_id', String(state.activeUserId));
          document.getElementById('auth-modal').classList.add('hidden');
          await loadDashboard(true);
          saveSlip(false);
          await renderActiveTab();
          showToast(`Signed in as ${res.user.display_name}`);
        } catch (err) {
          showToast(err.message, true);
        }
      })
    );

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
          <label class="block text-xs text-slate-400 mb-1">Group Invite Code</label>
          <input id="reg-invite" type="text" value="ACCALAB2026" class="w-full px-3 py-2 rounded-lg bg-surface border border-slate-700 text-xs text-white" />
        </div>
        <div>
          <label class="block text-xs text-slate-400 mb-1">Starting Bankroll (£)</label>
          <input id="reg-bankroll" type="number" min="10" step="10" value="250" class="w-full px-3 py-2 rounded-lg bg-surface border border-slate-700 text-xs text-white" />
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

      <button type="submit" class="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm">Create Account &amp; Personalise App</button>
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
              return `<button type="button" data-reg-team="${esc(t)}" class="px-2 py-0.5 rounded-full text-[11px] border transition ${
                on
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

function openAuthModal(initialMode = 'login') {
  renderAuthModalBody(initialMode);
  document.getElementById('auth-modal').classList.remove('hidden');
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
      await api('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
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
    openAuthSidebar.addEventListener('click', () => openAuthModal('login'));
  }
  const openAuthMobile = document.getElementById('open-auth-modal-mobile-btn');
  if (openAuthMobile) {
    openAuthMobile.addEventListener('click', () => openAuthModal('login'));
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

  document.getElementById('sync-btn-sidebar').addEventListener('click', () => triggerSync(false));
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
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  bindGlobalEvents();
  await loadDashboard(true);
  saveSlip(false);
  await renderActiveTab();
}

boot();
