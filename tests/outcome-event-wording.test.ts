import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanUiText } from './_support/ui-text-scan'

// Meta's outcome event is configuration (NEXT_PUBLIC_META_OUTCOME_EVENT, default AppointmentConfirmed).
// Text the model reads and text the owner sees must name the configured event, so a shop optimising for
// Purchase is never told about "AppointmentConfirmed Results". Under the default event the wording is
// unchanged (the control below).

vi.mock('server-only', () => ({}))

const ROOT = path.resolve(__dirname, '..')
const APPOINTMENT_EVENT = /AppointmentConfirmed/

async function modelFacingText(event: string): Promise<string> {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_META_OUTCOME_EVENT', event)
  vi.stubEnv('NEXT_PUBLIC_OUTCOME_NOUN', 'order/orders')
  const { MAXX_INSTRUCTIONS, MAXX_CHAT_SYSTEM } = await import('@/mcp/instructions')
  const { PRIMARY_TOOL_DEFINITIONS } = await import('@/mcp/tools/tool-definitions-primary')
  const { SECONDARY_TOOL_DEFINITIONS } = await import('@/mcp/tools/tool-definitions-secondary')
  const { SYSTEM_PROMPT } = await import('@/lib/report/prompt-builder')
  const { PERFORMANCE_PRESETS } = await import('@/lib/performance/presets')
  const tools = [...PRIMARY_TOOL_DEFINITIONS, ...SECONDARY_TOOL_DEFINITIONS].map((tool) => tool.description)
  return [MAXX_INSTRUCTIONS, MAXX_CHAT_SYSTEM, SYSTEM_PROMPT, ...tools, ...PERFORMANCE_PRESETS.map((p) => p.description)].join('\n')
}

describe('outcome event wording follows NEXT_PUBLIC_META_OUTCOME_EVENT', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

  it('the default event still reads AppointmentConfirmed (control)', async () => {
    expect(await modelFacingText('')).toMatch(APPOINTMENT_EVENT)
  })

  it('a Purchase business never sees AppointmentConfirmed in model-facing text', async () => {
    const text = await modelFacingText('Purchase')
    expect(text.split('\n').filter((line) => APPOINTMENT_EVENT.test(line))).toEqual([])
    expect(text).toMatch(/modelled Purchase Results/)
  })

  it('no screen hard-codes the AppointmentConfirmed event name', () => {
    const hits = scanUiText(ROOT, ['src/app', 'src/components'], APPOINTMENT_EVENT)
    expect(hits.map((hit) => `${hit.file}:${hit.line} ${hit.text}`)).toEqual([])
  })
})
