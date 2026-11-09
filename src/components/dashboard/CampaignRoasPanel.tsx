import { getAdminClient } from '@/lib/supabase/admin'
import { getPerCampaignRoas } from '@/lib/analytics/campaign-roas'
import { nyDaysAgo } from '@/lib/utils/date-utils'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { outcomeNoun } from '@/config/outcome-nouns'
import { formatMoney } from '@/lib/utils/format-currency'

// Campaign-level association diagnostics. A GA Paid Social session does not prove Meta platform
// provenance, and Meta view-through outcomes cannot carry GA session attribution, so this surface
// never promotes the linked amount into exact Meta paid ROAS.

const usd = (n: number | null | undefined) => (n == null ? 'n/a' : formatMoney(Number(n), { maximumFractionDigits: 0 }))

export async function CampaignRoasPanel() {
  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) return null

  const start = nyDaysAgo(30)
  const end = nyDaysAgo(1)

  let data: Awaited<ReturnType<typeof getPerCampaignRoas>>
  try {
    data = await getPerCampaignRoas(activeAccount.account.id, start, end)
  } catch {
    return (
      <div className="card-base p-5 space-y-2">
        <h2 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
          Campaign performance unavailable
        </h2>
        <p style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
          The campaign data could not be read. Spend, {outcomeNoun()}, amounts paid on active {outcomeNoun()}, and return metrics are unavailable — this is not a zero-spend result.
        </p>
      </div>
    )
  }

  const share = data.attributed_share

  const label = { fontSize: '11px', textTransform: 'uppercase' as const, letterSpacing: '0.06em', color: 'var(--text-tertiary)' }

  return (
    <div className="card-base p-5 space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
            Campaign value attribution diagnostics
          </h2>
          <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
            Last 30 days ({start} to {end}). Exact {outcomeNoun({ plural: false })} identity may associate amount paid on active {outcomeNoun()} with a GA session, but GA Paid Social can contain other platforms and Meta view-through outcomes have no GA session. That association is not exact Meta ROAS.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '20px', textAlign: 'right' }}>
          <div>
            <div style={label}>Exact Meta paid ROAS — unavailable</div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>
              {data.paid.roas == null ? 'unavailable' : data.paid.roas.toFixed(2) + 'x'}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
              {data.paid.attribution_reason} Unavailable is not zero. GA telemetry for context: {data.paid.ga4_confirmation_events} confirmation event(s), {usd(data.paid.ga4_event_value)} GA event value — not {outcomeNoun()}, not revenue.
            </div>
          </div>
          <div>
            <div style={label}>Active amount / Meta spend</div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>
              {data.account.mer == null ? 'unavailable' : data.account.mer.toFixed(2) + 'x'}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
              {data.account.mer == null
                ? `${data.account.revenue_coverage_reason ?? data.campaign_spend_reason ?? `The complete amount paid on active ${outcomeNoun()} and Meta spend are required.`}`
                : `Amount paid on active ${outcomeNoun()} / ${usd(data.account.meta_spend)} complete Meta spend. Active ${outcomeNoun()} only.`}
            </div>
          </div>
        </div>
      </div>

      {(data.spend_basis !== 'account_level_insights' || !data.campaign_mapping_complete) && (
        <div style={{ padding: '10px 14px', borderRadius: '8px', fontSize: '12.5px', background: 'rgba(251,191,36,0.08)', border: '1px solid var(--warning-border)', color: 'var(--warning)' }}>
          {data.spend_basis !== 'account_level_insights' && <div>{data.campaign_spend_reason}</div>}
          {!data.campaign_mapping_complete && <div>{data.campaign_mapping_reason}</div>}
        </div>
      )}

      <div style={{ padding: '10px 14px', borderRadius: '8px', fontSize: '12.5px', background: 'rgba(251,191,36,0.08)', border: '1px solid var(--warning-border)', color: 'var(--warning)' }}>
        {data.ga4Available
          ? `GA campaign attribution covers ${share == null ? 'an unavailable share' : `${Math.round(share * 100)}%`} of GA confirmation events. This is session telemetry, not proof of Meta platform attribution. Unattributed: ${data.unattributed.ga4_confirmation_events} confirmation event(s) / ${usd(data.unattributed.ga4_event_value)} GA event value.${
              data.meta_view_through_share != null
                ? ` ${Math.round(data.meta_view_through_share * 100)}% of Meta-reported ${outcomeNoun({ plural: false })} events were view-through and therefore cannot carry GA session attribution.`
                : ''
            }`
          : `GA4 session telemetry is unavailable. Exact Meta paid ROAS remains unavailable; the amount-paid/spend diagnostic on active ${outcomeNoun()} is a separate account-level quantity.`}
      </div>

      {data.rows.length > 0 ? (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-tertiary)' }}>
                <th style={{ padding: '6px 8px', ...label }}>Campaign</th>
                <th style={{ padding: '6px 8px', textAlign: 'right', ...label }}>Spend</th>
                <th style={{ padding: '6px 8px', textAlign: 'right', ...label }}>Meta Results (modelled 7dc/1dv)</th>
                <th style={{ padding: '6px 8px', textAlign: 'right', ...label }}>Confirmation events · GA telemetry</th>
                <th style={{ padding: '6px 8px', textAlign: 'right', ...label }}>Amount paid · active {outcomeNoun()} (GA session association)</th>
                <th style={{ padding: '6px 8px', textAlign: 'right', ...label }}>Exact Meta paid ROAS — unavailable</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                  <td style={{ padding: '8px', color: 'var(--text-primary)' }}>{r.campaign_name}</td>
                  <td style={{ padding: '8px', textAlign: 'right' }}>{usd(r.meta_spend)}</td>
                  <td style={{ padding: '8px', textAlign: 'right' }}>{r.meta_bookings_est}</td>
                  <td style={{ padding: '8px', textAlign: 'right' }}>{r.ga4_confirmation_events}</td>
                  <td style={{ padding: '8px', textAlign: 'right' }}>{r.exact_checkout_revenue == null ? '—' : usd(r.exact_checkout_revenue)}</td>
                  <td style={{ padding: '8px', textAlign: 'right', fontWeight: 700, color: r.roas != null && r.roas >= 1 ? 'var(--success)' : 'var(--text-primary)' }}>
                    {r.roas == null ? 'unavailable' : r.roas.toFixed(2) + 'x'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : data.spend_basis === 'account_level_insights' && data.account.meta_spend === 0 ? (
        <p style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>No campaign spend in this window.</p>
      ) : (
        <p style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>Campaign performance unavailable — an authoritative Meta spend read was not available, so an empty campaign list is not treated as zero spend.</p>
      )}
    </div>
  )
}
