// server.js
// Fetches the public ICS feed from aeseurope2026.sched.com, parses it into JSON,
// caches the result in memory, and serves it to the frontend along with static assets.
//
// No information is stored or duplicated. The upstream feed is the single source of truth.

'use strict';

const express = require('express');
const https = require('https');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const ICS_URL = process.env.ICS_URL || 'https://aeseurope2026.sched.com/all.ics';
const CONFERENCE_TZ = process.env.CONFERENCE_TZ || 'Europe/Copenhagen';
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || `${10 * 60 * 1000}`, 10);

let cache = { data: null, expires: 0, fetchedAt: null };

// ---------------------------------------------------------------------------
// HTTP fetch helper (follows redirects, sets a UA, has a timeout)
// ---------------------------------------------------------------------------
function fetchUrl(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AESScheduleViewer/1.0; +https://github.com/)',
        'Accept': 'text/calendar, text/plain, */*'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        res.resume();
        return resolve(fetchUrl(res.headers.location, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Upstream HTTP ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Upstream timeout')));
  });
}

// ---------------------------------------------------------------------------
// ICS parser
// ---------------------------------------------------------------------------

// RFC 5545 line unfolding: a CRLF followed by SP or HTAB is a continuation.
function unfoldLines(text) {
  return text.replace(/\r?\n[ \t]/g, '');
}

// Decode the standard ICS TEXT escapes.
function decodeText(s) {
  return s
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// Parse a DATE-TIME value like "20260507T090000" or "20260507T090000Z" or DATE "20260507".
function parseIcsDate(value, params) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) {
    return { iso: `${y}-${mo}-${d}`, dateOnly: true, tzid: null };
  }
  const isoLocal = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  if (z) return { iso: isoLocal + 'Z', tzid: 'UTC', dateOnly: false };
  if (params && params.TZID) return { iso: isoLocal, tzid: params.TZID, dateOnly: false };
  return { iso: isoLocal, tzid: null, dateOnly: false };
}

