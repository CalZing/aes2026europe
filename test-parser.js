// test-parser.js — quick integration check of the ICS parser with realistic input
'use strict';

// Stub out the express network listener so requiring server.js is safe.
process.env.PORT = '0';

// We need to access private functions. Easiest: re-exec the parser portion.
// Instead, monkey-load server.js but immediately close listener after.
const path = require('path');
const Module = require('module');
const origRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  if (id === 'express') {
    // Return a no-op express stub
    const stub = function() {
      const app = {};
      const noop = () => app;
      app.get = noop;
      app.use = noop;
      app.listen = (port, cb) => { cb && cb(); return { close: () => {} }; };
      return app;
    };
    stub.static = () => (req, res, next) => next && next();
    return stub;
  }
  return origRequire.apply(this, arguments);
};

// Now load and instrument. Inject test runner via globals.
const fs = require('fs');
const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
// Wrap the source to capture internal functions
const exposing = src + `
;module.exports = { parseIcs, buildEventsFromIcs, projectToConferenceTime, extractTopicsAndSpeakers, unfoldLines, decodeText };
`;
const tmpPath = path.join(__dirname, '__server_test.js');
fs.writeFileSync(tmpPath, exposing);
let mod;
try {
  mod = require(tmpPath);
} finally {
  fs.unlinkSync(tmpPath);
}

const { parseIcs, buildEventsFromIcs, projectToConferenceTime, extractTopicsAndSpeakers, unfoldLines, decodeText } = mod;

// ---------------------------------------------------------------------------
// Fixture: a small ICS that mimics what Sched typically emits.
// ---------------------------------------------------------------------------
const fixture = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Sched.com//Schedule//EN',
  'METHOD:PUBLISH',
  'CALSCALE:GREGORIAN',
  'BEGIN:VEVENT',
  'UID:1234567890@sched.com',
  'DTSTART;TZID=Europe/Copenhagen:20260527T090000',
  'DTEND;TZID=Europe/Copenhagen:20260527T103000',
  'SUMMARY:Keynote: The Future of Spatial Audio',
  'LOCATION:Auditorium 81',
  'DESCRIPTION:Speakers: Alice Andersson\\, Bob Bergstrom\\n\\nType: Keynote\\nTrack: Spatial Audio',
  'URL:https://aeseurope2026.sched.com/event/abc/keynote',
  'CATEGORIES:Spatial Audio,Plenary',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:abcdef@sched.com',
  'DTSTART:20260527T130000Z',
  'DTEND:20260527T140000Z',
  'SUMMARY:Tutorial on Loudspeaker Measurement (Loudspeakers)',
  'LOCATION:Building 303A, Room 42',
  'DESCRIPTION:Speakers: Steve Temme\\n',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:xyz@sched.com',
  'DTSTART;TZID=Europe/Copenhagen:20260528T140000',
  'DTEND;TZID=Europe/Copenhagen:20260528T153000',
  // A multi-line description folded with the leading space — must be unfolded.
  'DESCRIPTION:Speakers: Hyunkook Lee \\nThis session explores immersive\\, mu',
  ' ltichannel microphone array techniques developed for orchestral recordin',
  ' g. Type: Paper',
  'SUMMARY:ECHO Project — Immersive Microphone Arrays',
  'LOCATION:Aud 31',
  'END:VEVENT',
  'END:VCALENDAR',
  ''
].join('\r\n');

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL: ' + msg);
    process.exitCode = 1;
  } else {
    console.log('  ok:', msg);
  }
}

const events = buildEventsFromIcs(fixture);
console.log('\nParsed', events.length, 'events\n');

assert(events.length === 3, 'three events parsed');

const ev0 = events.find(e => e.uid === '1234567890@sched.com');
assert(ev0 != null, 'first event found by UID');
assert(ev0.title === 'Keynote: The Future of Spatial Audio', 'title decoded');
assert(ev0.start.dayKey === '2026-05-27', 'first event day = 2026-05-27');
assert(ev0.start.minutes === 9 * 60, 'first event starts at 09:00 (' + ev0.start.minutes + ')');
assert(ev0.start.label === '09:00', 'first event label = 09:00');
assert(ev0.end.minutes === 10 * 60 + 30, 'first event ends at 10:30');
assert(ev0.location === 'Auditorium 81', 'location decoded');
assert(ev0.topics.includes('Spatial Audio'), 'topic Spatial Audio from CATEGORIES');
assert(ev0.topics.includes('Plenary'), 'topic Plenary from CATEGORIES');
assert(ev0.topics.includes('Keynote'), 'topic Keynote from DESCRIPTION Type:');
assert(ev0.speakers.includes('Alice Andersson'), 'speakers parsed');
assert(ev0.speakers.includes('Bob Bergstrom'), 'speakers parsed');

const ev1 = events.find(e => e.uid === 'abcdef@sched.com');
assert(ev1 != null, 'second event found');
// 13:00 UTC -> 15:00 Copenhagen in summer (CEST, UTC+2)
assert(ev1.start.dayKey === '2026-05-27', 'second event day still 2026-05-27 in Copenhagen');
assert(ev1.start.minutes === 15 * 60, 'UTC 13:00 -> Copenhagen 15:00 (' + ev1.start.minutes + ')');
assert(ev1.start.label === '15:00', 'second event label');
// Topic extraction from trailing parens
assert(ev1.topics.includes('Loudspeakers'), 'topic Loudspeakers extracted from trailing parens (got: ' + JSON.stringify(ev1.topics) + ')');
assert(ev1.speakers.includes('Steve Temme'), 'second event speaker');

const ev2 = events.find(e => e.uid === 'xyz@sched.com');
assert(ev2 != null, 'third event found');
assert(ev2.title === 'ECHO Project — Immersive Microphone Arrays', 'third event title');
// The folded description should be unfolded
assert(/multichannel microphone array techniques/.test(ev2.description), 'description unfolded across lines (got: ' + JSON.stringify(ev2.description.slice(0, 200)) + ')');
assert(ev2.topics.includes('Paper'), 'topic Paper from inline Type:');
assert(ev2.start.dayKey === '2026-05-28', 'third event day');
assert(ev2.start.minutes === 14 * 60, 'third event 14:00');

// Sort check
assert(events[0].start.minutes <= events[1].start.minutes, 'events sorted by start time within day');

console.log('\nDone.');
