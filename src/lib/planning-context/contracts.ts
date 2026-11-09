import { createHash } from 'node:crypto'
import { z } from 'zod'

const nonBlank = z.string().trim().min(1).max(4000)
const stableId = z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9._-]*$/)
const nullableNonNegative = z.number().finite().nonnegative().nullable()
export const MAX_GOVERNED_URL_BYTES = 2048
export const MAX_BUSINESS_CONTEXT_BYTES = 24 * 1024
export const MAX_LANDING_PAGE_CONTEXT_BYTES = 16 * 1024
const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength

function normalizedHttpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return null
    }
    url.hash = ''
    const normalized = url.toString()
    return utf8Bytes(normalized) <= MAX_GOVERNED_URL_BYTES ? normalized : null
  } catch {
    return null
  }
}

const httpUrl = z.url().refine((value) => {
  return normalizedHttpUrl(value) != null
}, `URL must use HTTP or HTTPS, contain no credentials, and be at most ${MAX_GOVERNED_URL_BYTES} bytes`)

const secretAssignmentPattern = /\b(?:api[_-]?key|access[_-]?token|password|secret|authorization)\s*[:=]\s*\S+/i
const jwtPattern = /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/
const privateKeyPattern = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i
const credentialedHttpUrlPattern = /https?:\/\/[^\s/:@]+:[^\s/@]+@/i
const sensitiveQueryKeyPattern = /^(?:api[_-]?key|access[_-]?token|token|password|secret|signature|sig|authorization|x-(?:amz|goog)-(?:credential|signature|security-token))$/i
const sensitiveQueryAssignmentPattern = /[?&](?:api[_-]?key|access[_-]?token|token|password|secret|signature|sig|authorization|x-(?:amz|goog)-(?:credential|signature|security-token))=[^\s&#]+/i
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
const phonePattern = /(?:^|[^\d])(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)/
function stringContainsSensitiveData(value: string): boolean {
  if (secretAssignmentPattern.test(value) || jwtPattern.test(value)
    || privateKeyPattern.test(value) || credentialedHttpUrlPattern.test(value)
    || sensitiveQueryAssignmentPattern.test(value)
    || emailPattern.test(value) || phonePattern.test(value)) return true
  try {
    const url = new URL(value)
    return [...url.searchParams.keys()].some((key) => sensitiveQueryKeyPattern.test(key))
  } catch {
    return false
  }
}

export function containsSensitivePlanningContextData(value: unknown): boolean {
  if (typeof value === 'string') return stringContainsSensitiveData(value)
  if (Array.isArray(value)) return value.some(containsSensitivePlanningContextData)
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsSensitivePlanningContextData)
  }
  return false
}

function addDocumentBoundaryIssues(
  value: unknown,
  ctx: z.RefinementCtx,
  maxBytes: number,
  sensitiveScanValue: unknown = value,
): void {
  if (utf8Bytes(JSON.stringify(value)) > maxBytes) {
    ctx.addIssue({ code: 'custom', message: `document exceeds the ${maxBytes}-byte governed limit` })
  }
  if (containsSensitivePlanningContextData(sensitiveScanValue)) {
    ctx.addIssue({
      code: 'custom',
      message: 'planning context must not contain secrets, credential-bearing URLs, or free-text contact data',
    })
  }
}

type CtaKind = 'navigate' | 'form' | 'scheduler' | 'phone' | 'email' | 'download'
const webCtaKindSchema = z.enum(['navigate', 'form', 'scheduler', 'download'])

