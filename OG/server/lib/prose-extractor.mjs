// Streaming, JSON-aware extractor for narrative prose fields.
//
// The model emits a single JSON object whose interesting prose lives at:
//   narrativeResponse.resolutionProse        (string)
//   narrativeResponse.nextBeat.intro         (string)
//
// We don't have a full JSON tree until generation finishes, but we DO want to
// stream prose chars to the browser as they arrive. This module accepts raw
// text chunks via push() and invokes onDelta(text) whenever new characters of
// either tracked field have been produced. JSON string-escapes are decoded.
//
// We do NOT validate JSON; we only locate prose chars. If the model emits
// malformed JSON, downstream validation will catch it on the final result.

const TRACKED_KEYS = new Set(['resolutionProse', 'intro']);

export function makeProseExtractor(onDelta) {
  // Scanner state
  let inString = false;       // currently inside any "..." token
  let escape = false;         // previous char was '\'
  let stringIsKey = false;    // current "..." is a key name
  let stringIsValue = false;  // current "..." is a value
  let trackingValue = false;  // current value is for a tracked key (emit chars)
  let keyBuf = '';            // accumulating key name chars
  let lastKey = null;         // most recently closed key name
  let awaitingColon = false;  // saw key close, waiting for ':'
  let awaitingValue = false;  // saw ':', waiting for value start

  function push(chunk) {
    if (typeof chunk !== 'string' || chunk.length === 0) return;
    let out = '';

    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];

      // Inside any string
      if (inString) {
        if (escape) {
          escape = false;
          if (stringIsKey) keyBuf += unescapeChar(ch);
          else if (trackingValue) out += unescapeChar(ch);
          continue;
        }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') {
          // string closes
          inString = false;
          if (stringIsKey) {
            lastKey = keyBuf;
            keyBuf = '';
            stringIsKey = false;
            awaitingColon = true;
          } else if (stringIsValue) {
            stringIsValue = false;
            trackingValue = false;
            lastKey = null;
          }
          continue;
        }
        if (stringIsKey) keyBuf += ch;
        else if (trackingValue) out += ch;
        continue;
      }

      // Outside string
      if (ch === '"') {
        inString = true;
        if (awaitingValue) {
          awaitingValue = false;
          stringIsValue = true;
          trackingValue = TRACKED_KEYS.has(lastKey);
        } else {
          // Either a key or a stray string (e.g. inside an array). Treat as
          // potential key; lastKey will be overwritten without harm if it
          // turns out not to be followed by ':'.
          stringIsKey = true;
          keyBuf = '';
        }
        continue;
      }
      if (ch === ':') {
        if (awaitingColon) {
          awaitingColon = false;
          awaitingValue = true;
        }
        continue;
      }
      if (/\s/.test(ch)) continue;

      // Any non-whitespace token kills pending state:
      //  - between key-close and ':' nothing else may appear in valid JSON;
      //    in malformed JSON we just give up tracking that key.
      //  - after ':' a non-string token means the value isn't a string.
      if (awaitingColon) { awaitingColon = false; lastKey = null; }
      if (awaitingValue) { awaitingValue = false; lastKey = null; }
    }

    if (out.length > 0) onDelta(out);
  }

  return { push };
}

function unescapeChar(ch) {
  switch (ch) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case '"': return '"';
    case '\\': return '\\';
    case '/': return '/';
    case 'b': return '\b';
    case 'f': return '\f';
    // \uXXXX would need 4 hex chars to follow; skip for streaming preview.
    // The committed prose comes from JSON.parse on the validated result.
    case 'u': return '';
    default: return ch;
  }
}
