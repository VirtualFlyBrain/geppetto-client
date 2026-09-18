/*
 * QueryResultsModel turns a v3-cached run_query response into the
 * QueryResults the query builder renders; DirectQueries resolves a runnable
 * query to its GET, fetches it and hands back the same JSON string the
 * server used to send in return_query_results. Fixtures are captures from
 * the live server (17 Sep 2026): a class list with images, a tract list, a
 * class-connectivity table (first 30 rows), an empty table, a neuron-region
 * table, painted domains (plain-url thumbnails) and an image list.
 *
 * The full differential check (49 query runs over eight terms, up to
 * 25,000 rows) lives in scripts/direct-queries and needs the network.
 */
const fs = require('fs');
const path = require('path');

const GEPPETTO = {};
window.GEPPETTO = GEPPETTO;
GEPPETTO.Resources = require('@geppettoengine/geppetto-core/Resources').default;
require('@geppettoengine/geppetto-client/pages/geppetto/GEPPETTO.Events').default(GEPPETTO);
const Manager = require('@geppettoengine/geppetto-client/common/Manager').default;
const ModelFactory = require('@geppettoengine/geppetto-core/ModelFactory').default(GEPPETTO);
const QueryResultsModel = require('@geppettoengine/geppetto-client/common/QueryResultsModel');
const DirectQueries = require('@geppettoengine/geppetto-client/common/DirectQueries').default;
const TermInfoModel = require('@geppettoengine/geppetto-client/common/TermInfoModel');

GEPPETTO.ModelFactory = ModelFactory;
GEPPETTO.Utility = { extractMethodsFromObject: () => [] };
const events = [];
GEPPETTO.trigger = (evt, payload) => events.push([evt, payload]);
GEPPETTO.Manager = new Manager();
GEPPETTO.MessageSocket = { send: jest.fn(() => 'req-1') };
GEPPETTO.CommandController = { log: () => null, createTags: () => null };
GEPPETTO.DirectQueries = new DirectQueries(GEPPETTO);
// QueriesController is an AMD module
global.define = factory => {
  global.__amd = factory(require); 
};
require('@geppettoengine/geppetto-client/geppettoModel/QueriesController');
global.__amd(GEPPETTO);
console.warn = () => null;
console.time = () => null;
console.timeEnd = () => null;

const res = f => path.join(__dirname, 'resources', 'direct-queries', f);
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const order = readJson(res('order.json'));
const IMAGE_REF = 'geppettoModel#//@libraries.5/@types.10';
const capture = (id, q) => ({
  response: readJson(res(`${id}__${q}/run_query.json`)),
  server: readJson(res(`${id}__${q}/return_query_results.json`)).return_query_results,
  count: parseInt(readJson(res(`${id}__${q}/return_query_count.json`)).return_query_count, 10)
});

/*
 * An image reference now carries the template it is aligned to
 * ("VFB_00101384,VFB_00101485" where the server said "VFB_00101485"), so that
 * each slide of a multi-alignment carousel loads its own alignment instead of
 * all of them loading the first. That prefix is the one intended difference
 * from these captures -- and some were recaptured after the change and carry
 * it, so it is dropped from both sides; everything else must still match byte
 * for byte.
 */
