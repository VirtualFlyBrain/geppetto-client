/*
 * DirectGeometry resolves OBJ/SWC import types in the client. These tests
 * drive it against the real ModelFactory and Manager with a base model and
 * a fetched term captured from the live VFB server, and check that what it
 * merges is what the server's import_type_resolved reply would have merged.
 *
 * Fixtures (captures from v2.virtualflybrain.org, 17 Sep 2026):
 *   base_model.json                       geppetto_model_loaded for vfb.json
 *   VFB_jrmc2yzg.variable_fetched.json    a neuron with obj + swc imports
 *   VFB_jrmc2yzg.server_obj.json          the server's reply, obj text shrunk
 *   VFB_jrmc2yzg.server_swc.json          the server's reply, first 4 segments
 *   VFB_jrmc2yzg.head.swc                 the first 5 samples of the SWC file
 */
const fs = require('fs');
const path = require('path');

const GEPPETTO = {};
window.GEPPETTO = GEPPETTO;
GEPPETTO.Resources = require('@geppettoengine/geppetto-core/Resources').default;
require('@geppettoengine/geppetto-client/pages/geppetto/GEPPETTO.Events').default(GEPPETTO);
const Manager = require('@geppettoengine/geppetto-client/common/Manager').default;
const ModelFactory = require('@geppettoengine/geppetto-core/ModelFactory').default(GEPPETTO);
const DirectGeometryModule = require('@geppettoengine/geppetto-client/common/DirectGeometry');
const DirectGeometry = DirectGeometryModule.default;

GEPPETTO.ModelFactory = ModelFactory;
GEPPETTO.Utility = { extractMethodsFromObject: () => [] };
const events = [];
GEPPETTO.trigger = (evt, payload) => events.push([evt, payload]);
GEPPETTO.Manager = new Manager();
GEPPETTO.MessageSocket = { send: jest.fn(() => 'req-1') };
GEPPETTO.CommandController = { log: () => null, createTags: () => null };
GEPPETTO.DirectGeometry = new DirectGeometry(GEPPETTO);
console.warn = () => null;
console.time = () => null;
console.timeEnd = () => null;

const res = f => path.join(__dirname, 'resources', 'direct-geometry', f);
const readJson = f => JSON.parse(fs.readFileSync(res(f), 'utf8'));
const unsynched = model => model.libraries.flatMap(l => (l.types || []).filter(t => !t.synched))[0];

function loadTerm () {
  ModelFactory.allPaths = [];
  ModelFactory.allPathsIndexing = [];
  window.Instances = [];
  events.length = 0;
  GEPPETTO.Manager.loadModel(readJson('base_model.json'));
  GEPPETTO.Manager.addVariableToModel(readJson('VFB_jrmc2yzg.variable_fetched.json'));
  window.Project = { getId: () => 1 };
}

function typeAt (libId, typeId) {
  const lib = ModelFactory.geppettoModel.getLibraries().find(l => l.getId() === libId);
  return lib.getTypes().find(t => t.getId() === typeId);
}

test('the fetched term carries OBJ and SWC import types the module recognises', () => {
  loadTerm();
  const obj = GEPPETTO.DirectGeometry.findImportType('Model.OBJLibrary.VFB_jrmc2yzg_obj');
  const swc = GEPPETTO.DirectGeometry.findImportType('SWCLibrary.VFB_jrmc2yzg_swc');
  expect(obj.type.getMetaType()).toBe('ImportType');
  expect(DirectGeometryModule.interpreterKind(obj.type.getModelInterpreterId())).toBe('obj');
  expect(DirectGeometryModule.interpreterKind(swc.type.getModelInterpreterId())).toBe('swc');
  expect(GEPPETTO.DirectGeometry.findImportType('vfbLibrary.VFB_jrmc2yzg_metadata')).toBe(null);
  expect(GEPPETTO.DirectGeometry.findImportType('nope.nothing')).toBe(null);
  expect(GEPPETTO.DirectGeometry.visualTypeRef()).toBe('//@libraries.5/@types.8');
});

