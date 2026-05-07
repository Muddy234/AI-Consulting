// Objective-engine validator (Phase B). See OBJECTIVE_REFACTOR_PLAN.md §1.4.
//
// Two stages per call:
//   1. Structural validation against the JSON Schemas in server/schemas/.
//      (compiled with ajv; failures return immediately.)
//   2. Semantic checks that need state and/or world-bundle context:
//      link-id <-> linkContents correspondence, lethality gate against
//      lastChoiceRisk, fireAtHour > elapsed hours, macro-threat id
//      collision and per-game cap, per-world enum enforcement, npc
//      reference resolution, unlocksThreats reference resolution.
//
// Server-owned fields are silently stripped from worldStateDeltas (mutates
// output in place; returns the list of strips for logging).
//
// All validators return { ok, errors, output, stripped }. Errors carry
// dot-notation paths so re-prompts can be precise.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import Ajv from 'ajv';

// ----- per-world enums (TODO: Phase C moves these to the world bundle) -----

const WORLD_STATE_ENUMS = {
  timeOfDay:       ['dawn', 'midday', 'dusk', 'night'],
  cometStage:      ['approaching', 'near-zenith', 'zenith', 'passing', 'passed'],
  kingStatus:      ['declining', 'dying', 'near-death', 'dead'],
  crownStatus:     ['dormant', 'held', 'activated', 'destroyed'],
  antagonistPower: ['advisor', 'regent', 'crowned', 'king', 'dead']
};

// Server-owned fields the model must not set inside a worldStateDeltas block.
// (Top-level runtime-state fields — model could try to sneak them into the open
// worldStateDeltas object. Silent strip rather than reject.)
const SERVER_OWNED_IN_WORLDSTATE = new Set([
  'clockHours',
  'distanceToKing',
  'turnNumber',
  'cumulativeHoursElapsed'
]);

// Per-game cap on model-authored macro-threats. Bundle-authored are unlimited.
export const MODEL_AUTHORED_THREAT_CAP = 2;

// Terminal kinds that require an opted-in `desperate` choice on the prior turn.
const TERMINAL_REQUIRES_DESPERATE = new Set(['killed', 'trapped', 'jailed']);

// ----- ajv compilation -----

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.resolve(__dirname, '../schemas');

function loadSchema(filename) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, filename), 'utf8'));
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validateModelOutputShape  = ajv.compile(loadSchema('objective.model-output.json'));
const validateRuntimeStateShape = ajv.compile(loadSchema('objective.runtime-state.json'));

// ----- re-prompt template (single source of truth) -----

export const RE_PROMPT_TEMPLATE = (errPath, message) =>
  `Your previous response failed validation at \`${errPath}\`: ${message}. ` +
  `Return a corrected response that conforms to the schema exactly. ` +
  `Do not include any text outside the JSON object.`;

// ----- helpers -----

