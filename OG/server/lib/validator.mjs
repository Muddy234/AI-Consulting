// Validators for world bundle, runtime state, and model output.
// All validators return { ok: true, value } or { ok: false, errors: [{ path, message }] }.
// Validators never throw on bad data — they accumulate errors with paths so re-prompts can be precise.

import {
  WORLD_BUNDLE_REQUIRED,
  RUNTIME_STATE_REQUIRED,
  MODEL_OUTPUT_REQUIRED,
  WORLD_STATE_ENUMS,
  SERVER_OWNED_WORLD_FIELDS,
  CHOICE_LABELS,
  CHOICE_COUNT,
  CHOICE_COORD_MIN,
  CHOICE_COORD_MAX,
  CHOICE_COORD_STEP,
  CHOICE_COORD_EPSILON,
  CONFIDENCE_ENUM,
  FORWARD_CONFIDENCE_ENUM
} from './schema.mjs';

// Re-prompt template for one-shot retry when the model returns a malformed payload.
// Single source of truth — if you change wording, change it here only.
export const RE_PROMPT_TEMPLATE = (path, message) =>
  `Your previous response failed schema validation at \`${path}\`: ${message}. ` +
  `Return a corrected response that conforms to the schema exactly. ` +
  `Do not include any text outside the JSON object.`;

// ----- helpers -----

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function pushErr(errors, path, message) {
  errors.push({ path, message });
}

function requireFields(obj, required, basePath, errors) {
  for (const f of required) {
    if (obj[f] === undefined || obj[f] === null) {
      pushErr(errors, basePath ? `${basePath}.${f}` : f, 'missing required field');
    }
  }
}

function requireString(obj, key, basePath, errors, allowEmpty = false) {
  const v = obj[key];
  const path = basePath ? `${basePath}.${key}` : key;
  if (typeof v !== 'string') {
    pushErr(errors, path, `expected string, got ${v === null ? 'null' : typeof v}`);
    return false;
  }
  if (!allowEmpty && v.trim() === '') {
    pushErr(errors, path, 'empty string not allowed');
    return false;
  }
  return true;
}

function requireBool(obj, key, basePath, errors) {
  const path = basePath ? `${basePath}.${key}` : key;
  if (typeof obj[key] !== 'boolean') {
    pushErr(errors, path, `expected boolean, got ${typeof obj[key]}`);
    return false;
  }
  return true;
}

function requireArray(obj, key, basePath, errors) {
  const path = basePath ? `${basePath}.${key}` : key;
  if (!Array.isArray(obj[key])) {
    pushErr(errors, path, `expected array, got ${typeof obj[key]}`);
    return false;
  }
  return true;
}

// ----- world bundle -----

export function validateWorldBundle(bundle) {
  const errors = [];
  if (!isObject(bundle)) {
    return { ok: false, errors: [{ path: '$', message: 'world bundle must be an object' }] };
  }

  requireFields(bundle, WORLD_BUNDLE_REQUIRED, '', errors);

  if (typeof bundle.worldName === 'string' && !/^[a-z0-9-]+$/.test(bundle.worldName)) {
    pushErr(errors, 'worldName', 'must be lowercase alphanumeric with hyphens');
  }

  if (isObject(bundle.structuralObjective)) {
    requireString(bundle.structuralObjective, 'thematic', 'structuralObjective', errors);
    requireString(bundle.structuralObjective, 'climaxType', 'structuralObjective', errors);
  }

  if (isObject(bundle.worldBible)) {
    for (const k of ['geography', 'magicTechRules', 'factions', 'recentHistory', 'currentCrisis']) {
      requireString(bundle.worldBible, k, 'worldBible', errors);
    }
  }

  if (isObject(bundle.pacingBudget)) {
    const pb = bundle.pacingBudget;
    if (typeof pb.targetBeatCount !== 'number' || pb.targetBeatCount < 1) {
      pushErr(errors, 'pacingBudget.targetBeatCount', 'must be a positive number');
    }
    if (typeof pb.climaxByBeat !== 'number' || pb.climaxByBeat < 1) {
      pushErr(errors, 'pacingBudget.climaxByBeat', 'must be a positive number');
    }
    if (typeof pb.tokensPerBeat !== 'number' || pb.tokensPerBeat < 1) {
      pushErr(errors, 'pacingBudget.tokensPerBeat', 'must be a positive number');
    }
  }

  if (Array.isArray(bundle.characters)) {
    if (bundle.characters.length === 0) {
      pushErr(errors, 'characters', 'must contain at least one character');
    }
    const seen = new Set();
    bundle.characters.forEach((c, i) => {
      const path = `characters[${i}]`;
      if (!isObject(c)) {
        pushErr(errors, path, 'must be an object');
        return;
      }
      requireString(c, 'id', path, errors);
      requireString(c, 'name', path, errors);
      requireString(c, 'role', path, errors);
      if (c.id && seen.has(c.id)) pushErr(errors, `${path}.id`, `duplicate id "${c.id}"`);
      if (c.id) seen.add(c.id);
    });
  }

  if (isObject(bundle.openingBeat)) {
    const ob = bundle.openingBeat;
    requireString(ob, 'title', 'openingBeat', errors);
    requireString(ob, 'setting', 'openingBeat', errors);
    requireString(ob, 'prose', 'openingBeat', errors);
    if (Array.isArray(ob.choices)) {
      validateChoices(ob.choices, 'openingBeat.choices', errors);
    } else {
      pushErr(errors, 'openingBeat.choices', 'must be an array');
    }
  }

  if (isObject(bundle.playerStartingState)) {
    requireString(bundle.playerStartingState, 'location', 'playerStartingState', errors);
  }

  return errors.length === 0
    ? { ok: true, value: bundle }
    : { ok: false, errors };
}

