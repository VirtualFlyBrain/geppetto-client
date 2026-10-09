/**
 * Geppetto entry point
 *
 * @author matteo@openworm.org (Matteo Cantarelli)
 * @author giovanni@openworm.org (Giovanni Idili)
 * @author  Jesus R. Martinez (jesus@metacell.us)
 */
define(function (require) {
  return function (GEPPETTO) {
    var $ = require('jquery');

    /**
     * @class GEPPETTO.Main
     */
    GEPPETTO.Main = {

      localStorageEnabled: false,

      /**
       * Lets a page that embeds Geppetto in an iframe drive it.
       */
      createChannel: function () {
        // Change link from blank to self for GEPPETTO_CONFIGURATION.embedded environments
        if (GEPPETTO_CONFIGURATION.embedded && GEPPETTO_CONFIGURATION.embedderURL !== "/" && typeof handleRequest == 'undefined') {
          handleRequest = function (e) {
            if (GEPPETTO_CONFIGURATION.embedderURL.indexOf(e.origin) != -1) {
              if (e.data.command == 'loadSimulation') {
                if (e.data.url) {
                  GEPPETTO.CommandController.execute('Project.loadFromURL("' + e.data.url + '")');
                }
              } else if (e.data.command == 'removeWidgets') {
                GEPPETTO.CommandController.execute('G.removeWidget()');
              } else {
                eval(e.data.command);
              }
            }
          };
          // we have to listen for 'message'
          window.addEventListener('message', handleRequest, false);
          if ($.isArray(GEPPETTO_CONFIGURATION.embedderURL)) {
            window.parent.postMessage({ "command": "ready" }, GEPPETTO_CONFIGURATION.embedderURL[0]);
          } else {
            window.parent.postMessage({ "command": "ready" }, GEPPETTO_CONFIGURATION.embedderURL);
          }
        }
      },

      /**
       * Start listening. There is no server to connect to: the project is
       * loaded from static files when the application asks for it
       * (Project.loadFromURL).
       */
      init: function () {
        GEPPETTO.Events.listen();
        this.createChannel();
        GEPPETTO.CommandController.log(GEPPETTO.Resources.GEPPETTO_INITIALIZED, true);
      }
    };

    $(document).ready(function () {
      $("#loadingText").hide();
      GEPPETTO.Main.init();
    });
  };
});
