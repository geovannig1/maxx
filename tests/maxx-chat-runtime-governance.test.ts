import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAiEnv } from './helpers/ai-stub'

/**
 * A brief is SUBMITTED as a tool call now, not written as assistant text.
 *
 * Raw JSON in an assistant turn was unreliable: measured against production, the model returned prose
 * four consecutive times with claims available and the window correct, and 2/2 under each of two
 * different date contexts. `submit_answer_brief` makes the shape an API-validated tool input, and a
 * prose turn now earns ONE explicit request to submit before the answer is withheld — so these tests
 * must supply two model turns wherever they expect a withheld answer.
 */
const state = vi.hoisted(() => ({
  create: vi.fn(),
  execute: vi.fn(),
  gatherGovernedAudit: vi.fn(),
  /** The last account-level day the warehouse holds. null = the read failed. */
  closedThrough: null as string | null,
  /** Optional raw warehouse rows, including a same-day partial row. */
  closedThroughCandidates: null as string[] | null,
}))

// The gateway's Anthropic adapter sends every request through `client.beta.messages` (refusal
// fallbacks are a beta surface); both paths reach the same recorder.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class AnthropicMock {
    messages = { create: state.create }
    beta = { messages: { create: state.create } }
  },
}))

vi.mock('@/mcp/instructions', () => ({ MAXX_CHAT_SYSTEM: 'BASE MAXX PROMPT' }))

vi.mock('@/mcp/tools/index', () => ({
  // The roster must cover every tool these tests drive: `safeToolName` maps anything outside it to
  // "an unrecognised tool", so a mock that under-declares reality silently renames real tools.
  READ_ONLY_TOOL_DEFINITIONS: [
    { name: 'get_performance_cockpit', description: 'Read governed cockpit claims.', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_outcome_bookings', description: 'Read the Acuity ledger.', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_account_summary', description: 'Read account delivery.', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_reconciliation', description: 'Read tracking reconciliation.', inputSchema: { type: 'object', properties: {} } },
  ],
  WRITE_TOOLS: new Set(['adjust_budget']),
  executeTool: state.execute,
}))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => {
            const read = async (upperBound: string | null) => {
              const candidates = state.closedThroughCandidates
                ?? (state.closedThrough === null ? [] : [state.closedThrough])
              const eligible = candidates.filter((day) => upperBound === null || day <= upperBound)
              return eligible.length === 0
                ? { data: [], error: null }
                : { data: [{ date_start: eligible[0] }], error: null }
            }
            return {
              // Keep the uncapped path executable so the regression is RED before production adds
              // the boundary, while the capped path filters the raw same-day warehouse row.
              order: () => ({ limit: () => read(null) }),
              lte: (_column: string, upperBound: string) => ({
                order: () => ({ limit: () => read(upperBound) }),
              }),
            }
          },
        }),
      }),
    }),
  }),
}))
vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: async () => ({ ok: true, account: { id: 'acct-uuid' } }),
}))

vi.mock('@/lib/authority/diagnostic-surface', () => ({
  projectMaxxChatNarrative: (text: string) => `DIAGNOSTIC CHAT\n\n${text}`,
}))

vi.mock('@/lib/maxx/governed-audit-runtime', () => ({
  gatherGovernedAuditEvidence: state.gatherGovernedAudit,
}))

import { runMaxxChat, MAX_TOOL_RESULT_CHARS } from '@/lib/maxx/chat'
import { createMetricClaim } from '@/lib/cockpit/contracts'

function cockpitClaim() {
  return createMetricClaim({
    claimId: 'claim-results', metricKey: 'meta_results', label: 'Meta Results', value: 17,
    unit: 'count', formula: null, definitionVersion: 1,
    source: { system: 'meta', role: 'delivery_truth', head: 'meta-head', evidencePlane: 'meta_delivery' },
    entity: { level: 'account', id: 'active' }, attributionScope: 'meta_platform_modelled',
    window: { start: '2026-04-06', end: '2026-04-24', basis: 'closed_account_days', timezone: 'America/New_York' },
    comparison: { method: 'none', window: null }, asOf: '2026-04-25T12:00:00.000Z',
    availability: { state: 'available', blockerCodes: [] },
    coverage: { state: 'complete', numerator: 20, denominator: 20 },
    maturity: { state: 'settled', matureThrough: '2026-04-24' },
    freshness: { state: 'fresh', observedAt: '2026-04-25T12:00:00.000Z', maxAgeHours: 24 },
    setupFingerprint: 'setup-v1', authority: { state: 'context', policyVersion: 'meta-results-v1' },
    measurementKind: 'modelled', inputClaimIds: [],
  })
}

