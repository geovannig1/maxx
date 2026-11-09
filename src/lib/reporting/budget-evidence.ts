import { z } from 'zod'
import type { ReportEntity, ReportingContext } from './contracts'
import type { MetaRow } from './meta-metrics'
import { compareCreativeEvidenceInstants } from './creative-assignment-contract'
import { fromMinorUnits } from '@/lib/utils/format-currency'

const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/).datetime({ offset: true })
function field<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('state', [
    z.object({ state: z.literal('observed'), value }).strict(),
    z.object({ state: z.literal('missing'), value: z.null() }).strict(),
    z.object({ state: z.literal('invalid'), value: z.null() }).strict(),
  ])
}
// `majorUnits` is `minorUnits` in the report currency's major units (cents -> dollars, yen -> yen, fils ->
// dinars); validateReportBudgetEvidence checks the pair against the report's currency. Packets written
// before the v1 release named it `usd` (always minorUnits / 100) and are upgraded when read, the amount recomputed in
// the packet currency (src/lib/outcomes/legacy-vocabulary.ts).
const amount = z.discriminatedUnion('state', [
  z.object({ state: z.literal('observed'), minorUnits: z.number().int().nonnegative().safe(), majorUnits: z.number().finite().nonnegative() }).strict(),
  z.object({ state: z.literal('missing'), minorUnits: z.null(), majorUnits: z.null() }).strict(),
  z.object({ state: z.literal('invalid'), minorUnits: z.null(), majorUnits: z.null() }).strict(),
])
const status = field(z.string().regex(/^[A-Z][A-Z_]{0,79}$/))
const time = field(timestamp)
const flag = field(z.boolean())
export const ReportBudgetEvidenceSchema = z.object({
  version: z.literal(1), accountId: z.string().min(1), metaAccountId: z.string().min(1),
  entity: z.object({ level: z.enum(['campaign', 'adset']), id: z.string().min(1) }).strict(),
  campaignId: z.string().min(1).nullable(), observedAt: timestamp,
  dailyBudget: amount, lifetimeBudget: amount,
  configuredStatus: status, effectiveStatus: status,
  startTime: time, endTime: time, metaUpdatedAt: time,
  adsetBudgetSharing: flag, budgetScheduleEnabled: flag,
}).strict()
export type ReportBudgetEvidence = z.infer<typeof ReportBudgetEvidenceSchema>
type BudgetEntity = Pick<ReportEntity, 'level' | 'id' | 'campaignId' | 'configurationAsOf'>
type BudgetIdentity = { level: 'campaign' | 'adset'; id: string; campaignId: string | null }

export const BUDGET_EVIDENCE_LIMIT = 'Observed current configuration does not establish the budget or schedule in the selected historical period; current settings may differ from settings during the selected period. A daily budget is an average, not a hard daily spending cap. These are configured amounts and outer start/end times; detailed budget and ad-set schedules are not included. An own ad-set budget does not establish isolated allocation when sharing is enabled or unknown.'

function money(value: unknown, currency: string): ReportBudgetEvidence['dailyBudget'] {
  if (value === null || value === undefined) return { state: 'missing', minorUnits: null, majorUnits: null }
  // Native read fields are integer minor-unit strings; decimal amounts and JS numbers are not this instrument.
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN
  return Number.isSafeInteger(number) && number >= 0 ? { state: 'observed', minorUnits: number, majorUnits: fromMinorUnits(number, currency) }
    : { state: 'invalid', minorUnits: null, majorUnits: null }
}
function code(value: unknown): ReportBudgetEvidence['configuredStatus'] {
  if (value === null || value === undefined) return { state: 'missing', value: null }
  return typeof value === 'string' && /^[A-Z][A-Z_]{0,79}$/.test(value) ? { state: 'observed', value }
    : { state: 'invalid', value: null }
}
function boolean(value: unknown): ReportBudgetEvidence['budgetScheduleEnabled'] {
  return value === null || value === undefined ? { state: 'missing', value: null }
    : typeof value === 'boolean' ? { state: 'observed', value } : { state: 'invalid', value: null }
}
function instant(value: unknown, cutoff?: string): ReportBudgetEvidence['startTime'] {
  if (value === null || value === undefined) return { state: 'missing', value: null }
  const normalized = typeof value === 'string' ? value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2') : value
  return timestamp.safeParse(normalized).success && typeof normalized === 'string'
    && (!cutoff || compareCreativeEvidenceInstants(normalized, cutoff) <= 0)
    ? { state: 'observed', value: normalized } : { state: 'invalid', value: null }
}

