/**
 * Reading structure out of ad names.
 *
 * At a small account's spend, no single ad reaches a sample size worth a verdict — a dozen ads can share
 * most of the spend. But the names encode real structure (`Cold | Open Space C | April 2026 (7d)`), so
 * grouping by audience and creative concept turns a scatter of thin rows into a handful of
 * comparable ones. That is the practical fix for thin data, and it is how creative-analytics
 * tools present ads: the asset is the row, not the ad ID.
 *
 * FAIL SOFT, NEVER INFER. Legacy names (`legacy-ad-2`, `spring-promo-2026`)
 * and carry no structure. They are reported as `Unparsed` and shown as themselves. Guessing an
 * audience from a name that does not declare one would put a fabricated dimension on the page.
 *
 * TENANT-CONFIGURABLE. The separator and vocabulary are config with a safe default rather than a
 * hardcoded regex, so a second advertiser with a different convention is a config change.
 */

export interface AdNameTaxonomyConfig {
  /** Segment separator. Default `|`. */
  separator: string
  /** Minimum segments before a name is considered structured at all. */
  minSegments: number
  /**
   * Known audience labels, used only to normalise casing and to order groups.
   * NOT a gate — an unlisted label still parses, so a new tenant is not silently unparsed.
   */
  audienceVocabulary: string[]
}

export const DEFAULT_AD_NAME_TAXONOMY: AdNameTaxonomyConfig = {
  separator: '|',
  minSegments: 3,
  audienceVocabulary: ['Cold', 'Warm', 'Hot', 'Retargeting', 'Prospecting', 'Lookalike', 'Broad'],
}

export const UNPARSED_GROUP = 'Unparsed' as const

export interface AdNameTaxonomy {
  raw: string
  parsed: boolean
  audience: string | null
  concept: string | null
  cohort: string | null
  /** The attribution window baked into the name, e.g. `7d`. Descriptive only. */
  attributionWindow: string | null
  /** Trailing parentheticals that are not an attribution window, e.g. `ADR-056 tagged`. */
  annotations: string[]
  /**
   * Stable key for aggregation. Deliberately excludes cohort, window and annotations so a creative
   * relaunched as `... (ADR-056 tagged)` groups with its original rather than splitting the sample
   * in half — which would defeat the point of grouping.
   */
  groupKey: string
}

const PARENTHETICAL = /\(([^()]*)\)/g
const ATTRIBUTION_WINDOW = /^\d+\s*d$/i

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()
}

function normaliseAudience(value: string, vocabulary: readonly string[]): string {
  const match = vocabulary.find((known) => known.toLowerCase() === value.toLowerCase())
  return match ?? titleCase(value)
}

export function parseAdName(
  rawName: string,
  config: AdNameTaxonomyConfig = DEFAULT_AD_NAME_TAXONOMY,
): AdNameTaxonomy {
  const raw = (rawName ?? '').trim()
  const unparsed: AdNameTaxonomy = {
    raw, parsed: false, audience: null, concept: null, cohort: null,
    attributionWindow: null, annotations: [], groupKey: UNPARSED_GROUP,
  }
  if (raw === '') return unparsed

  const segments = raw.split(config.separator).map((s) => s.trim()).filter((s) => s !== '')
  if (segments.length < config.minSegments) return unparsed

  const [audienceRaw, conceptRaw, ...tail] = segments
  const trailer = tail.join(` ${config.separator} `)

  const parentheticals: string[] = []
  let attributionWindow: string | null = null
  const cohort = trailer.replace(PARENTHETICAL, (_match, inner: string) => {
    const value = inner.trim()
    if (attributionWindow === null && ATTRIBUTION_WINDOW.test(value)) attributionWindow = value.toLowerCase().replace(/\s+/g, '')
    else if (value !== '') parentheticals.push(value)
    return ''
  }).replace(/\s+/g, ' ').trim()

  const audience = normaliseAudience(audienceRaw, config.audienceVocabulary)
  const concept = conceptRaw.trim()
  if (concept === '') return unparsed

  return {
    raw,
    parsed: true,
    audience,
    concept,
    cohort: cohort === '' ? null : cohort,
    attributionWindow,
    annotations: parentheticals,
    groupKey: `${audience} ${config.separator} ${concept}`,
  }
}

export interface AdNameGroup<T> {
  groupKey: string
  audience: string | null
  concept: string | null
  parsed: boolean
  members: T[]
}

/** Group rows by `groupKey`, keeping every unparsed row visible in a single honest bucket. */
export function groupByAdName<T>(
  rows: readonly T[],
  nameOf: (row: T) => string,
  config: AdNameTaxonomyConfig = DEFAULT_AD_NAME_TAXONOMY,
): AdNameGroup<T>[] {
  const groups = new Map<string, AdNameGroup<T>>()
  for (const row of rows) {
    const taxonomy = parseAdName(nameOf(row), config)
    const existing = groups.get(taxonomy.groupKey)
    if (existing) { existing.members.push(row); continue }
    groups.set(taxonomy.groupKey, {
      groupKey: taxonomy.groupKey,
      audience: taxonomy.audience,
      concept: taxonomy.concept,
      parsed: taxonomy.parsed,
      members: [row],
    })
  }
  // Parsed groups first, then by audience vocabulary order, then concept. Unparsed always last —
  // it is a residue bucket, not a finding.
  const order = (audience: string | null) => {
    const index = config.audienceVocabulary.findIndex((a) => a === audience)
    return index === -1 ? config.audienceVocabulary.length : index
  }
  return [...groups.values()].sort((a, b) => {
    if (a.parsed !== b.parsed) return a.parsed ? -1 : 1
    if (!a.parsed) return 0
    const byAudience = order(a.audience) - order(b.audience)
    return byAudience !== 0 ? byAudience : (a.concept ?? '').localeCompare(b.concept ?? '')
  })
}
