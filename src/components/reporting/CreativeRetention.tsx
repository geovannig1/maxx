'use client'

import type { ReportEntity, ReportingContext } from '@/lib/reporting/contracts'
import { creativeRetention, RETENTION_MILESTONES } from '@/lib/reporting/creative-retention'

const COLORS = ['#818cf8', '#34d399', '#fbbf24', '#f472b6']
const format = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 })

export function CreativeRetention({ entities, context }: { entities: ReportEntity[]; context: ReportingContext }) {
  const rows = creativeRetention(entities, context)
  const hasWatch = rows.some(row => row.points.some(point => point.count !== null || point.starts !== null))
  if (!hasWatch) return <p className="text-sm leading-6 text-[var(--text-secondary)]">Video milestone comparison is unavailable for these executions. Supported delivery and response metrics remain below.</p>
  const hasPoints = rows.some(row => row.points.some(point => point.value !== null))
  return <section aria-label="Video retention comparison" className="min-w-0 space-y-4 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-4 sm:p-5">
    <div className="space-y-2"><h3 className="text-base font-semibold">Video retention comparison</h3>
      <p className="max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">Reported milestone plays divided by video starts, for each ad in the selected period. The horizontal axis is percentage of video length. Points do not describe exact viewing seconds or a sequence of unique people.</p>
    </div>
    <ul className="grid gap-3 text-sm sm:grid-cols-2">{rows.map(({ entity }, index) => <li key={entity.id} className="min-w-0">
      <p className="flex items-start gap-2 font-medium"><span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} /><span className="break-words">{index + 1}. {entity.name} · {entity.id}</span></p>
      <p className="ml-4 text-xs leading-5 text-[var(--text-secondary)]">{entity.creative?.durationSeconds && entity.creative.durationSeconds > 0
        ? `Current preview: ${format(entity.creative.durationSeconds)} seconds` : 'Current preview duration unavailable'}{entity.configurationAsOf ? ` · observed ${entity.configurationAsOf}` : ''}.</p>
    </li>)}</ul>
    <p className="text-xs leading-5 text-[var(--text-secondary)]">Current preview duration does not establish the duration of historical media or dynamic combinations. Compare short and long videos at equivalent viewing time only when that historical evidence exists.</p>
    {hasPoints && <svg viewBox="0 0 640 255" role="img" aria-label="Reported video milestone rates; exact values follow in the table" className="block w-full text-[var(--text-secondary)]">
      {[0, 25, 50, 75, 100].map(value => <g key={value}>
        <line x1="48" x2="618" y1={220 - value * 1.85} y2={220 - value * 1.85} stroke="currentColor" opacity="0.18" />
        <text x="39" y={224 - value * 1.85} textAnchor="end" fontSize="12" fill="currentColor">{value}%</text>
      </g>)}
      {RETENTION_MILESTONES.map((value, index) => <text key={value} x={64 + index * 180} y="244" textAnchor="middle" fontSize="12" fill="currentColor">{value}% length</text>)}
      {rows.map(({ entity, points }, rowIndex) => <g key={entity.id} stroke={COLORS[rowIndex % COLORS.length]} fill={COLORS[rowIndex % COLORS.length]}>
        {points.map((point, index) => {
          if (point.value === null) return null
          const x = 64 + index * 180, y = 220 - point.value * 1.85
          const prior = points[index - 1]
          return <g key={point.milestone}>
            {prior?.value !== null && prior?.value !== undefined && <line x1={x - 180} x2={x} y1={220 - prior.value * 1.85} y2={y} strokeWidth="2" strokeDasharray={rowIndex % 2 ? '5 3' : undefined} />}
            <circle cx={x} cy={y} r={4 + rowIndex / 2} fill="var(--bg-surface)" strokeWidth="2" data-retention-value={point.value}>
              <title>{entity.name}: {point.milestone}% milestone, {format(point.value)}%; {point.count} / {point.starts} starts</title>
            </circle>
          </g>
        })}
      </g>)}
    </svg>}
    <div className="overflow-x-auto" role="region" aria-label="Exact retention values, scroll for all executions" tabIndex={0}>
      <table className="w-full min-w-[520px] border-collapse text-left text-xs">
        <caption className="sr-only">Native milestone counts and video-start denominators. Missing points are not zero.</caption>
        <thead><tr><th scope="col" className="p-2">Milestone</th>{rows.map(({ entity }) => <th key={entity.id} scope="col" className="p-2">{entity.name} · {entity.id}</th>)}</tr></thead>
        <tbody>{RETENTION_MILESTONES.map((milestone, index) => <tr key={milestone} className="border-t border-[var(--border)] align-top">
          <th scope="row" className="p-2">{milestone}% length</th>
          {rows.map(({ entity, points }) => { const point = points[index]; return <td key={entity.id} className="min-w-36 p-2 leading-5">
            <p className="font-medium">{point.value === null ? 'Unavailable' : `${format(point.value)}%`}</p>
            <p>{point.count === null ? 'Count unavailable' : format(point.count)} / {point.starts === null ? 'starts unavailable' : `${format(point.starts)} starts`}</p>
            {point.reason && <p className="max-w-64 text-[var(--text-secondary)]">{point.reason}</p>}
          </td> })}
        </tr>)}</tbody>
      </table>
    </div>
  </section>
}
