import { audienceStatusCode } from '@/lib/audience/reference-readiness'
import type { ReportingContext } from './contracts'
import type { MetaRow } from './meta-metrics'
import type { ReportAudienceEvidence, ReportAudienceMember, ReportingAudienceRef } from './audience-evidence'
import { ReportAudienceMemberSchema } from './audience-evidence'
import { compareCreativeEvidenceInstants } from './creative-assignment-contract'

const object = (value: unknown): MetaRow => value && typeof value === 'object' && !Array.isArray(value) ? value as MetaRow : {}
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null
const integer = (value: unknown): number | null => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}
function updatedAt(value: unknown, asOf: string): string | null {
  if (typeof value === 'string' && !/^\d+$/.test(value)) {
    const normalized = value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
    if (!ReportAudienceMemberSchema.shape.metaUpdatedAt.safeParse(normalized).success) return null
    return compareCreativeEvidenceInstants(normalized, asOf) <= 0 ? normalized : null
  }
  const milliseconds = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))
    ? Number(value) * 1000 : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds <= Date.parse(asOf) ? new Date(milliseconds).toISOString() : null
}

export function projectAudienceInventory(context: ReportingContext, rows: MetaRow[]): Record<string, ReportingAudienceRef> {
  const ids = rows.map(row => text(row.id))
  return Object.fromEntries(rows.flatMap(row => {
    const id = text(row.id)
    if (!id || ids.filter(candidate => candidate === id).length !== 1) return []
    const owner = text(row.account_id)?.replace(/^act_/, '')
    const lower = integer(row.approximate_count_lower_bound), upper = integer(row.approximate_count_upper_bound)
    const spec = object(row.lookalike_spec), origin = spec.origin
    const origins = Array.isArray(origin) ? origin : origin ? [origin] : []
    const fallbackId = text(spec.origin_audience_id)
    const seeds = [...origins, ...(fallbackId ? [{ id: fallbackId, name: spec.origin_audience_name }] : [])].flatMap(item => {
      const seed = object(item), seedId = text(seed.id)
      return seedId ? [{ id: seedId, name: text(seed.name) }] : []
    })
    return [[id, {
      id, name: text(row.name), subtype: text(row.subtype),
      accountId: !owner || owner === context.account.metaAccountId.replace(/^act_/, '') ? context.account.id : owner,
      lastSyncedAt: context.asOf, operationStatus: row.operation_status, deliveryStatus: row.delivery_status,
      approximateCountLowerBound: lower !== null && upper !== null && lower > upper ? null : lower,
      approximateCountUpperBound: lower !== null && upper !== null && lower > upper ? null : upper,
      retentionDays: integer(row.retention_days), seeds: [...new Map(seeds.map(seed => [seed.id, seed])).values()],
      metaUpdatedAt: updatedAt(row.time_updated, context.asOf),
    } satisfies ReportingAudienceRef]]
  }))
}

export function projectAudienceEvidence(context: ReportingContext, adset: MetaRow | undefined,
  inventory: Record<string, ReportingAudienceRef>, observedAt: string | null,
  expansion: ReportAudienceEvidence['expansion']): ReportAudienceEvidence | undefined {
  const adsetId = text(adset?.id)
  if (!adsetId || !observedAt || !Number.isFinite(Date.parse(observedAt))) return undefined
  const targeting = object(adset?.targeting)
  const targetingAvailable = adset?.targeting !== null && typeof adset?.targeting === 'object' && !Array.isArray(adset?.targeting)
  let unparsedReferences = 0
  const members = (['included', 'excluded'] as const).flatMap(role => {
    const raw = targeting[role === 'included' ? 'custom_audiences' : 'excluded_custom_audiences']
    if (raw !== undefined && !Array.isArray(raw)) { unparsedReferences++; return [] }
    const values = Array.isArray(raw) ? raw : []
    return values.flatMap<ReportAudienceMember>(item => {
      const ref = object(item), id = text(ref.id) ?? text(item)
      if (!id) { unparsedReferences++; return [] }
      const known = inventory[id]
      const ownership = known?.accountId === context.account.id ? 'matched' : known?.accountId ? 'mismatch' : 'unconfirmed'
      const trusted = ownership === 'matched' ? known : undefined
      return [{ id, role, name: trusted?.name ?? text(ref.name), subtype: trusted?.subtype ?? null, ownership,
        operationCode: integer(audienceStatusCode(trusted?.operationStatus)), deliveryCode: integer(audienceStatusCode(trusted?.deliveryStatus)),
        operationDescription: text(object(trusted?.operationStatus).description), deliveryDescription: text(object(trusted?.deliveryStatus).description),
        lowerBound: integer(trusted?.approximateCountLowerBound), upperBound: integer(trusted?.approximateCountUpperBound),
        retentionDays: integer(trusted?.retentionDays), seeds: trusted?.seeds ?? [],
        inventoryObservedAt: trusted?.lastSyncedAt ?? null, metaUpdatedAt: trusted?.metaUpdatedAt ?? null,
      }]
    })
  })
  return { accountId: context.account.id, adsetId, observedAt, targetingAvailable, unparsedReferences, expansion,
    members: [...new Map(members.map(member => [`${member.role}:${member.id}`, member])).values()] }
}
