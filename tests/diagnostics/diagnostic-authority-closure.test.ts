import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { projectMetaRecommendationDiagnostic } from '@/mcp/tools/diagnosis-bundle'

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), 'utf8')

describe('launch diagnosis cannot bypass ActionAuthority', () => {
  it('the producer has no imperative lever channel or OFFSITE_CONVERSIONS event default', () => {
    // Reproduced before the fix: this module emitted five owner-facing setting instructions through
    // `levers[]`, and resolveOptimizationEvent('OFFSITE_CONVERSIONS') returned
    // AppointmentConfirmed without reading promoted_object or a CampaignPlan.
    const source = read('src/lib/diagnostics/launch-performance.ts')

    expect(source).not.toMatch(/\blevers\s*:\s*string\[\]/)
    expect(source).not.toMatch(/\blevers\.push\(/)
    expect(source).not.toMatch(
      /optimizationGoal\s*===\s*['"]OFFSITE_CONVERSIONS['"][\s\S]{0,120}return\s+ACCOUNT_CONVERSION_EVENT/,
    )
    expect(source).toMatch(/prescriptions:\s*\[\]/)
    expect(source).toMatch(/action_authority_tier:\s*['"]diagnostic_only['"]/)
  })

  it('every MCP description keeps diagnosis observational and routes actions to governed tools', () => {
    // Reproduced before the fix: both the tool wrapper and registry told the model to "use the
    // levers", so the MCP path could bypass the newer ActionAuthority pipeline even though the
    // persisted recommendations were correctly fail-closed.
    const modelFacing = [
      read('src/mcp/tools/diagnose-performance.ts'),
      read('src/mcp/tools/diagnosis-bundle.ts'),
      read('src/mcp/tools/index.ts'),
      read('src/mcp/instructions.ts'),
    ].join('\n')

    expect(modelFacing).not.toMatch(/expertise-led levers/i)
    expect(modelFacing).not.toMatch(/use the levers/i)
    expect(modelFacing).toMatch(/diagnostic[_ -]only/i)
    expect(modelFacing).toMatch(/prescriptions[^.\n]*empty|prescriptions:\s*\[\]/i)
    expect(modelFacing).toMatch(/get_recommendations/)
    expect(modelFacing).toMatch(/evaluate_recommendation/)
    expect(modelFacing).toMatch(/CampaignPlan/)
    expect(modelFacing).toMatch(/window_settle/)
    expect(modelFacing).toMatch(/spend_concentration/)
    expect(modelFacing).not.toMatch(/real choice is raise budget/i)
  })

  it('withholds raw Meta suggestion prose from the one-round diagnostic bundle', () => {
    const projected = projectMetaRecommendationDiagnostic({
      available: true,
      recommendations: [{
        objectIds: ['adset-1'],
        type: 'BUDGET',
        name: 'Increase budget',
        level: 'AD_SET',
        stage: 'ACTIVE',
        recommendationTime: '2026-07-30T00:00:00Z',
        url: null,
        body: 'Raise budget by 30 percent now.',
        liftEstimate: null,
        opportunityScoreLift: null,
      }],
      groupCount: 1,
      violations: [],
      paging: {
        pagesFollowed: 1,
        cursorFingerprints: [],
        stoppedBecause: 'exhausted',
        complete: true,
        violations: [],
      },
      fetchedAt: '2026-07-30T00:00:00Z',
    })

    expect(projected).toMatchObject({
      available: true,
      count: 1,
      raw_suggestions_withheld: true,
      action_authority_tier: 'diagnostic_only',
    })
    expect(JSON.stringify(projected)).not.toMatch(/Increase budget|Raise budget/i)
  })
})
