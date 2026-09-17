// Differential check: does the client-side term info producer build the same
// variable_fetched reply the live server sent?
//   node scripts/direct-terminfo/compare.mjs <captures dir> [id]
// <captures dir>/_base_model.json, _order.json, <id>/term_info.json, <id>/variable_fetched.json
import fs from 'fs';
import path from 'path';
import { termInfoToRawModel, shapeOfRaw } from '../../geppetto-client/js/common/TermInfoModel.js';

const dir = process.argv[2];
const only = process.argv.slice(3).find(a => !a.startsWith('--'));
const base = JSON.parse(fs.readFileSync(path.join(dir, '_base_model.json'), 'utf8'));
const orderFile = path.join(dir, '_order.json');
const order = fs.existsSync(orderFile) ? JSON.parse(fs.readFileSync(orderFile, 'utf8'))
  : fs.readdirSync(dir).filter(d => !d.startsWith('_') && fs.existsSync(path.join(dir, d, 'variable_fetched.json')))
    .sort((a, b) => fs.statSync(path.join(dir, a, 'variable_fetched.json')).mtimeMs - fs.statSync(path.join(dir, b, 'variable_fetched.json')).mtimeMs);
const shape = shapeOfRaw(base);

function diff (a, b, p, out) {
  if (out.length > 12) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { out.push(`${p}: length ${a.length} vs ${b.length}`); }
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${p}[${i}]`, out);
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    for (const k of kb) if (!(k in a)) out.push(`${p}.${k}: missing in ours`);
    for (const k of ka) if (!(k in b)) out.push(`${p}.${k}: extra in ours`);
    for (const k of ka) if (k in b) diff(a[k], b[k], `${p}.${k}`, out);
    return;
  }
  if (a !== b) {
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    let i = 0; while (i < sa.length && i < sb.length && sa[i] === sb[i]) i++;
    out.push(`${p}: ours ${sa.slice(Math.max(0, i - 60), i + 80)} | server ${sb.slice(Math.max(0, i - 60), i + 80)}`);
  }
}
// Print a path relative to the reply with variable ids substituted for indexes where possible
let ok = 0, bad = 0, drift = 0;
const seen = new Set();
// Gson serialises the slices JSON with HTML-safe escapes; Java's mdToHtml
// double-quotes replacement text so a backslash in a label comes out doubled
// (a server bug the port does not reproduce). Normalise both before diffing.
const normStr = s => s.replace(/\\u0027/g, "'").replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&').replace(/\\u003d/g, '=').replace(/\\\\/g, '\\');
const norm = v => typeof v === 'string' ? normStr(v) : Array.isArray(v) ? v.map(norm) : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)])) : v;
for (const id of order) {
  if (seen.has(id)) { console.log(`skip ${id} (repeat fetch; the client never re-fetches)`); continue; }
  seen.add(id);
  const ti = JSON.parse(fs.readFileSync(path.join(dir, id, 'term_info.json'), 'utf8'));
  const server = norm(JSON.parse(fs.readFileSync(path.join(dir, id, 'variable_fetched.json'), 'utf8')));
  const shapeBefore = JSON.parse(JSON.stringify(shape));
  let ours;
  try { ours = termInfoToRawModel(ti, id, shape).rawModel; } catch (e) { bad++; console.log(`FAIL ${id}: producer threw ${e.message}`); continue; }
  if (only && id !== only) continue;
  const out = [];
  diff(norm(ours), server, '', out);
  if (out.length === 0) { ok++; console.log(`ok   ${id}`); continue; }
  /*
   * v3-cached does not always answer the same for the same id (query counts
   * computed lazily, synonyms/licence rows present or not, example order):
   * the capture's term_info.json may simply not be what the server got. With
   * --refetch, try fresh copies of the term info against the same model
   * state; if one reproduces the server reply the port is right and the
   * input drifted.
   */
  if (process.argv.includes('--refetch')) {
    let matched = false;
    for (let attempt = 0; attempt < 8 && !matched; attempt++) {
      const fresh = await (await fetch(`https://v3-cached.virtualflybrain.org/get_term_info?id=${encodeURIComponent(id)}`)).json();
      const trial = termInfoToRawModel(fresh, id, JSON.parse(JSON.stringify(shapeBefore))).rawModel;
      const o2 = []; diff(norm(trial), server, '', o2);
      if (o2.length === 0) matched = true;
    }
    if (matched) { drift++; console.log(`drift ${id}: identical with a re-fetched term info (v3-cached answered differently)`); continue; }
  }
  bad++; console.log(`FAIL ${id}\n   ` + out.join('\n   '));
}
console.log(`${ok} identical, ${drift} identical after re-fetch (input drift), ${bad} differ`);
process.exitCode = bad ? 1 : 0;
