import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

describe('owner workflow/history screen contracts', () => {
  it('uses the canonical inbox triage buckets in order', () => {
    const inbox = read('src/components/inbox/InboxClient.tsx')

    const labels = [
      'Urgent',
      'Needs decision',
      'Manual work',
      'Waiting / blocked',
      'Informational / resolved',
    ]

    for (const label of labels) expect(inbox).toContain(`title="${label}"`)
    expect(inbox.indexOf('title="Urgent"')).toBeLessThan(inbox.indexOf('title="Needs decision"'))
    expect(inbox.indexOf('title="Needs decision"')).toBeLessThan(inbox.indexOf('title="Manual work"'))
    expect(inbox.indexOf('title="Manual work"')).toBeLessThan(inbox.indexOf('title="Waiting / blocked"'))
    expect(inbox.indexOf('title="Waiting / blocked"')).toBeLessThan(inbox.indexOf('title="Informational / resolved"'))
  })

  it('demotes approvals to readiness unless a real actionable proposal exists', () => {
    const page = read('src/app/(dashboard)/approvals/page.tsx')
    const queue = read('src/components/approvals/ApprovalsQueue.tsx')

    expect(page).toContain('title="Approval readiness"')
    expect(page).not.toContain('title="Approvals"')
    expect(queue).toContain('No actionable approval proposals')
    expect(queue).toContain('Approval readiness')
    expect(queue).toContain('actionable: false')
  })

  it('labels changes as lineage and review detail, not a generic pending-change queue', () => {
    const page = read('src/app/(dashboard)/changes/page.tsx')

    expect(page).toContain('title="Change lineage & review"')
    expect(page).toContain('lineage')
    expect(page).toContain('rollback')
    expect(page).not.toContain('title="Pending Changes"')
  })

  it('keeps Activity focused on the immutable lifecycle timeline with mobile-sized tab targets', () => {
    const layout = read('src/app/(dashboard)/activity/layout.tsx')

    expect(layout).toContain("label: 'Lifecycle timeline'")
    expect(layout).not.toContain("label: 'Reports'")
    expect(layout).not.toContain("label: 'Learnings'")
    expect(layout).toContain('minHeight: 44')
  })

  it('keeps the legacy report-history destination account scoped and linked to dated reports', () => {
    const reports = read('src/app/(dashboard)/activity/reports/page.tsx')

    expect(reports).toContain('resolveOnlyActiveAccount(db)')
    expect(reports).toMatch(/from\('daily_reports'\)[\s\S]{0,500}\.eq\('ad_account_id', active\.account\.id\)/)
    expect(reports).toContain('href={`/reports/${row.report_date}`}')
    expect(reports).not.toContain('total_spend')
    expect(reports).not.toContain('total_bookings')
    expect(reports).not.toContain('avg_cpb')
    expect(reports).not.toContain('Acuity')
    expect(reports).not.toContain('checkout')
  })
})
