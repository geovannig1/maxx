import { describe, expect, it } from 'vitest'
import { buildGovernedAuditEvidence } from '@/lib/maxx/governed-audit'
import { normalizeAnswerBriefValue } from '@/lib/maxx/answer-brief'
import type { AnswerBriefClaim } from '@/lib/maxx/answer-brief'

/**
 * The required packet must stay inside the surface it is rendered on.
 *
 * `normalizeAnswerBriefValue` force-selects every `required_claim_ids` entry and throws once more
 * than sixteen of them are unavailable — a bound its own comment sizes for "a two-ad-set audit".
 * Nothing bounded the producer to match: `buildGovernedAuditEvidence` marks three adset claims
 * required for EVERY row of `adsets_detail` under an `owner_ads_audit` / `adset_setup` focus, and
 * each is unavailable when Meta has not synced that ad set. Six ad sets is therefore enough to make
 * every governed answer unrenderable, and the account this runs against carries ten.
 *
 * The failure surfaces as `brief: null` — the eval reports "no governed brief produced" and the
 * reader is told the answer was withheld, with no indication that the server over-declared.
 */

const WINDOW = { start: '2026-08-01', end: '2026-08-20' }

/** An ad set Meta has not synced: no learning phase, no delivery sub-status, no audience. */
function unsyncedAdset(index: number) {
  return { id: `adset-${index}`, name: `Ad set ${index}` }
}

function packetFor(adsetCount: number, focus: 'owner_ads_audit' | 'creative_quality') {
  return buildGovernedAuditEvidence({
    focus,
    accountId: 'act-1',
    window: WINDOW,
    asOf: '2026-08-21T12:00:00.000Z',
    cockpit: { claims: [] },
    diagnosis: {
      adsets_detail: Array.from({ length: adsetCount }, (_, i) => unsyncedAdset(i + 1)),
      audiences: [],
    },
    reconciliation: null,
    economics: null,
    operatingMode: null,
    recommendations: { read_health: 'healthy', count: 0 },
    creative: null,
  })
}

function requiredUnavailableCount(adsetCount: number): number {
  const packet = packetFor(adsetCount, 'owner_ads_audit')
  return packet.claims
    .filter((claim) => packet.required_claim_ids.includes(claim.claimId))
    .filter((claim) => claim.availability.state === 'unavailable').length
}

function renderRequiredPacket(packet: ReturnType<typeof packetFor>) {
  const claimsById = new Map<string, AnswerBriefClaim>(
    packet.claims.map((claim) => [claim.claimId, claim as AnswerBriefClaim]),
  )
  // The model cites nothing; the server's own required packet is the whole selection.
  return normalizeAnswerBriefValue(
    { summary: 'governed_claims', observations: [], unavailable_claim_ids: [], action_decision_ids: [] },
    claimsById,
    packet.required_claim_ids,
    [],
  )
}

describe('governed audit required packet stays inside the renderable surface', () => {
  it('charges three unavailable required claims per ad set while there is budget, then stops growing', () => {
    // Under budget the ad set term is still fully forced: three claims for one unsynced ad set.
    expect(requiredUnavailableCount(1) - requiredUnavailableCount(0)).toBe(3)
    // Past it the term is bounded instead of scaling. Unbounded it would have been 30 at ten ad
    // sets, which is what made every ad set answer unrenderable.
    expect(requiredUnavailableCount(10) - requiredUnavailableCount(0)).toBeLessThan(30)
    expect(requiredUnavailableCount(25)).toBe(requiredUnavailableCount(10))
  })

  it('renders a two-ad-set audit, the bound the surface was sized for', () => {
    expect(() => renderRequiredPacket(packetFor(2, 'owner_ads_audit'))).not.toThrow()
  })

  it('still renders at ten ad sets instead of withholding every governed answer', () => {
    expect(() => renderRequiredPacket(packetFor(10, 'owner_ads_audit'))).not.toThrow()
  })

  it('never declares more unavailable claims required than the surface renders', () => {
    for (const count of [1, 2, 6, 10, 25]) {
      const packet = packetFor(count, 'owner_ads_audit')
      const unavailable = packet.claims
        .filter((claim) => packet.required_claim_ids.includes(claim.claimId))
        .filter((claim) => claim.availability.state === 'unavailable')
      expect(unavailable.length, `${count} ad sets over-declared`).toBeLessThanOrEqual(16)
    }
  })

  it('leaves a creative-focus audit free of adset requirements — why q3 is the only passing scenario', () => {
    const packet = packetFor(10, 'creative_quality')
    const adsetRequired = packet.claims
      .filter((claim) => packet.required_claim_ids.includes(claim.claimId))
      .filter((claim) => claim.metricKey.startsWith('meta.adset.'))
    expect(adsetRequired).toHaveLength(0)
    expect(() => renderRequiredPacket(packet)).not.toThrow()
  })
})
