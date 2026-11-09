import './_support/outcome-noun-booking'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buildDailyDigest,
  isDailyDigestV2,
  isDailyDigestV3,
  readDailyDigestSnapshot,
  type DailyDigestInput,
} from '@/lib/report/daily-digest'
import { PACING_TARGET_CAVEAT } from '@/lib/report/daily-digest-signals'
import {
  deliverDailyDigestSafely,
  type DailyDigestDeliveryLedger,
  type DailyDigestDeliveryRequest,
} from '@/lib/report/daily-digest-delivery'
import { weeklyExecutiveEvidenceFixture } from './fixtures/weekly-executive'

function unavailableExecutiveEvidence() {
  const evidence = structuredClone(weeklyExecutiveEvidenceFixture)
  evidence.outcomes = null
  evidence.meta = null
  evidence.metaColdWarm = null
  evidence.metaPlacements = null
  evidence.tracking = null
  evidence.capi = null
  evidence.gaIdentity = null
  evidence.paidCohort = null
  evidence.setupChanges = null
  for (const source of Object.values(evidence.sources)) {
    source.availability = 'unavailable'
    source.head = null
    source.blockerCodes = ['test_source_unavailable']
  }
  evidence.blockerCodes = ['test_source_unavailable']
  return evidence
}

function input(overrides: Partial<DailyDigestInput> = {}): DailyDigestInput {
  return {
    reportDate: '2026-03-10',
    accountName: 'Example Studio',
    today: { spend: 92.4, leads: 2, bookings: 1, ctr: 1.7, cpl: 23.1 },
    sevenDayDailyAverage: { spend: 88.6, leads: 2, bookings: 1, ctr: 1.62, cpl: 22.15 },
    dailyBudgetTarget: 88.6,
    executiveEvidence: unavailableExecutiveEvidence(),
    ...overrides,
  }
}

describe('daily digest', () => {
  it('emits V3 with three independent descriptive states and no composite verdict', () => {
    const digest = buildDailyDigest(input())

    expect(digest.contract_version).toBe(3)
    expect(Object.keys(digest.states)).toEqual(['business', 'paid_delivery', 'data_confidence'])
    expect(digest.states).toEqual({
      business: expect.objectContaining({ state: 'unavailable' }),
      paid_delivery: expect.objectContaining({ state: 'unavailable' }),
      data_confidence: expect.objectContaining({ state: 'unavailable' }),
    })
    expect(digest).not.toHaveProperty('verdict')
  })

  it('leaves current-budget pacing unclassified instead of changing states or narrative', () => {
    const onTarget = buildDailyDigest(input({ dailyBudgetTarget: 92.4 }))
    const farOff = buildDailyDigest(input({ dailyBudgetTarget: 200 }))
    const unavailable = buildDailyDigest(input({ dailyBudgetTarget: null }))

    expect(onTarget.pacing).toEqual({ spend: 92.4, target: null, band: 'unavailable' })
    expect(farOff.pacing).toEqual(onTarget.pacing)
    expect(unavailable.pacing.band).toBe('unavailable')
    expect(farOff.states).toEqual(onTarget.states)
    expect(unavailable.states).toEqual(onTarget.states)
    expect(farOff.narrative).toEqual(onTarget.narrative)
    expect(unavailable.narrative).toEqual(onTarget.narrative)
  })

  it('renders deterministic evidence language without unsupported healthy or maturity-day claims', () => {
    const digest = buildDailyDigest(input())

    expect(digest.narrative.source).toBe('deterministic')
    expect(digest.markdown).not.toMatch(/\bhealthy\b/i)
    expect(digest.markdown).not.toMatch(/\bday\s+\d+\b/i)
  })

  it('renders every deterministic section on a quiet day without an LLM', () => {
    const digest = buildDailyDigest(input())

    expect(digest.contract_version).toBe(3)
    expect(digest.subject).toBe('Maxx daily digest — 2026-03-10')
    expect(digest.markdown).toContain('## Observed flags\n- Setup history: unavailable')
    expect(digest.flags.some((flag) => flag.startsWith('- '))).toBe(false)
    expect(digest.markdown).toContain('- Amount Spent: $92.40 — +4.3% versus the prior seven-day daily average — within noise.')
    expect(digest.markdown).toContain('Creative setup unavailable in the committed executive evidence.')
    expect(digest.markdown).toContain('Governed actions unavailable — governed_actions_not_connected.')
    expect(digest.markdown).not.toMatch(/winner|loser|scale|kill/i)
  })

  it('projects only the governed-action state committed in executive evidence', () => {
    const evidence = structuredClone(weeklyExecutiveEvidenceFixture)
    const digest = buildDailyDigest(input({ executiveEvidence: evidence }))
    expect(digest.action_authority_tier).toBe('diagnostic_only')
    expect(digest.decisions).toEqual(['Governed actions unavailable — governed_actions_not_connected.'])
  })

  it('keeps the governance invariants unchanged in v3', () => {
    const digest = buildDailyDigest(input())

    expect(digest.generated_from).toBe('committed_report_facts')
    expect(digest.action_authority_tier).toBe('diagnostic_only')
    expect(digest.prescriptions).toEqual([])
    expect(digest.change_reporting_threshold_pct).toBe(20)
  })
})

