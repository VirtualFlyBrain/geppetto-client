/*
 * TermInfoModel builds a term's Geppetto model from its VFBquery term info in
 * the client; DirectTermInfo fetches and merges it. These tests replay a
 * capture from the live server (17 Sep 2026) - base model, then a template,
 * a class, an EM neuron, a dataset, a licence, a painted domain and an
 * unknown id, in that order - and check that what the client builds is what
 * the server's variable_fetched reply was, both as raw JSON and once merged
 * through the real ModelFactory.
 *
 * The full differential check over ~115 terms of every kind lives in
 * scripts/direct-terminfo (needs the network); this is the in-repo subset.
 */
const fs = require('fs');
const path = require('path');

const GEPPETTO = {};
window.GEPPETTO = GEPPETTO;
GEPPETTO.Resources = require('@geppettoengine/geppetto-core/Resources').default;
require('@geppettoengine/geppetto-client/pages/geppetto/GEPPETTO.Events').default(GEPPETTO);
const Manager = require('@geppettoengine/geppetto-client/common/Manager').default;
const ModelFactory = require('@geppettoengine/geppetto-core/ModelFactory').default(GEPPETTO);
const TermInfoModel = require('@geppettoengine/geppetto-client/common/TermInfoModel');
const DirectTermInfo = require('@geppettoengine/geppetto-client/common/DirectTermInfo').default;

GEPPETTO.ModelFactory = ModelFactory;
GEPPETTO.Utility = { extractMethodsFromObject: () => [] };
const events = [];
GEPPETTO.trigger = (evt, payload) => events.push([evt, payload]);
GEPPETTO.Manager = new Manager();
GEPPETTO.MessageSocket = { send: jest.fn(() => 'req-1') };
GEPPETTO.CommandController = { log: () => null, createTags: () => null };
GEPPETTO.DirectTermInfo = new DirectTermInfo(GEPPETTO);
console.warn = () => null;
/*
 * A failed fetch is retried before anything falls back to the server. The
 * tests want the retries, not the waiting between them.
 */
window.VFB_FETCH_BACKOFF_MS = [0, 0, 0];
console.time = () => null;
console.timeEnd = () => null;

const res = f => path.join(__dirname, 'resources', 'direct-terminfo', f);
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const base = () => readJson(path.join(__dirname, 'resources', 'direct-geometry', 'base_model.json'));
const order = readJson(res('order.json'));
const termInfo = id => readJson(res(id + '/term_info.json'));
const serverReply = id => readJson(res(id + '/variable_fetched.json'));

/*
 * Gson writes the slices JSON with HTML-safe escapes and Java's mdToHtml
 * doubles a backslash in a label (a server quirk the port does not copy).
 */
const normStr = s => s.replace(/\\u0027/g, "'").replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&').replace(/\\u003d/g, '=').replace(/\\\\/g, '\\');
const norm = v => typeof v === 'string' ? normStr(v) : Array.isArray(v) ? v.map(norm) : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)])) : v;

function freshModel () {
  ModelFactory.allPaths = [];
  ModelFactory.allPathsIndexing = [];
  window.Instances = [];
  events.length = 0;
  window.Project = { getId: () => 1 };
  return GEPPETTO.Manager.loadModel(base());
}

function typeAt (libId, typeId) {
  const lib = ModelFactory.geppettoModel.getLibraries().find(l => l.getId() === libId);
  return lib.getTypes().find(t => t.getId() === typeId);
}

test('the raw model built in the client is the server reply, term after term', () => {
  const shape = TermInfoModel.shapeOfRaw(base());
  for (const id of order) {
    const ours = TermInfoModel.termInfoToRawModel(termInfo(id), id, shape).rawModel;
    expect(norm(ours)).toEqual(norm(serverReply(id)));
  }
});

