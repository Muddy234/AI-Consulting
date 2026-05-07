// Threat engine (Phase D). See OBJECTIVE_REFACTOR_PLAN.md §1.2, §3.2 step 2.
//
// Macro-threats are persistent, ticked every turn. State per threat:
//   progress       monotonic, increases by clockHoursDelta each turn
//   slowedBy       accumulates from player-induced slowdowns
//   currentPhase   label, recomputed from effectiveProgress against bundle phases
//   knownToPlayer  gates HUD render
//   completed      set when effectiveProgress >= duration; onComplete payload is
//                  returned to the caller for application (engine stays pure)
//
// effectiveProgress = max(0, progress - slowedBy)
//
// HUD visibility = knownToPlayer && effectiveProgress > 0 && !completed.
// Slowing a known threat past 0 hides its meter; subsequent progress that
// exceeds slowedBy "resurges" the meter. The engine reports both transitions
// so the prompt composer can flag them for the model to acknowledge.
//
// Phase D scope: bundle-authored threats only. Model-authored macro-threats
// are accepted by the validator but their definitions (duration / phases /
// onComplete) are not yet ticked here. That gap closes in a later phase.

// ----- pure helpers -----

export function effectiveProgress(threatRuntime) {
  return Math.max(0, (threatRuntime?.progress ?? 0) - (threatRuntime?.slowedBy ?? 0));
}

export function computePhase(progress, phases) {
  if (!Array.isArray(phases) || phases.length === 0) return null;
  let current = phases[0].label;
  for (const p of phases) {
    if (typeof p?.atProgress === 'number' && p.atProgress <= progress) {
      current = p.label;
    }
  }
  return current;
}

export function isVisibleInHud(threatRuntime) {
  return Boolean(
    threatRuntime?.knownToPlayer &&
    !threatRuntime?.completed &&
    effectiveProgress(threatRuntime) > 0
  );
}

// ----- initialization -----

export function initThreatRuntime(bundleThreat, { authorSource = 'authored' } = {}) {
  const firstPhase = bundleThreat?.phases?.[0]?.label ?? null;
  return {
    progress: 0,
    currentPhase: firstPhase,
    slowedBy: 0,
    knownToPlayer: false,
    revealedAtHour: null,
    completed: false,
    completedAt: null,
    authorSource
  };
}

/**
 * Seed state.threats from a bundle. Idempotent — only adds threats not
 * already present, so it's safe to call on a partially-recovered state.
 */
export function seedThreatsFromBundle(state, bundle) {
  if (!state.threats) state.threats = {};
  for (const t of bundle.threats || []) {
    if (!state.threats[t.id]) {
      state.threats[t.id] = initThreatRuntime(t, { authorSource: 'authored' });
    }
  }
}

// ----- per-turn tick -----

/**
 * Advance every active threat in state.threats by clockHoursDelta and apply
 * any threatSlowdowns. Recomputes currentPhase. Detects completion. Reports
 * HUD-visibility transitions.
 *
 * Returns:
 *   {
 *     completions: [{ threatId, onComplete, completedAt }],
 *     hudChanges:  [{ threatId, change: 'hidden' | 'resurgent' }]
 *   }
 *
 * The caller is responsible for applying onComplete payloads to worldState
 * and majorEvents — keeps this engine stateless w.r.t. the rest of the world.
 */
