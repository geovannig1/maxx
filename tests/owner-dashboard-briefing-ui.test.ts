import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const page = readFileSync(join(process.cwd(), 'src/app/(dashboard)/dashboard/page.tsx'), 'utf8')
const cockpit = readFileSync(join(process.cwd(), 'src/components/dashboard/TodayPerformanceCockpit.tsx'), 'utf8')
const workspace = readFileSync(join(process.cwd(), 'src/components/reporting/ReportingWorkspace.tsx'), 'utf8')
const reportingHook = readFileSync(join(process.cwd(), 'src/lib/reporting/use-reporting-data.ts'), 'utf8')

describe('Today owner performance cockpit contract', () => {
  it('uses one selected-period reporting workspace instead of legacy independently scoped widgets', () => {
    expect(page).toContain('<ReportingWorkspace view="overview" />')
    expect(workspace).toContain('useReportingData()')
    expect(workspace).toContain('<OverviewReport data={data} />')
    expect(reportingHook).toContain('for (const section of REPORT_SOURCES)')
    expect(reportingHook).toContain('const sourceParams = new URLSearchParams(requestKey)')
    expect(reportingHook).toContain("if (section !== 'meta') sourceParams.delete('historyEntity')")
    expect(reportingHook).toMatch(/requestReportingPacket\(section, sourceParams\.toString\(\), controller.signal, refresh[,)]/)
    expect(page).not.toContain('OwnerDailyBriefing')
    expect(page).not.toContain('TodayPerformanceCockpit')
    expect(page).not.toContain('KpiGrid')
    expect(page).not.toContain('CampaignRoasPanel')
    expect(page).not.toContain('SourceToggle')
  })

  it('leads with Meta-only paid performance operating metrics', () => {
    expect(cockpit).toContain('Paid performance')
    expect(cockpit).toContain('purchaseRoasClaimId')
    expect(cockpit).toContain('linkCtrClaimId')
    expect(cockpit).toContain('frequencyClaimId')
    expect(cockpit).not.toMatch(/Acuity|checkout|amount paid|booked value|paid association/i)
  })

  it('shows canonical Meta Purchase ROAS and separates closed delivery, maturity, and sync clocks', () => {
    expect(cockpit).toContain('Canonical Meta purchase value')
    expect(cockpit).toContain('Meta only')
    expect(cockpit).toContain('Nothing changes in your ad account until you approve a change, and an approved change applies only with write mode on.')
    expect(cockpit).toContain('Delivery closed through')
    expect(cockpit).toContain('Conversions mature through')
    expect(cockpit).toContain('Synchronized at')
  })

  it('keeps evidence progressive and today-so-far outside the closed-period verdict', () => {
    expect(cockpit).toContain('<details')
    expect(cockpit).toContain('Meta evidence and diagnostics')
    // The 'Trends and comparisons' stub is gone: Today now renders a real daily series.
    expect(cockpit).toContain('DeliverySeriesChart')
    expect(cockpit).toContain('Delivery over time')
    expect(cockpit).toContain('Partial delivery only')
    expect(cockpit).toContain('does not affect the closed-period verdict')
  })
})
