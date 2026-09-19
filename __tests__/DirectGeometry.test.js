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
/*
 * A failed fetch is retried before anything falls back to the server. The
 * tests want the retries, not the waiting between them.
 */
window.VFB_FETCH_BACKOFF_MS = [0, 0, 0];
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

/*
 * An OBJ is parsed as it streams in, so the file never becomes one string: V8
 * cannot hold a string longer than 536,870,888 characters and VFB publishes
 * meshes well past that (APL_R's is 626MB). Kept indexed too, which is a
 * quarter of the memory OBJLoader's face-by-face expansion costs.
 */
const parseObj = (chunks) => {
  const parser = DirectGeometryModule.createObjParser();
  chunks.forEach(chunk => parser.push(chunk));
  return parser.finish();
};

test('OBJ parsing: vertices and faces, whatever the chunks land on', () => {
  const obj = '# a cube corner\nv 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 2 3\nf 1 2 4\n';
  const whole = parseObj([obj]);
  expect(whole.vertexCount).toBe(4);
  expect(whole.faceCount).toBe(2);
  expect(Array.from(whole.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  // OBJ counts from 1; the buffer counts from 0
  expect(Array.from(whole.indices)).toEqual([0, 1, 2, 0, 1, 3]);

  // Chunk boundaries fall wherever the network puts them, including mid-line
  // and mid-number, and the last line may arrive without its newline.
  for (let cut = 1; cut < obj.length; cut++) {
    const split = parseObj([obj.substring(0, cut), obj.substring(cut)]);
    expect(Array.from(split.positions)).toEqual(Array.from(whole.positions));
    expect(Array.from(split.indices)).toEqual(Array.from(whole.indices));
  }
  const noTrailingNewline = parseObj([obj.trim()]);
  expect(noTrailingNewline.faceCount).toBe(2);
});

test('OBJ parsing: face forms, polygons, negative indices, lines to ignore', () => {
  const obj = [
    'v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0',
    'vn 0 0 1', 'vt 0 0', 'g group', 'o object', 'usemtl red', 's off', '',
    'f 1/1/1 2/2/1 3/3/1',   // texture and normal indices are not geometry
    'f 1//1 3//1 4//1',
    'f 1 2 3 4',             // a quad is triangulated as a fan
    'f -4 -3 -2'             // counting back from the vertices seen so far
  ].join('\n');
  const g = parseObj([obj]);
  expect(g.vertexCount).toBe(4);
  expect(Array.from(g.indices)).toEqual([
    0, 1, 2,
    0, 2, 3,
    0, 1, 2, 0, 2, 3,
    0, 1, 2
  ]);
});

test('a parsed mesh is handed on as a VisualType, geometry in place of text', () => {
  const g = parseObj(['v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n']);
  const raw = DirectGeometryModule.objGeometryToRawType('VFB_x_obj', g);
  const asText = DirectGeometryModule.objToRawType('VFB_x_obj', 'v 0 0 0\n');
  expect(raw.eClass).toBe(asText.eClass);
  expect(raw.id).toBe('VFB_x_obj');
  expect(raw.defaultValue.eClass).toBe('OBJ');
  expect(raw.defaultValue.obj).toBe('');
  expect(Array.from(raw.defaultValue.objGeometry.indices)).toEqual([0, 1, 2]);
});

test('readObjStream reads the body a chunk at a time', async () => {
  // jsdom has neither, the browser has both.
  const util = require('util');
  global.TextDecoder = util.TextDecoder;
  const encoder = new util.TextEncoder();
  const chunks = ['v 0 0 0\nv 1 0 ', '0\nv 0 1 0\nf 1 2 3\n'].map(c => encoder.encode(c));
  let next = 0;
  const response = { body: { getReader: () => ({
    read: () => Promise.resolve(next < chunks.length ? { done: false, value: chunks[next++] } : { done: true })
  }) } };
  const g = await DirectGeometryModule.readObjStream(response);
  expect(g.vertexCount).toBe(3);
  expect(Array.from(g.indices)).toEqual([0, 1, 2]);
});

test('a vertex-only OBJ is a point cloud, not a failure', () => {
  // expression patterns publish volume.obj with vertices and no faces
  const g = parseObj(['# VFB point cloud\nv 1 2 3\nv 4 5 6\n']);
  expect(g.vertexCount).toBe(2);
  expect(g.faceCount).toBe(0);
  const raw = DirectGeometryModule.objGeometryToRawType('VFB_x0000001_obj', g);
  expect(Array.from(raw.defaultValue.objGeometry.positions)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(raw.defaultValue.objGeometry.indices.length).toBe(0);
});

test('a term the client built is not sent to the server, which never saw it', async () => {
  loadTerm();
  GEPPETTO.DirectTermInfo = { builtHere: { VFB_jrmc2yzg: true } };
  global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 404 }));
  delete window.location;
  window.location = { protocol: 'https:' };
  GEPPETTO.MessageSocket.send.mockClear();
  GEPPETTO.DirectGeometry.enabled = true;
  GEPPETTO.Manager.resolveImportType('SWCLibrary.VFB_jrmc2yzg_swc', () => null);
  await new Promise(r => setTimeout(r, 10));
  // asking would come back as "Couldn't find a type for the path ..."
  expect(GEPPETTO.MessageSocket.send).not.toHaveBeenCalled();
  delete GEPPETTO.DirectTermInfo;
});

