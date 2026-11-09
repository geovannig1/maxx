import { beforeEach, describe, expect, it, vi } from 'vitest'
import { issuePaidTouchToken } from '@/lib/attribution/paid-touch-contract'

// The outcome uuid recorded for Acuity appointment 501 (outcome_id replaced the numeric appointment_id).
const OUTCOME_501 = '00000000-0000-4000-8000-000000001271'
const outcomeLookup = vi.hoisted(() => ({ find: vi.fn() }))
vi.mock('@/lib/outcomes/adapters/acuity/outcome-source', () => ({ findAcuityOutcomeId: outcomeLookup.find }))
import {
  recordSignedAcuityEligibilityInput,
  recordSignedAcuityLinkEvaluation,
} from '@/lib/outcomes/adapters/acuity/paid-link-evaluation'

const ACCOUNT = '00000000-0000-4000-8000-000000001261'
const TOKEN_ID = '00000000-0000-4000-8000-000000001262'
const TOKEN = issuePaidTouchToken(TOKEN_ID, 'evaluation-secret-at-least-thirty-two-bytes')

function appointment(overrides: Record<string, unknown> = {}) {
  return {
    id: 501,
    datetimeCreated: '2026-08-10T14:00:00.000Z',
    amountPaid: '150.00',
    canceled: false,
    forms: [{ values: [
      { fieldID: 42, name: 'paid_touch_token', value: TOKEN },
      { fieldID: 43, name: 'utm_source', value: 'meta' },
      { fieldID: 44, name: 'utm_medium', value: 'paid_social' },
      { fieldID: 45, name: 'fbclid', value: 'IwZXh0bgNhZW0CMTAAAR1' },
    ] }],
    ...overrides,
  } as never
}

