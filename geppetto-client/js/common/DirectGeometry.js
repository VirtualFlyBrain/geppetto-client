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

import { fetchWithRetry, failureReason, callTag } from './RetryFetch';

/**
 * V8 cannot hold a string longer than this many characters, so an OBJ bigger
 * than it can never be read with response.text() -- the fetch succeeds and the
 * read throws. VFB publishes meshes well past it (APL_R's is 626MB), which is
 * why the OBJ is parsed from the stream instead of from one string.
 */
export var MAX_OBJ_TEXT = 536870888;

function grownTo (array, needed) {
  if (needed <= array.length) {
    return array;
  }
  var size = array.length;
  while (size < needed) {
    size = size * 2;
  }
  var grown = new array.constructor(size);
  grown.set(array);
  return grown;
}

/*
 * One vertex index out of an OBJ face token: "12", "12/3", "12/3/4" and
 * "12//4" all mean vertex 12, and a negative index counts back from the
 * vertices seen so far (-1 is the last one).
 */
function faceVertex (token, vertexCount) {
  var slash = token.indexOf('/');
  var index = parseInt(slash === -1 ? token : token.substring(0, slash), 10);
  if (isNaN(index)) {
    return -1;
  }
  return index < 0 ? vertexCount + index : index - 1;
}

/**
 * A parser that takes an OBJ a chunk of text at a time and keeps only the
 * geometry, as an indexed mesh.
 *
 * Indexed is the point as much as streaming is: THREE.OBJLoader expands every
 * face into its own three vertices, so a mesh costs (faces x 9) floats however
 * it arrived. Kept indexed, the same mesh is (vertices x 3) floats plus
 * (faces x 3) indices -- for APL_R, ~260MB rather than ~1GB, before normals.
 *
 * Only v and f lines carry geometry here. vn and vt are ignored because the
 * viewer recomputes normals on every mesh it loads anyway, and VFB's meshes
 * (trimesh and ImageJ exports) carry neither. Faces with more than three
 * vertices are triangulated as a fan.
 */
export function createObjParser () {
  var positions = new Float32Array(1 << 16);
  var indices = new Uint32Array(1 << 16);
  var positionCount = 0;
  var indexCount = 0;
  var rest = '';

  var vertex = function (line) {
    var f = line.split(/\s+/);
    positions = grownTo(positions, positionCount + 3);
    positions[positionCount++] = parseFloat(f[1]);
    positions[positionCount++] = parseFloat(f[2]);
    positions[positionCount++] = parseFloat(f[3]);
  };

  var face = function (line) {
    var f = line.split(/\s+/);
    var vertexCount = positionCount / 3;
    var first = faceVertex(f[1], vertexCount);
    if (first < 0) {
      return;
    }
    for (var k = 3; k < f.length; k++) {
      var b = faceVertex(f[k - 1], vertexCount);
      var c = faceVertex(f[k], vertexCount);
      if (b < 0 || c < 0) {
        continue;
      }
      indices = grownTo(indices, indexCount + 3);
      indices[indexCount++] = first;
      indices[indexCount++] = b;
      indices[indexCount++] = c;
    }
  };

  var line = function (text) {
    if (text.length < 6) {
      return;
    }
    var kind = text.charCodeAt(0);
    if (text.charCodeAt(1) !== 32) {
      return;
    }
    if (kind === 118) {
      vertex(text);
    } else if (kind === 102) {
      face(text);
    }
  };

  return {
    /** Feed the next piece of the file; chunk boundaries may fall mid-line. */
    push: function (chunk) {
      var text = rest + chunk;
      var start = 0;
      var end = text.indexOf('\n');
      while (end !== -1) {
        line(text.substring(start, end));
        start = end + 1;
        end = text.indexOf('\n', start);
      }
      rest = text.substring(start);
    },
    /** No more text: flush the last line and hand back what was found. */
    finish: function () {
      if (rest.length > 0) {
        line(rest);
        rest = '';
      }
      return {
        positions: positions.subarray(0, positionCount),
        indices: indices.subarray(0, indexCount),
        vertexCount: positionCount / 3,
        faceCount: indexCount / 3
      };
    }
  };
}

/**
 * Build the raw VisualType for an OBJ that was parsed rather than read whole.
 * Same shape as objToRawType, with the geometry in place of the text: nothing
 * but the viewer reads either, and the viewer prefers the geometry.
 *
 * @param id - the import type's id (e.g. VFB_00101567_obj)
 * @param geometry - {positions, indices} from createObjParser().finish()
 */
