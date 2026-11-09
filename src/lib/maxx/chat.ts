import 'server-only'
import {
  aiStatus, completeTurn, parseJsonAnswer,
  type AiMessage, type AiResponse, type AiToolDefinition, type AiToolResult,
} from '@/lib/ai'
import { MAXX_CHAT_SYSTEM } from '@/mcp/instructions'
import { READ_ONLY_TOOL_DEFINITIONS, executeTool, WRITE_TOOLS } from '@/mcp/tools/index'
import {
  normalizeAnswerBriefValue, parseAnswerBriefClaims, parsePersistedFinalActionDecisionEvidence,
  renderAnswerBrief, type AnswerBrief, type AnswerBriefClaim, type PersistedFinalActionDecisionEvidence,
} from '@/lib/maxx/answer-brief'
import { gatherGovernedAuditEvidence } from '@/lib/maxx/governed-audit-runtime'
import {
  ANSWER_BRIEF_OUTPUT_FORMAT, ANSWER_BRIEF_RETRY_PROMPT, ANSWER_BRIEF_TOOL, ANSWER_BRIEF_TOOL_DEFINITION,
} from '@/lib/maxx/answer-brief-submission'
import {
  MAX_TOOL_RESULT_CHARS, buildGovernedToolEvidence, safeToolName, serializeGovernedToolResultWithMeta,
  type MaxxToolEvidence,
} from '@/lib/maxx/chat-evidence'
import {
  MAXX_ANSWER_BRIEF_CONTRACT, MAXX_CHAT_MEASUREMENT_GOVERNANCE, governMaxxAnswer,
} from '@/lib/maxx/chat-governance'
import type { ChatTurn, MaxxChatResult } from '@/lib/maxx/chat-types'
import { CHAT_ACTION_NAMES, CHAT_ACTION_TOOL_DEFINITIONS, MAXX_CHAT_ACTIONS_CONTRACT, runChatActionTurn } from '@/lib/maxx/chat-actions'
import {
  errorText, noClaimSupplyMessage, persistedFinalActionDecisionsFromToolResult, todayContext,
  warehouseClosedThrough,
} from '@/lib/maxx/chat-turn-context'

export { ANSWER_BRIEF_OUTPUT_FORMAT, ANSWER_BRIEF_TOOL, ANSWER_BRIEF_TOOL_DEFINITION }
// The public surface is unchanged: these moved into cohesive sibling modules and are re-exported here.
export {
  MAX_TOOL_RESULT_CHARS, buildGovernedToolEvidence, safeToolName, serializeGovernedToolResult,
  serializeGovernedToolResultWithMeta,
  type MaxxEvidenceAvailability, type MaxxEvidenceSource, type MaxxToolEvidence,
} from '@/lib/maxx/chat-evidence'
export {
  MAXX_ANSWER_BRIEF_CONTRACT, MAXX_CHAT_MEASUREMENT_GOVERNANCE, governMaxxAnswer, type MaxxAnswerOrigin,
} from '@/lib/maxx/chat-governance'
export type { ChatTurn, MaxxChatResult } from '@/lib/maxx/chat-types'

// Six tool rounds keep one browser request bounded while leaving room for the core diagnosis bundle
// plus focused follow-up reads. Narrower questions can continue in a new, separately limited request.
const MAX_TOOL_ROUNDS = 6
/** Thinking is always on for Claude Opus 5.5 and counts toward max_tokens; 2048 was sized for none. */
const CHAT_MAX_TOKENS = 16_000
/** The route's `maxDuration` is 60s for the whole turn; stop before the platform kills it. */
const CHAT_TURN_BUDGET_MS = 55_000
const CHAT_ROUND_TIMEOUT_MS = 45_000
/** Below this, another model round cannot finish inside the turn budget. */
const CHAT_MIN_ROUND_MS = 3_000

function maxxChatFlagOn(): boolean {
  return process.env.MAXX_CHAT_ENABLED === 'true'
}