describe('signed Acuity paid-link evaluation v3', () => {
  beforeEach(() => {
    outcomeLookup.find.mockReset()
    outcomeLookup.find.mockResolvedValue(OUTCOME_501)
  })

  it('accepts the compact numeric offset emitted by the Acuity API', async () => {
    const rpc = vi.fn(async (name: string, payload: Record<string, unknown>) => {
      void payload
      return {
        data: name === 'record_paid_outcome_eligibility_input'
          ? {
              input_id: '00000000-0000-4000-8000-000000001269',
              received_at: '2026-08-26T14:18:42.000Z',
            }
          : { evaluation_id: '00000000-0000-4000-8000-000000001270' },
        error: null,
      }
    })
    const db = { rpc } as never

    const eligibility = await recordSignedAcuityEligibilityInput(
      db,
      ACCOUNT,
      appointment({ datetimeCreated: '2026-08-26T09:18:41-0500' }),
      { fieldId: 42, tokenSecret: 'evaluation-secret-at-least-thirty-two-bytes' },
    )
    await recordSignedAcuityLinkEvaluation(
      db,
      ACCOUNT,
      appointment({ datetimeCreated: '2026-08-26T09:18:41-0500' }),
      { status: 'absent' },
      { fieldId: 42, tokenSecret: 'evaluation-secret-at-least-thirty-two-bytes' },
      eligibility,
    )

    expect(eligibility.appointmentCreatedAt).toBe('2026-08-26T14:18:41.000Z')
    expect(outcomeLookup.find).toHaveBeenCalledWith(db, 501, ACCOUNT)
    expect(rpc.mock.calls[0]).toEqual(['record_paid_outcome_eligibility_input', expect.objectContaining({
      p_outcome_id: OUTCOME_501,
      p_outcome_created_at: '2026-08-26T14:18:41.000Z',
    })])
    expect(rpc.mock.calls[1]).toEqual(['record_paid_outcome_link_evaluation', expect.objectContaining({
      p_outcome_id: OUTCOME_501,
      p_outcome_created_at: '2026-08-26T14:18:41.000Z',
    })])
  })

  it('still rejects malformed appointment timestamps before storage', async () => {
    const rpc = vi.fn()
    const db = { rpc } as never

    await expect(recordSignedAcuityEligibilityInput(
      db,
      ACCOUNT,
      appointment({ datetimeCreated: '2026-08-26T09:18:41-2500' }),
      { fieldId: 42, tokenSecret: 'evaluation-secret-at-least-thirty-two-bytes' },
    )).rejects.toThrow(/invalid appointment identity/i)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('records the paid-eligible appointment independently from the successful link row', async () => {
    const rpc = vi.fn(async (name: string) => ({
      data: name === 'record_paid_outcome_eligibility_input'
        ? { input_id: '00000000-0000-4000-8000-000000001267', received_at: '2026-08-10T14:01:00.000Z' }
        : { evaluation_id: '00000000-0000-4000-8000-000000001263' },
      error: null,
    }))
    const chain = {
      select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => ({
        data: {
          id: '00000000-0000-4000-8000-000000001264',
          token_id: TOKEN_ID,
          last_touch_id: '00000000-0000-4000-8000-000000001265',
          last_interaction_at: '2026-08-10T13:00:00.000Z',
        },
        error: null,
      })),
    }
    chain.select.mockReturnValue(chain)
    chain.eq.mockReturnValue(chain)
    const from = vi.fn(() => chain)
    const db = { from, rpc } as never

    const eligibility = await recordSignedAcuityEligibilityInput(
      db,
      ACCOUNT,
      appointment(),
      { fieldId: 42, tokenSecret: 'evaluation-secret-at-least-thirty-two-bytes' },
    )
    await recordSignedAcuityLinkEvaluation(
      db,
      ACCOUNT,
      appointment(),
      { status: 'linked', paidTouch: null },
      { fieldId: 42, tokenSecret: 'evaluation-secret-at-least-thirty-two-bytes' },
      eligibility,
    )

    expect(rpc.mock.calls[0][0]).toBe('record_paid_outcome_eligibility_input')
    expect(rpc.mock.calls[1][0]).toBe('record_paid_outcome_link_evaluation')
    expect(from).toHaveBeenCalledWith('outcome_touch_links')
    expect(chain.eq).toHaveBeenCalledWith('outcome_id', OUTCOME_501)
    expect(rpc).toHaveBeenCalledWith('record_paid_outcome_link_evaluation', expect.objectContaining({
      p_ad_account_id: ACCOUNT,
      p_outcome_id: OUTCOME_501,
      p_eligibility_input_id: eligibility.inputId,
      p_paid_evidence_present: true,
      p_token_id: TOKEN_ID,
      p_link_id: '00000000-0000-4000-8000-000000001264',
      p_last_touch_id: '00000000-0000-4000-8000-000000001265',
      p_last_interaction_at: '2026-08-10T13:00:00.000Z',
      p_status: 'linked',
      p_collected_value: 150,
      p_cancelled: false,
      p_evaluation_fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    }))
  })

  it('records a paid rejection and rejects invalid appointment identity before storage', async () => {
    const rpc = vi.fn(async (name: string) => ({
      data: name === 'record_paid_outcome_eligibility_input'
        ? { input_id: '00000000-0000-4000-8000-000000001268', received_at: '2026-08-10T14:01:00.000Z' }
        : { evaluation_id: '00000000-0000-4000-8000-000000001266' },
      error: null,
    }))
    const db = { rpc } as never
    const eligibility = await recordSignedAcuityEligibilityInput(
      db, ACCOUNT, appointment(), { fieldId: 42, tokenSecret: 'evaluation-secret-at-least-thirty-two-bytes' },
    )
    await recordSignedAcuityLinkEvaluation(
      db,
      ACCOUNT,
      appointment(),
      { status: 'rejected', reason: 'invalid_token' },
      { fieldId: 42, tokenSecret: 'evaluation-secret-at-least-thirty-two-bytes' },
      eligibility,
    )
    expect(rpc).toHaveBeenCalledWith('record_paid_outcome_link_evaluation', expect.objectContaining({
      p_paid_evidence_present: true,
      p_status: 'rejected',
      p_reason_code: 'invalid_token',
      p_link_id: null,
    }))

    rpc.mockClear()
    await expect(recordSignedAcuityLinkEvaluation(
      db, ACCOUNT, appointment({ datetimeCreated: null }), { status: 'absent' }, null, eligibility,
    )).rejects.toThrow(/invalid appointment identity/i)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('refuses to record an eligibility input for an appointment with no recorded outcome', async () => {
    outcomeLookup.find.mockResolvedValue(null)
    const rpc = vi.fn()
    const db = { rpc } as never
    await expect(recordSignedAcuityEligibilityInput(
      db, ACCOUNT, appointment(), { fieldId: 42, tokenSecret: 'evaluation-secret-at-least-thirty-two-bytes' },
    )).rejects.toThrow(/no recorded outcome/i)
    expect(rpc).not.toHaveBeenCalled()
  })
})
