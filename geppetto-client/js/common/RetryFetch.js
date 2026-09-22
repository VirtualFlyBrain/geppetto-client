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
 * How many times one call may pick a dropped download back up where it left
 * off (see fetchWithRetry). Each resume that gets further resets the attempt
 * budget, so this is what bounds a link that keeps giving a little and then
 * dying: at worst ATTEMPTS fresh tries between every one of these.
 */
export var RESUMES = 8;

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

function resumeLimit () {
  var configured = (typeof window !== 'undefined') ? window.VFB_FETCH_RESUMES : undefined;
  return (typeof configured === 'number' && configured >= 0) ? configured : RESUMES;
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
var session = { down: {} };

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

/*
 * The file's path, which is what the host is chosen from: the same file must
 * come from the same host whichever published origin the page is on, and
 * whatever query a retry has appended.
 */
function pathKey (url) {
  var withoutQuery = String(url || '').split('?')[0];
  var afterHost = withoutQuery.split('//')[1];
  return (afterHost === undefined) ? withoutQuery : afterHost.substring(afterHost.indexOf('/') + 1);
}

/* FNV-1a, for a cheap stable spread. Any stable hash would do. */
function hashOf (text) {
  var hash = 2166136261;
  for (var i = 0; i < text.length; i++) {
    hash = hash ^ text.charCodeAt(i);
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash >>> 0;
}

/* One slot per unit of weight, so a 10Gb host takes ten times the share. */
function hostSlots (hosts) {
  var slots = [];
  for (var i = 0; i < hosts.length; i++) {
    for (var w = 0; w < hosts[i].weight; w++) {
      slots.push(hosts[i].host);
    }
  }
  return slots;
}

/**
 * The host a given file comes from, chosen by its path rather than once per
 * session.
 *
 * Per session would mean every file in a page load queues on one node, which
 * is no help at all for the case worth helping: several meshes loading at
 * once. Choosing by path spreads a batch of different files across the nodes
 * while keeping each file on one host, so the browser's cache still hits on a
 * revisit -- which is what the per-session choice was protecting.
 *
 * A host that is down is stepped over rather than removed, so only its own
 * files move; everything else keeps the host it already cached from.
 *
 * @param skip - how many hosts to step past, for a retry. A host that just
 *               failed to serve this file should not be asked again: an HTTP
 *               error means it answered, so it is not marked down, but it is
 *               still the least promising place to ask next. Attempt one
 *               always passes 0, so the cache-stable choice is the one that
 *               normally serves.
 */
export function hostFor (url, skip) {
  var slots = hostSlots(configuredHosts());
  if (!slots.length) {
    return publishedHost();
  }
  var distinct = [];
  for (var s = 0; s < slots.length; s++) {
    if (distinct.indexOf(slots[s]) === -1) {
      distinct.push(slots[s]);
    }
  }
  var start = hashOf(pathKey(url)) % slots.length;
  var stepped = 0;
  var wanted = (skip > 0) ? (skip % distinct.length) : 0;
  var seen = [];
  for (var probe = 0; probe < slots.length; probe++) {
    var candidate = slots[(start + probe) % slots.length];
    if (session.down[candidate] === true || seen.indexOf(candidate) > -1) {
      continue;
    }
    if (stepped === wanted) {
      return candidate;
    }
    seen.push(candidate);
    stepped++;
  }
  /* Stepped past everything usable: start again from the file's own host. */
  for (var again = 0; again < slots.length; again++) {
    var fallback = slots[(start + again) % slots.length];
    if (session.down[fallback] !== true) {
      return fallback;
    }
  }
  return publishedHost();
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
}

/** For tests, and for a session that wants to start over. */
export function resetHosts () {
  session = { down: {} };
}

/** The same URL, asked of this session's host. */
export function spreadUrl (url, skip) {
  var hosts = configuredHosts();
  if (!hosts.length || !url) {
    return url;
  }
  var text = String(url);
  var published = spreadableHosts();
  var host = hostFor(url, skip);
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

/*
 * The caller's fetch options with extra headers added, without mutating
 * theirs. Headers end up as a plain object whatever they started as, so a
 * caller's Headers instance and a test's object literal are treated alike.
 */
function withHeaders (init, extra) {
  var options = {};
  var headers = {};
  if (init) {
    for (var key in init) {
      if (Object.prototype.hasOwnProperty.call(init, key)) {
        options[key] = init[key];
      }
    }
    var given = init.headers;
    if (given && typeof given.forEach === 'function' && typeof given.get === 'function') {
      given.forEach(function (value, name) {
        headers[name] = value;
      });
    } else if (given) {
      for (var name in given) {
        if (Object.prototype.hasOwnProperty.call(given, name)) {
          headers[name] = given[name];
        }
      }
    }
  }
  for (var added in extra) {
    if (Object.prototype.hasOwnProperty.call(extra, added)) {
      headers[added] = extra[added];
    }
  }
  options.headers = headers;
  return options;
}

/**
 * What identifies the version of the file a response carries: a strong ETag
 * (a weak one, W/"...", promises the same meaning, not the same bytes, and a
 * resume is a byte-offset claim) and Last-Modified. Either can be missing --
 * the data hosts are another origin, and a browser only shows a page a
 * cross-origin response's ETag if the host exposes it, where Last-Modified
 * is always readable.
 *
 * A resume is checked against these rather than sent conditionally: an
 * If-Range header makes the browser preflight the request with OPTIONS,
 * which the data hosts refuse (405), so the request never leaves the page.
 * A plain Range header with a simple value needs no preflight. The consumer
 * compares what the 206 says it is with what the first response said, and
 * refuses to splice on any difference -- the same guarantee, one round trip
 * later in the case that should never happen for an immutable file.
 */
export function versionOf (response) {
  var version = { etag: null, lastModified: null };
  try {
    var headers = response && response.headers;
    if (!headers || typeof headers.get !== 'function') {
      return version;
    }
    var tag = headers.get('etag');
    if (typeof tag === 'string' && tag.length >= 3 && !/^W\//i.test(tag)) {
      version.etag = tag;
    }
    var modified = headers.get('last-modified');
    if (typeof modified === 'string' && modified.length > 0) {
      version.lastModified = modified;
    }
  } catch (ignore) {
    // a response that will not say is one that cannot be resumed against
  }
  return version;
}

/** Whether two versions are known to be the same file, by the strongest fact both carry. */
export function sameVersion (a, b) {
  if (a.etag !== null && b.etag !== null) {
    return a.etag === b.etag;
  }
  if (a.lastModified !== null && b.lastModified !== null) {
    return a.lastModified === b.lastModified;
  }
  return false;
}

function wait (ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/*
 * Whether the page is on its way out. A fetch that dies because the user
 * navigated away or reloaded looks exactly like a dropped connection, and
 * used to be retried and reported as one. Once the page is leaving nothing
 * is worth retrying, and the failure is not the host's to answer for.
 */
var leaving = false;
/*
 * How many times the page has been frozen (backgrounded on mobile, or tab
 * discard candidate) since load. A frozen page's timers are suspended, not
 * cancelled, so a pending retry still fires on resume -- but a failure that
 * happened around a freeze is a different animal from a plain dropped
 * connection, and worth telling apart when diagnosing where fails cluster.
 */
var freezeCount = 0;
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', function () {
    leaving = true;
  });
  window.addEventListener('beforeunload', function () {
    leaving = true;
  });
  // back/forward cache brings the page back alive after a pagehide
  window.addEventListener('pageshow', function () {
    leaving = false;
  });
  // Page Lifecycle API: Chrome/Android backgrounding a tab under memory or
  // battery pressure. Not supported everywhere (notably not Safari), so this
  // is a bonus signal where the browser offers it, never a requirement.
  document.addEventListener('freeze', function () {
    freezeCount++;
  });
}

/** For tests, and for anything that needs to know. */
export function pageLeaving () {
  return leaving;
}
export function setPageLeaving (value) {
  leaving = (value === true);
}

/*
 * A compact snapshot of the browser/network conditions at the moment a call
 * finally gives up, attached to the thrown error so a GA event (or a console
 * log) can carry it without the caller having to know any of this itself.
 * Nothing here is collected unless the platform offers it; every field is
 * best-effort and can be absent.
 */
function diagnostics (freezesAtStart) {
  var d = {};
  try {
    if (typeof document !== 'undefined') {
      d.visibility = document.visibilityState;
    }
    if (typeof navigator !== 'undefined') {
      d.online = navigator.onLine;
      var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (c) {
        d.effectiveType = c.effectiveType;
        d.saveData = c.saveData;
      }
    }
    d.frozeDuringCall = freezeCount > freezesAtStart;
  } catch (ignore) {
    // diagnostics must never be able to break the call they describe
  }
  return d;
}

/**
 * fetch(url), retried on anything transient -- including a failure while the
 * body is being read, when a consumer is given.
 *
 * @param init - optional fetch options, for a caller that needs them (an
 *               AbortController signal, say). An abort is never retried.
 * @param consume - optional function (response, resume) returning a promise
 *               for the value read from the body. It runs inside the attempt,
 *               so a connection dropped part-way through a stream is retried
 *               from the next host like any other failure, instead of
 *               surfacing after a "successful" fetch. Without it the caller
 *               reads the body itself and only the request is retried.
 *
 *               A consumer that sets consume.resumable = true is stateful and
 *               can pick a dropped download up where it left off. It reports
 *               how far it got as .bytesReceived on the failure it throws
 *               (cumulative across calls), and on the next call receives
 *               resume = {offset, version} when the request asked for bytes from
 *               that offset. It must then check the response: a 206 of the
 *               same version whose Content-Range starts at the offset
 *               continues; a 200 (a host that ignored the Range) starts the
 *               parse over; any other 206 is refused. A call with
 *               no resume argument is a fresh download and must start over
 *               whatever state the consumer holds.
 * @returns a promise for {response, attempts, resumes, value}; rejects with an
 *          error carrying .reason, .attempts, .resumes, .url and .host once the
 *          attempts are spent. A failure while the page is unloading has
 *          reason 'unload' and is not retried.
 *
 * Two kinds of failure, counted apart. A request that got nowhere -- refused,
 * an HTTP error, a body that broke before a single new byte -- is a strike,
 * and ATTEMPTS strikes end the call. A body that broke off after making
 * progress is not a strike at all: it is a normal interruption on a long
 * transfer, so the download is resumed from the last byte parsed (HTTP Range,
 * checked against the file's ETag so a changed file restarts rather than
 * splices), and the strike count goes back to zero. Nothing about a
 * connection that was working and then wasn't says the method is wrong, and
 * giving up the direct load for the server on that basis just re-fetches the
 * same file over a worse channel. RESUMES bounds how many such interruptions
 * one call will ride out, so a link that only ever trickles still ends.
 */
export function fetchWithRetry (url, attempts, init, consume) {
  var limit = attemptLimit(attempts);
  var resumeCap = resumeLimit();
  var canResume = typeof consume === 'function' && consume.resumable === true;
  var requests = 0;
  var strikes = 0;
  var resumes = 0;
  var lastReason = null;
  var freezesAtStart = freezeCount;
  /*
   * Where the consumer has got to, and which version of the file those
   * bytes came from. Both belong to the call, not the attempt: a resume on
   * another host is still the same file at the same offset.
   */
  var offset = 0;
  var version = null;
  var attempt = function (resuming) {
    requests++;
    var first = (requests === 1);
    /*
     * Each retry steps to the next host: the one that just failed is the
     * least promising place to ask again, whether it was marked down or
     * merely answered with an error. A resume steps too -- every host serves
     * the same bytes under the same ETag, and the consumer checks that it did.
     */
    var target = spreadUrl(url, requests - 1);
    /*
     * The URL is never decorated: these files are cached as immutable by URL,
     * and a cache-busting parameter turned every retry into a full download
     * of a file the browser may already hold. Only a retry after the host
     * answered badly (an HTTP error, or a body that would not parse -- either
     * of which a cache could hand back again) bypasses the cache; a retry
     * after a dropped connection may be served from it, since a partial
     * download is never cached.
     */
    var bypass = !first && (lastReason === 'parse' || /^http/.test(lastReason || ''));
    var options = bypass ? withReloadCache(init) : init;
    /*
     * Ask for the rest of the file whenever there is a rest to ask for,
     * strike or not: the offset is only ever set from bytes the consumer has
     * already parsed, so there is never a reason to fetch them again. The
     * consumer is told which version those bytes came from, and refuses a
     * 206 that is not the same file.
     */
    var resume;
    if (resuming) {
      resume = { offset: offset, version: version };
      options = withHeaders(options, { Range: 'bytes=' + offset + '-' });
    }
    var headersArrived = false;
    return (options ? fetch(target, options) : fetch(target)).then(function (response) {
      headersArrived = true;
      if (!response.ok) {
        return Promise.reject({ status: response.status, message: 'HTTP ' + response.status + ' fetching ' + target });
      }
      if (version === null) {
        var seen = versionOf(response);
        if (seen.etag !== null || seen.lastModified !== null) {
          version = seen;
        }
      }
      if (typeof consume !== 'function') {
        return { response: response, attempts: requests, resumes: resumes };
      }
      return Promise.resolve(consume(response, resume)).then(function (value) {
        return { response: response, attempts: requests, resumes: resumes, value: value };
      });
    }).catch(function (failure) {
      var reason = failureReason(failure);
      if (leaving && (reason === 'network' || reason === 'aborted' || reason === 'error')) {
        reason = 'unload';
      }
      lastReason = reason;
      /*
       * A host that cannot be reached at all is out for this session: it is
       * the case DNS would have routed around, and nothing else should keep
       * paying for it. A host that answered -- with an error, or with a body
       * that then broke off -- was reachable, so it stays.
       */
      if (reason === 'network' && !headersArrived) {
        markHostDown(hostOf(target));
      }
      /*
       * Did this attempt get the download further than it was? The consumer
       * reports its cumulative position; anything past the last one is
       * progress. A consumer that had to start over reports a smaller
       * number, which counts as no progress -- correctly, since the old
       * offset is gone.
       */
      var progressed = false;
      if (failure && typeof failure.bytesReceived === 'number') {
        progressed = headersArrived && failure.bytesReceived > offset;
        offset = failure.bytesReceived;
      }
      /*
       * Otherwise the body was never read -- the request was refused or the
       * host answered with an error -- and whatever the consumer holds is
       * still good, so the offset stands and the next request asks from it.
       */
      var resumable = canResume && offset > 0 && version !== null;
      /*
       * A connection that was delivering and then dropped is an interruption,
       * not a failed attempt: it costs no strike and clears the ones before
       * it. Only up to the cap, so a link that never gets far still ends --
       * and only when the download can actually be picked up, since starting
       * over is a full attempt however far the last one got.
       */
      if (resumable && progressed && reason === 'network' && resumes < resumeCap) {
        resumes++;
        strikes = 0;
        return wait(backoff(0)).then(function () {
          return attempt(resumable);
        });
      }
      strikes++;
      if (strikes < limit && reason !== 'unload' && worthRetrying(failure)) {
        return wait(backoff(strikes - 1)).then(function () {
          return attempt(resumable);
        });
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
      err.reason = reason;
      err.attempts = requests;
      err.resumes = resumes;
      err.url = url;
      err.host = hostOf(target);
      err.midStream = headersArrived;
      /*
       * A consumer (the OBJ stream reader, say) can attach its own facts to
       * the failure it threw -- bytes read before the drop, say -- and they
       * ride along here rather than needing their own reporting path.
       */
      if (failure && typeof failure.bytesReceived === 'number') {
        err.bytesReceived = failure.bytesReceived;
      } else if (offset > 0) {
        // the last request never read a body, but earlier ones got this far
        err.bytesReceived = offset;
      }
      if (failure && typeof failure.contentLength === 'number') {
        err.contentLength = failure.contentLength;
      }
      var diag = diagnostics(freezesAtStart);
      for (var key in diag) {
        if (Object.prototype.hasOwnProperty.call(diag, key)) {
          err[key] = diag[key];
        }
      }
      throw err;
    });
  };
  return attempt(false);
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