describe('daily digest v3 contract', () => {
  it('emits contract v3 with independent states, pacing, and gated kpis', () => {
    const digest = buildDailyDigest(input({ dailyBudgetTarget: 100 }))

    expect(digest.contract_version).toBe(3)
    expect(digest).not.toHaveProperty('verdict')
    expect(digest.pacing).toEqual({ spend: input().today.spend, target: null, band: 'unavailable' })
    const spendRow = digest.kpis.find((k) => k.key === 'spend')
    expect(spendRow?.unit).toBe('money')
    expect(spendRow?.value).toBe(92.4)
    expect(digest.kpis.map((k) => k.key)).toEqual(['spend', 'leads', 'bookings_real', 'bookings_meta', 'ctr', 'cpl'])
  })

  it('carries the three delta states apart — a missing baseline is never "within noise"', () => {
    const digest = buildDailyDigest(input({
      today: { spend: 92.4, leads: 30, bookings: 1, ctr: 1.7, cpl: 23.1 },
      sevenDayDailyAverage: { spend: 88.6, leads: 5, bookings: 1, ctr: null, cpl: 22.15 },
    }))
    const byKey = Object.fromEntries(digest.kpis.map((k) => [k.key, k]))

    expect(byKey.leads.state).toBe('significant')
    expect(byKey.leads.noise_gated).toBe(false)
    expect(byKey.spend.state).toBe('within_noise')
    expect(byKey.ctr.state).toBe('no_baseline')
    expect(byKey.ctr.delta_pct).toBeNull()
    expect(digest.markdown).toContain('- Link CTR (Meta): 1.70% — no comparable prior seven-day daily average.')
    expect(digest.markdown).not.toMatch(/Link CTR \(Meta\).*within noise/)
  })

  it('renders an absent Acuity booking plane as unavailable, never as zero', () => {
    const digest = buildDailyDigest(input())
    const real = digest.kpis.find((k) => k.key === 'bookings_real')

    expect(real).toMatchObject({ value: null, unit: 'count', state: 'no_baseline', delta_pct: null })
    expect(digest.markdown).toContain('- Value-bearing bookings (outcome ledger): unavailable — no comparable prior seven-day daily average.')
    expect(digest.markdown).not.toContain('Value-bearing bookings (outcome ledger): 0')
  })

  it('reports the real booking plane when the Acuity value is present', () => {
    const digest = buildDailyDigest(input({
      today: { spend: 92.4, leads: 2, bookings: 1, ctr: 1.7, cpl: 23.1, bookingsReal: 3 },
      sevenDayDailyAverage: { spend: 88.6, leads: 2, bookings: 1, ctr: 1.62, cpl: 22.15, bookingsReal: 2 },
    }))
    const real = digest.kpis.find((k) => k.key === 'bookings_real')

    expect(real?.value).toBe(3)
    expect(real?.state).toBe('within_noise')
    expect(digest.markdown).toContain('- Value-bearing bookings (outcome ledger): 3 — +50.0% versus the prior seven-day daily average — within noise.')
  })

  it('does not classify reported-day spend against current budget settings', () => {
    const digest = buildDailyDigest(input({ dailyBudgetTarget: 88.6 }))

    expect(digest.markdown).toContain(
      '## Spend context\nReported-day spend: $92.40.\n'
      + 'Weekly budget comparison unavailable — no exact budget-effective interval was provided for the trailing seven-day window.',
    )
    expect(digest.markdown).not.toContain(PACING_TARGET_CAVEAT)
  })

  it('omits the target caveat when no target was read — there is nothing to caveat', () => {
    expect(buildDailyDigest(input({ dailyBudgetTarget: null })).markdown).not.toContain(PACING_TARGET_CAVEAT)
  })

  it('never claims pacing is on target when no budget target could be read', () => {
    const digest = buildDailyDigest(input({ dailyBudgetTarget: null }))

    expect(digest.pacing).toEqual({ spend: 92.4, target: null, band: 'unavailable' })
    expect(digest).not.toHaveProperty('verdict')
    expect(digest.markdown).toContain('## Spend context\nReported-day spend: $92.40.')
    expect(digest.markdown).toContain('Weekly budget comparison unavailable')
    expect(digest.markdown).not.toMatch(/pacing green/)
  })

  it('does not call $261.10 trailing spend off pace against a $266 current-budget approximation', () => {
    const digest = buildDailyDigest(input({
      today: { ...input().today, spend: 261.1 },
      dailyBudgetTarget: 38,
    }))

    expect(digest.pacing).toEqual({ spend: 261.1, target: null, band: 'unavailable' })
    expect(digest.markdown).not.toMatch(/off pace|over target|under target|pacing (green|red|yellow|orange)/i)
  })

  it('renders creative wrapper and media identity only from committed setup evidence', () => {
    const evidence = structuredClone(weeklyExecutiveEvidenceFixture)
    const digest = buildDailyDigest(input({ executiveEvidence: evidence }))

    expect(digest.creative[0]).toContain('active ad wrappers')
    expect(digest.creative.join('\n')).toContain('media reuse not observed')
    expect(digest.creative.some((line) => line.startsWith('- '))).toBe(false)
    expect(digest.creative.join('\n')).not.toMatch(/frequency|retention/i)
  })

  it('initialises the narrative deterministically and mirrors it in the markdown', () => {
    const digest = buildDailyDigest(input())

    expect(digest.narrative.source).toBe('deterministic')
    expect(digest.narrative.text).toContain(digest.states.business.line)
    expect(digest.markdown).toContain(`## Deterministic read\n${digest.narrative.text}`)
  })
})

