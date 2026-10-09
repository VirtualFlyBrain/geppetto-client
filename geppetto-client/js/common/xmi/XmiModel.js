import SCHEMA from './GeppettoModelSchema';

/**
 * Turn a Geppetto model XMI (VFB's vfb.xmi) into the model JSON the server
 * used to send as geppetto_model_loaded, so the client can boot from static
 * files.
 *
 * The server read the XMI with EMF and wrote it out with EMF JSON. This does
 * the same walk with the class table generated from geppettoModel.ecore
 * (GeppettoModelSchema.js): an XML attribute is a scalar or a reference
 * (space-separated "//@..." paths), a child element is a contained object
 * whose class is its xsi:type or the feature's declared type, and the
 * attributes the server always wrote (ids, names, booleans) get their
 * defaults. The server then added two things of its own, which are added
 * here too: Geppetto's common type library after the model's libraries, and
 * the "time" state variable that points into it.
 *
 * __tests__/XmiModel.test.js checks the result against a capture of what the
 * live server sent for the same vfb.xmi.
 */

var CLASSES = SCHEMA.classes;
var MAP_ENTRIES = {};
SCHEMA.mapEntries.forEach(function (name) {
  MAP_ENTRIES[name] = true;
});

var XSI = 'http://www.w3.org/2001/XMLSchema-instance';

var COMMON_TYPES = [
  ['ParameterType', 'Parameter', 'Parameter'],
  ['DynamicsType', 'Dynamics', 'Dynamics'],
  ['StateVariableType', 'StateVariable', 'State Variable'],
  ['HTMLType', 'HTML', 'HTML'],
  ['URLType', 'URL', 'URL'],
  ['TextType', 'Text', 'Text'],
  ['PointType', 'Point', 'Point'],
  ['ExpressionType', 'Expression', 'Expression'],
  ['VisualType', 'Visual', 'Visual'],
  ['PointerType', 'Pointer', 'Pointer'],
  ['ImageType', 'Image', 'Image'],
  ['ConnectionType', 'connection', 'Connection'],
  ['VisualType', 'particles', 'Particles'],
  ['JSONType', 'JSON', 'JSON'],
  ['SimpleArrayType', 'simplearray', 'Simple Array'],
  ['MetadataType', 'metadata', 'Metadata']
];
var STATE_VARIABLE_TYPE = 2; // index of StateVariable above

function localName (qualified) {
  var i = qualified.indexOf(':');
  return i < 0 ? qualified : qualified.substring(i + 1);
}

function scalar (type, text) {
  if (type === 'b') {
    return text === 'true';
  }
  if (type === 'i') {
    return parseInt(text, 10);
  }
  if (type === 'f') {
    return parseFloat(text);
  }
  return text;
}

function refs (text) {
  return text.split(/\s+/).filter(function (part) {
    return part.length > 0;
  }).map(function (path) {
    return { $ref: path };
  });
}

function convert (element, className) {
  var features = CLASSES[className];
  if (features === undefined) {
    throw new Error('vfb.xmi: unknown class ' + className + ' at <' + element.nodeName + '>');
  }
  var out = MAP_ENTRIES[className] ? {} : { eClass: className };

  for (var i = 0; i < element.attributes.length; i++) {
    var attr = element.attributes[i];
    var name = attr.name;
    if (name === 'xmlns' || name.indexOf('xmlns:') === 0 || name.indexOf('xmi:') === 0 || attr.namespaceURI === XSI) {
      continue;
    }
    var feature = features[name];
    if (feature === undefined) {
      throw new Error('vfb.xmi: ' + className + ' has no feature "' + name + '"');
    }
    if (feature.k === 'a') {
      out[name] = scalar(feature.t, attr.value);
    } else {
      var list = refs(attr.value);
      out[name] = feature.m ? list : list[0];
    }
  }

  for (var child = element.firstElementChild; child !== null; child = child.nextElementSibling) {
    var key = localName(child.nodeName);
    var contained = features[key];
    if (contained === undefined || contained.k !== 'c') {
      throw new Error('vfb.xmi: ' + className + ' cannot contain <' + key + '>');
    }
    var xsiType = child.getAttributeNS(XSI, 'type');
    var value = convert(child, xsiType ? localName(xsiType) : contained.t);
    if (contained.m) {
      (out[key] = out[key] || []).push(value);
    } else {
      out[key] = value;
    }
  }

  for (var f in features) {
    if (Object.prototype.hasOwnProperty.call(features, f) && features[f].d !== undefined && out[f] === undefined) {
      out[f] = features[f].d;
    }
  }
  return out;
}

/**
 * The model JSON for an XMI document's text.
 */
export function xmiToModel (xmiText) {
  var doc = new DOMParser().parseFromString(xmiText, 'application/xml');
  var root = doc.documentElement;
  if (!root || root.getElementsByTagName('parsererror').length > 0 || localName(root.nodeName) === 'parsererror') {
    throw new Error('vfb.xmi is not well-formed XML');
  }
  var model = convert(root, 'GeppettoModel');

  var libraries = model.libraries = model.libraries || [];
  var common = libraries.length;
  libraries.push({
    eClass: 'GeppettoLibrary',
    id: 'common',
    name: 'Geppetto Common Library',
    types: COMMON_TYPES.map(function (t) {
      return { eClass: t[0], id: t[1], name: t[2], abstract: false };
    })
  });

  var stateVariable = '//@libraries.' + common + '/@types.' + STATE_VARIABLE_TYPE;
  var variables = model.variables = model.variables || [];
  variables.push({
    eClass: 'Variable',
    id: 'time',
    name: 'time',
    static: false,
    types: [{ $ref: stateVariable }],
    initialValues: [{
      key: 'geppettoModel#' + stateVariable,
      value: { eClass: 'PhysicalQuantity', scalingFactor: 0, value: 0.0, unit: { eClass: 'Unit', unit: 's' } }
    }]
  });
  return model;
}

/**
 * The experiment state the server sent with a freshly loaded project: the
 * time variable recorded, nothing else.
 */
export function initialExperimentState (model, projectId, experimentId) {
  var common = model.libraries.length - 1;
  var time = model.variables.length - 1;
  return {
    eClass: 'ExperimentState',
    experimentId: experimentId,
    projectId: projectId,
    recordedVariables: [{
      eClass: 'VariableValue',
      pointer: {
        eClass: 'Pointer',
        path: 'time(StateVariable)',
        elements: [{
          eClass: 'PointerElement',
          index: -1,
          variable: { $ref: 'geppettoModel#//@variables.' + time },
          type: { $ref: 'geppettoModel#//@libraries.' + common + '/@types.' + STATE_VARIABLE_TYPE }
        }]
      }
    }]
  };
}
