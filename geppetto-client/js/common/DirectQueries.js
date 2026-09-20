import { fetchWithRetry, failureReason, callTag } from './RetryFetch';

/**
 * Run a VFB term's queries in the client, without the server (VFB2 #502
 * phase 3).
 *
 * The server's run_query for a vfbquery query did a GET on
 * v3-cached/run_query?id=$ID&query_type=... (with &offset=&limit= for a
 * paged request), unwrapped the envelope with VFBqueryResponseProcessor and
 * formatted the table with VFBqueryJsonProcessor; run_query_count did the
 * count query and counted its rows. QueryResultsModel.js is those steps
 * ported to JavaScript; this module resolves a runnable query to its GET,
 * fetches it and hands back the same JSON string the callback used to get.
 *
 * Only queries whose chain is exactly [SimpleQuery GET, ProcessQuery
 * vfbqueryJsonProcessor] on a vfbqueryDataSource datasource are handled;
 * anything else (the legacy Neo4j/Owlery chains) goes to the server, as
 * does a failed fetch. Off unless the application sets
 * GEPPETTO.DirectQueries.enabled.
 */
import { responseToQueryResults, responseToCount, combineResults } from './QueryResultsModel';

export default function DirectQueries (GEPPETTO) {

  this.enabled = false;

  var rawModel = function () {
    return GEPPETTO.ModelFactory.geppettoModel.getWrappedObj();
  };

  /*
   * Follow a raw reference like //@dataSources.4/@queries.13 through the raw
   * model. Only the dataSources/queries steps are needed here.
   */
  var followRef = function (ref) {
    var node = rawModel();
    var parts = ref.replace('geppettoModel#', '').replace(/^\/\//, '').split('/');
    for (var i = 0; i < parts.length; i++) {
      var m = /^@([A-Za-z]+)\.(\d+)$/.exec(parts[i]);
      if (!m || !node || !Array.isArray(node[m[1]])) {
        return null;
      }
      node = node[m[1]][parseInt(m[2], 10)];
    }
    return node || null;
  };

  /**
   * Resolve a query id (the queryPath the server received) to
   * {url, query, countQuery} or null when this module cannot run it.
   */
  this.resolveQuery = function (queryPath) {
    var id = queryPath.replace(GEPPETTO.Resources.MODEL_PREFIX_CLIENT + '.', '');
    var raw = rawModel();
    var top = (raw.queries || []).filter(function (q) {
      return q.id === id;
    })[0];
    if (!top || !Array.isArray(top.queryChain) || top.queryChain.length !== 1) {
      return null;
    }
    var compound = top.queryChain[0].$ref ? followRef(top.queryChain[0].$ref) : top.queryChain[0];
    if (!compound || !Array.isArray(compound.queryChain) || compound.queryChain.length !== 2) {
      return null;
    }
    var simple = compound.queryChain[0];
    var process = compound.queryChain[1];
    if (!simple || simple.eClass !== 'SimpleQuery' || !simple.query
        || !process || process.eClass !== 'ProcessQuery' || process.queryProcessorId !== 'vfbqueryJsonProcessor') {
      return null;
    }
    // the datasource that owns the compound query
    var datasource = null;
    var sources = raw.dataSources || [];
    for (var i = 0; i < sources.length && datasource === null; i++) {
      if ((sources[i].queries || []).indexOf(compound) >= 0) {
        datasource = sources[i];
      }
    }
    if (!datasource || datasource.dataSourceService !== 'vfbqueryDataSource' || !datasource.url) {
      return null;
    }
    return { url: datasource.url, query: simple.query, countQuery: simple.countQuery || simple.query };
  };

  this.canRun = function (queries) {
    if (!this.enabled || !queries || queries.length === 0) {
      return false;
    }
    for (var i = 0; i < queries.length; i++) {
      if (!queries[i].target || !queries[i].query || this.resolveQuery(queries[i].query.getPath()) === null) {
        return false;
      }
    }
    return true;
  };

  var pageProtocol = function () {
    return (typeof window !== 'undefined' && window.location) ? window.location.protocol : 'https:';
  };

  /**
   * The GET url the server built from the query template: url?query with $ID
   * substituted, plus &offset=&limit= when offset is not 0.
   */
  this.queryUrl = function (resolved, targetId, forCount, offset, limit) {
    var url = resolved.url;
    if (pageProtocol() === 'https:' && url.indexOf('http://') === 0) {
      url = 'https://' + url.substring('http://'.length);
    }
    var q = (forCount ? resolved.countQuery : resolved.query).split('$ID').join(encodeURIComponent(targetId));
    var full = url + '?' + q;
    if (!forCount && offset !== undefined && offset !== null && String(offset) !== '0') {
      full += '&offset=' + offset + '&limit=' + (limit !== undefined && limit !== null ? limit : 10000);
    }
    return full;
  };

  this.imageTypeRef = function () {
    var libs = GEPPETTO.ModelFactory.geppettoModel.getLibraries();
    for (var i = 0; i < libs.length; i++) {
      var types = libs[i].getTypes();
      for (var j = 0; j < types.length; j++) {
        if (types[j].getId() === 'Image' && types[j].getMetaType() === 'ImageType') {
          return 'geppettoModel#//@libraries.' + i + '/@types.' + j;
        }
      }
    }
    return null;
  };

  var fetchJson = function (url) {
    // the JSON is read inside the retried call, so a truncated body is retried too
    return fetchWithRetry(url, undefined, undefined, function (response) {
      return response.json();
    }).then(function (result) {
      return result.value;
    });
  };

  var report = function (kind, ok, ms, queryId, failure) {
    try {
      GEPPETTO.trigger('geppetto:direct_query', {
        kind: kind,
        ok: ok,
        ms: ms,
        query: queryId,
        reason: ok ? undefined : ((failure && failure.reason) ? failure.reason : failureReason(failure)),
        attempts: (failure && failure.attempts) ? failure.attempts : undefined,
        call: ok ? undefined : ((failure && failure.url) ? callTag(failure.url) : queryId)
      });
    } catch (ignore) {
      // reporting must never break a query
    }
  };

  /**
   * Run the queries and call callback(jsonString) with the serialised
   * QueryResults, or fallback() to have the server run them.
   */
  this.run = function (queries, callback, offset, limit, fallback) {
    var that = this;
    var startedAt = Date.now();
    var imageRef = this.imageTypeRef();
    Promise.all(queries.map(function (q) {
      var resolved = that.resolveQuery(q.query.getPath());
      var target = q.target;
      return fetchJson(that.queryUrl(resolved, target.getId(), false, offset, limit)).then(function (response) {
        return responseToQueryResults(response, { id: target.getId(), name: target.getName() }, imageRef);
      });
    })).then(function (list) {
      var combined = combineResults(list);
      report('run', true, Date.now() - startedAt, queries[0].query.getId());
      callback(JSON.stringify(combined));
    }).catch(function (err) {
      console.error('DirectQueries - could not run in the client after '
        + (err && err.attempts ? err.attempts : 1) + ' attempt(s) ('
        + failureReason(err) + '), asking the server: ' + (err && err.message ? err.message : err));
      report('run', false, Date.now() - startedAt, queries[0].query.getId(), err);
      fallback();
    });
  };

  /**
   * Count the queries\' results and call callback(count), or fallback().
   */
  this.count = function (queries, callback, fallback) {
    var that = this;
    var startedAt = Date.now();
    Promise.all(queries.map(function (q) {
      var resolved = that.resolveQuery(q.query.getPath());
      return fetchJson(that.queryUrl(resolved, q.target.getId(), true)).then(responseToCount);
    })).then(function (counts) {
      /*
       * The server counted the rows of the combined result; for a single
       * query that is its row count, and a compound run intersects on ID,
       * which the count cannot see without the rows - use the smallest.
       */
      report('count', true, Date.now() - startedAt, queries[0].query.getId());
      callback(counts.length === 1 ? counts[0] : Math.min.apply(null, counts));
    }).catch(function (err) {
      console.error('DirectQueries - could not count in the client after '
        + (err && err.attempts ? err.attempts : 1) + ' attempt(s) ('
        + failureReason(err) + '), asking the server: ' + (err && err.message ? err.message : err));
      report('count', false, Date.now() - startedAt, queries[0].query.getId(), err);
      fallback();
    });
  };
}
