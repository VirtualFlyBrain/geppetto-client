/**
 * Resolve OBJ and SWC import types in the client, without the server.
 *
 * The server resolves an ImportType by downloading the file its url points
 * at, running a model interpreter over it, and sending the resulting type
 * back inside a full GeppettoModel where everything else is a `synched`
 * placeholder. For OBJ that type is a VisualType whose default value carries
 * the file's text verbatim; for SWC it is a CompositeVisualType with one
 * Cylinder-valued variable per sample that has a parent. Neither needs any
 * server state, so this module does the same work here: fetch the file,
 * build the same raw type, hand it to the same merge (Manager.swapResolvedType)
 * the server reply would have gone through. Nothing downstream can tell the
 * difference, and the mesh is now an ordinary cacheable HTTP resource.
 *
 * Type references are computed against the client's own model, so unlike
 * a server reply there is no second copy of the model to keep in step with.
 *
 * The functions that build raw types are pure and take plain data, so they
 * can be checked in node against payloads captured from the live server.
 */

/**
 * Build the raw VisualType the server would return for an OBJ import.
 *
 * @param id - the import type's id (e.g. VFB_00101567_obj)
 * @param objText - the OBJ file's text
 */
export function objToRawType (id, objText) {
  return {
    eClass: 'VisualType',
    id: id,
    name: id,
    abstract: false,
    defaultValue: { eClass: 'OBJ', obj: objText }
  };
}

/**
 * Parse SWC text into the samples the interpreter emits: every line with a
 * parent, in file order. Comment lines, blank lines and lines with fewer than
 * seven fields are skipped, as the server's interpreter skips them.
 *
 * @returns {byId, order} of {n, type, x, y, z, r, parent}; byId keyed by sample number
 */
export function parseSwc (swcText) {
  var byId = {};
  var order = [];
  var lines = swcText.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line === '' || line.charAt(0) === '#') {
      continue;
    }
    var f = line.split(/\s+/);
    if (f.length < 7) {
      continue;
    }
    var s = {
      n: parseInt(f[0], 10),
      type: parseInt(f[1], 10),
      x: parseFloat(f[2]),
      y: parseFloat(f[3]),
      z: parseFloat(f[4]),
      r: parseFloat(f[5]),
      parent: parseInt(f[6], 10)
    };
    byId[s.n] = s;
    order.push(s);
  }
  return { byId: byId, order: order };
}

/*
 * The server's interpreter draws a radius that is zero or negative (navis
 * writes 0.0 for unknown, FAFB exports -0.001) as 1.0.
 */
function swcRadius (r) {
  return r > 0 ? r : 1.0;
}

/**
 * Build the raw CompositeVisualType the server would return for an SWC import.
 *
 * Each sample with a parent becomes a variable `swcPoint<n>` of the model's
 * Visual type whose value is a Cylinder from the sample (position, bottom
 * radius) to its parent (distal, top radius), height 0. A root sample
 * (parent -1) of type 1, a soma, becomes a Sphere; other roots draw nothing.
 * This is exactly the server's swcModelInterpreter output, checked against
 * its replies for hemibrain, FlyWire, FAFB, MANC, BANC, MaleCNS and L1 files.
 *
 * @param id - the import type's id (e.g. VFB_jrmc2yzg_swc)
 * @param swcText - the SWC file's text
 * @param visualTypeRef - reference to the Visual type in the CLIENT model,
 *                        e.g. '//@libraries.5/@types.8'
 */
export function swcToRawType (id, swcText, visualTypeRef) {
  var swc = parseSwc(swcText);
  var variables = [];
  var segment = function (s, value) {
    return {
      eClass: 'Variable',
      id: 'swcPoint' + s.n,
      name: 'SWC Segment ' + s.n,
      static: false,
      types: [{ $ref: visualTypeRef }],
      initialValues: [{ key: 'geppettoModel#' + visualTypeRef, value: value }]
    };
  };
  for (var i = 0; i < swc.order.length; i++) {
    var s = swc.order[i];
    if (s.parent === -1) {
      if (s.type === 1) {
        variables.push(segment(s, {
          eClass: 'Sphere',
          radius: swcRadius(s.r),
          position: { eClass: 'Point', x: s.x, y: s.y, z: s.z }
        }));
      }
      continue;
    }
    var p = swc.byId[s.parent];
    if (p === undefined) {
      continue;
    }
    variables.push(segment(s, {
      eClass: 'Cylinder',
      bottomRadius: swcRadius(s.r),
      topRadius: swcRadius(p.r),
      height: 0.0,
      position: { eClass: 'Point', x: s.x, y: s.y, z: s.z },
      distal: { eClass: 'Point', x: p.x, y: p.y, z: p.z }
    }));
  }
  return {
    eClass: 'CompositeVisualType',
    id: id,
    name: id,
    abstract: false,
    variables: variables
  };
}

