// Knowledge layer (Phase F). See OBJECTIVE_REFACTOR_PLAN.md §1.5, §3.2 step 4.
//
// The prompt composer (Phase G) MUST read from this view, never directly
// from worldState / threats / scheduledEvents. The view enforces:
//
//   - NPC scoping: in-scene NPCs get their full knowledge graph; off-screen
//     NPCs get name/role/last-known-location/last-known-status with NO
//     currentKnowledge field. Structural defense against the model leaking
//     facts an off-screen NPC shouldn't know.
//
//   - Threat filtering: only threats with knownToPlayer=true are exposed.
//     Halric's plan ticks regardless of player visibility, but the model
//     never sees it until the player has earned the reveal.
//
//   - Revelation surfacing: only revelations whose surfaceAtHour has been
//     reached (and thus moved into playerKnowledge.witnessedEvents) are in
//     scope. Pending and silent revelations stay invisible.
//
// V1 limitation (documented): worldState is sent to the prompt as-is. Silent
// worldStateDelta changes (cancelled events with strength='silent', or
// model-authored fired events that bypass the prompt rule) are visible in
// worldState even though the player doesn't know. Mitigated by: the
// validator rejecting fire-revelations of strength=silent in model output;
// the bundle authoring discipline of not pairing worldStateDelta with
// silent revelations on cancel paths. A two-track worldState (truth vs
// player-visible) is the proper fix; deferred until needed.

// ----- in-scene determination -----

/**
 * True when the NPC and the player are at "the same place" by simple
 * substring match. Handles cases like "Wren's Hollow" vs "Wren's Hollow
 * (own home)". Tunable; will need to grow for richer location modeling.
 */
export function isNpcInScene(npcLocation, playerLocation) {
  if (!npcLocation || !playerLocation) return false;
  const a = String(npcLocation).toLowerCase().trim();
  const b = String(playerLocation).toLowerCase().trim();
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

// ----- NPC scoping -----

/**
 * Splits state.npcStates into in-scene (full knowledge) and off-screen
 * (id/name/role/last-known fields only — NO currentKnowledge or notes).
 * Returns { inScene: { [id]: view }, offScreen: { [id]: view } }.
 */
export function scopedNpcView(state, bundle) {
  const playerLocation = state?.location ?? '';
  const inScene = {};
  const offScreen = {};
  const characters = bundle?.characters || [];
  const charById = new Map(characters.map(c => [c.id, c]));

  for (const [id, npc] of Object.entries(state?.npcStates ?? {})) {
    const character = charById.get(id);
    if (isNpcInScene(npc?.location, playerLocation)) {
      inScene[id] = {
        id,
        name:             character?.name ?? id,
        role:             character?.role ?? null,
        location:         npc.location ?? null,
        status:           npc.status ?? null,
        motivationDelta:  npc.motivationDelta ?? null,
        currentKnowledge: Array.isArray(npc.currentKnowledge) ? [...npc.currentKnowledge] : [],
        notes:            character?.notes ?? null
      };
    } else {
      offScreen[id] = {
        id,
        name:              character?.name ?? id,
        role:              character?.role ?? null,
        lastKnownLocation: npc?.location ?? null,
        lastKnownStatus:   npc?.status ?? null
        // NO currentKnowledge, NO notes — structural leak protection
      };
    }
  }
  return { inScene, offScreen };
}

// ----- threat filtering -----

/**
 * Returns the player-visible view of threats: only those known to the
 * player. Each entry includes display metadata from the bundle and the
 * runtime phase / visibility / completion flags.
 */
export function knownThreatView(state, bundle) {
  const known = state?.playerKnowledge?.knownThreatIds ?? [];
  const bundleThreatsById = new Map((bundle?.threats || []).map(t => [t.id, t]));
  const out = [];
  for (const id of known) {
    const runtime = state?.threats?.[id];
    if (!runtime) continue;
    const bundleThreat = bundleThreatsById.get(id);
    const effective = Math.max(0, (runtime.progress ?? 0) - (runtime.slowedBy ?? 0));
    out.push({
      id,
      displayName:    bundleThreat?.displayName ?? id,
      icon:           bundleThreat?.icon ?? null,
      currentPhase:   runtime.currentPhase ?? null,
      isVisibleInHud: Boolean(runtime.knownToPlayer && !runtime.completed && effective > 0),
      completed:      Boolean(runtime.completed)
    });
  }
  return out;
}

// ----- recent revelations / facts -----

/**
 * Revelations the player learned at or after sinceHour. The orchestrator
 * passes the previous turn's hour stamp so the prompt composer can mark
 * "weave these in this beat."
 */
export function recentRevelations(state, { sinceHour = 0 } = {}) {
  const events = state?.playerKnowledge?.witnessedEvents ?? [];
  return events.filter(e => typeof e?.atHour === 'number' && e.atHour >= sinceHour);
}

/** Most recent N investigated facts (player clicked-to-learn). */
export function recentInvestigatedFacts(state, { count = 10 } = {}) {
  const facts = state?.playerKnowledge?.investigatedFacts ?? [];
  return facts.slice(-Math.max(0, count));
}

/** Most recent N rumors (partial / unreliable). */
export function recentRumors(state, { count = 10 } = {}) {
  const rumors = state?.playerKnowledge?.rumors ?? [];
  return rumors.slice(-Math.max(0, count));
}

// ----- the assembled view -----

/**
 * Build the prompt-ready knowledge view. The composer (Phase G) consumes
 * this and never reads from state directly.
 *
 * Optional inputs:
 *   hudChanges  - from threat-engine.tickThreats; { threatId, change } pairs
 *                 ('hidden' or 'resurgent') for the model to acknowledge
 *   sinceHour   - cutoff for "recent" revelations (typically last turn's stamp)
 */
export function buildKnowledgeView(state, bundle, { hudChanges = [], sinceHour = 0 } = {}) {
  return {
    leanState: {
      clockHours:     state?.clockHours ?? null,
      condition:      state?.condition ?? null,
      location:       state?.location ?? null,
      assets:         Array.isArray(state?.assets) ? [...state.assets] : [],
      lastChoiceRisk: state?.lastChoiceRisk ?? null
    },
    worldState:           { ...(state?.worldState ?? {}) },
    knownThreats:         knownThreatView(state, bundle),
    npcs:                 scopedNpcView(state, bundle),
    recentRevelations:    recentRevelations(state, { sinceHour }),
    investigatedFacts:    recentInvestigatedFacts(state),
    rumors:               recentRumors(state),
    hudChanges:           Array.isArray(hudChanges) ? [...hudChanges] : []
  };
}
