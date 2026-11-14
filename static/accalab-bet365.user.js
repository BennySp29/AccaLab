// ==UserScript==
// @name         AccaLab -> Bet365 Slip Builder Companion
// @namespace    https://bennysp29.github.io/AccaLab/
// @version      1.0.0
// @description  Displays your exported AccaLab accumulator inside Bet365, highlights the target match/market/selection, and steps cleanly between legs in the same Bet365 tab.
// @match        *://*.bet365.com/*
// @match        *://*.bet365.co.uk/*
// @match        *://*.bet365.es/*
// @match        *://*.bet365.de/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'accalab_b365_slip_v1';
  const IDX_KEY = 'accalab_b365_idx_v1';

  function decodeBase64UrlUtf8(token) {
    let b64 = String(token || '').replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function loadSlipFromContext() {
    try {
      const params = new URLSearchParams(window.location.search || '');
      const rawToken = params.get('accalab_slip');
      if (rawToken) {
        const parsed = decodeBase64UrlUtf8(rawToken);
        if (parsed && Array.isArray(parsed.legs) && parsed.legs.length) {
          sessionStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
          sessionStorage.setItem(IDX_KEY, '0');
          return parsed;
        }
      }
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && Array.isArray(parsed.legs) && parsed.legs.length) return parsed;
      }
    } catch (_) {}
    return null;
  }

  function clearHighlight() {
    document.querySelectorAll('[data-accalab-hl="1"]').forEach((el) => {
      el.removeAttribute('data-accalab-hl');
      el.style.outline = '';
      el.style.boxShadow = '';
    });
  }

  function highlightLegOnPage(leg) {
    clearHighlight();
    if (!leg || !document.body) return 0;

    const terms = [leg.s, leg.h, leg.a, leg.m]
      .filter((t) => typeof t === 'string' && t.trim().length >= 2)
      .map((t) => t.trim().toLowerCase());

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const matchedEls = [];
    let node;
    while ((node = walker.nextNode())) {
      const txt = (node.nodeValue || '').trim();
      if (!txt || txt.length > 90) continue;
      const parent = node.parentElement;
      if (!parent || parent.closest('#accalab-b365-companion')) continue;
      const lower = txt.toLowerCase();
      if (terms.some((term) => lower === term || lower.includes(term))) {
        const target = parent.closest('[role="button"], button, a, div') || parent;
        if (!matchedEls.includes(target)) matchedEls.push(target);
      }
      if (matchedEls.length >= 16) break;
    }

    matchedEls.forEach((el) => {
      el.setAttribute('data-accalab-hl', '1');
      el.style.outline = '2px solid #34d399';
      el.style.boxShadow = '0 0 12px rgba(16, 185, 129, 0.55)';
    });

    if (matchedEls[0]) {
      try {
        matchedEls[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (_) {}
    }
    return matchedEls.length;
  }

  function makeEl(tag, styles, text) {
    const el = document.createElement(tag);
    if (styles) Object.assign(el.style, styles);
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function mountCompanion(slip) {
    if (!slip || !document.body) return;
    const old = document.getElementById('accalab-b365-companion');
    if (old) old.remove();

    let idx = Number(sessionStorage.getItem(IDX_KEY) || '0');
    if (!Number.isFinite(idx) || idx < 0 || idx >= slip.legs.length) idx = 0;

    const wrap = makeEl('div', {
      position: 'fixed',
      left: '14px',
      bottom: '14px',
      zIndex: '2147483647',
      width: '340px',
      maxWidth: 'calc(100vw - 28px)',
      background: '#0f172a',
      color: '#f8fafc',
      border: '1px solid rgba(16, 185, 129, 0.55)',
      borderRadius: '14px',
      padding: '12px',
      boxShadow: '0 18px 40px rgba(0, 0, 0, 0.55)',
      fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
      fontSize: '12px',
      lineHeight: '1.4',
    });
    wrap.id = 'accalab-b365-companion';

    function render() {
      wrap.replaceChildren();
      const leg = slip.legs[idx];
      sessionStorage.setItem(IDX_KEY, String(idx));

      const top = makeEl('div', {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '8px',
      });
      const brand = makeEl('div', { fontWeight: '800', color: '#34d399' }, `AccaLab Slip (${idx + 1}/${slip.legs.length})`);
      const meta = makeEl('div', { color: '#fbbf24', fontWeight: '700' }, `£${Number(slip.st || 5).toFixed(2)} @ ${slip.od || ''}`);
      const closeBtn = makeEl(
        'button',
        {
          background: 'transparent',
          border: 'none',
          color: '#94a3b8',
          cursor: 'pointer',
          fontSize: '14px',
          padding: '0 4px',
        },
        '✕'
      );
      closeBtn.type = 'button';
      closeBtn.addEventListener('click', () => {
        clearHighlight();
        sessionStorage.removeItem(STORAGE_KEY);
        sessionStorage.removeItem(IDX_KEY);
        wrap.remove();
      });
      top.append(brand, meta, closeBtn);

      const card = makeEl('div', {
        background: '#1e293b',
        borderRadius: '10px',
        padding: '10px',
        marginBottom: '8px',
        border: '1px solid #334155',
      });
      const matchLine = makeEl('div', { fontWeight: '800', color: '#ffffff', marginBottom: '3px' }, `${leg.h} v ${leg.a}`);
      const mktLine = makeEl('div', { color: '#38bdf8', fontSize: '11px', marginBottom: '3px' }, `Market: ${leg.m} (${leg.lg || ''})`);
      const pickLine = makeEl('div', { color: '#34d399', fontWeight: '800' }, `Tap: ${leg.s || leg.l} @ ${leg.o}`);
      const statusLine = makeEl('div', { color: '#94a3b8', fontSize: '11px', marginTop: '4px' }, 'Keep your Bet365 slip open while stepping through legs.');
      card.append(matchLine, mktLine, pickLine, statusLine);

      const btnRow = makeEl('div', { display: 'flex', gap: '6px', flexWrap: 'wrap' });

      const findBtn = makeEl(
        'button',
        {
          flex: '1',
          padding: '7px 8px',
          borderRadius: '8px',
          border: '1px solid #10b981',
          background: '#065f46',
          color: '#ffffff',
          fontWeight: '700',
          cursor: 'pointer',
        },
        'Highlight Match'
      );
      findBtn.type = 'button';
      findBtn.addEventListener('click', () => {
        const count = highlightLegOnPage(leg);
        statusLine.textContent = count
          ? `Highlighted ${count} matching element(s) on this page.`
          : 'No match visible yet — click Open Match below to search this fixture.';
      });

      const openBtn = makeEl(
        'button',
        {
          flex: '1',
          padding: '7px 8px',
          borderRadius: '8px',
          border: '1px solid #fbbf24',
          background: '#78350f',
          color: '#fef3c7',
          fontWeight: '700',
          cursor: 'pointer',
        },
        'Open Match'
      );
      openBtn.type = 'button';
      openBtn.addEventListener('click', () => {
        const q = leg.k || `${leg.h} v ${leg.a}`;
        window.location.hash = `#/AX/K^${encodeURIComponent(q)}`;
        setTimeout(() => highlightLegOnPage(leg), 1100);
      });

      const prevBtn = makeEl(
        'button',
        {
          padding: '7px 10px',
          borderRadius: '8px',
          border: '1px solid #475569',
          background: '#1e293b',
          color: idx === 0 ? '#64748b' : '#ffffff',
          fontWeight: '700',
          cursor: idx === 0 ? 'default' : 'pointer',
        },
        '<-'
      );
      prevBtn.type = 'button';
      prevBtn.disabled = idx === 0;
      prevBtn.addEventListener('click', () => {
        if (idx > 0) {
          idx -= 1;
          render();
          const q = slip.legs[idx].k || `${slip.legs[idx].h} v ${slip.legs[idx].a}`;
          window.location.hash = `#/AX/K^${encodeURIComponent(q)}`;
        }
      });

      const nextBtn = makeEl(
        'button',
        {
          flex: '1',
          padding: '7px 10px',
          borderRadius: '8px',
          border: '1px solid #34d399',
          background: '#10b981',
          color: '#064e3b',
          fontWeight: '800',
          cursor: idx >= slip.legs.length - 1 ? 'default' : 'pointer',
          opacity: idx >= slip.legs.length - 1 ? '0.6' : '1',
        },
        idx >= slip.legs.length - 1 ? 'All Legs Shown' : `Next (${idx + 2}/${slip.legs.length}) ->`
      );
      nextBtn.type = 'button';
      nextBtn.disabled = idx >= slip.legs.length - 1;
      nextBtn.addEventListener('click', () => {
        if (idx < slip.legs.length - 1) {
          idx += 1;
          render();
          const q = slip.legs[idx].k || `${slip.legs[idx].h} v ${slip.legs[idx].a}`;
          window.location.hash = `#/AX/K^${encodeURIComponent(q)}`;
          setTimeout(() => highlightLegOnPage(slip.legs[idx]), 1100);
        }
      });

      btnRow.append(findBtn, openBtn, prevBtn, nextBtn);
      wrap.append(top, card, btnRow);
    }

    render();
    document.body.appendChild(wrap);
    setTimeout(() => highlightLegOnPage(slip.legs[idx]), 1200);
  }

  const slip = loadSlipFromContext();
  if (slip) {
    mountCompanion(slip);
  }
})();

