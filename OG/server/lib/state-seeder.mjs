// Initial state seeder (Phase I).
// Builds a fresh runtime state object from a world bundle, ready for turn 1.

import { seedThreatsFromBundle } from './threat-engine.mjs';
import { seedScheduledEventsFromBundle } from './scheduled-events-engine.mjs';

export function seedNewGame({ gameId, bundle }) {
  if (!gameId)  throw new Error('seedNewGame requires gameId');
  if (!bundle)  throw new Error('seedNewGame requires bundle');

  const startingClocks = bundle.startingClocks || {};
  const startingWorld  = bundle.startingWorldState || {};
  const startingPlayer = bundle.playerStartingState || {};

  const state = {
    gameId,
    worldName: bundle.worldName,
    turnNumber: 1,
    lastAppliedLogTurn: 1,

    clockHours:     startingClocks.clockHours     ?? 96,
    distanceToKing: startingClocks.distanceToKing ?? 100,

    condition:      startingPlayer.condition ?? 'healthy',
    location:       startingPlayer.location  ?? '',
    assets:         Array.isArray(startingPlayer.assets) ? [...startingPlayer.assets] : [],
    lastChoiceRisk: null,

    worldState: {
      timeOfDay:        startingWorld.timeOfDay        ?? 'dawn',
      cometStage:       startingWorld.cometStage       ?? 'approaching',
      kingStatus:       startingWorld.kingStatus       ?? 'declining',
      crownStatus:      startingWorld.crownStatus      ?? 'dormant',
      antagonistPower:  startingWorld.antagonistPower  ?? 'advisor',
      majorEvents: []
    },

    threats: {},
    scheduledEvents: [],
    pendingRevelations: [],
    openedLinks: {},

    playerKnowledge: {
      knownThreatIds: [],
      witnessedEvents: [],
      rumors: [],
      investigatedFacts: Array.isArray(startingPlayer.startingFacts)
        ? [...startingPlayer.startingFacts]
        : []
    },

    npcStates: {},

    runHistory: {
      threatsCompleted:           [],
      threatsStopped:             [],
      threatsNeverLearned:        [],
      counterfactualsFiredKnown:  [],
      counterfactualsFiredSilent: []
    },

    terminalState: null
  };

  seedThreatsFromBundle(state, bundle);
  seedScheduledEventsFromBundle(state, bundle);

  return state;
}
