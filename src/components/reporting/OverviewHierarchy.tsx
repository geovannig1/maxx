'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import type { ReportEntity, ReportMetric, ReportingData } from '@/lib/reporting/contracts'
import { overviewHref, overviewNumber, type OverviewEvent } from '@/lib/reporting/overview-model'
import { hierarchyAudience, hierarchyAudienceConcerns, hierarchyHasNoResults, hierarchyMetric, hierarchyPopulation } from '@/lib/reporting/overview-hierarchy'
import { audienceConfigurationState, type ReportAudienceMember } from '@/lib/reporting/audience-evidence'
import { reportMetricValue } from './MetricValue'

type Props = { data: ReportingData; event: OverviewEvent; savedId?: string | null }
const control = 'inline-flex min-h-11 items-center justify-center rounded-md px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] sm:min-h-9'
const linkStyle = 'inline-flex min-h-11 items-center text-[var(--accent)] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]'
const number = (value: number | null) => value === null ? 'Unavailable' : value.toLocaleString('en-US')
const nativeStatus = (member: ReportAudienceMember) => `${member.role} ${member.name ?? 'Unnamed audience'} (${member.id}): operation ${member.operationCode ?? 'unavailable'}, delivery ${member.deliveryCode ?? 'unavailable'}`

function detailHref(data: ReportingData, entity: ReportEntity, savedId?: string | null) {
  return overviewHref(data.context, '/performance', { level: entity.level, view: 'detail', group: 'results',
    ...(entity.level === 'campaign' ? { campaign: entity.id } : entity.level === 'adset'
      ? { adset: entity.id, ...(entity.campaignId ? { campaign: entity.campaignId } : {}) } : { ad: entity.id }),
  }, savedId)
}

function Metric({ metric, metricKey, label, name, omitSettling = false, value }: { metric?: ReportMetric; metricKey: string; label: string; name?: string; omitSettling?: boolean; value?: string }) {
  const claim = metric?.current
  const withheld = claim?.availability.state === 'unavailable' && claim.availability.blockerCodes.includes('meta_outcome_hierarchy_unreconciled')
  const qualifiers = claim ? [claim.coverage.state === 'partial' ? 'Partial evidence' : claim.coverage.state === 'unknown' ? 'Coverage unknown' : '',
    claim.freshness.state === 'stale' ? 'Stale' : '', claim.maturity.state === 'settling' ? omitSettling ? '' : 'Settling' : claim.maturity.state === 'partial' ? 'Partial period' : ''].filter(Boolean) : []
  return <div className="min-w-0"><dt className="text-[var(--text-secondary)]" aria-label={name}>{label}</dt>
    <dd data-hierarchy-metric={metricKey} className="break-words font-medium tabular-nums text-[var(--text-primary)]" title={metric?.definition}>{withheld ? 'Withheld' : value ?? reportMetricValue(metric)}</dd>
    {withheld && claim && <details className="text-[var(--text-secondary)]">
      <summary className="min-h-11 cursor-pointer content-center text-sm focus-visible:outline-2 focus-visible:outline-[var(--focus)] sm:min-h-8">Why {label} is withheld</summary>
      <p>{metric?.event} {label} is withheld for {claim.entity.level === 'adset' ? 'ad set' : claim.entity.level} {claim.entity.id} during {claim.window.start} – {claim.window.end} because its outcome hierarchy could not be reconciled. This reported {label} cannot support {label === 'CPA' ? 'a cost-per-result comparison' : 'an efficiency ranking'} for this period.</p>
    </details>}
    {qualifiers.length > 0 && <p className="break-words text-[var(--text-secondary)]">{qualifiers.join(' · ')}</p>}
  </div>
}