test('merging the client model gives the same objects as merging the server reply', () => {
  const snapshot = () => {
    const out = {};
    for (const id of order) {
      const v = ModelFactory.geppettoModel.getVariables().find(x => x.getId() === id);
      let instance = null;
      if (v) {
        // instances are made on demand, as VFB's loader does
        const inst = window.Instances.getInstance(id);
        instance = Object.keys(inst).filter(k => k.indexOf(id) === 0).sort();
      }
      out[id] = {
        variable: v ? JSON.parse(JSON.stringify(v.getWrappedObj())) : null,
        metadata: typeAt('vfbLibrary', id + '_metadata') ? JSON.parse(JSON.stringify(typeAt('vfbLibrary', id + '_metadata').getWrappedObj())) : null,
        instance: instance
      };
    }
    return out;
  };
  freshModel();
  for (const id of order) {
    GEPPETTO.Manager.addVariableToModel(serverReply(id));
  }
  const fromServer = norm(snapshot());

  freshModel();
  for (const id of order) {
    const shape = TermInfoModel.shapeOf(ModelFactory.geppettoModel);
    GEPPETTO.Manager.addVariableToModel(TermInfoModel.termInfoToRawModel(termInfo(id), id, shape).rawModel);
  }
  const fromClient = norm(snapshot());

  expect(fromClient).toEqual(fromServer);
  // and the merged term is usable the way VFB uses it
  expect(window.Instances.getInstance('VFB_jrmc2yzg.VFB_jrmc2yzg_obj').getType().getMetaType()).toBe('ImportType');
  const meta = window.Instances.getInstance('VFB_jrmc2yzg.VFB_jrmc2yzg_meta');
  expect(meta.getType().getId()).toBe('VFB_jrmc2yzg_metadata');
  expect(meta.getType().label.getInitialValue().value.html).toContain('<b>Dm8b_L (MaleCNS:544981)</b>');
  const slices = JSON.parse(window.Instances.getInstance('VFB_00101567.VFB_00101567_slices').getVariable().getInitialValue().value.data);
  expect(slices.subDomains[0]).toEqual(['0.5189161', '0.5189161', '1.0', 'LIP']);
  expect(slices.subDomains[1][0]).toBe('VFB_00101567');
  // an unknown id still gets a bare variable typed Orphan, as the server gave it
  expect(fromClient.no_such_id_xyz.variable.anonymousTypes[0].superType.length).toBe(1);
});

test('Manager.fetchVariables goes to the client for the term info datasource when enabled', async () => {
  freshModel();
  global.fetch = jest.fn(url => {
    const id = decodeURIComponent(url.split('id=')[1]);
    return Promise.resolve({ ok: true, json: () => Promise.resolve(termInfo(id)) });
  });
  delete window.location;
  window.location = { protocol: 'https:' };
  window.Model = {};

  GEPPETTO.DirectTermInfo.enabled = false;
  GEPPETTO.Manager.fetchVariables(['FBbt_00003676'], 'vfbqueryTermInfo', () => null);
  expect(GEPPETTO.MessageSocket.send).toHaveBeenCalledWith('fetch_variable', expect.objectContaining({ variableId: ['FBbt_00003676'], dataSourceId: 'vfbqueryTermInfo' }), expect.any(Function));
  expect(global.fetch).not.toHaveBeenCalled();

  GEPPETTO.MessageSocket.send.mockClear();
  GEPPETTO.DirectTermInfo.enabled = true;
  expect(GEPPETTO.DirectTermInfo.canFetch('vfbqueryTermInfo')).toBe(true);
  expect(GEPPETTO.DirectTermInfo.canFetch('neo4JDataSourceService')).toBe(false);
  await new Promise(resolve => GEPPETTO.Manager.fetchVariables('FBbt_00003676', 'vfbqueryTermInfo', resolve));
  expect(GEPPETTO.MessageSocket.send).not.toHaveBeenCalled();
  expect(global.fetch).toHaveBeenCalledWith('https://v3-cached.virtualflybrain.org/get_term_info?id=FBbt_00003676');
  expect(ModelFactory.geppettoModel.getVariables().some(x => x.getId() === 'FBbt_00003676')).toBe(true);
  expect(typeAt('vfbLibrary', 'FBbt_00003676_metadata')).toBeDefined();
  const report = events.find(e => e[0] === 'geppetto:direct_terminfo');
  expect(report[1]).toEqual(expect.objectContaining({ ok: true, id: 'FBbt_00003676' }));
  expect(events.some(e => e[0] === 'stop_spin_logo')).toBe(true);
});

