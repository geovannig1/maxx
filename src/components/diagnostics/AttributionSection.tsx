import type { AdUtmHealth } from '@/lib/tracking/utm-coverage'
import type { BookingLinkageAssessment } from '@/lib/tracking/utm-validator'
import { outcomeNoun } from '@/config/outcome-nouns'

// Attribution integrity card — observed readable-UTM coverage on active ads plus the booking-linkage
// advisory. It is diagnostic-only: a stored CampaignPlan must define the eventual paid-interaction
// contract, including immutable Meta IDs and readable labels.

type ObservedAdUtmHealth = Omit<AdUtmHealth, 'corrected'>
type DiagnosticBookingLinkage = Pick<
  BookingLinkageAssessment,
  'suspected' | 'label' | 'rationale'
> & {
  verification_status: 'unavailable_until_campaign_plan'
}

export interface AttributionUtm {
  tracking_contract_status: 'unavailable_until_campaign_plan'
  coverage: number | null
  scope: 'launch_cohort' | 'active_ads' | 'all_non_archived_ads'
  ads_total: number
  ads_correct: number
  ads_missing: number
  ads_misconfigured: number
  offenders: ObservedAdUtmHealth[]
  offenders_historical_count?: number
  booking_linkage: DiagnosticBookingLinkage
  source_label: string
}

const VERDICT_COLOR: Record<string, string> = {
  missing: 'var(--trust-low)', misconfigured: 'var(--warning)', correct: 'var(--success)',
}

function Pill({ text, color }: { text: string; color: string }) {
  return (
    <span className="inline-flex items-center rounded-full text-[11px] font-semibold" style={{ height: 20, padding: '0 8px', background: `${color}1f`, border: `1px solid ${color}`, color }}>
      {text}
    </span>
  )
}

export function AttributionSection({ utm }: { utm: AttributionUtm | null }) {
  if (!utm) {
    return (
      <div className="card-base p-4">
        <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
          Readable UTM diagnostics are unavailable — run a sync so observed ad tracking fields can be assessed. The paid-tracking contract remains unavailable until a CampaignPlan is stored and approved.
        </p>
      </div>
    )
  }

  const pct = utm.coverage == null ? null : `${(utm.coverage * 100).toFixed(0)}%`
  const healthy = utm.coverage != null && utm.coverage >= 1
  const scopeLabel =
    utm.scope === 'launch_cohort' ? 'observed launch cohort'
    : utm.scope === 'active_ads' ? 'active ads'
    : 'non-archived ads (none active — pre-launch)'

  return (
    <div className="card-base p-4 space-y-3">
      {/* Coverage headline */}
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          Readable UTM coverage: {utm.ads_correct} of {utm.ads_total} {scopeLabel} match the legacy diagnostic pattern {pct != null && <span className="font-normal" style={{ color: 'var(--text-tertiary)' }}>({pct})</span>}
        </h3>
        <Pill text={healthy ? 'diagnostic coverage complete' : 'diagnostic coverage gap'} color={healthy ? 'var(--success)' : 'var(--trust-low)'} />
      </div>
      <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
        {utm.ads_missing} untracked · {utm.ads_misconfigured} misconfigured — source: {utm.source_label}.
      </p>

      <div className="rounded-lg p-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
        <p className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          Tracking contract unavailable until a CampaignPlan is stored and approved.
        </p>
        <p className="mt-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          This readable-name coverage is diagnostic only. The paid-interaction contract must bind immutable Meta campaign, ad-set and ad IDs with readable names and exact {outcomeNoun({ plural: false })} linkage. Readable UTM coverage alone never unlocks paid ROAS.
        </p>
      </div>

      {/* Offenders — ACTIVE ads only (scoped to what the coverage headline measures) */}
      {utm.offenders.length > 0 && (
        <div className="space-y-1">
          <p className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>Observed active-ad tracking defects</p>
          <div className="space-y-1">
            {utm.offenders.map((ad) => (
              <div key={ad.meta_ad_id} className="flex items-baseline justify-between gap-3 py-1" style={{ borderBottom: '1px solid var(--border)' }}>
                <div className="min-w-0">
                  <span className="text-[12px] truncate" style={{ color: 'var(--text-primary)' }}>{ad.ad_name ?? ad.meta_ad_id}</span>
                  <span className="text-[11px] ml-2" style={{ color: 'var(--text-tertiary)' }}>{ad.campaign_name ?? '—'}{ad.effective_status ? ` · ${ad.effective_status}` : ''}</span>
                  {ad.verdict === 'misconfigured' && (
                    <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                      {ad.defects.map((defect) => defect.code.replaceAll('_', ' ')).join(' · ')}
                    </p>
                  )}
                </div>
                <Pill text={ad.verdict} color={VERDICT_COLOR[ad.verdict]} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Historical/paused ads with UTM gaps — cleanup, never an active-attribution problem */}
      {(utm.offenders_historical_count ?? 0) > 0 && (
        <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          {utm.offenders_historical_count} paused/historical ad{(utm.offenders_historical_count ?? 0) === 1 ? '' : 's'} also carry UTM gaps — cleanup only, they don&apos;t affect active attribution.
        </p>
      )}

      {/* Booking-linkage advisory — rationale only; never a measured fact or setup prescription. */}
      <div className="pt-1">
        <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          <strong style={{ color: utm.booking_linkage.suspected ? 'var(--warning)' : 'var(--text-secondary)' }}>{outcomeNoun({ plural: false, capitalize: true })} linkage ({utm.booking_linkage.label}):</strong> {utm.booking_linkage.rationale}
        </p>
      </div>
    </div>
  )
}
