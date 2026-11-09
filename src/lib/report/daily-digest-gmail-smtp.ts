import 'server-only'
import { Socket } from 'node:net'

import nodemailer from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'

export interface GmailSmtpMessage {
  host: 'smtp.gmail.com'
  port: 465
  secure: true
  auth: { user: string; pass: string }
  from: string
  to: string
  subject: string
  text: string
  /** OPTIONAL alternative part. When present nodemailer emits multipart/alternative and `text`
   *  remains the fallback body; when absent the message is byte-identical to the text-only v1. */
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

export class GmailSmtpDeliveryError extends Error {
  constructor(
    public readonly outcome: 'definite_failure' | 'ambiguous',
    message = 'Gmail SMTP delivery failed.',
  ) {
    super(message)
    this.name = 'GmailSmtpDeliveryError'
  }
}

function definitelyRejectedBeforeData(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const smtpError = error as { code?: unknown; command?: unknown }
  const code = typeof smtpError.code === 'string' ? smtpError.code.toUpperCase() : ''
  const command = typeof smtpError.command === 'string' ? smtpError.command.toUpperCase() : ''
  return (
    ['EAUTH', 'EDNS', 'EENVELOPE', 'ETLS'].includes(code)
    || /^(AUTH|EHLO|HELO|MAIL FROM|RCPT TO)/.test(command)
  )
}

export async function sendDailyDigestWithGmailSmtp(
  message: GmailSmtpMessage,
  options: { signal: AbortSignal },
  dependencies: GmailSmtpDependencies = {},
): Promise<{ messageId: string | null }> {
  if (options.signal.aborted) {
    throw new GmailSmtpDeliveryError('ambiguous', 'Gmail SMTP delivery aborted.')
  }

  const socket = (dependencies.createSocket ?? (() => new Socket()))()
  const transportOptions: GmailSmtpTransportOptions = {
    host: message.host,
    port: message.port,
    secure: message.secure,
    auth: message.auth,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
    tls: { servername: 'smtp.gmail.com', minVersion: 'TLSv1.2' },
    socket,
  }
  const createTransport = dependencies.createTransport ?? ((input) =>
    nodemailer.createTransport(input as SMTPTransport.Options))
  const transport = createTransport(transportOptions)

  let rejectAbort: ((error: Error) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => {
    socket.destroy()
    rejectAbort?.(new GmailSmtpDeliveryError('ambiguous', 'Gmail SMTP delivery aborted.'))
  }
  options.signal.addEventListener('abort', onAbort, { once: true })

  try {
    let sent: { messageId?: string }
    try {
      sent = await Promise.race([
        transport.sendMail({
          from: { address: message.from },
          to: [{ address: message.to }],
          envelope: { from: message.from, to: [message.to] },
          subject: message.subject,
          text: message.text,
          ...(message.html === undefined ? {} : { html: message.html }),
          messageId: message.messageId,
          headers: { 'X-Daily-Digest-Report-Id': message.reportId },
        }),
        aborted,
      ])
    } catch (error) {
      if (error instanceof GmailSmtpDeliveryError) throw error
      throw new GmailSmtpDeliveryError(
        definitelyRejectedBeforeData(error) ? 'definite_failure' : 'ambiguous',
      )
    }
    return { messageId: typeof sent.messageId === 'string' ? sent.messageId : null }
  } finally {
    options.signal.removeEventListener('abort', onAbort)
    transport.close()
    if (!socket.destroyed) socket.destroy()
  }
}
