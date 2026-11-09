import './_support/outcome-noun-booking'
import { beforeEach, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CreativeReport } from '@/components/reporting/CreativeReport'
import { AdsReport } from '@/components/reporting/AdsReport'
import { OverviewPerformance } from '@/components/reporting/OverviewPerformance'
import { ExpertReviewPanel } from '@/components/reporting/ExpertReviewPanel'
import { deriveExpertReview } from '@/lib/reporting/review'
import { reportMetricValue } from '@/components/reporting/MetricValue'
import { creativeGroupMetricValue } from '@/components/reporting/CreativeGroupMetric'
import { buildCreativeGroups } from '@/lib/reporting/creative-groups'
import { makeReportMetric } from '@/lib/reporting/claims'
import { InvestigationExport, METRIC_GROUPS, type MetricGroup } from '@/components/reporting/MetricTable'
import { creativeReportingFixture } from './reporting-browser/creative-fixture'
import { businessReportingFixture } from './reporting-browser/business-fixture'
import { businessExportRows } from '@/lib/reporting/business-export'
import * as reportExport from '@/lib/reporting/export'

const navigation = vi.hoisted(() => ({ search: '', pathname: '/creative' }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(navigation.search), usePathname: () => navigation.pathname,
}))
beforeEach(() => { navigation.search = ''; navigation.pathname = '/creative' })
const response = 'response' as MetricGroup
const costKeys = ['cost_per_2s_view', 'cost_per_thruplay', 'cost_per_engagement', 'cost_per_share']

it('explains response coverage when usable observations still lack comparable outcomes', () => {
  const review = deriveExpertReview(creativeReportingFixture())
  const coverage = review.populationCoverage!.find(row => row.family === 'Creative response')!
  expect(coverage.evaluated).toBe(8)
  expect(coverage.limited).toBeGreaterThan(0)
  const html = renderToStaticMarkup(<ExpertReviewPanel review={review} expanded />)
  expect(html).toContain('evaluated and limited may overlap')
})

it('does not attach a native booked-value identity to distinct business calculation rows', () => {
  const data = businessReportingFixture(), rows = businessExportRows(data)
  const calculations = rows.filter(row => row.source === 'maxx')
  expect(calculations).toHaveLength(36)
  for (const row of calculations) {
    expect(row.claim_id).toBeNull()
    expect(row.previous_claim_id).toBeNull()
    expect(row.input_claim_ids).toBeNull()
    expect(row.previous_input_claim_ids).toBeNull()
    expect(row.limitations).toContain('Native inputs:')
    expect(row.limitations).toContain('currentClaimId')
  }
  expect(rows.some(row => row.source === 'outcomes' && row.claim_id === data.business.data!.metrics.booked_value.current.claimId && row.value === 3200)).toBe(true)
})

it('retains meaningful fractional-cent cost precision without changing booked-money display', () => {
  const context = creativeReportingFixture().context
  const metric = (key: string) => makeReportMetric({ context, key, label: key, definition: 'Precision control', source: 'meta', unit: 'money', current: 0.015 })
  expect(reportMetricValue(metric('cost_per_2s_view'))).toBe('$0.015')
  expect(reportMetricValue(metric('cost_per_thruplay'))).toBe('$0.015')
  expect(reportMetricValue(metric('spend'))).toBe('$0.02')
  expect(reportMetricValue({ ...metric('cost_per_2s_view'), current: { ...metric('cost_per_2s_view').current, value: 0.00001 } })).toBe('<$0.0001')
  const grouped = buildCreativeGroups(creativeReportingFixture()).groups.find(group => group.metaCreativeId === '401')!.metrics.spend
  expect(creativeGroupMetricValue({ ...grouped, key: 'cost_per_2s_view', current: { ...grouped.current, value: 0.015 } })).toBe('$0.015')
})

