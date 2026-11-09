import { accountCurrency, accountLocale } from '@/config/business-config'
import type { GroupPerformance } from '@/lib/cockpit/audience-performance'

/**
 * Where the money went, grouped.
 *
 * On a small account no single ad has the volume to justify a verdict, so a per-ad table is
 * rows of "not enough data". Grouped by audience and creative concept the same spend separates
 * cleanly, which is the whole reason the grouping exists.
 *
 * Cost per result is Meta-modelled and labelled as such. Rows are compared to each other rather
 * than to a dollar target — the modelling bias cancels between rows on an identical basis, and a
 * money verdict on this surface is forbidden by `tests/dashboard-money-authority.test.ts`.
 */

const money = (n: number | null) =>
  n === null ? '—' : n.toLocaleString(accountLocale(), { style: 'currency', currency: accountCurrency() })

function Row({ group, isChild, cheapest }: { group: GroupPerformance; isChild: boolean; cheapest: number | null }) {
  const ratio = cheapest !== null && group.costPerResult !== null && cheapest > 0
    ? group.costPerResult / cheapest : null
  return (
    <tr style={{ borderTop: '1px solid var(--border)' }}>
      <th scope="row" className="py-2.5 pr-3 text-left text-[13.5px] font-medium"
        style={{ paddingLeft: isChild ? 22 : 0, color: isChild ? 'var(--text-secondary)' : 'var(--text-primary)', fontWeight: isChild ? 400 : 600 }}>
        {isChild ? group.concept : (group.audience ?? 'Unparsed')}
        {!isChild && !group.parsed && (
          <span className="ml-2 text-[11px] font-normal" style={{ color: 'var(--text-tertiary)' }}>legacy names, no structure</span>
        )}
      </th>
      {/* LIVE FIRST. `liveAds`/`liveSpend` are computed for every group in `audience-performance.ts`
          and were rendered nowhere — they reached the owner only through `buildTodayRead`, for the
          single worst group, in one gated branch. So a table headed "Where the money went" could not
          answer "where is the money going right now", which is the only question a budget decision
          turns on. Lifetime cost is history; live spend is the decision, so it reads first. */}
      <td className="py-2.5 px-3 text-right tabular-nums text-[13.5px] font-semibold"
        style={{ color: group.liveAds === 0 ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>
        {group.liveAds === 0 ? 'paused' : group.liveAds}
      </td>
      <td className="py-2.5 px-3 text-right tabular-nums text-[13.5px] font-semibold"
        style={{ color: group.liveAds === 0 ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>
        {group.liveAds === 0 ? '—' : money(group.liveSpend)}
      </td>
      <td className="py-2.5 px-3 text-right tabular-nums text-[13.5px]" style={{ color: 'var(--text-secondary)' }}>{group.ads}</td>
      <td className="py-2.5 px-3 text-right tabular-nums text-[13.5px]" style={{ color: 'var(--text-secondary)' }}>{money(group.spend)}</td>
      <td className="py-2.5 px-3 text-right tabular-nums text-[13.5px]">{group.results}</td>
      <td className="py-2.5 px-3 text-right tabular-nums text-[13.5px] font-semibold">{money(group.costPerResult)}</td>
      <td className="py-2.5 px-3 text-right tabular-nums text-[13.5px]" style={{ color: 'var(--text-secondary)' }}>
        {group.linkCtrPct === null ? '—' : `${group.linkCtrPct.toFixed(2)}%`}
      </td>
      <td className="py-2.5 pl-3 text-right text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
        {ratio === null ? (group.results === 0 && group.spend > 0 ? 'no Meta results' : '')
          : ratio <= 1.01 ? 'cheapest' : `${ratio.toFixed(1)}× cheapest`}
      </td>
    </tr>
  )
}

export function AudiencePerformanceTable({
  audiences, concepts,
}: { audiences: GroupPerformance[]; concepts: GroupPerformance[] }) {
  if (audiences.length === 0) return null
  const costs = audiences.filter((g) => g.parsed && g.costPerResult !== null).map((g) => g.costPerResult!)
  const cheapest = costs.length > 0 ? Math.min(...costs) : null

  return (
    <section className="owner-surface owner-surface-section" aria-labelledby="audience-title">
      <p className="section-label">Where the money went</p>
      <h2 id="audience-title" className="text-[20px] font-bold" style={{ color: 'var(--text-primary)' }}>
        By audience and creative concept
      </h2>
      <p className="mt-1 text-[13px] leading-5" style={{ color: 'var(--text-tertiary)' }}>
        Grouped because no single ad carries enough volume to judge. <strong>Live</strong> is what is
        running and spending now; the all-time columns are history. Cost per result is Meta-modelled;
        rows are comparable to each other on that same basis.
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse">
          <thead>
            <tr>
              {['Audience · concept', 'Live ads', 'Live spend', 'Ads (all time)', 'Spend (all time)', 'Results', 'Cost / result', 'Link CTR', ''].map((h, i) => (
                <th key={h || 'rel'} scope="col"
                  className={`section-label pb-2 ${i === 0 ? 'text-left' : 'text-right'} ${i === 0 ? '' : 'px-3'}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {audiences.map((audience) => (
              <Row key={audience.key} group={audience} isChild={false} cheapest={cheapest} />
            ))}
          </tbody>
        </table>
      </div>

      {concepts.filter((c) => c.parsed).length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-[13px] font-semibold" style={{ color: 'var(--accent)' }}>
            Break out by creative concept
          </summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse">
              <tbody>
                {concepts.filter((c) => c.parsed).map((concept) => (
                  <Row key={concept.key} group={concept} isChild cheapest={cheapest} />
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  )
}