describe('daily digest committed-evidence containment', () => {
  it('surfaces unavailable source health from the snapshot without a composite verdict', () => {
    const evidence = structuredClone(weeklyExecutiveEvidenceFixture)
    evidence.sources.meta = {
      availability: 'unavailable', head: null, blockerCodes: ['meta_read_failed'],
    }
    const digest = buildDailyDigest(input({ executiveEvidence: evidence }))

    expect(digest).not.toHaveProperty('verdict')
    expect(digest.flags).toContain('Meta: unavailable; blockers: meta_read_failed.')
    expect(digest.markdown).not.toMatch(/\bhealthy\b/i)
  })

  it('surfaces the durable material-change reason from setup evidence', () => {
    const evidence = structuredClone(weeklyExecutiveEvidenceFixture)
    const digest = buildDailyDigest(input({ executiveEvidence: evidence }))

    expect(digest.flags.join('\n')).toContain('Latest material change at')
    expect(digest.flags.join('\n')).toContain('Cold daily budget changed')
  })

  it('keeps an unknown material-change reason explicit', () => {
    const evidence = structuredClone(weeklyExecutiveEvidenceFixture)
    evidence.setupChanges!.latest_material_change = {
      status: 'unknown', occurredAt: evidence.asOf, reasonCode: 'setup_change_reason_unknown',
    }
    const digest = buildDailyDigest(input({ executiveEvidence: evidence }))

    expect(digest.flags).toContain('Latest material-change reason unavailable: setup_change_reason_unknown.')
  })
})