test('a failed fetch falls back to the server for the ids not yet merged', async () => {
  freshModel();
  window.Model = {};
  let calls = 0;
  global.fetch = jest.fn(url => {
    calls++;
    if (calls === 1) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(termInfo('Cachero2010')) });
    }
    return Promise.resolve({ ok: false, status: 503 });
  });
  GEPPETTO.MessageSocket.send.mockClear();
  GEPPETTO.DirectTermInfo.enabled = true;
  const cb = () => null;
  GEPPETTO.Manager.fetchVariables(['Cachero2010', 'VFBlicense_CC_BY_4_0'], 'vfbqueryTermInfo', cb);
  await new Promise(r => setTimeout(r, 20));
  expect(ModelFactory.geppettoModel.getVariables().some(x => x.getId() === 'Cachero2010')).toBe(true);
  expect(GEPPETTO.MessageSocket.send).toHaveBeenCalledWith('fetch_variable', expect.objectContaining({ variableId: ['VFBlicense_CC_BY_4_0'] }), cb);
  expect(events.filter(e => e[0] === 'geppetto:direct_terminfo').map(e => e[1].ok)).toEqual([true, false]);
});

test('markdown and count helpers match the server', () => {
  expect(TermInfoModel.mdToHtml('[medulla](FBbt_00003748) and [x](VFB_00101567,VFB_00102107)'))
    .toBe('<a href="?id=FBbt_00003748" data-instancepath="FBbt_00003748">medulla</a> and <a href="?id=VFB_00102107" data-instancepath="VFB_00102107">x</a>');
  expect(TermInfoModel.mdToHtml('[FlyBase:FBrf0123](http://flybase.org/reports/FBrf0123)'))
    .toBe('<a href="http://flybase.org/reports/FBrf0123" target="_blank" title="FlyBase:FBrf0123"><i class="popup-icon-link gpt-fly"></i></a>');
  expect(TermInfoModel.mdToHtml('[a%5Bb%5D](X1)')).toBe('<a href="?id=X1" data-instancepath="X1">a[b]</a>');
  expect(TermInfoModel.relationshipsToHtml('89% [capable of](RO_1): [glutamate secretion](GO_1) ([FlyBase:FBrf0259490](http://flybase.org/reports/FBrf0259490)); [part of](BFO_1): [medulla](FBbt_00003748)'))
    .toBe('<ul class="terminfo-relationships"><li><a href="https://virtualflybrain.org/docs/concepts/confidence-value/" target="_blank" title="confidence value"><span class="badge badge-secondary" title="confidence value">89%</span></a> <a href="http://flybase.org/reports/FBrf0259490" target="_blank" title="FlyBase:FBrf0259490"><i class="popup-icon-link gpt-fly"></i></a> capable of: <a href="?id=GO_1" data-instancepath="GO_1">glutamate secretion</a></li><li>part of: <a href="?id=FBbt_00003748" data-instancepath="FBbt_00003748">medulla</a></li></ul>');
  expect(['999', '1k', '9k', '46k', '527k', '1M', '2B'].map((s, i) => TermInfoModel.formatCount([999, 1200, 9900, 46789, 527179, 1000000, 2000000000][i]))).toEqual(['999', '1k', '9k', '46k', '527k', '1M', '2B']);
});
