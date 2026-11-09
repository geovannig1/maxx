import Link from 'next/link'
import type { AttentionItem } from '@/lib/dashboard/attention'

// Tier 1 "Needs you today" — the ONE consolidated action surface. It REPLACES the three competing
// next-action surfaces the old page stacked inches apart (verdict "needs" chips as a to-do list, the
// OperatingModeBanner "next checks", and MorningBrief "do this first"). Renders the shared
// buildAttention() model (count + link per surface, severity-ordered) so it can never disagree with the
// verdict hero or the future /inbox, plus inline previews of the top critical alerts and tasks and the
// mode-aware manual checks. Presentational, server-rendered.

interface AlertPreview { id: string; severity: string; title: string; message: string }
interface TaskPreview { id: string; title: string; priority: string; recommendation: string | null }

// Emphasis by intrinsic severity rank (1 = most urgent). Danger for the top tier, warning for the
// middle, accent for the rest — quiet-good/loud-bad.
function attnHex(rank: number): string {
  return rank <= 1 ? 'var(--danger)' : rank <= 3 ? 'var(--warning)' : 'var(--accent)'
}

const PRIORITY_STYLE: Record<string, React.CSSProperties> = {
  urgent: { background: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--danger-border)' },
  high: { background: 'var(--warning-bg)', color: 'var(--warning)', border: '1px solid var(--warning-border)' },
  medium: { background: 'var(--info-bg)', color: 'var(--info)', border: '1px solid var(--info-border)' },
  low: { background: 'var(--bg-subtle)', color: 'var(--text-tertiary)', border: '1px solid var(--border)' },
}

export function ActionInbox({
  attention,
  criticalAlerts,
  tasks,
  manualChecks,
}: {
  attention: AttentionItem[]
  criticalAlerts: AlertPreview[]
  tasks: TaskPreview[]
  manualChecks: string[]
}) {
  const nothing = attention.length === 0 && criticalAlerts.length === 0 && tasks.length === 0 && manualChecks.length === 0
  return (
    <div className="card-base p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="section-label" style={{ margin: 0 }}>Needs you today</p>
        <Link href="/inbox" style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none' }}>Open inbox →</Link>
      </div>

      {nothing ? (
        <p className="text-[13px]" style={{ color: 'var(--text-tertiary)' }}>You&apos;re all caught up — nothing needs you right now.</p>
      ) : (
        <div className="space-y-4">
          {attention.length > 0 && (
            <ul className="space-y-1.5">
              {attention.map((a) => (
                <li key={a.key}>
                  <Link href={a.href} className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 hover:opacity-80 transition-opacity" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', textDecoration: 'none' }}>
                    <span className="rounded-full shrink-0" style={{ width: 7, height: 7, background: attnHex(a.severityRank) }} />
                    <span className="text-[12.5px] flex-1 min-w-0" style={{ color: 'var(--text-primary)' }}>{a.label}</span>
                    <span className="text-[12px]" style={{ color: 'var(--accent)' }}>→</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {criticalAlerts.length > 0 && (
            <div>
              <p className="section-label mb-1.5">Critical alerts</p>
              <div className="space-y-1.5">
                {criticalAlerts.map((al) => (
                  <div key={al.id} className="flex items-start gap-2">
                    <span className="rounded-full shrink-0 mt-1.5" style={{ width: 6, height: 6, background: al.severity === 'critical' ? 'var(--danger)' : 'var(--warning)' }} />
                    <div className="min-w-0">
                      <p className="text-[12.5px] font-medium" style={{ color: 'var(--text-primary)' }}>{al.title}</p>
                      <p className="text-[12px] truncate" style={{ color: 'var(--text-secondary)' }}>{al.message}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tasks.length > 0 && (
            <div>
              <p className="section-label mb-1.5">Tasks</p>
              <div className="space-y-1.5">
                {tasks.map((t) => (
                  <div key={t.id} className="flex items-start gap-2.5">
                    <span className="shrink-0 text-[11px] font-semibold px-2 py-0.5 rounded" style={PRIORITY_STYLE[t.priority] ?? PRIORITY_STYLE.low}>{t.priority}</span>
                    <div className="min-w-0">
                      <p className="text-[12.5px] truncate" style={{ color: 'var(--text-primary)' }}>{t.title}</p>
                      {t.recommendation && <p className="text-[12px] line-clamp-2" style={{ color: 'var(--text-secondary)' }}>{t.recommendation}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {manualChecks.length > 0 && (
            <div>
              <p className="section-label mb-1.5">Manual checks</p>
              <ol className="space-y-1" style={{ margin: 0, paddingLeft: 18 }}>
                {manualChecks.map((c, i) => (
                  <li key={i} className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>{c}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
