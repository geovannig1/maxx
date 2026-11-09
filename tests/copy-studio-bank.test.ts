import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { DEMO_ACCOUNT_ID, createSampleDb } from '../scripts/demo/sample-db'
import { handleRest } from '../scripts/demo/rest'
import { DEMO_COPY_SAMPLES, DEMO_COPY_SAMPLE_MODEL } from '../scripts/demo/sample/demo-copy'
import { COPY_STUDIO_MODEL, COPY_STUDIO_SAMPLE_MODEL, bankNotes, groupBankRows } from '@/lib/creative/copy-studio'
import { verifiedFacts } from '@/lib/creative/copy-context'
import { scoreCopyVariant } from '@/lib/creative/copy-scorer'
import { EXAMPLE_BUSINESS_PROFILE } from '@/config/business-profile'

// The copy bank reuses copy_variations: one row per field, read back by created_at + angle. The demo
// ships hand-written samples in that shape; this reads them through the same REST subset the demo app
// uses, with the same filters the Copy studio sends, and checks they regroup into whole variants.

const score = (facts = verifiedFacts(EXAMPLE_BUSINESS_PROFILE)) => (v: Parameters<typeof scoreCopyVariant>[0]) => scoreCopyVariant(v, { facts })

describe('copy bank rows', () => {
  it('regroup fields saved together into one variant, parsing goal and audience from the notes', () => {
    const notes = bankNotes({ goal: 'bookings', temperature: 'warm' }, 88)
    const at = '2026-11-01T10:00:00Z'
    const rows = ['hook', 'primary_text', 'headline', 'cta'].map((copy_type) => ({
      copy_type, copy_text: copy_type === 'cta' ? 'BOOK_NOW' : `${copy_type} text`, angle: 'offer', performance_notes: notes, model_used: COPY_STUDIO_MODEL, created_at: at,
    }))
    const other = { ...rows[2], created_at: '2026-11-02T10:00:00Z', copy_text: 'Another headline' }
    const grouped = groupBankRows([...rows, other], (v) => score()(v))
    expect(grouped).toHaveLength(2)
    expect(grouped[0]).toMatchObject({ angle: 'offer', goal: 'bookings', temperature: 'warm', sample: false, hook: 'hook text', headline: 'headline text', cta: 'BOOK_NOW', description: null })
    expect(grouped[1]).toMatchObject({ headline: 'Another headline', hook: null })
  })

  it('ignores a note value outside the allowed lists', () => {
    const grouped = groupBankRows([{ copy_type: 'headline', copy_text: 'x', angle: null, performance_notes: 'Audience: everyone. Goal: world_domination.', model_used: COPY_STUDIO_MODEL, created_at: 'a' }], (v) => score()(v))
    expect(grouped[0]).toMatchObject({ goal: null, temperature: null })
  })
})

describe('demo copy samples', () => {
  let db: PGlite
  beforeAll(async () => { db = await createSampleDb() })
  afterAll(async () => { await db.close() })

  it('use the sample marker the console labels', () => {
    expect(DEMO_COPY_SAMPLE_MODEL).toBe(COPY_STUDIO_SAMPLE_MODEL)
  })

  it('are publishable under the demo profile (no unverified claims, valid CTAs, distinct angles)', () => {
    for (const sample of DEMO_COPY_SAMPLES) {
      const s = scoreCopyVariant(sample, { facts: verifiedFacts(EXAMPLE_BUSINESS_PROFILE), goal: sample.goal })
      expect(s.publishable, `${sample.angle}: ${s.findings.map((f) => f.message).join(' | ')}`).toBe(true)
    }
    expect(new Set(DEMO_COPY_SAMPLES.map((s) => s.angle)).size).toBe(DEMO_COPY_SAMPLES.length)
  })

  it('are seeded in the demo database and read back as whole variants with the studio filters', async () => {
    const url = `http://demo/rest/v1/copy_variations?select=copy_type,copy_text,angle,performance_notes,model_used,created_at`
      + `&ad_account_id=eq.${DEMO_ACCOUNT_ID}&model_used=in.(${COPY_STUDIO_MODEL},${COPY_STUDIO_SAMPLE_MODEL})&order=created_at.desc&limit=200`
    const res = await handleRest(db, new Request(url))
    expect(res.headers.get('x-demo-unsupported')).toBeNull()
    const rows = await res.json()
    expect(rows).toHaveLength(DEMO_COPY_SAMPLES.length * 5)
    const grouped = groupBankRows(rows, (v) => score()(v))
    expect(grouped).toHaveLength(DEMO_COPY_SAMPLES.length)
    expect(grouped.every((v) => v.sample && v.hook && v.primary_text && v.headline && v.cta)).toBe(true)
    expect(new Set(grouped.map((v) => v.headline))).toEqual(new Set(DEMO_COPY_SAMPLES.map((s) => s.headline)))
  })
})
