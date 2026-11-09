import { assertNoCrossPlaneLineage, type MetricClaim } from '@/lib/cockpit/contracts'
import { upcomingBusinessContext } from './business-intelligence-context'
import { validateReportAudienceEvidence } from './audience-evidence'
import { validateReportBudgetEvidence } from './budget-evidence'
import { websiteRowKey } from './website-identity'
import { compareCreativeEvidenceInstants, validateReportCreativeAssignmentEvidence } from './creative-assignment-contract'
import { BUSINESS_CUSTOMER_FOLLOWUP_METRIC_KEYS } from './business-customer-followup'
import {
  ReportingPacketSchema, type ReportBreakdown, type ReportMetric, type ReportMetricMap,
  type ReportSeriesPoint, type ReportingContext, type ReportingPacket, type ReportingRange,
} from './contracts'

type Entity = MetricClaim['entity']
interface Scope {
  entity: Entity
  range: ReportingRange
  comparison: ReportingRange
  allowPrevious: boolean
  basis?: MetricClaim['window']['basis']
  comparisonMode?: 'none'
  source?: Pick<MetricClaim['source'], 'system' | 'role' | 'evidencePlane'>
}
const SOURCE = {
  meta: { system: 'meta', role: 'delivery_truth', evidencePlane: 'meta_delivery' },
  business: { system: 'outcomes', role: 'business_truth', evidencePlane: 'outcome_business' },
  website: { system: 'ga4', role: 'measurement_qa', evidencePlane: 'ga4_telemetry' },
  measurement: { system: 'first_party_attribution', role: 'association_truth', evidencePlane: 'paid_association' },
} as const