/**
 * Wrap a resolved raw type in the GeppettoModel envelope the server sends:
 * every library, variable, datasource and query is a synched placeholder
 * except the one library that holds the resolved type.
 *
 * @param modelShape - {id, name, libraries: [{id, name}], variableCount,
 *                      dataSourceCount, queryCount} describing the CLIENT model
 * @param libraryId - id of the library the type belongs to
 * @param rawType - the resolved raw type
 */
export function wrapResolvedType (modelShape, libraryId, rawType) {
  var synched = function (n) {
    var a = [];
    for (var i = 0; i < n; i++) {
      a.push({ synched: true });
    }
    return a;
  };
  var libraries = [];
  for (var i = 0; i < modelShape.libraries.length; i++) {
    var lib = modelShape.libraries[i];
    if (lib.id === libraryId) {
      libraries.push({ eClass: 'GeppettoLibrary', id: lib.id, name: lib.name, types: [rawType] });
    } else {
      libraries.push({ synched: true });
    }
  }
  return {
    eClass: 'GeppettoModel',
    id: modelShape.id,
    name: modelShape.name,
    variables: synched(modelShape.variableCount),
    libraries: libraries,
    dataSources: synched(modelShape.dataSourceCount),
    queries: synched(modelShape.queryCount)
  };
}

/**
 * Which model interpreters this module can stand in for, by the id the
 * ImportType carries.
 */
export function interpreterKind (modelInterpreterId) {
  if (modelInterpreterId === 'objModelInterpreterService' || modelInterpreterId === 'objModelInterpreter') {
    return 'obj';
  }
  if (modelInterpreterId === 'swcModelInterpreter' || modelInterpreterId === 'swcModelInterpreterService') {
    return 'swc';
  }
  return null;
}

/**
 * The url to fetch from the browser. Model urls are http:// (the server used
 * to fetch them); a page served over https cannot, so match the page.
 */
export function fetchUrl (url, pageProtocol) {
  if (pageProtocol === 'https:' && url.indexOf('http://') === 0) {
    return 'https://' + url.substring('http://'.length);
  }
  return url;
}

/**
 * The runtime half: resolves import types against the live client model.
 * Off unless the application turns it on (GEPPETTO.DirectGeometry.enabled).
 */
