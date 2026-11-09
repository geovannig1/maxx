import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { ACUITY_SOURCE_ID, OUTCOME_ID } = vi.hoisted(() => ({
  ACUITY_SOURCE_ID: '00000000-0000-4000-8000-000000000743',
  OUTCOME_ID: '00000000-0000-4000-8000-000000000744',
}))

const state = vi.hoisted(() => ({
  getAppointment: vi.fn(),
  upsert: vi.fn(),
  link: vi.fn(),
  send: vi.fn(),
  evaluate: vi.fn(),
  recordInput: vi.fn(),
  row: { id: OUTCOME_ID, conversion_sent_at: null, fbp: null } as {
    id: string; conversion_sent_at: string | null; fbp: string | null
  },
}))

const readChain: { eq: ReturnType<typeof vi.fn>; maybeSingle: ReturnType<typeof vi.fn> } = {
  eq: vi.fn(),
  maybeSingle: vi.fn(async () => ({ data: state.row, error: null })),
}
readChain.eq.mockImplementation(() => readChain)
const db = {
  from: vi.fn(() => ({
    select: vi.fn(() => readChain),
    update: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
  })),
}

vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => db }))
vi.mock('@/lib/outcomes/adapters/acuity/client', () => ({ getAppointment: state.getAppointment }))
vi.mock('@/lib/outcomes/adapters/acuity/ledger', () => ({
  toLedgerRow: vi.fn((appointment: unknown) => appointment),
  upsertAppointments: state.upsert,
  resolveAdAccountId: vi.fn(async () => '00000000-0000-4000-8000-000000000741'),
}))
vi.mock('@/lib/outcomes/adapters/acuity/webhook', () => ({
  verifyAcuitySignature: vi.fn(() => true),
  parseWebhookBody: vi.fn(() => ({ action: 'appointment.scheduled', id: '777000103' })),
  isAppointmentAction: vi.fn(() => true),
}))
vi.mock('@/lib/outcomes/adapters/acuity/paid-touch-link', () => ({
  paidTouchLinkConfig: vi.fn(() => ({ fieldId: 42, tokenSecret: 'secret' })),
  linkAcuityPaidTouchWithFallback: state.link,
}))
vi.mock('@/lib/capi/acuity-capi', () => ({ sendAcuityCapiEvent: state.send }))
vi.mock('@/lib/outcomes/adapters/acuity/outcome-source', () => ({ findAcuitySourceId: vi.fn(async () => ACUITY_SOURCE_ID) }))
vi.mock('@/lib/outcomes/adapters/acuity/paid-link-evaluation', () => ({
  recordSignedAcuityEligibilityInput: state.recordInput,
  recordSignedAcuityLinkEvaluation: state.evaluate,
}))

function request(): NextRequest {
  return new NextRequest('https://maxx.example/api/webhooks/acuity', {
    method: 'POST',
    headers: { 'x-acuity-signature': 'valid' },
    body: 'action=appointment.scheduled&id=777000103',
  })
}

