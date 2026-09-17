// Differential check: does the client-side producer build the same resolved
// type the live server sends over the websocket?
//   node scripts/direct-geometry/compare.mjs <captures dir>
// <captures dir>/<id>/variable_fetched.json           (server reply to fetch_variable)
// <captures dir>/<id>/import_type_resolved.<type>.json (server reply to resolve_import_type)
// <captures dir>/_project/geppetto_model_loaded.json   (base model, for the Visual type ref)
import fs from 'fs';
import path from 'path';
import { objToRawType, swcToRawType, interpreterKind, fetchUrl } from '../../geppetto-client/js/common/DirectGeometry.js';

const dir = process.argv[2];
const base = JSON.parse(fs.readFileSync(path.join(dir, '_project/geppetto_model_loaded.json'), 'utf8'));
let visualRef = null;
base.libraries.forEach((l, i) => (l.types || []).forEach((t, j) => { if (t.id === 'Visual' && t.eClass === 'VisualType') visualRef = `//@libraries.${i}/@types.${j}`; }));
let failures = 0, checked = 0;
const near = (a, b) => a === b || Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
function diffCylinders (ours, theirs, label) {
  if (ours.length !== theirs.length) { console.log(`FAIL ${label}: ${ours.length} segments vs server ${theirs.length}`); return false; }
  for (let i = 0; i < ours.length; i++) {
    const a = ours[i], b = theirs[i];
    if (a.id !== b.id || a.name !== b.name || a.types[0].$ref !== b.types[0].$ref || a.initialValues[0].key !== b.initialValues[0].key) { console.log(`FAIL ${label}: variable ${i} header differs`, a.id, b.id); return false; }
    const va = a.initialValues[0].value, vb = b.initialValues[0].value;
    if (va.eClass !== vb.eClass) { console.log(`FAIL ${label}: ${a.id} is ${va.eClass} vs server ${vb.eClass}`); return false; }
    const scalars = va.eClass === 'Sphere' ? ['radius'] : ['bottomRadius', 'topRadius', 'height'];
    const points = va.eClass === 'Sphere' ? ['position'] : ['position', 'distal'];
    for (const k of scalars) if (!near(va[k], vb[k])) { console.log(`FAIL ${label}: ${a.id}.${k} ${va[k]} vs ${vb[k]}`); return false; }
    for (const p of points) for (const k of ['x', 'y', 'z']) if (!near(va[p][k], vb[p][k])) { console.log(`FAIL ${label}: ${a.id}.${p}.${k} ${va[p][k]} vs ${vb[p][k]}`); return false; }
  }
  return true;
}
for (const id of fs.readdirSync(dir)) {
  if (id.startsWith('_')) continue;
  const fetched = JSON.parse(fs.readFileSync(path.join(dir, id, 'variable_fetched.json'), 'utf8'));
  for (const lib of fetched.libraries) for (const t of (lib.types || [])) {
    if (t.synched || t.eClass !== 'ImportType') continue;
    const kind = interpreterKind(t.modelInterpreterId);
    const capture = path.join(dir, id, `import_type_resolved.${t.id}.json`);
    if (!kind || !fs.existsSync(capture)) continue;
    checked++;
    const server = JSON.parse(fs.readFileSync(capture, 'utf8'));
    const theirs = server.libraries.flatMap(l => (l.types || []).filter(x => !x.synched))[0];
    const text = await (await fetch(fetchUrl(t.url, 'https:'))).text();
    const ours = kind === 'obj' ? objToRawType(t.id, text) : swcToRawType(t.id, text, visualRef);
    let ok;
    if (kind === 'obj') {
      ok = ours.eClass === theirs.eClass && ours.id === theirs.id && ours.name === theirs.name && ours.abstract === theirs.abstract
        && ours.defaultValue.eClass === theirs.defaultValue.eClass && ours.defaultValue.obj === theirs.defaultValue.obj;
      if (!ok) console.log(`FAIL ${id} obj: envelope or text differs (ours ${ours.defaultValue.obj.length} chars, server ${theirs.defaultValue.obj.length})`);
    } else {
      ok = ours.eClass === theirs.eClass && ours.id === theirs.id && ours.name === theirs.name && ours.abstract === theirs.abstract
        && diffCylinders(ours.variables, theirs.variables, `${id} swc`);
    }
    if (ok) console.log(`ok   ${id} ${kind}: identical to the server (${kind === 'obj' ? ours.defaultValue.obj.length + ' chars' : ours.variables.length + ' segments'})`);
    else failures++;
  }
}
console.log(`${checked} import types checked, ${failures} differ`);
process.exitCode = failures || checked === 0 ? 1 : 0;
