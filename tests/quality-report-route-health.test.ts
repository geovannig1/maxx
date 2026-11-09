import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({
  buildError: null as Error | null,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'owner', email: 'owner@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' } } }),
    },
  })),
}))

vi.mock('@/lib/diagnostics/quality-report', () => {
  class QualityReportUnavailableError extends Error {
    readonly code = 'QUALITY_REPORT_UNAVAILABLE'
    constructor(readonly reason: string) {
      super(`QUALITY_REPORT_UNAVAILABLE: ${reason}`)
      this.name = 'QualityReportUnavailableError'
    }
  }
  return {
    QualityReportUnavailableError,
    buildQualityReport: vi.fn(async () => {
      if (state.buildError) throw state.buildError
      return { available: true, ads: [], adsets: [] }
    }),
  }
})

describe('quality diagnostics route read health', () => {
  beforeEach(() => {
    // the owner gate fails closed without OWNER_EMAIL, in development too.
    vi.stubEnv('OWNER_EMAIL', 'owner@example.com')
    state.buildError = null
  })

  it('returns structured unavailable rather than a healthy-looking empty report', async () => {
    const { QualityReportUnavailableError } = await import('@/lib/diagnostics/quality-report')
    state.buildError = new QualityReportUnavailableError('ads_read_failed')
    const { GET } = await import('@/app/api/diagnostics/quality/route')

    const response = await GET(new NextRequest('http://localhost/api/diagnostics/quality?from=2026-07-01&to=2026-07-07'))

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      available: false,
      code: 'QUALITY_REPORT_UNAVAILABLE',
      reason: 'ads_read_failed',
    })
  })
})
