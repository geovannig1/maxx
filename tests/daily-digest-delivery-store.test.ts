import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getAdminClientMock } = vi.hoisted(() => ({ getAdminClientMock: vi.fn() }))

vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: getAdminClientMock }))

import { createDailyDigestDeliveryLedger } from '@/lib/report/daily-digest-delivery-store'

const attemptId = '00000000-0000-4000-8000-000000000942'
const claimInput = {
  reportId: '00000000-0000-4000-8000-000000000941',
  provider: 'gmail_smtp' as const,
  recipient: 'owner@example.com',
  payloadFingerprint: `sha256:${'a'.repeat(64)}`,
  messageId: '<gmail-fixture@gmail.com>',
}

describe('daily digest delivery ledger store', () => {
  beforeEach(() => {
    getAdminClientMock.mockReset()
  })

  it('persists the exact one-shot identity and returns its UUID', async () => {
    const builder = {
      insert: vi.fn(),
      select: vi.fn(),
      single: vi.fn(async () => ({ data: { id: attemptId }, error: null })),
    }
    builder.insert.mockReturnValue(builder)
    builder.select.mockReturnValue(builder)
    const from = vi.fn(() => builder)
    getAdminClientMock.mockReturnValue({ from })

    await expect(createDailyDigestDeliveryLedger().claim(claimInput)).resolves.toEqual({
      status: 'claimed',
      attemptId,
    })
    expect(from).toHaveBeenCalledWith('daily_digest_delivery_attempts')
    expect(builder.insert).toHaveBeenCalledWith({
      report_id: claimInput.reportId,
      provider: claimInput.provider,
      recipient: claimInput.recipient,
      payload_fingerprint: claimInput.payloadFingerprint,
      message_id: claimInput.messageId,
    })
  })

  it('turns a unique conflict into a durable already-attempted result', async () => {
    const insertBuilder = {
      insert: vi.fn(),
      select: vi.fn(),
      single: vi.fn(async () => ({ data: null, error: { code: '23505' } })),
    }
    insertBuilder.insert.mockReturnValue(insertBuilder)
    insertBuilder.select.mockReturnValue(insertBuilder)
    const existingBuilder = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn(async () => ({ data: { status: 'ambiguous' }, error: null })),
    }
    existingBuilder.select.mockReturnValue(existingBuilder)
    existingBuilder.eq.mockReturnValue(existingBuilder)
    getAdminClientMock.mockReturnValue({
      from: vi.fn()
        .mockReturnValueOnce(insertBuilder)
        .mockReturnValueOnce(existingBuilder),
    })

    await expect(createDailyDigestDeliveryLedger().claim(claimInput)).resolves.toEqual({
      status: 'already_attempted',
      attemptStatus: 'ambiguous',
    })
    expect(existingBuilder.eq).toHaveBeenCalledWith('payload_fingerprint', claimInput.payloadFingerprint)
    expect(existingBuilder.eq).not.toHaveBeenCalledWith('provider', claimInput.provider)
  })

  it('completes only a still-claimed attempt', async () => {
    const builder = {
      update: vi.fn(),
      eq: vi.fn(),
      select: vi.fn(),
      maybeSingle: vi.fn(async () => ({ data: { id: attemptId }, error: null })),
    }
    builder.update.mockReturnValue(builder)
    builder.eq.mockReturnValue(builder)
    builder.select.mockReturnValue(builder)
    getAdminClientMock.mockReturnValue({ from: vi.fn(() => builder) })

    await expect(createDailyDigestDeliveryLedger().complete({
      attemptId,
      status: 'sent',
      providerMessageId: '<owner-fixture@gmail.com>',
    })).resolves.toBeUndefined()
    expect(builder.eq).toHaveBeenNthCalledWith(1, 'id', attemptId)
    expect(builder.eq).toHaveBeenNthCalledWith(2, 'status', 'claimed')
  })
})
