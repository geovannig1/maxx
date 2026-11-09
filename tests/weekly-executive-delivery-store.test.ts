import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getAdminClientMock } = vi.hoisted(() => ({ getAdminClientMock: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: getAdminClientMock }))

import { createWeeklyExecutiveDeliveryLedger } from '@/lib/report/weekly-executive-delivery-store'
import { WEEKLY_REPORT_ID } from './fixtures/weekly-executive'

const ATTEMPT = '00000000-0000-4000-8000-000000001082'
const claimInput = {
  reportId: WEEKLY_REPORT_ID,
  provider: 'gmail_smtp' as const,
  recipient: 'owner@example.com',
  payloadFingerprint: `sha256:${'a'.repeat(64)}`,
  messageId: `<maxx-weekly-executive-${WEEKLY_REPORT_ID}@gmail.com>`,
}

describe('weekly executive delivery ledger store', () => {
  beforeEach(() => getAdminClientMock.mockReset())

  it('claims the committed weekly report once', async () => {
    const builder = {
      insert: vi.fn(), select: vi.fn(),
      single: vi.fn(async () => ({ data: { id: ATTEMPT }, error: null })),
    }
    builder.insert.mockReturnValue(builder)
    builder.select.mockReturnValue(builder)
    const from = vi.fn(() => builder)
    getAdminClientMock.mockReturnValue({ from })

    await expect(createWeeklyExecutiveDeliveryLedger().claim(claimInput)).resolves.toEqual({
      status: 'claimed', attemptId: ATTEMPT,
    })
    expect(from).toHaveBeenCalledWith('weekly_executive_delivery_attempts')
    expect(builder.insert).toHaveBeenCalledWith({
      report_id: claimInput.reportId,
      provider: claimInput.provider,
      recipient: claimInput.recipient,
      payload_fingerprint: claimInput.payloadFingerprint,
      message_id: claimInput.messageId,
    })
  })

  it('treats any prior attempt for the report and recipient as final even if rendering changed', async () => {
    const insertBuilder = {
      insert: vi.fn(), select: vi.fn(),
      single: vi.fn(async () => ({ data: null, error: { code: '23505' } })),
    }
    insertBuilder.insert.mockReturnValue(insertBuilder)
    insertBuilder.select.mockReturnValue(insertBuilder)
    const existingBuilder = {
      select: vi.fn(), eq: vi.fn(),
      maybeSingle: vi.fn(async () => ({ data: { status: 'ambiguous' }, error: null })),
    }
    existingBuilder.select.mockReturnValue(existingBuilder)
    existingBuilder.eq.mockReturnValue(existingBuilder)
    getAdminClientMock.mockReturnValue({
      from: vi.fn().mockReturnValueOnce(insertBuilder).mockReturnValueOnce(existingBuilder),
    })

    await expect(createWeeklyExecutiveDeliveryLedger().claim(claimInput)).resolves.toEqual({
      status: 'already_attempted', attemptStatus: 'ambiguous',
    })
    expect(existingBuilder.eq).toHaveBeenCalledWith('report_id', claimInput.reportId)
    expect(existingBuilder.eq).toHaveBeenCalledWith('recipient', claimInput.recipient)
    expect(existingBuilder.eq).not.toHaveBeenCalledWith('payload_fingerprint', claimInput.payloadFingerprint)
  })
})
