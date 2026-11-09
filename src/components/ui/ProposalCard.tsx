import type { ReactNode } from 'react'
import { DataQualityChip, type Coverage, type MeasurementKind } from '@/components/ui/DataQualityChip'
import { FreshnessStrip, type Freshness } from '@/components/ui/FreshnessStrip'
import { accountTimezoneShortName } from '@/config/timezone-label'

/**
 * Foundation primitive. The frame every proposal is presented in.
 *
 * Acceptance bar 2: the owner can act in under ten seconds, and a proposal carries its action,
 * reasoning, confidence, evidence and resolution WITHOUT a click. So identity, authority, evidence
 * window and data quality all live in the frame; the caller supplies the reasoning body and the
 * controls as children.
 *
 * WHAT THIS FIXES. `DecisionQueue` rendered `item.authority.replace(/_/g, ' ')`, turning
 * `diagnostic_only` into "diagnostic only". That reads like English but is still the enum, and it
 * does not tell the owner the thing they need: that Maxx *cannot act* on it. Underscore-stripping
 * is not translation. Bar 5 says no enum values and no error codes reach the owner, ever — and the
 * previous leak survived an earlier fix precisely because a hand-written template is not a label table.
 */

export type ProposalAuthority = 'execution_eligible' | 'owner_review' | 'diagnostic_only'

/**
 * Each entry says what the owner can DO, not what the system calls it. The `meaning` rides along as
 * the accessible name so the short label never has to carry the whole explanation.
 */
type Tier = { label: string; meaning: string; tone: string }

const AUTHORITY: Record<ProposalAuthority, Tier> = {
  // "Ready to run — Maxx can carry this out once you approve it" was FALSE. Write mode is off, and the footer on this very card reads "Agree records your
  // decision only. It does not mean implemented and cannot change Meta" (DecisionQueue.tsx:202).
  // One card making two opposite promises costs more trust than any leaked enum, because an enum
  // only confuses. The label now names who does the work: the owner does.
  execution_eligible: {
    label: 'Yours to apply',
    meaning: 'Maxx has a specific change ready. It runs only after you approve it on the Changes page, with write mode on.',
    tone: 'var(--accent)',
  },
  owner_review: {
    label: 'Needs your call',
    meaning: 'Two ways to go, and Maxx will not pick. Your decision is recorded, not executed.',
    tone: 'var(--warning)',
  },
  // On a small account nearly every proposal is this tier. "Maxx cannot act on this" is accurate but
  // describes Maxx's limitation; a queue of those reads as a wall of apologies. Same fact, framed
  // around the owner's next move.
  diagnostic_only: {
    label: 'For your judgement',
    meaning: 'Maxx found this but has no change to propose yet — it is here so you can judge it.',
    tone: 'var(--text-tertiary)',
  },
}

/**
 * `authority` reaches this component UNVALIDATED. It is read from `action_decisions.authority_tier`
 * and passed through `action-decision-store.ts:97` (`as unknown as PersistedActionDecision[]`, no
 * runtime check) → `legacy-cutover.ts:81` → `read-model.ts:118` → `queue-v2.ts`. The only real guard
 * is a CHECK constraint in the baseline schema, three modules away, and a fourth literal for this concept
 * already exists (`diagnostic-surface.ts:205`, 'diagnostic_only_legacy').
 *
 * A bare `AUTHORITY[authority]` returns undefined for anything unmapped, and the next line reads
 * `.meaning` off it — a TypeError that white-screens the whole /decisions page, because this is a
 * client component. This file exists because a hand-written template assumed it knew every value;
 * it must not repeat that assumption. Degrade to the most restrictive tier, never crash.
 */
function tierFor(authority: string): Tier {
  return AUTHORITY[authority as ProposalAuthority] ?? AUTHORITY.diagnostic_only
}

/**
 * `confidence.label` arrives unvalidated over the same read-model path as `authority`. Interpolating
 * the union directly would ship any future enum token (e.g. `very_low`) straight to the owner — the
 * leak this file exists to close. Table + degrade, same pattern as tierFor. Scores render as a
 * percent, matching RecCard/TrustBadge; the same number must never appear in two formats.
 */
const CONFIDENCE_LABEL: Record<string, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
  insufficient: 'Not enough data',
}

function confidenceLabel(label: string): string {
  return CONFIDENCE_LABEL[label] ?? 'Confidence'
}

export function ProposalCard({
  title,
  summary,
  authority,
  source,
  evidenceWindow,
  confidence,
  quality,
  freshness,
  nowMs,
  children,
}: {
  title: string
  /** The reasoning, in the owner's words. */
  summary: string
  authority: ProposalAuthority
  /** Where the proposal came from, already in owner-facing words. */
  source: string
  /** Date-only ET bounds. `null` renders an evidenced absence, never a blank. */
  evidenceWindow: { start: string; end: string } | null
  /** Engine confidence. `undefined` renders nothing (caller has no confidence concept);
   * `null` renders an evidenced absence, never a blank. */
  confidence?: { score: number; label: string } | null
  quality?: { kind: MeasurementKind; coverage?: Coverage | null; blockerCodes?: readonly string[] | null }
  freshness?: Freshness
  /** Required whenever `freshness` is given; see FreshnessStrip on why it is not defaulted. */
  nowMs?: number
  /** The controls. Kept as children so this primitive never owns the write path. */
  children?: ReactNode
}) {
  const tier = tierFor(authority)

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="section-label">{source}</span>
            <span
              className="text-[12px] font-semibold rounded-full px-2 py-1"
              title={tier.meaning}
              aria-label={tier.meaning}
              style={{
                color: tier.tone,
                background: `color-mix(in srgb, ${tier.tone} 12%, transparent)`,
                border: `1px solid color-mix(in srgb, ${tier.tone} 45%, transparent)`,
              }}
            >
              {tier.label}
            </span>
            {confidence !== undefined && (
              confidence === null ? (
                <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                  Confidence unavailable
                </span>
              ) : (
                <span
                  className="text-[12px] font-semibold rounded-full px-2 py-1"
                  title="How sure Maxx is, based on the evidence checks behind this proposal."
                  style={{
                    color: 'var(--text-secondary)',
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border)',
                  }}
                >
                  {confidenceLabel(confidence.label)} · {Math.round(confidence.score * 100)}%
                </span>
              )
            )}
            {quality && (
              <DataQualityChip
                kind={quality.kind}
                coverage={quality.coverage}
                blockerCodes={quality.blockerCodes}
                compact
              />
            )}
          </div>
          <h2 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {title}
          </h2>
        </div>

        {evidenceWindow ? (
          <div
            className="rounded-lg px-3 py-2 shrink-0"
            style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}
          >
            <p className="section-label">Evidence period</p>
            <p className="text-[12px] font-semibold mt-0.5" style={{ color: 'var(--text-primary)' }}>
              {evidenceWindow.start} – {evidenceWindow.end} {accountTimezoneShortName()}
            </p>
          </div>
        ) : (
          // Bar 3: an absent window is stated, not left blank.
          <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
            Evidence period unavailable
          </span>
        )}
      </div>

      <p className="text-[14px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        {summary}
      </p>

      {freshness && nowMs !== undefined && (
        <FreshnessStrip label="Evidence" freshness={freshness} nowMs={nowMs} compact />
      )}

      {children}
    </div>
  )
}
