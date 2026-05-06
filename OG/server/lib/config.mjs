// Shared paths and constants. Single source of truth.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// server/lib/config.mjs -> server/ -> OG/
export const SERVER_DIR = path.resolve(__dirname, '..');
export const PROJECT_ROOT = path.resolve(SERVER_DIR, '..');

export const WORLDS_DIR = path.join(PROJECT_ROOT, 'worlds');
export const STATE_DIR = path.join(PROJECT_ROOT, 'state');
export const LOGS_DIR = path.join(PROJECT_ROOT, 'logs');

export const DEFAULT_WORLD = 'ember-crown';
export const DEFAULT_XLSX = path.join(PROJECT_ROOT, 'showrunner-world-template.xlsx');

export const MODEL = process.env.EMBER_MODEL || 'claude-opus-4-6';
export const PORT = 3000;

// Limits
export const MAJOR_EVENTS_CAP = 12;
export const RECENT_HISTORY_BEATS = 3;