function NativeAudience({ data, entity }: Pick<Props, 'data'> & { entity: ReportEntity }) {
  const evidence = hierarchyAudience(data, entity)
  if (!evidence) return <p>Audience operation and size evidence unavailable.</p>
  return <>
    <p>Current configuration {audienceConfigurationState(evidence, data.context.asOf)} · observed {evidence.observedAt}</p>
    <p>Audience expansion: {evidence.expansion}. {evidence.targetingAvailable ? `${evidence.members.length} explicit references supplied.` : 'Targeting unavailable.'}</p>
    {evidence.unparsedReferences > 0 && <p>{evidence.unparsedReferences} audience references could not be read.</p>}
    {evidence.members.map(member => <div key={`${member.role}:${member.id}`} className="mt-3 border-t border-[var(--border)] pt-2">
      <p className="font-medium text-[var(--text-primary)]">{member.role === 'included' ? 'Included' : 'Excluded'} · {member.name ?? 'Unnamed audience'} ({member.id})</p>
      <p>Operation status {number(member.operationCode)} · Delivery status {number(member.deliveryCode)}</p>
      {member.operationDescription && <p>{member.operationDescription}</p>}
      {member.deliveryDescription && <p>{member.deliveryDescription}</p>}
      <p>Approximate size · lower {number(member.lowerBound)} / upper {number(member.upperBound)}</p>
      <p>Inventory observed {member.inventoryObservedAt ?? 'Unavailable'} · Account identity {member.ownership}</p>
    </div>)}
    <p className="mt-2">These are current configuration observations. Approximate size is not an exact audience count or a saturation denominator.</p>
  </>
}

function HierarchyRow({ data, event, savedId, entity, maxSpend, omitSettling }: Props & { entity: ReportEntity; maxSpend: number; omitSettling: boolean }) {
  const spend = hierarchyMetric(data, entity, 'spend', event), amount = overviewNumber(spend)
  const count = hierarchyMetric(data, entity, event.count, event)
  const noResults = hierarchyHasNoResults(data, entity, event)
  const frequency = hierarchyMetric(data, entity, 'frequency', event)
  const percent = amount === null ? null : maxSpend > 0 ? amount / maxSpend * 100 : 0
  const zero = amount !== null && amount > 0 && spend?.current.coverage.state === 'complete'
    && overviewNumber(count) === 0 && count?.current.coverage.state === 'complete'
  return <article data-hierarchy-row={entity.id} className="min-w-0 border-t border-[var(--border)] py-3">
    <div className="grid min-w-0 gap-x-5 gap-y-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,0.9fr)_minmax(0,2.6fr)]">
      <div className="min-w-0">
        <Link href={detailHref(data, entity, savedId)} className="inline-flex min-h-11 max-w-full items-center break-words font-semibold text-[var(--text-primary)] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] sm:min-h-8">{entity.name}</Link>
        <p className="break-words text-sm text-[var(--text-secondary)]">{entity.audienceLabel || 'Audience context unavailable'} · {entity.status || 'Status unavailable'}</p>
      </div>
      <div className="flex min-w-0 items-center gap-3 lg:block lg:space-y-2">
        <dl className="shrink-0"><Metric metric={spend} metricKey="spend" label="Spend" /></dl>
        <div className="min-w-0 flex-1" aria-hidden="true">{percent !== null && <div className="h-1.5 rounded-full bg-[var(--bg-base)]">
          <div data-spend-percent={percent} className="h-1.5 rounded-full bg-[var(--accent)]" style={{ width: `${percent}%` }} />
        </div>}</div>
      </div>
      <dl className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
        <Metric metric={count} metricKey={event.count} label="Events" name={`Meta ${event.label} count`} omitSettling={omitSettling} />
        <Metric metric={hierarchyMetric(data, entity, event.cpa, event)} metricKey={event.cpa} label="CPA" name={`Cost per Meta ${event.label}`} omitSettling={omitSettling} value={noResults ? '— · No results' : undefined} />
        <Metric metric={hierarchyMetric(data, entity, event.value, event)} metricKey={event.value} label="Value" name={`Meta ${event.label} value`} omitSettling={omitSettling} />
        <Metric metric={hierarchyMetric(data, entity, event.roas, event)} metricKey={event.roas} label="ROAS" name={`Meta ${event.label} ROAS`} omitSettling={omitSettling} />
      </dl>
    </div>
    {zero && <p className="mt-2 text-[var(--warning)]">Spend with 0 Meta {event.label} events.</p>}
    <details className="mt-1 min-w-0 text-[var(--text-secondary)]">
      <summary className="min-h-11 cursor-pointer content-center text-sm focus-visible:outline-2 focus-visible:outline-[var(--focus)] sm:min-h-8">Configuration &amp; audience</summary>
      <div className="space-y-1 break-words pb-2">
        <p>Current configuration · as of {entity.configurationAsOf ?? 'Unavailable'}</p>
        <p>{entity.level === 'campaign' ? 'Campaign' : 'Ad set'} ID {entity.id}{entity.campaignName && entity.level !== 'campaign' ? ` · ${entity.campaignName}` : ''}</p>
        <p>Current status {entity.status || 'Unavailable'} · {entity.audienceLabel || 'Audience context unavailable'}. Current settings do not establish historical targeting.</p>
        <p>Period frequency: {reportMetricValue(frequency)} · {data.context.range.from}–{data.context.range.to}. Frequency alone does not establish fatigue.</p>
        {entity.level === 'adset' ? <NativeAudience data={data} entity={entity} /> : <p>Audience operation and size belong to each ad set; no combined audience pool is inferred.</p>}
      </div>
    </details>
  </article>
}

