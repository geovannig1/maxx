import { describe, expect, it } from 'vitest'
import { planPreview, planPreviewLines } from '@/lib/campaigns/plan-preview'
import { creativeBody, promotedObject } from '@/lib/platforms/meta/campaign-payloads'
import { campaignPlanSpecSchema, type CampaignPlanSpec } from '@/lib/campaigns/plan-spec'
import { validSpec } from './_support/campaign-plan-fixtures'

// Security review L7: the owner approves exactly what is sent. Every value a plan puts into the Meta
// creative and the conversion target (copy, link, url_tags, media, thumbnail, pixel, event) is in the
// approval preview, read from the same payload builders the creation uses.

const money = (minor: number) => `$${(minor / 100).toFixed(2)}`

function leaves(value: unknown, skip: (key: string) => boolean, key = ''): string[] {
  if (typeof value === 'string') {
    if (skip(key)) return []
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed && typeof parsed === 'object') return leaves(parsed, skip, key)
    } catch { /* plain text */ }
    return [value]
  }
  if (Array.isArray(value)) return value.flatMap((v) => leaves(v, skip, key))
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => leaves(v, skip, k))
  return []
}

function videoSpec(): CampaignPlanSpec {
  const base = validSpec()
  const ads = base.ad_sets[0].ads.map((ad, i) => (i === 1
    ? { ...ad, creative: { mode: 'video', video_id: '888', thumbnail_url: 'https://cdn.example/thumb888.jpg' }, copy: { ...ad.copy!, description: 'Weekend slots open' } }
    : ad))
  return campaignPlanSpecSchema.parse({ ...base, ad_sets: [{ ...base.ad_sets[0], ads }] })
}

describe('plan approval preview shows every field sent to Meta (security review L7)', () => {
  const spec = videoSpec()
  const text = planPreview(spec, money, { projectedAccountMinor: 9000, ceilingMinor: 20000, stepOverride: false })

  it('includes every creative value and the url_tags of each new ad', () => {
    const skip = (key: string) => ['page_id', 'name'].includes(key)
    for (const ad of spec.ad_sets[0].ads) {
      const body = creativeBody(ad, '555', 'mxffffffffffff-x')!
      const values = leaves(body, skip)
      expect(values.length).toBeGreaterThan(4)
      for (const value of values) expect(text, `${ad.key}: ${value}`).toContain(value)
    }
  })

  it('includes the pixel and the event a conversion ad set optimises for', () => {
    for (const value of leaves(promotedObject(spec), (key) => key === 'custom_event_type')) expect(text).toContain(value)
    expect(text).toContain('Purchase')
  })

  it('keeps one header line per ad, with its detail lines indented under it', () => {
    const lines = planPreviewLines(spec, money)
    const header = lines.findIndex((l) => l.startsWith('    Ad "Ad 2"'))
    expect(header).toBeGreaterThan(0)
    expect(lines[header + 1]).toMatch(/^ {6}\S/)
    expect(lines.filter((l) => /^ {4}Ad "/.test(l))).toHaveLength(3)
  })
})
