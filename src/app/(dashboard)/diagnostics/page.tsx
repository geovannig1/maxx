'use client'

import { useState, useEffect } from 'react'
import { ShieldCheck } from 'lucide-react'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { DateRangeControl, type DateRangeValue } from '@/components/ui/DateRangeControl'
import { PageHeader } from '@/components/layout/PageHeader'
import { useGlobalControls } from '@/lib/use-global-controls'
import { comparisonLabel } from '@/lib/insights/compare'
import { TrustBreakdown } from '@/components/trust/TrustBadge'
import { ReconciliationSection } from '@/components/diagnostics/ReconciliationSection'
import { AttributionSection, type AttributionUtm } from '@/components/diagnostics/AttributionSection'
import { AnomalySection } from '@/components/diagnostics/AnomalySection'
import { QualitySection } from '@/components/diagnostics/QualitySection'
import { VerdictHeader, diagnosticsStatusCards } from '@/components/diagnostics/VerdictHeader'
import { PlainTrustVerdict } from '@/components/diagnostics/PlainTrustVerdict'
import { DecisionGateSection } from '@/components/diagnostics/DecisionGateSection'
import { DIAGNOSTICS_ANCHORS } from '@/lib/trust/status-cards'
import type { TrustScore } from '@/lib/trust/trust'
import type { SpendIntegrityResult, PlaneConflictResult, BilledContextResult } from '@/lib/diagnostics/reconcile'
import type { AnomalyExplanation } from '@/lib/diagnostics/anomaly'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

interface ReconResp { attribution_window_label: string; integrity: SpendIntegrityResult; money: PlaneConflictResult; billed: BilledContextResult; trust: TrustScore; utm: AttributionUtm | null; data_age_hours: number | null; ga4_available: boolean }
interface AnomResp { anomalies: AnomalyExplanation[]; movements: AnomalyExplanation[] }
// QualitySection props are structural — accept the route shape loosely here.
interface QualResp { ads: Parameters<typeof QualitySection>[0]['ads']; adsets: Parameters<typeof QualitySection>[0]['adsets']; coverage: { total_ads_with_spend: number; rated_ads: number } }

