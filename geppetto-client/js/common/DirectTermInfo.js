/**
 * Fetch a VFB term's info in the client and build its model locally, without
 * the server (VFB2 #502 phase 2).
 *
 * The server's fetch_variable for the vfbqueryTermInfo datasource did a GET
 * on v3-cached/get_term_info and ran VFBProcessTermInfoVFBqueryJson over the
 * reply to produce the term's variable, metadata rows and import types.
 * TermInfoModel.js is that processor ported to JavaScript; this module does
 * the fetch, hands the JSON and a description of the client model to it, and
 * merges the result through Manager.addVariableToModel exactly as the server
 * reply would have been merged. References are computed against the client's
 * own model, so there is no second copy to keep in step.
 *
 * Off unless the application sets GEPPETTO.DirectTermInfo.enabled. Only the
 * datasource whose service is vfbqueryTermInfoDataSource is handled; any
 * other datasource, or a failed fetch, goes to the server as before.
 */
import { termInfoToRawModel, shapeOf } from './TermInfoModel';

var TERM_INFO_SERVICE = 'vfbqueryTermInfoDataSource';

export default function DirectTermInfo (GEPPETTO) {

  this.enabled = false;

  /**
   * The datasource with this id, if it is one this module can stand in for.
   */
  this.findDatasource = function (datasourceId) {
    var sources = GEPPETTO.ModelFactory.geppettoModel.getDatasources();
    for (var i = 0; i < sources.length; i++) {
      if (sources[i].getId() === datasourceId) {
        var raw = sources[i].getWrappedObj();
        return raw.dataSourceService === TERM_INFO_SERVICE && raw.url ? sources[i] : null;
      }
    }
    return null;
  };

  this.canFetch = function (datasourceId) {
    return this.enabled && this.findDatasource(datasourceId) !== null;
  };

  /**
   * Build the get_term_info url for an id. The model's url is http:// (the
   * server used to fetch it); a page served over https cannot, so match the
   * page. Ids are encoded because get_term_info takes them as a query value.
   */
  this.termInfoUrl = function (datasource, id) {
    var url = datasource.getWrappedObj().url;
    if (typeof window !== 'undefined' && window.location && window.location.protocol === 'https:' && url.indexOf('http://') === 0) {
      url = 'https://' + url.substring('http://'.length);
    }
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'id=' + encodeURIComponent(id);
  };

  /**
   * Fetch and merge each id in turn (the server merged a list in one reply;
   * one merge per id is the same model). Calls callback() when all are in,
   * or fallback(ids) if anything failed so the caller can ask the server.
   */
  this.fetch = function (variableIds, datasourceId, callback, fallback) {
    var that = this;
    var datasource = this.findDatasource(datasourceId);
    var startedAt = Date.now();
    var report = function (ok, id) {
      try {
        GEPPETTO.trigger('geppetto:direct_terminfo', { ok: ok, ms: Date.now() - startedAt, id: id });
      } catch (ignore) {
        // reporting must never break the load
      }
    };
    GEPPETTO.trigger('spin_logo');
    var next = function (i) {
      if (i >= variableIds.length) {
        GEPPETTO.trigger('stop_spin_logo');
        if (callback !== undefined) {
          callback();
        }
        return;
      }
      var id = variableIds[i];
      var url = that.termInfoUrl(datasource, id);
      fetch(url).then(function (response) {
        if (!response.ok) {
          throw new Error('HTTP ' + response.status + ' fetching ' + url);
        }
        return response.json();
      }).then(function (termInfo) {
        var shape = shapeOf(GEPPETTO.ModelFactory.geppettoModel);
        var built = termInfoToRawModel(termInfo, id, shape);
        GEPPETTO.Manager.addVariableToModel(built.rawModel);
        report(true, id);
        next(i + 1);
      }).catch(function (err) {
        console.error('DirectTermInfo - could not build ' + id + ' in the client, asking the server: ' + (err && err.message ? err.message : err));
        report(false, id);
        GEPPETTO.trigger('stop_spin_logo');
        fallback(variableIds.slice(i));
      });
    };
    next(0);
  };
}
