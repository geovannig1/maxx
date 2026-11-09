import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { resolveAudience, type AudienceRef } from '@/lib/audience/resolver'

// `fetchAudienceMetadata` selected four columns — audience_id, name, subtype, meta_account_id — and
// built an AudienceRef from them. `resolveAudience` also reads `lastSyncedAt`, `operationStatus` and
// `deliveryStatus`. Absent, `typeof undefined === 'string'` is false, `syncedMs` becomes NaN, and the
// resolver returns `unresolved` ("inventory age is UNKNOWN") for EVERY audience, unconditionally.
//
// That froze preflight on every money recommendation in the account while targeting metadata was 0.1h
// old. TypeScript could not catch it: those three fields are optional on AudienceRef, so a ref without
// them is a structurally valid AudienceRef.
describe('audience metadata: the query must supply every field the resolver reads', () => {
  const ref = (over: Partial<AudienceRef> = {}): AudienceRef => ({
    id: '100000000000003',
    name: 'Website visitors 180d',
    subtype: 'WEBSITE',
    accountId: 'act_1',
    lastSyncedAt: new Date().toISOString(),
    operationStatus: { code: 200 },
    deliveryStatus: { code: 200 },
    ...over,
  })

  const resolutionFor = (audience: AudienceRef) => resolveAudience(
    {
      adsetName: 'Cold Prospecting',
      accountId: 'act_1',
      targeting: { custom_audiences: [{ id: audience.id }] },
      targetingSyncedAt: new Date().toISOString(),
      audiencesById: { [audience.id]: audience },
    },
    Date.now(),
  )

  it('classifies a fresh audience, and cannot classify one missing its sync stamp', () => {
    const complete = resolutionFor(ref())
    expect(complete.unresolvedIncludedAudienceIds).toEqual([])
    expect(complete.includedCustomAudiences.map((a) => a.id)).toEqual([ref().id])
    // (composition also depends on the expansion flag, which this fixture does not set — the
    //  defect-specific signal is whether the audience was classifiable at all.)

    // The exact ref shape the old four-column SELECT produced.
    const starved = resolutionFor(ref({
      lastSyncedAt: undefined, operationStatus: undefined, deliveryStatus: undefined,
    }))
    expect(starved.unresolvedIncludedAudienceIds).toEqual([ref().id])
    expect(starved.includedCustomAudiences).toEqual([])
    // Unknown composition is what freezes every money recommendation in the account.
    expect(starved.composition).toBe('unknown')
  })

  it('the SELECT names every column the resolver requires', () => {
    // A behavioural test cannot reach the query string, and the type system cannot either — the fields
    // are optional. This guard is the only thing standing between a four-column SELECT and a silent
    // account-wide freeze, so it asserts the query text directly.
    const source = fs.readFileSync('src/lib/recommendations/evidence-gate.ts', 'utf8')
    const select = source.match(/\.from\('custom_audiences'\)\s*\n\s*\.select\('([^']+)'\)/)
    expect(select, 'custom_audiences select not found').not.toBeNull()
    for (const column of ['audience_id', 'subtype', 'meta_account_id', 'last_synced_at', 'operation_status', 'delivery_status']) {
      expect(select![1]).toContain(column)
    }
  })
})
