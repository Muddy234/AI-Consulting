// Scheduled-events engine (Phase E). See OBJECTIVE_REFACTOR_PLAN.md §1.2, §3.2 step 2.
//
// Per-turn lifecycle for a scheduled event:
//   1. status starts at 'pending' (seeded from bundle, or appended at runtime
//      by the model)
//   2. Once cumulative game-hours reach the event's fireAtHour, the engine
//      evaluates preconditions:
//        - If ANY precondition evaluates true, status -> 'cancelled' and
//          outcomeOnCancel applies (typically just a revelation, often quiet
//          or silent)
//        - Otherwise status -> 'fired' and outcomeOnFire applies
//          (worldStateDelta, npcImpacts, revelation)
//   3. The revelation (if non-silent) is enqueued into state.pendingRevelations
//      with surfaceAtHour = fireAtHour + delayHours
//   4. When cumulative hours reach surfaceAtHour, the queue entry moves to
//      playerKnowledge.witnessedEvents and is removed from the queue
//
// Preconditions (negative-contract: if true, event cancels):
//   { check: 'npcDead',          npcId: <id> }
//   { check: 'npcAlive',         npcId: <id> }
//   { check: 'playerHasAsset',   asset: <name> }
//   { check: 'playerLacksAsset', asset: <name> }
//   { check: 'playerKnowsFact',  fact: <id> }
//   { check: 'threatCompleted',  threatId: <id> }
//   { check: 'worldStateEquals', key: <field>, value: <value> }
//   { check: 'always' }   (pure cancel)
//   { check: 'never'  }   (pure no-op; useful in tests)

// ----- precondition evaluators -----

const PRECONDITION_EVALUATORS = {
  npcDead:         (state, p) => state?.npcStates?.[p.npcId]?.status === 'dead',
  npcAlive:        (state, p) => Boolean(state?.npcStates?.[p.npcId]) && state.npcStates[p.npcId].status !== 'dead',
  playerHasAsset:  (state, p) => Array.isArray(state?.assets) && state.assets.includes(p.asset),
  playerLacksAsset:(state, p) => Array.isArray(state?.assets) && !state.assets.includes(p.asset),
  playerKnowsFact: (state, p) => {
    const k = state?.playerKnowledge;
    return Array.isArray(k?.investigatedFacts) && k.investigatedFacts.includes(p.fact);
  },
  threatCompleted: (state, p) => state?.threats?.[p.threatId]?.completed === true,
  worldStateEquals:(state, p) => state?.worldState?.[p.key] === p.value,
  always:          () => true,
  never:           () => false
};

export function evaluatePrecondition(precondition, state) {
  if (!precondition || !precondition.check) {
    throw new Error(`Precondition missing 'check' field: ${JSON.stringify(precondition)}`);
  }
  const fn = PRECONDITION_EVALUATORS[precondition.check];
  if (!fn) {
    throw new Error(`Unknown precondition check: '${precondition.check}'`);
  }
  return fn(state, precondition);
}

/** True if ANY precondition evaluates true (= event cancels). */
export function shouldCancel(preconditions, state) {
  if (!Array.isArray(preconditions) || preconditions.length === 0) return false;
  for (const p of preconditions) {
    if (evaluatePrecondition(p, state)) return true;
  }
  return false;
}

// ----- seeding + add -----

/**
 * Seed state.scheduledEvents from bundle.authoredScheduledEvents (idempotent).
 * Skips events whose ids are already present.
 */
export function seedScheduledEventsFromBundle(state, bundle) {
  if (!Array.isArray(state.scheduledEvents)) state.scheduledEvents = [];
  const existingIds = new Set(state.scheduledEvents.map(e => e.id));
  for (const e of bundle?.authoredScheduledEvents || []) {
    if (existingIds.has(e.id)) continue;
    state.scheduledEvents.push({
      id: e.id,
      fireAtHour: e.fireAtHour,
      preconditions: e.preconditions || [],
      outcomeOnFire: e.outcomeOnFire || null,
      outcomeOnCancel: e.outcomeOnCancel || null,
      status: 'pending',
      authorSource: 'authored'
    });
  }
}

