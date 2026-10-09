/*
 * ProjectLoader boots a project from static files: the descriptor, then the
 * XMI it names, then the same three steps the server's replies used to drive.
 */
import fs from 'fs';
import path from 'path';
import ProjectLoader from '../geppetto-client/js/common/ProjectLoader';

const resources = path.join(__dirname, 'resources', 'xmi-model');
const xmi = fs.readFileSync(path.join(resources, 'vfb.xmi'), 'utf8');
const server = JSON.parse(fs.readFileSync(path.join(resources, 'geppetto_model_loaded.json'), 'utf8'));
const descriptor = {
  id: 1,
  name: 'Virtual Fly Brain',
  activeExperimentId: 1,
  experiments: [{ id: 1, name: 'Virtual Fly Brain', status: 'COMPLETED', aspectConfigurations: [] }],
  geppettoModel: { id: 9, url: '/vfb.xmi', type: 'GEPPETTO_PROJECT' }
};

window.VFB_FETCH_BACKOFF_MS = [0, 0, 0];
console.time = () => null;
console.error = () => null;

let calls;
let events;
const GEPPETTO = {
  Resources: { PARSING_MODEL: 'parsing' },
  Events: { Show_spinner: 'spinner:show', Hide_spinner: 'spinner:hide' },
  trigger: (name, payload) => events.push([name, payload]),
  UserController: { setUserPrivileges: p => calls.push(['privileges', p]) },
  Manager: {
    loadProject: (project, persisted) => calls.push(['project', project, persisted]),
    loadModel: model => calls.push(['model', model]),
    loadExperiment: (id, state) => calls.push(['experiment', id, state])
  },
  ViewController: { resolveViews: () => calls.push(['views']) }
};

const serve = files => jest.fn(url => {
  const body = files[url];
  if (body === undefined) {
    return Promise.resolve({ ok: false, status: 404 });
  }
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(JSON.parse(body)),
    text: () => Promise.resolve(body)
  });
});

beforeEach(() => {
  calls = [];
  events = [];
  delete window.location;
  window.location = { protocol: 'https:' };
});

test('loads descriptor, model and experiment in the order the server sent them', async () => {
  global.fetch = serve({
    'https://v2.example.org/ctx/geppetto/build/vfb.json': JSON.stringify(descriptor),
    'https://v2.example.org/ctx/geppetto/build/vfb.xmi': xmi
  });
  const model = await new ProjectLoader(GEPPETTO).load('http://v2.example.org/ctx/geppetto/build/vfb.json');

  // http:// from the caller is fetched as https:// on an https page
  expect(global.fetch.mock.calls.map(c => c[0])).toEqual([
    'https://v2.example.org/ctx/geppetto/build/vfb.json',
    'https://v2.example.org/ctx/geppetto/build/vfb.xmi'
  ]);
  expect(calls.map(c => c[0])).toEqual(['privileges', 'project', 'model', 'experiment']);
  expect(calls[0][1].privileges).toEqual(['READ_PROJECT', 'DOWNLOAD']);
  const project = calls[1][1];
  expect(calls[1][2]).toBe(false);
  expect(project.id).not.toBe(1);
  expect(project.view).toEqual({ id: 1, viewStates: '{"views":{}}' });
  expect(calls[2][1]).toStrictEqual(server);
  expect(model).toBe(calls[2][1]);
  expect(calls[3][1]).toBe(1);
  expect(calls[3][2].projectId).toBe(project.id);
  expect(calls[3][2].recordedVariables[0].pointer.elements[0].type).toEqual({ $ref: 'geppettoModel#//@libraries.5/@types.2' });
});

test('a project with no active experiment resolves views instead', async () => {
  global.fetch = serve({
    'https://h/vfb.json': JSON.stringify(Object.assign({}, descriptor, { activeExperimentId: -1 })),
    'https://h/vfb.xmi': xmi
  });
  await new ProjectLoader(GEPPETTO).load('https://h/vfb.json');
  expect(calls.map(c => c[0])).toEqual(['privileges', 'project', 'model', 'views']);
});

test('a missing model is reported, and nothing is half-loaded', async () => {
  global.fetch = serve({ 'https://h/vfb.json': JSON.stringify(descriptor) });
  await expect(new ProjectLoader(GEPPETTO).load('https://h/vfb.json')).rejects.toBeDefined();
  expect(calls).toEqual([]);
  const failed = events.find(e => e[0] === 'geppetto:project_load_failed');
  expect(failed[1]).toMatchObject({ url: 'https://h/vfb.xmi', reason: 'http404' });
  expect(events.some(e => e[0] === 'spinner:hide')).toBe(true);
});
