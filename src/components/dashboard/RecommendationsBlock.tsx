import Link from 'next/link'
import type { OpenRecommendationsReadResult, StoredRecommendation } from '@/lib/recommendations/store'
import type { QuietExplanation } from '@/lib/recommendations/quiet'

// Tier 4 "Maxx recommends" — top-3 open recommendations as one-line rows (type · entity + confidence/risk),
// a count, and a link to /recommendations. When there are none, the honest "why Maxx is quiet" panel
// (explainQuiet) names the exact gate holding Maxx back and what would unlock deeper analysis — not a
// generic "no recs yet." Presentational, server-rendered. The rec-row markup is lifted from the old
// OperatingModeBanner "standing recommendations" preview (its former home).

function riskHex(level: string): string {
  return level === 'high' ? 'var(--danger)' : level === 'medium' ? 'var(--warning)' : 'var(--success)'
}

export function RecommendationReadNotice({ read }: { read: OpenRecommendationsReadResult }) {
  if (read.health === 'healthy') return null
  const unavailable = read.health === 'unavailable'
  return (
    <div
      className="rounded-lg px-4 py-3"
      style={{
        background: unavailable ? 'color-mix(in srgb, var(--danger) 8%, transparent)' : 'color-mix(in srgb, var(--warning) 8%, transparent)',
        border: `1px solid ${unavailable ? 'var(--danger)' : 'var(--warning)'}`,
      }}
      role="status"
    >
      <p className="text-[13px] font-semibold" style={{ color: unavailable ? 'var(--danger)' : 'var(--warning)' }}>
        {unavailable ? 'Recommendations unavailable' : 'Recommendation feed is incomplete'}
      </p>
      <p className="text-[12px] mt-1" style={{ color: 'var(--text-secondary)' }}>
        {unavailable
          ? 'The current feed could not be read, so we cannot say whether Maxx has current recommendations.'
          : `${read.visibleCount} visible · ${read.quarantinedCount ?? 'unknown'} quarantined. Do not treat the visible set as complete.`}
      </p>
      {read.reasons.length > 0 && (
        <ul className="mt-2 space-y-1">
          {read.reasons.map((reason) => (
            <li key={`${reason.code}-${reason.affectedCount ?? 'unknown'}`} className="text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
              • {reason.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function RecommendationsBlock({
  recs,
  awaitingDecisionCount,
  quiet,
  read,
}: {
  recs: StoredRecommendation[]
  awaitingDecisionCount: number
  quiet: QuietExplanation
  read: OpenRecommendationsReadResult
}) {
  const top = recs.slice(0, 3)
  return (
    <div className="card-base p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="section-label" style={{ margin: 0 }}>Maxx recommends</p>
        <Link href="/recommendations" style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none' }}>View all →</Link>
      </div>

      {read.health !== 'healthy' && (
        <div className="mb-3"><RecommendationReadNotice read={read} /></div>
      )}

      {recs.length === 0 && read.health === 'healthy' ? (
        <div>
          <p className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{quiet.title}</p>
          {quiet.reasons.length > 0 && (
            <ul className="mt-2 space-y-1">
              {quiet.reasons.map((r, i) => (
                <li key={i} className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>• {r}</li>
              ))}
            </ul>
          )}
          {quiet.unlocks.length > 0 && (
            <>
              <p className="section-label mt-3 mb-1.5">What unlocks deeper analysis</p>
              <ul className="space-y-1">
                {quiet.unlocks.map((u, i) => (
                  <li key={i} className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>→ {u}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : recs.length > 0 ? (
        <>
          <div className="space-y-2">
            {top.map((r) => (
              <div key={r.id} className="rounded-lg px-3 py-2.5" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full" style={{ background: 'var(--accent-dim)', color: 'var(--accent)', border: '1px solid var(--border-focus)' }}>
                    {r.recommendation_type.replace(/_/g, ' ')}
                  </span>
                  <span className="text-[12.5px] font-medium min-w-0 truncate" style={{ color: 'var(--text-primary)' }}>
                    {r.target_entity_name ?? r.target_entity_type}
                  </span>
                  <span className="text-[11px] ml-auto whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>
                    conf {r.confidence_label} · <span style={{ color: riskHex(r.risk_level) }}>{r.risk_level} risk</span>
                  </span>
                </div>
                <p className="text-[12px] mt-1" style={{ color: 'var(--text-secondary)' }}>{r.observed_fact}</p>
              </div>
            ))}
          </div>
          <p className="text-[12px] mt-3" style={{ color: 'var(--text-tertiary)' }}>
            {recs.length} open recommendation{recs.length === 1 ? '' : 's'}
            {awaitingDecisionCount > 0 && (
              <> · <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{awaitingDecisionCount} awaiting your decision</span></>
            )}
            {' · '}
            <Link href="/recommendations" style={{ color: 'var(--accent)', textDecoration: 'none' }}>review →</Link>
          </p>
        </>
      ) : null}
    </div>
  )
}
