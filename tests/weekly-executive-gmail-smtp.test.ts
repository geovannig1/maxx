import { describe, expect, it, vi } from 'vitest'

import { sendWeeklyExecutiveWithGmailSmtp } from '@/lib/report/weekly-executive-gmail-smtp'
import { WEEKLY_REPORT_ID, WEEK_END, WEEK_START } from './fixtures/weekly-executive'

const message = {
  host: 'smtp.gmail.com' as const,
  port: 465 as const,
  secure: true as const,
  auth: { user: 'customer-fixture@gmail.com', pass: 'abcdefghijklmnop' },
  from: 'customer-fixture@gmail.com',
  to: 'customer-fixture@gmail.com',
  subject: `Maxx weekly executive read — ${WEEK_START}–${WEEK_END}`,
  text: '# Weekly executive read',
  html: '<!DOCTYPE html><html><body>Weekly executive read</body></html>',
  reportId: WEEKLY_REPORT_ID,
  messageId: `<maxx-weekly-executive-${WEEKLY_REPORT_ID}@gmail.com>`,
}

describe('weekly executive Gmail SMTP envelope', () => {
  it('keeps text and HTML in parity and identifies the committed weekly report', async () => {
    const socket = { destroyed: false, destroy: vi.fn(function destroy() { socket.destroyed = true }) }
    const transport = {
      sendMail: vi.fn(async () => ({ messageId: '<sender-fixture@gmail.com>' })),
      close: vi.fn(),
    }

    await sendWeeklyExecutiveWithGmailSmtp(message, {
      signal: new AbortController().signal,
    }, { createSocket: () => socket, createTransport: () => transport })

    expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      text: message.text,
      html: message.html,
      messageId: message.messageId,
      headers: { 'X-Weekly-Executive-Report-Id': WEEKLY_REPORT_ID },
    }))
    expect(transport.close).toHaveBeenCalledOnce()
    expect(socket.destroy).toHaveBeenCalledOnce()
  })
})
