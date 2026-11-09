import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  KNOWLEDGE_CORPUS,
  QUARANTINED_KNOWLEDGE_KEYS,
  RUNTIME_CITABLE_KNOWLEDGE_KEYS,
  corpusEntry,
  corpusForDomain,
  citeEntry,
  runtimeCitableCorpus,
} from '@/lib/knowledge/corpus'

// Corpus invariants. The owner non-negotiable is enforced here: NO INVENTED
// SOURCES — every entry carries a named source; meta_official claims carry a URL or an explicit
// research-pass/doc provenance; and every docs/meta-knowledge doc is distilled by ≥1 entry (drift guard).

describe('knowledge corpus — citation discipline', () => {
  it('has a meaningful corpus (≥20 entries) with unique keys', () => {
    expect(KNOWLEDGE_CORPUS.length).toBeGreaterThanOrEqual(20)
    const keys = KNOWLEDGE_CORPUS.map((e) => e.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('every entry has a named source, a tier, an accessed date, and an account fit note', () => {
    for (const e of KNOWLEDGE_CORPUS) {
      expect(e.source.name.length, e.key).toBeGreaterThan(5)
      expect(['meta_official', 'principle', 'practitioner', 'big_player']).toContain(e.source.tier)
      expect(e.source.accessed, e.key).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(e.account_relevance.length, e.key).toBeGreaterThan(20)
      expect(e.claim.length, e.key).toBeGreaterThan(20)
    }
  })

  it('meta_official entries carry a URL or an explicit docs/meta-knowledge / research-pass provenance', () => {
    for (const e of KNOWLEDGE_CORPUS.filter((x) => x.source.tier === 'meta_official')) {
      const hasUrl = !!e.source.url && e.source.url.startsWith('http')
      const hasDocProvenance = !!e.doc_ref || /docs\/(meta-knowledge|research)\//.test(e.source.name)
      expect(hasUrl || hasDocProvenance, `${e.key} needs a URL or doc provenance`).toBe(true)
    }
  })

  it('drift guard: every docs/meta-knowledge doc is distilled by at least one entry', () => {
    const docsDir = path.resolve(process.cwd(), 'docs/meta-knowledge')
    // README.md is the provenance note for the vendored folder, not a reference document.
    const docs = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md') && f !== 'README.md')
    expect(docs.length).toBeGreaterThan(0)
    const referenced = KNOWLEDGE_CORPUS.map((e) => `${e.doc_ref ?? ''} ${e.source.name}`).join(' ')
    for (const doc of docs) {
      expect(referenced.includes(doc), `docs/meta-knowledge/${doc} is not distilled by any corpus entry`).toBe(true)
    }
  })

  it('the 5×-CPA budget figure is tiered as a heuristic claim, never presented as a Meta rule', () => {
    const e = corpusEntry('learning-budget-5x-heuristic')
    expect(e).toBeDefined()
    expect(e!.claim).toMatch(/industry heuristic/i)
    // And the Meta-published learning bar stays meta_official:
    const learn = corpusEntry('learning-exit-50-events')
    expect(learn?.source.tier).toBe('meta_official')
  })

  it('domain lookup + citation rendering work', () => {
    expect(corpusForDomain('measurement').length).toBeGreaterThanOrEqual(4)
    const e = corpusEntry('standard-over-custom-events')!
    expect(citeEntry(e)).toContain('[meta_official:')
  })

  it('serves the current conditional doctrine and withholds audited universal/stale claims', () => {
    const runtimeKeys = new Set(runtimeCitableCorpus().map((entry) => entry.key))
    for (const key of QUARANTINED_KNOWLEDGE_KEYS) expect(runtimeKeys.has(key), key).toBe(false)
    for (const key of [
      'objective-outcome-alignment-current',
      'advantage-audience-controls-suggestions-current',
      'strict-retargeting-identity-current',
      'detailed-targeting-exclusions-removed-current',
      'advantage-placements-conditional-default-current',
      'simplify-comparable-jobs-current',
      'budget-duration-conditional-current',
      'bid-strategy-kpi-current',
      'capi-accepted-delivery-current',
      'capi-browser-dedup-current',
      'attribution-not-incrementality-current',
      'breakdown-effect-current',
      'learning-state-not-decision-sufficiency-current',
    ]) expect(runtimeKeys.has(key), key).toBe(true)
    expect(runtimeKeys).toEqual(RUNTIME_CITABLE_KNOWLEDGE_KEYS)
    expect(runtimeCitableCorpus().every((entry) => entry.source.url && entry.source.tier === 'meta_official')).toBe(true)
  })

  it('regression coverage: the past-miss topics are all encoded (CAPI, parity, fatigue, breakdown, truth hierarchy)', () => {
    for (const key of ['capi-dedup-spec', 'standard-over-custom-events', 'fatigue-signals', 'breakdown-effect', 'truth-hierarchy', 'learning-limited-profitable']) {
      expect(corpusEntry(key), key).toBeDefined()
    }
  })
})
