import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

import { NAV, ALL_NAV_ITEMS } from '@/components/layout/nav-config'
import { PlanEditor } from '@/components/campaigns/PlanEditor'
import { PlanBriefForm } from '@/components/campaigns/PlanBriefForm'
import { PlanReadinessList } from '@/components/campaigns/PlanChecklist'
import { validSpec } from './_support/campaign-plan-fixtures'

// ADR-062 console: the sidebar reaches New campaign, Campaign plans and the Copy studio; the brief form
// says what AI off means; the editor shows findings inline and will not submit a plan with a blocker.

describe('campaign plan console', () => {
  it('puts New campaign and Campaign plans under Ads, and the Copy studio under Creative', () => {
    const [primary] = NAV
    expect(primary.items.find((i) => i.label === 'Ads')?.children?.map((c) => c.href)).toEqual(['/campaigns/new', '/campaigns/plans'])
    expect(primary.items.find((i) => i.label === 'Creative')?.children?.map((c) => c.href)).toEqual(['/creative/copy'])
    expect(ALL_NAV_ITEMS.filter((i) => i.href === '/creative/copy')).toHaveLength(1)
  })

  it('explains the template planner when AI is off', () => {
    const html = renderToStaticMarkup(<PlanBriefForm aiOn={false} today="2026-11-09" />)
    expect(html).toContain('AI is off: the template planner drafts it')
    expect(html).toMatch(/disabled=""/)
  })

  it('shows a blocker under its field and keeps Submit disabled', () => {
    const issues = [{ path: 'campaign.daily_budget_minor', code: 'budget_below_meta_minimum', severity: 'blocker' as const, message: 'Below Meta minimum.' }]
    const html = renderToStaticMarkup(<PlanEditor planId="p1" versionId="v1" status="draft" spec={validSpec()} issues={issues} audiences={[]} minorPerMajor={100} writeMode="off" />)
    expect(html).toContain('Below Meta minimum.')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-plan-submit/)
    const clean = renderToStaticMarkup(<PlanEditor planId="p1" versionId="v1" status="draft" spec={validSpec()} issues={[]} audiences={[]} minorPerMajor={100} writeMode="off" />)
    expect(clean).not.toMatch(/<button[^>]*disabled=""[^>]*data-plan-submit/)
    expect(clean).toContain('value="30"')
  })

  it('locks a plan that is waiting for approval', () => {
    const html = renderToStaticMarkup(<PlanEditor planId="p1" versionId="v1" status="pending_approval" spec={validSpec()} issues={[]} audiences={[]} minorPerMajor={100} writeMode="on" />)
    expect(html).not.toContain('data-plan-submit')
    expect(html).not.toContain('Save as new version')
  })

  it('lists readiness with an accessible status', () => {
    const html = renderToStaticMarkup(<PlanReadinessList items={[{ id: 'audience_size', label: 'Audience size known', status: 'unknown', detail: 'Withheld.' }]} />)
    expect(html).toContain('data-status="unknown"')
    expect(html).toContain('(unknown)')
  })
})