export function normalizeCtaDestination(kind: CtaKind, input: string): string {
  if (kind !== 'phone' && kind !== 'email') return normalizeCanonicalUrl(input)

  let parsed: URL
  try { parsed = new URL(input) } catch {
    throw new Error(`${kind} CTA destination must be an absolute ${kind === 'phone' ? 'tel:' : 'mailto:'} URI.`)
  }
  const expectedProtocol = kind === 'phone' ? 'tel:' : 'mailto:'
  if (parsed.protocol !== expectedProtocol || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${kind} CTA destination must be a query-free, credential-free ${expectedProtocol} URI.`)
  }

  const target = parsed.pathname.trim()
  let normalized: string
  if (kind === 'phone') {
    const allowedPhoneSyntax = /^\+?[\d().\s-]+$/.test(target)
    const digits = target.replace(/\D/g, '')
    const hasInternationalPrefix = target.startsWith('+')
    if (!allowedPhoneSyntax || digits.length < 7 || digits.length > 15
      || (hasInternationalPrefix && digits.startsWith('0'))) {
      throw new Error('phone CTA destination is malformed.')
    }
    normalized = `tel:${hasInternationalPrefix ? '+' : ''}${digits}`
  } else {
    if (!/^[^@,\s]+@[^@,\s]+\.[^@,\s]+$/.test(target)) {
      throw new Error('email CTA destination is malformed.')
    }
    normalized = parsed.toString()
  }
  if (utf8Bytes(normalized) > MAX_GOVERNED_URL_BYTES) {
    throw new Error(`CTA destination is too long; maximum is ${MAX_GOVERNED_URL_BYTES} UTF-8 bytes.`)
  }
  return normalized
}

const webCtaSchema = z.object({
  label: nonBlank,
  kind: webCtaKindSchema,
  destination: httpUrl.nullable(),
}).strict()

const phoneCtaSchema = z.object({
  label: nonBlank,
  kind: z.literal('phone'),
  destination: z.string(),
}).strict().superRefine((value, ctx) => {
  try {
    normalizeCtaDestination(value.kind, value.destination)
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'CTA destination is invalid.',
      path: ['destination'],
    })
  }
})

const emailCtaSchema = z.object({
  label: nonBlank,
  kind: z.literal('email'),
  destination: z.string(),
}).strict().superRefine((value, ctx) => {
  try {
    normalizeCtaDestination(value.kind, value.destination)
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'CTA destination is invalid.',
      path: ['destination'],
    })
  }
})

const ctaSchema = z.discriminatedUnion('kind', [webCtaSchema, phoneCtaSchema, emailCtaSchema])

const offerSchema = z.object({
  id: stableId,
  name: nonBlank,
  description: nonBlank,
  kind: z.enum(['studio_rental', 'managed_photoshoot', 'seasonal', 'other']),
  status: z.enum(['active', 'paused', 'retired']),
  meta_eligibility: z.enum(['allowed', 'blocked', 'unknown']),
  booking_url: httpUrl.nullable(),
}).strict()

const audienceSchema = z.object({
  id: stableId,
  name: nonBlank,
  stage: z.enum(['awareness', 'consideration', 'lead', 'booking', 'mixed']),
  description: nonBlank,
  offer_ids: z.array(stableId).min(1).max(100),
}).strict()

const claimSchema = z.object({
  id: stableId,
  text: nonBlank,
  source_ref: nonBlank,
  offer_ids: z.array(stableId).min(1).max(100),
}).strict()

const serviceMarketSchema = z.object({
  id: stableId,
  label: nonBlank,
  country_code: z.string().regex(/^[A-Z]{2}$/),
  kind: z.enum(['city', 'region', 'postal_code', 'radius', 'custom']),
  meta_location_key: nonBlank.nullable(),
  radius_miles: z.number().finite().positive().max(100).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'radius' && value.radius_miles == null) {
    ctx.addIssue({ code: 'custom', message: 'radius markets require radius_miles', path: ['radius_miles'] })
  }
  if (value.kind !== 'radius' && value.radius_miles != null) {
    ctx.addIssue({ code: 'custom', message: 'radius_miles is valid only for radius markets', path: ['radius_miles'] })
  }
})

const serviceAreaSchema = z.object({
  status: z.enum(['known', 'unknown']),
  markets: z.array(serviceMarketSchema).max(100),
  notes: nonBlank.nullable(),
}).strict()

const seasonalitySchema = z.object({
  status: z.enum(['known', 'none', 'unknown']),
  periods: z.array(z.object({
    id: stableId,
    label: nonBlank,
    start_date: z.iso.date(),
    end_date: z.iso.date(),
    offer_ids: z.array(stableId).min(1).max(100),
  }).strict()).max(50),
  notes: nonBlank.nullable(),
}).strict()

export const businessContextDocumentV1Schema = z.object({
  schema_version: z.literal(1),
  business: z.object({
    name: nonBlank,
    market: nonBlank,
    timezone: nonBlank,
    currency: z.string().regex(/^[A-Z]{3}$/),
  }).strict(),
  offers: z.array(offerSchema).min(1).max(100),
  audiences: z.array(audienceSchema).max(200),
  approved_claims: z.array(claimSchema).max(500),
  economics: z.object({
    target_cpa: nullableNonNegative,
    max_cpa: nullableNonNegative,
    contribution_margin_percent: z.number().finite().min(0).max(100).nullable(),
    monthly_meta_spend_ceiling: nullableNonNegative,
    basis: nonBlank.nullable(),
  }).strict(),
  service_area: serviceAreaSchema,
  capacity: z.object({
    status: z.enum(['known', 'unknown']),
    weekly_booking_capacity: z.number().int().nonnegative().nullable(),
    notes: nonBlank.nullable(),
  }).strict(),
  seasonality: seasonalitySchema,
  constraints: z.array(z.object({ id: stableId, rule: nonBlank }).strict()).max(200),
}).strict().superRefine((value, ctx) => {
  addDocumentBoundaryIssues(value, ctx, MAX_BUSINESS_CONTEXT_BYTES)
  const target = value.economics.target_cpa
  const max = value.economics.max_cpa
  if (target != null && max != null && target > max) {
    ctx.addIssue({
      code: 'custom',
      message: 'target_cpa must be less than or equal to max_cpa',
      path: ['economics', 'target_cpa'],
    })
  }

  const economicsKnown = [
    value.economics.target_cpa,
    value.economics.max_cpa,
    value.economics.contribution_margin_percent,
    value.economics.monthly_meta_spend_ceiling,
  ].some((metric) => metric != null)
  if (economicsKnown && value.economics.basis == null) {
    ctx.addIssue({
      code: 'custom',
      message: 'known economics require a non-empty provenance basis',
      path: ['economics', 'basis'],
    })
  }

  if (
    (value.capacity.status === 'known' && value.capacity.weekly_booking_capacity == null)
    || (value.capacity.status === 'unknown' && value.capacity.weekly_booking_capacity != null)
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'capacity status and weekly_booking_capacity must agree',
      path: ['capacity', 'weekly_booking_capacity'],
    })
  }

  if (
    (value.service_area.status === 'known' && value.service_area.markets.length === 0)
    || (value.service_area.status === 'unknown' && value.service_area.markets.length !== 0)
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'service-area status and markets must agree',
      path: ['service_area', 'markets'],
    })
  }

  if (
    (value.seasonality.status === 'known' && value.seasonality.periods.length === 0)
    || (value.seasonality.status !== 'known' && value.seasonality.periods.length !== 0)
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'seasonality status and periods must agree',
      path: ['seasonality', 'periods'],
    })
  }

  const offerIds = new Set(value.offers.map((offer) => offer.id))
  if (offerIds.size !== value.offers.length) {
    ctx.addIssue({ code: 'custom', message: 'offer ids must be unique', path: ['offers'] })
  }
  for (const [label, ids] of [
    ['audience', value.audiences.map((audience) => audience.id)],
    ['claim', value.approved_claims.map((claim) => claim.id)],
    ['constraint', value.constraints.map((constraint) => constraint.id)],
    ['service area', value.service_area.markets.map((market) => market.id)],
    ['seasonality period', value.seasonality.periods.map((period) => period.id)],
  ] as const) {
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', message: `${label} ids must be unique`, path: [`${label}s`] })
    }
  }
  for (const [index, audience] of value.audiences.entries()) {
    for (const offerId of audience.offer_ids) {
      if (!offerIds.has(offerId)) {
        ctx.addIssue({
          code: 'custom',
          message: `audience references unknown offer ${offerId}`,
          path: ['audiences', index, 'offer_ids'],
        })
      }
    }
  }
  for (const [index, claim] of value.approved_claims.entries()) {
    for (const offerId of claim.offer_ids) {
      if (!offerIds.has(offerId)) {
        ctx.addIssue({
          code: 'custom',
          message: `claim references unknown offer ${offerId}`,
          path: ['approved_claims', index, 'offer_ids'],
        })
      }
    }
  }
  for (const [index, period] of value.seasonality.periods.entries()) {
    if (period.start_date > period.end_date) {
      ctx.addIssue({
        code: 'custom',
        message: 'seasonality period start_date must not be after end_date',
        path: ['seasonality', 'periods', index, 'start_date'],
      })
    }
    for (const offerId of period.offer_ids) {
      if (!offerIds.has(offerId)) {
        ctx.addIssue({
          code: 'custom',
          message: `seasonality period references unknown offer ${offerId}`,
          path: ['seasonality', 'periods', index, 'offer_ids'],
        })
      }
    }
  }
})

export type BusinessContextDocumentV1 = z.infer<typeof businessContextDocumentV1Schema>

export const landingPageSnapshotDocumentV1Schema = z.object({
  schema_version: z.literal(1),
  requested_url: httpUrl,
  final_url: httpUrl,
  canonical_url: httpUrl,
  purpose: z.enum(['awareness', 'consideration', 'lead_capture', 'booking', 'mixed']),
  supported_funnel_stages: z.array(z.enum(['awareness', 'consideration', 'lead', 'booking'])).min(1),
  offer_ids: z.array(stableId).min(1),
  claim_ids: z.array(stableId),
  ctas: z.array(ctaSchema).min(1),
  mobile: z.object({
    status: z.enum(['pass', 'warning', 'fail', 'unknown']),
    evidence: nonBlank.nullable(),
  }).strict(),
  runtime: z.object({
    status: z.enum(['pass', 'warning', 'fail', 'unknown']),
    http_status: z.number().int().min(100).max(599).nullable(),
    observed_at: z.iso.datetime().nullable(),
  }).strict(),
  tracking: z.object({
    status: z.enum(['observed', 'partial', 'unverified']),
    inventory: z.array(nonBlank),
  }).strict(),
  content_summary: nonBlank,
}).strict().superRefine((value, ctx) => {
  const sensitiveScanValue = {
    ...value,
    ctas: value.ctas.map((cta) => (
      cta.kind === 'phone' || cta.kind === 'email'
        ? { ...cta, destination: null }
        : cta
    )),
  }
  addDocumentBoundaryIssues(value, ctx, MAX_LANDING_PAGE_CONTEXT_BYTES, sensitiveScanValue)
  if (value.mobile.status !== 'unknown' && value.mobile.evidence == null) {
    ctx.addIssue({ code: 'custom', message: 'evaluated mobile status requires evidence', path: ['mobile', 'evidence'] })
  }
  if (value.runtime.status === 'unknown'
    && (value.runtime.http_status != null || value.runtime.observed_at != null)) {
    ctx.addIssue({
      code: 'custom',
      message: 'unknown runtime status must not manufacture HTTP or observation evidence',
      path: ['runtime'],
    })
  }
  if (value.runtime.status !== 'unknown' && value.runtime.observed_at == null) {
    ctx.addIssue({
      code: 'custom',
      message: 'evaluated runtime status requires an observation time',
      path: ['runtime'],
    })
  }
  if (value.runtime.status === 'pass'
    && (value.runtime.http_status == null
      || value.runtime.http_status < 200
      || value.runtime.http_status >= 300)) {
    ctx.addIssue({ code: 'custom', message: 'runtime pass requires HTTP 2xx', path: ['runtime', 'http_status'] })
  }
  if (value.runtime.status === 'warning'
    && (value.runtime.http_status == null || value.runtime.http_status >= 400)) {
    ctx.addIssue({
      code: 'custom',
      message: 'runtime warning requires a non-error HTTP response',
      path: ['runtime', 'http_status'],
    })
  }
  if (value.runtime.status === 'fail'
    && value.runtime.http_status != null && value.runtime.http_status < 400) {
    ctx.addIssue({ code: 'custom', message: 'runtime fail cannot carry a successful HTTP status', path: ['runtime', 'http_status'] })
  }
  if (value.tracking.status !== 'unverified' && value.tracking.inventory.length === 0) {
    ctx.addIssue({
      code: 'custom',
      message: 'observed tracking status requires a non-empty inventory',
      path: ['tracking', 'inventory'],
    })
  }
  for (const [label, ids] of [
    ['supported funnel stage', value.supported_funnel_stages],
    ['offer', value.offer_ids],
    ['claim', value.claim_ids],
  ] as const) {
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', message: `${label} values must be unique`, path: [] })
    }
  }
})

export type LandingPageSnapshotDocumentV1 = z.infer<typeof landingPageSnapshotDocumentV1Schema>

function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON does not permit non-finite numbers.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((key) => {
      if (record[key] === undefined) throw new Error('Canonical JSON does not permit undefined values.')
      return `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    }).join(',')}}`
  }
  throw new Error(`Canonical JSON does not permit ${typeof value} values.`)
}

export function hashCanonicalDocument(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`
}

export function normalizeCanonicalUrl(input: string): string {
  let parsed: URL
  try { parsed = new URL(input) } catch {
    throw new Error('Landing-page identity must be an absolute HTTP(S) URL.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Landing-page identity must use HTTP or HTTPS.')
  }
  if (parsed.username || parsed.password) {
    throw new Error('Landing-page identity must not contain credentials.')
  }
  parsed.hash = ''
  const normalized = parsed.toString()
  if (utf8Bytes(normalized) > MAX_GOVERNED_URL_BYTES) {
    throw new Error(`Landing-page identity is too long; maximum is ${MAX_GOVERNED_URL_BYTES} UTF-8 bytes.`)
  }
  return normalized
}
