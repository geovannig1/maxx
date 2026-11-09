import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { prepareSavedDb } from './reporting-saved-fixture'
import { claim, claimedJob, finish, jobSnapshot, scopeFixture } from './reporting-refresh-fixture'
import { canonicalReportingJson } from '@/lib/reporting/snapshot-contract'

const scope = (breakdown: 'placement' | 'age' | 'gender' | 'region') => ({
  ...scopeFixture(), detailIds: [],
  historyEntity: { level: 'campaign', id: 'campaign-1', breakdown },
})

describe('selected-parent breakdown scope', () => {
  let db: PGlite
  beforeAll(async () => { db = await prepareSavedDb() })
  beforeEach(async () => { await db.exec('BEGIN') })
  afterEach(async () => { await db.exec('ROLLBACK') })
  afterAll(async () => { await db?.close() })

  it.each(['placement', 'age', 'gender', 'region'] as const)('accepts and preserves the canonical %s scope', async breakdown => {
    const selected = scope(breakdown)
    const result = await claim(db, selected)
    expect(result.claimed).toBe(true)
    expect(result.job?.scope_canonical).toBe(canonicalReportingJson(selected))
  })

  it('keeps every dimension and the legacy parent scope in separate refresh identities', async () => {
    const legacy = { ...scopeFixture(), detailIds: [], historyEntity: { level: 'campaign', id: 'campaign-1' } }
    const values = [legacy, ...(['placement', 'age', 'gender', 'region'] as const).map(scope)]
    const jobs = await Promise.all(values.map(value => claimedJob(db, value)))
    expect(new Set(jobs.map(job => job.scope_key)).size).toBe(values.length)
    expect(jobs[0].scope_canonical).not.toContain('breakdown')
  })

  it.each(['device', '', null, 1])('rejects unsupported breakdown %j', async breakdown => {
    await expect(claim(db, { ...scope('placement'), historyEntity: { level: 'campaign', id: 'campaign-1', breakdown } }))
      .rejects.toMatchObject({ code: '23514' })
  })

  it.each(['extra', 'mixed', 'non_meta'] as const)('rejects invalid breakdown scope boundary: %s', async problem => {
    const selected = scope('placement')
    const value = problem === 'extra' ? { ...selected, historyEntity: { ...selected.historyEntity, extra: true } }
      : problem === 'mixed' ? { ...selected, detailIds: ['ad-1'] } : { ...selected, source: 'business' }
    await expect(claim(db, value)).rejects.toMatchObject({ code: '23514' })
  })

  it('commits a snapshot only against the exact selected-parent breakdown scope', async () => {
    const job = await claimedJob(db, scope('region'))
    expect(await finish(db, job)).toEqual({ committed: true, snapshot_id: expect.any(String) })
    const wrong = await claimedJob(db, scope('gender'))
    const snapshot = { ...jobSnapshot(wrong), scope: scope('region') }
    await expect(finish(db, wrong, snapshot)).rejects.toMatchObject({ code: '23514' })
  })
})
