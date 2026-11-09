// screen tests import this first to run as a business that calls its outcomes bookings
// (NEXT_PUBLIC_OUTCOME_NOUN), so their pinned text keeps its meaning. The default wording (outcome/outcomes)
// is covered by tests/ui-outcome-wording.test.ts and tests/outcome-nouns.test.ts.
process.env.NEXT_PUBLIC_OUTCOME_NOUN = 'booking/bookings'
export {}
