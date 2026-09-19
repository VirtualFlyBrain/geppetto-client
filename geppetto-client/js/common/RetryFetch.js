/**
 * One fetch, retried, with a reason when it finally gives up.
 *
 * Every direct path used to make a single request and fall back to the server
 * on the first failure -- and the server, for these, does nothing cleverer
 * than fetch the same URL again. A transient 503 or a dropped connection
 * therefore cost a round trip through the websocket to reach the same file,
 * and for a term this client built the server cannot resolve it at all.
 * Retrying here is both cheaper and the only thing that can actually recover.
 *
 * A failure that survives the retries is reported with a reason and the call
 * that failed, because the events only carried a duration and could not say
 * whether a fallback was a 404, a timeout or a parse error.
 */

/* Enough that a blip does not reach the user, few enough to stay quick. */
export var ATTEMPTS = 4;
export var BACKOFF_MS = [500, 2000, 5000];

/*
 * Both are overridable at runtime (window.VFB_FETCH_ATTEMPTS,
 * window.VFB_FETCH_BACKOFF_MS) so a deployment can tune them without a
 * release, and so tests do not have to wait out the backoff.
 */
function attemptLimit (requested) {
  if (requested) {
    return requested;
  }
  var configured = (typeof window !== 'undefined') ? window.VFB_FETCH_ATTEMPTS : undefined;
  return (typeof configured === 'number' && configured > 0) ? configured : ATTEMPTS;
}

function backoff (index) {
  var configured = (typeof window !== 'undefined') ? window.VFB_FETCH_BACKOFF_MS : undefined;
  var waits = (configured && configured.length) ? configured : BACKOFF_MS;
  return waits[Math.min(index, waits.length - 1)];
}

/**
 * Why a fetch failed, as a short token for an event name.
 *
 * @param failure - a Response that was not ok, or a thrown error
 */
export function failureReason (failure) {
  if (failure === undefined || failure === null) {
    return 'unknown';
  }
  if (typeof failure.status === 'number' && failure.status > 0) {
    return 'http' + failure.status;
  }
  var name = String(failure.name || '');
  var message = String(failure.message || failure);
  if (name === 'AbortError') {
    return 'aborted';
  }
  if (/Cannot create a string longer/i.test(message)) {
    return 'toolarge';
  }
  if (/JSON|Unexpected token|parse/i.test(message)) {
    return 'parse';
  }
  if (name === 'TypeError' || /NetworkError|Failed to fetch|network/i.test(message)) {
    return 'network';
  }
  if (/timed out|timeout/i.test(message)) {
    return 'timeout';
  }
  return 'error';
}

/* Retry anything that might come good. A 404 will not, so it goes once. */
function worthRetrying (failure) {
  var reason = failureReason(failure);
  if (reason === 'aborted' || reason === 'toolarge') {
    return false;
  }
  if (/^http4/.test(reason)) {
    return reason === 'http408' || reason === 'http429';
  }
  return true;
}

function wait (ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/**
 * fetch(url), retried on anything transient.
 *
 * @returns a promise for {response, attempts}; rejects with an error carrying
 *          .reason, .attempts and .url once the attempts are spent.
 */
export function fetchWithRetry (url, attempts) {
  var limit = attemptLimit(attempts);
  var tried = 0;
  var attempt = function () {
    tried++;
    /*
     * A retry must not be served the same failure from a cache, and should
     * not be answered by whatever the first attempt was talking to if that
     * can be helped. JavaScript cannot choose the IP -- the browser owns
     * connection reuse and DNS -- but a reload-cache request with a fresh
     * URL is the most a client can do to make the retry a real one. A
     * connection-level failure is different: the browser drops that
     * connection, so the next attempt can land on another round-robin
     * address by itself.
     */
    var first = (tried === 1);
    var target = first ? url : (url + (url.indexOf('?') > -1 ? '&' : '?') + '_retry=' + tried);
    return (first ? fetch(target) : fetch(target, { cache: 'reload' })).then(function (response) {
      if (response.ok) {
        return { response: response, attempts: tried };
      }
      return Promise.reject({ status: response.status, message: 'HTTP ' + response.status + ' fetching ' + target });
    }).catch(function (failure) {
      if (tried < limit && worthRetrying(failure)) {
        return wait(backoff(tried - 1)).then(attempt);
      }
      var err = new Error((failure && failure.message) ? failure.message : String(failure));
      err.reason = failureReason(failure);
      err.attempts = tried;
      err.url = url;
      throw err;
    });
  };
  return attempt();
}

/**
 * The part of a call worth putting in an event name: the term the file
 * belongs to, or the last path segment. Event names are capped at 40
 * characters, so this stays short.
 */
export function callTag (url) {
  if (!url) {
    return 'na';
  }
  var withoutQuery = String(url).split('?')[0];
  var vfb = withoutQuery.match(/\/i\/(\w{4})\/(\w{4})\//);
  if (vfb !== null) {
    return vfb[1] + vfb[2];
  }
  var id = String(url).match(/[?&]id=([^&]+)/);
  if (id !== null) {
    return id[1].replace(/^VFB_/, '');
  }
  return withoutQuery.split('/').pop() || 'na';
}
