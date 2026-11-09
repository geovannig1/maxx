/* ============================================================================
 * Example Studio — paid-touch capture + Acuity attribution decoration (ADR-056)
 *
 * VERSIONED ARTIFACT ONLY. Updating this file does not modify your site's tag manager or CMS.
 * Before activation, set window.PAID_TOUCH_CONFIG immediately before this script:
 *   { endpoint: 'https://<maxx-host>/api/attribution/paid-touch', token_field_id: '<acuity-field-id>' }
 *
 * The public endpoint records an interaction and returns an opaque signed token. This script never
 * sends a conversion, customer identity, or appointment data. The signed Acuity webhook is the only
 * process allowed to link a token to a real appointment.
 * ========================================================================== */
(function () {
  'use strict';

  // Numeric ids of the hidden Acuity intake fields that receive attribution values. Set them in
  // window.PAID_TOUCH_CONFIG.field_ids on the page; an empty id means "do not write that value".
  var DEFAULT_FIELD_IDS = {
    utm_source:   '',
    utm_medium:   '',
    utm_campaign: '',
    utm_content:  '',
    utm_term:     '',
    fbclid:       '',
    gclid:        '',
    landing_page: '',
    referrer:     ''
  };

  var config = window.PAID_TOUCH_CONFIG || {};
  var FIELD_IDS = {};
  Object.keys(DEFAULT_FIELD_IDS).forEach(function (key) {
    var configured = config.field_ids && typeof config.field_ids[key] === 'string' ? config.field_ids[key].trim() : '';
    FIELD_IDS[key] = /^[0-9]+$/.test(configured) ? configured : DEFAULT_FIELD_IDS[key];
  });
  var PAID_ENDPOINT = typeof config.endpoint === 'string' ? config.endpoint.trim() : '';
  var PAID_TOKEN_FIELD_ID = typeof config.token_field_id === 'string'
    ? config.token_field_id.trim()
    : String(config.token_field_id || '').trim();
  var ATTR_STORE = 'maxx_attribution';
  var PAID_STORE = 'paid_touch_state';
  var COOKIE_DAYS = 90;
  var ANONYMOUS_EVIDENCE_REUSE_MS = 30 * 60 * 1000;
  var SCHEDULER_HOST = /(^|\.)example-studio\.as\.me$|(^|\.)acuityscheduling\.com$|(^|\.)squarespacescheduling\.com$/i;
  var ATTR_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'];
  var META_ID_KEYS = ['meta_campaign_id', 'meta_adset_id', 'meta_ad_id'];
  var TOKEN_RE = /^pt1\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/i;

  function readCookie(name) {
    var match = document.cookie.match('(?:^|; )' + name + '=([^;]*)');
    try { return match ? JSON.parse(decodeURIComponent(match[1])) : null; } catch { return null; }
  }
  function writeCookie(name, value) {
    var expires = new Date();
    expires.setTime(expires.getTime() + COOKIE_DAYS * 864e5);
    document.cookie = name + '=' + encodeURIComponent(JSON.stringify(value)) +
      ';expires=' + expires.toUTCString() + ';path=/;SameSite=Lax;Secure';
  }
  function readStore(name) {
    try {
      var stored = window.localStorage.getItem(name);
      if (stored) return JSON.parse(stored);
    } catch { /* storage blocked; use cookie */ }
    return readCookie(name);
  }
  function writeStore(name, value) {
    try { window.localStorage.setItem(name, JSON.stringify(value)); } catch { /* cookie fallback */ }
    writeCookie(name, value);
  }

  function cleanText(value, max) {
    if (typeof value !== 'string') return null;
    var trimmed = value.trim();
    if (!trimmed || trimmed.length > max || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
    return trimmed;
  }
  function cleanMetaId(value) {
    var cleaned = cleanText(value, 32);
    return cleaned && /^\d{1,32}$/.test(cleaned) ? cleaned : null;
  }
  function httpsUrl(value, keepQuery) {
    try {
      var url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password) return null;
      url.hash = '';
      if (!keepQuery) url.search = '';
      var normalized = url.toString();
      return normalized.length <= 2048 ? normalized : null;
    } catch { return null; }
  }

  // Readable attribution remains last-non-direct. Paid acquisition/optimization lineage is separate:
  // the server token chain retains first and last paid touches without rewriting either observation.
  function resolveReadableAttribution() {
    var stored = readStore(ATTR_STORE) || {};
    var query = new URLSearchParams(location.search);
    var incoming = {};
    var sawAny = false;
    ATTR_KEYS.forEach(function (key) {
      var value = cleanText(query.get(key), key === 'fbclid' || key === 'gclid' ? 1024 : 512);
      if (value) { incoming[key] = value; sawAny = true; }
    });
    if (!sawAny) return stored;
    incoming.landing_page = httpsUrl(location.href, true) || '';
    incoming.referrer = httpsUrl(document.referrer, false) || '';
    writeStore(ATTR_STORE, incoming);
    return incoming;
  }

  function paidEvidence() {
    var query = new URLSearchParams(location.search);
    var source = (cleanText(query.get('utm_source'), 32) || '').toLowerCase();
    var medium = (cleanText(query.get('utm_medium'), 32) || '').toLowerCase();
    if (['meta', 'facebook', 'instagram'].indexOf(source) === -1 || medium !== 'paid_social') return null;

    var fbclid = cleanText(query.get('fbclid'), 1024);
    var ids = {};
    META_ID_KEYS.forEach(function (key) { ids[key] = cleanMetaId(query.get(key)); });
    if (!fbclid && !ids.meta_campaign_id && !ids.meta_adset_id && !ids.meta_ad_id) return null;
    var landing = httpsUrl(location.href, true);
    if (!landing) return null;

    return {
      source: 'meta',
      fbclid: fbclid,
      meta_campaign_id: ids.meta_campaign_id,
      meta_adset_id: ids.meta_adset_id,
      meta_ad_id: ids.meta_ad_id,
      utm_source: source,
      utm_medium: 'paid_social',
      utm_campaign: cleanText(query.get('utm_campaign'), 512),
      utm_content: cleanText(query.get('utm_content'), 512),
      utm_term: cleanText(query.get('utm_term'), 512),
      landing_url: landing,
      referrer_url: httpsUrl(document.referrer, false)
    };
  }

  function usableToken(state) {
    if (!state || state.pending || !TOKEN_RE.test(String(state.token || ''))) return null;
    var expires = new Date(state.expires_at || '').getTime();
    return Number.isFinite(expires) && expires > Date.now() ? String(state.token) : null;
  }
  function newCaptureId() {
    var cryptoApi = window.crypto || (typeof crypto !== 'undefined' ? crypto : null);
    return cryptoApi && typeof cryptoApi.randomUUID === 'function' ? cryptoApi.randomUUID() : null;
  }
  function captureEvidenceKey(evidence) {
    return JSON.stringify({
      source: evidence.source,
      fbclid: evidence.fbclid,
      meta_campaign_id: evidence.meta_campaign_id,
      meta_adset_id: evidence.meta_adset_id,
      meta_ad_id: evidence.meta_ad_id,
      utm_source: evidence.utm_source,
      utm_medium: evidence.utm_medium,
      utm_campaign: evidence.utm_campaign,
      utm_content: evidence.utm_content,
      utm_term: evidence.utm_term
    });
  }
  function captureConfigured() {
    if (!/^\d+$/.test(PAID_TOKEN_FIELD_ID)) return false;
    try {
      var endpoint = new URL(PAID_ENDPOINT);
      return endpoint.protocol === 'https:' && endpoint.toString() === PAID_ENDPOINT;
    } catch { return false; }
  }

  var readable = resolveReadableAttribution();
  var paidState = readStore(PAID_STORE) || {};
  var activePaidToken = usableToken(paidState);
  var evidence = paidEvidence();
  var schedulerAckInFlight = false;

  function fieldValues() {
    var values = {};
    Object.keys(FIELD_IDS).forEach(function (key) {
      var fieldId = FIELD_IDS[key];
      var value = readable[key];
      if (fieldId && value) values[fieldId] = value;
    });
    if (activePaidToken && /^\d+$/.test(PAID_TOKEN_FIELD_ID)) {
      values[PAID_TOKEN_FIELD_ID] = activePaidToken;
    }
    return values;
  }
  function isScheduler(url) {
    try { return SCHEDULER_HOST.test(new URL(url, location.href).hostname); } catch { return false; }
  }
  function decorateUrl(raw, values) {
    try {
      var url = new URL(raw, location.href);
      Object.keys(values).forEach(function (fieldId) {
        var key = 'field:' + fieldId;
        if (!url.searchParams.has(key)) url.searchParams.set(key, values[fieldId]);
      });
      return url.toString().replace(/field%3A/g, 'field:');
    } catch { return raw; }
  }
  function decorate() {
    var values = fieldValues();
    if (Object.keys(values).length === 0) return 0;
    var schedulerSurfacesWithToken = 0;
    var iframes = document.querySelectorAll('iframe');
    for (var i = 0; i < iframes.length; i++) {
      var src = iframes[i].getAttribute('src') || '';
      if (src && isScheduler(src)) {
        var decorated = decorateUrl(src, values);
        if (decorated !== src) iframes[i].setAttribute('src', decorated);
        if (activePaidToken && decorated.indexOf('field:' + PAID_TOKEN_FIELD_ID + '=') !== -1) {
          schedulerSurfacesWithToken += 1;
        }
      }
    }
    var links = document.querySelectorAll('a[href]');
    for (var j = 0; j < links.length; j++) {
      var href = links[j].getAttribute('href') || '';
      if (href && isScheduler(href)) {
        var decoratedHref = decorateUrl(href, values);
        if (decoratedHref !== href) links[j].setAttribute('href', decoratedHref);
        if (activePaidToken && decoratedHref.indexOf('field:' + PAID_TOKEN_FIELD_ID + '=') !== -1) {
          schedulerSurfacesWithToken += 1;
        }
      }
    }
    return schedulerSurfacesWithToken;
  }

  function acknowledgeSchedulerDelivery(surfaceCount) {
    if (!surfaceCount || schedulerAckInFlight || paidState.scheduler_acknowledged ||
        !paidState.capture_id || !activePaidToken || !captureConfigured()) return;
    schedulerAckInFlight = true;
    fetch(PAID_ENDPOINT, {
      method: 'PATCH',
      mode: 'cors',
      credentials: 'omit',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capture_id: paidState.capture_id,
        token: activePaidToken,
        delivery_status: 'scheduler_decorated'
      })
    }).then(function (response) {
      if (!response || !response.ok) throw new Error('scheduler acknowledgement rejected');
      paidState.scheduler_acknowledged = true;
      writeStore(PAID_STORE, paidState);
    }).catch(function () {
      // Keep the acknowledgement pending. A later DOM/load pass retries without unlocking evidence.
    }).then(function () { schedulerAckInFlight = false; });
  }

  // A newly observed paid click invalidates the older token for decoration until the new observation
  // commits. If capture fails, no token is attached rather than misattributing the booking backwards.
  if (evidence) {
    var evidenceKey = captureEvidenceKey(evidence);
    var validOldToken = usableToken({ token: paidState.token, expires_at: paidState.expires_at, pending: null });
    var capturedAt = new Date(paidState.captured_at || '').getTime();
    var sameResolvedClick = validOldToken && !paidState.pending && paidState.evidence_key === evidenceKey &&
      (evidence.fbclid || (Number.isFinite(capturedAt) && Date.now() - capturedAt < ANONYMOUS_EVIDENCE_REUSE_MS));
    var pending = null;

    if (sameResolvedClick) {
      activePaidToken = validOldToken;
    } else {
      activePaidToken = null;
      pending = paidState.pending && paidState.pending.evidence_key === evidenceKey
        ? paidState.pending
        : {
            capture_id: newCaptureId(),
            evidence_key: evidenceKey,
            previous_token: validOldToken
          };
      paidState = {
        token: validOldToken,
        expires_at: validOldToken ? paidState.expires_at : null,
        evidence_key: paidState.evidence_key || null,
        captured_at: paidState.captured_at || null,
        pending: pending
      };
      writeStore(PAID_STORE, paidState);
    }

    if (pending && pending.capture_id && captureConfigured()) {
      var requestBody = Object.assign({}, evidence, {
        capture_id: pending.capture_id,
        previous_token: pending.previous_token || null
      });
      fetch(PAID_ENDPOINT, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }).then(function (response) {
        if (!response || !response.ok) throw new Error('capture rejected');
        return response.json();
      }).then(function (body) {
        var data = body && body.data;
        var expiresMs = data ? new Date(data.expires_at || '').getTime() : NaN;
        var maxExpiry = Date.now() + 91 * 864e5;
        if (!data || body.conversion_sent !== false || typeof data.identity_complete !== 'boolean' ||
            !TOKEN_RE.test(String(data.token || '')) || !Number.isFinite(expiresMs) ||
            expiresMs <= Date.now() || expiresMs > maxExpiry) {
          throw new Error('invalid capture response');
        }
        paidState = {
          token: data.token,
          expires_at: data.expires_at,
          capture_id: pending.capture_id,
          evidence_key: evidenceKey,
          captured_at: new Date().toISOString(),
          scheduler_acknowledged: false,
          pending: null
        };
        activePaidToken = data.token;
        writeStore(PAID_STORE, paidState);
        acknowledgeSchedulerDelivery(decorate());
      }).catch(function () {
        // Keep the stable pending capture id and predecessor for a retry; stale attribution stays blocked.
      });
    }
  }

  function run() { acknowledgeSchedulerDelivery(decorate()); }
  run();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  window.addEventListener('load', run);
  if (window.MutationObserver) {
    var observer = new window.MutationObserver(function () { run(); });
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href']
    });
    setTimeout(function () { observer.disconnect(); }, 30000);
  }
})();
