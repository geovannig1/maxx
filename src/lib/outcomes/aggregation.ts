import { accountCurrency } from '@/config/business-config'

/**
 * Aggregation rules across outcome sources. Every reader of `v_business_outcomes`/`outcomes`
 * follows them; tests/db/outcome-per-source-readers-db.test.ts enforces them on the shipped schema.
 *
 * 1. Population: only outcomes of the account's ENABLED sources (`source_enabled`). A disabled
 *    source's rows are stored but counted nowhere.
 * 2. Counts sum across sources. Sources are treated as disjoint: the same real-world result reported
 *    by two sources is two outcomes (there is no cross-source identity to deduplicate on).
 * 3. Money sums only within ONE currency, the account currency. An outcome in any other currency makes
 *    the read fail with `outcome_currency_mismatch`; totals are refused, never converted or mixed.
 *    NULL stays "not observed" and never becomes 0 (src/lib/outcomes/facts.ts).
 * 4. Identity is the outcome uuid. A source's own id (`external_id`) is interpreted only by that
 *    source's adapter: no reader applies one source's id format (a numeric appointment id) to another.
 * 5. Completeness: every enabled reconciled source must prove the window (source-health.ts); push-only
 *    sources count as received and are named `push_as_received`. No enabled source is
 *    `no_outcome_source`, never zero.
 * 6. Source-specific diagnostics (a reconciliation's missed-webhook count, its conversion sweep) count
 *    only that source's rows.
 */

export class OutcomeCurrencyError extends Error {
  constructor(readonly currencies: string[], readonly expected: string) {
    super('outcome_currency_mismatch')
    this.name = 'OutcomeCurrencyError'
  }
}

const KNOWN_READ_CODE = /^(no_outcome_source|outcome_currency_mismatch|outcome_source_unsupported:[a-z]+|outcome_sources_read_failed|[a-z]+_ledger_[a-z_]+)/

/** A domain-authored reason code from an outcome read (it carries no database text), or null. */
export function knownOutcomeReadCode(error: unknown): string | null {
  return error instanceof Error ? KNOWN_READ_CODE.exec(error.message)?.[0] ?? null : null
}

/** Rule 3. Throws `outcome_currency_mismatch` unless every row is in `expected` (the account currency). */
export function requireOutcomeCurrency(
  rows: ReadonlyArray<{ currency?: string | null }>,
  expected: string = accountCurrency(),
): string {
  const found = [...new Set(rows.map((r) => (r.currency ?? '').trim()))]
  const foreign = found.filter((c) => c !== expected)
  if (foreign.length > 0) throw new OutcomeCurrencyError(found.sort(), expected)
  return expected
}
