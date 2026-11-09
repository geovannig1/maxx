import 'server-only'
import { Socket } from 'node:net'

import nodemailer from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'

export interface WeeklyExecutiveGmailSmtpMessage {
  host: 'smtp.gmail.com'
  port: 465
  secure: true
  auth: { user: string; pass: string }
  from: string
  to: string
  subject: string
  text: string
  html?: string
  reportId: string
  messageId: string
}

interface DestroyableSocket {
  destroyed: boolean
  destroy(error?: Error): unknown
}

interface GmailSmtpTransport {
  sendMail(message: Record<string, unknown>): Promise<{ messageId?: string }>
  close(): void
}

interface GmailSmtpTransportOptions {
  host: 'smtp.gmail.com'
  port: 465
  secure: true
  auth: { user: string; pass: string }
  connectionTimeout: number
  greetingTimeout: number
  socketTimeout: number
  tls: { servername: 'smtp.gmail.com'; minVersion: 'TLSv1.2' }
  socket: DestroyableSocket
}

interface GmailSmtpDependencies {
  createSocket?: () => DestroyableSocket
  createTransport?: (options: GmailSmtpTransportOptions) => GmailSmtpTransport
}

export class WeeklyExecutiveGmailSmtpDeliveryError extends Error {
  constructor(
    public readonly outcome: 'definite_failure' | 'ambiguous',
    message = 'Gmail SMTP delivery failed.',
  ) {
    super(message)
    this.name = 'WeeklyExecutiveGmailSmtpDeliveryError'
  }
}

function definitelyRejectedBeforeData(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const smtpError = error as { code?: unknown; command?: unknown }
  const code = typeof smtpError.code === 'string' ? smtpError.code.toUpperCase() : ''
  const command = typeof smtpError.command === 'string' ? smtpError.command.toUpperCase() : ''
  return ['EAUTH', 'EDNS', 'EENVELOPE', 'ETLS'].includes(code)
    || /^(AUTH|EHLO|HELO|MAIL FROM|RCPT TO)/.test(command)
}

export async function sendWeeklyExecutiveWithGmailSmtp(
  message: WeeklyExecutiveGmailSmtpMessage,
  options: { signal: AbortSignal },
  dependencies: GmailSmtpDependencies = {},
): Promise<{ messageId: string | null }> {
  if (options.signal.aborted) {
    throw new WeeklyExecutiveGmailSmtpDeliveryError('ambiguous', 'Gmail SMTP delivery aborted.')
  }

  const socket = (dependencies.createSocket ?? (() => new Socket()))()
  const createTransport = dependencies.createTransport ?? ((input: GmailSmtpTransportOptions) =>
    nodemailer.createTransport(input as SMTPTransport.Options))
  const transport = createTransport({
    host: message.host,
    port: message.port,
    secure: message.secure,
    auth: message.auth,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
    tls: { servername: 'smtp.gmail.com', minVersion: 'TLSv1.2' },
    socket,
  })

  let rejectAbort: ((error: Error) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = () => {
    socket.destroy()
    rejectAbort?.(new WeeklyExecutiveGmailSmtpDeliveryError('ambiguous', 'Gmail SMTP delivery aborted.'))
  }
  options.signal.addEventListener('abort', onAbort, { once: true })

  try {
    try {
      const sent = await Promise.race([
        transport.sendMail({
          from: { address: message.from },
          to: [{ address: message.to }],
          envelope: { from: message.from, to: [message.to] },
          subject: message.subject,
          text: message.text,
          ...(message.html === undefined ? {} : { html: message.html }),
          messageId: message.messageId,
          headers: { 'X-Weekly-Executive-Report-Id': message.reportId },
        }),
        aborted,
      ])
      return { messageId: typeof sent.messageId === 'string' ? sent.messageId : null }
    } catch (error) {
      if (error instanceof WeeklyExecutiveGmailSmtpDeliveryError) throw error
      throw new WeeklyExecutiveGmailSmtpDeliveryError(
        definitelyRejectedBeforeData(error) ? 'definite_failure' : 'ambiguous',
      )
    }
  } finally {
    options.signal.removeEventListener('abort', onAbort)
    transport.close()
    if (!socket.destroyed) socket.destroy()
  }
}
