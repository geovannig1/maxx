'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { ReportingContextSchema, type ReportingContext, type ReportEntity, type ReportingData } from '@/lib/reporting/contracts'
import { buildCreativeGroups, type CreativeGroup, type CreativeGroupMember, type CreativeGroupingResult } from '@/lib/reporting/creative-groups'
import { METRIC_GROUPS, metricLabel, type MetricGroup, type QueryChanges } from './MetricTable'
import { CreativeGroupMetric, creativeEvidenceReason } from './CreativeGroupMetric'
import { CreativeGroupExport } from './CreativeGroupExport'
import { CreativeAsset } from './CreativeAsset'
import { reportMetricValue } from './MetricValue'

export interface CreativeGroupPanelProps {
  data: ReportingData
  entities: ReportEntity[]
  group: MetricGroup
  href: (changes: QueryChanges) => string
  sortKey?: string
  direction?: 'asc' | 'desc'
}

function Membership({ member, result }: { member: CreativeGroupMember; result: CreativeGroupingResult }) {
  const [expanded, setExpanded] = useState(false)
  return <details onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="inline-flex min-h-11 cursor-pointer items-center text-xs underline underline-offset-4">Assignment evidence for {member.adName}</summary>
    {expanded && <div className="space-y-3 pb-3 text-xs break-words">{(['current', 'previous'] as const).map(period => {
      const assignment = member.assignments[period], range = period === 'current' ? result.context!.range : result.context!.comparison
      return <div key={period}><p className="font-semibold">{period === 'current' ? 'Current' : 'Previous'} · {range.from} – {range.to}</p>
        {assignment.state === 'blocked' ? <p>{creativeEvidenceReason(assignment.blockerCode)}</p> : <>
          <p>Observed stable creative object {assignment.metaCreativeId}</p>
          {assignment.boundaryObservationIds.map(id => {
            const observation = result.sourcePacket?.result.data?.creativeAssignmentEvidence?.observations.find(row => row.id === id)
            return <p key={id}>Boundary observation {id} · observed {observation?.observedAt} · Meta updated {observation?.metaUpdatedTime ?? 'unavailable'}</p>
          })}
        </>}
      </div>
    })}</div>}
  </details>
}

function GroupCard({ item, result, group, href }: {
  item: CreativeGroup; result: CreativeGroupingResult; group: MetricGroup; href: CreativeGroupPanelProps['href']
}) {
  const identity = item.preview.creative?.identity
  return <article data-creative-id={item.metaCreativeId} className="min-w-0 space-y-5 rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-4 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 flex-1 space-y-2">
        <h3 className="text-xl font-semibold">{item.name}</h3>
        <p className="text-sm text-[var(--text-secondary)]">Creative object {item.metaCreativeId} · {item.members.length} executions</p>
        <p className="max-w-xl text-xs leading-5 text-[var(--text-secondary)]">Historical object membership supports these selected ad totals. The current preview does not establish historical media content or individual asset performance.</p>
      </div>
      <div className="w-64 max-w-full shrink-0 space-y-2">
        <p className="text-sm font-medium">Current configuration preview</p>
        {item.preview.state === 'available' ? <>
          <CreativeAsset creative={item.preview.creative} name={item.name} />
          <p className="text-xs leading-5 text-[var(--text-secondary)]">Observed {item.preview.observedAt} · from ad {item.preview.adId}</p>
        </> : <p className="rounded-xl bg-[var(--bg-subtle)] p-4 text-sm">No matching current preview is available for this historical creative object.</p>}
      </div>
    </div>
    {item.comparison.reason && <p className="text-sm text-[var(--text-secondary)]">{creativeEvidenceReason(item.comparison.reason)} Valid per-ad results remain available.</p>}
    <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">{METRIC_GROUPS[group].keys.map(key => item.metrics[key]
      ? <CreativeGroupMetric key={key} metric={item.metrics[key]} /> : <p key={key}>{metricLabel(key)}: Unavailable</p>)}</div>
    <details>
      <summary aria-label="Executions and assignment evidence" className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium underline underline-offset-4">Executions and assignment evidence ({item.members.length})</summary>
      <section className="min-w-0 pt-3">
        <h4 className="text-sm font-semibold">Historical object membership</h4>
        <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">These executions have a stable observed ad-to-creative-object assignment for the selected period.</p>
        <ul className="mt-3 divide-y divide-[var(--border)]">{item.members.map(member => <li key={member.adId} className="py-2 break-words">
          <Link href={href({ ad: member.adId, view: null })} scroll={false} className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4">{member.adName}</Link>
          <p className="text-xs text-[var(--text-secondary)]">Ad {member.adId} · Current creative: {member.currentCreativeId ?? 'Unavailable'} · {member.entity.campaignName ?? member.entity.campaignId ?? 'Campaign unavailable'}</p>
          <Membership member={member} result={result} />
        </li>)}</ul>
        {identity && <details><summary className="inline-flex min-h-11 cursor-pointer items-center text-xs underline underline-offset-4">Current media identity</summary>
          <div className="space-y-2 break-words text-xs"><p>{identity.structure} · observed {identity.observedAt} · observed fields only</p>
            {identity.members.map(member => <p key={`${member.kind}:${member.role}:${member.id}`}>{member.kind} {member.id} · {member.role}</p>)}
            {identity.unresolvedSourcePaths.length > 0 && <p>Unresolved fields: {identity.unresolvedSourcePaths.join(', ')}</p>}
          </div></details>}
      </section>
    </details>
  </article>
}

