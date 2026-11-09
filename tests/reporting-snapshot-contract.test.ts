import { describe, expect, it } from 'vitest'
import { snapshotContext, snapshotPacket } from './fixtures/reporting-snapshot'
import {
  canonicalReportingJson, createReportingSnapshot, makeReportingSnapshotScope,
  reportingFingerprint, validateReportingSnapshot, validateReportingPacketScope,
} from '@/lib/reporting/snapshot-contract'

const scope = () => makeReportingSnapshotScope('meta', snapshotContext, { detailIds: ['b', 'a', 'a'] })
const completed = '2026-09-05T17:00:40.000Z'

describe('immutable reporting snapshot identity and evidence', () => {
  it('validates pending evidence with the same identity, policy and clocks without making it publishable', () => {
    const pending = snapshotPacket(); pending.result.data!.detailState = 'loading'
    expect(validateReportingPacketScope(pending, scope(), completed)).toEqual(pending)
    expect(() => createReportingSnapshot(scope(), pending, completed)).toThrow()
    expect(() => validateReportingPacketScope(pending, { ...scope(), metaAccountId: 'act_456' }, completed)).toThrow()
    expect(() => validateReportingPacketScope(pending, scope(), 'invalid-time')).toThrow()
    expect(() => validateReportingPacketScope(pending, scope(), '2026-09-05T16:59:00Z')).toThrow()
    const claim = pending.result.data!.metrics.clicks.current
    pending.result.data!.metrics.clicks.current = { ...claim, authority: { ...claim.authority, policyVersion: 'wrong-policy' } }
    expect(() => validateReportingPacketScope(pending, scope(), completed)).toThrow()
  })
  it('canonicalizes only semantically unordered detail IDs and ignores display name/retrieval time in scope', () => {
    const first = scope()
    const other = makeReportingSnapshotScope('meta', { ...snapshotContext, asOf: completed,
      account: { ...snapshotContext.account, name: 'Renamed' } }, { detailIds: ['a', 'b'] })
    expect(first).toEqual(other)
    expect(first.detailIds).toEqual(['a', 'b'])
    expect(reportingFingerprint(first)).toBe(reportingFingerprint({ ...other }))
    expect(canonicalReportingJson({ z: 1, a: { y: null, x: 0 } })).toBe('{"a":{"x":0,"y":null},"z":1}')
    expect(canonicalReportingJson({ optional: undefined, measured: null })).toBe('{"measured":null}')
    expect(reportingFingerprint([1, 2])).not.toBe(reportingFingerprint([2, 1]))
  })
  it('binds requested/effective periods, source, account, policy and selected detail scope separately', () => {
    const first = scope()
    for (const changed of [
      { ...first, accountId: '00000000-0000-4000-8000-000000001312' },
      { ...first, metaAccountId: 'act_456' }, { ...first, source: 'business', detailIds: [] },
      { ...first, detailIds: [] }, { ...first, requestedRange: { ...first.range, to: '2026-09-06' } },
    ]) expect(reportingFingerprint(changed)).not.toBe(reportingFingerprint(first))
    expect(() => makeReportingSnapshotScope('business', snapshotContext, { detailIds: ['a'] })).toThrow()
    expect(() => makeReportingSnapshotScope('meta', snapshotContext, { detailIds: ['a', 'b', 'c'] })).toThrow()
    expect(() => makeReportingSnapshotScope('meta', snapshotContext, { requestedRange: { from: '2026-09-01', to: '2026-09-04' } })).toThrow()
  })
  it('preserves explicit zero, missing values, source heads and original clocks across immutable serialization', () => {
    const packet = snapshotPacket()
    packet.result.asOf = '2026-09-05T16:00:00.000Z'
    const snapshot = createReportingSnapshot(scope(), packet, completed)
    if (snapshot.packet.section !== 'meta') throw new Error('Wrong fixture source')
    expect(snapshot.retrieval).toEqual({ startedAt: snapshotContext.asOf, completedAt: completed })
    expect(snapshot.sourceAsOf).toBe(packet.result.asOf)
    expect(snapshot.packet.result.data!.metrics.clicks.current.value).toBe(0)
    expect(snapshot.packet.result.data!.metrics.missing.current.value).toBeNull()
    expect(snapshot.packet.result.data!.metrics.clicks.current.source.head).toBe('fixture-source-head')
    expect(validateReportingSnapshot(JSON.parse(canonicalReportingJson(snapshot)), scope())).toEqual(snapshot)
    expect(packet.context.asOf).toBe(snapshotContext.asOf)
  })
  it('does not invent a source watermark when the adapter has none', () => {
    const packet = snapshotPacket(); packet.result.asOf = null
    expect(createReportingSnapshot(scope(), packet, completed).sourceAsOf).toBeNull()
  })
  it.each(['loading', 'unavailable'] as const)('does not persist %s Meta details as a completed report', detailState => {
    const packet = snapshotPacket(); packet.result.data!.detailState = detailState
    expect(() => createReportingSnapshot(scope(), packet, completed)).toThrow()
  })
  it('rejects unavailable data, wrong packet identity, impossible clocks and unsupported policy versions', () => {
    const packet = snapshotPacket()
    expect(() => createReportingSnapshot(scope(), { ...packet, result: { state: 'unavailable', data: null, asOf: null, notes: [] } }, completed)).toThrow()
    expect(() => createReportingSnapshot(scope(), { ...packet, context: { ...packet.context, account: { ...packet.context.account, metaAccountId: 'act_456' } } }, completed)).toThrow()
    expect(() => createReportingSnapshot(scope(), packet, '2026-09-05T16:59:59Z')).toThrow()
    const snapshot = createReportingSnapshot(scope(), packet, completed)
    expect(() => validateReportingSnapshot({ ...snapshot, scope: { ...scope(), policyVersion: 'unreviewed-v2' } }, scope())).toThrow()
    expect(() => validateReportingSnapshot({ ...snapshot, sourceAsOf: completed }, scope())).toThrow()
    expect(() => validateReportingSnapshot(snapshot, { ...scope(), detailIds: ['c'] })).toThrow()
  })
  it('validates metrics and diagnostic authority before publication, even when the envelope matches', () => {
    const packet = snapshotPacket()
    const original = packet.result.data!.metrics.clicks.current
    packet.result.data!.metrics.clicks.current = { ...original, value: Number.NaN }
    expect(() => createReportingSnapshot(scope(), packet, completed)).toThrow()
    packet.result.data!.metrics.clicks.current = { ...original, entity: { ...original.entity, id: 'another-account' } }
    expect(() => createReportingSnapshot(scope(), packet, completed)).toThrow()
    packet.result.data!.metrics.clicks.current = { ...original, definitionVersion: 2 }
    expect(() => createReportingSnapshot(scope(), packet, completed)).toThrow()
    packet.result.data!.metrics.clicks.current = { ...original, authority: { ...original.authority, policyVersion: 'another-policy' } }
    expect(() => createReportingSnapshot(scope(), packet, completed)).toThrow()
  })
})