const withoutTemplatePrefix = json => json.replace(/\\"reference\\":\\"VFB_\w+,/g, '\\"reference\\":\\"');

test('the table built in the client is the server reply, byte for byte', () => {
  for (const [id, q, name] of order) {
    const c = capture(id, q);
    const ours = QueryResultsModel.responseToQueryResults(c.response, { id, name }, IMAGE_REF);
    expect(withoutTemplatePrefix(JSON.stringify(ours))).toBe(withoutTemplatePrefix(c.server));
    expect(QueryResultsModel.responseToCount(c.response)).toBe(c.count);
  }
});

test('formatting details match the server', () => {
  // class connectivity: fixed nine columns, right-aligned counts, HALF_UP on the decimal representation
  const r = QueryResultsModel.responseToQueryResults({
    headers: { id: { order: -1 }, upstream_class: { order: 0 }, downstream_class: { order: 1 }, total_n: { order: 2 }, connected_n: { order: 3 }, percent_connected: { order: 4 }, pairwise_connections: { order: 5 }, total_weight: { order: 6 }, avg_weight: { order: 7 } },
    rows: [{ id: 'X', upstream_class: '[a](X)', downstream_class: '[b](Y)', total_n: 12, connected_n: 3, percent_connected: 25, pairwise_connections: 4, total_weight: 29, avg_weight: 1.45 }]
  }, { id: 'Y', name: 'b' }, IMAGE_REF);
  expect(r.header).toEqual(['ID', 'Upstream_Class', 'Downstream_Class', 'Total_N', 'Connected_N', 'Percent_Connected', 'Pairwise_Connections', 'Total_Weight', 'Avg_Weight']);
  expect(r.results[0].values).toEqual(['X', '[a](X)', '[b](Y)', '    12', '     3', ' 25.0%', '       4', '       29', '    1.5']);
  // a missing class column is synthesised from the queried term
  const one = QueryResultsModel.responseToQueryResults({
    headers: { id: { order: -1 }, upstream_class: { order: 0 }, total_n: { order: 2 }, connected_n: { order: 3 }, percent_connected: { order: 4 }, pairwise_connections: { order: 5 } },
    rows: [{ id: 'X', upstream_class: '[a](X)', total_n: 1, connected_n: 1, percent_connected: 100, pairwise_connections: 1 }]
  }, { id: 'Y', name: 'b' }, IMAGE_REF);
  expect(one.results[0].values[2]).toBe('[b](Y)');
  expect(one.results[0].values[7]).toBe('');
  // generic: numeric columns padded to a common width, tags re-delimited, lists piped, image markdown serialised
  const g = QueryResultsModel.responseToQueryResults({
    headers: { id: { order: -1 }, label: { order: 0 }, tags: { order: 1 }, weight: { order: 2 }, things: { order: 3 }, thumbnail: { order: 4 }, source: { order: 5 } },
    rows: [
      { id: 'A', label: '[a](A)', tags: 'Adult|Neuron', weight: 9, things: ['x', 'y'], thumbnail: "[![a b](https://h/i/00/11/VFB_t/thumbnail.png 'a b')](VFB_t,A)", source: 'dropped' },
      { id: 'B', label: '[b%5B1%5D](B)', tags: 'Adult', weight: 12.25, things: [], thumbnail: 'http://h/i/00/22/VFB_t/thumbnailT.png', source: 'dropped' }
    ]
  }, { id: 'Q', name: 'q' }, IMAGE_REF);
  expect(g.header).toEqual(['ID', 'Name', 'Gross_Type', 'Weight', 'things', 'Images']);
  expect(g.results[0].values.slice(0, 5)).toEqual(['A', '[a](A)', 'Adult; Neuron', ' 9   ', 'x|y']);
  expect(g.results[1].values.slice(0, 5)).toEqual(['B', '[b%5B1%5D](B)', 'Adult', '12.25', '']);
  const img0 = JSON.parse(g.results[0].values[5]);
  expect(img0.initialValues[0].value.elements[0].initialValue).toEqual({ eClass: 'Image', data: 'https://h/i/00/11/VFB_t/thumbnail.png', name: 'a b', reference: 'VFB_t,A', format: 'PNG' });
  const img1 = JSON.parse(g.results[1].values[5]);
  expect(img1.initialValues[0].value.elements[0].initialValue.data).toBe('https://h/i/00/22/VFB_t/thumbnailT.png');
  expect(img1.initialValues[0].value.elements[0].initialValue.reference).toBe('VFB_t,B');
  // empty and malformed envelopes give the bare object the server gave
  expect(QueryResultsModel.responseToQueryResults({ error: 'Missing required parameter: id' }, { id: 'Q' }, IMAGE_REF)).toEqual({ eClass: 'QueryResults' });
  expect(QueryResultsModel.responseToCount({ error: 'x' })).toBe(0);
});

test('a compound run intersects on ID in the order given', () => {
  const a = { eClass: 'QueryResults', header: ['ID', 'Name'], results: [{ values: ['1', 'a'] }, { values: ['2', 'b'] }, { values: ['3', 'c'] }] };
  const b = { eClass: 'QueryResults', header: ['ID', 'Name'], results: [{ values: ['3', 'c'] }, { values: ['1', 'a'] }] };
  expect(QueryResultsModel.combineResults([a, b]).results.map(r => r.values[0])).toEqual(['1', '3']);
  expect(QueryResultsModel.combineResults([a])).toBe(a);
  /*
   * Queries with different columns used to throw, which killed every compound
   * run from a URL. The first query's table is kept and intersected instead.
   */
  const narrow = { eClass: 'QueryResults', header: ['ID'], results: [{ values: ['2'] }] };
  const mixed = QueryResultsModel.combineResults([a, narrow]);
  expect(mixed.header).toEqual(['ID', 'Name']);
  expect(mixed.results.map(r => r.values)).toEqual([['2', 'b']]);
});

function loadModel () {
  ModelFactory.allPaths = [];
  ModelFactory.allPathsIndexing = [];
  window.Instances = [];
  events.length = 0;
  window.Project = { getId: () => 1 };
  GEPPETTO.Manager.loadModel(readJson(path.join(__dirname, 'resources', 'direct-geometry', 'base_model.json')));
  // the term the queries run on, built in the client so its references fit this model
  const termInfo = readJson(path.join(__dirname, 'resources', 'direct-terminfo', 'FBbt_00003676', 'term_info.json'));
  GEPPETTO.Manager.addVariableToModel(TermInfoModel.termInfoToRawModel(termInfo, 'FBbt_00003676', TermInfoModel.shapeOf(ModelFactory.geppettoModel)).rawModel);
  delete window.location;
  window.location = { protocol: 'https:' };
}

const queryDTO = (variableId, queryId) => ({
  target: ModelFactory.geppettoModel.getVariables().find(v => v.getId() === variableId),
  query: window.Model.getQueries().find(q => q.getId() === queryId)
});

test('a vfbquery query resolves to its GET on the model datasource', () => {
  loadModel();
  const dq = GEPPETTO.DirectQueries;
  const resolved = dq.resolveQuery('Model.NeuronsPartHere');
  expect(resolved).toEqual({ url: 'http://v3-cached.virtualflybrain.org/run_query', query: 'id=$ID&query_type=NeuronsPartHere', countQuery: 'id=$ID&query_type=NeuronsPartHere' });
  expect(dq.queryUrl(resolved, 'FBbt_00003676', false, 0, 10000)).toBe('https://v3-cached.virtualflybrain.org/run_query?id=FBbt_00003676&query_type=NeuronsPartHere');
  expect(dq.queryUrl(resolved, 'FBbt_00003676', false, 10000, 10000)).toBe('https://v3-cached.virtualflybrain.org/run_query?id=FBbt_00003676&query_type=NeuronsPartHere&offset=10000&limit=10000');
  expect(dq.resolveQuery('NoSuchQuery')).toBe(null);
  expect(dq.imageTypeRef()).toBe(IMAGE_REF);
  dq.enabled = true;
  expect(dq.canRun([queryDTO('FBbt_00003676', 'PartsOf')])).toBe(true);
  expect(dq.canRun([{ target: queryDTO('FBbt_00003676', 'PartsOf').target, query: { getPath: () => 'NoSuchQuery' } }])).toBe(false);
  dq.enabled = false;
  expect(dq.canRun([queryDTO('FBbt_00003676', 'PartsOf')])).toBe(false);
});

test('QueriesController runs and counts in the client when enabled, on the server otherwise', async () => {
  loadModel();
  const c = capture('FBbt_00003676', 'ListAllAvailableImages');
  global.fetch = jest.fn(url => Promise.resolve({ ok: true, json: () => Promise.resolve(c.response) }));
  const dto = [queryDTO('FBbt_00003676', 'ListAllAvailableImages')];

  GEPPETTO.DirectQueries.enabled = false;
  GEPPETTO.QueriesController.runQuery(dto, () => null, 0, 10000);
  expect(GEPPETTO.MessageSocket.send).toHaveBeenCalledWith('run_query', expect.objectContaining({ runnableQueries: [{ targetVariablePath: 'FBbt_00003676', queryPath: 'ListAllAvailableImages' }], offset: 0, limit: 10000 }), expect.any(Function));
  expect(global.fetch).not.toHaveBeenCalled();

  GEPPETTO.MessageSocket.send.mockClear();
  GEPPETTO.DirectQueries.enabled = true;
  const json = await new Promise(resolve => GEPPETTO.QueriesController.runQuery(dto, resolve, 0, 10000));
  expect(GEPPETTO.MessageSocket.send).not.toHaveBeenCalled();
  expect(global.fetch).toHaveBeenCalledWith('https://v3-cached.virtualflybrain.org/run_query?id=FBbt_00003676&query_type=ListAllAvailableImages');
  expect(json).toBe(c.server);
  const count = await new Promise(resolve => GEPPETTO.QueriesController.getQueriesCount(dto, resolve));
  expect(count).toBe(c.count);
  expect(events.filter(e => e[0] === 'geppetto:direct_query').map(e => e[1].kind + ':' + e[1].ok)).toEqual(['run:true', 'count:true']);
});

test('a failed fetch falls back to the server', async () => {
  loadModel();
  global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 502 }));
  GEPPETTO.MessageSocket.send.mockClear();
  GEPPETTO.DirectQueries.enabled = true;
  const dto = [queryDTO('FBbt_00003676', 'PartsOf')];
  const cb = () => null;
  GEPPETTO.QueriesController.runQuery(dto, cb, 0, 10000);
  await new Promise(r => setTimeout(r, 20));
  expect(GEPPETTO.MessageSocket.send).toHaveBeenCalledWith('run_query', expect.objectContaining({ runnableQueries: [{ targetVariablePath: 'FBbt_00003676', queryPath: 'PartsOf' }] }), expect.any(Function));
  GEPPETTO.QueriesController.getQueriesCount(dto, cb);
  await new Promise(r => setTimeout(r, 20));
  expect(GEPPETTO.MessageSocket.send).toHaveBeenCalledWith('run_query_count', expect.anything(), expect.any(Function));
  expect(events.filter(e => e[0] === 'geppetto:direct_query').map(e => e[1].ok)).toEqual([false, false]);
});
