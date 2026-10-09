
/**
 * Controller responsible to execute queries
 *
 * @author Matteo Cantarelli
 */
define(function (require) {
  return function (GEPPETTO) {

    /**
     * @class GEPPETTO.QueriesController
     */
    GEPPETTO.QueriesController
        = {

        /**
         * Run a set of queries. A vfbquery query is fetched from v3-cached
         * and its table built here, as the server did; no other kind can
         * run without the server.
         *
         * @param queries
         * @param callback - (serialised QueryResults)
         * @param onFailed - (error)
         */
        runQuery: function (queries, callback, offset, limit, onFailed) {
          if (GEPPETTO.DirectQueries === undefined || !GEPPETTO.DirectQueries.canRun(queries)) {
            GEPPETTO.Manager.requestFailed('run_query', this.describe(queries), new Error('no client-side runner for this query'), onFailed);
            return;
          }
          GEPPETTO.DirectQueries.run(queries, callback, offset, limit, function (err) {
            GEPPETTO.Manager.requestFailed('run_query', GEPPETTO.QueriesController.describe(queries), err, onFailed);
          });
        },

        /**
         * Get the count for a set of queries
         *
         * @param queries
         * @param callback - (count)
         * @param onFailed - (error)
         */
        getQueriesCount: function (queries, callback, onFailed) {
          if (!queries || queries.length === 0) {
            callback(0);
            return;
          }
          if (GEPPETTO.DirectQueries === undefined || !GEPPETTO.DirectQueries.canRun(queries)) {
            GEPPETTO.Manager.requestFailed('run_query_count', this.describe(queries), new Error('no client-side runner for this query'), onFailed);
            return;
          }
          GEPPETTO.DirectQueries.count(queries, callback, function (err) {
            GEPPETTO.Manager.requestFailed('run_query_count', GEPPETTO.QueriesController.describe(queries), err, onFailed);
          });
        },

        describe: function (queries) {
          return (queries || []).map(function (q) {
            return (q.query ? q.query.getId() : '?') + '(' + (q.target ? q.target.getId() : '?') + ')';
          });
        }
      }
  }

});
