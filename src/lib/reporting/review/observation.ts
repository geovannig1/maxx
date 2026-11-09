import { OBSERVATION_HEADINGS, type ReviewObservation, type ReviewObservationSection } from './contracts'

/** Presentation boundaries are prepared with the original answer, never inferred from prose. */
export const observationSectionText = (sections: ReviewObservationSection[]) => sections.flatMap(section => section.paragraphs).join(' ')

export function matchingObservationSections(observation: ReviewObservation): ReviewObservationSection[] | null {
  const sections: unknown = observation.sections
  if (!Array.isArray(sections) || !sections.length || sections.length > 20) return null
  const valid = sections.every(section => section && typeof section === 'object'
    && (section.heading === undefined || OBSERVATION_HEADINGS.includes(section.heading))
    && Array.isArray(section.paragraphs) && section.paragraphs.length > 0 && section.paragraphs.length <= 20
    && section.paragraphs.every((text: unknown) => typeof text === 'string' && text.trim().length > 0))
  return valid && observationSectionText(sections) === observation.text ? sections : null
}
