// Differential check: does the client-side query processor build the same
// return_query_results the live server sent?
//   node scripts/direct-queries/compare.mjs <captures dir>
// <captures dir>/<id>__<query>/run_query.json, return_query_results.json, return_query_count.json; _order.json
import fs from 'fs';
import path from 'path';
import { responseToQueryResults, responseToCount } from '../../geppetto-client/js/common/QueryResultsModel.js';

const dir = process.argv[2];
const order = JSON.parse(fs.readFileSync(path.join(dir, '_order.json'), 'utf8'));
const IMAGE_REF = 'geppettoModel#//@libraries.5/@types.10';
let ok = 0, bad = 0;
for (const [id, qid, name] of order) {
  const d = path.join(dir, `${id}__${qid}`);
  const response = JSON.parse(fs.readFileSync(path.join(d, 'run_query.json'), 'utf8'));
  const server = JSON.parse(JSON.parse(fs.readFileSync(path.join(d, 'return_query_results.json'), 'utf8')).return_query_results);
  const serverCount = parseInt(JSON.parse(fs.readFileSync(path.join(d, 'return_query_count.json'), 'utf8')).return_query_count, 10);
  const built = responseToQueryResults(response, { id, name }, IMAGE_REF);
  const ours = { header: built.header || [], results: built.results || [] };
  server.header = server.header || []; server.results = server.results || [];
  const count = responseToCount(response);
  const problems = [];
  if (JSON.stringify(ours.header) !== JSON.stringify(server.header)) problems.push(`header ours ${JSON.stringify(ours.header)} vs ${JSON.stringify(server.header)}`);
  if (ours.results.length !== server.results.length) problems.push(`rows ${ours.results.length} vs ${server.results.length}`);
  const n = Math.min(ours.results.length, server.results.length);
  outer: for (let r = 0; r < n; r++) {
    const a = ours.results[r].values, b = server.results[r].values;
    if (a.length !== b.length) { problems.push(`row ${r}: ${a.length} cells vs ${b.length}`); break; }
    for (let c = 0; c < a.length; c++) {
      if (a[c] !== b[c]) { problems.push(`row ${r} col ${server.header[c]}: ours ${JSON.stringify(a[c]).slice(0, 160)} | server ${JSON.stringify(b[c]).slice(0, 160)}`); if (problems.length > 4) break outer; }
    }
  }
  if (count !== serverCount) problems.push(`count ${count} vs ${serverCount}`);
  if (problems.length === 0) { ok++; console.log(`ok   ${id} ${qid} (${ours.results.length} rows, ${ours.header.length} cols)`); }
  else { bad++; console.log(`FAIL ${id} ${qid}\n   ` + problems.join('\n   ')); }
}
console.log(`${ok} identical, ${bad} differ`);
process.exitCode = bad ? 1 : 0;