/*
 * A single failure used to be the end of it: the client asked the server,
 * which for these does nothing cleverer than fetch the same URL again, and
 * for a term this client built cannot resolve it at all. Transient failures
 * are retried here instead, and what finally went wrong is reported.
 */
test('a transient failure is retried and recovers without the server', async () => {
  loadTerm();
  let calls = 0;
  global.fetch = jest.fn(() => {
    calls++;
    if (calls < 3) {
      return Promise.resolve({ ok: false, status: 503 });
    }
    return Promise.resolve({ ok: true, text: () => Promise.resolve('1 1 0 0 0 1 -1\n2 0 1 0 0 2 1\n') });
  });
  delete window.location;
  window.location = { protocol: 'https:' };
  GEPPETTO.MessageSocket.send.mockClear();
  events.length = 0;
  GEPPETTO.DirectGeometry.enabled = true;
  GEPPETTO.Manager.resolveImportType('SWCLibrary.VFB_jrmc2yzg_swc', () => null);
  await new Promise(r => setTimeout(r, 50));
  expect(calls).toBe(3);
  expect(GEPPETTO.MessageSocket.send).not.toHaveBeenCalled();
  const report = events.find(e => e[0] === 'geppetto:direct_geometry');
  expect(report[1].ok).toBe(true);
  expect(report[1].attempts).toBe(3);
});

test('a failure that survives the retries says why, and for which call', async () => {
  loadTerm();
  let calls = 0;
  global.fetch = jest.fn(() => {
    calls++;
    return Promise.resolve({ ok: false, status: 503 });
  });
  delete window.location;
  window.location = { protocol: 'https:' };
  events.length = 0;
  GEPPETTO.DirectGeometry.enabled = true;
  GEPPETTO.Manager.resolveImportType('SWCLibrary.VFB_jrmc2yzg_swc', () => null);
  await new Promise(r => setTimeout(r, 50));
  expect(calls).toBe(4);
  const report = events.find(e => e[0] === 'geppetto:direct_geometry');
  expect(report[1].ok).toBe(false);
  expect(report[1].reason).toBe('http503');
  expect(report[1].attempts).toBe(4);
  // the term the file belongs to, short enough for an event name
  expect(report[1].call).toBe('jrmc2yzg');
});

test('a 404 is not retried: it will not come good', async () => {
  loadTerm();
  let calls = 0;
  global.fetch = jest.fn(() => {
    calls++;
    return Promise.resolve({ ok: false, status: 404 });
  });
  delete window.location;
  window.location = { protocol: 'https:' };
  events.length = 0;
  GEPPETTO.DirectGeometry.enabled = true;
  GEPPETTO.Manager.resolveImportType('SWCLibrary.VFB_jrmc2yzg_swc', () => null);
  await new Promise(r => setTimeout(r, 50));
  expect(calls).toBe(1);
  const report = events.find(e => e[0] === 'geppetto:direct_geometry');
  expect(report[1].reason).toBe('http404');
});

