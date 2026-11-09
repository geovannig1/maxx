// Shared GA4 mock helpers for the stress suite. Pure builders — NO network, NO real client.
// The leading-underscore dir keeps this outside vitest's `include: ['tests/**/*.test.ts']`,
// so it's imported by tests but never executed as a test file.

/** Build a GA4 `runReport` response from simple rows. Each row carries dimension + metric values
 *  in the order the query requests them. The GA4 client coerces values via Number(), so strings are fine.
 *
 *  `rowCount` and `metadata` are included because the REAL API always returns them, and the client now
 *  refuses a response missing `rowCount` (an absent count must not read as zero) or carrying
 *  `dataLossFromOtherRow` (GA4 preserves metric totals while destroying the dimension). A mock that
 *  omits a field the API always sends is a lie that makes the suite green over inputs production never
 *  produces — which is how nine tests passed against a client that would have thrown in production.
 *  Override either field per test to exercise the refusal paths. */
export function ga4Resp(
  rows: Array<{ dims: string[]; metrics: Array<number | string> }>,
  overrides: { rowCount?: number | null; dataLossFromOtherRow?: boolean } = {},
) {
  return [
    {
      rows: rows.map((r) => ({
        dimensionValues: r.dims.map((v) => ({ value: v })),
        metricValues: r.metrics.map((v) => ({ value: String(v) })),
      })),
      rowCount: overrides.rowCount === undefined ? rows.length : overrides.rowCount,
      metadata: {
        dataLossFromOtherRow: overrides.dataLossFromOtherRow ?? false,
        samplingMetadatas: [],
      },
    },
  ]
}

/** A syntactically-valid but FAKE GA4 service-account JSON. Passes the client's parse + presence
 *  checks; it is never used to authenticate because `@google-analytics/data` is mocked in tests.
 *  This is not a real key and authenticates against nothing. */
export const FAKE_GA4_SA_JSON = JSON.stringify({
  client_email: 'stress-test@example.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nFAKE-NOT-A-REAL-KEY-FOR-TESTS-ONLY\n-----END PRIVATE KEY-----\n',
})
