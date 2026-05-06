import { readFileSync } from 'node:fs';
const path = process.argv[2];
const html = readFileSync(path, 'utf8');
const re = /<script[^>]*>([\s\S]*?)<\/script>/g;
let m, i = 0, bad = 0;
while ((m = re.exec(html)) !== null) {
  const code = m[1];
  try { new Function(code); }
  catch (e) { bad++; console.log('block', i, 'parse error:', e.message); }
  i++;
}
console.log('script blocks:', i, 'errors:', bad);
process.exit(bad === 0 ? 0 : 1);
