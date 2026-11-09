import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashPaidTouchToken, issuePaidTouchToken } from '@/lib/attribution/paid-touch-contract'
import type { AcuityAppointmentRaw } from '@/lib/outcomes/adapters/acuity/client'

const SECRET = ['acuity-link', 'secret-at-least-thirty-two-bytes'].join('-')
const ACCOUNT = '00000000-0000-4000-8000-000000000731'
const TOKEN_ID = '00000000-0000-4000-8000-000000000732'
const TOKEN = issuePaidTouchToken(TOKEN_ID, SECRET)
const TOUCH_ID = '00000000-0000-4000-8000-000000000735'

// The outcome uuid recorded for Acuity appointment 777000103 (outcome_id replaced appointment_id).
const OUTCOME_ID = '00000000-0000-4000-8000-000000000737'

const state = vi.hoisted(() => ({ rpc: vi.fn(), findOutcome: vi.fn() }))
vi.mock('@/lib/outcomes/adapters/acuity/outcome-source', () => ({ findAcuityOutcomeId: state.findOutcome }))

const appointment = (values: Array<{ fieldID: number; name: string; value: string }>): AcuityAppointmentRaw => ({
  id: 777000103,
  datetimeCreated: '2026-07-30T20:00:00.000Z',
  scheduledBy: null,
  forms: [{ id: 1, name: 'Internal attribution', values }],
})

const fallbackLinkResult = {
  id: '00000000-0000-4000-8000-000000000736',
  ad_account_id: ACCOUNT,
  outcome_id: OUTCOME_ID,
  token_id: null,
  first_touch_id: TOUCH_ID,
  last_touch_id: TOUCH_ID,
  first_interaction_at: '2026-07-30T18:30:00.000Z',
  last_interaction_at: '2026-07-30T18:30:00.000Z',
  outcome_created_at: '2026-07-30T20:00:00.000Z',
  last_fbclid: 'IwZXh0bgNhZW0CMTAAAR1',
  policy_version: 1,
  linked_at: '2026-07-30T20:00:05.000Z',
}

