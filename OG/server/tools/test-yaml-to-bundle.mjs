// Phase C test: YAML -> JSON conversion + world bundle revalidates.
// Run: node server/tools/test-yaml-to-bundle.mjs
//
// Tests:
//   1. Default ember-crown bundle: yaml parses, json regenerates, bundle revalidates.
//   2. yaml-to-bundle is mtime-aware (skip when json is newer).
//   3. --force regenerates even when json is newer.
//   4. Missing yaml throws.
//   5. Bundle has the expected rev-2 shape (threats, scheduledEvents, opening hyperlinks).

import fs from 'node:fs';
import path from 'node:path';
import { convertYamlToBundle, jsonPath } from '../lib/yaml-to-bundle.mjs';
import { loadWorldBundle } from '../lib/world-bundle.mjs';
import {
  validateWorldBundle,
  formatErrors
} from '../lib/objective-validator.mjs';
import { DEFAULT_WORLD } from '../lib/config.mjs';

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else      { console.log(`FAIL  ${label}${detail ? '\n  ' + detail : ''}`); fail++; }
}

// ---------- 1. ember-crown round-trip ----------

console.log('--- ember-crown round-trip ---');

// Force regen so we have a known fresh state for the rest of the suite.
const r1 = convertYamlToBundle({ worldName: DEFAULT_WORLD, force: true, silent: true });
ok('forced conversion did not skip', r1.skipped === false);
ok('json file exists at expected path', fs.existsSync(r1.jsonPath));

const bundle = loadWorldBundle(DEFAULT_WORLD);
const v = validateWorldBundle(bundle);
ok('loaded bundle revalidates',
   v.ok === true,
   v.ok ? '' : formatErrors(v.errors));

// ---------- 2. mtime-aware skip ----------

console.log('\n--- mtime-aware skip ---');

const r2 = convertYamlToBundle({ worldName: DEFAULT_WORLD, silent: true });
ok('second invocation skipped (json newer than yaml)',
   r2.skipped === true);

// ---------- 3. --force regenerates ----------

console.log('\n--- --force regenerates ---');

const r3 = convertYamlToBundle({ worldName: DEFAULT_WORLD, force: true, silent: true });
ok('--force did not skip', r3.skipped === false);

// ---------- 4. missing yaml throws ----------

console.log('\n--- missing yaml ---');

let threw = false;
try {
  convertYamlToBundle({ worldName: 'no-such-world', silent: true });
} catch (err) {
  threw = err.message.includes('not found');
}
ok('missing world.yaml throws "not found"', threw);

// ---------- 5. bundle structure (rev-2 shape) ----------

console.log('\n--- bundle structure ---');

ok('bundle.worldName === ember-crown',
   bundle.worldName === 'ember-crown');
ok('bundle.objective.primary present',
   typeof bundle.objective?.primary === 'string' && bundle.objective.primary.length > 0);
ok('bundle.startingClocks.clockHours === 96',
   bundle.startingClocks.clockHours === 96);
ok('bundle.threats has 1 macro-threat (halric-coronation)',
   bundle.threats.length === 1 && bundle.threats[0].id === 'halric-coronation');
ok('bundle.threats[0].duration === 96',
   bundle.threats[0].duration === 96);
ok('bundle.threats[0].phases has 3 entries',
   bundle.threats[0].phases.length === 3);
ok('bundle.authoredScheduledEvents has 6 tentpoles',
   bundle.authoredScheduledEvents.length === 6);
ok('bundle.characters has sera, king-aldric, high-advisor-halric',
   bundle.characters.map(c => c.id).sort().join(',') ===
     ['high-advisor-halric','king-aldric','sera'].join(','));
ok('bundle.worldStateEnums has all 5 keys',
   ['timeOfDay','cometStage','kingStatus','crownStatus','antagonistPower']
     .every(k => Array.isArray(bundle.worldStateEnums[k])));

ok('openingScene has structured prose with hyperlinks',
   bundle.openingScene.prose.segments.some(s => s.type === 'link'));

const linkSegs = bundle.openingScene.prose.segments.filter(s => s.type === 'link');
const linkContentKeys = Object.keys(bundle.openingScene.linkContents);
ok('every opening link segment has a matching linkContents entry',
   linkSegs.every(s => linkContentKeys.includes(s.id)),
   `segments: ${linkSegs.map(s=>s.id).join(',')}; contents: ${linkContentKeys.join(',')}`);
ok('opening choices have risk tags',
   bundle.openingScene.choices.every(c => ['controlled','risky','desperate'].includes(c.risk)));

// All 6 tentpoles fire at distinct hours, in chronological order
const fireHours = bundle.authoredScheduledEvents.map(e => e.fireAtHour);
const sorted = [...fireHours].sort((a, b) => a - b);
ok('tentpoles span the 96h budget',
   Math.min(...fireHours) >= 0 && Math.max(...fireHours) <= 96,
   `hours: ${fireHours.join(',')}`);
ok('tentpoles are in chronological order in YAML',
   JSON.stringify(fireHours) === JSON.stringify(sorted));

// halric-coronation onComplete carries the irony-ending payload
const halric = bundle.threats[0];
ok('halric-coronation.onComplete sets antagonistPower=king',
   halric.onComplete?.worldStateDelta?.antagonistPower === 'king');
ok('halric-coronation.onComplete logs a majorEvent',
   typeof halric.onComplete?.majorEvent === 'string' && halric.onComplete.majorEvent.length > 0);

// ---------- 6. validateWorldBundle catches missing fields ----------

console.log('\n--- validateWorldBundle negative cases ---');

{
  const b = JSON.parse(JSON.stringify(bundle));
  delete b.threats;
  const r = validateWorldBundle(b);
  ok('missing threats rejected',
     !r.ok && r.errors.some(e => e.path === 'threats'));
}
{
  const b = JSON.parse(JSON.stringify(bundle));
  b.threats.push({ id: 'halric-coronation', displayName: 'dup', duration: 24, phases: [{ atProgress: 0, label: 'p' }], onComplete: { majorEvent: 'x' } });
  const r = validateWorldBundle(b);
  ok('duplicate threat id rejected',
     !r.ok && r.errors.some(e => /duplicate threat id/.test(e.message)));
}
{
  const b = JSON.parse(JSON.stringify(bundle));
  b.openingScene.choices = [{ label: 'A', text: 'only one', risk: 'controlled' }];
  const r = validateWorldBundle(b);
  ok('opening with 1 choice rejected',
     !r.ok && r.errors.some(e => e.path === 'openingScene.choices'));
}
{
  const b = JSON.parse(JSON.stringify(bundle));
  // remove the linkContents for the first link in segments
  const firstLinkId = b.openingScene.prose.segments.find(s => s.type === 'link').id;
  delete b.openingScene.linkContents[firstLinkId];
  const r = validateWorldBundle(b);
  ok('opening link without linkContents rejected',
     !r.ok && r.errors.some(e => e.path.startsWith('openingScene.linkContents.')));
}

// ---------- summary ----------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
