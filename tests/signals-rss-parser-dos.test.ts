import { describe, expect, it } from 'vitest'
import { MAX_FEED_BYTES, MAX_ITEMS_PER_FEED, parseRssItems } from '@/lib/signals/fetcher'

// Re-audit: the old `/<item>([\s\S]*?)<\/item>/g` rescanned the rest of the body from every
// unterminated `<item>`, so a 120 KB hostile feed took ~5 s. The parser must stay linear and bounded.

const elapsed = (fn: () => unknown) => { const t = performance.now(); fn(); return performance.now() - t }

describe('RSS parser on hostile bodies', () => {
  it('parses ~2 MB of unterminated <item>/<entry>/<title> openings quickly', () => {
    const hostile = [
      '<item>'.repeat(350_000),
      `<item>${'<title>'.repeat(300_000)}`,
      `<entry>${'<link '.repeat(300_000)}`,
      `<item><title>t</title><link>${'<'.repeat(2_000_000)}`,
    ]
    for (const body of hostile) {
      expect(body.length).toBeGreaterThan(1_500_000)
      expect(elapsed(() => expect(parseRssItems(body)).toEqual([]))).toBeLessThan(500)
    }
  })

  it('caps items per feed and skips oversized items', () => {
    const item = (n: number) => `<item><title>T${n}</title><link>https://example.test/${n}</link></item>`
    const many = Array.from({ length: 500 }, (_, n) => item(n)).join('')
    expect(parseRssItems(many)).toHaveLength(MAX_ITEMS_PER_FEED)
    const oversized = `<item><title>${'x'.repeat(20_000)}</title><link>https://example.test/big</link></item>${item(1)}`
    expect(parseRssItems(oversized).map((i) => i.title)).toEqual(['T1'])
  })

  it('still reads RSS (plain and CDATA) and Atom items (control)', () => {
    expect(parseRssItems('<rss><item><title><![CDATA[ Hello ]]></title><link>https://a.test/1</link><pubDate>Thu, 09 Jul 2026 11:30:31 +0000</pubDate></item></rss>'))
      .toEqual([{ title: 'Hello', link: 'https://a.test/1', pubDate: 'Thu, 09 Jul 2026 11:30:31 +0000' }])
    expect(parseRssItems('<feed><entry><title type="html">Atom</title><link rel="alternate" href="https://a.test/2"/><updated>2026-07-09T00:00:00Z</updated></entry></feed>'))
      .toEqual([{ title: 'Atom', link: 'https://a.test/2', pubDate: '2026-07-09T00:00:00Z' }])
  })

  it('buffers at most 256 KB of one feed', () => {
    expect(MAX_FEED_BYTES).toBe(256 * 1024)
  })
})
