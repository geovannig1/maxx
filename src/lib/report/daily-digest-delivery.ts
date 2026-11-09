import 'server-only'
import { createHash } from 'node:crypto'

import {
  GmailSmtpDeliveryError,
  sendDailyDigestWithGmailSmtp,
  type GmailSmtpMessage,
} from '@/lib/report/daily-digest-gmail-smtp'
import { createDailyDigestDeliveryLedger } from '@/lib/report/daily-digest-delivery-store'

const RESEND_ENDPOINT = 'https://api.resend.com/emails'
const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_{}|~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAX_DIGEST_BYTES = 100_000
const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000

type DailyDigestEmailProvider = 'gmail_smtp' | 'resend'

export interface DailyDigestDeliveryRequest {
  reportId: string
  reportDate: string
  subject: string
  markdown: string
  /** OPTIONAL pre-rendered alternative part. It is carried ALONGSIDE `markdown`, never instead of
   *  it, and its absence must leave every provider call byte-identical to the text-only path. */
  html?: string
}

export type DailyDigestDeliveryAttemptStatus = 'claimed' | 'sent' | 'failed' | 'ambiguous'

export interface DailyDigestDeliveryLedger {
  claim(input: {
    reportId: string
    provider: DailyDigestEmailProvider
    recipient: string
    payloadFingerprint: string
    messageId: string
  }): Promise<
    | { status: 'claimed'; attemptId: string }
    | { status: 'already_attempted'; attemptStatus: DailyDigestDeliveryAttemptStatus }
  >
  complete(input: {
    attemptId: string
    status: Exclude<DailyDigestDeliveryAttemptStatus, 'claimed'>
    providerMessageId?: string | null
  }): Promise<void>
}

export type DailyDigestGmailSmtpSender = (
  message: GmailSmtpMessage,
  options: { signal: AbortSignal },
) => Promise<{ messageId: string | null }>

export type DailyDigestDeliveryResult =
  | { status: 'sent'; provider: DailyDigestEmailProvider; provider_message_id: string | null }
  | { status: 'skipped'; reason: 'not_configured' | 'already_attempted' }
  | { status: 'failed'; provider?: DailyDigestEmailProvider; reason: string }

interface DeliveryDependencies {
  env?: Record<string, string | undefined>
  fetcher?: typeof fetch
  gmailSmtpSender?: DailyDigestGmailSmtpSender
  deliveryLedger?: DailyDigestDeliveryLedger
  deliveryTimeoutMs?: number
}

interface GmailConfig {
  provider: 'gmail_smtp'
  user: string
  appPassword: string
  to: string
}

interface ResendConfig {
  provider: 'resend'
  apiKey: string
  from: string
  to: string
}

function isValidEmail(value: string): boolean {
  return value.length <= 320 && EMAIL_PATTERN.test(value) && !/[\u0000-\u001f\u007f]/.test(value)
}

function plainEmail(value: string): string {
  const match = value.match(/<([^<>]+)>$/)
  return (match?.[1] ?? value).trim()
}

function validDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

function validRequest(request: DailyDigestDeliveryRequest): boolean {
  return (
    typeof request.reportId === 'string'
    && UUID_PATTERN.test(request.reportId)
    && typeof request.reportDate === 'string'
    && validDate(request.reportDate)
    && typeof request.subject === 'string'
    && request.subject === `Maxx daily digest — ${request.reportDate}`
    && request.subject.length <= 200
    && !/[\u0000-\u001f\u007f]/.test(request.subject)
    && typeof request.markdown === 'string'
    && request.markdown.length > 0
    && !request.markdown.includes('\u0000')
    && new TextEncoder().encode(request.markdown).byteLength <= MAX_DIGEST_BYTES
    && (request.html === undefined || validHtmlPart(request.html))
  )
}

/** Held to the same bounds as the text part: an html body is only ever an alternative rendering
 *  of it, so it can be neither empty, nor NUL-bearing, nor larger than the digest byte budget. */
function validHtmlPart(html: unknown): boolean {
  return (
    typeof html === 'string'
    && html.length > 0
    && !html.includes('\u0000')
    && new TextEncoder().encode(html).byteLength <= MAX_DIGEST_BYTES
  )
}

