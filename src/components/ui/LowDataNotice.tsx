import { Sparkles } from 'lucide-react'

// The calibration banner (design-system §7.2) — the critical low-data primitive. For a dormant/low-data
// account this is the dominant experience, so it must read as "still warming up," NOT "broken." It says
// plainly: not enough signal yet, here's what we have vs what's needed, and what unlocks confidence.
// Trust down-ranks automatically elsewhere; this explains WHY the numbers are directional or absent.

interface CalibrationItem {
  label: string
  have: string
  need?: string
}

export function LowDataNotice({
  title = 'Still warming up',
  message,
  items,
  tone = 'info',
}: {
  title?: string
  message: string
  items?: CalibrationItem[] // e.g. { label: 'Bookings', have: '1', need: '≥ 5 for scale calls' }
  tone?: 'info' | 'warning'
}) {
  const accent = tone === 'warning' ? 'var(--warning)' : 'var(--info)'
  const bg = tone === 'warning' ? 'rgba(251,191,36,0.06)' : 'rgba(96,165,250,0.06)'
  const border = tone === 'warning' ? 'rgba(251,191,36,0.22)' : 'rgba(96,165,250,0.22)'
  return (
    <div
      className="rounded-lg px-4 py-3"
      style={{ background: bg, border: `1px solid ${border}` }}
    >
      <div className="flex items-start gap-2.5">
        <Sparkles className="w-4 h-4 mt-0.5 shrink-0" style={{ color: accent }} />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</p>
          <p className="text-[12px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>{message}</p>
          {items && items.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
              {items.map((it) => (
                <div key={it.label} className="text-[11.5px]">
                  <span style={{ color: 'var(--text-tertiary)' }}>{it.label}: </span>
                  <span className="font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>{it.have}</span>
                  {it.need && <span style={{ color: 'var(--text-tertiary)' }}> · need {it.need}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