describe('signed Acuity webhook paid-touch seam', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env.ACUITY_USER_ID = 'owner'
    process.env.ACUITY_API_KEY = 'acuity-secret'
    state.row = { id: OUTCOME_ID, conversion_sent_at: null, fbp: null }
    state.getAppointment.mockReset()
    state.getAppointment.mockResolvedValue({
      id: 777000103, scheduledBy: null, datetimeCreated: '2026-09-14T14:05:10-0500',
      canceled: false, forms: [],
    })
    state.upsert.mockReset()
    state.upsert.mockResolvedValue(1)
    state.link.mockReset()
    state.link.mockResolvedValue({
      status: 'linked',
      paidTouch: { fbclid: 'IwZXh0bgNhZW0CMTAAAR1', observedAt: '2026-07-30T18:30:00.000Z' },
    })
    state.send.mockReset()
    state.send.mockResolvedValue({ mode: 'live', status: 'sent', eventId: 'acuity-777000103' })
    state.evaluate.mockReset()
    state.evaluate.mockResolvedValue(undefined)
    state.recordInput.mockReset()
    state.recordInput.mockResolvedValue({
      inputId: '00000000-0000-4000-8000-000000000742',
      outcomeId: OUTCOME_ID,
      appointmentId: 777000103,
      appointmentCreatedAt: '2026-09-14T14:05:10-0500',
      paidEvidencePresent: true,
      tokenId: null,
      amountPaid: null,
      canceled: false,
    })
  })

  it('links only after the ledger is durable and supplies the linked touch to the sole sender', async () => {
    const { POST } = await import('@/app/api/webhooks/acuity/route')
    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(state.upsert.mock.invocationCallOrder[0]).toBeLessThan(state.link.mock.invocationCallOrder[0])
    expect(state.recordInput.mock.invocationCallOrder[0]).toBeLessThan(state.link.mock.invocationCallOrder[0])
    expect(state.recordInput).toHaveBeenCalledWith(
      db,
      '00000000-0000-4000-8000-000000000741',
      expect.objectContaining({
        id: 777000103,
        datetimeCreated: '2026-09-14T14:05:10-0500',
      }),
      { fieldId: 42, tokenSecret: 'secret' },
    )
    expect(state.link).toHaveBeenCalledWith(
      db,
      '00000000-0000-4000-8000-000000000741',
      expect.objectContaining({ id: 777000103 }),
      { fieldId: 42, tokenSecret: 'secret' },
    )
    expect(state.evaluate).toHaveBeenCalledWith(
      db,
      '00000000-0000-4000-8000-000000000741',
      expect.objectContaining({ id: 777000103 }),
      expect.objectContaining({ status: 'linked' }),
      { fieldId: 42, tokenSecret: 'secret' },
      expect.objectContaining({ inputId: '00000000-0000-4000-8000-000000000742' }),
    )
    expect(state.send).toHaveBeenCalledWith(
      expect.objectContaining({ id: 777000103 }),
      null,
      db,
      { fbclid: 'IwZXh0bgNhZW0CMTAAAR1', observedAt: '2026-07-30T18:30:00.000Z' },
    )
  })

  it('never converts a rejected token into attribution; the legitimate booking still sends without fbc', async () => {
    state.link.mockResolvedValue({ status: 'rejected', reason: 'invalid_token' })
    const { POST } = await import('@/app/api/webhooks/acuity/route')
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(state.send).toHaveBeenCalledWith(
      expect.objectContaining({ id: 777000103 }), null, db, null,
    )
  })

  it('keeps linking and immediate CAPI independent when eligibility persistence fails, then returns 502 for retry', async () => {
    state.recordInput.mockRejectedValueOnce(new Error('invalid appointment identity'))
    const { POST } = await import('@/app/api/webhooks/acuity/route')
    const response = await POST(request())

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({ error: 'Paid eligibility input write failed' })
    expect(state.upsert).toHaveBeenCalledOnce()
    expect(state.link).toHaveBeenCalledOnce()
    expect(state.upsert.mock.invocationCallOrder[0]).toBeLessThan(state.link.mock.invocationCallOrder[0])
    expect(state.evaluate).not.toHaveBeenCalled()
    expect(state.send).toHaveBeenCalledOnce()
  })

  it('still sends immediate CAPI when link-evaluation persistence fails, then returns 502 for retry', async () => {
    state.evaluate.mockRejectedValueOnce(new Error('evaluation write failed'))
    const { POST } = await import('@/app/api/webhooks/acuity/route')
    const response = await POST(request())

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({ error: 'Paid-link evaluation write failed' })
    expect(state.link).toHaveBeenCalledOnce()
    expect(state.evaluate).toHaveBeenCalledOnce()
    expect(state.send).toHaveBeenCalledOnce()
  })

  it('does not resend CAPI when an Acuity retry finds a prior accepted delivery', async () => {
    state.row = { id: OUTCOME_ID, conversion_sent_at: '2026-09-14T19:05:14.000Z', fbp: null }
    const { POST } = await import('@/app/api/webhooks/acuity/route')
    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ capi: 'already-delivered' })
    expect(db.from).toHaveBeenCalledWith('outcomes')
    expect(readChain.eq).toHaveBeenCalledWith('source_id', ACUITY_SOURCE_ID)
    expect(readChain.eq).toHaveBeenCalledWith('external_id', '777000103')
    expect(state.link).toHaveBeenCalledOnce()
    expect(state.evaluate).toHaveBeenCalledOnce()
    expect(state.send).not.toHaveBeenCalled()
  })

  it('uses fbclid fallback when the intake token is absent and paid-social attribution is present', async () => {
    state.link.mockResolvedValue({
      status: 'linked',
      paidTouch: { fbclid: 'fallback-fbclid', observedAt: '2026-07-30T18:30:00.000Z' },
    })
    const { POST } = await import('@/app/api/webhooks/acuity/route')
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(state.send).toHaveBeenCalledWith(
      expect.objectContaining({ id: 777000103 }),
      null,
      db,
      { fbclid: 'fallback-fbclid', observedAt: '2026-07-30T18:30:00.000Z' },
    )
  })
})