function readProvider(env: Record<string, string | undefined>):
  | DailyDigestEmailProvider
  | 'invalid'
  | null {
  const value = env.DAILY_DIGEST_EMAIL_PROVIDER?.trim() ?? ''
  if (!value) return null
  return value === 'gmail_smtp' || value === 'resend' ? value : 'invalid'
}

function readGmailConfig(env: Record<string, string | undefined>): GmailConfig | null {
  const user = env.GMAIL_SMTP_USER?.trim().toLowerCase() ?? ''
  const appPassword = (env.GMAIL_SMTP_APP_PASSWORD ?? '').replace(/ /g, '')
  const to = env.OWNER_EMAIL?.trim().toLowerCase() ?? ''
  if (
    !isValidEmail(user)
    || !isValidEmail(to)
    || !/@gmail\.com$/i.test(user)
    || user !== to
    || !/^[A-Za-z0-9]{16}$/.test(appPassword)
  ) return null
  return { provider: 'gmail_smtp', user, appPassword, to }
}

function readResendConfig(env: Record<string, string | undefined>): ResendConfig | null {
  const apiKey = env.RESEND_API_KEY?.trim() ?? ''
  const from = env.DAILY_DIGEST_FROM_EMAIL?.trim() ?? ''
  const to = env.OWNER_EMAIL?.trim() ?? ''
  if (
    !apiKey
    || apiKey.length > 512
    || /[\u0000-\u001f\u007f]/.test(apiKey)
    || from.length > 320
    || /[\r\n]/.test(from)
    || !isValidEmail(plainEmail(from))
    || !isValidEmail(to)
  ) return null
  return { provider: 'resend', apiKey, from, to }
}

/**
 * `html` is DELIBERATELY EXCLUDED from the hashed payload. Do not add it.
 *
 * The fingerprint is what makes "one email per committed report" hold. The html part is only a
 * second rendering of facts the text part already carries, so hashing it would key idempotency on
 * the RENDER OUTCOME: a run whose render threw would send text-only under fingerprint A, and a
 * re-invocation for the same committed report — exactly the case the ledger exists for — would
 * render successfully, hash to fingerprint B, INSERT a fresh claim, and mail the owner a second
 * digest for the same day. Worse, `messageIdFor` derives from the fingerprint, so the two would
 * not even collapse into one Gmail thread.
 *
 * A day that falls back to text-only has lost formatting, not information. Duplicate mail is the
 * larger harm, so identity stays anchored to the committed report's facts.
 */
