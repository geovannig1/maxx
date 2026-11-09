import { describe, expect, it } from 'vitest'
import { budgetContextFixture } from './fixtures/reporting-budget-context'
import { projectBudgetEvidence } from '@/lib/reporting/budget-evidence'
import { budgetExportRows } from '@/lib/reporting/budget-export'
import type { ReportingPacket } from '@/lib/reporting/contracts'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { upgradeLegacyVocabulary } from '@/lib/outcomes/legacy-vocabulary'

// budget evidence carried its amount under the key `usd`, computed as minorUnits / 100 for every
// currency. The amount is now `majorUnits`, computed in the report's currency (JPY 0 digits, KWD 3).
// Stored packets are fingerprinted, so a packet written with `usd` keeps its bytes and is upgraded on read
// (tests/reporting-budget-evidence.test.ts reads such stored v1 and v2 snapshots).

function currentPacket(): Extract<ReportingPacket, { section: 'meta' }> {
  const data = budgetContextFixture()
  return { section: 'meta', context: data.context, result: data.meta, notes: [] }
}

describe('budget amount key', () => {
  it('names the amount currency-neutrally and computes it in the report currency', () => {
    const { context } = budgetContextFixture()
    const entity = { level: 'adset' as const, id: '202', campaignId: '102' }
    const source = { id: '202', account_id: context.account.metaAccountId, campaign_id: '102', daily_budget: '4000' }
    const amount = (currency: string) =>
      projectBudgetEvidence({ ...context, currency }, entity, source, context.asOf)!.dailyBudget
    expect(amount('USD')).toEqual({ state: 'observed', minorUnits: 4000, majorUnits: 40 })
    expect(amount('JPY')).toEqual({ state: 'observed', minorUnits: 4000, majorUnits: 4000 })
    expect(amount('KWD')).toEqual({ state: 'observed', minorUnits: 4000, majorUnits: 4 })
    expect(JSON.stringify(currentPacket())).not.toMatch(/"usd"/)
  })

  it('rejects an amount that does not equal the minor units in the report currency', () => {
    const packet = currentPacket()
    const adset = packet.result.data!.entities.find(item => item.id === '202')!
    // Control: the healthy packet validates.
    expect(() => validateReportingPacket(packet)).not.toThrow()
    // A cents conversion is wrong for a JPY report (4000 yen, not 40).
    const jpy = structuredClone(packet)
    jpy.context = { ...jpy.context, currency: 'JPY' }
    expect(() => validateReportingPacket(jpy)).toThrow()
    // Control: the same JPY packet without budget evidence validates, so the refusal is the amount.
    const jpyWithout = structuredClone(jpy)
    for (const item of jpyWithout.result.data!.entities) delete item.budgetEvidence
    expect(() => validateReportingPacket(jpyWithout)).not.toThrow()
    adset.budgetEvidence!.dailyBudget = { state: 'observed', minorUnits: 4000, majorUnits: 40.01 }
    expect(() => validateReportingPacket(packet)).toThrow()
  })

  it('exports the amount and states its unit without naming one currency', () => {
    const data = budgetContextFixture()
    const rows = budgetExportRows(data.meta.data!.entities, data.meta.data!.entities, data.context)
    const daily = rows.find(item => item.metric === 'Configured daily budget' && item.value !== null)
    expect(daily?.value).toBe(100)
    expect(rows.map(item => item.definition).join(' ')).not.toMatch(/USD/)
  })

  it('upgrades a legacy `usd` amount on read, only inside a budget amount (controls)', () => {
    expect(upgradeLegacyVocabulary({ dailyBudget: { state: 'observed', minorUnits: 4000, usd: 40 } }))
      .toEqual({ dailyBudget: { state: 'observed', minorUnits: 4000, majorUnits: 40 } })
    expect(upgradeLegacyVocabulary({ state: 'missing', minorUnits: null, usd: null }))
      .toEqual({ state: 'missing', minorUnits: null, majorUnits: null })
    // Key order is kept, so the upgraded amount canonicalises like a current one.
    expect(Object.keys(upgradeLegacyVocabulary({ state: 'observed', minorUnits: 1, usd: 0.01 }))).toEqual(['state', 'minorUnits', 'majorUnits'])
    // Controls: a `usd` key outside a budget amount, and a string 'usd', are left alone.
    expect(upgradeLegacyVocabulary({ usd: 2, note: 'usd' })).toEqual({ usd: 2, note: 'usd' })
    expect(upgradeLegacyVocabulary({ state: 'observed', usd: 2 })).toEqual({ state: 'observed', usd: 2 })
    const current = { state: 'observed', minorUnits: 4000, majorUnits: 40 }
    expect(upgradeLegacyVocabulary(current)).toEqual(current)
  })

  it('recomputes a legacy amount in the packet currency, since minorUnits is exact', () => {
    const packet = (currency: string, usd: number) =>
      ({ context: { currency }, result: { entities: [{ budgetEvidence: { dailyBudget: { state: 'observed', minorUnits: 4000, usd } } }] } })
    const amount = (value: ReturnType<typeof packet>) =>
      (upgradeLegacyVocabulary(value).result.entities[0].budgetEvidence.dailyBudget as Record<string, unknown>)
    expect(amount(packet('JPY', 40))).toEqual({ state: 'observed', minorUnits: 4000, majorUnits: 4000 })
    expect(amount(packet('KWD', 40))).toEqual({ state: 'observed', minorUnits: 4000, majorUnits: 4 })
    expect(amount(packet('USD', 40))).toEqual({ state: 'observed', minorUnits: 4000, majorUnits: 40 })
    // Controls: a stored amount that was never minorUnits / 100 is kept as stored (validation rejects it),
    // and so is an amount with no packet currency in scope.
    expect(amount(packet('JPY', 41))).toEqual({ state: 'observed', minorUnits: 4000, majorUnits: 41 })
    expect(upgradeLegacyVocabulary({ result: { dailyBudget: { state: 'observed', minorUnits: 4000, usd: 40 } } }))
      .toEqual({ result: { dailyBudget: { state: 'observed', minorUnits: 4000, majorUnits: 40 } } })
  })
})
