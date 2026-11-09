import { lineageNotice, type RecLineageStatus } from '@/lib/flags/generations'

// Report lineage — the DETERMINISTIC read-time lineage surface for a daily report. Renders ALL
// FIVE states visibly (never relies on LLM prose): current = a quiet muted caption; no_snapshot =
// neutral info; last_known_complete = warning; rolled_back = warning ("historical, do not act" — a
// deliberate rollback is never disguised as ordinary staleness); unknown = info ("unable to verify" is
// never presented as current). Pure and presentational, so it is render-tested directly
// (renderToStaticMarkup) — the same state strings the API and MCP consumers return come from the shared
// lineageNotice().

const BANNER: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '10px',
  padding: '11px 15px', borderRadius: '10px', fontSize: '12.5px',
}

export function LineageNotice({ status }: { status: RecLineageStatus }) {
  if (status.state === 'current') {
    return (
      <p data-lineage="current" className="text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
        Recommendation snapshot: current
      </p>
    )
  }
  const notice = lineageNotice(status)
  if (!notice) return null // unreachable for the three non-current states; keeps the component total
  const tone =
    status.state === 'last_known_complete' || status.state === 'rolled_back'
      ? { background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', color: 'var(--warning)' }
      : { background: 'var(--info-bg)', border: '1px solid var(--info-border)', color: 'var(--info)' }
  return (
    <div data-lineage={status.state} style={{ ...BANNER, ...tone }}>
      {notice}
    </div>
  )
}
