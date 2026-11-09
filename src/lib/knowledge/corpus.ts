// THE KNOWLEDGE CORPUS — Maxx's durable, cited best-practice knowledge.
//
// Before this existed, docs/meta-knowledge/*.md was expertise the runtime never read, and prompts
// re-hardcoded fragments of it. This module is the machine-readable distillation: every entry carries a
// NAMED SOURCE (owner non-negotiable: no invented sources — enforced by tests/knowledge-corpus.test.ts),
// a provenance TIER, and an explicit Example Studio fit note (generic best practice often does NOT transfer
// to a capped-budget, hyper-local, low-volume booking business — the fit note is where that discipline
// lives).
//
// Governance (owner decision 2026-07-09): tier `meta_official` enters PRE-APPROVED (a git PR is the
// review); `practitioner`/`big_player` claims may only enter this in-repo corpus AFTER the owner approves
// them (until then they live as pending expert_insights rows on the Signals page). `principle` = classic,
// named published work (same rule as the hook corpus).
//
// This corpus NEVER overrides account data (Truth Hierarchy) — it informs strategy; facts stay measured.

export type KnowledgeDomain =
  | 'learning_phase'
  | 'bidding'
  | 'budget_scaling'
  | 'creative'
  | 'structure_audience'
  | 'measurement'
  | 'profit_economics'
  | 'landing_offer'
  | 'seasonality'

export type SourceTier = 'meta_official' | 'principle' | 'practitioner' | 'big_player'

export interface KnowledgeSource {
  name: string
  url?: string
  tier: SourceTier
  /** When the claim was last verified against the source (YYYY-MM-DD). */
  accessed: string
}

export interface KnowledgeEntry {
  key: string
  domain: KnowledgeDomain
  /** One precise, citable sentence. */
  claim: string
  /** Mechanism / nuance / numbers — the working detail behind the claim. */
  detail: string
  /** When this applies (omit = generally). */
  applies_when?: string
  source: KnowledgeSource
  /** How it lands for the configured account (a capped daily budget, a local radius, low weekly booking
   *  volume, an example champion baseline). Say explicitly when a generic practice does NOT transfer. */
  account_relevance: string
  /** docs/meta-knowledge file this entry distills (drift-guard: every doc must be referenced). */
  doc_ref?: string
}

import { PLATFORM_MECHANICS_ENTRIES } from './entries/platform-mechanics'
import { STRATEGY_MEASUREMENT_ENTRIES } from './entries/strategy-measurement'
import { LOCAL_SERVICE_BOOKING_ENTRIES } from './entries/local-service-booking'
import { CURRENT_MEDIA_BUYING_ENTRIES } from './entries/current-media-buying'

export const KNOWLEDGE_CORPUS: readonly KnowledgeEntry[] = [
  ...PLATFORM_MECHANICS_ENTRIES,
  ...STRATEGY_MEASUREMENT_ENTRIES,
  ...LOCAL_SERVICE_BOOKING_ENTRIES,
  ...CURRENT_MEDIA_BUYING_ENTRIES,
]

/** Claims retained for historical/playbook reference but withheld from model-facing knowledge because
 * the audit found an unsupported universal threshold, stale platform detail, or account-specific rule. */
export const QUARANTINED_KNOWLEDGE_KEYS = new Set([
  'significant-edits-reset',
  'learning-limited-profitable',
  'fluctuation-bands',
  'auction-overlap',
  'cbo-funnel-caveat',
  'retargeting-share-norm',
  'fatigue-signals',
  'standard-over-custom-events',
  'capi-dedup-spec',
  'attribution-windows-2026',
  'location-expansion-default-on',
  'cost-goal-5x-rule-unsupported',
  'cbo-two-adset-tradeoff',
  'local-creative-format-spec',
])

/** Fail-closed model-facing allowlist. The historical corpus remains queryable by explicit key for
 * audit compatibility, but only the primary-source doctrine re-verified in the current audit enters
 * Maxx's runtime reasoning context. */
export const RUNTIME_CITABLE_KNOWLEDGE_KEYS = new Set(
  CURRENT_MEDIA_BUYING_ENTRIES.map((entry) => entry.key),
)

export function runtimeCitableCorpus(): KnowledgeEntry[] {
  return KNOWLEDGE_CORPUS.filter((entry) => RUNTIME_CITABLE_KNOWLEDGE_KEYS.has(entry.key))
}

/** Entries for one domain. */
export function corpusForDomain(domain: KnowledgeDomain): KnowledgeEntry[] {
  return KNOWLEDGE_CORPUS.filter((e) => e.domain === domain)
}

/** Resolve entry by key (used by playbooks' corpus_refs; tests assert every ref resolves). */
export function corpusEntry(key: string): KnowledgeEntry | undefined {
  return KNOWLEDGE_CORPUS.find((e) => e.key === key)
}

/** Compact one-line citation rendering, e.g. for prompt injection. */
export function citeEntry(e: KnowledgeEntry): string {
  return `${e.claim} [${e.source.tier}: ${e.source.name}]`
}