describe('runMaxxChat governed runtime', () => {
  beforeEach(() => {
    vi.stubEnv('MAXX_CHAT_ENABLED', 'true')
    useAiEnv({ ANTHROPIC_API_KEY: 'test-key' })
    state.create.mockReset()
    state.execute.mockReset()
    state.gatherGovernedAudit.mockReset()
    state.closedThrough = null
    state.closedThroughCandidates = null
    state.gatherGovernedAudit.mockResolvedValue({
      claims: [],
      requiredClaimIds: [],
      persistedFinalActionDecisions: [],
      consulted: [],
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('sends the measurement contract and a governed evidence envelope to the model', async () => {
    const governedClaim = cockpitClaim()
    state.create
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'get_performance_cockpit', input: {
          start_date: '2026-04-06', end_date: '2026-04-24',
        } }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'brief-1', name: 'submit_answer_brief', input: {
          summary: 'governed_claims',
          observations: [{
            claim_ids: [governedClaim.claimId],
          }],
          action_decision_ids: [],
          unavailable_claim_ids: [],
          next_check: null,
        } }],
      })
    state.execute.mockResolvedValue({
      status: 'available',
      results: 17,
      claims: [governedClaim],
    })

    const answer = await runMaxxChat([{ role: 'user', content: 'How many results?' }])

    expect(state.create).toHaveBeenCalledTimes(2)
    expect(state.create.mock.calls[0][0].system[0].text).toMatch(/SOURCE ROLES[\s\S]*Meta[\s\S]*Outcomes[\s\S]*GA4[\s\S]*CAPI/i)
    const followUpMessages = state.create.mock.calls[1][0].messages
    const toolResult = followUpMessages.at(-1).content[0].content
    expect(JSON.parse(toolResult)).toMatchObject({
      evidence: {
        tool: 'get_performance_cockpit',
        sources: ['Meta'],
        // "requested", because dateArg proves the string is a date and NOT that the lookup covered
        // it — resolveClosedDateRange clamps rather than throwing.
        dateWindow: 'requested 2026-04-06 to 2026-04-24; actual coverage must come from tool lineage',
        availability: 'returned',
      },
      data: { results: 17 },
    })
    expect(answer.availability).toBe('available')
    expect(answer.text).toContain('Source roles')
    expect(answer.text).toContain('**Meta Results — 17**')
  })

  it('adds mandatory server-governed evidence without sending the private packet to Anthropic', async () => {
    const privateClaim = createMetricClaim({
      ...cockpitClaim(),
      claimId: 'server-required-claim',
      metricKey: 'tracking.private_marker',
      label: 'SERVER PRIVATE MARKER',
      value: 7,
    })
    state.closedThrough = '2026-04-24'
    state.gatherGovernedAudit.mockResolvedValueOnce({
      claims: [privateClaim],
      requiredClaimIds: [privateClaim.claimId],
      persistedFinalActionDecisions: [{
        id: 'server-decision-1', persisted: true, final: true,
        record_type: 'action_decisions', policy_version: 5,
        action_kind: 'observe', authority_tier: 'diagnostic_only',
        approval_state: 'not_requested', owner_copy: 'SERVER PRIVATE DECISION COPY',
        lineage: { source_kind: 'recommendation', source_id: 'rec-1' },
      }],
      consulted: [{ tool: 'get_reconciliation', args: {}, result: { available: true } }],
    })
    state.create.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'brief-1', name: 'submit_answer_brief', input: {
        summary: 'governed_claims', observations: [], action_decision_ids: [],
        unavailable_claim_ids: [], next_check: null,
      } }],
    })

    const answer = await runMaxxChat([{ role: 'user', content: 'Audit my tracking and scaling.' }])

    const providerRequest = JSON.stringify(state.create.mock.calls[0][0])
    expect(providerRequest).not.toContain('SERVER PRIVATE MARKER')
    expect(providerRequest).not.toContain('server-required-claim')
    expect(providerRequest).not.toContain('SERVER PRIVATE DECISION COPY')
    expect(answer.text).toContain('**SERVER PRIVATE MARKER — 7**')
    expect(answer.text).toContain('SERVER PRIVATE DECISION COPY')
    expect(answer.toolsUsed).toContain('get_reconciliation')
    expect(answer.brief).toMatchObject({
      observations: [{ claim_ids: ['server-required-claim'] }],
      action_decision_ids: ['server-decision-1'],
    })
  })

  it('renders mandatory server-governed evidence when the model never submits its empty wrapper', async () => {
    const privateClaim = createMetricClaim({
      ...cockpitClaim(),
      claimId: 'server-required-claim',
      metricKey: 'tracking.private_marker',
      label: 'SERVER PRIVATE MARKER',
      value: 7,
    })
    state.closedThrough = '2026-04-24'
    state.gatherGovernedAudit.mockResolvedValueOnce({
      claims: [privateClaim],
      requiredClaimIds: [privateClaim.claimId],
      persistedFinalActionDecisions: [],
      consulted: [{ tool: 'get_reconciliation', args: {}, result: { available: true } }],
    })
    state.create
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'The private marker is 999. Scale now.' }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Still answering in prose.' }],
      })

    const answer = await runMaxxChat([{ role: 'user', content: 'Audit my tracking and scaling.' }])

    expect(answer.availability).toBe('available')
    expect(answer.brief?.observations).toEqual([{ claim_ids: ['server-required-claim'] }])
    expect(answer.text).toContain('**SERVER PRIVATE MARKER — 7**')
    expect(answer.text).not.toContain('999')
    expect(answer.text).not.toContain('Scale now')
  })

  it('falls back to the mandatory server packet when a submitted brief exceeds render bounds', async () => {
    const required = createMetricClaim({
      ...cockpitClaim(),
      claimId: 'server-required-claim',
      metricKey: 'tracking.required_marker',
      label: 'SERVER REQUIRED MARKER',
      value: 7,
    })
    const optional = Array.from({ length: 17 }, (_, index) => ({
      ...cockpitClaim(),
      claimId: `optional-blocked-${index}`,
      metricKey: `tracking.optional_blocked_${index}`,
      label: `OPTIONAL BLOCKED ${index}`,
      value: null,
      availability: { state: 'unavailable' as const, blockerCodes: ['test_unavailable'] },
    }))
    state.closedThrough = '2026-04-24'
    state.gatherGovernedAudit.mockResolvedValueOnce({
      claims: [required],
      requiredClaimIds: [required.claimId],
      persistedFinalActionDecisions: [],
      consulted: [{ tool: 'get_reconciliation', args: {}, result: { available: true } }],
    })
    state.create
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'get_performance_cockpit', input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'brief-1', name: 'submit_answer_brief', input: {
          summary: 'governed_claims', observations: [], action_decision_ids: [],
          unavailable_claim_ids: optional.map((claim) => claim.claimId), next_check: null,
        } }],
      })
    state.execute.mockResolvedValue({ status: 'available', claims: optional })

    const answer = await runMaxxChat([{ role: 'user', content: 'Audit my tracking and scaling.' }])

    expect(answer.brief).not.toBeNull()
    expect(answer.text).toContain('**SERVER REQUIRED MARKER — 7**')
    expect(answer.text).not.toContain('OPTIONAL BLOCKED')
  })

  it('exposes the governed claim set beside the brief, for evaluation', async () => {
    const governedClaim = cockpitClaim()
    state.create
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'get_performance_cockpit', input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'brief-1', name: 'submit_answer_brief', input: {
          summary: 'governed_claims',
          observations: [{ claim_ids: [governedClaim.claimId] }],
          action_decision_ids: [], unavailable_claim_ids: [], next_check: null,
        } }],
      })
    state.execute.mockResolvedValue({ status: 'available', results: 17, claims: [governedClaim] })

    const answer = await runMaxxChat([{ role: 'user', content: 'How many results?' }])

    // A gate reading a cited claim's properties must read the GOVERNED claim. The predicate is checked
    // field-by-field against the server's own re-derivation, so a transcribed field can only be
    // byte-identical or a throw — it carries nothing the server does not already hold.
    expect(answer.claims.get('claim-results')).toEqual(governedClaim)
    expect(answer.brief).not.toBeNull()
  })

  it('drops claims the model never saw when the tool payload was truncated', async () => {
    // Claims used to be harvested from the RAW result before serialization, so an over-long payload
    // left the resolver holding the full set while the model received `{ truncated: true, preview }`
    // — a string, not JSON. Truncation flips availability to 'partial', which does NOT return early
    // (only 'unavailable' does), so the turn continued with the two sides disagreeing about what was
    // on offer, and evaluation would credit the model for claims it was never shown.
    const governedClaim = cockpitClaim()
    state.create
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'get_performance_cockpit', input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'brief-1', name: 'submit_answer_brief', input: {
          summary: 'governed_claims',
          observations: [{ claim_ids: [governedClaim.claimId] }],
          action_decision_ids: [], unavailable_claim_ids: [], next_check: null,
        } }],
      })
    // Big enough to blow MAX_TOOL_RESULT_CHARS (60,000).
    state.execute.mockResolvedValue({
      status: 'available',
      claims: [governedClaim],
      // Sized RELATIVE to the bound, not to a literal. This was `70_000`, chosen when the bound was
      // 60_000, so raising the bound to 100_000 left the payload comfortably under it and the test
      // silently stopped exercising truncation at all — it asserted a drop that no longer happened.
      // A fixture pinned to a constant's old value is a test that expires without saying so.
      filler: 'x'.repeat(MAX_TOOL_RESULT_CHARS + 10_000),
    })

    const answer = await runMaxxChat([{ role: 'user', content: 'How many results?' }])

    // The model cited a claim it could not have fully seen, so rendering fails and the answer is
    // withheld — fail-closed, rather than silently succeeding against a set it never received.
    expect(answer.claims.size).toBe(0)
    expect(answer.brief).toBeNull()
    expect(answer.text).toContain('withheld')
  })

  it('does not treat a tool result\'s OWN `truncated` field as a truncation signal', async () => {
    // The decision used to be read back out of `data.truncated`, but on the untruncated path `data`
    // IS the tool's result. A tool returning a top-level `truncated: true` would have had its claims
    // dropped although the model saw the whole payload — silently, since availability stays
    // 'returned'. No tool emits that field today, but acuity/ledger-health.ts carries `truncated` as
    // a domain field and the Acuity adapter lands next.
    const governedClaim = cockpitClaim()
    state.create
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'get_performance_cockpit', input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'brief-1', name: 'submit_answer_brief', input: {
          summary: 'governed_claims',
          observations: [{ claim_ids: [governedClaim.claimId] }],
          action_decision_ids: [], unavailable_claim_ids: [], next_check: null,
        } }],
      })
    state.execute.mockResolvedValue({
      status: 'available', claims: [governedClaim], truncated: true, results: 17,
    })

    const answer = await runMaxxChat([{ role: 'user', content: 'How many results?' }])

    expect(answer.claims.get('claim-results')).toEqual(governedClaim)
    expect(answer.brief).not.toBeNull()
    expect(answer.availability).toBe('available')
  })

  it('withholds a completed free-form numeric answer that is not a structured brief', async () => {
    state.create
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Spend was $963.40.' }] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Spend was $963.40.' }] })

    const answer = await runMaxxChat([{ role: 'user', content: 'What was spend?' }])

    expect(answer.availability).toBe('unavailable')
    expect(answer.text).not.toContain('$963.40')
    // No lookup ran, so this is the model failing on its own terms — NOT a claim-supply gap. The two
    // are reported differently on purpose; see the next test.
    expect(answer.text).toMatch(/did not come back in the governed format/i)
    expect(answer.text).not.toMatch(/publish a citable governed claim/i)
  })

  it('does NOT blame claim supply when claims were harvested and the model answered in prose', () => {
    // The other half of the condition. Mutation testing removed `claimsById.size === 0` and nothing
    // failed, because no case existed where a tool ran, claims WERE harvested, and the answer was
    // still unusable. Without this, mislabelling in the opposite direction — a genuine model failure
    // reported as "our claim-supply gap" — is unguarded.
    state.create
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'get_performance_cockpit', input: {} }],
      })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Spend was $963.40.' }] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Spend was $963.40.' }] })
    state.execute.mockResolvedValue({ status: 'available', claims: [cockpitClaim()] })

    return runMaxxChat([{ role: 'user', content: 'What was spend?' }]).then((answer) => {
      expect(answer.availability).toBe('unavailable')
      expect(answer.text).not.toContain('$963.40')
      expect(answer.text).toMatch(/did not come back in the governed format/i)
      expect(answer.text).not.toMatch(/none of those publish a citable governed claim/i)
    })
  })

  it('does not call a claim-emitting tool a claim-supply gap when it returns nothing', async () => {
    // A cockpit call that yields no claims is an INTERNAL evidence failure (truncated payload, or a
    // claim set that did not parse — both swallowed silently). Reporting it as "these tools publish
    // no citable claims" states a false cause about our own coverage.
    state.create
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'get_performance_cockpit', input: {} }],
      })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Spend was $99.' }] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Spend was $99.' }] })
    state.execute.mockResolvedValue({ status: 'available', claims: [] })

    const answer = await runMaxxChat([{ role: 'user', content: 'What was spend?' }])

    expect(answer.availability).toBe('unavailable')
    expect(answer.text).toMatch(/internal evidence failure/i)
    expect(answer.text).not.toMatch(/none of those publish a citable governed claim/i)
  })

  async function systemPromptFor(iso: string, closedThrough: string | null): Promise<string> {
    state.closedThrough = closedThrough
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date(iso))
    // Two turns: the prose answer, then the one explicit request to submit that now precedes a
    // withheld verdict. Only the FIRST call's system prompt is read.
    state.create
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not a brief' }] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'still not a brief' }] })
    await runMaxxChat([{ role: 'user', content: 'How much did I spend?' }])
    vi.useRealTimers()
    return state.create.mock.calls[0][0].system[0].text as string
  }

  it.each([
    ['2026-08-24T12:00:00Z', '2026-08-22', 'a mid-month day, sync one day behind the calendar'],
    ['2026-08-31T12:00:00Z', '2026-08-30', 'the last day of a month'],
    ['2028-02-29T12:00:00Z', '2028-02-28', 'a leap day'],
    ['2026-11-02T12:00:00Z', '2026-11-01', 'a DST fall-back boundary'],
  ])('states the month through the WAREHOUSE boundary on %s (%s)', async (iso, closed) => {
    // The clock is DRIVEN and the warehouse boundary is SUPPLIED. The first version read the real
    // clock and wrapped its assertion in `if (stated)`, so it asserted nothing on any day but the 1st
    // — and on the 1st the old buggy code emitted the word "yesterday", failing the regex anyway.
    const system = await systemPromptFor(iso, closed)
    const today = new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

    expect(system).toContain(`TODAY IS ${today}`)
    // The floor is a VALUE, not a shape: asserting only /\d{4}-\d{2}-\d{2}/ let 89 survive, which is
    // one day inside the real floor of addDays(lastClosedDate, -89) = today-90.
    const floor = new Date(new Date(iso).getTime() - 90 * 86_400_000)
      .toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    expect(system).toContain(`no earlier than ${floor}`)

    // The month must end at the SYNCED day, never at the calendar day.
    expect(system).toContain(`closed through ${closed}`)
    const stated = /"this month" means (\d{4}-\d{2}-\d{2}) through (\d{4}-\d{2}-\d{2})/.exec(system)
    expect(stated).not.toBeNull()
    expect(stated![2]).toBe(closed)
    expect(stated![1] <= stated![2]).toBe(true)
    expect(system).not.toContain(today.slice(0, 10) === closed ? '\u0000never' : `through ${today}`)
  })

  it('refuses the framing when the month has no synced days yet', async () => {
    // The 1st, before that month's first sync. `resolveClosedDateRange` does NOT reject a start after
    // the end — it clamps start down and returns a single day of the PREVIOUS month with no refusal.
    const system = await systemPromptFor('2026-09-01T12:00:00Z', '2026-08-31')
    expect(system).toMatch(/has NO fully-synced days yet/i)
    expect(system).toContain('2026-08-31')
    expect(/"this month" means/.test(system)).toBe(false)
  })

  it('excludes today\'s partial manual-sync row from the owner audit and prompt', async () => {
    state.closedThroughCandidates = ['2026-08-27', '2026-08-25']
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-08-27T16:00:00Z'))
    state.create
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not a brief' }] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'still not a brief' }] })

    await runMaxxChat([{ role: 'user', content: 'Audit my tracking and scaling.' }])

    expect(state.gatherGovernedAudit).toHaveBeenCalledWith({
      question: 'Audit my tracking and scaling.',
      closedThrough: '2026-08-25',
    })
    const system = state.create.mock.calls[0][0].system[0].text as string
    expect(system).toContain('closed through 2026-08-25')
    expect(system).not.toContain('closed through 2026-08-27')
  })

  it('says the boundary is UNKNOWN rather than substituting the calendar', async () => {
    // Before a day's sync the calendar says data is closed through yesterday, the warehouse holds only
    // the day before, and a cockpit call ending yesterday returns every claim with ZERO available
    // (`meta_account_spend_day_missing:<yesterday>`). Guessing a boundary sends the
    // model at a window every claim refuses; saying it is unknown does not.
    const system = await systemPromptFor('2026-08-24T12:00:00Z', null)
    expect(system).toMatch(/could not be determined/i)
    expect(system).toMatch(/do not assume one/i)
    expect(/"this month" means/.test(system)).toBe(false)
    expect(system).not.toMatch(/closed through \d{4}-\d{2}-\d{2}/)
  })

  it('CONSTRAINS the retry to the brief schema, rather than politely asking for it', async () => {
    // The mechanism two comments and a commit message credited for turning a 4/4 live failure rate
    // into determinism — and which was never written. `rg tool_choice src/` returned two hits, both
    // comments. What shipped was a plain-English nudge the model can decline exactly as it declined
    // the original instruction. This asserts the REQUEST, so the claim cannot outrun the code again.
    //
    // the retry used to force the tool (`tool_choice: { type: 'tool' }`). Claude Opus 5.5
    // rejects forced tool choice with a 400, so the retry now constrains the REPLY instead: the
    // brief's JSON schema as structured output, with tool calls switched off for that one request.
    state.create
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'You spent a lot.' }] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'You spent a lot.' }] })
    await runMaxxChat([{ role: 'user', content: 'What was spend?' }])

    expect(state.create).toHaveBeenCalledTimes(2)
    // First turn: free choice, but never two tools at once.
    expect(state.create.mock.calls[0][0].tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true })
    expect(state.create.mock.calls[0][0].output_config?.format).toBeUndefined()
    // Retry: the brief is REQUIRED, as the shape of the reply.
    const retry = state.create.mock.calls[1][0]
    expect(retry.tool_choice).toEqual({ type: 'none' })
    expect(retry.output_config.format.type).toBe('json_schema')
    const schema = retry.output_config.format.schema
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties).sort()).toEqual([
      'action_decision_ids', 'next_check', 'observations', 'summary', 'unavailable_claim_ids',
    ])
    expect(schema.properties.summary).toEqual({ type: 'string', enum: ['governed_claims'] })
    // The tool list is unchanged on the retry, so the cached prefix and thinking blocks stay valid.
    expect(retry.tools).toEqual(state.create.mock.calls[0][0].tools)
  })

  it('never sends a forced tool choice, which Claude Opus 5.5 rejects with a 400', async () => {
    const governedClaim = cockpitClaim()
    state.create
      .mockResolvedValueOnce({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'get_performance_cockpit', input: {} }] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Prose.' }] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Prose again.' }] })
    state.execute.mockResolvedValue({ status: 'available', claims: [governedClaim] })
    await runMaxxChat([{ role: 'user', content: 'What was spend?' }])

    expect(state.create).toHaveBeenCalledTimes(3)
    for (const call of state.create.mock.calls) {
      expect(['auto', 'none']).toContain(call[0].tool_choice.type)
      // Sampling and thinking controls the current models reject are never sent either.
      for (const key of ['temperature', 'top_p', 'top_k', 'thinking']) expect(call[0]).not.toHaveProperty(key)
    }
  })

  it('accepts the brief returned as structured output on the retry', async () => {
    const governedClaim = cockpitClaim()
    state.create
      .mockResolvedValueOnce({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'get_performance_cockpit', input: {} }] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'You spent $1,057.30.' }] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
        summary: 'governed_claims', observations: [{ claim_ids: [governedClaim.claimId] }],
        action_decision_ids: [], unavailable_claim_ids: [], next_check: null,
      }) }] })
    state.execute.mockResolvedValue({ status: 'available', claims: [governedClaim] })

    const answer = await runMaxxChat([{ role: 'user', content: 'What was spend?' }])

    expect(answer.availability).toBe('available')
    expect(answer.brief).toMatchObject({ observations: [{ claim_ids: [governedClaim.claimId] }] })
    expect(answer.text).toContain('**Meta Results — 17**')
    expect(answer.text).not.toContain('1,057.30')
  })

  it('still validates a structured-output brief with zod: an unknown claim id is withheld', async () => {
    const governedClaim = cockpitClaim()
    state.create
      .mockResolvedValueOnce({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'get_performance_cockpit', input: {} }] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Prose.' }] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
        summary: 'governed_claims', observations: [{ claim_ids: ['invented-claim-id'] }],
        action_decision_ids: [], unavailable_claim_ids: [], next_check: null,
      }) }] })
    state.execute.mockResolvedValue({ status: 'available', claims: [governedClaim] })

    const answer = await runMaxxChat([{ role: 'user', content: 'What was spend?' }])

    expect(answer.availability).toBe('unavailable')
    expect(answer.text).not.toContain('invented-claim-id')
  })

  it('withholds a REFUSAL on the retry as a refusal, never as text', async () => {
    state.create
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Prose.' }] })
      .mockResolvedValueOnce({
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: null },
        content: [{ type: 'text', text: '{"summary":"governed_claims","LEAK":"$7,777"}' }],
      })

    const answer = await runMaxxChat([{ role: 'user', content: 'What was spend?' }])

    expect(answer.availability).toBe('unavailable')
    expect(answer.text).toMatch(/declined/i)
    expect(answer.text).not.toMatch(/7,777|LEAK/)
  })

  it('withholds a max-token stop as incomplete', async () => {
    state.create.mockResolvedValueOnce({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Spend was $5,' }] })

    const answer = await runMaxxChat([{ role: 'user', content: 'What was spend?' }])

    expect(answer.availability).toBe('unavailable')
    expect(answer.text).toMatch(/incomplete/i)
    expect(answer.text).not.toContain('$5,')
  })

  it('sends the configured model, room for thinking, and a timeout inside the route budget', async () => {
    state.create.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] })
    await runMaxxChat([{ role: 'user', content: 'What was spend?' }])

    const [params, options] = state.create.mock.calls[0]
    expect(params.model).toBe('claude-opus-5-5')
    // Thinking is always on for Claude Opus 5.5 and counts toward max_tokens: 2048 was sized for
    // a model that did not think.
    expect(params.max_tokens).toBeGreaterThanOrEqual(16_000)
    expect(options.timeout).toBeGreaterThan(0)
    expect(options.timeout).toBeLessThanOrEqual(55_000)
  })

  it('with AI off answers "AI is off" without any model call or account read', async () => {
    useAiEnv({ AI_PROVIDER: 'none' })

    const answer = await runMaxxChat([{ role: 'user', content: 'What was spend?' }])

    expect(answer.availability).toBe('unavailable')
    expect(answer.text).toMatch(/AI is off/i)
    expect(state.create).not.toHaveBeenCalled()
    expect(state.gatherGovernedAudit).not.toHaveBeenCalled()
    expect(state.execute).not.toHaveBeenCalled()
  })

  it('forbids a submission sharing a turn with an account lookup', async () => {
    // `disable_parallel_tool_use` on every non-retry turn. Without it the model can emit a brief AND a
    // lookup together; the loop returned on the brief and the lookup was never executed, never
    // appeared in `toolsUsed`, never contributed evidence — so any claim id the model expected from
    // it failed to resolve, and the answer under-reported what it had consulted.
    state.create.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't1', name: 'get_performance_cockpit', input: {} }],
    }).mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'b1', name: 'submit_answer_brief', input: {
        summary: 'governed_claims', observations: [], action_decision_ids: [],
        unavailable_claim_ids: [], next_check: null,
      } }],
    })
    state.execute.mockResolvedValue({ status: 'available', claims: [cockpitClaim()] })
    await runMaxxChat([{ role: 'user', content: 'What was spend?' }])

    for (const call of state.create.mock.calls) {
      const choice = call[0].tool_choice
      if (choice.type === 'auto') expect(choice.disable_parallel_tool_use).toBe(true)
    }
  })

  it('accepts NO brief when two arrive in one turn, instead of silently picking one', async () => {
    // `.find` took the first and discarded the rest in silence, so a turn carrying an empty brief and
    // a valid one was withheld while the valid one sat unread in the same message.
    const governedClaim = cockpitClaim()
    state.create.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'b1', name: 'submit_answer_brief', input: { summary: 'nope' } },
        { type: 'tool_use', id: 'b2', name: 'submit_answer_brief', input: {
          summary: 'governed_claims', observations: [{ claim_ids: [governedClaim.claimId] }],
          action_decision_ids: [], unavailable_claim_ids: [], next_check: null,
        } },
      ],
    })

    const answer = await runMaxxChat([{ role: 'user', content: 'What was spend?' }])

    expect(answer.availability).toBe('unavailable')
    expect(answer.text).toMatch(/arrived more than once/i)
  })

  it('does not blame the lookup budget when the LAST round answers in prose', async () => {
    // Prose on the final round set the retry flag, `continue`d, exited the loop, and returned "That
    // question exceeded the governed lookup limit" — a cause that was not the cause, with the retry
    // request queued into `messages` and never sent and the claim-supply discrimination skipped.
    for (let round = 0; round < 6; round += 1) {
      state.create.mockResolvedValueOnce(round < 5
        ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${round}`, name: 'get_outcome_bookings', input: {} }] }
        : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'You had 42 bookings.' }] })
    }
    state.execute.mockResolvedValue({ status: 'available', bookings: 42 })

    const answer = await runMaxxChat([{ role: 'user', content: 'How many bookings?' }])

    expect(answer.availability).toBe('unavailable')
    expect(answer.text).not.toMatch(/exceeded the governed lookup limit/i)
    // The real cause: none of the tools consulted publish a citable claim.
    expect(answer.text).toMatch(/server produced no citable governed claim/i)
  })

  it('names the claim-supply gap when a CITATION fails on a plane with no supply', async () => {
    // The commit's own motivating example routed around the discrimination: the model invents a
    // plausible Acuity id because no Acuity claims exist, `resolveClaim` throws, and the reader was
    // told "you cited evidence that does not match the governed record" — naming the model for our
    // own coverage gap.
    state.create.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't1', name: 'get_outcome_bookings', input: {} }],
    }).mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'b1', name: 'submit_answer_brief', input: {
        summary: 'governed_claims',
        observations: [{ claim_ids: ['acuity:2026-07-06:2026-07-27:confirmed_appointments:63'] }],
        action_decision_ids: [], unavailable_claim_ids: [], next_check: null,
      } }],
    })
    state.execute.mockResolvedValue({ status: 'available', bookings: 63 })
    // The answer prints the tool's observed-at time. Left on the live clock, any instant whose digits
    // contain "63" (e.g. ".163Z") failed the leak assertion below for reasons unrelated to the leak.
    // Pin it to an instant with no "63" so the assertion measures only the invented value.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-28T12:00:00.000Z'))

    const answer = await runMaxxChat([{ role: 'user', content: 'How many bookings?' }])

    expect(answer.availability).toBe('unavailable')
    expect(answer.text).toMatch(/server produced no citable governed claim/i)
    // The pin took effect: the only clock-derived text is the pinned instant.
    expect(answer.text).toContain('tool response observed 2026-07-28T12:00:00.000Z')
    expect(answer.text).not.toContain('63')
  })

  it('OFFERS the brief tool to the model, or nothing can ever be submitted', async () => {
    // The mechanism dies silently without this: the model cannot call a tool it was not given, every
    // answer falls to prose, and every answer is withheld. Removing the roster line was the one
    // mutation the rest of this file did not catch, because these tests construct their own tool_use
    // blocks rather than reading what was offered.
    state.create.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] })
    await runMaxxChat([{ role: 'user', content: 'What was spend?' }])

    const offered = state.create.mock.calls[0][0].tools as Array<{ name: string; input_schema: unknown }>
    const brief = offered.find((tool) => tool.name === 'submit_answer_brief')
    expect(brief).toBeDefined()

    // And its schema must actually constrain the brief, not be an open object.
    const schema = brief!.input_schema as { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      'action_decision_ids', 'next_check', 'observations', 'summary', 'unavailable_claim_ids',
    ])
    expect(schema.required).toContain('observations')
  })

  it('asks ONCE for a submission when the model answers in prose, and accepts it', async () => {
    // The forced-retry path. Raw JSON in an assistant turn failed 4/4 live with claims available and
    // the window correct; the brief is a tool input now, and a prose turn earns one explicit request
    // to submit rather than discarding the turn's work.
    const governedClaim = cockpitClaim()
    state.create
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'get_performance_cockpit', input: {} }],
      })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'You spent $1,057.30.' }] })
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'brief-1', name: 'submit_answer_brief', input: {
          summary: 'governed_claims',
          observations: [{ claim_ids: [governedClaim.claimId] }],
          action_decision_ids: [], unavailable_claim_ids: [], next_check: null,
        } }],
      })
    state.execute.mockResolvedValue({ status: 'available', claims: [governedClaim] })

    const answer = await runMaxxChat([{ role: 'user', content: 'What was spend?' }])

    expect(answer.availability).toBe('available')
    expect(answer.brief).not.toBeNull()
    // The prose numbers never reach the reader: the server renders from the claim.
    expect(answer.text).toContain('**Meta Results — 17**')
    const askedFor = state.create.mock.calls[2][0].messages.at(-1)
    expect(askedFor.role).toBe('user')
    expect(askedFor.content).toContain('submit_answer_brief')
  })

  it('asks only once — a second prose turn is withheld, not retried forever', async () => {
    state.create
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Spend was $963.40.' }] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Spend was $963.40.' }] })

    const answer = await runMaxxChat([{ role: 'user', content: 'What was spend?' }])

    expect(state.create).toHaveBeenCalledTimes(2)
    expect(answer.availability).toBe('unavailable')
    expect(answer.text).not.toContain('$963.40')
  })

  it('never runs the brief tool as an account lookup, or counts it as one', async () => {
    // It is a sink. Executing it would 404 in `executeTool`; counting it in `toolsUsed` would make
    // `noClaimSupplyMessage` list it as a lookup that publishes no claims.
    state.create.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'brief-1', name: 'submit_answer_brief', input: {
        summary: 'governed_claims', observations: [], action_decision_ids: [],
        unavailable_claim_ids: [], next_check: null,
      } }],
    })

    const answer = await runMaxxChat([{ role: 'user', content: 'What was spend?' }])

    expect(state.execute).not.toHaveBeenCalled()
    expect(answer.toolsUsed).not.toContain('submit_answer_brief')
  })

  it('reports a claim-supply gap as OUR gap, naming the tools that carry no claims', async () => {
    // 42 of the 43 read-only lookups publish no MetricClaim, so a question that routes to any of them
    // has nothing citable however well it is answered. That used to surface as "the response was not
    // a structured governed answer" — our missing coverage, reported as the model's failure, on the
    // one surface where the reader could otherwise learn which plane has no evidence behind it.
    state.create
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'get_outcome_bookings', input: {} }],
      })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'You had 42 bookings.' }] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'You had 42 bookings.' }] })
    state.execute.mockResolvedValue({ status: 'available', bookings: 42 })

    const answer = await runMaxxChat([{ role: 'user', content: 'How many bookings?' }])

    expect(answer.availability).toBe('unavailable')
    expect(answer.text).not.toContain('42 bookings')
    expect(answer.text).toMatch(/server produced no citable governed claim/i)
    expect(answer.text).toContain('get outcome bookings')
    expect(answer.text).toMatch(/internal evidence failure/i)
  })

  it('does not promote an action id returned by a diagnostic tool', async () => {
    state.create
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'get_account_summary', input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'brief-1', name: 'submit_answer_brief', input: {
          summary: 'governed_claims',
          observations: [],
          action_decision_ids: ['diagnostic-injected-action'],
          unavailable_claim_ids: [],
          next_check: null,
        } }],
      })
    state.execute.mockResolvedValue({
      status: 'available',
      action_decision_ids: ['diagnostic-injected-action'],
    })

    const answer = await runMaxxChat([{ role: 'user', content: 'What should I do?' }])

    expect(answer.availability).toBe('unavailable')
    expect(answer.text).not.toContain('diagnostic-injected-action')
  })

  it('aborts on a tool failure and never asks the model to interpret partial evidence', async () => {
    state.create.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tool-1', name: 'get_account_summary', input: {} }],
    })
    state.execute.mockRejectedValueOnce(new Error('database password and internal stack'))

    const answer = await runMaxxChat([{ role: 'user', content: 'How are the ads doing?' }])

    expect(state.create).toHaveBeenCalledTimes(1)
    expect(answer.availability).toBe('unavailable')
    expect(answer.text).toMatch(/governed account lookup failed/i)
    expect(answer.text).not.toMatch(/password|internal stack/i)
    expect(answer.evidence).toEqual([
      expect.objectContaining({ tool: 'get_account_summary', availability: 'unavailable' }),
    ])
  })

  it('sanitizes provider failures into an unavailable result', async () => {
    state.create.mockRejectedValueOnce(new Error('401 invalid secret sk-live-example'))

    const answer = await runMaxxChat([{ role: 'user', content: 'hello' }])

    expect(answer).toMatchObject({
      availability: 'unavailable',
      toolsUsed: [],
      evidence: [],
    })
    expect(answer.text).toMatch(/language-model provider is unavailable/i)
    expect(answer.text).not.toMatch(/401|secret|sk-live/i)
  })

  it('fails closed on an incomplete or unexpected provider stop', async () => {
    state.create.mockResolvedValueOnce({
      stop_reason: 'refusal',
      content: [{ type: 'text', text: 'Spend was $9,999 from memory.' }],
    })

    const answer = await runMaxxChat([{ role: 'user', content: 'What was spend?' }])

    expect(answer.availability).toBe('unavailable')
    expect(answer.text).toMatch(/did not complete a governed answer/i)
    expect(answer.text).not.toContain('$9,999')
  })
  /**
   * The forced-submission retry made an EMPTY brief the path of least resistance.
   *
   * `tool_choice: { type: 'tool' }` compels `submit_answer_brief`. For any question needing a plane
   * with no claim supply — 42 of the 43 read-only lookups — three empty arrays are the only
   * submission that satisfies the schema, and `renderAnswerBrief` turns that into the single sentence
   * "Governed evidence is shown below." Before this guard, `runMaxxChat` returned it as
   * `availability: 'available'`: a heading over an empty page, presented as a verified answer, on the
   * exact surface built to make that impossible. The mechanism added to stop the model answering in
   * PROSE converted the honest supply-gap refusal into a content-free success.
   */
  it('withholds a brief that cites nothing, and says which plane had no claim supply', async () => {
    state.create
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'get_outcome_bookings', input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'brief-1', name: 'submit_answer_brief', input: {
          summary: 'governed_claims',
          observations: [], action_decision_ids: [], unavailable_claim_ids: [], next_check: null,
        } }],
      })
    state.execute.mockResolvedValue({ status: 'available', bookings: 56 })

    const answer = await runMaxxChat([{ role: 'user', content: 'How many appointments did we book?' }])

    expect(answer.availability).toBe('unavailable')
    expect(answer.text).not.toBe('Governed evidence is shown below.')
    expect(answer.text).not.toContain('Governed evidence is shown below')
    // Routed through the discrimination, so the reader learns the CAUSE rather than a generic refusal.
    expect(answer.text).toMatch(/server produced no citable governed claim/i)
    expect(answer.text).toMatch(/get outcome bookings/i)
  })

  it('withholds an empty brief even when governed claims WERE available to cite', async () => {
    // The other half of the discrimination: claim supply existed and the model cited none of it. That
    // is not a coverage gap, so it must not be reported as one.
    const governedClaim = cockpitClaim()
    state.create
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'get_performance_cockpit', input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'brief-1', name: 'submit_answer_brief', input: {
          summary: 'governed_claims',
          observations: [], action_decision_ids: [], unavailable_claim_ids: [], next_check: null,
        } }],
      })
    state.execute.mockResolvedValue({ status: 'available', results: 17, claims: [governedClaim] })

    const answer = await runMaxxChat([{ role: 'user', content: 'How many results?' }])

    expect(answer.availability).toBe('unavailable')
    expect(answer.text).toMatch(/cited no governed evidence at all/i)
    expect(answer.text).not.toMatch(/server produced no citable governed claim/i)
  })

  it('a brief citing ONLY unavailable claims is still an answer, not an empty one', async () => {
    // The guard must key on "cites nothing", not on "has no observations". Declaring what could not
    // be measured is what the contract asks for; swallowing it would delete the honest answer.
    const blocked = { ...cockpitClaim(), claimId: 'claim-blocked', value: null,
      availability: { state: 'unavailable' as const, blockerCodes: ['no_paid_join'] } }
    state.create
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'get_performance_cockpit', input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'brief-1', name: 'submit_answer_brief', input: {
          summary: 'governed_claims',
          observations: [], action_decision_ids: [],
          unavailable_claim_ids: ['claim-blocked'], next_check: null,
        } }],
      })
    state.execute.mockResolvedValue({ status: 'available', claims: [blocked] })

    const answer = await runMaxxChat([{ role: 'user', content: 'What is the paid CPA?' }])

    expect(answer.availability).toBe('available')
    expect(answer.text).toContain('**Unavailable**')
    expect(answer.text).toContain('blocked by: no_paid_join')
  })
})
