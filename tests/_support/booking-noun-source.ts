// text builders now name outcomes through the noun helper (`${OW.many}` ...). Tests that pin a
// builder's SOURCE text read it as a business that calls its outcomes bookings, like the tests that
// pin rendered text (tests/_support/outcome-noun-booking.ts).
const FORMS: Array<[RegExp, string]> = [
  [/\$\{withIndefiniteArticle\(OW\.one\)\.replace\(\/\^a\/, 'A'\)\}/g, 'A booking'],
  [/\$\{withIndefiniteArticle\(OW\.one\)\}/g, 'a booking'],
  [/\$\{OW\.many\.toUpperCase\(\)\}/g, 'BOOKINGS'],
  [/\$\{OW\.one\.toUpperCase\(\)\}/g, 'BOOKING'],
  [/\$\{OW\.Many\}/g, 'Bookings'],
  [/\$\{OW\.One\}/g, 'Booking'],
  [/\$\{OW\.many\}/g, 'bookings'],
  [/\$\{OW\.one\}/g, 'booking'],
]

/** Source text with every outcome-noun placeholder written as "booking/bookings". */
export function withBookingNouns(source: string): string {
  return FORMS.reduce((text, [pattern, word]) => text.replace(pattern, word), source)
}
