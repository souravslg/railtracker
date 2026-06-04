(function () {
  'use strict';

  /* ══════════════════════════════════════════════
     CONSTANTS  (no more magic numbers scattered)
  ══════════════════════════════════════════════ */
  const CFG = {
    AR_INTERVAL_SECS   : 45,      // auto-refresh period
    PREFETCH_TTL_MS    : 30_000,  // prefetch cache lifetime
    PREFETCH_STAGGER_MS: 800,     // gap between background prefetches
    PREFETCH_INIT_DELAY: 2_000,   // wait before first background prefetch
    FETCH_TIMEOUT_MS   : 8_000,   // per-endpoint fetch timeout
    SEARCH_LOADING_MIN : 420,     // minimum loading-card visibility
    RECENT_MAX         : 6,       // max recent-search entries stored
    SEARCH_CACHE_MAX   : 24,      // max cached search queries stored
    LIVE_CACHE_MAX     : 10,      // max cached live train payloads stored
    TOAST_DURATION_MS  : 2_600,   // toast auto-dismiss
    FAV_CONFIRM_MS     : 2_200,   // fav confirmation banner duration
    SCROLL_FAB_THRESH  : 400,     // px before scroll-top FAB appears
    NET_REFRESH_MS     : 30_000,  // network re-assessment interval
    LEAFLET_POLL_MS    : 100,     // poll interval waiting for Leaflet
    LEAFLET_POLL_MAX   : 80,      // max poll attempts (~8 s)
    FONT_FALLBACK_MS   : 1_500,   // max wait for icon font
    FONT_PROBE_MAX     : 40,      // max font-probe iterations
    COUNTDOWN_WARN_MINS: 5,       // red countdown under this many minutes
    DELAY_LATE_MINS    : 1,       // threshold: considered late
    DELAY_VERY_LATE    : 30,      // threshold: very late chip
    DELAY_CHIP_SECS    : 60,      // show delay chip above this many secs
    DELAY_CHIP_THRESH  : 120,     // 'r' class above this many secs
    MAP_AUTO_OPEN_MS   : 700,     // delay before auto-opening map
    MAP_INVALIDATE_MS  : 350,     // Leaflet invalidateSize delay
    MAP_TAB_INVALIDATE : 100,     // Leaflet invalidateSize on tab switch
    ACCURACY_CIRCLE_M  : 300,     // radius of accuracy circle on map
    ISP_MAX_LEN        : 30,      // truncate ISP name after this
  };

  /* ══════════════════════════════════════════════
     TYPED ERRORS  (richer error classification)
  ══════════════════════════════════════════════ */
  class NetworkError   extends Error { constructor(m){ super(m); this.name='NetworkError'; } }
  class ApiError       extends Error { constructor(m,status){ super(m); this.name='ApiError'; this.status=status; } }
  class ParseError     extends Error { constructor(m){ super(m); this.name='ParseError'; } }
  class TimeoutError   extends Error { constructor(m){ super(m); this.name='TimeoutError'; } }

  /** Human-readable message from any caught error */
  function friendlyError(err) {
    if (err instanceof TimeoutError)  return 'Request timed out — check your connection';
    if (err instanceof NetworkError)  return 'Network error — are you offline?';
    if (err instanceof ParseError)    return 'Received unexpected data from server';
    if (err instanceof ApiError) {
      if (err.status === 404) return 'Train not found';
      if (err.status === 429) return 'Too many requests — please wait a moment';
      if (err.status >= 500)  return 'Server error — try again shortly';
      return `Server returned ${err.status}`;
    }
    return err.message || 'Something went wrong';
  }

  /* ══════════════════════════════════════════════
     STATE
  ══════════════════════════════════════════════ */
  let searchTimer      = null;
  let countdownInterval= null;
  let arTick           = null;
  let arSecs           = CFG.AR_INTERVAL_SECS;
  let searchLoadingTick = null;
  let searchLoadingPct  = 0;
  let welcomeRevealTimer= null;
  let liveLoadingToken  = 0;
  let liveLoadingReady  = false;
  let liveLoadingData   = null;
  let liveLoadingFrame  = null;
  let liveLoadingPct    = 0;
  let liveLoadingStart  = 0;
  let liveLoadingStartX = 0;
  let liveLoadingStartY = 0;
  let liveLoadingEndX   = 0;
  let liveLoadingEndY   = 0;
  let liveLoadingCanvas = null;
  let liveLoadingCtx    = null;
  let liveLoadingButton = null;
  let curNum           = null;
  let curName          = null;
  let curDayOffset     = 0;
  let lastRefTs        = null;
  let searchRes        = [];
  const trainNameCache = new Map();
  const searchCacheMemory = new Map();

  // Use official RailRadar API directly
  const BASE = 'https://api.railradar.in';
  const SEARCH_CACHE_KEY = 'tt-search-cache';
  const LIVE_CACHE_KEY   = 'tt-live-cache';
  const ROUTE_BASE_PATH  = (() => {
    const path = window.location.pathname;
    const base = path.replace(/\/[^/]*$/, '/');
    return base.endsWith('/') ? base : base + '/';
  })();
  const scheduleIdle = callback => {
    if (typeof window.requestIdleCallback === 'function') {
      return window.requestIdleCallback(callback, { timeout: 2_000 });
    }
    return window.setTimeout(callback, 300);
  };

  /* ══════════════════════════════════════════════
     DOM REFS  (single source of truth)
  ══════════════════════════════════════════════ */
  const $ = id => document.getElementById(id);
  const DOM = {
    get toast()         { return $('toast'); },
    get searchInput()   { return $('searchInput'); },
    get searchResults() { return $('searchResults'); },
    get liveView()      { return $('liveView'); },
    get refreshBtn()    { return $('refreshBtn'); },
    get suggestBox()    { return $('suggestBox'); },
    get arFill()        { return $('arFill'); },
    get arCd()          { return $('arCd'); },
    get istText()       { return $('istText'); },
    get appBar()        { return $('appBar'); },
    get scrollTopFab()  { return $('scrollTopFab'); },
    get favModal()      { return $('favModal'); },
    get favModalContent(){ return $('favModalContent'); },
    get favConfirm()    { return $('favConfirm'); },
    get themeIcon()     { return $('themeIcon'); },
    get netSig()        { return $('netSig'); },
    get netLabel()      { return $('netLabel'); },
    get sigBars()       { return $('sigBars'); },
    get netLocTxt()     { return $('netLocTxt'); },
    get netPill()       { return $('netPill'); },
    get netPopover()    { return $('netPopover'); },
  };

  /* ══════════════════════════════════════════════
     FETCH  (typed errors, structured retry)
  ══════════════════════════════════════════════ */
  let allTrainsLookup = null;
  async function searchTrainsLocally(q) {
    if (!allTrainsLookup) {
      try {
        const r = await fetch(BASE + '/lookup/trains');
        const d = await r.json();
        allTrainsLookup = d.data || {};
      } catch (e) {
        throw new NetworkError('Failed to fetch train lookup data');
      }
    }
    const results = [];
    const lowerQ = q.toLowerCase();
    for (const [num, name] of Object.entries(allTrainsLookup)) {
      if (num.includes(lowerQ) || name.toLowerCase().includes(lowerQ)) {
        let fromStn = 'Source', toStn = 'Dest';
        if (name.includes(' - ')) {
          const parts = name.split(' - ');
          if (parts.length >= 2) {
            fromStn = parts[0].split(' ').pop();
            toStn = parts[1].split(' ')[0];
          }
        }
        results.push({ number: num, name, fromStnCode: fromStn, toStnCode: toStn });
        if (results.length >= 25) break;
      }
    }
    return { success: true, data: results };
  }

  async function fetchData(path) {
    const hasTimeout = typeof AbortSignal.timeout === 'function';
    const mkSig = () => hasTimeout ? AbortSignal.timeout(CFG.FETCH_TIMEOUT_MS) : undefined;
    try {
      if (path.startsWith('/search?q=')) {
        const q = new URLSearchParams(path.split('?')[1]).get('q');
        return await searchTrainsLocally(q);
      }
      
      if (path.startsWith('/live-status?')) {
        const params = new URLSearchParams(path.split('?')[1]);
        const trainNo = params.get('trainNo');
        
        const r = await fetch(BASE + `/api/v1/trains/${trainNo}`, { signal: mkSig() });
        if (!r.ok) throw new ApiError(`HTTP ${r.status}`, r.status);
        const res = await parseResp(r);
        
        if (!res.success || !res.data) throw new ParseError('Invalid train data');
        
        const d = res.data;
        const live = d.liveData || {};
        const staticRoute = d.route || [];
        
        const stnMap = {};
        staticRoute.forEach(s => stnMap[s.stationCode] = s.stationName);
        
        let delayInSecs = 0;
        let curr = live.currentLocation || {};
        
        const mappedRoute = (live.route || []).map(r => {
          const delayMins = Math.max(r.delayArrivalMinutes || 0, r.delayDepartureMinutes || 0);
          return {
            stationCode: r.stationCode,
            station_name: stnMap[r.stationCode] || r.stationCode,
            scheduledArrivalTime: r.scheduledArrival,
            scheduledDepartureTime: r.scheduledDeparture,
            actualArrivalTime: r.actualArrival,
            actualDepartureTime: r.actualDeparture,
            platformNumber: r.platform,
            delayInMins: delayMins,
            hasDeparted: !!r.actualDeparture,
            hasArrived: !!r.actualArrival
          };
        });
        
        if (mappedRoute.length > 0) {
          const lastArrived = [...mappedRoute].reverse().find(r => r.actualArrivalTime);
          if (lastArrived) delayInSecs = (lastArrived.delayInMins || 0) * 60;
        }

        return {
          success: true,
          data: {
            currentPosition: {
              latLng: { latitude: curr.latitude, longitude: curr.longitude },
              stationCode: curr.stationCode,
              distanceFromOriginKm: curr.distanceFromOriginKm,
              speedKmph: curr.speedKmph || 0
            },
            delayInSecs: delayInSecs,
            route: mappedRoute
          }
        };
      }
    } catch (e) {
      if (e instanceof ParseError) throw e;
      if (e instanceof ApiError && e.status < 500) throw e;
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new TimeoutError(`Request timed out`);
      if (e instanceof ApiError) throw e;
      throw new NetworkError(e.message);
    }
  }

  async function parseResp(r) {
    try {
      return await r.json();
    } catch (e) {
      // If JSON parsing fails, try to get text for debugging or throw ParseError
      let txt = '';
      try { txt = await r.text(); } catch (e2) {}
      if (txt && txt.trim().startsWith('<')) {
        throw new ParseError('Received HTML instead of JSON');
      }
      throw new ParseError('Invalid JSON response');
    }
  }

  async function resolveTrainName(num, fallbackName = '') {
    const key = String(num);
    if (trainNameCache.has(key)) {
      const cached = trainNameCache.get(key);
      if (cached && cached !== key) return cached;
    }
    if (fallbackName && fallbackName !== key) {
      trainNameCache.set(key, fallbackName);
      return fallbackName;
    }
    try {
      const d = await fetchData('/search?q=' + encodeURIComponent(num));
      const trains = d?.data ?? [];
      const exactMatch = trains.find(t => String(t.number) === key);
      if (exactMatch && exactMatch.name) {
        trainNameCache.set(key, exactMatch.name);
        return exactMatch.name;
      }
    } catch (e) {
      // ignore
    }
    const resolved = fallbackName || key;
    trainNameCache.set(key, resolved);
    return resolved;
  }

  function animateCountdownTick(el) {
    if (!el) return;
    el.classList.remove('tick-down');
    void el.offsetWidth;
    el.classList.add('tick-down');
  }

  /* ══════════════════════════════════════════════
     UTILS
  ══════════════════════════════════════════════ */
  const getDateString = (offsetDays = 0) => {
    const d = new Date();
    if (offsetDays !== 0) d.setDate(d.getDate() + offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const pad    = n  => String(n).padStart(2, '0');
  const fmt    = ts => ts
    ? new Date(ts * 1000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
    : '—';
  const fmtDateTime = ts => {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    const day = String(d.getDate()).padStart(2, '0');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[d.getMonth()];
    const timeStr = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
    return `${day} ${month}, ${timeStr}`;
  };
  const delaySecs = (actualTs, scheduledTs) => {
    if (actualTs == null || scheduledTs == null) return 0;
    return Math.max(0, actualTs - scheduledTs);
  };
  const he     = s  => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const loader = msg => `<div class="loader"><div class="spinner"><svg viewBox="22 22 44 44"><circle cx="44" cy="44" r="20.2"/></svg></div>${he(msg)}</div>`;
  const readJson = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  };
  const writeJson = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  };
  const normalizeCacheKey = value => String(value == null ? '' : value).trim().toLowerCase();
  const getRouteTrainNo = () => {
    const pathSegments = window.location.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    let lastSegment = pathSegments[pathSegments.length - 1] || '';
    try { lastSegment = decodeURIComponent(lastSegment); } catch (e) {}
    const match = lastSegment.match(/^(\d{3,})(?:-.*)?$/);
    if (match) return match[1];
    
    const params = new URLSearchParams(window.location.search);
    let candidate = params.get('trainNo') || params.get('train') || params.get('t');
    if (candidate) {
      try { candidate = decodeURIComponent(candidate); } catch (e) {}
      const m = candidate.match(/^(\d{3,})(?:-.*)?$/);
      if (m) return m[1];
    }
    return null;
  };

  const getRouteTrainName = () => {
    const pathSegments = window.location.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    let lastSegment = pathSegments[pathSegments.length - 1] || '';
    try { lastSegment = decodeURIComponent(lastSegment); } catch (e) {}
    const match = lastSegment.match(/^(\d{3,})-(.+)$/);
    if (match && match[2]) {
      let slug = match[2];
      if (slug.endsWith('-running-status-live')) {
        slug = slug.slice(0, -20);
      }
      return slug
        .split('-')
        .filter(Boolean)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    }
    
    const params = new URLSearchParams(window.location.search);
    let candidate = params.get('trainNo') || params.get('train') || params.get('t');
    if (candidate) {
      try { candidate = decodeURIComponent(candidate); } catch (e) {}
      const m = candidate.match(/^(\d{3,})-(.+)$/);
      if (m && m[2]) {
        let slug = m[2];
        if (slug.endsWith('-running-status-live')) {
          slug = slug.slice(0, -20);
        }
        return slug
          .split('-')
          .filter(Boolean)
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');
      }
    }
    return null;
  };
  const buildTrainUrl = (num, name) => {
    if (!name) return `${ROUTE_BASE_PATH}${encodeURIComponent(String(num))}-running-status-live`;
    const slug = String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    const segment = slug ? `${num}-${slug}-running-status-live` : `${num}-running-status-live`;
    return `${ROUTE_BASE_PATH}${encodeURIComponent(segment)}`;
  };
  function syncRoute(num, name, replace = false) {
    const url = buildTrainUrl(num, name);
    const state = { view: 'train', num: String(num), name: name };
    if (replace) history.replaceState(state, '', url);
    else history.pushState(state, '', url);
  }
  function clearRoute(replace = false) {
    const state = { view: 'home' };
    if (replace) history.replaceState(state, '', ROUTE_BASE_PATH);
    else history.pushState(state, '', ROUTE_BASE_PATH);
  }

  /* ── Toast ── */
  function toast(msg, type) {
    const c   = { done: 'var(--green)', error: 'var(--red)', info: 'var(--accent)' };
    const el  = DOM.toast;
    if (!el) return;
    el.innerHTML = `<span style="color:${c[type] || c.done}">●</span> ${he(msg)}`;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), CFG.TOAST_DURATION_MS);
  }

  /* ── Error display helpers ── */
  function renderError(msg, hint = '') {
    return `<div class="loader" style="flex-direction:column;align-items:flex-start;gap:6px">
      <div>${he(msg)}</div>
      ${hint ? `<div style="font-size:11px;opacity:.5">${he(hint)}</div>` : ''}
    </div>`;
  }

  function errorHint(err) {
    if (err instanceof TimeoutError)  return 'Try refreshing or check your connection';
    if (err instanceof NetworkError)  return 'Check your internet connection';
    if (err instanceof ParseError)    return 'The server may be experiencing issues';
    if (err instanceof ApiError && err.status === 404) return 'The train number may be incorrect';
    if (err instanceof ApiError && err.status >= 500)  return 'Server issue — try again in a moment';
    return 'Train may not be running today';
  }

  /* ══════════════════════════════════════════════
     CLOCK
  ══════════════════════════════════════════════ */
  function tickClock() {
    const el = DOM.istText;
    if (!el) return;
    try {
      const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      el.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    } catch (e) { /* silent */ }
  }
  tickClock();
  setInterval(tickClock, 1000);

  /* ══════════════════════════════════════════════
     SCROLL  (passive, single handler)
  ══════════════════════════════════════════════ */
  window.addEventListener('scroll', () => {
    DOM.appBar?.classList.toggle('elevated', scrollY > 4);
    DOM.scrollTopFab?.classList.toggle('show', scrollY > CFG.SCROLL_FAB_THRESH);
  }, { passive: true });
  DOM.scrollTopFab?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

  /* ══════════════════════════════════════════════
     AUTO-REFRESH
  ══════════════════════════════════════════════ */
  function startAR()  { stopAR(); arSecs = CFG.AR_INTERVAL_SECS; updateAR(); arTick = setInterval(_arTick, 1000); }
  function stopAR()   { if (arTick) { clearInterval(arTick); arTick = null; } }
  function _arTick()  { arSecs--; updateAR(); if (arSecs <= 0) { arSecs = CFG.AR_INTERVAL_SECS; doRefresh(true); } }
  function updateAR() {
    const f = DOM.arFill, l = DOM.arCd;
    if (f) f.style.width = `${((CFG.AR_INTERVAL_SECS - arSecs) / CFG.AR_INTERVAL_SECS * 100)}%`;
    if (l) l.textContent = `Next in ${arSecs}s`;
  }

  async function doRefresh(silent) {
    if (!curNum) return;
    const b = DOM.refreshBtn;
    if (!silent) {
      b?.classList.add('spinning');
      if (b) b.disabled = true;
      arSecs = CFG.AR_INTERVAL_SECS;
      updateAR();
    }
    try {
      const today = getDateString(curDayOffset);
      const d = await fetchData(`/live-status?trainNo=${encodeURIComponent(curNum)}&startDate=${today}`);
      lastRefTs = new Date();
      renderLive(d.data, curNum, curName);
      updateLastRef();
      if (!silent) toast('Refreshed!', 'done');
      else toast('Auto-refreshed', 'info');
    } catch (err) {
      const msg = friendlyError(err);
      toast(`Refresh failed: ${msg}`, 'error');
      // On repeated auto-refresh failures, slow down to save battery/data
      if (silent) arSecs = CFG.AR_INTERVAL_SECS;
    } finally {
      if (!silent) {
        b?.classList.remove('spinning');
        if (b) b.disabled = false;
      }
    }
  }

  function updateLastRef() {
    const el = $('lastRefTime');
    if (el && lastRefTs) {
      try {
        const d = new Date(lastRefTs.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        el.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} IST`;
      } catch (e) { /* silent */ }
    }
  }

  /* ══════════════════════════════════════════════
     SEARCH
  ══════════════════════════════════════════════ */
  const si = DOM.searchInput;

  si?.addEventListener('input', function () {
    const q = this.value.trim();
    clearTimeout(searchTimer);
    if (!q) { showWelcome(); clearSuggest(); return; }
    if (q.length < 2) return;
    searchTimer = setTimeout(() => doSearch(q), 120);
  });

  // Keyboard shortcuts: Escape + "/" to focus search
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== si) {
      e.preventDefault();
      si?.focus();
      return;
    }
    if (e.key === 'Escape') {
      clearSuggest();
      if (!curNum) { si.value = ''; showWelcome(); }
      else si?.blur();
    }
  });

  function clearSuggest() { if (DOM.suggestBox) DOM.suggestBox.innerHTML = ''; }

  function restoreSearchWrap() {
    const searchWrap = $('trainSearchWrap');
    const brand = $('brandBtn');
    if (searchWrap) searchWrap.style.display = '';
    if (searchWrap && brand && searchWrap.parentNode !== brand.parentNode) {
      brand.insertAdjacentElement('afterend', searchWrap);
      searchWrap.classList.remove('hero-mode');
    }
  }

  async function doSearch(q) {
    restoreSearchWrap();
    const sr = DOM.searchResults, lv = DOM.liveView;
    lv.innerHTML = '';
    clearInterval(countdownInterval);
    countdownInterval = null;
    stopAR();
    curNum = null; curName = null;
    DOM.refreshBtn.style.display = 'none';
    
    const cached = getPersistedSearchCache(q);
    if (cached?.data?.length) {
      searchRes = cached.data;
      renderSearch(cached.data, q, true);
      return;
    }
    
    sr.innerHTML = loader("Searching...");
    try {
      const d = await fetchData('/search?q=' + encodeURIComponent(q));
      const trains = d?.data ?? [];
      searchRes = trains;
      saveSearchCache(q, trains);
      renderSearch(trains, q);
    } catch (err) {
      const cachedBackup = getPersistedSearchCache(q);
      if (cachedBackup?.data?.length) {
        searchRes = cachedBackup.data;
        toast('Showing cached results', 'info');
        renderSearch(cachedBackup.data, q, true);
        return;
      }
      const msg  = friendlyError(err);
      const hint = errorHint(err);
      sr.innerHTML = renderError(`Search failed: ${msg}`, hint);
    }
  }

  let allStationsLookup = null;
  async function resolveStation(query) {
    if (!query) return '';
    if (!allStationsLookup) {
      try {
        const r = await fetch(BASE + '/lookup/stations');
        const d = await r.json();
        allStationsLookup = d.data || {};
      } catch (e) {
        return query.toUpperCase();
      }
    }
    const q = query.trim().toUpperCase();
    if (allStationsLookup[q]) return q;
    
    const lowerQ = query.trim().toLowerCase();
    for (const [code, name] of Object.entries(allStationsLookup)) {
      if (name.toLowerCase() === lowerQ) return code;
    }
    for (const [code, name] of Object.entries(allStationsLookup)) {
      if (name.toLowerCase().includes(lowerQ)) return code;
    }
    return q;
  }

  async function doFindTrains(from, to) {
    restoreSearchWrap();
    const sr = DOM.searchResults, lv = DOM.liveView;
    lv.innerHTML = '';
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    stopAR();
    curNum = null; curName = null;
    DOM.refreshBtn.style.display = 'none';
    
    sr.innerHTML = loader(`Finding stations...`);
    try {
      const fromCode = await resolveStation(from);
      const toCode = await resolveStation(to);
      
      sr.innerHTML = loader(`Finding trains from ${fromCode} to ${toCode}...`);
      
      const r = await fetch(BASE + `/api/v1/trains/between?from=${fromCode}&to=${toCode}`);
      if (!r.ok) throw new ApiError(`HTTP ${r.status}`, r.status);
      const res = await r.json();
      if (!res.success || !res.data) throw new ParseError('Invalid response');
      
      const mapped = (res.data.trains || []).map(t => ({
        number: t.trainNumber,
        name: t.trainName,
        fromStnCode: t.sourceStationCode,
        toStnCode: t.destinationStationCode
      }));
      
      searchRes = mapped;
      renderSearch(mapped, `${fromCode} to ${toCode}`);
    } catch (err) {
      const msg  = friendlyError(err);
      const hint = errorHint(err);
      sr.innerHTML = renderError(`Failed: ${msg}`, hint);
    }
  }

  function renderSkeleton(n) {
    let h = '';
    for (let i = 0; i < n; i++) {
      h += `<div class="skeleton-card loading-card">
        <div class="sk-line" style="width:36%;margin-bottom:10px"></div>
        <div class="sk-line" style="width:64%"></div>
        <div class="sk-line" style="width:28%;margin-top:6px"></div>
      </div>`;
    }
    return h;
  }

  function renderSearchLoading(query, pct = 0) {
    return `<div class="search-loading-card" aria-live="polite" aria-busy="true">
      <div class="search-loading-top">
        <div class="search-loading-ring">
          <svg viewBox="0 0 44 44" aria-hidden="true">
            <circle class="search-loading-track" cx="22" cy="22" r="18"></circle>
            <circle class="search-loading-fill" cx="22" cy="22" r="18"></circle>
          </svg>
          <span class="search-loading-pct">${pct}%</span>
        </div>
        <div class="search-loading-copy">
          <div class="search-loading-title">Searching trains</div>
          <div class="search-loading-sub">Looking up ${he(query)} and preparing results from cache or network.</div>
        </div>
      </div>
      <div class="search-loading-bar"><div class="search-loading-bar-fill" style="width:${pct}%"></div></div>
      <div class="search-loading-meta">
        <span>Cache</span>
        <span>Match</span>
        <span>Render</span>
      </div>
    </div>`;
  }

  function updateSearchLoading(query, pct) {
    const sr = DOM.searchResults;
    const card = sr?.querySelector('.search-loading-card');
    if (!card) return;
    const pctEl = card.querySelector('.search-loading-pct');
    const fillEl = card.querySelector('.search-loading-bar-fill');
    const subEl = card.querySelector('.search-loading-sub');
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (fillEl) fillEl.style.width = `${pct}%`;
    if (subEl) subEl.textContent = `Looking up ${query} and preparing results from cache or network.`;
  }

  function clearSearchLoading() {
    if (searchLoadingTick) {
      clearInterval(searchLoadingTick);
      searchLoadingTick = null;
    }
    searchLoadingPct = 0;
  }

  function startSearchLoading(query) {
    const sr = DOM.searchResults;
    if (!sr) return;
    clearSearchLoading();
    searchLoadingPct = 8;
    sr.innerHTML = renderSearchLoading(query, searchLoadingPct);
    searchLoadingTick = setInterval(() => {
      const card = sr.querySelector('.search-loading-card');
      if (!card) {
        clearSearchLoading();
        return;
      }
      const step = searchLoadingPct < 35 ? 13 : searchLoadingPct < 70 ? 8 : 3;
      searchLoadingPct = Math.min(92, searchLoadingPct + step);
      updateSearchLoading(query, searchLoadingPct);
    }, 120);
  }

  async function keepSearchLoadingVisible(startTime) {
    const elapsed = Date.now() - startTime;
    const waitMs = CFG.SEARCH_LOADING_MIN - elapsed;
    if (waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }

  function renderSearch(trains, query = '', fromCache = false) {
    const sr = DOM.searchResults;
    if (!trains?.length) { sr.innerHTML = '<div class="loader">No trains found.</div>'; return; }
    clearSearchLoading();
    let h = `<div class="results-hdr">${trains.length} result${trains.length > 1 ? 's' : ''} found</div>`;
    if (fromCache && query) {
      h += `<div class="results-cache-note">Loaded from browser cache for <strong>${he(query)}</strong>.</div>`;
    }
    const savedFavs = getFavs();
    for (let i = 0; i < trains.length; i++) {
      const t = trains[i];
      const trainIsFav = savedFavs.some(f => f.num === String(t.number));
      h += `<div class="result-card">
        <div class="rnum-badge">${he(t.number)}</div>
        <div class="rinfo">
          <div class="rname">${he(t.name)}</div>
          <div class="rroute"><span class="material-symbols-rounded" style="font-size:13px">location_on</span>${he(t.fromStnCode)} → ${he(t.toStnCode)}</div>
        </div>
        <button class="fav-btn${trainIsFav ? ' active' : ''}" data-fav-idx="${i}" title="${trainIsFav ? 'Remove from favourites' : 'Add to favourites'}">
          <span class="material-symbols-rounded" style="font-size:20px">star</span>
        </button>
        <button class="animated-button track-btn" data-idx="${i}">
          <svg viewBox="0 0 24 24" class="arr-2" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M16.1716 10.9999L10.8076 5.63589L12.2218 4.22168L20 11.9999L12.2218 19.778L10.8076 18.3638L16.1716 12.9999H4V10.9999H16.1716Z"></path>
          </svg>
          <span class="text">Track</span>
          <span class="circle"></span>
          <svg viewBox="0 0 24 24" class="arr-1" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M16.1716 10.9999L10.8076 5.63589L12.2218 4.22168L20 11.9999L12.2218 19.778L10.8076 18.3638L16.1716 12.9999H4V10.9999H16.1716Z"></path>
          </svg>
        </button>
      </div>`;
    }
    sr.innerHTML = h;
    sr.querySelectorAll('.result-card').forEach((card, i) => {
      const t = searchRes[i];
      if (!t) return;
      attachPrefetch(card, String(t.number), t.name);
    });
    sr.querySelectorAll('[data-idx]').forEach(btn => {
      const t = searchRes[+btn.dataset.idx];
      if (!t) return;
      attachPrefetch(btn, String(t.number), t.name);
      btn.addEventListener('click', e => {
        e.stopPropagation();
        doLive(String(t.number), t.name, 'push', btn);
        saveRecent(String(t.number), t.name);
      });
    });
    sr.querySelectorAll('[data-fav-idx]').forEach(btn => {
      const t = searchRes[+btn.dataset.favIdx];
      if (!t) return;
      attachPrefetch(btn, String(t.number), t.name);
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const t = searchRes[+btn.dataset.favIdx];
        if (!t) return;
        const num = String(t.number);
        if (isFav(num)) { removeFav(num); btn.classList.remove('active'); showFavConfirm('Removed from favourites'); }
        else            { saveFav(num, t.name); btn.classList.add('active'); showFavConfirm('★ Added to favourites'); }
      });
    });
  }

  /* ══════════════════════════════════════════════
     RENDER LIVE  (split into sub-renderers)
  ══════════════════════════════════════════════ */
  function renderLive(data, trainNo, trainName) {
    const lv = DOM.liveView;
    if (!data?.route?.length) {
      lv.innerHTML = '<div class="loader">No route data available for this train today.</div>';
      return;
    }

    // Clear any running countdown from previous render
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }

    // ── Derived state ──
    const route    = data.route;
    // ── Check if today's run has not started yet ──
    const originStn = route[0];
    let notStartedYet = false;
    let todayStartTs = 0;
    
    if (originStn && originStn.scheduledDepartureTime && curDayOffset === 0) {
      const d = new Date(originStn.scheduledDepartureTime * 1000);
      const today = new Date();
      today.setHours(d.getHours(), d.getMinutes(), d.getSeconds(), 0);
      todayStartTs = Math.floor(today.getTime() / 1000);
      
      if (Date.now() / 1000 < todayStartTs) {
        notStartedYet = true;
      }
    }

    let curCode = data.currentPosition?.stationCode;
    let curIdx = -1;
    let delayMins = Math.round((data.delayInSecs || 0) / 60);
    let progress = 0;
    let distOrig = data.currentPosition?.distanceFromOriginKm != null ? Number(data.currentPosition.distanceFromOriginKm).toFixed(1) : '—';
    let distLast = data.currentPosition?.distanceFromLastStationKm != null ? Number(data.currentPosition.distanceFromLastStationKm).toFixed(1) : '—';
    let lat = data.currentPosition?.latLng?.latitude;
    let lng = data.currentPosition?.latLng?.longitude;
    let speedKmh = data.currentPosition?.speedKmph != null ? Math.round(data.currentPosition.speedKmph) : null;

    if (notStartedYet) {
      curCode = originStn?.stationCode;
      curIdx = 0;
      delayMins = 0;
      progress = 0;
      distOrig = '0.0';
      distLast = '0.0';
      lat = null;
      lng = null;
      speedKmh = 0;
      
      route.forEach(stn => {
        stn.actualArrivalTime = null;
        stn.actualDepartureTime = null;
        stn.delayInMins = 0;
        stn.hasDeparted = false;
        stn.hasArrived = false;
      });
    } else {
      for (let i = 0; i < route.length; i++) { if (route[i].stationCode === curCode) { curIdx = i; break; } }
      progress = curIdx >= 0 ? Math.round(curIdx / Math.max(route.length - 1, 1) * 100) : 0;
    }

    const isLate     = delayMins > CFG.DELAY_LATE_MINS;
    const isVeryLate = delayMins > CFG.DELAY_VERY_LATE;

    const origin     = route[0];
    const dest       = route[route.length - 1];
    const curStn     = curIdx >= 0 ? route[curIdx] : null;
    const nextStop   = curIdx >= 0 && curIdx < route.length - 1 ? route[curIdx + 1] : null;
    const remaining  = curIdx >= 0 ? route.length - 1 - curIdx : route.length;
    const remainingLabel = curIdx >= 0 ? 'Stops left' : 'Total stops';

    let etaStr = '—'; let etaTs = 0;
    if (nextStop) {
      const liveArrivalSecs = nextStop.actualArrivalTime || (nextStop.scheduledArrivalTime ? nextStop.scheduledArrivalTime + (delayMins * 60) : null);
      if (liveArrivalSecs) {
        etaTs  = liveArrivalSecs * 1000;
        etaStr = new Date(etaTs).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
      }
    }
    const favFlag  = isFav(trainNo);

    const startingStation = originStn?.station_name || originStn?.stationName || 'Origin';
    const destStation = dest?.station_name || dest?.stationName || 'Destination';

    let bannerHtml = '';
    
    if (notStartedYet) {
      bannerHtml = `<div class="not-started-banner" style="background: linear-gradient(135deg, rgba(245, 158, 11, 0.12), rgba(245, 158, 11, 0.03)); border-bottom: 1.5px solid rgba(245, 158, 11, 0.22);">
        <div class="ns-icon-bg" style="background: rgba(245, 158, 11, 0.16); box-shadow: 0 4px 10px rgba(245, 158, 11, 0.18); font-size: 16px;">⏳</div>
        <div class="ns-content">
          <h4 style="color: var(--yellow); margin-bottom: 3px;">Train has not started yet</h4>
          <p style="font-size: 11px; opacity: 0.95; line-height: 1.4;">
            Today's run from <strong>${startingStation}</strong> to <strong>${destStation}</strong> is scheduled to start at <strong>${fmt(todayStartTs)}</strong>.
          </p>
        </div>
      </div>`;
    } else if (curIdx === route.length - 1 || progress === 100) {
      bannerHtml = `<div class="not-started-banner" style="background: linear-gradient(135deg, rgba(16, 185, 129, 0.12), rgba(16, 185, 129, 0.03)); border-bottom: 1.5px solid rgba(16, 185, 129, 0.22);">
        <div class="ns-icon-bg" style="background: rgba(16, 185, 129, 0.16); box-shadow: 0 4px 10px rgba(16, 185, 129, 0.18); font-size: 16px;">✅</div>
        <div class="ns-content">
          <h4 style="color: var(--green); margin-bottom: 3px;">Train reached at destination</h4>
          <p style="font-size: 11px; opacity: 0.95; line-height: 1.4;">
            The tour starting from <strong>${startingStation}</strong> has successfully reached <strong>${destStation}</strong>.
          </p>
        </div>
      </div>`;
    }

    // ── Assemble HTML from sub-renderers ──
    const h = [
      `<div class="live-panel">`,
      renderLiveHeader(trainNo, trainName, data, origin, dest, isLate, isVeryLate, delayMins, distOrig, remaining, route.length, remainingLabel, favFlag),
      bannerHtml,
      renderLiveProgress(origin, dest, progress),
      renderLiveStats(isLate, isVeryLate, delayMins, distOrig, distLast, etaStr, speedKmh),
      curStn ? renderLivePosition(curStn, nextStop, etaStr) : '',
      etaTs  ? renderCountdownRow(nextStop, etaStr, etaTs) : '',
      (lat != null && lng != null) ? renderMapSection(lat, lng) : '',
      renderShareRow(),
      renderAutoBar(),
      renderTabs(),
      renderTimeline(route, curIdx),
      renderStopsTable(route, curIdx),
      renderInfoTab(trainNo, trainName, data, route, origin, dest, progress),
      `</div><div class="last-ref">Last refreshed: <span id="lastRefTime">—</span></div>`,
    ].join('');

    lv.innerHTML = h;

    // ── Post-render wiring ──
    requestAnimationFrame(() => setTimeout(() => {
      const pf = $('progFill');
      if (pf) pf.style.width = progress + '%';
    }, 80));

    wireCountdown(etaTs);
    wireFavBtn(trainNo, trainName);
    wireDateSelect(trainNo, trainName);
    wireMap(lat, lng, trainName, curStn, isLate, delayMins, speedKmh, progress);
    wireShare(trainNo, trainName, curStn, curCode, dest, isLate, delayMins, progress);
    wireTabs(lv);

    // ── Dynamic SEO ──
    const seoTitle = `Live Running Status of ${trainName || 'Train'} (${trainNo}) - TrainTracker.in`;
    const seoDesc = `Check live running status of ${trainName || 'Train'} (${trainNo}) which runs from ${originStn?.station_name || originStn?.stationCode || 'Source'} to ${dest?.station_name || dest?.stationCode || 'Destination'}. Spot your train in real-time on TrainTracker.in`;
    document.title = seoTitle;
    const metaDescEl = document.querySelector('meta[name="description"]');
    if (metaDescEl) metaDescEl.setAttribute('content', seoDesc);
  }

  /* ── Sub-renderers ── */

  function renderLiveHeader(trainNo, trainName, data, origin, dest, isLate, isVeryLate, delayMins, distOrig, remaining, total, remainingLabel, favFlag) {
    return `<div class="lp-head">
      <div class="lp-chips">
        <span class="chip chip-num">${he(trainNo)}</span>
        <span class="chip chip-src">${he(data.dataSource || 'LIVE')}</span>
        <span class="chip ${isLate ? (isVeryLate ? 'chip-late' : 'chip-warn') : 'chip-ok'}">
          <span class="blink"></span>${isLate ? '+' + delayMins + ' min late' : 'On Time'}
        </span>
      </div>
      <div class="lp-top">
        <div>
          <div class="lp-title">${he(trainNo)}${trainName && trainName !== trainNo ? ' — ' + he(trainName) : ''}</div>
          <div class="lp-route"><span class="material-symbols-rounded" style="font-size:14px">train</span>${he(origin?.station_name || '—')} → ${he(dest?.station_name || '—')}</div>
        </div>
        <button class="fav-btn${favFlag ? ' active' : ''}" id="lpFavBtn" title="Favourite" style="margin-top:4px">
          <span class="material-symbols-rounded" style="font-size:22px">star</span>
        </button>
      </div>
      <div class="lp-date-selector">
        <label for="liveDateSelect">Live Status:</label>
        <select id="liveDateSelect" class="date-select">
          <option value="0" ${curDayOffset === 0 ? 'selected' : ''}>Today</option>
          <option value="-1" ${curDayOffset === -1 ? 'selected' : ''}>Yesterday</option>
        </select>
      </div>
      <div class="lp-meta-row">
        <div class="meta-it"><div class="mlabel">Updated</div><div class="mval">${fmtDateTime(data.lastUpdatedTimestamp)}</div></div>
        <div class="meta-it"><div class="mlabel">Covered</div><div class="mval">${distOrig} km</div></div>
        <div class="meta-it"><div class="mlabel">${he(remainingLabel)}</div><div class="mval">${remaining}</div></div>
        <div class="meta-it"><div class="mlabel">Total stops</div><div class="mval">${total}</div></div>
      </div>
    </div>`;
  }

  function renderLiveProgress(origin, dest, progress) {
    return `<div class="lp-progress">
      <div class="prog-head">
        <span class="prog-endpoints">${he(origin?.stationCode || '')} → ${he(dest?.stationCode || '')}</span>
        <span class="prog-pct">${progress}%</span>
      </div>
      <div class="linear-track"><div class="linear-fill" id="progFill" style="width:0%"></div></div>
      <div class="prog-labels">
        <span class="prog-lbl">${he(origin?.station_name || '')}</span>
        <span class="prog-lbl" style="text-align:right">${he(dest?.station_name || '')}</span>
      </div>
    </div>`;
  }

  // SVGs extracted as constants — generated once, not per-render
  const SVG = {
    delay: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><polyline points="12 7 12 12 15 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    route: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="6" cy="19" r="2" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="5" r="2" stroke="currentColor" stroke-width="1.8"/><path d="M6 17v-4a6 6 0 0 1 6-6h2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    loc:   `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" fill="currentColor"/></svg>`,
    timer: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 6v6l4 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/></svg>`,
    speed: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 12L8.5 7.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><path d="M3 12a9 9 0 1 1 18 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M5.6 16.8L8 14.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M18.4 16.8L16 14.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    train: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="4" y="3" width="16" height="12" rx="3" fill="white" opacity=".3"/><rect x="4" y="3" width="16" height="12" rx="3" stroke="white" stroke-width="1.8"/><circle cx="8.5" cy="18.5" r="1.8" fill="white"/><circle cx="15.5" cy="18.5" r="1.8" fill="white"/><line x1="4" y1="9" x2="20" y2="9" stroke="white" stroke-width="1.8"/><line x1="12" y1="3" x2="12" y2="9" stroke="white" stroke-width="1.8"/></svg>`,
  };

  function renderLiveStats(isLate, isVeryLate, delayMins, distOrig, distLast, etaStr, speedKmh) {
    return `<div class="stats-row">
      <div class="stat-it"><div style="color:${isLate ? 'var(--red)' : 'var(--green)'};display:flex;justify-content:center;margin-bottom:4px">${SVG.delay}</div><div class="sval ${isLate ? 'r' : 'g'}">${isLate ? '+' + delayMins : '0'}</div><div class="slbl">Min Delay</div></div>
      <div class="stat-it"><div style="color:var(--accent);display:flex;justify-content:center;margin-bottom:4px">${SVG.route}</div><div class="sval b">${distOrig}</div><div class="slbl">KM Done</div></div>
      <div class="stat-it"><div style="color:var(--text3);display:flex;justify-content:center;margin-bottom:4px">${SVG.loc}</div><div class="sval">${distLast}</div><div class="slbl">KM Last Stn</div></div>
      <div class="stat-it"><div style="color:var(--accent);display:flex;justify-content:center;margin-bottom:4px">${SVG.timer}</div><div class="sval b" style="font-size:13px">${etaStr}</div><div class="slbl">ETA Next</div></div>
      ${speedKmh !== null ? `<div class="stat-it"><div style="color:var(--yellow);display:flex;justify-content:center;margin-bottom:4px">${SVG.speed}</div><div class="sval y">${speedKmh}</div><div class="slbl">km/h</div></div>` : ''}
    </div>`;
  }

  function renderLivePosition(curStn, nextStop, etaStr) {
    return `<div class="lp-pos">
      <div class="pos-icon">${SVG.train}</div>
      <div class="pos-info">
        <div class="pos-at">Currently At</div>
        <div class="pos-name">${he(curStn.station_name)}</div>
        <div class="pos-sub">${he(curStn.stationCode)} · Platform ${he(curStn.platformNumber || '—')}</div>
      </div>
      <div class="pos-next">${nextStop
        ? `<div class="next-lbl">NEXT STOP</div><div class="next-name">${he(nextStop.station_name)}</div><div class="next-chip">ETA ${etaStr}</div>`
        : `<div class="next-chip">🏁 Final Destination</div>`
      }</div>
    </div>`;
  }

  function renderCountdownRow(nextStop, etaStr, etaTs) {
    const schTs = nextStop?.scheduledArrivalTime || 0;
    const expTs = etaTs / 1000;
    const isDifferent = schTs > 0 && expTs > 0 && schTs !== expTs;
    const isLate = expTs > schTs;
    const isEarly = expTs < schTs;

    return `<div class="cd-row">
      <div><div class="cd-lbl">ARRIVES IN</div><div class="cd-val" id="cdVal">--:--</div></div>
      <div style="flex:1">
        <div class="cd-stn">${he(nextStop?.station_name || '')}</div>
        <div class="cd-code">${he(nextStop?.stationCode || '')} · PF ${he(nextStop?.platformNumber || '—')}</div>
      </div>
      <div class="cd-right">
        <div class="cd-sched-lbl">${isDifferent ? (isEarly ? 'EARLY' : 'EXPECTED') : 'SCHEDULED'}</div>
        ${isDifferent ? `<div class="t-sch" style="font-size:11px;margin-bottom:2px">${fmt(schTs)}</div>` : ''}
        <div class="cd-sched-val" style="${isLate ? 'color:var(--red)' : isEarly ? 'color:var(--green)' : ''}">${etaStr}</div>
      </div>
    </div>`;
  }

  function renderMapSection(lat, lng) {
    const gmapUrl = `https://maps.google.com/maps?q=${lat},${lng}&z=14&output=embed`;
    return `<div class="train-map-section">
      <button class="train-map-toggle" id="trainMapToggle">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 20l-5.447-2.724A1 1 0 0 1 3 16.382V5.618a1 1 0 0 1 1.447-.894L9 7m0 13V7m0 13 6 1m-6-14 6-2m0 15 5.447-2.724A1 1 0 0 0 21 16.382V5.618a1 1 0 0 0-1.447-.894L15 7m0 13V7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Live Train Location
        <span style="margin-left:6px;font-size:10px;opacity:.6;font-family:var(--mono)">${Number(lat).toFixed(4)}°, ${Number(lng).toFixed(4)}°</span>
        <svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="train-map-outer" id="trainMapOuter">
        <div class="map-tab-bar">
          <button class="map-tab active" data-map="leaflet">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10A15.3 15.3 0 0 1 8 12a15.3 15.3 0 0 1 4-10z" stroke="currentColor" stroke-width="1.8"/></svg>
            OpenStreetMap
          </button>
          <button class="map-tab" data-map="google">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" fill="currentColor"/></svg>
            Google Maps
          </button>
        </div>
        <div class="map-pane active" id="mapPaneLeaflet"><div id="trainLeafletMap"></div></div>
        <div class="map-pane" id="mapPaneGoogle" data-src="${he(gmapUrl)}"></div>
      </div>
    </div>`;
  }

  function renderShareRow() {
    return `<div class="share-row">
      <span class="share-lbl">Share</span>
      <button class="share-btn" id="copyShareBtn"><span class="material-symbols-rounded" style="font-size:15px">content_copy</span> Copy</button>
      <button class="share-btn" id="waShareBtn"><span class="material-symbols-rounded" style="font-size:15px">chat</span> WhatsApp</button>
      <button class="share-btn" id="dlShareBtn"><span class="material-symbols-rounded" style="font-size:15px">download</span> Save</button>
    </div>`;
  }

  function renderAutoBar() {
    return `<div class="auto-bar">
      <div class="auto-bar-l">
        <div class="live-ind"><div class="live-dot"></div>LIVE</div>
        <div class="ar-prog"><div class="ar-fill" id="arFill" style="width:0%"></div></div>
      </div>
      <span class="ar-lbl" id="arCd">Next in ${CFG.AR_INTERVAL_SECS}s</span>
    </div>`;
  }

  function renderTabs() {
    return `<div class="md3-tabs">
      <button class="tab-btn active" data-tab="tab-tl">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><line x1="8" y1="6" x2="21" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="8" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="8" y1="18" x2="21" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="3" y1="6" x2="3.01" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="3" y1="12" x2="3.01" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="3" y1="18" x2="3.01" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        Timeline
      </button>
      <button class="tab-btn" data-tab="tab-table">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="1.8"/><line x1="3" y1="9" x2="21" y2="9" stroke="currentColor" stroke-width="1.8"/><line x1="3" y1="15" x2="21" y2="15" stroke="currentColor" stroke-width="1.8"/><line x1="9" y1="9" x2="9" y2="21" stroke="currentColor" stroke-width="1.8"/></svg>
        All Stops
      </button>
      <button class="tab-btn" data-tab="tab-info">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><line x1="12" y1="8" x2="12" y2="8.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="12" y1="12" x2="12" y2="16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        Details
      </button>
    </div>`;
  }

  function renderTimeline(route, curIdx) {
    let h = `<div id="tab-tl" class="tab-content active"><div class="lp-timeline"><div class="sec-title">Journey Timeline</div><div class="tl-wrap"><div class="tl-line"></div>`;
    for (let i = 0; i < route.length; i++) {
      const s = route[i], isCur = i === curIdx, isPast = i < curIdx;
      const isNonStop = s.isStoppage === false || s.isStoppage === 0 || s.stoppage === false || s.stoppage === 0 || s.haltDuration === 0 || s.haltDuration === "00:00" || s.haltMins === 0 || (s.scheduledArrivalTime === s.scheduledDepartureTime && s.scheduledArrivalTime !== null && i !== 0 && i !== route.length - 1);
      const cls  = isCur ? 'current' : isPast ? 'past' : 'future';
      const aD   = delaySecs(s.actualArrivalTime, s.scheduledArrivalTime);
      const dD   = delaySecs(s.actualDepartureTime, s.scheduledDepartureTime);
      const aCls = s.actualArrivalTime   ? (aD > CFG.DELAY_CHIP_THRESH ? 'r' : 'g') : 'd';
      const dCls = s.actualDepartureTime ? (dD > CFG.DELAY_CHIP_THRESH ? 'r' : 'g') : 'd';
      let statusBadge = '';
      if      (isCur)            statusBadge = `<span class="stop-status s-here">● Here</span>`;
      else if (isPast)           statusBadge = `<span class="stop-status s-done">✓ Done</span>`;
      else if (i === curIdx + 1) statusBadge = `<span class="stop-status s-next">→ Next</span>`;
      else                       statusBadge = `<span class="stop-status s-upcoming">Upcoming</span>`;
      h += `<div class="stop ${cls}"><div class="stop-dot">${isCur ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" style="display:block;color:white"><path d="M12 2c-4 0-6 2-6 6v7c0 1.5.5 3 2 3l-2 2v1h12v-1l-2-2c1.5 0 2-1.5 2-3V8c0-4-2-6-6-6zm0 3c1.5 0 2 .5 2 1.5s-.5 1.5-2 1.5-2-.5-2-1.5S10.5 5 12 5zm-3 8c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1zm6 0c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1z" fill="currentColor"/></svg>` : ''}</div>
        <div class="stop-row">
          <div class="stop-info">
            <div class="sname" style="display:inline-flex;align-items:center;flex-wrap:wrap;gap:6px">
              ${he(s.station_name)}
              ${isNonStop ? `<span class="non-stop-badge">Non Stop</span>` : ''}
            </div>
            <div class="scode">${he(s.stationCode)} · #${s.stopIndex || (i + 1)}</div>
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:3px">
              ${statusBadge}
              ${s.platformNumber ? `<div class="pf-chip">PF ${he(s.platformNumber)}</div>` : ''}
            </div>
          </div>
          <div class="stop-times">
            <div class="t-grp"><div class="t-label">Arrival</div>${aD > CFG.DELAY_CHIP_SECS ? `<div class="t-sch">${fmt(s.scheduledArrivalTime)}</div>` : ''}<div class="t-val ${aCls}">${fmt(s.actualArrivalTime || s.scheduledArrivalTime)}</div>${aD > CFG.DELAY_CHIP_SECS ? `<div class="d-chip">+${Math.round(aD / 60)}m late</div>` : ''}</div>
            <div class="t-grp"><div class="t-label">Depart</div>${dD > CFG.DELAY_CHIP_SECS ? `<div class="t-sch">${fmt(s.scheduledDepartureTime)}</div>` : ''}<div class="t-val ${dCls}">${fmt(s.actualDepartureTime || s.scheduledDepartureTime)}</div>${dD > CFG.DELAY_CHIP_SECS ? `<div class="d-chip">+${Math.round(dD / 60)}m late</div>` : ''}</div>
          </div>
        </div>
      </div>${i < route.length - 1 ? '<hr class="stop-div">' : ''}`;
    }
    return h + `</div></div></div></div>`;
  }

  function renderStopsTable(route, curIdx) {
    let h = `<div id="tab-table" class="tab-content"><div style="padding:16px 20px;background:var(--surface)"><div class="sec-title">All Stops</div>
      <div class="stops-wrap"><table>
        <thead><tr><th>#</th><th>Station</th><th>Code</th><th>PF</th><th>Sch Arr</th><th>Act Arr</th><th>Sch Dep</th><th>Act Dep</th><th>Delay</th></tr></thead>
        <tbody>`;
    for (let i = 0; i < route.length; i++) {
      const s   = route[i], isCur = i === curIdx, isPast = i < curIdx;
      const isNonStop = s.isStoppage === false || s.isStoppage === 0 || s.stoppage === false || s.stoppage === 0 || s.haltDuration === 0 || s.haltDuration === "00:00" || s.haltMins === 0 || (s.scheduledArrivalTime === s.scheduledDepartureTime && s.scheduledArrivalTime !== null && i !== 0 && i !== route.length - 1);
      const rc  = isCur ? 'row-cur' : isPast ? 'row-past' : 'row-fut';
      const md  = Math.max(delaySecs(s.actualArrivalTime, s.scheduledArrivalTime), delaySecs(s.actualDepartureTime, s.scheduledDepartureTime));
      h += `<tr class="${rc}"><td>${i + 1}${isCur ? '<span class="cur-arrow"> ◀</span>' : ''}</td>
        <td class="td-name">
          <div style="display:inline-flex;align-items:center;flex-wrap:wrap;gap:6px">
            ${he(s.station_name)}
            ${isNonStop ? `<span class="non-stop-badge">Non Stop</span>` : ''}
          </div>
        </td><td class="td-code">${he(s.stationCode)}</td>
        <td class="td-pf">${he(s.platformNumber || '—')}</td>
        <td class="td-t">${fmt(s.scheduledArrivalTime)}</td><td class="td-t">${fmt(s.actualArrivalTime)}</td>
        <td class="td-t">${fmt(s.scheduledDepartureTime)}</td><td class="td-t">${fmt(s.actualDepartureTime)}</td>
        <td class="td-d ${md > CFG.DELAY_CHIP_THRESH ? 'late' : 'ok'}">${md > CFG.DELAY_CHIP_SECS ? '+' + Math.round(md / 60) + 'm' : '—'}</td>
      </tr>`;
    }
    return h + `</tbody></table></div></div></div>`;
  }

  function renderInfoTab(trainNo, trainName, data, route, origin, dest, progress) {
    const cell = (label, val, small = false) =>
      `<div class="meta-it info-card">
        <div class="mlabel">${label}</div>
        <div class="mval"${small ? ' style="font-size:12px"' : ''}>${val}</div>
      </div>`;
    return `<div id="tab-info" class="tab-content"><div style="padding:16px 20px;background:var(--surface)">
      <div class="sec-title">Train Details</div>
      <div class="info-grid">
        ${cell('Train Number', he(trainNo))}
        ${cell('Train Name', he(trainName !== trainNo ? trainName : '—'), true)}
        ${cell('Data Source', he(data.dataSource || '—'), true)}
        ${cell('Stops', route.length)}
        ${cell('Progress', progress + '%')}
        ${cell('Origin', he(origin?.station_name || '—'), true)}
        ${cell('Destination', he(dest?.station_name || '—'), true)}
      </div>
    </div></div>`;
  }

  /* ── Post-render wire functions ── */

  function wireCountdown(etaTs) {
    if (!etaTs) return;
    // Guard: clear any previous interval before starting a new one
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
      const el = $('cdVal');
      if (!el) { clearInterval(countdownInterval); countdownInterval = null; return; }
      const diff = etaTs - Date.now();
      if (diff <= 0) {
        el.textContent = 'Arriving';
        el.style.color = 'var(--green)';
        animateCountdownTick(el);
        clearInterval(countdownInterval);
        countdownInterval = null;
        return;
      }
      const m = Math.floor(diff / 60_000), sc = Math.floor((diff % 60_000) / 1000);
      el.textContent = `${pad(m)}:${pad(sc)}`;
      el.style.color = m < CFG.COUNTDOWN_WARN_MINS ? 'var(--red)' : '';
      animateCountdownTick(el);
    }, 1000);
  }

  function wireFavBtn(trainNo, trainName) {
    const lpFav = $('lpFavBtn');
    if (!lpFav) return;
    lpFav.addEventListener('click', () => {
      if (isFav(trainNo)) { removeFav(trainNo); lpFav.classList.remove('active'); showFavConfirm('Removed from favourites'); }
      else                { saveFav(trainNo, trainName); lpFav.classList.add('active'); showFavConfirm('★ Added to favourites'); }
    });
  }

  function wireDateSelect(trainNo, trainName) {
    const sel = $('liveDateSelect');
    if (!sel) return;
    sel.addEventListener('change', (e) => {
      curDayOffset = parseInt(e.target.value, 10) || 0;
      doLive(trainNo, trainName, 'replace', null, curDayOffset);
    });
  }

  function wireMap(lat, lng, trainName, curStn, isLate, delayMins, speedKmh, progress) {
    if (lat == null || lng == null) return;
    const trainMapToggle = $('trainMapToggle');
    const trainMapOuter  = $('trainMapOuter');
    let   leafletMap     = null;
    let   leafletPollTimer = null;

    function buildLeafletMap() {
      const container = $('trainLeafletMap');
      if (!container || leafletMap) return;
      // Guard: if container is not visible, invalidateSize will silently fail
      if (typeof L === 'undefined') {
        let attempts = 0;
        leafletPollTimer = setInterval(() => {
          attempts++;
          if (typeof L !== 'undefined') { clearInterval(leafletPollTimer); buildLeafletMap(); }
          else if (attempts >= CFG.LEAFLET_POLL_MAX) {
            clearInterval(leafletPollTimer);
            container.innerHTML = '<div style="padding:20px;text-align:center;opacity:.5;font-size:13px">Map failed to load</div>';
          }
        }, CFG.LEAFLET_POLL_MS);
        return;
      }
      try {
        delete L.Icon.Default.prototype._getIconUrl;
        L.Icon.Default.mergeOptions({
          iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
          iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
          shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
        });
        const isMobile = window.innerWidth <= 768 || ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
        leafletMap = L.map(container, {
          zoomControl: !isMobile,
          attributionControl: true,
          scrollWheelZoom: !isMobile,
          dragging: !isMobile,
          touchZoom: !isMobile
        });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(leafletMap);
        leafletMap.setView([lat, lng], 14);
        L.circle([lat, lng], { radius: CFG.ACCURACY_CIRCLE_M, className: 'leaflet-accuracy-circle' }).addTo(leafletMap);
        const trainIconHtml = `<div class="train-marker-wrap"><div class="train-marker-pulse2"></div><div class="train-marker-pulse"></div><div class="train-marker-icon">${SVG.train}</div></div>`;
        const trainIcon = L.divIcon({ html: trainIconHtml, className: '', iconSize: [40, 40], iconAnchor: [20, 20], popupAnchor: [0, -24] });
        const delayTxt  = isLate ? ('+' + delayMins + ' min late') : 'On Time';
        const popupHtml = `<div><div class="map-popup-title">🚆 ${he(trainName)}</div>
          <div class="map-popup-row"><span class="map-popup-lbl">Station</span><span class="map-popup-val">${he(curStn ? curStn.station_name : trainName)}</span></div>
          <div class="map-popup-row"><span class="map-popup-lbl">Delay</span><span class="map-popup-val" style="color:${isLate ? 'var(--red)' : 'var(--green)'}">${delayTxt}</span></div>
          <div class="map-popup-row"><span class="map-popup-lbl">Speed</span><span class="map-popup-val">${speedKmh != null ? speedKmh + ' km/h' : '—'}</span></div>
          <div class="map-popup-row"><span class="map-popup-lbl">Progress</span><span class="map-popup-val">${progress}%</span></div>
        </div>`;
        L.marker([lat, lng], { icon: trainIcon, zIndexOffset: 1000 }).addTo(leafletMap);
        // Invalidate after a brief delay to handle hidden containers
        setTimeout(() => { if (leafletMap) leafletMap.invalidateSize(); }, CFG.MAP_INVALIDATE_MS);
      } catch (e) {
        container.innerHTML = '<div style="padding:20px;text-align:center;opacity:.5;font-size:13px">Map error — try refreshing</div>';
      }
    }

    if (trainMapOuter) {
      trainMapOuter.querySelectorAll('.map-tab').forEach(tab => {
        tab.addEventListener('click', function () {
          trainMapOuter.querySelectorAll('.map-tab').forEach(t => t.classList.remove('active'));
          trainMapOuter.querySelectorAll('.map-pane').forEach(p => p.classList.remove('active'));
          this.classList.add('active');
          const paneId = 'mapPane' + this.dataset.map.charAt(0).toUpperCase() + this.dataset.map.slice(1);
          const pane   = document.getElementById(paneId);
          if (pane) {
            pane.classList.add('active');
            if (this.dataset.map === 'leaflet') {
              buildLeafletMap();
              // Only call invalidateSize if map exists and container is visible
              if (leafletMap) setTimeout(() => {
                if (leafletMap && pane.offsetParent !== null) leafletMap.invalidateSize();
              }, CFG.MAP_TAB_INVALIDATE);
            } else if (this.dataset.map === 'google') {
              if (!pane.querySelector('iframe')) {
                const src = pane.dataset.src;
                pane.innerHTML = `<iframe class="gmap-frame" src="${src}" loading="lazy" allowfullscreen referrerpolicy="no-referrer-when-downgrade"></iframe>`;
              }
            }
          }
        });
      });
    }

    if (trainMapToggle) {
      trainMapToggle.addEventListener('click', function () {
        const isOpen = trainMapOuter?.classList.contains('open');
        trainMapOuter?.classList.toggle('open', !isOpen);
        this.classList.toggle('open', !isOpen);
        if (!isOpen) buildLeafletMap();
      });
      // Auto-open when coords available (always open)
      if (lat != null && lng != null) {
        setTimeout(() => {
          if (trainMapOuter && !trainMapOuter.classList.contains('open')) {
            trainMapOuter.classList.add('open');
            trainMapToggle.classList.add('open');
            buildLeafletMap();
          }
        }, CFG.MAP_AUTO_OPEN_MS);
      }
    }
  }

  function wireShare(trainNo, trainName, curStn, curCode, dest, isLate, delayMins, progress) {
    const liveUrl = window.location.origin + buildTrainUrl(trainNo, trainName);
    const shareText = `🚆 ${trainNo} — ${trainName}\n📍 At: ${curStn ? curStn.station_name : curCode || '—'}\n⏱ Delay: ${isLate ? '+' + delayMins + ' min' : 'On time'}\n🏁 Destination: ${dest ? dest.station_name : '—'}\n📊 Progress: ${progress}%\n\n🔗 Live Link: ${liveUrl}`;
    const cpBtn = $('copyShareBtn');
    if (cpBtn) cpBtn.addEventListener('click', function () {
      navigator.clipboard.writeText(liveUrl)
        .then(() => { toast('Live URL Copied!', 'done'); this.classList.add('copied'); setTimeout(() => this.classList.remove('copied'), 2000); })
        .catch(() => toast('Copy failed — try long-pressing', 'error'));
    });
    const waBtn = $('waShareBtn');
    if (waBtn) waBtn.addEventListener('click', () => window.open('https://wa.me/?text=' + encodeURIComponent(shareText), '_blank'));
    const dlBtn = $('dlShareBtn');
    if (dlBtn) dlBtn.addEventListener('click', () => {
      try {
        const a   = document.createElement('a');
        a.href     = URL.createObjectURL(new Blob([shareText], { type: 'text/plain' }));
        a.download = `train-${trainNo}-status.txt`;
        a.click();
        toast('Saved!', 'done');
      } catch (e) { toast('Save failed', 'error'); }
    });
  }

  function wireTabs(lv) {
    lv.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
      btn.addEventListener('click', function () {
        lv.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        lv.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        this.classList.add('active');
        const t = document.getElementById(this.dataset.tab);
        if (t) t.classList.add('active');
      });
    });
  }

  /* ══════════════════════════════════════════════
     PREFETCH ENGINE
  ══════════════════════════════════════════════ */
  const prefetchCache    = new Map();
  const prefetchInFlight = new Set();

  async function prefetchTrain(num, name) {
    if (!num) return;
    if (prefetchInFlight.has(num)) return;
    prefetchInFlight.add(num);
    try {
      const today = getDateString(0);
      await fetchData(`/live-status?trainNo=${encodeURIComponent(num)}&startDate=${today}`);
      // Older browsers may not support CSS.escape or complex selectors —
      // fall back to filtering all nodes with the attribute.
      document.querySelectorAll('[data-prefetch-num]').forEach(el => {
        if (el.getAttribute('data-prefetch-num') === String(num)) {
          el.classList.remove('prefetching');
          el.classList.add('prefetched');
        }
      });
    } catch (e) { /* silent — prefetch failure is non-critical */ }
    finally { prefetchInFlight.delete(num); }
  }

  function attachPrefetch(el, num, name) {
    if (!el || !num || el._pfAttached) return;
    el._pfAttached = true;
    el.setAttribute('data-prefetch-num', num);
    const trigger = () => { el.classList.add('prefetching'); prefetchTrain(num, name); };
    el.addEventListener('mouseenter',  trigger, { passive: true });
    el.addEventListener('touchstart',  trigger, { passive: true, once: true });
    el.addEventListener('focus',       trigger, { passive: true });
  }

  async function doLive(num, name, routeAction = 'push', triggerEl = null, forceDayOffset = null) {
    if (!num) return;
    restoreSearchWrap();
    const resolvedName = await resolveTrainName(num, name);
    syncRoute(num, resolvedName !== num ? resolvedName : null, routeAction === 'replace');
    DOM.searchResults.innerHTML = '';
    clearInterval(countdownInterval); stopAR();
    
    if (forceDayOffset !== null) {
      curDayOffset = forceDayOffset;
    } else if (curNum !== num) {
      curDayOffset = 0; // reset to today for new train
    }
    
    curNum = num; curName = resolvedName;
    DOM.refreshBtn.style.display = 'flex';
    clearSuggest(); si.value = '';
    DOM.liveView.innerHTML = loader("Loading live status...");
    try {
      const today = getDateString(curDayOffset);
      const d = await fetchData(`/live-status?trainNo=${encodeURIComponent(num)}&startDate=${today}`);
      
      // Auto-switch to yesterday if today hasn't started but an active run from yesterday is returned
      if (forceDayOffset === null && curDayOffset === 0 && d.data?.route?.length) {
        const originStn = d.data.route[0];
        if (originStn && originStn.scheduledDepartureTime) {
          const dDate = new Date(originStn.scheduledDepartureTime * 1000);
          const tDate = new Date();
          tDate.setHours(dDate.getHours(), dDate.getMinutes(), dDate.getSeconds(), 0);
          const todayStartTs = Math.floor(tDate.getTime() / 1000);
          
          if (Date.now() / 1000 < todayStartTs) {
            const curCode = d.data.currentPosition?.stationCode;
            let curIdx = -1;
            for (let i = 0; i < d.data.route.length; i++) {
              if (d.data.route[i].stationCode === curCode) { curIdx = i; break; }
            }
            const progress = curIdx >= 0 ? Math.round(curIdx / Math.max(d.data.route.length - 1, 1) * 100) : 0;
            const isReached = curIdx === d.data.route.length - 1 || progress === 100;
            
            if (curIdx > 0 && !isReached) {
              curDayOffset = -1;
            }
          }
        }
      }
      
      const apiName = d.data?.trainName || d.data?.train_name || d.data?.name;
      if (apiName && apiName !== num) {
        curName = apiName;
        trainNameCache.set(String(num), apiName);
        syncRoute(num, apiName, true);
      }
      
      lastRefTs = new Date();
      renderLive(d.data, curNum, curName);
      updateLastRef();
      startAR();
    } catch (err) {
      const msg  = friendlyError(err);
      const hint = errorHint(err);
      DOM.liveView.innerHTML = renderError(`Failed to load: ${msg}`, hint);
      if (err instanceof NetworkError || (err instanceof ApiError && err.status >= 500)) {
        DOM.liveView.innerHTML += `<div style="padding:0 20px 16px"><button class="track-btn" id="retryLiveBtn" style="margin-top:8px">↺ Retry</button></div>`;
        $('retryLiveBtn')?.addEventListener('click', () => doLive(num, name));
      }
    }
  }

  /* ══════════════════════════════════════════════
     STORAGE  (recent + favourites)
  ══════════════════════════════════════════════ */
  function getRecent()       { try { return JSON.parse(localStorage.getItem('tt-recent') || '[]'); } catch { return []; } }
  function saveRecent(num, name) {
    let r = getRecent().filter(x => x.num !== num);
    r.unshift({ num, name });
    if (r.length > CFG.RECENT_MAX) r = r.slice(0, CFG.RECENT_MAX);
    try { localStorage.setItem('tt-recent', JSON.stringify(r)); } catch (e) { /* storage full */ }
  }
  function clearRecent()     { try { localStorage.removeItem('tt-recent'); } catch (e) {} showWelcome(); toast('Cleared', 'done'); }
  function getFavs()         { try { return JSON.parse(localStorage.getItem('tt-favs')   || '[]'); } catch { return []; } }
  function isFav(num)        { return getFavs().some(f => f.num === String(num)); }
  function saveFav(num, name){ let f = getFavs().filter(x => x.num !== String(num)); f.unshift({ num: String(num), name }); try { localStorage.setItem('tt-favs', JSON.stringify(f)); } catch (e) {} }
  function removeFav(num)    { let f = getFavs().filter(x => x.num !== String(num)); try { localStorage.setItem('tt-favs', JSON.stringify(f)); } catch (e) {} }

  function getPersistedSearchCache(query) {
    const key = normalizeCacheKey(query);
    if (!key) return null;
    const memoryHit = searchCacheMemory.get(key);
    if (memoryHit) return memoryHit;
    const cache = readJson(SEARCH_CACHE_KEY, []);
    const hit = cache.find(item => item.q === key) || null;
    if (hit) searchCacheMemory.set(key, hit);
    return hit;
  }

  function saveSearchCache(query, trains) {
    const key = normalizeCacheKey(query);
    if (!key) return;
    let cache = readJson(SEARCH_CACHE_KEY, []);
    cache = cache.filter(item => item.q !== key);
    const entry = { q: key, label: String(query).trim(), ts: Date.now(), data: trains };
    cache.unshift(entry);
    if (cache.length > CFG.SEARCH_CACHE_MAX) cache = cache.slice(0, CFG.SEARCH_CACHE_MAX);
    writeJson(SEARCH_CACHE_KEY, cache);
    searchCacheMemory.set(key, entry);
  }

  function getPersistedLiveCache(num) {
    const key = String(num == null ? '' : num).trim();
    if (!key) return null;
    const cache = readJson(LIVE_CACHE_KEY, []);
    return cache.find(item => item.num === key) || null;
  }

  function saveLiveCache(num, data, name) {
    const key = String(num == null ? '' : num).trim();
    if (!key || !data) return;
    let cache = readJson(LIVE_CACHE_KEY, []);
    cache = cache.filter(item => item.num !== key);
    cache.unshift({ num: key, name: name || key, ts: Date.now(), data });
    if (cache.length > CFG.LIVE_CACHE_MAX) cache = cache.slice(0, CFG.LIVE_CACHE_MAX);
    writeJson(LIVE_CACHE_KEY, cache);
  }

  function showFavConfirm(msg) {
    const el = DOM.favConfirm;
    if (!el) return;
    el.textContent = msg; el.classList.add('show');
    clearTimeout(showFavConfirm._t);
    showFavConfirm._t = setTimeout(() => el.classList.remove('show'), CFG.FAV_CONFIRM_MS);
  }

  /* ══════════════════════════════════════════════
     WELCOME
  ══════════════════════════════════════════════ */
  function showWelcome() {
    let h = `
    <div class="rr-welcome">
      <div class="rr-welcome-top">
        <a href="#" class="rr-map-btn" style="text-decoration:none">
          <div class="rr-map-icon"><span class="material-symbols-rounded">radar</span></div>
          <div class="rr-map-info">
            <div class="rr-map-title">Live Train Map <span class="rr-badge-live">Live</span></div>
            <div class="rr-map-sub">Track 132,000 km of active rail network</div>
          </div>
          <div class="rr-map-arrow"><span class="material-symbols-rounded">arrow_forward</span></div>
        </a>

        <div class="rr-card">
          <div class="rr-card-header">
            <div class="rr-icon-bg bg-success-light"><span class="material-symbols-rounded text-success">arrow_right_alt</span></div>
            <span>Find Trains</span>
          </div>
          <div class="rr-card-body">
            <div class="rr-input-row">
              <span class="material-symbols-rounded text-success">location_on</span>
              <input type="text" id="rrFromStn" placeholder="From Station Code (e.g. NDLS)" class="rr-input-clear" style="text-transform: uppercase;">
            </div>
            <div class="rr-input-row border-top">
              <span class="material-symbols-rounded text-primary">train</span>
              <input type="text" id="rrToStn" placeholder="To Station Code (e.g. BPL)" class="rr-input-clear" style="text-transform: uppercase;">
            </div>
            <div class="rr-card-action">
              <button id="rrFindBtn" class="rr-btn rr-btn-primary">View Trains <span class="material-symbols-rounded" style="font-size:16px;margin-left:4px">arrow_forward</span></button>
            </div>
          </div>
        </div>

        <div class="rr-card">
          <div class="rr-card-header">
            <div class="rr-icon-bg bg-primary-light"><span class="material-symbols-rounded text-primary">train</span></div>
            <span>Live Train Status</span>
          </div>
          <div class="rr-card-body" style="display:flex;align-items:center;gap:10px;padding:12px 16px;">
            <div style="flex:1">
              <input type="text" id="rrWelcomeTrainSearch" class="rr-input-clear" placeholder="Train number or name" autocomplete="off">
            </div>
            <button class="rr-btn rr-btn-primary" id="rrWelcomeTrainBtn" style="padding:10px 14px; width: auto;"><span class="material-symbols-rounded">search</span></button>
          </div>
        </div>

        <div class="rr-card">
          <div class="rr-card-header">
            <div class="rr-icon-bg bg-primary-light"><span class="material-symbols-rounded text-primary">radar</span></div>
            <span>Live Station Board</span>
          </div>
          <div class="rr-card-body" style="display:flex;align-items:center;gap:10px;padding:12px 16px;">
            <div style="flex:1">
              <input type="text" placeholder="Station code or name" disabled class="rr-input-clear">
            </div>
            <button class="rr-btn rr-btn-primary" disabled style="padding:10px 14px; width: auto;"><span class="material-symbols-rounded">search</span></button>
          </div>
        </div>
      </div>

      <div class="rr-welcome-text-sections">
        <div class="rr-hero-banner">
          <h1>Live Train Running Status</h1>
          <p>Check the exact live train status and real-time GPS location of any Indian Railways train. Track current speed, delay, and expected arrival time instantly on an interactive map.</p>
        </div>

        <div class="rr-text-card">
          <h2>TrainTracker Features</h2>
          <div class="rr-grid-2">
            <div class="rr-feature">
              <h3><span class="material-symbols-rounded text-primary">radar</span> Visual Train Tracking</h3>
              <p>Watch trains move live on an interactive map using real-time GPS telemetry.</p>
            </div>
            <div class="rr-feature">
              <h3><span class="material-symbols-rounded text-primary">route</span> Trains Between Stations</h3>
              <p>Search available trains running between two stations and check their live running status.</p>
            </div>
            <div class="rr-feature">
              <h3><span class="material-symbols-rounded text-primary">bolt</span> Live Station Arrivals</h3>
              <p>View the live station board for upcoming train arrivals and departures.</p>
            </div>
            <div class="rr-feature">
              <h3><span class="material-symbols-rounded text-primary">navigation</span> Offline Mode</h3>
              <p>Track train locations without an internet connection using the mobile application.</p>
            </div>
          </div>
        </div>

        <div class="rr-text-card">
          <h2 style="display:flex;align-items:center;gap:8px;"><span class="material-symbols-rounded text-primary">search</span>How to check train status</h2>
          <div class="rr-grid-3">
            <div class="rr-step">
              <h3><span class="rr-step-num">1</span> Enter Train Details</h3>
              <p>Input the 5-digit train number or train name in the search box.</p>
            </div>
            <div class="rr-step">
              <h3><span class="rr-step-num">2</span> View Live Location</h3>
              <p>See the train's exact coordinates, speed, and delay on the map.</p>
            </div>
            <div class="rr-step">
              <h3><span class="rr-step-num">3</span> Check Arrival Time</h3>
              <p>Review the timetable for expected arrival times and platform numbers.</p>
            </div>
          </div>
        </div>

        <div class="rr-text-card rr-bg-muted">
          <h2>About TrainTracker</h2>
          <p>TrainTracker is a modern transit tracking platform built to visualize Indian Railways data. Rather than displaying a static list of passed stations, the application plots all active trains directly on an interactive geographical map.</p>
          <p style="margin-top:12px">By aggregating live GPS telemetry, the system calculates precise real-time location updates, delays, and dynamic arrival estimations directly on the map interface.</p>
        </div>

        <div class="rr-text-card" style="padding:0;overflow:hidden">
          <div class="rr-faq-header">
            <span class="material-symbols-rounded">help</span> Frequently Asked Questions
          </div>
          <div class="rr-faq-item">
            <h4>How do I find my train running status?</h4>
            <p>Enter the train number or name in the search bar to view the train's real-time location on the map.</p>
          </div>
          <div class="rr-faq-item">
            <h4>Can the train status be tracked without internet?</h4>
            <p>Yes. The mobile application utilizes the device's internal GPS alongside an offline schedule to track live location without an active internet connection.</p>
          </div>
          <div class="rr-faq-item">
            <h4>Are the platform allocations accurate?</h4>
            <p>Platform numbers are predicted based on historical routing data. Passengers must verify the final platform on official railway station displays.</p>
          </div>
        </div>

        <div class="rr-notice">Notice: TrainTracker is an independent technology platform. It is not affiliated with the Ministry of Railways or IRCTC.</div>
      </div>
    </div>`;

    DOM.searchResults.innerHTML = h;
    DOM.liveView.innerHTML      = '';

    // Bind event for the Train Status search within Welcome page
    const wSearch = $('rrWelcomeTrainSearch');
    const wBtn = $('rrWelcomeTrainBtn');
    if(wSearch && wBtn) {
      wSearch.addEventListener('keypress', (e) => {
        if(e.key === 'Enter' && wSearch.value.trim().length >= 2) {
          DOM.searchInput.value = wSearch.value.trim();
          doSearch(wSearch.value.trim());
        }
      });
      wBtn.addEventListener('click', () => {
        if(wSearch.value.trim().length >= 2) {
          DOM.searchInput.value = wSearch.value.trim();
          doSearch(wSearch.value.trim());
        }
      });
    }

    // Bind event for Find Trains (Between Stations)
    const rrFrom = $('rrFromStn');
    const rrTo = $('rrToStn');
    const rrFindBtn = $('rrFindBtn');
    if (rrFrom && rrTo && rrFindBtn) {
      rrFindBtn.addEventListener('click', () => {
        const fromCode = rrFrom.value.trim().toUpperCase();
        const toCode = rrTo.value.trim().toUpperCase();
        if (fromCode.length >= 2 && toCode.length >= 2) {
          doFindTrains(fromCode, toCode);
        } else {
          toast('Enter valid station codes', 'error');
        }
      });
      
      const onEnter = (e) => {
        if (e.key === 'Enter') rrFindBtn.click();
      };
      rrFrom.addEventListener('keypress', onEnter);
      rrTo.addEventListener('keypress', onEnter);
    }

    // Hide global search wrap in header while on welcome, to match RailRadar minimalist look
    const searchWrap = $('trainSearchWrap');
    if (searchWrap) searchWrap.style.display = 'none';
  }

  function revealWelcomeAfterDelay() {
    if (welcomeRevealTimer) clearTimeout(welcomeRevealTimer);
    const welcome = DOM.searchResults.querySelector('.welcome');
    if (!welcome) return;
    welcome.classList.remove('is-visible');
    welcomeRevealTimer = setTimeout(() => welcome.classList.add('is-visible'), 240);
  }

  function renderLiveLoading(num, name, pct = 0) {
    return `<div class="travel-canvas live-loading-overlay" aria-busy="true" aria-live="polite">
      <canvas id="liveArrowCanvas"></canvas>
      <div class="live-loading-panel">
        <div class="live-loading-orbit">
          <span class="material-symbols-rounded live-loading-arrow">arrow_forward</span>
          <span class="live-loading-pct">${pct}%</span>
        </div>
        <div class="live-loading-copy">
          <div class="live-loading-title">Loading live status</div>
          <div class="live-loading-sub">${he(name || num)} is being prepared in full.</div>
        </div>
        <div class="live-loading-track"><div class="live-loading-fill" style="width:${pct}%"></div></div>
      </div>
    </div>`;
  }

  function clearLiveLoading() {
    if (liveLoadingFrame) {
      cancelAnimationFrame(liveLoadingFrame);
      liveLoadingFrame = null;
    }
    liveLoadingPct = 0;
    liveLoadingReady = false;
    liveLoadingData = null;
    liveLoadingCanvas = null;
    liveLoadingCtx = null;
    liveLoadingButton = null;
  }

  function finishLiveLoading(token) {
    if (token !== liveLoadingToken || !liveLoadingReady || !liveLoadingData) return;
    const data = liveLoadingData;
    const trainNo = curNum;
    const trainName = curName;
    clearLiveLoading();
    renderLive(data, trainNo, trainName);
    updateLastRef();
    startAR();
  }

  function drawLiveLoadingFrame(progress, name, num) {
    if (!liveLoadingCanvas || !liveLoadingCtx) return;
    const canvas = liveLoadingCanvas;
    const ctx = liveLoadingCtx;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const currentX = liveLoadingStartX + (liveLoadingEndX - liveLoadingStartX) * progress;
    const currentY = liveLoadingStartY;
    const barWidth = w * 0.7;
    const barHeight = 8;
    const barX = (w - barWidth) / 2;
    const barY = h - 45;
    ctx.fillStyle = 'rgba(30, 40, 55, 0.7)';
    ctx.fillRect(barX, barY, barWidth, barHeight);
    const fillWidth = barWidth * progress;
    const gradient = ctx.createLinearGradient(barX, barY, barX + Math.max(fillWidth, 1), barY);
    gradient.addColorStop(0, '#aaff33');
    gradient.addColorStop(1, '#b5ff4f');
    ctx.fillStyle = gradient;
    ctx.fillRect(barX, barY, fillWidth, barHeight);
    ctx.font = "bold 18px 'Segoe UI', 'Inter', monospace";
    ctx.fillStyle = '#d0ff90';
    ctx.shadowBlur = 4;
    ctx.shadowColor = '#aaff33aa';
    ctx.fillText(`${Math.floor(progress * 100)}%`, barX + Math.max(fillWidth - 28, 0), barY - 8);
    ctx.fillStyle = '#c0ff80';
    ctx.font = '12px monospace';
    ctx.fillText('LOADING PROGRESS', barX, barY - 12);
    ctx.save();
    ctx.shadowBlur = 8;
    ctx.shadowColor = '#aaff66';
    const tipX = currentX;
    const tipY = Math.min(Math.max(currentY, 35), h - 35);
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - 18, tipY - 12);
    ctx.lineTo(tipX - 8, tipY - 4);
    ctx.lineTo(tipX - 8, tipY - 9);
    ctx.lineTo(tipX - 2, tipY - 2);
    ctx.lineTo(tipX - 8, tipY + 5);
    ctx.lineTo(tipX - 8, tipY + 0);
    ctx.lineTo(tipX - 18, tipY + 12);
    ctx.closePath();
    ctx.fillStyle = '#d9ff66';
    ctx.fill();
    ctx.strokeStyle = '#bdff33';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(tipX - 2, tipY, 5, 0, Math.PI * 2);
    ctx.fillStyle = 'gold';
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(tipX - 2, tipY, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = 'white';
    ctx.fill();
    for (let i = 0; i < 3; i++) {
      const trailOffset = -12 - i * 9;
      const trailAlpha = 0.5 - i * 0.15;
      ctx.beginPath();
      ctx.arc(currentX + trailOffset, tipY + (Math.sin(Date.now() * 0.01 + i) * 2), 4 - i, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(180, 255, 100, ${trailAlpha * (1 - progress * 0.4)})`;
      ctx.fill();
    }
    ctx.beginPath();
    ctx.moveTo(liveLoadingStartX, tipY);
    ctx.lineTo(currentX - 5, tipY);
    ctx.strokeStyle = '#aaff8844';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
    if (progress > 0.02) {
      ctx.beginPath();
      ctx.arc(liveLoadingStartX, tipY, 6 * (1 - progress), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(210, 255, 100, ${0.5 * (1 - progress)})`;
      ctx.fill();
    }
    if (progress > 0.85) {
      ctx.beginPath();
      ctx.arc(liveLoadingEndX, tipY, 12 + Math.sin(Date.now() * 0.015) * 3, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(170, 255, 80, ${0.5 * (progress - 0.85) / 0.15})`;
      ctx.fill();
    }
    if (progress >= 0.995) {
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.arc(liveLoadingEndX, tipY, 22, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffaa';
      ctx.shadowBlur = 20;
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
    const pctEl = DOM.liveView.querySelector('.live-loading-pct');
    const fillEl = DOM.liveView.querySelector('.live-loading-fill');
    if (pctEl) pctEl.textContent = `${Math.floor(progress * 100)}%`;
    if (fillEl) fillEl.style.width = `${Math.floor(progress * 100)}%`;
  }

  function resizeLiveLoadingCanvas() {
    if (!liveLoadingCanvas) return;
    const rect = liveLoadingCanvas.getBoundingClientRect();
    liveLoadingCanvas.width = Math.max(1, Math.floor(rect.width));
    liveLoadingCanvas.height = Math.max(1, Math.floor(rect.height));
  }

  function startLiveLoading(num, name, triggerEl = null) {
    const token = ++liveLoadingToken;
    clearLiveLoading();
    DOM.liveView.innerHTML = renderLiveLoading(num, name, 0);
    liveLoadingCanvas = DOM.liveView.querySelector('#liveArrowCanvas');
    liveLoadingCtx = liveLoadingCanvas?.getContext('2d') || null;
    liveLoadingButton = triggerEl || null;
    resizeLiveLoadingCanvas();
    const overlay = DOM.liveView.querySelector('.live-loading-overlay');
    const btnRect = liveLoadingButton?.getBoundingClientRect?.();
    const overlayRect = overlay?.getBoundingClientRect?.() || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const startX = btnRect ? (btnRect.left + btnRect.width / 2) - overlayRect.left : overlayRect.width * 0.35;
    const startY = btnRect ? (btnRect.top + btnRect.height / 2) - overlayRect.top : overlayRect.height * 0.45;
    liveLoadingStartX = Math.min(Math.max(startX, 20), overlayRect.width - 20);
    liveLoadingStartY = Math.min(Math.max(startY, 35), overlayRect.height - 35);
    liveLoadingEndX = Math.max(liveLoadingStartX + 120, overlayRect.width - 70);
    liveLoadingStart = performance.now();
    liveLoadingPct = 0;
    let completed = false;
    const tick = now => {
      if (token !== liveLoadingToken) return;
      const elapsed = now - liveLoadingStart;
      const raw = Math.min(1, elapsed / 1800);
      const eased = 1 - Math.pow(1 - raw, 1.6);
      liveLoadingPct = Math.floor(eased * 100);
      drawLiveLoadingFrame(eased, name, num);
      if (raw >= 1) completed = true;
      // Render immediately once animation is done AND data is ready (no frame delay)
      if (completed && liveLoadingReady && liveLoadingData) {
        lastRefTs = new Date();
        finishLiveLoading(token);
        return;
      }
      liveLoadingFrame = requestAnimationFrame(tick);
    };
    liveLoadingFrame = requestAnimationFrame(tick);
    return token;
  }

  /* ══════════════════════════════════════════════
     FAV MODAL
  ══════════════════════════════════════════════ */
  function openFavModal() {
    const favs = getFavs();
    let h = '';
    if (!favs.length) {
      h = '<p style="color:var(--text2)">No favourites yet. Star trains to add them here.</p>';
    } else {
      h = '<div class="chips-row" style="margin-bottom:0">';
      favs.forEach(f => {
        h += `<div style="display:flex;align-items:center;gap:8px;background:var(--bg2);border:1px solid var(--border2);border-radius:var(--r4);padding:8px 14px;font-size:13px">
          <span class="r-num" style="cursor:pointer" data-fav-track="${he(f.num)}" data-fav-name="${he(f.name)}">${he(f.num)}</span>
          <span style="cursor:pointer;flex:1" data-fav-track="${he(f.num)}" data-fav-name="${he(f.name)}">${he(f.name)}</span>
          <button data-fav-remove="${he(f.num)}" style="background:none;border:none;cursor:pointer;color:var(--red);margin-left:4px;font-size:18px;line-height:1;padding:2px 4px;border-radius:4px" title="Remove">×</button>
        </div>`;
      });
      h += '</div>';
    }
    const box = DOM.favModalContent;
    box.innerHTML = h;
    box.querySelectorAll('[data-fav-remove]').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); removeFav(btn.dataset.favRemove); showFavConfirm('Removed'); openFavModal(); });
    });
    box.querySelectorAll('[data-fav-track]').forEach(el => {
      attachPrefetch(el, el.dataset.favTrack, el.dataset.favName);
      el.addEventListener('click', () => {
        DOM.favModal.style.display = 'none';
        doLive(el.dataset.favTrack, el.dataset.favName);
        saveRecent(el.dataset.favTrack, el.dataset.favName);
      });
    });
    DOM.favModal.style.display = 'flex';
  }

  $('favMenuBtn')?.addEventListener('click', openFavModal);
  $('favModalClose')?.addEventListener('click', () => DOM.favModal.style.display = 'none');
  DOM.favModal?.addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.style.display = 'none'; });

  /* ══════════════════════════════════════════════
     HOME
  ══════════════════════════════════════════════ */
  function goHome(syncHistory = true) {
    stopAR();
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    curNum = null; curName = null;
    DOM.refreshBtn.style.display = 'none';
    si.value = ''; clearSuggest(); showWelcome();
    if (syncHistory) clearRoute(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });

    document.title = "Live Train Running Status & Tracker | TrainTracker.in";
    const metaDescEl = document.querySelector('meta[name="description"]');
    if (metaDescEl) metaDescEl.setAttribute('content', "Check exact live train running status, real-time location, delays, and platform numbers instantly. Enter your train name or number to start tracking.");
  }

  $('brandBtn')?.addEventListener('click', () => goHome(true));
  DOM.refreshBtn?.addEventListener('click', () => doRefresh(false));
  DOM.refreshBtn?.addEventListener('mouseenter', () => { if (curNum) prefetchTrain(curNum, curName); }, { passive: true });
  window.addEventListener('popstate', () => {
    const routeTrainNo = getRouteTrainNo();
    const routeTrainName = getRouteTrainName();
    if (routeTrainNo) doLive(routeTrainNo, routeTrainName, 'replace');
    else goHome(false);
  });

  /* ══════════════════════════════════════════════
     DISCLAIMER + MODALS
  ══════════════════════════════════════════════ */
  $('disclaimerLink')?.addEventListener('click', e => { e.preventDefault(); $('disclaimerModal').style.display = 'flex'; });
  $('modalCloseBtn')?.addEventListener('click', () => $('disclaimerModal').style.display = 'none');
  $('disclaimerModal')?.addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.style.display = 'none'; });

  /* ══════════════════════════════════════════════
     THEME
  ══════════════════════════════════════════════ */
  let isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  DOM.themeIcon.textContent = isDark ? 'light_mode' : 'dark_mode';
  $('themeToggleBtn')?.addEventListener('click', () => {
    isDark = !isDark;
    isDark
      ? document.documentElement.setAttribute('data-theme', 'dark')
      : document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('tt', isDark ? 'dark' : 'light'); } catch (e) {}
    DOM.themeIcon.textContent = isDark ? 'light_mode' : 'dark_mode';
  });

  /* ══════════════════════════════════════════════
     NETWORK HEALTH
  ══════════════════════════════════════════════ */
  DOM.netPill?.addEventListener('click', e => { e.stopPropagation(); DOM.netPopover?.classList.toggle('open'); });
  document.addEventListener('click', () => DOM.netPopover?.classList.remove('open'));

  function setSignalLevel(lvl, label, cls) {
    if (DOM.netSig)   DOM.netSig.className = 'net-pill-sig ' + cls;
    if (DOM.netLabel) DOM.netLabel.textContent = label;
    DOM.sigBars?.querySelectorAll('span').forEach((b, i) => b.classList.toggle('lit', i < lvl));
    const ps = $('popSignal'); if (ps) ps.textContent = label;
  }

  async function measurePing() {
    try {
      const t0 = performance.now();
      await fetch('https://www.google.com/favicon.ico?_=' + Date.now(), { mode: 'no-cors', cache: 'no-store' });
      return Math.round(performance.now() - t0);
    } catch { return null; }
  }

  async function assessSignal() {
    if (!navigator.onLine) { setSignalLevel(0, 'Offline', 's0'); const pt = $('popType'); if (pt) pt.textContent = 'Offline'; return; }
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const ef   = conn?.effectiveType ?? null;
    const dl   = conn?.downlink      ?? null;
    const rtt  = conn?.rtt           ?? null;
    const ping = await measurePing();
    const pp   = $('popPing'); if (pp) pp.textContent = ping != null ? ping + 'ms' : '—';
    let typeStr = ef ? ef.toUpperCase() : 'Unknown';
    if (conn?.type && conn.type !== 'unknown') typeStr = conn.type.charAt(0).toUpperCase() + conn.type.slice(1) + ' (' + typeStr + ')';
    const pt = $('popType'); if (pt) pt.textContent = typeStr;
    const ps = $('popSpeed'); if (ps) ps.textContent = dl != null ? dl + ' Mbps downlink' + (rtt != null ? ', RTT ' + rtt + 'ms' : '') : '—';
    let score = 5;
    if      (ef === 'slow-2g') score = 1;
    else if (ef === '2g')      score = 2;
    else if (ef === '3g')      score = 3;
    else if (ef === '4g') { score = ping > 300 ? 3 : ping > 150 ? 4 : 5; }
    if (dl != null) {
      if      (dl < 0.2) score = Math.min(score, 1);
      else if (dl < 1)   score = Math.min(score, 2);
      else if (dl < 5)   score = Math.min(score, 3);
      else if (dl < 15)  score = Math.min(score, 4);
    }
    const labels  = ['Offline', 'Very Weak', 'Weak', 'Moderate', 'Strong', 'Very Strong'];
    const classes = ['s0', 's1', 's2', 's3', 's4', 's5'];
    setSignalLevel(score, labels[score], classes[score]);
  }

  async function fetchIpInfo() {
    const apis = [
      {
        url: 'https://ipapi.co/json/',
        parse: (d) => {
          if (d.error) throw new Error(d.reason);
          return {
            ip: d.ip,
            city: d.city || '',
            region: d.region || '',
            country: d.country_name || '',
            lat: d.latitude ? Number(d.latitude).toFixed(4) : '—',
            lon: d.longitude ? Number(d.longitude).toFixed(4) : '—',
            isp: d.org || d.asn || '—'
          };
        }
      },
      {
        url: 'https://ipinfo.io/json',
        parse: (d) => {
          const coords = d.loc ? d.loc.split(',') : ['', ''];
          return {
            ip: d.ip,
            city: d.city || '',
            region: d.region || '',
            country: d.country || '',
            lat: coords[0] ? Number(coords[0]).toFixed(4) : '—',
            lon: coords[1] ? Number(coords[1]).toFixed(4) : '—',
            isp: d.org || '—'
          };
        }
      },
      {
        url: 'https://api.db-ip.com/v2/free/self',
        parse: (d) => {
          return {
            ip: d.ipAddress,
            city: d.city || '',
            region: d.stateProv || '',
            country: d.countryName || '',
            lat: '—',
            lon: '—',
            isp: '—'
          };
        }
      },
      {
        url: 'https://ipwho.is/',
        parse: (d) => {
          if (d.success === false) throw new Error('ipwhois failed');
          return {
            ip: d.ip,
            city: d.city || '',
            region: d.region || '',
            country: d.country || '',
            lat: d.latitude ? Number(d.latitude).toFixed(4) : '—',
            lon: d.longitude ? Number(d.longitude).toFixed(4) : '—',
            isp: d.connection?.isp || d.connection?.asn || '—'
          };
        }
      },
      {
        url: 'https://freeipapi.com/api/json',
        parse: (d) => {
          return {
            ip: d.ipAddress,
            city: d.cityName || '',
            region: d.regionName || '',
            country: d.countryName || '',
            lat: d.latitude ? Number(d.latitude).toFixed(4) : '—',
            lon: d.longitude ? Number(d.longitude).toFixed(4) : '—',
            isp: '—'
          };
        }
      }
    ];

    let success = false;
    for (const api of apis) {
      try {
        const r = await fetch(api.url, { cache: 'no-store' });
        if (!r.ok) continue;
        const raw = await r.json();
        const data = api.parse(raw);
        if (!data.ip) continue;

        const locStr = [data.city, data.region, data.country].filter(Boolean).join(', ') || '—';
        const locText = locStr !== '—' ? locStr : '—';
        
        if (DOM.netLocTxt) DOM.netLocTxt.textContent = locStr !== '—' ? locStr : 'No location';
        const pi = $('popIp');     if (pi) pi.textContent = data.ip;
        const pisp = $('popIsp');  if (pisp) pisp.textContent = data.isp.length > CFG.ISP_MAX_LEN ? data.isp.slice(0, CFG.ISP_MAX_LEN) + '…' : data.isp;
        const pl = $('popLoc');    if (pl) pl.textContent = locText;
        const pc = $('popCoords'); if (pc) pc.textContent = data.lat !== '—' && data.lon !== '—' ? `${data.lat}°, ${data.lon}°` : '—';
        
        success = true;
        break;
      } catch (err) {
        console.warn(`GeoIP API ${api.url} failed:`, err);
      }
    }

    if (!success) {
      try {
        const r = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
        if (r.ok) {
          const d = await r.json();
          if (DOM.netLocTxt) DOM.netLocTxt.textContent = 'No location';
          const pi = $('popIp'); if (pi) pi.textContent = d.ip || 'Unavailable';
          const pl = $('popLoc'); if (pl) pl.textContent = '—';
          const pisp = $('popIsp'); if (pisp) pisp.textContent = '—';
          const pc = $('popCoords'); if (pc) pc.textContent = '—';
          return;
        }
      } catch (e) {
        // Ignored
      }
      if (DOM.netLocTxt) DOM.netLocTxt.textContent = 'No location';
      const pi = $('popIp'); if (pi) pi.textContent = 'Unavailable';
      const pl = $('popLoc'); if (pl) pl.textContent = '—';
    }
  }

  function updateNet(e) {
    const nb = $('netBadge'); if (!nb) return;
    const offSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM19 18H6c-2.21 0-4-1.79-4-4s1.79-4 4-4h.71A5.506 5.506 0 0 1 12 6c2.76 0 5.08 1.95 5.42 4.5l.29 2H19c1.65 0 3 1.35 3 3s-1.35 3-3 3z" fill="currentColor"/><line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
    const onSvg  = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z" fill="currentColor"/></svg>`;
    if (!navigator.onLine) { nb.className = 'net-badge show offline'; nb.innerHTML = offSvg + ' Offline'; }
    else if (e?.type === 'online') { nb.className = 'net-badge show online'; nb.innerHTML = onSvg + ' Back online'; setTimeout(() => nb.classList.remove('show'), 3000); }
    else nb.classList.remove('show');
    assessSignal();
  }

  window.addEventListener('online',  updateNet);
  window.addEventListener('offline', () => { setSignalLevel(0, 'Offline', 's0'); if (DOM.netLocTxt) DOM.netLocTxt.textContent = '—'; updateNet(); });
  if (navigator.connection) navigator.connection.addEventListener('change', assessSignal);
  scheduleIdle(() => {
    assessSignal();
    fetchIpInfo();
    setInterval(assessSignal, CFG.NET_REFRESH_MS);
  });

  /* ══════════════════════════════════════════════
     FONT LOAD GUARD
  ══════════════════════════════════════════════ */
  if (document.fonts?.ready) {
    document.fonts.ready.then(() => document.body.classList.add('fonts-loaded'));
  } else {
    setTimeout(() => document.body.classList.add('fonts-loaded'), CFG.FONT_FALLBACK_MS);
  }

  (function checkIconFont() {
    if (document.fonts?.check?.('16px "Material Symbols Rounded"')) {
      document.body.classList.add('fonts-loaded');
      return;
    }
    const probe = document.createElement('span');
    probe.className = 'material-symbols-rounded';
    probe.style.cssText = 'position:absolute;visibility:hidden;font-size:100px;top:-999px;left:-999px';
    probe.textContent = 'train';
    document.body.appendChild(probe);
    const checkWidth = probe.offsetWidth;
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      if (probe.offsetWidth !== checkWidth || attempts > CFG.FONT_PROBE_MAX) {
        document.body.classList.add('fonts-loaded');
        clearInterval(poll);
        document.body.removeChild(probe);
      }
    }, 50);
  })();

  /* ══════════════════════════════════════════════
     INIT
  ══════════════════════════════════════════════ */
  const initialTrainNo = getRouteTrainNo();
  const initialTrainName = getRouteTrainName();
  if (initialTrainNo) doLive(initialTrainNo, initialTrainName, 'replace');
  else showWelcome();

  scheduleIdle(() => {
    setTimeout(() => {
      const all  = [...getRecent(), ...getFavs()];
      const seen = new Set();
      all.forEach((t, i) => {
        if (!t?.num || seen.has(t.num)) return;
        seen.add(t.num);
        setTimeout(() => prefetchTrain(t.num, t.name), i * CFG.PREFETCH_STAGGER_MS);
      });
    }, CFG.PREFETCH_INIT_DELAY);
  });

})();
// Trigger build