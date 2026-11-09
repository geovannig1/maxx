import { createMetricClaim } from '@/lib/cockpit/contracts'
import type { MetaReport, ReportMetricMap, ReportingContext } from './contracts'
import { makeReportMetric, COMPLETE_FIELD_COVERAGE, UNKNOWN_FIELD_COVERAGE } from './claims'
import type { MetaRow } from './meta-metrics'

/** Pure account projection shared by source assembly and strict interpretation validation. */
export function projectCampaignAuthority(context: ReportingContext, report: MetaReport, reads: Map<string, MetaRow[]>): { report: MetaReport; notes: string[] } {
  const notes = ['Account AppointmentConfirmed count/value and click/view splits use complete campaign-scope canonical claims, with inspectable lineage. Native account reach/frequency remain unchanged.']
  const observations: MetaReport['observations'] = []
  const campaigns = new Map<string, MetaReport['entities'][number]>()
  for (const entity of report.entities) if (entity.level === 'campaign' && !campaigns.has(entity.id)) campaigns.set(entity.id, entity)
  const campaignMetrics = (period: 'current' | 'previous', key: string) => {
    const rows = reads.get(`${period}:campaign`)
    return rows?.length ? rows.map(row => (typeof row.campaign_id === 'string' ? campaigns.get(row.campaign_id) : undefined)?.metrics[key]) : []
  }
  const aggregate = (period: 'current' | 'previous', key: string) => {
    const inputs = campaignMetrics(period, key)
    const claims = inputs.map(metric => period === 'current' ? metric?.current : metric?.previous)
    const valid = claims.length > 0 && claims.every(claim => claim?.availability.state === 'available' && claim.coverage.state === 'complete' && typeof claim.value === 'number')
    return { inputs: inputs.filter((metric): metric is NonNullable<typeof metric> => Boolean(metric)), claims,
      value: valid ? claims.reduce((sum, claim) => sum + (claim!.value as number), 0) : null }
  }
  const canonicalIdentity = (metric: ReportMetricMap[string]): ReportMetricMap[string] => ({ ...metric,
    current: createMetricClaim({ ...metric.current, claimId: `${metric.current.claimId}:campaign-canonical` }),
    previous: metric.previous ? createMetricClaim({ ...metric.previous, claimId: `${metric.previous.claimId}:campaign-canonical` }) : null,
  })
  let metrics = report.metrics
  for (const key of ['bookings', 'appointment_value', 'bookings_click', 'bookings_view']) {
    const now = aggregate('current', key)
    const prior = aggregate('previous', key)
    const original = metrics[key]
    const metric = makeReportMetric({
      context, key, label: original.label, unit: original.current.unit, event: 'AppointmentConfirmed', source: 'meta',
      current: now.value, previous: prior.value,
      definition: `SUM of canonical campaign ${original.label} for the exact account/window. Every returned campaign field must be valid; campaign outcomes are the canonical account authority.`,
      inputMetrics: [...new Set([...now.inputs, ...prior.inputs])], coverage: now.value === null ? UNKNOWN_FIELD_COVERAGE : { state: 'complete', numerator: now.inputs.length, denominator: now.inputs.length },
      previousCoverage: prior.value === null ? UNKNOWN_FIELD_COVERAGE : { state: 'complete', numerator: prior.inputs.length, denominator: prior.inputs.length },
      measurementKind: 'derived', attributionScope: 'meta_platform_modelled', basis: 'impression_date_et',
      maturity: original.current.maturity, previousMaturity: original.previous?.maturity,
      freshness: original.current.freshness, sourceHead: `meta-campaign-authority:${context.account.metaAccountId}:${context.asOf}`,
      reason: 'meta_campaign_authority_field_unavailable', previousReason: 'meta_campaign_authority_field_unavailable',
    })
    metrics = { ...metrics, [key]: canonicalIdentity({ ...metric,
      current: createMetricClaim({ ...metric.current, inputClaimIds: now.claims.flatMap(claim => claim ? [claim.claimId] : []) }),
      previous: metric.previous ? createMetricClaim({ ...metric.previous, inputClaimIds: prior.claims.flatMap(claim => claim ? [claim.claimId] : []) }) : null }) }
    for (const period of ['current', 'previous'] as const) {
      const native = period === 'current' ? original.current : original.previous
      const projected = period === 'current' ? now.value : prior.value
      if (native?.value !== null && native?.value !== undefined && native.value !== projected) {
        observations.push({ id: `native-account:${period}:${key}`, title: 'Native account outcome differs from campaign authority', kind: 'quality', entityId: null, observedAt: context.asOf,
          detail: `${period} native account ${key}: ${native.value}; campaign-authority ${key}: ${projected ?? 'unavailable'} for ${native.window.start}–${native.window.end}. The account metric uses campaign authority and does not overwrite lower-level observations.` })
      }
    }
  }
  for (const [key, numerator, denominator] of [['cost_per_booking', 'spend', 'bookings'], ['appointment_roas', 'appointment_value', 'spend']] as const) {
    const value = (prior: boolean) => {
      const a = prior ? metrics[numerator].previous : metrics[numerator].current
      const b = prior ? metrics[denominator].previous : metrics[denominator].current
      return a?.coverage.state === 'complete' && b?.coverage.state === 'complete' && typeof a.value === 'number' && typeof b.value === 'number' && b.value > 0 ? a.value / b.value : null
    }
    const now = value(false)
    const prior = value(true)
    const original = metrics[key]
    metrics = { ...metrics, [key]: canonicalIdentity(makeReportMetric({ context, key, label: original.label, unit: original.current.unit,
      definition: `${metrics[numerator].label} / ${metrics[denominator].label}; canonical campaign outcomes and native account spend over the same exact period.`,
      source: 'meta', event: 'AppointmentConfirmed', current: now, previous: prior,
      inputMetrics: [metrics[numerator], metrics[denominator]], measurementKind: 'derived', attributionScope: 'meta_platform_modelled', basis: 'impression_date_et',
      coverage: now === null ? UNKNOWN_FIELD_COVERAGE : COMPLETE_FIELD_COVERAGE, previousCoverage: prior === null ? UNKNOWN_FIELD_COVERAGE : COMPLETE_FIELD_COVERAGE,
      maturity: original.current.maturity, previousMaturity: original.previous?.maturity, freshness: original.current.freshness,
    })) }
  }
  return { report: { ...report, metrics, observations: [...report.observations, ...observations], sourceDescription: `${report.sourceDescription} Account AppointmentConfirmed outcomes are projected from complete canonical campaign claims.` }, notes }
}