export function objGeometryToRawType (id, geometry) {
  return {
    eClass: 'VisualType',
    id: id,
    name: id,
    abstract: false,
    defaultValue: {
      eClass: 'OBJ',
      obj: '',
      objGeometry: { positions: geometry.positions, indices: geometry.indices }
    }
  };
}

/**
 * Parse an OBJ response body as it arrives.
 *
 * @returns a promise for {positions, indices, vertexCount, faceCount}
 */
export function readObjStream (response) {
  var parser = createObjParser();
  var decoder = new TextDecoder('utf-8');
  var reader = response.body.getReader();
  var step = function () {
    return reader.read().then(function (result) {
      if (result.done) {
        parser.push(decoder.decode());
        return parser.finish();
      }
      parser.push(decoder.decode(result.value, { stream: true }));
      return step();
    });
  };
  return step();
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
    /*
     * The server can only resolve imports of terms it built itself. For one
     * this client built (VFB2 #502 phase 2) it answers "Couldn't find a type
     * for the path ...", so a failure here is the end of it: report it and
     * let the application decide what to show instead.
     */
    var serverKnows = function (paths) {
      var built = (GEPPETTO.DirectTermInfo !== undefined) ? GEPPETTO.DirectTermInfo.builtHere : undefined;
      if (built === undefined) {
        return true;
      }
      for (var i = 0; i < paths.length; i++) {
        var leaf = paths[i].split('.').pop();
        if (built[leaf.replace(/_(obj|swc)$/, '')] === true) {
          return false;
        }
      }
      return true;
    };
    GEPPETTO.trigger('spin_logo');
    var done = function () {
      pending--;
      if (pending === 0) {
        GEPPETTO.trigger('stop_spin_logo');
        if (failed && serverKnows(typePaths)) {
          fallback(typePaths);
        } else if (callback !== undefined && !failed) {
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
      var report = function (ok, failure, attempts) {
        try {
          GEPPETTO.trigger('geppetto:direct_geometry', {
            kind: kind,
            ok: ok,
            ms: Date.now() - startedAt,
            path: path,
            reason: ok ? undefined : ((failure && failure.reason) ? failure.reason : failureReason(failure)),
            attempts: attempts,
            call: callTag(url),
            midStream: ok ? undefined : (failure && failure.midStream === true)
          });
        } catch (ignore) {
          // reporting must never break resolution
        }
      };
      /*
       * An OBJ is parsed from the stream: the file never becomes one string,
       * so V8's string ceiling stops applying and the mesh is kept indexed
       * rather than expanded face by face. SWC is small and stays text.
       */
      var attemptsUsed = 1;
      /*
       * The body is read inside the retried call: a connection that drops
       * part-way through a 7 MB template used to surface as a failure after
       * one "successful" fetch and go straight to the server fallback. Now it
       * is retried from the next host like a failed request.
       */
      var consume = function (response) {
        if (kind === 'obj' && response.body !== undefined && response.body !== null
          && typeof response.body.getReader === 'function' && typeof TextDecoder === 'function') {
          return readObjStream(response).then(function (geometry) {
            if (geometry.vertexCount === 0) {
              throw new Error('no vertices parsed from ' + url);
            }
            /*
             * No faces is not a failure: an expression pattern's volume.obj
             * is a point cloud, vertices only, and the viewer draws it as
             * one. Only an empty file is a failure.
             */
            return objGeometryToRawType(found.type.getId(), geometry);
          });
        }
        return response.text().then(function (text) {
          if (kind === 'obj') {
            return objToRawType(found.type.getId(), text);
          }
          var ref = that.visualTypeRef();
          if (ref === null) {
            throw new Error('no Visual type in the model to build SWC segments from');
          }
          return swcToRawType(found.type.getId(), text, ref);
        });
      };
      fetchWithRetry(url, undefined, undefined, consume).then(function (result) {
        attemptsUsed = result.attempts;
        return result.value;
      }).then(function (rawType) {
        var rawModel = wrapResolvedType(that.modelShape(), found.library.getId(), rawType);
        GEPPETTO.Manager.swapResolvedType(rawModel);
        report(true, undefined, attemptsUsed);
        settle(true);
      }).catch(function (err) {
        console.error('DirectGeometry - could not resolve ' + path + ' after '
          + (err && err.attempts ? err.attempts : attemptsUsed) + ' attempt(s) ('
          + ((err && err.reason) ? err.reason : failureReason(err)) + '): ' + (err && err.message ? err.message : err));
        report(false, err, (err && err.attempts) ? err.attempts : attemptsUsed);
        settle(false);
      });
    };
    for (var i = 0; i < typePaths.length; i++) {
      one(typePaths[i]);
    }
  };
}
