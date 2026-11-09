import { describe, expect, it, vi } from 'vitest'

const ACCOUNT = '00000000-0000-4000-8000-000000001221'
const RUN = '00000000-0000-4000-8000-000000001222'

describe('policy-v3 completeness manifest producer', () => {
  it('asks Postgres to derive both windows from independent ledgers and never accepts caller counts', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { id: '00000000-0000-4000-8000-000000001223', cohort_kind: 'recent_scale', capture_complete: false, linker_complete: false, blocker_codes: ['capture_surface_not_activated'] }, error: null })
      .mockResolvedValueOnce({ data: { id: '00000000-0000-4000-8000-000000001224', cohort_kind: 'matured_cut', capture_complete: false, linker_complete: false, blocker_codes: ['pre_activation_window'] }, error: null })
    const { producePaidCohortCompletenessManifests } = await import(
      '@/lib/attribution/paid-eligibility-manifest'
    )

    const result = await producePaidCohortCompletenessManifests({ rpc } as never, {
      adAccountId: ACCOUNT,
      evaluationRunId: RUN,
      sourceNotBefore: '2026-08-21T15:00:00.000Z',
      windows: {
        recentScale: { start: '2026-08-07', end: '2026-08-20' },
        maturedCut: { start: '2026-07-24', end: '2026-08-06' },
      },
    })

    expect(result).toHaveLength(2)
    expect(rpc).toHaveBeenCalledTimes(2)
    for (const [, args] of rpc.mock.calls) {
      expect(args).not.toHaveProperty('p_capture_eligible_inputs')
      expect(args).not.toHaveProperty('p_captured_touches')
      expect(args).not.toHaveProperty('p_eligible_appointments')
      expect(args).not.toHaveProperty('p_linked_appointments')
      expect(args).toMatchObject({
        p_ad_account_id: ACCOUNT,
        p_evaluation_run_id: RUN,
        p_source_not_before: '2026-08-21T15:00:00.000Z',
        p_contract_version: 1,
        p_policy_version: 1,
      })
    }
  })

  it('fails closed when the manifest RPC returns a malformed or unavailable result', async () => {
    const { producePaidCohortCompletenessManifests } = await import(
      '@/lib/attribution/paid-eligibility-manifest'
    )
    const input = {
      adAccountId: ACCOUNT,
      evaluationRunId: RUN,
      sourceNotBefore: '2026-08-21T15:00:00.000Z',
      windows: {
        recentScale: { start: '2026-08-07', end: '2026-08-20' },
        maturedCut: { start: '2026-07-24', end: '2026-08-06' },
      },
    } as const
    await expect(producePaidCohortCompletenessManifests({ rpc: vi.fn(async () => ({ data: {}, error: null })) } as never, input))
      .rejects.toThrow(/invalid/i)
    await expect(producePaidCohortCompletenessManifests({ rpc: vi.fn(async () => ({ data: null, error: { message: 'down' } })) } as never, input))
      .rejects.toThrow(/failed/i)
  })

  it('reads only an exact account/window/evaluation-run v3 proof and exposes its synchronization head', async () => {
    const filters: Record<string, unknown> = {}
    const chain = {
      select: vi.fn(), eq: vi.fn(), order: vi.fn(), limit: vi.fn(), maybeSingle: vi.fn(),
    }
    chain.select.mockReturnValue(chain)
    chain.eq.mockImplementation((key: string, value: unknown) => { filters[key] = value; return chain })
    chain.order.mockReturnValue(chain)
    chain.limit.mockReturnValue(chain)
    chain.maybeSingle.mockResolvedValue({
      data: {
        evaluation_run_id: RUN,
        window_start: '2026-08-07', window_end: '2026-08-20',
        source_not_before: '2026-08-21T15:00:00.000Z',
        capture_completed_at: '2026-08-21T15:07:00.000Z',
        linker_completed_at: '2026-08-21T15:09:00.000Z',
        contract_version: 1, policy_version: 1,
        capture_complete: true, linker_complete: true,
        capture_eligible_inputs: 7, captured_touches: 7,
        eligible_outcomes: 2, evaluated_outcomes: 2, linked_outcomes: 2,
        blocker_codes: [], created_at: '2026-08-21T15:09:00.000Z',
      },
      error: null,
    })
    const { readPaidEligibilityManifestForWindow } = await import(
      '@/lib/attribution/paid-eligibility-manifest'
    )
    const proof = await readPaidEligibilityManifestForWindow(
      { from: vi.fn(() => chain) } as never,
      { adAccountId: ACCOUNT, evaluationRunId: RUN, start: '2026-08-07', end: '2026-08-20' },
    )

    expect(filters).toMatchObject({
      ad_account_id: ACCOUNT,
      evaluation_run_id: RUN,
      window_start: '2026-08-07',
      window_end: '2026-08-20',
      contract_version: 1,
      policy_version: 1,
    })
    expect(proof).toEqual({
      policyVersion: 3,
      evaluationRunId: RUN,
      manifestContractVersion: 1,
      manifestPolicyVersion: 1,
      window: { start: '2026-08-07', end: '2026-08-20' },
      capture: { eligible: 7, captured: 7, complete: true },
      linker: { eligible: 2, evaluated: 2, linked: 2, complete: true },
      blockerCodes: [],
      sourceNotBefore: '2026-08-21T15:00:00.000Z',
      synchronizedAt: '2026-08-21T15:09:00.000Z',
    })
  })
})
