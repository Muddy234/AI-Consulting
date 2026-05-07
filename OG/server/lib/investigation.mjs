// Hyperlink investigation flow (Phase H). See OBJECTIVE_REFACTOR_PLAN.md §3.3, §4.2.
//
// When the player clicks a hyperlink in beat prose, the orchestrator
// invokes applyInvestigation. This:
//   1. Looks up the link in the beat's linkContents map
//   2. First-click-per-beat idempotency: if already opened, returns the
//      cached content with no further side effects
//   3. Otherwise, deducts costHours from clockHours (clamped at 0; reports
//      actualCostApplied)
//   4. If any cost was applied, ticks threats and scheduled events by that
//      many hours -- the world advances while the player investigates
//   5. Applies unlocksFacts to playerKnowledge.investigatedFacts
//   6. Applies unlocksThreats via revealThreat (sets knownToPlayer + adds
//      to playerKnowledge.knownThreatIds)
//   7. Records the open in state.openedLinks[beatNumber] for idempotency
//
// The orchestrator (Phase I) wires this to a POST /investigate route.
// The function itself is pure-ish: mutates state, returns a result.

import { tickThreats, revealThreat } from './threat-engine.mjs';
import { tickScheduledEvents } from './scheduled-events-engine.mjs';

const INVESTIGATION_REVEAL_SOURCE = 'investigation';

/**
 * True if the link has been opened before in this beat.
 */
export function isLinkOpened(state, beatNumber, linkId) {
  const key = String(beatNumber);
  return Boolean(state?.openedLinks?.[key]?.includes(linkId));
}

/**
 * Apply a hyperlink investigation. See module-top docstring.
 *
 * Returns:
 *   {
 *     ok: boolean,
 *     error?: string,
 *     alreadyOpened: boolean,
 *     content: string,
 *     costHoursApplied: number,
 *     unlocksFacts: string[],     // newly added (excludes already-known)
 *     unlocksThreats: string[],   // newly revealed (excludes already-known)
 *     tickResults: {
 *       threatTick:  { completions, hudChanges } | null,
 *       eventTick:   { fired, cancelled, enqueued, surfaced } | null
 *     } | null
 *   }
 */
export function applyInvestigation(state, bundle, {
  beatNumber,
  linkId,
  linkContents,
  currentHour
} = {}) {
  if (linkId == null || linkId === '') {
    return _err('linkId required');
  }
  if (!linkContents || typeof linkContents !== 'object') {
    return _err('linkContents required');
  }
  if (!Object.prototype.hasOwnProperty.call(linkContents, linkId)) {
    return _err(`link '${linkId}' not found in linkContents`);
  }
  if (beatNumber == null) {
    return _err('beatNumber required');
  }

  const link = linkContents[linkId];

  // First-click-only idempotency
  if (isLinkOpened(state, beatNumber, linkId)) {
    return {
      ok: true,
      alreadyOpened: true,
      content: link.content,
      costHoursApplied: 0,
      unlocksFacts: [],
      unlocksThreats: [],
      tickResults: null
    };
  }

  // Hour stamp BEFORE we deduct cost (caller-supplied or derived from
  // current state.clockHours). Used as the base for "post-investigation
  // hour" downstream.
  const baseHour = currentHour ?? deriveCurrentHourBeforeCost(state, bundle);

  // Deduct cost (clamped at 0)
  const requested = Math.max(0, Number(link.costHours) || 0);
  const before = Number(state?.clockHours) || 0;
  const newClockHours = Math.max(0, before - requested);
  const costHoursApplied = before - newClockHours;
  state.clockHours = newClockHours;

  // The world tick happens AT baseHour + costHoursApplied (i.e., the
  // moment the investigation completes).
  const hourAfterCost = baseHour + costHoursApplied;

  // Tick world if any cost was applied
  let tickResults = null;
  if (costHoursApplied > 0) {
    tickResults = {
      threatTick: tickThreats(state, bundle, {
        clockHoursDelta: costHoursApplied,
        currentHour: hourAfterCost
      }),
      eventTick: tickScheduledEvents(state, bundle, { currentHour: hourAfterCost })
    };
  }

  // unlocksFacts -> playerKnowledge.investigatedFacts (deduped)
  const factsApplied = [];
  if (Array.isArray(link.unlocksFacts) && link.unlocksFacts.length > 0) {
    if (!state.playerKnowledge) {
      state.playerKnowledge = { knownThreatIds: [], witnessedEvents: [], rumors: [], investigatedFacts: [] };
    }
    if (!Array.isArray(state.playerKnowledge.investigatedFacts)) {
      state.playerKnowledge.investigatedFacts = [];
    }
    for (const fact of link.unlocksFacts) {
      if (!state.playerKnowledge.investigatedFacts.includes(fact)) {
        state.playerKnowledge.investigatedFacts.push(fact);
        factsApplied.push(fact);
      }
    }
  }

  // unlocksThreats -> revealThreat (returns true on the transition)
  const threatsApplied = [];
  if (Array.isArray(link.unlocksThreats) && link.unlocksThreats.length > 0) {
    for (const threatId of link.unlocksThreats) {
      const newlyRevealed = revealThreat(state, threatId, hourAfterCost);
      if (newlyRevealed) threatsApplied.push(threatId);
    }
  }

  // Record open for idempotency
  if (!state.openedLinks) state.openedLinks = {};
  const key = String(beatNumber);
  if (!Array.isArray(state.openedLinks[key])) state.openedLinks[key] = [];
  state.openedLinks[key].push(linkId);

  return {
    ok: true,
    alreadyOpened: false,
    content: link.content,
    costHoursApplied,
    unlocksFacts: factsApplied,
    unlocksThreats: threatsApplied,
    tickResults
  };
}

function _err(message) {
  return {
    ok: false,
    error: message,
    alreadyOpened: false,
    content: null,
    costHoursApplied: 0,
    unlocksFacts: [],
    unlocksThreats: [],
    tickResults: null
  };
}

function deriveCurrentHourBeforeCost(state, bundle) {
  const initial = bundle?.startingClocks?.clockHours;
  const remaining = state?.clockHours;
  if (typeof initial !== 'number' || typeof remaining !== 'number') return 0;
  return initial - remaining;
}