/** The chat kill switch AND a configured AI provider: with AI off there is nothing to chat with. */
export function maxxChatEnabled(): boolean {
  return maxxChatFlagOn() && aiStatus().state === 'on'
}

const CLAIM_EMITTING_TOOLS = new Set(['get_performance_cockpit'])

function claimsFromToolResult(tool: string, result: unknown): AnswerBriefClaim[] {
  // A `claims` property in arbitrary tool payload is untrusted content. Only the cockpit adapter
  // deliberately emits the MetricClaim contract consumed by AnswerBrief rendering.
  if (!CLAIM_EMITTING_TOOLS.has(tool)) return []
  if (!result || typeof result !== 'object' || Array.isArray(result)) return []
  try {
    return parseAnswerBriefClaims((result as Record<string, unknown>).claims)
  } catch {
    return []
  }
}

// Map the MCP tool defs (inputSchema) to the gateway tool shape (input_schema). Read-only tools only.
// The brief tool is appended; its contract lives in answer-brief-submission.ts.
const CHAT_TOOLS: AiToolDefinition[] = READ_ONLY_TOOL_DEFINITIONS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.inputSchema as Record<string, unknown>,
}))
CHAT_TOOLS.push(ANSWER_BRIEF_TOOL_DEFINITION)

function unavailableResult(
  message: string,
  toolsUsed: string[],
  evidence: MaxxToolEvidence[],
): MaxxChatResult {
  return {
    // Every string reaching here is a literal composed in this file.
    text: governMaxxAnswer(message, evidence, 'server_composed'),
    toolsUsed: [...new Set(toolsUsed)],
    evidence,
    availability: 'unavailable',
    brief: null,
    claims: new Map(),
    actionDecisions: new Map(),
  }
}

