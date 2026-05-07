// Test buildRecentHistory + stringifySegments.
// Run: node server/tools/test-history.mjs
//
// Writes synthetic beat-log entries into a temp gameId then reads them
// back through buildRecentHistory. Verifies opening-always-included,
// dedup, chronological order, and segment stitching.

import fs from 'node:fs';
import path from 'node:path';
import { LOGS_DIR } from '../lib/config.mjs';
import {
  appendTurnEntry,
  appendAppliedMarker,
  deleteLog
} from '../lib/beat-log.mjs';
import { buildRecentHistory, stringifySegments } from '../lib/history.mjs';

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else      { console.log(`FAIL  ${label}${detail ? '\n  ' + detail : ''}`); fail++; }
}

function makeGameId() {
  return 'test-history-' + Math.random().toString(36).slice(2, 8);
}

// helpers to author log entries
function logOpening(gameId) {
  appendTurnEntry(gameId, {
    beatNumber: 1,
    playerChoice: null,
    modelOutput: {
      presentedBeat: {
        beatNumber: 1, isOpening: true,
        prose: { segments: [
          { type: 'text', content: 'You wake to the sound of your own name. ' },
          { type: 'link', id: 'pin', content: 'silver pin shaped like a flame', linkType: 'clue' },
          { type: 'text', content: '. Three riders.' }
        ]}
      },
      resolution: null
    }
  });
  appendAppliedMarker(gameId, 1);
}
function logBeat(gameId, n, { resolution, intro, title } = {}) {
  appendTurnEntry(gameId, {
    beatNumber: n,
    playerChoice: 'A',
    modelOutput: {
      presentedBeat: {
        title:  title || `Beat ${n}`,
        intro:  intro  ? { segments: [{ type: 'text', content: intro }] } : null
      },
      resolution: resolution ? { segments: [{ type: 'text', content: resolution }] } : null
    }
  });
  appendAppliedMarker(gameId, n);
}

// ---------- stringifySegments ----------

console.log('--- stringifySegments ---');
{
  ok('empty / null -> empty string',
     stringifySegments(null) === '' && stringifySegments(undefined) === '' && stringifySegments([]) === '');

  const segs = [
    { type: 'text', content: 'Outside, ' },
    { type: 'link', id: 'l1', content: 'the comet', linkType: 'lore' },
    { type: 'text', content: ' hangs low.' }
  ];
  ok('text+link concat',
     stringifySegments(segs) === 'Outside, the comet hangs low.');

  ok('unknown segment type contributes empty',
     stringifySegments([{ type: 'unknown', content: 'x' }]) === '');
}

// ---------- buildRecentHistory: empty ----------

console.log('\n--- buildRecentHistory: empty game ---');
{
  const gameId = makeGameId();
  ok('no log -> empty array', buildRecentHistory(gameId).length === 0);
  deleteLog(gameId);
}

// ---------- buildRecentHistory: opening only ----------

console.log('\n--- buildRecentHistory: opening only (turn 1) ---');
{
  const gameId = makeGameId();
  logOpening(gameId);
  const h = buildRecentHistory(gameId);
  ok('one entry returned',                 h.length === 1);
  ok('opening title default applied',      h[0].title.startsWith('I.') || h[0].title === 'Beat 1' || /Open/i.test(h[0].title));
  ok('opening prose stitched correctly',
     h[0].prose.includes('You wake to the sound') && h[0].prose.includes('silver pin'));
  deleteLog(gameId);
}

// ---------- buildRecentHistory: opening + 2 beats (all included) ----------

console.log('\n--- buildRecentHistory: opening + 2 (all fit) ---');
{
  const gameId = makeGameId();
  logOpening(gameId);
  logBeat(gameId, 2, { resolution: 'You ride east.', intro: 'The road thins.' });
  logBeat(gameId, 3, { resolution: 'Sera reins beside you.', intro: 'The pines lean over.' });
  const h = buildRecentHistory(gameId);
  ok('three entries returned',                  h.length === 3);
  ok('chronological order (1, 2, 3)',
     h[0].title.toLowerCase().includes('open') || h[0].title === 'Beat 1' || /^I\./.test(h[0].title));
  ok('beat 2 prose includes resolution + intro',
     h[1].prose.includes('You ride east.') && h[1].prose.includes('The road thins.'));
  ok('beat 3 prose includes resolution + intro',
     h[2].prose.includes('Sera reins') && h[2].prose.includes('The pines lean'));
  deleteLog(gameId);
}

// ---------- buildRecentHistory: opening preserved at turn 6 ----------

console.log('\n--- buildRecentHistory: opening always included (later turns) ---');
{
  const gameId = makeGameId();
  logOpening(gameId);
  for (let n = 2; n <= 6; n++) logBeat(gameId, n, { intro: `Intro ${n}.` });
  const h = buildRecentHistory(gameId);
  ok('exactly 4 entries (opening + last 3)',
     h.length === 4,
     `got ${h.length}: ${h.map(e=>e.title).join(', ')}`);
  ok('opening (beat 1) is the first entry',
     h[0].prose.includes('You wake to the sound'));
  ok('beats 4, 5, 6 are the rest in order',
     h[1].prose.includes('Intro 4') &&
     h[2].prose.includes('Intro 5') &&
     h[3].prose.includes('Intro 6'));
  ok('beats 2 and 3 are NOT included',
     !h.some(e => e.prose.includes('Intro 2')) &&
     !h.some(e => e.prose.includes('Intro 3')));
  deleteLog(gameId);
}

// ---------- buildRecentHistory: dedup when opening overlaps ----------

console.log('\n--- buildRecentHistory: dedup at turn 3 (opening within last 3) ---');
{
  const gameId = makeGameId();
  logOpening(gameId);
  logBeat(gameId, 2, { intro: 'Intro 2.' });
  logBeat(gameId, 3, { intro: 'Intro 3.' });
  const h = buildRecentHistory(gameId);
  ok('three entries, no duplicate of opening',
     h.length === 3,
     `got ${h.length}: ${h.map(e=>e.title).join(', ')}`);
  ok('opening present once',
     h.filter(e => e.prose.includes('You wake to the sound')).length === 1);
  deleteLog(gameId);
}

// ---------- summary ----------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