/*
 * VFB's ingress is several Rancher hosts behind one round-robin name. Naming
 * them lets a session use one directly and spread the load; the cache is why
 * it is per session rather than per request.
 */
const RetryFetch = require('@geppettoengine/geppetto-client/common/RetryFetch');

test('data calls go to the published host until hosts are configured', () => {
  RetryFetch.resetHosts();
  delete window.VFB_DATA_HOSTS;
  const url = 'https://www.virtualflybrain.org/data/VFB/i/jrmc/2yzg/VFB_00101567/volume.swc';
  expect(RetryFetch.spreadUrl(url)).toBe(url);
});

test('a session picks one host and keeps it, and leaves other origins alone', () => {
  RetryFetch.resetHosts();
  window.VFB_DATA_HOSTS = 'buttermilk.inf.ed.ac.uk, parsley.inf.ed.ac.uk';
  const url = 'https://www.virtualflybrain.org/data/VFB/i/jrmc/2yzg/VFB_00101567/volume.swc';
  const first = RetryFetch.spreadUrl(url);
  expect(['buttermilk.inf.ed.ac.uk', 'parsley.inf.ed.ac.uk']).toContain(RetryFetch.hostOf(first));
  // same host for the rest of the session: these files are cached by URL
  for (let i = 0; i < 10; i++) {
    expect(RetryFetch.spreadUrl(url)).toBe(first);
  }
  // a query to the API is a different origin and is not spread
  const api = 'https://v3-cached.virtualflybrain.org/run_query?id=X';
  expect(RetryFetch.spreadUrl(api)).toBe(api);
  delete window.VFB_DATA_HOSTS;
});

test('a page served from the apex spreads too, and the apex is never marked down', async () => {
  RetryFetch.resetHosts();
  window.VFB_DATA_HOSTS = 'buttermilk.virtualflybrain.org';
  // no www: a page loaded on the apex builds its data URLs from that origin
  const url = 'https://virtualflybrain.org/data/VFB/i/jrmc/2yzg/VFB_00101567/volume.swc';
  expect(RetryFetch.hostOf(RetryFetch.spreadUrl(url))).toBe('buttermilk.virtualflybrain.org');

  // the node is certless/unreachable: it drops out, the apex serves instead
  const seen = [];
  global.fetch = jest.fn((target) => {
    seen.push(RetryFetch.hostOf(target));
    if (RetryFetch.hostOf(target) === 'buttermilk.virtualflybrain.org') {
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
  });
  await RetryFetch.fetchWithRetry(url);
  expect(seen[0]).toBe('buttermilk.virtualflybrain.org');
  expect(seen[1]).toBe('virtualflybrain.org');

  // a published origin must never be marked down: that would leave nothing to serve
  RetryFetch.markHostDown('virtualflybrain.org');
  RetryFetch.markHostDown('www.virtualflybrain.org');
  expect(RetryFetch.hostOf(RetryFetch.spreadUrl(url))).toBe('virtualflybrain.org');
  delete window.VFB_DATA_HOSTS;
});

test('a host that cannot be reached is dropped for the session', async () => {
  RetryFetch.resetHosts();
  window.VFB_DATA_HOSTS = 'buttermilk.inf.ed.ac.uk';
  const url = 'https://www.virtualflybrain.org/data/VFB/i/jrmc/2yzg/VFB_00101567/volume.swc';
  expect(RetryFetch.hostOf(RetryFetch.spreadUrl(url))).toBe('buttermilk.inf.ed.ac.uk');
  const seen = [];
  global.fetch = jest.fn((target) => {
    seen.push(RetryFetch.hostOf(target));
    if (RetryFetch.hostOf(target) === 'buttermilk.inf.ed.ac.uk') {
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
  });
  await RetryFetch.fetchWithRetry(url);
  expect(seen[0]).toBe('buttermilk.inf.ed.ac.uk');
  // nothing left to spread to, so it falls back to the published name
  expect(seen[1]).toBe('www.virtualflybrain.org');
  expect(RetryFetch.hostOf(RetryFetch.spreadUrl(url))).toBe('www.virtualflybrain.org');
  delete window.VFB_DATA_HOSTS;
});
