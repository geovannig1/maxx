import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RecommendationReadNotice } from '@/components/dashboard/RecommendationsBlock'
import type { OpenRecommendationsReadResult } from '@/lib/recommendations/store'

function render(read: OpenRecommendationsReadResult): string {
  return renderToStaticMarkup(<RecommendationReadNotice read={read} />)
}

describe('RecommendationReadNotice', () => {
  it('renders nothing for a healthy read', () => {
    expect(render({
      health: 'healthy', recommendations: [], visibleCount: 0, quarantinedCount: 0, reasons: [], evidence: new Map(),
    })).toBe('')
  })

  it('renders degraded with visible and quarantined counts', () => {
    const html = render({
      health: 'degraded',
      recommendations: [],
      visibleCount: 1,
      quarantinedCount: 2,
      reasons: [{
        code: 'target_not_current',
        affectedCount: 2,
        message: '2 open recommendations were quarantined.',
      }],
      evidence: new Map(),
    })

    expect(html).toContain('Recommendation feed is incomplete')
    expect(html).toContain('1 visible')
    expect(html).toContain('2 quarantined')
    expect(html).toContain('2 open recommendations were quarantined.')
  })

  it('renders unavailable without presenting a zero-row claim', () => {
    const html = render({
      health: 'unavailable',
      recommendations: [],
      visibleCount: 0,
      quarantinedCount: null,
      reasons: [{
        code: 'recommendations_read_failed',
        affectedCount: null,
        message: 'The current recommendation snapshot could not be read.',
      }],
      evidence: new Map(),
    })

    expect(html).toContain('Recommendations unavailable')
    expect(html).toContain('cannot say whether Maxx has current recommendations')
    expect(html).not.toContain('0 quarantined')
  })
})
