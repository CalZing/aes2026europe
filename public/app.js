// app.js
// AES Europe 2026 schedule viewer — client-side logic.
// State is held in memory, persisted to localStorage, and partially mirrored in
// the URL hash so views can be shared. No accounts, no remote storage.

(() => {
  'use strict';

  // ------------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------------
  const STORAGE_KEYS = {
    bookmarks: 'aes2026.bookmarks',
    prefs: 'aes2026.prefs'
  };

  const state = {
    events: [],
    meta: null,
    days: [],                 // ordered list of dayKey strings
    topics: [],               // [{ name, count, hue }]
    bookmarks: new Set(),
    selectedTopics: new Set(),
    currentDay: null,
    groupBy: 'topic',
    onlyBookmarked: false,
    searchQuery: '',
    pxPerMin: 3,
    panelOpen: false
  };

  const PX_PER_MIN_MIN = 1;
  const PX_PER_MIN_MAX = 8;

  // Topic chip hues — match the CSS palette indices
  const HUES = [28, 198, 158, 268, 8, 50, 220, 138];
  function hueFor(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return HUES[h % HUES.length];
  }

  // ------------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------------
  function loadBookmarks() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.bookmarks);
      if (raw) state.bookmarks = new Set(JSON.parse(raw));
    } catch (_) { /* ignore */ }
  }
  function saveBookmarks() {
    try {
      localStorage.setItem(STORAGE_KEYS.bookmarks, JSON.stringify(Array.from(state.bookmarks)));
    } catch (_) { /* ignore */ }
  }

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.prefs);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (typeof p.groupBy === 'string') state.groupBy = p.groupBy;
      if (typeof p.onlyBookmarked === 'boolean') state.onlyBookmarked = p.onlyBookmarked;
      if (typeof p.pxPerMin === 'number') state.pxPerMin = clampZoom(p.pxPerMin);
      if (typeof p.panelOpen === 'boolean') state.panelOpen = p.panelOpen;
    } catch (_) { /* ignore */ }
  }
  function savePrefs() {
    try {
      localStorage.setItem(STORAGE_KEYS.prefs, JSON.stringify({
        groupBy: state.groupBy,
        onlyBookmarked: state.onlyBookmarked,
        pxPerMin: state.pxPerMin,
        panelOpen: state.panelOpen
      }));
    } catch (_) { /* ignore */ }
  }

  // ------------------------------------------------------------------------
  // URL hash sync (shareable view: day + selected topics + search)
  // ------------------------------------------------------------------------
  function readHash() {
    const hash = location.hash.replace(/^#/, '');
    if (!hash) return {};
    const out = {};
    for (const part of hash.split('&')) {
      const [k, v] = part.split('=').map(decodeURIComponent);
      out[k] = v;
    }
    return out;
  }
  function writeHash() {
    const params = [];
    if (state.currentDay) params.push(`day=${encodeURIComponent(state.currentDay)}`);
    if (state.selectedTopics.size) {
      params.push('topics=' + encodeURIComponent(Array.from(state.selectedTopics).join('|')));
    }
    if (state.searchQuery.trim()) {
      params.push('q=' + encodeURIComponent(state.searchQuery.trim()));
    }
    const next = params.length ? '#' + params.join('&') : '#';
    if (next !== location.hash) history.replaceState(null, '', next);
  }
  function applyHashToState() {
    const h = readHash();
    if (h.day) state.currentDay = h.day;
    if (h.topics) {
      state.selectedTopics = new Set(h.topics.split('|').filter(Boolean));
    }
    if (h.q) state.searchQuery = h.q;
  }

  // ------------------------------------------------------------------------
  // Fetch & index
  // ------------------------------------------------------------------------
  async function fetchSchedule() {
    setStatus('loading…', '');
    try {
      const res = await fetch('/api/schedule');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.events = data.events || [];
      state.meta = data.meta || null;
      indexEvents();
      if (state.meta && state.meta.stale) setStatus('cached (upstream unavailable)', 'warn');
      else setStatus(`${state.events.length} sessions · live`, 'ok');
    } catch (err) {
      console.error(err);
      setStatus('failed to load', 'err');
      throw err;
    }
  }

  function indexEvents() {
    // Days
    const dayKeys = new Set();
    for (const ev of state.events) {
      if (ev.start && ev.start.dayKey) dayKeys.add(ev.start.dayKey);
    }
    state.days = Array.from(dayKeys).sort();
    if (!state.currentDay || !dayKeys.has(state.currentDay)) {
      state.currentDay = chooseDefaultDay(state.days);
    }

    // Topic counts
    const counts = new Map();
    for (const ev of state.events) {
      for (const t of ev.topics || []) counts.set(t, (counts.get(t) || 0) + 1);
    }
    state.topics = Array.from(counts.entries())
      .map(([name, count]) => ({ name, count, hue: hueFor(name) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    // Prune selectedTopics to known topics
    const known = new Set(state.topics.map(t => t.name));
    for (const t of Array.from(state.selectedTopics)) {
      if (!known.has(t)) state.selectedTopics.delete(t);
    }
  }

  function chooseDefaultDay(days) {
    if (!days.length) return null;
    // If today matches a day, pick it. Otherwise, pick the first upcoming day,
    // else fall back to the first day.
    const today = new Date();
    const todayKey = formatDayKey(today);
    if (days.includes(todayKey)) return todayKey;
    for (const d of days) if (d >= todayKey) return d;
    return days[0];
  }

  function formatDayKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // ------------------------------------------------------------------------
  // Filtering
  // ------------------------------------------------------------------------
  function eventsForCurrentDay() {
    return state.events.filter(e => e.start && e.start.dayKey === state.currentDay);
  }

  function matchesFilters(ev) {
    if (state.onlyBookmarked && !state.bookmarks.has(ev.uid)) return false;
    const q = state.searchQuery.trim().toLowerCase();
    if (q) {
      const hay = [
        ev.title || '',
        ev.description || '',
        ev.location || '',
        (ev.speakers || []).join(' '),
        (ev.topics || []).join(' ')
      ].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (state.selectedTopics.size > 0) {
      const hasAny = (ev.topics || []).some(t => state.selectedTopics.has(t));
      if (!hasAny) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------------
  // Rendering – top bar pieces
  // ------------------------------------------------------------------------
  function setStatus(text, state) {
    const el = document.getElementById('status');
    el.textContent = text;
    el.setAttribute('data-state', state || '');
  }

  function renderDayTabs() {
    const nav = document.getElementById('daytabs');
    nav.innerHTML = '';
    for (const day of state.days) {
      const btn = document.createElement('button');
      btn.className = 'daytab';
      btn.setAttribute('aria-selected', String(day === state.currentDay));
      btn.dataset.day = day;
      const d = new Date(day + 'T12:00:00');
      const wd = d.toLocaleDateString('en-US', { weekday: 'short' });
      const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      btn.innerHTML = `
        <span class="daytab__weekday">${wd}</span>
        <span class="daytab__date">${md}</span>
      `;
      btn.addEventListener('click', () => {
        if (state.currentDay === day) return;
        state.currentDay = day;
        writeHash();
        renderDayTabs();
        renderMain();
      });
      nav.appendChild(btn);
    }
  }

  function renderTopicFilter() {
    const list = document.getElementById('topic-list');
    list.innerHTML = '';
    for (const t of state.topics) {
      const btn = document.createElement('button');
      btn.className = 'topic-chip';
      btn.style.setProperty('--chip-hue', String(t.hue));
      btn.setAttribute('aria-pressed', String(state.selectedTopics.has(t.name)));
      btn.innerHTML = `
        <span class="topic-chip__swatch" aria-hidden="true"></span>
        <span>${escapeHtml(t.name)}</span>
        <span class="topic-chip__count mono">${t.count}</span>
      `;
      btn.addEventListener('click', () => {
        if (state.selectedTopics.has(t.name)) state.selectedTopics.delete(t.name);
        else state.selectedTopics.add(t.name);
        writeHash();
        renderTopicFilter();
        renderToolbarCounts();
        renderMain();
      });
      list.appendChild(btn);
    }
    if (!state.topics.length) {
      list.innerHTML = '<p style="color:var(--fg-dim);font-size:12px;margin:0">No topics were detected in the upstream feed. Try the "By room" grouping instead.</p>';
    }
  }

  function renderToolbarCounts() {
    const total = state.topics.length;
    const sel = state.selectedTopics.size;
    const pill = document.getElementById('filter-toggle-count');
    if (!sel) {
      pill.textContent = 'all';
      pill.className = 'pill pill--accent';
    } else {
      pill.textContent = `${sel}/${total}`;
      pill.className = 'pill pill--accent';
    }
    document.getElementById('bookmark-count').textContent = String(state.bookmarks.size);
  }

  // ------------------------------------------------------------------------
  // Rendering – main views
  // ------------------------------------------------------------------------
  function renderMain() {
    const host = document.getElementById('timeline-host');
    const empty = document.getElementById('empty');
    host.innerHTML = '';

    const dayEvents = eventsForCurrentDay().filter(matchesFilters);

    if (!dayEvents.length) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    if (state.groupBy === 'flat') {
      host.appendChild(renderFlatList(dayEvents));
    } else {
      host.appendChild(renderTimeline(dayEvents, state.groupBy));
    }
  }

  function renderFlatList(events) {
    const wrap = document.createElement('div');
    wrap.className = 'flat-list';
    const sorted = events.slice().sort((a, b) => a.start.minutes - b.start.minutes);
    for (const ev of sorted) {
      const item = document.createElement('div');
      item.className = 'flat-item' + (state.bookmarks.has(ev.uid) ? ' flat-item--bookmarked' : '');
      item.addEventListener('click', (e) => {
        // ignore clicks on the bookmark button itself
        if (e.target.closest('.flat-item__bookmark')) return;
        openModal(ev);
      });
      const timeStr = `${ev.start.label}${ev.end ? '–' + ev.end.label : ''}`;
      item.innerHTML = `
        <div class="flat-item__time mono">${escapeHtml(timeStr)}</div>
        <div class="flat-item__body">
          <div class="flat-item__title">${escapeHtml(ev.title)}</div>
          <div class="flat-item__meta">
            ${ev.location ? `<span class="mono">${escapeHtml(ev.location)}</span>` : ''}
            ${ev.speakers && ev.speakers.length ? `<span>${escapeHtml(ev.speakers.slice(0, 3).join(' · '))}${ev.speakers.length > 3 ? ' …' : ''}</span>` : ''}
          </div>
          ${ev.topics && ev.topics.length ? `<div class="flat-item__topics">${ev.topics.map(t => `<span class="flat-item__topic-chip">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
        </div>
        <button class="flat-item__bookmark" aria-pressed="${state.bookmarks.has(ev.uid)}" aria-label="Bookmark">${state.bookmarks.has(ev.uid) ? '★' : '☆'}</button>
      `;
      item.querySelector('.flat-item__bookmark').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleBookmark(ev.uid);
        renderMain();
        renderToolbarCounts();
      });
      wrap.appendChild(item);
    }
    return wrap;
  }

  function renderTimeline(events, groupBy) {
    // Compute day time range
    let minM = Infinity, maxM = -Infinity;
    for (const ev of events) {
      const s = ev.start.minutes;
      const e = ev.end ? ev.end.minutes : s + 30;
      if (s < minM) minM = s;
      if (e > maxM) maxM = e;
    }
    // Snap to whole hours, with at least 30 min padding either side
    const dayStart = Math.max(0, Math.floor((minM - 15) / 60) * 60);
    const dayEnd   = Math.min(24 * 60, Math.ceil((maxM + 15) / 60) * 60);
    const totalMin = Math.max(60, dayEnd - dayStart);
    const pxPerMin = state.pxPerMin;
    const bodyWidth = totalMin * pxPerMin;

    // Group events into rows
    const rowsMap = new Map(); // rowKey -> { key, label, events: [] }
    const addToRow = (key, label, ev) => {
      if (!rowsMap.has(key)) rowsMap.set(key, { key, label, events: [] });
      rowsMap.get(key).events.push(ev);
    };

    if (groupBy === 'topic') {
      for (const ev of events) {
        const ts = (ev.topics && ev.topics.length) ? ev.topics : ['Uncategorized'];
        for (const t of ts) {
          // If user has selected topics, only emit rows for those (so the
          // timeline focuses on what they're filtering for).
          if (state.selectedTopics.size > 0 && !state.selectedTopics.has(t)) continue;
          addToRow(t, t, ev);
        }
        // If the event ends up in zero rows (e.g. all its topics filtered out
        // but it matched search), don't add it. matchesFilters() already
        // guarantees at least one topic in the selected set.
      }
    } else if (groupBy === 'room') {
      for (const ev of events) {
        const r = ev.location || '(no room)';
        addToRow(r, r, ev);
      }
    }

    // Sort rows: by event count desc, then alpha
    const rows = Array.from(rowsMap.values()).sort((a, b) => {
      if (b.events.length !== a.events.length) return b.events.length - a.events.length;
      return a.label.localeCompare(b.label);
    });

    // Build DOM
    const tl = document.createElement('section');
    tl.className = 'timeline';
    tl.style.setProperty('--label-w', getCssVar('--label-w'));

    // corner
    const corner = document.createElement('div');
    corner.className = 'timeline__corner';
    corner.textContent = `${rows.length} row${rows.length === 1 ? '' : 's'} · ${events.length} sessions`;
    tl.appendChild(corner);

    // time header
    const times = document.createElement('div');
    times.className = 'timeline__times';
    times.style.width = bodyWidth + 'px';
    times.style.position = 'sticky';
    // grid forces width via the body row, but explicit width keeps things crisp.
    appendTimeTicks(times, dayStart, dayEnd, pxPerMin, true);
    tl.appendChild(times);

    // labels column
    const labels = document.createElement('div');
    labels.className = 'timeline__labels';

    // body
    const body = document.createElement('div');
    body.className = 'timeline__rows';
    body.style.width = bodyWidth + 'px';

    rows.forEach((row, idx) => {
      // assign lanes so overlapping events don't visually collide
      const { laneByUid, laneCount } = assignLanes(row.events);

      // label
      const label = document.createElement('div');
      label.className = 'row__label';
      label.style.setProperty('--row-hue', String(HUES[idx % HUES.length]));
      label.style.setProperty('--lanes', String(laneCount));
      label.innerHTML = `
        <div class="row__label-name" title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</div>
        <div class="row__label-count mono">${row.events.length} session${row.events.length === 1 ? '' : 's'}</div>
      `;
      labels.appendChild(label);

      // row body
      const r = document.createElement('div');
      r.className = 'row';
      r.style.setProperty('--row-hue', String(HUES[idx % HUES.length]));
      r.style.setProperty('--lanes', String(laneCount));
      r.style.width = bodyWidth + 'px';

      // tick lines repeated per row for visual continuity
      appendTimeTicks(r, dayStart, dayEnd, pxPerMin, false);

      // sessions
      for (const ev of row.events) {
        const s = ev.start.minutes;
        const e = ev.end ? ev.end.minutes : s + 30;
        const leftMin = Math.max(0, s - dayStart);
        const widthMin = Math.max(5, e - s);
        const left = leftMin * pxPerMin;
        const width = widthMin * pxPerMin;
        const block = document.createElement('button');
        block.className = 'session' + (state.bookmarks.has(ev.uid) ? ' session--bookmarked' : '') + (width < 36 ? ' session--narrow' : '');
        block.style.left = left + 'px';
        block.style.width = width + 'px';
        block.style.setProperty('--lane', String(laneByUid.get(ev.uid) || 0));
        const title = ev.title || '(untitled)';
        const timeLabel = `${ev.start.label}${ev.end ? '–' + ev.end.label : ''}`;
        block.title = `${title}\n${timeLabel}${ev.location ? '\n' + ev.location : ''}`;
        block.innerHTML = `
          ${state.bookmarks.has(ev.uid) ? '<span class="session__bookmark" aria-hidden="true">★</span>' : ''}
          <div class="session__title">${escapeHtml(title)}</div>
        `;
        block.addEventListener('click', () => openModal(ev));
        r.appendChild(block);
      }
      body.appendChild(r);
    });

    tl.appendChild(labels);
    tl.appendChild(body);

    // "Now" line if the current time falls within range and the day matches today
    const now = new Date();
    if (formatDayKey(now) === state.currentDay) {
      const nowMin = now.getHours() * 60 + now.getMinutes();
      if (nowMin >= dayStart && nowMin <= dayEnd) {
        const nowLine = document.createElement('div');
        nowLine.className = 'now-line';
        nowLine.style.left = ((nowMin - dayStart) * pxPerMin) + 'px';
        nowLine.innerHTML = `<div class="now-line__label">now</div>`;
        body.appendChild(nowLine);
      }
    }

    return tl;
  }

  function appendTimeTicks(parent, dayStart, dayEnd, pxPerMin, withLabels) {
    // every 30 min: faint tick; every hour: strong + label
    for (let m = dayStart; m <= dayEnd; m += 30) {
      const tick = document.createElement('div');
      const isHour = (m % 60) === 0;
      tick.className = 'time-tick' + (isHour ? ' time-tick--hour' : '');
      tick.style.left = ((m - dayStart) * pxPerMin) + 'px';
      parent.appendChild(tick);
      if (withLabels && isHour) {
        const label = document.createElement('div');
        label.className = 'time-tick--label';
        label.style.left = ((m - dayStart) * pxPerMin) + 'px';
        const hh = String(Math.floor(m / 60)).padStart(2, '0');
        const mm = String(m % 60).padStart(2, '0');
        label.textContent = `${hh}:${mm}`;
        parent.appendChild(label);
      }
    }
  }

  // Sweep-line lane assignment. Sorts events by start, then places each event
  // in the lowest-indexed lane whose previous occupant has already ended.
  // Returns { laneByUid: Map<uid, laneIndex>, laneCount: number of lanes used }.
  function assignLanes(events) {
    const laneByUid = new Map();
    if (!events.length) return { laneByUid, laneCount: 1 };
    const sorted = [...events].sort((a, b) => {
      const da = a.start.minutes - b.start.minutes;
      if (da !== 0) return da;
      const ea = a.end ? a.end.minutes : a.start.minutes + 30;
      const eb = b.end ? b.end.minutes : b.start.minutes + 30;
      return eb - ea; // longer event first on ties so it claims the top lane
    });
    const laneEnd = []; // laneEnd[i] = end minute of latest event in lane i
    for (const ev of sorted) {
      const s = ev.start.minutes;
      const e = ev.end ? ev.end.minutes : s + 30;
      let lane = -1;
      for (let i = 0; i < laneEnd.length; i++) {
        if (laneEnd[i] <= s) { lane = i; break; }
      }
      if (lane === -1) {
        lane = laneEnd.length;
        laneEnd.push(e);
      } else {
        laneEnd[lane] = e;
      }
      laneByUid.set(ev.uid, lane);
    }
    return { laneByUid, laneCount: Math.max(1, laneEnd.length) };
  }

  function getCssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || null;
  }

  // ------------------------------------------------------------------------
  // Modal
  // ------------------------------------------------------------------------
  function openModal(ev) {
    const modal = document.getElementById('session-modal');
    const body = document.getElementById('session-modal-body');
    const timeStr = `${ev.start.label}${ev.end ? '–' + ev.end.label : ''}`;
    const dayObj = new Date(ev.start.dayKey + 'T12:00:00');
    const dayLabel = dayObj.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const isBookmarked = state.bookmarks.has(ev.uid);

    body.innerHTML = `
      <h2>${escapeHtml(ev.title)}</h2>
      <div class="modal__meta">
        <span>${escapeHtml(dayLabel)}</span>
        <span>${escapeHtml(timeStr)}</span>
        ${ev.location ? `<span>${escapeHtml(ev.location)}</span>` : ''}
      </div>
      ${ev.speakers && ev.speakers.length ? `<div style="margin-bottom:12px"><strong style="font-size:12px;color:var(--fg-muted);font-family:'Geist Mono',monospace;text-transform:uppercase;letter-spacing:0.06em">Speakers</strong><br>${escapeHtml(ev.speakers.join(' · '))}</div>` : ''}
      ${ev.topics && ev.topics.length ? `<div class="modal__topics">${ev.topics.map(t => `<span class="flat-item__topic-chip" style="font-size:11px">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      <div class="modal__desc">${escapeHtml(ev.description || '(no description)')}</div>
      <div class="modal__actions">
        <button class="toolbar__btn" id="modal-bookmark" aria-pressed="${isBookmarked}">
          ${isBookmarked ? '★ Bookmarked' : '☆ Bookmark'}
        </button>
        ${ev.url ? `<a class="toolbar__btn" href="${escapeAttr(ev.url)}" target="_blank" rel="noopener">Open on sched.com ↗</a>` : ''}
      </div>
    `;
    body.querySelector('#modal-bookmark').addEventListener('click', () => {
      toggleBookmark(ev.uid);
      openModal(ev); // re-render modal contents
      renderMain();
      renderToolbarCounts();
    });
    if (typeof modal.showModal === 'function') modal.showModal();
    else modal.setAttribute('open', '');
  }

  // ------------------------------------------------------------------------
  // Bookmarks
  // ------------------------------------------------------------------------
  function toggleBookmark(uid) {
    if (state.bookmarks.has(uid)) state.bookmarks.delete(uid);
    else state.bookmarks.add(uid);
    saveBookmarks();
  }

  // ------------------------------------------------------------------------
  // .ics export of bookmarked sessions
  // ------------------------------------------------------------------------
  function exportBookmarksIcs() {
    const selected = state.events.filter(e => state.bookmarks.has(e.uid));
    if (!selected.length) {
      alert('You have no bookmarked sessions yet. Star sessions first, then export.');
      return;
    }
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//AES Europe 2026 viewer//bookmarks//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:AES Europe 2026 — my bookmarks'
    ];
    for (const ev of selected) {
      const start = icsTime(ev.start);
      const end   = icsTime(ev.end || ev.start);
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${escapeIcs(ev.uid)}`);
      lines.push(`DTSTAMP:${icsNow()}`);
      lines.push(`DTSTART:${start}`);
      lines.push(`DTEND:${end}`);
      lines.push(`SUMMARY:${escapeIcs(ev.title)}`);
      if (ev.location) lines.push(`LOCATION:${escapeIcs(ev.location)}`);
      if (ev.description) lines.push(`DESCRIPTION:${escapeIcs(ev.description)}`);
      if (ev.url) lines.push(`URL:${escapeIcs(ev.url)}`);
      if (ev.topics && ev.topics.length) {
        lines.push('CATEGORIES:' + ev.topics.map(escapeIcs).join(','));
      }
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/calendar' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'aes-europe-2026-bookmarks.ics';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  }
  function icsTime(t) {
    if (t.utc) {
      return t.utc.replace(/[-:]/g, '').replace(/\.\d+/, '');
    }
    // local-time, conference TZ — emit as floating local time (RFC 5545 form)
    const d = t.dayKey.replace(/-/g, '');
    const h = String(Math.floor(t.minutes / 60)).padStart(2, '0');
    const m = String(t.minutes % 60).padStart(2, '0');
    return `${d}T${h}${m}00`;
  }
  function icsNow() {
    return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  }
  function escapeIcs(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  }

  // ------------------------------------------------------------------------
  // Misc helpers
  // ------------------------------------------------------------------------
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function escapeAttr(s) { return escapeHtml(s); }

  function clampZoom(v) {
    return Math.max(PX_PER_MIN_MIN, Math.min(PX_PER_MIN_MAX, v));
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // ------------------------------------------------------------------------
  // Wire up controls
  // ------------------------------------------------------------------------
  function wireControls() {
    const $ = (id) => document.getElementById(id);

    $('search').value = state.searchQuery;
    $('search').addEventListener('input', debounce((e) => {
      state.searchQuery = e.target.value;
      writeHash();
      renderMain();
    }, 150));

    $('group-by').value = state.groupBy;
    $('group-by').addEventListener('change', (e) => {
      state.groupBy = e.target.value;
      savePrefs();
      renderMain();
    });

    $('only-bookmarked').checked = state.onlyBookmarked;
    $('only-bookmarked').addEventListener('change', (e) => {
      state.onlyBookmarked = e.target.checked;
      savePrefs();
      renderMain();
    });

    $('filter-toggle').addEventListener('click', () => {
      state.panelOpen = !state.panelOpen;
      const panel = $('filter-panel');
      panel.hidden = !state.panelOpen;
      $('filter-toggle').setAttribute('aria-expanded', String(state.panelOpen));
      savePrefs();
    });

    if (state.panelOpen) {
      $('filter-panel').hidden = false;
      $('filter-toggle').setAttribute('aria-expanded', 'true');
    }

    $('topics-all').addEventListener('click', () => {
      state.selectedTopics = new Set();
      writeHash();
      renderTopicFilter();
      renderToolbarCounts();
      renderMain();
    });
    $('topics-invert').addEventListener('click', () => {
      const next = new Set();
      for (const t of state.topics) {
        if (!state.selectedTopics.has(t.name)) next.add(t.name);
      }
      state.selectedTopics = next;
      writeHash();
      renderTopicFilter();
      renderToolbarCounts();
      renderMain();
    });

    $('export-ics').addEventListener('click', exportBookmarksIcs);

    $('reset-filters').addEventListener('click', () => {
      state.selectedTopics = new Set();
      state.searchQuery = '';
      state.onlyBookmarked = false;
      $('search').value = '';
      $('only-bookmarked').checked = false;
      writeHash();
      savePrefs();
      renderTopicFilter();
      renderToolbarCounts();
      renderMain();
    });

    $('zoom-in').addEventListener('click', () => {
      state.pxPerMin = clampZoom(state.pxPerMin + 1);
      $('zoom-label').textContent = `${state.pxPerMin} px/min`;
      savePrefs();
      renderMain();
    });
    $('zoom-out').addEventListener('click', () => {
      state.pxPerMin = clampZoom(state.pxPerMin - 1);
      $('zoom-label').textContent = `${state.pxPerMin} px/min`;
      savePrefs();
      renderMain();
    });
    $('zoom-label').textContent = `${state.pxPerMin} px/min`;
  }

  // ------------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------------
  async function boot() {
    loadBookmarks();
    loadPrefs();
    applyHashToState();
    wireControls();
    try {
      await fetchSchedule();
    } catch (_) {
      return;
    }
    renderDayTabs();
    renderTopicFilter();
    renderToolbarCounts();
    renderMain();
    writeHash();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