type AudienceConcern = ReturnType<typeof hierarchyAudienceConcerns>[number]

function audienceConcernSummary({ members, conflict, evidence, configuration }: AudienceConcern) {
  const involved = [...new Map([...members, ...evidence.members.filter(member => conflict.some(other => other.id === member.id))]
    .map(member => [`${member.role}:${member.id}`, member])).values()]
  if (!involved.length) return `Audience configuration ${configuration}.`
  const included = involved.filter(member => member.role === 'included').length
  const codes = [...new Set(involved.map(member => member.operationCode ?? 'unavailable'))]
  const descriptions = [...new Set(involved.flatMap(member => [member.operationDescription, member.deliveryDescription])
    .filter((description): description is string => Boolean(description?.trim()))
    .map(description => new Intl.Segmenter('en', { granularity: 'sentence' }).segment(description)[Symbol.iterator]().next().value?.segment.trim() ?? description))]
  return `${included} included · ${involved.length - included} excluded audiences. ${descriptions.length
    ? `Meta: ${descriptions.join(' ')}` : `Operation codes ${codes.join(', ')}`}`
}

function AudienceConcernRow({ data, savedId, concern, compact }: Pick<Props, 'data' | 'savedId'> & { concern: AudienceConcern; compact: boolean }) {
  const { entity, evidence, configuration, members, conflict } = concern
  const status = members.length ? members.map(nativeStatus).join('; ') : `Audience configuration ${configuration}.`
  const conflicts = conflict.length > 0 && <p className="break-words">Included and excluded: {conflict.map(member => `${member.name ?? 'Unnamed audience'} (${member.id})`).join('; ')}.</p>
  return <div data-audience-concern={entity.id} className="min-w-0 border-t border-[var(--border)] pt-2">
    <Link className={compact ? 'inline-flex min-h-11 max-w-full items-center break-words font-medium text-[var(--accent)] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-[var(--focus)] sm:min-h-8' : `${linkStyle} max-w-full break-words font-medium`}
      href={`${overviewHref(data.context, '/reports', { report: 'audience' }, savedId)}#audience-adset-${encodeURIComponent(entity.id)}`}>{entity.name}</Link>
    <p className={`break-words ${compact ? 'text-sm' : ''}`}>{compact ? audienceConcernSummary(concern) : status}</p>
    {!compact && conflicts}
    <details><summary className={compact ? 'min-h-11 cursor-pointer content-center text-sm sm:min-h-8' : 'min-h-11 cursor-pointer content-center'}>
      {compact ? 'Native audience evidence' : `Current status ${entity.status} · observed ${evidence.observedAt}`}
    </summary>
      {compact && <div className="space-y-1 break-words pb-2"><p>Current status {entity.status} · observed {evidence.observedAt}</p><p>{status}</p>{conflicts}</div>}
      <NativeAudience data={data} entity={entity} />
    </details>
  </div>
}

