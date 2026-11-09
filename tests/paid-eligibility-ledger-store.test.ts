import { beforeEach, describe, expect, it, vi } from 'vitest'

const ACCOUNT = '00000000-0000-4000-8000-000000001211'
const ATTEMPT = '00000000-0000-4000-8000-000000001212'
const CAPTURE = '00000000-0000-4000-8000-000000001213'
const TOUCH = '00000000-0000-4000-8000-000000001214'
const TOKEN_FIXTURE_ID = '00000000-0000-4000-8000-000000001215'
// The outcome uuid of the Acuity appointment 123 (outcome_id replaced the numeric appointment_id).
const OUTCOME_123 = '00000000-0000-4000-8000-000000001219'

const rpc = vi.fn()
const db = { rpc } as never

describe('paid eligibility ledger store', () => {
  beforeEach(() => rpc.mockReset())

  it('records the independent received-attempt denominator before any capture succeeds', async () => {
    rpc.mockResolvedValue({ data: { attempt_id: ATTEMPT, received_at: '2026-08-21T14:00:00.000Z' }, error: null })
    const { recordPaidCaptureAttempt } = await import('@/lib/attribution/paid-eligibility-ledger')

    const result = await recordPaidCaptureAttempt(db, {
      adAccountId: ACCOUNT,
      attemptId: ATTEMPT,
      browserCaptureId: CAPTURE,
      requestFingerprint: `sha256:${'a'.repeat(64)}`,
    })

    expect(result).toEqual({ attemptId: ATTEMPT, receivedAt: '2026-08-21T14:00:00.000Z' })
    expect(rpc).toHaveBeenCalledWith('record_paid_capture_attempt', {
      p_ad_account_id: ACCOUNT,
      p_attempt_id: ATTEMPT,
      p_browser_capture_id: CAPTURE,
      p_request_fingerprint: `sha256:${'a'.repeat(64)}`,
      p_contract_version: 1,
    })
  })

  it('records success and scheduler delivery as separate append-only facts', async () => {
    rpc
      .mockResolvedValueOnce({ data: { event_id: '00000000-0000-4000-8000-000000001216' }, error: null })
      .mockResolvedValueOnce({ data: { event_id: '00000000-0000-4000-8000-000000001217' }, error: null })
    const { recordPaidCaptureOutcome, recordSchedulerTokenDelivery } = await import(
      '@/lib/attribution/paid-eligibility-ledger'
    )

    await recordPaidCaptureOutcome(db, {
      adAccountId: ACCOUNT,
      attemptId: ATTEMPT,
      eventId: '00000000-0000-4000-8000-000000001216',
      outcome: 'touch_persisted',
      reasonCode: null,
      touchId: TOUCH,
      tokenId: TOKEN_FIXTURE_ID,
    })
    await recordSchedulerTokenDelivery(db, {
      adAccountId: ACCOUNT,
      eventId: '00000000-0000-4000-8000-000000001217',
      browserCaptureId: CAPTURE,
      tokenId: TOKEN_FIXTURE_ID,
      tokenHash: `sha256:${'b'.repeat(64)}`,
      deliveryStatus: 'scheduler_decorated',
    })

    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'record_paid_capture_outcome',
      'record_paid_destination_token_delivery',
    ])
  })

  it('records the signed-webhook appointment input before its link evaluation', async () => {
    rpc.mockResolvedValue({
      data: {
        input_id: '00000000-0000-4000-8000-000000001218',
        received_at: '2026-08-21T14:05:00.000Z',
      },
      error: null,
    })
    const { recordPaidAppointmentEligibilityInput } = await import(
      '@/lib/attribution/paid-eligibility-ledger'
    )
    const result = await recordPaidAppointmentEligibilityInput(db, {
      adAccountId: ACCOUNT,
      inputId: '00000000-0000-4000-8000-000000001218',
      inputFingerprint: `sha256:${'d'.repeat(64)}`,
      outcomeId: OUTCOME_123,
      outcomeCreatedAt: '2026-08-21T14:00:00.000Z',
      linkerConfigured: true,
      paidEvidencePresent: true,
      tokenId: TOKEN_FIXTURE_ID,
      amountPaid: 150,
      canceled: false,
    })
    expect(result.inputId).toBe('00000000-0000-4000-8000-000000001218')
    expect(rpc).toHaveBeenCalledWith('record_paid_outcome_eligibility_input', expect.objectContaining({
      p_ad_account_id: ACCOUNT,
      p_outcome_id: OUTCOME_123,
      p_paid_evidence_present: true,
      p_linker_configured: true,
    }))
  })

  it('validates ids, digests, and finite money before calling a governed RPC', async () => {
    const { recordPaidCaptureAttempt, recordPaidAppointmentLinkEvaluation } = await import(
      '@/lib/attribution/paid-eligibility-ledger'
    )
    await expect(recordPaidCaptureAttempt(db, {
      adAccountId: 'not-an-account', attemptId: ATTEMPT, browserCaptureId: null,
      requestFingerprint: `sha256:${'a'.repeat(64)}`,
    })).rejects.toThrow(/invalid/i)
    await expect(recordPaidAppointmentLinkEvaluation(db, {
      adAccountId: ACCOUNT,
      evaluationId: ATTEMPT,
      evaluationFingerprint: `sha256:${'c'.repeat(64)}`,
      eligibilityInputId: '00000000-0000-4000-8000-000000001218',
      outcomeId: OUTCOME_123,
      outcomeCreatedAt: '2026-08-21T14:00:00.000Z',
      paidEvidencePresent: true,
      tokenId: TOKEN_FIXTURE_ID,
      linkId: null,
      lastTouchId: null,
      lastInteractionAt: null,
      status: 'rejected',
      reasonCode: 'invalid_token',
      amountPaid: Number.NaN,
      canceled: false,
    })).rejects.toThrow(/invalid/i)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('passes an exact decimal string to the numeric RPC parameter unchanged, and refuses a malformed one', async () => {
    rpc.mockResolvedValue({ data: { input_id: '00000000-0000-4000-8000-000000001218', received_at: '2026-08-21T14:05:00.000Z' }, error: null })
    const { recordPaidAppointmentEligibilityInput } = await import('@/lib/attribution/paid-eligibility-ledger')
    const input = (amountPaid: string) => ({
      adAccountId: ACCOUNT, inputId: '00000000-0000-4000-8000-000000001218', inputFingerprint: `sha256:${'d'.repeat(64)}`,
      outcomeId: OUTCOME_123, outcomeCreatedAt: '2026-08-21T14:00:00.000Z', linkerConfigured: true,
      paidEvidencePresent: true, tokenId: TOKEN_FIXTURE_ID, amountPaid, canceled: false,
    })
    await recordPaidAppointmentEligibilityInput(db, input('123456789012345.123456'))
    expect(rpc).toHaveBeenCalledWith('record_paid_outcome_eligibility_input',
      expect.objectContaining({ p_collected_value: '123456789012345.123456' }))
    rpc.mockClear()
    for (const bad of ['1e5', '-1', '01.5', '1.1234567', '1234567890123456', ' 1', '1,5', '']) {
      await expect(recordPaidAppointmentEligibilityInput(db, input(bad)), bad).rejects.toThrow(/invalid/i)
    }
    expect(rpc).not.toHaveBeenCalled()
  })

  it('rejects a non-uuid outcome id before calling the governed RPC', async () => {
    const { recordPaidAppointmentEligibilityInput } = await import(
      '@/lib/attribution/paid-eligibility-ledger'
    )
    await expect(recordPaidAppointmentEligibilityInput(db, {
      adAccountId: ACCOUNT,
      inputId: '00000000-0000-4000-8000-000000001218',
      inputFingerprint: `sha256:${'d'.repeat(64)}`,
      outcomeId: '123',
      outcomeCreatedAt: '2026-08-21T14:00:00.000Z',
      linkerConfigured: true,
      paidEvidencePresent: true,
      tokenId: TOKEN_FIXTURE_ID,
      amountPaid: 150,
      canceled: false,
    })).rejects.toThrow(/invalid/i)
    expect(rpc).not.toHaveBeenCalled()
  })
})