test('the wrapped OBJ type merges exactly as the server reply does', () => {
  const serverReply = readJson('VFB_jrmc2yzg.server_obj.json');
  const objText = unsynched(serverReply).defaultValue.obj;

  loadTerm();
  GEPPETTO.Manager.swapResolvedType(serverReply);
  const fromServer = JSON.parse(JSON.stringify(typeAt('OBJLibrary', 'VFB_jrmc2yzg_obj').getWrappedObj()));

  loadTerm();
  const found = GEPPETTO.DirectGeometry.findImportType('OBJLibrary.VFB_jrmc2yzg_obj');
  const raw = DirectGeometryModule.wrapResolvedType(GEPPETTO.DirectGeometry.modelShape(), 'OBJLibrary',
    DirectGeometryModule.objToRawType(found.type.getId(), objText));
  expect(raw.libraries.length).toBe(serverReply.libraries.length);
  expect(raw.libraries.map(l => !!l.synched)).toEqual(serverReply.libraries.map(l => !!l.synched));
  GEPPETTO.Manager.swapResolvedType(raw);
  const fromClient = JSON.parse(JSON.stringify(typeAt('OBJLibrary', 'VFB_jrmc2yzg_obj').getWrappedObj()));

  expect(fromClient).toEqual(fromServer);
  expect(fromClient.eClass).toBe('VisualType');
  expect(fromClient.defaultValue.obj).toBe(objText);
  expect(window.Instances.getInstance('VFB_jrmc2yzg.VFB_jrmc2yzg_obj').getType().getMetaType()).toBe('VisualType');
});

test('the wrapped SWC type merges exactly as the server reply does', () => {
  const serverReply = readJson('VFB_jrmc2yzg.server_swc.json');
  const swcText = fs.readFileSync(res('VFB_jrmc2yzg.head.swc'), 'utf8');

  loadTerm();
  GEPPETTO.Manager.swapResolvedType(serverReply);
  const fromServer = JSON.parse(JSON.stringify(typeAt('SWCLibrary', 'VFB_jrmc2yzg_swc').getWrappedObj()));

  loadTerm();
  const raw = DirectGeometryModule.wrapResolvedType(GEPPETTO.DirectGeometry.modelShape(), 'SWCLibrary',
    DirectGeometryModule.swcToRawType('VFB_jrmc2yzg_swc', swcText, GEPPETTO.DirectGeometry.visualTypeRef()));
  GEPPETTO.Manager.swapResolvedType(raw);
  const fromClient = JSON.parse(JSON.stringify(typeAt('SWCLibrary', 'VFB_jrmc2yzg_swc').getWrappedObj()));

  expect(fromClient.variables.length).toBe(4);
  expect(fromClient.variables.map(v => v.id)).toEqual(fromServer.variables.map(v => v.id));
  fromClient.variables.forEach((v, i) => {
    const a = v.initialValues[0].value;
    const b = fromServer.variables[i].initialValues[0].value;
    expect(a.position).toEqual(b.position);
    expect(a.distal).toEqual(b.distal);
    expect(a.bottomRadius).toBeCloseTo(b.bottomRadius, 6);
    expect(a.topRadius).toBeCloseTo(b.topRadius, 6);
  });
  const inst = window.Instances.getInstance('VFB_jrmc2yzg.VFB_jrmc2yzg_swc');
  expect(inst.getType().getMetaType()).toBe('CompositeVisualType');
  expect(inst.getType().getVariables().length).toBe(4);
});

