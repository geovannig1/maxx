import { AUDIENCE_EVIDENCE_LIMIT, audienceConfigurationState, reportAudienceMemberState, type ReportAudienceEvidence } from '@/lib/reporting/audience-evidence'

const STATE_LABEL = { resolved: 'Readiness checks passed', unhealthy: 'Native status needs review', unresolved: 'Readiness unknown', rejected: 'Account identity mismatch', empty: 'Reference unavailable' }
const shown = (value: number | null) => value === null ? 'Unavailable' : value.toLocaleString('en-US')

export function AudienceEvidenceDetails({ evidence, asOf }: { evidence?: ReportAudienceEvidence; asOf: string }) {
  if (!evidence) return <p className="mt-3 text-xs leading-5 text-[var(--text-secondary)]">Audience membership and operational evidence were not supplied. Period performance below remains separately reported.</p>
  const state = audienceConfigurationState(evidence, asOf)
  return <section aria-label="Current audience configuration" className="mt-4 min-w-0 space-y-3 text-xs leading-5 text-[var(--text-secondary)]">
    <div>
      <h4 className="font-semibold text-[var(--text-primary)]">Current audience configuration · Meta</h4>
      <p>Configuration {state} · observed {evidence.observedAt}</p>
      <p>Advantage audience expansion: {evidence.expansion}. {evidence.members.filter(member => member.role === 'included').length} included / {evidence.members.filter(member => member.role === 'excluded').length} excluded references supplied.</p>
      {evidence.unparsedReferences > 0 && <p className="text-[var(--warning)]">{evidence.unparsedReferences} malformed reference(s) could not be interpreted; membership coverage is incomplete.</p>}
      {!evidence.targetingAvailable && <p>Targeting was not supplied. No empty or broad audience is inferred.</p>}
    </div>
    {evidence.members.length === 0 && evidence.targetingAvailable && <p>No explicit custom-audience references were supplied. Other targeting restrictions may apply.</p>}
    {evidence.members.map(member => {
      const readiness = reportAudienceMemberState(member, evidence, asOf)
      return <article key={`${member.role}:${member.id}`} data-audience-member={`${member.role}:${member.id}`} className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-3 print:break-inside-avoid">
        <p className="break-words font-semibold text-[var(--text-primary)]">{member.role === 'included' ? 'Included' : 'Excluded'} · {member.name ?? 'Unnamed audience'}</p>
        <p className="break-all">Audience ID {member.id} · {member.subtype ?? 'Subtype unavailable'}</p>
        <p className={readiness === 'unhealthy' || readiness === 'rejected' ? 'text-[var(--warning)]' : ''}>{STATE_LABEL[readiness]}</p>
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
          <div><dt>Operation status</dt><dd className="font-medium text-[var(--text-primary)]">{shown(member.operationCode)}</dd></div>
          <div><dt>Delivery status</dt><dd className="font-medium text-[var(--text-primary)]">{shown(member.deliveryCode)}</dd></div>
          <div><dt>Retention window</dt><dd>{member.retentionDays === null ? 'Unavailable' : `${shown(member.retentionDays)} days`}</dd></div>
          <div className="col-span-2"><dt>Approximate size bounds</dt><dd>Lower {shown(member.lowerBound)} / upper {shown(member.upperBound)}</dd></div>
          <div><dt>Account identity</dt><dd>{member.ownership}</dd></div>
        </dl>
        {member.operationDescription && <p className="mt-2 break-words">Meta operation description: {member.operationDescription}</p>}
        {member.deliveryDescription && <p className="break-words">Meta delivery description: {member.deliveryDescription}</p>}
        <p className="mt-2 break-words">Seed audiences: {member.seeds.length ? member.seeds.map(seed => `${seed.name ?? 'Unnamed seed'} (${seed.id})`).join('; ') : 'Not supplied'}</p>
        <p className="break-words">Inventory observed: {member.inventoryObservedAt ?? 'Unavailable'}</p>
        <p className="break-words">Meta metadata updated: {member.metaUpdatedAt ?? 'Unavailable'}</p>
      </article>
    })}
    <p>{AUDIENCE_EVIDENCE_LIMIT}</p>
  </section>
}
