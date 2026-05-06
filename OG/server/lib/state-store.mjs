// Atomic state file I/O for per-game runtime state.
// Atomic-write pattern: serialize JSON, write to .tmp, fsync, rename over the live file.
// Survives mid-write crashes — readers either see the prior good copy or the new one, never garbage.

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.mjs';

export function statePath(gameId) {
  return path.join(STATE_DIR, `${gameId}.json`);
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

/** Returns parsed state or null if missing. Throws if present-but-corrupt. */
export function readState(gameId) {
  const p = statePath(gameId);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`State file corrupt (${p}): ${err.message}`);
  }
}

/**
 * Atomic write: state/<gameId>.json.tmp -> fsync -> rename.
 * Always serializes with newline-terminated pretty JSON for human inspection.
 */
export function writeState(gameId, state) {
  ensureStateDir();
  const target = statePath(gameId);
  const tmp = target + '.tmp';
  const payload = JSON.stringify(state, null, 2) + '\n';

  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

/** Returns array of gameIds with persisted state. */
export function listGameIds() {
  if (!fs.existsSync(STATE_DIR)) return [];
  return fs.readdirSync(STATE_DIR)
    .filter(f => f.endsWith('.json') && !f.endsWith('.tmp.json'))
    .map(f => f.slice(0, -'.json'.length));
}

/** Removes state file (used by /reset). Silent if missing. */
export function deleteState(gameId) {
  const p = statePath(gameId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
