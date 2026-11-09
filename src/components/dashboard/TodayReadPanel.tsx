import type { TodayRead } from '@/lib/cockpit/audience-performance'

/**
 * The first thing on the page: one sentence saying what matters, with its evidence beside it.
 *
 * This exists because the console was faithfully rendering an engine that had nothing to say —
 * nearly all of its recommendations were hold, investigate, or keep. A number grid cannot fix that. A
 * sentence can, provided it is derived and checkable rather than asserted, which is why the
 * evidence chips sit on the same line and never behind a click.
 */
export function TodayReadPanel({ read }: { read: TodayRead }) {
  const conclusive = read.kind !== 'insufficient'
  return (
    <section
      className="owner-surface owner-surface-section"
      aria-labelledby="today-read-title"
      style={conclusive ? { borderColor: 'var(--border-strong)' } : undefined}
    >
      <p className="section-label">What matters today</p>
      <h2
        id="today-read-title"
        className="mt-1 max-w-4xl text-[19px] font-bold leading-snug"
        style={{ color: 'var(--text-primary)' }}
      >
        {read.headline}
      </h2>
      <ul className="mt-3 flex flex-wrap gap-2" aria-label="Evidence">
        {read.evidence.map((item) => (
          <li
            key={item}
            className="rounded-md border px-2.5 py-1 text-[12px]"
            style={{ borderColor: 'var(--border)', background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}
          >
            {item}
          </li>
        ))}
      </ul>
    </section>
  )
}
