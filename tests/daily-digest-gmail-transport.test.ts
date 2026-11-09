import { describe, expect, it, vi } from 'vitest'

import {
  GmailSmtpDeliveryError,
  sendDailyDigestWithGmailSmtp,
} from '@/lib/report/daily-digest-gmail-smtp'

const message = {
  host: 'smtp.gmail.com' as const,
  port: 465 as const,
  secure: true as const,
  auth: { user: 'customer-fixture@gmail.com', pass: 'abcdefghijklmnop' },
  from: 'customer-fixture@gmail.com',
  to: 'owner@example.com',
  subject: 'Maxx daily digest — 2026-08-11',
  text: '# Daily digest',
  reportId: '00000000-0000-4000-8000-000000000941',
  messageId: '<gmail-fixture@gmail.com>',
}

/** The exact key set the plain-text path has been putting on the wire in production. */
const V1_SEND_MAIL_KEYS = ['from', 'to', 'envelope', 'subject', 'text', 'messageId', 'headers']

describe('Gmail SMTP multipart body', () => {
  function transportSpy() {
    const socket = { destroyed: false, destroy: vi.fn(function destroy() { socket.destroyed = true }) }
    const transport = {
      // The generic types the mock's argument, so mock.calls[n][0] is the payload record.
      sendMail: vi.fn<(payload: Record<string, unknown>) => Promise<{ messageId: string }>>(
        async () => ({ messageId: '<sender-fixture@gmail.com>' }),
      ),
      close: vi.fn(),
    }
    return { socket, transport }
  }

  it('sends the html part ALONGSIDE the text part so nodemailer emits multipart/alternative', async () => {
    const { socket, transport } = transportSpy()
    const html = '<!DOCTYPE html><html><body>Spend is pacing to target.</body></html>'

    await sendDailyDigestWithGmailSmtp({ ...message, html }, {
      signal: new AbortController().signal,
    }, { createSocket: () => socket, createTransport: () => transport })

    const payload = transport.sendMail.mock.calls[0][0]
    expect(payload.html).toBe(html)
    // The text part is the deliverability signal AND the fallback: html never replaces it.
    expect(payload.text).toBe(message.text)
  })

  it('sends exactly the v1 field set when no html part is supplied', async () => {
    const { socket, transport } = transportSpy()

    await sendDailyDigestWithGmailSmtp(message, {
      signal: new AbortController().signal,
    }, { createSocket: () => socket, createTransport: () => transport })

    const payload = transport.sendMail.mock.calls[0][0]
    expect(Object.keys(payload).sort()).toEqual([...V1_SEND_MAIL_KEYS].sort())
    expect('html' in payload).toBe(false)
    expect(payload).toEqual({
      from: { address: message.from },
      to: [{ address: message.to }],
      envelope: { from: message.from, to: [message.to] },
      subject: message.subject,
      text: message.text,
      messageId: message.messageId,
      headers: { 'X-Daily-Digest-Report-Id': message.reportId },
    })
  })
})

describe('Gmail SMTP socket lifecycle', () => {
  it('destroys the SMTP socket and closes the transport when delivery is aborted', async () => {
    const socket = { destroyed: false, destroy: vi.fn(function destroy() { socket.destroyed = true }) }
    const transport = {
      sendMail: vi.fn(() => new Promise<{ messageId?: string }>(() => {})),
      close: vi.fn(),
    }
    const controller = new AbortController()
    const sending = sendDailyDigestWithGmailSmtp(message, { signal: controller.signal }, {
      createSocket: () => socket,
      createTransport: () => transport,
    })

    controller.abort()

    await expect(sending).rejects.toThrow('Gmail SMTP delivery aborted.')
    expect(socket.destroy).toHaveBeenCalledOnce()
    expect(transport.close).toHaveBeenCalledOnce()
  })

  it('classifies an authentication rejection as a definite pre-DATA failure', async () => {
    const socket = { destroyed: false, destroy: vi.fn(function destroy() { socket.destroyed = true }) }
    const authenticationError = Object.assign(new Error('authentication failed'), {
      code: 'EAUTH',
      command: 'AUTH PLAIN',
    })
    const transport = {
      sendMail: vi.fn(async () => { throw authenticationError }),
      close: vi.fn(),
    }

    const sending = sendDailyDigestWithGmailSmtp(message, {
      signal: new AbortController().signal,
    }, {
      createSocket: () => socket,
      createTransport: () => transport,
    })

    await expect(sending).rejects.toMatchObject({
      outcome: 'definite_failure',
      message: 'Gmail SMTP delivery failed.',
    } satisfies Partial<GmailSmtpDeliveryError>)
    expect(JSON.stringify(await sending.catch((error) => error))).not.toContain('authentication failed')
    expect(socket.destroy).toHaveBeenCalledOnce()
    expect(transport.close).toHaveBeenCalledOnce()
  })

  it('keeps an unexpected connection close ambiguous because DATA may have been accepted', async () => {
    const socket = { destroyed: false, destroy: vi.fn(function destroy() { socket.destroyed = true }) }
    const connectionError = Object.assign(new Error('connection closed unexpectedly'), {
      code: 'ECONNECTION',
      command: 'CONN',
    })
    const transport = {
      sendMail: vi.fn(async () => { throw connectionError }),
      close: vi.fn(),
    }

    const sending = sendDailyDigestWithGmailSmtp(message, {
      signal: new AbortController().signal,
    }, {
      createSocket: () => socket,
      createTransport: () => transport,
    })

    await expect(sending).rejects.toMatchObject({
      outcome: 'ambiguous',
      message: 'Gmail SMTP delivery failed.',
    } satisfies Partial<GmailSmtpDeliveryError>)
    expect(socket.destroy).toHaveBeenCalledOnce()
    expect(transport.close).toHaveBeenCalledOnce()
  })
})
