import 'server-only'
import { createHash } from 'node:crypto'

import { createWeeklyExecutiveDeliveryLedger } from '@/lib/report/weekly-executive-delivery-store'
import {
  sendWeeklyExecutiveWithGmailSmtp,
  WeeklyExecutiveGmailSmtpDeliveryError,
  type WeeklyExecutiveGmailSmtpMessage,
} from '@/lib/report/weekly-executive-gmail-smtp'

const RESEND_ENDPOINT = 'https://api.resend.com/emails'
const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_{}|~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAX_BODY_BYTES = 100_000
const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000

type WeeklyExecutiveEmailProvider = 'gmail_smtp' | 'resend'

export interface WeeklyExecutiveDeliveryRequest {
  reportId: string
  weekStart: string
  weekEnd: string
  subject: string
  text: string
  html?: string
}

export type WeeklyExecutiveDeliveryAttemptStatus = 'claimed' | 'sent' | 'failed' | 'ambiguous'

export interface WeeklyExecutiveDeliveryLedger {
  claim(input: {
    reportId: string
    provider: WeeklyExecutiveEmailProvider
    recipient: string
    payloadFingerprint: string
    messageId: string
  }): Promise<
    | { status: 'claimed'; attemptId: string }
    | { status: 'already_attempted'; attemptStatus: WeeklyExecutiveDeliveryAttemptStatus }
  >
  complete(input: {
    attemptId: string
    status: Exclude<WeeklyExecutiveDeliveryAttemptStatus, 'claimed'>
    providerMessageId?: string | null
  }): Promise<void>
}

export type WeeklyExecutiveGmailSmtpSender = (
  message: WeeklyExecutiveGmailSmtpMessage,
  options: { signal: AbortSignal },
) => Promise<{ messageId: string | null }>

export type WeeklyExecutiveDeliveryResult =
  | { status: 'sent'; provider: WeeklyExecutiveEmailProvider; provider_message_id: string | null }
  | { status: 'skipped'; reason: 'not_configured' | 'already_attempted' }
  | { status: 'failed'; provider?: WeeklyExecutiveEmailProvider; reason: string }

