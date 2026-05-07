// Loads + validates + caches world bundles.
// world.yaml (committed) is the source of truth; world.json (gitignored)
// is the runtime artifact, regenerated from YAML at boot via lib/yaml-to-bundle.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { WORLDS_DIR } from './config.mjs';
import { convertYamlToBundle } from './yaml-to-bundle.mjs';
import { validateWorldBundle, formatErrors } from './objective-validator.mjs';

const cache = new Map();  // worldName -> bundle

export function bundlePath(worldName) {
  return path.join(WORLDS_DIR, worldName, 'world.json');
}

/**
 * Regenerates world.json from world.yaml if needed (mtime-aware), reads,
 * validates, and caches the bundle. Throws a verbose error on any failure.
 */
export function loadWorldBundle(worldName) {
  // Regenerate JSON from YAML if YAML is newer (or if JSON is missing).
  convertYamlToBundle({ worldName, silent: true });

  const p = bundlePath(worldName);
  if (!fs.existsSync(p)) {
    throw new Error(`World bundle not found: ${p}.`);
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
      `World bundle failed validation (${p}):\n${formatErrors(result.errors)}`
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
