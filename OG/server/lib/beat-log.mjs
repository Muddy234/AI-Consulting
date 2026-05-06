// Append-only beat log. One JSON object per line.
// Two record kinds share the file:
//   - turn entries: { ts, beatNumber, playerChoice, modelInput, modelOutput,
//                     stateBefore, intendedStateAfter, tokensIn, tokensOut, applied: false, kind: 'turn' }
//   - applied markers: { ts, beatNumber, applied: true, kind: 'applied' }
//
// Recovery reads forward; the latest record per beatNumber is the truth.
// Writes are append + fsync — survives crashes, never rewrites prior bytes.

import fs from 'node:fs';
import path from 'node:path';
import { LOGS_DIR } from './config.mjs';

export function logPath(gameId) {
  return path.join(LOGS_DIR, `${gameId}.jsonl`);
}

function ensureLogsDir() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function appendLine(filePath, obj) {
  ensureLogsDir();
  const line = JSON.stringify(obj) + '\n';
  const fd = fs.openSync(filePath, 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Appends a turn entry with applied: false.
 * Caller must call appendAppliedMarker after successfully writing the new state.
 */
export function appendTurnEntry(gameId, entry) {
  const obj = {
    kind: 'turn',
    ts: entry.ts || new Date().toISOString(),
    beatNumber: entry.beatNumber,
    playerChoice: entry.playerChoice ?? null,
    modelInput: entry.modelInput ?? null,
    modelOutput: entry.modelOutput ?? null,
    stateBefore: entry.stateBefore ?? null,
    intendedStateAfter: entry.intendedStateAfter ?? null,
    tokensIn: entry.tokensIn ?? 0,
    tokensOut: entry.tokensOut ?? 0,
    applied: false,
    notes: entry.notes ?? null
  };
  appendLine(logPath(gameId), obj);
  return obj;
}

/** Append a small marker confirming the state for `beatNumber` was applied to disk. */
export function appendAppliedMarker(gameId, beatNumber) {
  const obj = {
    kind: 'applied',
    ts: new Date().toISOString(),
    beatNumber,
    applied: true
  };
  appendLine(logPath(gameId), obj);
  return obj;
}

/** Read all lines as parsed records. Returns [] if log missing. */
export function readAllRecords(gameId) {
  const p = logPath(gameId);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      // Skip a corrupt trailing line (likely a torn write); log to stderr for operator.
      console.warn(`[beat-log] skipping corrupt line in ${p}: ${err.message}`);
    }
  }
  return out;
}

/** Returns last N turn entries (markers excluded), oldest-first. */
export function tailTurnEntries(gameId, n) {
  const all = readAllRecords(gameId).filter(r => r.kind === 'turn');
  return n > 0 ? all.slice(-n) : all;
}

/** Returns the highest beatNumber present among turn entries, or 0 if none. */
export function highestLoggedBeat(gameId) {
  const turns = readAllRecords(gameId).filter(r => r.kind === 'turn');
  return turns.reduce((m, r) => Math.max(m, r.beatNumber || 0), 0);
}

/**
 * Walk the log forward and identify any turn entries whose beatNumber has not been
 * confirmed by a subsequent applied marker (or whose beatNumber > lastAppliedLogBeat).
 * Returns turn entries oldest-first that need replay against the current state.
 */
export function scanUnappliedEntries(gameId, lastAppliedLogBeat) {
  const records = readAllRecords(gameId);
  const turnsByBeat = new Map();
  const appliedBeats = new Set();
  for (const r of records) {
    if (r.kind === 'turn') {
      turnsByBeat.set(r.beatNumber, r);
    } else if (r.kind === 'applied') {
      appliedBeats.add(r.beatNumber);
    }
  }
  const out = [];
  // Iterate beats in order from lastAppliedLogBeat+1 upward to keep replay deterministic.
  const beats = [...turnsByBeat.keys()]
    .filter(b => b > lastAppliedLogBeat)
    .sort((a, b) => a - b);
  for (const b of beats) {
    out.push({ entry: turnsByBeat.get(b), hasAppliedMarker: appliedBeats.has(b) });
  }
  return out;
}

/** Removes log file (used by /reset). Silent if missing. */
export function deleteLog(gameId) {
  const p = logPath(gameId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
