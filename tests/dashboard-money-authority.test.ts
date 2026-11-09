import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { projectMorningMetaDelivery } from '@/app/api/morning-brief/route'

const read = (path: string) => readFileSync(path, 'utf8')

describe('dashboard and morning-brief money authority', () => {
  it('projects raw Meta delivery context without producing paid-performance authority', () => {
    const context = projectMorningMetaDelivery({ total_spend: 72, total_bookings: 2 })
    expect(context).toEqual({
      available: true,
      spend: 72,
      modelled_results: 2,
      evidence_basis: 'meta_modelled',
      action_authority: 'diagnostic_only',
    })
    expect(JSON.stringify(context)).not.toMatch(/cpa|roas|healthy|under|over|scale|keep|cut/i)
  })

  it('does not fabricate zero delivery from an incomplete committed report', () => {
    expect(projectMorningMetaDelivery({ total_spend: null, total_bookings: 0 })).toMatchObject({
      available: false,
      spend: null,
      modelled_results: null,
      unavailable_reason: 'incomplete_committed_daily_report',
    })
    expect(projectMorningMetaDelivery({ total_spend: 'not-a-number', total_bookings: 2 })).toMatchObject({
      available: false,
      unavailable_reason: 'incomplete_committed_daily_report',
    })
  })

  it('keeps the owner surfaces free of modelled CPA status and champion-derived instructions', () => {
    const page = read('src/app/(dashboard)/dashboard/page.tsx')
    const verdict = read('src/lib/dashboard/verdict.ts')
    const economics = read('src/components/dashboard/EconomicsCard.tsx')
    const route = read('src/app/api/morning-brief/route.ts')
    const brief = read('src/components/dashboard/MorningBrief.tsx')
    const kpis = read('src/components/dashboard/KpiGrid.tsx')
    const ownerSurface = [page, verdict, economics, route, brief, kpis].join('\n')

    expect(ownerSurface).not.toMatch(/getMetricStatus\(['"]cpa|cpa_status|cpa_delta_pct|championVerdict/)
    expect(ownerSurface).not.toMatch(/Keep it running|raise-budget condition|Beating the champion|At the champion level|Scale opportunities/i)
    expect(route).not.toMatch(/select\(['"]avg_cpb|cpa_target/)
    expect(kpis).not.toMatch(/current\.cpb|Meta CPA/)
    expect(economics).toMatch(/audit context/i)
    expect(economics).toMatch(/outcome ledger/i)
    expect(economics).toMatch(/Meta modelled/i)
  })
})