/**
 * Append a model-authored scheduled event at runtime (called after the
 * validator has approved it). Throws on id collision.
 */
export function addModelScheduledEvent(state, eventToAdd) {
  if (!Array.isArray(state.scheduledEvents)) state.scheduledEvents = [];
  if (state.scheduledEvents.some(e => e.id === eventToAdd.id)) {
    throw new Error(`Scheduled event id collision: '${eventToAdd.id}'`);
  }
  state.scheduledEvents.push({
    id: eventToAdd.id,
    fireAtHour: eventToAdd.fireAtHour,
    preconditions: eventToAdd.preconditions || [],
    outcomeOnFire: eventToAdd.outcomeOnFire || null,
    outcomeOnCancel: eventToAdd.outcomeOnCancel || null,
    status: 'pending',
    authorSource: 'model'
  });
}

// ----- fire / cancel -----

/**
 * Walk pending events and fire/cancel any whose fireAtHour <= currentHour.
 * Mutates: event.status. Returns:
 *   {
 *     fired:     [{ eventId, outcome }],
 *     cancelled: [{ eventId, outcome }]   // outcome may be null if outcomeOnCancel was null
 *   }
 *
 * Engine pure w.r.t. world: does NOT apply worldStateDelta / npcImpacts here.
 * The caller invokes applyEventOutcome on each entry. Revelations are also
 * not enqueued here — the caller calls enqueueRevelation per fired/cancelled
 * entry. This split makes the lifecycle inspectable and side-effects explicit.
 */
export function fireDueEvents(state, { currentHour }) {
  const fired = [];
  const cancelled = [];
  if (!Array.isArray(state.scheduledEvents)) return { fired, cancelled };

  for (const e of state.scheduledEvents) {
    if (e.status !== 'pending') continue;
    if (e.fireAtHour > currentHour) continue;

    if (shouldCancel(e.preconditions, state)) {
      e.status = 'cancelled';
      cancelled.push({ eventId: e.id, outcome: e.outcomeOnCancel ?? null, fireAtHour: e.fireAtHour });
    } else {
      e.status = 'fired';
      fired.push({ eventId: e.id, outcome: e.outcomeOnFire ?? null, fireAtHour: e.fireAtHour });
    }
  }
  return { fired, cancelled };
}

// ----- outcome application (caller convenience) -----

/**
 * Apply an event outcome's worldStateDelta and npcImpacts to state. Pure-ish:
 * mutates state.worldState and state.npcStates. Returns brief logging info.
 *
 * source label is used as the provenance tag on any knowledge gained
 * (e.g., 'event:king-decline-48h').
 */
export function applyEventOutcome(state, outcome, bundle, source) {
  if (!outcome) return { worldStateChanges: [], npcChanges: [] };

  const worldStateChanges = [];
  if (outcome.worldStateDelta && typeof outcome.worldStateDelta === 'object') {
    if (!state.worldState) state.worldState = { majorEvents: [] };
    for (const [k, v] of Object.entries(outcome.worldStateDelta)) {
      state.worldState[k] = v;
      worldStateChanges.push({ key: k, value: v });
    }
  }

  const npcChanges = [];
  if (Array.isArray(outcome.npcImpacts)) {
    for (const impact of outcome.npcImpacts) {
      const id = impact.npcId;
      if (!id) continue;
      if (!state.npcStates) state.npcStates = {};
      if (!state.npcStates[id]) {
        const bundleChar = (bundle?.characters || []).find(c => c.id === id);
        state.npcStates[id] = {
          location: bundleChar?.startingLocation ?? '',
          status:   bundleChar?.startingStatus   ?? '',
          motivationDelta: null,
          currentKnowledge: []
        };
      }
      const npc = state.npcStates[id];
      if (impact.locationDelta)   npc.location = impact.locationDelta;
      if (impact.statusDelta)     npc.status = impact.statusDelta;
      if (impact.motivationDelta) npc.motivationDelta = impact.motivationDelta;
      if (Array.isArray(impact.knowledgeGained)) {
        for (const k of impact.knowledgeGained) {
          npc.currentKnowledge.push({ ...k, source });
        }
      }
      npcChanges.push({ npcId: id });
    }
  }
  return { worldStateChanges, npcChanges };
}

