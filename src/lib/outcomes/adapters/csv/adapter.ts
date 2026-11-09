import type { OutcomeSourceAdapter } from '@/lib/outcomes/adapter'

/**
 * The CSV import (ADR-058, the v1 release): the owner uploads a file on the import screen. Neither
 * push nor pull: nothing calls in and Maxx never fetches. Rows carry no attribution token, and the
 * origin a row states is recorded but not observed (`originKnown: false`), so:
 *   - a CSV outcome is never sent to an ad platform (src/lib/conversions/outcome-conversions.ts), and
 *   - an enabled CSV source makes every paid cohort incomplete with `source_cannot_carry_token`
 *     (src/lib/attribution/paid-cohort.ts), so it can never unlock money authority by being left
 *     out of the linkage denominator.
 * The file format is in ./contract.ts.
 */
export const csvAdapter: OutcomeSourceAdapter = {
  kind: 'csv',
  capabilities: {
    pull: false,
    push: false,
    backfill: false,
    carriesToken: false,
    originKnown: false,
    collectedValue: true,
    platformNativeEvents: [],
  },
  validateConfig(_env, config) {
    const keys = Object.keys(config)
    return keys.length === 0 ? { ok: true, value: undefined } : { ok: false, reason: `unknown config keys: ${keys.join(', ')}` }
  },
  async health() {
    return { configured: true, detail: 'Owner upload on the import screen; no credentials.' }
  },
}
