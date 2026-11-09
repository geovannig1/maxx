import { describe, expect, it } from 'vitest'
import { MAXX_INSTRUCTIONS } from '@/mcp/instructions'
import { PRIMARY_TOOL_DEFINITIONS } from '@/mcp/tools/tool-definitions-primary'
import { SECONDARY_TOOL_DEFINITIONS } from '@/mcp/tools/tool-definitions-secondary'
import { SYSTEM_PROMPT } from '@/lib/report/prompt-builder'
import { MAXX_CHAT_MEASUREMENT_GOVERNANCE } from '@/lib/maxx/chat'
import { PLAYBOOKS } from '@/lib/playbooks/playbooks'
import { CHAMPION_CONTEXT } from '@/lib/playbooks/types'
import { BUSINESS_ACCOUNT_METRIC_DEFINITIONS } from '@/lib/reporting/business-metric-definitions'
import { BUSINESS_DRIVER_DEFINITIONS } from '@/lib/reporting/business-driver-definitions'
import { META_NATIVE_METRIC_DEFINITIONS, META_RATIO_METRIC_DEFINITIONS } from '@/lib/reporting/meta-metric-definitions'

// text the model reads names outcomes with the configured noun. This file sets no noun, so it runs
// as a business with the default "outcome/outcomes": no booking or appointment wording may remain in the
// rendered model-facing text (Meta's event name AppointmentConfirmed is Meta's identifier, not wording;
// "booked value" names the gross-value metric and is still listed as debt).

const OUTCOME_WORDING = /\b(bookings?|appointments?)\b/gi
const words = (text: string) => text.replace(/\bAppointmentConfirmed\b/g, '').match(OUTCOME_WORDING) ?? []

describe('model-facing text under the default outcome noun', () => {
  it('detects booking wording in a planted text (control)', () => {
    expect(words('No bookings; an appointment-id join. AppointmentConfirmed fired.')).toEqual(['bookings', 'appointment'])
  })

  it('MCP instructions and tool descriptions name outcomes, not bookings or appointments', () => {
    expect(process.env.NEXT_PUBLIC_OUTCOME_NOUN ?? '').toBe('')
    const tools = [...PRIMARY_TOOL_DEFINITIONS, ...SECONDARY_TOOL_DEFINITIONS].map((tool) => tool.description).join('\n')
    expect(words(MAXX_INSTRUCTIONS)).toEqual([])
    expect(words(tools)).toEqual([])
    expect(MAXX_INSTRUCTIONS).toMatch(/\boutcomes\b/)
  })

  it('the report system prompt and the chat governance name outcomes, not bookings or appointments', () => {
    expect(words(SYSTEM_PROMPT)).toEqual([])
    expect(words(MAXX_CHAT_MEASUREMENT_GOVERNANCE)).toEqual([])
  })

  it('the reasoning playbooks name outcomes, not bookings or appointments', () => {
    expect(words(JSON.stringify(PLAYBOOKS))).toEqual([])
    expect(words(CHAMPION_CONTEXT)).toEqual([])
    expect(CHAMPION_CONTEXT).toMatch(/\boutcomes\b/)
  })

  it('the report metric labels and definitions name outcomes, not bookings or appointments', () => {
    const business = Object.values(BUSINESS_ACCOUNT_METRIC_DEFINITIONS).filter((m) => m.key !== 'booked_value')
    const text = [
      ...business.flatMap((m) => [m.label, m.definition]),
      ...Object.values(BUSINESS_DRIVER_DEFINITIONS),
      ...META_NATIVE_METRIC_DEFINITIONS.map((m) => m.label),
      ...META_RATIO_METRIC_DEFINITIONS.map(([, label]) => label),
    ].join('\n')
    expect(words(text)).toEqual([])
    expect(text).toMatch(/\bPaid outcomes\b/)
  })
})
