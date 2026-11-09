import type { OperatingModeResult } from '@/lib/modes/operating-mode'

// Slim operating-mode strip (Tier 1). One line: mode chip + focus. The reason and the capability
// restrictions live behind a small expander so they stay accessible without competing for the eye.
// Write-mode state is owned by the Topbar (rendered once, app-wide), so this strip no longer repeats it —
// the WRITE-MODE chip is dropped and the write-mode restriction line is filtered out here. The standing
// recommendations and the mode-aware next checks moved to RecommendationsBlock and ActionInbox.
// Server-rendered.

const MODE_COLOR: Record<string, { fg: string; bg: string; bd: string }> = {
  pre_launch: { fg: 'var(--warning)', bg: 'rgba(251,191,36,0.10)', bd: 'rgba(251,191,36,0.30)' },
  low_data: { fg: 'var(--warning)', bg: 'rgba(251,191,36,0.08)', bd: 'var(--warning-border)' },
  active_learning: { fg: 'var(--info)', bg: 'rgba(96,165,250,0.08)', bd: 'var(--info-border)' },
  sufficient: { fg: 'var(--success)', bg: 'rgba(52,211,153,0.08)', bd: 'var(--success-border)' },
}

export function OperatingModeBanner({ mode }: { mode: OperatingModeResult }) {
  const c = MODE_COLOR[mode.dataMode] ?? MODE_COLOR.low_data
  // Write-mode reassurance is Topbar-owned; drop the duplicate restriction line so it renders once on Today.
  const restrictions = mode.restrictions.filter((r) => !r.toLowerCase().includes('write mode'))
  return (
    <div className="card-base px-4 py-3">
      <div className="flex items-center gap-2.5 flex-wrap">
        <span className="section-label" style={{ margin: 0 }}>Mode</span>
        <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 100, color: c.fg, background: c.bg, border: `1px solid ${c.bd}` }}>{mode.label}</span>
        <span className="text-[12.5px] min-w-0" style={{ color: 'var(--text-secondary)' }}>
          <strong style={{ color: 'var(--text-secondary)' }}>Focus:</strong> {mode.focus}
        </span>
      </div>
      <details className="mt-2">
        <summary className="text-[11px] font-semibold cursor-pointer" style={{ color: 'var(--accent)' }}>Why this mode &amp; what it restricts</summary>
        <p className="text-[12.5px] mt-2" style={{ color: 'var(--text-secondary)' }}>{mode.reason}</p>
        {restrictions.length > 0 && (
          <ul className="mt-2" style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 3 }}>
            {restrictions.map((r, i) => (
              <li key={i} className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>· {r}</li>
            ))}
          </ul>
        )}
      </details>
    </div>
  )
}