// ----- runtime state -----

export function validateRuntimeState(state) {
  const errors = [];
  if (!isObject(state)) {
    return { ok: false, errors: [{ path: '$', message: 'runtime state must be an object' }] };
  }

  requireFields(state, RUNTIME_STATE_REQUIRED, '', errors);

  if (typeof state.beatNumber !== 'number' || state.beatNumber < 1) {
    pushErr(errors, 'beatNumber', 'must be a positive number');
  }
  if (typeof state.lastAppliedLogBeat !== 'number' || state.lastAppliedLogBeat < 0) {
    pushErr(errors, 'lastAppliedLogBeat', 'must be a non-negative number');
  }

  if (isObject(state.worldState)) {
    const ws = state.worldState;
    if (typeof ws.cumulativeHoursElapsed !== 'number' || ws.cumulativeHoursElapsed < 0) {
      pushErr(errors, 'worldState.cumulativeHoursElapsed', 'must be a non-negative number');
    }
    if (typeof ws.worldDay !== 'number' || ws.worldDay < 1) {
      pushErr(errors, 'worldState.worldDay', 'must be a positive number');
    }
    for (const [field, allowed] of Object.entries(WORLD_STATE_ENUMS)) {
      if (ws[field] !== undefined && !allowed.includes(ws[field])) {
        pushErr(errors, `worldState.${field}`, `value "${ws[field]}" not in ${JSON.stringify(allowed)}`);
      }
    }
  }

  if (isObject(state.playerState)) {
    requireString(state.playerState, 'location', 'playerState', errors);
  }

  if (state.npcStates !== undefined && !isObject(state.npcStates)) {
    pushErr(errors, 'npcStates', 'must be an object keyed by npc id');
  }

  return errors.length === 0
    ? { ok: true, value: state }
    : { ok: false, errors };
}

// ----- model output -----

/**
 * Validates the model's per-turn JSON output.
 * @param {object} output - parsed JSON from the model
 * @param {object} ctx - { knownNpcIds: Set<string> } from the world bundle
 * @returns { ok, value, errors }
 */
