/**
 * There is no Geppetto server any more: the client loads its project from
 * static files (ProjectLoader) and fetches everything else itself (the
 * Direct* modules). What is left here is the old send() entry point for the
 * generic Geppetto features that only a server could do - experiments,
 * persistence, Dropbox, server-side downloads. They now fail straight away
 * and say so, instead of waiting on a socket that will never open.
 */
define(function (require) {
  return function (GEPPETTO) {
    var warned = {};

    GEPPETTO.MessageSocket = {
      send: function (command, parameter, callback) {
        if (!warned[command]) {
          warned[command] = true;
          console.warn('Geppetto: "' + command + '" needs a Geppetto server, which this build does not have');
        }
        GEPPETTO.trigger('geppetto:request_failed', { command: command, reason: 'no-server' });
        return null;
      },

      // kept for GEPPETTO.ScriptRunner, which listens for server replies that no longer come
      addHandler: function () {},
      removeHandler: function () {}
    };
  };
});
