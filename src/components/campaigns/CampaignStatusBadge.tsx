type StatusStyle = {
  label: string
  style: React.CSSProperties
}

const BADGE_BASE_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: '20px',
  padding: '0 8px',
  borderRadius: '100px',
  fontSize: '11px',
  fontWeight: 600,
  whiteSpace: 'nowrap',
  border: '1px solid',
}

const STATUS_MAP: Record<string, StatusStyle> = {
  ACTIVE: {
    label: 'Active',
    style: { background: 'var(--success-bg)', color: 'var(--success)', borderColor: 'var(--success-border)' },
  },
  ENABLED: {
    label: 'Active',
    style: { background: 'var(--success-bg)', color: 'var(--success)', borderColor: 'var(--success-border)' },
  },
  PAUSED: {
    label: 'Paused',
    style: { background: 'var(--warning-bg)', color: 'var(--warning)', borderColor: 'var(--warning-border)' },
  },
  DELETED: {
    label: 'Deleted',
    style: { background: 'var(--danger-bg)', color: 'var(--danger)', borderColor: 'var(--danger-border)' },
  },
  ARCHIVED: {
    label: 'Archived',
    style: { background: 'var(--danger-bg)', color: 'var(--danger)', borderColor: 'var(--danger-border)' },
  },
  WITH_ISSUES: {
    label: 'Issues',
    style: { background: 'var(--danger-bg)', color: 'var(--danger)', borderColor: 'var(--danger-border)' },
  },
  IN_PROCESS: {
    label: 'Learning',
    style: { background: 'var(--info-bg)', color: 'var(--info)', borderColor: 'var(--info-border)' },
  },
  LEARNING_LIMITED: {
    label: 'Limited',
    style: { background: 'var(--warning-bg)', color: 'var(--warning)', borderColor: 'var(--warning-border)' },
  },
  CAMPAIGN_PAUSED: {
    label: 'Paused',
    style: { background: 'var(--warning-bg)', color: 'var(--warning)', borderColor: 'var(--warning-border)' },
  },
  ADSET_PAUSED: {
    label: 'Paused',
    style: { background: 'var(--warning-bg)', color: 'var(--warning)', borderColor: 'var(--warning-border)' },
  },
  DISAPPROVED: {
    label: 'Rejected',
    style: { background: 'var(--danger-bg)', color: 'var(--danger)', borderColor: 'var(--danger-border)' },
  },
  PENDING_REVIEW: {
    label: 'Review',
    style: { background: 'var(--info-bg)', color: 'var(--info)', borderColor: 'var(--info-border)' },
  },
}

const DEFAULT_STYLE: React.CSSProperties = {
  background: 'var(--bg-subtle)',
  color: 'var(--text-tertiary)',
  borderColor: 'var(--border)',
}

export function CampaignStatusBadge({ status }: { status: string }) {
  const key = status?.toUpperCase().replace(/ /g, '_')
  const config = STATUS_MAP[key] ?? {
    label: status ?? 'Unknown',
    style: DEFAULT_STYLE,
  }

  return (
    <span style={{ ...BADGE_BASE_STYLE, ...config.style }}>
      {config.label}
    </span>
  )
}
