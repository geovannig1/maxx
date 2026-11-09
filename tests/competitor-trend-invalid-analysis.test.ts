import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// An ad whose model output failed validation is stored with an `invalid_model_output` marker so it
// is not retried. That marker is not an analysis: it must not be counted as a format.
function adminWith(ads: unknown[]) {
  return {
    getAdminClient: () => ({
      from(table: string) {
        const rows = table === 'competitor_sources' ? [{ id: 'source-1', name: 'Rival' }] : ads
        const chain: Record<string, unknown> = {
          select: () => chain, in: () => chain, not: () => chain, eq: () => chain,
          then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
        }
        return chain
      },
    }),
  }
}

const recent = new Date().toISOString()
const ad = (id: string, ai_analysis: unknown) => ({
  id, competitor_id: 'source-1', ad_creative_bodies: ['Body'], ai_analysis,
  ad_delivery_start_time: recent, created_at: recent,
})

describe('detectFormatTrends', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => { vi.restoreAllMocks(); vi.doUnmock('@/lib/supabase/admin') })

  it('ignores ads whose analysis is the invalid-output marker', async () => {
    vi.doMock('@/lib/supabase/admin', () => adminWith([
      ad('a', { format_guess: 'reel' }),
      ad('b', { analysis_status: 'invalid_model_output', failed_at: recent }),
    ]))
    const { detectFormatTrends } = await import('@/lib/competitors/trend-detector')
    const formats = (await detectFormatTrends('account-1')).map((trend) => trend.format)
    expect(formats).not.toContain('unknown')
    // Control: the real analysis is still counted.
    expect(formats).toContain('reel')
  })
})
