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

/*
 * VFB's ingress is several Rancher hosts behind one round-robin name, so a
 * browser talks to whichever address it resolved and keeps that connection
 * for the origin. Naming the hosts directly lets a session use one of them
 * and spread the load across the rest -- worth doing for the meshes, which
 * are the only sizeable transfers.
 *
 * Per session, not per request: these files come back immutable and the
 * browser caches by URL, so asking a different host each time would make a
 * returning visitor download what they already have.
 *
 * Off until window.VFB_DATA_HOSTS names some hosts. Names only -- an address
 * would pin us to a host that DNS has since dropped, and the certificate is
 * issued for names.
 */
var session = { host: undefined, down: {} };

/*
 * A host may carry a weight, "host*n", for how much of the load it should
 * take: VFB's hosts are not equal -- vfbk8s10 has a 10Gb link where the
 * others have 1Gb -- so an even split would waste the fast one. No weight
 * means 1.
 */
function configuredHosts () {
  var configured = (typeof window !== 'undefined') ? window.VFB_DATA_HOSTS : undefined;
  if (typeof configured === 'string') {
    configured = configured.split(',');
  }
  if (!configured || !configured.length) {
    return [];
  }
  return configured.map(function (entry) {
    var parts = String(entry).trim().split('*');
    var weight = parseInt(parts[1], 10);
    return { host: parts[0].trim(), weight: (isNaN(weight) || weight < 1) ? 1 : weight };
  }).filter(function (entry) {
    return entry.host.length > 0;
  });
}

/*
 * Only the origins the data is published under are spread; everything else is
 * left alone. There is more than one: VFB is served from both the apex and
 * www, and a page loaded on either builds its URLs from the origin it is on.
 */
function spreadableHosts () {
  var configured = (typeof window !== 'undefined') ? window.VFB_DATA_HOST : undefined;
  if (typeof configured === 'string') {
    configured = configured.split(',');
  }
  if (!configured || !configured.length) {
    configured = ['www.virtualflybrain.org', 'virtualflybrain.org'];
  }
  return configured.map(function (host) {
    return String(host).trim();
  }).filter(function (host) {
    return host.length > 0;
  });
}

/* The name to fall back to when no alternative host is usable. */
function publishedHost () {
  return spreadableHosts()[0];
}

/**
 * The host this session uses, chosen once from the ones that are up. Falls
 * back to the published name when every alternative has failed.
 */
export function sessionHost () {
  var hosts = configuredHosts().filter(function (entry) {
    return session.down[entry.host] !== true;
  });
  if (!hosts.length) {
    session.host = undefined;
    return publishedHost();
  }
  var stillUp = hosts.filter(function (entry) {
    return entry.host === session.host;
  });
  if (stillUp.length > 0) {
    return session.host;
  }
  var total = hosts.reduce(function (sum, entry) {
    return sum + entry.weight;
  }, 0);
  var pick = Math.random() * total;
  for (var i = 0; i < hosts.length; i++) {
    pick -= hosts[i].weight;
    if (pick < 0) {
      session.host = hosts[i].host;
      return session.host;
    }
  }
  session.host = hosts[hosts.length - 1].host;
  return session.host;
}

/** This host is not answering: nothing else in this session should use it. */
export function markHostDown (host) {
  if (host && spreadableHosts().indexOf(host) === -1 && session.down[host] !== true) {
    session.down[host] = true;
    try {
      GEPPETTO.trigger('geppetto:data_host_down', { host: host });
    } catch (ignore) {
      // reporting must never break a load
    }
  }
  if (session.host === host) {
    session.host = undefined;
  }
}

/** For tests, and for a session that wants to start over. */
export function resetHosts () {
  session = { host: undefined, down: {} };
}

/** The same URL, asked of this session's host. */
export function spreadUrl (url) {
  var hosts = configuredHosts();
  if (!hosts.length || !url) {
    return url;
  }
  var text = String(url);
  var published = spreadableHosts();
  var host = sessionHost();
  /*
   * Nothing left to spread to: leave the URL on whichever published origin
   * the page is already using, rather than moving it to another one.
   */
  if (published.indexOf(host) > -1) {
    return url;
  }
  for (var i = 0; i < published.length; i++) {
    var origin = '//' + published[i] + '/';
    if (text.indexOf(origin) > -1) {
      return text.replace(origin, '//' + host + '/');
    }
  }
  return url;
}

/** Which host a URL is addressed to, for reporting and for marking it down. */
export function hostOf (url) {
  var match = String(url || '').match(/\/\/([^/]+)\//);
  return match === null ? '' : match[1];
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

/* The caller's fetch options plus our cache directive, without mutating theirs. */
function withReloadCache (init) {
  var options = { cache: 'reload' };
  if (init) {
    for (var key in init) {
      if (Object.prototype.hasOwnProperty.call(init, key)) {
        options[key] = init[key];
      }
    }
    options.cache = 'reload';
  }
  return options;
}

function wait (ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/**
 * fetch(url), retried on anything transient.
 *
 * @param init - optional fetch options, for a caller that needs them (an
 *               AbortController signal, say). An abort is never retried.
 * @returns a promise for {response, attempts}; rejects with an error carrying
 *          .reason, .attempts and .url once the attempts are spent.
 */
export function fetchWithRetry (url, attempts, init) {
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
    /*
     * Each attempt re-picks the session's host, so once one is marked down
     * the retry goes to another without the caller knowing anything about it.
     */
    var addressed = spreadUrl(url);
    var target = first ? addressed : (addressed + (addressed.indexOf('?') > -1 ? '&' : '?') + '_retry=' + tried);
    /*
     * The caller's own options are carried through every attempt, so a signal
     * still aborts a retry; only the cache directive is ours to add.
     */
    var options = first ? init : withReloadCache(init);
    return (options ? fetch(target, options) : fetch(target)).then(function (response) {
      if (response.ok) {
        return { response: response, attempts: tried };
      }
      return Promise.reject({ status: response.status, message: 'HTTP ' + response.status + ' fetching ' + target });
    }).catch(function (failure) {
      /*
       * A host that cannot be reached at all is out for this session: it is
       * the case DNS would have routed around, and nothing else should keep
       * paying for it. An HTTP error is the host answering, so it stays.
       */
      if (failureReason(failure) === 'network') {
        markHostDown(hostOf(target));
      }
      if (tried < limit && worthRetrying(failure)) {
        return wait(backoff(tried - 1)).then(attempt);
      }
      var err = new Error((failure && failure.message) ? failure.message : String(failure));
      /*
       * Keep the original name: callers distinguish an abort from a failure by
       * it (an aborted call is a cancel, not something to report to the user),
       * and rewrapping used to lose that.
       */
      if (failure && failure.name) {
        err.name = failure.name;
      }
      err.reason = failureReason(failure);
      err.attempts = tried;
      err.url = url;
      err.host = hostOf(target);
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
