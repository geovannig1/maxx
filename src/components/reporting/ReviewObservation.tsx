import type { ReviewObservation as Observation } from '@/lib/reporting/review/contracts'
import { matchingObservationSections } from '@/lib/reporting/review/observation'
import type { ReactNode } from 'react'

/** Older saved answers remain verbatim; malformed presentation cannot conceal original facts. */
export function ReviewObservation({ observation, header }: { observation: Observation; header?: ReactNode }) {
  const sections = matchingObservationSections(observation)
  if (!sections) return <>{header}<p data-observation-text className={`${header ? 'mt-3 ' : ''}max-w-[75ch] break-words text-sm leading-6 text-[var(--text-secondary)]`}>{observation.text}</p></>
  return <div className="space-y-4 text-sm leading-6 text-[var(--text-secondary)]">
    {sections.map((section, index) => <div key={index} className={index === 0 ? 'print:break-inside-avoid' : undefined}>
      {index === 0 && header && <div className="mb-3">{header}</div>}
      <div data-observation-section
      className={section.heading ? 'grid min-w-0 gap-x-5 gap-y-1 border-t border-[var(--border)] pt-3 md:grid-cols-[minmax(10rem,0.32fr)_minmax(0,1fr)] print:break-inside-avoid' : 'max-w-[75ch] print:break-inside-avoid'}>
      {section.heading && <h4 className="min-w-0 break-words font-semibold text-[var(--text-primary)]">{section.heading}</h4>}
      <div className="min-w-0 max-w-[75ch] space-y-1">{section.paragraphs.map((text, paragraph) =>
        <p key={paragraph} data-observation-text className="break-words">{text}</p>)}</div>
      </div>
    </div>)}
  </div>
}
