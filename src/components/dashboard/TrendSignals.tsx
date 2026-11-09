import { getAdminClient } from '@/lib/supabase/admin'
import { Rss, ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { nyDaysAgo } from '@/lib/utils/date-utils'

interface SignalRow {
  id: string
  title: string
  source_name: string
}

export async function TrendSignals() {
  const db = getAdminClient()
  const fourteenDaysAgo = nyDaysAgo(14)

  // Only OWNER-APPROVED insights reach the dashboard (035 review gate). Pre-migration the filter
  // errors ⇒ raw stays null ⇒ the component renders nothing — fail-closed.
  const { data: raw } = await db
    .from('expert_insights')
    .select('id, title, expert_sources(name)')
    .eq('applies_to_account', true)
    .eq('review_status', 'approved')
    .gte('published_at', fourteenDaysAgo)
    .order('published_at', { ascending: false })
    .limit(3)

  const signals: SignalRow[] = (raw ?? []).map((r) => {
    const row = r as unknown as {
      id: string
      title: string
      expert_sources: { name: string } | { name: string }[] | null
    }
    const sourceName = Array.isArray(row.expert_sources)
      ? (row.expert_sources[0]?.name ?? 'Unknown')
      : (row.expert_sources?.name ?? 'Unknown')
    return { id: row.id, title: row.title, source_name: sourceName }
  })

  if (signals.length === 0) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
      {/* Label row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Rss style={{ width: '12px', height: '12px', color: 'var(--accent)' }} />
        <span className="section-label">What&apos;s trending</span>
        <span style={{ fontSize: '10px', fontWeight: 700, padding: '1px 6px', background: 'var(--accent-dim)', color: 'var(--accent)', borderRadius: '100px' }}>
          {signals.length}
        </span>
      </div>

      {/* Signal rows */}
      {signals.map(s => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />
          <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {s.title}
          </span>
          <span style={{ fontSize: '10.5px', color: 'var(--text-tertiary)', flexShrink: 0 }}>
            {s.source_name}
          </span>
          <Link href="/signals">
            <ExternalLink style={{ width: '11px', height: '11px', color: 'var(--text-disabled)', flexShrink: 0 }} />
          </Link>
        </div>
      ))}

      {/* View all */}
      <div style={{ textAlign: 'right' }}>
        <Link href="/signals" style={{ fontSize: '12px', color: 'var(--accent)', textDecoration: 'none' }}>
          View all signals →
        </Link>
      </div>
    </div>
  )
}
