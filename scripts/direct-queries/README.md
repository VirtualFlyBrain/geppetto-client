# Direct queries: differential check against the live server

`geppetto-client/js/common/QueryResultsModel.js` is the server's
VFBqueryResponseProcessor + VFBqueryJsonProcessor ported to JavaScript;
`DirectQueries.js` resolves a runnable query to its v3-cached GET, fetches it
and hands the query builder the same serialised QueryResults the server sent.

    pip install websockets
    python3 scripts/direct-queries/capture.py captures <id> [<id> ...]
    node scripts/direct-queries/compare.mjs captures

`capture.py` loads the project on the live websocket, fetches each term, and
for every query the term's info lists runs `run_query_count` and `run_query`
on the server while fetching the same v3-cached run_query JSON the client
would use, saving all three per `<id>__<query>`. `compare.mjs` builds each
table with the client processor and reports `ok`/`FAIL` with the first
differing cells, plus the count.

Corpus used on 17 Sep 2026 (v3-cached on a single container): 49 query runs
over eight terms - painted domains, aligned images and datasets of a
template, class lists with images, neurons part/synaptic/pre/post here, parts,
tracts, clones, transgene expression, dataset images, neuron-neuron and
neuron-region connectivity, NBLAST similarity, up/downstream class
connectivity, splits targeting, subclasses, and empty tables - all identical,
including tables of 25,000 rows.
