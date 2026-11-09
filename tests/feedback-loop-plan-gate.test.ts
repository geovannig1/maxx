import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ db: vi.fn(), llm: vi.fn() }))

vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: calls.db }))
// Every model entry point of the AI gateway records into the same spy.
vi.mock('@/lib/ai', () => ({ generateText: calls.llm, generateStructured: calls.llm, completeTurn: calls.llm }))

describe('legacy feedback loop is quarantined until CampaignPlan-backed experiments exist', () => {
  it('creates no brief/test/approval rows and invokes neither DB nor LLM', async () => {
    const { runFeedbackLoop, processFeedbackForCompletedTests } = await import('@/lib/feedback/loop')

    await expect(runFeedbackLoop('account-1')).resolves.toBe(0)
    await expect(processFeedbackForCompletedTests('account-1')).resolves.toBe(0)
    expect(calls.db).not.toHaveBeenCalled()
    expect(calls.llm).not.toHaveBeenCalled()
  })

  it('contains no context-free budget or booking pass/fail rules', () => {
    const source = readFileSync('src/lib/feedback/loop.ts', 'utf8')
    expect(source).not.toMatch(/budget_daily\s*:\s*\d/)
    expect(source).not.toMatch(/CPA\s*[<>]=?\s*\$\s?\d|Spend\s*[<>]=?\s*\$\s?\d|0 bookings/)
    expect(source).toMatch(/CAMPAIGN_PLAN_REQUIRED/)
  })
})
