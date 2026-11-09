/* Example Studio — canonical Acuity browser confirmation listener.
 * Deploy as the GTM Custom HTML tag `cHTML - Acuity Form Listener`.
 * Acuity runs the custom conversion code in its nested confirmation frame and
 * posts to window.top, so the trusted boundary is the exact documented frame
 * origin plus a strict payload contract. The nested sender is not the public
 * scheduler iframe's contentWindow.
 */
(function () {
  'use strict';

  var TRUSTED_ORIGIN = 'https://conversion-tracking-sandbox.acuityinnovation.com';
  var MAX_APPOINTMENT_ID_LENGTH = 15;
  var MAX_PRICE = 100000;
  var firedAppointmentIds = Object.create(null);

  function parsePrice(rawPrice) {
    var value;
    if (typeof rawPrice === 'number') {
      value = rawPrice;
    } else if (typeof rawPrice === 'string') {
      var text = rawPrice.trim();
      var validPrice = /^\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/;
      if (!validPrice.test(text)) return null;
      value = Number(text.replace(/[$,]/g, ''));
    } else {
      return null;
    }

    if (!Number.isFinite(value) || value < 0 || value > MAX_PRICE) return null;
    return value;
  }

  function parseAppointmentId(rawId) {
    // The two representations used to be validated by DIFFERENT rules. The numeric branch
    // checked only safe-integer/positive and never applied MAX_APPOINTMENT_ID_LENGTH, so 16-digit
    // 1234567890123456 (a safe integer) was accepted while the identical string was rejected. The same
    // ID must pass or fail identically however Acuity happens to type it — so NORMALIZE first, then
    // apply one contract to the normalized string.
    var normalized;
    if (typeof rawId === 'number') {
      if (!Number.isSafeInteger(rawId) || rawId <= 0) return null;
      normalized = String(rawId);
    } else if (typeof rawId === 'string') {
      normalized = rawId;
    } else {
      return null;
    }

    // ONE digit/length contract, applied to the normalized string in both cases.
    var validId = new RegExp('^\\d{1,' + MAX_APPOINTMENT_ID_LENGTH + '}$');
    if (!validId.test(normalized)) return null;

    // Leading zeros are cosmetic; strip them AFTER the length check so "0000000000000001" cannot buy
    // itself extra digits by padding.
    var appointmentId = normalized.replace(/^0+/, '');
    if (!appointmentId) return null;

    return appointmentId;
  }

  function categoryFor(appointmentType) {
    var normalized = appointmentType.toLowerCase();
    if (normalized.indexOf('session') !== -1 || normalized.indexOf('mini') !== -1) {
      return 'Photoshoot';
    }
    if (normalized.indexOf('rental') !== -1) return 'Rental';
    if (normalized.indexOf('event') !== -1) return 'Event';
    if (normalized.indexOf('membership') !== -1) return 'Membership';
    return 'Unknown';
  }

  function parseConfirmation(rawData) {
    if (typeof rawData !== 'string') return null;

    var data;
    try {
      data = JSON.parse(rawData);
    } catch {
      // Optional catch binding — the error is deliberately unused; malformed JSON is simply not ours.
      return null;
    }

    if (!data || data.event !== 'AcuityEvent' || data.Type !== 'appointment') return null;

    var appointmentId = parseAppointmentId(data.ID);
    if (!appointmentId) return null;

    var appointmentTypeRaw = String(
      data.AppointmentType == null ? '' : data.AppointmentType,
    ).replace(/\s+/g, ' ').trim();
    if (!appointmentTypeRaw || appointmentTypeRaw.length > 300) return null;

    var value = parsePrice(data.Price);
    if (value == null) return null;

    var appointmentTypeClean = appointmentTypeRaw
      .split('+')[0]
      .replace(/\u2013/g, '-')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      appointmentId: appointmentId,
      appointmentTypeRaw: appointmentTypeRaw,
      appointmentTypeClean: appointmentTypeClean,
      packageCategory: categoryFor(appointmentTypeClean),
      value: value,
    };
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== TRUSTED_ORIGIN) return;

    var confirmation = parseConfirmation(event.data);
    if (!confirmation || firedAppointmentIds[confirmation.appointmentId]) return;
    firedAppointmentIds[confirmation.appointmentId] = true;

    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event: 'scheduler_booking_confirmed',
      acuity_id: confirmation.appointmentId,
      appointment_id: confirmation.appointmentId,
      event_id: 'acuity-' + confirmation.appointmentId,
      appointment_type_raw: confirmation.appointmentTypeRaw,
      appointment_type_clean: confirmation.appointmentTypeClean,
      package_category: confirmation.packageCategory,
      value: confirmation.value,
      currency: 'USD',
    });
  }, false);
})();
