import { describe, it, expect } from 'vitest'
import { PLAYBOOKS, getPlaybook, playbookMenu, renderPlaybook, renderDoctrineDigest } from '@/lib/playbooks'
import { corpusEntry } from '@/lib/knowledge/corpus'
import { TOOL_DEFINITIONS } from '@/mcp/tools/index'
import { getPlaybookTool } from '@/mcp/tools/playbook'

// Playbook invariants + the regression list from the approved plan: each rule
// below exists because a real hole was found in past advice.

const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((t) => t.name))

describe('playbooks — structural invariants', () => {
  it('covers all 11 intents with unique keys', () => {
    expect(PLAYBOOKS).toHaveLength(11)
    expect(new Set(PLAYBOOKS.map((p) => p.intent)).size).toBe(11)
  })

  it('every playbook: ≥3 procedure steps, ≥3 decision rules, ≥1 never, champion context', () => {
    for (const p of PLAYBOOKS) {
      expect(p.procedure.length, p.intent).toBeGreaterThanOrEqual(3)
      expect(p.decision_rules.length, p.intent).toBeGreaterThanOrEqual(3)
      expect(p.never.length, p.intent).toBeGreaterThanOrEqual(1)
      expect(p.champion_context).toContain('$30 lifetime CPA')
    }
  })

  it('every required_evidence and procedure tool exists in TOOL_DEFINITIONS', () => {
    for (const p of PLAYBOOKS) {
      for (const t of p.required_evidence) expect(TOOL_NAMES.has(t), `${p.intent}: ${t}`).toBe(true)
      for (const s of p.procedure) if (s.tool) expect(TOOL_NAMES.has(s.tool), `${p.intent}: ${s.tool}`).toBe(true)
    }
  })

  it('every corpus_ref resolves to a real corpus entry', () => {
    for (const p of PLAYBOOKS) {
      for (const ref of p.corpus_refs) expect(corpusEntry(ref), `${p.intent}: ${ref}`).toBeDefined()
    }
  })
})

describe('playbooks — regression rules (each maps to a past miss)', () => {
  it('scale_decision encodes the budget cap + champion-beating proof (regression 3)', () => {
    const p = getPlaybook('scale_decision')!
    const all = [...p.decision_rules, ...p.never].join(' ')
    expect(all).toMatch(/CAPPED|cap/i)
    expect(all).toMatch(/champion/i)
    expect(all).toMatch(/industry heuristic/i) // never sell 5× as a Meta rule
  })

  it('optimization_event encodes never-abandon + standard-event parity with its caveats (regression: missed lever)', () => {
    const p = getPlaybook('optimization_event')!
    const all = [...p.decision_rules, ...p.never].join(' ')
    expect(all).toMatch(/NEVER abandon/i)
    expect(all).toMatch(/standard event such as Schedule or Purchase/i)
    expect(all).toMatch(/NOT a learning-exit fix/i)
    expect(all).toMatch(/outcome source collects payment/i)
    expect(all).toMatch(/kill criteria/i) // one-rung-up needs pre-declared revert rules
  })

  it('measurement_tracking encodes CAPI + ad-attributed≠total (regressions 1+2)', () => {
    const p = getPlaybook('measurement_tracking')!
    const all = [p.procedure.map((s) => s.step + ' ' + s.check).join(' '), ...p.decision_rules].join(' ')
    expect(all).toMatch(/CAPI/i)
    expect(all).toMatch(/Ad-attributed ≠ total/i)
  })

  it('creative_refresh is an evidence-only map with no legacy score or direct action ladder', () => {
    const p = getPlaybook('creative_refresh')!
    const all = [...p.procedure.map((step) => `${step.step} ${step.check}`), ...p.decision_rules, ...p.never].join(' ')
    expect(p.required_evidence).toEqual(['get_creative_performance', 'get_creative_insights', 'get_recommendations'])
    expect(all).toMatch(/descriptive Meta delivery evidence/i)
    expect(all).toMatch(/CampaignPlan/i)
    expect(all).not.toMatch(/frequency\s*>\s*3|warn at 2\.5|scale\/refresh\/kill verdicts|rank which creatives/i)
  })

  it('kill_or_keep + budget_allocation forbid breakdown-average decisions (platform mechanic)', () => {
    for (const intent of ['kill_or_keep', 'budget_allocation'] as const) {
      const p = getPlaybook(intent)!
      expect(p.never.join(' ')).toMatch(/breakdown/i)
    }
  })

  it('launch_setup counts age from first spend, not creation (the start_time trap)', () => {
    const p = getPlaybook('launch_setup')!
    expect([...p.decision_rules, ...p.procedure.map((s) => s.check)].join(' ')).toMatch(/first spend/i)
  })

  it('structure_audience encodes the Advantage+/geo doctrine (niche corpus): geo is a hard control, audit the expansion box', () => {
    const p = getPlaybook('structure_audience')!
    const all = [...p.decision_rules, ...p.never].join(' ')
    expect(all).toMatch(/does NOT widen geo|hard control/i)
    expect(all).toMatch(/location-expansion|reach more people/i)
  })

  it('budget_allocation forbids a cost/bid cap at this budget (Meta 5× rule) and treats daily budget as a weekly average', () => {
    const p = getPlaybook('budget_allocation')!
    const all = p.decision_rules.join(' ')
    expect(all).toMatch(/5×|cost.?goal.?5x|\$300\/day/i)
    expect(all).toMatch(/weekly average|weekly overspend/i)
  })

  it('seasonality playbook: calendar-aware but validates the prior against the account’s own booking history', () => {
    const p = getPlaybook('seasonality')!
    const all = [...p.decision_rules, ...p.never].join(' ')
    expect(all).toMatch(/event weeks|weather season|trough/i)
    expect(all).toMatch(/outcome ledger \/ GA4|booking history/i)
    expect(all).toMatch(/watch\/warning/i) // only an actual weather watch/warning justifies pause logic
  })
})