describe('Acuity paid-touch token extraction and linkage', () => {
  beforeEach(() => {
    state.findOutcome.mockReset()
    state.findOutcome.mockResolvedValue(OUTCOME_ID)
    state.rpc.mockReset()
    state.rpc.mockResolvedValue({
      data: {
        id: '00000000-0000-4000-8000-000000000733',
        outcome_id: OUTCOME_ID,
        token_id: TOKEN_ID,
        first_touch_id: '00000000-0000-4000-8000-000000000734',
        last_touch_id: '00000000-0000-4000-8000-000000000735',
        first_interaction_at: '2026-07-29T12:00:00.000Z',
        last_interaction_at: '2026-07-30T18:30:00.000Z',
        outcome_created_at: '2026-07-30T20:00:00.000Z',
        last_fbclid: 'IwZXh0bgNhZW0CMTAAAR1',
        policy_version: 1,
        linked_at: '2026-07-30T20:00:05.000Z',
        ad_account_id: ACCOUNT,
      },
      error: null,
    })
  })

  it('reads only the configured numeric internal field and rejects conflicting duplicates', async () => {
    const { extractPaidTouchToken } = await import('@/lib/outcomes/adapters/acuity/paid-touch-link')
    expect(extractPaidTouchToken(appointment([
      { fieldID: 41, name: 'paid_touch_token', value: 'wrong-field' },
      { fieldID: 42, name: 'renamed internal field', value: ` ${TOKEN} ` },
    ]).forms, 42)).toEqual({ ok: true, token: TOKEN })
    expect(extractPaidTouchToken(appointment([
      { fieldID: 42, name: 'paid_touch_token', value: TOKEN },
      { fieldID: 42, name: 'paid_touch_token', value: issuePaidTouchToken(
        '00000000-0000-4000-8000-000000000736', SECRET,
      ) },
    ]).forms, 42)).toEqual({ ok: false, reason: 'ambiguous' })
  })

  it('verifies the bearer token and links through the governed RPC', async () => {
    const { linkAcuityPaidTouch } = await import('@/lib/outcomes/adapters/acuity/paid-touch-link')
    const result = await linkAcuityPaidTouch(
      { rpc: state.rpc } as never,
      ACCOUNT,
      appointment([{ fieldID: 42, name: 'paid_touch_token', value: TOKEN }]),
      { fieldId: 42, tokenSecret: SECRET },
    )

    expect(state.rpc).toHaveBeenCalledWith('link_outcome_paid_touch', {
      p_ad_account_id: ACCOUNT,
      p_outcome_id: OUTCOME_ID,
      p_token_id: TOKEN_ID,
      p_token_hash: hashPaidTouchToken(TOKEN),
      p_policy_version: 1,
    })
    expect(result).toEqual({
      status: 'linked',
      paidTouch: { fbclid: 'IwZXh0bgNhZW0CMTAAAR1', observedAt: '2026-07-30T18:30:00.000Z' },
    })
  })

  it('treats absence as organic/unknown and rejects malformed tokens before the RPC', async () => {
    const { linkAcuityPaidTouch } = await import('@/lib/outcomes/adapters/acuity/paid-touch-link')
    expect(await linkAcuityPaidTouch(
      { rpc: state.rpc } as never, ACCOUNT, appointment([]), { fieldId: 42, tokenSecret: SECRET },
    )).toEqual({ status: 'absent' })
    expect(await linkAcuityPaidTouch(
      { rpc: state.rpc } as never,
      ACCOUNT,
      appointment([{ fieldID: 42, name: 'paid_touch_token', value: 'forged' }]),
      { fieldId: 42, tokenSecret: SECRET },
    )).toEqual({ status: 'rejected', reason: 'invalid_token' })
    expect(state.rpc).not.toHaveBeenCalled()
  })

  it('resolves the outcome under the account and rejects an unrecorded appointment before the RPC', async () => {
    const { linkAcuityPaidTouch } = await import('@/lib/outcomes/adapters/acuity/paid-touch-link')
    const db = { rpc: state.rpc } as never
    await linkAcuityPaidTouch(
      db, ACCOUNT, appointment([{ fieldID: 42, name: 'paid_touch_token', value: TOKEN }]),
      { fieldId: 42, tokenSecret: SECRET },
    )
    expect(state.findOutcome).toHaveBeenCalledWith(db, 777000103, ACCOUNT)

    state.rpc.mockClear()
    state.findOutcome.mockResolvedValueOnce(null)
    expect(await linkAcuityPaidTouch(
      db, ACCOUNT, appointment([{ fieldID: 42, name: 'paid_touch_token', value: TOKEN }]),
      { fieldId: 42, tokenSecret: SECRET },
    )).toEqual({ status: 'rejected', reason: 'link_rejected' })
    state.findOutcome.mockRejectedValueOnce(new Error('lookup failed'))
    expect(await linkAcuityPaidTouch(
      db, ACCOUNT, appointment([{ fieldID: 42, name: 'paid_touch_token', value: TOKEN }]),
      { fieldId: 42, tokenSecret: SECRET },
    )).toEqual({ status: 'rejected', reason: 'link_rejected' })
    expect(state.rpc).not.toHaveBeenCalled()
  })

  it('fails closed when the RPC links a different outcome than the one resolved', async () => {
    const { linkAcuityPaidTouch } = await import('@/lib/outcomes/adapters/acuity/paid-touch-link')
    const linked = (await state.rpc()).data as Record<string, unknown>
    state.rpc.mockClear()
    state.rpc.mockResolvedValueOnce({
      data: { ...linked, outcome_id: '00000000-0000-4000-8000-000000000799' }, error: null,
    })
    expect(await linkAcuityPaidTouch(
      { rpc: state.rpc } as never,
      ACCOUNT,
      appointment([{ fieldID: 42, name: 'paid_touch_token', value: TOKEN }]),
      { fieldId: 42, tokenSecret: SECRET },
    )).toEqual({ status: 'error', reason: 'invalid_rpc_response' })
  })

  it('fails closed on a malformed RPC response and preserves a linked touch without fbclid', async () => {
    const { linkAcuityPaidTouch } = await import('@/lib/outcomes/adapters/acuity/paid-touch-link')
    state.rpc.mockResolvedValueOnce({ data: { outcome_id: OUTCOME_ID }, error: null })
    expect(await linkAcuityPaidTouch(
      { rpc: state.rpc } as never,
      ACCOUNT,
      appointment([{ fieldID: 42, name: 'paid_touch_token', value: TOKEN }]),
      { fieldId: 42, tokenSecret: SECRET },
    )).toEqual({ status: 'error', reason: 'invalid_rpc_response' })

    state.rpc.mockResolvedValueOnce({
      data: { ...state.rpc.getMockImplementation(), ...{
        id: '00000000-0000-4000-8000-000000000733', ad_account_id: ACCOUNT,
        outcome_id: OUTCOME_ID, token_id: TOKEN_ID,
        first_touch_id: '00000000-0000-4000-8000-000000000734',
        last_touch_id: '00000000-0000-4000-8000-000000000735',
        first_interaction_at: '2026-07-29T12:00:00.000Z',
        last_interaction_at: '2026-07-30T18:30:00.000Z',
        outcome_created_at: '2026-07-30T20:00:00.000Z',
        last_fbclid: null, policy_version: 1, linked_at: '2026-07-30T20:00:05.000Z',
      } }, error: null,
    })
    expect(await linkAcuityPaidTouch(
      { rpc: state.rpc } as never,
      ACCOUNT,
      appointment([{ fieldID: 42, name: 'paid_touch_token', value: TOKEN }]),
      { fieldId: 42, tokenSecret: SECRET },
    )).toEqual({ status: 'linked', paidTouch: null })
  })

  describe('fbclid fallback', () => {
    beforeEach(() => {
      state.rpc.mockResolvedValue({ data: fallbackLinkResult, error: null })
    })

    it('returns absent when the intake has no fbclid', async () => {
      const { linkAcuityPaidTouchFbclidFallback } = await import('@/lib/outcomes/adapters/acuity/paid-touch-link')
      expect(await linkAcuityPaidTouchFbclidFallback(
        { rpc: state.rpc } as never,
        ACCOUNT,
        appointment([
          { fieldID: 41, name: 'utm_source', value: 'meta' },
        ]),
      )).toEqual({ status: 'absent' })
      expect(state.rpc).not.toHaveBeenCalled()
    })

    it('rejects fallback when fbclid is present but utm_source is not paid-social', async () => {
      const { linkAcuityPaidTouchFbclidFallback } = await import('@/lib/outcomes/adapters/acuity/paid-touch-link')
      expect(await linkAcuityPaidTouchFbclidFallback(
        { rpc: state.rpc } as never,
        ACCOUNT,
        appointment([
          { fieldID: 41, name: 'utm_source', value: 'google' },
          { fieldID: 42, name: 'fbclid', value: 'IwZXh0bgNhZW0CMTAAAR1' },
        ]),
      )).toEqual({ status: 'rejected', reason: 'not_paid_social' })
      expect(state.rpc).not.toHaveBeenCalled()
    })

    it('links via the fallback RPC when paid-social fbclid is present', async () => {
      const { linkAcuityPaidTouchFbclidFallback } = await import('@/lib/outcomes/adapters/acuity/paid-touch-link')
      const result = await linkAcuityPaidTouchFbclidFallback(
        { rpc: state.rpc } as never,
        ACCOUNT,
        appointment([
          { fieldID: 41, name: 'utm_source', value: 'meta' },
          { fieldID: 42, name: 'fbclid', value: 'IwZXh0bgNhZW0CMTAAAR1' },
        ]),
      )
      expect(state.rpc).toHaveBeenCalledWith('link_outcome_paid_touch_fbclid_fallback', {
        p_ad_account_id: ACCOUNT,
        p_outcome_id: OUTCOME_ID,
        p_fbclid: 'IwZXh0bgNhZW0CMTAAAR1',
        p_policy_version: 1,
      })
      expect(result).toEqual({
        status: 'linked',
        paidTouch: { fbclid: 'IwZXh0bgNhZW0CMTAAAR1', observedAt: '2026-07-30T18:30:00.000Z' },
      })
    })

    it('rejects the fallback before the RPC when the appointment has no recorded outcome', async () => {
      const { linkAcuityPaidTouchFbclidFallback } = await import('@/lib/outcomes/adapters/acuity/paid-touch-link')
      state.findOutcome.mockResolvedValueOnce(null)
      expect(await linkAcuityPaidTouchFbclidFallback(
        { rpc: state.rpc } as never,
        ACCOUNT,
        appointment([
          { fieldID: 41, name: 'utm_source', value: 'meta' },
          { fieldID: 42, name: 'fbclid', value: 'IwZXh0bgNhZW0CMTAAAR1' },
        ]),
      )).toEqual({ status: 'rejected', reason: 'link_rejected' })
      expect(state.rpc).not.toHaveBeenCalled()
    })

    it('fails closed when the fallback RPC returns a non-null token_id', async () => {
      const { linkAcuityPaidTouchFbclidFallback } = await import('@/lib/outcomes/adapters/acuity/paid-touch-link')
      state.rpc.mockResolvedValueOnce({
        data: { ...fallbackLinkResult, token_id: TOKEN_ID },
        error: null,
      })
      expect(await linkAcuityPaidTouchFbclidFallback(
        { rpc: state.rpc } as never,
        ACCOUNT,
        appointment([
          { fieldID: 41, name: 'utm_source', value: 'meta' },
          { fieldID: 42, name: 'fbclid', value: 'IwZXh0bgNhZW0CMTAAAR1' },
        ]),
      )).toEqual({ status: 'error', reason: 'invalid_rpc_response' })
    })

    it('combines token link and fbclid fallback in the with-fallback helper', async () => {
      const { linkAcuityPaidTouchWithFallback } = await import('@/lib/outcomes/adapters/acuity/paid-touch-link')
      // fbclid is in its own field (43); field 42 has no token, so token link returns absent without
      // RPC; fallback RPC returns the fallback link.
      state.rpc.mockResolvedValueOnce({ data: fallbackLinkResult, error: null })
      const result = await linkAcuityPaidTouchWithFallback(
        { rpc: state.rpc } as never,
        ACCOUNT,
        appointment([
          { fieldID: 41, name: 'utm_source', value: 'meta' },
          { fieldID: 43, name: 'fbclid', value: 'IwZXh0bgNhZW0CMTAAAR1' },
        ]),
        { fieldId: 42, tokenSecret: SECRET },
      )
      expect(state.rpc).toHaveBeenCalledTimes(1)
      expect(state.rpc).toHaveBeenCalledWith('link_outcome_paid_touch_fbclid_fallback', {
        p_ad_account_id: ACCOUNT,
        p_outcome_id: OUTCOME_ID,
        p_fbclid: 'IwZXh0bgNhZW0CMTAAAR1',
        p_policy_version: 1,
      })
      expect(result).toEqual({
        status: 'linked',
        paidTouch: { fbclid: 'IwZXh0bgNhZW0CMTAAAR1', observedAt: '2026-07-30T18:30:00.000Z' },
      })
    })

    it('with-fallback helper skips fallback when the token link succeeds', async () => {
      const { linkAcuityPaidTouchWithFallback } = await import('@/lib/outcomes/adapters/acuity/paid-touch-link')
      // Override the fallback-result default so the token link RPC returns a real token link.
      state.rpc.mockResolvedValueOnce({
        data: {
          id: '00000000-0000-4000-8000-000000000733',
          ad_account_id: ACCOUNT,
          outcome_id: OUTCOME_ID,
          token_id: TOKEN_ID,
          first_touch_id: '00000000-0000-4000-8000-000000000734',
          last_touch_id: TOUCH_ID,
          first_interaction_at: '2026-07-29T12:00:00.000Z',
          last_interaction_at: '2026-07-30T18:30:00.000Z',
          outcome_created_at: '2026-07-30T20:00:00.000Z',
          last_fbclid: 'IwZXh0bgNhZW0CMTAAAR1',
          policy_version: 1,
          linked_at: '2026-07-30T20:00:05.000Z',
        },
        error: null,
      })
      const result = await linkAcuityPaidTouchWithFallback(
        { rpc: state.rpc } as never,
        ACCOUNT,
        appointment([{ fieldID: 42, name: 'paid_touch_token', value: TOKEN }]),
        { fieldId: 42, tokenSecret: SECRET },
      )
      expect(state.rpc).toHaveBeenCalledTimes(1)
      expect(state.rpc).toHaveBeenCalledWith('link_outcome_paid_touch', expect.any(Object))
      expect(result).toEqual({
        status: 'linked',
        paidTouch: { fbclid: 'IwZXh0bgNhZW0CMTAAAR1', observedAt: '2026-07-30T18:30:00.000Z' },
      })
    })

    it('with-fallback helper does not fallback on invalid-token rejections', async () => {
      const { linkAcuityPaidTouchWithFallback } = await import('@/lib/outcomes/adapters/acuity/paid-touch-link')
      const result = await linkAcuityPaidTouchWithFallback(
        { rpc: state.rpc } as never,
        ACCOUNT,
        appointment([{ fieldID: 42, name: 'paid_touch_token', value: 'forged' }]),
        { fieldId: 42, tokenSecret: SECRET },
      )
      expect(state.rpc).not.toHaveBeenCalled()
      expect(result).toEqual({ status: 'rejected', reason: 'invalid_token' })
    })
  })
})
