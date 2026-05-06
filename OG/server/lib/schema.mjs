// Shape definitions used by validator.mjs.
// Plain JS objects rather than JSON Schema — keeps validation logic + error messages focused.

// Allowed enum values for known worldState fields. The model may add new keys
// (string-typed) without restriction, but enum-typed keys are policed.
export const WORLD_STATE_ENUMS = {
  timeOfDay: ['dawn', 'midday', 'dusk', 'night'],
  cometStage: ['approaching', 'near-zenith', 'zenith', 'passing', 'passed'],
  kingStatus: ['declining', 'dying', 'dead'],
  crownStatus: ['dormant', 'held', 'activated', 'destroyed'],
  antagonistPower: ['advisor', 'regent', 'crowned', 'dead']
};

// Server-owned fields the model is not permitted to set in worldStateDeltas.
// Validator silently strips these — does not fail the whole turn.
export const SERVER_OWNED_WORLD_FIELDS = new Set([
  'worldDay',
  'cumulativeHoursElapsed'
]);

export const PLAYER_CONDITION_ENUM = ['well', 'tired', 'wounded', 'exhausted', 'dying', 'baseline'];

export const CHOICE_LABELS = ['A', 'B', 'C'];
export const CHOICE_COUNT = 3;

// Choice coordinate axes (2x2 matrix). Each choice has (selfOther, assertYield)
// in the closed interval [-1, +1], on a 0.10 grid. (0, 0) is forbidden.
// Axis 1: selfOther  -- negative = SELF-oriented; positive = OTHER-oriented.
// Axis 2: assertYield -- negative = ASSERT;       positive = YIELD.
export const CHOICE_COORD_MIN = -1;
export const CHOICE_COORD_MAX = 1;
export const CHOICE_COORD_STEP = 0.1;
// Float tolerance for step-multiple checks (0.10 increments don't roundtrip cleanly in IEEE 754).
export const CHOICE_COORD_EPSILON = 1e-6;

export const CONFIDENCE_ENUM = ['certain', 'suspected', 'rumored'];

export const FORWARD_CONFIDENCE_ENUM = ['low', 'moderate', 'high'];

// Top-level required fields for each shape.
export const WORLD_BUNDLE_REQUIRED = [
  'worldName', 'displayName', 'voice', 'structuralObjective', 'worldBible',
  'worldConstraints', 'adaptationRules', 'pacingBudget', 'characters',
  'openingBeat', 'playerStartingState'
];

export const RUNTIME_STATE_REQUIRED = [
  'gameId', 'worldName', 'beatNumber', 'lastAppliedLogBeat',
  'worldState', 'playerState', 'npcStates', 'plotTrajectory'
];

export const MODEL_OUTPUT_REQUIRED = [
  'worldImpacts', 'npcImpacts', 'narrativeResponse',
  'forwardProjection', 'directorReasoning'
];