interface DeliveryDependencies {
  env?: Record<string, string | undefined>
  fetcher?: typeof fetch
  gmailSmtpSender?: WeeklyExecutiveGmailSmtpSender
  deliveryLedger?: WeeklyExecutiveDeliveryLedger
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

function validDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

function validCompletedWeek(start: string, end: string): boolean {
  if (!validDate(start) || !validDate(end)) return false
  const startAt = Date.parse(`${start}T00:00:00.000Z`)
  const endAt = Date.parse(`${end}T00:00:00.000Z`)
  return new Date(startAt).getUTCDay() === 1
    && new Date(endAt).getUTCDay() === 0
    && endAt - startAt === 6 * 86_400_000
}

function validBody(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('\u0000')
    && new TextEncoder().encode(value).byteLength <= MAX_BODY_BYTES
}

function validRequest(request: WeeklyExecutiveDeliveryRequest): boolean {
  return UUID_PATTERN.test(request.reportId)
    && validCompletedWeek(request.weekStart, request.weekEnd)
    && request.subject === `Maxx weekly executive read — ${request.weekStart}–${request.weekEnd}`
    && request.subject.length <= 200
    && !/[\u0000-\u001f\u007f]/.test(request.subject)
    && validBody(request.text)
    && (request.html === undefined || validBody(request.html))
}

function isValidEmail(value: string): boolean {
  return value.length <= 320 && EMAIL_PATTERN.test(value) && !/[\u0000-\u001f\u007f]/.test(value)
}

function plainEmail(value: string): string {
  const match = value.match(/<([^<>]+)>$/)
  return (match?.[1] ?? value).trim()
}

function readProvider(env: Record<string, string | undefined>): WeeklyExecutiveEmailProvider | 'invalid' | null {
  const value = env.WEEKLY_EXECUTIVE_EMAIL_PROVIDER?.trim()
    || env.DAILY_DIGEST_EMAIL_PROVIDER?.trim()
    || ''
  if (!value) return null
  return value === 'gmail_smtp' || value === 'resend' ? value : 'invalid'
}

function readGmailConfig(env: Record<string, string | undefined>): GmailConfig | null {
  const user = env.GMAIL_SMTP_USER?.trim().toLowerCase() ?? ''
  const appPassword = (env.GMAIL_SMTP_APP_PASSWORD ?? '').replace(/ /g, '')
  const to = env.OWNER_EMAIL?.trim().toLowerCase() ?? ''
  if (!isValidEmail(user) || !isValidEmail(to) || !/@gmail\.com$/i.test(user)
    || user !== to || !/^[A-Za-z0-9]{16}$/.test(appPassword)) return null
  return { provider: 'gmail_smtp', user, appPassword, to }
}

function readResendConfig(env: Record<string, string | undefined>): ResendConfig | null {
  const apiKey = env.RESEND_API_KEY?.trim() ?? ''
  const from = env.DAILY_DIGEST_FROM_EMAIL?.trim() ?? ''
  const to = env.OWNER_EMAIL?.trim() ?? ''
  if (!apiKey || apiKey.length > 512 || /[\u0000-\u001f\u007f]/.test(apiKey)
    || from.length > 320 || /[\r\n]/.test(from)
    || !isValidEmail(plainEmail(from)) || !isValidEmail(to)) return null
  return { provider: 'resend', apiKey, from, to }
}

/** HTML is a presentation of the same facts, so it cannot mint a second delivery identity. */
function fingerprint(request: WeeklyExecutiveDeliveryRequest, recipient: string): string {
  const payload = JSON.stringify({
    report_id: request.reportId,
    week_start: request.weekStart,
    week_end: request.weekEnd,
    recipient,
    subject: request.subject,
    text: request.text,
  })
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`
}

function messageIdFor(request: WeeklyExecutiveDeliveryRequest, payloadFingerprint: string): string {
  return `<maxx-weekly-executive-${request.reportId}-${payloadFingerprint.slice(7)}@gmail.com>`
}

async function completeAttempt(
  ledger: WeeklyExecutiveDeliveryLedger,
  input: Parameters<WeeklyExecutiveDeliveryLedger['complete']>[0],
): Promise<void> {
  try {
    await ledger.complete(input)
  } catch {
    console.error('[WeeklyExecutiveDelivery] Failed to persist terminal attempt state.')
  }
}

async function deliverWithGmail(
  request: WeeklyExecutiveDeliveryRequest,
  config: GmailConfig,
  sender: WeeklyExecutiveGmailSmtpSender,
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
  try {
    return await Promise.race([sender({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: config.user, pass: config.appPassword },
      from: config.user, to: config.to, subject: request.subject, text: request.text,
      ...(request.html === undefined ? {} : { html: request.html }),
      reportId: request.reportId, messageId,
    }, { signal: controller.signal }), timeout])
  } catch (error) {
    if (timedOut) throw new Error('timeout')
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function deliverWithResend(
  request: WeeklyExecutiveDeliveryRequest,
  config: ResendConfig,
  fetcher: typeof fetch,
  payloadFingerprint: string,
): Promise<{ ok: boolean; messageId: string | null }> {
  const response = await fetcher(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `maxx-weekly-executive/${request.reportId}/${payloadFingerprint.slice(7)}`,
    },
    signal: AbortSignal.timeout(DEFAULT_DELIVERY_TIMEOUT_MS),
    body: JSON.stringify({
      from: config.from, to: [config.to], subject: request.subject, text: request.text,
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

/** Isolated post-commit side effect. Any durable attempt, including ambiguous, is never retried. */
export async function deliverWeeklyExecutiveSafely(
  request: WeeklyExecutiveDeliveryRequest,
  dependencies: DeliveryDependencies = {},
): Promise<WeeklyExecutiveDeliveryResult> {
  const env = dependencies.env ?? process.env
  const provider = readProvider(env)
  if (provider === null) return { status: 'skipped', reason: 'not_configured' }
  if (provider === 'invalid') {
    return { status: 'failed', reason: 'Weekly executive email provider configuration is invalid.' }
  }
  if (!validRequest(request)) {
    return { status: 'failed', provider, reason: 'Weekly executive delivery request is invalid.' }
  }
  const config = provider === 'gmail_smtp' ? readGmailConfig(env) : readResendConfig(env)
  if (!config) {
    return {
      status: 'failed', provider,
      reason: provider === 'gmail_smtp'
        ? 'Weekly executive Gmail SMTP configuration is incomplete or invalid.'
        : 'Weekly executive Resend configuration is incomplete or invalid.',
    }
  }

  const ledger = dependencies.deliveryLedger ?? createWeeklyExecutiveDeliveryLedger()
  const payloadFingerprint = fingerprint(request, config.to)
  const messageId = messageIdFor(request, payloadFingerprint)
  let claim: Awaited<ReturnType<WeeklyExecutiveDeliveryLedger['claim']>>
  try {
    claim = await ledger.claim({
      reportId: request.reportId, provider, recipient: config.to, payloadFingerprint, messageId,
    })
  } catch {
    return { status: 'failed', provider, reason: 'Weekly executive delivery could not be claimed.' }
  }
  if (claim.status === 'already_attempted') return { status: 'skipped', reason: 'already_attempted' }

  if (config.provider === 'gmail_smtp') {
    try {
      const timeoutMs = Number.isFinite(dependencies.deliveryTimeoutMs)
        ? Math.max(1, Math.min(dependencies.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS, 30_000))
        : DEFAULT_DELIVERY_TIMEOUT_MS
      const sent = await deliverWithGmail(
        request, config, dependencies.gmailSmtpSender ?? sendWeeklyExecutiveWithGmailSmtp,
        timeoutMs, messageId,
      )
      await completeAttempt(ledger, {
        attemptId: claim.attemptId, status: 'sent', providerMessageId: sent.messageId,
      })
      return { status: 'sent', provider, provider_message_id: sent.messageId }
    } catch (error) {
      const timedOut = error instanceof Error && error.message === 'timeout'
      const status = error instanceof WeeklyExecutiveGmailSmtpDeliveryError
        && error.outcome === 'definite_failure' ? 'failed' : 'ambiguous'
      await completeAttempt(ledger, { attemptId: claim.attemptId, status })
      return {
        status: 'failed', provider,
        reason: timedOut ? 'Gmail SMTP delivery timed out.' : 'Gmail SMTP delivery failed.',
      }
    }
  }

  try {
    const sent = await deliverWithResend(
      request, config, dependencies.fetcher ?? fetch, payloadFingerprint,
    )
    await completeAttempt(ledger, {
      attemptId: claim.attemptId, status: sent.ok ? 'sent' : 'failed',
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
