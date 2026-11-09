import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ANSWER_BRIEF_OUTPUT_FORMAT, ANSWER_BRIEF_TOOL, ANSWER_BRIEF_TOOL_DEFINITION, MAXX_ANSWER_BRIEF_CONTRACT,
} from '@/lib/maxx/chat'
import { parseAnswerBriefValue } from '@/lib/maxx/answer-brief'

/**
 * Every claim the submission mechanism makes about itself, bound to an assertion.
 *
 * WHY THIS FILE EXISTS. A commit introduced `submit_answer_brief` and described it as "a tool whose
 * input_schema IS the contract… the API validates the shape instead of the model remembering it" and
 * as using "`tool_choice` to REQUIRE it — which is what makes the final turn deterministic instead of
 * hopeful." Neither `strict: true` nor `tool_choice` was in the code. `rg tool_choice src/` returned
 * two hits, both comments, both written by that commit. The measured improvement was real and came
 * from offering the tool at all; the mechanism credited for it did not exist.
 *
 * Mutation testing cannot catch that class of defect — it finds code no test watches, not a
 * mechanism that was never written. What catches it is refusing to let a claim ship without an
 * assertion that binds it. That is what this file is: one test per claim, each naming the claim.
 *
 * The second half is the schema-agreement check. `ANSWER_BRIEF_TOOL_DEFINITION.input_schema` is
 * hand-written JSON Schema; `answerBriefSchema` is zod. They are two encodings of one contract kept
 * in step by hand in two files, and six of the eight ways to break the JSON half survived the entire
 * suite: removing the `summary` enum, dropping `minItems`, widening every bound to 999, replacing
 * every property value with `{}`, making `observations` a string, and gutting `required`. A schema
 * nobody checks is a contract that does not exist.
 */

const schema = ANSWER_BRIEF_TOOL_DEFINITION.input_schema as {
  type: string
  additionalProperties?: boolean
  required?: string[]
  properties: Record<string, Record<string, unknown>>
}