export function AudienceAndDelivery({ data, savedId, compact = false }: Pick<Props, 'data' | 'savedId'> & { compact?: boolean }) {
  const concerns = hierarchyAudienceConcerns(data)
  const entities = data.meta.data?.entities ?? []
  const observations = ['available', 'partial'].includes(data.meta.state)
    ? (data.meta.data?.observations ?? []).filter(observation => ['audience', 'delivery'].includes(observation.kind)) : []
  const supplied = entities.filter(entity => entity.level === 'adset')
  const missing = supplied.filter(entity => !hierarchyAudience(data, entity)).length
  const spendOrder = new Map(hierarchyPopulation(data, 'adset', '').rows.map((entity, index) => [entity.id, index]))
  const ordered = compact ? [...concerns].sort((a, b) => (spendOrder.get(a.entity.id) ?? Infinity) - (spendOrder.get(b.entity.id) ?? Infinity)
    || a.entity.id.localeCompare(b.entity.id)) : concerns
  const observationRows = observations.map(observation => {
    const entity = entities.find(entity => entity.id === observation.entityId)
    return <details key={observation.id} className="min-w-0 border-t border-[var(--border)] pt-2">
      <summary className="min-h-11 cursor-pointer content-center break-words font-medium text-[var(--text-primary)]">{observation.title}{entity ? ` · ${entity.name}` : observation.entityId ? ` · ${observation.entityId}` : ''}</summary>
      <p className="break-words">{observation.detail}</p>
      <p>Meta {observation.kind} observation · observed {observation.observedAt ?? 'Unavailable'}</p>
      {entity && <Link href={detailHref(data, entity, savedId)} className={linkStyle}>Inspect {entity.name}</Link>}
    </details>
  })
  return <section aria-label="Audience and delivery" className="min-w-0 space-y-2 border-t border-[var(--border)] pt-4 text-[var(--text-secondary)]">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold text-[var(--text-primary)]">Audience and delivery</h3>
      <Link href={overviewHref(data.context, '/reports', { report: 'audience' }, savedId)} className={linkStyle}>All audience evidence</Link></div>
    <p>{compact ? `${concerns.length} affected ad sets · ordered by observed period spend.` : 'Current observations across all supplied ad sets, independent of the comparison page.'}</p>
    {(compact ? ordered.slice(0, 3) : ordered).map(concern => <AudienceConcernRow key={concern.entity.id} data={data} savedId={savedId} concern={concern} compact={compact} />)}
    {compact && ordered.length > 3 && <details aria-label="All affected ad sets">
      <summary className="min-h-11 cursor-pointer content-center font-medium text-[var(--accent)] sm:min-h-9">Show all {ordered.length} affected ad sets</summary>
      {ordered.slice(3).map(concern => <AudienceConcernRow key={concern.entity.id} data={data} savedId={savedId} concern={concern} compact />)}
    </details>}
    {compact && observations.length > 0 ? <details>
      <summary className="min-h-11 cursor-pointer content-center font-medium sm:min-h-9">{observations.length} additional audience and delivery observations</summary>
      {observationRows}
    </details> : observationRows}
    {missing > 0 && <p>Audience operation and size evidence unavailable for {missing} of {supplied.length} supplied ad sets.</p>}
    {!concerns.length && !observations.length && <p>No audience or delivery concerns were supplied by these checks; this does not establish their absence.</p>}
    <p>{compact ? 'Current audience size and period frequency do not establish saturation.' : 'Period frequency remains separate from current audience size. Incomplete audience pools cannot establish saturation.'}</p>
  </section>
}

