import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getPlaybook, renderDoctrineDigest, renderPlaybook } from '@/lib/playbooks'
import { getPlaybookTool } from '@/mcp/tools/playbook'

const ROOT = join(process.cwd(), 'src')

const ANY_DOLLAR_AMOUNT = /\$\s?\d/
const ANY_MILE_RADIUS = /\b\d+(?:\.\d+)?\s?-?\s?(?:mi|miles?)\b/i
// Meta standard events plus any custom appointment-style event name. Case-sensitive on purpose:
// the lower-case words "lead" or "purchase" in prose are not event names.
const NAMED_PIXEL_EVENT = /\b(?:Schedule|Lead|Purchase|Contact|CompleteRegistration|InitiateCheckout|Appointment[A-Z]\w*)\b/

describe('the authority-gate patterns reject the leaks they exist to catch', () => {
  it('each pattern matches a planted bad case and passes a clean one', () => {
    expect('spend $72.40 a day').toMatch(ANY_DOLLAR_AMOUNT)
    expect('raise to $90/day').toMatch(ANY_DOLLAR_AMOUNT)
    expect('target a 12 mi radius').toMatch(ANY_MILE_RADIUS)
    expect('a 15-mile radius').toMatch(ANY_MILE_RADIUS)
    expect('optimize for AppointmentBooked').toMatch(NAMED_PIXEL_EVENT)
    expect('optimize for Schedule').toMatch(NAMED_PIXEL_EVENT)
    const clean = 'DIAGNOSTIC ONLY — read the governed recommendations before an approved CampaignPlan exists.'
    for (const pattern of [ANY_DOLLAR_AMOUNT, ANY_MILE_RADIUS, NAMED_PIXEL_EVENT]) expect(clean).not.toMatch(pattern)
  })
})

describe('legacy playbook authority boundary', () => {
  it('renders an evidence map without legacy action rules or account-setting doctrine', () => {
    for (const intent of ['scale_decision', 'kill_or_keep', 'structure_audience', 'optimization_event', 'launch_setup'] as const) {
      const output = renderPlaybook(getPlaybook(intent)!)

      expect(output).toContain('DIAGNOSTIC ONLY')
      expect(output).toContain('REQUIRED EVIDENCE')
      expect(output).not.toMatch(/DECISION RULES:|CHAMPION CONTEXT:|PROCEDURE:/)
      // No concrete money figure, mile radius or named pixel event: any of them would be an
      // account-specific setting leaking through a map that is meant to carry evidence tools only.
      expect(output).not.toMatch(ANY_DOLLAR_AMOUNT)
      expect(output).not.toMatch(ANY_MILE_RADIUS)
      expect(output).not.toMatch(NAMED_PIXEL_EVENT)
      expect(output).not.toMatch(/increase budget|reduce budget|pause\/kill|switch(?:ing)? optimization/i)
    }
  })

  it('returns an explicit non-authoritative contract from the MCP tool', () => {
    const output = getPlaybookTool({ intent: 'launch_setup' }) as Record<string, unknown>

    expect(output.authority).toBe('diagnostic_only')
    expect(output.action_guidance_status).toBe('withheld')
    expect(output.campaign_plan_status).toBe('unavailable')
    expect(output).not.toHaveProperty('decision_rules')
    expect(output).not.toHaveProperty('champion_context')
    expect(String(output.note)).toMatch(/governed current recommendations/i)
  })

  it('keeps the compatibility digest diagnostic-only and free of action rules', () => {
    const digest = renderDoctrineDigest(['scale_decision', 'kill_or_keep'])

    expect(digest).toContain('DIAGNOSTIC ONLY')
    expect(digest).not.toMatch(/Decision Doctrine|NEVER:|increase budget|pause\/kill/i)
    expect(digest).not.toMatch(ANY_DOLLAR_AMOUNT)
  })

  it('does not append a legacy doctrine digest to daily or weekly report prompts', () => {
    for (const file of ['lib/report/generator.ts', 'lib/report/weekly.ts']) {
      const source = readFileSync(join(ROOT, file), 'utf8')
      expect(source).not.toMatch(/renderDoctrineDigest/)
      expect(source).not.toMatch(/\$\{SYSTEM_PROMPT\}\\n\\n\$\{doctrine\}/)
    }
  })
})