describe('the tool definition claims the API will enforce it', () => {
  it('sets strict, without which Anthropic treats input_schema as a hint', () => {
    // The single field that turns the JSON schema from advisory into enforced.
    expect((ANSWER_BRIEF_TOOL_DEFINITION as { strict?: boolean }).strict).toBe(true)
  })

  it('meets strict mode is preconditions, or the API rejects the tool outright', () => {
    expect(schema.additionalProperties).toBe(false)
    expect(Array.isArray(schema.required)).toBe(true)
  })

  it('is named the same thing the loop intercepts', () => {
    expect(ANSWER_BRIEF_TOOL_DEFINITION.name).toBe(ANSWER_BRIEF_TOOL)
  })

  it('carries the array limits in its DESCRIPTION, since the schema cannot', () => {
    // Strict mode rejects `maxItems`, so these bounds exist only in zod — and a limit the model is
    // never told is a limit it exceeds. Measured: without this text a brief arrived with nine
    // observations, accepted by the API and refused by zod one step later. Adding it moved live
    // results from 3/6 to 7/8. My own mutation sweep then found the whole description could be
    // blanked with the suite still green, which is how a fix that earned four runs of evidence
    // regresses in silence.
    const description = ANSWER_BRIEF_TOOL_DEFINITION.description ?? ''
    expect(description).toMatch(/at most 8 observations/i)
    expect(description).toMatch(/at most 8 claim_ids/i)
    expect(description).toMatch(/at most 16 unavailable_claim_ids/i)
    expect(description).toMatch(/at most 3 action_decision_ids/i)
    // The grouping rule, whole. Its tail sat on its own source line and survived the sweep — a
    // sentence that reads complete while the instruction it carries has been cut in half.
    expect(description).toMatch(/Group related claims into ONE observation rather than making one observation per claim/i)
  })

  it('tells the model it cites ids and the SERVER writes the words', () => {
    // The instruction that keeps prose out of the answer at all. Unasserted until a mutation sweep
    // blanked it with the suite green — and it is the sentence the entire governance design rests on.
    const description = ANSWER_BRIEF_TOOL_DEFINITION.description ?? ''
    expect(description).toMatch(/Cite governed claims by id only/i)
    expect(description).toMatch(/the server renders all wording from the claims themselves/i)
  })

  it('tells the model ids are COPIED, not constructed', () => {
    // The likely failure without this rule: the model reads numbers from a tool that publishes no
    // claims and assembles a plausible-looking id from them, e.g.
    // `get_account_summary:period:2030-03-01:2030-03-21:total_spend:925:USD:Meta_actual`. Such an id
    // resolves to nothing. The contract says ids are copied verbatim and that only one tool returns
    // a claims array; both sentences are load-bearing.
    expect(MAXX_ANSWER_BRIEF_CONTRACT).toMatch(/COPIED VERBATIM/)
    expect(MAXX_ANSWER_BRIEF_CONTRACT).toMatch(/Never construct, guess, adapt or format a claim id/i)
    expect(MAXX_ANSWER_BRIEF_CONTRACT).toMatch(/Only get_performance_cockpit returns a "claims" array/i)
    // And the availability rule: without it an unavailable claim gets cited as if it were measured.
    expect(MAXX_ANSWER_BRIEF_CONTRACT).toMatch(/Check each claim's availability field/i)
  })
})

describe('the tool definition stays inside strict mode is schema subset', () => {
  // A rejected tool definition fails EVERY request. With `maxItems` present and `strict: true` the
  // API returns 400 "For 'array' type, property 'maxItems' is not supported", and every chat
  // question comes back "Maxx's language-model provider is unavailable" — the entire chat down,
  // from one schema keyword. Anyone reconciling the divergence below by adding `maxItems` back would
  // reproduce that outage, so the absence is asserted, not assumed.
  function keysDeep(node: unknown, found = new Set<string>()): Set<string> {
    if (Array.isArray(node)) { for (const item of node) keysDeep(item, found); return found }
    if (node === null || typeof node !== 'object') return found
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      found.add(key)
      keysDeep(value, found)
    }
    return found
  }

  it('uses no schema keyword strict mode rejects', () => {
    const used = keysDeep(schema)
    // Probed against the live API rather than assumed: enum, null, minItems, minLength, maxLength and
    // nested additionalProperties are all accepted; maxItems is the single exclusion.
    expect(used.has('maxItems')).toBe(false)
  })

  it('still uses the constraints strict mode DOES support, or it enforces nothing', () => {
    const used = keysDeep(schema)
    for (const supported of ['enum', 'minItems', 'minLength', 'maxLength', 'additionalProperties', 'required']) {
      expect(used.has(supported)).toBe(true)
    }
  })
})

