import { AlertTriangle, CircleDashed, HelpCircle, LockKeyhole, RefreshCw } from 'lucide-react'

export type StatePanelState = 'loading' | 'empty' | 'unavailable' | 'unknown' | 'blocked' | 'error'

export const STATE_PANEL_COPY: Record<StatePanelState, { label: string; tone: string }> = {
  loading: { label: 'Loading', tone: 'neutral' },
  empty: { label: 'No records', tone: 'neutral' },
  unavailable: { label: 'Source unavailable', tone: 'warning' },
  unknown: { label: 'Unknown', tone: 'neutral' },
  blocked: { label: 'Blocked', tone: 'warning' },
  error: { label: 'Error', tone: 'danger' },
}

const ICON = {
  loading: RefreshCw,
  empty: CircleDashed,
  unavailable: AlertTriangle,
  unknown: HelpCircle,
  blocked: LockKeyhole,
  error: AlertTriangle,
} satisfies Record<StatePanelState, React.ElementType>

const TONE_STYLE: Record<string, { bg: string; border: string; icon: string }> = {
  neutral: { bg: 'var(--bg-subtle)', border: 'var(--border)', icon: 'var(--text-tertiary)' },
  warning: { bg: 'var(--warning-bg)', border: 'var(--warning-border)', icon: 'var(--warning)' },
  danger: { bg: 'var(--danger-bg)', border: 'var(--danger-border)', icon: 'var(--danger)' },
  good: { bg: 'var(--success-bg)', border: 'var(--success-border)', icon: 'var(--success)' },
  action: { bg: 'var(--accent-dim)', border: 'var(--border-focus)', icon: 'var(--accent)' },
}

export function StatePanel({
  state,
  title,
  description,
  action,
  compact = false,
}: {
  state: StatePanelState
  title: string
  description: string
  action?: { label: string; onClick: () => void }
  compact?: boolean
}) {
  const copy = STATE_PANEL_COPY[state]
  const tone = TONE_STYLE[copy.tone]
  const Icon = ICON[state]
  const role = state === 'error' || state === 'unavailable' ? 'alert' : state === 'loading' ? 'status' : undefined

  return (
    <div
      className="flex flex-col items-center justify-center text-center"
      data-state={state}
      role={role}
      aria-busy={state === 'loading' ? true : undefined}
      style={{ padding: compact ? '28px 20px' : '64px 28px' }}
    >
      <div
        className="flex items-center justify-center"
        style={{
          width: compact ? 44 : 56,
          height: compact ? 44 : 56,
          borderRadius: 14,
          marginBottom: 14,
          background: tone.bg,
          border: `1px solid ${tone.border}`,
        }}
      >
        <Icon className={state === 'loading' ? 'animate-spin' : undefined} style={{ width: 22, height: 22, color: tone.icon }} />
      </div>
      <p className="text-[10.5px] font-bold uppercase tracking-[0.09em]" style={{ color: tone.icon, marginBottom: 5 }}>
        {copy.label}
      </p>
      <p className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</p>
      <p className="text-[13px] max-w-sm leading-relaxed mt-1" style={{ color: 'var(--text-tertiary)' }}>{description}</p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-5 rounded-lg text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
          style={{ minHeight: 44, padding: '0 16px', background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', cursor: 'pointer' }}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
