import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { GOLDEN_QUESTIONS } from '@/lib/eval/golden-questions'
import { getPlaybook, renderPlaybook } from '@/lib/playbooks'

describe('creative evidence-map authority', () => {
  it('renders only usable diagnostic tools and no unavailable health-score ranking path', () => {
    const playbook = getPlaybook('creative_refresh')!
    const rendered = renderPlaybook(playbook)

    expect(playbook.required_evidence).toEqual([
      'get_creative_performance',
      'get_creative_insights',
      'get_recommendations',
    ])
    expect(rendered).toContain('STATUS: DIAGNOSTIC ONLY')
    expect(rendered).toContain('get_recommendations')
    expect(rendered).not.toMatch(/get_creative_health_scores|rank which creatives|scale\/refresh\/kill/i)
  })

  it('scores the creative question on evidence truth and governance rather than a legacy grade', () => {
    const question = GOLDEN_QUESTIONS.find((candidate) => candidate.id === 'q3-creative-quality')!
    const serialized = JSON.stringify(question)

    expect(question.required_tools).toEqual([
      'get_creative_insights',
      'get_creative_performance',
      'get_recommendations',
    ])
    expect(serialized).toMatch(/CampaignPlan|campaign plan/i)
    expect(serialized).toMatch(/diagnostic|descriptive/i)
    expect(question.required_tools).not.toContain('get_creative_health_scores')
  })

  it('pins the creative playbook source against reintroducing hard fatigue/action bands', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/playbooks/playbooks.ts'), 'utf8')
    const block = source.slice(
      source.indexOf("intent: 'creative_refresh'"),
      source.indexOf("intent: 'budget_allocation'"),
    )

    expect(block).not.toMatch(/get_creative_health_scores|rank which creatives|scale\/refresh\/kill verdicts/i)
    expect(block).not.toMatch(/frequency\s*>\s*3|warn at 2\.5|CTR eroded\s*[≥>]\s*20/i)
    expect(block).toMatch(/get_recommendations/)
    expect(block).toMatch(/approved stored CampaignPlan/i)
  })
})
