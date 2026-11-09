import { describe, expect, it } from 'vitest'
import { resolveAudience } from '@/lib/audience/resolver'
import { frozenEvidence, gateRecommendation } from '@/lib/recommendations/evidence-gate'

const NOW = Date.parse('2026-07-30T12:00:00Z')

function evidenceFixture() {
  const evidence = frozenEvidence(30, 'fixture')
  const audience = resolveAudience({
    adsetName: 'Warm',
    targeting: {
      custom_audiences: [{ id: 'site' }],
      targeting_automation: { advantage_audience: 0 },
    },
    targetingSyncedAt: '2026-07-30T11:00:00Z',
    accountId: 'act_test',
    audiencesById: {
      site: { id: 'site', name: 'Site visitors', subtype: 'WEBSITE', accountId: 'act_test', operationStatus: { code: 200 }, deliveryStatus: { code: 200 }, lastSyncedAt: '2026-07-30T11:00:00Z' },
    },
  }, NOW)
  evidence.audienceByAdset.set('adset-db-id', audience)
  evidence.budgetStructureByAdset.set('adset-db-id', 'abo')
  evidence.dailyBudgetByAdset.set('adset-db-id', 30)
  return evidence
}

describe('recommendation preflight — paid interaction cohort outcome scope', () => {
  it('uses a complete unit cohort as first-party evidence at the exact decision unit', () => {
    const result = gateRecommendation('pause', {
      adsetDbId: 'adset-db-id',
      entityLevel: 'adset',
      evidence: evidenceFixture(),
      proposedBudget: null,
      entityKey: 'meta-adset-id',
      paidCohortOutcomes: {
        value: 0,
        scope: 'adset',
        provenance: 'paid cohort matured_cut generation gen-1',
      },
    })

    expect(result).not.toBeNull()
    expect(result!.decision.gates.find((gate) => gate.name === 'attributed_outcome_scope_recorded'))
      .toMatchObject({ passed: true })
    expect(result!.decision.evidence.businessTruth)
      .toContain('scope=adset; paid cohort matured_cut generation gen-1')
  })

  it('does not relabel account-wide ledger evidence when the unit cohort is absent', () => {
    const result = gateRecommendation('pause', {
      adsetDbId: 'adset-db-id',
      entityLevel: 'adset',
      evidence: evidenceFixture(),
      proposedBudget: null,
      entityKey: 'meta-adset-id',
    })

    expect(result!.decision.gates.find((gate) => gate.name === 'attributed_outcome_scope_recorded'))
      .toMatchObject({ passed: true })
    expect(result!.decision.gates.find((gate) => gate.name === 'attributed_outcome_scope_recorded')!.detail)
      .toMatch(/grants no commercial authority/i)
    expect(result!.decision.evidence.businessTruth).toContain('scope=account')
  })
})
