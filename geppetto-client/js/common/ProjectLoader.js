import { fetchWithRetry, failureReason } from './RetryFetch';
import { xmiToModel, initialExperimentState } from './xmi/XmiModel';

/**
 * Load a project from its JSON descriptor without a server.
 *
 * The server used to do this on load_project_from_url: read the descriptor,
 * read the model it names (an XMI, relative to the descriptor), and send back
 * project_loaded, geppetto_model_loaded and experiment_loaded. Both files are
 * static, so the client reads them itself and runs the same three steps in
 * the same order (Manager.loadProject, loadModel, loadExperiment).
 */
export default function ProjectLoader (GEPPETTO) {

  /*
   * What the server granted an anonymous visitor, minus the Dropbox link
   * (which needed the server).
   */
  var GUEST = {
    userName: 'Guest',
    loggedIn: true,
    hasPersistence: false,
    privileges: ['READ_PROJECT', 'DOWNLOAD']
  };

  /*
   * Callers pass an absolute http:// URL (the server fetched it). A page on
   * https cannot, so use the page's protocol for its own host.
   */
  var pageSafe = function (url) {
    if (typeof window === 'undefined' || !window.location || window.location.protocol !== 'https:') {
      return url;
    }
    return url.indexOf('http://') === 0 ? 'https://' + url.substring('http://'.length) : url;
  };

  var read = function (url, how) {
    return fetchWithRetry(url, undefined, undefined, function (response) {
      return how === 'json' ? response.json() : response.text();
    }).then(function (result) {
      return result.value;
    });
  };

  var failed = function (url, err) {
    var reason = (err && err.reason) ? err.reason : failureReason(err);
    var message = 'Could not load ' + url + ' (' + reason + '): ' + (err && err.message ? err.message : err);
    console.error('ProjectLoader - ' + message);
    GEPPETTO.trigger(GEPPETTO.Events.Hide_spinner);
    GEPPETTO.trigger('geppetto:project_load_failed', { url: url, reason: reason, message: message });
    GEPPETTO.trigger('geppetto:error', message);
  };

  /**
   * Fetch and load the project at projectURL. Resolves with the model.
   */
  this.load = function (projectURL) {
    var url = pageSafe(projectURL);
    var project;
    var modelUrl = url;
    return read(url, 'json').then(function (descriptor) {
      project = descriptor;
      modelUrl = new URL(String(project.geppettoModel.url).replace(/^\/+/, ''), url).href;
      return read(modelUrl, 'text');
    }).then(function (xmi) {
      var model = xmiToModel(xmi);
      /*
       * The server gave every load a fresh project id. Views are kept in
       * localStorage under it, so a fixed id would bring one visit's
       * layout back on the next; keep it fresh.
       */
      project.id = Math.floor(Math.random() * 2147483647);
      project.isPublic = false;
      if (project.view === undefined) {
        project.view = { id: 1, viewStates: '{"views":{}}' };
      }
      GEPPETTO.UserController.setUserPrivileges(GUEST);
      GEPPETTO.Manager.loadProject(project, false);

      console.time(GEPPETTO.Resources.PARSING_MODEL);
      GEPPETTO.trigger(GEPPETTO.Events.Show_spinner, GEPPETTO.Resources.PARSING_MODEL);
      GEPPETTO.Manager.loadModel(model);
      var experimentId = project.activeExperimentId;
      if (experimentId === undefined || experimentId === null || experimentId === -1) {
        GEPPETTO.ViewController.resolveViews();
      } else {
        GEPPETTO.Manager.loadExperiment(experimentId, initialExperimentState(model, project.id, experimentId));
      }
      return model;
    }).catch(function (err) {
      failed(project === undefined ? url : modelUrl, err);
      throw err;
    });
  };
}
