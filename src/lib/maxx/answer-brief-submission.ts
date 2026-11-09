import type { AiOutputFormat, AiToolDefinition, JsonSchemaObject } from '@/lib/ai'

/**
 * How the model hands back its governed answer: the submission contract for `runMaxxChat`.
 *
 * Moved out of chat.ts in the v1 release (re-exported there) when the forced retry was redesigned.
 *
 * FIRST CHOICE: the `submit_answer_brief` tool, offered with every lookup under `tool_choice: auto`.
 * `strict: true` makes the API validate the submission against `input_schema`; without it the
 * schema is a hint. Measured against production, raw JSON in an assistant turn came back as prose
 * four consecutive times; offering the tool is what fixed that.
 *
 * RETRY: when the model answers in prose anyway, the old code compelled the tool with
 * `tool_choice: { type: 'tool' }`. Claude Opus 5.5 rejects forced tool choice with a 400, which
 * would take the whole retry down. The retry now asks for the SAME brief as structured output:
 * `output_config.format` with the JSON schema below and `tool_choice: none`, so the reply text is
 * constrained to the schema instead of the model being asked to call a tool. The tool list stays
 * on the request so the prompt-cache prefix and earlier thinking blocks stay valid.
 */

export const ANSWER_BRIEF_TOOL = 'submit_answer_brief'

/**
 * NO `maxItems`. Anthropic's strict-mode schema subset rejects it outright:
 *   400 invalid_request_error — "tools.0.custom: For 'array' type, property 'maxItems' is not supported"
 * and a rejected tool definition fails EVERY request, taking the whole chat down. Measured: with
 * `maxItems` present and `strict: true`, six consecutive live questions returned "Maxx's
 * language-model provider is unavailable".
 *
 * Probed the rest of the subset rather than guessing — `enum`, `null`, `minItems`, `minLength`,
 * `maxLength` and nested `additionalProperties: false` are all accepted. `maxItems` is the single
 * exclusion, so upper array bounds are owned by zod alone, which runs on every submission regardless.
 * `tests/maxx-chat-submission-contract.test.ts` pins both halves: that the key is absent here, and
 * that the two encodings agree on everything else.
 */
const claimIdArray = () => ({
  type: 'array' as const, items: { type: 'string' as const, minLength: 1, maxLength: 240 },
})

export const ANSWER_BRIEF_TOOL_DEFINITION: AiToolDefinition = {
  name: ANSWER_BRIEF_TOOL,
  // Enforced by the API, not advisory. Requires additionalProperties:false + required, both set below.
  strict: true,
  description:
    'Submit the final governed answer. Call this exactly once, after every lookup you need. Cite '
    + 'governed claims by id only — the server renders all wording from the claims themselves. '
    // The upper bounds live HERE because strict mode cannot express `maxItems` in the schema, and a
    // limit the model is never told is a limit it will exceed: measured, a brief with nine
    // observations was accepted by the API and refused by zod one step later, wasting the turn.
    + 'LIMITS: at most 8 observations, at most 8 claim_ids in each, at most 16 unavailable_claim_ids, '
    + 'at most 3 action_decision_ids. Group related claims into ONE observation rather than making '
    + 'one observation per claim.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', enum: ['governed_claims'] },
      observations: {
        type: 'array',
        items: {
          type: 'object',
          properties: { claim_ids: { ...claimIdArray(), minItems: 1 } },
          required: ['claim_ids'], additionalProperties: false,
        },
      },
      action_decision_ids: claimIdArray(),
      unavailable_claim_ids: claimIdArray(),
      next_check: { type: 'null' },
    },
    required: ['summary', 'observations', 'action_decision_ids', 'unavailable_claim_ids'],
    additionalProperties: false,
  },
}

/**
 * Structured output documents a narrower JSON Schema subset than strict tools: string length
 * constraints and array item counts are not supported there. They are removed from the RETRY
 * schema only; zod (`normalizeAnswerBriefValue`) enforces every bound on every brief either way.
 * `next_check` becomes required-and-null because structured output requires every property.
 */
const UNSUPPORTED_IN_STRUCTURED_OUTPUT = new Set(['minLength', 'maxLength', 'minItems', 'maxItems'])

function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported)
  if (node === null || typeof node !== 'object') return node
  return Object.fromEntries(Object.entries(node as Record<string, unknown>)
    .filter(([key]) => !UNSUPPORTED_IN_STRUCTURED_OUTPUT.has(key))
    .map(([key, value]) => [key, stripUnsupported(value)]))
}

export const ANSWER_BRIEF_OUTPUT_FORMAT: AiOutputFormat = {
  name: ANSWER_BRIEF_TOOL,
  schema: {
    ...(stripUnsupported(ANSWER_BRIEF_TOOL_DEFINITION.input_schema) as JsonSchemaObject),
    required: ['summary', 'observations', 'action_decision_ids', 'unavailable_claim_ids', 'next_check'],
  },
}

/** The single request made after a prose answer. It names the brief so the model knows what to return. */
export const ANSWER_BRIEF_RETRY_PROMPT = `Submit that as a governed answer: reply with the ${ANSWER_BRIEF_TOOL} `
  + 'object only (the JSON format required for this reply). Cite the claim ids that answer the '
  + 'question, and list any that are unavailable. Do not restate the numbers.'
