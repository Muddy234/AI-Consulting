// Model client: a thin wrapper around the Claude Agent SDK that the
// orchestrator can call as `await modelClient.call({ system, user })`
// and get back a parsed JSON object.
//
// In tests, swap with a mock client that returns canned outputs (see
// tools/test-objective-orchestrator.mjs).

import { query } from '@anthropic-ai/claude-agent-sdk';
import { MODEL } from './config.mjs';

export const defaultModelClient = {
  async call({ system, user }) {
    const options = {
      model: MODEL,
      maxTurns: 1,
      systemPrompt: system,
      stderr: line => console.error('[claude-cli stderr]', line)
    };
    let resultText = '';
    let isError = false;
    let errorDetail = null;
    for await (const msg of query({ prompt: user, options })) {
      if (msg.type === 'result') {
        if (msg.subtype === 'success') resultText = msg.result || '';
        else { isError = true; errorDetail = { subtype: msg.subtype, errors: msg.errors }; }
      }
    }
    if (isError) {
      const e = new Error(`Agent SDK error: ${JSON.stringify(errorDetail)}`);
      e.detail = errorDetail;
      throw e;
    }
    return extractJson(resultText);
  }
};

/**
 * Pull the first balanced JSON object out of a text blob, tolerating
 * wrapping prose / code fences. Throws if no parseable object is found.
 */
export function extractJson(text) {
  if (typeof text !== 'string') throw new Error('extractJson requires a string');
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const start = trimmed.indexOf('{');
  if (start < 0) throw new Error('No JSON object in model output');
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(trimmed.slice(start, i + 1));
    }
  }
  throw new Error('Unbalanced JSON in model output');
}