test('Manager.resolveImportType goes to the client when enabled, to the server otherwise', async () => {
  loadTerm();
  const serverReply = readJson('VFB_jrmc2yzg.server_obj.json');
  const objText = unsynched(serverReply).defaultValue.obj;
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve(objText) }));
  delete window.location;
  window.location = { protocol: 'https:' };

  GEPPETTO.DirectGeometry.enabled = false;
  GEPPETTO.Manager.resolveImportType('OBJLibrary.VFB_jrmc2yzg_obj', () => null);
  expect(GEPPETTO.MessageSocket.send).toHaveBeenCalledWith('resolve_import_type', expect.objectContaining({ paths: ['OBJLibrary.VFB_jrmc2yzg_obj'] }), expect.any(Function));
  expect(global.fetch).not.toHaveBeenCalled();

  GEPPETTO.MessageSocket.send.mockClear();
  GEPPETTO.DirectGeometry.enabled = true;
  const done = new Promise(resolve => GEPPETTO.Manager.resolveImportType('Model.OBJLibrary.VFB_jrmc2yzg_obj', resolve));
  await done;
  expect(GEPPETTO.MessageSocket.send).not.toHaveBeenCalled();
  expect(global.fetch).toHaveBeenCalledWith('https://www.virtualflybrain.org/data/VFB/i/jrmc/2yzg/VFB_00101567/volume_man.obj');
  expect(typeAt('OBJLibrary', 'VFB_jrmc2yzg_obj').getMetaType()).toBe('VisualType');
  const report = events.find(e => e[0] === 'geppetto:direct_geometry');
  expect(report[1].kind).toBe('obj');
  expect(report[1].ok).toBe(true);
  expect(events.some(e => e[0] === 'spin_logo')).toBe(true);
  expect(events.some(e => e[0] === 'stop_spin_logo')).toBe(true);
});

test('a failed fetch falls back to the server and reports it', async () => {
  loadTerm();
  global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 503 }));
  delete window.location;
  window.location = { protocol: 'https:' };
  GEPPETTO.MessageSocket.send.mockClear();
  GEPPETTO.DirectGeometry.enabled = true;
  const cb = () => null;
  GEPPETTO.Manager.resolveImportType('SWCLibrary.VFB_jrmc2yzg_swc', cb);
  await new Promise(r => setTimeout(r, 10));
  expect(GEPPETTO.MessageSocket.send).toHaveBeenCalledWith('resolve_import_type', expect.objectContaining({ paths: ['SWCLibrary.VFB_jrmc2yzg_swc'] }), cb);
  expect(typeAt('SWCLibrary', 'VFB_jrmc2yzg_swc').getMetaType()).toBe('ImportType');
  const report = events.find(e => e[0] === 'geppetto:direct_geometry');
  expect(report[1].ok).toBe(false);
});

test('mixed lists with an interpreter the client cannot stand in for go to the server whole', () => {
  loadTerm();
  GEPPETTO.MessageSocket.send.mockClear();
  GEPPETTO.DirectGeometry.enabled = true;
  expect(GEPPETTO.DirectGeometry.canResolve(['OBJLibrary.VFB_jrmc2yzg_obj', 'vfbLibrary.VFB_jrmc2yzg_metadata'])).toBe(false);
  expect(GEPPETTO.DirectGeometry.canResolve([])).toBe(false);
  expect(DirectGeometryModule.fetchUrl('http://x/y.obj', 'https:')).toBe('https://x/y.obj');
  expect(DirectGeometryModule.fetchUrl('http://x/y.obj', 'http:')).toBe('http://x/y.obj');
});

test('SWC parsing: comments, blanks, short lines, orphans, soma roots, non-positive radii', () => {
  const text = '# c\n\n1 1 0 0 0 1 -1\r\n2 0 1 0 0 2 1\nbad line\n3 0 2 0 0 0.0 2\n4 0 9 9 9 4 99\n5 0 3 0 0 -0.001 3\n6 0 7 7 7 0.5 -1\n';
  const t = DirectGeometryModule.swcToRawType('x_swc', text, '//@libraries.5/@types.8');
  expect(t.variables.map(v => v.id)).toEqual(['swcPoint1', 'swcPoint2', 'swcPoint3', 'swcPoint5']);
  const values = t.variables.map(v => v.initialValues[0].value);
  // a type-1 root is a soma sphere; a type-0 root (sample 6) draws nothing
  expect(values[0]).toEqual({ eClass: 'Sphere', radius: 1, position: { eClass: 'Point', x: 0, y: 0, z: 0 } });
  expect(values[1]).toEqual({ eClass: 'Cylinder', bottomRadius: 2, topRadius: 1, height: 0, position: { eClass: 'Point', x: 1, y: 0, z: 0 }, distal: { eClass: 'Point', x: 0, y: 0, z: 0 } });
  // zero and negative radii are drawn as 1, as the server does
  expect(values[2].bottomRadius).toBe(1);
  expect(values[2].topRadius).toBe(2);
  expect(values[3].bottomRadius).toBe(1);
  expect(values[3].topRadius).toBe(1);
});