/** Projection is called only for identity-compatible rows from the account-scoped native inventory edge. */
export function projectBudgetEvidence(context: ReportingContext, entity: BudgetIdentity,
  row: MetaRow | undefined, observedAt: string | null): ReportBudgetEvidence | undefined {
  if (!row || row.id !== entity.id || !observedAt || !timestamp.safeParse(observedAt).success
    || compareCreativeEvidenceInstants(observedAt, context.asOf) > 0) return undefined
  const metaAccountId = context.account.metaAccountId.replace(/^act_/, '')
  if (row.account_id !== undefined && (typeof row.account_id !== 'string' || row.account_id.replace(/^act_/, '') !== metaAccountId)) return undefined
  const campaignId = entity.level === 'campaign' ? entity.id : typeof row.campaign_id === 'string' && row.campaign_id.trim() ? row.campaign_id : null
  if (campaignId !== null && campaignId !== entity.campaignId) return undefined
  let startTime = instant(row.start_time), endTime = instant(row[entity.level === 'campaign' ? 'stop_time' : 'end_time'])
  if (startTime.state === 'observed' && endTime.state === 'observed' && compareCreativeEvidenceInstants(startTime.value, endTime.value) > 0) {
    startTime = { state: 'invalid', value: null }; endTime = { state: 'invalid', value: null }
  }
  return ReportBudgetEvidenceSchema.parse({ version: 1, accountId: context.account.id, metaAccountId,
    entity: { level: entity.level, id: entity.id }, campaignId, observedAt,
    dailyBudget: money(row.daily_budget, context.currency), lifetimeBudget: money(row.lifetime_budget, context.currency),
    configuredStatus: code(row.status), effectiveStatus: code(row.effective_status), startTime, endTime,
    metaUpdatedAt: instant(row.updated_time, observedAt),
    adsetBudgetSharing: boolean(entity.level === 'campaign' ? row.is_adset_budget_sharing_enabled : undefined),
    budgetScheduleEnabled: boolean(row.is_budget_schedule_enabled) })
}

export function validateReportBudgetEvidence(evidence: ReportBudgetEvidence, context: ReportingContext, entity: BudgetEntity): void {
  const end = evidence.endTime, start = evidence.startTime, update = evidence.metaUpdatedAt
  if (evidence.accountId !== context.account.id || evidence.metaAccountId !== context.account.metaAccountId.replace(/^act_/, '')
    || evidence.entity.level !== entity.level || evidence.entity.id !== entity.id
    || (entity.level === 'campaign' ? evidence.campaignId !== entity.id : evidence.campaignId !== null && evidence.campaignId !== entity.campaignId)
    || !entity.configurationAsOf || compareCreativeEvidenceInstants(evidence.observedAt, entity.configurationAsOf) !== 0
    || compareCreativeEvidenceInstants(evidence.observedAt, context.asOf) > 0
    || (update.state === 'observed' && compareCreativeEvidenceInstants(update.value, evidence.observedAt) > 0)
    || (start.state === 'observed' && end.state === 'observed' && compareCreativeEvidenceInstants(start.value, end.value) > 0)
    || (entity.level === 'adset' && evidence.adsetBudgetSharing.state !== 'missing')
    // Each amount is its native minor units converted exactly once, in the report's currency.
    || [evidence.dailyBudget, evidence.lifetimeBudget].some(item =>
      item.state === 'observed' && item.majorUnits !== fromMinorUnits(item.minorUnits, context.currency))) {
    throw new Error('Invalid reporting budget identity or observation scope.')
  }
}

export interface BudgetOwnership {
  state: 'own' | 'campaign' | 'undetermined' | 'unavailable'
  owner: ReportBudgetEvidence | null
  parent: ReportBudgetEvidence | null
}
/** Own means a positive amount observed on this object, never a guaranteed isolated allocation. */
export function resolveBudgetOwnership(entity: ReportEntity, entities: ReportEntity[]): BudgetOwnership {
  const own = entity.budgetEvidence
  const candidates = entities.filter(item => item.level === 'campaign' && item.id === entity.campaignId)
  const parent = entity.level === 'adset' && own?.campaignId === entity.campaignId && candidates.length === 1
    ? candidates[0].budgetEvidence ?? null : null
  const positive = (value: ReportBudgetEvidence | undefined | null) => Boolean(value && [value.dailyBudget, value.lifetimeBudget].some(item => item.state === 'observed' && item.minorUnits > 0))
  const multiple = (value: ReportBudgetEvidence | undefined | null) => Boolean(value && [value.dailyBudget, value.lifetimeBudget].every(item => item.state === 'observed' && item.minorUnits > 0))
  if (multiple(own) || multiple(parent) || positive(own) && positive(parent)) return { state: 'undetermined', owner: null, parent }
  if (positive(own)) return { state: 'own', owner: own!, parent }
  if (positive(parent) && own && [own.dailyBudget, own.lifetimeBudget].every(item => item.state === 'observed' && item.minorUnits === 0))
    return { state: 'campaign', owner: parent, parent }
  return { state: positive(parent) ? 'undetermined' : 'unavailable', owner: null, parent }
}