export function validateModelOutput(output, ctx = {}) {
  const errors = [];
  const knownNpcIds = ctx.knownNpcIds || new Set();

  if (!isObject(output)) {
    return { ok: false, errors: [{ path: '$', message: 'model output must be a JSON object' }] };
  }

  requireFields(output, MODEL_OUTPUT_REQUIRED, '', errors);

  // worldImpacts
  if (isObject(output.worldImpacts)) {
    const wi = output.worldImpacts;
    if (!isObject(wi.stateChanges)) {
      pushErr(errors, 'worldImpacts.stateChanges', 'expected object');
    } else {
      const sc = wi.stateChanges;
      if (sc.timeElapsed !== null && typeof sc.timeElapsed !== 'string') {
        pushErr(errors, 'worldImpacts.stateChanges.timeElapsed', 'expected string or null');
      }
      if (sc.worldStateDeltas !== undefined && !isObject(sc.worldStateDeltas)) {
        pushErr(errors, 'worldImpacts.stateChanges.worldStateDeltas', 'expected object');
      } else if (isObject(sc.worldStateDeltas)) {
        // Strip server-owned fields and validate enums
        for (const k of Object.keys(sc.worldStateDeltas)) {
          if (SERVER_OWNED_WORLD_FIELDS.has(k)) {
            // server-owned: silently delete (delta-applier also enforces)
            delete sc.worldStateDeltas[k];
            continue;
          }
          if (WORLD_STATE_ENUMS[k] && !WORLD_STATE_ENUMS[k].includes(sc.worldStateDeltas[k])) {
            pushErr(errors, `worldImpacts.stateChanges.worldStateDeltas.${k}`,
              `value "${sc.worldStateDeltas[k]}" not in ${JSON.stringify(WORLD_STATE_ENUMS[k])}`);
          }
        }
      }
    }
    if (wi.majorEventLogged !== null && wi.majorEventLogged !== undefined &&
        typeof wi.majorEventLogged !== 'string') {
      pushErr(errors, 'worldImpacts.majorEventLogged', 'expected string or null');
    }
  } else if (output.worldImpacts !== undefined) {
    pushErr(errors, 'worldImpacts', 'expected object');
  }

  // npcImpacts
  if (Array.isArray(output.npcImpacts)) {
    output.npcImpacts.forEach((imp, i) => {
      const path = `npcImpacts[${i}]`;
      if (!isObject(imp)) {
        pushErr(errors, path, 'must be an object');
        return;
      }
      if (!isNonEmptyString(imp.npcId)) {
        pushErr(errors, `${path}.npcId`, 'must be a non-empty string');
      } else if (!knownNpcIds.has(imp.npcId)) {
        pushErr(errors, `${path}.npcId`,
          `"${imp.npcId}" is not a persistent NPC. Use only ids from the character bibles. ` +
          `Background NPCs belong in narrative prose, not in npcImpacts[].`);
      }
      if (imp.knowledgeGained !== undefined && imp.knowledgeGained !== null) {
        if (!Array.isArray(imp.knowledgeGained)) {
          pushErr(errors, `${path}.knowledgeGained`, 'expected array or null');
        } else {
          imp.knowledgeGained.forEach((k, j) => {
            const kpath = `${path}.knowledgeGained[${j}]`;
            if (!isObject(k) || !isNonEmptyString(k.fact)) {
              pushErr(errors, kpath, 'expected { fact, confidence }');
            } else if (k.confidence && !CONFIDENCE_ENUM.includes(k.confidence)) {
              pushErr(errors, `${kpath}.confidence`,
                `value "${k.confidence}" not in ${JSON.stringify(CONFIDENCE_ENUM)}`);
            }
          });
        }
      }
    });
  } else if (output.npcImpacts !== undefined) {
    pushErr(errors, 'npcImpacts', 'expected array');
  }

  // narrativeResponse
  if (isObject(output.narrativeResponse)) {
    const nr = output.narrativeResponse;
    requireString(nr, 'resolutionProse', 'narrativeResponse', errors);
    requireBool(nr, 'isEnding', 'narrativeResponse', errors);
    if (isObject(nr.nextBeat)) {
      requireString(nr.nextBeat, 'title', 'narrativeResponse.nextBeat', errors);
      requireString(nr.nextBeat, 'intro', 'narrativeResponse.nextBeat', errors);
      if (Array.isArray(nr.nextBeat.choices)) {
        validateChoices(nr.nextBeat.choices, 'narrativeResponse.nextBeat.choices', errors);
      } else if (!nr.isEnding) {
        // Endings may omit choices; mid-game beats must include them.
        pushErr(errors, 'narrativeResponse.nextBeat.choices', 'expected array of 3 choices');
      }
    } else if (!nr.isEnding) {
      pushErr(errors, 'narrativeResponse.nextBeat', 'expected object');
    }
  } else if (output.narrativeResponse !== undefined) {
    pushErr(errors, 'narrativeResponse', 'expected object');
  }

  // forwardProjection
  if (isObject(output.forwardProjection)) {
    const fp = output.forwardProjection;
    requireString(fp, 'next2BeatsTarget', 'forwardProjection', errors);
    requireString(fp, 'tonalAim', 'forwardProjection', errors);
    if (fp.currentConfidence !== undefined &&
        !FORWARD_CONFIDENCE_ENUM.includes(fp.currentConfidence)) {
      pushErr(errors, 'forwardProjection.currentConfidence',
        `value "${fp.currentConfidence}" not in ${JSON.stringify(FORWARD_CONFIDENCE_ENUM)}`);
    }
  } else if (output.forwardProjection !== undefined) {
    pushErr(errors, 'forwardProjection', 'expected object');
  }

  // directorReasoning
  if (output.directorReasoning !== undefined) {
    if (typeof output.directorReasoning !== 'string') {
      pushErr(errors, 'directorReasoning', 'expected string');
    }
  }

  return errors.length === 0
    ? { ok: true, value: output }
    : { ok: false, errors };
}

