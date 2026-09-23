/*!
 * GraphPulse tracking snippet.
 *   <script src="https://<ingest-host>/tracker.js" data-key="<tenant api key>" defer></script>
 * Optional attributes: data-endpoint (override collect URL), data-respect-dnt.
 * API: graphpulse.track(name, props), graphpulse.convert(goal, props), graphpulse.pageview()
 */
(function (w, d) {
  'use strict';
  var script = d.currentScript || d.querySelector('script[data-key]');
  if (!script) return;
  var KEY = script.getAttribute('data-key');
  var ENDPOINT = script.getAttribute('data-endpoint') || new URL(script.src, w.location.href).origin + '/v1/collect';
  var SESSION_IDLE_MS = 30 * 60 * 1000;
  var FLUSH_MS = 2000;
  var MAX_QUEUE = 20;

  if (!KEY) return console.warn('[GraphPulse] data-key attribute is missing');
  if (script.hasAttribute('data-respect-dnt') && (navigator.doNotTrack === '1' || w.doNotTrack === '1')) return;

  var memory = {};
  function get(k) { try { return w.localStorage.getItem(k); } catch (e) { return memory[k] || null; } }
  function set(k, v) { try { w.localStorage.setItem(k, v); } catch (e) { memory[k] = v; } }

  function uuid() {
    if (w.crypto && w.crypto.randomUUID) return w.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  var visitorId = get('gp_vid');
  if (!visitorId) { visitorId = uuid(); set('gp_vid', visitorId); }

  function sessionId() {
    var now = Date.now();
    var sid = get('gp_sid');
    var last = Number(get('gp_last')) || 0;
    if (!sid || now - last > SESSION_IDLE_MS) { sid = uuid(); set('gp_sid', sid); }
    set('gp_last', String(now));
    return sid;
  }

  // Only report the referrer when it's another site - internal clicks are
  // captured as graph edges between pages instead.
  function externalReferrer() {
    try {
      return d.referrer && new URL(d.referrer).host !== w.location.host ? d.referrer : null;
    } catch (e) { return null; }
  }

  var queue = [];
  var timer = null;

  function flush(useBeacon) {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!queue.length) return;
    var body = JSON.stringify({ apiKey: KEY, events: queue.splice(0, queue.length) });
    // text/plain keeps this a "simple" CORS request (no preflight).
    if (useBeacon && navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain' }))) return;
    fetch(ENDPOINT, { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'text/plain' } })
      .catch(function () { /* analytics must never break the host page */ });
  }

  function send(type, extra) {
    var e = {
      eventId: uuid(),
      type: type,
      visitorId: visitorId,
      sessionId: sessionId(),
      url: w.location.href,
      title: d.title,
      ts: Date.now()
    };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
    queue.push(e);
    if (queue.length >= MAX_QUEUE) flush(false);
    else if (!timer) timer = setTimeout(function () { flush(false); }, FLUSH_MS);
  }

  var lastPath = null;
  function pageview(force) {
    var path = w.location.pathname;
    if (force !== true && path === lastPath) return;
    var first = lastPath === null;
    lastPath = path;
    send('pageview', { referrer: first ? externalReferrer() : null });
  }

  // Single-page apps: track client-side route changes.
  ['pushState', 'replaceState'].forEach(function (fn) {
    var orig = history[fn];
    history[fn] = function () {
      var result = orig.apply(this, arguments);
      pageview(false);
      return result;
    };
  });
  w.addEventListener('popstate', function () { pageview(false); });
  d.addEventListener('visibilitychange', function () { if (d.visibilityState === 'hidden') flush(true); });
  w.addEventListener('pagehide', function () { flush(true); });

  w.graphpulse = {
    pageview: function () { pageview(true); },
    track: function (name, props) { send('event', { name: name, props: props || {} }); },
    convert: function (goal, props) { send('conversion', { name: goal, props: props || {} }); flush(true); }
  };

  pageview();
})(window, document);