export function tickThreats(state, bundle, { clockHoursDelta = 0, threatSlowdowns = [], currentHour = null } = {}) {
  const completions = [];
  const hudChanges = [];

  if (!state.threats) state.threats = {};

  // Index slowdowns by threatId, summing duplicates.
  const slowdownsByThreat = new Map();
  for (const s of threatSlowdowns) {
    if (!s?.threatId || typeof s.hours !== 'number' || s.hours <= 0) continue;
    slowdownsByThreat.set(s.threatId, (slowdownsByThreat.get(s.threatId) ?? 0) + s.hours);
  }

  // Bundle threat lookup.
  const bundleById = new Map();
  for (const t of bundle?.threats || []) bundleById.set(t.id, t);

  // Hour stamp for completion / resurgence (caller-supplied; otherwise derived).
  const hourStamp = currentHour ?? deriveCurrentHour(state, bundle, clockHoursDelta);

  for (const [id, runtime] of Object.entries(state.threats)) {
    if (runtime.completed) continue;

    // Phase D: only bundle-authored threats tick.
    const bundleThreat = bundleById.get(id);
    if (!bundleThreat) continue;

    const wasVisible = isVisibleInHud(runtime);

    // Tick: progress monotonically increases by elapsed time.
    runtime.progress += Math.max(0, clockHoursDelta);

    // Apply this turn's player-induced slowdowns.
    const slowdownNow = slowdownsByThreat.get(id) ?? 0;
    if (slowdownNow > 0) runtime.slowedBy += slowdownNow;

    // Recompute phase from effective progress against the bundle's phase ladder.
    const eff = effectiveProgress(runtime);
    runtime.currentPhase = computePhase(eff, bundleThreat.phases || []);

    // Completion check uses effective progress (slowdowns delay completion).
    if (eff >= (bundleThreat.duration ?? Infinity)) {
      runtime.completed = true;
      runtime.completedAt = hourStamp;
      completions.push({
        threatId: id,
        onComplete: bundleThreat.onComplete ?? null,
        completedAt: hourStamp
      });
    }

    // HUD-visibility transitions, only meaningful for known threats.
    const isVisible = isVisibleInHud(runtime);
    if (runtime.knownToPlayer) {
      if (wasVisible && !isVisible && !runtime.completed) {
        hudChanges.push({ threatId: id, change: 'hidden' });
      } else if (!wasVisible && isVisible) {
        hudChanges.push({ threatId: id, change: 'resurgent' });
      }
    }
  }

  return { completions, hudChanges };
}

// ----- reveal (called when an unlock condition fires) -----

/**
 * Mark a threat as known to the player. Idempotent: calling twice is a no-op
 * after the first reveal. Returns true on the transitioning call, false
 * otherwise.
 */
export function revealThreat(state, threatId, atHour) {
  const runtime = state?.threats?.[threatId];
  if (!runtime) return false;
  if (runtime.knownToPlayer) return false;

  runtime.knownToPlayer = true;
  runtime.revealedAtHour = atHour ?? null;

  if (!state.playerKnowledge) {
    state.playerKnowledge = {
      knownThreatIds: [],
      witnessedEvents: [],
      rumors: [],
      investigatedFacts: []
    };
  }
  if (!state.playerKnowledge.knownThreatIds.includes(threatId)) {
    state.playerKnowledge.knownThreatIds.push(threatId);
  }
  return true;
}

// ----- onComplete application (called by orchestrator after tickThreats) -----

/**
 * Apply a threat's onComplete payload to worldState + majorEvents. Pure-ish:
 * mutates state.worldState and returns a brief description for logging.
 */
export function applyOnComplete(state, onComplete) {
  if (!onComplete || !state) return null;

  if (!state.worldState) state.worldState = { majorEvents: [] };
  if (!Array.isArray(state.worldState.majorEvents)) state.worldState.majorEvents = [];

  if (onComplete.worldStateDelta && typeof onComplete.worldStateDelta === 'object') {
    for (const [k, v] of Object.entries(onComplete.worldStateDelta)) {
      state.worldState[k] = v;
    }
  }
  if (onComplete.majorEvent) {
    state.worldState.majorEvents.push(onComplete.majorEvent);
    // cap at 12 (rolling)
    if (state.worldState.majorEvents.length > 12) {
      state.worldState.majorEvents = state.worldState.majorEvents.slice(-12);
    }
  }
  return onComplete.majorEvent ?? null;
}

// ----- internal -----

function deriveCurrentHour(state, bundle, clockHoursDelta) {
  const initial = bundle?.startingClocks?.clockHours;
  const remaining = state?.clockHours;
  if (typeof initial !== 'number' || typeof remaining !== 'number') return 0;
  // Hour stamp AFTER this tick is applied: (initial - remaining) + delta.
  return (initial - remaining) + Math.max(0, clockHoursDelta);
}
