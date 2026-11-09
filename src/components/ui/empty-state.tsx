// Three flavors (design-system §7.1): `action` (something to do — accent, default), `info` (no data yet,
// neutral), `good` (celebratory — e.g. an empty approval queue means "on pace", shown positively).
type EmptyTone = 'action' | 'info' | 'good'
const TONE: Record<EmptyTone, { bg: string; border: string; icon: string }> = {
  action: { bg: 'var(--accent-dim)', border: '1px solid var(--accent-dim)', icon: 'var(--accent-hover)' },
  info: { bg: 'var(--border)', border: '1px solid var(--border)', icon: 'var(--text-tertiary)' },
  good: { bg: 'var(--success-bg)', border: '1px solid var(--success-border)', icon: 'var(--success)' },
}

interface EmptyStateProps {
  icon: React.ElementType
  title: string
  description: string
  action?: { label: string; onClick: () => void }
  tone?: EmptyTone
}

export function EmptyState({ icon: Icon, title, description, action, tone = 'action' }: EmptyStateProps) {
  const t = TONE[tone]
  return (
    <div className="flex flex-col items-center justify-center py-20 px-8 text-center">
      <div
        className="w-14 h-14 rounded-xl flex items-center justify-center mb-4"
        style={{ background: t.bg, border: t.border }}
      >
        <Icon className="w-6 h-6" style={{ color: t.icon }} />
      </div>
      <p className="text-[15px] font-semibold mb-1.5" style={{ color: 'var(--text-primary)' }}>
        {title}
      </p>
      <p className="text-[13px] max-w-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
        {description}
      </p>
      {action && (
        <button
          onClick={action.onClick}
          className="mt-5 px-4 rounded-md text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
          style={{ minHeight: 44, background: 'var(--accent)', color: 'var(--on-accent)', border: 'none' }}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