describe('the JSON schema and the zod schema encode the same contract', () => {
  // Each case is a document plus what BOTH encodings must say about it. A divergence is a wasted turn
  // at best (the API accepts what zod rejects) and a silent loosening at worst.
  const valid = {
    summary: 'governed_claims',
    observations: [{ claim_ids: ['meta.spend:2026-08-01:2026-08-22'] }],
    action_decision_ids: [],
    unavailable_claim_ids: [],
    next_check: null,
  }

  const CASES: Array<{ name: string; doc: unknown; accepted: boolean }> = [
    { name: 'a well-formed brief', doc: valid, accepted: true },
    { name: 'next_check omitted entirely', doc: { ...valid, next_check: undefined }, accepted: true },
    { name: 'a summary that is not the literal', doc: { ...valid, summary: 'here is your answer' }, accepted: false },
    { name: 'a non-null next_check', doc: { ...valid, next_check: 'Pause the campaign.' }, accepted: false },
    { name: 'an unknown top-level key', doc: { ...valid, direction: 'up' }, accepted: false },
    { name: 'an unknown key inside an observation', doc: { ...valid, observations: [{ claim_ids: ['a'], lineage: {} }] }, accepted: false },
    { name: 'an observation with zero claim_ids', doc: { ...valid, observations: [{ claim_ids: [] }] }, accepted: false },
    { name: 'observations as a string', doc: { ...valid, observations: 'meta.spend' }, accepted: false },
    { name: 'a claim id that is not a string', doc: { ...valid, observations: [{ claim_ids: [42] }] }, accepted: false },
    { name: 'a claim id over the length bound', doc: { ...valid, observations: [{ claim_ids: ['x'.repeat(241)] }] }, accepted: false },
    { name: 'a missing required key', doc: { summary: 'governed_claims', observations: [], action_decision_ids: [] }, accepted: false },
  ]

  /** The JSON Schema subset this contract uses, evaluated directly — no dependency, no drift. */
  function jsonSchemaAccepts(node: Record<string, unknown>, value: unknown): boolean {
    if (node.enum) return (node.enum as unknown[]).includes(value)
    switch (node.type) {
      case 'null': return value === null
      case 'string': {
        if (typeof value !== 'string') return false
        if (typeof node.minLength === 'number' && value.length < node.minLength) return false
        if (typeof node.maxLength === 'number' && value.length > node.maxLength) return false
        return true
      }
      case 'array': {
        if (!Array.isArray(value)) return false
        if (typeof node.minItems === 'number' && value.length < node.minItems) return false
        if (typeof node.maxItems === 'number' && value.length > node.maxItems) return false
        return value.every((item) => jsonSchemaAccepts(node.items as Record<string, unknown>, item))
      }
      case 'object': {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
        const record = value as Record<string, unknown>
        const properties = (node.properties ?? {}) as Record<string, Record<string, unknown>>
        for (const key of (node.required ?? []) as string[]) {
          if (record[key] === undefined) return false
        }
        for (const [key, item] of Object.entries(record)) {
          if (item === undefined) continue
          if (!(key in properties)) return node.additionalProperties !== false
          if (!jsonSchemaAccepts(properties[key], item)) return false
        }
        return true
      }
      default: return true
    }
  }

  const zodAccepts = (doc: unknown) => {
    try { parseAnswerBriefValue(JSON.parse(JSON.stringify(doc))); return true } catch { return false }
  }

  it('evaluates the JSON schema at all (guards this file against asserting nothing)', () => {
    expect(jsonSchemaAccepts(schema as unknown as Record<string, unknown>, valid)).toBe(true)
    expect(jsonSchemaAccepts(schema as unknown as Record<string, unknown>, { nonsense: true })).toBe(false)
  })

  /**
   * The ONE axis on which the two encodings deliberately differ.
   *
   * Upper array bounds live in zod alone, because strict mode cannot express `maxItems` without
   * rejecting the tool. The API therefore accepts an over-long brief and zod refuses it one step
   * later: a wasted turn, never a bypass, because zod runs on every submission. Asserted in BOTH
   * directions so the divergence stays exactly this size.
   */
  const OVER_BOUND: Array<{ name: string; doc: unknown }> = [
    { name: 'nine observations', doc: { ...valid, observations: Array.from({ length: 9 }, () => ({ claim_ids: ['a'] })) } },
    { name: 'nine claim ids in one observation', doc: { ...valid, observations: [{ claim_ids: Array.from({ length: 9 }, (_, i) => `c${i}`) }] } },
    { name: 'four action decision ids', doc: { ...valid, action_decision_ids: ['a', 'b', 'c', 'd'] } },
    { name: 'seventeen unavailable ids', doc: { ...valid, unavailable_claim_ids: Array.from({ length: 17 }, (_, i) => `u${i}`) } },
  ]

  it.each(OVER_BOUND)('$name — JSON accepts, zod refuses (upper bounds are zod-only, by necessity)', ({ doc }) => {
    expect(jsonSchemaAccepts(schema as unknown as Record<string, unknown>, JSON.parse(JSON.stringify(doc)))).toBe(true)
    expect(zodAccepts(doc)).toBe(false)
  })

  it.each(CASES)('$name — both encodings agree', ({ doc, accepted }) => {
    const json = jsonSchemaAccepts(schema as unknown as Record<string, unknown>, JSON.parse(JSON.stringify(doc)))
    const zod = zodAccepts(doc)
    expect({ json, zod }).toEqual({ json: accepted, zod: accepted })
  })

  /**
   * the prose RETRY asks for the brief as structured output (Claude Opus 5.5 rejects the forced
   * tool choice it used to send). Structured output has a narrower schema subset than strict tools,
   * so string lengths and item counts are stripped there and zod alone enforces them; and every
   * property is required, so next_check must be sent (as null). Both divergences are enumerated here
   * so they stay exactly this size.
   */
  const retrySchema = ANSWER_BRIEF_OUTPUT_FORMAT.schema as Record<string, unknown>
  const BOUNDS_ONLY = new Set(['an observation with zero claim_ids', 'a claim id over the length bound'])
  const RETRY_STRICTER = new Set(['next_check omitted entirely'])

  it('the retry schema uses no keyword structured output rejects, and is the same object shape', () => {
    const keys = new Set<string>()
    const walk = (node: unknown) => {
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (node === null || typeof node !== 'object') return
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) { keys.add(key); walk(value) }
    }
    walk(retrySchema)
    for (const unsupported of ['minLength', 'maxLength', 'minItems', 'maxItems']) expect(keys.has(unsupported)).toBe(false)
    expect(retrySchema.additionalProperties).toBe(false)
    expect(Object.keys(retrySchema.properties as object).sort()).toEqual(Object.keys(schema.properties).sort())
    expect(ANSWER_BRIEF_OUTPUT_FORMAT.name).toBe(ANSWER_BRIEF_TOOL)
  })

  it.each(CASES)('$name — the retry schema agrees with zod except on the enumerated divergences', ({ name, doc, accepted }) => {
    const json = jsonSchemaAccepts(retrySchema, JSON.parse(JSON.stringify(doc)))
    const zod = zodAccepts(doc)
    if (BOUNDS_ONLY.has(name)) {
      // Accepted by the schema, refused by zod one step later: a wasted turn, never a bypass.
      expect({ json, zod }).toEqual({ json: true, zod: false })
    } else if (RETRY_STRICTER.has(name)) {
      expect({ json, zod }).toEqual({ json: false, zod: true })
    } else {
      expect({ json, zod }).toEqual({ json: accepted, zod: accepted })
    }
  })
})

