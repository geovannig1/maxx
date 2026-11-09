import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({
  verifySignature: vi.fn(),
  parseBody: vi.fn(),
}))

vi.mock('@/lib/outcomes/adapters/acuity/webhook', () => ({
  verifyAcuitySignature: state.verifySignature,
  parseWebhookBody: state.parseBody,
  isAppointmentAction: vi.fn(() => true),
}))

function declaredOversizeRequest(): NextRequest {
  return new NextRequest('https://maxx.example/api/webhooks/acuity', {
    method: 'POST',
    headers: {
      'content-length': '65537',
      'x-acuity-signature': 'unsigned',
    },
    body: 'action=appointment.scheduled&id=777000103',
  })
}

function streamedOversizeRequest(): { request: NextRequest; wasCancelled: () => boolean } {
  let pulls = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1
      if (pulls === 1) controller.enqueue(new Uint8Array(65 * 1024))
      else controller.close()
    },
    cancel() { cancelled = true },
  }, { highWaterMark: 0 })
  const request = new Request('https://maxx.example/api/webhooks/acuity', {
    method: 'POST',
    headers: { 'x-acuity-signature': 'unsigned' },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
  return { request: new NextRequest(request), wasCancelled: () => cancelled }
}

describe('public Acuity webhook body limits', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env.ACUITY_USER_ID = 'owner'
    process.env.ACUITY_API_KEY = 'acuity-secret'
    state.verifySignature.mockReset()
    state.parseBody.mockReset()
  })

  it('rejects an oversized unsigned Content-Length before signature verification or parsing', async () => {
    const { POST } = await import('@/app/api/webhooks/acuity/route')
    const response = await POST(declaredOversizeRequest())

    expect(response.status).toBe(413)
    expect(state.verifySignature).not.toHaveBeenCalled()
    expect(state.parseBody).not.toHaveBeenCalled()
  })

  it('rejects an oversized unsigned chunked body before signature verification or parsing', async () => {
    const { POST } = await import('@/app/api/webhooks/acuity/route')
    const streamed = streamedOversizeRequest()
    expect(streamed.request.headers.has('content-length')).toBe(false)
    const response = await POST(streamed.request)

    expect(response.status).toBe(413)
    expect(streamed.wasCancelled()).toBe(true)
    expect(state.verifySignature).not.toHaveBeenCalled()
    expect(state.parseBody).not.toHaveBeenCalled()
  })
})
