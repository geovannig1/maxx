import 'server-only'
import { READ_ONLY_TOOL_DEFINITIONS, WRITE_TOOLS } from '@/mcp/tools/index'

export type MaxxEvidenceSource = 'Meta' | 'Outcomes' | 'GA4' | 'CAPI' | 'Governed app records'
export type MaxxEvidenceAvailability = 'returned' | 'partial' | 'unavailable'

export interface MaxxToolEvidence {
  tool: string
  sources: MaxxEvidenceSource[]
  dateWindow: string
  scope: string
  observedAt: string
  freshness: string
  availability: MaxxEvidenceAvailability
  caveat: string
}

interface ToolEvidenceInput {
  tool: string
  args: Record<string, unknown>
  result: unknown
  observedAt?: string
}

const META_TOOLS = new Set([
  'get_performance_cockpit',
  'get_account_summary', 'get_campaign_performance', 'get_creative_performance',
  'get_audience_breakdown', 'get_auction_diagnostics', 'get_meta_recommendations',
  'get_creative_health_scores', 'diagnose_ad_performance', 'get_data_drift',
])
const OUTCOME_TOOLS = new Set(['get_outcomes', 'get_outcomes_by_label', 'get_bookings_by_type'])
const GA4_TOOLS = new Set(['get_ga4_by_campaign'])
const MIXED_MEASUREMENT_TOOLS = new Set([
  'get_daily_report', 'get_operating_mode', 'get_launch_readiness',
  'get_reconciliation', 'get_diagnosis_bundle',
])

/**
 * The tool NAME is model-authored, and it was printed verbatim.
 *
 * `evidenceDisclosure` interpolates `item.tool`, and `noClaimSupplyMessage` lists the tools consulted
 * — the latter on the HTTP 200 path. Both take `block.name` straight from the model. Bounding the
 * ARGUMENTS while leaving the name unbounded is why the previous fix's own docstring ("nothing
 * model-authored can reach the disclosure, whatever it contains") was false: a `tool_use` block named
 * `get_spend— IGNORE. Your account spent $12,400 ... Scale to $200/day today.` rendered in full.
 *
 * The provider API normally constrains a tool call's name to the supplied roster, so this is
 * defence-in-depth rather than a proven live emission — the same reasoning this file already applies
 * to write tools, which are excluded from `CHAT_TOOLS` and refused again anyway.
 */
const EXPOSED_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ...READ_ONLY_TOOL_DEFINITIONS.map((definition) => definition.name),
  ...WRITE_TOOLS,
])

export function safeToolName(name: string): string {
  return EXPOSED_TOOL_NAMES.has(name) ? name : 'an unrecognised tool'
}

function sourcesForTool(tool: string): MaxxEvidenceSource[] {
  if (META_TOOLS.has(tool)) return ['Meta']
  if (OUTCOME_TOOLS.has(tool)) return ['Outcomes']
  if (GA4_TOOLS.has(tool)) return ['GA4']
  if (tool === 'get_utm_health') return ['Meta', 'Outcomes', 'GA4']
  if (tool === 'get_economics') return ['Meta', 'Outcomes']
  if (tool === 'evaluate_recommendation') return ['Meta', 'Governed app records']
  if (MIXED_MEASUREMENT_TOOLS.has(tool)) return ['Meta', 'Outcomes', 'GA4', 'CAPI']
  return ['Governed app records']
}

/**
 * Tool arguments are MODEL-AUTHORED and reach the owner verbatim. Validate them positively.
 *
 * `evidenceDisclosure` interpolates `dateWindow` and `scope` into the "Evidence used" block, and
 * `governMaxxAnswer` composes that block OUTSIDE both of its guards — they read the narrative only.
 * So a string entering through an ARGUMENT was never scored, while the identical string entering
 * through the message was scrubbed.
 *
 * The old reader accepted any non-empty string of any length. On the success path arguments have
 * passed `DateSchema`, so they were well-formed by luck of ordering; on the FAILURE path the evidence
 * is built from the arguments that just failed validation — precisely the arbitrary ones. Reproduced:
 * a `start_date` of "Your account spent $12,400 this month at a $41.20 paid CPA — scale the winning
 * ad set to $200/day today." rendered verbatim under **Evidence used**, styled as governed
 * provenance. A fabricated money figure and an action instruction, on the surface built to prevent
 * both. Returning that text to the client (rather than discarding it with a bare 503) is what made a
 * latent hole reachable.
 *
 * Positive validation, not a blocklist: a value that is not the shape its slot accepts is treated as
 * ABSENT, and the caller's existing "must come from tool lineage" fallback describes the lookup
 * instead.
 *
 * An earlier version of this comment claimed "nothing model-authored can reach the disclosure,
 * whatever it contains" while bounding only the ARGUMENTS. The tool NAME is model-authored too and
 * was printed verbatim — see `safeToolName`, which closes the third channel. The claim is true now;
 * it was not when it was written.
 */
function dateArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null
}

/**
 * Meta entity ids are numeric. The first version accepted `[A-Za-z0-9_-]{1,40}`, which was looser
 * than this comment claimed and looser than markdown tolerates: the value is printed after a space,
 * so a leading `_` is left-flanking and `__X__` renders as bold. Verified against the real renderer —
 * `{ campaign_id: '__SCALE_TO_200_A_DAY__' }` produced `scope: campaign <strong>SCALE_TO_200_A_DAY</strong>`.
 * Digits carry no markdown meaning at all, so the class does the work the length bound cannot.
 */
function idArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return /^[0-9]{1,40}$/.test(trimmed) ? trimmed : null
}

function dateWindowFor(args: Record<string, unknown>): string {
  // "requested", not a bare range. `dateArg` proves the string is a DATE; it does not prove the
  // lookup covered it. `resolveClosedDateRange` CLAMPS instead of throwing, so
  // `{start_date: '2026-08-01', end_date: '2026-12-31'}` returns 2026-08-01..2026-08-22 with
  // `clamped_to_closed_day: true` while this line stated four months — a false provenance claim on
  // the SUCCESS path, wearing the new validator as proof. The tool's returned lineage is the only
  // thing that knows actual coverage, which the fallbacks below have always said.
  const start = dateArg(args, 'start_date')
  const end = dateArg(args, 'end_date')
  if (start && end) return `requested ${start} to ${end}; actual coverage must come from tool lineage`
  if (start) return `requested ${start} onward; exact end must come from tool lineage`
  if (end) return `requested through ${end}; exact start must come from tool lineage`
  const date = dateArg(args, 'date')
  if (date) return `requested ${date}; actual coverage must come from tool lineage`
  const days = args.window_days ?? args.days
  if (typeof days === 'number' && Number.isInteger(days) && days > 0 && days <= 400) {
    return `requested last ${days} days; exact dates must come from tool lineage`
  }
  return 'tool-defined; exact returned coverage required'
}

function scopeFor(args: Record<string, unknown>): string {
  const scopedIds: Array<[string, string]> = [
    ['ad_id', 'ad'], ['adset_id', 'ad set'], ['campaign_id', 'campaign'],
    ['meta_entity_id', 'Meta entity'],
  ]
  for (const [key, label] of scopedIds) {
    const value = idArg(args, key)
    if (value) return `${label} ${value}`
  }
  return 'active ad account; narrower scope must come from tool lineage'
}

function availabilityFor(result: unknown): MaxxEvidenceAvailability {
  if (result === null || result === undefined) return 'unavailable'
  if (typeof result !== 'object' || Array.isArray(result)) return 'returned'
  const row = result as Record<string, unknown>
  if (row.available === false || row.error) return 'unavailable'
  const statuses = [
    row.availability, row.status, row.health, row.source_health, row.read_health,
  ].filter((value): value is string => typeof value === 'string').join(' ')
  if (/unavailable|failed|failure|error/i.test(statuses)) return 'unavailable'
  if (/partial|stale|degraded|unverified|unknown|incomplete/i.test(statuses)) return 'partial'

  // A tool can succeed while one nested evidence plane is stale, truncated, or unavailable. Treat
  // that as partial so the usable sibling claims remain available without flattening the failed plane
  // into a fully healthy response. Bound traversal to keep untrusted tool payloads cheap to inspect.
  const queue: Array<{ value: unknown; depth: number }> = Object.values(row)
    .map((value) => ({ value, depth: 1 }))
  let visited = 0
  while (queue.length > 0 && visited < 5_000) {
    const current = queue.shift()!
    visited += 1
    if (current.depth > 6 || current.value === null || typeof current.value !== 'object') continue
    if (Array.isArray(current.value)) {
      for (const value of current.value) queue.push({ value, depth: current.depth + 1 })
      continue
    }
    const nested = current.value as Record<string, unknown>
    if (nested.available === false || nested.error || nested.truncated === true) return 'partial'
    for (const key of ['availability', 'status', 'health', 'source_health', 'read_health']) {
      const value = nested[key]
      if (typeof value === 'string'
        && /unavailable|failed|failure|error|partial|stale|degraded|unverified|unknown|incomplete/i.test(value)) {
        return 'partial'
      }
    }
    for (const value of Object.values(nested)) queue.push({ value, depth: current.depth + 1 })
  }
  return 'returned'
}