// ----- revelation queue -----

/**
 * Enqueue a revelation into state.pendingRevelations. Silent revelations are
 * skipped (they never surface). Returns the queue entry (or null if skipped).
 */
export function enqueueRevelation(state, { eventId, fireAtHour, revelation }) {
  if (!revelation) return null;
  if (revelation.strength === 'silent') return null;
  if (!Array.isArray(state.pendingRevelations)) state.pendingRevelations = [];

  const entry = {
    eventId,
    surfaceAtHour: (fireAtHour ?? 0) + (revelation.delayHours ?? 0),
    strength: revelation.strength,
    content: revelation.content
  };
  state.pendingRevelations.push(entry);
  return entry;
}

/**
 * Walk pendingRevelations and surface any whose surfaceAtHour <= currentHour.
 * Surfaced entries are appended to playerKnowledge.witnessedEvents and removed
 * from the queue. Returns the list of surfaced entries.
 */
export function surfaceDueRevelations(state, { currentHour }) {
  if (!Array.isArray(state.pendingRevelations)) state.pendingRevelations = [];
  if (!state.playerKnowledge) {
    state.playerKnowledge = { knownThreatIds: [], witnessedEvents: [], rumors: [], investigatedFacts: [] };
  }
  if (!Array.isArray(state.playerKnowledge.witnessedEvents)) {
    state.playerKnowledge.witnessedEvents = [];
  }

  const surfaced = [];
  const remaining = [];
  for (const r of state.pendingRevelations) {
    if (r.surfaceAtHour <= currentHour) {
      state.playerKnowledge.witnessedEvents.push({
        eventId: r.eventId,
        atHour: currentHour,
        strength: r.strength,
        summary: r.content
      });
      surfaced.push(r);
    } else {
      remaining.push(r);
    }
  }
  state.pendingRevelations = remaining;
  return surfaced;
}

// ----- combined tick (caller convenience) -----

/**
 * One-call orchestration: fire due events, apply their outcomes, enqueue
 * revelations, surface due revelations. Returns a summary.
 *
 * The order matters:
 *   1. fireDueEvents (mutates event status; reads state for preconditions)
 *   2. apply outcomes + enqueue revelations
 *   3. surface revelations whose delay has already elapsed by the time we
 *      reach this turn (so a 0-delay loud revelation surfaces immediately)
 */
export function tickScheduledEvents(state, bundle, { currentHour }) {
  const { fired, cancelled } = fireDueEvents(state, { currentHour });

  const enqueued = [];
  for (const f of fired) {
    applyEventOutcome(state, f.outcome, bundle, `event:${f.eventId}`);
    const entry = enqueueRevelation(state, {
      eventId: f.eventId,
      fireAtHour: f.fireAtHour,
      revelation: f.outcome?.revelation
    });
    if (entry) enqueued.push(entry);
  }
  for (const c of cancelled) {
    // outcomeOnCancel typically has only a revelation; no worldStateDelta to apply
    const entry = enqueueRevelation(state, {
      eventId: c.eventId,
      fireAtHour: c.fireAtHour,
      revelation: c.outcome?.revelation
    });
    if (entry) enqueued.push(entry);
  }
  const surfaced = surfaceDueRevelations(state, { currentHour });

  return { fired, cancelled, enqueued, surfaced };
}
