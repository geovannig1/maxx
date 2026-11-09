import { accountLocale, accountTimezone } from './business-config'

// The short on-screen name of the business timezone: screens label dates and windows
// with it instead of a hard-coded "ET". Client-safe.
//
// Intl's generic short name ("ET", "CT", "AET", "MEZ") does not change with daylight saving, so a window
// that spans a clock change keeps one label and the server and browser renders agree. Where the locale
// has no compact generic name (en-US gives "Germany Time" for Berlin), the IANA id is shown
// instead: unambiguous and still stable across daylight saving.

const UTC_ZONES = new Set(['UTC', 'Etc/UTC', 'Etc/GMT', 'GMT'])

/** PURE. The short label for `timezone` in `locale`. */
export function timezoneShortName(timezone: string, locale: string): string {
  if (UTC_ZONES.has(timezone)) return 'UTC'
  try {
    const generic = new Intl.DateTimeFormat(locale, { timeZone: timezone, timeZoneName: 'shortGeneric' })
      .formatToParts(new Date(0))
      .find((part) => part.type === 'timeZoneName')?.value
    return generic && !/\s/.test(generic) ? generic : timezone
  } catch {
    return timezone
  }
}

/** The configured business timezone's short label, e.g. "ET" for the US Eastern zone in en-US. */
export function accountTimezoneShortName(): string {
  return timezoneShortName(accountTimezone(), accountLocale())
}
