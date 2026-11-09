import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'

import {
  computeVisionPromptFingerprint,
  computeVisionSourceAssetFingerprint,
  findPendingVisionCreativeInputs,
} from '@/lib/creative/vision-analyzer'

const ACCOUNT = '00000000-0000-4000-8000-000000000951'

function creative(index: number) {
  return {
    id: `00000000-0000-4000-8001-${String(index).padStart(12, '0')}`,
    ad_account_id: ACCOUNT,
    creative_id: String(1000000000000000 + index),
    thumbnail_url: `https://scontent.xx.fbcdn.net/${index}.jpg`,
    image_url: null,
    image_hash: `image-${index}`,
    video_id: null,
    body: 'Studio rental',
    title: `Creative ${index}`,
    asset_type: 'IMAGE',
    child_attachments: null,
    object_story_spec: null,
    asset_feed_spec: null,
  }
}

function fakeDb() {
  const creatives = Array.from({ length: 101 }, (_, index) => creative(index + 1))
  const versions = creatives.slice(0, 100).map((row, index) => {
    const input = { ...row, object_type: row.asset_type }
    return {
      id: `00000000-0000-4000-8002-${String(index + 1).padStart(12, '0')}`,
      ad_account_id: ACCOUNT,
      creative_id: row.id,
      analysis_schema_version: 2,
      prompt_version: 'creative-attributes-v2',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      source_asset_fingerprint: computeVisionSourceAssetFingerprint(input),
      prompt_fingerprint: computeVisionPromptFingerprint(input),
      analyzed_at: '2026-08-12T12:00:00.000Z',
    }
  })
  const ranges: Array<{ table: string; start: number; end: number }> = []
  const from = vi.fn((table: string) => {
    let rows = [...(table === 'creatives' ? creatives : versions)]
    let range: [number, number] | null = null
    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn((column: string, value: unknown) => {
      rows = rows.filter((row) => (row as Record<string, unknown>)[column] === value)
      return chain
    })
    chain.in = vi.fn((column: string, values: unknown[]) => {
      rows = rows.filter((row) => values.includes((row as Record<string, unknown>)[column]))
      return chain
    })
    chain.or = vi.fn(() => chain)
    chain.order = vi.fn(() => chain)
    chain.range = vi.fn((start: number, end: number) => {
      range = [start, end]
      ranges.push({ table, start, end })
      return chain
    })
    chain.then = (resolve: (value: unknown) => unknown) => {
      const page = range ? rows.slice(range[0], range[1] + 1) : rows
      return Promise.resolve({ data: page, error: null }).then(resolve)
    }
    return chain
  })
  return { db: { from } as unknown as SupabaseClient, ranges }
}

describe('versioned vision backfill discovery', () => {
  it('paginates deterministically beyond a fully-versioned first candidate page', async () => {
    const { db, ranges } = fakeDb()

    const pending = await findPendingVisionCreativeInputs(db, ACCOUNT, 1, { provider: 'anthropic', model: 'claude-sonnet-4-6' })

    expect(pending).toHaveLength(1)
    expect(pending[0].creative_id).toBe(String(1000000000000101))
    expect(ranges.filter(({ table }) => table === 'creatives')).toEqual([
      { table: 'creatives', start: 0, end: 99 },
      { table: 'creatives', start: 100, end: 199 },
    ])
  })
})
