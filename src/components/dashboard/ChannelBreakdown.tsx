import type { ChannelRow } from '@/lib/ga4/client'
import { formatMoney } from '@/lib/utils/format-currency'

// Per-channel breakdown — the depth behind the Paid/Organic split. Merges GA4 traffic-by-channel and
// revenue-by-channel so you can see EXACTLY which channels compose the selected bucket (e.g. confirm
// "Paid = Paid Social = Meta", not Google). GA4-classified, so it's reliable regardless of UTM health.

/** GA confirmation-event telemetry per channel — not bookings, not revenue. */
interface RevenueChannelRow { channel: string; source: 'paid' | 'organic'; confirmationEvents: number; eventValue: number }

export function ChannelBreakdown({
  traffic,
  revenue,
  source,
}: {
  traffic: ChannelRow[]
  revenue: RevenueChannelRow[]
  source: 'paid' | 'organic'
}) {
  // Merge the two channel lists into one row per channel for the selected source.
  const byChannel = new Map<string, { channel: string; sessions: number; eventValue: number; confirmationEvents: number }>()
  for (const t of traffic) {
    if (t.source !== source) continue
    const r = byChannel.get(t.channel) ?? { channel: t.channel, sessions: 0, eventValue: 0, confirmationEvents: 0 }
    r.sessions += t.sessions
    byChannel.set(t.channel, r)
  }
  for (const rv of revenue) {
    if (rv.source !== source) continue
    const r = byChannel.get(rv.channel) ?? { channel: rv.channel, sessions: 0, eventValue: 0, confirmationEvents: 0 }
    r.eventValue += rv.eventValue
    r.confirmationEvents += rv.confirmationEvents
    byChannel.set(rv.channel, r)
  }
  const rows = [...byChannel.values()].sort((a, b) => b.sessions - a.sessions || b.eventValue - a.eventValue)
  if (rows.length === 0) return null

  const totalSessions = rows.reduce((s, r) => s + r.sessions, 0)

  return (
    <div className="card-base overflow-hidden">
      <div className="px-5 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <p className="section-label">Channels in this view — GA4 default channel grouping</p>
      </div>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Channel</th>
              <th style={{ textAlign: 'right' }}>Sessions</th>
              <th style={{ textAlign: 'right' }}>Share</th>
              <th style={{ textAlign: 'right' }}>Confirmation events</th>
              <th style={{ textAlign: 'right' }}>GA event value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.channel}>
                <td style={{ color: 'var(--text-primary)' }}>{r.channel}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>{r.sessions.toLocaleString()}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-tertiary)' }}>{totalSessions > 0 ? `${Math.round((r.sessions / totalSessions) * 100)}%` : '—'}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>{r.confirmationEvents > 0 ? Math.round(r.confirmationEvents) : '—'}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>{r.eventValue > 0 ? `${formatMoney(r.eventValue, { maximumFractionDigits: 0 })}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
