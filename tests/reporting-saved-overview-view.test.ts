import { describe, expect, it } from 'vitest'
import { savedReportHome } from '@/components/reporting/SavedReportContext'
import { SavedReportSummarySchema, SavedViewSchema } from '@/lib/reporting/saved-contract'

const id = '00000000-0000-4000-8000-000000001401'
const missing = { state: 'missing', code: 'not_supplied', context: null } as const
const savedSummary = {
  id, title: 'Original dashboard view', createdAt: '2026-09-08T16:00:00Z',
  range: { from: '2026-09-02', to: '2026-09-04' },
  sourceSummary: { meta: missing, business: missing, website: missing, measurement: missing },
  versions: { manifest: 'report_saved.v1', review: 'report_review.v1', playbook: 'original-version', export: 'report_saved_export.v1' },
}

describe('saved dashboard comparison selection', () => {
  it('restores current dashboard selection state without obsolete hierarchy pagination', () => {
    const view = SavedViewSchema.parse({ pathname: '/dashboard', query: {
      from: '2026-09-02', to: '2026-09-04', overview_event: 'purchase', overview_level: 'adset',
      overview_q: 'Audience', overview_creative_page: '2', overview_creative_size: '5', overview_creative_q: 'Studio', overview_creative_sort: 'cpa',
    } })
    const saved = SavedReportSummarySchema.parse({ ...savedSummary, view })
    const before = JSON.stringify(saved)
    const url = new URL(savedReportHome(saved), 'https://maxx.test')
    expect(url.pathname).toBe('/dashboard')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: '2026-09-02', to: '2026-09-04', overview_event: 'purchase', overview_level: 'adset',
      overview_q: 'Audience', overview_creative_page: '2', overview_creative_size: '5', overview_creative_q: 'Studio', overview_creative_sort: 'cpa', saved: id,
    })
    expect(JSON.stringify(saved)).toBe(before)
  })

  it('rejects obsolete hierarchy pagination while retaining supported dashboard state', () => {
    const supported = { pathname: '/dashboard', query: {
      from: '2026-09-02', to: '2026-09-04', overview_event: 'purchase', overview_level: 'campaign',
      overview_q: 'Professional', overview_creative_page: '2', overview_creative_size: '5', overview_creative_q: 'Studio',
      overview_creative_sort: 'cpa', overview_creative_view: 'scatter', overview_creative_focus: 'lowest_cpa',
    } }
    expect(SavedViewSchema.safeParse(supported).success).toBe(true)
    expect(SavedViewSchema.safeParse({ ...supported, query: { ...supported.query, overview_hierarchy_page: '2' } }).success).toBe(false)
  })

  it('keeps older saved dashboard views valid without adding a page or changing their search', () => {
    const view = SavedViewSchema.parse({ pathname: '/dashboard', query: {
      from: '2026-09-02', to: '2026-09-04', overview_level: 'campaign', overview_q: 'Professional productions',
    }, hash: '#full-assessments' })
    const saved = SavedReportSummarySchema.parse({ ...savedSummary, view })
    const url = new URL(savedReportHome(saved), 'https://maxx.test')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: '2026-09-02', to: '2026-09-04', overview_level: 'campaign', overview_q: 'Professional productions', saved: id,
    })
    expect(url.hash).toBe('#full-assessments')
  })

  it('still rejects unsupported selections instead of accepting arbitrary new view parameters', () => {
    expect(SavedViewSchema.safeParse({ pathname: '/dashboard', query: {
      unsupported_selection: 'value',
    } }).success).toBe(false)
  })
})