function fingerprint(request: DailyDigestDeliveryRequest, recipient: string): string {
  const payload = JSON.stringify({
    report_id: request.reportId,
    report_date: request.reportDate,
    recipient,
    subject: request.subject,
    text: request.markdown,
  })
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`
}

function messageIdFor(request: DailyDigestDeliveryRequest, payloadFingerprint: string): string {
  return `<maxx-daily-digest-${request.reportId}-${payloadFingerprint.slice(7)}@gmail.com>`
}

async function completeAttempt(
  ledger: DailyDigestDeliveryLedger,
  input: Parameters<DailyDigestDeliveryLedger['complete']>[0],
): Promise<void> {
  try {
    await ledger.complete(input)
  } catch {
    // The durable claim remains and blocks retries even if its terminal state cannot be recorded.
    console.error('[DailyDigestDelivery] Failed to persist terminal attempt state.')
  }
}

async function deliverWithGmail(
  request: DailyDigestDeliveryRequest,
  config: GmailConfig,
  sender: DailyDigestGmailSmtpSender,
  timeoutMs: number,
  messageId: string,
): Promise<{ messageId: string | null }> {
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new Error('timeout'))
    }, timeoutMs)
  })
  const message: GmailSmtpMessage = {
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: config.user, pass: config.appPassword },
    from: config.user,
    to: config.to,
    subject: request.subject,
    text: request.markdown,
    ...(request.html === undefined ? {} : { html: request.html }),
    reportId: request.reportId,
    messageId,
  }
  try {
    return await Promise.race([sender(message, { signal: controller.signal }), timeout])
  } catch (error) {
    if (timedOut) throw new Error('timeout')
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function deliverWithResend(
  request: DailyDigestDeliveryRequest,
  config: ResendConfig,
  fetcher: typeof fetch,
  payloadFingerprint: string,
): Promise<{ ok: boolean; messageId: string | null }> {
  const response = await fetcher(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `maxx-daily-digest/${request.reportId}/${payloadFingerprint.slice(7)}`,
    },
    signal: AbortSignal.timeout(DEFAULT_DELIVERY_TIMEOUT_MS),
    body: JSON.stringify({
      from: config.from,
      to: [config.to],
      subject: request.subject,
      text: request.markdown,
      ...(request.html === undefined ? {} : { html: request.html }),
    }),
  })
  if (!response.ok) return { ok: false, messageId: null }
  try {
    const body = await response.json() as { id?: unknown }
    return { ok: true, messageId: typeof body.id === 'string' ? body.id : null }
  } catch {
    return { ok: true, messageId: null }
  }
}

/** Isolated post-commit side effect. Every failure resolves and an existing durable claim is never retried. */
export async function deliverDailyDigestSafely(
  request: DailyDigestDeliveryRequest,
  dependencies: DeliveryDependencies = {},
): Promise<DailyDigestDeliveryResult> {
  const env = dependencies.env ?? process.env
  const provider = readProvider(env)
  if (provider === null) return { status: 'skipped', reason: 'not_configured' }
  if (provider === 'invalid') {
    return { status: 'failed', reason: 'Daily digest email provider configuration is invalid.' }
  }
  if (!validRequest(request)) {
    return { status: 'failed', provider, reason: 'Daily digest delivery request is invalid.' }
  }

  const config = provider === 'gmail_smtp' ? readGmailConfig(env) : readResendConfig(env)
  if (!config) {
    return {
      status: 'failed',
      provider,
      reason: provider === 'gmail_smtp'
        ? 'Daily digest Gmail SMTP configuration is incomplete or invalid.'
        : 'Daily digest Resend configuration is incomplete or invalid.',
    }
  }

  const ledger = dependencies.deliveryLedger ?? createDailyDigestDeliveryLedger()
  const payloadFingerprint = fingerprint(request, config.to)
  const messageId = messageIdFor(request, payloadFingerprint)
  let claim: Awaited<ReturnType<DailyDigestDeliveryLedger['claim']>>
  try {
    claim = await ledger.claim({
      reportId: request.reportId,
      provider,
      recipient: config.to,
      payloadFingerprint,
      messageId,
    })
  } catch {
    return { status: 'failed', provider, reason: 'Daily digest delivery could not be claimed.' }
  }
  if (claim.status === 'already_attempted') {
    return { status: 'skipped', reason: 'already_attempted' }
  }

  if (config.provider === 'gmail_smtp') {
    try {
      const timeoutMs = Number.isFinite(dependencies.deliveryTimeoutMs)
        ? Math.max(1, Math.min(dependencies.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS, 30_000))
        : DEFAULT_DELIVERY_TIMEOUT_MS
      const sent = await deliverWithGmail(
        request,
        config,
        dependencies.gmailSmtpSender ?? sendDailyDigestWithGmailSmtp,
        timeoutMs,
        messageId,
      )
      await completeAttempt(ledger, {
        attemptId: claim.attemptId,
        status: 'sent',
        providerMessageId: sent.messageId,
      })
      return { status: 'sent', provider, provider_message_id: sent.messageId }
    } catch (error) {
      const timedOut = error instanceof Error && error.message === 'timeout'
      const status = error instanceof GmailSmtpDeliveryError
        && error.outcome === 'definite_failure'
        ? 'failed'
        : 'ambiguous'
      await completeAttempt(ledger, { attemptId: claim.attemptId, status })
      return {
        status: 'failed',
        provider,
        reason: timedOut ? 'Gmail SMTP delivery timed out.' : 'Gmail SMTP delivery failed.',
      }
    }
  }

  try {
    const sent = await deliverWithResend(
      request,
      config,
      dependencies.fetcher ?? fetch,
      payloadFingerprint,
    )
    await completeAttempt(ledger, {
      attemptId: claim.attemptId,
      status: sent.ok ? 'sent' : 'failed',
      providerMessageId: sent.messageId,
    })
    return sent.ok
      ? { status: 'sent', provider, provider_message_id: sent.messageId }
      : { status: 'failed', provider, reason: 'Resend delivery failed.' }
  } catch {
    await completeAttempt(ledger, { attemptId: claim.attemptId, status: 'ambiguous' })
    return { status: 'failed', provider, reason: 'Resend delivery failed.' }
  }
}
