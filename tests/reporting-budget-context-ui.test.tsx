import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { OverviewPerformance } from '@/components/reporting/OverviewPerformance'
import { HierarchyDetail } from '@/components/reporting/HierarchyDetail'
import { EntityComparison } from '@/components/reporting/EntityComparison'
import { collectReportExportRows } from '@/components/reporting/ReportsReport'
import { deriveExpertReview } from '@/lib/reporting/review'
import { validateSavedReview } from '@/lib/reporting/saved-review'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { purchaseCpaFixture } from './fixtures/reporting-purchase-cpa'
import { budgetContextFixture } from './fixtures/reporting-budget-context'

const navigation = vi.hoisted(() => ({ search: '', pathname: '/dashboard' }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(navigation.search),
  usePathname: () => navigation.pathname,
}))

const fixture = budgetContextFixture

beforeEach(() => { navigation.search = ''; navigation.pathname = '/dashboard' })

describe('current budget context in the existing reporting workflow', () => {
  it('shows budget ownership on the comprehensive campaign and ad-set tables', () => {
    const data = fixture()
    let html = renderToStaticMarkup(<OverviewPerformance data={data} />)
    expect(html).toContain('Campaign budget')
    expect(html).toContain('current observation')
    expect(html).toContain('$100 per day')
    expect(html).toContain('ad-set budget ownership not established')
    expect(html).toContain('Fictional Purchase cost adset 201')
    navigation.search = 'overview_level=campaign'
    html = renderToStaticMarkup(<OverviewPerformance data={data} />)
    expect(html).toContain('Configured budget')
    expect(html).toContain('$100 per day')
  })

  it.each([['campaign', '101'], ['adset', '201']] as const)('keeps exact %s amount, status, dates and time in its detail', (level, id) => {
    const data = fixture(), entity = data.meta.data!.entities.find(row => row.level === level && row.id === id)!
    const html = renderToStaticMarkup(<HierarchyDetail entity={entity} context={data.context} meta={data.meta.data!}
      sourceAsOf={data.meta.asOf!} group="results" onGroupChange={() => {}} />)
    for (const value of ['Budget and schedule', 'Current settings observed', data.context.asOf, 'Configured status', 'Effective status']) expect(html).toContain(value)
    expect(html).toContain('$100 per day')
    expect(html).toContain(level === 'campaign' ? 'Aug 1, 2026' : 'Aug 2, 2026')
    expect(html).toContain('may differ from settings during the selected period')
    expect(html).not.toContain('expected spend')
  })

  it('keeps shared campaign ownership explicit in side-by-side ad-set context', () => {
    const data = fixture(), selected = data.meta.data!.entities.filter(row => row.level === 'adset')
    const html = renderToStaticMarkup(<EntityComparison entities={selected} allEntities={data.meta.data!.entities}
      context={data.context} group="results" />)
    expect(html).toContain('Campaign budget')
    expect(html).toContain('Campaign 101')
    expect(html).toContain('Ad-set budget')
    expect(html).toContain('$40 per day')
    expect(html).not.toContain('$140')
  })

  it('exports each source amount once with ownership and current-configuration limits', () => {
    const data = fixture(), rows = collectReportExportRows(data, 'results')
    const campaignBudget = rows.filter(row => row.metric === 'Configured daily budget' && row.entity.includes('campaign 101'))
    expect(campaignBudget).toHaveLength(1)
    expect(campaignBudget[0]).toMatchObject({ value: 100, unit: 'money', source: 'meta_configuration',
      date_basis: 'configuration_observation', as_of: data.context.asOf })
    expect(campaignBudget[0].limitations).toMatch(/not.*historical|selected historical period/i)
    expect(rows.find(row => row.metric === 'Budget owner' && row.entity.includes('adset 201'))?.value).toContain('Campaign 101')
    expect(rows.find(row => row.metric === 'Configured daily budget' && row.entity.includes('campaign 102'))).toMatchObject({ value: null, unit: 'money', availability: 'missing' })
  })

  it('includes strict budget evidence in the prepared parent answer and leaves old missing evidence valid', () => {
    const data = fixture(), finding = deriveExpertReview(data).findings.find(row => row.id === 'performance:adset:201')!
    expect(finding.observation.text).toMatch(/campaign budget.*\$100 per day/i)
    expect(finding.budgetEvidence).toHaveLength(2)
    expect(finding.limitations.join(' ')).toContain('selected historical period')
    const old = purchaseCpaFixture(), before = JSON.stringify(old)
    expect(() => deriveExpertReview(old)).not.toThrow()
    expect(JSON.stringify(old)).toBe(before)
  })

  it('reopens exact current and older saved reviews while rejecting changed budget evidence', () => {
    const data = fixture(), review = deriveExpertReview(data)
    expect(validateSavedReview(structuredClone(review), data)).toEqual(review)
    const changed = structuredClone(review)
    const reference = changed.findings.find(row => row.id === 'performance:adset:201')!.budgetEvidence![1]
    reference.value.dailyBudget = { state: 'observed', minorUnits: 10000, majorUnits: 999 }
    expect(() => validateSavedReview(changed, data)).toThrow()
    const oldData = purchaseCpaFixture(), oldReview = { ...deriveExpertReview(oldData), playbookVersion: 'maxx-diagnostic-2026-09-07.v13' }
    expect(validateSavedReview(oldReview, oldData).playbookVersion).toBe('maxx-diagnostic-2026-09-07.v13')
  })

  it('keeps contradictory own and parent amounts separate and preserves schedule time and zone', () => {
    const data = fixture(), entity = data.meta.data!.entities.find(row => row.level === 'adset' && row.id === '201')!
    entity.budgetEvidence!.dailyBudget = { state: 'observed', minorUnits: 5000, majorUnits: 50 }
    entity.budgetEvidence!.startTime = { state: 'observed', value: '2026-09-05T20:30:00-04:00' }
    entity.budgetEvidence!.endTime = { state: 'observed', value: '2026-09-06T09:15:00-04:00' }
    validateReportingPacket({ section: 'meta', context: data.context, result: data.meta, notes: [] })
    const html = renderToStaticMarkup(<HierarchyDetail entity={entity} context={data.context} meta={data.meta.data!}
      sourceAsOf={data.meta.asOf!} group="results" onGroupChange={() => {}} />)
    for (const value of ['Budget ownership undetermined', 'Entity configuration', '$50 per day',
      'Parent campaign 101 budget evidence', '$100 per day', 'Sep 5, 2026, 8:30 PM EDT', 'Sep 6, 2026, 9:15 AM EDT']) expect(html).toContain(value)
  })
})