function Section({ id, title, subtitle, children }: { id?: string; title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div id={id} className="space-y-2">
      <div>
        <h2 className="text-[14px] font-bold" style={{ color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>{title}</h2>
        {subtitle && <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>{subtitle}</p>}
      </div>
      {children}
    </div>
  )
}

export default function DiagnosticsPage() {
  // Persisted GLOBAL range (URL + localStorage) so the range carries over from other pages
  // instead of silently resetting to 1M on each visit.
  const { range, setRange } = useGlobalControls()
  const [recon, setRecon] = useState<ReconResp | null>(null)
  const [anom, setAnom] = useState<AnomResp | null>(null)
  const [qual, setQual] = useState<QualResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0) // bump to refetch (e.g. on retry)

  const { from, to } = range
  const priorLabel = comparisonLabel(from, to)

  // Fetch on range/refetch. The IIFE awaits first so no setState runs synchronously inside the effect
  // (loading is shown via the event handlers below — see settings/page.tsx for the same pattern).
  useEffect(() => {
    let active = true
    void (async () => {
      const [r, a, q] = await Promise.all([
        fetch(`/api/diagnostics/reconciliation?from=${from}&to=${to}`, { cache: 'no-store' }),
        fetch(`/api/diagnostics/anomalies?from=${from}&to=${to}`, { cache: 'no-store' }),
        fetch(`/api/diagnostics/quality?from=${from}&to=${to}`, { cache: 'no-store' }),
      ])
      if (!active) return
      if (!r.ok || !a.ok || !q.ok) { setError('Failed to load diagnostics.'); setLoading(false); return }
      setRecon(await r.json()); setAnom(await a.json()); setQual(await q.json())
      setError(null)
      setLoading(false)
    })().catch(() => { if (active) { setError('Failed to load diagnostics.'); setLoading(false) } })
    return () => { active = false }
  }, [from, to, nonce])

  // setState in event handlers is fine — this is how we show the loading state on a range change / retry.
  function onRange(v: DateRangeValue) { setLoading(true); setError(null); setRange(v) }
  function onRetry() { setLoading(true); setError(null); setNonce((n) => n + 1) }

  return (
    <div className="space-y-6">
      {/* Header — shared PageHeader. Global chrome (freshness / write-mode / Trust) lives in the top bar. */}
      <PageHeader
        title="Diagnostics & Trust"
        icon={ShieldCheck}
        subtitle={`Is the data trustworthy? Four verdicts up top, then the evidence. ${from} → ${to}`}
        controls={<DateRangeControl value={range} onChange={onRange} />}
      />

      {error ? (
        <ErrorState title="Couldn't load diagnostics" onRetry={onRetry} />
      ) : loading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}
        </div>
      ) : (
        <>
          {/* Plain verdict, then the four cards it summarises — both from ONE computeStatusCards() call,
              the same one the dashboard TrustStrip renders, so no surface tells a different story. */}
          {recon && (() => {
            const cards = diagnosticsStatusCards({
              ga4Available: recon.ga4_available,
              utm: recon.utm,
              attributedShare: recon.money.attributionCoverage,
              dataAgeHours: recon.data_age_hours,
              integrityStatus: recon.integrity.status,
              trust: recon.trust,
              moneyDirection: recon.money.direction,
            })
            return <>
              <PlainTrustVerdict cards={cards} integrity={recon.integrity.status} />
              <VerdictHeader cards={cards} />
            </>
          })()}

          {/* Why there is or is not new advice. Rendered unconditionally and FIRST: it does not depend
              on the reconciliation fetch, and when advice is frozen this is the question the owner
              actually came here with. */}
          <Section id={DIAGNOSTICS_ANCHORS.decisionGate} title="Can Maxx generate new advice?" subtitle="Four checks must all pass before flags and recommendations are regenerated. This is the last sync's own record of them — not an inference.">
            <div className="card-base p-4"><DecisionGateSection /></div>
          </Section>

          {/* Overall data trust */}
          {recon && (
            <Section title="Data trust" subtitle={`A 95% score means safe to act without caveat. ${recon.ga4_available ? 'GA confirmation-event telemetry is available — it is attribution context, not money, so a revenue claim resting on it can never reach this bar.' : 'GA telemetry unavailable.'}`}>
              <div className="card-base p-4"><TrustBreakdown trust={recon.trust} /></div>
            </Section>
          )}

          {/* Reconciliation */}
          {recon && (
            <Section id={DIAGNOSTICS_ANCHORS.reconciliation} title="Do the numbers agree?" subtitle="Meta-internal integrity, Meta-modelled vs GA-event plane conflict, outcome business facts, and lifetime billed context.">
              <ReconciliationSection integrity={recon.integrity} money={recon.money} billed={recon.billed} attributionLabel={recon.attribution_window_label} />
            </Section>
          )}

          {/* Attribution instrumentation */}
          {recon && (
            <Section id={DIAGNOSTICS_ANCHORS.attribution} title="Can we tell which campaign gets credit?" subtitle={`UTM/session telemetry plus exact ${OW.one} identity — paid claims stay unavailable until the full join and spend mapping are complete.`}>
              <AttributionSection utm={recon.utm} />
            </Section>
          )}

          {/* Anomalies */}
          {anom && (
            <Section id={DIAGNOSTICS_ANCHORS.anomalies} title="What changed and why" subtitle={`What moved ${priorLabel}, decomposed into the arithmetic driver and the campaign behind it.`}>
              <AnomalySection anomalies={anom.anomalies} movements={anom.movements} priorLabel={priorLabel} />
            </Section>
          )}

          {/* Auction quality + delivery evidence */}
          {qual && (
            <Section title="Ad auction &amp; delivery evidence" subtitle="Describes delivery conditions only. It does not evaluate paid outcomes or recommend a change.">
              <QualitySection ads={qual.ads} adsets={qual.adsets} coverage={qual.coverage} />
            </Section>
          )}
        </>
      )}
    </div>
  )
}