// Parse the unfolded ICS text into a list of VEVENT objects.
function parseIcs(text) {
  const lines = unfoldLines(text).split(/\r?\n/);
  const events = [];
  let cur = null;
  let inEvent = false;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = {};
      inEvent = true;
      continue;
    }
    if (line === 'END:VEVENT') {
      if (cur) events.push(cur);
      cur = null;
      inEvent = false;
      continue;
    }
    if (!inEvent || !cur) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const left = line.substring(0, colonIdx);
    const value = line.substring(colonIdx + 1);
    const parts = left.split(';');
    const name = parts[0].toUpperCase();
    const params = {};
    for (let i = 1; i < parts.length; i++) {
      const eq = parts[i].indexOf('=');
      if (eq > 0) params[parts[i].substring(0, eq).toUpperCase()] = parts[i].substring(eq + 1);
    }

    switch (name) {
      case 'DTSTART': cur.start = parseIcsDate(value, params); break;
      case 'DTEND':   cur.end   = parseIcsDate(value, params); break;
      case 'SUMMARY':     cur.title = decodeText(value); break;
      case 'DESCRIPTION': cur.description = decodeText(value); break;
      case 'LOCATION':    cur.location = decodeText(value); break;
      case 'UID':         cur.uid = value; break;
      case 'URL':         cur.url = value; break;
      case 'CATEGORIES':
        cur.categories = decodeText(value)
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
        break;
      default: break;
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Timezone normalization
// ---------------------------------------------------------------------------
// Sched typically emits DTSTART/DTEND either in UTC (Z suffix) or in the
// conference local zone via TZID. We want a single canonical representation:
//   { dayKey: 'YYYY-MM-DD', minutes: <minutes since 00:00 in CONFERENCE_TZ> }
// Plus the original ISO string for tooltips / .ics export.

function projectToConferenceTime(parsed) {
  if (!parsed) return null;
  if (parsed.dateOnly) {
    return { dayKey: parsed.iso, minutes: 0, label: '00:00', utc: null, dateOnly: true };
  }

  // If already a local-time string in (assumed) conference TZ, take it verbatim.
  // Sched's TZID is consistently the conference TZ, so we don't need a tz database.
  if (parsed.tzid && parsed.tzid !== 'UTC') {
    const m = parsed.iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
    if (m) {
      return {
        dayKey: `${m[1]}-${m[2]}-${m[3]}`,
        minutes: (+m[4]) * 60 + (+m[5]),
        label: `${m[4]}:${m[5]}`,
        utc: null,
        dateOnly: false
      };
    }
  }

  // UTC or tz-naive: convert to CONFERENCE_TZ via Intl.
  const d = new Date(parsed.iso);
  if (isNaN(d.getTime())) return null;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: CONFERENCE_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
  // "en-CA" uses 00..23 for hour but emits "24" at midnight – normalize.
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return {
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: (+hour) * 60 + (+parts.minute),
    label: `${hour}:${parts.minute}`,
    utc: d.toISOString(),
    dateOnly: false
  };
}

// ---------------------------------------------------------------------------
// Topic / speaker extraction
// ---------------------------------------------------------------------------
// Sched stores Type/Track in different places depending on the event. We try:
//  1) CATEGORIES (rare but explicit)
//  2) "Track:" / "Type:" / "Topic:" / "Session Type:" lines in the description
//  3) Tags in parentheses at the end of the title, e.g. "... (Spatial Audio)"

function stripHtml(s) {
  if (!s) return '';
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTopicsAndSpeakers(ev) {
  const topics = new Set();
  const speakers = [];
  const plain = stripHtml(ev.description || '');

  if (Array.isArray(ev.categories)) {
    for (const c of ev.categories) topics.add(c);
  }

  // Description: extract Type/Track/Topic labels (line-start or mid-paragraph)
  // and Speakers: lines.
  const lines = plain.split('\n').map(l => l.trim()).filter(Boolean);
  const labelRegex = /\b(Type|Track|Topic|Category|Session Type|Theme)\s*:\s*([^\n.;|]+)/gi;
  let lm;
  while ((lm = labelRegex.exec(plain)) !== null) {
    for (const t of lm[2].split(/[,;]/)) {
      const v = t.trim().replace(/\.$/, '');
      if (v && v.length <= 60) topics.add(v);
    }
  }
  for (const line of lines) {
    const sp = line.match(/^Speakers?\s*:\s*(.+)$/i);
    if (sp) {
      for (const s of sp[1].split(/[,;•]/)) {
        const v = s.trim();
        if (v) speakers.push(v);
      }
    }
  }

  // Tag in trailing parens, e.g. "Some title (Spatial Audio)"
  if (ev.title) {
    const trailing = ev.title.match(/\(([^()]{2,40})\)\s*$/);
    if (trailing) {
      const candidate = trailing[1].trim();
      // Avoid obvious non-topics like a year or a single number
      if (!/^\d+$/.test(candidate) && candidate.split(' ').length <= 5) {
        topics.add(candidate);
      }
    }
  }

  return {
    topics: Array.from(topics),
    speakers
  };
}

// ---------------------------------------------------------------------------
// Build the normalized event list
// ---------------------------------------------------------------------------
function buildEventsFromIcs(icsText) {
  const raw = parseIcs(icsText);
  const events = [];
  for (const e of raw) {
    if (!e.start || !e.title) continue;
    const start = projectToConferenceTime(e.start);
    const end   = projectToConferenceTime(e.end || e.start);
    if (!start) continue;
    const { topics, speakers } = extractTopicsAndSpeakers(e);
    events.push({
      uid: e.uid || `${e.title}-${start.utc || start.label}`,
      title: e.title,
      description: stripHtml(e.description || ''),
      location: e.location || '',
      url: e.url || '',
      start, end,
      topics,
      speakers
    });
  }
  events.sort((a, b) => {
    if (a.start.dayKey !== b.start.dayKey) return a.start.dayKey < b.start.dayKey ? -1 : 1;
    return a.start.minutes - b.start.minutes;
  });
  return events;
}

async function getSchedule({ force = false } = {}) {
  if (!force && cache.data && cache.expires > Date.now()) {
    return { events: cache.data, fetchedAt: cache.fetchedAt, fromCache: true };
  }
  const icsText = await fetchUrl(ICS_URL);
  const events = buildEventsFromIcs(icsText);
  cache = {
    data: events,
    expires: Date.now() + CACHE_TTL_MS,
    fetchedAt: new Date().toISOString()
  };
  return { events, fetchedAt: cache.fetchedAt, fromCache: false };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/api/schedule', async (req, res) => {
  try {
    const { events, fetchedAt, fromCache } = await getSchedule({ force: req.query.refresh === '1' });
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      events,
      meta: {
        source: ICS_URL,
        timezone: CONFERENCE_TZ,
        fetchedAt,
        fromCache,
        count: events.length
      }
    });
  } catch (err) {
    console.error('getSchedule failed:', err.message);
    // If we have stale data, still serve it rather than fail outright
    if (cache.data) {
      return res.status(200).json({
        events: cache.data,
        meta: {
          source: ICS_URL,
          timezone: CONFERENCE_TZ,
          fetchedAt: cache.fetchedAt,
          fromCache: true,
          stale: true,
          warning: 'Upstream fetch failed; serving cached copy.',
          count: cache.data.length
        }
      });
    }
    res.status(502).json({ error: 'Failed to fetch upstream schedule', detail: err.message });
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.listen(PORT, () => {
  console.log(`AES Europe 2026 schedule viewer listening on :${PORT}`);
  console.log(`Source: ${ICS_URL}`);
});
