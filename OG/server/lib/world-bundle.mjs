// Loads + validates + caches world.json bundles.
// Server calls loadWorldBundle once at startup; per-turn code calls getCachedBundle.

import fs from 'node:fs';
import path from 'node:path';
import { WORLDS_DIR } from './config.mjs';
import { validateWorldBundle, formatErrors } from './validator.mjs';

const cache = new Map();  // worldName -> bundle

export function bundlePath(worldName) {
  return path.join(WORLDS_DIR, worldName, 'world.json');
}

/**
 * Reads, validates, and caches the world bundle.
 * Throws a verbose error if the bundle is missing or invalid.
 */
export function loadWorldBundle(worldName) {
  const p = bundlePath(worldName);
  if (!fs.existsSync(p)) {
    throw new Error(`World bundle not found: ${p}. Run tools/xlsx-to-bundle.mjs first.`);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`World bundle is not valid JSON (${p}): ${err.message}`);
  }

  const result = validateWorldBundle(raw);
  if (!result.ok) {
    throw new Error(
      `World bundle failed validation (${p}):\n${formatErrors(result.errors)}\n` +
      `Fix the xlsx and re-run the converter, or edit world.json directly.`
    );
  }

  cache.set(worldName, raw);
  return raw;
}

export function getCachedBundle(worldName) {
  if (!cache.has(worldName)) {
    return loadWorldBundle(worldName);
  }
  return cache.get(worldName);
}

/** Returns Set of npc ids — used by validator.validateModelOutput for npcImpacts checks. */
export function knownNpcIds(bundle) {
  return new Set((bundle.characters || []).map(c => c.id));
}

/** Clears cache. Useful in tests; not used in production. */
export function clearCache() {
  cache.clear();
}
