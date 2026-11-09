import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SourceReconcileResult } from '@/lib/outcomes/reconciliation'
import type { OutcomeSourceRef } from '@/lib/outcomes/source-health'
import {
  outcomeArrivalLine,
  pushOnlyOutcomeArrival,
  reportOutcomesReady,
} from '@/lib/outcomes/report-gate'

// Daily (and Monday weekly) report gate for installs whose only enabled outcome sources are push-only
// (signed webhook, CSV import). Those adapters cannot reconcile, so waiting for a same-run source
// reconciliation skipped every report. Push-only installs now get a report labelled with how the
// outcomes arrived and no completeness claim; any reconciled source keeps the existing gate exactly.

const WINDOW = { startDate: '2026-10-08', endDate: '2026-11-06' }
const WEBHOOK: OutcomeSourceRef = { sourceId: 'src-webhook', kind: 'webhook' }
const CSV: OutcomeSourceRef = { sourceId: 'src-csv', kind: 'csv' }
const RECONCILED: OutcomeSourceRef = { sourceId: 'src-reconciled', kind: 'acuity' }

const COVERING: SourceReconcileResult = {
  available: true,
  truncated: false,
  completedAt: '2026-11-07T10:00:00Z',
  sourceWindowBasis: 'booking_date_et',
  windowStartDate: '2020-01-01',
  windowEndDate: '2026-11-06',
}
const NOT_RUN: SourceReconcileResult = { available: false, reason: 'reconciliation did not run' }
// What reconcileOutcomeSources returns on a push-only install: the registered reference adapter is
// not configured, so no reconciliation exists at all.
const NOT_CONFIGURED: SourceReconcileResult = { available: false, reason: 'not configured' }

const NO_CLAIM = /reconcil|complete/i

function ready(sources: OutcomeSourceRef[] | null, reconcile: SourceReconcileResult | null | undefined, lifecycleRun = true) {
  return reportOutcomesReady({
    lifecycleRun,
    arrival: pushOnlyOutcomeArrival(sources),
    reconcile,
    ...WINDOW,
  })
}

describe('pushOnlyOutcomeArrival', () => {
  it('labels a webhook-only install "As received"', () => {
    expect(pushOnlyOutcomeArrival([WEBHOOK])).toEqual({
      sources: [{ source_id: 'src-webhook', kind: 'webhook', label: 'As received' }],
    })
  })

  it('labels a CSV-only install "As imported"', () => {
    expect(pushOnlyOutcomeArrival([CSV])).toEqual({
      sources: [{ source_id: 'src-csv', kind: 'csv', label: 'As imported' }],
    })
  })

  it('labels each source of a webhook + CSV install', () => {
    expect(pushOnlyOutcomeArrival([CSV, WEBHOOK])?.sources.map((s) => s.label)).toEqual(['As imported', 'As received'])
  })

  it('is null whenever any enabled source reconciles, or the sources are unknown, unread or absent', () => {
    expect(pushOnlyOutcomeArrival([RECONCILED])).toBeNull()
    expect(pushOnlyOutcomeArrival([WEBHOOK, RECONCILED])).toBeNull()
    expect(pushOnlyOutcomeArrival([CSV, RECONCILED, WEBHOOK])).toBeNull()
    expect(pushOnlyOutcomeArrival([{ sourceId: 'x', kind: 'not-a-registered-kind' }])).toBeNull()
    expect(pushOnlyOutcomeArrival([])).toBeNull()
    expect(pushOnlyOutcomeArrival(null)).toBeNull()
    expect(pushOnlyOutcomeArrival(undefined)).toBeNull()
  })
})

describe('reportOutcomesReady', () => {
  it('(1) produces the report for push-only installs although no reconciliation exists', () => {
    for (const sources of [[WEBHOOK], [CSV], [WEBHOOK, CSV]]) {
      expect(ready(sources, NOT_CONFIGURED)).toBe(true)
      expect(ready(sources, undefined)).toBe(true)
      expect(ready(sources, null)).toBe(true)
    }
  })

  it('(2) skips the report when a reconciled source is enabled and the same-run reconciliation is missing, incomplete or truncated (control: the gate is not always true)', () => {
    expect(ready([RECONCILED], undefined)).toBe(false)
    expect(ready([RECONCILED], null)).toBe(false)
    expect(ready([RECONCILED], NOT_RUN)).toBe(false)
    expect(ready([RECONCILED], { ...COVERING, truncated: true })).toBe(false)
    expect(ready([RECONCILED], { ...COVERING, truncated: undefined })).toBe(false)
    expect(ready([RECONCILED], { ...COVERING, sourceWindowBasis: 'appointment_date' })).toBe(false)
    expect(ready([RECONCILED], { ...COVERING, completedAt: undefined })).toBe(false)
    expect(ready([RECONCILED], { ...COVERING, windowEndDate: '2026-11-05' })).toBe(false)
    expect(ready([RECONCILED], { ...COVERING, windowStartDate: '2026-10-09' })).toBe(false)
  })

  it('(3) produces the report for a reconciled source whose same-run reconciliation covers the window', () => {
    expect(ready([RECONCILED], COVERING)).toBe(true)
  })

  it('(4) skips mixed reconciled + push-only installs without a covering reconciliation, and keeps them gated with one', () => {
    expect(ready([WEBHOOK, RECONCILED], NOT_CONFIGURED)).toBe(false)
    expect(ready([CSV, RECONCILED], undefined)).toBe(false)
    expect(ready([WEBHOOK, CSV, RECONCILED], { ...COVERING, truncated: true })).toBe(false)
    expect(ready([WEBHOOK, RECONCILED], COVERING)).toBe(true)
  })

  it('keeps the existing behaviour with no enabled source or an unreadable source list: the reconciliation gate decides', () => {
    expect(ready([], NOT_CONFIGURED)).toBe(false)
    expect(ready(null, NOT_CONFIGURED)).toBe(false)
    expect(ready([], COVERING)).toBe(true)
  })

  it('leaves historical (non-lifecycle) runs ungated, as before', () => {
    expect(ready([RECONCILED], undefined, false)).toBe(true)
    expect(ready([], undefined, false)).toBe(true)
  })
})

