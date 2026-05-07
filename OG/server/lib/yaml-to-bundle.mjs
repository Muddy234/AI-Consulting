// Convert worlds/<name>/world.yaml -> worlds/<name>/world.json (Phase C).
//
// world.yaml is the source of truth (committed). world.json is a build
// artifact (gitignored), regenerated on server boot. Mtime-aware: skips
// regeneration when world.json is newer than world.yaml unless --force.
//
// See OBJECTIVE_REFACTOR_PLAN.md §2.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { WORLDS_DIR } from './config.mjs';

export function yamlPath(worldName, worldsDir = WORLDS_DIR) {
  return path.join(worldsDir, worldName, 'world.yaml');
}

export function jsonPath(worldName, worldsDir = WORLDS_DIR) {
  return path.join(worldsDir, worldName, 'world.json');
}

function shouldSkip(yamlP, jsonP, force) {
  if (force) return false;
  if (!fs.existsSync(jsonP)) return false;
  return fs.statSync(jsonP).mtimeMs >= fs.statSync(yamlP).mtimeMs;
}

/**
 * Convert a world's YAML source to its JSON bundle.
 * Returns { skipped, jsonPath, bundle? }.
 * Throws if the YAML is missing or fails to parse.
 */
export function convertYamlToBundle({ worldName, force = false, silent = false, worldsDir = WORLDS_DIR } = {}) {
  const yamlP = yamlPath(worldName, worldsDir);
  const jsonP = jsonPath(worldName, worldsDir);

  if (!fs.existsSync(yamlP)) {
    throw new Error(`world.yaml not found: ${yamlP}`);
  }
  if (shouldSkip(yamlP, jsonP, force)) {
    if (!silent) console.log(`[yaml-to-bundle] skip (up-to-date): ${jsonP}`);
    return { skipped: true, jsonPath: jsonP };
  }

  const text = fs.readFileSync(yamlP, 'utf8');
  let bundle;
  try {
    bundle = yaml.load(text);
  } catch (err) {
    throw new Error(`Failed to parse YAML at ${yamlP}: ${err.message}`);
  }

  // Atomic write: tmp -> rename
  const tmpP = jsonP + '.tmp';
  fs.writeFileSync(tmpP, JSON.stringify(bundle, null, 2));
  fs.renameSync(tmpP, jsonP);

  if (!silent) console.log(`[yaml-to-bundle] wrote ${jsonP}`);
  return { skipped: false, jsonPath: jsonP, bundle };
}

// CLI: `node lib/yaml-to-bundle.mjs --world=ember-crown [--force]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = {};
  for (const a of process.argv.slice(2)) {
    if (a === '--force') args.force = true;
    else if (a.startsWith('--world=')) args.worldName = a.slice('--world='.length);
  }
  if (!args.worldName) {
    console.error('Usage: node lib/yaml-to-bundle.mjs --world=<name> [--force]');
    process.exit(1);
  }
  try {
    convertYamlToBundle(args);
  } catch (err) {
    console.error('[yaml-to-bundle] error:', err.message);
    process.exit(1);
  }
}
