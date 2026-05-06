// xlsx -> world.json converter.
// Reads showrunner-world-template.xlsx and emits worlds/<world>/world.json.
// Default behavior: skip if world.json is newer than the xlsx (mtime-aware).
// Pass --force to regenerate regardless.
//
// Usage:
//   node tools/xlsx-to-bundle.mjs                      # uses defaults from config
//   node tools/xlsx-to-bundle.mjs --force
//   node tools/xlsx-to-bundle.mjs --xlsx=path --world=name --out=path

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';
import {
  DEFAULT_WORLD,
  DEFAULT_XLSX,
  WORLDS_DIR
} from '../lib/config.mjs';

// ---------- xlsx parsing ----------

function readSharedStrings(zip) {
  const entry = zip.getEntry('xl/sharedStrings.xml');
  if (!entry) return [];
  const xml = entry.getData().toString('utf8');
  const strings = [];
  // Each <si> is one shared string. Inside, text lives in <t>...</t>;
  // rich text spreads across <r><t>...</t></r> runs that must be concatenated.
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = siRe.exec(xml)) !== null) {
    const inner = m[1];
    let text = '';
    let tm;
    tRe.lastIndex = 0;
    while ((tm = tRe.exec(inner)) !== null) {
      text += decodeXml(tm[1]);
    }
    strings.push(text);
  }
  return strings;
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function readSheet(zip, sheetFile, sharedStrings) {
  const entry = zip.getEntry(`xl/worksheets/${sheetFile}`);
  if (!entry) throw new Error(`Missing sheet ${sheetFile}`);
  const xml = entry.getData().toString('utf8');
  // Map cellRef ("B7") -> string value.
  // Self-closing branch FIRST so it doesn't fall through to the open/close branch
  // (which would gobble across self-closing cells looking for </c>).
  const cells = {};
  const cRe = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g;
  let m;
  while ((m = cRe.exec(xml)) !== null) {
    const isSelfClosing = m[1] !== undefined;
    const attrs = isSelfClosing ? m[1] : m[2];
    const inner = isSelfClosing ? '' : m[3];
    const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1];
    if (!ref) continue;
    const tAttr = (attrs.match(/t="([^"]+)"/) || [])[1];
    let val = '';
    if (tAttr === 's') {
      const idx = parseInt((inner.match(/<v>(\d+)<\/v>/) || [])[1], 10);
      if (Number.isFinite(idx) && idx < sharedStrings.length) val = sharedStrings[idx];
    } else if (tAttr === 'inlineStr') {
      const tMatch = inner.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
      if (tMatch) val = decodeXml(tMatch[1]);
    } else {
      const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
      if (vMatch) val = decodeXml(vMatch[1]);
    }
    cells[ref] = val;
  }
  return cells;
}

function loadWorkbook(xlsxPath) {
  const zip = new AdmZip(xlsxPath);
  const shared = readSharedStrings(zip);
  return {
    sheet1: readSheet(zip, 'sheet1.xml', shared),  // README
    sheet2: readSheet(zip, 'sheet2.xml', shared),  // World Definition
    sheet3: readSheet(zip, 'sheet3.xml', shared),  // Characters
    sheet4: readSheet(zip, 'sheet4.xml', shared),  // Runtime State (ref)
    sheet5: readSheet(zip, 'sheet5.xml', shared),  // Model I-O (ref)
  };
}

// ---------- field extraction ----------

// "Your World" is column F; "Example" is column E. Prefer F; fall back to E.
function pick(cells, row) {
  const f = (cells[`F${row}`] || '').trim();
  if (f) return f;
  return (cells[`E${row}`] || '').trim();
}

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseInventory(text) {
  if (!text) return [];
  // The template uses "Hunting knife. Cloak. Three days' food."
  // Split on period or comma; trim; drop empties.
  return text
    .split(/[.,;]/)
    .map(s => s.trim())
    .filter(Boolean);
}

function extractClimaxType(text) {
  if (!text) return '';
  // "Succession (the dying king's power passes — to ...)" -> "Succession"
  const idx = text.indexOf(' (');
  return idx > 0 ? text.slice(0, idx).trim() : text.trim();
}

function extractCharacters(cells) {
  const chars = [];
  // Header row is 5; data starts at row 6.
  // Stop on blank Name (column B) or the "Your characters below" divider.
  for (let row = 6; row < 200; row++) {
    const name = (cells[`B${row}`] || '').trim();
    if (!name) break;
    if (/your characters below/i.test(name)) break;

    const role = (cells[`C${row}`] || '').trim();
    const physical = (cells[`E${row}`] || '').trim();
    const voice = (cells[`F${row}`] || '').trim();
    const motivations = (cells[`G${row}`] || '').trim();
    const allegiances = (cells[`H${row}`] || '').trim();
    const startingLocation = (cells[`I${row}`] || '').trim();
    const startingStatus = (cells[`J${row}`] || '').trim();
    const knowledgeText = (cells[`K${row}`] || '').trim();
    const notes = (cells[`L${row}`] || '').trim();

    chars.push({
      id: slugify(name),
      name,
      role,
      physical,
      voice,
      motivations,
      allegiances,
      startingLocation,
      startingStatus,
      knowledgeText,    // free-form for v1; structured graph happens at runtime
      notes
    });
  }
  return chars;
}

