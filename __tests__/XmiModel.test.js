import fs from 'fs';
import path from 'path';
import { xmiToModel, initialExperimentState } from '../geppetto-client/js/common/xmi/XmiModel';

const resources = path.join(__dirname, 'resources', 'xmi-model');
const read = name => fs.readFileSync(path.join(resources, name), 'utf8');

describe('XmiModel', () => {
  const server = JSON.parse(read('geppetto_model_loaded.json'));
  const built = xmiToModel(read('vfb.xmi'));

  it('builds the model the server sent for vfb.xmi', () => {
    expect(built).toStrictEqual(server);
  });

  it('builds the experiment state the server sent with it', () => {
    const state = JSON.parse(read('experiment_loaded.json'));
    expect(initialExperimentState(built, state.projectId, state.experimentId)).toEqual(state);
  });

  it('puts the common library after the model\'s own and points time at it', () => {
    const model = xmiToModel('<?xml version="1.0"?><gep:GeppettoModel xmi:version="2.0" '
      + 'xmlns:xmi="http://www.omg.org/XMI" xmlns:gep="g"><libraries id="a" name="A"/></gep:GeppettoModel>');
    expect(model.libraries.map(l => l.id)).toEqual(['a', 'common']);
    expect(model.variables[0].types).toEqual([{ $ref: '//@libraries.1/@types.2' }]);
  });

  it('refuses what it does not understand rather than guess', () => {
    expect(() => xmiToModel('<gep:GeppettoModel xmlns:gep="g" bogus="1"/>')).toThrow(/no feature "bogus"/);
    expect(() => xmiToModel('<gep:GeppettoModel xmlns:gep="g"><nope/></gep:GeppettoModel>')).toThrow(/cannot contain <nope>/);
    expect(() => xmiToModel('<not xml')).toThrow(/well-formed/);
  });
});
