import { listOutcomeAdapters } from './registry'
import { LEGACY_MONEY_VOCABULARY } from './legacy-money-keys'
import { LEGACY_WEBSITE_METRIC_VOCABULARY } from '@/lib/reporting/legacy-website-keys'
import { isIsoCurrency } from '@/config/business-config'
import { fromMinorUnits } from '@/lib/utils/format-currency'

/**
 * Names an adapter's source once lent to shared, persisted vocabulary (keys, claim systems, evidence
 * planes, metric keys, blocker codes), and their source-neutral replacements. The shipped schema writes
 * only the new vocabulary; a stored document that still carries the old one (fingerprinted reporting
 * snapshots and saved reports keep their bytes) is upgraded when read, after its integrity is verified.
 */
export interface LegacyVocabulary {
  /** Whole tokens (a key or a whole string value). */
  exact: Readonly<Record<string, string>>
  /** Token prefixes, longest first. */
  prefixes: ReadonlyArray<readonly [from: string, to: string]>
  /** Qualifier prefixes (`<source>:<code>`): the prefix is replaced and the remainder upgraded too. */
  qualifiers?: ReadonlyArray<readonly [from: string, to: string]>
  /** The capitalized word inside camelCase identifiers, and its replacement (fooXBar -> fooYBar, xBar -> yBar). */
  identifierWord?: readonly [from: string, to: string]
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*$/

/** PURE. One token under one vocabulary, or the token unchanged. */
export function upgradeLegacyToken(token: string, vocabulary: LegacyVocabulary): string {
  const exact = vocabulary.exact[token]
  if (exact !== undefined) return exact
  for (const [from, to] of vocabulary.qualifiers ?? []) {
    if (token.startsWith(from)) return to + upgradeLegacyToken(token.slice(from.length), vocabulary)
  }
  for (const [from, to] of vocabulary.prefixes) if (token.startsWith(from)) return to + token.slice(from.length)
  const word = vocabulary.identifierWord
  if (word && IDENTIFIER.test(token)) {
    const [from, to] = word
    const lowerFrom = from[0].toLowerCase() + from.slice(1)
    const lowerTo = to[0].toLowerCase() + to.slice(1)
    if (/^[a-z]/.test(token) && token.includes(from)) return token.split(from).join(to)
    if (token.startsWith(lowerFrom) && /^[A-Z]/.test(token.slice(lowerFrom.length))) return lowerTo + token.slice(lowerFrom.length)
  }
  return token
}

function vocabularies(): LegacyVocabulary[] {
  // Core money keys once named after one currency, website event-card keys once named after one
  // business's GA4 events, then each adapter's source vocabulary.
  return [LEGACY_MONEY_VOCABULARY, LEGACY_WEBSITE_METRIC_VOCABULARY, ...listOutcomeAdapters().flatMap((adapter) => adapter.legacyVocabulary ? [adapter.legacyVocabulary] : [])]
}

/** Packets written before the v1 release keyed a budget amount's major units `usd` beside `minorUnits`. */
export const LEGACY_BUDGET_AMOUNT_KEY = 'usd'
export const BUDGET_AMOUNT_KEY = 'majorUnits'

/** Whether an object is a legacy budget amount: `minorUnits` beside `usd` (and no current key). */
export function isLegacyBudgetAmount(value: Record<string, unknown>): boolean {
  return Object.hasOwn(value, 'minorUnits') && Object.hasOwn(value, LEGACY_BUDGET_AMOUNT_KEY)
    && !Object.hasOwn(value, BUDGET_AMOUNT_KEY)
}

/** The ISO currency an object states for its subtree: a report packet's `context.currency`. */
function scopeCurrency(value: Record<string, unknown>): string | null {
  const context = value.context
  if (context === null || typeof context !== 'object' || Array.isArray(context)) return null
  const currency = (context as Record<string, unknown>).currency
  return isIsoCurrency(currency) ? currency : null
}

/**
 * The major-unit amount of a legacy budget amount. Before the v1 release the writer stored `minorUnits / 100` for
 * every currency, which is wrong for JPY (0 digits) or KWD (3). `minorUnits` is exact, so an amount that
 * is exactly that old computation is recomputed in the packet currency. Anything else, or an amount with
 * no packet currency in scope, is kept as stored, so validation still refuses a value that was wrong.
 */
function legacyMajorUnits(amount: Record<string, unknown>, stored: unknown, currency: string | null): unknown {
  const minor = amount.minorUnits
  if (currency === null || typeof minor !== 'number' || !Number.isSafeInteger(minor) || stored !== minor / 100) return stored
  return fromMinorUnits(minor, currency)
}

/** PURE over its input. A copy of a JSON value with every legacy key and string token upgraded. */
export function upgradeLegacyVocabulary<T>(value: T, list: readonly LegacyVocabulary[] = vocabularies()): T {
  const token = (s: string) => list.reduce((acc, vocabulary) => upgradeLegacyToken(acc, vocabulary), s)
  const walk = (v: unknown, currency: string | null): unknown => {
    if (typeof v === 'string') return token(v)
    if (Array.isArray(v)) return v.map((item) => walk(item, currency))
    if (v !== null && typeof v === 'object') {
      const record = v as Record<string, unknown>
      const inScope = scopeCurrency(record) ?? currency
      // Core rule: a budget amount's major units are no longer keyed 'usd'. Only that key, only
      // beside `minorUnits`, is renamed in place, with key order preserved; its value is recomputed in
      // the packet currency when it was the old minorUnits / 100.
      const budgetAmount = isLegacyBudgetAmount(record)
      return Object.fromEntries(Object.entries(record).map(([k, entry]) =>
        budgetAmount && k === LEGACY_BUDGET_AMOUNT_KEY
          ? [BUDGET_AMOUNT_KEY, legacyMajorUnits(record, entry, inScope)]
          // Core rule (currency): the money unit is the account currency, no longer named 'usd'.
          : [token(k), k === 'unit' && entry === 'usd' ? 'money' : walk(entry, inScope)]))
    }
    return v
  }
  return walk(value, null) as T
}