export function CreativeGroupPanel({ data, entities, group, href, sortKey = 'spend', direction = 'desc' }: CreativeGroupPanelProps) {
  // Only IDs are serialized here; materialized metric evidence is intentionally never serialized in render.
  const selection = JSON.stringify(entities.map(entity => entity.id))
  const meta = data.meta
  const sourceContext = { ...data.context, asOf: meta.asOf ?? data.context.asOf }
  const parsedContext = ReportingContextSchema.safeParse(sourceContext)
  // Normalize this small context, so another source's clock/object identity cannot interrupt a Meta export.
  const contextKey = JSON.stringify(parsedContext.success ? parsedContext.data : sourceContext)
  const context = useMemo(() => JSON.parse(contextKey) as ReportingContext, [contextKey])
  const result = useMemo(() => buildCreativeGroups({ meta, context }, JSON.parse(selection) as string[]), [meta, context, selection])
  const hasMetricSort = result.groups.some(item => item.metrics[sortKey])
  const groups = [...result.groups].sort((left, right) => {
    if (!hasMetricSort) return entities.findIndex(entity => left.members.some(member => member.adId === entity.id))
      - entities.findIndex(entity => right.members.some(member => member.adId === entity.id))
    const a = left.metrics[sortKey]?.current.value ?? null, b = right.metrics[sortKey]?.current.value ?? null
    if (a === null || b === null) return a === b ? left.id.localeCompare(right.id) : a === null ? 1 : -1
    return (direction === 'asc' ? a - b : b - a) || left.id.localeCompare(right.id)
  })
  return <section className="space-y-5" aria-label="Shared creative objects">
    <div className="space-y-3"><h2 className="text-xl font-semibold">Shared creative objects</h2>
      {result.state === 'ready' ? <>
        <p className="text-sm text-[var(--text-secondary)]">{`${result.population.selectedAdCount} selected executions · ${result.population.assignedAdCount} assigned · ${result.population.unassignedAdCount} unassigned · ${result.population.returnedAdCount} returned by Meta`}</p>
        <p className="text-xs text-[var(--text-secondary)]">{result.context!.range.from} – {result.context!.range.to} · Previous {result.context!.comparison.from} – {result.context!.comparison.to} · {result.context!.timezone} · Meta as of {result.context!.asOf}</p>
      </> : <p role="status" className="text-sm">Population could not be established. Creative grouping is unavailable; individual ad destinations remain below.</p>}
      <CreativeGroupExport result={result} context={result.context ?? context} />
      <p className="max-w-4xl text-xs leading-5 text-[var(--text-secondary)]">Membership covers selected executions in the returned Meta population, not every use of a creative. Delivery reflects Meta selection and can give ads unequal exposure; these are observed results, not a controlled creative test. Outcomes remain Meta-reported and are not allocated to individual media assets.</p>
      {result.state === 'ready' && <details><summary className="inline-flex min-h-11 cursor-pointer items-center text-xs underline underline-offset-4">Population and evidence limits</summary>
        <div className="space-y-2 text-xs leading-5 text-[var(--text-secondary)]">{result.limitations.map((note, index) => <p key={index}>{note}</p>)}</div>
      </details>}
      {groups.length > 0 && <p className="text-xs text-[var(--text-secondary)]">{hasMetricSort ? `Sorted by current ${metricLabel(sortKey)} · ${direction === 'asc' ? 'ascending' : 'descending'} · unavailable last` : 'Groups follow execution order; this is not a ranking of group performance.'}</p>}
    </div>
    {groups.map(item => <GroupCard key={item.id} item={item} result={result} group={group} href={href} />)}
    {result.unassigned.length > 0 && <section className="rounded-2xl border border-[var(--border)] p-4 sm:p-6">
      <h3 className="text-lg font-semibold">Unassigned executions</h3>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">These ads retain their own native results. Historical membership does not support a shared creative total.</p>
      <ul className="mt-3 divide-y divide-[var(--border)]">{result.unassigned.map(member => <li key={member.adId} className="py-3 break-words">
        <Link href={href({ ad: member.adId, view: null })} scroll={false} className="inline-flex min-h-11 items-center font-medium underline underline-offset-4">{member.adName}</Link>
        <p className="text-xs text-[var(--text-secondary)]">Ad {member.adId} · Current creative: {member.currentCreativeId ?? 'Unavailable'} · Spend: {reportMetricValue(member.entity.metrics.spend)}</p>
        <p className="mt-1 text-sm">{creativeEvidenceReason(member.reason)}</p><Membership member={member} result={result} />
      </li>)}</ul>
    </section>}
    {result.state !== 'ready' && entities.length > 0 && <ul>{entities.map(entity => <li key={entity.id}>
      <Link href={href({ ad: entity.id, view: null })} scroll={false} className="inline-flex min-h-11 items-center underline underline-offset-4">{entity.name}</Link>
    </li>)}</ul>}
    {result.state === 'ready' && result.population.selectedAdCount === 0 && <p className="text-sm">No returned ad executions match the current filters.</p>}
  </section>
}
