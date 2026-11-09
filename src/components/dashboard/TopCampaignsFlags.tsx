import Link from 'next/link'
import type { CampaignRow, FlagRow } from '@/components/dashboard/dashboard-data'

// Tier 3 (money) detail tables — Top Campaigns + Active Flags, at the bottom of the money tier. Meta paid;
// the caller hides this in the Organic view. Presentational, server-rendered. (The old standalone
// "Open Tasks" column is gone — the Action Inbox owns tasks now.)

export function TopCampaignsFlags({
  topCampaigns,
  flags,
  dataWindow,
}: {
  topCampaigns: CampaignRow[]
  flags: FlagRow[]
  dataWindow: string
}) {
  return (
    <div className="space-y-4">
      {/* Campaigns table */}
      <div className="card-base overflow-hidden">
        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
          <p className="section-label">Top Campaigns ({dataWindow})</p>
          <Link href="/performance/campaigns" className="hover:opacity-70 transition-opacity"
            style={{ fontSize: '12px', color: 'var(--accent)', textDecoration: 'none' }}>
            View all →
          </Link>
        </div>
        {topCampaigns.length === 0 ? (
          <p className="px-5 py-5 text-sm" style={{ color: 'var(--text-tertiary)' }}>No campaign data yet.</p>
        ) : (
          <div className="overflow-x-auto"><table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Campaign</th>
                <th style={{ textAlign: 'right' }}>Spend</th>
                <th style={{ textAlign: 'right' }}>Leads</th>
                <th style={{ textAlign: 'right' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {topCampaigns.map((c: CampaignRow, i) => (
                <tr key={i}>
                  <td style={{ color: 'var(--text-tertiary)', width: '32px' }}>{i + 1}</td>
                  <td style={{ color: 'var(--text-primary)' }}>
                    {c.campaign_name ?? c.meta_campaign_id ?? `Campaign ${i + 1}`}
                  </td>
                  <td style={{ color: 'var(--text-secondary)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    ${(c.spend ?? 0).toFixed(0)}
                  </td>
                  <td style={{ color: 'var(--text-secondary)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {c.leads ?? 0}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span style={{
                      fontSize: '11px', fontWeight: 600,
                      color: c.status === 'ACTIVE' ? 'var(--success)' : 'var(--text-tertiary)',
                      background: c.status === 'ACTIVE' ? 'var(--success-bg)' : 'var(--border)',
                      border: `1px solid ${c.status === 'ACTIVE' ? 'rgba(52,211,213,0.25)' : 'var(--border)'}`,
                      borderRadius: '5px', padding: '2px 7px',
                    }}>
                      {c.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>

      {/* Active Flags */}
      {flags.length > 0 && (
        <div className="card-base overflow-hidden">
          <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
            <p className="section-label">Active Flags</p>
            <Link href="/performance/flags" className="hover:opacity-70 transition-opacity"
              style={{ fontSize: '12px', color: 'var(--accent)', textDecoration: 'none' }}>
              View all →
            </Link>
          </div>
          <div>
            {flags.map((f: FlagRow, i) => {
              const entityId = f.meta_ad_id ?? f.meta_adset_id ?? '—'
              return (
                <div key={i} className="flex items-start gap-3 px-5 py-3" style={{ borderBottom: i < flags.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <span style={{
                    fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '100px', flexShrink: 0,
                    ...(f.flag_type === 'winner' ? { background: 'var(--success-bg)', color: 'var(--success)', border: '1px solid var(--success-border)' }
                      : f.flag_type === 'loser' ? { background: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--danger-border)' }
                      : { background: 'var(--accent-dim)', color: 'var(--accent)', border: '1px solid var(--border-focus)' })
                  }}>
                    {f.flag_type.replaceAll('_', ' ')}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate" style={{ color: 'var(--text-secondary)' }}>
                      {f.ad_name ?? f.adset_name ?? entityId}
                    </p>
                    <p className="text-xs truncate" style={{ color: 'var(--text-tertiary)' }}>{f.reason}</p>
                  </div>
                  {f.cpa_in_window !== null && (
                    <span className="text-xs shrink-0" style={{ color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                      ${f.cpa_in_window.toFixed(2)}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