describe('parseAnswerBriefValue actually validates', () => {
  // It could be replaced with `return value as AnswerBrief` and every test still passed, which meant
  // the only real gate on tool input was unexercised — and the schema-failure branch that routes into
  // the claim-supply discrimination had never once executed.
  it('rejects a malformed submission rather than passing it through', () => {
    expect(() => parseAnswerBriefValue({ summary: 'nope' })).toThrow()
    expect(() => parseAnswerBriefValue(null)).toThrow()
    expect(() => parseAnswerBriefValue('governed_claims')).toThrow()
  })

  it('strips nothing and admits nothing extra', () => {
    const parsed = parseAnswerBriefValue({
      summary: 'governed_claims', observations: [], action_decision_ids: [],
      unavailable_claim_ids: [], next_check: null,
    })
    expect(Object.keys(parsed).sort()).toEqual([
      'action_decision_ids', 'next_check', 'observations', 'summary', 'unavailable_claim_ids',
    ])
    expect(() => parseAnswerBriefValue({
      summary: 'governed_claims', observations: [], action_decision_ids: [],
      unavailable_claim_ids: [], next_check: null, extra: 1,
    })).toThrow()
  })

  it('is not a cast: a value typed as the brief but shaped wrongly still throws', () => {
    const pretender = { summary: 'governed_claims', observations: [{ claim_ids: [] }], action_decision_ids: [], unavailable_claim_ids: [], next_check: null }
    expect(() => parseAnswerBriefValue(pretender)).toThrow()
  })
})

describe('the zod claim id is the one the JSON bound describes', () => {
  it('agrees on trimming, or a whitespace id wastes a turn', () => {
    // zod uses `.trim().min(1)`, so "   " trims to "" and is rejected; the JSON bound counts raw
    // length and would accept it. Documented as a KNOWN, deliberate divergence: it costs one turn and
    // cannot loosen anything, because zod runs on every submission regardless.
    const whitespaceId = { summary: 'governed_claims', observations: [{ claim_ids: ['   '] }], action_decision_ids: [], unavailable_claim_ids: [], next_check: null }
    expect(() => parseAnswerBriefValue(whitespaceId)).toThrow()
    const idSchema = (schema.properties.observations.items as Record<string, Record<string, Record<string, unknown>>>)
      .properties.claim_ids.items as Record<string, unknown>
    expect(idSchema.minLength).toBe(1)
    expect(z.string().trim().min(1).safeParse('   ').success).toBe(false)
  })
})
