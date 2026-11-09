// The single shared page header (design-system §9.6). Defined once, rendered on every page, so the
// title + page-specific controls stay consistent. The GLOBAL chrome — data freshness, write-mode, and
// the Trust entry — now lives in the persistent cockpit top bar (Topbar), not here, so it can't drift
// page-to-page and isn't duplicated. PageHeader is purely: icon + title + subtitle + a controls slot.
//
// Intentionally NOT a client component so it composes inside both server pages (dashboard, reports)
// and client pages.
export function PageHeader({
  title,
  subtitle,
  icon: Icon,
  controls,
}: {
  title: string
  subtitle?: React.ReactNode
  icon?: React.ElementType
  controls?: React.ReactNode // the page's date-range / source / action controls
}) {
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap">
      <div className="flex items-center gap-2.5 min-w-0">
        {Icon && (
          <div className="flex items-center justify-center rounded-lg shrink-0" style={{ width: 34, height: 34, background: 'var(--accent-dim)', border: '1px solid var(--border-focus)' }}>
            <Icon className="w-[18px] h-[18px]" style={{ color: 'var(--accent)' }} />
          </div>
        )}
        <div className="min-w-0">
          <h1 style={{ fontSize: '20px', fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.02em', lineHeight: 1.2 }}>{title}</h1>
          {subtitle && <p className="text-[12.5px] mt-0.5" style={{ color: 'var(--text-tertiary)', lineHeight: 1.45 }}>{subtitle}</p>}
        </div>
      </div>
      {controls && (
        <div className="flex items-center gap-3 flex-wrap justify-end">
          {controls}
        </div>
      )}
    </div>
  )
}
