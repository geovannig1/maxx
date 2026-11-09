import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { compareCreativeEvidenceInstants, createReportCreativeAssignmentResolver, resolveReportCreativeAssignment, validateReportCreativeAssignmentEvidence, type ReportCreativeAssignmentEvidence } from '@/lib/reporting/creative-assignment-contract'
import * as nativeAssignment from '@/lib/creative/assignment-stability'
import { readReportCreativeAssignmentEvidence } from '@/lib/reporting/creative-assignment-reader'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { snapshotContext as context, snapshotPacket } from './fixtures/reporting-snapshot'

const adId = '301', creativeId = '401'
function evidence(): ReportCreativeAssignmentEvidence {
  return { accountId: context.account.id, asOf: context.asOf, state: 'available', notes: [], observations: [
    { id: '00000000-0000-4000-8000-000000000001', metaAdId: adId, metaCreativeId: creativeId,
      observedAt: '2026-08-30T03:59:59.999Z', metaUpdatedTime: '2026-08-01T00:00:00Z' },
    { id: '00000000-0000-4000-8000-000000000002', metaAdId: adId, metaCreativeId: creativeId,
      observedAt: '2026-09-05T04:00:00Z', metaUpdatedTime: '2026-08-01T00:00:00Z' },
  ] }
}
function fakeDb(rows: Record<string, unknown>[], stalled = false, ignoreAbort = false) {
  const log: string[] = []
  let signal: AbortSignal | undefined
  const result = { data: rows, error: null }
  const query = {
    select: () => { log.push('select'); return query }, eq: () => query, in: () => query, order: () => query, range: () => query,
    abortSignal: (value: AbortSignal) => { signal = value; return query },
    then: (resolve: (value: typeof result) => void, reject: (error: unknown) => void) => {
      if (!stalled) return Promise.resolve(result).then(resolve, reject)
      return new Promise<typeof result>((_resolve, rejectRead) => { if (!ignoreAbort) signal?.addEventListener('abort', () => rejectRead(new Error('aborted'))) }).then(resolve, reject)
    },
  }
  return { db: { from: (name: string) => { log.push(name); return query } } as unknown as SupabaseClient, log, aborted: () => signal?.aborted }
}
const nativeRows = () => evidence().observations.map(row => ({ id: row.id, ad_account_id: context.account.id, meta_ad_id: row.metaAdId,
  meta_creative_id: row.metaCreativeId, observed_at: row.observedAt, meta_updated_time: row.metaUpdatedTime }))
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('reporting creative assignment contract', () => {
  it('delegates current and previous windows to the existing bracketing resolver', () => {
    for (const period of ['current', 'previous'] as const) expect(resolveReportCreativeAssignment(context, evidence(), adId, period))
      .toMatchObject({ state: 'observed_stable', metaCreativeId: creativeId })
    expect(resolveReportCreativeAssignment(context, undefined, adId, 'current')).toMatchObject({ state: 'blocked' })
    expect(resolveReportCreativeAssignment(context, { ...evidence(), observations: evidence().observations.slice(1) }, adId, 'current')).toMatchObject({ state: 'blocked', blockerCode: 'assignment_history_missing' })
  })
  it('does not accept changed assignments, unknown identities or changed update times', () => {
    for (const changed of [{ metaCreativeId: '402' }, { metaCreativeId: null }, { metaUpdatedTime: '2026-09-01T00:00:00Z' }]) {
      const current = evidence()
      const altered = { ...current, observations: [current.observations[0], { ...current.observations[1], ...changed }] }
      expect(resolveReportCreativeAssignment(context, altered, adId, 'current').state).toBe('blocked')
    }
  })
  it('rejects foreign accounts/ad rows, duplicate identities, and observations a nanosecond after as-of', () => {
    const current = evidence()
    const altered = [
      { ...current, accountId: 'foreign-account' },
      { ...current, observations: current.observations.map(row => ({ ...row, metaAdId: '999' })) },
      { ...current, observations: [current.observations[0], current.observations[0]] },
      { ...current, observations: [{ ...current.observations[0], observedAt: '2026-09-05T17:00:00.000000001Z' }] },
    ]
    expect(() => validateReportCreativeAssignmentEvidence(context, current, [adId])).not.toThrow()
    for (const bad of altered) expect(() => validateReportCreativeAssignmentEvidence(context, bad, [adId])).toThrow()
  })
  it('validates optional history against the report population while old packets stay valid', () => {
    const old = snapshotPacket()
    expect(() => validateReportingPacket(old)).not.toThrow()
    const entity = { id: adId, level: 'ad' as const, name: 'Synthetic', campaignId: null, campaignName: null, adsetId: null, adsetName: null,
      status: 'UNKNOWN', configurationAsOf: null, audience: 'unknown' as const, audienceLabel: 'Unknown', creative: null, metrics: {} }
    const packet = { ...old, result: { ...old.result, data: { ...old.result.data!, entities: [entity], creativeAssignmentEvidence: evidence() } } }
    expect(() => validateReportingPacket(packet)).not.toThrow()
    expect(() => validateReportingPacket({ ...packet, result: { ...packet.result, data: { ...packet.result.data, entities: [] } } })).toThrow()
  })
  it('retains precision across offset spellings and rejects impossible evidence cutoffs', () => {
    expect(compareCreativeEvidenceInstants('2026-09-05T17:00:00.000000001Z', '2026-09-05T13:00:00.000000000-04:00')).toBeGreaterThan(0)
    expect(compareCreativeEvidenceInstants('2026-09-05T17:00:00.000000001Z', '2026-09-05T13:00:00.000000001-04:00')).toBe(0)
    expect(() => compareCreativeEvidenceInstants('2026-09-05T17:00:00+99:00', context.asOf)).toThrow()
    const current = evidence()
    const duplicate = { ...current.observations[0], id: 'abcdefab-cdef-4abc-8abc-abcdefabcdef' }
    expect(() => validateReportCreativeAssignmentEvidence(context, { ...current,
      observations: [duplicate, { ...current.observations[1], id: duplicate.id.toUpperCase() }] }, [adId])).toThrow()
  })
  it('resolves a batch from one validated snapshot, with equivalent strict results and bounded native work', () => {
    const source = evidence()
    const ads = Array.from({ length: 20 }, (_, index) => String(301 + index))
    const observations = ads.flatMap((metaAdId, index) => source.observations.map((row, side) => ({ ...row, metaAdId,
      id: `00000000-0000-4000-8000-${String(index * 2 + side + 1).padStart(12, '0')}` })))
    const batch = { ...source, observations }
    const expected = ads.flatMap(ad => (['current', 'previous'] as const).map(period => resolveReportCreativeAssignment(context, batch, ad, period)))
    const spy = vi.spyOn(nativeAssignment, 'resolveCreativeAssignment')
    const resolve = createReportCreativeAssignmentResolver(context, batch)
    const actual = ads.flatMap(ad => (['current', 'previous'] as const).map(period => resolve(ad, period)))
    expect(actual).toEqual(expected)
    expect(actual.every(result => result.state === 'observed_stable')).toBe(true)
    expect(spy.mock.calls.length).toBeLessThanOrEqual(ads.length * 3)
    batch.observations[0].metaCreativeId = '999'
    expect(resolve(ads[0], 'current').state).toBe('observed_stable')
    const invalid = createReportCreativeAssignmentResolver(context, { ...batch, accountId: 'foreign-account' })
    for (const ad of ads) expect(invalid(ad, 'current')).toMatchObject({ state: 'blocked', blockerCode: 'assignment_evidence_invalid' })
  })
})

