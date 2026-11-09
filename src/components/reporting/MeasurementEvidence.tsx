import Link from 'next/link'
import type { ReportMetricMap, ReportingData } from '@/lib/reporting/contracts'
import { ReportMetricValue } from './MetricValue'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

function EvidenceGroup({ title, description, metrics, notes }: {
  title: string; description: string; metrics: ReportMetricMap; notes: string[]
}) {
  return <div className="min-w-0 border-t border-[var(--border)] pt-4">
    <h3 className="font-semibold">{title}</h3>
    <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">{description}</p>
    {Object.keys(metrics).length ? <div className="mt-3 grid grid-cols-2 gap-4 lg:grid-cols-3">
      {Object.values(metrics).map(metric => <div className="min-w-0" key={metric.key}>
        <p className="text-xs text-[var(--text-secondary)]">{metric.label}</p>
        <ReportMetricValue metric={metric} compact />
      </div>)}
    </div> : <p className="mt-3 text-sm text-[var(--text-secondary)]">Evidence unavailable for the selected period.</p>}
    {notes.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-4 text-xs leading-5 text-[var(--text-secondary)]">
      {notes.map(note => <li key={note}>{note}</li>)}
    </ul>}
  </div>
}

export function MeasurementEvidence({ data }: { data: ReportingData }) {
  const section = data.measurement
  const report = section?.data
  const query = new URLSearchParams({ from: data.context.range.from, to: data.context.range.to })
  return <section id="measurement-evidence" aria-label={`${OW.One} links and tracking`} className="scroll-mt-24 space-y-4 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-5">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-xl font-semibold">{OW.One} links and tracking</h2>
      <Link className="inline-flex min-h-11 items-center text-sm text-[var(--accent)]" href={`/conversions?${query}`}>Measurement details</Link>
    </div>
    <p className="text-xs leading-5 text-[var(--text-secondary)]">{report?.sourceDescription ?? (section?.state === 'loading'
      ? `Loading ${OW.one} associations and event receipts independently…` : `${OW.One} association and tracking evidence is unavailable.`)}</p>
    {section?.asOf && <p className="text-xs text-[var(--text-secondary)]">Evidence as of {section.asOf}</p>}
    {report && <>
      <EvidenceGroup title={`${OW.Many} associated with a paid touch`} metrics={report.paidAssociation} notes={report.paidAssociationNotes}
        description={`First-party links among active, positive-price ${OW.many} created in the selected period. Lag metrics use observed paid-touch and ${OW.one}-created timestamps, not ${OW.one}-to-service lead time. A linked ad touch establishes an association, not causation or payment. Missing linkage is not proof of organic traffic.`} />
      <EvidenceGroup title="Website confirmation delivery" metrics={Object.fromEntries(Object.entries(report.capi).filter(([key]) => key !== 'later_canceled_website_confirmations'))} notes={report.capiNotes}
        description="Conversions API receipts for confirmations created in the selected period. Delivery acceptance does not establish attribution, payment or a sale." />
    </>}
    {!report && section?.notes.map(note => <p key={note} className="text-xs leading-5 text-[var(--text-secondary)]">{note}</p>)}
  </section>
}
