export type EvidenceSource = 'outcomes' | 'ga4' | 'meta' | 'maxx' | 'manual' | 'unknown'
export type EvidenceRole = 'business_truth' | 'telemetry' | 'modelled_attribution' | 'delivery_fact' | 'derived_diagnostic' | 'operator_record' | 'unknown'

export const SOURCE_LABELS: Record<EvidenceSource, string> = {
  outcomes: 'Outcomes',
  ga4: 'GA4',
  meta: 'Meta',
  maxx: 'Maxx',
  manual: 'Manual',
  unknown: 'Unknown source',
}

export const SOURCE_ROLE_LABELS: Record<EvidenceRole, string> = {
  business_truth: 'business truth',
  telemetry: 'telemetry',
  modelled_attribution: 'modelled attribution',
  delivery_fact: 'delivery fact',
  derived_diagnostic: 'derived diagnostic',
  operator_record: 'operator record',
  unknown: 'role unknown',
}

const SOURCE_COLOR: Record<EvidenceSource, string> = {
  outcomes: 'var(--success)',
  ga4: 'var(--info)',
  meta: 'var(--accent)',
  maxx: 'var(--accent-hover)',
  manual: 'var(--warning)',
  unknown: 'var(--text-tertiary)',
}

export function EvidenceMeta({
  source,
  role,
  window,
  scope,
  freshness,
  confidence,
  compact = false,
}: {
  source: EvidenceSource
  role: EvidenceRole
  window: string
  scope: string
  freshness?: string | null
  confidence?: string | null
  compact?: boolean
}) {
  const color = SOURCE_COLOR[source]
  const items = [
    SOURCE_LABELS[source],
    SOURCE_ROLE_LABELS[role],
    window,
    scope,
    freshness,
    confidence,
  ].filter(Boolean)

  return (
    <div
      className="flex flex-wrap items-center"
      aria-label={`Evidence: ${items.join(', ')}`}
      style={{ gap: compact ? 5 : 7 }}
    >
      <span
        className="inline-flex items-center rounded-full font-semibold"
        style={{
          minHeight: compact ? 24 : 28,
          padding: compact ? '0 8px' : '0 10px',
          fontSize: compact ? 11 : 12,
          color,
          background: `color-mix(in srgb, ${color} 12%, transparent)`,
          border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
        }}
      >
        {SOURCE_LABELS[source]}
      </span>
      {items.slice(1).map((item) => (
        <span key={item} className="text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
          {item}
        </span>
      ))}
    </div>
  )
}
