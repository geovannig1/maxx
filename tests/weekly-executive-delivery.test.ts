import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  deliverWeeklyExecutiveSafely,
  type WeeklyExecutiveDeliveryAttemptStatus,
  type WeeklyExecutiveDeliveryLedger,
  type WeeklyExecutiveDeliveryRequest,
  type WeeklyExecutiveGmailSmtpSender,
} from '@/lib/report/weekly-executive-delivery'
import { WEEKLY_REPORT_ID, WEEK_END, WEEK_START } from './fixtures/weekly-executive'

const request: WeeklyExecutiveDeliveryRequest = {
  reportId: WEEKLY_REPORT_ID,
  weekStart: WEEK_START,
  weekEnd: WEEK_END,
  subject: `Maxx weekly executive read — ${WEEK_START}–${WEEK_END}`,
  text: '# Maxx Weekly Executive Read\n\nDiagnostic only.',
  html: '<!DOCTYPE html><html><body>Diagnostic only.</body></html>',
}

// Fixture addresses stay @gmail.com on purpose: the Gmail SMTP path rejects a sender outside gmail.com
// and requires OWNER_EMAIL to equal it (daily-digest-delivery.ts, weekly-executive-delivery.ts).
const gmailEnv = {
  WEEKLY_EXECUTIVE_EMAIL_PROVIDER: 'gmail_smtp',
  GMAIL_SMTP_USER: 'customer-fixture@gmail.com',
  GMAIL_SMTP_APP_PASSWORD: 'abcd efgh ijkl mnop',
  OWNER_EMAIL: 'customer-fixture@gmail.com',
}

function ledger(overrides: Partial<WeeklyExecutiveDeliveryLedger> = {}): WeeklyExecutiveDeliveryLedger {
  return {
    claim: vi.fn<WeeklyExecutiveDeliveryLedger['claim']>(async () => ({
      status: 'claimed', attemptId: 'attempt-1',
    })),
    complete: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('weekly executive one-shot delivery', () => {
  afterEach(() => vi.useRealTimers())

  it('sends a validated completed Monday-through-Sunday report through explicit Gmail SMTP', async () => {
    const deliveryLedger = ledger()
    const gmailSmtpSender = vi.fn<WeeklyExecutiveGmailSmtpSender>(async () => ({
      messageId: '<sender-fixture@gmail.com>',
    }))

    await expect(deliverWeeklyExecutiveSafely(request, {
      env: gmailEnv, deliveryLedger, gmailSmtpSender,
    })).resolves.toEqual({
      status: 'sent', provider: 'gmail_smtp', provider_message_id: '<sender-fixture@gmail.com>',
    })
    expect(gmailSmtpSender).toHaveBeenCalledWith(expect.objectContaining({
      subject: request.subject,
      text: request.text,
      html: request.html,
      reportId: WEEKLY_REPORT_ID,
      messageId: expect.stringMatching(/^<maxx-weekly-executive-[0-9a-f-]+-[0-9a-f]{64}@gmail\.com>$/),
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(deliveryLedger.claim).toHaveBeenCalledWith(expect.objectContaining({
      reportId: WEEKLY_REPORT_ID,
      recipient: 'customer-fixture@gmail.com',
      payloadFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    }))
  })

  it('rejects a partial or misaligned week before reserving its lifetime delivery slot', async () => {
    const deliveryLedger = ledger()
    for (const invalid of [
      { ...request, weekStart: '2026-08-04' },
      { ...request, weekEnd: '2026-08-08' },
      { ...request, subject: 'Injected\r\nBcc: x@example.com' },
    ]) {
      await expect(deliverWeeklyExecutiveSafely(invalid, {
        env: gmailEnv, deliveryLedger,
      })).resolves.toEqual({
        status: 'failed', provider: 'gmail_smtp',
        reason: 'Weekly executive delivery request is invalid.',
      })
    }
    expect(deliveryLedger.claim).not.toHaveBeenCalled()
  })

  it('never re-sends a committed weekly report after any prior attempt', async () => {
    const gmailSmtpSender = vi.fn<WeeklyExecutiveGmailSmtpSender>()
    const deliveryLedger = ledger({
      claim: vi.fn<WeeklyExecutiveDeliveryLedger['claim']>(async () => ({
        status: 'already_attempted', attemptStatus: 'ambiguous',
      })),
    })

    await expect(deliverWeeklyExecutiveSafely(request, {
      env: gmailEnv, deliveryLedger, gmailSmtpSender,
    })).resolves.toEqual({ status: 'skipped', reason: 'already_attempted' })
    expect(gmailSmtpSender).not.toHaveBeenCalled()
  })

  it('deduplicates by committed report and recipient even if a historical render differs', async () => {
    const rows = new Map<string, WeeklyExecutiveDeliveryAttemptStatus>()
    const deliveryLedger: WeeklyExecutiveDeliveryLedger = {
      claim: vi.fn<WeeklyExecutiveDeliveryLedger['claim']>(async (input) => {
        const key = `${input.reportId}|${input.recipient}`
        const existing = rows.get(key)
        if (existing) return { status: 'already_attempted', attemptStatus: existing }
        rows.set(key, 'claimed')
        return { status: 'claimed', attemptId: key }
      }),
      complete: vi.fn<WeeklyExecutiveDeliveryLedger['complete']>(async (input) => {
        rows.set(input.attemptId, input.status)
      }),
    }
    const gmailSmtpSender = vi.fn<WeeklyExecutiveGmailSmtpSender>(async () => ({ messageId: null }))

    const first = await deliverWeeklyExecutiveSafely(request, {
      env: gmailEnv, deliveryLedger, gmailSmtpSender,
    })
    const second = await deliverWeeklyExecutiveSafely({
      ...request, text: `${request.text}\nHistorical renderer changed.`, html: '<p>changed</p>',
    }, { env: gmailEnv, deliveryLedger, gmailSmtpSender })

    expect(first).toMatchObject({ status: 'sent' })
    expect(second).toEqual({ status: 'skipped', reason: 'already_attempted' })
    expect(gmailSmtpSender).toHaveBeenCalledOnce()
  })

  it('marks a timed-out send ambiguous and never retries it', async () => {
    vi.useFakeTimers()
    const deliveryLedger = ledger()
    const gmailSmtpSender = vi.fn<WeeklyExecutiveGmailSmtpSender>(() => new Promise(() => {}))
    const delivery = deliverWeeklyExecutiveSafely(request, {
      env: gmailEnv, deliveryLedger, gmailSmtpSender, deliveryTimeoutMs: 25,
    })
    await vi.advanceTimersByTimeAsync(26)

    await expect(delivery).resolves.toEqual({
      status: 'failed', provider: 'gmail_smtp', reason: 'Gmail SMTP delivery timed out.',
    })
    expect(deliveryLedger.complete).toHaveBeenCalledWith({
      attemptId: 'attempt-1', status: 'ambiguous',
    })
  })

  it('inherits the already-explicit daily provider when no weekly override is configured', async () => {
    const gmailSmtpSender = vi.fn<WeeklyExecutiveGmailSmtpSender>(async () => ({ messageId: null }))
    const env = { ...gmailEnv, WEEKLY_EXECUTIVE_EMAIL_PROVIDER: undefined, DAILY_DIGEST_EMAIL_PROVIDER: 'gmail_smtp' }

    await expect(deliverWeeklyExecutiveSafely(request, {
      env, gmailSmtpSender, deliveryLedger: ledger(),
    })).resolves.toMatchObject({ status: 'sent', provider: 'gmail_smtp' })
  })
})