export default function DirectGeometry (GEPPETTO) {

  this.enabled = false;

  /**
   * Find an ImportType in the client model by its path (Model. prefix
   * optional), returning {library, type, libraryIndex} or null.
   */
  this.findImportType = function (path) {
    var p = path.replace(GEPPETTO.Resources.MODEL_PREFIX_CLIENT + '.', '');
    var parts = p.split('.');
    if (parts.length !== 2) {
      return null;
    }
    var libs = GEPPETTO.ModelFactory.geppettoModel.getLibraries();
    for (var i = 0; i < libs.length; i++) {
      if (libs[i].getId() === parts[0]) {
        var types = libs[i].getTypes();
        for (var j = 0; j < types.length; j++) {
          if (types[j].getId() === parts[1]) {
            if (types[j].getMetaType() !== GEPPETTO.Resources.IMPORT_TYPE) {
              return null;
            }
            return { library: libs[i], libraryIndex: i, type: types[j] };
          }
        }
      }
    }
    return null;
  };

  /**
   * Reference string for the Visual type in the client model, the type every
   * SWC segment variable has.
   */
  this.visualTypeRef = function () {
    var libs = GEPPETTO.ModelFactory.geppettoModel.getLibraries();
    for (var i = 0; i < libs.length; i++) {
      var types = libs[i].getTypes();
      for (var j = 0; j < types.length; j++) {
        if (types[j].getId() === 'Visual' && types[j].getMetaType() === GEPPETTO.Resources.VISUAL_TYPE_NODE) {
          return '//@libraries.' + i + '/@types.' + j;
        }
      }
    }
    return null;
  };

  this.modelShape = function () {
    var model = GEPPETTO.ModelFactory.geppettoModel;
    var raw = model.getWrappedObj();
    var libs = model.getLibraries();
    var shape = { id: raw.id, name: raw.name, libraries: [], variableCount: 0, dataSourceCount: 0, queryCount: 0 };
    for (var i = 0; i < libs.length; i++) {
      shape.libraries.push({ id: libs[i].getId(), name: libs[i].getName() });
    }
    shape.variableCount = (raw.variables || []).length;
    shape.dataSourceCount = (raw.dataSources || []).length;
    shape.queryCount = (raw.queries || []).length;
    return shape;
  };

  /**
   * Can every one of these paths be resolved here? Mixed lists go to the
   * server whole so the caller's single callback keeps its meaning.
   */
  this.canResolve = function (typePaths) {
    if (!this.enabled) {
      return false;
    }
    for (var i = 0; i < typePaths.length; i++) {
      var found = this.findImportType(typePaths[i]);
      if (found === null || interpreterKind(found.type.getModelInterpreterId()) === null) {
        return false;
      }
    }
    return typePaths.length > 0;
  };

  /**
   * Resolve the import types in place. Calls callback() once all are merged,
   * or fallback(paths) if anything failed so the caller can go to the server.
   */
  /*
   * VFB asks for the same import more than once while a term loads (the
   * loader and the viewer both resolve it). The second request used to be a
   * second download; now it waits for the first and shares its outcome.
   */
  var inFlight = {};

  this.resolve = function (typePaths, callback, fallback) {
    var that = this;
    var pending = typePaths.length;
    var failed = false;
    GEPPETTO.trigger('spin_logo');
    var done = function () {
      pending--;
      if (pending === 0) {
        GEPPETTO.trigger('stop_spin_logo');
        if (failed) {
          fallback(typePaths);
        } else if (callback !== undefined) {
          callback();
        }
      }
    };
    var one = function (path) {
      if (inFlight[path] !== undefined) {
        inFlight[path].push(function (ok) {
          if (!ok) {
            failed = true;
          }
          done();
        });
        return;
      }
      inFlight[path] = [];
      var settle = function (ok) {
        var waiters = inFlight[path];
        delete inFlight[path];
        if (!ok) {
          failed = true;
        }
        done();
        for (var w = 0; w < waiters.length; w++) {
          waiters[w](ok);
        }
      };
      var found = that.findImportType(path);
      var kind = interpreterKind(found.type.getModelInterpreterId());
      var url = fetchUrl(found.type.getUrl(), window.location.protocol);
      var startedAt = Date.now();
      var report = function (ok) {
        try {
          GEPPETTO.trigger('geppetto:direct_geometry', { kind: kind, ok: ok, ms: Date.now() - startedAt, path: path });
        } catch (ignore) {
          // reporting must never break resolution
        }
      };
      fetch(url).then(function (response) {
        if (!response.ok) {
          throw new Error('HTTP ' + response.status + ' fetching ' + url);
        }
        return response.text();
      }).then(function (text) {
        var rawType;
        if (kind === 'obj') {
          rawType = objToRawType(found.type.getId(), text);
        } else {
          var ref = that.visualTypeRef();
          if (ref === null) {
            throw new Error('no Visual type in the model to build SWC segments from');
          }
          rawType = swcToRawType(found.type.getId(), text, ref);
        }
        var rawModel = wrapResolvedType(that.modelShape(), found.library.getId(), rawType);
        GEPPETTO.Manager.swapResolvedType(rawModel);
        report(true);
        settle(true);
      }).catch(function (err) {
        console.error('DirectGeometry - could not resolve ' + path + ' in the client, asking the server: ' + (err && err.message ? err.message : err));
        report(false);
        settle(false);
      });
    };
    for (var i = 0; i < typePaths.length; i++) {
      one(typePaths[i]);
    }
  };
}