/** `ownerUserId`: the signed-in owner. Only with it are the owner actions (ADR-062) offered. */
export async function runMaxxChat(history: ChatTurn[], options: { ownerUserId?: string } = {}): Promise<MaxxChatResult> {
  if (!maxxChatFlagOn()) {
    return unavailableResult(
      'Maxx chat is disabled. The account diagnostics remain read-only.',
      [],
      [],
    )
  }
  const ai = aiStatus()
  if (ai.state !== 'on') {
    return unavailableResult(
      ai.state === 'off'
        ? 'AI is off (AI_PROVIDER=none or no AI provider configured), so Maxx chat cannot answer. The governed data pages still work.'
        : "Maxx's language-model provider is not configured correctly, so I cannot verify an answer right now. The governed data pages still work.",
      [],
      [],
    )
  }
  const turnDeadline = Date.now() + CHAT_TURN_BUDGET_MS
  // Read once per turn, before the loop: the boundary cannot move mid-conversation and a per-round
  // read would be three identical queries.
  const closedThrough = await warehouseClosedThrough()

  const messages: AiMessage[] = history.map((m): AiMessage => (m.role === 'user'
    ? { role: 'user', text: m.content }
    : { role: 'assistant', text: m.content, toolCalls: [] }))
  const toolsUsed: string[] = []
  const evidence: MaxxToolEvidence[] = []
  const claimsById = new Map<string, AnswerBriefClaim>()
  const actionDecisionsById = new Map<string, PersistedFinalActionDecisionEvidence>()
  const requiredClaimIds = new Set<string>()

  // These reads stay inside the application server. Only bounded provenance metadata is retained in
  // `evidence`; raw results and the derived claim packet are never appended to model messages.
  const latestQuestion = [...history].reverse().find((turn) => turn.role === 'user')?.content ?? ''
  const governedAudit = await gatherGovernedAuditEvidence({
    question: latestQuestion,
    closedThrough,
  })
  for (const lookup of governedAudit.consulted) {
    toolsUsed.push(safeToolName(lookup.tool))
    evidence.push(buildGovernedToolEvidence(lookup))
  }
  for (const claim of governedAudit.claims) claimsById.set(claim.claimId, claim)
  for (const id of governedAudit.requiredClaimIds) requiredClaimIds.add(id)
  try {
    for (const decision of parsePersistedFinalActionDecisionEvidence(
      governedAudit.persistedFinalActionDecisions,
    )) {
      actionDecisionsById.set(decision.id, decision)
    }
  } catch {
    console.warn('[MaxxChat] Internal governed decisions were invalid and were not admitted.')
  }

  // Set once the model has been told to submit; a second prose turn is a real failure, not a slip.
  let forcedSubmission = false
  const tools = options.ownerUserId ? [...CHAT_TOOLS, ...CHAT_ACTION_TOOL_DEFINITIONS] : CHAT_TOOLS
  const actionsContract = options.ownerUserId ? `\n\n${MAXX_CHAT_ACTIONS_CONTRACT}` : ''

  /**
   * Render a submitted brief, or explain precisely why it could not be rendered.
   *
   * The three failures below used to share one bare catch and one sentence blaming the model. They
   * need different responses from a reader, and only one of them is the model's fault:
   *   • NO CLAIM SUPPLY — neither the internal governed gather nor a model-requested claim-emitting
   *     tool produced a citable claim. Reporting that as a model failure is a lie about our read.
   *   • SCHEMA — the submission did not satisfy the brief contract.
   *   • CITATION — it conformed but named a claim the governed set does not contain, or filed an
   *     available claim as unavailable.
   */
  /**
   * Why no governed answer was produced — named, not blamed on the model by default.
   *
   * Reached from BOTH failing paths: a submission that does not satisfy the contract, and a model
   * that answered in prose even after being asked to submit. The second is the common one, so routing
   * only the first through this discrimination would have made the supply-gap message unreachable in
   * practice while still passing its unit test.
   */
  const withheldBecause = (fallback: string): MaxxChatResult => {
    // `claimsById` includes both server-gathered claims and claims harvested from model-requested
    // claim-emitting tools. Only discriminate between those model tools when both sources yielded
    // nothing; otherwise preserve the path-specific failure below.
    if (claimsById.size === 0) {
      const claimEmittingConsulted = toolsUsed.some((tool) => CLAIM_EMITTING_TOOLS.has(tool))
      if (toolsUsed.length > 0 && !claimEmittingConsulted) {
        return unavailableResult(noClaimSupplyMessage(toolsUsed), toolsUsed, evidence)
      }
      if (claimEmittingConsulted) {
        return unavailableResult(
          'A governed lookup that does publish citable claims returned none this time, so there was '
          + 'nothing to cite and the answer was withheld. This is an internal evidence failure, not a '
          + 'limit of your account data.',
          toolsUsed,
          evidence,
        )
      }
    }
    return unavailableResult(fallback, toolsUsed, evidence)
  }

  const finishWithBrief = (submitted: unknown): MaxxChatResult => {
    let brief: AnswerBrief
    try {
      brief = normalizeAnswerBriefValue(
        submitted,
        claimsById,
        [...requiredClaimIds],
        [...actionDecisionsById.keys()],
      )
    } catch (error) {
      console.warn(`[MaxxChat] AnswerBrief schema rejected: ${errorText(error)}`)
      return withheldBecause(
        'The answer did not come back in the governed format, so it was withheld rather than shown unverified.',
      )
    }
    // A brief that cites NOTHING renders to its own heading and nothing else — the single sentence
    // "Governed evidence is shown below.", returned with `availability: 'available'` and no evidence
    // below it. That is a heading over an empty page presented as a verified answer, and it is the
    // one output shape this whole contract exists to make impossible.
    //
    // It remains reachable when every internal evidence read fails and the forced-submission retry
    // compels `submit_answer_brief`. In that state three empty arrays satisfy the schema, and without
    // this guard `renderAnswerBrief` returns a heading over an empty page as an available answer.
    //
    // Routed through `withheldBecause` rather than refused here, so the reader gets the specific
    // cause — which plane has no claim supply — instead of a generic failure.
    if (brief.observations.length === 0
      && brief.unavailable_claim_ids.length === 0
      && brief.action_decision_ids.length === 0) {
      console.warn('[MaxxChat] AnswerBrief submitted with no citations; withheld.')
      return withheldBecause(
        'The answer cited no governed evidence at all, so there was nothing to show and it was withheld.',
      )
    }
    let rendered: string
    try {
      rendered = renderAnswerBrief(brief, [...claimsById.values()], actionDecisionsById)
    } catch (error) {
      // LOGGED, never rendered: `errorText` quotes the identifier the model supplied, and echoing it
      // would put model-authored text in front of the reader on the one path that exists to stop that.
      // Routed through the discrimination, not returned raw. An unknown or misclassified id is still
      // rejected even when the server has preloaded the required cross-plane claim packet.
      console.warn(`[MaxxChat] AnswerBrief citation rejected: ${errorText(error)}`)
      return withheldBecause(
        'The answer cited evidence that does not match the governed record, so it was withheld.',
      )
    }
    return {
      // `renderAnswerBrief` emits only claim-derived lines; the model supplied ids, never prose.
      text: governMaxxAnswer(rendered, evidence, 'server_composed'),
      toolsUsed: [...new Set(toolsUsed)],
      evidence,
      availability: evidence.some((item) => item.availability !== 'returned')
        ? 'partial'
        : evidence.length > 0 ? 'available' : 'partial',
      brief,
      // Copied: claimsById stays mutable for the rest of the loop, so handing it out directly would
      // make the ReadonlyMap type a lie.
      claims: new Map(claimsById),
      actionDecisions: new Map(actionDecisionsById),
    }
  }

  /**
   * The model selects optional claims, but it does not select the server-owned audit packet. Those
   * required ids were classified from the owner's question and derived locally before the provider
   * loop; requiring the model to submit three empty arrays before they can be rendered makes a
   * content-free transport wrapper a single point of failure. If the provider does not complete that
   * wrapper, compose it locally from the required ids. Optional model-visible claims remain excluded,
   * and every rendered value still comes from the governed claim map.
   */
  const finishWithRequiredAuditOr = (fallback: () => MaxxChatResult): MaxxChatResult => {
    if (requiredClaimIds.size === 0 && actionDecisionsById.size === 0) return fallback()
    return finishWithBrief({
      summary: 'governed_claims',
      observations: [],
      action_decision_ids: [],
      unavailable_claim_ids: [],
      next_check: null,
    })
  }

  // A malformed model selection must not suppress the mandatory server-owned audit packet. Try the
  // submitted selection first; if its schema/citations exceed the bounded owner surface, discard the
  // optional selection and render only the locally derived required claims and final decisions.
  const finishSubmittedBrief = (submitted: unknown): MaxxChatResult => {
    const selected = finishWithBrief(submitted)
    return selected.brief ? selected : finishWithRequiredAuditOr(() => selected)
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const remainingMs = turnDeadline - Date.now()
    if (remainingMs < CHAT_MIN_ROUND_MS) {
      return finishWithRequiredAuditOr(() => unavailableResult(
        'That question ran out of time before a governed answer was complete, so I did not produce a partial answer. Narrow it to a specific campaign, metric, and date range.',
        toolsUsed,
        evidence,
      ))
    }
    let resp: AiResponse
    try {
      resp = await completeTurn({
        feature: 'maxx_chat',
        system: `${todayContext(closedThrough)}\n\n${MAXX_CHAT_SYSTEM}\n\n${MAXX_CHAT_MEASUREMENT_GOVERNANCE}\n\n${MAXX_ANSWER_BRIEF_CONTRACT}${actionsContract}`,
        cacheSystemPrompt: true,
        messages,
        // The same tool list on every round, so the cached prefix and thinking blocks stay valid.
        // Lookups run one at a time (the adapter disables parallel calls): a turn carrying a
        // submission alongside an account lookup silently dropped the lookup, so the answer
        // under-reported what it consulted and any claim id from it failed to resolve.
        tools,
        // On the retry, REQUIRE the brief as the shape of the reply (structured output) with tool
        // calls off for that request. Forcing the tool instead is a 400 on Claude Opus 5.5.
        toolChoice: forcedSubmission ? 'none' : 'auto',
        ...(forcedSubmission ? { outputFormat: ANSWER_BRIEF_OUTPUT_FORMAT } : {}),
        maxTokens: CHAT_MAX_TOKENS,
        timeoutMs: Math.min(CHAT_ROUND_TIMEOUT_MS, remainingMs),
      })
    } catch {
      return finishWithRequiredAuditOr(() => unavailableResult(
        "Maxx's language-model provider is unavailable, so I cannot verify an answer right now.",
        toolsUsed,
        evidence,
      ))
    }

    if (resp.stop === 'tool_use') {
      // The brief is a SINK, not a lookup: submitting it ENDS the turn. Checked before the assistant
      // message is appended, because there is no following round to give it to — appending it left
      // the submission as the last message and broke every reader of the conversation tail. It also
      // never reaches `executeTool`, and is deliberately kept out of `toolsUsed`, which means
      // "account lookups consulted" and feeds the claim-supply message.
      const submissions = resp.toolCalls.filter((call) => call.name === ANSWER_BRIEF_TOOL)
      // `.find` took the first and discarded the rest in silence, so a turn carrying an empty brief
      // and a valid one was withheld while the valid one sat unread in the same message.
      if (submissions.length > 1) {
        console.warn(`[MaxxChat] ${submissions.length} briefs submitted in one turn; none accepted.`)
        return finishWithRequiredAuditOr(() => withheldBecause(
          'The answer arrived more than once in a single turn, so none of them was accepted.',
        ))
      }
      if (submissions.length === 1) return finishSubmittedBrief(submissions[0].input)
      // ADR-062: an owner action is a sink too. It runs only for the signed-in owner, answers with a
      // card, and never approves or applies anything.
      if (options.ownerUserId && resp.toolCalls.some((call) => CHAT_ACTION_NAMES.has(call.name))) {
        return runChatActionTurn(resp.toolCalls, {
          ownerUserId: options.ownerUserId, decisionIds: new Set(actionDecisionsById.keys()), toolsUsed, evidence,
        })
      }

      messages.push(resp.assistant)
      const toolResults: AiToolResult[] = []
      let requestedTool = false

      for (const call of resp.toolCalls) {
        requestedTool = true
        const args = (call.input ?? {}) as Record<string, unknown>
        // Sanitised at the point of capture: `toolsUsed` is returned to the client and rendered
        // under "Checked:" in MaxxChat.tsx, as well as being listed by `noClaimSupplyMessage`.
        toolsUsed.push(safeToolName(call.name))
        // Defense-in-depth: write tools are already excluded from CHAT_TOOLS; refuse them anyway.
        if (WRITE_TOOLS.has(call.name)) {
          const refused = buildGovernedToolEvidence({ tool: call.name, args, result: { available: false } })
          return unavailableResult(
            'A write-capable tool was refused. Ask Maxx only drafts and proposes (you approve on the Changes page), so this request has no verified answer.',
            toolsUsed,
            [...evidence, refused],
          )
        }
        try {
          const result = await executeTool(call.name, args)
          const { text: serialized, truncated } = serializeGovernedToolResultWithMeta({
            tool: call.name,
            args,
            result,
          }, MAX_TOOL_RESULT_CHARS)
          const envelope = JSON.parse(serialized) as { evidence?: MaxxToolEvidence }
          // Harvest ONLY what the model actually saw. Claims used to be taken from the raw result
          // before serialization, so an over-long payload left the resolver holding the complete set
          // while the model received `{ truncated: true, preview }` — a string, not JSON. Truncation
          // flips availability to 'partial', which does not return early (only 'unavailable' does),
          // so the turn continued with the two sides disagreeing about what was on offer. Evaluation
          // would then credit or blame the model for claims it was never shown.
          //
          // Dropping the whole tool call's claims is deliberately coarse: a truncated payload is a
          // JSON prefix, and a predicate must match its governed claim byte-exactly across ten
          // fields, so partial visibility is not a basis for citation. The model citing an id it
          // could not fully see now fails in renderAnswerBrief instead of silently succeeding.
          if (!truncated) {
            for (const claim of claimsFromToolResult(call.name, result)) claimsById.set(claim.claimId, claim)
            for (const decision of persistedFinalActionDecisionsFromToolResult(call.name, result)) {
              actionDecisionsById.set(decision.id, decision)
            }
          }
          if (!envelope.evidence || envelope.evidence.availability === 'unavailable') {
            const unavailable = envelope.evidence
              ?? buildGovernedToolEvidence({ tool: call.name, args, result: { available: false } })
            return unavailableResult(
              'A governed account lookup returned unavailable evidence, so I cannot verify an answer.',
              toolsUsed,
              [...evidence, unavailable],
            )
          }
          evidence.push(envelope.evidence)
          toolResults.push({ callId: call.id, content: serialized })
        } catch {
          const unavailable = buildGovernedToolEvidence({ tool: call.name, args, result: { available: false } })
          return unavailableResult(
            'A governed account lookup failed, so I cannot verify an answer from partial evidence.',
            toolsUsed,
            [...evidence, unavailable],
          )
        }
      }
      if (!requestedTool) {
        return unavailableResult(
          'The language-model response requested a lookup without a valid tool call, so no answer was produced.',
          toolsUsed,
          evidence,
        )
      }
      messages.push({ role: 'tool_results', results: toolResults })
      continue
    }

    if (resp.stop === 'max_tokens') {
      return finishWithRequiredAuditOr(() => unavailableResult(
        'The generated answer was incomplete, so it was not shown as verified.',
        toolsUsed,
        evidence,
      ))
    }

    // A refusal is never an answer, whatever text came with it.
    if (resp.stop === 'refusal') {
      return finishWithRequiredAuditOr(() => unavailableResult(
        'The language-model provider declined this request, so it did not complete a governed answer and no response was shown.',
        toolsUsed,
        evidence,
      ))
    }

    if (resp.stop !== 'end_turn') {
      return finishWithRequiredAuditOr(() => unavailableResult(
        'The language-model provider did not complete a governed answer, so no response was shown.',
        toolsUsed,
        evidence,
      ))
    }

    // The retry's reply is the brief itself, constrained to its schema (structured output). It is
    // still only a SELECTION of claim ids: zod and the citation checks run on it exactly as on a
    // tool submission, and text that is not JSON is withheld.
    if (forcedSubmission) {
      let submitted: unknown
      try {
        submitted = parseJsonAnswer(resp.text)
      } catch {
        return finishWithRequiredAuditOr(() => withheldBecause(
          'The answer did not come back in the governed format, so it was withheld rather than shown unverified.',
        ))
      }
      return finishSubmittedBrief(submitted)
    }

    // The model answered in PROSE instead of submitting the brief. That was the dominant failure
    // mode when the brief was raw JSON in an assistant turn — measured four consecutive times against
    // production with claims available and the window correct, and 2/2 under each of two different
    // date contexts. Rather than discard a turn's work, REQUIRE the submission: the retry asks for the
    // brief as structured output (see answer-brief-submission.ts), so the reply is the schema.
    // `round + 1 < MAX_TOOL_ROUNDS` because a retry needs a round to happen in. Without it, prose on
    // the final round set the flag, `continue`d, exited the loop, and returned "That question exceeded
    // the governed lookup limit" — a cause that was not the cause, with the retry request queued into
    // `messages` and never sent, and the whole claim-supply discrimination skipped.
    if (round + 1 < MAX_TOOL_ROUNDS) {
      forcedSubmission = true
      messages.push(resp.assistant)
      messages.push({ role: 'user', text: ANSWER_BRIEF_RETRY_PROMPT })
      continue
    }
    return finishWithRequiredAuditOr(() => withheldBecause(
      'The answer did not come back in the governed format, so it was withheld rather than shown unverified.',
    ))
  }

  return finishWithRequiredAuditOr(() => unavailableResult(
    'That question exceeded the governed lookup limit, so I did not produce a partial answer. Narrow it to a specific campaign, metric, and date range.',
    toolsUsed,
    evidence,
  ))
}