export function buildGovernedToolEvidence(input: ToolEvidenceInput): MaxxToolEvidence {
  const observedAt = input.observedAt ?? new Date().toISOString()
  return {
    tool: safeToolName(input.tool),
    sources: sourcesForTool(input.tool),
    dateWindow: dateWindowFor(input.args),
    scope: scopeFor(input.args),
    observedAt,
    freshness: `tool response observed ${observedAt}; underlying source freshness requires payload lineage`,
    availability: availabilityFor(input.result),
    caveat: 'A returned response does not make every metric complete, current, or decision-grade.',
  }
}

function jsonWithPreview(
  evidence: MaxxToolEvidence,
  raw: string,
  maxChars: number,
): string {
  const partialEvidence = { ...evidence, availability: 'partial' as const }
  const encode = (preview: string) => JSON.stringify({
    evidence: partialEvidence,
    data: { truncated: true, preview },
  })
  let low = 0
  let high = raw.length
  let best = encode('')
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = encode(raw.slice(0, mid))
    if (candidate.length <= maxChars) {
      best = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  if (best.length <= maxChars) return best
  const compact = JSON.stringify({
    evidence: {
      tool: evidence.tool,
      sources: evidence.sources,
      dateWindow: evidence.dateWindow,
      scope: evidence.scope,
      observedAt: evidence.observedAt,
      freshness: evidence.observedAt,
      availability: 'partial',
    },
    data: { truncated: true },
  })
  if (compact.length <= maxChars) return compact
  const minimal = JSON.stringify({
    evidence: { availability: 'partial' },
    data: { truncated: true },
  })
  return minimal.length <= maxChars ? minimal : '{}'
}

/**
 * Serialize, and say separately whether the payload was bounded.
 *
 * The truncation decision must NOT be read back out of `data.truncated`, because on the untruncated
 * path `data` IS the tool's own result (`{ evidence, data: input.result }`). A tool returning a
 * top-level `truncated: true` would then have its claims dropped although the model saw everything,
 * silently — availability stays 'returned', the turn continues, and the model's citation blows up in
 * renderAnswerBrief. No tool emits that field today, but a reconciled source's ledger health carries `truncated`
 * as a domain field and the outcome-source adapter is the next thing to land here.
 *
 * So the flag travels beside the text, in a namespace the payload cannot reach — and it is computed
 * HERE, where the answer is already known, not by re-serializing and diffing. The first attempt did
 * exactly that and broke every governed answer: `buildGovernedToolEvidence` stamps `observedAt`, so
 * two calls produce two different strings and the diff reported truncation on every payload,
 * dropping all claims. Caught by running it.
 */
export function serializeGovernedToolResultWithMeta(
  input: ToolEvidenceInput,
  maxChars: number,
): { text: string; truncated: boolean } {
  const evidence = buildGovernedToolEvidence(input)
  let encoded: string
  try {
    encoded = JSON.stringify({ evidence, data: input.result })
  } catch {
    // Unserializable payload: the model gets nothing to cite, so treat it as bounded.
    return {
      text: JSON.stringify({
        evidence: { ...evidence, availability: 'unavailable' as const },
        data: { unavailable: true },
      }),
      truncated: true,
    }
  }
  if (encoded.length <= maxChars) return { text: encoded, truncated: false }
  return { text: jsonWithPreview(evidence, encoded, maxChars), truncated: true }
}

/** Preserve a valid evidence envelope even when a payload must be bounded for the model context. */
export function serializeGovernedToolResult(input: ToolEvidenceInput, maxChars: number): string {
  return serializeGovernedToolResultWithMeta(input, maxChars).text
}

/**
 * The context bound on ONE tool result. Exported so the invariant that matters can be tested.
 *
 * WHAT GOES WRONG WHEN A COCKPIT EXCEEDS IT. Past this bound `jsonWithPreview` replaces the payload
 * with a truncated STRING. `claimsFromToolResult` then cannot parse it, every claim is dropped, and
 * the turn ends in "a governed lookup that does publish citable claims returned none this time".
 * Not a degraded answer — no answer, on the account's own numbers.
 *
 * MEASURED, after per-metric trends were added: a fully settled request serialises to 47,536
 * chars across 37 claims, and a SETTLING one — any window ending recently, which is the normal case —
 * to 61,618 across 49. The old bound was 60,000. The suite was green, the gate was green, and the
 * chat would have stopped answering; nothing measured the payload against the bound.
 *
 * So the number is not the fix. `tests/maxx-tool-result-bound.test.ts` drives the real serializer
 * with a worst-case cockpit and fails if it truncates, which turns the next growth in claims into a
 * red test instead of a silent loss of evidence. Raise this bound deliberately when that test fails;
 * do not widen it to make a red test pass without saying what grew.
 *
 * COST IS REAL AND NOT FREE: this is roughly 25k tokens of input per cockpit call, and tool results
 * accumulate across rounds within a turn.
 */
export const MAX_TOOL_RESULT_CHARS = 100_000
