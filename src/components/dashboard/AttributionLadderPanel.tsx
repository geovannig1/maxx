import type { AttributionLadder } from '@/lib/cockpit/attribution-ladder'
import { describeMetaClaim, describeMetaValueSplit, describeMoney } from '@/lib/cockpit/attribution-ladder'
import { outcomeNoun } from '@/config/outcome-nouns'
import { accountTimezoneShortName } from '@/config/timezone-label'

/**
 * The reconciliation ladder.
 *
 * Rendered as rows on a single surface separated by dividers — deliberately not as a grid of
 * cards. These numbers are one descending argument, and cards would present them as five
 * independent facts. The design system also forbids nesting a card inside a surface.
 *
 * The Meta claim sits below a rule, labelled with its own date basis, because it is counted on
 * impression date while every rung above is counted on booking-created date. It is a parallel
 * claim about the same period, not the bottom of the funnel.
 */

const BASIS_LABEL: Record<string, string> = {
  booking_created_date_et: `counted on the ${outcomeNoun({ plural: false })} date (${accountTimezoneShortName()})`,
  closed_account_days: 'counted on impression date',
}

function Rung({
  rung, widthPct, isLast,
}: {
  rung: AttributionLadder['rungs'][number]
  widthPct: number
  isLast: boolean
}) {
  return (
    <li className={isLast ? 'py-4' : 'border-b py-4'} style={{ borderColor: 'var(--border)' }}>
      <div className="flex items-baseline gap-4">
        <span className="stat-value shrink-0 tabular-nums" style={{ minWidth: '4.5ch' }}>{rung.count.toLocaleString('en-US')}</span>
        <span className="min-w-0 flex-1 text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{rung.label}</span>
      </div>
      {/* Proportional rule: the descent is the argument, so it should be visible without arithmetic. */}
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full" style={{ background: 'var(--bg-subtle)' }}>
        <div className="h-full rounded-full" style={{ width: `${widthPct}%`, background: 'var(--chart-1)' }} />
      </div>
      {rung.dropReason && (
        <p className="mt-2 max-w-2xl text-[12.5px] leading-5" style={{ color: 'var(--text-tertiary)' }}>
          {rung.dropReason}
        </p>
      )}
    </li>
  )
}

export function AttributionLadderPanel({ ladder }: { ladder: AttributionLadder }) {
  const metaValueSplit = describeMetaValueSplit(ladder.meta)
  const top = ladder.rungs[0]?.count ?? 0
  const widthFor = (count: number) => (top > 0 ? Math.max(1.5, (count / top) * 100) : 0)

  return (
    <section className="owner-surface owner-surface-section" aria-labelledby="ladder-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="section-label">Where the {outcomeNoun()} came from</p>
          <h2 id="ladder-title" className="text-[20px] font-bold" style={{ color: 'var(--text-primary)' }}>
            {outcomeNoun({ capitalize: true })}, and how many can be traced to paid
          </h2>
        </div>
        <span className="rounded-full border px-2.5 py-1 text-[12px] font-semibold"
          style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>
          {BASIS_LABEL.booking_created_date_et}
        </span>
      </div>

      <ol className="mt-4">
        {ladder.rungs.map((rung, index) => (
          <Rung key={rung.key} rung={rung} widthPct={widthFor(rung.count)} isLast={index === ladder.rungs.length - 1} />
        ))}
      </ol>

      <div className="rounded-lg p-3" style={{ background: 'var(--bg-subtle)' }}>
        <p className="text-[13px] leading-5" style={{ color: 'var(--text-secondary)' }}>{describeMoney(ladder.money)}</p>
        {ladder.zeroValueBookings > 0 && (
          <p className="mt-1 text-[12.5px] leading-5" style={{ color: 'var(--text-tertiary)' }}>
            Plus {ladder.zeroValueBookings} zero-value {outcomeNoun({ count: ladder.zeroValueBookings })} in the same period.
          </p>
        )}
      </div>

      {/* The rule matters: everything below is measured on a different calendar. */}
      <div className="mt-5 border-t pt-4" style={{ borderColor: 'var(--border-strong)' }}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="section-label">{ladder.meta.label}</p>
          <span className="text-[12px] font-semibold" style={{ color: 'var(--text-tertiary)' }}>
            {BASIS_LABEL[ladder.meta.basis]}
          </span>
        </div>
        <p className="mt-2 text-[14px] font-semibold leading-6" style={{ color: 'var(--text-primary)' }}>
          {describeMetaClaim(ladder.meta)}
        </p>
        {/*
          The same split in dollars, on its own line rather than appended to the count sentence:
          the two can be reported to different completeness, and the value share is the one that
          decides whether a ROAS figure means anything. Rendered only when there IS value to split
          — an absent line reads "not measured", which a rendered "$0.00" would falsely deny.
        */}
        {metaValueSplit && (
          <p className="mt-1 text-[13px] font-semibold leading-5" style={{ color: 'var(--text-secondary)' }}>
            {metaValueSplit}
          </p>
        )}
        <p className="mt-1 max-w-2xl text-[12.5px] leading-5" style={{ color: 'var(--text-tertiary)' }}>
          {ladder.meta.note}
        </p>
      </div>
    </section>
  )
}