describe('daily digest snapshot reader', () => {
  const v1 = {
    contract_version: 1,
    report_date: '2026-08-12',
    generated_from: 'committed_report_facts',
    action_authority_tier: 'diagnostic_only',
    prescriptions: [],
    change_reporting_threshold_pct: 20,
    subject: 'Maxx daily digest — 2026-08-12',
    markdown: '# x',
  }

  function legacyV2Snapshot(): Record<string, unknown> {
    const common = { ...buildDailyDigest(input()) } as Record<string, unknown>
    delete common.states
    delete common.evidence_snapshot
    return {
      ...common,
      contract_version: 2,
      verdict: { status: 'amber', line: 'Watch — legacy diagnostic state.' },
      narrative: { text: 'Legacy deterministic fallback.', source: 'deterministic_fallback' },
    }
  }

  it('still reads a committed v1 snapshot', () => {
    expect(readDailyDigestSnapshot(v1)).not.toBeNull()
    expect(isDailyDigestV2(readDailyDigestSnapshot(v1)!)).toBe(false)
  })

  it('reads a v2 snapshot round-tripped through JSON', () => {
    const built = JSON.parse(JSON.stringify({
      ...legacyV2Snapshot(),
      pacing: { spend: 82.5, target: 75, band: 'yellow' },
    }))
    const read = readDailyDigestSnapshot(built)

    expect(read).not.toBeNull()
    expect(isDailyDigestV2(read!)).toBe(true)
    expect(read).toEqual(built)
  })

  it('reads a v3 snapshot round-tripped through JSON', () => {
    const built = JSON.parse(JSON.stringify(buildDailyDigest(input({
      executiveEvidence: weeklyExecutiveEvidenceFixture,
    }))))
    const read = readDailyDigestSnapshot(built)

    expect(read).not.toBeNull()
    expect(isDailyDigestV3(read!)).toBe(true)
    expect(read).toEqual(built)
  })

  it('rejects a V3 digest whose executive evidence reference is absent', () => {
    const built = JSON.parse(JSON.stringify(buildDailyDigest(input({
      executiveEvidence: weeklyExecutiveEvidenceFixture,
    })))) as Record<string, unknown>

    expect(readDailyDigestSnapshot({ ...built, evidence_snapshot: null })).toBeNull()
  })

  it('accepts everything the builder can emit, including hostile inputs', () => {
    const hostile: DailyDigestInput[] = [
      input({ today: { spend: NaN, leads: 2, bookings: 1, ctr: 1.5, cpl: 23.1 } }),
      input({
        today: { spend: 0, leads: 0, bookings: 0, ctr: null, cpl: null },
        sevenDayDailyAverage: null,
        dailyBudgetTarget: null,
      }),
    ]

    for (const candidate of hostile) {
      const built = buildDailyDigest(candidate)
      const roundTripped = readDailyDigestSnapshot(JSON.parse(JSON.stringify(built)))
      expect(roundTripped).not.toBeNull()
      expect(isDailyDigestV3(roundTripped!)).toBe(true)
    }
    expect(buildDailyDigest(hostile[0]).pacing.spend).toBeNull()
    expect(buildDailyDigest(hostile[0]).markdown).not.toContain('Spend $0.00')
  })

  it('rejects a direct V3 build without executive evidence', () => {
    expect(() => buildDailyDigest(input({
      executiveEvidence: null as unknown as DailyDigestInput['executiveEvidence'],
    })))
      .toThrow(/executive evidence snapshot is required/i)
  })

  it('rejects a kpi set with the wrong arity', () => {
    const v3 = JSON.parse(JSON.stringify(buildDailyDigest(input()))) as Record<string, unknown>
    const kpis = v3.kpis as Array<Record<string, unknown>>

    expect(readDailyDigestSnapshot({ ...v3, kpis: [] })).toBeNull()
    expect(readDailyDigestSnapshot({ ...v3, kpis: kpis.filter((k) => k.key !== 'bookings_real') })).toBeNull()
    expect(readDailyDigestSnapshot({ ...v3, kpis: [...kpis, kpis[0]] })).toBeNull()
  })

  it('rejects malformed input with v1 strictness', () => {
    expect(readDailyDigestSnapshot(null)).toBeNull()
    expect(readDailyDigestSnapshot([v1])).toBeNull()
    expect(readDailyDigestSnapshot({ ...v1, contract_version: 3 })).toBeNull()
    expect(readDailyDigestSnapshot({ ...v1, generated_from: 'llm' })).toBeNull()
    expect(readDailyDigestSnapshot({ ...v1, action_authority_tier: 'apply' })).toBeNull()
    expect(readDailyDigestSnapshot({ ...v1, prescriptions: ['raise budget'] })).toBeNull()
    expect(readDailyDigestSnapshot({ ...v1, change_reporting_threshold_pct: 10 })).toBeNull()
    expect(readDailyDigestSnapshot({ ...v1, markdown: 42 })).toBeNull()
  })

  it('rejects a v3 snapshot whose new fields are malformed', () => {
    const v3 = JSON.parse(JSON.stringify(buildDailyDigest(input()))) as Record<string, unknown>

    expect(readDailyDigestSnapshot({ ...v3, states: { business: { state: 'great', line: 'x' } } })).toBeNull()
    const states = v3.states as Record<string, unknown>
    expect(readDailyDigestSnapshot({ ...v3, states: { ...states, paid_delivery: { state: 'green', line: 'x' } } })).toBeNull()
    expect(readDailyDigestSnapshot({ ...v3, states: { ...states, data_confidence: { state: 'complete' } } })).toBeNull()
    expect(readDailyDigestSnapshot({ ...v3, pacing: { spend: 1, target: null, band: 'teal' } })).toBeNull()
    expect(readDailyDigestSnapshot({ ...v3, pacing: { spend: 'sixty', target: null, band: 'unavailable' } })).toBeNull()
    const kpis = v3.kpis as Array<Record<string, unknown>>
    expect(readDailyDigestSnapshot({ ...v3, kpis: kpis.map((k, i) => (i === 0 ? { ...k, state: 'maybe' } : k)) })).toBeNull()
    expect(readDailyDigestSnapshot({ ...v3, kpis: kpis.map((k, i) => (i === 0 ? { ...k, unit: 'furlongs' } : k)) })).toBeNull()
    expect(readDailyDigestSnapshot({ ...v3, kpis: 'none' })).toBeNull()
    expect(readDailyDigestSnapshot({ ...v3, flags: ['ok', 7] })).toBeNull()
    expect(readDailyDigestSnapshot({ ...v3, creative: 'none' })).toBeNull()
    expect(readDailyDigestSnapshot({ ...v3, decisions: [null] })).toBeNull()
    expect(readDailyDigestSnapshot({ ...v3, narrative: { text: 'x', source: 'llm' } })).toBeNull()
    expect(readDailyDigestSnapshot({ ...v3, narrative: { text: 'different deterministic text', source: 'deterministic' } })).toBeNull()
    expect(readDailyDigestSnapshot({ ...v3, markdown: '# stale or substituted rendering' })).toBeNull()
    expect(readDailyDigestSnapshot({ ...v3, subject: 'Different account conclusion' })).toBeNull()
    expect(readDailyDigestSnapshot({ ...v3, evidence_snapshot: { contract: 'wrong', version: 1 } })).toBeNull()
    const withoutStates = { ...v3 }
    delete withoutStates.states
    expect(readDailyDigestSnapshot(withoutStates)).toBeNull()
  })

  it('still rejects malformed legacy v2 fields', () => {
    const v2 = legacyV2Snapshot()
    expect(readDailyDigestSnapshot({ ...v2, verdict: { status: 'blue', line: 'x' } })).toBeNull()
    expect(readDailyDigestSnapshot({ ...v2, narrative: { text: 'x', source: 'guess' } })).toBeNull()
  })
})

