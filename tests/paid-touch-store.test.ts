import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PAID_TOUCH_CONTRACT_VERSION,
  hashPaidTouchToken,
  issuePaidTouchToken,
  normalizePaidTouchCapture,
  verifyPaidTouchToken,
} from '@/lib/attribution/paid-touch-contract'
// Type-only: erased at compile time, so the dynamic import below still governs module state.
import type { PaidTouchStoreError } from '@/lib/attribution/paid-touch-store'

const SECRET = ['paid-touch-test', 'secret-at-least-thirty-two-bytes'].join('-')
const ACCOUNT = '00000000-0000-4000-8000-000000000701'
const RETURNED_TOUCH = '00000000-0000-4000-8000-000000000702'
const RETURNED_TOKEN = '00000000-0000-4000-8000-000000000703'

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  ids: [
    '00000000-0000-4000-8000-000000000704',
    '00000000-0000-4000-8000-000000000705',
  ],
}))

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, randomUUID: vi.fn(() => state.ids.shift() ?? '00000000-0000-4000-8000-000000000706') }
})

function capture(previousToken: string | null = null) {
  return normalizePaidTouchCapture({
    capture_id: '00000000-0000-4000-8000-000000000707',
    source: 'meta',
    fbclid: 'IwZXh0bgNhZW0CMTAAAR1',
    meta_campaign_id: '100000000000007',
    meta_adset_id: '100000000000008',
    meta_ad_id: '100000000000009',
    utm_source: 'meta',
    utm_medium: 'paid_social',
    utm_campaign: 'Cold Studio',
    utm_content: 'Proof reel',
    utm_term: 'Springfield creators',
    landing_url: 'https://example-studio.test/book/?ignored=1',
    referrer_url: 'https://l.facebook.com/path?ignored=1',
    previous_token: previousToken,
  }, ['example-studio.test'])
}

function successRow(tokenId = RETURNED_TOKEN) {
  return {
    touch_id: RETURNED_TOUCH,
    token_id: tokenId,
    first_touch_id: RETURNED_TOUCH,
    last_touch_id: RETURNED_TOUCH,
    observed_at: '2026-07-30T21:00:00.000Z',
    expires_at: '2026-10-28T21:00:00.000Z',
    identity_complete: true,
    contract_version: 1,
    policy_version: 1,
  }
}

describe('persistPaidTouchCapture', () => {
  beforeEach(() => {
    vi.resetModules()
    state.ids = [
      '00000000-0000-4000-8000-000000000704',
      '00000000-0000-4000-8000-000000000705',
    ]
    state.rpc.mockReset()
    state.rpc.mockResolvedValue({ data: successRow(), error: null })
  })

  it('generates server ids, sends only the token digest, and returns a token for the committed id', async () => {
    const { persistPaidTouchCapture } = await import('@/lib/attribution/paid-touch-store')
    const result = await persistPaidTouchCapture({ rpc: state.rpc } as never, ACCOUNT, capture(), SECRET)

    expect(state.rpc).toHaveBeenCalledOnce()
    const [name, args] = state.rpc.mock.calls[0]
    expect(name).toBe('capture_paid_touch')
    expect(args).toMatchObject({
      p_ad_account_id: ACCOUNT,
      p_touch_id: '00000000-0000-4000-8000-000000000704',
      p_token_id: '00000000-0000-4000-8000-000000000705',
      p_previous_token_id: null,
      p_previous_token_hash: null,
      p_contract_version: PAID_TOUCH_CONTRACT_VERSION,
      p_policy_version: 1,
    })
    expect(args.p_token_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(args.p_capture_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(JSON.stringify(args)).not.toContain(result.token)
    expect(verifyPaidTouchToken(result.token, SECRET)).toEqual({ ok: true, tokenId: RETURNED_TOKEN })
  })

  it('verifies and hashes a predecessor before the RPC', async () => {
    const predecessorId = '00000000-0000-4000-8000-000000000708'
    const predecessor = issuePaidTouchToken(predecessorId, SECRET)
    const { persistPaidTouchCapture } = await import('@/lib/attribution/paid-touch-store')
    await persistPaidTouchCapture({ rpc: state.rpc } as never, ACCOUNT, capture(predecessor), SECRET)

    expect(state.rpc.mock.calls[0][1]).toMatchObject({
      p_previous_token_id: predecessorId,
      p_previous_token_hash: hashPaidTouchToken(predecessor),
    })
  })

  it('rejects an invalid predecessor without touching the database', async () => {
    const { persistPaidTouchCapture } = await import('@/lib/attribution/paid-touch-store')
    await expect(persistPaidTouchCapture(
      { rpc: state.rpc } as never, ACCOUNT, capture('pt1.forged'), SECRET,
    )).rejects.toEqual(expect.objectContaining<Partial<PaidTouchStoreError>>({
      code: 'PREVIOUS_TOKEN_INVALID', status: 400,
    }))
    expect(state.rpc).not.toHaveBeenCalled()
  })

  it('regenerates the deterministic token for an existing committed id on an idempotent retry', async () => {
    const existing = '00000000-0000-4000-8000-000000000709'
    state.rpc.mockResolvedValue({ data: successRow(existing), error: null })
    const { persistPaidTouchCapture } = await import('@/lib/attribution/paid-touch-store')
    const result = await persistPaidTouchCapture({ rpc: state.rpc } as never, ACCOUNT, capture(), SECRET)
    expect(result.tokenId).toBe(existing)
    expect(result.token).toBe(issuePaidTouchToken(existing, SECRET))
  })

  it('fails closed on a malformed RPC envelope or a database rejection', async () => {
    const { PaidTouchStoreError, persistPaidTouchCapture } = await import('@/lib/attribution/paid-touch-store')
    state.rpc.mockResolvedValueOnce({ data: { ...successRow(), identity_complete: 'yes' }, error: null })
    await expect(persistPaidTouchCapture(
      { rpc: state.rpc } as never, ACCOUNT, capture(), SECRET,
    )).rejects.toBeInstanceOf(PaidTouchStoreError)

    state.rpc.mockResolvedValueOnce({ data: null, error: { message: 'paid-touch capture collision' } })
    await expect(persistPaidTouchCapture(
      { rpc: state.rpc } as never, ACCOUNT, capture(), SECRET,
    )).rejects.toEqual(expect.objectContaining({ code: 'CAPTURE_CONFLICT', status: 409 }))
  })
})
