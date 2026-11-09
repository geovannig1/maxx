// Sanity ceiling for one outcome's money: a value above it is a sender bug or an attack, not a
// sale. Webhook and CSV ingest refuse it with a 4xx, and no Conversions API event ever carries it.
// OUTCOME_MONEY_CEILING (major units of the account currency) overrides the default; an unusable
// setting falls back to the default rather than lifting the ceiling.

export const DEFAULT_OUTCOME_MONEY_CEILING = 1_000_000_000

export function outcomeMoneyCeiling(env: Record<string, string | undefined> = process.env): number {
  const raw = env.OUTCOME_MONEY_CEILING?.trim()
  const value = raw ? Number(raw) : Number.NaN
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_OUTCOME_MONEY_CEILING
}

/** true when `value` (an exact decimal string or a number) is a finite amount above the ceiling. A
 *  null/absent value is "not observed" and never exceeds it. */
export function exceedsOutcomeMoneyCeiling(
  value: string | number | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (value === null || value === undefined || value === '') return false
  const amount = typeof value === 'number' ? value : Number(value)
  return !Number.isFinite(amount) || amount > outcomeMoneyCeiling(env)
}
