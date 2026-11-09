import { describe, expect, it } from 'vitest'
import { TOOL_DEFINITIONS } from '@/mcp/tools'
import { createPausedTestDraft } from '@/mcp/tools/write-tools'

describe('unimplemented Meta object creation is not a setup-advice side channel', () => {
  // ADR-062: campaign and ad-set creation now go through owner-approved campaign plans (the MCP
  // server reads plans, it never creates). The test registry is still unimplemented.
  it.each([
    ['test', createPausedTestDraft],
  ] as const)('%s creator returns one stable unavailable result and ignores arbitrary setup claims', async (_name, create) => {
    const result = await create({
      approved: 'APPROVED',
      objective: 'OUTCOME_SALES',
      audience_type: 'warm',
      optimization_goal: 'OFFSITE_CONVERSIONS',
      daily_budget_usd: 999,
      geo_radius_km: 25,
    } as never)
    const serialized = JSON.stringify(result)

    expect(result).toMatchObject({
      status: 'NOT_IMPLEMENTED',
      blocker_codes: expect.arrayContaining([
        'experiment_registry_not_implemented',
        'meta_object_creation_not_implemented',
      ]),
    })
    expect(serialized).not.toContain('OUTCOME_SALES')
    expect(serialized).not.toContain('OFFSITE_CONVERSIONS')
    expect(serialized).not.toContain('999')
    expect(serialized).not.toContain('25')
    expect(serialized).not.toContain('manual_steps')
  })

  it('advertises no caller-selectable objective, audience, budget, optimization, geo, or approval bypass', () => {
    const names = [
      'create_paused_test_draft',
    ]

    for (const name of names) {
      const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name)
      expect(definition?.description).toMatch(/NOT_IMPLEMENTED/i)
      expect(definition?.inputSchema.properties).toEqual({})
      expect(definition?.inputSchema).toHaveProperty('additionalProperties', false)
      expect(definition?.inputSchema).not.toHaveProperty('required')
    }
  })
})
