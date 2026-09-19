import { createObjParser } from './DirectGeometry';

/**
 * Parse OBJ streams off the main thread, in a small pool of workers.
 *
 * The parse itself was never the slow part in wall-clock terms -- it is that
 * it runs on the main thread, so a page loading several meshes stops
 * responding while they are read. Clicks land on nothing, tabs do not open,
 * and the app looks hung even though it is working. Moving the parse to a
 * worker gives that time back to the UI.
 *
 * A pool rather than a worker per mesh: the meshes are the reason this
 * matters, and they are large. One worker per mesh would let a page with nine
 * of them hold nine full buffers at once, which is how a tab runs out of
 * memory. Two or three parse in parallel and the rest queue, which is enough
 * to keep the main thread free without that risk.
 *
 * Off unless window.VFB_OBJ_WORKERS says otherwise, and every failure falls
 * back to parsing inline, so the worst case is exactly today's behaviour.
 */

/* Small: these are memory-heavy, and the win is being off the main thread. */
export var POOL_SIZE = 2;

function poolSize () {
  var configured = (typeof window !== 'undefined') ? window.VFB_OBJ_WORKERS : undefined;
  if (configured === true) {
    return POOL_SIZE;
  }
  return (typeof configured === 'number' && configured > 0) ? configured : 0;
}

/** Whether parsing should be attempted in a worker at all. */
export function enabled () {
  return poolSize() > 0
    && (typeof Worker !== 'undefined')
    && (typeof Blob !== 'undefined')
    && (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function');
}

/*
 * The worker's whole source. Inlined as a blob rather than served as a file
 * because the client is bundled and the page's origin is not where the data
 * comes from -- a blob worker is same-origin with the page and needs no build
 * step or CSP host of its own.
 *
 * It fetches and parses; it deliberately knows nothing about retries or host
 * spreading, which stay on the main thread where the session's state lives.
 * The URL it is given has already been through spreadUrl.
 */
/*
 * The worker's whole source. The parser is shipped as the *same* function the
 * main thread uses, serialised with toString, so the two can never drift: a
 * mesh parsed in a worker is parsed by identical code. createObjParser
 * declares its own helpers, so it has no free variables and survives
 * minification, which a function referencing module-scope helpers would not.
 *
 * Inlined as a blob rather than served as a file because the client is bundled
 * and the data comes from a different origin than the page -- a blob worker is
 * same-origin with the page and needs no build step or CSP host of its own.
 *
 * It fetches and parses; it deliberately knows nothing about retries or host
 * spreading, which stay on the main thread where the session state lives. The
 * URL it is handed has already been through spreadUrl.
 */
function workerSource () {
  return [
    'var createObjParser = ' + createObjParser.toString() + ';',
    'self.onmessage = function (e) {',
    '  var url = e.data.url;',
    '  fetch(url).then(function (response) {',
    '    if (!response.ok) {',
    '      throw new Error("HTTP " + response.status + " fetching " + url);',
    '    }',
    '    var parser = createObjParser();',
    '    var decoder = new TextDecoder("utf-8");',
    '    var reader = response.body.getReader();',
    '    var step = function () {',
    '      return reader.read().then(function (result) {',
    '        if (result.done) {',
    '          parser.push(decoder.decode());',
    '          return parser.finish();',
    '        }',
    '        parser.push(decoder.decode(result.value, { stream: true }));',
    '        return step();',
    '      });',
    '    };',
    '    return step();',
    '  }).then(function (geometry) {',
    /*
     * subarray views share the parser's oversized buffer; copy to exact sizes
     * first, because a transfer moves the whole buffer, slack included.
     */
    '    var positions = new Float32Array(geometry.positions);',
    '    var indices = new Uint32Array(geometry.indices);',
    '    var normals = geometry.normals === null ? null : new Float32Array(geometry.normals);',
    '    var moved = [positions.buffer, indices.buffer];',
    '    if (normals !== null) { moved.push(normals.buffer); }',
    '    self.postMessage({',
    '      ok: true,',
    '      positions: positions,',
    '      indices: indices,',
    '      normals: normals,',
    '      vertexCount: geometry.vertexCount,',
    '      faceCount: geometry.faceCount',
    '    }, moved);',
    '  }).catch(function (err) {',
    '    self.postMessage({ ok: false, message: String(err && err.message ? err.message : err) });',
    '  });',
    '};'
  ].join('\n');
}

var blobUrl;

function sharedBlobUrl () {
  if (blobUrl === undefined) {
    blobUrl = URL.createObjectURL(new Blob([workerSource()], { type: 'application/javascript' }));
  }
  return blobUrl;
}

var idle = [];
var busy = 0;
var waiting = [];

function release (worker) {
  busy--;
  idle.push(worker);
  if (waiting.length > 0) {
    waiting.shift()();
  }
}

function takeWorker () {
  return new Promise(function (resolve, reject) {
    var start = function () {
      busy++;
      if (idle.length > 0) {
        resolve(idle.pop());
        return;
      }
      try {
        resolve(new Worker(sharedBlobUrl()));
      } catch (err) {
        busy--;
        reject(err);
      }
    };
    if (busy < poolSize()) {
      start();
    } else {
      waiting.push(start);
    }
  });
}

/** For tests, and for a page that wants to start over. */
export function resetPool () {
  idle.forEach(function (worker) {
    try {
      worker.terminate(); 
    } catch (ignore) { /* nothing useful to do */ }
  });
  idle = [];
  busy = 0;
  waiting = [];
  blobUrl = undefined;
}

/**
 * Fetch and parse an OBJ in a worker.
 *
 * @param url - already spread to this session's host by the caller
 * @returns a promise for {positions, indices, vertexCount, faceCount};
 *          rejects so the caller can parse inline instead.
 */
export function parseObjInWorker (url) {
  return takeWorker().then(function (worker) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var done = function (fn, value) {
        if (settled) {
          return;
        }
        settled = true;
        worker.onmessage = null;
        worker.onerror = null;
        release(worker);
        fn(value);
      };
      worker.onmessage = function (e) {
        if (e.data && e.data.ok) {
          done(resolve, {
            positions: e.data.positions,
            indices: e.data.indices,
            normals: e.data.normals,
            vertexCount: e.data.vertexCount,
            faceCount: e.data.faceCount
          });
        } else {
          done(reject, new Error((e.data && e.data.message) ? e.data.message : 'worker parse failed'));
        }
      };
      worker.onerror = function (e) {
        /*
         * A worker that errored is not reused: it may be part-way through a
         * parse, and a fresh one costs little next to a mesh.
         */
        settled = true;
        try {
          worker.terminate(); 
        } catch (ignore) { /* already gone */ }
        busy--;
        if (waiting.length > 0) {
          waiting.shift()();
        }
        reject(new Error((e && e.message) ? e.message : 'worker failed to start'));
      };
      worker.postMessage({ url: url });
    });
  });
}
