// Build the [RECENT HISTORY] block input for the prompt composer.
// Per OBJECTIVE_REFACTOR_PLAN.md §1.5: "opening beat (always) + last 3 beats."
// The opening anchors voice; the last 3 anchor continuity.

import { readAllRecords } from './beat-log.mjs';

/**
 * Returns an array of { title, prose } in chronological order suitable
 * for the prompt composer's recentHistory parameter. Stitches resolution
 * prose (the outcome of the player's prior choice) and intro prose (the
 * scene that followed) into a single block per beat.
 *
 * Always includes the opening (beat 1). Plus the most recent up-to-3
 * beats. Dedupes if the opening overlaps the recent window.
 */
export function buildRecentHistory(gameId) {
  const turns = readAllRecords(gameId).filter(r => r.kind === 'turn');
  if (turns.length === 0) return [];

  const ids = new Set();
  const collected = [];

  const opening = turns.find(r => r.beatNumber === 1);
  if (opening) { collected.push(opening); ids.add(1); }

  for (const r of turns.slice(-3)) {
    if (!ids.has(r.beatNumber)) {
      collected.push(r);
      ids.add(r.beatNumber);
    }
  }
  collected.sort((a, b) => a.beatNumber - b.beatNumber);

  return collected.map(toHistoryEntry).filter(e => e && e.prose);
}

function toHistoryEntry(entry) {
  const m = entry.modelOutput || {};
  const presented = m.presentedBeat;
  const resolution = m.resolution;

  const title =
    presented?.title
    ?? (entry.beatNumber === 1 ? 'I. The Opening' : `Beat ${entry.beatNumber}`);

  const parts = [];
  if (resolution?.segments) parts.push(stringifySegments(resolution.segments));
  if (presented?.prose?.segments) parts.push(stringifySegments(presented.prose.segments));
  if (presented?.intro?.segments) parts.push(stringifySegments(presented.intro.segments));

  const prose = parts.filter(p => p && p.trim()).join('\n\n');
  return { title, prose };
}

/**
 * Concatenate proseSegment[] into plain text. Both 'text' and 'link'
 * segments contribute their visible content; the link/text distinction
 * does not survive into the recent-history string (the model just needs
 * the prose for tonal continuity).
 */
export function stringifySegments(segments) {
  if (!Array.isArray(segments)) return '';
  return segments
    .map(s => (s?.type === 'text' || s?.type === 'link') ? (s.content || '') : '')
    .join('');
}
