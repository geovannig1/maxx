import { describe, it, expect } from 'vitest'
import { parseRssItems, isFreshItem, MAX_ITEM_AGE_DAYS, MAX_ITEMS_PER_SOURCE } from '@/lib/signals/fetcher'

// Signals-hygiene guards (owner-approved cleanup 2026-07-10). The Google-backlog flood happened because
// stale items reached the LLM judge and silent fetch failures were invisible — these are the code-level
// guards (the judging-prompt tightening is LLM-side).

describe('isFreshItem (date guard — no LLM spend on stale backlog)', () => {
  const NOW = new Date('2026-07-10T00:00:00Z').getTime()

  it('passes recent items and blocks verifiably old ones', () => {
    expect(isFreshItem('Thu, 09 Jul 2026 11:30:31 +0000', MAX_ITEM_AGE_DAYS, NOW)).toBe(true)
    expect(isFreshItem('2026-01-15T08:00:00-07:00', MAX_ITEM_AGE_DAYS, NOW)).toBe(true)
    // The exact failure mode that flooded the queue: COVID-era Google posts.
    expect(isFreshItem('Tue, 14 Apr 2020 09:00:00 +0000', MAX_ITEM_AGE_DAYS, NOW)).toBe(false)
    expect(isFreshItem('Sat, 16 Jan 2021 16:48:07 GMT', MAX_ITEM_AGE_DAYS, NOW)).toBe(false)
  })

  it('unknown/unparseable dates pass through (never drop content just for a missing date)', () => {
    expect(isFreshItem(null, MAX_ITEM_AGE_DAYS, NOW)).toBe(true)
    expect(isFreshItem('not a date', MAX_ITEM_AGE_DAYS, NOW)).toBe(true)
  })

  it('boundary: exactly at the max age passes; a day past fails', () => {
    const at = new Date(NOW - MAX_ITEM_AGE_DAYS * 86_400_000).toUTCString()
    const past = new Date(NOW - (MAX_ITEM_AGE_DAYS + 1) * 86_400_000).toUTCString()
    expect(isFreshItem(at, MAX_ITEM_AGE_DAYS, NOW)).toBe(true)
    expect(isFreshItem(past, MAX_ITEM_AGE_DAYS, NOW)).toBe(false)
  })
})

describe('parseRssItems (both formats the live sources use)', () => {
  it('parses WordPress-style RSS <item> with CDATA titles (Loomer/Perpetual Traffic shape)', () => {
    const xml = `<rss><channel>
      <item><title><![CDATA[Lead Capture AI Agent for Instant Forms]]></title><link>https://ex.com/a</link><pubDate>Thu, 09 Jul 2026 11:30:31 +0000</pubDate></item>
      <item><title>Plain title post</title><link>https://ex.com/b</link><pubDate>Mon, 06 Jul 2026 22:58:33 +0000</pubDate></item>
    </channel></rss>`
    const items = parseRssItems(xml)
    expect(items).toHaveLength(2)
    expect(items[0].title).toBe('Lead Capture AI Agent for Instant Forms')
    expect(items[0].pubDate).toContain('2026')
  })

  it('parses Atom <entry> with href links (CTC Shopify shape)', () => {
    const xml = `<feed>
      <entry><title>Google Ads AI Transparency Labels Are Live</title><link href="https://ex.com/atom-a"/><published>2026-07-10T08:07:37-07:00</published></entry>
    </feed>`
    const items = parseRssItems(xml)
    expect(items).toHaveLength(1)
    expect(items[0].link).toBe('https://ex.com/atom-a')
    expect(items[0].pubDate).toBe('2026-07-10T08:07:37-07:00')
  })

  it('returns [] on junk without throwing', () => {
    expect(parseRssItems('<html>not a feed</html>')).toEqual([])
  })
})

describe('per-source cap sanity', () => {
  it('the cap is small enough that one busy feed cannot dominate a run', () => {
    expect(MAX_ITEMS_PER_SOURCE).toBeLessThanOrEqual(10)
    expect(MAX_ITEMS_PER_SOURCE).toBeGreaterThanOrEqual(3)
  })
})
