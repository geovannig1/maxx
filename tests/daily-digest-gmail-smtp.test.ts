import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  deliverDailyDigestSafely,
  type DailyDigestDeliveryAttemptStatus,
  type DailyDigestDeliveryRequest,
  type DailyDigestDeliveryLedger,
  type DailyDigestGmailSmtpSender,
} from '@/lib/report/daily-digest-delivery'
import { GmailSmtpDeliveryError } from '@/lib/report/daily-digest-gmail-smtp'

const request: DailyDigestDeliveryRequest = {
  reportId: '00000000-0000-4000-8000-000000000941',
  reportDate: '2026-08-11',
  subject: 'Maxx daily digest — 2026-08-11',
  markdown: '# Daily digest\n\nNothing broke.',
}

// Fixture addresses stay @gmail.com on purpose: the Gmail SMTP path rejects a sender outside gmail.com
// and requires OWNER_EMAIL to equal it (daily-digest-delivery.ts, weekly-executive-delivery.ts).
const gmailEnv = {
  DAILY_DIGEST_EMAIL_PROVIDER: 'gmail_smtp',
  GMAIL_SMTP_USER: 'customer-fixture@gmail.com',
  GMAIL_SMTP_APP_PASSWORD: 'abcd efgh ijkl mnop',
  OWNER_EMAIL: 'customer-fixture@gmail.com',
}