describe('outcomeArrivalLine', () => {
  it('names how outcomes arrived and makes no completeness claim', () => {
    const webhook = outcomeArrivalLine(pushOnlyOutcomeArrival([WEBHOOK]))
    const both = outcomeArrivalLine(pushOnlyOutcomeArrival([WEBHOOK, CSV]))
    expect(webhook).toContain('As received')
    expect(webhook).not.toContain('As imported')
    expect(both).toContain('As received')
    expect(both).toContain('As imported')
    for (const line of [webhook, both]) expect(line).not.toMatch(NO_CLAIM)
  })

  it('adds nothing when the sources are not all push-only', () => {
    expect(outcomeArrivalLine(null)).toBe('')
  })
})

// --- generateDailyReport records the label on the report (report_json + visible markdown) ---------

const captured = vi.hoisted(() => ({ payloads: [] as Array<Record<string, unknown>> }))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.maybeSingle = async () => ({ data: { account_name: 'Fixture', timezone_name: null }, error: null })
      return chain
    },
  }),
}))
vi.mock('@/lib/report/executive-evidence-production', () => ({
  buildExecutiveEvidenceForReport: async () => ({
    outcomes: {
      byWindow: {
        lastDay: {
          activeAmountPaidRevenue: 120,
          activeAmountPaidObserved: 120,
          amountPaidCoverage: { withRecordedAmount: 2, total: 2 },
        },
      },
    },
    sources: { outcomes: { availability: 'available' } },
  }),
}))
vi.mock('@/lib/report/executive-evidence-store', () => ({
  commitExecutiveEvidenceGeneration: async () => ({ id: 'evidence-1' }),
}))
vi.mock('@/lib/report/daily-digest-wiring', () => ({
  buildCommittedDailyDigest: async () => ({ kpis: [], narrative: { text: 'Summary.' } }),
}))
vi.mock('@/lib/report/daily-digest', async (o: () => Promise<Record<string, unknown>>) => ({
  ...(await o()),
  renderDailyDigestMarkdown: () => '# Daily digest',
}))
vi.mock('@/lib/flags/generations', async (o: () => Promise<Record<string, unknown>>) => ({
  ...(await o()),
  commitDailyReportGeneration: async (_db: unknown, args: { payload: Record<string, unknown> }) => {
    captured.payloads.push(args.payload)
    return { committed: false, reason: 'captured' }
  },
}))

const PLANE = { complete: true, blockerCodes: [] as string[] }

async function generate(outcomeArrival?: ReturnType<typeof pushOnlyOutcomeArrival>) {
  const { generateDailyReport } = await import('@/lib/report/generator')
  await generateDailyReport('acct-1', '2026-11-06', null, {
    sourceNotBefore: '2026-11-07T09:00:00Z',
    metaOutcomePlane: PLANE,
    ...(outcomeArrival === undefined ? {} : { outcomeArrival }),
  })
  return captured.payloads.at(-1) as {
    full_report_md: string
    report_json: Record<string, unknown>
    business_revenue: unknown
  }
}

describe('generateDailyReport records how push-only outcomes arrived', () => {
  beforeEach(() => { captured.payloads = [] })

  it('records the label on report_json and in the report text, with no completeness wording', async () => {
    const arrival = pushOnlyOutcomeArrival([WEBHOOK, CSV])
    const payload = await generate(arrival)
    expect(payload.report_json.outcome_arrival).toEqual(arrival)
    expect(JSON.stringify(payload.report_json.outcome_arrival)).not.toMatch(NO_CLAIM)
    expect(payload.full_report_md).toContain(outcomeArrivalLine(arrival))
    expect(outcomeArrivalLine(arrival)).not.toBe('')
  })

  it('leaves the money basis and the reconciled-source report unchanged (control)', async () => {
    const reconciled = await generate()
    const nullArrival = await generate(null)
    const pushOnly = await generate(pushOnlyOutcomeArrival([CSV]))
    expect(reconciled.report_json).not.toHaveProperty('outcome_arrival')
    expect(nullArrival.report_json).not.toHaveProperty('outcome_arrival')
    expect(nullArrival.full_report_md).toBe(reconciled.full_report_md)
    expect(pushOnly.full_report_md).not.toBe(reconciled.full_report_md)
    // the money basis differs only in the explicit source completeness it now states.
    const { source_completeness: pushCompleteness, ...pushBasis } = pushOnly.report_json.money_basis as Record<string, unknown>
    const { source_completeness: reconciledCompleteness, ...reconciledBasis } = reconciled.report_json.money_basis as Record<string, unknown>
    expect(pushBasis).toEqual(reconciledBasis)
    expect(pushCompleteness).toBe('as_received')
    expect(reconciledCompleteness).toBe('reconciled')
    expect(pushOnly.business_revenue).toBe(reconciled.business_revenue)
  })
})