function buildBundle(workbook, worldName) {
  const w = workbook.sheet2;  // World Definition
  const settingAndTone = pick(w, 9);

  const bundle = {
    worldName,
    displayName: pick(w, 7) || worldName,
    tagline: pick(w, 8),
    voice: settingAndTone,
    settingAndTone,
    structuralObjective: {
      thematic: pick(w, 11),
      climaxType: extractClimaxType(pick(w, 12)),
      climaxTypeRaw: pick(w, 12)
    },
    worldBible: {
      geography: pick(w, 15),
      magicTechRules: pick(w, 16),
      factions: pick(w, 17),
      recentHistory: pick(w, 18),
      currentCrisis: pick(w, 19),
      themes: pick(w, 20)
    },
    worldConstraints: pick(w, 16),  // magic/tech rules drive the "no iPhones" constraint
    adaptationRules: pick(w, 22),
    pacingBudget: {
      // Plan defaults; raw text preserved for prompt context.
      targetBeatCount: 6,
      climaxByBeat: 6,
      tokensPerBeat: 1000,
      raw: pick(w, 13),
      tokensRaw: pick(w, 36)
    },
    characters: extractCharacters(workbook.sheet3),
    openingBeat: {
      title: pick(w, 24),
      setting: pick(w, 25),
      prose: pick(w, 26),
      // Opening beat coordinates are authored. Each opening choice carries a
      // (selfOther, assertYield) target on the 2x2 matrix. The three coords
      // here span 3 distinct quadrants and use 0.10-step values.
      choices: [
        { label: 'A', text: pick(w, 27), selfOther: 0.4, assertYield: 0.4 },
        { label: 'B', text: pick(w, 28), selfOther: -0.4, assertYield: 0.5 },
        { label: 'C', text: pick(w, 29), selfOther: -0.6, assertYield: -0.4 }
      ]
    },
    playerStartingState: {
      location: pick(w, 31),
      knowledgeText: pick(w, 32),
      inventory: parseInventory(pick(w, 33)),
      condition: pick(w, 34) || 'baseline'
    },
    sourceXlsxMtime: null  // filled by caller
  };

  return bundle;
}

// ---------- io ----------

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function atomicWriteJson(targetPath, obj) {
  ensureDir(path.dirname(targetPath));
  const tmp = `${targetPath}.tmp`;
  const data = JSON.stringify(obj, null, 2);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, targetPath);
}

function shouldSkip(xlsxPath, outPath, force) {
  if (force) return false;
  if (!fs.existsSync(outPath)) return false;
  const xlsxMtime = fs.statSync(xlsxPath).mtimeMs;
  const outMtime = fs.statSync(outPath).mtimeMs;
  return outMtime >= xlsxMtime;
}

// ---------- entrypoint ----------

function parseArgs(argv) {
  const args = { force: false };
  for (const a of argv.slice(2)) {
    if (a === '--force') args.force = true;
    else if (a.startsWith('--xlsx=')) args.xlsx = a.slice(7);
    else if (a.startsWith('--world=')) args.world = a.slice(8);
    else if (a.startsWith('--out=')) args.out = a.slice(6);
  }
  return args;
}

export function convertXlsxToBundle({ xlsxPath, worldName, outPath, force = false, silent = false } = {}) {
  xlsxPath = xlsxPath || DEFAULT_XLSX;
  worldName = worldName || DEFAULT_WORLD;
  outPath = outPath || path.join(WORLDS_DIR, worldName, 'world.json');

  if (!fs.existsSync(xlsxPath)) {
    throw new Error(`xlsx not found: ${xlsxPath}`);
  }

  if (shouldSkip(xlsxPath, outPath, force)) {
    if (!silent) console.log(`[xlsx-to-bundle] skip (up-to-date): ${outPath}`);
    return { skipped: true, outPath };
  }

  const wb = loadWorkbook(xlsxPath);
  const bundle = buildBundle(wb, worldName);
  bundle.sourceXlsxMtime = new Date(fs.statSync(xlsxPath).mtimeMs).toISOString();

  atomicWriteJson(outPath, bundle);
  if (!silent) console.log(`[xlsx-to-bundle] wrote ${outPath}`);
  return { skipped: false, outPath, bundle };
}

// CLI
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv);
  try {
    convertXlsxToBundle({
      xlsxPath: args.xlsx,
      worldName: args.world,
      outPath: args.out,
      force: args.force
    });
  } catch (err) {
    console.error('[xlsx-to-bundle] FAILED:', err.message);
    process.exit(1);
  }
}