function ledger(overrides: Partial<DailyDigestDeliveryLedger> = {}): DailyDigestDeliveryLedger {
  return {
    claim: vi.fn<DailyDigestDeliveryLedger['claim']>(async () => ({
      status: 'claimed',
      attemptId: 'attempt-1',
    })),
    complete: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('daily digest Gmail SMTP transport', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('selects Gmail SMTP explicitly and sends through the injected bounded transport', async () => {
    const fetcher = vi.fn()
    const deliveryLedger = ledger()
    const gmailSmtpSender = vi.fn<DailyDigestGmailSmtpSender>(async () => ({
      messageId: '<owner-fixture@gmail.com>',
    }))

    const result = await deliverDailyDigestSafely(request, {
      env: gmailEnv,
      fetcher: fetcher as unknown as typeof fetch,
      gmailSmtpSender,
      deliveryLedger,
    })

    expect(result).toEqual({
      status: 'sent',
      provider: 'gmail_smtp',
      provider_message_id: '<owner-fixture@gmail.com>',
    })
    expect(fetcher).not.toHaveBeenCalled()
    expect(gmailSmtpSender).toHaveBeenCalledOnce()
    expect(gmailSmtpSender).toHaveBeenCalledWith(expect.objectContaining({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: 'customer-fixture@gmail.com',
        pass: 'abcdefghijklmnop',
      },
      from: 'customer-fixture@gmail.com',
      to: 'customer-fixture@gmail.com',
      subject: request.subject,
      text: request.markdown,
      messageId: expect.stringMatching(
        new RegExp(`^<maxx-daily-digest-${request.reportId}-[0-9a-f]{64}@gmail\\.com>$`),
      ),
    }), expect.objectContaining({
      signal: expect.any(AbortSignal),
    }))
    expect(deliveryLedger.claim).toHaveBeenCalledWith(expect.objectContaining({
      reportId: request.reportId,
      provider: 'gmail_smtp',
      recipient: 'customer-fixture@gmail.com',
      payloadFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    }))
    expect(deliveryLedger.complete).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'attempt-1',
      status: 'sent',
      providerMessageId: '<owner-fixture@gmail.com>',
    }))
  })

  it('fails safely without calling a transport when explicit Gmail configuration is incomplete', async () => {
    const gmailSmtpSender = vi.fn<DailyDigestGmailSmtpSender>()

    const result = await deliverDailyDigestSafely(request, {
      env: {
        DAILY_DIGEST_EMAIL_PROVIDER: 'gmail_smtp',
        GMAIL_SMTP_USER: 'customer-fixture@gmail.com',
        GMAIL_SMTP_APP_PASSWORD: '',
        OWNER_EMAIL: 'owner@example.com',
      },
      gmailSmtpSender,
      deliveryLedger: ledger(),
    })

    expect(result).toEqual({
      status: 'failed',
      provider: 'gmail_smtp',
      reason: 'Daily digest Gmail SMTP configuration is incomplete or invalid.',
    })
    expect(gmailSmtpSender).not.toHaveBeenCalled()
  })

  it('bounds a stalled SMTP send and resolves fail-soft', async () => {
    vi.useFakeTimers()
    const gmailSmtpSender = vi.fn<DailyDigestGmailSmtpSender>(() => new Promise(() => {}))
    const deliveryLedger = ledger()

    const delivery = deliverDailyDigestSafely(request, {
      env: gmailEnv,
      gmailSmtpSender,
      deliveryLedger,
      deliveryTimeoutMs: 25,
    })
    await vi.advanceTimersByTimeAsync(26)

    await expect(delivery).resolves.toEqual({
      status: 'failed',
      provider: 'gmail_smtp',
      reason: 'Gmail SMTP delivery timed out.',
    })
    expect(deliveryLedger.complete).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'attempt-1',
      status: 'ambiguous',
    }))
  })

  it('contains provider failures without exposing credentials or provider exception text', async () => {
    const appPassword = gmailEnv.GMAIL_SMTP_APP_PASSWORD
    const deliveryLedger = ledger()
    const gmailSmtpSender = vi.fn<DailyDigestGmailSmtpSender>(async () => {
      throw new Error(`535 authentication failed for ${gmailEnv.GMAIL_SMTP_USER}: ${appPassword}`)
    })

    const result = await deliverDailyDigestSafely(request, {
      env: gmailEnv,
      gmailSmtpSender,
      deliveryLedger,
    })
    const serialized = JSON.stringify(result)

    expect(result).toEqual({
      status: 'failed',
      provider: 'gmail_smtp',
      reason: 'Gmail SMTP delivery failed.',
    })
    expect(serialized).not.toContain(appPassword)
    expect(serialized).not.toContain(gmailEnv.GMAIL_SMTP_USER)
    expect(serialized).not.toContain('535')
    expect(deliveryLedger.complete).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'attempt-1',
      status: 'ambiguous',
    }))
  })

  it('records a definite pre-DATA SMTP rejection as failed rather than ambiguous', async () => {
    const deliveryLedger = ledger()
    const gmailSmtpSender = vi.fn<DailyDigestGmailSmtpSender>(async () => {
      throw new GmailSmtpDeliveryError('definite_failure')
    })

    await expect(deliverDailyDigestSafely(request, {
      env: gmailEnv,
      gmailSmtpSender,
      deliveryLedger,
    })).resolves.toEqual({
      status: 'failed',
      provider: 'gmail_smtp',
      reason: 'Gmail SMTP delivery failed.',
    })
    expect(deliveryLedger.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
    }))
  })

  it('never retries a payload that already has a durable delivery attempt', async () => {
    const gmailSmtpSender = vi.fn<DailyDigestGmailSmtpSender>()
    const deliveryLedger = ledger({
      claim: vi.fn<DailyDigestDeliveryLedger['claim']>(async () => ({
        status: 'already_attempted',
        attemptStatus: 'ambiguous',
      })),
    })

    await expect(deliverDailyDigestSafely(request, {
      env: gmailEnv,
      gmailSmtpSender,
      deliveryLedger,
    })).resolves.toEqual({ status: 'skipped', reason: 'already_attempted' })
    expect(gmailSmtpSender).not.toHaveBeenCalled()
  })

  it('fails closed for unknown providers and invalid digest headers', async () => {
    await expect(deliverDailyDigestSafely(request, {
      env: { DAILY_DIGEST_EMAIL_PROVIDER: 'unknown' },
      deliveryLedger: ledger(),
    })).resolves.toEqual({
      status: 'failed',
      reason: 'Daily digest email provider configuration is invalid.',
    })

    await expect(deliverDailyDigestSafely({ ...request, subject: 'Injected\r\nBcc: x@example.com' }, {
      env: gmailEnv,
      deliveryLedger: ledger(),
    })).resolves.toEqual({
      status: 'failed',
      provider: 'gmail_smtp',
      reason: 'Daily digest delivery request is invalid.',
    })
  })

  it('rejects display-name senders and multi-recipient destination strings', async () => {
    const gmailSmtpSender = vi.fn<DailyDigestGmailSmtpSender>()
    const invalidEnvironments = [
      { ...gmailEnv, GMAIL_SMTP_USER: 'Maxx <customer-fixture@gmail.com>' },
      { ...gmailEnv, OWNER_EMAIL: 'customer-fixture@gmail.com,evil@example.com' },
      { ...gmailEnv, OWNER_EMAIL: 'other-fixture@gmail.com' },
    ]

    for (const env of invalidEnvironments) {
      await expect(deliverDailyDigestSafely(request, {
        env,
        gmailSmtpSender,
        deliveryLedger: ledger(),
      })).resolves.toEqual({
        status: 'failed',
        provider: 'gmail_smtp',
        reason: 'Daily digest Gmail SMTP configuration is incomplete or invalid.',
      })
    }
    expect(gmailSmtpSender).not.toHaveBeenCalled()
  })

  it('rejects a non-Gmail authenticated sender before claiming delivery', async () => {
    const deliveryLedger = ledger()
    const gmailSmtpSender = vi.fn<DailyDigestGmailSmtpSender>()

    await expect(deliverDailyDigestSafely(request, {
      env: {
        ...gmailEnv,
        GMAIL_SMTP_USER: 'maxx@example.com',
        OWNER_EMAIL: 'maxx@example.com',
      },
      gmailSmtpSender,
      deliveryLedger,
    })).resolves.toEqual({
      status: 'failed',
      provider: 'gmail_smtp',
      reason: 'Daily digest Gmail SMTP configuration is incomplete or invalid.',
    })
    expect(deliveryLedger.claim).not.toHaveBeenCalled()
    expect(gmailSmtpSender).not.toHaveBeenCalled()
  })

  it('threads an html part through to the transport without disturbing the text part', async () => {
    const html = '<!DOCTYPE html><html><body>Nothing broke.</body></html>'
    const gmailSmtpSender = vi.fn<DailyDigestGmailSmtpSender>(async () => ({ messageId: null }))

    await deliverDailyDigestSafely({ ...request, html }, {
      env: gmailEnv,
      gmailSmtpSender,
      deliveryLedger: ledger(),
    })

    expect(gmailSmtpSender).toHaveBeenCalledWith(
      expect.objectContaining({ text: request.markdown, html }),
      expect.anything(),
    )
  })

  it('sends no html key at all when the request carries no html', async () => {
    const gmailSmtpSender = vi.fn<DailyDigestGmailSmtpSender>(async () => ({ messageId: null }))

    await deliverDailyDigestSafely(request, {
      env: gmailEnv,
      gmailSmtpSender,
      deliveryLedger: ledger(),
    })

    const message = gmailSmtpSender.mock.calls[0][0]
    expect('html' in message).toBe(false)
    expect(message.text).toBe(request.markdown)
  })

  it('rejects an oversized or NUL-bearing html part without ever claiming a delivery', async () => {
    const gmailSmtpSender = vi.fn<DailyDigestGmailSmtpSender>()
    const deliveryLedger = ledger()
    const invalid = ['a'.repeat(100_001), '', '<p>\u0000</p>']

    // Byte length, not code-unit length: 50_001 two-byte characters exceed the 100_000-byte cap.
    for (const html of [...invalid, 'é'.repeat(50_001)]) {
      await expect(deliverDailyDigestSafely({ ...request, html }, {
        env: gmailEnv,
        gmailSmtpSender,
        deliveryLedger,
      })).resolves.toEqual({
        status: 'failed',
        provider: 'gmail_smtp',
        reason: 'Daily digest delivery request is invalid.',
      })
    }
    expect(gmailSmtpSender).not.toHaveBeenCalled()
    // Validation runs BEFORE the claim, so a rejected request leaves no orphan row in the ledger
    // holding this report's one delivery slot hostage against a later, valid attempt.
    expect(deliveryLedger.claim).not.toHaveBeenCalled()
  })

  it('EXCLUDES html from the fingerprint, so one committed report stays one email', async () => {
    const gmailSmtpSender = vi.fn<DailyDigestGmailSmtpSender>(async () => ({ messageId: null }))
    const fingerprints: string[] = []
    const capture = () => ledger({
      claim: vi.fn<DailyDigestDeliveryLedger['claim']>(async (input) => {
        fingerprints.push(input.payloadFingerprint)
        return { status: 'claimed', attemptId: 'attempt-1' }
      }),
    })

    for (const payload of [
      request,
      { ...request, html: '<p>one</p>' },
      { ...request, html: '<p>two</p>' },
    ]) {
      await deliverDailyDigestSafely(payload, {
        env: gmailEnv,
        gmailSmtpSender,
        deliveryLedger: capture(),
      })
    }

    // The html is only a second rendering of facts the text part already carries, so a different
    // render OUTCOME must not mint a different payload identity.
    expect(new Set(fingerprints).size).toBe(1)
  })

  it('never sends a second digest when a re-run renders html the first run could not', async () => {
    // Mirrors the delivery table's unique key (report_id, recipient, payload_fingerprint), so the
    // dedupe is exercised the way the real ledger enforces it rather than by assumption.
    const rows = new Map<string, DailyDigestDeliveryAttemptStatus>()
    const deliveryLedger: DailyDigestDeliveryLedger = {
      claim: vi.fn<DailyDigestDeliveryLedger['claim']>(async (input) => {
        const key = `${input.reportId}|${input.recipient}|${input.payloadFingerprint}`
        const existing = rows.get(key)
        if (existing) return { status: 'already_attempted', attemptStatus: existing }
        rows.set(key, 'claimed')
        return { status: 'claimed', attemptId: key }
      }),
      complete: vi.fn<DailyDigestDeliveryLedger['complete']>(async (input) => {
        rows.set(input.attemptId, input.status)
      }),
    }
    const gmailSmtpSender = vi.fn<DailyDigestGmailSmtpSender>(async () => ({ messageId: null }))

    // Run 1: the html render failed upstream, so the digest went out text-only.
    const first = await deliverDailyDigestSafely(request, {
      env: gmailEnv, gmailSmtpSender, deliveryLedger,
    })
    // Run 2: SAME committed report, cron re-invoked, and this time the render succeeded.
    const second = await deliverDailyDigestSafely({ ...request, html: '<p>now it rendered</p>' }, {
      env: gmailEnv, gmailSmtpSender, deliveryLedger,
    })

    expect(first).toMatchObject({ status: 'sent' })
    expect(second).toEqual({ status: 'skipped', reason: 'already_attempted' })
    expect(gmailSmtpSender).toHaveBeenCalledOnce()
  })

  it('adds html to the Resend body only when the request carries one', async () => {
    const resendEnv = {
      DAILY_DIGEST_EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test',
      DAILY_DIGEST_FROM_EMAIL: 'updates@example.com',
      OWNER_EMAIL: 'owner@example.com',
    }
    const bodies: Array<Record<string, unknown>> = []
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json({ id: 'resend-1' })
    }) as unknown as typeof fetch

    await deliverDailyDigestSafely(request, { env: resendEnv, fetcher, deliveryLedger: ledger() })
    await deliverDailyDigestSafely({ ...request, html: '<p>hi</p>' }, {
      env: resendEnv,
      fetcher,
      deliveryLedger: ledger(),
    })

    expect('html' in bodies[0]).toBe(false)
    expect(bodies[0].text).toBe(request.markdown)
    expect(bodies[1].html).toBe('<p>hi</p>')
    expect(bodies[1].text).toBe(request.markdown)
  })

  it('does not infer a provider from credentials', async () => {
    const deliveryLedger = ledger()
    const gmailSmtpSender = vi.fn<DailyDigestGmailSmtpSender>()
    const credentialsOnly = Object.fromEntries(
      Object.entries(gmailEnv).filter(([key]) => key !== 'DAILY_DIGEST_EMAIL_PROVIDER'),
    )

    await expect(deliverDailyDigestSafely(request, {
      env: credentialsOnly,
      gmailSmtpSender,
      deliveryLedger,
    })).resolves.toEqual({ status: 'skipped', reason: 'not_configured' })
    expect(deliveryLedger.claim).not.toHaveBeenCalled()
    expect(gmailSmtpSender).not.toHaveBeenCalled()
  })
})
