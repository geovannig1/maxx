import './_support/outcome-noun-booking'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import {
  applyMetaSpendWindowHealth,
  resolveDashboardMetaOutcomeReadHealth,
  resolveDashboardMetaReadHealth,
} from '@/lib/dashboard/read-health'
import { KpiGrid, type KpiSet } from '@/components/dashboard/KpiGrid'
import { aggregateDashboardReportKpis } from '@/components/dashboard/dashboard-data'

const activeAccount = {
  ok: true,
  account: { id: 'account-a', accountId: 'act_account-a', accountName: 'Studio A' },
} as const
const zero: KpiSet = {
  spend: 0,
  leads: 0,
  bookings: 0,
  realBookings: 2,
  realRevenue: 1000,
  cpl: null,
  cpb: null,
}
const availableDelivery = resolveDashboardMetaReadHealth(activeAccount, 'daily_reports', null)
const availableOutcomes = resolveDashboardMetaOutcomeReadHealth(availableDelivery, [
  { report_date: '2026-08-20', total_leads: 0, total_bookings: 0 },
], { start: '2026-08-20', end: '2026-08-20' })

describe('dashboard Meta read health', () => {
  it('keeps a successful empty/zero read available', () => {
    expect(resolveDashboardMetaReadHealth(activeAccount, 'daily_reports', null)).toEqual({
      status: 'available',
      source: 'daily_reports',
      evidence_basis: 'meta_modelled',
      reason_code: null,
      unavailable_reason: null,
    })
  })

  it('distinguishes query failure and ambiguous ownership from zero', () => {
    expect(resolveDashboardMetaReadHealth(activeAccount, 'daily_reports', { message: 'offline' })).toMatchObject({
      status: 'unavailable',
      reason_code: 'DAILY_REPORTS_READ_FAILED',
    })
    expect(resolveDashboardMetaReadHealth({ ok: false, reason: 'ambiguous' }, 'daily_insights', null)).toMatchObject({
      status: 'unavailable',
      reason_code: 'ACTIVE_ACCOUNT_AMBIGUOUS',
    })
  })

  it('marks a successful-but-incomplete insight window unavailable', () => {
    const base = resolveDashboardMetaReadHealth(activeAccount, 'daily_reports', null)
    expect(applyMetaSpendWindowHealth(base, {
      status: 'unavailable', totalSpend: null, dayCount: null,
      blockerCodes: ['meta_spend_day_missing:2026-08-14'],
    })).toMatchObject({
      status: 'unavailable',
      reason_code: 'META_INSIGHT_WINDOW_INCOMPLETE',
    })
  })

  it('marks missing or partially-null report outcomes unavailable independently of delivery', () => {
    expect(resolveDashboardMetaOutcomeReadHealth(availableDelivery, [])).toMatchObject({
      status: 'unavailable',
      reason_code: 'META_OUTCOME_ROWS_MISSING',
    })
    expect(resolveDashboardMetaOutcomeReadHealth(availableDelivery, [
      { total_leads: 2, total_bookings: 1 },
      { total_leads: null, total_bookings: null },
    ])).toMatchObject({
      status: 'unavailable',
      reason_code: 'META_OUTCOME_WINDOW_INCOMPLETE',
    })
    expect(availableDelivery.status).toBe('available')
  })

  it('marks successful report reads with missing expected closed dates unavailable', () => {
    expect(resolveDashboardMetaOutcomeReadHealth(availableDelivery, [
      { report_date: '2026-08-18', total_leads: 0, total_bookings: 2 },
      { report_date: '2026-08-20', total_leads: 0, total_bookings: 1 },
    ], { start: '2026-08-18', end: '2026-08-20' })).toMatchObject({
      status: 'unavailable',
      reason_code: 'META_OUTCOME_WINDOW_INCOMPLETE',
    })
  })

  it('allows a complete closed-date outcome window with measured zeroes', () => {
    expect(resolveDashboardMetaOutcomeReadHealth(availableDelivery, [
      { report_date: '2026-08-19', total_leads: 0, total_bookings: 0 },
      { report_date: '2026-08-20', total_leads: 0, total_bookings: 0 },
    ], { start: '2026-08-19', end: '2026-08-20' })).toMatchObject({
      status: 'available',
      reason_code: null,
    })
  })

  it('never aggregates a mixed outcome window into a partial total', () => {
    expect(aggregateDashboardReportKpis([
      { report_date: '2026-08-13', total_spend: 25, total_leads: 2, total_bookings: 1, business_outcomes: null, business_revenue: null, avg_cpl: 12.5, avg_cpb: 25 },
      { report_date: '2026-08-14', total_spend: 30, total_leads: null, total_bookings: null, business_outcomes: null, business_revenue: null, avg_cpl: null, avg_cpb: null },
    ])).toMatchObject({ leads: null, bookings: null, cpl: null, cpb: null })
  })

  it('wires every core Meta aggregate query through validation into the page-level source state', () => {
    const reader = readFileSync('src/lib/platforms/meta/reporting/meta-reader.ts', 'utf8')
    const loader = readFileSync('src/lib/reporting/loader.ts', 'utf8')
    const validator = readFileSync('src/lib/reporting/validation.ts', 'utf8')
    const route = readFileSync('src/app/api/reporting/route.ts', 'utf8')
    const page = readFileSync('src/app/(dashboard)/dashboard/page.tsx', 'utf8')
    const workspace = readFileSync('src/components/reporting/ReportingWorkspace.tsx', 'utf8')
    const hook = readFileSync('src/lib/reporting/use-reporting-data.ts', 'utf8')
    const request = readFileSync('src/lib/reporting/request-packet.ts', 'utf8')

    expect(reader).toMatch(/\['account', 'campaign', 'adset', 'ad'\]/)
    expect(reader).toContain('Promise.allSettled')
    expect(reader).toContain('Omitted dates/entities are unknown, not measured zero.')
    expect(route).toMatch(/getUser\(\)[\s\S]*if \(!user\)[\s\S]*resolveOnlyActiveAccount\(\)[\s\S]*loadReportingSection\(/)
    expect(loader).toMatch(/readMetaReport\(context, \{ detailIds, onProgress: publish,/)
    expect(loader).toContain('...(historyEntity ? { historyEntity } : {})')
    expect(loader).toMatch(/const validate = \(raw: unknown\)[\s\S]*validateReportingPacket\(raw\)/)
    expect(loader).toMatch(/const packet = validate\(\{ context, section, result, notes: \[\] \}\)/)
    expect(validator).toContain("meta: { system: 'meta', role: 'delivery_truth', evidencePlane: 'meta_delivery' }")
    expect(page).toContain('<ReportingWorkspace view="overview" />')
    expect(workspace).toContain('useReportingData()')
    expect(workspace).toContain("state === 'partial' ? 'Partial evidence' : 'Unavailable'")
    expect(workspace).toContain('onClick={() => retry(source)}')
    expect(hook).toContain('const sourceParams = new URLSearchParams(requestKey)')
    expect(hook).toContain("if (section !== 'meta') sourceParams.delete('historyEntity')")
    expect(hook).toMatch(/requestReportingPacket\(section, sourceParams\.toString\(\), controller.signal, refresh[,)]/)
    expect(request).toMatch(/fetch\(`\/api\/reporting\?\$\{key\}&section=\$\{section\}/)
    expect(hook).toMatch(/\[section\]: \{ state: 'unavailable', data: null/)
  })

  it('renders a real zero only after a successful read', () => {
    const html = renderToStaticMarkup(<KpiGrid
      current={zero}
      previous={zero}
      series={{ spend: [], leads: [], cpl: [] }}
      currency="USD"
      comparisonLabel="vs prior"
      metaRead={availableDelivery}
      metaOutcomeRead={availableOutcomes}
    />)

    expect(html).toMatch(/Meta spend/)
    expect(html).toMatch(/\$0\.00/)
    expect(html).toMatch(/Meta modelled events/)
    expect(html).not.toMatch(/Meta delivery is unavailable/)
  })

  it('preserves available spend while rendering incomplete outcomes unavailable', () => {
    const incomplete: KpiSet = { ...zero, spend: 50, leads: null, bookings: null }
    const outcomeRead = resolveDashboardMetaOutcomeReadHealth(availableDelivery, [
      { report_date: '2026-08-20', total_leads: null, total_bookings: null },
    ])
    const html = renderToStaticMarkup(<KpiGrid
      current={incomplete}
      previous={incomplete}
      series={{ spend: [20, 30], leads: [], cpl: [] }}
      currency="USD"
      comparisonLabel="vs prior"
      metaRead={availableDelivery}
      metaOutcomeRead={outcomeRead}
    />)

    expect(html).toMatch(/Meta spend/)
    expect(html).toMatch(/\$50\.00/)
    expect(html).toMatch(/Meta leads[\s\S]*Unavailable/)
    expect(html).toMatch(/Meta modelled events[\s\S]*Unavailable/)
    expect(html).toMatch(/Meta delivery remains available/)
    expect(html).not.toMatch(/Meta leads[\s\S]*>0</)
  })

  it('renders failed Meta reads unavailable while preserving Acuity business values', () => {
    const html = renderToStaticMarkup(<KpiGrid
      current={zero}
      previous={zero}
      series={{ spend: [], leads: [], cpl: [] }}
      currency="USD"
      comparisonLabel="vs prior"
      metaRead={resolveDashboardMetaReadHealth(activeAccount, 'daily_reports', { message: 'offline' })}
      metaOutcomeRead={resolveDashboardMetaOutcomeReadHealth(
        resolveDashboardMetaReadHealth(activeAccount, 'daily_reports', { message: 'offline' }),
        [],
      )}
    />)

    expect(html).toMatch(/Meta delivery is unavailable \(DAILY_REPORTS_READ_FAILED\)/)
    expect(html).toMatch(/Real bookings/)
    expect(html).toMatch(/>2</)
    // Compact currency formatting is ICU-version dependent: Node 22 renders "$1.0K", Node 24 "$1K".
    // The claim under test is that the Acuity revenue survives a failed Meta read — not which
    // compact form the runtime chose — so accept either rather than pinning one Node version.
    expect(html).toMatch(/\$1(\.0)?K/)
    expect(html).not.toMatch(/\$0\.00/)
  })
})