describe('playbook rendering + tool', () => {
  it('menu lists 11; public rendering exposes evidence tools but withholds historical action doctrine', () => {
    expect(playbookMenu()).toHaveLength(11)
    const r = renderPlaybook(getPlaybook('scale_decision')!)
    expect(r).toContain('DIAGNOSTIC ONLY')
    expect(r).toContain('REQUIRED EVIDENCE TOOLS')
    expect(r).toContain('get_recommendations')
    expect(r).not.toMatch(/PROCEDURE:|DECISION RULES:|NEVER:|CHAMPION CONTEXT:/)
  })

  it('compatibility doctrine digest fails closed without returning legacy rules', () => {
    const d = renderDoctrineDigest(['scale_decision', 'kill_or_keep', 'creative_refresh', 'budget_allocation'])
    expect(d).toContain('DIAGNOSTIC ONLY')
    expect(d).toContain('scale_decision')
    expect(d).not.toMatch(/NEVER:|DECISION RULES:|CHAMPION CONTEXT:/)
  })

  it('the get_playbook tool schema enum covers EVERY playbook intent (cross-PR audit M1: a hardcoded enum orphaned seasonality)', () => {
    const def = TOOL_DEFINITIONS.find((t) => t.name === 'get_playbook')!
    const schema = def.inputSchema as { properties: { intent: { enum: string[] } } }
    for (const p of PLAYBOOKS) {
      expect(schema.properties.intent.enum, `intent '${p.intent}' missing from the tool schema enum`).toContain(p.intent)
    }
  })

  it('get_playbook tool: menu without intent, diagnostic evidence map with source references, error on unknown', () => {
    const menu = getPlaybookTool({}) as { playbooks: unknown[] }
    expect(menu.playbooks).toHaveLength(11)
    const full = getPlaybookTool({ intent: 'optimization_event' }) as {
      authority: string
      rendered: string
      references: { key: string; source_name: string; status: string }[]
    }
    expect(full.authority).toBe('diagnostic_only')
    expect(full.rendered).toContain('PLAYBOOK: optimization_event')
    expect(full.references.length).toBeGreaterThan(0)
    expect(full.references.every((reference) => reference.status === 'reference_only_claim_withheld')).toBe(true)
    const bad = getPlaybookTool({ intent: 'nope' }) as { error: string }
    expect(bad.error).toBe('UNKNOWN_INTENT')
  })
})
