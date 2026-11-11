'use client'

import { TrustBadge } from '@/components/trust/TrustBadge'
import { rankingInfo, type QualityVerdict } from '@/lib/diagnostics/rankings'
import type { DeliveryDiagnosticResult, DeliveryDiagnosticStatus, DeliverySignalState } from '@/lib/diagnostics/opportunity'
import { formatMoneyTrim } from '@/lib/utils/format-currency'

interface AdRow {
  ad_id: string
  ad_name: string
  spend: number
  impressions: number
  quality_ranking: string | null
  engagement_rate_ranking: string | null
  conversion_rate_ranking: string | null
  verdict: QualityVerdict
}

interface AdsetRow {
  adset_id: string
  adset_name: string
  spend: number
  delivery_diagnostic: DeliveryDiagnosticResult
}

const TONE_COLOR = { good: 'var(--success)', neutral: 'var(--text-tertiary)', bad: 'var(--trust-low)' } as const
const DELIVERY_COLOR: Record<DeliveryDiagnosticStatus, string> = { evidence_available: 'var(--accent)', notable_observation: 'var(--warning)', insufficient_evidence: 'var(--text-tertiary)' }
const SIGNAL_COLOR: Record<DeliverySignalState, string> = { observed: 'var(--text-tertiary)', notable: 'var(--warning)', unavailable: 'var(--text-tertiary)' }
const VERDICT_COLOR: Record<QualityVerdict, string> = { strong: 'var(--success)', ok: 'var(--accent)', weak: 'var(--trust-low)', unrated: 'var(--text-tertiary)' }

function RankPill({ raw }: { raw: string | null }) {
  const info = rankingInfo(raw)
  const color = TONE_COLOR[info.tone]
  return <span className="text-[11px] rounded px-1.5 py-0.5" style={{ background: `${color}1a`, color, border: `1px solid ${color}55` }}>{info.label}</span>
}

export function QualitySection({ ads, adsets, coverage }: { ads: AdRow[]; adsets: AdsetRow[]; coverage: { total_ads_with_spend: number; rated_ads: number } }) {
  return (
    <div className="space-y-4">
      {/* Auction and delivery evidence (ad-set level) */}
      <div>
        <h3 className="text-[13px] font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Auction &amp; delivery evidence <span className="font-normal text-[11px]" style={{ color: 'var(--text-tertiary)' }}>— diagnostic only; no change is recommended here</span></h3>
        {adsets.length === 0 ? (
          <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>No ad sets delivered in this window.</p>
        ) : (
          <div className="space-y-2">
            {adsets.slice(0, 8).map((a) => (
              <div key={a.adset_id} className="card-base p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[12.5px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{a.adset_name}</p>
                    <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{formatMoneyTrim(a.spend)} delivered in this window</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[11px] font-semibold rounded-full px-2 py-0.5" style={{ background: `${DELIVERY_COLOR[a.delivery_diagnostic.status]}1f`, border: `1px solid ${DELIVERY_COLOR[a.delivery_diagnostic.status]}`, color: DELIVERY_COLOR[a.delivery_diagnostic.status] }}>
                      {a.delivery_diagnostic.status.replaceAll('_', ' ')}
                    </span>
                    <TrustBadge score={a.delivery_diagnostic.trust.score} level={a.delivery_diagnostic.trust.level} />
                  </div>
                </div>
                <p className="text-[11.5px] mt-1.5" style={{ color: 'var(--text-secondary)' }}>{a.delivery_diagnostic.summary}</p>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {a.delivery_diagnostic.signals.map((s) => (
                    <span key={s.key} className="text-[10.5px] rounded px-1.5 py-0.5" style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: SIGNAL_COLOR[s.state] }}>
                      {s.label} — {s.detail.replace(/_/g, ' ')}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Auction quality rankings (ad level) */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>Auction quality rankings</h3>
          <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{coverage.rated_ads}/{coverage.total_ads_with_spend} ads rated</span>
        </div>
        {coverage.rated_ads === 0 ? (
          <p className="text-[12px] card-base p-4" style={{ color: 'var(--text-tertiary)' }}>
            No ads rated yet. Meta only returns quality / engagement / conversion rankings once an ad clears ~500 impressions, and they populate on the next nightly sync (these rankings are now collected for each ad).
          </p>
        ) : (
          <div className="card-base overflow-hidden">
            <div className="overflow-x-auto"><table className="data-table">
              <thead><tr>
                <th className="text-left" style={{ color: 'var(--text-tertiary)' }}>Ad</th>
                <th className="text-right" style={{ color: 'var(--text-tertiary)' }}>Spend</th>
                <th className="text-left" style={{ color: 'var(--text-tertiary)' }}>Quality</th>
                <th className="text-left" style={{ color: 'var(--text-tertiary)' }}>Engagement</th>
                <th className="text-left" style={{ color: 'var(--text-tertiary)' }}>Conversion</th>
                <th className="text-left" style={{ color: 'var(--text-tertiary)' }}>Summary</th>
              </tr></thead>
              <tbody>
                {ads.slice(0, 25).map((a) => (
                  <tr key={a.ad_id}>
                    <td className="font-medium max-w-[220px] truncate" style={{ color: 'var(--text-primary)' }}>{a.ad_name}</td>
                    <td className="text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>{formatMoneyTrim(a.spend)}</td>
                    <td><RankPill raw={a.quality_ranking} /></td>
                    <td><RankPill raw={a.engagement_rate_ranking} /></td>
                    <td><RankPill raw={a.conversion_rate_ranking} /></td>
                    <td><span className="text-[11px] font-semibold" style={{ color: VERDICT_COLOR[a.verdict] }}>{a.verdict}</span></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        )}
      </div>
    </div>
  )
}