function requireMatch(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid reporting packet: ${message}`)
}

function shiftedDay(date: string, offset: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10)
}

function sameEntity(left: Entity, right: Entity): boolean {
  return left.level === right.level && left.id === right.id
}

function sameWindow(window: MetricClaim['window'], range: ReportingRange, timezone: string): boolean {
  return window.start === range.from && window.end === range.to && window.timezone === timezone
}

function unique(values: string[], label: string): void {
  requireMatch(new Set(values).size === values.length, `duplicate ${label}`)
}

/** Schema parsing canonicalizes object order; retain every evidence field in identity checks. */
function measurementIdentity(claim: MetricClaim, metric: ReportMetric): string {
  // Comparison describes this occurrence's display position. It is validated separately, because
  // the same prior-day measurement is also the current value in the comparison-series table.
  const evidence = { ...claim, comparison: undefined }
  return JSON.stringify({ evidence, key: metric.key, label: metric.label, definition: metric.definition, event: metric.event })
}

class PacketValidator {
  private readonly claims = new Map<string, MetricClaim>()
  private readonly identities = new Map<string, string>()
  private readonly source: typeof SOURCE[keyof typeof SOURCE]
  // Every account-day claim lists every campaign; scanning all entities per input was days x campaigns x entities.
  private campaignIds?: ReadonlySet<string>

  constructor(private readonly packet: ReportingPacket) {
    this.source = SOURCE[packet.section]
  }

  private get context(): ReportingContext { return this.packet.context }

  private scope(entity: Entity): Scope {
    return { entity, range: this.context.range, comparison: this.context.comparison, allowPrevious: true }
  }

  private claim(claim: MetricClaim, metric: ReportMetric, scope: Scope, prior: boolean): void {
    const source = scope.source ?? this.source
    requireMatch(claim.source.system === source.system && claim.source.role === source.role
      && claim.source.evidencePlane === source.evidencePlane, 'source system, role and evidence plane mismatch')
    requireMatch(sameEntity(claim.entity, scope.entity), 'claim entity does not match the containing population')
    requireMatch(claim.metricKey === `${source.system}.${metric.key}`, 'claim metric identity mismatch')
    requireMatch(claim.label === metric.label.trim() && claim.formula === metric.definition.slice(0, 500).trim(), 'metric definition does not match its claim identity')
    requireMatch(sameWindow(claim.window, prior ? scope.comparison : scope.range, this.context.timezone), 'claim window does not match its period')
    requireMatch(claim.window.basis !== 'partial_today', 'open-day basis in a closed-period report')
    requireMatch(claim.window.basis !== 'service_date_et'
      || (this.packet.section === 'business' && scope.basis === 'service_date_et'), 'service dates require an explicit business population')
    requireMatch(this.packet.section !== 'business' || claim.window.basis === (scope.basis ?? 'booking_created_date_et'), 'business window must match its explicit date basis')
    requireMatch(this.packet.section !== 'measurement' || claim.window.basis === 'booking_created_date_et', 'measurement cohort must use booking creation date')
    requireMatch(this.packet.section !== 'website' || claim.window.basis === 'closed_account_days', 'website evidence must use closed property days')
    requireMatch(claim.unit === 'state' || claim.value === null || typeof claim.value === 'number', 'numeric metric has a nonnumeric value')
    if (prior || scope.comparisonMode === 'none') {
      requireMatch(claim.comparison.method === 'none' && claim.comparison.window === null, 'prior claim has an unexpected comparison')
    } else {
      const comparison = claim.comparison.window
      requireMatch(claim.comparison.method === 'prior_equal_period' && comparison !== null
        && sameWindow(comparison, scope.comparison, this.context.timezone) && comparison.basis === claim.window.basis,
      'comparison window does not match this occurrence')
    }
    const identity = measurementIdentity(claim, metric)
    const existing = this.identities.get(claim.claimId)
    requireMatch(existing === undefined || existing === identity, 'conflicting duplicate claim identity')
    this.identities.set(claim.claimId, identity)
    this.claims.set(claim.claimId, claim)
  }

  private metrics(metrics: ReportMetricMap, scope: Scope): void {
    for (const metric of Object.values(metrics)) {
      this.claim(metric.current, metric, scope, false)
      if (metric.previous) {
        requireMatch(scope.allowPrevious, 'previous values are not part of this requested series period')
        requireMatch(metric.previous.unit === metric.current.unit && metric.previous.window.basis === metric.current.window.basis
          && metric.previous.attributionScope === metric.current.attributionScope, 'current and prior metric identity differs')
        this.claim(metric.previous, metric, scope, true)
      }
    }
  }

  private series(points: ReportSeriesPoint[], entity: Entity, prior: boolean, business = false): void {
    const period = prior ? this.context.comparison : this.context.range
    const distance = business ? 1 : (Date.parse(this.context.range.from) - Date.parse(this.context.comparison.from)) / 86_400_000
    unique(points.map(point => point.date), 'series dates')
    for (const point of points) {
      requireMatch(point.date >= period.from && point.date <= period.to, 'series date lies outside its period')
      const comparisonDay = shiftedDay(point.date, -distance)
      this.metrics(point.metrics, {
        entity: business ? { ...entity, id: `${entity.id}:day:${point.date}`.slice(0, 160) } : entity,
        range: { from: point.date, to: point.date }, comparison: { from: comparisonDay, to: comparisonDay },
        allowPrevious: !prior && !business,
      })
    }
  }

  private breakdowns(rows: ReportBreakdown[], entity: Entity): void {
    unique(rows.map(row => row.id), 'breakdown identities')
    unique(rows.map(row => JSON.stringify([row.dimension, row.label])), 'breakdown populations')
    for (const row of rows) {
      const id = `${entity.id}:${row.dimension}:${row.label}`
      requireMatch(row.id === `${entity.level}:${id}`, 'breakdown entity identity mismatch')
      this.metrics(row.metrics, this.scope({ ...entity, id }))
    }
  }

  private meta(): void {
    if (this.packet.section !== 'meta' || !this.packet.result.data) return
    const report = this.packet.result.data
    const account = { level: 'account' as const, id: this.context.account.id }
    this.metrics(report.metrics, this.scope(account))
    this.series(report.series, account, false)
    this.series(report.comparisonSeries, account, true)
    this.breakdowns(report.breakdowns, account)
    unique(report.entities.map(entity => `${entity.level}:${entity.id}`), 'entity identities')
    if (report.creativeAssignmentEvidence) validateReportCreativeAssignmentEvidence(this.context, report.creativeAssignmentEvidence,
      report.entities.filter(entity => entity.level === 'ad').map(entity => entity.id))
    for (const entity of report.entities) {
      if (entity.budgetEvidence) validateReportBudgetEvidence(entity.budgetEvidence, this.context, entity)
      if (entity.audienceEvidence) {
        requireMatch(entity.level === 'adset', 'audience evidence requires an ad set')
        validateReportAudienceEvidence(entity.audienceEvidence, this.context, entity.id, entity.configurationAsOf)
      }
      if (entity.creative?.identity) {
        requireMatch(entity.creative.identity.observedAt === entity.configurationAsOf
          && compareCreativeEvidenceInstants(entity.creative.identity.observedAt, this.context.asOf) <= 0,
        'creative membership observation must match its configuration time and report cutoff')
      }
      const identity = { level: entity.level, id: entity.id }
      this.metrics(entity.metrics, this.scope(identity))
      this.series(entity.series ?? [], identity, false)
      this.series(entity.comparisonSeries ?? [], identity, true)
      this.breakdowns(entity.breakdowns ?? [], identity)
    }
  }

  private business(): void {
    if (this.packet.section !== 'business' || !this.packet.result.data) return
    const report = this.packet.result.data
    const account = { level: 'business' as const, id: this.context.account.id }
    this.metrics(report.metrics, this.scope(account))
    this.series(report.series, account, false, true)
    this.series(report.comparisonSeries, account, true, true)
    unique(report.types.map(row => row.id), 'business type identities')
    unique(report.types.map(row => `${account.id}:type:${row.id}`.slice(0, 160)), 'business type populations')
    for (const row of report.types) this.metrics(row.metrics, {
      ...this.scope({ ...account, id: `${account.id}:type:${row.id}`.slice(0, 160) }),
    })
    this.businessIntelligence()
  }

  private businessIntelligence(): void {
    if (this.packet.section !== 'business') return
    const intelligence = this.packet.result.data?.intelligence
    if (!intelligence) return
    const identity = (suffix: string): Entity => ({ level: 'business', id: `${this.context.account.id}:${suffix}`.slice(0, 160) })
    const customers = intelligence.customers.data
    if (customers) {
      requireMatch(customers.historyTo === this.context.range.to
        && (customers.historyFrom === null || customers.historyFrom <= customers.historyTo), 'customer history window mismatch')
      this.metrics(customers.metrics, this.scope(identity('customers')))
      unique(customers.groups.map(row => row.id), 'customer groups')
      for (const row of customers.groups) {
        requireMatch(['prior_booking', 'first_observed', 'unidentified'].includes(row.id), 'unknown customer cohort')
        this.metrics(row.metrics, this.scope(identity(`customers:${row.id}`)))
      }
      if (customers.followup) {
        for (const row of customers.followup.horizons) {
          const supplied = Object.keys(row.metrics)
          requireMatch(supplied.length === BUSINESS_CUSTOMER_FOLLOWUP_METRIC_KEYS.length
            && BUSINESS_CUSTOMER_FOLLOWUP_METRIC_KEYS.every(key => supplied.includes(key)),
          'customer follow-up metric identities mismatch')
          this.metrics(row.metrics, this.scope(identity(`customers:followup:${row.id}`)))
        }
      }
    }
    const lead = intelligence.leadTime.data
    if (lead) {
      this.metrics(lead.metrics, this.scope(identity('lead_time')))
      unique(lead.buckets.map(row => row.id), 'lead-time buckets')
      for (const row of lead.buckets) {
        requireMatch(['under_1', '1_7', '7_14', '14_30', '30_plus'].includes(row.id), 'unknown lead-time bucket')
        this.metrics(row.metrics, this.scope(identity(`lead_time:${row.id}`)))
      }
    }
    const upcoming = intelligence.upcoming.data
    if (!upcoming) return
    requireMatch(intelligence.upcoming.asOf !== null, 'upcoming observation time unavailable')
    const context = upcomingBusinessContext(this.context, intelligence.upcoming.asOf)
    requireMatch(upcoming.range.from === context.range.from && upcoming.range.to === context.range.to, 'upcoming horizon mismatch')
    const scope = (suffix: string, range = context.range): Scope => ({ entity: identity(suffix), range,
      comparison: context.comparison, allowPrevious: false, basis: 'service_date_et', comparisonMode: 'none' })
    this.metrics(upcoming.metrics, scope('upcoming'))
    unique(upcoming.days.map(row => row.date), 'upcoming service dates')
    for (const row of upcoming.days) {
      requireMatch(row.date >= context.range.from && row.date <= context.range.to, 'service date outside upcoming horizon')
      this.metrics(row.metrics, scope(`upcoming:day:${row.date}`, { from: row.date, to: row.date }))
    }
    unique(upcoming.types.map(row => row.id), 'upcoming appointment types')
    for (const row of upcoming.types) this.metrics(row.metrics, scope(`upcoming:type:${row.id}`))
  }

  private website(): void {
    if (this.packet.section !== 'website' || !this.packet.result.data) return
    const report = this.packet.result.data
    const account = { level: 'account' as const, id: this.context.account.id }
    this.metrics(report.metrics, this.scope(account))
    unique(report.rows.map(row => row.id), 'website journey identities')
    unique(report.rows.map(websiteRowKey), 'website journey populations')
    unique(report.events.map(row => JSON.stringify([row.name, row.device, row.channel])), 'website event populations')
    report.rows.forEach((row, index) => this.metrics(row.metrics, {
      ...this.scope({ ...account, id: `${account.id}:journey:${index}`.slice(0, 160) }),
    }))
    report.events.forEach((row, index) => {
      requireMatch(Object.values(row.metrics).every(metric => metric.event === row.name), 'website event identity mismatch')
      this.metrics(row.metrics, this.scope({ ...account, id: `${account.id}:event:${index}`.slice(0, 160) }))
    })
  }

  private measurement(): void {
    if (this.packet.section !== 'measurement' || !this.packet.result.data) return
    const report = this.packet.result.data
    const scope = this.scope({ level: 'business', id: this.context.account.id })
    this.metrics(report.paidAssociation, { ...scope, source: SOURCE.measurement })
    this.metrics(report.capi, { ...scope, source: { system: 'capi', role: 'delivery_transport', evidencePlane: 'capi_delivery' } })
  }

  private lineage(): void {
    const visiting = new Set<string>(), visited = new Set<string>()
    const visit = (claim: MetricClaim): void => {
      requireMatch(!visiting.has(claim.claimId), 'cyclic input lineage')
      if (visited.has(claim.claimId)) return
      visiting.add(claim.claimId)
      for (const id of claim.inputClaimIds) {
        const input = this.claims.get(id)
        requireMatch(input !== undefined, 'input lineage does not resolve in this packet')
        requireMatch((sameEntity(claim.entity, input.entity) || this.campaignInput(claim, input))
          && JSON.stringify(claim.window) === JSON.stringify(input.window), 'input lineage population or window differs')
        if (claim.availability.state === 'available' && claim.measurementKind === 'derived') {
          requireMatch(input.availability.state === 'available' && input.coverage.state === 'complete', 'available derivation has unavailable or incomplete inputs')
        }
        visit(input)
      }
      visiting.delete(claim.claimId)
      visited.add(claim.claimId)
    }
    for (const claim of this.claims.values()) visit(claim)
    assertNoCrossPlaneLineage(Object.fromEntries(this.claims))
  }

  private campaignInput(claim: MetricClaim, input: MetricClaim): boolean {
    if (this.packet.section !== 'meta' || !this.packet.result.data) return false
    const canonical = ['meta.bookings', 'meta.appointment_value', 'meta.bookings_click', 'meta.bookings_view']
    return claim.measurementKind === 'derived' && canonical.includes(claim.metricKey)
      && claim.entity.level === 'account' && claim.entity.id === this.context.account.id
      && input.entity.level === 'campaign' && input.metricKey === claim.metricKey
      && (this.campaignIds ??= new Set(this.packet.result.data.entities.flatMap(entity => entity.level === 'campaign' ? [entity.id] : []))).has(input.entity.id)
  }

  validate(): ReportingPacket {
    this.meta()
    this.business()
    this.website()
    this.measurement()
    this.lineage()
    return this.packet
  }
}

/** Validate data where it is displayed, not only as an unscoped collection of valid claims. */
export function validateReportingPacket(raw: unknown): ReportingPacket {
  return new PacketValidator(ReportingPacketSchema.parse(raw)).validate()
}
