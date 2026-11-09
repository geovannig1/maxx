import type { ReportingData } from '@/lib/reporting/contracts'
import { deriveCustomerReview } from '@/lib/reporting/review/business-customers'
import { useSavedReportContext } from './SavedReportContext'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

/** The same prepared interpretation used by Results, beside its native customer detail. */
export function CustomerResultSummary({ data }: { data: ReportingData }) {
  const saved = useSavedReportContext()
  const finding = saved ? saved.review.findings.find(item => item.id === 'business_customers') : deriveCustomerReview(data)
  if (!finding) return <p className="mt-4 text-sm text-[var(--text-secondary)]">This assessment was not included in the saved report.</p>
  return <div data-customer-result={finding.id} className="mt-4 space-y-2 border-l-2 border-[var(--accent)] pl-3 text-sm leading-6">
    <h3 className="font-semibold text-[var(--text-primary)]">What explains customer-group results</h3>
    <p className="text-xs text-[var(--text-secondary)]">{OW.One} creation dates {data.context.range.from} – {data.context.range.to}; previous {data.context.comparison.from} – {data.context.comparison.to} · {data.context.timezone}.</p>
    <p className="break-words text-[var(--text-secondary)]">{finding.observation.text}</p>
  </div>
}