it('preserves current/prior claim identities in an ordinary native metric export', () => {
  const data = creativeReportingFixture()
  const metric = data.meta.data!.entities.find(entity => entity.id === '301')!.metrics.outbound_cpc
  const [row] = reportExport.metricsToExportRows({ outbound_cpc: metric }, 'ad 301', data.context)
  expect(row.claim_id).toBe(metric.current.claimId)
  expect(row.previous_claim_id).toBe(metric.previous!.claimId)
  expect(JSON.parse(row.input_claim_ids!)).toEqual(metric.current.inputClaimIds)
  expect(JSON.parse(row.previous_input_claim_ids!)).toEqual(metric.previous!.inputClaimIds)
  expect(row.value).toBe(6)
})

it('opens creative response by default with viewing, social response, clicks and named results together', () => {
  const html = renderToStaticMarkup(<CreativeReport data={creativeReportingFixture()} />)
  expect(html).toMatch(/aria-pressed="true"[^>]*>Response<\/button>/)
  for (const label of ['Post engagements', 'Outbound clicks', 'Landing-page views', 'Reported bookings', 'ThruPlays']) expect(html).toContain(label)
  expect(html).toContain('Cost per post engagement')
  expect(html).toContain('Messaging conversations')
  expect(html).toContain('not relabeled as a three-second view')
  expect(html).toContain('Measured zero outcomes')
  expect(html).toContain('Outcome field unavailable')
})

it('keeps response costs available in exact ad detail, daily selection and placement detail', () => {
  navigation.search = 'group=response&ad=301'
  const data = creativeReportingFixture(undefined, undefined, undefined, undefined, ['301'])
  const html = renderToStaticMarkup(<CreativeReport data={data} />)
  expect(html).toMatch(/aria-pressed="true"[^>]*>Response<\/button>/)
  expect(html).toContain('Cost per ThruPlay')
  expect(html).toContain('Cost per post engagement')
  expect(html).toContain('value="cost_per_engagement"')
  expect(html).toContain('Ad placement metrics')
  expect(html).toContain('group=response')
  expect(html).toContain('from=2026-09-02')
})

it('preserves all existing metric groups and exposes response in campaign/ad-set investigation', () => {
  expect(Object.keys(METRIC_GROUPS)).toEqual(expect.arrayContaining(['results', 'delivery', 'clicks', 'attention', 'engagement', 'response']))
  navigation.search = 'group=response'
  const data = creativeReportingFixture()
  expect(renderToStaticMarkup(<AdsReport data={data} />)).toContain('>Response</button>')
  expect(renderToStaticMarkup(<OverviewPerformance data={data} />)).toContain('>Response</button>')
})

it('exports selected response rows with exact native inputs, real zero and unknown cost kept distinct', () => {
  const download = vi.spyOn(reportExport, 'downloadReportCsv').mockImplementation(() => {})
  try {
    const data = creativeReportingFixture()
    const entities = data.meta.data!.entities.filter(entity => ['301', '307', '308'].includes(entity.id))
    const button = InvestigationExport({ entities, group: response, context: data.context, filename: 'response' })
    button.props.onClick()
    const rows = download.mock.calls[0][0]
    const first = entities[0]
    for (const [index, key] of costKeys.entries()) {
      const metric = first.metrics[key]
      const row = rows.find(row => row.claim_id === metric.current.claimId)
      expect(row).toMatchObject({ value: [0.015, 0.024, 0.4, 30][index], from: '2026-09-02', to: '2026-09-04', source: 'meta' })
      expect(JSON.parse(row!.input_claim_ids!)).toEqual(metric.current.inputClaimIds)
      expect(JSON.parse(row!.input_claim_ids!)).toHaveLength(2)
    }
    expect(rows.some(row => row.claim_id === entities[1].metrics.engagements.current.claimId && row.value === 0)).toBe(true)
    expect(rows.some(row => row.claim_id === entities[1].metrics.cost_per_engagement.current.claimId && row.value === null)).toBe(true)
    expect(rows.some(row => row.claim_id === entities[2].metrics.bookings.current.claimId && row.value === null)).toBe(true)
    expect(rows.some(row => row.entity.includes('(ad 302;'))).toBe(false)
  } finally { download.mockRestore() }
})