function ajvPathToDot(p) {
  if (!p || p === '') return '<root>';
  // ajv instancePath looks like '/foo/bar/0' -> 'foo.bar[0]'
  return p
    .slice(1)
    .split('/')
    .map(s => /^\d+$/.test(s) ? `[${s}]` : s)
    .join('.')
    .replace(/\.\[/g, '[');
}

function ajvErrorMessage(e) {
  if (e.keyword === 'enum') {
    return `${e.message} (allowed: ${e.params.allowedValues.join(', ')})`;
  }
  if (e.keyword === 'required') {
    return `missing required field '${e.params.missingProperty}'`;
  }
  if (e.keyword === 'additionalProperties') {
    return `unexpected field '${e.params.additionalProperty}'`;
  }
  return e.message;
}

function ajvErrorsToDotted(errors) {
  return (errors || []).map(e => ({
    path: ajvPathToDot(e.instancePath || ''),
    message: ajvErrorMessage(e)
  }));
}

// ----- semantic checks -----

function stripServerOwnedFromWorldStateDeltas(output) {
  const stripped = [];
  const wsd = output?.worldImpacts?.stateChanges?.worldStateDeltas;
  if (!wsd) return stripped;
  for (const key of Object.keys(wsd)) {
    if (SERVER_OWNED_IN_WORLDSTATE.has(key)) {
      delete wsd[key];
      stripped.push(`worldImpacts.stateChanges.worldStateDeltas.${key} (server-owned)`);
    }
  }
  return stripped;
}

function checkLinkCorrespondence(prose, contents, prosePath, contentsPath, errors) {
  if (!prose || !contents) return;
  const linkSegments = (prose.segments || [])
    .map((s, i) => s?.type === 'link' ? { id: s.id, idx: i } : null)
    .filter(Boolean);
  const proseIds = linkSegments.map(x => x.id);
  const contentKeys = Object.keys(contents);

  for (const { id, idx } of linkSegments) {
    if (!Object.prototype.hasOwnProperty.call(contents, id)) {
      errors.push({
        path: `${contentsPath}.${id}`,
        message: `missing linkContents entry for id '${id}' (referenced by ${prosePath}.segments[${idx}])`
      });
    }
  }
  for (const key of contentKeys) {
    if (!proseIds.includes(key)) {
      errors.push({
        path: `${contentsPath}.${key}`,
        message: `linkContents has entry for '${key}' but no link segment in ${prosePath}.segments references it`
      });
    }
  }
  const seen = new Set();
  for (const { id, idx } of linkSegments) {
    if (seen.has(id)) {
      errors.push({
        path: `${prosePath}.segments[${idx}].id`,
        message: `duplicate link id '${id}' within prose segments (must be unique within a beat)`
      });
    }
    seen.add(id);
  }
}

function checkLethalityGate(output, state, errors) {
  const ts = output?.narrativeResponse?.terminalState;
  if (!ts || !TERMINAL_REQUIRES_DESPERATE.has(ts.kind)) return;
  if (state?.lastChoiceRisk !== 'desperate') {
    errors.push({
      path: 'narrativeResponse.terminalState.kind',
      message: `terminal kind '${ts.kind}' requires lastChoiceRisk='desperate' but state has '${state?.lastChoiceRisk ?? 'null'}'`
    });
  }
}

function checkTerminalConsistency(output, state, errors) {
  const ts = output?.narrativeResponse?.terminalState;
  if (!ts) return;
  const sc = output?.worldImpacts?.stateChanges || {};

  if (ts.kind === 'reached-king') {
    const distAfter = (state?.distanceToKing ?? 100) + (sc.distanceDelta ?? 0);
    if (distAfter > 5) {
      errors.push({
        path: 'narrativeResponse.terminalState.kind',
        message: `terminal kind 'reached-king' requires distanceToKing <= 5 after deltas; would be ${distAfter} (was ${state?.distanceToKing ?? 100}, delta ${sc.distanceDelta ?? 0})`
      });
    }
  }
  if (ts.kind === 'time-up') {
    const hoursAfter = (state?.clockHours ?? 96) - (sc.clockHoursDelta ?? 0);
    if (hoursAfter > 0) {
      errors.push({
        path: 'narrativeResponse.terminalState.kind',
        message: `terminal kind 'time-up' requires clockHours <= 0 after deltas; would be ${hoursAfter} (was ${state?.clockHours ?? 96}, delta -${sc.clockHoursDelta ?? 0})`
      });
    }
  }
}

function checkScheduledEventTimes(output, state, bundle, errors) {
  const adds = output?.worldImpacts?.scheduledEventsToAdd || [];
  if (adds.length === 0) return;
  const initial = bundle?.startingClocks?.clockHours ?? 96;
  const elapsed = initial - (state?.clockHours ?? initial);
  for (let i = 0; i < adds.length; i++) {
    const ev = adds[i];
    if (typeof ev.fireAtHour === 'number' && ev.fireAtHour <= elapsed) {
      errors.push({
        path: `worldImpacts.scheduledEventsToAdd[${i}].fireAtHour`,
        message: `fireAtHour=${ev.fireAtHour} must be greater than elapsed hours (${elapsed}); cannot schedule in the past`
      });
    }
  }
}

function checkMacroThreatRules(output, state, errors) {
  const adds = output?.worldImpacts?.macroThreatsToAdd || [];
  if (adds.length === 0) return;

  const existing = state?.threats || {};
  const existingModelAuthored = Object.values(existing)
    .filter(t => t?.authorSource === 'model').length;

  if (existingModelAuthored + adds.length > MODEL_AUTHORED_THREAT_CAP) {
    errors.push({
      path: 'worldImpacts.macroThreatsToAdd',
      message: `would exceed per-game cap of ${MODEL_AUTHORED_THREAT_CAP} model-authored macro-threats (already have ${existingModelAuthored}, attempted to add ${adds.length})`
    });
  }

  const existingIds = new Set(Object.keys(existing));
  const seenInBatch = new Set();
  for (let i = 0; i < adds.length; i++) {
    const id = adds[i].id;
    if (existingIds.has(id)) {
      errors.push({
        path: `worldImpacts.macroThreatsToAdd[${i}].id`,
        message: `threat id '${id}' already exists in state.threats`
      });
    }
    if (seenInBatch.has(id)) {
      errors.push({
        path: `worldImpacts.macroThreatsToAdd[${i}].id`,
        message: `duplicate threat id '${id}' within macroThreatsToAdd batch`
      });
    }
    seenInBatch.add(id);
  }
}

function checkWorldStateEnums(output, errors) {
  const wsd = output?.worldImpacts?.stateChanges?.worldStateDeltas;
  if (!wsd) return;
  for (const [key, allowed] of Object.entries(WORLD_STATE_ENUMS)) {
    if (key in wsd && !allowed.includes(wsd[key])) {
      errors.push({
        path: `worldImpacts.stateChanges.worldStateDeltas.${key}`,
        message: `value '${wsd[key]}' not in allowed enum (${allowed.join(', ')})`
      });
    }
  }
}

function checkNpcReferences(output, bundle, errors) {
  const characters = bundle?.characters || [];
  const validIds = new Set(characters.map(c => c.id));
  const impacts = output?.npcImpacts || [];
  for (let i = 0; i < impacts.length; i++) {
    if (!validIds.has(impacts[i].npcId)) {
      errors.push({
        path: `npcImpacts[${i}].npcId`,
        message: `npcId '${impacts[i].npcId}' not found in bundle.characters; persistent NPCs must reference an authored character (background NPCs go in prose only)`
      });
    }
  }
}

function checkUnlockThreatRefs(output, state, bundle, errors) {
  const bundleThreatIds = new Set((bundle?.threats || []).map(t => t.id));
  const stateThreatIds  = new Set(Object.keys(state?.threats || {}));
  const macroAddsIds    = new Set(
    (output?.worldImpacts?.macroThreatsToAdd || []).map(t => t.id)
  );
  const allThreatIds = new Set([...bundleThreatIds, ...stateThreatIds, ...macroAddsIds]);

  function checkMap(map, basePath) {
    if (!map) return;
    for (const [linkId, content] of Object.entries(map)) {
      const refs = content?.unlocksThreats || [];
      for (let i = 0; i < refs.length; i++) {
        if (!allThreatIds.has(refs[i])) {
          errors.push({
            path: `${basePath}.${linkId}.unlocksThreats[${i}]`,
            message: `threat id '${refs[i]}' not found in bundle, runtime state, or this turn's macroThreatsToAdd`
          });
        }
      }
    }
  }
  checkMap(
    output?.narrativeResponse?.resolutionLinkContents,
    'narrativeResponse.resolutionLinkContents'
  );
  checkMap(
    output?.narrativeResponse?.nextBeat?.introLinkContents,
    'narrativeResponse.nextBeat.introLinkContents'
  );
}

// ----- public API -----

export function validateRuntimeState(state) {
  const ok = validateRuntimeStateShape(state);
  if (ok) return { ok: true, errors: [] };
  return { ok: false, errors: ajvErrorsToDotted(validateRuntimeStateShape.errors) };
}

export function validateModelOutput(output, { state, bundle }) {
  // Stage 1: structural shape
  const shapeOk = validateModelOutputShape(output);
  if (!shapeOk) {
    return {
      ok: false,
      errors: ajvErrorsToDotted(validateModelOutputShape.errors),
      output,
      stripped: []
    };
  }

  // Stage 2: silently strip server-owned fields (mutates output)
  const stripped = stripServerOwnedFromWorldStateDeltas(output);

  // Stage 3: semantic rules
  const errors = [];
  checkLinkCorrespondence(
    output?.narrativeResponse?.resolutionProse,
    output?.narrativeResponse?.resolutionLinkContents,
    'narrativeResponse.resolutionProse',
    'narrativeResponse.resolutionLinkContents',
    errors
  );
  if (output?.narrativeResponse?.nextBeat) {
    checkLinkCorrespondence(
      output.narrativeResponse.nextBeat.intro,
      output.narrativeResponse.nextBeat.introLinkContents,
      'narrativeResponse.nextBeat.intro',
      'narrativeResponse.nextBeat.introLinkContents',
      errors
    );
  }
  checkLethalityGate(output, state, errors);
  checkTerminalConsistency(output, state, errors);
  checkScheduledEventTimes(output, state, bundle, errors);
  checkMacroThreatRules(output, state, errors);
  checkWorldStateEnums(output, errors);
  checkNpcReferences(output, bundle, errors);
  checkUnlockThreatRefs(output, state, bundle, errors);

  return {
    ok: errors.length === 0,
    errors,
    output,
    stripped
  };
}

// ----- formatting helpers -----

export function formatErrors(errors) {
  if (!errors || errors.length === 0) return '(no errors)';
  return errors.map(e => `  - [${e.path}] ${e.message}`).join('\n');
}

export function firstError(errors) {
  if (!errors || errors.length === 0) return null;
  const e = errors[0];
  return { path: e.path, message: e.message };
}