describe('daily digest delivery isolation', () => {
  const request: DailyDigestDeliveryRequest = {
    reportId: '00000000-0000-4000-8000-000000000941',
    reportDate: '2026-03-10',
    subject: 'Maxx daily digest — 2026-03-10',
    markdown: '# Daily digest',
  }
  const deliveryLedger: DailyDigestDeliveryLedger = {
    claim: vi.fn<DailyDigestDeliveryLedger['claim']>(async () => ({
      status: 'claimed',
      attemptId: 'attempt-1',
    })),
    complete: vi.fn(async () => undefined),
  }

  it('skips cleanly when delivery is not configured', async () => {
    await expect(deliverDailyDigestSafely(request, { env: {} })).resolves.toEqual({
      status: 'skipped',
      reason: 'not_configured',
    })
  })

  it('contains provider failures instead of throwing into the sync', async () => {
    let capturedInit: RequestInit | undefined
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedInit = init
      return new Response('provider unavailable', { status: 503 })
    }) as unknown as typeof fetch
    const result = await deliverDailyDigestSafely(request, {
      env: {
        DAILY_DIGEST_EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_test',
        DAILY_DIGEST_FROM_EMAIL: 'Maxx <updates@example.com>',
        OWNER_EMAIL: 'owner@example.com',
      },
      fetcher,
      deliveryLedger,
    })

    expect(result).toMatchObject({ status: 'failed', provider: 'resend' })
    expect(fetcher).toHaveBeenCalledOnce()
    expect((capturedInit?.headers as Record<string, string>)['Idempotency-Key'])
      .toMatch(new RegExp(`^maxx-daily-digest/${request.reportId}/[0-9a-f]{64}$`))
  })

  it('wires delivery only to the exact report committed by this sync invocation', () => {
    const orchestrator = readFileSync('src/lib/sync/orchestrator.ts', 'utf8')
    const cron = readFileSync('src/app/api/cron/daily-sync/route.ts', 'utf8')

    expect(orchestrator).toMatch(/if \(res\.committed && typeof res\.report_id === 'string'\)[\s\S]{0,240}?committedReport\s*=\s*\{\s*id:\s*res\.report_id/)
    expect(orchestrator).toMatch(/return \{[\s\S]{0,260}?success: true,[\s\S]{0,180}?metaOutcomeMetricsComplete: metaOutcomePlane\.complete,[\s\S]{0,180}?outcomeReconcile,[\s\S]{0,80}?committedReport/)
    expect(cron).toMatch(/committedReport\s*=\s*result\.committedReport/)
    expect(cron).toMatch(/if \(!committedReport\)[\s\S]{0,180}?report_not_committed/)
    expect(cron).toMatch(/deliverCommittedDailyExecutive\(\{ adAccountDbId, report: committedReport \}\)/)
    expect(cron).toMatch(/\.eq\('id', input\.report\.id\)/)
  })
})