// Quadrant id from a (selfOther, assertYield) pair. Axis-zero values are treated
// as belonging to the negative side for quadrant counting; (0, 0) is rejected
// upstream and never reaches this helper.
function quadrantId(selfOther, assertYield) {
  const so = selfOther > 0 ? '+' : '-';
  const ay = assertYield > 0 ? '+' : '-';
  return `${so}${ay}`;
}

function validateCoordValue(v, path, errors) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    pushErr(errors, path, `expected finite number, got ${v === null ? 'null' : typeof v}`);
    return false;
  }
  if (v < CHOICE_COORD_MIN || v > CHOICE_COORD_MAX) {
    pushErr(errors, path, `must be in [${CHOICE_COORD_MIN}, ${CHOICE_COORD_MAX}], got ${v}`);
    return false;
  }
  // Tolerant 0.10-step check (IEEE 754 makes exact divisibility unreliable).
  const steps = v / CHOICE_COORD_STEP;
  if (Math.abs(steps - Math.round(steps)) > CHOICE_COORD_EPSILON * 1000) {
    pushErr(errors, path, `must be a multiple of ${CHOICE_COORD_STEP}, got ${v}`);
    return false;
  }
  return true;
}

function validateChoices(choices, basePath, errors) {
  if (choices.length !== CHOICE_COUNT) {
    pushErr(errors, basePath, `expected exactly ${CHOICE_COUNT} choices, got ${choices.length}`);
    return;
  }
  const seenLabels = new Set();
  const quadrantsSeen = new Set();
  choices.forEach((c, i) => {
    const path = `${basePath}[${i}]`;
    if (!isObject(c)) {
      pushErr(errors, path, 'must be an object');
      return;
    }
    if (!CHOICE_LABELS.includes(c.label)) {
      pushErr(errors, `${path}.label`, `must be one of ${JSON.stringify(CHOICE_LABELS)}`);
    } else if (seenLabels.has(c.label)) {
      pushErr(errors, `${path}.label`, `duplicate label "${c.label}"`);
    } else {
      seenLabels.add(c.label);
    }
    if (!isNonEmptyString(c.text)) {
      pushErr(errors, `${path}.text`, 'must be a non-empty string');
    }
    const soOk = validateCoordValue(c.selfOther, `${path}.selfOther`, errors);
    const ayOk = validateCoordValue(c.assertYield, `${path}.assertYield`, errors);
    if (soOk && ayOk) {
      // (0, 0) is not a valid choice position.
      if (Math.abs(c.selfOther) < CHOICE_COORD_EPSILON &&
          Math.abs(c.assertYield) < CHOICE_COORD_EPSILON) {
        pushErr(errors, path, '(selfOther, assertYield) must not be (0, 0)');
      } else {
        quadrantsSeen.add(quadrantId(c.selfOther, c.assertYield));
      }
    }
  });
  if (quadrantsSeen.size < 2) {
    pushErr(errors, basePath, `choices must span at least 2 distinct quadrants, got ${quadrantsSeen.size}`);
  }
}

// ----- error formatting -----

/** Formats validator errors into a single human-readable line for logs. */
export function formatErrors(errors) {
  return errors.map(e => `  ${e.path}: ${e.message}`).join('\n');
}

/** Picks the first error to drive a re-prompt. */
export function firstError(errors) {
  return errors[0] || { path: '$', message: 'unknown validation failure' };
}