export function OverviewHierarchy({ data, event, savedId, showAudience = true }: Props & { showAudience?: boolean }) {
  const search = useSearchParams(), pathname = usePathname() ?? '/dashboard'
  const params = new URLSearchParams(search?.toString() ?? '')
  params.delete('overview_hierarchy_page')
  const level = params.get('overview_level') === 'campaign' ? 'campaign' : 'adset'
  const query = params.get('overview_q') ?? ''
  const { population, rows, maxSpend } = hierarchyPopulation(data, level, query)
  const outcomeClaims = rows.flatMap(entity => [event.count, event.cpa, event.value, event.roas]
    .map(key => hierarchyMetric(data, entity, key, event)?.current)).filter(claim => claim?.availability.state === 'available')
  const settlingTogether = outcomeClaims.length > 0 && outcomeClaims.every(claim => claim!.maturity.state === 'settling')
  const label = level === 'adset' ? 'ad sets' : 'campaigns'
  const href = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(changes)) { if (value === null) next.delete(key); else next.set(key, value) }
    return overviewHref(data.context, pathname, Object.fromEntries(next), savedId)
  }
  const allEntities = data.meta.data?.entities ?? []
  return <section aria-label="Campaign and ad-set comparison" className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] p-5 text-sm leading-5 text-[var(--text-primary)] sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-xl font-semibold">Campaigns and ad sets</h2>
      <Link href={overviewHref(data.context, '/performance', { level, group: 'results' }, savedId)} className={`${control} text-[var(--accent)] underline-offset-4 hover:underline`}>Full comparison</Link></div>
    <div className="mt-1 flex flex-wrap items-start gap-x-4 gap-y-1 text-sm text-[var(--text-secondary)]">
      <p className="py-1">Meta {event.label}</p>
      <details aria-label="Comparison reporting context" className="min-w-0">
        <summary className="cursor-pointer py-1 focus-visible:outline-2 focus-visible:outline-[var(--focus)]">Period &amp; source{settlingTogether && ' · Settling'}</summary>
        <p>{data.context.range.from}–{data.context.range.to} · {data.context.timezone} · impression date</p>
        <p>Meta as of {data.meta.asOf ?? 'Unavailable'} · {data.meta.state}</p>
      </details>
    </div>
    <div className="my-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
    <nav aria-label="Comparison level" className="flex flex-wrap gap-1">
      {(['adset', 'campaign'] as const).map(value => <Link key={value} href={href({ overview_level: value, overview_q: null })}
        scroll={false} className={`${control} ${value === level ? 'bg-[var(--bg-base)] font-medium text-[var(--accent)]' : 'text-[var(--text-secondary)]'}`} aria-current={value === level ? 'page' : undefined}>
        {value === 'adset' ? 'Ad sets' : 'Campaigns'} ({allEntities.filter(entity => entity.level === value).length})
      </Link>)}
    </nav>
    <label className="block min-w-0 flex-1 basis-60 text-[var(--text-secondary)] lg:max-w-sm"><span className="sr-only">Search {label}</span>
      <input type="search" value={query} placeholder={`Search ${label} by name, ID or campaign`} className="min-h-11 w-full min-w-0 rounded-md border border-[var(--border)] bg-[var(--bg-surface)] px-3 text-sm text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--focus)]"
        onChange={change => window.history.replaceState(null, '', href({ overview_q: change.target.value || null }))} />
    </label>
    </div>
    <p className="mb-3 text-sm text-[var(--text-secondary)]">Spend, highest first · Bars share the largest observed {level === 'adset' ? 'ad set' : 'campaign'} spend. Missing values sort last.</p>
    {rows.map(entity => <HierarchyRow key={entity.id} data={data} event={event} entity={entity} maxSpend={maxSpend} savedId={savedId} omitSettling={settlingTogether} />)}
    {!rows.length && <p className="border-t border-[var(--border)] py-4 text-[var(--text-secondary)]">{population.length ? `No ${label} match this search.`
      : data.meta.state === 'loading' || data.meta.data?.detailState === 'loading' ? 'Loading Meta campaign and ad-set evidence…' : 'Meta campaign and ad-set evidence unavailable for this selection.'}</p>}
    <div className="mb-4 border-t border-[var(--border)] pt-2">
      <p role="status" className="text-[var(--text-secondary)]">{rows.length} {label}{query ? ` matched · ${population.length} supplied` : ' · All supplied statuses'}</p>
    </div>
    {showAudience && <AudienceAndDelivery data={data} savedId={savedId} />}
  </section>
}
