# Direct geometry: differential check against the live server

`geppetto-client/js/common/DirectGeometry.js` resolves OBJ and SWC import
types in the browser instead of asking the Geppetto server. These scripts
prove the client builds the same resolved type the server would have sent.

    pip install websockets
    python3 scripts/direct-geometry/capture.py VFB_00101567 VFB_jrmc2yzg ...
    node scripts/direct-geometry/compare.mjs captures

`capture.py` drives the live websocket like the browser does (load project,
fetch_variable, resolve_import_type for every obj/swc import) and saves the
raw replies under `captures/<id>/`. `compare.mjs` downloads each file, runs
the client producer on it and reports `ok`/`FAIL` per import type: OBJ text
must be byte-identical, SWC segments must match id, order, shape and
coordinates. Corpus used on 17 Sep 2026 (all identical): JRC2018U template,
a painted domain, MaleCNS, MANC, BANC, FlyWire, FAFB and L1EM neurons.

`__tests__/DirectGeometry.test.js` covers the merge into the real ModelFactory
with small fixtures cut from those captures.