describe('bounded optional reporting history read', () => {
  it('reads only validated native assignment observations and preserves their exact identities', async () => {
    const source = fakeDb(nativeRows())
    const result = await readReportCreativeAssignmentEvidence(context, [adId], { db: source.db })
    expect(result).toEqual(evidence())
    expect(source.log).toEqual(['ad_creative_assignment_observations', 'select'])
  })
  it.each(['account', 'ad', 'duplicate', 'future'])('withholds a malformed %s result without exposing database errors', async failure => {
    const rows = nativeRows()
    if (failure === 'account') rows[0].ad_account_id = '00000000-0000-4000-8000-000000000099'
    if (failure === 'ad') rows[0].meta_ad_id = '999'
    if (failure === 'duplicate') rows.push(rows[0])
    if (failure === 'future') rows[0].observed_at = '2026-09-05T17:00:00.000000001Z'
    const result = await readReportCreativeAssignmentEvidence(context, [adId], { db: fakeDb(rows).db })
    expect(result.state).toBe('unavailable')
    expect(result.observations).toEqual([])
  })
  it.each([false, true])('bounds a stalled read at five seconds even when abort is ignored: %s', async ignoreAbort => {
    vi.useFakeTimers()
    const source = fakeDb([], true, ignoreAbort)
    const pending = readReportCreativeAssignmentEvidence(context, [adId], { db: source.db })
    await vi.advanceTimersByTimeAsync(4999)
    expect(source.aborted()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const result = await pending
    expect(source.aborted()).toBe(true)
    expect(result).toMatchObject({ state: 'unavailable', observations: [] })
    expect(result.notes.join(' ')).toMatch(/timed out|five.second|5.second/i)
  })
  it('rejects a source error without leaking its text and never opens a source for empty scope', async () => {
    const from = vi.fn(() => { throw new Error('synthetic-private-database-detail') })
    const db = { from } as unknown as SupabaseClient
    expect(await readReportCreativeAssignmentEvidence(context, [], { db })).toMatchObject({ state: 'available', observations: [] })
    expect(from).not.toHaveBeenCalled()
    const result = await readReportCreativeAssignmentEvidence(context, [adId], { db })
    expect(result.state).toBe('unavailable')
    expect(JSON.stringify(result)).not.toContain('synthetic-private-database-detail')
  })
})
