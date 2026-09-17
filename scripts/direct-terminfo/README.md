# Direct term info: differential check against the live server

`geppetto-client/js/common/TermInfoModel.js` is the server's
`VFBProcessTermInfoVFBqueryJson` query processor ported to JavaScript;
`DirectTermInfo.js` fetches v3-cached/get_term_info and merges what it builds.
These scripts prove the client builds the same `variable_fetched` reply the
server would have sent.

    pip install websockets
    python3 scripts/direct-terminfo/capture.py corpus.json captures
    node scripts/direct-terminfo/compare.mjs captures [--refetch]

`corpus.json` is a list of `[group, id, label]`; put the template first, as a
real session would. `capture.py` drives the live websocket like the browser
does (load project, then fetch_variable for each id in order, saving the
reply and the term info the client would have fetched at the same moment).
`compare.mjs` replays the same order against a description of the client
model, builds each term with the JS producer and reports `ok`/`FAIL` with
the first differing paths.

v3-cached does not always answer the same for an id (query counts are
computed lazily, synonym/licence rows come and go, example order varies), so
a capture's term info may not be what the server got. `--refetch` retries a
failing id with fresh copies of the term info against the same model state
and reports `drift` if one reproduces the server reply.

Two deliberate differences are normalised before diffing: Gson's HTML-safe
escapes (`'` etc.) inside the slices JSON string, and the server's
doubling of a backslash inside a label (Java's `Matcher.quoteReplacement`
applied twice in `mdToHtml`), which the port does not reproduce.

Corpus used on 17 Sep 2026: 114 terms - all eight templates, painted
domains, neuropil and neuron classes, EM and LM neuron images, expression
patterns and images, splits, clones, clusters, datasets, publications,
licences, tracts, deprecated terms, genes, scRNAseq and NBLAST terms, and
an unknown id: 103 identical, 8 identical after re-fetch, 3 with the same
kind of input drift not reproduced within eight re-fetches.
